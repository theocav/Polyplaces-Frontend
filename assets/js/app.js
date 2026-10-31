document.body.classList.add('js');

const prefersReducedMotion = window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
  : false;

// Bootstrap: read API base from env.js stub (not a secret — just a URL needed to reach the backend)
const _bootstrapEnv = window.__POLYPLACES_ENV__ || {};
const _CONFIG_API_BASE = String(
  _bootstrapEnv.POLYPLACES_API_BASE_URL ||
    document.querySelector('meta[name="api-base"]')?.getAttribute('content') ||
    'https://api.polyplaces.co.uk'
).replace(/\/$/, '');

// Runtime config — overwritten by fetchRemoteConfig(); sane defaults until then
let apiBase = _CONFIG_API_BASE;
let NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

// Fetch all config (including secrets) from backend. Non-blocking — defaults above
// cover the window between page load and fetch completion.
const _configReady = (async () => {
  try {
    const res = await fetch(`${_CONFIG_API_BASE}/api/config`, {
      credentials: 'omit',
      cache: 'no-store',
    });
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.POLYPLACES_API_BASE_URL) apiBase = String(cfg.POLYPLACES_API_BASE_URL).replace(/\/$/, '');
      if (cfg.POLYPLACES_NOMINATIM_URL) NOMINATIM_SEARCH_URL = String(cfg.POLYPLACES_NOMINATIM_URL).replace(/\/$/, '');
      if (cfg.SENTRY_DSN && typeof Sentry !== 'undefined') {
        Sentry.init({
          dsn: cfg.SENTRY_DSN,
          environment: cfg.POLYPLACES_SITE_URL?.includes('localhost') ? 'development' : 'production',
          sendDefaultPii: false,
        });
      }
    }
  } catch {
    // Config fetch failed — defaults apply, Sentry inactive this session
  }
})();

if (prefersReducedMotion) {
  document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
} else {
  const obs = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          obs.unobserve(e.target);
        }
      });
    },
    { threshold: 0.1 }
  );

  document.querySelectorAll('.reveal').forEach((el) => obs.observe(el));
}

const _hintSentinel = document.getElementById('map-hint-sentinel');
const _mapHint = document.getElementById('map-hint');
if (_hintSentinel && _mapHint) {
  new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => _mapHint.classList.toggle('is-docked', e.isIntersecting));
    },
    { threshold: 0 }
  ).observe(_hintSentinel);
}

const cartStorageKey = 'polyplaces_cart_v1';
const REQUIRE_SESSION_ID = false; // TODO(backend): flip after success_url includes session_id
const _PRODUCTS_CACHE_KEY = 'polyplaces_products_cache_v1';
const _STORE_CACHE_KEY = 'polyplaces_store_cache_v1';
const _PRODUCTS_CACHE_TTL = 300000; // 5 minutes
const _SNAPSHOT_URL = '/assets/data/products-snapshot.json';

let storeInited = false;
let products = [];
let selectedProduct = null;
let handleIcon = null;
let cartFocusCleanup = null;
let navFocusCleanup = null;
let lastCartFocus = null;

const PRODUCT_ID_BLACKLIST = new Set(['district']);

function sanitizeProductList(list) {
  const input = Array.isArray(list) ? list : [];
  return input.filter(
    (product) => product &&
      !PRODUCT_ID_BLACKLIST.has(String(product.id)) &&
      typeof product.id === 'string' &&
      typeof product.name === 'string' &&
      typeof product.priceId === 'string'
  );
}

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

const productMeta = {
  small:  { artSize: '20\u00D720cm', badge: 'Most popular' },
  a4:     { artSize: '20\u00D728cm', badge: 'Best for gifting' },
  large:  { artSize: '32\u00D732cm', badge: null },
};

// Frame add-on options keyed by frameKey (small, medium, large, etc.).
// Each entry is an array of frame choices with colour metadata; populated from API.
let frameOptions = {};
let selectedFrame = null; // null | priceId of the selected frame (null = no frame selected)

// Custom size configuration.
const CUSTOM_SIZE_MIN_MM = 100;
const CUSTOM_SIZE_MAX_MM = 330;
const CUSTOM_SIZE_LARGE_THRESHOLD_MM = 300; // above this, we show a warning about large sizes
const CUSTOM_MAP_SCALE = 3; // 1 mm of print = 3 m of map coverage

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  });
}

function createFocusTrap(container, onClose) {
  const handler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose?.();
      return;
    }
    if (e.key !== 'Tab') return;

    const focusables = getFocusableElements(container);
    if (focusables.length === 0) {
      e.preventDefault();
      container?.focus?.();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
      return;
    }
    if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}

// ── Analytics ──────────────────────────────────────────────────────────────────
// Events go through ppTrack in analytics.js, which handles consent and sends to
// GA4 and Meta. analytics.js loads after this file, so calls made before it
// runs (the purchase on the Stripe return, say) wait in __ppPending.
function track(name, params, opts) {
  if (typeof window.ppTrack === 'function') return window.ppTrack(name, params, opts);
  (window.__ppPending = window.__ppPending || []).push([name, params, opts]);
  return null;
}

// Engaged-time stopwatch: counts only while the tab is visible, so a preview
// left open in a background tab doesn't read as minutes of interest.
function engagedTimer() {
  let total = 0;
  let since = document.visibilityState === 'visible' ? Date.now() : null;
  const onVis = () => {
    if (document.visibilityState === 'visible') {
      if (since == null) since = Date.now();
    } else if (since != null) {
      total += Date.now() - since;
      since = null;
    }
  };
  document.addEventListener('visibilitychange', onVis);
  const ms = () => total + (since != null ? Date.now() - since : 0);
  return {
    ms,
    stop() {
      total = ms();
      since = null;
      document.removeEventListener('visibilitychange', onVis);
      return total;
    },
  };
}

function gaItems(items) {
  return items.map((i) => ({
    item_id: i.priceId,
    item_name: i.name,
    item_variant: i.frame ? (i.frameName || 'framed') : 'unframed',
    item_category: i.landscape ? 'landscape' : 'buildings',
    price: Number(i.price) || 0,
    quantity: 1,
  }));
}

function cartValue(items) {
  return items.reduce((sum, i) => sum + (Number(i.price) || 0), 0);
}

// Country and region from the reverse-geocode label ("NatWest, Greater
// London, United Kingdom"). Deliberately coarse: a framed area is often
// someone's home, so no street-level detail goes to analytics.
function placeFromLabel(label) {
  const parts = String(label || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || label === 'Location unavailable') return {};
  return {
    country: parts[parts.length - 1],
    region: parts.length >= 3 ? parts[parts.length - 2] : undefined,
  };
}

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : undefined);

// One summary per framing session instead of an event per drag: how long the
// visitor spent placing the frame and how much they adjusted it before adding
// to cart or leaving.
let selectionStats = null;

function selectionStat(key) {
  if (!selectionStats) {
    selectionStats = {
      timer: engagedTimer(),
      drags: 0, map_pans: 0, map_zooms: 0, frame_zooms: 0, rotations: 0,
      landscape_toggles: 0, searches: 0, size_changes: 0, previewed: false,
    };
  }
  if (key) selectionStats[key] += 1;
}

function sendSelectionSummary(outcome, place = {}) {
  if (!selectionStats) return;
  const s = selectionStats;
  selectionStats = null;
  const c = selectionMeta?.center || frameCenter;
  track('selection_summary', {
    outcome,
    engaged_ms: s.timer.stop(),
    drags: s.drags,
    map_pans: s.map_pans,
    map_zooms: s.map_zooms,
    frame_zooms: s.frame_zooms,
    rotations: s.rotations,
    landscape_toggles: s.landscape_toggles,
    searches: s.searches,
    size_changes: s.size_changes,
    previewed: s.previewed,
    size: selectedProduct?.name,
    landscape: !!landscapeMode,
    lat_1dp: round1(c?.lat),
    lng_1dp: round1(c?.lng),
    country: place.country,
    region: place.region,
  });
}

window.addEventListener('pagehide', () => sendSelectionSummary('left'));

function showCheckoutBanner() {
  const banner = document.getElementById('checkout-banner');
  const textEl = document.getElementById('checkout-banner-text');
  const closeBtn = document.getElementById('checkout-banner-close');
  if (!banner || !textEl || !closeBtn) return;

  const params = new URLSearchParams(window.location.search);
  const status = params.get('checkout');
  if (!status) return;

  const messages = {
    success: 'Payment successful. We have received your order.',
    fail: 'Payment failed. Please try again or use a different card.',
    abort: 'Checkout cancelled. You can resume anytime from your cart.',
  };
  const message = messages[status] || 'Checkout updated.';

  banner.classList.add('show');
  banner.classList.add(`is-${status}`);
  banner.setAttribute('aria-hidden', 'false');
  textEl.textContent = message;

  if (status === 'success' && (params.get('session_id') || !REQUIRE_SESSION_ID)) {
    // Browser-side purchase, once per Stripe session, before the cart is cleared.
    // The Stripe webhook reports the same purchase server-side with the real
    // charged amount; transaction_id (GA4) and the 'purchase_<session>' event
    // id (Meta) let each platform drop the duplicate.
    const sessionId = params.get('session_id') || '';
    let alreadyTracked = false;
    try {
      alreadyTracked = sessionId && localStorage.getItem('_fbq_purchased') === sessionId;
    } catch (_) {}
    if (!alreadyTracked && cart.length) {
      const orderValue = cartValue(cart);
      track('purchase', {
        transaction_id: sessionId || undefined,
        value: orderValue,
        currency: 'GBP',
        items: gaItems(cart),
      }, {
        eventId: sessionId ? `purchase_${sessionId}` : undefined,
        metaParams: {
          content_ids: cart.map((i) => i.priceId),
          content_type: 'product',
          num_items: cart.length,
          value: orderValue,
          currency: 'GBP',
        },
      });
      try { if (sessionId) localStorage.setItem('_fbq_purchased', sessionId); } catch (_) {}
    }
    // Stripe returned successfully; clear the cart so users don't accidentally repurchase.
    clearCart();
  } else if (status === 'fail' || status === 'abort') {
    track('checkout_returned', { status, value: cartValue(cart), num_items: cart.length });
  }

  closeBtn.onclick = () => {
    banner.classList.remove('show', 'is-success', 'is-fail', 'is-abort');
    banner.setAttribute('aria-hidden', 'true');
  };

  if (window.history && window.history.replaceState) {
    const url = new URL(window.location.href);
    url.searchParams.delete('checkout');
    window.history.replaceState({}, '', url);
  }
}

function showBanner(message, type = 'fail') {
  const banner = document.getElementById('checkout-banner');
  const textEl = document.getElementById('checkout-banner-text');
  const closeBtn = document.getElementById('checkout-banner-close');
  if (!banner || !textEl || !closeBtn) return;
  textEl.textContent = message;
  banner.className = `checkout-banner show is-${type}`;
  banner.setAttribute('aria-hidden', 'false');
  closeBtn.onclick = () => {
    banner.classList.remove('show', 'is-success', 'is-fail', 'is-abort');
    banner.setAttribute('aria-hidden', 'true');
  };
}

function formatPriceFromAmount(amount) {
  if (amount === null || typeof amount === 'undefined') return '\u00A3\u2014';
  const value = Number(amount) / 100;
  if (!Number.isFinite(value)) return '\u00A3\u2014';
  return `\u00A3${value.toFixed(0)}`;
}

