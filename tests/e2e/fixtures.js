// Shared Playwright fixtures: every external host the site talks to is
// intercepted, so tests run offline and deterministically.
//
//   test('...', async ({ page, api }) => {
//     api.on('GET /api/products', { json: {...} });   // override a response
//     await page.goto('/store/');
//     api.requests('POST /api/checkout')              // recorded calls
//   });
//
// localStorage is seeded before any page script runs. By default the cookie
// banner is answered ('0') and the newsletter popup is suppressed, so neither
// covers the page; override with test.use({ storage: {...} }).

import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { PRODUCTS_RESPONSE, PLACES, review } from './data.js';

const ROOT = path.resolve(__dirname, '../..');
const LEAFLET_DIST = path.join(ROOT, 'node_modules/leaflet/dist');
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

export const API = 'https://api.polyplaces.co.uk';

// A fake Turnstile that renders instantly and hands out predictable tokens.
const FAKE_TURNSTILE = `
  window.__ts = { renders: [], resets: [] };
  window.turnstile = {
    _n: 0,
    render(el, opts) { window.__ts.renders.push(opts); return 'w' + (++this._n); },
    getResponse(id) { return 'token-' + id; },
    reset(id) { window.__ts.resets.push(id); },
  };`;

export const DEFAULT_STORAGE = {
  pp_cn: '0',
  pp_nl: JSON.stringify({ state: 'subscribed', at: 0 }),
};

function defaultHandlers() {
  return {
    'GET /api/config': { json: {} },
    'GET /api/products': { json: PRODUCTS_RESPONSE },
    'GET /api/places': { json: { places: PLACES } },
    'GET /api/reviews': { json: { reviews: [review(1), review(2), review(3)], total: 3, average: 4.7, nextCursor: null } },
    'POST /api/reviews': { json: { ok: true } },
    'POST /api/contact': { json: { ok: true } },
    'POST /api/newsletter': { json: { ok: true } },
    'GET /api/custom-size-price': (req) => {
      const w = Number(req.query.widthMm), h = Number(req.query.heightMm);
      return { json: { unitAmount: 2000 + Math.round((w * h) / 100) } };
    },
    'GET /api/reverse-geocode': { json: { label: 'Westminster, London' } },
    'POST /api/checkout': { json: { url: 'https://checkout.stripe.com/c/pay/cs_test_123' } },
    // Static snapshot: off by default so the live (mocked) API is the source.
    'GET /assets/data/products-snapshot.json': { status: 404, body: '' },
    nominatim: { json: [] },
  };
}

class MockApi {
  constructor(page) {
    this.page = page;
    this.handlers = defaultHandlers();
    this.log = [];
  }

  on(key, response) {
    this.handlers[key] = response;
  }

  requests(key) {
    return this.log.filter((r) => r.key === key);
  }

  async waitFor(key, count = 1) {
    await expect.poll(() => this.requests(key).length, { message: `waiting for ${count}x ${key}` }).toBeGreaterThanOrEqual(count);
    return this.requests(key);
  }

  async respond(route, key) {
    const request = route.request();
    const url = new URL(request.url());
    let body = null;
    try { body = request.postDataJSON(); } catch { body = request.postData(); }
    const entry = { key, url: url.href, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: request.headers() };
    this.log.push(entry);

    let res = this.handlers[key];
    if (typeof res === 'function') res = await res(entry);
    if (!res) res = { status: 404, body: '' };
    if (res.abort) return route.abort();
    if (res.delay) await new Promise((r) => setTimeout(r, res.delay));
    return route.fulfill({
      status: res.status ?? 200,
      contentType: res.contentType ?? (res.json !== undefined ? 'application/json' : 'text/plain'),
      headers: { 'Access-Control-Allow-Origin': '*', ...(res.headers || {}) },
      body: res.json !== undefined ? JSON.stringify(res.json) : (res.body ?? ''),
    });
  }

  async install() {
    const { page } = this;

    await page.route(`${API}/**`, (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }
      return this.respond(route, `${req.method()} ${new URL(req.url()).pathname}`);
    });

