import { test, expect, openStore, readCart } from './fixtures.js';

async function chooseCustom(page) {
  await page.locator('.size-opt-custom').click();
  await expect(page.locator('#custom-size-panel')).toBeVisible();
  await expect(page.locator('#order-scale')).toHaveText(/^Custom/);
}

test('activating custom fetches a price and places a custom frame', async ({ page, api }) => {
  await openStore(page);
  await chooseCustom(page);
  const [req] = api.requests('GET /api/custom-size-price');
  expect(req.query).toEqual({ widthMm: '200', heightMm: '200' });
  await expect(page.locator('.size-opt-custom .size-opt-price')).toHaveText('£24'); // 2000 + 400 pence
  await expect(page.locator('#order-scale')).toHaveText('Custom · 200×200mm');
  await expect(page.locator('#order-price')).toHaveText('£24');
  await expect(page.locator('.size-opt.active')).toHaveAttribute('data-product-id', 'custom');
  await expect(page.locator('#rotation-btn')).toBeDisabled();
  // 200 mm at 3 m per mm -> a 600 m wide frame.
  await page.waitForFunction(() => !bboxAnim);
  const w = await page.evaluate(() => (bbox.east - bbox.west) * 111320 * Math.cos(frameCenter.lat * Math.PI / 180));
  expect(w).toBeCloseTo(600, -1);
});

test('dimensions are clamped to 100-330 mm and rounded', async ({ page, api }) => {
  await openStore(page);
  await chooseCustom(page);
  await page.locator('#custom-width').fill('500');
  await page.locator('#custom-height').fill('42.6');
  await expect.poll(() => api.requests('GET /api/custom-size-price').at(-1).query).toEqual({ widthMm: '330', heightMm: '100' });
  await expect(page.locator('#order-scale')).toHaveText('Custom · 330×100mm');
});

test('surcharge note shows above 300 mm', async ({ page, api }) => {
  await openStore(page);
  await chooseCustom(page);
  await expect(page.locator('#custom-size-surcharge-note')).toBeHidden();
  await page.locator('#custom-height').fill('301');
  await expect(page.locator('#custom-size-surcharge-note')).toBeVisible();
  await page.locator('#custom-height').fill('300');
  await expect(page.locator('#custom-size-surcharge-note')).toBeHidden();
});

test('typing is debounced into one price request', async ({ page, api }) => {
  await openStore(page);
  await chooseCustom(page);
  const before = api.requests('GET /api/custom-size-price').length;
  for (const v of ['2', '25', '250']) await page.locator('#custom-width').fill(v);
  await expect(page.locator('.size-opt-custom .size-opt-price')).toHaveText('…');
  await expect(page.locator('#order-scale')).toHaveText('Custom · 250×200mm');
  expect(api.requests('GET /api/custom-size-price').length - before).toBe(1);
});

test('empty or zero inputs do nothing', async ({ page, api }) => {
  await openStore(page);
  await chooseCustom(page);
  const before = api.requests('GET /api/custom-size-price').length;
  await page.locator('#custom-width').fill('');
  await page.locator('#custom-height').fill('0');
  await page.waitForTimeout(600);
  expect(api.requests('GET /api/custom-size-price').length).toBe(before);
});

for (const [name, res] of [['an HTTP error', { status: 500, json: {} }], ['a bad body', { json: { unitAmount: '12' } }]]) {
  test(`price failure (${name}) shows a dash and a banner`, async ({ page, api }) => {
    api.on('GET /api/custom-size-price', res);
    await openStore(page);
    await page.locator('.size-opt-custom').click();
    await expect(page.locator('.size-opt-custom .size-opt-price')).toHaveText('—');
    await expect(page.locator('#checkout-banner-text')).toHaveText('Unable to fetch price for this size. Please try again.');
  });
}

// KNOWN BUG (frontend-test-plan.md 4.2): input changes are ignored until
// selectedProduct is the custom product, which only happens after a price
// fetch succeeds. After a failure, editing the size never retries.
test.fail('editing the size after a failed price fetch retries', async ({ page, api }) => {
  api.on('GET /api/custom-size-price', { status: 500, json: {} });
  await openStore(page);
  await page.locator('.size-opt-custom').click();
  await expect(page.locator('.size-opt-custom .size-opt-price')).toHaveText('—');
  api.on('GET /api/custom-size-price', { json: { unitAmount: 2500 } });
  await page.locator('#custom-width').fill('210');
  await expect(page.locator('#order-scale')).toHaveText('Custom · 210×200mm', { timeout: 2000 });
});

test('custom item goes into the cart with its dimensions and no frame', async ({ page, api }) => {
  await openStore(page);
  await chooseCustom(page);
  await page.locator('#sel-run').click();
  await page.locator('[data-pv="skip"]').click();
  await expect.poll(() => readCart(page)).toHaveLength(1);
  const [item] = await readCart(page);
  expect(item).toMatchObject({
    productId: 'custom', priceId: 'custom', price: 24, customWidthMm: 200, customHeightMm: 200, frame: false,
  });
});

test('picking a standard size hides the custom panel', async ({ page, api }) => {
  await openStore(page);
  await chooseCustom(page);
  await page.locator('.size-opt[data-product-id="prod_large"]').click();
  await expect(page.locator('#custom-size-panel')).toBeHidden();
});
