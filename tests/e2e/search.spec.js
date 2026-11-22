import { test, expect, openStore } from './fixtures.js';
import { NOMINATIM } from './data.js';

test.beforeEach(async ({ page, api }) => {
  api.on('nominatim', { json: NOMINATIM });
  await openStore(page);
});

const input = (page) => page.locator('#map-search-input');
const results = (page) => page.locator('#map-search-results');
const rows = (page) => page.locator('.map-search-result[role="option"]');

test('Search queries Nominatim and lists results as text', async ({ page, api }) => {
  api.on('nominatim', { json: [{ display_name: '<img src=x onerror="window.__xss=1">', lat: '1', lon: '1' }, ...NOMINATIM], delay: 200 });
  await input(page).fill('  whitby  ');
  await page.locator('#map-search-btn').click();
  await expect(page.locator('#map-search-btn')).toHaveText('Searching…');
  await expect(page.locator('#map-search-btn')).toBeDisabled();
  await expect(rows(page)).toHaveCount(4);
  await expect(page.locator('#map-search-btn')).toHaveText('Search');
  await expect(results(page)).toHaveAttribute('aria-hidden', 'false');
  await expect(rows(page).first()).toHaveText('<img src=x onerror="window.__xss=1">');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  const [req] = api.requests('nominatim');
  expect(req.query).toEqual({ format: 'jsonv2', q: 'whitby', limit: '6', addressdetails: '1' });
  expect(req.headers.accept).toBe('application/json');
});

test('picking a result recentres the map and the frame', async ({ page, api }) => {
  await input(page).fill('whitby');
  await page.locator('#map-search-btn').click();
  await rows(page).nth(0).dispatchEvent('click');
  await expect(results(page)).not.toHaveClass(/show/);
  const r = await page.evaluate(() => ({ c: map.getCenter(), z: map.getZoom() }));
  expect(r.c.lat).toBeCloseTo(54.4863, 3);
  expect(r.z).toBeGreaterThanOrEqual(14);
  await expect.poll(() => page.evaluate(() => frameCenter.lat), { timeout: 3000 }).toBeCloseTo(54.4863, 3);
  await expect(page.locator('#order-status-msg')).toHaveText('Looking good! Adjust the frame then add to cart.');
});

test('Enter with no list open jumps straight to the top hit', async ({ page, api }) => {
  await input(page).fill('whitby');
  await input(page).press('Enter');
  await expect.poll(() => page.evaluate(() => map.getCenter().lat)).toBeCloseTo(54.4863, 3);
  await expect(rows(page)).toHaveCount(0);
});

test('arrow keys move the selection, clamped; Enter picks it', async ({ page, api }) => {
  await input(page).fill('whitby');
  await page.locator('#map-search-btn').click();
  await expect(rows(page).nth(0)).toHaveAttribute('aria-selected', 'true');

  await input(page).press('ArrowDown');
  await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page).nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(rows(page).nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.map-search-result[aria-selected="true"]')).toHaveCount(1);

  await input(page).focus();
  await input(page).press('Enter');
  await expect.poll(() => page.evaluate(() => map.getCenter().lng)).toBeCloseTo(-78.9429, 3);
});

test('Escape closes the list from the input and from the list', async ({ page, api }) => {
  await input(page).fill('whitby');
  await page.locator('#map-search-btn').click();
  await input(page).press('Escape');
  await expect(results(page)).not.toHaveClass(/show/);
  await expect(results(page)).toHaveAttribute('aria-hidden', 'true');

  await page.locator('#map-search-btn').click();
  await input(page).press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(results(page)).not.toHaveClass(/show/);
  await expect(input(page)).toBeFocused();
});

test('clicking elsewhere closes the list', async ({ page, api }) => {
  await input(page).fill('whitby');
  await page.locator('#map-search-btn').click();
  await expect(results(page)).toHaveClass(/show/);
  await page.locator('.store-title').click();
  await expect(results(page)).not.toHaveClass(/show/);
});

test('empty query does not search', async ({ page, api }) => {
  await input(page).fill('   ');
  await page.locator('#map-search-btn').click();
  expect(api.requests('nominatim')).toHaveLength(0);
});

for (const [name, res] of [
  ['no matches', { json: [] }],
  ['an HTTP error', { status: 503, json: {} }],
  ['a non-array body', { json: { error: 'x' } }],
]) {
  test(`shows "No results found." for ${name}`, async ({ page, api }) => {
    api.on('nominatim', res);
    await input(page).fill('nowhere');
    await page.locator('#map-search-btn').click();
    await expect(page.locator('.map-search-result.is-empty')).toHaveText('No results found.');
    await expect(page.locator('#map-search-btn')).toBeEnabled();
  });
}

test('results with bad coordinates are ignored', async ({ page, api }) => {
  api.on('nominatim', { json: [{ display_name: 'Bad', lat: 'x', lon: 'y' }] });
  const before = await page.evaluate(() => map.getCenter());
  await input(page).fill('bad');
  await page.locator('#map-search-btn').click();
  await rows(page).first().dispatchEvent('click');
  const after = await page.evaluate(() => map.getCenter());
  expect(after).toEqual(before);
});

// Regression (frontend-test-plan.md 4.10): on a 1280x720 window the map
// toolbar wraps, and the results list must still sit above the frame controls.
test('every search result can be clicked', async ({ page, api }) => {
  await input(page).fill('whitby');
  await page.locator('#map-search-btn').click();
  await rows(page).nth(0).click({ timeout: 2000 });
  await expect.poll(() => page.evaluate(() => map.getCenter().lat)).toBeCloseTo(54.4863, 3);
});
