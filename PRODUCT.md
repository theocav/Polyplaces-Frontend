# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two primary audiences: gift buyers purchasing a custom 3D map sculpture for someone else (anniversaries, weddings, moving-away, memorials), and self-purchasers commissioning a piece for a place meaningful to them (home, a hike, a trip). Corporate/commission inquiries exist (see homepage CTA for large-format and corporate commissions) but were not confirmed as a primary segment.

## Product Purpose

Polyplaces turns a chosen real-world UK location into a physical, tactile 3D topographic sculpture — customers pick an area and a scale, and the piece is sculpted to match that location's actual terrain.

## Positioning

The differentiator is topographic relief *alongside* real buildings in the same piece — not just terrain, and not just flat map art. Competing products (Etsy map-art sellers, generic laser-cut map shops) are typically flat-layered or terrain-only; Polyplaces combines true elevation relief with real building forms in one sculpture.

## Operating Context

- Store flow: choose location/area → pick scale (Small, A4, Large, or fully custom dimensions) → checkout.
- Backend: separate API at `api.polyplaces.co.uk` serves product/pricing data; a local `products-snapshot.json` is preloaded/cached for the storefront.
- Reviews are ingested via an n8n workflow (see `n8n-reviews-schema.md`).
- Checkout has its own documented endpoint spec (`checkout-endpoint-spec.md`).
- Site sections: home, store, about, care, contact, etsy (cross-listing), faq, privacy, shipping, terms, reviews.

## Capabilities and Constraints

- **UK-only fulfillment**: sculpts UK locations; scoped to UK customers/shipping.
- **Made-to-order**: no stock inventory — every piece is produced on demand; lead time is a real constraint to reflect honestly in copy, not paper over.
- Standard sizes: Small (20×20cm), A4, Large (32×32cm); custom dimensions/scale also available.
- Corporate/large-format commissions are offered via direct contact rather than self-serve checkout.

## Brand Commitments

Name: Polyplaces. Tagline voice example: "Your place. In relief." Tone is considered/tactile/keepsake-oriented rather than novelty-gift oriented (per existing meta copy: "thoughtful, personalized," "meaningful UK locations," "considerate, custom gift-giving").

## Evidence on Hand

- Real product imagery under `/assets/imgs/` (e.g. Small/A4/Large frame shots) referenced in structured data.
- Existing customer reviews pipeline (n8n-driven) — do not fabricate testimonials; use `/reviews` and the schema doc as the source of truth.
- No pricing figures were confirmed in this session — prices are fetched live from the API/snapshot, not hardcoded facts to restate.

## Product Principles

1. Sell the tactile, physical outcome — the piece someone will hold and display — not the ordering mechanics.
2. Lead with the combined relief-plus-buildings differentiator; don't let copy collapse it into generic "custom map art."
3. Respect made-to-order reality: never imply in-stock/instant fulfillment.
4. Keep scope UK-only in claims, imagery, and location examples unless this is explicitly revisited.
5. Preserve the considerate/keepsake tone over novelty-gift framing.
