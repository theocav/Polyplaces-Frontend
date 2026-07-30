# n8n Spec: Reviews & Contact

What n8n owns, what the Worker owns, and the exact shapes crossing between them.

The Worker (`api.polyplaces.co.uk`) is the only thing that ever talks to n8n. The
browser never sees an n8n URL. n8n's job is storage, moderation and notification —
not validation, not rate limiting, not bot filtering. Those are all done before the
request arrives.

Three webhooks to build:

| Flow | Method | Called by | Purpose |
|---|---|---|---|
| A | `POST` | Worker `POST /api/reviews` | Store a new review as `pending`, moderate |
| B | `GET`  | Worker `GET /api/reviews`  | Return approved reviews |
| C | `POST` | Worker `POST /api/contact` | Record a contact enquiry |

---

## Auth — do this first

Every webhook node uses the **same Header Auth credential**:

```
Header name:  X-Polyplaces-Secret
Header value: <long random string>
```

Generate with `openssl rand -hex 32`. The same value goes into the Worker as the
`N8N_SHARED_SECRET` secret.

This is the layer that matters if a webhook URL ever leaks — and URLs do leak, via
logs, screenshots, browser history, n8n's own UI. Obscurity is not the protection;
this header is. A `curl` at the raw webhook URL without it must return `401`.

Test it before building anything else:

```bash
curl -i -X POST '<webhook URL>' -d '{}'                                  # expect 401
curl -i -X POST '<webhook URL>' -H 'X-Polyplaces-Secret: <secret>' -d '{}' # expect 200
```

---

## Data Table: `reviews`

| Column | Type | Written by | Notes |
|---|---|---|---|
| `id` | string, PK | n8n | `rv_` + ULID |
| `submission_id` | string, **unique** | Worker | UUIDv4, one per HTTP request. The unique index is what makes a retry safe |
| `name` | string | Worker | ≤ 80 chars, trimmed. Displayed as typed |
| `location` | string | Worker | ≤ 80, may be `""` |
| `rating` | integer | Worker | 1–5, already validated |
| `title` | string | Worker | ≤ 120, may be `""` |
| `body` | string | Worker | 20–2000 |
| `email` | string | Worker | ≤ 254. **Moderation only. Never leaves n8n** |
| `order_ref` | string | Worker | optional; lets you verify a real purchase |
| `status` | enum | n8n | `pending` \| `approved` \| `rejected`. Default `pending` |
| `moderation_note` | string | n8n | why it was rejected/flagged |
| `created_at` | ISO 8601 | n8n | insert time |
| `approved_at` | ISO 8601 | n8n | null until approved. **This is the sort key for display** |
| `source_ip_hash` | string | Worker | `SHA-256(ip + salt)`, hex. Spot a repeat spammer without storing an IP |
| `user_agent` | string | Worker | ≤ 255, truncated |

### The one rule that must not break

**Flow B returns rows where `status = 'approved'` and nothing else.**

The Worker filters on `status` a second time after receiving the response. That
redundancy is deliberate: a mistake in a moderation branch — an inverted condition,
a node left disabled — cannot then put spam on the homepage. Keep `status` in the
Flow B projection so the Worker has something to check.

### Unique index

`submission_id` must be a unique constraint, not just a convention. The Worker does
not retry failed n8n calls specifically because a duplicate review is worse than a
lost one, but a network-level replay is still possible. On conflict, ignore the
insert and return success.

---

## Flow A — review intake

**Trigger:** Webhook, `POST`, Header Auth, **Respond: Immediately** (`200`).

Respond before moderation runs. The Worker aborts at 10 s, and the submitter is
watching a spinner — moderation can take as long as it likes after the response.

**Body received from the Worker** (already validated and sanitised — lengths capped,
control characters stripped, rating an integer 1–5, email syntactically valid):

```jsonc
{
  "submissionId": "3f9c…",
  "name": "Tom H.",
  "location": "London, UK",
  "rating": 5,
  "title": "Best gift I've given",
  "body": "I ordered a sculpture of the street where I proposed…",
  "email": "tom@example.com",
  "orderRef": "",
  "sourceIpHash": "9f2b…",
  "userAgent": "Mozilla/5.0 …",
  "receivedAt": "2026-07-30T09:14:22.418Z"
}
```

