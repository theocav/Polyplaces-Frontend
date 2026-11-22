# Backend Spec: Landscape mode

## Purpose

The storefront now lets customers order a **Landscape** piece: the sculpture is
fabricated as terrain relief only, with **no buildings**. Landscape pieces also
cover much wider areas than normal ones (up to ~14km across), for hills,
coastline and countryside.

Today the backend does not read the flag at all, so a landscape order reaches
Stripe looking exactly like a normal order, and would be made **with**
buildings. This spec covers everything the backend needs so that the flag
survives checkout and reaches whoever makes the piece.

Frontend behaviour is described in `landscape-mode-spec.md`. The checkout
endpoint itself is described in `checkout-endpoint-spec.md`.

Handler: `app.post('/api/checkout')` in `src/worker.js`.

---

## TL;DR

1. **Read `item.landscape`** in `POST /api/checkout`. Only a literal `true`
   counts; anything else (missing, `"true"`, `1`) is `false`. Never 400 on it.
2. **Write `metadata.landscape`**: zero-based, comma-joined indices of landscape
   items, or `"none"`, exactly like `metadata.framed`. Mirror it onto the
   PaymentIntent like the other metadata.
3. **No price change.** `landscape` never affects `unit_amount`.
4. **Allow wide areas.** Landscape `bbox`es can be up to 7x the normal width. If
   any bbox size check exists or is added, use the limits below.
5. **Surface it in fulfilment.** Order notifications, the proof render and the
   fabrication pipeline must treat flagged items as terrain only.

Steps 1-3 are the blocker for shipping the feature. Until they are live,
landscape orders must not be accepted.

---

## What the frontend sends

Per cart item, alongside the existing fields:

```jsonc
{
  "priceId": "price_...",
  "productId": "prod_...",
  "sizeCode": "2000",
  "quantity": 1,
  "framed": false,

  "landscape": true,                 // NEW - boolean, always sent
  "bbox": { "south": 35.32, "west": 138.66, "north": 35.40, "east": 138.79 },
  "center": { "lat": 35.36, "lng": 138.73 },
  "rotation": 0,                     // 0 or 90
  "zoom": 4.5,                       // real scale factor, see below
  "location": "Mount Fuji, Shizuoka Prefecture, Japan"
}
```

- `landscape` is always present on carts built by the current frontend, as a
  real boolean (`!!item.landscape`). Carts saved in a visitor's browser before
  the feature shipped have no `landscape` key; treat those as `false`.
- `bbox` is already the **final area to sculpt**. It is computed from the piece
  size x `zoom`, and is the axis-aligned envelope after `rotation`. Fulfilment
  does not need `zoom` to know what area to make.
- `zoom` is the **real** scale factor:

  | Mode | Real range | Default | Shown to the customer |
  |---|---|---|---|
  | Normal | 0.7 - 1.3 | 1.0 | Same as real (e.g. `1.2x`) |
  | Landscape | 2.0 - 7.0 | 4.5 | Stretched to 2.0x - 10.0x |

  The landscape label is a linear stretch:
  `shown = 2 + (real - 2) x 8 / 5`. So real `7.0` is shown as `10.0x` and real
  `4.5` as `6.0x`. Support should expect customers to quote the shown number.

---

## Required changes

### 1. `POST /api/checkout`: read and persist `landscape`

**Parsing.** Per item:

```js
const landscape = item.landscape === true;
```

Do not accept truthy strings or numbers, and do not reject them either. The
field is fulfilment-affecting, so the safe failure is "not landscape, item
still valid", never a 400 that blocks checkout. The frontend always sends a
real boolean.

**Session metadata.** Add, always set:

| Key | Value | Example |
|---|---|---|
| `metadata.landscape` | Zero-based cart indices of landscape items, comma-joined, or `"none"` | `"0,2"`, `"none"` |

Same format and the same zero-based indexing as `metadata.framed`, so the two
can be read together. Mirror onto `payment_intent_data.metadata` with the rest.

Note that cart indices are **cart items**, not Stripe line items. A framed
print is two line items but one index.

**Custom-size items** (`priceId === "custom"`). Also set
`product_data.metadata.landscape` to `"true"` or `"false"` on the inline
product, next to the existing `product_data.metadata.location`. This keeps the
flag attached to the line item if session metadata is ever lost or truncated.

**Checkout page note (recommended).** The `location` field already becomes a
note on the Stripe page. For landscape items, append
`" - Landscape (no buildings)"` to that note. The customer then sees what they
are paying for one last time before paying.

**Pricing.** None. `landscape` must not change `unit_amount` for standard or
custom items, and must not change the frame line item.

**Metadata budget.** One extra key, at most ~200 chars for a 99-item cart. This
stays well inside Stripe's 50-key / 500-char limits and needs no chunking.

**Logging.** Include the landscape count in the existing checkout log line,
e.g. `landscape_items: 2`, so rollout can be watched.

### 2. Allow wide landscape areas

The backend currently accepts any finite `bbox` (non-finite values are dropped
silently) and has no size check. Nothing needs to change **unless** a check is
added, now or later. If one is, it must allow landscape areas:

