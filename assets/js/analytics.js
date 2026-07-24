// GA4 loader — shared by page load and the consent Accept button.
window.ppLoadGA = function () {
  if (window.__ppGaLoaded) return;
  window.__ppGaLoaded = true;
  var GA_ID = 'G-XEPWHQVWZY';
  var g = document.createElement('script');
  g.async = true;
  g.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(g);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { dataLayer.push(arguments); };
  gtag('js', new Date());
  gtag('config', GA_ID);
};

// Fire a GA4 event only once analytics is loaded; no-op before consent.
window.ppTrackGA = function (name, params) {
  if (typeof window.gtag !== 'function') return;
  window.gtag('event', name, params || {});
};

// GA4 sets cookies, so load only after explicit accept.
if (localStorage.getItem('pp_cn') === '1') {
  window.ppLoadGA();
}
