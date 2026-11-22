import { test, expect, openStore, fbqEvents, API } from './fixtures.js';
import { PRODUCTS, PRODUCTS_RESPONSE } from './data.js';

const STORE_CACHE = 'polyplaces_store_cache_v1';

test.describe('product loading', () => {
  test('falls back to the live API when there is no cache or snapshot', async ({ page, api }) => {
    await openStore(page);
    expect(api.requests('GET /api/products')).toHaveLength(1);
    const cached = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORE_CACHE);
    expect(cached.products.map((p) => p.id)).toEqual(PRODUCTS.map((p) => p.id));
    expect(await page.evaluate(() => localStorage.getItem('polyplaces_products_cache_v1'))).not.toBeNull();
  });

  // store/index.html preloads /api/products unconditionally, so request counts
  // cannot show whether the cache was used; the rendered prices can.
  test('renders from a fresh cache and does not revalidate it', async ({ page, api }) => {
    const cached = structuredClone(PRODUCTS_RESPONSE);
    cached.products[0].unitAmount = 9900;
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [STORE_CACHE, JSON.stringify({ ts: Date.now(), ...cached })]);
    await openStore(page);
    await expect(page.locator('#order-price')).toHaveText('£99');
    await page.waitForTimeout(500);
    await expect(page.locator('#order-price')).toHaveText('£99');
  });

  test('renders a stale cache first, then applies a changed live payload', async ({ page, api }) => {
    const stale = { ts: Date.now() - 10 * 60 * 1000, ...PRODUCTS_RESPONSE };
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [STORE_CACHE, JSON.stringify(stale)]);
    const live = structuredClone(PRODUCTS_RESPONSE);
    live.products[0].unitAmount = 3200;
    api.on('GET /api/products', { json: live, delay: 2000 }); // outlasts the HTML preload

    await page.goto('/store/');
    await expect(page.locator('#order-price')).toHaveText('£30');
    await expect(page.locator('#order-price')).toHaveText('£32');
    await expect(page.locator('.size-opt.active')).toHaveAttribute('data-product-id', 'prod_small');
  });

  test('re-selects the first product when the live payload drops the current one', async ({ page, api }) => {
    const stale = { ts: 0, ...PRODUCTS_RESPONSE };
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [STORE_CACHE, JSON.stringify(stale)]);
    api.on('GET /api/products', { json: { ...PRODUCTS_RESPONSE, products: PRODUCTS.slice(1) }, delay: 2000 });
    await page.goto('/store/?scale=small');
    await expect(page.locator('.size-opt.active')).toHaveAttribute('data-product-id', 'prod_small');
    await expect(page.locator('.size-opt.active')).toHaveAttribute('data-product-id', 'prod_medium');
  });

  test('uses the committed snapshot before the live API answers', async ({ page, api }) => {
    api.on('GET /assets/data/products-snapshot.json', { json: PRODUCTS_RESPONSE });
    api.on('GET /api/products', { json: PRODUCTS_RESPONSE, delay: 5000 });
    await openStore(page);
    await expect(page.locator('.size-opt')).toHaveCount(4);
  });

  test('shows an error when every source fails', async ({ page, api }) => {
    api.on('GET /api/products', { status: 500, json: {} });
    await page.goto('/store/');
    await expect(page.locator('#size-options-empty')).toHaveText(/Sizes failed to load/);
    await expect(page.locator('#size-options-empty')).toBeVisible();
    await expect(page.locator('#store-size-loading')).toHaveClass(/hidden/);
    await expect(page.locator('#sel-run')).toBeDisabled();
  });

  test('shows "No sizes" when the catalogue has nothing sellable', async ({ page, api }) => {
    api.on('GET /api/products', { json: { products: [{ id: 'district', name: 'D', priceId: 'p' }] } });
    await page.goto('/store/');
    await expect(page.locator('#size-options-empty')).toHaveText('No sizes available right now.');
    await expect(page.locator('.size-opt')).toHaveCount(0);
    await expect(page.locator('#sel-run')).toBeDisabled();
  });
});