| Size | `sizeCode` (m at 1x) | Normal max width | Landscape max width |
|---|---|---|---|
| Small | 500 | 650m | 3.5km |
| A4 (Medium) | 750 | 975m | 5.25km |
| Large | 2000 | 2.6km | **14km** |
| Custom (max 330mm) | 990 (`widthMm x 3`) | 1.29km | 6.93km |

Height is width x the product's aspect ratio (A4 is ~1.41). When rotated 90°,
width and height swap. Allow ~5% tolerance on top of these for rounding at
different latitudes.

### 3. Persist `zoom` (recommended)

`zoom` is still discarded today. `bbox` is enough to fabricate, but the zoom is
now a large and customer-visible number, and support will be asked about it.
Store it as:

| Key | Value | Example |
|---|---|---|
| `metadata.zooms` | Real zoom per cart item, `\|`-joined, one decimal | `"1.0\|4.5\|7.0"` |

Store the **real** value, not the shown one. Use the formula above to convert
if a customer quotes the shown number.

### 4. Fulfilment: treat flagged items as terrain only

Everything downstream of the Stripe session must read `metadata.landscape` and
act on it for the matching cart index:

- **Order notifications / admin view.** Show the flag prominently on the
  item, e.g. **"Landscape - terrain only, no buildings"**. It must not be
  possible to read an order and miss it.
- **Proof render.** The digital proof sent before production must be
  terrain only, so the customer approves what will actually be made.
- **Fabrication pipeline.** Omit building meshes and building footprints.
  Keep the terrain. Water handling: see open questions.
- **Order confirmation email** (if one is sent). Mention the landscape option
  on the item so it matches the cart and the checkout note.

---

## Backward compatibility

- Requests without `landscape` behave exactly as today, plus
  `metadata.landscape: "none"`.
- Old carts in visitors' browsers keep working with no migration.
- The legacy v1 frame payload described in `checkout-endpoint-spec.md` is
  unaffected; `landscape` is read the same way on both shapes.

---

## Acceptance checks

| Request | Expect |
|---|---|
| One item, `landscape: true` | 200, `metadata.landscape === "0"` on session and PaymentIntent |
| Three items, landscape on items 0 and 2 | `metadata.landscape === "0,2"` |
| No item has `landscape` | `metadata.landscape === "none"` |
| `landscape: "true"` (string) | 200, treated as `false`, `"none"` |
| Framed landscape print | Two line items, `metadata.framed === "0"` and `metadata.landscape === "0"` |
| Custom size, `landscape: true` | Inline product has `metadata.landscape === "true"`; price unchanged |
| Large landscape at 7x (bbox ~14km wide) | 200, bbox stored unchanged |
| Same cart with and without `landscape` | Identical `amount_total` |

---

## Example

**Landscape, Large, unframed, at the top of the range**

```json
{
  "items": [
    {
      "priceId": "price_1TOPSTLEGOIbuY1TZ9TufvQM",
      "productId": "prod_UN9mz4xq0BJ1AJ",
      "sizeCode": "2000",
      "quantity": 1,
      "framed": false,
      "landscape": true,
      "bbox": { "south": 35.297, "west": 138.650, "north": 35.424, "east": 138.805 },
      "center": { "lat": 35.3606, "lng": 138.7274 },
      "rotation": 0,
      "zoom": 7,
      "location": "Mount Fuji, Oyama, Sunto County, Shizuoka Prefecture, Japan"
    }
  ]
}
```

Resulting session metadata (relevant keys only):

```json
{
  "framed": "none",
  "landscape": "0",
  "zooms": "7.0",
  "bbox": "35.297,138.65,35.424,138.805"
}
```

---

## Open questions for fulfilment

- **Water.** The browser 3D preview models terrain, buildings, water and
  building footprints separately. Should landscape pieces keep water bodies
  (lakes, rivers, coastline), or be pure terrain?
- **Vertical exaggeration.** A Large piece at 7x shows ~14km on 32cm, about
  1:44,000. Real terrain at that scale reads almost flat. Does the pipeline
  need a stronger height exaggeration for landscape pieces, and should it
  scale with zoom?
- **Elevation data resolution.** The site now accepts locations worldwide.
  Confirm the elevation source covers the whole world at a resolution that
  holds up at the narrow end (Small, 2x, ~1km).

---

## Out of scope

- The 3D preview before add to cart runs entirely in the browser, with its own
  limits (0.25° for landscape, 0.1° otherwise). No backend change.
- `rotation` and `center` stay discarded. Orientation can be recovered by
  comparing the `bbox` aspect with the product's aspect ratio.

---

## Related backend fix (not landscape): UK-only delivery

The site now lets customers pick any location in the world but says delivery is
**UK addresses only** (FAQ, shipping page, store: "Free UK delivery").
`checkout-endpoint-spec.md` says the Checkout Session collects shipping for
`GB, US, CA, AU, NZ, IE`. That list must become **`["GB"]`**, or overseas
customers can pay for orders that cannot be delivered.

While in there:

- `POLYPLACES_SEARCH_COUNTRY_CODES` and `POLYPLACES_SEARCH_VIEWBOX` in
  `/api/config` are no longer read by the frontend and can be removed.
- `GET /api/reverse-geocode` is now called for locations worldwide. If it
  restricts results to the UK, remove that restriction so non-UK frames get a
  proper location label.
