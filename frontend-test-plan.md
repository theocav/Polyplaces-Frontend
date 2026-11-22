# Frontend test plan

Analysis of the Polyplaces frontend as of `e50bb88`, and the test suite to build on it. Nothing here is implemented yet.

## 1. What the frontend is

A static multi-page site served by a Cloudflare Worker (`worker/index.js`, assets binding on `.`). No framework, no bundler for the site itself, no tests and no test tooling today.

| Layer | Files | Shape |
| --- | --- | --- |
| Pages | `index.html`, `store/`, `etsy/`, `contact/`, `reviews/`, `newsletter/`, `faq/`, `about/`, `care/`, `shipping/`, `privacy/`, `terms/`, `404.html` | Static HTML. Every page loads `env.js`, `app.js`, `analytics.js`; some add `turnstile.js`, `contact.js`, `newsletter.js`, `reviews.js`. Meta Pixel inline in `<head>`. |
| Main script | `assets/js/app.js` (2.7k lines) | One classic script, global state, self-initialising by sniffing DOM ids (`#landing`, `#storePage`, `#etsyPage`). Leaflet from unpkg. |
| Form scripts | `contact.js`, `newsletter.js`, `reviews.js`, `turnstile.js`, `analytics.js` | IIFEs, each bails out if its root element is missing. |
| 3D preview | `src/preview/*.js` (ES modules) -> esbuild -> `assets/js/preview/preview.js` + `preview-worker.js` | Pure geometry/data modules + three.js renderer + Web Worker. Lazy `import()`ed from `app.js`. |
| Edge worker | `worker/index.js` | `/api/tiles`, `/api/dsm`, `/api/overture-pmtiles` proxies with caching, CORS, rate limit. |
| Build scripts | `scripts/*.js` | `generate-env`, `snapshot-products`, `build-frames`, `build-preview`, `bust-cache`. |

### External dependencies every browser test must stub

- `https://api.polyplaces.co.uk/api/*` - `config`, `products`, `places`, `custom-size-price`, `reverse-geocode`, `checkout`, `reviews` (GET/POST), `contact`, `newsletter`. Note `env.js` is committed pointing at production, and `/api/config` can override `apiBase` at runtime.
- `unpkg.com/leaflet@1.9.4` (script + CSS), `*.tile.openstreetmap.org` tiles.
- `nominatim.openstreetmap.org/search` (map search).
- `challenges.cloudflare.com/turnstile` (forms), `connect.facebook.net` (pixel), `googletagmanager.com` (GA after consent), Sentry bundle.
- Preview only: `tiles.mapterhorn.com`, Overture S3 PMTiles, `/api/tiles|dsm|overture-pmtiles`.

### Global state in `app.js` (what tests will poke and assert)

`products`, `selectedProduct`, `frameOptions`, `selectedFrame`, `cart`, `bbox`, `frameCenter`, `frameCorners`, `frameRotation`, `frameZoom`, `landscapeMode`, `selectionMeta`, `apiBase`.

Because `app.js` is a classic script, its top-level `function` declarations are `window` properties and its top-level `let`/`const` live in the shared global lexical scope. So a Playwright `page.evaluate(() => computeRotatedCorners(...))` or `page.evaluate(() => cart.length)` works with **no refactor**. That is the main lever for testing this file.

### localStorage keys

| Key | Owner | Meaning |
| --- | --- | --- |
| `polyplaces_cart_v1` | cart | array of cart items |
| `polyplaces_store_cache_v1` / `polyplaces_products_cache_v1` | products | `{ ts, products, framePrices }`, 5 min TTL |
| `pp_cn` | cookie banner | `'1'` accept, `'0'` reject; absent = banner shows |
| `pp_nl` | newsletter popup | `{ state: seen/dismissed/subscribed, at }`, 7-day snooze |
| `_fbq_purchased` | checkout banner | last Stripe session id tracked as Purchase |

Tests must seed `pp_cn` and `pp_nl` up front, or the cookie overlay (and later the newsletter popup) will cover the page and swallow clicks.

## 2. Recommended tooling

Two runners, no changes to production code required to start:

