# Backend Spec: POST /api/checkout

## Purpose

Frontend posts the cart here. Backend validates every price against live Stripe
data, builds `line_items`, attaches fulfilment metadata, creates a Stripe Checkout
Session, and returns the hosted-checkout URL for redirect.

The backend never trusts client-supplied prices. Every `priceId` is checked
against the account's active prices *and* against what that price actually is —
a frame price cannot be sold as a print, and a print price cannot be sold as a
frame. The only client-influenced amount is the custom-size print, recalculated
server-side from `widthMm`/`heightMm`.

Handler: `app.post('/api/checkout')` in `src/worker.js`.

---

## TL;DR for the frontend

Send this per cart item. Everything below is implemented and live in the handler.

```jsonc
{
  "items": [
    {
      "priceId": "price_1TOPSTLEGOIbuY1TZ9TufvQM",  // required
      "productId": "prod_UN9mz4xq0BJ1AJ",
      "sizeCode": "3",
      "quantity": 1,                                 // optional, default 1, max 99

      "framed": true,                                // send explicitly, always
      "frame": {                                     // required iff framed === true
        "productId": "prod_UNfr4me00001",
        "priceId": "price_1Tyfs7LEGOIbuY1Tt0Iz73B6"
      },

      "bbox": { "south": 51.496, "west": -0.1044, "north": 51.5139, "east": -0.0755 },
      "location": "NatWest, Greater London, United Kingdom"
    }
  ]
}
```

Unframed item: `"framed": false` and **no** `frame` key.

**IDs only.** Colour, frame key and everything else about the frame are read from
the Stripe product server-side — `productId` already determines them. Extra keys
inside `frame` are ignored rather than trusted: sending `"frameKey": "walnut"` on
an oak frame changes nothing about what ships.

Both IDs come from `GET /api/products` → `framePrices[<print's frameKey>][n]`.
Never construct or cache them.

---

## Endpoint

```
POST /api/checkout
Content-Type: application/json
```

No authentication. CORS-gated: the `Origin` header must match `FRONTEND_URL`
(comma-separated allowlist) or, when `ALLOW_LOCALHOST_ORIGINS=true`, any
`http://localhost:<port>` / `http://127.0.0.1:<port>`. A disallowed origin gets
`403 {"error":"Not allowed by CORS"}` before the handler runs.

---

## Request body

