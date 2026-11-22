// Every public page: loads cleanly, has basic SEO tags, internal links
// resolve, and passes an axe accessibility scan.

import AxeBuilder from '@axe-core/playwright';
import { test, expect, cartItem } from './fixtures.js';

const PAGES = [
  '/', '/store/', '/about/', '/care/', '/contact/', '/faq/', '/newsletter/',
  '/privacy/', '/reviews/', '/shipping/', '/terms/', '/etsy/',
];

for (const path of PAGES) {
  test(`${path} loads without errors and has a title and description`, async ({ page, api }) => {
    const failed = [];
    page.on('response', (r) => {
      if (r.url().startsWith('http://localhost') && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
    });
    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    await page.goto(path);
    await page.waitForLoadState('networkidle');

    expect(page.pageErrors, 'uncaught exceptions').toEqual([]);
    expect(consoleErrors).toEqual([]);
    // The snapshot is a deliberate 404 in the mock; anything else is a broken asset.
    expect(failed.filter((f) => !f.includes('products-snapshot.json'))).toEqual([]);
    await expect(page).toHaveTitle(/Polyplaces/);
    if (path !== '/etsy/') {
      await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.{40,}/);
    }
  });
}

test('unknown paths serve the 404 page', async ({ page, api }) => {
  const res = await page.goto('/no-such-page/');
  expect(res.status()).toBe(404);
  await expect(page.locator('body')).toContainText(/doesn.t exist|not found/i);
});

test('every internal link resolves', async ({ page, request, api }) => {
  const links = new Set();
  for (const path of PAGES) {
    await page.goto(path);
    for (const href of await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.href))) {
      const u = new URL(href);
      if (u.origin === 'http://localhost:4173') links.add(u.pathname);
    }
  }
  for (const link of [...links].sort()) {
    const res = await request.get(link);
    expect(res.status(), link).toBeLessThan(400);
  }
  expect(links.size).toBeGreaterThan(10);
});

test('sitemap lists only pages that exist', async ({ request }) => {
  const xml = await (await request.get('/sitemap.xml')).text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  expect(locs.length).toBeGreaterThan(5);
  for (const p of locs) expect((await request.get(p)).status(), p).toBe(200);
});

// Violations present when this suite was written (frontend-test-plan.md 4.12).
// The scans fail on anything new; remove entries here as they are fixed.
//   aria-hidden-focus   closed nav drawer, checkout banner and cart drawer are
//                       aria-hidden but their links/buttons stay tabbable
//   heading-order       footer column h4s follow the page's h1/h2 directly
//   button-name         homepage gallery thumbs are image-only buttons (alt="")
//   aria-command-name   Leaflet's drag handle marker has role=button, no name
//   nested-interactive  size cards are role=button and contain frame radios
//   aria-allowed-role   <aside role="dialog"> for the cart drawer
const SITE_WIDE = ['aria-hidden-focus', 'heading-order'];
const KNOWN_A11Y = {
  '/': [...SITE_WIDE, 'button-name'],
  '/store/': [...SITE_WIDE, 'aria-command-name', 'nested-interactive'],
  '/etsy/': [...SITE_WIDE, 'aria-command-name'],
  cart: ['aria-allowed-role', 'heading-order'],
};

function newViolations(violations, known) {
  return violations
    .filter((v) => !known.includes(v.id))
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

test.describe('accessibility', () => {
  // Contrast is a design call tracked separately.
  const scan = (page) => new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();

  for (const path of PAGES) {
    test(`${path} has no new axe violations`, async ({ page, api }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const { violations } = await scan(page);
      expect(newViolations(violations, KNOWN_A11Y[path] || SITE_WIDE)).toEqual([]);
    });
  }

  test('open cart drawer has no new axe violations', async ({ page, api }) => {
    await page.addInitScript((item) => localStorage.setItem('polyplaces_cart_v1', JSON.stringify([item])), cartItem());
    await page.goto('/store/');
    await page.locator('#cart-toggle').click();
    const { violations } = await new AxeBuilder({ page }).include('#cart-drawer').disableRules(['color-contrast']).analyze();
    expect(newViolations(violations, KNOWN_A11Y.cart)).toEqual([]);
  });

  test('3D preview offer has no axe violations', async ({ page, api }) => {
    await page.goto('/store/');
    await expect(page.locator('#sel-run')).toBeEnabled();
    await page.locator('#sel-run').click();
    const { violations } = await new AxeBuilder({ page }).include('.pv-overlay').disableRules(['color-contrast']).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});

test.describe('dialogs', () => {
  test.use({ storage: { pp_cn: '0' } });

  test('newsletter popup has no axe violations', async ({ page, api }) => {
    await page.goto('/about/');
    await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { clientY: 0, bubbles: true })));
    await expect(page.locator('.nl-overlay')).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).include('.nl-overlay').disableRules(['color-contrast']).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});

test.describe('cookie dialog', () => {
  test.use({ storage: {} });

  test('has no axe violations', async ({ page, api }) => {
    await page.goto('/about/');
    const { violations } = await new AxeBuilder({ page }).include('.cookie-consent-overlay').disableRules(['color-contrast']).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});
