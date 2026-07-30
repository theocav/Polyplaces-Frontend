(function () {
  var form   = document.getElementById('contact-form');
  var status = document.getElementById('form-status');
  var btn    = document.getElementById('submit-btn');

  if (!form) return;

  // Stamped when the form is drawn. The backend rejects submissions that come
  // back implausibly fast — a human cannot fill this in under three seconds.
  var RENDERED_AT = Date.now();

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var name    = document.getElementById('name').value.trim();
    var email   = document.getElementById('email').value.trim();
    var subject = document.getElementById('subject').value;
    var message = document.getElementById('message').value.trim();
    var company = document.getElementById('company') ? document.getElementById('company').value.trim() : '';

    if (!name || !email || !message) {
      showStatus('error', 'Please fill in all required fields.');
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

    fetch(API_BASE + '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        email: email,
        subject: subject,
        message: message,
        renderedAt: RENDERED_AT,
        company: company,
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
      if (typeof fbq === 'function') fbq('track', 'Lead', { content_name: 'Contact form' });
      if (typeof window.ppTrackGA === 'function') window.ppTrackGA('contact_submitted', { subject: subject });
      showStatus('success', 'Message sent — we’ll be in touch within 1–2 business days.');
      form.reset();
      if (typeof window.ppTurnstileReset === 'function') window.ppTurnstileReset(form);
    })
    .catch(function (err) {
      var msg = err && err.message;
      if (msg === 'rate') {
        showStatus('error', 'Too many messages sent — please try again shortly.');
      } else if (msg && msg !== 'server') {
        showStatus('error', msg);
      } else {
        showStatus('error', 'Something went wrong. Please try again or email us directly at contact@polyplaces.co.uk.');
      }
      if (typeof window.ppTurnstileReset === 'function') window.ppTurnstileReset(form);
    })
    .finally(function () {
      btn.disabled = false;
      btn.textContent = 'Send message →';
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