```jsonc
{
  "items": [ /* 1–50 item objects */ ],

  // Optional. First non-empty wins; item-level fields are also consulted.
  // Used only for the "Map location: …" note on the Stripe Checkout page.
  "locationLabel": "Greater London, United Kingdom"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `items` | array | **yes** | Non-empty, max 50 (`MAX_CHECKOUT_ITEMS`) |
| `locationLabel` | string \| object | no | Also read from `location`, `frameLocation`, `selectedLocation`, `reverseGeocode`, `geocode`, `mapLocation`. Objects are read via `label` / `name` / `title` / `display_name` / `displayName` / `formatted` / `formatted_address` |

### Item: identity, price, quantity

| Field | Type | Required | Rule |
|---|---|---|---|
| `priceId` | string | **yes** | Active Stripe price ID, or the literal `"custom"`. Must belong to a product whose `metadata.type` is **not** `"frame"` |
| `productId` | string | no | Fulfilment metadata (`metadata.productIds`) |
| `sizeCode` | string | no | Fulfilment metadata (`metadata.sizeCodes`) |
| `quantity` | integer | no | Default `1`. Range 1–99 (`MAX_ITEM_QUANTITY`). Applies to the print *and* its frame |

### Item: frame

| Field | Type | Required | Rule |
|---|---|---|---|
| `framed` | boolean | recommended | `true` → `frame` object required. `false` → `frame` must be absent. Any non-boolean (`"yes"`, `1`) is a 400 |
| `frame.productId` | string | **iff framed** | Must be the price's real owner, and its `metadata.type` must be `"frame"` |
| `frame.priceId` | string | **iff framed** | Active Stripe price, non-empty, must not start with `fallback_` |

Those two IDs are the entire frame contract. Any other key inside `frame`
(`frameKey`, `colourName`, `colourHex`, …) is **ignored** — the backend reads
those from the Stripe product, so client-side values cannot drift from or
override what Stripe says.

Send `framed` on **every** item, including unframed ones. The redundancy with the
`frame` object is deliberate: the original bug was a frame silently vanishing
because its presence had to be *inferred*.

Compatibility checks performed server-side, all 400 on failure:

- `frame.priceId` resolves to a real active price
- that price's product has `metadata.type === "frame"`
- `frame.productId` matches the price's actual product
- the **print's** `metadata.frameKey` matches the frame product's `metadata.frameFor` —
  both read from Stripe, so a mismatched frame is caught regardless of what the
  client claims

### Item: custom size (`priceId === "custom"`)

| Field | Type | Required | Rule |
|---|---|---|---|
| `customWidthMm` | integer | **yes** | `MIN_SIZE_MM` ≤ v ≤ `MAX_SIZE_MM` (currently 100–330) |
| `customHeightMm` | integer | **yes** | Same |

Price computed by `calculateCustomPrice`:
`round((round(areaSqm × RATE_PER_SQM_PENCE) + FIXED_COST_PENCE + (500 if either dimension ≥ 300mm)) / (1 − MARGIN))`.
Preview the identical figure via `GET /api/custom-size-price?widthMm=&heightMm=`.

Custom items are still validated for frames — `framed` + `frame` work normally.

### Item: map geometry & labels

All optional, none affect price.

| Field | Aliases | Becomes |
|---|---|---|
| `bbox` | `frameBbox`, `bounds` | `metadata.bbox` / `metadata.bboxes` (`\|`-joined), serialized `south,west,north,east`. Non-finite values drop it silently |
| `frameCoordinates` | `coordinates` | `metadata.frameCoordinates` / `metadata.frameCoordinatesList`. Strings pass through; objects are JSON-stringified |
| `location` | `locationLabel`, `frameLocation` | Checkout-page note; also `product_data.metadata.location` on custom items |

Derived, always set: `metadata.framed` — comma-joined indices of framed items, or
`"none"`.

> **Changed:** `item.frame` is no longer a coordinate source. It previously fell
> through to `metadata.frameCoordinates`; it now carries the frame selection
> object. Send geometry as `frameCoordinates` or `coordinates`.

**Stripe metadata limits:** 50 keys, 500 chars per value. Longer values are
auto-chunked into `key_1`, `key_2`, … so a large cart of verbose coordinate
payloads can approach the key ceiling. Prefer `bbox` over full ring geometry.

### Ignored fields

Accepted without error, discarded by design: `center`, `rotation`, `zoom`,
`customLabel`.

---

## Line items sent to Stripe

Per cart item, in order:

1. **The print** — `{ price: <priceId>, quantity: <quantity> }`, or for
   `"custom"`, inline `price_data` (GBP, server-computed `unit_amount`, product
   name `"Custom Map Print"`, description `"<W>×<H>mm custom size"`).
2. **The frame**, when framed — `{ price: <frame.priceId>, quantity: <quantity> }`,
   immediately after its print. One frame per print, so quantities track.

A framed print is **two line items** on the Stripe page. Session options:
`mode: payment`, `allow_promotion_codes: true`, shipping collection for
`GB, US, CA, AU, NZ, IE`, metadata mirrored onto `payment_intent_data`.

---

## Responses

**200**
```json
{ "url": "https://checkout.stripe.com/c/pay/cs_live_..." }
```
Redirect the browser to it.

**Errors** — all `{"error": "<message>"}`; a `detail` object is added when
`DEBUG_VERBOSE=true`. `N` is the zero-based cart index.

| Status | Message | Cause |
|---|---|---|
| 400 | `Invalid JSON body.` | Body is not JSON |
| 400 | `Cart is empty.` | `items` missing/empty/not an array |
| 400 | `Too many items.` | > 50 items |
| 400 | `Cart items must include priceId.` | Any item missing `priceId` |
| 400 | `Invalid item.` | `priceId` is not an active Stripe price |
| 400 | `Item N: this price is a frame, not a print` | Frame price used in the print slot |
| 400 | `Item N: framed is true but no frame was provided` | Missing `frame` object |
| 400 | `Item N: frame provided but framed is not true` | Contradictory fields |
| 400 | `Item N: framed must be a boolean` | `"yes"`, `1`, etc. |
| 400 | `Item N: frame.priceId is required when framed is true` | Frame object without a price |
| 400 | `Item N: frame.productId is required` | Frame object with a price but no product |
| 400 | `Item N: product is not a frame` | Frame product lacks `metadata.type === "frame"` |
| 400 | `Item N: frame price does not belong to frame product` | `frame.productId` ↛ `frame.priceId` |
| 400 | `Item N: frame does not fit this print` | Print's `frameKey` ≠ frame product's `frameFor` |
| 400 | `Item N: quantity must be an integer between 1 and 99` | Bad quantity |
| 400 | `Frame pricing is unavailable. Please reload and try again.` | Frame price empty or `fallback_*` |
| 400 | `Invalid frame selection.` | Frame price is not an active Stripe price |
| 400 | `Custom item missing dimensions` / `must be integers` / `out of range` | Custom-size validation |
| 400 | `Pricing misconfigured: …` | Server-side pricing env vars bad |
| 403 | `Not allowed by CORS` | Origin not allowlisted |
| 501 | `Stripe is not configured. Set STRIPE_SECRET_KEY.` | Missing secret |
| 500 | `Unable to create checkout session.` | Stripe/network failure |

Surface `error` verbatim for 400s — they are written to be user-readable, and the
`Item N:` prefix tells you which cart row to highlight.

---

## Where the IDs come from

`GET /api/products`:

```jsonc
{
  "products": [
    { "id": "prod_…", "priceId": "price_…", "sizeCode": "3",
      "frameKey": "oak", "displaySize": "297x420", "aspectRatio": 0.7,
      "unitAmount": 9900, "currency": "gbp", "sortOrder": 1 }
  ],
  "framePrices": {
    "oak": [
      { "productId": "prod_…", "priceId": "price_…", "unitAmount": 2500,
        "frameKey": "oak", "colourHex": "#8B5A2B", "colourName": "Oak" }
    ]
  },
  "warnings": [ /* products Stripe returned that the backend could not use */ ]
}
```

Frame options for a print = `framePrices[product.frameKey]`.

Use `colourHex` / `colourName` / `unitAmount` to **render** the picker. Send back
only `productId` and `priceId` — the backend re-derives the rest from Stripe.

`warnings` is informational: entries there are misconfigured in Stripe and were
excluded from the catalogue. Not an error; safe to ignore in the UI, useful in
logs.

---

## Legacy payload (v1) — still accepted

Deprecated but functional, so an old client cannot break mid-deploy:

| Shape | Behaviour |
|---|---|
| `framePriceId: "price_…"` (flat, no flag) | Presence implies framed |
| `frame: true \| 1 \| "true" \| "yes" \| "y" \| "on" \| "framed"` + `framePriceId` | Framed |
| `frame: false \| 0 \| "false" \| "no" \| "off" \| "none" \| ""` | Not framed |
| `frame: { … }` with no `priceId` | Ignored — treated as a legacy coordinates object, not a frame |

Legacy frame payloads log `checkout_payload_v1` with the item indices. Watch that
event; when it stops appearing in production, v1 handling can be deleted.

v1 payloads carry no `frame.productId`, so the ownership check is skipped. The
`metadata.type === "frame"` check and the print↔frame fit check still apply, so a
v1 frame whose Stripe product is misconfigured now returns 400 rather than
silently dropping the frame.

---

## Examples

**Framed print, quantity 2**
```json
{ "items": [ {
  "priceId": "price_1TOPSTLEGOIbuY1TZ9TufvQM",
  "productId": "prod_UN9mz4xq0BJ1AJ",
  "sizeCode": "3",
  "quantity": 2,
  "framed": true,
  "frame": {
    "productId": "prod_UNfr4me00001",
    "priceId": "price_1Tyfs7LEGOIbuY1Tt0Iz73B6"
  },
  "bbox": { "south": 51.496, "north": 51.5139, "west": -0.1044, "east": -0.0755 },
  "location": "NatWest, Greater London, United Kingdom"
} ] }
```
→ `line_items`: print ×2, frame ×2.

**Unframed print**
```json
{ "items": [ {
  "priceId": "price_1TOPSTLEGOIbuY1TZ9TufvQM",
  "productId": "prod_UN9mz4xq0BJ1AJ",
  "sizeCode": "3",
  "framed": false,
  "bbox": { "south": 51.496, "north": 51.5139, "west": -0.1044, "east": -0.0755 }
} ] }
```

**Unframed custom size**
```json
{ "items": [ {
  "priceId": "custom", "framed": false,
  "customWidthMm": 250, "customHeightMm": 300,
  "location": "NatWest, Greater London, United Kingdom"
} ] }
```

---

## Frontend migration checklist

- [ ] Read `framePrices[frameKey][n]`; keep `productId` + `priceId` for the
      payload, and the colour fields for display only
- [ ] Emit `framed: true|false` on every item
- [ ] Emit `frame: { productId, priceId }` only when `framed === true` — no
      colour or frameKey fields; they are ignored
- [ ] Stop sending flat `framePriceId`
- [ ] Stop using `frame` for coordinates — use `frameCoordinates`
- [ ] Send `quantity` if the UI has a stepper; otherwise omit
- [ ] Render 400 `error` strings directly; `Item N:` maps to `items[N]`
- [ ] Refetch `/api/products` on checkout failure — stale price IDs 400

---

## Known gaps

- **No idempotency key.** A double-submit creates two sessions.
- **Print-slot check is `type !== 'frame'` only.** A print product missing
  `sizeCode` is allowed through (logged as `item_product_missing_size_code`),
  since `/api/products` already refuses to serve such products.
- **`rotation`, `zoom`, `center` are discarded.** If fulfilment ever needs the
  exact render parameters, they must be added to metadata.
