// Site-wide behaviour from app.js and analytics.js: nav drawer, cookie
// consent, the newsletter popup and the viewport height fix.

import { test, expect, fbqEvents, gaEvents, openStore } from './fixtures.js';

test.describe('nav drawer @mobile', () => {
  test.beforeEach(async ({ page, api }) => {
    await page.goto('/about/');
  });

  const toggle = (page) => page.locator('#nav-toggle');
  const drawer = (page) => page.locator('#nav-drawer');

  test('opens and closes from the toggle, with labels and focus', async ({ page }) => {
    await toggle(page).click();
    await expect(page.locator('body')).toHaveClass(/nav-open/);
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle(page)).toHaveAttribute('aria-label', 'Close menu');
    await expect(drawer(page)).toHaveAttribute('aria-hidden', 'false');
    expect(await page.evaluate(() => document.getElementById('nav-drawer').contains(document.activeElement))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/nav-open/);
    await expect(toggle(page)).toHaveAttribute('aria-label', 'Open menu');
    await expect(drawer(page)).toHaveAttribute('aria-hidden', 'true');
    await expect(toggle(page)).toBeFocused();
  });

  test('traps Tab inside the drawer', async ({ page }) => {
    await toggle(page).click();
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.getElementById('nav-drawer').contains(document.activeElement))).toBe(true);
    }
  });

  test('the overlay closes it', async ({ page }) => {
    await toggle(page).click();
    await page.locator('#nav-overlay').click({ position: { x: 40, y: 600 } }); // drawer is on the right
    await expect(page.locator('body')).not.toHaveClass(/nav-open/);
  });

  test('following a link closes it', async ({ page }) => {
    await toggle(page).click();
    await drawer(page).locator('a[href="/contact/"]').click();
    await page.waitForURL(/\/contact\//);
  });

  test('swiping left closes it; a small swipe does not', async ({ page }) => {
    await toggle(page).click();
    const swipe = (dx) => drawer(page).evaluate((el, d) => {
      const t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 });
      el.dispatchEvent(new TouchEvent('touchstart', { changedTouches: [t(200)], bubbles: true }));
      el.dispatchEvent(new TouchEvent('touchend', { changedTouches: [t(200 - d)], bubbles: true }));
    }, dx);
    await swipe(30);
    await expect(page.locator('body')).toHaveClass(/nav-open/);
    await swipe(60);
    await expect(page.locator('body')).not.toHaveClass(/nav-open/);
  });

  test('sets --app-h from the visual viewport', async ({ page }) => {
    const [appH, vv] = await page.evaluate(() => [
      document.documentElement.style.getPropertyValue('--app-h'),
      Math.round(window.visualViewport.height),
    ]);
    expect(appH).toBe(`${vv}px`);
  });
});

test.describe('store on a phone @mobile', () => {
  test('places a frame with the touch drag hint (coarse pointer)', async ({ page, api }) => {
    await openStore(page);
    await expect(page.locator('#map-hint')).toHaveText('Drag the round handle to move your frame');
    await expect(page.locator('.leaflet-marker-draggable')).toHaveCount(1);
    expect(page.pageErrors).toEqual([]);
  });

  test('frame handle lands clear of the map toolbar', async ({ page, api }) => {
    await openStore(page);
    const [handle, toolbar] = await page.evaluate(() => [
      document.querySelector('.leaflet-marker-draggable').getBoundingClientRect().top,
      document.querySelector('.map-toolbar').getBoundingClientRect().bottom,
    ]);
    // 44px hit area around a 28px dot: the dot starts 8px in.
    expect(handle + 8).toBeGreaterThan(toolbar);
  });

  test('bottom bar mirrors the order price and hides while typing', async ({ page, api }) => {
    await openStore(page);
    const bar = page.locator('.order-buy');
    await expect(bar).toBeVisible();
    await expect(page.locator('#order-buy-price')).toHaveText(await page.locator('#order-price').textContent());
    await page.locator('#custom-location-label').focus();
    await expect(bar).toBeHidden();
    await page.locator('#custom-location-label').blur();
    await expect(bar).toBeVisible();
  });
});

