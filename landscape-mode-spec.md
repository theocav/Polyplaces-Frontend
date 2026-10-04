# Spec: Landscape mode

## What changed

`store/` and `etsy/` (shared via `assets/js/app.js` and `assets/css/styles.css`)
gained a **Landscape mode** toggle next to the existing Rotate/Zoom frame
controls on the map.

Landscape mode means: the sculpture is fabricated as terrain relief only -
buildings are omitted from the piece. To support wide-area landscape shots
(hills, coastline, countryside) the zoom slider's range extends from its
normal 0.7-1.3x up to **10x** while the mode is active.

## Frontend changes

- **UI**: a `Landscape` pill button in `.frame-controls` (same row as Rotate
  and Zoom), styled with a new terrain-green palette (`--terrain`,
  `--terrain-lt`, `--terrain-bg`) so it reads as a distinct mode rather than
  another orange control.
- **Callout**: a floating banner (`.landscape-banner`) fades in over the map
  while active: "Landscape mode - terrain only, buildings are not printed."
- **Zoom range**: `#zoom-slider` max attribute flips between `1.3` (default)
  and `10` (landscape on). Turning landscape off clamps any zoom value above
  1.3 back down to 1.3.
- **Order summary** (store page only): a "Buildings: Not included" line
  appears in the order panel while landscape mode is active for the current
  selection.
- **Cart**: cart items carry `landscape: true|false`; the cart drawer shows a
  "Landscape - no buildings" tag on affected items.
- **State reset**: landscape mode resets to `false` whenever a new size is
  selected or the frame is cleared, same as rotation and zoom.

All of this lives in `applyLandscapeUI()` and the `landscape-toggle-btn`
handler in `assets/js/app.js`, plus the `landscapeMode` module-level flag.

## Backend contract change

`POST /api/checkout` items now include:

```jsonc
{
  "landscape": true // boolean, default false
}
```

This is **new** and, unlike the pre-existing `rotation`/`zoom`/`center`
fields (which the backend intentionally discards - see
`checkout-endpoint-spec.md`'s "Known gaps"), `landscape` must be read and
persisted, because it determines what actually gets fabricated.

### Required backend work (not yet implemented)

1. Read `item.landscape` (boolean; treat anything non-`true` as `false`).
2. Set `metadata.landscape` on the Stripe Checkout Session/PaymentIntent,
   following the same pattern as `metadata.framed`: comma-joined cart indices
   of landscape items, or `"none"` if none.
3. No pricing impact - `landscape` does not change `unit_amount` for any item,
   standard or custom.
4. No validation beyond boolean coercion is needed; an absent field means
   `false`.

## Out of scope / not done here

- No 3D preview exists in the storefront (the map is a 2D Leaflet bbox
  picker), so "buildings not printed" is communicated via copy/UI only, not a
  rendered building layer being toggled off.
- Server-side metadata write-up (item 2 above) is a backend task, tracked
  here but not implemented in this change.
