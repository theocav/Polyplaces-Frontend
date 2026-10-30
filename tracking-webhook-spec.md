# Backend Spec: server-side purchase tracking (Stripe webhook → GA4 + Meta)

## Purpose

Stripe Checkout is hosted on checkout.stripe.com, so no tracking script runs
there. The browser reports `purchase` when the customer lands back on
`?checkout=success`, but that misses anyone who closes the tab, pays on another
device, blocks scripts or clears storage - and it only knows the cart total,
not what Stripe actually charged after promo codes and shipping.

The source of truth is Stripe's `checkout.session.completed` webhook. On it the
API worker sends the purchase to:

- **GA4 Measurement Protocol** - `purchase`, deduplicated against the browser
  event by `transaction_id`.
- **Meta Conversions API (CAPI)** - `Purchase`, deduplicated against the Pixel
  event by `event_id`.

Both only when the customer accepted analytics cookies on the site
(`attribution` present on the checkout request).

---

## 1. `POST /api/checkout` - new optional field

The frontend now adds `attribution` to the body when the visitor has consented.
It is absent otherwise. Unknown today; the handler must accept and store it.

```jsonc
{
  "items": [ /* unchanged */ ],
  "attribution": {
    "gaClientId": "1234567890.1730000000",   // GA4 client_id, nullable
    "gaSessionId": "1730000000",             // GA4 session_id, nullable
    "fbp": "fb.1.1730000000000.123456789",   // _fbp cookie, nullable
    "fbc": "fb.1.1730000000000.IwAR..."      // _fbc cookie or built from fbclid, nullable
  }
}
```

Validation: each value a string ≤ 200 chars or null; drop anything else. Never
fail checkout over this field.

Store on the session metadata (also mirrored to `payment_intent_data.metadata`
as today):

| Metadata key | From |
|---|---|
| `ga_client_id` | `attribution.gaClientId` |
| `ga_session_id` | `attribution.gaSessionId` |
| `fbp` | `attribution.fbp` |
| `fbc` | `attribution.fbc` |
| `analytics_consent` | `"1"` when `attribution` was sent, else omit |

Also record the request's `User-Agent` and client IP (`CF-Connecting-IP`) as
`client_ua` / `client_ip` - Meta CAPI uses them for matching. Only when
`analytics_consent` is set.

Make sure `success_url` carries the session id:
`https://polyplaces.co.uk/?checkout=success&session_id={CHECKOUT_SESSION_ID}`.
The browser event uses it as `transaction_id` and in its `event_id`.

---

## 2. `POST /api/stripe/webhook`

Verify the `Stripe-Signature` header with `STRIPE_WEBHOOK_SECRET` (raw body,
`stripe.webhooks.constructEventAsync` on Workers). Respond `200` fast; do the
outbound calls in `ctx.waitUntil`.

### `checkout.session.completed`

Skip when `metadata.analytics_consent !== "1"` or `payment_status !== "paid"`.

Fetch line items (`stripe.checkout.sessions.listLineItems(id)`).

**GA4 Measurement Protocol**

```
POST https://www.google-analytics.com/mp/collect?measurement_id=G-XEPWHQVWZY&api_secret=<GA4_API_SECRET>
```

```jsonc
{
  "client_id": "<metadata.ga_client_id>",
  "events": [{
    "name": "purchase",
    "params": {
      "transaction_id": "<session.id>",          // same as the browser event
      "value": <session.amount_total / 100>,
      "currency": "GBP",
      "shipping": <session.total_details.amount_shipping / 100>,
      "coupon": "<promotion code, if any>",
      "session_id": "<metadata.ga_session_id>",  // ties it to the visit
      "engagement_time_msec": 1,
      "items": [ { "item_id": "<price.id>", "item_name": "<description>",
                   "price": <unit_amount / 100>, "quantity": <quantity> } ]
    }
  }]
}
```

Without `ga_client_id`, skip GA (a made-up client id creates a phantom user).
`GA4_API_SECRET`: GA4 Admin → Data streams → web stream → Measurement Protocol
API secrets.

**Meta Conversions API**

```
POST https://graph.facebook.com/v21.0/1684282595954858/events?access_token=<META_CAPI_TOKEN>
```

```jsonc
{
  "data": [{
    "event_name": "Purchase",
    "event_time": <session.created or now, unix seconds>,
    "event_id": "purchase_<session.id>",          // matches the Pixel event
    "action_source": "website",
    "event_source_url": "https://polyplaces.co.uk/",
    "user_data": {
      "em": ["<sha256(lowercased trimmed customer_details.email)>"],
      "ph": ["<sha256(digits-only phone), if collected>"],
      "zp": ["<sha256(lowercased postcode, no spaces)>"],
      "country": ["<sha256('gb')>"],
      "fbp": "<metadata.fbp>",
      "fbc": "<metadata.fbc>",
      "client_ip_address": "<metadata.client_ip>",
      "client_user_agent": "<metadata.client_ua>"
    },
    "custom_data": {
      "currency": "GBP",
      "value": <session.amount_total / 100>,
      "content_ids": ["<price ids>"],
      "content_type": "product",
      "num_items": <line item count>
    }
  }]
}
```

`META_CAPI_TOKEN`: Events Manager → dataset 1684282595954858 → Settings →
Conversions API → Generate access token. Test with `test_event_code` from the
Events Manager "Test events" tab before going live.

### `checkout.session.expired`

Optional. With consent and `ga_client_id`, send GA4 `checkout_abandoned`
(`value`, `currency`, `transaction_id`) so the funnel shows drop-off at Stripe.

### Failures

Log and move on - tracking must never make the webhook return non-2xx, or
Stripe retries and order fulfilment logic downstream may run twice.

---

## Secrets

| Name | Where |
|---|---|
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Developers → Webhooks → endpoint |
| `GA4_API_SECRET` | GA4 Measurement Protocol API secret |
| `META_CAPI_TOKEN` | Meta Events Manager Conversions API token |

Set with `wrangler secret put`. None of them go in the frontend.

---

## Frontend events this pairs with

| Browser event | Server event | Dedup key |
|---|---|---|
| GA4 `purchase` | MP `purchase` | `transaction_id = session.id` |
| Pixel `Purchase` | CAPI `Purchase` | `event_id = "purchase_" + session.id` |
