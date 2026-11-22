// contact.js, newsletter.js and the reviews.js submission share one contract:
// client-side validation, a JSON POST with anti-spam fields and a Turnstile
// token, and the same success / 400 / 429 / 5xx handling.

import { test, expect, fbqEvents, gaEvents, DEFAULT_STORAGE, API } from './fixtures.js';

const FORMS = {
  contact: {
    path: '/contact/',
    endpoint: 'POST /api/contact',
    async fill(page) {
      await page.locator('#name').fill(' Ada ');
      await page.locator('#email').fill('ada@example.com');
      await page.locator('#subject').selectOption('commission');
      await page.locator('#message').fill(' A big one please ');
    },
    body: { name: 'Ada', email: 'ada@example.com', subject: 'commission', message: 'A big one please', company: '' },
    success: 'Message sent — we’ll be in touch within 1–2 business days.',
    rate: 'Too many messages sent — please try again shortly.',
    generic: 'Something went wrong. Please try again or email us directly at info@polyplaces.co.uk.',
    button: 'Send message →',
    pixel: ['Lead', { content_name: 'Contact form' }],
    ga: ['contact_submitted', { subject: 'commission' }],
    emailField: '#email',
  },
  newsletter: {
    path: '/newsletter/',
    endpoint: 'POST /api/newsletter',
    async fill(page) {
      await page.locator('#email').fill(' ada@example.com ');
    },
    body: { email: 'ada@example.com', company: '', source: '/newsletter/' },
    success: 'Check your inbox for your 10% discount code. It should arrive within a few minutes.',
    rate: 'Too many signup attempts - please try again in a few minutes.',
    generic: 'Something went wrong. Please try again or email us directly at info@polyplaces.co.uk.',
    button: 'Sign me up →',
    pixel: ['Lead', { content_name: 'Newsletter signup' }],
    ga: ['newsletter_signup', {}],
    emailField: '#email',
  },
  review: {
    path: '/reviews/',
    endpoint: 'POST /api/reviews',
    async fill(page) {
      await page.locator('#rv-name').fill('Ada L.');
      await page.locator('#rv-location').fill('London');
      await page.locator('label[for="rv-rating-4"]').click();
      await page.locator('#rv-title').fill('Lovely');
      await page.locator('#rv-body').fill('Arrived quickly.');
      await page.locator('#rv-email').fill('ada@example.com');
      await page.locator('#rv-order').fill('PP-123');
    },
    body: { name: 'Ada L.', location: 'London', rating: 4, title: 'Lovely', body: 'Arrived quickly.', email: 'ada@example.com', orderRef: 'PP-123', company: '' },
    success: 'Thanks — your review will appear once we’ve checked it.',
    rate: 'Too many submissions — please try again in a few minutes.',
    generic: 'Something went wrong. Please try again, or email us at info@polyplaces.co.uk.',
    button: 'Submit review →',
    pixel: ['SubmitApplication', { content_name: 'Review' }],
    ga: ['review_submitted', { rating: 4 }],
    emailField: '#rv-email',
  },
};

const formFor = (name) => page => page.locator(name === 'contact' ? '#contact-form' : name === 'newsletter' ? '#newsletter-form' : '#review-form');
const status = (page) => page.locator('#form-status');
const submit = (page) => page.locator('#submit-btn');