test.describe('size selection', () => {
  test('renders every size plus custom, last', async ({ page, api }) => {
    await openStore(page);
    const cards = page.locator('.size-opt');
    await expect(cards).toHaveCount(4);
    await expect(cards.nth(0).locator('.size-opt-name')).toHaveText('Small');
    await expect(cards.nth(0).locator('.size-opt-price')).toHaveText('£30');
    await expect(cards.nth(1).locator('.size-opt-sub')).toContainText('A4');
    await expect(cards.nth(3)).toHaveAttribute('data-product-id', 'custom');
    await expect(cards.nth(3)).toContainText('Up to 330×330mm');
  });

  test('preselects the first product and places a frame', async ({ page, api }) => {
    await openStore(page);
    await expect(page.locator('.size-opt.active')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#order-scale')).toHaveText('Small · 20cm x 20cm');
    await expect(page.locator('#order-price')).toHaveText('£30');
    await expect(page.locator('#frame-controls')).toBeVisible();
    await expect(page.locator('.leaflet-marker-draggable')).toHaveCount(1);
    await expect(page.locator('#map-hint')).toHaveText('Drag the corner handle to reposition');
    expect(page.pageErrors).toEqual([]);
  });

  test('click, Enter and Space select a size', async ({ page, api }) => {
    await openStore(page);
    await page.locator('.size-opt[data-product-id="prod_large"]').click();
    await expect(page.locator('#order-price')).toHaveText('£45');
    await page.locator('.size-opt[data-product-id="prod_medium"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#order-scale')).toHaveText('Medium · A4');
    await page.locator('.size-opt[data-product-id="prod_small"]').focus();
    await page.keyboard.press(' ');
    await expect(page.locator('#order-scale')).toHaveText('Small · 20cm x 20cm');
    await expect(page.locator('.size-opt[aria-pressed="true"]')).toHaveCount(1);
  });

  test('switching product resizes the frame around the same centre', async ({ page, api }) => {
    await openStore(page);
    const before = await page.evaluate(() => ({ ...frameCenter }));
    await page.locator('.size-opt[data-product-id="prod_large"]').click();
    await page.waitForFunction(() => Math.abs((bbox.east - bbox.west) * 111320 * Math.cos(51.505 * Math.PI / 180) - 2000) < 5);
    const after = await page.evaluate(() => ({ ...frameCenter }));
    expect(after.lat).toBeCloseTo(before.lat, 6);
    expect(after.lng).toBeCloseTo(before.lng, 6);
  });

  test('tracks ViewContent once per new product', async ({ page, api }) => {
    await openStore(page);
    await page.locator('.size-opt[data-product-id="prod_small"]').click();
    await page.locator('.size-opt[data-product-id="prod_large"]').click();
    const events = await fbqEvents(page, 'ViewContent');
    expect(events.map((e) => e.content_ids[0])).toEqual(['price_small', 'price_large']);
    expect(events[1]).toMatchObject({ value: 45, currency: 'GBP', content_name: 'Large' });
  });

  test('?scale= preselects by name', async ({ page, api }) => {
    await openStore(page, '?scale=large');
    await expect(page.locator('.size-opt.active')).toHaveAttribute('data-product-id', 'prod_large');
  });

  test('unknown ?scale= falls back to the first product', async ({ page, api }) => {
    await openStore(page, '?scale=giant');
    await expect(page.locator('.size-opt.active')).toHaveAttribute('data-product-id', 'prod_small');
  });

  // KNOWN BUG (frontend-test-plan.md 4.7): the homepage gallery and footer link
  // to ?scale=a4, but the A4 product is called "Medium" with a Stripe id, so the
  // link opens on Small instead.
  test.fail('?scale=a4 from the gallery and footer opens the A4 product', async ({ page, api }) => {
    await openStore(page, '?scale=a4');
    await expect(page.locator('.size-opt.active')).toHaveAttribute('data-product-id', 'prod_medium', { timeout: 1000 });
  });

  // KNOWN BUG (frontend-test-plan.md 4.7): productMeta is keyed by 'small',
  // 'a4', 'large' but real product ids are Stripe ids, so no badge ever shows.
  test.fail('shows the "Most popular" badge on Small', async ({ page, api }) => {
    await openStore(page);
    await expect(page.locator('.size-opt[data-product-id="prod_small"] .size-opt-badge')).toHaveText('Most popular', { timeout: 1000 });
  });

  test('product names from the API are rendered as text', async ({ page, api }) => {
    const evil = structuredClone(PRODUCTS_RESPONSE);
    evil.products[0].name = '<img src=x onerror="window.__xss=1">';
    api.on('GET /api/products', { json: evil });
    await openStore(page);
    await expect(page.locator('.size-opt').first().locator('.size-opt-name')).toHaveText(evil.products[0].name);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });
});