function renderSizeOptions() {
  const container = document.getElementById('size-options');
  const empty = document.getElementById('size-options-empty');
  const loadingEl = document.getElementById('store-size-loading');

  if (!container || !empty) return;
  container.innerHTML = '';

  if (products.length === 0) {
    empty.textContent = 'No sizes available right now.';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  products.forEach((product) => {
    const btn = document.createElement('div');
    btn.className = 'size-opt';
    btn.dataset.productId = escapeHtml(product.id);
    const meta = productMeta[product.id] || {};
    const badge = meta.badge ? `<span class="size-opt-badge">${meta.badge}</span>` : '';
    const artSize = meta.artSize ? ` &middot; <span class="size-opt-art">${meta.artSize}</span>` : '';

    const frames = product.frameKey ? (frameOptions[product.frameKey] ?? null) : null;
    const frameOptsHtml = frames && frames.length > 0 ? `
      <div class="frame-opts" hidden>
        <div class="frame-colour-selector">
          <div class="frame-colours-header">Frame</div>
          <div class="frame-colour-boxes">
            <div class="frame-colour-box">
              <input type="radio" id="frame-colour-none-${escapeHtml(product.id)}" name="frame-colour-${escapeHtml(product.id)}" value="" class="frame-colour-radio" checked />
              <label for="frame-colour-none-${escapeHtml(product.id)}" class="frame-colour-label">
                <span class="frame-colour-swatch frame-colour-swatch--none"></span>
                <div class="frame-colour-name">No frame</div>
                <div class="frame-colour-price">&nbsp;</div>
              </label>
            </div>
            ${frames.map(frame => {
              const safeHex = /^#[0-9a-fA-F]{3,8}$/.test(frame.colourHex) ? frame.colourHex : '#cccccc';
              return `
              <div class="frame-colour-box">
                <input type="radio" id="frame-colour-${escapeHtml(frame.priceId)}-${escapeHtml(product.id)}" name="frame-colour-${escapeHtml(product.id)}" value="${escapeHtml(frame.priceId)}" class="frame-colour-radio" />
                <label for="frame-colour-${escapeHtml(frame.priceId)}-${escapeHtml(product.id)}" class="frame-colour-label">
                  <span class="frame-colour-swatch" style="background-color:${safeHex}" title="${escapeHtml(frame.colourName)}"></span>
                  <div class="frame-colour-name">${escapeHtml(frame.colourName)}</div>
                  ${frame.unitAmount ? `<div class="frame-colour-price">+${formatPriceFromAmount(frame.unitAmount)}</div>` : ''}
                </label>
              </div>
            `}).join('')}
          </div>
        </div>
      </div>
    ` : '';

    btn.innerHTML = `
      <div class="size-opt-top">
        <div class="size-opt-info">
          <div class="size-opt-name-row"><div class="size-opt-name">${escapeHtml(product.name)}</div>${badge}</div>
          <div class="size-opt-sub">${escapeHtml(product.displaySize)}${artSize}</div>
        </div>
        <div class="size-opt-price">${formatPriceFromAmount(product.unitAmount)}</div>
      </div>
      ${frameOptsHtml}
    `;

    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('aria-pressed', 'false');

    btn.onclick = (e) => {
      if (e.target.closest('.frame-opts')) return;
      selectProduct(product);
    };

    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        btn.click();
      }
    });

    if (frames && frames.length > 0) {
      const colourRadios = btn.querySelectorAll('.frame-colour-radio');

      colourRadios.forEach((radio) => {
        radio.addEventListener('change', (e) => {
          e.stopPropagation();
          if (selectedProduct?.id === product.id) {
            const value = radio.value || null;
            handleFrameChange(product, value, !!value);
          }
        });
      });
    }

    container.appendChild(btn);
  });

  // Custom size option — always appended last; no frame option.
  const customBtn = document.createElement('div');
  customBtn.className = 'size-opt size-opt-custom';
  customBtn.dataset.productId = 'custom';
  customBtn.innerHTML = `
    <div class="size-opt-top">
      <div class="size-opt-info">
        <div class="size-opt-name-row"><div class="size-opt-name">Custom</div></div>
        <div class="size-opt-sub">Up to ${CUSTOM_SIZE_MAX_MM}\u00D7${CUSTOM_SIZE_MAX_MM}mm</div>
      </div>
      <div class="size-opt-price size-opt-price-custom">&darr; Set size</div>
    </div>
  `;
  customBtn.setAttribute('role', 'button');
  customBtn.setAttribute('tabindex', '0');
  customBtn.setAttribute('aria-pressed', 'false');
  customBtn.onclick = () => activateCustomSize();
  customBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      customBtn.click();
    }
  });
  container.appendChild(customBtn);
}

function selectProduct(product) {
  if (!product) return;
  const isNewProduct = !selectedProduct || selectedProduct.id !== product.id;
  if (isNewProduct) {
    if (selectionStats && selectedProduct) selectionStat('size_changes');
    else selectionStat();
    const viewValue = Number.isFinite(Number(product.unitAmount)) ? Number(product.unitAmount) / 100 : 0;
    track('view_item', {
      value: viewValue,
      currency: 'GBP',
      items: [{ item_id: product.priceId, item_name: product.name, price: viewValue, quantity: 1 }],
    }, {
      metaParams: {
        content_ids: [product.priceId],
        content_name: product.name,
        content_type: 'product',
        value: viewValue,
        currency: 'GBP',
      },
    });
  }
  const prevBBox = bbox ? { ...bbox } : null;
  const prevCenter = prevBBox
    ? { lat: (prevBBox.south + prevBBox.north) / 2, lng: (prevBBox.west + prevBBox.east) / 2 }
    : null;
  selectedProduct = product;

  // Reset frame selection when switching to a different product.
  if (isNewProduct) {
    selectedFrame = null;
    document.querySelectorAll('.frame-opts').forEach((el) => {
      el.hidden = true;
      const noneRadio = el.querySelector('.frame-colour-radio[value=""]');
      if (noneRadio) noneRadio.checked = true;
    });
  }
  // Reveal frame options for the newly selected product (not custom).
  if (product.id !== 'custom' && (frameOptions[product.frameKey]?.length > 0)) {
    const activeFrameOpts = document.querySelector(`.size-opt[data-product-id="${product.id}"] .frame-opts`);
    if (activeFrameOpts) activeFrameOpts.hidden = false;
  }

  // Rotation resets for the new product; landscape mode and zoom carry over.
  frameRotation = 0;
  const rotBtn = document.getElementById('rotation-btn');
  if (rotBtn) rotBtn.setAttribute('aria-pressed', 'false');
  applyLandscapeUI();

  // Disable rotate button for square products and custom sizes.
  const isSquare = Math.abs((Number(product.aspectRatio) || 1) - 1) < 0.01;
  if (rotBtn) rotBtn.disabled = isSquare || product.id === 'custom';

  document.querySelectorAll('.size-opt').forEach((b) => {
    b.classList.remove('active');
    b.setAttribute('aria-pressed', 'false');
  });
  const activeBtn = document.querySelector(`.size-opt[data-product-id="${product.id}"]`);
  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.setAttribute('aria-pressed', 'true');
  }

  // Show or hide the custom size inputs panel.
  const customPanel = document.getElementById('custom-size-panel');
  if (customPanel) customPanel.hidden = product.id !== 'custom';

  // Show or hide the frame line in the order summary.
  const frameLine = document.getElementById('order-frame-line');
  const frameVal = document.getElementById('order-frame');
  if (frameLine) {
    frameLine.hidden = product.id === 'custom' || !(frameOptions[product.frameKey]?.length > 0);
    if (frameVal && isNewProduct) frameVal.textContent = 'No frame';
  }

  if (layerGroup) layerGroup.clearLayers();
  resetReviewState();

  document.getElementById('sel-run').disabled = true;
  document.getElementById('map-hint').textContent = 'Placing your frame…';

  document.getElementById('order-scale').textContent = `${product.name} \u00B7 ${product.displaySize}`;
  document.getElementById('order-price').textContent = formatPriceFromAmount(getEffectiveUnitAmount(product, selectedFrame));

  // Place (or morph) the frame immediately at the center of the current viewport.
  if (map && handleIcon) {
    const center = prevCenter || map.getCenter();
    const nextBBox = computeBBoxForProduct(center, product, frameZoom);
    if (nextBBox) {
      if (prevBBox && bboxLayer && handle) {
        animateBBoxTo(nextBBox, 420);
      } else {
        createBBox(center, handleIcon);
      }
      document.getElementById('sel-run').disabled = false;
      if (!window.matchMedia('(pointer: coarse)').matches) {
        document.getElementById('map-hint').textContent = 'Drag the corner handle to reposition';
      }
      document.getElementById('order-status-msg').textContent = 'Adjust the frame, then add to cart.';
    } else {
      document.getElementById('order-status-msg').textContent = 'Unable to place the frame for this size.';
      document.getElementById('map-hint').textContent = 'Select a different size';
    }
  } else {
    document.getElementById('order-status-msg').textContent =
      'Select a scale to place your frame.';
    document.getElementById('map-hint').textContent = 'Select a scale to place your frame';
  }
}

function getEffectiveUnitAmount(product, frameValue) {
  if (!product) return null;
  const amount = product.unitAmount != null ? Number(product.unitAmount) : null;
  if (frameValue && amount != null) {
    const frames = product.frameKey ? (frameOptions[product.frameKey] ?? null) : null;
    const frame = frames?.find(f => f.priceId === frameValue);
    if (frame) return amount + frame.unitAmount;
  }
  return amount;
}

function handleFrameChange(product, frameValue, isEnabled) {
  selectedFrame = frameValue;
  document.getElementById('order-price').textContent = formatPriceFromAmount(getEffectiveUnitAmount(product, frameValue));
  const frames = product.frameKey ? (frameOptions[product.frameKey] ?? null) : null;
  const frame = frameValue ? frames?.find(f => f.priceId === frameValue) : null;
  const frameVal = document.getElementById('order-frame');
  if (frameVal) {
    frameVal.textContent = frame ? `${frame.colourName}` : 'No frame';
  }
  // The preview's frame picker lands here too, via selectStoreFrame.
  track('select_frame', {
    frame: frame?.colourName || 'none',
    size: product.name,
    source: document.querySelector('.pv-overlay') ? 'preview' : 'store',
  });
}

function _applyFramePrices(rawFramePrices) {
  if (!rawFramePrices || typeof rawFramePrices !== 'object') return;
  // Build a fresh map so a background refresh cannot leave behind frame keys or
  // colours the API no longer sells (and their old prices).
  const next = {};
  Object.entries(rawFramePrices).forEach(([frameKey, framesArray]) => {
    if (Array.isArray(framesArray) && framesArray.length > 0) {
      const valid = framesArray.filter(f =>
        typeof f?.priceId === 'string' &&
        typeof f.unitAmount === 'number' &&
        typeof f.colourHex === 'string' &&
        /^#[0-9a-fA-F]{3,8}$/.test(f.colourHex) &&
        typeof f.colourName === 'string'
      );
      if (valid.length > 0) {
        next[frameKey] = valid.map(f => ({
          priceId: f.priceId,
          // Optional: a cached response from before the API returned this field has
          // no productId, in which case checkout falls back to the legacy payload.
          ...(typeof f.productId === 'string' && f.productId ? { productId: f.productId } : {}),
          unitAmount: f.unitAmount,
          colourHex: f.colourHex,
          colourName: f.colourName,
        }));
      }
    }
  });
  if (Object.keys(next).length > 0) frameOptions = next;
}

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

async function initStore() {
  if (storeInited) return;
  storeInited = true;

  const loadingEl = document.getElementById('store-size-loading');
  const emptyEl = document.getElementById('size-options-empty');
  if (loadingEl) loadingEl.classList.remove('hidden');
  if (emptyEl) emptyEl.classList.add('hidden');

  await loadProducts();

  if (loadingEl) loadingEl.classList.add('hidden');

  initMap();
  initCustomSizePanel();
  initFrameControls();
  initMobileInputFix();
  if (selectedProduct) {
    // If the user selected a size before the map finished initializing, re-run selection to auto-place the frame.
    selectProduct(selectedProduct);
    return;
  }
  const _scaleParam = new URLSearchParams(window.location.search).get('scale');
  const _preselect = _scaleParam && products.find(
    (p) => p.id?.toLowerCase() === _scaleParam.toLowerCase() ||
           p.name?.toLowerCase().replace(/\s+/g, '') === _scaleParam.toLowerCase()
  );
  if (_preselect) {
    selectProduct(_preselect);
  } else if (products.length > 0) {
    selectProduct(products[0]);
  }
}