1. **Vitest (Node)** - unit tests for `src/preview/*` (pure ES modules), `worker/index.js` (stub `caches.default`, `fetch`, `env`), and the build scripts.
2. **Playwright** - browser tests for everything in `assets/js/`, driven against `npx serve -l 3000 .` (the existing `serve` script / `.claude/launch.json`).
   - `page.route` intercepts every external host above. Serve Leaflet from `node_modules` (add `leaflet@1.9.4` as a devDependency) so tests are offline and deterministic. Return a 1x1 PNG for OSM tiles.
   - Abort Meta/GA/Sentry/Turnstile scripts, then inject fakes with `page.addInitScript` (`window.fbq = spy`, `window.turnstile = { render, getResponse, reset }`) so analytics and token calls can be asserted.
   - A shared fixture: `mockApi(page, overrides)` + `seedStorage(page, { consent: '0', newsletter: 'subscribed', cart })`.
   - Projects: Chromium desktop + one mobile viewport (Pixel 7) for the nav drawer, swipe-to-close, `--app-h`, coarse-pointer hint text.
   - Fake time via `page.clock` for the 400 ms custom-size debounce, the 500 ms newsletter mock and the 7-day snooze.

Suggested layout:

```
tests/
  unit/        preview-geo.test.js, preview-config.test.js, preview-terrain.test.js,
               preview-buildings.test.js, preview-net.test.js, preview-mesh.test.js,
               worker.test.js, scripts.test.js, csp.test.js
  e2e/         fixtures.js, products.json, store.spec.js, cart.spec.js, checkout.spec.js,
               search.spec.js, custom-size.spec.js, frame-controls.spec.js, preview.spec.js,
               home.spec.js, nav.spec.js, consent.spec.js, newsletter-popup.spec.js,
               contact.spec.js, newsletter-page.spec.js, reviews.spec.js, etsy.spec.js,
               pages.spec.js, a11y.spec.js
```

`package.json` scripts: `test:unit` (vitest), `test:e2e` (playwright), `test` (both).

## 3. Test inventory

### 3.1 Unit - `app.js` pure helpers (run in Playwright via `page.evaluate` on any page)

- `sanitizeProductList`: drops `district`, non-string `id`/`name`/`priceId`, nulls; tolerates non-arrays.
- `formatPriceFromAmount` (pence -> `£N`, null/NaN -> `£—`), `formatPrice` (pounds).
- `escapeHtml` on `<script>`, quotes, null.
- `computeBBoxForProduct`: width = `sizeCode * zoom` metres, height = width x aspectRatio; bad ratio falls back to 1; non-numeric `sizeCode` -> null.
- `computeRotatedCorners`: 0 degrees matches the axis-aligned bbox; 90 degrees swaps the extents; corner order TL, TR, BR, BL; `width <= 0` -> null.
- `cornersToBBox`, `findTopLeftCorner` (ties broken by lowest longitude), `easeInOutCubic` endpoints, `lerp`.
- `zoomLabel` in landscape mode: 2 -> `2.0×`, 7 -> `10.0×`. `setFrameZoom` clamps to 0.7-1.3 / 2-7 and rounds to 0.1.
- `getEffectiveUnitAmount`: base + frame; unknown frame -> base; null product -> null.
- `_applyFramePrices`: rejects bad hex/missing fields, replaces (never merges) the map, ignores an all-invalid payload, keeps optional `productId`.
- `_resolveFrameProductId`: uses stored id, else looks up `framePriceId` across `frameOptions`, else null.
- `buildCustomProduct`: `sizeCode = widthMm * 3`, `aspectRatio = h / w`, `priceId: 'custom'`.
- `previewPieceMm`: `"20cm x 20cm"`, `"20 × 28cm"` forms, `A4` -> 210x297, custom dims, fallback.
- `previewFrameChoices`: empty for custom, lowercases colour.
- `galleryEyebrow`: named sizes, custom with/without cm, frame suffix.

### 3.2 Product data loading (`getProductData` / `loadProducts`)

