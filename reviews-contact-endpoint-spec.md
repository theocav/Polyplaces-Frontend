# Backend Spec: Reviews & Contact endpoints

## Purpose

Three routes on the existing Hono worker (`src/worker.js`, route
`api.polyplaces.co.uk/*`) that put a hardened proxy in front of n8n.

n8n webhooks are unauthenticated public URLs with no rate limiting, running on a
single container. If a webhook URL ships in browser JS, it is found in DevTools within
a minute and can be hammered until the container falls over. **No n8n URL may reach the
browser.** The frontend talks only to this worker; the worker holds the URLs and the
shared secret as secrets, and forwards only requests that clear five gates.

Companion doc: `n8n-reviews-schema.md` — the Data Table schema and the three n8n flows.

| Route | Purpose |
|---|---|
| `GET /api/reviews` | Approved reviews, edge-cached |
| `POST /api/reviews` | Submit a review → n8n moderation queue |
| `POST /api/contact` | Contact enquiry → Resend email + n8n record |
| `POST /contact` | Deprecated alias of `POST /api/contact` |

---

## What already exists — reuse, don't rebuild

Confirmed present in the deployed bundle:

| Symbol | Use |
|---|---|
| `app.use("*")` CORS middleware | Origin allowlist + preflight + response headers. Runs before every route. **New routes inherit it. Do not add per-route CORS** |
| `getClientIp(c.req)` | Rate-limit key and IP hash source |
| `isValidEmail(str)` | Email syntax |
| `HttpError(status, message)` + `app.onError` | Throw it; the handler renders `{"error": msg}` and adds `detail` when `DEBUG_VERBOSE=true` |
| `safeStringify` / `describeError` | Structured logging |
| `normalizeContactSubject` / `CONTACT_SUBJECT_LABELS` | Contact subject enum |

### Delete this

```js
var contactRateLimitMap = new Map();      // module scope
var CONTACT_RATE_LIMIT_MAX = 50;
var CONTACT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1e3;
```

It does not work. Worker isolates are per-colo, numerous, and short-lived; this Map is
wiped on every cold start and shared with nothing. It stops a `for` loop in one tab and
nothing beyond that. Replace with the rate-limit binding below and delete the calls to
`contactCheckRateLimit`.

`customPriceRateLimitMap` has the same flaw. Out of scope here, but worth the same
treatment when someone next touches `/api/custom-size-price`.

---

## Configuration

### New secrets (`wrangler secret put`)

| Name | Value |
|---|---|
| `N8N_REVIEWS_WEBHOOK_URL` | Flow A, review intake |
| `N8N_REVIEWS_READ_URL` | Flow B, review read |
| `N8N_CONTACT_WEBHOOK_URL` | Flow C, contact intake |
| `N8N_SHARED_SECRET` | `X-Polyplaces-Secret` value, `openssl rand -hex 32` |
| `TURNSTILE_SECRET_KEY` | From the Turnstile widget |
| `IP_HASH_SALT` | `openssl rand -hex 16`. Never rotate casually — rotation orphans existing `source_ip_hash` values |

### New rate-limit bindings (`wrangler.jsonc`)

```jsonc
"ratelimits": [
  { "name": "RL_REVIEWS", "namespace_id": "1001", "simple": { "limit": 3,  "period": 60 } },
  { "name": "RL_CONTACT", "namespace_id": "1002", "simple": { "limit": 5,  "period": 60 } },
  { "name": "RL_GLOBAL",  "namespace_id": "1003", "simple": { "limit": 60, "period": 60 } }
]
```

Free on all plans, including this zone's Free plan. `period` accepts only `10` or `60`
seconds — the "3 per 10 minutes" intent is expressed as 3/60s, which is strict enough
in practice given a human submits one review. Limits are per-colo, not global; that is
fine for abuse control and is the reason `RL_GLOBAL` exists as a backstop.

`namespace_id` values are arbitrary but must be unique and stable within the worker.

---

## `GET /api/reviews`

```
GET /api/reviews?limit=12&cursor=0
```

