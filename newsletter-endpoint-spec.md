# Backend Spec: POST /api/newsletter

## Purpose

The homepage newsletter popup trades a 10% discount code for an email address. This
route takes that address, proves the sender is human, issues a single-use Stripe
promotion code, emails it, and records the subscriber.

Handler: `app.post('/api/newsletter')` in `src/worker.js`, route
`api.polyplaces.co.uk/*`.

The frontend is already written and live behind a flag - see "Turning it on" at the
bottom. Nothing on the page changes when this ships except the value of one constant.

---

## TL;DR for the frontend

What the popup posts today, unchanged apart from `turnstileToken`:

```jsonc
{
  "email": "tom@example.com",
  "renderedAt": 1753872000000,   // ms epoch, stamped when the popup opened
  "company": "",                 // honeypot, always empty from a real browser
  "source": "/store/",           // page path the popup was shown on
  "turnstileToken": "0.abc…"     // see "Turnstile" below
}
```

Success is `200 {"ok":true}`. The code itself is **never** in the response - it goes
to the inbox, which is the whole point of asking for the address. The popup shows
"Check your inbox" and the address it sent to.

---

## What already exists - reuse, don't rebuild

Confirmed present in the deployed bundle (see `reviews-contact-endpoint-spec.md`):

| Symbol | Use |
|---|---|
| `app.use("*")` CORS middleware | Origin allowlist + preflight. Runs before every route. **New routes inherit it. Do not add per-route CORS** |
| `getClientIp(c.req)` | Rate-limit key and IP hash source |
| `isValidEmail(str)` | Email syntax |
| `HttpError(status, message)` + `app.onError` | Throw it; the handler renders `{"error": msg}` |
| `safeStringify` / `describeError` | Structured logging |
| Resend send in the contact handler | Copy the call shape, not the template |
| Stripe client used by `/api/checkout` | Same secret key, same account. Do not open a second client |

---

## Configuration

### New secrets (`wrangler secret put`)

| Name | Value |
|---|---|
| `STRIPE_NEWSLETTER_COUPON_ID` | Id of a 10% off, `duration: once` coupon created by hand in the Stripe dashboard. Not created at runtime |
| `N8N_NEWSLETTER_WEBHOOK_URL` | Subscriber intake flow, if storage goes to n8n |

`RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`, `IP_HASH_SALT` and the Stripe secret key are
already set for the existing routes.

### New rate-limit binding (`wrangler.jsonc`)

```jsonc
{ "name": "RL_NEWSLETTER", "namespace_id": "1004", "simple": { "limit": 3, "period": 60 } }
```

Alongside the existing `RL_REVIEWS` / `RL_CONTACT` / `RL_GLOBAL`. Not a module-scope
`Map` - worker isolates are per-colo and short-lived, so a Map stops a `for` loop in
one tab and nothing else.

---

## The gates

Same order and same reasoning as `/api/contact` - cheapest first, so a flood is
rejected before it costs anything. Two of them matter more here than on any other
route, because a signup that clears them **spends money**: it creates a promotion code
and sends an email.

### 1. CORS

Existing middleware. No work. Bad origin → `403 {"error":"Not allowed by CORS"}`.

### 2. Rate limit

```js
const ip = getClientIp(c.req);
const { success } = await c.env.RL_NEWSLETTER.limit({ key: ip });
if (!success) throw new HttpError(429, "Too many requests. Please try again in a few minutes.");
const global = await c.env.RL_GLOBAL.limit({ key: "newsletter" });
if (!global.success) throw new HttpError(429, "Too many requests. Please try again in a few minutes.");
```

Set `Retry-After: 60`.

### 3. Shape

- `Content-Length` > 2048 → `400 "Request too large."` Check the header *before*
  `await c.req.json()`.
- Not JSON → `400 "Invalid JSON body."`

  | Field | Rule |
  |---|---|
  | `email` | required, ≤ 254, `isValidEmail` |
  | `renderedAt` | required, number |
  | `company` | optional, must be absent or `""` |
  | `source` | optional, ≤ 200, path only. Reject anything containing `://` |
  | `turnstileToken` | required, ≤ 2048 |

- Lowercase and trim the email before every downstream use, so `Tom@…` and `tom@…`
  are one subscriber rather than two codes.
- Unknown keys: drop silently, don't 400. A future frontend field must not break an
  older worker.

### 4. Honeypot + timing → silent drop

- `company` must be absent or `""`.
- `now - renderedAt` must be ≥ 3000 ms and ≤ 6 h.

On failure return **the normal success response** - `200 {"ok":true}`, identical body -
and issue nothing, send nothing, store nothing. Log `event: "spam_drop"` with the
reason.

A bot that gets a `400` learns which field betrayed it. A bot that gets a `200` and no
email learns nothing.

### 5. Turnstile