- Fresh cache (< 5 min) -> renders from cache, **no** `/api/products` call.
- Stale cache -> renders from cache, then background fetch; when live differs, `onUpdate` re-renders and keeps the current selection (or falls back to the first product if it disappeared).
- No cache -> `/assets/data/products-snapshot.json` first, live in background.
- No cache, snapshot 404/empty -> blocks on live.
- Everything fails -> "Sizes failed to load..." message, loading spinner hidden.
- Live fetch writes both cache keys.
- `?scale=a4` and `?scale=<name without spaces>` preselect; unknown scale -> first product.

### 3.3 Store page (`/store/`)

- Size cards render name, badge, art size, price; custom card always last; clicking / Enter / Space selects; `aria-pressed` and `.active` move; frame radios only shown for the selected product.
- Selecting a product places the polygon + handle at map centre, enables Add to cart, updates `order-scale` / `order-price` / status / hint text (desktop vs `pointer: coarse`).
- Switching product animates the bbox, resets rotation and frame selection, keeps zoom and landscape mode.
- Frame radio change updates price; "No frame" resets it.
- Rotate button: disabled for square and custom products; toggles 0/90 and redraws (assert `frameCorners`).
- Zoom slider: updates `frameZoom`, label, `--fill` CSS var, polygon size.
- Landscape toggle: switches zoom range and default (1.0 <-> 4.5), shows banner and `order-landscape-line`, re-centres the map if zoomed out below level 12.
- Map `zoomend` below 12 (9 in landscape) clears the frame with the right hint text.
- Dragging the handle moves `frameCenter` by the handle delta and resets the status text.
- Clear button resets everything (`sel-run` disabled, summary dashes, custom panel hidden).
- `?lat=&lng=&z=` opens there; out-of-range / garbage params ignored; `z` clamped 12-19.

### 3.4 Map search

- Click Search -> Nominatim called with `format=jsonv2`, `q`, `limit=6`, `addressdetails=1`; results list renders `display_name` as text (inject `<img onerror>` to prove no XSS).
- Enter with closed list auto-selects the top hit; Enter with open list picks the active row.
- ArrowUp/Down move `aria-selected` and focus, clamped at the ends; Escape clears (from input and from list, returning focus).
- Click outside closes; empty query clears; HTTP error / bad JSON -> "No results found."; button shows "Searching…" and re-enables.
- Picking a result recentres the map (zoom >= 14) and recentres the frame.

### 3.5 Custom size

- Activating shows the panel; width/height clamped to 100-330 mm and rounded; surcharge note above 300 mm.
- Price fetch debounced 400 ms (one request for rapid typing), shows `…` meanwhile, then selects the custom product with the returned price.
- Non-OK or non-numeric price -> `—` and the fail banner.

### 3.6 Cart

- Add to cart: reverse-geocode called with the centre; `label` / `display_name` / "Location unavailable" fallbacks; item shape (frame fields, landscape, rotation, zoom, custom dims, trimmed custom label) persisted to `polyplaces_cart_v1`; label input cleared; drawer opens.
- 10-item limit -> status message + banner, nothing added.
- Render: count, `aria-label` pluralisation, total, empty state with checkout disabled, frame / landscape / custom-label lines, Remove removes the right index.
- `loadCart` drops items without `priceId` and survives corrupt JSON.
- Old carts without `bbox` get one recomputed from `center` and saved back; items with no centre show "Preview unavailable".
- Drawer: opens/closes via toggle, overlay, close button, Escape; focus trapped (Tab / Shift+Tab wrap) and restored; `aria-hidden` / `aria-expanded` kept in sync.
- Cart persists across pages (add on `/store/`, see it on `/about/`).

### 3.7 Checkout

- POST body per item: `sizeCode` stringified, `framed: false` when bare, v2 `frame: { productId, priceId }` when the frame product id is known (stored or recovered from `frameOptions`), legacy `framePriceId` when not, custom dims only for custom.
- `fallback_*` price ids -> "temporarily unavailable" banner, no request.
- Framed item missing `framePriceId` -> banner, no request.
- Success -> navigates to `data.url` (route the Stripe URL to a stub page).
- Failure (non-OK or missing `url`) -> banner with the API error, product caches cleared, button restored.
- `fbq('track', 'InitiateCheckout')` and GA `begin_checkout` values.

