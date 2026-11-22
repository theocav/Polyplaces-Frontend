// Pure helpers in app.js. It is a classic script, so its top-level functions
// and let/const bindings are reachable from page.evaluate on any page.

import { test, expect } from './fixtures.js';

test.beforeEach(async ({ page, api }) => {
  await page.goto('/about/');
  await page.waitForFunction(() => typeof computeRotatedCorners === 'function');
});

test('sanitizeProductList keeps only well-formed, non-blacklisted products', async ({ page }) => {
  const out = await page.evaluate(() => sanitizeProductList([
    { id: 'a', name: 'A', priceId: 'p' },
    { id: 'district', name: 'District', priceId: 'p' },
    { id: 1, name: 'Num', priceId: 'p' },
    { id: 'b', name: 'B' },
    null,
  ]));
  expect(out.map((p) => p.id)).toEqual(['a']);
  expect(await page.evaluate(() => sanitizeProductList('nope'))).toEqual([]);
});

test('price formatting', async ({ page }) => {
  const r = await page.evaluate(() => [
    formatPriceFromAmount(3000), formatPriceFromAmount(3050), formatPriceFromAmount(null),
    formatPriceFromAmount(undefined), formatPriceFromAmount('abc'),
    formatPrice(45), formatPrice('x'),
  ]);
  expect(r).toEqual(['£30', '£31', '£—', '£—', '£—', '£45', '£—']);
});

test('escapeHtml neutralises markup', async ({ page }) => {
  expect(await page.evaluate(() => escapeHtml('<img src=x onerror="a()">&'))).toBe('&lt;img src=x onerror="a()"&gt;&amp;');
  expect(await page.evaluate(() => escapeHtml(null))).toBe('');
});

test('computeBBoxForProduct sizes the frame in metres', async ({ page }) => {
  const b = await page.evaluate(() => computeBBoxForProduct({ lat: 0, lng: 0 }, { sizeCode: '1000', aspectRatio: 1.4 }, 2));
  // 2000 m wide x 2800 m tall at the equator.
  expect((b.north - b.south) * 111320).toBeCloseTo(2800, 0);
  expect((b.east - b.west) * 111320).toBeCloseTo(2000, 0);
  const bad = await page.evaluate(() => [
    computeBBoxForProduct({ lat: 0, lng: 0 }, { sizeCode: 'x' }),
    computeBBoxForProduct({ lat: 0, lng: 0 }, null),
  ]);
  expect(bad).toEqual([null, null]);
  const ratioFallback = await page.evaluate(() => computeBBoxForProduct({ lat: 0, lng: 0 }, { sizeCode: 100, aspectRatio: -1 }));
  expect(ratioFallback.north - ratioFallback.south).toBeCloseTo(ratioFallback.east - ratioFallback.west, 10);
});

test('computeRotatedCorners matches the bbox at 0 degrees and swaps extents at 90', async ({ page }) => {
  const r = await page.evaluate(() => {
    const product = { sizeCode: 1000, aspectRatio: 1.4 };
    const c = { lat: 51.5, lng: -0.1 };
    return {
      flat: computeRotatedCorners(c, product, 0, 1),
      bbox: computeBBoxForProduct(c, product, 1),
      turned: cornersToBBox(computeRotatedCorners(c, product, 90, 1)),
      none: computeRotatedCorners(c, { sizeCode: 0 }, 0, 1),
    };
  });
  const [tl, tr, br, bl] = r.flat;
  expect(tl[0]).toBeCloseTo(r.bbox.north, 10);
  expect(tl[1]).toBeCloseTo(r.bbox.west, 10);
  expect(tr[1]).toBeCloseTo(r.bbox.east, 10);
  expect(br[0]).toBeCloseTo(r.bbox.south, 10);
  expect(bl[1]).toBeCloseTo(r.bbox.west, 10);
  // Rotated 90 degrees: the 1400 m side now runs east-west.
  expect((r.turned.north - r.turned.south) * 111320).toBeCloseTo(1000, 0);
  expect(r.none).toBeNull();
});

test('findTopLeftCorner picks the northernmost, then westernmost corner', async ({ page }) => {
  expect(await page.evaluate(() => findTopLeftCorner([[1, 5], [2, 3], [2, 1], [0, 0]]))).toBe(2);
});

test('easing and lerp endpoints', async ({ page }) => {
  expect(await page.evaluate(() => [easeInOutCubic(0), easeInOutCubic(0.5), easeInOutCubic(1), lerp(2, 4, 0.25)]))
    .toEqual([0, 0.5, 1, 2.5]);
});

test('zoom label stretches landscape zoom to read 2-10x', async ({ page }) => {
  const r = await page.evaluate(() => {
    landscapeMode = true;
    const out = [zoomLabel(2), zoomLabel(7), zoomLabel(4.5)];
    landscapeMode = false;
    out.push(zoomLabel(1.3));
    return out;
  });
  expect(r).toEqual(['2.0×', '10.0×', '6.0×', '1.3×']);
});