function setupMapSearch() {
  const input = document.getElementById('map-search-input');
  const button = document.getElementById('map-search-btn');
  const resultsEl = document.getElementById('map-search-results');
  if (!input || !button || !resultsEl) return;

  let activeIndex = -1;
  let activeResults = [];

  const clearResults = () => {
    resultsEl.innerHTML = '';
    resultsEl.classList.remove('show');
    resultsEl.setAttribute('aria-hidden', 'true');
    activeIndex = -1;
    activeResults = [];
  };

  const applyResult = (item) => {
    const lat = Number(item?.lat);
    const lon = Number(item?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    track('map_search_pick', {
      position: Math.max(0, activeResults.indexOf(item)),
      place_type: item.addresstype || item.type,
      country: item.address?.country,
    });
    map.setView([lat, lon], Math.max(map.getZoom(), 14), { animate: false });

    // After search, always center the frame on the new viewport center (if a product is selected).
    if (selectedProduct && map && handleIcon) {
      const center = map.getCenter();
      const next = computeBBoxForProduct(center, selectedProduct, frameZoom);
      if (next) {
        if (bbox && bboxLayer && handle) {
          animateBBoxTo(next, 420);
        } else {
          createBBox(center, handleIcon);
        }
        document.getElementById('sel-run').disabled = false;
        if (!window.matchMedia('(pointer: coarse)').matches) {
          document.getElementById('map-hint').textContent = 'Drag the corner handle to reposition';
        }
        document.getElementById('order-status-msg').textContent = 'Looking good! Adjust the frame then add to cart.';
      }
    }
    clearResults();
  };

  const setActiveIndex = (nextIndex, { focus = false } = {}) => {
    if (!Array.isArray(activeResults) || activeResults.length === 0) return;
    const clamped = Math.max(0, Math.min(activeResults.length - 1, nextIndex));
    activeIndex = clamped;
    resultsEl.querySelectorAll('.map-search-result[role="option"]').forEach((el) => {
      const idx = Number(el.dataset.index);
      el.setAttribute('aria-selected', idx === activeIndex ? 'true' : 'false');
    });
    if (focus) {
      const el = resultsEl.querySelector(`.map-search-result[data-index="${activeIndex}"]`);
      el?.focus?.();
    }
  };

  const renderResults = (items) => {
    resultsEl.innerHTML = '';
    if (!items || items.length === 0) {
      const row = document.createElement('div');
      row.className = 'map-search-result is-empty';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.textContent = 'No results found.';
      resultsEl.appendChild(row);
      resultsEl.classList.add('show');
      resultsEl.setAttribute('aria-hidden', 'false');
      activeIndex = -1;
      activeResults = [];
      return;
    }
    activeResults = items.slice();
    activeIndex = 0;
    items.forEach((item, idx) => {
      const row = document.createElement('button');
      row.className = 'map-search-result';
      row.type = 'button';
      row.dataset.index = String(idx);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', idx === activeIndex ? 'true' : 'false');
      const _strong = document.createElement('strong');
      _strong.textContent = item.display_name;
      row.appendChild(_strong);
      row.onclick = () => applyResult(item);
      row.onmouseenter = () => setActiveIndex(idx);
      row.onfocus = () => setActiveIndex(idx);
      resultsEl.appendChild(row);
    });
    resultsEl.classList.add('show');
    resultsEl.setAttribute('aria-hidden', 'false');
  };

  const runSearch = async (autoSelectTop = false) => {
    const query = input.value.trim();
    if (!query) {
      clearResults();
      return;
    }
    button.disabled = true;
    button.textContent = 'Searching\u2026';
    try {
      const url = new URL(NOMINATIM_SEARCH_URL);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('q', query);
      url.searchParams.set('limit', '6');
      url.searchParams.set('addressdetails', '1');
      // Worldwide on purpose: any place can be sculpted (delivery is UK only).
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      const results = Array.isArray(data) ? data : [];
      // The query itself stays out: people search their own address.
      selectionStat('searches');
      track('map_search', { result_count: results.length, auto_selected: autoSelectTop }, { metaParams: {} });
      if (autoSelectTop && results.length > 0) {
        applyResult(results[0]);
        return;
      }
      renderResults(results);
    } catch {
      renderResults([]);
    } finally {
      button.disabled = false;
      button.textContent = 'Search';
    }
  };

  button.onclick = () => runSearch(false);
  input.onkeydown = (e) => {
    const isOpen = resultsEl.classList.contains('show');
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isOpen && activeIndex >= 0 && activeResults[activeIndex]) {
        applyResult(activeResults[activeIndex]);
        return;
      }
      runSearch(true);
    }
    if (e.key === 'Escape') {
      clearResults();
    }
    if (e.key === 'ArrowDown') {
      if (!isOpen || activeResults.length === 0) return;
      e.preventDefault();
      setActiveIndex(activeIndex + 1, { focus: true });
    }
    if (e.key === 'ArrowUp') {
      if (!isOpen || activeResults.length === 0) return;
      e.preventDefault();
      setActiveIndex(activeIndex - 1, { focus: true });
    }
  };

  resultsEl.addEventListener('keydown', (e) => {
    const isOpen = resultsEl.classList.contains('show');
    if (!isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      clearResults();
      input.focus();
    }
    if (e.key === 'ArrowDown') {
      if (activeResults.length === 0) return;
      e.preventDefault();
      setActiveIndex(activeIndex + 1, { focus: true });
    }
    if (e.key === 'ArrowUp') {
      if (activeResults.length === 0) return;
      e.preventDefault();
      setActiveIndex(activeIndex - 1, { focus: true });
    }
  });

  document.addEventListener('click', (e) => {
    if (!resultsEl.classList.contains('show')) return;
    if (e.target === input || resultsEl.contains(e.target) || e.target === button) return;
    clearResults();
  });
}

function showStore() {
  window.location.href = '/store/';
}

function showLanding() {
  window.location.href = '/';
}

let map, layerGroup, bbox, bboxLayer, handle;
let selectionMeta = null;
let cart = [];
let cartPreviewMaps = new Map();
let frameRotation = 0;   // degrees 0-359
let frameZoom = 1.0;     // geographic scale factor: 0.7-1.3, or 2-7 in landscape mode
let frameCenter = null;  // { lat, lng } actual center of the frame
let frameCorners = null; // [[lat,lng]×4] rotated corners currently drawn
let landscapeMode = false; // true = terrain-only piece (no buildings), wider zoom range unlocked

const ZOOM_STANDARD = { min: 0.7, max: 1.3, initial: 1.0 };
// Landscape zoom really runs 2-7x, but the label reads 2-10x: the real value
// is stretched linearly so the top of the slider shows as 10x.
const ZOOM_LANDSCAPE = { min: 2, max: 7, displayMax: 10, initial: 4.5 };

function zoomRange() {
  return landscapeMode ? ZOOM_LANDSCAPE : ZOOM_STANDARD;
}

// Leaflet zoom below which the placed frame is cleared. Landscape frames run
// to ~14km wide, so that mode lets the map pull back to a regional view.
const MAP_MIN_ZOOM_STANDARD = 12;
const MAP_MIN_ZOOM_LANDSCAPE = 9;

function frameMinMapZoom() {
  return landscapeMode ? MAP_MIN_ZOOM_LANDSCAPE : MAP_MIN_ZOOM_STANDARD;
}

function zoomLabel(zoom) {
  if (!landscapeMode) return `${zoom.toFixed(1)}×`;
  const { min, max, displayMax } = ZOOM_LANDSCAPE;
  const shown = min + ((zoom - min) / (max - min)) * (displayMax - min);
  return `${shown.toFixed(1)}×`;
}

// Sets frameZoom (clamped to the current mode's range) and syncs the slider.
function setFrameZoom(zoom) {
  const { min, max } = zoomRange();
  frameZoom = Math.round(Math.min(max, Math.max(min, zoom)) * 10) / 10;
  const zoomSlider = document.getElementById('zoom-slider');
  const zoomVal = document.getElementById('zoom-val');
  if (zoomSlider) {
    zoomSlider.min = String(min);
    zoomSlider.max = String(max);
    zoomSlider.value = String(frameZoom);
    syncZoomFill();
  }
  if (zoomVal) zoomVal.textContent = zoomLabel(frameZoom);
}

// Reflects landscapeMode into the toggle button, the map banner, the zoom
// slider's range, and (on the store page) the order summary line.
function applyLandscapeUI() {
  const btn = document.getElementById('landscape-toggle-btn');
  const banner = document.getElementById('landscape-banner');
  const orderLine = document.getElementById('order-landscape-line');

  if (btn) btn.setAttribute('aria-pressed', landscapeMode ? 'true' : 'false');
  if (banner) {
    banner.classList.toggle('is-visible', landscapeMode);
    banner.setAttribute('aria-hidden', landscapeMode ? 'false' : 'true');
  }
  if (orderLine) orderLine.hidden = !landscapeMode;

  setFrameZoom(frameZoom);
}

// The slider track is filled up to the thumb via a CSS custom property.
function syncZoomFill() {
  const zoomSlider = document.getElementById('zoom-slider');
  if (!zoomSlider) return;
  const min = Number(zoomSlider.min);
  const max = Number(zoomSlider.max);
  const pct = ((Number(zoomSlider.value) - min) / (max - min)) * 100;
  zoomSlider.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct))}%`);
}

// A homepage gallery piece links here with the place it shows attached, so the
// map opens on that location rather than the default view. Anything off the
// map or unparseable is ignored and the default stands.
function readMapStart(worldBounds) {
  const params = new URLSearchParams(window.location.search);
  const lat = parseFloat(params.get('lat'));
  const lng = parseFloat(params.get('lng'));
  const z   = parseInt(params.get('z'), 10);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!worldBounds.contains([lat, lng])) return null;
  return { centre: [lat, lng], zoom: Number.isFinite(z) ? Math.min(Math.max(z, 12), 19) : 15 };
}

function initMap() {
  // Any place on Earth can be framed; bounds only stop panning off the edge of
  // the Web Mercator map (which ends near ±85° latitude). Opens on London.
  const worldBounds = L.latLngBounds([-85, -180], [85, 180]);
  const start = readMapStart(worldBounds);
  map = L.map('store-map', {
    zoomControl: false,
    maxBounds: worldBounds,
    maxBoundsViscosity: 1.0,
  }).setView(start ? start.centre : [51.505, -0.09], start ? start.zoom : 14);
  L.control.zoom({ position: 'topleft' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '\u00A9 OpenStreetMap',
  }).addTo(map);
  layerGroup = L.layerGroup().addTo(map);

  const hIcon = L.divIcon({
    className: '',
    html: `<div style="width:28px;height:28px;border-radius:50%;background:white;border:2.5px solid #c94f2c;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,0.2);cursor:grab"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#c94f2c" stroke-width="2.5"><path d="M12 2v20M2 12h20"/></svg></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
  handleIcon = hIcon;
  setupMapSearch();

  document.getElementById('sel-run').onclick = offerPreview;
  document.getElementById('sel-clear').onclick = clearMap;

  // No map click handler: frame placement is driven by the scale selector only (see selectProduct).

  map.on('dragend', () => { if (selectionStats) selectionStat('map_pans'); });
  map.on('zoomend', () => {
    if (!bbox) return;
    if (selectionStats) selectionStat('map_zooms');
    if (map.getZoom() < frameMinMapZoom()) {
      clearFrame();
      document.getElementById('map-hint').textContent =
        'Zoom back in to place your frame — selections clear below street level.';
    }
  });
}

function clearCart() {
  cart = [];
  try {
    localStorage.removeItem(cartStorageKey);
  } catch {
    // ignore
  }
  renderCart();
}

function bboxToBounds(b) {
  if (!b) return null;
  const south = Number(b.south);
  const west = Number(b.west);
  const north = Number(b.north);
  const east = Number(b.east);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  return L.latLngBounds([south, west], [north, east]);
}

