import { test, expect, openStore, readCart, cartItem, fbqEvents, gaEvents, DEFAULT_STORAGE } from './fixtures.js';

const CART_KEY = 'polyplaces_cart_v1';

// Add to cart goes through the 3D preview offer for small frames.
async function addToCart(page) {
  await page.locator('#sel-run').click();
  await page.locator('[data-pv="skip"]').click();
  await expect(page.locator('body')).toHaveClass(/cart-open/);
}

function seedCart(page, items) {
  return page.addInitScript(([k, v]) => {
    if (!sessionStorage.getItem('__cart_seeded')) {
      sessionStorage.setItem('__cart_seeded', '1');
      localStorage.setItem(k, v);
    }
  }, [CART_KEY, JSON.stringify(items)]);
}

test.describe('adding to cart', () => {
  test('stores the full selection and opens the drawer', async ({ page, api }) => {
    await openStore(page, '?scale=medium');
    await page.locator('label[for="frame-colour-fprice_medium_white-prod_medium"]').click();
    await page.locator('#rotation-btn').click();
    await page.locator('#custom-location-label').fill('  Where we met  ');
    await addToCart(page);

    const [geo] = api.requests('GET /api/reverse-geocode');
    const meta = await page.evaluate(() => selectionMeta.center);
    expect(Number(geo.query.lat)).toBeCloseTo(meta.lat, 8);
    expect(Number(geo.query.lon)).toBeCloseTo(meta.lng, 8);

    const [item] = await readCart(page);
    expect(item).toMatchObject({
      productId: 'prod_medium', priceId: 'price_medium', name: 'Medium', sizeCode: '750',
      price: 50, location: 'Westminster, London', customLabel: 'Where we met',
      rotation: 90, zoom: 1, landscape: false,
      frame: true, framePriceId: 'fprice_medium_white', frameProductId: 'fprod_medium_white',
      frameUnitAmount: 1500, frameName: 'White',
    });
    expect(item.id).toMatch(/[0-9a-f-]{36}/);
    expect(item.bbox.north).toBeGreaterThan(item.bbox.south);

    await expect(page.locator('#custom-location-label')).toHaveValue('');
    await expect(page.locator('#sel-run')).toHaveText('✓ Added to cart');
    await expect(page.locator('#order-status-msg')).toHaveText('✓ Added to cart.');
    await expect(page.locator('#cart-count')).toHaveText('1');
    await expect(page.locator('.cart-item-title')).toHaveText('Medium');
    await expect(page.locator('.cart-item-frame')).toHaveText('White');
    await expect(page.locator('.cart-item-custom-label')).toHaveText('Where we met');
    await expect(page.locator('#cart-total')).toHaveText('£50');
  });

  test('falls back through label, display_name and "Location unavailable"', async ({ page, api }) => {
    await openStore(page);
    api.on('GET /api/reverse-geocode', { json: { display_name: 'Southwark' } });
    await addToCart(page);
    await page.keyboard.press('Escape');
    api.on('GET /api/reverse-geocode', { status: 500, json: {} });
    await addToCart(page);
    expect((await readCart(page)).map((i) => i.location)).toEqual(['Southwark', 'Location unavailable']);
  });

  test('records landscape mode and shows it in the cart', async ({ page, api }) => {
    await openStore(page);
    await page.locator('#landscape-toggle-btn').click();
    await addToCart(page);
    const [item] = await readCart(page);
    expect(item).toMatchObject({ landscape: true, zoom: 4.5 });
    await expect(page.locator('.cart-item-landscape')).toHaveText('Landscape · no buildings');
  });

  test('moving the frame after adding resets the button label', async ({ page, api }) => {
    await openStore(page);
    await addToCart(page);
    await page.keyboard.press('Escape');
    await page.locator('#zoom-slider').fill('1.2');
    await expect(page.locator('#sel-run')).toHaveText('Add to cart →');
  });

  test('tracks AddToCart', async ({ page, api }) => {
    await openStore(page);
    await addToCart(page);
    expect(await fbqEvents(page, 'AddToCart')).toEqual([
      { content_ids: ['price_small'], content_name: 'Small', content_type: 'product', value: 30, currency: 'GBP' },
    ]);
  });

  test('stops at 10 items', async ({ page, api }) => {
    await seedCart(page, Array.from({ length: 10 }, () => cartItem()));
    await openStore(page);
    await page.locator('#sel-run').click();
    await page.locator('[data-pv="skip"]').click();
    await expect(page.locator('#checkout-banner-text')).toHaveText('You can only add up to 10 items to your cart.');
    expect(await readCart(page)).toHaveLength(10);
  });
});

