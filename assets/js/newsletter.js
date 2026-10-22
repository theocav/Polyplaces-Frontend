(function () {
  var form   = document.getElementById('newsletter-form');
  var status = document.getElementById('form-status');
  var btn    = document.getElementById('submit-btn');

  if (!form) return;

  // Stamped when the form is drawn. The backend rejects submissions that come
  // back implausibly fast - a human cannot fill this in under three seconds.
  var RENDERED_AT = Date.now();

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var email   = document.getElementById('email').value.trim();
    var company = document.getElementById('company') ? document.getElementById('company').value.trim() : '';

    if (!email) {
      showStatus('error', 'Please enter your email address.');
      return;
    }

    var emailInput = document.getElementById('email');
    if (!emailInput.checkValidity() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showStatus('error', 'Please enter a valid email address.');
      emailInput.focus();
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Sending…';
    hideStatus();

    var API_BASE = (
      (window.__POLYPLACES_ENV__ && window.__POLYPLACES_ENV__.POLYPLACES_API_BASE_URL) ||
      (document.querySelector('meta[name="api-base"]') && document.querySelector('meta[name="api-base"]').getAttribute('content')) ||
      'https://api.polyplaces.co.uk'
    ).replace(/\/$/, '');

    fetch(API_BASE + '/api/newsletter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        renderedAt: RENDERED_AT,
        company: company,
        source: location.pathname,
        turnstileToken: (typeof window.ppTurnstileToken === 'function')
          ? window.ppTurnstileToken(form) : ''
      })
    })
    .then(function (res) {
      return res.json()
        .catch(function () { return {}; })
        .then(function (data) {
          if (res.ok) return data;
          if (res.status === 429) throw new Error('rate');
          // 400s from the API are written to be shown to the user verbatim.
          throw new Error(res.status === 400 && data.error ? data.error : 'server');
        });
    })
    .then(function () {
      if (typeof fbq === 'function') fbq('track', 'Lead', { content_name: 'Newsletter signup' });
      if (typeof window.ppTrackGA === 'function') window.ppTrackGA('newsletter_signup');
      showStatus('success', 'Check your inbox for your 10% discount code. It should arrive within a few minutes.');
      form.reset();
      if (typeof window.ppTurnstileReset === 'function') window.ppTurnstileReset(form);
    })
    .catch(function (err) {
      var msg = err && err.message;
      if (msg === 'rate') {
        showStatus('error', 'Too many signup attempts - please try again in a few minutes.');
      } else if (msg && msg !== 'server') {
        showStatus('error', msg);
      } else {
        showStatus('error', 'Something went wrong. Please try again or email us directly at info@polyplaces.co.uk.');
      }
      if (typeof window.ppTurnstileReset === 'function') window.ppTurnstileReset(form);
    })
    .finally(function () {
      btn.disabled = false;
      btn.textContent = 'Sign me up →';
    });
  });

  function showStatus(type, msg) {
    status.className = 'form-status ' + type + ' show';
    status.textContent = msg;
  }
  function hideStatus() {
    status.className = 'form-status';
    status.textContent = '';
  }
}());