| Param | Type | Default | Rule |
|---|---|---|---|
| `limit` | integer | 12 | Clamped 1–24. Non-numeric → default |
| `cursor` | string | `"0"` | Opaque to the client; currently the numeric offset. Non-numeric or negative → `0` |

No auth. CORS-gated by the existing middleware.

### Response — 200

```jsonc
{
  "reviews": [
    { "id": "rv_01H…", "name": "Tom H.", "location": "London, UK",
      "rating": 5, "title": "Best gift I've given", "body": "…",
      "createdAt": "2026-07-14T10:02:00Z" }
  ],
  "total": 47,
  "average": 4.8,
  "nextCursor": "12"
}
```

`nextCursor` is `null` when `offset + reviews.length >= total`.

### Behaviour

1. Parse and clamp params.
2. Cache lookup: `caches.default`, key = a normalised URL built from the *clamped*
   values, so `?limit=999` and `?limit=24` share one entry and a fuzzer cannot blow up
   cardinality.
3. Miss → `GET` `N8N_REVIEWS_READ_URL` with `X-Polyplaces-Secret` and
   `AbortSignal.timeout(8000)`.
4. **Re-filter on `status === 'approved'`.** n8n filters too. Two independent checks
   mean a disabled node or an inverted condition in a moderation branch cannot put spam
   on the homepage.
5. Map to the response shape. Drop every field not listed above — in particular `email`,
   `source_ip_hash`, `user_agent`, `moderation_note`, `order_ref`. If n8n over-returns,
   the worker is the last thing standing between a customer's email address and a public
   page.
6. `average`: use n8n's if present, else mean of the returned page's ratings, else `null`.
7. Store in cache with `Cache-Control: public, max-age=60, s-maxage=300`.

### Degradation — this endpoint never 5xxs

n8n error, timeout, malformed JSON, container down:

- serve the stale cached copy if there is one (`stale-if-error` semantics, done manually —
  keep a longer-lived copy under a `:stale` cache key), else
- return `200 {"reviews":[],"total":0,"average":null,"nextCursor":null}`.

The frontend treats an empty list as "show the three hardcoded fallback reviews". A 500
here would put an error state on the homepage because an automation container restarted;
an empty list quietly shows the old testimonials instead. Log the failure loudly, return
`200` regardless.

---

## `POST /api/reviews`

```jsonc
{
  "name": "Tom H.",
  "location": "London, UK",
  "rating": 5,
  "title": "Best gift I've given",
  "body": "I ordered a sculpture of the street where I proposed…",
  "email": "tom@example.com",
  "orderRef": "",
  "renderedAt": 1753872000000,
  "company": "",
  "turnstileToken": "0.abc…"
}
```

### Response — 202

```json
{ "status": "pending", "message": "Thanks — your review will appear once we've checked it." }
```

Always this body on success. Never echo moderation state, never reveal whether the
submission was auto-flagged — that turns the endpoint into an oracle a spammer can tune
against.

---

## `POST /api/contact`

Existing fields plus the three anti-abuse ones:

```jsonc
{
  "name": "Tom H.",
  "email": "tom@example.com",
  "subject": "commission",
  "message": "…",
  "renderedAt": 1753872000000,
  "company": "",
  "turnstileToken": "0.abc…"
}
```

→ `200 {"ok":true}`, unchanged from today.

Keep `app.post("/contact", …)` pointing at the same handler. `contact.js` is cached with
a content-hashed query string, but a browser holding the old file must not break during
a deploy window.

### Resend stays

The current handler emails `info@polyplaces.co.uk` via Resend with `reply_to` set to the
submitter. **Keep it, and keep awaiting it** — the response status reflects the Resend
send. Forward to n8n alongside via `c.executionCtx.waitUntil(...)`, fire-and-forget.

Your inbox then does not depend on the n8n container being up, and n8n still gets the
record for any automation you build on it. If n8n later owns the email entirely, delete
the Resend block deliberately rather than letting the two drift into sending duplicates.

---

## The five gates

Order matters — cheapest first, so a flood is rejected before it costs anything.

### 1. CORS

Existing middleware. No work. Bad origin → `403 {"error":"Not allowed by CORS"}`.

### 2. Rate limit