    await page.route('**/assets/data/products-snapshot.json*', (route) =>
      this.respond(route, 'GET /assets/data/products-snapshot.json'));

    await page.route('https://nominatim.openstreetmap.org/**', (route) => this.respond(route, 'nominatim'));

    await page.route('https://unpkg.com/leaflet@1.9.4/dist/**', (route) => {
      const rel = new URL(route.request().url()).pathname.replace('/leaflet@1.9.4/dist/', '');
      return route.fulfill({ path: path.join(LEAFLET_DIST, rel), headers: { 'Access-Control-Allow-Origin': '*' } });
    });

    await page.route(/tile\.openstreetmap\.org/, (route) =>
      route.fulfill({ contentType: 'image/png', body: PNG_1PX, headers: { 'Access-Control-Allow-Origin': '*' } }));

    await page.route('https://challenges.cloudflare.com/**', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: FAKE_TURNSTILE }));

    // Analytics: keep the inline fbq stub queueing (so calls can be asserted)
    // and let gtag push to dataLayer without loading anything.
    await page.route(/connect\.facebook\.net|googletagmanager\.com|www\.facebook\.com|google-analytics\.com/, (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '' }));

    // Stripe: a stub page to land on after checkout.
    await page.route('https://checkout.stripe.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Stripe</title><h1>Stripe checkout</h1>' }));
  }
}

export const test = base.extend({
  storage: [DEFAULT_STORAGE, { option: true }],

  api: async ({ page }, use) => {
    const api = new MockApi(page);
    await api.install();
    await use(api);
  },

  page: async ({ page, storage }, use) => {
    // Seed once per test, not on every navigation, so state the page writes
    // (cart, consent) survives reloads and page-to-page navigation.
    await page.addInitScript((seed) => {
      try {
        if (sessionStorage.getItem('__pp_seeded')) return;
        sessionStorage.setItem('__pp_seeded', '1');
        for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
      } catch (_) { /* opaque origins (about:blank) */ }
    }, storage);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err));
    page.pageErrors = errors;
    await use(page);
  },
});

export { expect };

// Helpers --------------------------------------------------------------------

// Meta Pixel calls queued by the inline fbq stub, as [command, event, params].
export function fbqCalls(page) {
  return page.evaluate(() => (window.fbq?.queue || []).map((args) => Array.from(args)));
}

export async function fbqEvents(page, name) {
  return (await fbqCalls(page)).filter(([cmd, ev]) => cmd === 'track' && ev === name).map(([, , params]) => params);
}

// GA4 events pushed through gtag (only present once consent was given).
export function gaEvents(page, name) {
  return page.evaluate((n) => (window.dataLayer || [])
    .map((args) => Array.from(args))
    .filter(([cmd, ev]) => cmd === 'event' && (!n || ev === n))
    .map(([, ev, params]) => ({ event: ev, params })), name);
}

export function readCart(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('polyplaces_cart_v1') || '[]'));
}

export const cartItem = (overrides = {}) => ({
  id: `item-${Math.random().toString(16).slice(2)}`,
  productId: 'prod_small',
  priceId: 'price_small',
  name: 'Small',
  displaySize: '20cm x 20cm',
  sizeCode: '500',
  aspectRatio: 1,
  price: 30,
  location: 'Westminster, London',
  customLabel: '',
  bbox: { south: 51.5028, north: 51.5072, west: -0.0936, east: -0.0864 },
  center: { lat: 51.505, lng: -0.09 },
  rotation: 0,
  zoom: 1,
  landscape: false,
  frame: false,
  framePriceId: null,
  frameProductId: null,
  frameUnitAmount: 0,
  frameName: null,
  ...overrides,
});

// Opens /store/ and waits until a frame has been placed on the map.
export async function openStore(page, query = '') {
  await page.goto(`/store/${query}`);
  await expect(page.locator('.size-opt').first()).toBeVisible();
  await expect(page.locator('#sel-run')).toBeEnabled();
}