function syncCartPreviewMaps() {
  if (typeof L === 'undefined') return;
  const previewEls = Array.from(document.querySelectorAll('.cart-item-preview'));
  const keep = new Set();
  let cartMutated = false;

  const resolveCartItemBBox = (item) => {
    const existingBounds = bboxToBounds(item?.bbox);
    if (existingBounds) return existingBounds;

    // Back-compat: older carts may be missing `bbox`, but we can often recompute it from
    // the stored `center` and known product dimensions.
    const center = item?.center;
    if (!center || !Number.isFinite(Number(center.lat)) || !Number.isFinite(Number(center.lng))) return null;

    const resolvedProduct =
      products.find((p) => String(p?.id) === String(item?.productId));

    // If we can't resolve a product entry (e.g., cart opened on pages where products
    // aren't loaded), fall back to dimensions stored on the cart item itself.
    const pseudoProduct = resolvedProduct
      ? resolvedProduct
      : {
          sizeCode: item?.sizeCode,
          aspectRatio: item?.aspectRatio,
        };

    const computed = computeBBoxForProduct({ lat: Number(center.lat), lng: Number(center.lng) }, pseudoProduct);
    const computedBounds = bboxToBounds(computed);
    if (!computedBounds) return null;

    item.bbox = computed;
    cartMutated = true;
    return computedBounds;
  };

  previewEls.forEach((el) => {
    const id = String(el.dataset.itemId || '');
    const item = cart.find((i) => String(i?.id) === id);
    if (!id) return;

    const bounds = resolveCartItemBBox(item);
    if (!bounds) {
      // Older carts (or fallback data) may not include enough info to preview.
      el.classList.add('is-fallback');
      el.innerHTML = '<div class="cart-item-preview-fallback">Preview unavailable</div>';
      return;
    }

    el.classList.remove('is-fallback');
    keep.add(id);
    const existing = cartPreviewMaps.get(id);
    if (existing) {
      const existingContainer = existing?.container || existing?.map?._container || null;
      const containerDetached = existingContainer ? !document.body.contains(existingContainer) : true;
      const containerMismatch = existingContainer ? existingContainer !== el : true;
      if (containerDetached || containerMismatch) {
        try {
          existing.map.remove();
        } catch {
          // ignore
        }
        cartPreviewMaps.delete(id);
      } else {
      existing.rect.setBounds(bounds);
      existing.map.fitBounds(bounds, { padding: [10, 10], animate: false });
      existing.map.invalidateSize(false);
      return;
      }
    }

    // Ensure container is empty (Leaflet will inject its own DOM)
    el.innerHTML = '';

    const m = L.map(el, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
      touchZoom: false,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '\u00A9 OpenStreetMap',
    }).addTo(m);

    const rect = L.rectangle(bounds, {
      color: '#c94f2c',
      weight: 3,
      fillColor: '#c94f2c',
      fillOpacity: 0.12,
      dashArray: '5 4',
    }).addTo(m);

    m.fitBounds(bounds, { padding: [10, 10], animate: false });

    cartPreviewMaps.set(id, { map: m, rect, container: el });

    // If the drawer is animating open, sizes can be wrong at first render.
    setTimeout(() => {
      try {
        m.invalidateSize(false);
        m.fitBounds(bounds, { padding: [10, 10], animate: false });
      } catch {
        // ignore
      }
    }, 80);
    setTimeout(() => {
      try {
        m.invalidateSize(false);
        m.fitBounds(bounds, { padding: [10, 10], animate: false });
      } catch {
        // ignore
      }
    }, 360);
  });

  for (const [id, entry] of cartPreviewMaps.entries()) {
    if (keep.has(id)) continue;
    try {
      entry.map.remove();
    } catch {
      // ignore
    }
    cartPreviewMaps.delete(id);
  }

  if (cartMutated) {
    try {
      saveCart();
    } catch {
      // ignore
    }
  }
}

function mToLat(m) {
  return m / 111320;
}

function mToLon(m, lat) {
  return m / (111320 * Math.cos((lat * Math.PI) / 180));
}

function computeBBox(c) {
  if (!selectedProduct) return null;
  const width = Number(selectedProduct.sizeCode);
  if (!Number.isFinite(width)) return null;
  const ratio = Number(selectedProduct.aspectRatio);
  const aspectRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const w = width;
  const h = width * aspectRatio;
  const dLat = mToLat(h / 2);
  const dLon = mToLon(w / 2, c.lat);
  return { south: c.lat - dLat, north: c.lat + dLat, west: c.lng - dLon, east: c.lng + dLon };
}

function computeBBoxForProduct(c, product, zoom = 1) {
  if (!product) return null;
  const width = Number(product.sizeCode) * zoom;
  if (!Number.isFinite(width)) return null;
  const ratio = Number(product.aspectRatio);
  const aspectRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const w = width;
  const h = width * aspectRatio;
  const dLat = mToLat(h / 2);
  const dLon = mToLon(w / 2, c.lat);
  return { south: c.lat - dLat, north: c.lat + dLat, west: c.lng - dLon, east: c.lng + dLon };
}

// Compute 4 rotated corners (lat/lng) of the frame for a given center, product, rotation and zoom.
// Corners are returned in order: top-left, top-right, bottom-right, bottom-left (rotated).
function computeRotatedCorners(center, product, rotationDeg, zoom) {
  if (!product || !center) return null;
  const width = Number(product.sizeCode) * (zoom || 1);
  if (!Number.isFinite(width) || width <= 0) return null;
  const ratio = Number(product.aspectRatio);
  const ar = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const w = width;       // east-west meters
  const h = width * ar;  // north-south meters

  const rad = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  // Local corners relative to center (x = east m, y = north m):
  const local = [
    { x: -w / 2, y:  h / 2 },  // top-left
    { x:  w / 2, y:  h / 2 },  // top-right
    { x:  w / 2, y: -h / 2 },  // bottom-right
    { x: -w / 2, y: -h / 2 },  // bottom-left
  ];

  return local.map(({ x, y }) => {
    const rx = x * cosR - y * sinR;  // rotated east offset
    const ry = x * sinR + y * cosR;  // rotated north offset
    return [
      center.lat + mToLat(ry),
      center.lng + mToLon(rx, center.lat),
    ];
  });
}

// Axis-aligned bounding box that encloses all polygon corners.
function cornersToBBox(corners) {
  const lats = corners.map((c) => c[0]);
  const lngs = corners.map((c) => c[1]);
  return {
    south: Math.min(...lats),
    north: Math.max(...lats),
    west:  Math.min(...lngs),
    east:  Math.max(...lngs),
  };
}

// Return the index of the visually top-left (north-west) corner of a rotated polygon.
// Picks the corner with the highest latitude; ties broken by lowest longitude.
function findTopLeftCorner(corners) {
  let best = 0;
  for (let i = 1; i < corners.length; i++) {
    const [clat, clng] = corners[i];
    const [blat, blng] = corners[best];
    if (clat > blat + 1e-10) { best = i; continue; }
    if (Math.abs(clat - blat) < 1e-10 && clng < blng) { best = i; }
  }
  return best;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function setBBoxLive(next) {
  bbox = next;
  // During animation frameRotation is always 0, so corners == axis-aligned bbox corners.
  frameCenter = {
    lat: (next.south + next.north) / 2,
    lng: (next.west + next.east) / 2,
  };
  frameCorners = [
    [next.north, next.west],
    [next.north, next.east],
    [next.south, next.east],
    [next.south, next.west],
  ];
  if (bboxLayer) {
    bboxLayer.setLatLngs(frameCorners);
  }
  if (handle) handle.setLatLng(frameCorners[0]);
}

let bboxAnim = null;
function animateBBoxTo(targetBBox, durationMs = 420) {
  if (!bbox || !targetBBox) return;
  if (bboxAnim) cancelAnimationFrame(bboxAnim);

  const from = { ...bbox };
  const start = performance.now();

  if (bboxLayer) bboxLayer.setStyle({ dashArray: '0', fillOpacity: 0.04 });

  const step = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    const e = easeInOutCubic(t);
    const next = {
      south: lerp(from.south, targetBBox.south, e),
      north: lerp(from.north, targetBBox.north, e),
      west: lerp(from.west, targetBBox.west, e),
      east: lerp(from.east, targetBBox.east, e),
    };
    setBBoxLive(next);

    if (t < 1) {
      bboxAnim = requestAnimationFrame(step);
      return;
    }

    setBBoxLive(targetBBox);
    if (bboxLayer) bboxLayer.setStyle({ dashArray: '6 4', fillOpacity: 0.05 });
    updateLocationDisplay();
    bboxAnim = null;
  };

  bboxAnim = requestAnimationFrame(step);
}

function createBBox(c, icon) {
  frameCenter = { lat: c.lat, lng: c.lng };
  if (icon) handleIcon = icon;

  const frameControlsEl = document.getElementById('frame-controls');
  if (frameControlsEl && frameControlsEl.hidden) {
    frameControlsEl.hidden = false;
    frameControlsEl.removeAttribute('hidden');
  }

  redrawFrame();
  updateLocationDisplay();
}

// Single function that (re)draws the polygon and handle from current frame state.
function redrawFrame() {
  if (!frameCenter || !selectedProduct || !map || !handleIcon) return;

  const corners = computeRotatedCorners(frameCenter, selectedProduct, frameRotation, frameZoom);
  if (!corners) return;

  frameCorners = corners;
  bbox = cornersToBBox(corners);

  if (bboxLayer) {
    bboxLayer.setLatLngs(corners);
  } else {
    bboxLayer = L.polygon(corners, {
      color: '#c94f2c',
      weight: 2,
      fillColor: '#c94f2c',
      fillOpacity: 0.05,
      dashArray: '6 4',
    }).addTo(map);
  }

  const handlePos = corners[findTopLeftCorner(corners)]; // visual top-left (NW)
  if (handle) {
    handle.setLatLng(handlePos);
  } else {
    handle = L.marker(handlePos, { draggable: true, icon: handleIcon }).addTo(map);
    handle.on('dragstart', () => {
      resetReviewState();
    });
    handle.on('drag', (e) => {
      layerGroup.clearLayers();
      moveFromHandle(e.target.getLatLng(), false);
    });
    handle.on('dragend', (e) => {
      selectionStat('drags');
      moveFromHandle(e.target.getLatLng(), true);
    });
  }

  const frameControlsEl = document.getElementById('frame-controls');
  if (frameControlsEl && frameControlsEl.hidden) {
    frameControlsEl.hidden = false;
  }
}

function moveFromHandle(newHandleLl, updateLocation = true) {
  if (!frameCenter || !frameCorners) return;
  // Shift the center by the same delta the visual top-left corner moved.
  const oldHandle = frameCorners[findTopLeftCorner(frameCorners)];
  const deltaLat = newHandleLl.lat - oldHandle[0];
  const deltaLng = newHandleLl.lng - oldHandle[1];
  frameCenter = { lat: frameCenter.lat + deltaLat, lng: frameCenter.lng + deltaLng };
  redrawFrame();
  if (updateLocation) updateLocationDisplay();
}

function clearFrame() {
  if (layerGroup) layerGroup.clearLayers();
  resetReviewState();
  if (bboxLayer) {
    map.removeLayer(bboxLayer);
    bboxLayer = null;
  }
  if (handle) {
    map.removeLayer(handle);
    handle = null;
  }
  bbox = null;
  frameCenter = null;
  frameCorners = null;
  frameRotation = 0;
  frameZoom = ZOOM_STANDARD.initial;
  landscapeMode = false;
  selectionMeta = null;
  selectedFrame = null;
  const _frameLine = document.getElementById('order-frame-line');
  if (_frameLine) _frameLine.hidden = true;
  const rotBtn = document.getElementById('rotation-btn');
  if (rotBtn) rotBtn.setAttribute('aria-pressed', 'false');
  applyLandscapeUI();
  const frameControlsEl = document.getElementById('frame-controls');
  if (frameControlsEl) frameControlsEl.hidden = true;
  document.getElementById('sel-run').disabled = true;
  document.getElementById('sel-run').textContent = 'Add to cart \u2192';
  document.getElementById('order-status-msg').textContent =
    'Select a scale to place your frame.';
  document.getElementById('map-hint').textContent = 'Select a scale to place your frame';
}

function clearMap() {
  clearFrame();
  document.getElementById('sel-run').disabled = true;
  document.getElementById('sel-run').textContent = 'Add to cart \u2192';
  document.getElementById('order-scale').textContent = '\u2014';
  document.getElementById('order-price').textContent = '\u2014';
  document.getElementById('order-status-msg').textContent =
    'Choose a scale to place your frame.';
  document.getElementById('map-hint').textContent = 'Select a scale to place your frame';
  document.querySelectorAll('.size-opt').forEach((b) => b.classList.remove('active'));
  selectedProduct = null;
  const customPanel = document.getElementById('custom-size-panel');
  if (customPanel) customPanel.hidden = true;
}

function updateLocationDisplay() {
  if (!bbox) return;
  const center = {
    lat: (bbox.south + bbox.north) / 2,
    lng: (bbox.west + bbox.east) / 2,
  };
  selectionMeta = {
    center,
    bbox,
    rotation: frameRotation,
    zoom: frameZoom,
    landscape: landscapeMode,
    locationText: null,
  };
  const btn = document.getElementById('sel-run');
  if (btn && btn.textContent.includes('Added to cart')) {
    btn.textContent = 'Add to cart \u2192';
  }
}


function loadCart() {
  try {
    const stored = JSON.parse(localStorage.getItem(cartStorageKey));
    cart = Array.isArray(stored) ? stored : [];
    cart = cart.filter((item) => item && item.priceId);
  } catch {
    cart = [];
  }
}

function saveCart() {
  localStorage.setItem(cartStorageKey, JSON.stringify(cart));
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '\u00A3\u2014';
  return `\u00A3${n.toFixed(0)}`;
}

