/**
 * Cloudflare Turnstile bootstrap, shared by /contact/ and /reviews/.
 *
 * Renders explicitly rather than via auto-render so the site key can come from
 * env.js at runtime instead of being baked into every HTML file.
 *
 * Markup contract — one element per form:
 *   <div class="turnstile-field" data-turnstile></div>
 *
 * API:
 *   window.ppTurnstileToken(formEl)  -> string ('' when unrendered or expired)
 *   window.ppTurnstileReset(formEl)  -> void, call after a submit
 *   window.ppTurnstileReady          -> bool, false until the widget renders
 */
(function () {
  var SITE_KEY = (
    (window.__POLYPLACES_ENV__ && window.__POLYPLACES_ENV__.POLYPLACES_TURNSTILE_SITE_KEY) || ''
  ).trim();

  // Maps a container element to its Turnstile widget id.
  var widgets = [];

  window.ppTurnstileReady = false;

  function containers() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-turnstile]'));
  }

  function findWidget(formEl) {
    for (var i = 0; i < widgets.length; i++) {
      if (!formEl || formEl.contains(widgets[i].el)) return widgets[i];
    }
    return null;
  }

  window.ppTurnstileToken = function (formEl) {
    var w = findWidget(formEl);
    if (!w || !window.turnstile) return '';
    try {
      return window.turnstile.getResponse(w.id) || '';
    } catch (e) {
      return '';
    }
  };

  window.ppTurnstileReset = function (formEl) {
    var w = findWidget(formEl);
    if (!w || !window.turnstile) return;
    try {
      window.turnstile.reset(w.id);
    } catch (e) {
      /* widget already gone; nothing to reset */
    }
  };

  function renderAll() {
    if (!window.turnstile) return;
    containers().forEach(function (el) {
      if (el.getAttribute('data-turnstile-rendered') === '1') return;
      var id = window.turnstile.render(el, {
        sitekey: SITE_KEY,
        theme: 'light',
        action: el.getAttribute('data-turnstile') || 'submit'
      });
      el.setAttribute('data-turnstile-rendered', '1');
      widgets.push({ el: el, id: id });
    });
    window.ppTurnstileReady = widgets.length > 0;
  }

  function init() {
    if (!containers().length) return;

    if (!SITE_KEY) {
      // No key configured. Leave the slot empty and let the form submit with an
      // empty token — the backend decides whether that is fatal. Failing loudly
      // in the console beats a silently unprotected form nobody notices.
      console.warn('[turnstile] POLYPLACES_TURNSTILE_SITE_KEY is not set — widget not rendered.');
      return;
    }

    // api.js is loaded async, so it may land before or after this file.
    if (window.turnstile) {
      renderAll();
    } else {
      var tries = 0;
      var poll = setInterval(function () {
        if (window.turnstile) {
          clearInterval(poll);
          renderAll();
        } else if (++tries > 100) { // ~10s
          clearInterval(poll);
          console.warn('[turnstile] api.js did not load.');
        }
      }, 100);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