### 3.8 Checkout return banner (`?checkout=`)

- `success` / `fail` / `abort` messages and classes; unknown value -> "Checkout updated."; close button hides it; `checkout` param removed from the URL.
- `success` clears the cart and fires Purchase once per `session_id` (reload with the same id -> no second event).
- **Regression test for the bug in section 4.1.**

### 3.9 Homepage (`/`)

- "From £N" prices painted per `frameKey` from products data; hidden when no price.
- Gallery: fallback thumbs work offline; click and ArrowLeft/Right (wrapping) swap photo, text, CTA href (`/store/?scale&lat&lng&z`, URL-encoded) and `aria-selected`.
- `/api/places` with valid places replaces the strip; invalid places (no image, non-finite lat) are filtered; empty / error keeps the fallback. Names rendered as text (XSS check).
- Reviews strip: replaced only with >= 3 live reviews; fallback kept on error or fewer.
- `.reveal` elements get `.in` (immediately under `prefers-reduced-motion`).

### 3.10 Site-wide chrome

- Nav drawer: toggle open/close, labels, focus trap, overlay click, link click closes, swipe-left > 48 px closes (mobile project).
- Cookie consent: shows when `pp_cn` absent, locks scroll; Accept sets `1` and loads GA (assert gtag script requested); Reject sets `0` and no GA; never shows again; `analytics.js` loads GA on a later page only when `pp_cn === '1'`; `ppTrackGA` is a no-op before consent.
- Newsletter popup: armed only after consent; opens on > 55 % scroll or top-edge mouseout (not under `hover: none`); not on `/etsy/`; not while the cart is open; snoozed 7 days once shown; never after subscribing; Escape / close / backdrop / "No thanks" close and restore focus; invalid email error; mock success path shows the confirmation with the email escaped.
- `--app-h` set from `visualViewport`.

### 3.11 Forms (`contact.js`, `newsletter.js`, `reviews.js`, `turnstile.js`)

Shared matrix for all three forms:

- Required-field and email validation messages, focus moves to the bad field.
- Payload includes `renderedAt`, honeypot `company`, `turnstileToken` from the fake widget, plus form-specific fields (`subject`; `source` path; review `rating`, `orderRef`, etc.).
- 200 -> success message, form reset, Turnstile reset, Lead/SubmitApplication + GA events.
- 400 with `{ error }` -> that error shown verbatim; 429 -> rate-limit copy; 500 / non-JSON -> generic copy; Turnstile reset on every failure.
- Button disabled + "Sending…" during the request, restored after.

Reviews page specifically: skeletons while loading; summary (average, stars, singular/plural); empty state; error state; "Load more" with cursor, hidden when no `nextCursor`; rating-only cards; star string clamped 0-5; JSON-LD injected with `aggregateRating`; all API text rendered as text (XSS check with `<img onerror>` in name/body).

Turnstile: no site key -> warning and no render; `ppTurnstileRender` for late containers (newsletter popup); renders once per container; polls up to ~10 s for `api.js`.

### 3.12 3D preview flow (store)

- Add to cart on a frame wider than 0.1 degrees (0.25 in landscape) skips the dialog and goes straight to reverse-geocode + cart.
- Dialog: copy mentions buildings only when not landscape; "No thanks, add to cart" adds; close / Escape / backdrop close and restore focus; focus trapped.
- "Show me a preview": route `preview.js` to a fake ES module exporting `createPreview` that records its options and lets the test fire `onProgress`, `onReady({ views: ['room','model'] })`, `onError(code)`. Assert `bbox`, `includeBuildings`, `room.size/colour/bareMm/rotated`; stage labels and bar width; view buttons toggle `aria-pressed` and call `setView`; frame picker upsell copy when bare, picking a frame checks the store radio and updates the Add button price; each `onError` code maps to its message; failed `import()` shows the load error; closing calls `dispose()`.
- One smoke test against the real bundle with all tile hosts stubbed is optional (needs WebGL; run headed or with SwiftShader).