test.describe('frames', () => {
  test('only the selected product shows its frame options', async ({ page, api }) => {
    await openStore(page);
    await expect(page.locator('.size-opt[data-product-id="prod_small"] .frame-opts')).toBeVisible();
    await expect(page.locator('.size-opt[data-product-id="prod_large"] .frame-opts')).toBeHidden();
    await expect(page.locator('.size-opt[data-product-id="prod_small"] .frame-colour-label')).toHaveText([
      /No frame/, /Oak\s*\+£10/, /Black\s*\+£10/, /White\s*\+£10/,
    ]);
  });

  test('choosing a frame updates the price; No frame resets it', async ({ page, api }) => {
    await openStore(page);
    await page.locator('label[for="frame-colour-fprice_small_oak-prod_small"]').click();
    await expect(page.locator('#order-price')).toHaveText('£40');
    expect(await page.evaluate(() => selectedFrame)).toBe('fprice_small_oak');
    await page.locator('label[for="frame-colour-none-prod_small"]').click();
    await expect(page.locator('#order-price')).toHaveText('£30');
    expect(await page.evaluate(() => selectedFrame)).toBeNull();
  });

  test('clicking a frame option does not reselect the product', async ({ page, api }) => {
    await openStore(page);
    await page.locator('label[for="frame-colour-fprice_small_black-prod_small"]').click();
    await expect(page.locator('#order-price')).toHaveText('£40');
    expect(await fbqEvents(page, 'ViewContent')).toHaveLength(1);
  });

  test('switching product clears the frame choice', async ({ page, api }) => {
    await openStore(page);
    await page.locator('label[for="frame-colour-fprice_small_oak-prod_small"]').click();
    await page.locator('.size-opt[data-product-id="prod_large"]').click();
    await expect(page.locator('#order-price')).toHaveText('£45');
    await expect(page.locator('#frame-colour-none-prod_small')).toBeChecked();
    expect(await page.evaluate(() => selectedFrame)).toBeNull();
  });

  test('frame colours with a bad hex fall back to grey', async ({ page, api }) => {
    await page.goto('/about/');
    await page.evaluate(() => {
      frameOptions = { small: [{ priceId: 'f', unitAmount: 1, colourHex: 'red;background:url(x)', colourName: 'X' }] };
      products = [{ id: 'p', name: 'P', priceId: 'pp', frameKey: 'small' }];
      document.body.insertAdjacentHTML('beforeend', '<div id="size-options"></div><div id="size-options-empty"></div>');
      renderSizeOptions();
    });
    await expect(page.locator('.frame-colour-swatch').nth(1)).toHaveAttribute('style', 'background-color:#cccccc');
  });
});

