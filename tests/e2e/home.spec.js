import { test, expect } from './fixtures.js';
import { PRODUCTS_RESPONSE, review } from './data.js';

test.describe('prices', () => {
  test('paints "From" prices per frame key', async ({ page, api }) => {
    await page.goto('/');
    await expect(page.locator('#prod-price-small')).toHaveText('From £30');
    await expect(page.locator('#prod-price-medium')).toHaveText('From £35');
    await expect(page.locator('#prod-price-large')).toHaveText('From £45');
    await expect(page.locator('#prod-price-large')).toBeVisible();
  });

  test('leaves prices hidden when there is no price', async ({ page, api }) => {
    const data = structuredClone(PRODUCTS_RESPONSE);
    data.products[2].unitAmount = 0;
    api.on('GET /api/products', { json: data });
    await page.goto('/');
    await expect(page.locator('#prod-price-small')).toHaveText('From £30');
    await expect(page.locator('#prod-price-large')).toBeHidden();
  });

  test('a failed price load leaves the page working', async ({ page, api }) => {
    api.on('GET /api/products', { status: 500, json: {} });
    await page.goto('/');
    await expect(page.locator('#prod-price-small')).toBeHidden();
    expect(page.pageErrors).toEqual([]);
  });
});

test.describe('gallery', () => {
  const thumbs = (page) => page.locator('.gallery-thumb');

  test.describe('fallback thumbs', () => {
    test.beforeEach(async ({ api }) => api.on('GET /api/places', { status: 500, json: {} }));

    test('keep the static pieces when the API fails', async ({ page, api }) => {
      await page.goto('/');
      await api.waitFor('GET /api/places');
      await expect(thumbs(page)).toHaveCount(4);
      await expect(page.locator('#gallery-place')).toHaveText('Whitby harbour');
    });

    test('click swaps the featured piece and the CTA', async ({ page, api }) => {
      await page.goto('/');
      const second = thumbs(page).nth(1);
      await second.click();
      await expect(second).toHaveAttribute('aria-selected', 'true');
      await expect(second).toHaveClass(/is-active/);
      await expect(thumbs(page).nth(0)).toHaveAttribute('aria-selected', 'false');
      const d = await second.evaluate((el) => ({ ...el.dataset }));
      await expect(page.locator('#gallery-place')).toHaveText(d.place);
      await expect(page.locator('#gallery-photo')).toHaveAttribute('alt', d.alt);
      await expect(page.locator('#gallery-cta')).toHaveAttribute('href',
        `/store/?scale=${encodeURIComponent(d.scale)}&lat=${encodeURIComponent(d.lat)}&lng=${encodeURIComponent(d.lng)}&z=${encodeURIComponent(d.z)}`);
      await expect(page.locator('#gallery-cta')).toHaveAttribute('aria-label', `Make ${d.place} yours`);
    });

    test('arrow keys move along the strip and wrap', async ({ page, api }) => {
      await page.goto('/');
      await thumbs(page).nth(0).focus();
      await page.keyboard.press('ArrowLeft');
      await expect(thumbs(page).nth(3)).toBeFocused();
      await expect(thumbs(page).nth(3)).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('ArrowRight');
      await expect(thumbs(page).nth(0)).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(thumbs(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    });
  });

  test('published places replace the strip; invalid ones are dropped', async ({ page, api }) => {
    api.on('GET /api/places', {
      json: {
        places: [
          {
            name: '<b>Edinburgh</b>', description: 'Castle', size: 'large', frame: 'oak', lat: 55.9486, lng: -3.1999, zoom: 15,
            image: { url: '/assets/imgs/Large%20frame.webp', alt: 'Edinburgh', width: 800, height: 600 },
          },
          { name: 'No image', lat: 1, lng: 1, image: {} },
          { name: 'Bad lat', lat: 'x', lng: 1, image: { url: '/x.webp' } },
          { name: 'Bath', size: 'custom', widthCm: 25, heightCm: 18, lat: 51.38, lng: -2.36, zoom: 16, image: { url: '/assets/imgs/custom.webp' } },
        ],
      },
    });
    await page.goto('/');
    await expect(thumbs(page)).toHaveCount(2);
    await expect(page.locator('#gallery-place')).toHaveText('<b>Edinburgh</b>');
    await expect(page.locator('#gallery-eyebrow')).toHaveText('Large · 32 × 32cm · Oak frame');
    await expect(page.locator('#gallery-photo')).toHaveAttribute('width', '800');
    await expect(page.locator('#gallery-cta')).toHaveAttribute('href', '/store/?scale=large&lat=55.9486&lng=-3.1999&z=15');

    await thumbs(page).nth(1).click();
    await expect(page.locator('#gallery-eyebrow')).toHaveText('Custom · 25 × 18cm');
    await expect(page.locator('#gallery-note')).toHaveText('');
    await expect(page.locator('#gallery-photo')).toHaveAttribute('alt', 'Bath');
  });

  test('an empty places list keeps the fallback', async ({ page, api }) => {
    api.on('GET /api/places', { json: { places: [] } });
    await page.goto('/');
    await api.waitFor('GET /api/places');
    await expect(thumbs(page)).toHaveCount(4);
  });

  test('"Make this place yours" opens the store on that place', async ({ page, api }) => {
    await page.goto('/');
    await expect(page.locator('#gallery-place')).toHaveText('Edinburgh Old Town');
    await page.locator('#gallery-cta').click();
    await page.waitForURL(/\/store\//);
    await expect(page.locator('.size-opt.active')).toHaveAttribute('data-product-id', 'prod_large');
    expect(await page.evaluate(() => map.getCenter().lat)).toBeCloseTo(55.9486, 3);
  });
});

test.describe('reviews strip', () => {
  test('swaps in three live reviews', async ({ page, api }) => {
    await page.goto('/');
    await expect(page.locator('#home-reviews-grid .review-card')).toHaveCount(3);
    await expect(page.locator('#home-reviews-grid .review-text').first()).toHaveText('“Title 1” — Body 1');
    expect(api.requests('GET /api/reviews')[0].query).toEqual({ limit: '3' });
  });

  for (const [why, res] of [
    ['fewer than three', { json: { reviews: [review(1), review(2)] } }],
    ['an error', { status: 500, json: {} }],
  ]) {
    test(`keeps the curated cards on ${why}`, async ({ page, api }) => {
      await page.goto('/');
      const fallback = await page.locator('#home-reviews-grid').innerHTML();
      api.on('GET /api/reviews', res);
      await page.reload();
      await api.waitFor('GET /api/reviews', 2);
      await page.waitForTimeout(200);
      expect(await page.locator('#home-reviews-grid').innerHTML()).not.toContain('Reviewer 1');
      expect(fallback.length).toBeGreaterThan(0);
    });
  }
});

test.describe('reveal animations', () => {
  test('reveal on scroll', async ({ page, api }) => {
    await page.goto('/');
    const last = page.locator('.reveal').last();
    await expect(last).not.toHaveClass(/\bin\b/);
    await last.scrollIntoViewIfNeeded();
    await expect(last).toHaveClass(/\bin\b/);
  });

  test('show everything at once with reduced motion', async ({ page, api }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const count = await page.locator('.reveal').count();
    await expect(page.locator('.reveal.in')).toHaveCount(count);
  });
});