function renderCart() {
  const cartItemsEl = document.getElementById('cart-items');
  const cartCountEl = document.getElementById('cart-count');
  const cartToggleEl = document.getElementById('cart-toggle');
  const cartTotalEl = document.getElementById('cart-total');
  const checkoutBtn = document.getElementById('cart-checkout');
  if (!cartItemsEl || !cartCountEl || !cartTotalEl || !checkoutBtn) return;

  cartItemsEl.innerHTML = '';
  cartCountEl.textContent = String(cart.length);
  if (cartToggleEl) {
    const suffix = cart.length === 1 ? 'item' : 'items';
    cartToggleEl.setAttribute('aria-label', `Open cart (${cart.length} ${suffix})`);
  }

  if (cart.length === 0) {
    cartItemsEl.innerHTML = '<div class="cart-empty">Your cart is empty. Add a sculpture to continue.</div>';
    cartTotalEl.textContent = '\u00A30';
    checkoutBtn.disabled = true;
    syncCartPreviewMaps();
    return;
  }
  checkoutBtn.disabled = false;

  let total = 0;
  cart.forEach((item, idx) => {
    const p = Number(item.price);
    if (Number.isFinite(p)) total += p;
    const itemEl = document.createElement('div');
    itemEl.className = 'cart-item';
    const labelLine = item.customLabel
      ? `<div class="cart-item-meta cart-item-custom-label">${escapeHtml(item.customLabel)}</div><div class="cart-item-geo">${escapeHtml(item.location)}</div>`
      : `<div class="cart-item-meta">${escapeHtml(item.location)}</div>`;
    const frameLine = item.frame ? `<div class="cart-item-frame">${escapeHtml(item.frameName || 'With frame')}</div>` : '';
    const landscapeLine = item.landscape ? '<div class="cart-item-landscape">Landscape &middot; no buildings</div>' : '';
    itemEl.innerHTML = `
      <div class="cart-item-preview" data-item-id="${escapeHtml(item.id)}"></div>
      <div class="cart-item-title">${escapeHtml(item.name)}</div>
      ${frameLine}
      ${landscapeLine}
      ${labelLine}
      <div class="cart-item-row">
        <div class="cart-item-price">${formatPrice(item.price)}</div>
        <button type="button" class="cart-item-remove" data-index="${idx}">Remove</button>
      </div>
    `;
    cartItemsEl.appendChild(itemEl);
  });

  cartTotalEl.textContent = formatPrice(total);
  cartItemsEl.querySelectorAll('.cart-item-remove').forEach((btn) => {
    btn.onclick = () => {
      const index = Number(btn.dataset.index);
      const removed = cart.splice(index, 1);
      if (removed.length) {
        track('remove_from_cart', { value: cartValue(removed), currency: 'GBP', items: gaItems(removed) });
      }
      saveCart();
      renderCart();
    };
  });

  syncCartPreviewMaps();
}

function addSelectionToCart() {
  if (!selectedProduct || !selectionMeta) return;

  const CART_LIMIT = 10;
  if (cart.length >= CART_LIMIT) {
    document.getElementById('order-status-msg').textContent = `Cart limit reached (${CART_LIMIT} items max).`;
    showBanner(`You can only add up to ${CART_LIMIT} items to your cart.`, 'fail');
    return;
  }

  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const frames = selectedProduct.frameKey ? (frameOptions[selectedProduct.frameKey] ?? null) : null;
  const selectedFrameData = selectedFrame ? frames?.find(f => f.priceId === selectedFrame) : null;
  const hasFrame = !!selectedFrameData && selectedProduct.id !== 'custom';
  const frameUnitAmount = hasFrame ? selectedFrameData.unitAmount : 0;
  const baseUnitAmount = Number.isFinite(Number(selectedProduct.unitAmount)) ? Number(selectedProduct.unitAmount) : 0;

  const item = {
    id,
    productId: selectedProduct.id,
    priceId: selectedProduct.priceId,
    name: selectedProduct.name,
    displaySize: selectedProduct.displaySize,
    sizeCode: selectedProduct.sizeCode,
    aspectRatio: selectedProduct.aspectRatio,
    price: (baseUnitAmount + frameUnitAmount) / 100,
    location: selectionMeta.locationText,
    customLabel: (document.getElementById('custom-location-label')?.value || '').trim(),
    bbox: selectionMeta.bbox,
    center: selectionMeta.center,
    rotation: selectionMeta.rotation || 0,
    zoom: selectionMeta.zoom || 1,
    landscape: !!selectionMeta.landscape,
    frame: hasFrame,
    framePriceId: hasFrame ? selectedFrameData.priceId : null,
    frameProductId: hasFrame ? (selectedFrameData.productId || null) : null,
    frameUnitAmount,
    frameName: hasFrame ? selectedFrameData.colourName : null,
    ...(selectedProduct.id === 'custom' && {
      customWidthMm: selectedProduct.customWidthMm,
      customHeightMm: selectedProduct.customHeightMm,
    }),
  };
  cart.push(item);
  const place = placeFromLabel(item.location);
  sendSelectionSummary('added_to_cart', place);
  track('add_to_cart', {
    value: Number(item.price) || 0,
    currency: 'GBP',
    items: gaItems([item]),
    framed: hasFrame,
    landscape: item.landscape,
    country: place.country,
    region: place.region,
  }, {
    metaParams: {
      content_ids: [item.priceId],
      content_name: item.name,
      content_type: 'product',
      value: Number(item.price) || 0,
      currency: 'GBP',
    },
  });
  saveCart();
  renderCart();
  const labelInput = document.getElementById('custom-location-label');
  if (labelInput) labelInput.value = '';
}

function openCart() {
  const drawer = document.getElementById('cart-drawer');
  const overlay = document.getElementById('cart-overlay');
  const toggle = document.getElementById('cart-toggle');
  const closeBtn = document.getElementById('cart-close');
  if (!drawer) return;
  if (document.body.classList.contains('cart-open')) return;

  lastCartFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.classList.add('cart-open');
  track('view_cart', { value: cartValue(cart), currency: 'GBP', items: gaItems(cart) });
  drawer.setAttribute('aria-hidden', 'false');
  overlay?.setAttribute('aria-hidden', 'false');
  toggle?.setAttribute('aria-expanded', 'true');
  cartFocusCleanup?.();
  cartFocusCleanup = createFocusTrap(drawer, closeCart);
  if (closeBtn) closeBtn.focus();
  else drawer.focus();
  syncCartPreviewMaps();
  // Re-sync after the slide-in transition so Leaflet has the final layout box.
  setTimeout(syncCartPreviewMaps, 320);
  setTimeout(syncCartPreviewMaps, 700);
}

function closeCart() {
  const drawer = document.getElementById('cart-drawer');
  const overlay = document.getElementById('cart-overlay');
  const toggle = document.getElementById('cart-toggle');
  if (!drawer) return;
  if (!document.body.classList.contains('cart-open')) return;

  document.body.classList.remove('cart-open');
  drawer.setAttribute('aria-hidden', 'true');
  overlay?.setAttribute('aria-hidden', 'true');
  toggle?.setAttribute('aria-expanded', 'false');
  cartFocusCleanup?.();
  cartFocusCleanup = null;
  if (lastCartFocus && document.documentElement.contains(lastCartFocus)) lastCartFocus.focus();
  lastCartFocus = null;
}

// Carts persisted before frameProductId existed only have framePriceId. Recover the
// product ID from the live frame options so those carts still get a v2 payload.
function _resolveFrameProductId(item) {
  if (!item || !item.framePriceId) return null;
  if (item.frameProductId) return item.frameProductId;
  for (const list of Object.values(frameOptions || {})) {
    if (!Array.isArray(list)) continue;
    const hit = list.find((f) => f.priceId === item.framePriceId);
    if (hit && hit.productId) return hit.productId;
  }
  return null;
}