test.describe('frame controls', () => {
  test('rotate is disabled for square products and toggles A4', async ({ page, api }) => {
    await openStore(page);
    await expect(page.locator('#rotation-btn')).toBeDisabled();
    await page.locator('.size-opt[data-product-id="prod_medium"]').click();
    await expect(page.locator('#rotation-btn')).toBeEnabled();
    await page.waitForFunction(() => !bboxAnim);

    const tall = await page.evaluate(() => (bbox.north - bbox.south) * 111320);
    await page.locator('#rotation-btn').click();
    await expect(page.locator('#rotation-btn')).toHaveAttribute('aria-pressed', 'true');
    const turned = await page.evaluate(() => ({ h: (bbox.north - bbox.south) * 111320, rot: frameRotation, meta: selectionMeta.rotation }));
    expect(turned.rot).toBe(90);
    expect(turned.meta).toBe(90);
    expect(turned.h).toBeLessThan(tall);

    await page.locator('#rotation-btn').click();
    expect(await page.evaluate(() => frameRotation)).toBe(0);
  });

  test('selecting a new product resets rotation', async ({ page, api }) => {
    await openStore(page, '?scale=medium');
    await page.locator('#rotation-btn').click();
    await page.locator('.size-opt[data-product-id="prod_large"]').click();
    await expect(page.locator('#rotation-btn')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => frameRotation)).toBe(0);
  });

  test('zoom slider scales the frame and updates the label and fill', async ({ page, api }) => {
    await openStore(page);
    const w1 = await page.evaluate(() => bbox.east - bbox.west);
    await page.locator('#zoom-slider').fill('1.3');
    await expect(page.locator('#zoom-val')).toHaveText('1.3×');
    const r = await page.evaluate(() => ({ w: bbox.east - bbox.west, zoom: selectionMeta.zoom, fill: document.getElementById('zoom-slider').style.getPropertyValue('--fill') }));
    expect(r.w / w1).toBeCloseTo(1.3, 5);
    expect(r.zoom).toBe(1.3);
    expect(r.fill).toBe('100%');
  });

  test('landscape mode widens the zoom range and shows the banner', async ({ page, api }) => {
    await openStore(page);
    await page.locator('#zoom-slider').fill('0.7');
    await page.locator('#landscape-toggle-btn').click();
    await expect(page.locator('#landscape-toggle-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#landscape-banner')).toHaveClass(/is-visible/);
    await expect(page.locator('#order-landscape-line')).toBeVisible();
    await expect(page.locator('#zoom-slider')).toHaveAttribute('min', '2');
    await expect(page.locator('#zoom-slider')).toHaveAttribute('max', '7');
    await expect(page.locator('#zoom-val')).toHaveText('6.0×'); // 4.5 shown on the 2-10 scale
    expect(await page.evaluate(() => [frameZoom, selectionMeta.landscape])).toEqual([4.5, true]);

    await page.locator('#landscape-toggle-btn').click();
    await expect(page.locator('#order-landscape-line')).toBeHidden();
    expect(await page.evaluate(() => frameZoom)).toBe(1);
  });

  test('landscape mode survives a product switch', async ({ page, api }) => {
    await openStore(page);
    await page.locator('#landscape-toggle-btn').click();
    await page.locator('.size-opt[data-product-id="prod_large"]').click();
    await expect(page.locator('#landscape-toggle-btn')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => frameZoom)).toBe(4.5);
  });

  test('leaving landscape while zoomed out pulls the map back in', async ({ page, api }) => {
    await openStore(page);
    await page.locator('#landscape-toggle-btn').click();
    await page.evaluate(() => map.setZoom(10, { animate: false }));
    expect(await page.evaluate(() => bbox !== null)).toBe(true); // 10 is fine in landscape
    await page.locator('#landscape-toggle-btn').click();
    await expect.poll(() => page.evaluate(() => map.getZoom())).toBe(12);
    expect(await page.evaluate(() => bbox !== null)).toBe(true);
  });

  test('zooming the map out past street level clears the frame', async ({ page, api }) => {
    await openStore(page);
    await page.evaluate(() => map.setZoom(11, { animate: false }));
    await expect(page.locator('#map-hint')).toContainText('Zoom back in');
    await expect(page.locator('#frame-controls')).toBeHidden();
    await expect(page.locator('#sel-run')).toBeDisabled();
    expect(await page.evaluate(() => [bbox, selectionMeta])).toEqual([null, null]);
  });

  test('dragging the handle moves the frame', async ({ page, api }) => {
    await openStore(page);
    const before = await page.evaluate(() => ({ ...frameCenter }));
    const handle = page.locator('.leaflet-marker-draggable');
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 60, { steps: 8 });
    await page.mouse.up();
    const after = await page.evaluate(() => ({ c: { ...frameCenter }, meta: { ...selectionMeta.center } }));
    expect(after.c.lng).toBeGreaterThan(before.lng);
    expect(after.c.lat).toBeLessThan(before.lat);
    expect(after.meta.lng).toBeCloseTo(after.c.lng, 8);
    await expect(page.locator('#order-status-msg')).toHaveText('Frame placed. Drag to adjust, then add to cart.');
  });

  test('Clear selection resets the configurator', async ({ page, api }) => {
    await openStore(page);
    await page.locator('#sel-clear').click();
    await expect(page.locator('#sel-run')).toBeDisabled();
    await expect(page.locator('#order-scale')).toHaveText('—');
    await expect(page.locator('#order-price')).toHaveText('—');
    await expect(page.locator('.size-opt.active')).toHaveCount(0);
    await expect(page.locator('.leaflet-marker-draggable')).toHaveCount(0);
    expect(await page.evaluate(() => [selectedProduct, bbox])).toEqual([null, null]);
  });

  // KNOWN BUG (frontend-test-plan.md 4.3): clearMap removes .active but leaves
  // aria-pressed="true" on the old card.
  test.fail('Clear selection also resets aria-pressed', async ({ page, api }) => {
    await openStore(page);
    await page.locator('#sel-clear').click();
    await expect(page.locator('.size-opt[aria-pressed="true"]')).toHaveCount(0, { timeout: 1000 });
  });
});

