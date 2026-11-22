// The 3D preview dialog. The real bundle needs WebGL and live map data, so
// preview.js is replaced by a fake module that records what app.js passes it
// and lets each test drive the lifecycle callbacks.

import { test, expect, openStore, readCart, gaEvents, DEFAULT_STORAGE } from './fixtures.js';

const FAKE_PREVIEW = `
export function createPreview(container, opts) {
  const p = {
    container, opts, view: 'room', calls: [], disposed: false,
    setView(v) { this.view = v; this.calls.push(['setView', v]); },
    async setFrame(c) { this.calls.push(['setFrame', c]); this.view = 'room'; },
    dispose() { this.disposed = true; },
  };
  window.__preview = p;
  return p;
}`;

test.use({ storage: { ...DEFAULT_STORAGE, pp_cn: '1' } });

test.beforeEach(async ({ page }) => {
  await page.route('**/assets/js/preview/preview.js*', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: FAKE_PREVIEW }));
});

const dialog = (page) => page.locator('.pv-overlay');

async function openDialog(page, query = '') {
  await openStore(page, query);
  await page.locator('#sel-run').click();
  await expect(dialog(page)).toBeVisible();
}

async function showPreview(page) {
  await page.locator('[data-pv="show"]').click();
  await page.waitForFunction(() => window.__preview);
}

test.describe('the offer', () => {
  test('asks first, with buildings in the copy', async ({ page, api }) => {
    await openDialog(page);
    await expect(dialog(page)).toHaveAttribute('role', 'dialog');
    await expect(dialog(page)).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#pv-title')).toHaveText('See your sculpture in 3D?');
    await expect(dialog(page)).toContainText('the terrain, buildings and water');
    await expect(page.locator('[data-pv="show"]')).toBeFocused();
    expect(api.requests('GET /api/reverse-geocode')).toHaveLength(0);
  });

  test('landscape copy leaves buildings out', async ({ page, api }) => {
    await openStore(page);
    await page.locator('#landscape-toggle-btn').click();
    await page.locator('#zoom-slider').fill('2');
    await page.locator('#sel-run').click();
    await expect(dialog(page)).toContainText('the terrain, and water');
  });

  test('"No thanks" adds to cart', async ({ page, api }) => {
    await openDialog(page);
    await page.locator('[data-pv="skip"]').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('body')).toHaveClass(/cart-open/);
    expect(await readCart(page)).toHaveLength(1);
  });

  for (const [how, act, refocus] of [
    ['the close button', (p) => p.locator('.pv-close').click(), true],
    ['Escape', (p) => p.keyboard.press('Escape'), true],
    // The click lands on whatever is under the backdrop, which takes focus.
    ['the backdrop', (p) => p.mouse.click(5, 300), false],
  ]) {
    test(`closing with ${how} adds nothing`, async ({ page, api }) => {
      await openDialog(page);
      await act(page);
      await expect(dialog(page)).toHaveCount(0);
      expect(await readCart(page)).toHaveLength(0);
      if (refocus) await expect(page.locator('#sel-run')).toBeFocused();
      expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    });
  }

  test('focus stays inside the dialog', async ({ page, api }) => {
    await openDialog(page);
    await expect(page.locator('[data-pv="show"]')).toBeFocused(); // focused after 60 ms
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.querySelector('.pv-card').contains(document.activeElement))).toBe(true);
    }
  });

  test('frames too wide for the preview skip straight to the cart', async ({ page, api }) => {
    await openStore(page, '?scale=large'); // 2 km
    await page.locator('#landscape-toggle-btn').click();
    await page.locator('#zoom-slider').fill('7'); // 14 km: past the 0.1 degree cap, inside 0.25
    const wide = await page.evaluate(() => {
      const b = selectionMeta.bbox;
      return Math.max(b.north - b.south, b.east - b.west);
    });
    expect(wide).toBeGreaterThan(0.1);
    expect(wide).toBeLessThan(0.25);
    await page.locator('#sel-run').click();
    await expect(dialog(page)).toBeVisible(); // landscape allows up to 0.25

    await page.keyboard.press('Escape');
    await page.locator('#landscape-toggle-btn').click(); // back to standard, 1.0x = 2 km: fine
    await page.evaluate(() => {
      // Standard mode cap is 0.1 degrees; force a frame past it.
      selectionMeta.bbox = { south: 51.4, north: 51.55, west: -0.2, east: -0.1 };
    });
    await page.locator('#sel-run').click();
    await expect(page.locator('body')).toHaveClass(/cart-open/);
    await expect(dialog(page)).toHaveCount(0);
  });
});

