# Polyplaces Frontend — Product Preloading & Offline-Price Spec

Audience: an implementation model/agent. Follow tasks exactly.

Goal: prices render instantly on every page, with no pop-in, and still render
when `api.polyplaces.co.uk` is slow or down. Live API data remains the source of
truth — it refreshes in the background and patches the page when it differs.

Architecture (three layers, all required):

1. **Build-time snapshot** — `assets/data/products-snapshot.json`, generated at
   deploy time from the live API and committed. Served same-origin. This is the
   instant-render source and the API-down fallback.
2. **Stale-while-revalidate loader** — render from localStorage cache or
   snapshot immediately, then fetch the live API in the background and re-render
   only if data changed.
3. **Preload hint** — `<link rel="preload" as="fetch">` so the live API fetch
   starts during HTML parse, before `app.js` executes.

Coordination with `SECURITY-UX-FIX-SPEC.md` (if already applied):
- Its `_headers` rule caches `/assets/*` as immutable for 1 year. Task 5 below
  adds an override so the snapshot is never stale-cached.
- Its P2-6 sets `_PRODUCTS_CACHE_TTL = 300000` (5 min). Keep that value; in this
  spec the TTL means "fresh enough to skip the background refetch", not "fresh
  enough to render".
- Its P1-1 requires `sanitizeProductList` + field validation; snapshot data MUST
  pass through the same sanitization path (it does if you follow Task 2).

General rules: don't reformat unrelated code; after editing `app.js` or HTML,
run `npm run bust`; do not commit or push unless asked.

---

## Task 1 — Snapshot generator script

Create `scripts/snapshot-products.js`:

```js
#!/usr/bin/env node
/**
 * snapshot-products.js
 * Fetches /api/products from the live API and writes a committed snapshot used
 * for instant price rendering and as a fallback when the API is unreachable.
 * Run at build/deploy time (see "preserve" npm script).
 */
const fs = require('fs');
const path = require('path');

const API_BASE = (process.env.POLYPLACES_API_BASE_URL || 'https://api.polyplaces.co.uk').replace(/\/$/, '');
const OUT = path.resolve(__dirname, '..', 'assets', 'data', 'products-snapshot.json');

(async () => {
  try {
    const res = await fetch(`${API_BASE}/api/products`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const products = Array.isArray(data?.products) ? data.products : Array.isArray(data) ? data : [];
    if (products.length === 0) throw new Error('API returned zero products');

    const snapshot = {
      generatedAt: new Date().toISOString(),
      products,
      framePrices: data?.framePrices || null,
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    console.log(`Snapshot written: ${products.length} products -> ${path.relative(process.cwd(), OUT)}`);
  } catch (err) {
    // Never fail the build for this: a previous snapshot on disk is still valid.
    if (fs.existsSync(OUT)) {
      console.warn(`[snapshot-products] fetch failed (${err.message}); keeping existing snapshot.`);
    } else {
      console.warn(`[snapshot-products] fetch failed (${err.message}); NO snapshot exists — prices will depend on the live API.`);
    }
  }
})();
```

Wire it into [package.json](package.json) `scripts`:

```json
"snapshot": "node scripts/snapshot-products.js",
"preserve": "node scripts/generate-env.js && node scripts/snapshot-products.js && node scripts/bust-cache.js"
```

Then run `npm run snapshot` once and commit the generated
`assets/data/products-snapshot.json`. (Requires Node 18+ for global `fetch` —
already true if wrangler runs.)

**Acceptance:** file exists with `generatedAt`, non-empty `products` array;
running with the API unreachable leaves the existing file intact and exits 0.

## Task 2 — Stale-while-revalidate loader in `app.js`

All edits in [assets/js/app.js](assets/js/app.js).

### 2a. Add a single shared data-source function

Add near the cache-key constants (`_PRODUCTS_CACHE_KEY` area). Note those
constants are currently defined at line ~1440, *below* the functions that use
them — `const` declarations are NOT hoisted usably, but the existing code only
uses them inside functions called after full script evaluation, so it works.
Move the three constants (`_PRODUCTS_CACHE_KEY`, `_STORE_CACHE_KEY`,
`_PRODUCTS_CACHE_TTL`) up next to `cartStorageKey` (line ~77) to make the new
code safe, then add:

```js
const _SNAPSHOT_URL = '/assets/data/products-snapshot.json';

// Returns { products, framePrices, source } as fast as possible:
// fresh localStorage cache -> committed snapshot -> live API (blocking, last resort).
// Independently: if the cache wasn't fresh, kicks off a background API refresh
// and invokes onUpdate(data) when the live payload differs from what was returned.
async function getProductData(onUpdate) {
  const readCache = () => {
    try {
      const c = JSON.parse(localStorage.getItem(_STORE_CACHE_KEY));
      if (c && typeof c.ts === 'number' && Array.isArray(c.products)) return c;
    } catch (_) {}
    return null;
  };

  const fetchLive = async () => {
    const res = await fetch(`${apiBase}/api/products`);
    if (!res.ok) throw new Error(`Products fetch failed: ${res.status}`);
    const data = await res.json();
    const products = sanitizeProductList(
      Array.isArray(data?.products) ? data.products : Array.isArray(data) ? data : []
    );
    const payload = { products, framePrices: data?.framePrices || null };
    try {
      localStorage.setItem(_STORE_CACHE_KEY, JSON.stringify({ ts: Date.now(), ...payload }));
      localStorage.setItem(_PRODUCTS_CACHE_KEY, JSON.stringify({ ts: Date.now(), products }));
    } catch (_) {}
    return payload;
  };

  const cached = readCache();
  const cacheFresh = cached && Date.now() - cached.ts < _PRODUCTS_CACHE_TTL;

  let initial = null;
  if (cached) {
    initial = { products: sanitizeProductList(cached.products), framePrices: cached.framePrices || null, source: 'cache' };
  } else {
    try {
      const res = await fetch(_SNAPSHOT_URL, { cache: 'no-cache' });
      if (res.ok) {
        const snap = await res.json();
        if (Array.isArray(snap?.products) && snap.products.length > 0) {
          initial = { products: sanitizeProductList(snap.products), framePrices: snap.framePrices || null, source: 'snapshot' };
        }
      }
    } catch (_) {}
  }

  if (!cacheFresh) {
    // Background revalidation — never blocks initial render when we have data.
    const revalidate = fetchLive()
      .then((live) => {
        if (
          initial &&
          typeof onUpdate === 'function' &&
          JSON.stringify({ p: live.products, f: live.framePrices }) !==
            JSON.stringify({ p: initial.products, f: initial.framePrices })
        ) {
          onUpdate(live);
        }
        return live;
      })
      .catch((err) => {
        if (typeof Sentry !== 'undefined') Sentry.captureException(err);
        return null;
      });

    if (!initial) {
      // No cache, no snapshot: the live fetch is all we have — await it.
      const live = await revalidate;
      if (live) return { ...live, source: 'live' };
      return null;
    }
  }

  return initial;
}
```

### 2b. Rewrite `loadProducts()` (store) to use it

Replace the body of `loadProducts()` (currently lines ~456-494) with:

```js
async function loadProducts() {
  const apply = (data) => {
    products = sanitizeProductList(data.products);
    _applyFramePrices(data.framePrices);
    renderSizeOptions();
    // Keep the current selection valid after a background update.
    if (selectedProduct && selectedProduct.id !== 'custom') {
      const still = products.find((p) => p.id === selectedProduct.id);
      if (still) selectProduct(still);
      else if (products.length > 0) selectProduct(products[0]);
    }
  };

  try {
    const data = await getProductData(apply);
    const loadingEl = document.getElementById('store-size-loading');
    if (loadingEl) loadingEl.classList.add('hidden');
    if (!data) throw new Error('No product data available');
    products = sanitizeProductList(data.products);
    _applyFramePrices(data.framePrices);
    renderSizeOptions();
    return products;
  } catch (err) {
    if (typeof Sentry !== 'undefined') Sentry.captureException(err);
    const loadingEl = document.getElementById('store-size-loading');
    if (loadingEl) loadingEl.classList.add('hidden');
    const emptyEl = document.getElementById('size-options-empty');
    if (emptyEl) {
      emptyEl.textContent = 'Sizes failed to load. Please check your connection and refresh.';
      emptyEl.classList.remove('hidden');
    }
    return [];
  }
}
```

Careful with `apply` re-selection: `selectProduct` resets frame rotation/zoom.
That is acceptable on a data change (prices/frames may have changed), and data
changes mid-session are rare. Do not try to preserve rotation state.

### 2c. Rewrite `loadHomepagePrices()` to use it

Replace its body (currently lines ~1444-1469) with:

```js
async function loadHomepagePrices() {
  const paint = (prods) => {
    prods.forEach((p) => {
      const el = document.getElementById(`prod-price-${p.frameKey}`);
      if (el && typeof p.unitAmount === 'number' && p.unitAmount > 0) {
        el.textContent = `From £${Math.round(p.unitAmount / 100)}`;
        el.removeAttribute('hidden');
      }
    });
  };
  try {
    const data = await getProductData((live) => paint(live.products));
    if (data) paint(data.products);
  } catch (err) {
    if (typeof Sentry !== 'undefined') Sentry.captureException(err);
    console.error('[Polyplaces] Failed to load homepage prices:', err);
  }
}
```