test.describe('map start position', () => {
  test('opens on lat/lng/z from the URL', async ({ page, api }) => {
    await openStore(page, '?lat=54.4863&lng=-0.6133&z=16');
    const r = await page.evaluate(() => ({ c: map.getCenter(), z: map.getZoom(), f: frameCenter }));
    expect(r.c.lat).toBeCloseTo(54.4863, 3);
    expect(r.z).toBe(16);
    expect(r.f.lat).toBeCloseTo(54.4863, 3);
  });

  test('clamps z to 12-19 and defaults it to 15', async ({ page, api }) => {
    await openStore(page, '?lat=54&lng=-1&z=3');
    expect(await page.evaluate(() => map.getZoom())).toBe(12);
    await openStore(page, '?lat=54&lng=-1');
    expect(await page.evaluate(() => map.getZoom())).toBe(15);
  });

  test('ignores off-map or garbage coordinates', async ({ page, api }) => {
    await openStore(page, '?lat=95&lng=0');
    expect(await page.evaluate(() => map.getCenter().lat)).toBeCloseTo(51.505, 3);
    await openStore(page, '?lat=abc&lng=1');
    expect(await page.evaluate(() => map.getCenter().lat)).toBeCloseTo(51.505, 3);
  });
});

test('config endpoint can redirect API calls', async ({ page, api }) => {
  api.on('GET /api/config', { json: { POLYPLACES_API_BASE_URL: `${API}/v2/` } });
  api.on('GET /v2/api/products', { json: PRODUCTS_RESPONSE });
  await page.goto('/store/');
  await expect.poll(() => page.evaluate(() => apiBase)).toBe(`${API}/v2`);
});