test.describe('cookie consent', () => {
  test.use({ storage: {} });

  test('asks on first visit and locks scrolling', async ({ page, api }) => {
    await page.goto('/about/');
    const dialog = page.getByRole('dialog', { name: 'Cookie consent' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.locator('a[href="/privacy/"]')).toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  });

  test('Accept stores consent, loads GA and does not ask again', async ({ page, api }) => {
    const gtm = page.waitForRequest(/googletagmanager\.com\/gtag\/js\?id=G-XEPWHQVWZY/);
    await page.goto('/about/');
    await page.locator('#cookie-accept').click();
    await gtm;
    await expect(page.locator('.cookie-consent-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => [localStorage.getItem('pp_cn'), document.body.style.overflow])).toEqual(['1', '']);
    await page.evaluate(() => window.ppTrackGA('test_event', { a: 1 }));
    expect(await gaEvents(page, 'test_event')).toEqual([{ event: 'test_event', params: { a: 1 } }]);

    await page.goto('/faq/');
    await expect(page.locator('.cookie-consent-overlay')).toHaveCount(0);
    // Consent is remembered: GA loads on its own on later pages.
    expect(await page.evaluate(() => window.__ppGaLoaded)).toBe(true);
  });

  test('Reject stores refusal and GA never loads', async ({ page, api }) => {
    let gaRequested = false;
    page.on('request', (r) => { if (r.url().includes('googletagmanager.com')) gaRequested = true; });
    await page.goto('/about/');
    await page.locator('#cookie-reject').click();
    expect(await page.evaluate(() => localStorage.getItem('pp_cn'))).toBe('0');
    await page.evaluate(() => window.ppTrackGA('test_event'));
    expect(await page.evaluate(() => [typeof window.gtag, window.dataLayer])).toEqual(['undefined', undefined]);
    await page.goto('/faq/');
    await expect(page.locator('.cookie-consent-overlay')).toHaveCount(0);
    expect(gaRequested).toBe(false);
  });

  test('appears on every kind of page', async ({ page, api }) => {
    for (const path of ['/', '/store/', '/etsy/', '/404-nope']) {
      await page.evaluate(() => localStorage.removeItem('pp_cn')).catch(() => {});
      await page.goto(path);
      await expect(page.locator('.cookie-consent-overlay'), path).toBeVisible();
    }
  });
});

test.describe('newsletter popup', () => {
  test.use({ storage: { pp_cn: '0' } });

  const popup = (page) => page.locator('.nl-overlay');

  async function scrollPast(page, fraction = 0.6) {
    await page.evaluate((f) => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f), fraction);
  }

  test('opens after scrolling past 55% and is stamped as seen', async ({ page, api }) => {
    await page.goto('/about/');
    await scrollPast(page, 0.4);
    await page.waitForTimeout(150);
    await expect(popup(page)).toHaveCount(0);
    await scrollPast(page, 0.7);
    await expect(popup(page)).toBeVisible();
    await expect(page.locator('#nl-email')).toBeFocused();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pp_nl')));
    expect(saved.state).toBe('seen');
    expect(Date.now() - saved.at).toBeLessThan(60_000);
  });

  test('opens on exit intent through the top of the window', async ({ page, api }) => {
    await page.goto('/about/');
    await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { clientY: 0, bubbles: true })));
    await expect(popup(page)).toBeVisible();
  });

  test('ignores exit intent on touch-only devices', async ({ page, api }) => {
    await page.addInitScript(() => {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (q === '(hover: none)' ? { matches: true, addListener() {}, removeListener() {} } : mm(q));
    });
    await page.goto('/about/');
    await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { clientY: 0, bubbles: true })));
    await page.waitForTimeout(150);
    await expect(popup(page)).toHaveCount(0);
  });

  test('waits for the cookie banner to be answered', async ({ page, api }) => {
    await page.addInitScript(() => localStorage.removeItem('pp_cn'));
    await page.goto('/about/');
    await scrollPast(page);
    await page.waitForTimeout(150);
    await expect(popup(page)).toHaveCount(0);
    await page.locator('#cookie-reject').click();
    await scrollPast(page, 0.9);
    await expect(popup(page)).toBeVisible();
  });

  test('does not open over the cart', async ({ page, api }) => {
    await page.goto('/about/');
    await page.locator('#cart-toggle').click();
    await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { clientY: 0, bubbles: true })));
    await page.waitForTimeout(150);
    await expect(popup(page)).toHaveCount(0);
  });

  for (const [how, act] of [
    ['the close button', (p) => p.locator('#nl-close').click()],
    ['No thanks', (p) => p.locator('#nl-decline').click()],
    ['Escape', (p) => p.keyboard.press('Escape')],
    ['the backdrop', (p) => p.mouse.click(5, 5)],
  ]) {
    test(`${how} dismisses it and snoozes for 7 days`, async ({ page, api }) => {
      await page.goto('/about/');
      await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { clientY: 0, bubbles: true })));
      await expect(popup(page)).toBeVisible();
      await act(page);
      await expect(popup(page)).toHaveCount(0);
      expect(await page.evaluate(() => [JSON.parse(localStorage.getItem('pp_nl')).state, document.body.style.overflow])).toEqual(['dismissed', '']);
      await page.reload();
      await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { clientY: 0, bubbles: true })));
      await page.waitForTimeout(150);
      await expect(popup(page)).toHaveCount(0);
    });
  }

  test('comes back after the snooze expires', async ({ page, api }) => {
    await page.addInitScript(() => localStorage.setItem('pp_nl', JSON.stringify({ state: 'dismissed', at: Date.now() - 8 * 24 * 3600 * 1000 })));
    await page.goto('/about/');
    await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { clientY: 0, bubbles: true })));
    await expect(popup(page)).toBeVisible();
  });

  test('validates the email', async ({ page, api }) => {
    await page.goto('/about/');
    await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { clientY: 0, bubbles: true })));
    await page.locator('#nl-email').fill('nope');
    await page.locator('#nl-submit').click();
    await expect(page.locator('#nl-status')).toHaveText('Please enter a valid email address.');
    await expect(page.locator('#nl-status')).toHaveClass(/nl-status-error/);
  });

  test('subscribing confirms, escapes the email and never shows again', async ({ page, api }) => {
    await page.goto('/about/');
    await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { clientY: 0, bubbles: true })));
    // Renders its own Turnstile widget, since it was built after page load.
    await expect.poll(() => page.evaluate(() => window.__ts?.renders.length)).toBe(1);
    await page.locator('#nl-email').fill('a+<b>@example.com');
    await page.locator('#nl-submit').click();
    await expect(page.locator('#nl-submit')).toHaveText('Sending…');
    await expect(page.locator('.nl-title')).toHaveText('Check your inbox');
    await expect(page.locator('.nl-text strong')).toHaveText('a+<b>@example.com');
    await expect(page.locator('#nl-done')).toBeFocused();
    expect(await fbqEvents(page, 'Lead')).toEqual([{ content_name: 'Newsletter' }]);
    // The endpoint is still mocked out in app.js (NEWSLETTER_ENDPOINT = null).
    expect(api.requests('POST /api/newsletter')).toHaveLength(0);

    await page.locator('#nl-done').click();
    await expect(popup(page)).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pp_nl')).state)).toBe('subscribed');
  });

  test('never shows for subscribers, however old', async ({ page, api }) => {
    await page.addInitScript(() => localStorage.setItem('pp_nl', JSON.stringify({ state: 'subscribed', at: 0 })));
    await page.goto('/about/');
    await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { clientY: 0, bubbles: true })));
    await page.waitForTimeout(150);
    await expect(popup(page)).toHaveCount(0);
  });
});