for (const [name, f] of Object.entries(FORMS)) {
  test.describe(`${name} form`, () => {
    test.use({ storage: { ...DEFAULT_STORAGE, pp_cn: '1' } });

    test.beforeEach(async ({ page, api }) => {
      await page.goto(f.path);
      // Turnstile renders once the fake api.js arrives.
      await page.waitForFunction(() => window.ppTurnstileReady === true);
    });

    test('renders the Turnstile widget with the site key and action', async ({ page }) => {
      const renders = await page.evaluate(() => window.__ts.renders);
      expect(renders).toHaveLength(1);
      expect(renders[0].sitekey).toBe('0x4AAAAAAEB9HHypdEham6WW');
    });

    test('posts the payload with anti-spam fields and resets on success', async ({ page, api }) => {
      await f.fill(page);
      await submit(page).click();
      await expect(status(page)).toHaveText(f.success);
      await expect(status(page)).toHaveClass(/success/);

      const [req] = api.requests(f.endpoint);
      expect(req.body).toMatchObject({ ...f.body, turnstileToken: 'token-w1' });
      expect(req.body.renderedAt).toBeLessThanOrEqual(Date.now());
      expect(req.headers['content-type']).toBe('application/json');

      await expect(page.locator(f.emailField)).toHaveValue('');
      expect(await page.evaluate(() => window.__ts.resets)).toEqual(['w1']);
      expect(await fbqEvents(page, f.pixel[0])).toEqual([f.pixel[1]]);
      const ga = await gaEvents(page, f.ga[0]);
      expect(ga.map((e) => e.params)).toEqual([f.ga[1]]);
    });

    test('disables the button while sending', async ({ page, api }) => {
      api.on(f.endpoint, { json: {}, delay: 400 });
      await f.fill(page);
      await submit(page).click();
      await expect(submit(page)).toBeDisabled();
      await expect(submit(page)).toHaveText('Sending…');
      await expect(submit(page)).toBeEnabled();
      await expect(submit(page)).toHaveText(f.button);
    });

    test('rejects an invalid email and focuses it', async ({ page, api }) => {
      await f.fill(page);
      await page.locator(f.emailField).fill('ada@example');
      await submit(page).click();
      await expect(status(page)).toHaveText('Please enter a valid email address.');
      await expect(status(page)).toHaveClass(/error/);
      await expect(page.locator(f.emailField)).toBeFocused();
      expect(api.requests(f.endpoint)).toHaveLength(0);
    });

    test('shows a 400 error from the API verbatim', async ({ page, api }) => {
      api.on(f.endpoint, { status: 400, json: { error: 'That email looks disposable.' } });
      await f.fill(page);
      await submit(page).click();
      await expect(status(page)).toHaveText('That email looks disposable.');
      expect(await page.evaluate(() => window.__ts.resets)).toEqual(['w1']);
    });

    test('a 429 shows the rate-limit message', async ({ page, api }) => {
      api.on(f.endpoint, { status: 429, json: {} });
      await f.fill(page);
      await submit(page).click();
      await expect(status(page)).toHaveText(f.rate);
    });

    for (const [why, res] of [
      ['a 500', { status: 500, json: { error: 'internal detail' } }],
      ['a 400 without an error', { status: 400, json: {} }],
      ['a non-JSON body', { status: 502, body: '<html>bad gateway</html>', contentType: 'text/html' }],
    ]) {
      test(`${why} shows the generic message`, async ({ page, api }) => {
        api.on(f.endpoint, res);
        await f.fill(page);
        await submit(page).click();
        await expect(status(page)).toHaveText(f.generic);
        await expect(submit(page)).toBeEnabled();
        // Nothing was cleared, so the visitor can retry.
        await expect(page.locator(f.emailField)).not.toHaveValue('');
      });
    }

    // KNOWN BUG (frontend-test-plan.md 4.11): the catch shows any error message
    // other than 'rate'/'server' verbatim, so a dropped connection shows the
    // browser's raw TypeError text ("Failed to fetch") instead of the help text.
    test.fail('a network failure shows the generic message', async ({ page, api }) => {
      api.on(f.endpoint, { abort: true });
      await f.fill(page);
      await submit(page).click();
      await expect(status(page)).toHaveText(f.generic, { timeout: 2000 });
    });

    test('sends the honeypot when a bot fills it', async ({ page, api }) => {
      await f.fill(page);
      const honeypot = name === 'review' ? '#rv-company' : '#company';
      await page.locator(honeypot).fill('Acme', { force: true });
      await submit(page).click();
      const [req] = await api.waitFor(f.endpoint);
      expect(req.body.company).toBe('Acme');
    });
  });
}

test.describe('required fields', () => {
  test('contact needs name, email and message', async ({ page, api }) => {
    await page.goto('/contact/');
    await page.locator('#name').fill('Ada');
    await page.locator('#email').fill('ada@example.com');
    await page.locator('#submit-btn').click();
    await expect(page.locator('#form-status')).toHaveText('Please fill in all required fields.');
    expect(api.requests('POST /api/contact')).toHaveLength(0);
  });

  test('newsletter needs an email', async ({ page, api }) => {
    await page.goto('/newsletter/');
    await page.locator('#submit-btn').click();
    await expect(page.locator('#form-status')).toHaveText('Please enter your email address.');
  });

  test('review needs a name, then a rating, then an email', async ({ page, api }) => {
    await page.goto('/reviews/');
    await page.locator('#submit-btn').click();
    await expect(page.locator('#form-status')).toHaveText('Please tell us your name.');
    await page.locator('#rv-name').fill('Ada');
    await page.locator('#submit-btn').click();
    await expect(page.locator('#form-status')).toHaveText('Please choose a star rating.');
    await page.locator('label[for="rv-rating-5"]').click();
    await page.locator('#submit-btn').click();
    await expect(page.locator('#form-status')).toHaveText('Please enter a valid email address.');
    await page.locator('#rv-email').fill('ada@example.com');
    await page.locator('#submit-btn').click();
    const [req] = await api.waitFor('POST /api/reviews');
    // A rating alone is a valid review.
    expect(req.body).toMatchObject({ name: 'Ada', rating: 5, title: '', body: '' });
  });

  test('review success uses the API message when given', async ({ page, api }) => {
    api.on('POST /api/reviews', { json: { message: 'Thanks Ada!' } });
    await page.goto('/reviews/');
    await FORMS.review.fill(page);
    await page.locator('#submit-btn').click();
    await expect(page.locator('#form-status')).toHaveText('Thanks Ada!');
  });
});

test.describe('Turnstile', () => {
  test('without a site key the widget is skipped and the form still submits', async ({ page, api }) => {
    await page.route('**/assets/js/env.js*', (route) => route.fulfill({
      contentType: 'application/javascript',
      body: `window.__POLYPLACES_ENV__ = { POLYPLACES_API_BASE_URL: '${API}' };`,
    }));
    const warnings = [];
    page.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()));
    await page.goto('/newsletter/');
    await page.locator('#email').fill('ada@example.com');
    await page.locator('#submit-btn').click();
    const [req] = await api.waitFor('POST /api/newsletter');
    expect(req.body.turnstileToken).toBe('');
    expect(warnings.some((w) => w.includes('POLYPLACES_TURNSTILE_SITE_KEY is not set'))).toBe(true);
  });

  test('ppTurnstileToken is empty before the widget exists', async ({ page, api }) => {
    await page.route('https://challenges.cloudflare.com/**', (route) => route.abort());
    await page.goto('/contact/');
    expect(await page.evaluate(() => window.ppTurnstileToken(document.getElementById('contact-form')))).toBe('');
    expect(await page.evaluate(() => window.ppTurnstileReady)).toBe(false);
  });
});