test.describe('cart drawer', () => {
  test('renders seeded items, totals and removes the right one', async ({ page, api }) => {
    await seedCart(page, [
      cartItem({ id: 'a', name: 'Small', price: 30 }),
      cartItem({ id: 'b', name: 'Large', price: 67, frame: true, framePriceId: 'f', frameName: 'Oak' }),
      cartItem({ id: 'c', name: 'Medium', price: 35 }),
    ]);
    await page.goto('/about/');
    await expect(page.locator('#cart-count')).toHaveText('3');
    await expect(page.locator('#cart-toggle')).toHaveAttribute('aria-label', 'Open cart (3 items)');
    await page.locator('#cart-toggle').click();
    await expect(page.locator('#cart-total')).toHaveText('£132');
    await page.locator('.cart-item-remove').nth(1).click();
    await expect(page.locator('.cart-item-title')).toHaveText(['Small', 'Medium']);
    await expect(page.locator('#cart-total')).toHaveText('£65');
    expect((await readCart(page)).map((i) => i.id)).toEqual(['a', 'c']);
    await expect(page.locator('#cart-toggle')).toHaveAttribute('aria-label', 'Open cart (2 items)');
  });

  test('empty cart disables checkout', async ({ page, api }) => {
    await page.goto('/about/');
    await page.locator('#cart-toggle').click();
    await expect(page.locator('.cart-empty')).toBeVisible();
    await expect(page.locator('#cart-checkout')).toBeDisabled();
    await expect(page.locator('#cart-total')).toHaveText('£0');
    await expect(page.locator('#cart-toggle')).toHaveAttribute('aria-label', 'Open cart (0 items)');
  });

  test('singular label for one item', async ({ page, api }) => {
    await seedCart(page, [cartItem()]);
    await page.goto('/about/');
    await expect(page.locator('#cart-toggle')).toHaveAttribute('aria-label', 'Open cart (1 item)');
  });

  test('drops corrupt entries and survives corrupt JSON', async ({ page, api }) => {
    await seedCart(page, [cartItem({ id: 'ok' }), { name: 'no price id' }, null]);
    await page.goto('/about/');
    await expect(page.locator('#cart-count')).toHaveText('1');

    await page.evaluate((k) => localStorage.setItem(k, '{not json'), CART_KEY);
    await page.reload();
    await expect(page.locator('#cart-count')).toHaveText('0');
    expect(page.pageErrors).toEqual([]);
  });

  test('cart text is rendered safely', async ({ page, api }) => {
    await seedCart(page, [cartItem({ name: '<img src=x onerror="window.__xss=1">', location: '<b>loc</b>', customLabel: '<i>x</i>' })]);
    await page.goto('/about/');
    await page.locator('#cart-toggle').click();
    await expect(page.locator('.cart-item-title')).toHaveText('<img src=x onerror="window.__xss=1">');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('recomputes a missing bbox from the centre for older carts', async ({ page, api }) => {
    const old = cartItem({ id: 'old' });
    delete old.bbox;
    await seedCart(page, [old, cartItem({ id: 'broken', bbox: null, center: null })]);
    await openStore(page); // cart previews need Leaflet, which only the map pages load
    await page.locator('#cart-toggle').click();
    await expect(page.locator('.cart-item-preview[data-item-id="old"].leaflet-container')).toHaveCount(1);
    await expect(page.locator('.cart-item-preview[data-item-id="broken"]')).toHaveText('Preview unavailable');
    const saved = await readCart(page);
    expect(saved[0].bbox.north).toBeGreaterThan(saved[0].bbox.south);
  });

  test('open/close via toggle, overlay, close button and Escape; focus is trapped and restored', async ({ page, api }) => {
    await seedCart(page, [cartItem()]);
    await page.goto('/about/');
    const toggle = page.locator('#cart-toggle');
    const drawer = page.locator('#cart-drawer');

    await toggle.click();
    await expect(page.locator('body')).toHaveClass(/cart-open/);
    await expect(drawer).toHaveAttribute('aria-hidden', 'false');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#cart-close')).toBeFocused();

    // Tab cycles inside the drawer.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.getElementById('cart-drawer').contains(document.activeElement))).toBe(true);
    }
    await page.locator('#cart-close').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#cart-checkout')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/cart-open/);
    await expect(drawer).toHaveAttribute('aria-hidden', 'true');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();

    await toggle.click();
    await page.locator('#cart-overlay').click({ position: { x: 300, y: 400 } });
    await expect(page.locator('body')).not.toHaveClass(/cart-open/);
  });

  // KNOWN BUG (frontend-test-plan.md 4.9): nav is z-index 1100 and the drawer
  // 900, so the fixed 60px nav covers the drawer header - its title and Close
  // button cannot be seen or clicked on desktop.
  test.fail('the drawer Close button can be clicked', async ({ page, api }) => {
    await page.goto('/about/');
    await page.locator('#cart-toggle').click();
    await page.locator('#cart-close').click({ timeout: 2000 });
    await expect(page.locator('body')).not.toHaveClass(/cart-open/);
  });

  test('cart persists from the store to other pages', async ({ page, api }) => {
    await openStore(page);
    await addToCart(page);
    await page.goto('/faq/');
    await expect(page.locator('#cart-count')).toHaveText('1');
  });
});

test.describe('checkout', () => {
  test('posts the v2 payload and redirects to Stripe', async ({ page, api }) => {
    await seedCart(page, [
      cartItem({ id: 'a', sizeCode: 500, price: 40, frame: true, framePriceId: 'fprice_small_oak', frameProductId: 'fprod_small_oak', customLabel: 'Home' }),
      cartItem({ id: 'b', productId: 'prod_large', priceId: 'price_large', sizeCode: '2000', landscape: true, zoom: 4.5, rotation: 0 }),
      cartItem({ id: 'c', productId: 'custom', priceId: 'custom', sizeCode: 600, customWidthMm: 200, customHeightMm: 300 }),
    ]);
    await page.goto('/about/');
    await page.locator('#cart-toggle').click();
    await page.locator('#cart-checkout').click();
    await page.waitForURL('https://checkout.stripe.com/**');

    const [{ body }] = api.requests('POST /api/checkout');
    const [a, b, c] = body.items;
    expect(a).toEqual({
      priceId: 'price_small', productId: 'prod_small', sizeCode: '500',
      bbox: expect.any(Object), center: expect.any(Object), rotation: 0, zoom: 1, landscape: false,
      location: 'Westminster, London', customLabel: 'Home',
      framed: true, frame: { productId: 'fprod_small_oak', priceId: 'fprice_small_oak' },
    });
    expect(b).toMatchObject({ priceId: 'price_large', sizeCode: '2000', landscape: true, zoom: 4.5, framed: false });
    expect(b).not.toHaveProperty('frame');
    expect(c).toMatchObject({ priceId: 'custom', customWidthMm: 200, customHeightMm: 300, framed: false });
  });

  test('recovers the frame product id from frame options for older carts', async ({ page, api }) => {
    await seedCart(page, [cartItem({ frame: true, framePriceId: 'fprice_small_black', frameProductId: undefined })]);
    await openStore(page); // loads frame options
    await page.locator('#cart-toggle').click();
    await page.locator('#cart-checkout').click();
    const [{ body }] = await api.waitFor('POST /api/checkout');
    expect(body.items[0].frame).toEqual({ productId: 'fprod_small_black', priceId: 'fprice_small_black' });
  });

  test('falls back to the flat framePriceId when the product id is unknown', async ({ page, api }) => {
    await seedCart(page, [cartItem({ frame: true, framePriceId: 'fprice_unknown', frameProductId: null })]);
    await page.goto('/about/');
    await page.locator('#cart-toggle').click();
    await page.locator('#cart-checkout').click();
    const [{ body }] = await api.waitFor('POST /api/checkout');
    expect(body.items[0]).toMatchObject({ framePriceId: 'fprice_unknown' });
    expect(body.items[0]).not.toHaveProperty('framed');
  });

  test('omits an empty sizeCode', async ({ page, api }) => {
    await seedCart(page, [cartItem({ sizeCode: '' })]);
    await page.goto('/about/');
    await page.locator('#cart-toggle').click();
    await page.locator('#cart-checkout').click();
    const [{ body }] = await api.waitFor('POST /api/checkout');
    expect(body.items[0]).not.toHaveProperty('sizeCode');
  });

  test('blocks fallback price ids', async ({ page, api }) => {
    await seedCart(page, [cartItem({ priceId: 'fallback_small' })]);
    await page.goto('/about/');
    await page.locator('#cart-toggle').click();
    await page.locator('#cart-checkout').click();
    await expect(page.locator('#checkout-banner-text')).toHaveText('Checkout is temporarily unavailable. Please try again shortly.');
    expect(api.requests('POST /api/checkout')).toHaveLength(0);
  });

  test('blocks a framed item with no frame price', async ({ page, api }) => {
    await seedCart(page, [cartItem({ frame: true, framePriceId: null })]);
    await page.goto('/about/');
    await page.locator('#cart-toggle').click();
    await page.locator('#cart-checkout').click();
    await expect(page.locator('#checkout-banner-text')).toHaveText('Please select a frame colour for all items with frames.');
    expect(api.requests('POST /api/checkout')).toHaveLength(0);
  });

  test('shows the API error, clears product caches and restores the button', async ({ page, api }) => {
    await seedCart(page, [cartItem()]);
    await page.addInitScript(() => localStorage.setItem('polyplaces_store_cache_v1', '{"ts":1,"products":[]}'));
    api.on('POST /api/checkout', { status: 400, json: { error: 'Price no longer available' }, delay: 300 });
    await page.goto('/about/');
    await page.locator('#cart-toggle').click();
    await page.locator('#cart-checkout').click();
    await expect(page.locator('#cart-checkout')).toHaveText('Redirecting...');
    await expect(page.locator('#cart-checkout')).toBeDisabled();
    await expect(page.locator('#checkout-banner-text')).toHaveText('Price no longer available');
    await expect(page.locator('#cart-checkout')).toHaveText('Checkout securely with Stripe');
    await expect(page.locator('#cart-checkout')).toBeEnabled();
    expect(await page.evaluate(() => localStorage.getItem('polyplaces_store_cache_v1'))).toBeNull();
  });

  test('treats a 200 without a url as a failure', async ({ page, api }) => {
    await seedCart(page, [cartItem()]);
    api.on('POST /api/checkout', { json: {} });
    await page.goto('/about/');
    await page.locator('#cart-toggle').click();
    await page.locator('#cart-checkout').click();
    await expect(page.locator('#checkout-banner-text')).toHaveText('Checkout failed');
  });

  test.describe('with analytics consent', () => {
    test.use({ storage: { ...DEFAULT_STORAGE, pp_cn: '1' } });

    test('tracks InitiateCheckout and begin_checkout', async ({ page, api }) => {
      await seedCart(page, [cartItem({ price: 30 }), cartItem({ priceId: 'price_large', name: 'Large', price: 45 })]);
      api.on('POST /api/checkout', { status: 500, json: {} });
      await page.goto('/about/');
      await page.locator('#cart-toggle').click();
      await page.locator('#cart-checkout').click();
      await expect(page.locator('#checkout-banner')).toHaveClass(/show/);
      expect(await fbqEvents(page, 'InitiateCheckout')).toEqual([
        { content_ids: ['price_small', 'price_large'], content_type: 'product', num_items: 2, value: 75, currency: 'GBP' },
      ]);
      const [ga] = await gaEvents(page, 'begin_checkout');
      expect(ga.params).toMatchObject({ value: 75, currency: 'GBP' });
      expect(ga.params.items).toHaveLength(2);
    });
  });
});

test.describe('checkout return banner', () => {
  test.use({ storage: { ...DEFAULT_STORAGE, pp_cn: '1' } });

  for (const [status, text] of [
    ['fail', 'Payment failed. Please try again or use a different card.'],
    ['abort', 'Checkout cancelled. You can resume anytime from your cart.'],
    ['other', 'Checkout updated.'],
  ]) {
    test(`?checkout=${status} shows its message and keeps the cart`, async ({ page, api }) => {
      await seedCart(page, [cartItem()]);
      await page.goto(`/about/?checkout=${status}&utm=x`);
      await expect(page.locator('#checkout-banner')).toHaveClass(new RegExp(`show.*is-${status}`));
      await expect(page.locator('#checkout-banner-text')).toHaveText(text);
      await expect(page.locator('#checkout-banner')).toHaveAttribute('aria-hidden', 'false');
      expect(page.url()).toMatch(/\/about\/\?utm=x$/);
      expect(await readCart(page)).toHaveLength(1);

      await page.locator('#checkout-banner-close').click();
      await expect(page.locator('#checkout-banner')).not.toHaveClass(/show/);
      await expect(page.locator('#checkout-banner')).toHaveAttribute('aria-hidden', 'true');
    });
  }

  test('?checkout=success clears the cart and tracks Purchase once per session', async ({ page, api }) => {
    await seedCart(page, [cartItem({ price: 40, priceId: 'price_small' })]);
    await page.goto('/about/?checkout=success&session_id=cs_test_1');
    await expect(page.locator('#checkout-banner-text')).toHaveText('Payment successful. We have received your order.');
    await expect(page.locator('#cart-count')).toHaveText('0');
    expect(await readCart(page)).toEqual([]);
    expect(await fbqEvents(page, 'Purchase')).toEqual([
      { content_ids: ['price_small'], content_type: 'product', num_items: 1, value: 40, currency: 'GBP' },
    ]);

    // Back-button / reload with the same session: no second Purchase.
    await page.goto('/about/?checkout=success&session_id=cs_test_1');
    expect(await fbqEvents(page, 'Purchase')).toEqual([]);
  });

  // KNOWN BUG (frontend-test-plan.md 4.8): analytics.js loads after app.js,
  // and showCheckoutBanner runs as app.js loads, so window.ppTrackGA does not
  // exist yet and the GA4 purchase event is never sent.
  test.fail('?checkout=success sends the GA4 purchase event', async ({ page, api }) => {
    await seedCart(page, [cartItem({ price: 40 })]);
    await page.goto('/about/?checkout=success&session_id=cs_test_2');
    await expect(page.locator('#checkout-banner')).toHaveClass(/show/);
    const [ga] = await gaEvents(page, 'purchase');
    expect(ga?.params).toMatchObject({ transaction_id: 'cs_test_2', value: 40, currency: 'GBP' });
  });

  test('no banner without the param', async ({ page, api }) => {
    await page.goto('/about/');
    await expect(page.locator('#checkout-banner')).not.toHaveClass(/show/);
  });

  // KNOWN BUG (frontend-test-plan.md 4.1): the status goes into classList.add
  // unescaped. Whitespace throws, which aborts app.js and kills the store.
  test.fail('a malformed ?checkout= value does not break the page', async ({ page, api }) => {
    await page.goto('/store/?checkout=a%20b');
    await expect(page.locator('.size-opt').first()).toBeVisible({ timeout: 3000 });
    expect(page.pageErrors).toEqual([]);
  });
});
