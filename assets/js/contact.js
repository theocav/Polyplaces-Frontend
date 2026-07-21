(function () {
  var form   = document.getElementById('contact-form');
  var status = document.getElementById('form-status');
  var btn    = document.getElementById('submit-btn');

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var name    = document.getElementById('name').value.trim();
    var email   = document.getElementById('email').value.trim();
    var subject = document.getElementById('subject').value;
    var message = document.getElementById('message').value.trim();

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

    fetch(API_BASE + '/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, subject: subject, message: message })
    })
    .then(function (res) {
      if (!res.ok) throw new Error('server');
      if (typeof fbq === 'function') fbq('track', 'Lead', { content_name: 'Contact form' });
      showStatus('success', 'Message sent — we'll be in touch within 1–2 business days.');
      form.reset();
    })
    .catch(function () {
      showStatus('error', 'Something went wrong. Please try again or email us directly at contact@polyplaces.co.uk.');
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
