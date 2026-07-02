(function () {
  if (localStorage.getItem('pp_cn') === '0') return;
  var s = document.createElement('script');
  s.defer = true;
  s.dataset.domain = 'polyplaces.co.uk';
  s.src = 'https://plausible.io/js/script.js';
  document.head.appendChild(s);
}());