```js
const form = new FormData();
form.append("secret",   c.env.TURNSTILE_SECRET_KEY);
form.append("response", token);
form.append("remoteip", ip);
const res  = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",
                         { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
const data = await res.json();
if (!data.success) throw new HttpError(400, "Verification failed. Please refresh and try again.");
```

Missing token is a `400`, not a silent drop - a real person with a broken widget needs
to see the error. If `siteverify` is unreachable, **fail closed**.

### 6. Repeat address

Before issuing anything, check whether this email already has a live code.

- Already subscribed → return `200 {"ok":true}` and re-send the **existing** code, or
  send nothing at all if the last send was under an hour ago.
- Never issue a second code for the same address. Otherwise the offer is an unlimited
  discount tap for anyone who resubmits, and the popup's own 7-day snooze is only a
  client-side courtesy that a determined visitor bypasses by clearing localStorage.

This is the gate that decides whether the promotion is a promotion or a giveaway.

---

## Issuing the code

One 10% off coupon exists in Stripe, created by hand, id in
`STRIPE_NEWSLETTER_COUPON_ID`. Per subscriber the worker creates a promotion code
against it:

```js
const promo = await stripe.promotionCodes.create({
  coupon: c.env.STRIPE_NEWSLETTER_COUPON_ID,
  max_redemptions: 1,
  expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  metadata: { email, source, issued_at: new Date().toISOString() }
});
```

Notes that matter:

- **`max_redemptions: 1`** is what makes this a personal code rather than a string that
  ends up on a voucher aggregator.
- Let Stripe generate the code string. A readable custom `code` per subscriber is
  guessable, and guessable single-use codes get enumerated.
- `expires_at` gives the offer an end. 30 days is a suggestion, not a constraint.
- Stripe Checkout's hosted page already has a promotion code field, so redemption
  needs **no frontend work** - the session must have `allow_promotion_codes: true`,
  which `/api/checkout` should be checked for before this ships.
- If `promotionCodes.create` fails, `500` and send no email. A code that does not exist
  in an inbox is worse than a retry.

---

## Sending the code

Resend, worker-side, same call shape as the contact handler. **Await it** - the
response status reflects the send, so a visitor is never told to check an inbox that
will stay empty.

- To: the subscriber. From: the address already verified for Resend.
- Subject and body are yours to write. It must contain the code, what it applies to,
  the expiry date, and a one-click unsubscribe.
- On Resend failure: delete or deactivate the promotion code just created, then `500`.
  Otherwise every failed send leaks an unredeemable code into the Stripe account.

---

## Storing the subscriber

Forward to n8n via `c.executionCtx.waitUntil(...)`, fire-and-forget, with
`X-Polyplaces-Secret` - the same pattern the contact route uses. The response does not
depend on the n8n container being up.

Record: email, `source`, `issued_at`, the promotion code id (not the code string), the
hashed IP (`IP_HASH_SALT`), and consent - the timestamp and the wording shown at the
time. That last one is the part people forget, and it is the part that matters if
anyone ever asks how the address was collected.

---

## Responses

| Status | Body | When |
|---|---|---|
| 200 | `{"ok":true}` | Issued and sent. Also returned for honeypot and timing drops, and for an address that already subscribed |
| 400 | `{"error":"…"}` | Bad JSON, bad shape, failed or missing Turnstile. Text surfaces verbatim to the user |
| 403 | `{"error":"Not allowed by CORS"}` | Bad origin |
| 429 | `{"error":"Too many requests. Please try again in a few minutes."}` | Rate limited |
| 500 | `{"error":"…"}` | Stripe or Resend failed. The popup shows its generic retry message |

The frontend treats every non-2xx identically: re-enable the button and show "Something
went wrong - please try again shortly." Only the text of a 400 is worth writing
carefully, because it is the only one a user can act on.

---

## Turning it on

In [`assets/js/app.js`](assets/js/app.js), in the newsletter popup block:

```js
const NEWSLETTER_ENDPOINT = null; // e.g. '/api/newsletter'
```

Set it to `'/api/newsletter'`. That is the entire frontend change - the POST body,
error handling, and success panel are already written and behave the same whether the
promise came from `fetch` or the mock.

Also required before or with that flip: the Turnstile widget in the popup, which does
not exist yet. Until it does, `turnstileToken` is absent and gate 5 rejects every real
signup.

---

## Open questions

1. **Storage** - n8n Data Table, consistent with reviews, or a real ESP. If an ESP
   owns the list, it probably owns the sending too, and the Resend section above
   collapses into a single API call.
2. **Does the 10% stack** with anything else you run? Stripe will happily apply a
   coupon on top of a sale price unless the coupon is restricted.
3. **Unsubscribe** - a link needs somewhere to land. A `GET /api/newsletter/unsubscribe`
   with a signed token is the smallest thing that works, and it is not optional under
   PECR for marketing email to UK consumers.