test.describe('the preview', () => {
  test('passes the frame, room and mode to createPreview', async ({ page, api }) => {
    await openDialog(page, '?scale=medium');
    await page.keyboard.press('Escape');
    await page.locator('label[for="frame-colour-fprice_medium_black-prod_medium"]').click();
    await page.locator('#rotation-btn').click();
    await page.locator('#sel-run').click();
    await showPreview(page);

    const opts = await page.evaluate(() => {
      const { bbox, config, room } = window.__preview.opts;
      return { bbox, config, room, meta: selectionMeta.bbox };
    });
    expect(opts.bbox).toEqual([opts.meta.south, opts.meta.west, opts.meta.north, opts.meta.east]);
    expect(opts.config).toEqual({ includeBuildings: true });
    expect(opts.room).toEqual({ size: 'medium', colour: 'black', bareMm: [210, 297], rotated: true });
    await expect(page.locator('#pv-title')).toHaveText('Your sculpture in 3D');
    await expect(page.locator('[data-pv="add"]')).toHaveText('Add to cart · £50 →');
    expect((await gaEvents(page, 'preview_open'))).toHaveLength(1);
  });

  test('custom sizes get no room frame choices', async ({ page, api }) => {
    await openStore(page);
    await page.locator('.size-opt-custom').click();
    await expect(page.locator('#order-scale')).toHaveText(/Custom/);
    await page.locator('#sel-run').click();
    await showPreview(page);
    const room = await page.evaluate(() => window.__preview.opts.room);
    expect(room).toEqual({ size: null, colour: null, bareMm: [200, 200], rotated: false });
  });

  test('progress updates the label and bar', async ({ page, api }) => {
    await openDialog(page);
    await showPreview(page);
    await expect(page.locator('#pv-loading-label')).toHaveText('Gathering map data');
    await page.evaluate(() => window.__preview.opts.onProgress('buildings', 0.5, 0.42));
    await expect(page.locator('#pv-loading-label')).toHaveText('Raising the buildings');
    await expect(page.locator('#pv-bar-fill')).toHaveAttribute('style', 'width: 42%;');
    await page.evaluate(() => window.__preview.opts.onProgress('unknown', 0.5, 0.5));
    await expect(page.locator('#pv-loading-label')).toHaveText('Raising the buildings');
  });

  test('ready with a room shows the view switch and frame upsell', async ({ page, api }) => {
    await openDialog(page);
    await showPreview(page);
    await page.evaluate(() => window.__preview.opts.onReady({ views: ['room', 'model'] }));
    await expect(page.locator('#pv-loading')).toBeHidden();
    await expect(page.locator('#pv-views')).toBeVisible();
    await expect(page.locator('#pv-frames')).toHaveClass(/pv-frames--upsell/);
    await expect(page.locator('#pv-frames-title')).toHaveText('Finish it with a frame');
    await expect(page.locator('.pv-frame')).toHaveText([/No frame/, /Oak\s*\+£10/, /Black\s*\+£10/, /White\s*\+£10/]);
    await expect(page.locator('.pv-frame[data-colour=""]')).toHaveAttribute('aria-pressed', 'true');

    await page.locator('[data-view="model"]').click();
    await expect(page.locator('[data-view="model"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-view="room"]')).toHaveAttribute('aria-pressed', 'false');

    // Picking a frame in the preview selects it on the store too.
    await page.locator('.pv-frame[data-colour="oak"]').click();
    await expect(page.locator('.pv-frame[data-colour="oak"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-pv="add"]')).toHaveText('Add to cart · £40 →');
    await expect(page.locator('#frame-colour-fprice_small_oak-prod_small')).toBeChecked();
    await expect(page.locator('#order-price')).toHaveText('£40');
    // setFrame moved the fake back to the room view; the switch follows.
    await expect(page.locator('[data-view="room"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.__preview.calls)).toEqual([['setView', 'model'], ['setFrame', 'oak']]);
    expect((await gaEvents(page, 'preview_frame_upsell')).map((e) => e.params)).toEqual([{ colour: 'Oak' }]);

    await page.locator('.pv-frame[data-colour=""]').click();
    await expect(page.locator('#order-price')).toHaveText('£30');

    await page.locator('[data-pv="add"]').click();
    expect(await page.evaluate(() => window.__preview.disposed)).toBe(true);
    // Adding waits on reverse geocoding, so poll for the item.
    await expect.poll(() => readCart(page)).toHaveLength(1);
    const [item] = await readCart(page);
    expect(item.frame).toBe(false);
  });

  test('a frame already chosen is not presented as an upsell', async ({ page, api }) => {
    await openStore(page);
    await page.locator('label[for="frame-colour-fprice_small_white-prod_small"]').click();
    await page.locator('#sel-run').click();
    await showPreview(page);
    expect(await page.evaluate(() => window.__preview.opts.room.colour)).toBe('white');
    await page.evaluate(() => window.__preview.opts.onReady({ views: ['room', 'model'] }));
    await expect(page.locator('#pv-frames-title')).toHaveText('Frame');
    await expect(page.locator('#pv-frames')).not.toHaveClass(/upsell/);
    await expect(page.locator('.pv-frame[data-colour="white"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('ready without a room hides the switch and picker', async ({ page, api }) => {
    await openDialog(page);
    await showPreview(page);
    await page.evaluate(() => window.__preview.opts.onReady({ views: ['model'] }));
    await expect(page.locator('#pv-loading')).toBeHidden();
    await expect(page.locator('#pv-views')).toBeHidden();
    await expect(page.locator('#pv-frames')).toBeHidden();
  });

  for (const [code, text] of [
    ['bad_bbox', 'This area is too large to preview.'],
    ['too_many_tiles', 'This area is too large to preview.'],
    ['no_webgl', 'Your browser can’t show 3D previews.'],
    ['timeout', 'The preview is taking too long - please try again later.'],
    ['oom', 'This area is too detailed to preview on this device.'],
    ['mystery', 'The preview couldn’t be built just now.'],
  ]) {
    test(`error ${code} shows its message`, async ({ page, api }) => {
      await openDialog(page);
      await showPreview(page);
      await page.evaluate((c) => window.__preview.opts.onError(c), code);
      await expect(page.locator('#pv-loading')).toHaveClass(/pv-loading-error/);
      await expect(page.locator('#pv-loading-label')).toHaveText(text);
    });
  }

  test('a module that fails to load shows an error, and the cart still works', async ({ page, api }) => {
    await page.unroute('**/assets/js/preview/preview.js*');
    await page.route('**/assets/js/preview/preview.js*', (route) => route.fulfill({ status: 500, body: '' }));
    await openDialog(page);
    await page.locator('[data-pv="show"]').click();
    await expect(page.locator('#pv-loading-label')).toHaveText('The preview couldn’t be loaded just now.');
    await page.locator('[data-pv="add"]').click();
    await expect.poll(() => readCart(page)).toHaveLength(1);
  });

  test('"Back to the map" disposes the preview', async ({ page, api }) => {
    await openDialog(page);
    await showPreview(page);
    await page.locator('[data-pv="back"]').click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__preview.disposed)).toBe(true);
    expect(await readCart(page)).toHaveLength(0);
  });
});