### 2d. Keep checkout guards

Do NOT remove the `fallback_` priceId guard in `checkoutCart()` — it protects
against junk data. Snapshot priceIds are real Stripe ids, so snapshot-sourced
carts check out normally.

**Acceptance:**
- With DevTools set to "Offline" for `api.polyplaces.co.uk` only (block request
  URL), homepage still shows "From £N" prices and `/store/` still lists sizes
  (from snapshot).
- With everything online and an empty localStorage, prices appear without
  waiting for the API round-trip (network tab: render happens after the
  same-origin snapshot fetch, while `/api/products` is still pending).
- When the API returns different prices than the snapshot, the page updates to
  the API values within one network round-trip (test by hand-editing the local
  snapshot to a wrong price and reloading).

## Task 3 — Preload hint for the live API fetch

In `index.html` and `store/index.html` `<head>` (after the `api-base` meta tag):

```html
<link rel="preload" href="https://api.polyplaces.co.uk/api/products" as="fetch" crossorigin="anonymous"/>
<link rel="preload" href="/assets/data/products-snapshot.json" as="fetch"/>
```

Notes for the implementer:
- `crossorigin="anonymous"` is required on the API preload; `app.js` fetches it
  in CORS mode without credentials, and preload matching is strict about this.
  The snapshot preload is same-origin — no crossorigin attribute.
- Do not add these to content pages (about/faq/etc.) — they don't render prices.

Also add to `index.html` only (homepage → store is the main journey; warm the
store's unique assets):

```html
<link rel="prefetch" href="/store/"/>
```

**Acceptance:** network tab on a cold load of `/` shows `/api/products` starting
before `app.js` executes, and no console warning about an unused preload.

## Task 4 — Snapshot must never be stale-cached at the edge

If `_headers` from the security spec exists, append this block AFTER the
`/assets/*` block (later rules override the same header for a more specific
match):

```
/assets/data/*
  Cache-Control: no-cache
```

If `_headers` does not exist yet, still create it with just that block.

Also verify [.assetsignore](.assetsignore) does not exclude `assets/data/`
(current patterns don't — `package.json` etc. are exact names, not `*.json`).

**Acceptance:** after deploy, `curl -sI https://polyplaces.co.uk/assets/data/products-snapshot.json`
shows `Cache-Control: no-cache` and status 200.

## Task 5 — Reserve layout space (no pop-in shift)

Homepage price elements (`id="prod-price-*"`) use the `hidden` attribute until
filled, which collapses their space and causes layout shift when prices arrive.

In [assets/css/styles.css](assets/css/styles.css), add:

```css
[id^="prod-price-"][hidden] {
  display: block;
  visibility: hidden;
  min-height: 1.2em;
}
```

(Adjust `display` to match the element's normal display value — check the
existing rule for those elements first; if they are inline, use `inline-block`.)

**Acceptance:** with network throttled to Slow 3G, the product cards do not
shift vertically when prices appear.

## Task 6 — Deployment doc note

Append to the end of `config-endpoint-spec.md` (or the backend tracker):

> Frontend now ships a committed snapshot of `/api/products`
> (`assets/data/products-snapshot.json`), regenerated on every deploy via
> `npm run preserve`. When product prices or priceIds change in Stripe,
> redeploy the frontend (or at minimum run `npm run snapshot` and deploy) so the
> fallback stays current. The live API still overrides the snapshot at runtime,
> so a stale snapshot only matters when the API is down.

---

## Explicitly rejected alternatives (do not implement)

- **Service worker with stale-while-revalidate**: strictly more moving parts
  (SW lifecycle, update semantics, cache eviction) for the same result; the
  localStorage + snapshot combo already covers both speed and offline-API.
- **Hardcoding prices in HTML**: duplicates data in 10 HTML files, guaranteed to
  drift; the committed snapshot is the single-file version of this idea.
- **Preload only, no snapshot**: does not solve the API-down case the site
  currently suffers from.

## Verification checklist

- [ ] `npm run preserve` regenerates snapshot + env.js + cache-bust hashes.
- [ ] Block `api.polyplaces.co.uk` in DevTools → homepage prices and store sizes
      still render; checkout button still guarded.
- [ ] Cold cache online → prices render before `/api/products` resolves.
- [ ] Hand-edit snapshot price → page self-corrects to API price after load.
- [ ] No "preload not used" console warnings.
- [ ] `curl -sI .../assets/data/products-snapshot.json` → `Cache-Control: no-cache`.
- [ ] `git status` shows snapshot committed; `npm run bust` ran after HTML edits.