async function checkoutCart() {
  if (cart.length === 0) return;

  // Validate frame selections
  if (cart.some((i) => i.frame && !i.framePriceId)) {
    showBanner('Please select a frame colour for all items with frames.', 'fail');
    return;
  }

  if (
    cart.some((i) => String(i?.priceId || '').startsWith('fallback_')) ||
    cart.some((i) => i.frame && String(i?.framePriceId || '').startsWith('fallback_'))
  ) {
    showBanner('Checkout is temporarily unavailable. Please try again shortly.', 'fail');
    return;
  }
  const checkoutBtn = document.getElementById('cart-checkout');
  checkoutBtn.disabled = true;
  checkoutBtn.textContent = 'Redirecting...';
  const coValue = cartValue(cart);
  track('begin_checkout', {
    value: coValue,
    currency: 'GBP',
    items: gaItems(cart),
  }, {
    metaParams: {
      content_ids: cart.map((i) => i.priceId),
      content_type: 'product',
      num_items: cart.length,
      value: coValue,
      currency: 'GBP',
    },
  });
  try {
    // GA client/session ids and Meta browser ids, stored on the Stripe session
    // so the webhook can attribute the purchase. Null without consent.
    const attribution = typeof window.ppAttribution === 'function'
      ? await window.ppAttribution().catch(() => null)
      : null;
    const res = await fetch(`${apiBase}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: cart.map((item) => {
          const framed = !!(item.frame && item.framePriceId);
          const frameProductId = framed ? _resolveFrameProductId(item) : null;
          return {
            priceId: item.priceId,
            productId: item.productId,
            ...(item.sizeCode != null && item.sizeCode !== ''
              ? { sizeCode: String(item.sizeCode) }
              : {}),
            bbox: item.bbox,
            center: item.center,
            rotation: item.rotation,
            zoom: item.zoom,
            landscape: !!item.landscape,
            location: item.location,
            customLabel: item.customLabel,
            // v2 shape once the frame's productId is known; the backend still accepts
            // the flat framePriceId, so an unknown productId falls back rather than 400s.
            ...(framed
              ? frameProductId
                ? { framed: true, frame: { productId: frameProductId, priceId: item.framePriceId } }
                : { framePriceId: item.framePriceId }
              : { framed: false }),
            ...(item.priceId === 'custom'
              ? { customWidthMm: item.customWidthMm, customHeightMm: item.customHeightMm }
              : {}),
          };
        }),
        ...(attribution ? { attribution } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.url) throw new Error(data.error || 'Checkout failed');
    window.location.href = data.url;
  } catch (err) {
    track('checkout_error', { message: String(err?.message || 'unknown').slice(0, 100), value: coValue });
    try { localStorage.removeItem(_STORE_CACHE_KEY); localStorage.removeItem(_PRODUCTS_CACHE_KEY); } catch {}
    showBanner(err.message || 'Unable to start checkout. Please try again.', 'fail');
  } finally {
    checkoutBtn.disabled = false;
    checkoutBtn.textContent = 'Checkout securely with Stripe';
  }
}

function initCartUI() {
  const cartToggle = document.getElementById('cart-toggle');
  if (!cartToggle) return;
  loadCart();
  renderCart();
  cartToggle.onclick = openCart;
  document.getElementById('cart-close').onclick = closeCart;
  document.getElementById('cart-overlay').onclick = closeCart;
  document.getElementById('cart-checkout').onclick = checkoutCart;
}

async function loadHomepagePrices() {
  const paint = (prods) => {
    prods.forEach((p) => {
      const el = document.getElementById(`prod-price-${p.frameKey}`);
      if (el && typeof p.unitAmount === 'number' && p.unitAmount > 0) {
        el.textContent = `From \u00a3${Math.round(p.unitAmount / 100)}`;
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

// Homepage gallery - one featured piece with a thumbnail strip. Each thumb
// carries the place it shows, so "Make this place yours" opens the store map
// on that location at the size the piece was made in.
//
// The pieces are managed in the admin app and served by GET /api/places. The
// thumbs in index.html are the fallback: they stay unless the API returns at
// least one published place, so the section is never empty. API text is
// written with textContent only.
const GALLERY_SIZE_LABELS = {
  small: 'Small · 20 × 20cm',
  a4: 'A4 · 20 × 28cm',
  large: 'Large · 32 × 32cm',
};
const GALLERY_FRAME_LABELS = { oak: 'Oak frame', black: 'Black frame', white: 'White frame' };

function galleryEyebrow(p) {
  let size = GALLERY_SIZE_LABELS[p.size];
  if (!size) {
    size = p.widthCm && p.heightCm
      ? `Custom · ${p.widthCm} × ${p.heightCm}cm`
      : 'Custom · any size';
  }
  return GALLERY_FRAME_LABELS[p.frame] ? `${size} · ${GALLERY_FRAME_LABELS[p.frame]}` : size;
}

function initGallery() {
  const gallery = document.getElementById('gallery');
  if (!gallery) return;

  const photo   = document.getElementById('gallery-photo');
  const place   = document.getElementById('gallery-place');
  const note    = document.getElementById('gallery-note');
  const eyebrow = document.getElementById('gallery-eyebrow');
  const cta     = document.getElementById('gallery-cta');
  const strip   = gallery.querySelector('.gallery-thumbs');
  let thumbs  = Array.from(strip.querySelectorAll('.gallery-thumb'));

  const show = (thumb) => {
    const d = thumb.dataset;
    photo.src = d.photo;
    photo.alt = d.alt;
    if (d.w && d.h) { photo.width = Number(d.w); photo.height = Number(d.h); }
    place.textContent   = d.place;
    note.textContent    = d.note;
    eyebrow.textContent = d.eyebrow;
    cta.href = `/store/?scale=${encodeURIComponent(d.scale)}&lat=${encodeURIComponent(d.lat)}&lng=${encodeURIComponent(d.lng)}&z=${encodeURIComponent(d.z)}`;
    cta.setAttribute('aria-label', `Make ${d.place} yours`);
    thumbs.forEach((t) => {
      t.setAttribute('aria-selected', String(t === thumb));
      t.classList.toggle('is-active', t === thumb);
    });
  };

  strip.addEventListener('click', (e) => {
    const thumb = e.target.closest('.gallery-thumb');
    if (thumb) show(thumb);
  });
  // Left/right arrows move along the strip, as a tablist should.
  strip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = thumbs.indexOf(e.target.closest('.gallery-thumb'));
    if (i < 0) return;
    e.preventDefault();
    const next = thumbs[(i + (e.key === 'ArrowRight' ? 1 : thumbs.length - 1)) % thumbs.length];
    next.focus();
    show(next);
  });

  loadGalleryPlaces().then((places) => {
    if (!places.length) return;
    thumbs = places.map((p) => {
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'gallery-thumb';
      thumb.setAttribute('role', 'tab');
      Object.assign(thumb.dataset, {
        place: p.name,
        eyebrow: galleryEyebrow(p),
        note: p.description || '',
        photo: p.image.url,
        alt: p.image.alt || p.name,
        w: p.image.width || '',
        h: p.image.height || '',
        scale: p.size,
        lat: p.lat,
        lng: p.lng,
        z: p.zoom,
      });
      const img = document.createElement('img');
      img.src = p.image.url;
      img.alt = '';
      img.loading = 'lazy';
      thumb.appendChild(img);
      return thumb;
    });
    strip.replaceChildren(...thumbs);
    show(thumbs[0]);
  });
}

async function loadGalleryPlaces() {
  try {
    const res = await fetch(`${_CONFIG_API_BASE}/api/places`, { credentials: 'omit' });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data.places) ? data.places : []).filter((p) =>
      p && p.name && p.image && p.image.url && Number.isFinite(p.lat) && Number.isFinite(p.lng)
    );
  } catch (err) {
    console.error('[Polyplaces] Failed to load gallery places:', err);
    return [];
  }
}

function initNavUI() {
  const toggle = document.getElementById('nav-toggle');
  const drawer = document.getElementById('nav-drawer');
  const overlay = document.getElementById('nav-overlay');
  const drawerClose = document.getElementById('nav-drawer-close');
  if (!toggle || !drawer || !overlay) return;

  const closeNav = () => {
    document.body.classList.remove('nav-open');
    toggle.setAttribute('aria-label', 'Open menu');
    toggle.setAttribute('aria-expanded', 'false');
    drawer.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('aria-hidden', 'true');
    navFocusCleanup?.();
    navFocusCleanup = null;
    toggle.focus();
  };

  const openNav = () => {
    document.body.classList.add('nav-open');
    toggle.setAttribute('aria-label', 'Close menu');
    toggle.setAttribute('aria-expanded', 'true');
    drawer.setAttribute('aria-hidden', 'false');
    overlay.setAttribute('aria-hidden', 'false');
    navFocusCleanup?.();
    navFocusCleanup = createFocusTrap(drawer, closeNav);
    const first = drawer.querySelector('a,button');
    if (first instanceof HTMLElement) first.focus();
    else if (drawer instanceof HTMLElement) drawer.focus();
  };

  toggle.onclick = () => {
    const isOpen = document.body.classList.contains('nav-open');
    if (isOpen) {
      closeNav();
    } else {
      openNav();
    }
  };

  overlay.onclick = closeNav;
  if (drawerClose) drawerClose.onclick = closeNav;
  drawer.addEventListener('click', (e) => {
    if (e.target.closest('a,button')) closeNav();
  });

  // Swipe left on the drawer to close it (mobile).
  let _navSwipeStartX = 0;
  drawer.addEventListener('touchstart', (e) => {
    _navSwipeStartX = e.changedTouches[0].clientX;
  }, { passive: true });
  drawer.addEventListener('touchend', (e) => {
    const dx = _navSwipeStartX - e.changedTouches[0].clientX;
    if (dx > 48) closeNav();
  }, { passive: true });
}

// On mobile, temporarily un-stick the order CTA while an input is focused
// so the virtual keyboard doesn't obscure the Add to cart button.
function initMobileInputFix() {
  const orderCta = document.querySelector('.order-cta');
  if (!orderCta) return;
  const inputs = document.querySelectorAll('.config-right input, .config-right textarea');
  inputs.forEach((input) => {
    input.addEventListener('focus', () => {
      orderCta.style.position = 'relative';
      orderCta.style.bottom = 'auto';
      orderCta.style.boxShadow = 'none';
    });
    input.addEventListener('blur', () => {
      orderCta.style.position = '';
      orderCta.style.bottom = '';
      orderCta.style.boxShadow = '';
    });
  });
}

// ── Custom size ────────────────────────────────────────────────────────────────

// Price for the current custom dimensions as returned by the API (pence).
// null means no price has been fetched yet or the fetch is in flight.
let customSizeUnitAmount = null;
let customSizePriceDebounceTimer = null;

function buildCustomProduct(widthMm, heightMm, unitAmountPence) {
  return {
    id: 'custom',
    name: 'Custom',
    displaySize: `${widthMm}\u00D7${heightMm}mm`,
    sizeCode: widthMm * CUSTOM_MAP_SCALE,
    aspectRatio: heightMm / widthMm,
    unitAmount: unitAmountPence,
    priceId: 'custom',
    customWidthMm: widthMm,
    customHeightMm: heightMm,
  };
}

function activateCustomSize() {
  const panel = document.getElementById('custom-size-panel');
  if (panel) panel.hidden = false;
  document.querySelectorAll('.size-opt').forEach((b) => b.classList.remove('active'));
  const customBtn = document.querySelector('.size-opt[data-product-id="custom"]');
  if (customBtn) customBtn.classList.add('active');
  updateCustomSizeSelection();
}

async function fetchCustomSizePrice(widthMm, heightMm) {
  const res = await fetch(
    `${apiBase}/api/custom-size-price?widthMm=${encodeURIComponent(widthMm)}&heightMm=${encodeURIComponent(heightMm)}`
  );
  if (!res.ok) throw new Error(`Pricing unavailable (${res.status})`);
  const data = await res.json();
  if (typeof data?.unitAmount !== 'number') throw new Error('Invalid pricing response');
  return data.unitAmount; // pence
}

function updateCustomSizeSelection() {
  const wInput = document.getElementById('custom-width');
  const hInput = document.getElementById('custom-height');
  if (!wInput || !hInput) return;

  const rawW = Number(wInput.value);
  const rawH = Number(hInput.value);
  if (!Number.isFinite(rawW) || rawW <= 0 || !Number.isFinite(rawH) || rawH <= 0) return;

  const w = Math.round(Math.max(CUSTOM_SIZE_MIN_MM, Math.min(CUSTOM_SIZE_MAX_MM, rawW)));
  const h = Math.round(Math.max(CUSTOM_SIZE_MIN_MM, Math.min(CUSTOM_SIZE_MAX_MM, rawH)));

  // Show surcharge note based on dimensions (no API call needed for this).
  const surchargeEl = document.getElementById('custom-size-surcharge-note');
  if (surchargeEl) {
    surchargeEl.hidden = !(w > CUSTOM_SIZE_LARGE_THRESHOLD_MM || h > CUSTOM_SIZE_LARGE_THRESHOLD_MM);
  }

  // Show loading state while price is fetched from the server.
  customSizeUnitAmount = null;
  const priceLabelEl = document.querySelector('.size-opt[data-product-id="custom"] .size-opt-price');
  if (priceLabelEl) priceLabelEl.textContent = '…';

  clearTimeout(customSizePriceDebounceTimer);
  customSizePriceDebounceTimer = setTimeout(async () => {
    try {
      const unitAmountPence = await fetchCustomSizePrice(w, h);
      customSizeUnitAmount = unitAmountPence;
      if (priceLabelEl) priceLabelEl.textContent = formatPriceFromAmount(unitAmountPence);
      selectProduct(buildCustomProduct(w, h, unitAmountPence));
    } catch {
      if (priceLabelEl) priceLabelEl.textContent = '—';
      showBanner('Unable to fetch price for this size. Please try again.', 'fail');
    }
  }, 400);
}

function initCustomSizePanel() {
  const wInput = document.getElementById('custom-width');
  const hInput = document.getElementById('custom-height');
  if (!wInput || !hInput) return;
  const onChange = () => {
    if (selectedProduct?.id !== 'custom') return;
    updateCustomSizeSelection();
  };
  wInput.addEventListener('input', onChange);
  hInput.addEventListener('input', onChange);
  wInput.addEventListener('change', onChange);
  hInput.addEventListener('change', onChange);
}

// ── End custom size ────────────────────────────────────────────────────────────

// ── Frame controls (rotation + zoom sliders) ───────────────────────────────────

function initFrameControls() {
  const rotBtn = document.getElementById('rotation-btn');
  const zoomSlider = document.getElementById('zoom-slider');

  if (rotBtn) {
    rotBtn.addEventListener('click', () => {
      const isRotated = rotBtn.getAttribute('aria-pressed') === 'true';
      frameRotation = isRotated ? 0 : 90;
      rotBtn.setAttribute('aria-pressed', isRotated ? 'false' : 'true');
      selectionStat('rotations');
      if (frameCenter && selectedProduct) {
        resetReviewState();
        redrawFrame();
        updateLocationDisplay();
      }
    });
  }

  if (zoomSlider) {
    zoomSlider.addEventListener('input', () => {
      setFrameZoom(Number(zoomSlider.value));
      if (frameCenter && selectedProduct) {
        resetReviewState();
        redrawFrame();
        updateLocationDisplay();
      }
    });
    // One count per slider gesture, not per pixel of travel.
    zoomSlider.addEventListener('change', () => selectionStat('frame_zooms'));
  }

  const landscapeBtn = document.getElementById('landscape-toggle-btn');
  if (landscapeBtn) {
    landscapeBtn.addEventListener('click', () => {
      landscapeMode = !landscapeMode;
      selectionStat('landscape_toggles');
      // Each mode starts from its own default rather than a clamped leftover.
      frameZoom = zoomRange().initial;
      applyLandscapeUI();
      if (frameCenter && selectedProduct) {
        resetReviewState();
        redrawFrame();
        updateLocationDisplay();
        // Leaving landscape while pulled back past street level would clear
        // the frame on the next zoom, so bring the map in to it instead.
        if (map && map.getZoom() < frameMinMapZoom()) {
          map.setView([frameCenter.lat, frameCenter.lng], frameMinMapZoom());
        }
      }
    });
  }
}

// ── End frame controls ─────────────────────────────────────────────────────────


// Drawers are sized off --app-h. In-app browsers (Instagram, Facebook, TikTok)
// overlay a bottom toolbar that 100vh does not account for, which pushed the
// cart footer — and the checkout button — off screen. Browsers with dvh support
// override this via @supports; this covers the rest.
function initViewportHeight() {
  const vv = window.visualViewport;
  const apply = () => {
    const h = vv ? vv.height : window.innerHeight;
    if (h > 0) document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
  };
  apply();
  if (vv) {
    vv.addEventListener('resize', apply);
  } else {
    window.addEventListener('resize', apply);
  }
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
}

initViewportHeight();
initCartUI();
initNavUI();
showCheckoutBanner();
if (document.getElementById('landing')) {
  loadHomepagePrices();
  initGallery();
}

// Cookie consent — injected on every page so consent can be captured
// wherever the visitor lands (not just the homepage).
(function () {
  if (localStorage.getItem('pp_cn')) return;

  const overlay = document.createElement('div');
  overlay.className = 'cookie-consent-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Cookie consent');
  overlay.innerHTML =
    '<div class="cookie-consent-card">' +
      '<h3 class="cookie-consent-title">We value your privacy</h3>' +
      '<p class="cookie-consent-text">We use essential cookies to run this site and, with your consent, ' +
      'analytics cookies to understand how it&rsquo;s used so we can improve it. ' +
      'Read our <a href="/privacy/">privacy policy</a>.</p>' +
      '<div class="cookie-consent-actions">' +
        '<button type="button" class="cookie-consent-btn cookie-consent-reject" id="cookie-reject">Reject non-essential</button>' +
        '<button type="button" class="cookie-consent-btn cookie-consent-accept" id="cookie-accept">Accept all</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const dismiss = (val) => {
    localStorage.setItem('pp_cn', val);
    overlay.remove();
    document.body.style.overflow = '';
    // The newsletter popup waits on this so the two never stack, and
    // analytics.js loads GA4 and the Meta Pixel on it after an accept.
    document.dispatchEvent(new CustomEvent('pp:consent'));
  };
  document.getElementById('cookie-accept').onclick = () => dismiss('1');
  document.getElementById('cookie-reject').onclick = () => dismiss('0');
}());

// ── Newsletter popup ───────────────────────────────────────────────────────────
// Offers 10% off in exchange for an email. Held back until the cookie banner is
// out of the way, and suppressed for 7 days once it has been shown, whether
// the visitor dismissed it or ignored it - or for good once they subscribe.
(function () {
  // MOCK: no /api/newsletter endpoint exists yet. Set this to the path once the
  // backend is live and submit will POST for real instead of faking success.
  const NEWSLETTER_ENDPOINT = null; // e.g. '/api/newsletter'
  const STORE_KEY = 'pp_nl';
  const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const SCROLL_TRIGGER = 0.55; // fraction of the page scrolled

  // Not on the Etsy tool page - that is a bare utility, not a storefront.
  if (/^\/etsy\//.test(location.pathname)) return;

  const readState = () => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; }
    catch (e) { return null; }
  };
  const writeState = (state) => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ state, at: Date.now() })); }
    catch (e) { /* private mode - the popup simply reappears next visit */ }
  };

  // Any prior showing counts, dismissed or merely ignored - otherwise a
  // refresh or a click through to another page just restarts the timer.
  const saved = readState();
  if (saved && saved.state === 'subscribed') return;
  if (saved && Date.now() - saved.at < SNOOZE_MS) return;

  let shown = false;
  let overlay = null;
  let lastFocused = null;

  function close(reason) {
    if (!overlay) return;
    writeState(reason);
    overlay.remove();
    overlay = null;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKeydown);
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close('dismissed');
  }

  function open() {
    if (shown || document.body.classList.contains('cart-open')) return;
    shown = true;
    // Stamped on open, so ignoring the popup snoozes it just like dismissing.
    writeState('seen');
    lastFocused = document.activeElement;

    overlay = document.createElement('div');
    overlay.className = 'nl-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'nl-title');
    overlay.innerHTML =
      '<div class="nl-card">' +
        '<button type="button" class="nl-close" id="nl-close" aria-label="Close">&times;</button>' +
        '<div class="nl-media">' +
          '<img src="/assets/imgs/newsletter-studio.webp" width="1000" height="1242" decoding="async" ' +
          'alt="A Polyplaces sculpture being finished by hand at the studio bench">' +
        '</div>' +
        '<div class="nl-body">' +
          '<p class="nl-eyebrow">10% off your first piece</p>' +
          '<h2 class="nl-title" id="nl-title">Hold the places you love</h2>' +
          '<p class="nl-text">Leave your email and we&rsquo;ll send your discount code, plus the ' +
          'occasional note from the studio. No spam, unsubscribe any time.</p>' +
          '<form class="nl-form" id="nl-form" novalidate>' +
            '<label class="sr-only" for="nl-email">Email address</label>' +
            '<input type="email" id="nl-email" name="email" placeholder="you@example.com" autocomplete="email" required>' +
            '<input type="text" id="nl-company" name="company" tabindex="-1" autocomplete="off" aria-hidden="true" class="nl-hp">' +
            '<div class="turnstile-field" data-turnstile="newsletter"></div>' +
            '<button type="submit" class="nl-submit" id="nl-submit">Get my 10% off</button>' +
          '</form>' +
          '<p class="nl-status" id="nl-status" role="status"></p>' +
          '<button type="button" class="nl-decline" id="nl-decline">No thanks</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeydown);

    const RENDERED_AT = Date.now();
    const form   = overlay.querySelector('#nl-form');
    const email  = overlay.querySelector('#nl-email');
    const btn    = overlay.querySelector('#nl-submit');
    const status = overlay.querySelector('#nl-status');

    overlay.querySelector('#nl-close').onclick = () => close('dismissed');
    overlay.querySelector('#nl-decline').onclick = () => close('dismissed');
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close('dismissed'); });
    setTimeout(() => email.focus(), 60);

    // The modal is built on open, long after turnstile.js scanned the page.
    if (typeof window.ppTurnstileRender === 'function') {
      window.ppTurnstileRender(overlay.querySelector('[data-turnstile]'));
    }

    track('newsletter_shown');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        status.textContent = 'Please enter a valid email address.';
        status.className = 'nl-status nl-status-error';
        email.focus();
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Sending…';
      status.textContent = '';
      status.className = 'nl-status';

      const payload = {
        email: value,
        renderedAt: RENDERED_AT,
        company: overlay.querySelector('#nl-company').value.trim(),
        source: location.pathname,
        turnstileToken: (typeof window.ppTurnstileToken === 'function')
          ? window.ppTurnstileToken(form) : ''
      };

      const API_BASE = (
        (window.__POLYPLACES_ENV__ && window.__POLYPLACES_ENV__.POLYPLACES_API_BASE_URL) ||
        'https://api.polyplaces.co.uk'
      ).replace(/\/$/, '');

      const request = NEWSLETTER_ENDPOINT
        ? fetch(API_BASE + NEWSLETTER_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }).then((res) => { if (!res.ok) throw new Error('server'); })
        : new Promise((resolve) => setTimeout(resolve, 500)); // MOCK

      request.then(() => {
        track('newsletter_signup', { source: 'popup' }, { metaEvent: 'Lead', metaParams: { content_name: 'Newsletter' } });
        writeState('subscribed');
        overlay.querySelector('.nl-body').innerHTML =
          '<p class="nl-eyebrow">You&rsquo;re in</p>' +
          '<h2 class="nl-title">Check your inbox</h2>' +
          '<p class="nl-text">Your 10% discount code is on its way to <strong>' + escapeHtml(value) + '</strong>. ' +
          'It should land within a few minutes - have a look in spam if it doesn&rsquo;t.</p>' +
          '<button type="button" class="nl-submit" id="nl-done">Start browsing</button>';
        overlay.querySelector('#nl-done').onclick = () => close('subscribed');
        overlay.querySelector('#nl-done').focus();
      }).catch(() => {
        btn.disabled = false;
        btn.textContent = 'Get my 10% off';
        status.textContent = 'Something went wrong - please try again shortly.';
        status.className = 'nl-status nl-status-error';
        // Tokens are single-use, so a retry without this always fails.
        if (typeof window.ppTurnstileReset === 'function') window.ppTurnstileReset(form);
      });
    });
  }

  // Two intent-led triggers, no timer: the visitor has either read a good part
  // of the page, or is on their way out. Neither interrupts what they came for.
  function arm() {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (max > 0 && window.scrollY / max > SCROLL_TRIGGER) fire();
    };
    // Exit intent: pointer leaving through the top of the window, towards the
    // tabs or address bar. Desktop only - touch devices have no equivalent.
    const onExit = (e) => {
      if (e.clientY <= 0 && !window.matchMedia('(hover: none)').matches) fire();
    };
    const fire = () => {
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('mouseout', onExit);
      open();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('mouseout', onExit);
  }

  // Wait for the cookie banner to be answered so the two never stack.
  if (localStorage.getItem('pp_cn')) arm();
  else document.addEventListener('pp:consent', arm, { once: true });
}());

if (document.getElementById('storePage')) {
  initStore();
}

// ── Etsy tool page ─────────────────────────────────────────────────────────────
// Standalone variant of the store: fixed sizes, no pricing, no cart, no right bar.
// A single Copy button places the current frame's bounding box on the clipboard.
const ETSY_PRODUCTS = [
  { id: 'etsy-15x15', name: '15 × 15', displaySize: '15 × 15 cm', sizeCode: 150 * CUSTOM_MAP_SCALE, aspectRatio: 1 },
  { id: 'etsy-29x21', name: '29 × 21', displaySize: '29 × 21 cm', sizeCode: 290 * CUSTOM_MAP_SCALE, aspectRatio: 210 / 290 },
  { id: 'etsy-25x25', name: '25 × 25', displaySize: '25 × 25 cm', sizeCode: 250 * CUSTOM_MAP_SCALE, aspectRatio: 1 },
  { id: 'etsy-30x30', name: '30 × 30', displaySize: '30 × 30 cm', sizeCode: 300 * CUSTOM_MAP_SCALE, aspectRatio: 1 },
];

function initEtsy() {
  if (storeInited) return;
  storeInited = true;

  products = ETSY_PRODUCTS;
  renderSizeOptions();

  initMap();
  initFrameControls();
  initMobileInputFix();

  selectProduct(products[0]);

  const copyBtn = document.getElementById('etsy-copy');
  if (copyBtn) copyBtn.onclick = copyBoundingBox;
}

async function copyBoundingBox() {
  const btn = document.getElementById('etsy-copy');
  if (!bbox) return;
  // Standard bbox order: west,south,east,north (minLon,minLat,maxLon,maxLat).
  const text = [bbox.west, bbox.south, bbox.east, bbox.north]
    .map((n) => Number(n).toFixed(6))
    .join(',');

  const flash = (label, ok) => {
    if (!btn) return;
    const original = btn.dataset.label || btn.textContent;
    btn.dataset.label = original;
    btn.textContent = label;
    btn.classList.toggle('is-copied', ok);
    btn.classList.toggle('is-copyfail', !ok);
    setTimeout(() => {
      btn.textContent = btn.dataset.label;
      btn.classList.remove('is-copied', 'is-copyfail');
    }, 1600);
  };

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    flash('✓ Copied', true);
  } catch {
    flash('Copy failed', false);
  }
}

if (document.getElementById('etsyPage')) {
  initEtsy();
}

async function reviewSelection() {
  if (!selectedProduct || !bbox || !selectionMeta) return;
  const btn = document.getElementById('sel-run');
  btn.disabled = true;
  btn.textContent = 'Locating\u2026';
  try {
    const center = selectionMeta.center;
    const url = `${apiBase}/api/reverse-geocode?lat=${center.lat}&lon=${center.lng}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Reverse geocoding failed.');
    const data = await res.json();
    selectionMeta.locationText = data?.label || data?.display_name || 'Location unavailable';
  } catch {
    selectionMeta.locationText = 'Location unavailable';
  }
  addSelectionToCart();
  document.getElementById('order-status-msg').textContent = '\u2713 Added to cart.';
  btn.textContent = '\u2713 Added to cart';
  btn.disabled = false;
  openCart();
}

// ── 3D preview before add to cart ──────────────────────────────────────────────
// Add to cart first asks whether the visitor wants a 3D preview of the framed
// area. The preview bundle (three.js + compute worker) loads only on a yes.
// Matches the preview's own limits: landscape (terrain only) can go wider.
const PREVIEW_MAX_DEG = 0.1;
const PREVIEW_MAX_DEG_LANDSCAPE = 0.25;
const PREVIEW_STAGE_LABELS = {
  terrain: 'Shaping the terrain',
  buildings: 'Raising the buildings',
  water: 'Finding the water',
  footprints: 'Placing the buildings',
  mesh: 'Carving the model',
};

function previewModuleUrl() {
  const meta = document.querySelector('meta[name="preview-module"]');
  return meta?.content || '/assets/js/preview/preview.js';
}

// The physical size of the piece, unframed, as [width, height] in mm, from
// the product's display size ("20cm x 20cm", "A4") or custom dimensions.
function previewPieceMm(product) {
  if (product?.id === 'custom') return [Number(product.customWidthMm) || 200, Number(product.customHeightMm) || 200];
  const text = String(product?.displaySize || '');
  const cm = /(\d+(?:\.\d+)?)\s*cm\s*[x\u00d7]\s*(\d+(?:\.\d+)?)\s*cm/i.exec(text);
  if (cm) return [Number(cm[1]) * 10, Number(cm[2]) * 10];
  if (/\bA4\b/i.test(text)) return [210, 297];
  const ratio = Number(product?.aspectRatio) || 1;
  return [200, 200 * ratio];
}

// The store's frame choices for the selected product, keyed by colour
// ('oak', 'black', 'white') for the room mock-up.
function previewFrameChoices(product) {
  if (!product || product.id === 'custom') return [];
  return (frameOptions[product.frameKey] || []).map((f) => ({ ...f, colour: f.colourName.toLowerCase() }));
}

// Mirrors a frame choice made in the preview onto the store's own radios, so
// the order summary, price and cart all follow it.
function selectStoreFrame(product, priceId) {
  const radio = Array.from(document.querySelectorAll('.frame-colour-radio'))
    .find((r) => r.name === `frame-colour-${product.id}` && r.value === (priceId || ''));
  if (radio && !radio.checked) {
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
  } else if (!radio) {
    handleFrameChange(product, priceId || null, !!priceId);
  }
}

function offerPreview() {
  if (!selectedProduct || !bbox || !selectionMeta) return;
  const b = selectionMeta.bbox;
  const box = [b.south, b.west, b.north, b.east];
  // Frames past what the browser preview can build go straight to the cart.
  const maxDeg = selectionMeta.landscape ? PREVIEW_MAX_DEG_LANDSCAPE : PREVIEW_MAX_DEG;
  if (box[2] - box[0] > maxDeg || box[3] - box[1] > maxDeg) {
    track('preview_unavailable', { reason: 'too_large', landscape: !!selectionMeta.landscape });
    reviewSelection();
    return;
  }
  openPreviewDialog(box, !!selectionMeta.landscape);
}

function openPreviewDialog(box, landscape) {
  const lastFocused = document.activeElement;
  let preview = null;
  let releaseTrap = null;
  // Engagement for the preview_close event: time spent looking at the 3D
  // model (from when it is ready), and what the visitor did with it.
  const pv = { shown: false, ready: false, timer: null, startedAt: 0, views: 0, frames: 0 };
  track('preview_offered', { landscape: !!landscape });

  const overlay = document.createElement('div');
  overlay.className = 'pv-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'pv-title');
  overlay.innerHTML =
    '<div class="pv-card" tabindex="-1">' +
      '<button type="button" class="nl-close pv-close" aria-label="Close">&times;</button>' +
      '<div class="pv-ask">' +
        '<p class="nl-eyebrow">Before it goes in your cart</p>' +
        '<h2 class="nl-title" id="pv-title">See your sculpture in 3D?</h2>' +
        '<p class="nl-text">We can build a quick 3D preview of the area you framed - the terrain, ' +
        (landscape ? '' : 'buildings ') + 'and water in the same proportions as the finished piece. ' +
        'It usually takes 10-30 seconds.</p>' +
        '<div class="pv-actions">' +
          '<button type="button" class="nl-submit" data-pv="show">Show me a preview</button>' +
          '<button type="button" class="nl-decline" data-pv="skip">No thanks, add to cart</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  const card = overlay.querySelector('.pv-card');

  // outcome: 'add' | 'back' | 'dismiss' (×, Escape or backdrop).
  function close(outcome = 'dismiss') {
    if (!overlay.isConnected) return;
    if (!pv.shown) {
      track('preview_declined', { outcome: outcome === 'add' ? 'add_without_preview' : 'dismiss' });
    } else {
      track('preview_close', {
        outcome,
        loaded: pv.ready,
        engaged_ms: pv.timer ? pv.timer.stop() : 0,
        wait_ms: pv.ready ? undefined : Math.round(performance.now() - pv.startedAt),
        view: preview?.view,
        view_changes: pv.views,
        frame_changes: pv.frames,
        frame: (previewFrameChoices(selectedProduct).find((f) => f.priceId === selectedFrame) || {}).colourName || 'none',
      });
    }
    preview?.dispose();
    releaseTrap?.();
    overlay.remove();
    document.body.style.overflow = '';
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  function addToCart() {
    close('add');
    reviewSelection();
  }

  releaseTrap = createFocusTrap(card, () => close());
  overlay.querySelector('.pv-close').onclick = () => close();
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-pv="skip"]').onclick = addToCart;
  overlay.querySelector('[data-pv="show"]').onclick = () => showPreview();
  setTimeout(() => overlay.querySelector('[data-pv="show"]')?.focus(), 60);

  function showPreview() {
    card.classList.add('pv-card-wide');
    card.querySelector('.pv-ask').outerHTML =
      '<div class="pv-head">' +
        '<h2 class="nl-title" id="pv-title">Your sculpture in 3D</h2>' +
        '<p class="pv-sub">Drag to look around, scroll or pinch to zoom. A guide to shape and scale - you&rsquo;ll still approve a proof before we make anything.</p>' +
      '</div>' +
      '<div class="pv-stage">' +
        '<div class="pv-canvas" id="pv-canvas"></div>' +
        '<div class="pv-views" id="pv-views" role="group" aria-label="Preview view" hidden>' +
          '<button type="button" class="pv-view" data-view="room" aria-pressed="true">In a room</button>' +
          '<button type="button" class="pv-view" data-view="model" aria-pressed="false">Close-up</button>' +
        '</div>' +
        '<div class="pv-loading" id="pv-loading" role="status" aria-live="polite">' +
          '<span class="pv-loading-label" id="pv-loading-label">Gathering map data</span>' +
          '<span class="pv-bar" aria-hidden="true"><span class="pv-bar-fill" id="pv-bar-fill"></span></span>' +
        '</div>' +
      '</div>' +
      '<div class="pv-frames" id="pv-frames" role="group" aria-labelledby="pv-frames-title" hidden></div>' +
      '<p class="pv-credit" id="pv-credit">Map data &copy; Overture Maps Foundation, &copy; OpenStreetMap contributors (ODbL). ' +
        'Elevation &copy; Mapterhorn; UK LiDAR from the Environment Agency (Open Government Licence).</p>' +
      '<div class="pv-actions pv-actions-row">' +
        '<button type="button" class="nl-decline" data-pv="back">Back to the map</button>' +
        '<button type="button" class="nl-submit" data-pv="add">Add to cart &rarr;</button>' +
      '</div>';
    card.querySelector('[data-pv="back"]').onclick = () => close('back');
    card.querySelector('[data-pv="add"]').onclick = addToCart;
    card.focus();

    const loading = card.querySelector('#pv-loading');
    const label = card.querySelector('#pv-loading-label');
    const fill = card.querySelector('#pv-bar-fill');
    const showError = (text) => {
      loading.classList.add('pv-loading-error');
      label.textContent = text;
    };

    pv.shown = true;
    pv.startedAt = performance.now();
    if (selectionStats) selectionStats.previewed = true;
    track('preview_open', { landscape: !!landscape });

    const product = selectedProduct;
    const choices = previewFrameChoices(product);
    const chosen = choices.find((f) => f.priceId === selectedFrame) || null;
    const addBtn = card.querySelector('[data-pv="add"]');
    const showPrice = () => {
      const amount = getEffectiveUnitAmount(product, selectedFrame);
      addBtn.innerHTML = amount != null ? `Add to cart &middot; ${formatPriceFromAmount(amount)} &rarr;` : 'Add to cart &rarr;';
    };
    showPrice();

    // Frame picker under the stage. With no frame chosen it leads as an
    // upsell; picking one hangs it in the room and selects it on the store.
    function buildFramePicker() {
      const bar = card.querySelector('#pv-frames');
      if (!choices.length) return;
      const startedBare = !chosen;
      bar.innerHTML =
        '<div class="pv-frames-copy">' +
          `<p class="pv-frames-title" id="pv-frames-title">${startedBare ? 'Finish it with a frame' : 'Frame'}</p>` +
          (startedBare ? '<p class="pv-frames-note">A box frame with mount, ready to hang. Try one on the wall.</p>' : '') +
        '</div>' +
        '<div class="pv-frames-options">' +
          '<button type="button" class="pv-frame" data-colour="" aria-pressed="false">' +
            '<span class="pv-frame-swatch pv-frame-swatch--none" aria-hidden="true"></span>No frame</button>' +
          choices.map((f) => {
            const hex = /^#[0-9a-fA-F]{3,8}$/.test(f.colourHex) ? f.colourHex : '#cccccc';
            return `<button type="button" class="pv-frame" data-colour="${escapeHtml(f.colour)}" aria-pressed="false">` +
              `<span class="pv-frame-swatch" style="background:${hex}" aria-hidden="true"></span>${escapeHtml(f.colourName)}` +
              `<span class="pv-frame-price">+${formatPriceFromAmount(f.unitAmount)}</span></button>`;
          }).join('') +
        '</div>';
      bar.classList.toggle('pv-frames--upsell', startedBare);
      bar.hidden = false;

      const buttons = Array.from(bar.querySelectorAll('.pv-frame'));
      const mark = (colour) => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.colour === (colour || ''))));
      mark(chosen?.colour);
      buttons.forEach((btn) => {
        btn.onclick = async () => {
          const colour = btn.dataset.colour || null;
          const frame = choices.find((f) => f.colour === colour) || null;
          mark(colour);
          selectStoreFrame(product, frame?.priceId || null);
          showPrice();
          pv.frames += 1;
          if (frame && startedBare) track('preview_frame_upsell', { colour: frame.colourName });
          bar.classList.add('pv-frames--busy');
          await preview?.setFrame(colour);
          bar.classList.remove('pv-frames--busy');
          // A frame picked in the close-up carries the view into the room.
          card.querySelectorAll('#pv-views [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === preview?.view)));
        };
      });
    }

    import(previewModuleUrl()).then((mod) => {
      if (!overlay.isConnected) return;
      preview = mod.createPreview(card.querySelector('#pv-canvas'), {
        bbox: box,
        config: { includeBuildings: !landscape },
        room: {
          size: choices.length ? product.frameKey : null,
          colour: chosen?.colour || null,
          bareMm: previewPieceMm(product),
          // Only the A4 frame rotates on the map, between 0 and 90 degrees.
          rotated: (selectionMeta?.rotation || 0) % 180 === 90,
        },
        onProgress(stage, value, overall) {
          if (PREVIEW_STAGE_LABELS[stage]) label.textContent = PREVIEW_STAGE_LABELS[stage];
          fill.style.width = `${Math.round(overall * 100)}%`;
        },
        onReady(info) {
          loading.hidden = true;
          pv.ready = true;
          pv.timer = engagedTimer();
          track('preview_ready', {
            load_ms: Math.round(performance.now() - pv.startedAt),
            has_room: !!info?.views?.includes('room'),
            landscape: !!landscape,
          });
          // The view switch and frame picker only matter with the room.
          const views = card.querySelector('#pv-views');
          if (!info?.views?.includes('room')) return;
          buildFramePicker();
          views.hidden = false;
          views.querySelectorAll('[data-view]').forEach((btn) => {
            btn.onclick = () => {
              if (btn.dataset.view !== preview.view) {
                pv.views += 1;
                track('preview_view_change', { view: btn.dataset.view });
              }
              preview.setView(btn.dataset.view);
              views.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
            };
          });
        },
        onError(code) {
          const messages = {
            bad_bbox: 'This area is too large to preview.',
            too_many_tiles: 'This area is too large to preview.',
            no_webgl: 'Your browser can’t show 3D previews.',
            timeout: 'The preview is taking too long - please try again later.',
            oom: 'This area is too detailed to preview on this device.',
          };
          track('preview_error', { code: String(code), wait_ms: Math.round(performance.now() - pv.startedAt) });
          showError(messages[code] || 'The preview couldn’t be built just now.');
        },
      });
    }).catch(() => {
      track('preview_error', { code: 'module_load', wait_ms: Math.round(performance.now() - pv.startedAt) });
      if (overlay.isConnected) showError('The preview couldn’t be loaded just now.');
    });
  }
}

function resetReviewState() {
  const btn = document.getElementById('sel-run');
  if (btn) btn.textContent = 'Add to cart \u2192';
  const statusEl = document.getElementById('order-status-msg');
  if (statusEl) statusEl.textContent = 'Frame placed. Drag to adjust, then add to cart.';
}


window.showStore = showStore;
window.showLanding = showLanding;
