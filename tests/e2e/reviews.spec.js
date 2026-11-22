import { test, expect } from './fixtures.js';
import { review } from './data.js';

const list = (page) => page.locator('#reviews-list');
const cards = (page) => page.locator('#reviews-list .review-card:not(.skeleton)');

test('shows skeletons, then the first page with a summary', async ({ page, api }) => {
  api.on('GET /api/reviews', {
    json: { reviews: [review(1), review(2)], total: 2, average: 4.5, nextCursor: null },
    delay: 1500,
  });
  await page.goto('/reviews/');
  await expect(page.locator('#reviews-list .skeleton')).toHaveCount(6);
  await expect(cards(page)).toHaveCount(2);
  await expect(list(page)).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#reviews-summary')).toHaveClass(/show/);
  await expect(page.locator('#reviews-summary .rs-score')).toHaveText('4.5');
  await expect(page.locator('#reviews-summary .rs-stars')).toHaveText('★★★★★'); // 4.5 rounds up
  await expect(page.locator('#reviews-summary')).toContainText('2 reviews');
  await expect(page.locator('#reviews-more')).toBeHidden();
  expect(api.requests('GET /api/reviews')[0].query).toEqual({ limit: '12' });
});

test('card text: title and body, either alone, or rating only', async ({ page, api }) => {
  api.on('GET /api/reviews', {
    json: {
      reviews: [
        review(1, { title: 'Great', body: 'Loved it', rating: 4 }),
        review(2, { title: 'Just a title', body: '' }),
        review(3, { title: '', body: 'Just a body' }),
        review(4, { title: '', body: '', location: '' }),
        review(5, { name: '', rating: 9 }),
      ],
      total: 1, average: 5,
    },
  });
  await page.goto('/reviews/');
  await expect(cards(page).locator('.review-text')).toHaveText([
    '“Great” — Loved it',
    '“Just a title”',
    '"Just a body"',
    '“Title 5” — Body 5',
  ]);
  await expect(cards(page).nth(0).locator('.stars')).toHaveText('★★★★☆');
  await expect(cards(page).nth(3)).toHaveClass(/is-rating-only/);
  await expect(cards(page).nth(3).locator('.reviewer')).toHaveText('Reviewer 4');
  await expect(cards(page).nth(0).locator('.reviewer')).toHaveText('Reviewer 1 · Leeds, UK');
  await expect(cards(page).nth(4).locator('.reviewer')).toHaveText('Anonymous · Leeds, UK');
  await expect(cards(page).nth(4).locator('.stars')).toHaveText('★★★★★'); // clamped to 5
  await expect(page.locator('#reviews-summary')).toContainText('1 review');
});

test('review content is never parsed as HTML', async ({ page, api }) => {
  const evil = '<img src=x onerror="window.__xss=1">';
  api.on('GET /api/reviews', { json: { reviews: [review(1, { name: evil, title: evil, body: evil, location: evil })], total: 1, average: 5 } });
  await page.goto('/reviews/');
  await expect(cards(page)).toHaveCount(1);
  await expect(page.locator('#reviews-list img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('Load more follows the cursor and hides at the end', async ({ page, api }) => {
  api.on('GET /api/reviews', (req) => req.query.cursor === 'c2'
    ? { json: { reviews: [review(13)], nextCursor: null }, delay: 200 }
    : { json: { reviews: Array.from({ length: 12 }, (_, i) => review(i + 1)), total: 13, average: 5, nextCursor: 'c2' } });
  await page.goto('/reviews/');
  await expect(cards(page)).toHaveCount(12);
  await expect(page.locator('#reviews-more')).toBeVisible();
  await page.locator('#reviews-more-btn').click();
  await expect(page.locator('#reviews-more-btn')).toHaveText('Loading…');
  await expect(page.locator('#reviews-more-btn')).toBeDisabled();
  await expect(cards(page)).toHaveCount(13);
  await expect(page.locator('#reviews-more')).toBeHidden();
  expect(api.requests('GET /api/reviews')[1].query).toEqual({ limit: '12', cursor: 'c2' });
});

test('a failed Load more hides the button and keeps what loaded', async ({ page, api }) => {
  api.on('GET /api/reviews', (req) => req.query.cursor
    ? { status: 500, json: {} }
    : { json: { reviews: [review(1)], total: 2, average: 5, nextCursor: 'c2' } });
  await page.goto('/reviews/');
  await page.locator('#reviews-more-btn').click();
  await expect(page.locator('#reviews-more')).toBeHidden();
  await expect(cards(page)).toHaveCount(1);
});

test('empty state', async ({ page, api }) => {
  api.on('GET /api/reviews', { json: { reviews: [], total: 0 } });
  await page.goto('/reviews/');
  await expect(page.locator('.reviews-empty')).toHaveText('No reviews yet. If you have one of our sculptures, yours could be the first.');
  await expect(page.locator('#reviews-summary')).not.toHaveClass(/show/);
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
});

test('error state', async ({ page, api }) => {
  api.on('GET /api/reviews', { status: 503, json: {} });
  await page.goto('/reviews/');
  await expect(page.locator('.reviews-empty')).toHaveText('Reviews are unavailable right now. Please try again shortly.');
  await expect(page.locator('#reviews-more')).toBeHidden();
});

test('injects Product JSON-LD with an aggregate rating', async ({ page, api }) => {
  api.on('GET /api/reviews', {
    json: { reviews: Array.from({ length: 12 }, (_, i) => review(i + 1, { rating: 4 })), total: 40, average: 4.25 },
  });
  await page.goto('/reviews/');
  const ld = JSON.parse(await page.locator('head script[type="application/ld+json"]').last().textContent());
  expect(ld['@type']).toBe('Product');
  expect(ld.review).toHaveLength(10);
  expect(ld.review[0]).toMatchObject({
    '@type': 'Review', author: { name: 'Reviewer 1' }, name: 'Title 1', reviewBody: 'Body 1',
    reviewRating: { ratingValue: 4, bestRating: 5, worstRating: 1 },
  });
  expect(ld.aggregateRating).toEqual({ '@type': 'AggregateRating', ratingValue: '4.3', reviewCount: 40, bestRating: 5, worstRating: 1 });
});
