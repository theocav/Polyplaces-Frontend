/**
 * Reviews — homepage strip and the /reviews/ page.
 *
 * Loaded on both. Whichever elements are present decide what runs:
 *   #home-reviews-grid  -> replace the hardcoded fallback cards with live ones
 *   #reviews-list       -> full paginated list + submission form
 *
 * Everything from the API is untrusted user input. It is written with
 * textContent only — never innerHTML — because a public review form is the one
 * place an XSS can enter this site.
 */
(function () {
  var homeGrid = document.getElementById('home-reviews-grid');
  var listEl   = document.getElementById('reviews-list');
  if (!homeGrid && !listEl) return;

  var PAGE_SIZE = 12;
  var RENDERED_AT = Date.now();

  var API_BASE = (
    (window.__POLYPLACES_ENV__ && window.__POLYPLACES_ENV__.POLYPLACES_API_BASE_URL) ||
    (document.querySelector('meta[name="api-base"]') && document.querySelector('meta[name="api-base"]').getAttribute('content')) ||
    'https://api.polyplaces.co.uk'
  ).replace(/\/$/, '');

  /* ---------- helpers ---------- */

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function starString(rating) {
    var r = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
    return new Array(r + 1).join('★') + new Array(6 - r).join('☆');
  }

  // "Tom H." + "London, UK" -> a .reviewer node reading "Tom H. · London, UK"
  function reviewerNode(review) {
    var wrap = el('div', 'reviewer', review.name || 'Anonymous');
    if (review.location) {
      var loc = el('span', null, ' · ' + review.location);
      wrap.appendChild(loc);
    }
    return wrap;
  }

  function reviewCard(review, extraClass) {
    var card = el('div', 'review-card' + (extraClass ? ' ' + extraClass : ''));
    card.appendChild(el('div', 'stars', starString(review.rating)));

    var text = review.body || '';
    if (review.title) text = '“' + review.title + '” — ' + text;
    else text = '"' + text + '"';
    card.appendChild(el('p', 'review-text', text));

    card.appendChild(reviewerNode(review));
    return card;
  }

  function skeletonCard() {
    var card = el('div', 'review-card skeleton');
    card.appendChild(el('span', 'sk-line short'));
    card.appendChild(el('span', 'sk-line'));
    card.appendChild(el('span', 'sk-line'));
    card.appendChild(el('span', 'sk-line mid'));
    return card;
  }

  function fetchReviews(limit, cursor) {
    var url = API_BASE + '/api/reviews?limit=' + encodeURIComponent(limit);
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error('reviews ' + res.status);
      return res.json();
    });
  }

  /* ---------- homepage strip ---------- */

  if (homeGrid) {
    fetchReviews(3)
      .then(function (data) {
        var rows = (data && data.reviews) || [];
        // Only swap in live reviews once there are enough to fill the row.
        // Below that the curated fallbacks look better than a half-empty grid.
        if (rows.length < 3) return;
        homeGrid.textContent = '';
        rows.forEach(function (r, i) {
          homeGrid.appendChild(reviewCard(r, 'reveal in' + (i === 1 ? ' d1' : i === 2 ? ' d2' : '')));
        });
      })
      .catch(function () {
        /* Fallback cards are already in the DOM. Nothing to do. */
      });
  }

  /* ---------- /reviews/ page ---------- */

  if (!listEl) return;

  var summaryEl = document.getElementById('reviews-summary');
  var moreWrap  = document.getElementById('reviews-more');
  var moreBtn   = document.getElementById('reviews-more-btn');
  var form      = document.getElementById('review-form');
  var status    = document.getElementById('form-status');
  var submitBtn = document.getElementById('submit-btn');

  var cursor = null;
  var loaded = 0;

  function showSkeletons(n) {
    listEl.textContent = '';
    for (var i = 0; i < n; i++) listEl.appendChild(skeletonCard());
  }

  function renderSummary(data) {
    if (!summaryEl || !data || !data.total) return;
    var avg = data.average != null ? Number(data.average) : null;
    summaryEl.textContent = '';
    if (avg != null && !isNaN(avg)) {
      summaryEl.appendChild(el('span', 'rs-score', avg.toFixed(1)));
      summaryEl.appendChild(el('span', 'rs-stars', starString(avg)));
    }
    summaryEl.appendChild(el('span', null,
      data.total + (data.total === 1 ? ' review' : ' reviews')));
    summaryEl.className = 'reviews-summary show';
  }

  function renderEmpty() {
    listEl.textContent = '';
    listEl.appendChild(el('div', 'reviews-empty',
      'No reviews yet. If you have one of our sculptures, yours could be the first.'));
  }

  function appendPage(data, isFirst) {
    var rows = (data && data.reviews) || [];
    if (isFirst) {
      listEl.textContent = '';
      listEl.setAttribute('aria-busy', 'false');
    }

    if (isFirst && !rows.length) {
      renderEmpty();
      if (moreWrap) moreWrap.hidden = true;
      return;
    }

    rows.forEach(function (r) {
      listEl.appendChild(reviewCard(r, 'reveal in'));
    });
    loaded += rows.length;

    cursor = (data && data.nextCursor) || null;
    if (moreWrap) moreWrap.hidden = !cursor;
  }

  function loadFirstPage() {
    showSkeletons(6);
    fetchReviews(PAGE_SIZE)
      .then(function (data) {
        appendPage(data, true);
        renderSummary(data);
        injectJsonLd(data);
      })
      .catch(function () {
        listEl.textContent = '';
        listEl.setAttribute('aria-busy', 'false');
        listEl.appendChild(el('div', 'reviews-empty',
          'Reviews are unavailable right now. Please try again shortly.'));
        if (moreWrap) moreWrap.hidden = true;
      });
  }

  if (moreBtn) {
    moreBtn.addEventListener('click', function () {
      if (!cursor) return;
      moreBtn.disabled = true;
      moreBtn.textContent = 'Loading…';
      fetchReviews(PAGE_SIZE, cursor)
        .then(function (data) { appendPage(data, false); })
        .catch(function () { if (moreWrap) moreWrap.hidden = true; })
        .finally(function () {
          moreBtn.disabled = false;
          moreBtn.textContent = 'Load more reviews';
        });
    });
  }

  // Structured data, built from what is actually on the page.
  function injectJsonLd(data) {
    var rows = (data && data.reviews) || [];
    if (!rows.length) return;
    var payload = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Polyplaces 3D map sculpture',
      url: 'https://polyplaces.co.uk/store/',
      review: rows.slice(0, 10).map(function (r) {
        return {
          '@type': 'Review',
          author: { '@type': 'Person', name: r.name || 'Anonymous' },
          datePublished: r.createdAt || undefined,
          name: r.title || undefined,
          reviewBody: r.body || '',
          reviewRating: {
            '@type': 'Rating',
            ratingValue: Number(r.rating) || 5,
            bestRating: 5,
            worstRating: 1
          }
        };
      })
    };
    if (data.average != null && data.total) {
      payload.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: Number(data.average).toFixed(1),
        reviewCount: data.total,
        bestRating: 5,
        worstRating: 1
      };
    }
    var s = document.createElement('script');
    s.type = 'application/ld+json';
    s.textContent = JSON.stringify(payload);
    document.head.appendChild(s);
  }

  loadFirstPage();

  /* ---------- submission ---------- */

  function showStatus(type, msg) {
    if (!status) return;
    status.className = 'form-status ' + type + ' show';
    status.textContent = msg;
    status.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function hideStatus() {
    if (!status) return;
    status.className = 'form-status';
    status.textContent = '';
  }

  function value(id) {
    var n = document.getElementById(id);
    return n ? n.value.trim() : '';
  }

  if (!form) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var name    = value('rv-name');
    var location= value('rv-location');
    var title   = value('rv-title');
    var body    = value('rv-body');
    var email   = value('rv-email');
    var orderRef= value('rv-order');
    var company = value('rv-company');

    var ratingEl = form.querySelector('input[name="rating"]:checked');
    var rating   = ratingEl ? parseInt(ratingEl.value, 10) : 0;

    if (!name)   { return showStatus('error', 'Please tell us your name.'); }
    if (!rating) { return showStatus('error', 'Please choose a star rating.'); }
    if (body.length < 20) {
      return showStatus('error', 'Please write a little more — at least 20 characters.');
    }
    var emailInput = document.getElementById('rv-email');
    if (!email || !emailInput.checkValidity() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showStatus('error', 'Please enter a valid email address.');
      emailInput.focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    hideStatus();

    fetch(API_BASE + '/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        location: location,
        rating: rating,
        title: title,
        body: body,
        email: email,
        orderRef: orderRef,
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
      .then(function (data) {
        if (typeof fbq === 'function') fbq('track', 'SubmitApplication', { content_name: 'Review' });
        if (typeof window.ppTrackGA === 'function') window.ppTrackGA('review_submitted', { rating: rating });
        showStatus('success', (data && data.message) ||
          'Thanks — your review will appear once we’ve checked it.');
        form.reset();
        if (typeof window.ppTurnstileReset === 'function') window.ppTurnstileReset(form);
      })
      .catch(function (err) {
        var msg = err && err.message;
        if (msg === 'rate') {
          showStatus('error', 'Too many submissions — please try again in a few minutes.');
        } else if (msg && msg !== 'server') {
          showStatus('error', msg);
        } else {
          showStatus('error', 'Something went wrong. Please try again, or email us at contact@polyplaces.co.uk.');
        }
        if (typeof window.ppTurnstileReset === 'function') window.ppTurnstileReset(form);
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit review →';
      });
  });
}());
