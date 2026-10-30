// Analytics - GA4 and the Meta Pixel, both loaded only after the visitor
// accepts the cookie banner (pp_cn = '1'). Every page event goes through
// ppTrack so the two stay in step and share one event_id, which Meta uses to
// merge browser events with the server-side Conversions API events sent from
// the Stripe webhook (see tracking-webhook-spec.md).
(function () {
  var GA_ID = 'G-XEPWHQVWZY';
  var META_PIXEL_ID = '1684282595954858';

  // GA4 event name -> Meta standard event. Anything not listed stays GA-only,
  // so Meta gets the funnel and GA gets the fine-grained behaviour.
  var META_EVENTS = {
    view_item: 'ViewContent',
    add_to_cart: 'AddToCart',
    begin_checkout: 'InitiateCheckout',
    purchase: 'Purchase',
    generate_lead: 'Lead',
    map_search: 'Search',
    review_submitted: 'SubmitApplication',
  };

  function consented() {
    try { return localStorage.getItem('pp_cn') === '1'; } catch (_) { return false; }
  }

  function consentDecided() {
    try { return !!localStorage.getItem('pp_cn'); } catch (_) { return false; }
  }

  window.ppLoadGA = function () {
    if (window.__ppGaLoaded) return;
    window.__ppGaLoaded = true;
    var g = document.createElement('script');
    g.async = true;
    g.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(g);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    // Loaded only after Accept all, so every consent type is granted.
    gtag('consent', 'default', {
      analytics_storage: 'granted',
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
    });
    gtag('js', new Date());
    gtag('config', GA_ID);
  };

  // Meta's standard base code, moved here from each page's <head> so it can
  // wait for consent.
  window.ppLoadMeta = function () {
    if (window.fbq) return;
    /* eslint-disable */
    !function(f,b,e,v,n,t,s)
    {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    fbq('init', META_PIXEL_ID);
    fbq('track', 'PageView');
  };

  function eventId(name) {
    var rand = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
    return name + '_' + rand;
  }

  function send(name, params, opts) {
    if (typeof window.gtag === 'function') {
      var gaParams = {};
      for (var k in params) if (params[k] !== undefined && params[k] !== null) gaParams[k] = params[k];
      gaParams.event_id = opts.eventId;
      window.gtag('event', name, gaParams);
    }
    if (typeof window.fbq === 'function') {
      var metaName = opts.metaEvent || META_EVENTS[name];
      if (metaName) window.fbq('track', metaName, opts.metaParams || {}, { eventID: opts.eventId });
    }
  }

  // Events fired before the visitor answers the banner wait here; Accept
  // sends them, Reject drops them.
  var queue = [];

  // ppTrack(name, params, opts)
  //   params: GA4 event parameters (undefined/null values are dropped)
  //   opts.metaParams: Meta custom_data, for events mapped in META_EVENTS
  //   opts.metaEvent:  override the Meta event name
  //   opts.eventId:    fixed id for dedup (e.g. 'purchase_' + Stripe session)
  // Returns the event_id.
  window.ppTrack = function (name, params, opts) {
    opts = opts || {};
    opts.eventId = opts.eventId || eventId(name);
    params = params || {};
    if (consented()) send(name, params, opts);
    else if (!consentDecided()) queue.push([name, params, opts]);
    return opts.eventId;
  };

  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function gaGet(field) {
    return new Promise(function (resolve) {
      if (typeof window.gtag !== 'function') return resolve(null);
      var done = false;
      setTimeout(function () { if (!done) { done = true; resolve(null); } }, 400);
      window.gtag('get', GA_ID, field, function (v) {
        if (!done) { done = true; resolve(v == null ? null : String(v)); }
      });
    });
  }

  // fbclid from an ad click, kept for the visit so ppAttribution can build
  // _fbc if fbevents.js hasn't set it yet.
  try {
    var fbclid = new URLSearchParams(location.search).get('fbclid');
    if (fbclid) sessionStorage.setItem('pp_fbclid', fbclid);
  } catch (_) {}

  // IDs the API stores on the Stripe session so the webhook can report the
  // purchase to GA4 and Meta against this visitor. Null without consent.
  window.ppAttribution = function () {
    if (!consented()) return Promise.resolve(null);
    return Promise.all([gaGet('client_id'), gaGet('session_id')]).then(function (ga) {
      var fbc = cookie('_fbc');
      if (!fbc) {
        try {
          var id = sessionStorage.getItem('pp_fbclid');
          if (id) fbc = 'fb.1.' + Date.now() + '.' + id;
        } catch (_) {}
      }
      return { gaClientId: ga[0], gaSessionId: ga[1], fbp: cookie('_fbp'), fbc: fbc };
    });
  };

  function start() {
    window.ppLoadGA();
    window.ppLoadMeta();
    var pending = queue;
    queue = [];
    pending.forEach(function (e) { send(e[0], e[1], e[2]); });
  }

  // The banner in app.js sets pp_cn, then fires pp:consent.
  document.addEventListener('pp:consent', function () {
    if (consented()) start();
    else queue = [];
  });

  if (consented()) start();

  // app.js loads first and parks early events (the purchase on the Stripe
  // return) in __ppPending until ppTrack exists.
  var early = window.__ppPending || [];
  window.__ppPending = [];
  early.forEach(function (e) { window.ppTrack(e[0], e[1], e[2]); });
}());