test('getEffectiveUnitAmount adds the chosen frame', async ({ page }) => {
  const r = await page.evaluate(() => {
    frameOptions = { small: [{ priceId: 'f1', unitAmount: 1000 }] };
    const p = { frameKey: 'small', unitAmount: 3000 };
    return [getEffectiveUnitAmount(p, 'f1'), getEffectiveUnitAmount(p, 'nope'), getEffectiveUnitAmount(p, null), getEffectiveUnitAmount(null, 'f1')];
  });
  expect(r).toEqual([4000, 3000, 3000, null]);
});

test('_applyFramePrices validates entries and replaces the whole map', async ({ page }) => {
  const r = await page.evaluate(() => {
    frameOptions = { old: [{ priceId: 'gone' }] };
    _applyFramePrices({
      small: [
        { priceId: 'ok', productId: 'fp', unitAmount: 1000, colourHex: '#abc', colourName: 'Oak', extra: 'dropped' },
        { priceId: 'badhex', unitAmount: 1000, colourHex: 'red', colourName: 'Red' },
        { priceId: 'noamount', unitAmount: '1000', colourHex: '#000', colourName: 'Black' },
      ],
      empty: [],
      allBad: [{ priceId: 1 }],
    });
    const first = JSON.parse(JSON.stringify(frameOptions));
    _applyFramePrices({ x: [{ priceId: 1 }] }); // nothing valid: keep what we have
    _applyFramePrices(null);
    return { first, after: frameOptions };
  });
  expect(r.first).toEqual({ small: [{ priceId: 'ok', productId: 'fp', unitAmount: 1000, colourHex: '#abc', colourName: 'Oak' }] });
  expect(r.after).toEqual(r.first);
});

test('_resolveFrameProductId recovers ids for older carts', async ({ page }) => {
  const r = await page.evaluate(() => {
    frameOptions = { small: [{ priceId: 'fp1', productId: 'prodF' }, { priceId: 'fp2' }] };
    return [
      _resolveFrameProductId({ framePriceId: 'fp1', frameProductId: 'stored' }),
      _resolveFrameProductId({ framePriceId: 'fp1' }),
      _resolveFrameProductId({ framePriceId: 'fp2' }),
      _resolveFrameProductId({ framePriceId: null }),
      _resolveFrameProductId(null),
    ];
  });
  expect(r).toEqual(['stored', 'prodF', null, null, null]);
});

test('buildCustomProduct maps millimetres to map metres', async ({ page }) => {
  expect(await page.evaluate(() => buildCustomProduct(200, 300, 2500))).toEqual({
    id: 'custom', name: 'Custom', displaySize: '200×300mm', sizeCode: 600, aspectRatio: 1.5,
    unitAmount: 2500, priceId: 'custom', customWidthMm: 200, customHeightMm: 300,
  });
});

test('previewPieceMm reads the physical size', async ({ page }) => {
  const r = await page.evaluate(() => [
    previewPieceMm({ displaySize: '20cm x 20cm' }),
    previewPieceMm({ displaySize: '32 cm × 32 cm' }),
    previewPieceMm({ displaySize: 'A4' }),
    previewPieceMm({ id: 'custom', customWidthMm: 250, customHeightMm: 180 }),
    previewPieceMm({ displaySize: '??', aspectRatio: 1.5 }),
  ]);
  expect(r).toEqual([[200, 200], [320, 320], [210, 297], [250, 180], [200, 300]]);
});

test('previewFrameChoices lowercases colours and skips custom', async ({ page }) => {
  const r = await page.evaluate(() => {
    frameOptions = { small: [{ priceId: 'f', colourName: 'Oak' }] };
    return [previewFrameChoices({ id: 'x', frameKey: 'small' }), previewFrameChoices({ id: 'custom', frameKey: 'small' }), previewFrameChoices(null)];
  });
  expect(r).toEqual([[{ priceId: 'f', colourName: 'Oak', colour: 'oak' }], [], []]);
});

test('galleryEyebrow labels', async ({ page }) => {
  const r = await page.evaluate(() => [
    galleryEyebrow({ size: 'small', frame: 'oak' }),
    galleryEyebrow({ size: 'a4' }),
    galleryEyebrow({ size: 'custom', widthCm: 25, heightCm: 18, frame: 'black' }),
    galleryEyebrow({ size: 'custom', frame: 'pink' }),
  ]);
  expect(r).toEqual([
    'Small · 20 × 20cm · Oak frame',
    'A4 · 20 × 28cm',
    'Custom · 25 × 18cm · Black frame',
    'Custom · any size',
  ]);
});