```js
const ip = getClientIp(c.req);
const { success } = await c.env.RL_REVIEWS.limit({ key: ip });
if (!success) throw new HttpError(429, "Too many requests. Please try again in a few minutes.");
const global = await c.env.RL_GLOBAL.limit({ key: "reviews" });
if (!global.success) throw new HttpError(429, "Too many requests. Please try again in a few minutes.");
```

Set `Retry-After: 60`. `RL_GLOBAL` is keyed on a constant, so it caps total throughput to
n8n regardless of how many IPs are involved — the per-IP limiter alone does nothing
against a botnet.

### 3. Shape

- `Content-Length` > 8192 → `400 "Request too large."` Check the header *before*
  `await c.req.json()`; parsing a hostile 10 MB body first is the mistake to avoid.
- Not JSON → `400 "Invalid JSON body."`
- Field caps, applied after trimming:

  | Field | Rule |
  |---|---|
  | `name` | required, 1–80 |
  | `location` | optional, ≤ 80 |
  | `rating` | required, integer, 1–5 (`5.0` and `"5"` are rejected — send a JSON number) |
  | `title` | optional, ≤ 120 |
  | `body` | **optional**, ≤ 2000. A star rating on its own is a valid review — do not impose a minimum length |
  | `email` | required, ≤ 254, `isValidEmail` |
  | `orderRef` | optional, ≤ 64 |
  | `message` (contact) | required, 10–4000 |

- Strip C0/C1 control characters except `\n` and `\t`; collapse runs of 3+ newlines.
- Reject if the URL characters in `body` exceed 60% of its length → `400 "Please remove
  links from your review."` A review with more link than prose is spam every time. Skip
  this check when `body` is empty — a rating-only review has nothing to measure, and a
  naive ratio check on an empty string divides by zero.
- Unknown keys: drop silently, don't 400. A future frontend field must not break an
  older worker.

Errors surface verbatim to the user, so keep them readable — same convention as
`checkout-endpoint-spec.md`.

### 4. Honeypot + timing → silent drop

- `company` must be absent or `""`.
- `now - renderedAt` must be ≥ 3000 ms and ≤ 6 h. Missing or non-numeric `renderedAt`
  fails the check.

On failure return **the normal success response** — `202`/`200`, identical body — and do
not forward. Log `event: "spam_drop"` with the reason.

This is the one gate that must not return an error. A bot that gets a `400` learns which
field betrayed it and adapts; a bot that gets a `200` and never sees its review appear
learns nothing. The timing bound is client-supplied and therefore spoofable — it costs
nothing and catches the majority of unsophisticated submitters, which is its whole job.
Turnstile is the gate that holds against someone actually trying.

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

Tokens are single-use and expire after 5 minutes; a replay fails at `siteverify`, which
is the point. A missing token is a `400`, not a silent drop — a legitimate user with a
broken widget needs to see the error.

If `siteverify` itself is unreachable, **fail closed** (`400`). Turnstile being down is
rare; an open failure mode is an advertised bypass.

---

## Forwarding to n8n

Only after all five gates:

```js
await fetch(c.env.N8N_REVIEWS_WEBHOOK_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Polyplaces-Secret": c.env.N8N_SHARED_SECRET,
  },
  body: JSON.stringify({
    submissionId: crypto.randomUUID(),
    name, location, rating, title, body, email, orderRef,
    sourceIpHash: await sha256Hex(ip + c.env.IP_HASH_SALT),
    userAgent: (c.req.header("User-Agent") ?? "").slice(0, 255),
    receivedAt: new Date().toISOString(),
  }),
  signal: AbortSignal.timeout(10_000),
});
```

**No retry.** A retried review can produce two rows; `submission_id`'s unique index is
the backstop, but a lost review is a better failure than a duplicated one. On failure,
log and return `500 {"error":"Could not submit your review. Please try again shortly."}`.

`sha256Hex` is a small helper over `crypto.subtle.digest("SHA-256", …)` — n8n gets a
stable per-visitor identifier for spotting repeat spammers, and no IP address is ever
stored.

---

## Optional: a WAF rate-limiting rule

This zone (`polyplaces.co.uk`, `46a1356466de1b0516cf5b624fa8bc5c`) is on the Free plan,
which includes one rate-limiting rule. Spend it here:

```
Expression:  http.host eq "api.polyplaces.co.uk"
             and http.request.method eq "POST"
             and starts_with(http.request.uri.path, "/api/reviews")
Rate:        20 requests / 1 min, per IP
Action:      Block, 10 min
```

This blocks at the edge before the worker is invoked, so a flood costs zero worker
invocations rather than merely being rejected cheaply inside one. Belt and braces with
the binding, not a replacement — the binding gives per-route granularity the single free
rule can't.

---

## Errors

| Status | Message | Cause |
|---|---|---|
| 400 | `Invalid JSON body.` | Body is not JSON |
| 400 | `Request too large.` | `Content-Length` > 8192 |
| 400 | `Missing required field: <f>` | Required field absent/blank |
| 400 | `Field too long: <f>` | Over cap |
| 400 | `Invalid email address` | `isValidEmail` failed |
| 400 | `Rating must be a whole number between 1 and 5.` | Bad `rating` |
| 400 | `Please remove links from your review.` | URL-dense body |
| 400 | `Verification failed. Please refresh and try again.` | Turnstile failed/missing/unreachable |
| 403 | `Not allowed by CORS` | Origin not allowlisted |
| 429 | `Too many requests. Please try again in a few minutes.` | Rate limited |
| 500 | `Could not submit your review. Please try again shortly.` | n8n unreachable |
| 500 | `Failed to send message` | Resend failed (existing contact behaviour) |

`GET /api/reviews` has no error path — see Degradation.

---

## Verification

```bash
API=https://api.polyplaces.co.uk
ORIGIN='Origin: https://polyplaces.co.uk'

# read works, is cached, exposes no email
curl -s "$API/api/reviews?limit=3" -H "$ORIGIN" | jq
curl -s "$API/api/reviews?limit=3" -H "$ORIGIN" | grep -c '"email"'   # expect 0

# limit clamping
curl -s "$API/api/reviews?limit=999" -H "$ORIGIN" | jq '.reviews | length'  # expect <= 24

# rate limit
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/api/reviews" \
    -H "$ORIGIN" -H 'Content-Type: application/json' -d '{}'
done                                                    # expect 429 after the 3rd

# body cap — rejected before parsing
head -c 20000 /dev/zero | tr '\0' 'a' > /tmp/big.txt
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/api/reviews" \
  -H "$ORIGIN" -H 'Content-Type: application/json' \
  --data-binary "{\"body\":\"$(cat /tmp/big.txt)\"}"    # expect 400

# CORS
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/api/reviews" \
  -H 'Origin: https://evil.example' -d '{}'             # expect 403

# n8n is protected, not merely hidden — the check that matters
curl -s -o /dev/null -w "%{http_code}\n" -X POST '<n8n webhook URL>' -d '{}'   # expect 401
```

Then, through the site:

- [ ] Honeypot filled via DevTools → success response, **zero** new n8n executions
- [ ] Submit within 3 s of page load → same silent drop
- [ ] Tampered Turnstile token → `400`
- [ ] Valid submission → `202`, row lands as `pending`, absent from `GET /api/reviews`
- [ ] Approve in n8n → visible within 5 min (cache TTL)
- [ ] Contact form → `200`, Resend email arrives **and** Flow C execution fires
- [ ] Replay the same `submission_id` → one row
- [ ] Stop the n8n container → `GET /api/reviews` still `200`, homepage shows fallbacks

---

## Known gaps

- **Rate limits are per-colo.** The Workers binding is not globally consistent. A
  distributed attacker gets one bucket per Cloudflare location. `RL_GLOBAL` narrows this
  but does not close it; the WAF rule above is the real answer at scale.
- **`renderedAt` is client-supplied** and therefore spoofable. It is a cheap filter, not
  a control. Turnstile carries the weight.
- **`cursor` is a raw offset.** Rows inserted between pages shift the window slightly.
  Acceptable for reviews; a real keyset cursor on `approved_at` would fix it if volume
  ever justifies the work.
- **No email verification on reviews.** Anyone can submit under any name. Moderation is
  the control; `order_ref` is there if you later want to require proof of purchase.