### 3.13 Etsy tool (`/etsy/`)

- Four fixed sizes, first preselected, no prices, no cart side-effects, no newsletter popup.
- Copy writes `west,south,east,north` to 6 dp (grant clipboard permission and read it back); "✓ Copied" then label restored after 1.6 s; clipboard failure -> "Copy failed".

### 3.14 Static pages

For every page in the table: loads with no console errors and no failed same-origin requests, has a `<title>` and meta description, every internal link resolves (crawl from `sitemap.xml` + nav), and `404.html` is served for unknown paths under `wrangler dev`.

Accessibility: `@axe-core/playwright` scan of each page plus the open cart drawer, nav drawer, cookie dialog, newsletter dialog and preview dialog.

### 3.15 Node unit tests

- `src/preview/config.js`: `validateBbox` (wrong length, NaN, inverted, out of +-85/180, over max span), `maxPreviewDegrees`, `frameProfile`, `terrainMmPerM`.
- `src/preview/geo.js`: `tileFrac` / `tileRange` / `tileCount` known values, ring and polygon area sign, `boundsOverlap` / `boundsInside` / `polygonContains`, `segmentsIntersect` edge cases, `representativePoint` lies inside concave shapes.
- `src/preview/terrain.js`: `terrariumDecode`, `normalise`, `gaussianSmooth` preserves a flat field, `terrainGridSize`, `makeSampler` interpolation; `buildTerrain` with stubbed `fetch`.
- `src/preview/buildings.js`: `resolveHeight` / `resolveMinHeight` precedence, `compressHeight`, `interquartileMean`, `buildFootprints` on small fixtures.
- `src/preview/net.js`: `pool` honours concurrency, `withRetry` retries then throws the last error, 404 is final, outer abort stops retries, timeout aborts (fake timers).
- `src/preview/mesh.js`: `buildMeshes` on a tiny grid gives finite, non-empty buffers.
- `worker/index.js`: non-`/api` falls through to `ASSETS`; OPTIONS preflight headers; non-GET 405; rate-limit 429; CORS echoes only allowed origins; tiles z outside 10-15 -> 400, cache hit served without upstream fetch, 404 cached, 5xx passed through empty; dsm param validation and `scalefactor` above 2048 px, XML upstream -> 204, timeout -> 504; overture theme/release allow-lists, Range validation (missing, inverted, > 4 MB -> 416), non-206 upstream -> 502, cached 200 re-served as 206.
- `scripts/`: `bust-cache` rewrite (adds and replaces `?v=`, all three path prefixes) and `generate-env` `parseEnvFile` (comments, quotes, `=` in values). Both need their functions exported behind a `require.main === module` guard first - the only production-code change in this plan.
- CSP: the `sha256-...` in `_headers` matches the inline Meta Pixel script in every HTML page (a one-character edit to that script silently breaks tracking in production).

## 4. Issues found while reading (write a failing test first, then fix)

1. **`?checkout=` with whitespace kills the page.** `showCheckoutBanner` does `banner.classList.add(\`is-${status}\`)`. A value like `?checkout=a%20b` throws `InvalidCharacterError`, and because it runs at top level of `app.js` before the cookie banner, newsletter popup and `initStore`, the rest of the script never runs (store map never loads). Whitelist `success|fail|abort` before adding the class.
2. **Custom size can get stuck.** `initCustomSizePanel` only reacts to input when `selectedProduct.id === 'custom'`, but `selectedProduct` only becomes custom once the first price fetch succeeds. If that fetch fails, or while it is in flight (400 ms + network), typing new dimensions does nothing.
3. **`clearMap` leaves `aria-pressed="true"`** on the previously selected size card (it removes `.active` only). `activateCustomSize` likewise never sets `aria-pressed`.
4. **Frame never shown in the store order summary.** `selectProduct` / `handleFrameChange` write to `#order-frame-line` / `#order-frame`, but `store/index.html` has neither element. Either intended or a markup regression - worth a test that pins down the expected behaviour.
5. **Any `?checkout=success` clears the cart and fires a Purchase event** because `REQUIRE_SESSION_ID` is `false` (known TODO). A test should cover the current behaviour and flip when the backend change lands.
6. `serve` does not apply `_headers`, so CSP violations only show up in production. Running the E2E suite once under `wrangler dev` (or injecting the CSP header via `page.route`) would catch a new third-party host before it ships.

