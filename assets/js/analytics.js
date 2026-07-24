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

// GA4 sets cookies, so load only after explicit accept.
if (localStorage.getItem('pp_cn') === '1') {
  window.ppLoadGA();
}