**Nodes:**

1. **Insert** into `reviews`, `status = 'pending'`, `created_at = now()`.
2. **Moderate.** Anything from a keyword list to an AI classification node. Suggestions
   in rough order of value:
   - reject if `body` contains a URL (near-universal spam signal on a review form)
   - reject on a profanity/keyword list
   - flag if `source_ip_hash` already has ≥ 3 rows in the last 24 h
   - flag if `email` domain is a known disposable provider
   - an LLM node scoring "is this a plausible review of a 3D-printed map sculpture?"
3. **Notify** — Telegram/email/Slack with the body and two links: approve and reject.
   Approving sets `status = 'approved'` and `approved_at = now()`.

Auto-approving is a choice you can make later. Start manual; the volume will be low
and you'll learn what the spam actually looks like.

**Cache note:** the site caches reads for 5 minutes, so an approval shows up within
5 minutes, not instantly. Expected, not a bug.

---

## Flow B — review read

**Trigger:** Webhook, `GET`, Header Auth, **Respond: Using Respond to Webhook node**.

**Query params from the Worker:** `limit` (1–24, already clamped), `offset` (integer ≥ 0).

**Nodes:**

1. Query `reviews` where `status = 'approved'`, order by `approved_at DESC`, apply
   `limit` and `offset`.
2. Count total approved rows (unpaginated) — this drives the "47 reviews" line and the
   average on the page.
3. Respond.

**Response shape:**

```jsonc
{
  "rows": [
    { "id": "rv_01H…", "name": "Tom H.", "location": "London, UK",
      "rating": 5, "title": "Best gift I've given", "body": "…",
      "status": "approved", "approved_at": "2026-07-14T10:02:00Z" }
  ],
  "total": 47,
  "average": 4.8
}
```

**Project only those fields.** `email`, `source_ip_hash`, `user_agent`,
`moderation_note` and `order_ref` must not appear — this response is one Worker hop
from a public page, and a `SELECT *` here is how customer email addresses end up
in someone's DevTools.

If computing `average` in n8n is awkward, omit it; the Worker falls back to averaging
the returned page, which is close enough for a display figure.

**Empty table is not an error.** Return `{"rows":[],"total":0}` with `200`. The site
renders its static fallback reviews in that case.

---

## Flow C — contact intake

**Trigger:** Webhook, `POST`, Header Auth, **Respond: Immediately**.

```jsonc
{
  "submissionId": "7a41…",
  "name": "Tom H.",
  "email": "tom@example.com",
  "subject": "commission",          // general | commission | order | other
  "message": "…",
  "sourceIpHash": "9f2b…",
  "userAgent": "Mozilla/5.0 …",
  "receivedAt": "2026-07-30T09:14:22.418Z"
}
```

Do what you like downstream — a `contacts` table, a CRM, a Telegram ping.

**The Worker keeps sending the notification email via Resend**, and that send is what
the response status is based on. So your inbox does not depend on the n8n container
being up. Flow C is the durable record and any richer automation on top; don't rebuild
the email unless you also delete the Resend block in the Worker.

---

## What n8n does *not* need to do

Handled entirely before the request reaches you. Don't duplicate it:

- rate limiting (Workers Rate Limiting binding, per-IP and global)
- bot filtering (Cloudflare Turnstile, verified server-side)
- honeypot and submit-timing checks (silently dropped — those requests never reach n8n at all)
- field length limits, type checks, email syntax, `rating` range
- CORS

If you see an execution, it already passed all of it. Your remaining job is content
judgement: is this a real review or spam prose that got through.

---

## Checklist

- [ ] Header Auth credential created, secret shared with the Worker
- [ ] `reviews` table created with a **unique** index on `submission_id`
- [ ] Flow A: insert as `pending`, respond immediately, notify
- [ ] Flow B: `status = 'approved'` filter, `approved_at DESC`, restricted projection
- [ ] Flow C: record enquiry
- [ ] `curl` without the header returns `401` on all three
- [ ] A `pending` row does not appear in Flow B's output
- [ ] Flow B's response contains no `email` field