Found while building the suite (each pinned by a `test.fail` that will start failing - i.e. flag itself - once fixed):

7. **`?scale=a4` and product badges never match.** Real product ids are Stripe ids (`prod_...`) and the A4 product is named "Medium", so `productMeta` (keyed `small`/`a4`/`large`) never applies, and the gallery / footer links to `?scale=a4` and `?scale=custom` open on Small. (`store.spec.js`)
8. **GA4 `purchase` is never sent.** `analytics.js` loads after `app.js`, and `showCheckoutBanner` runs as `app.js` loads, so `window.ppTrackGA` does not exist yet. The Meta Purchase event is unaffected. (`cart.spec.js`)
9. **Cart drawer header is hidden under the nav on desktop.** `nav` is `z-index: 1100`, `.cart-drawer` is `900`; the fixed 60px nav covers the drawer's "Your cart" title and Close button. Escape and the overlay still close it. (`cart.spec.js`)
10. **Search results hidden behind the frame controls** at 1280x720: the map toolbar wraps and the Rotate / Zoom / Landscape bar sits on top of the results list, covering the first two results. (`search.spec.js`)
11. **Raw browser errors shown on form failures.** In `contact.js`, `newsletter.js` and `reviews.js`, a dropped connection shows "Failed to fetch" instead of the help text, because the catch shows any message other than `rate`/`server`. (`forms.spec.js`)
12. **Accessibility baseline** (axe, contrast excluded): closed nav drawer, checkout banner and cart drawer are `aria-hidden` but still tabbable (every page); footer `h4`s skip heading levels; homepage gallery thumbs are image-only buttons with no name; Leaflet's drag handle has no name; size cards are `role=button` containing radios; `<aside role="dialog">`. Recorded in `KNOWN_A11Y` in `pages.spec.js` - scans fail only on new violations.
13. **CSP hash vs Windows line endings.** The CSP hash matches the committed (LF) Meta Pixel script, but this checkout has `core.autocrlf=true`, so files on disk are CRLF and hash differently. Deploying straight from a Windows working copy with `wrangler deploy` would get the pixel blocked by CSP. A `.gitattributes` with `*.html text eol=lf` would remove the risk.
14. Minor: the store and homepage `<link rel="preload">` `/api/products` even when a fresh cache makes the request unnecessary; cart previews only render on pages that load Leaflet (home, store, Etsy).

## 6. Status

Built on `feature/dev`:

- `npm run test:unit` - Vitest, 123 tests: preview geometry / config / terrain / buildings / net / mesh, the edge Worker, CSP hashes and hosts, build scripts.
- `npm run test:e2e` - Playwright, 249 tests (Chromium desktop + Pixel 7 for `@mobile`), all external hosts mocked in `tests/e2e/fixtures.js`. 11 of them are `test.fail` known-bug pins.
- `npm test` runs both. `.github/workflows/test.yml` runs both on pushes and PRs.
- Only production-code change: `scripts/bust-cache.js` and `scripts/generate-env.js` now export their pure functions and run `main()` only when executed directly.

## 5. Suggested order of work

1. Tooling: add `vitest`, `@playwright/test`, `@axe-core/playwright`, `leaflet@1.9.4`; config files; `fixtures.js` with API mocks and storage seeding.
2. Node unit tests (fast, no browser): preview modules, worker, CSP hash.
3. E2E core money path: store -> size -> frame -> add to cart -> checkout payload -> return banner. Include the regression tests for 4.1-4.3.
4. Remaining store behaviour: search, custom size, frame controls, preview dialog with the fake module, Etsy.
5. Site chrome and forms: consent, newsletter popup, nav, contact / newsletter / reviews.
6. Static page crawl and axe scans.
7. CI: run `test:unit` and `test:e2e` (Chromium + mobile) on every push to `feature/*` and PRs to `master`.
