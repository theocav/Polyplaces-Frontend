import { test, expect } from './fixtures.js';

test.beforeEach(async ({ page, api }) => {
  await page.goto('/etsy/');
  await expect(page.locator('.size-opt.active')).toBeVisible();
});

test('offers the four fixed Etsy sizes with no prices or custom option', async ({ page }) => {
  await expect(page.locator('.size-opt:visible .size-opt-name')).toHaveText(['15 × 15', '29 × 21', '25 × 25', '30 × 30']);
  await expect(page.locator('.size-opt-price').first()).toBeHidden();
  await expect(page.locator('.size-opt-custom')).toBeHidden();
  await expect(page.locator('.size-opt.active')).toHaveAttribute('data-product-id', 'etsy-15x15');
});

test('makes no product, cart or pricing calls', async ({ page, api }) => {
  await page.locator('.size-opt[data-product-id="etsy-30x30"]').click();
  await page.waitForTimeout(300);
  for (const key of ['GET /api/products', 'GET /api/custom-size-price', 'GET /api/reverse-geocode']) {
    expect(api.requests(key)).toHaveLength(0);
  }
  expect(page.pageErrors).toEqual([]);
});

test('the 29 x 21 size rotates; squares do not', async ({ page }) => {
  await expect(page.locator('#rotation-btn')).toBeDisabled();
  await page.locator('.size-opt[data-product-id="etsy-29x21"]').click();
  await expect(page.locator('#rotation-btn')).toBeEnabled();
});

test('Copy puts west,south,east,north on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#etsy-copy').click();
  await expect(page.locator('#etsy-copy')).toHaveText('✓ Copied');
  await expect(page.locator('#etsy-copy')).toHaveClass(/is-copied/);
  const [text, b] = await Promise.all([
    page.evaluate(() => navigator.clipboard.readText()),
    page.evaluate(() => bbox),
  ]);
  expect(text).toBe([b.west, b.south, b.east, b.north].map((n) => n.toFixed(6)).join(','));
  await expect(page.locator('#etsy-copy')).toHaveText('Copy', { timeout: 3000 });
});

test('a clipboard failure says so', async ({ page }) => {
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
  });
  await page.locator('#etsy-copy').click();
  await expect(page.locator('#etsy-copy')).toHaveText('Copy failed');
  await expect(page.locator('#etsy-copy')).toHaveClass(/is-copyfail/);
});

test.describe('newsletter popup', () => {
  test.use({ storage: { pp_cn: '0' } });

  test('never appears on the Etsy tool', async ({ page }) => {
    await page.mouse.move(400, 300);
    await page.mouse.move(400, -5);
    await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { clientY: -1, bubbles: true })));
    await page.waitForTimeout(200);
    await expect(page.locator('.nl-overlay')).toHaveCount(0);
  });
});
