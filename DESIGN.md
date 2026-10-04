---
name: Polyplaces
description: A physical, tactile 3D topographic map sculpture studio for UK locations.
colors:
  warm-paper: "#f7f4ef"
  warm-paper-deep: "#efe9df"
  pure-white: "#ffffff"
  near-black-ink: "#1a1714"
  warm-charcoal: "#524a41"
  warm-taupe: "#7a7166"
  burnt-terracotta: "#c94f2c"
  terracotta-light: "#e8684a"
  terracotta-wash: "#fdf0ec"
  ink-shadow: "rgba(26,23,20,0.18)"
  ink-border: "rgba(26,23,20,0.1)"
typography:
  display:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "clamp(2.625rem, 5vw, 4.25rem)"
    fontWeight: 300
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "clamp(1.75rem, 3.5vw, 2.75rem)"
    fontWeight: 300
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "1.375rem"
    fontWeight: 400
    lineHeight: 1.2
  body:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    letterSpacing: "0.08em"
rounded:
  none: "2px"
  sm: "4px"
  md: "6px"
  lg: "10px"
  xl: "14px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "14px"
  md: "20px"
  lg: "32px"
  xl: "40px"
  2xl: "72px"
  section: "90px"
components:
  button-primary:
    backgroundColor: "{colors.burnt-terracotta}"
    textColor: "{colors.pure-white}"
    rounded: "{rounded.none}"
    padding: "13px 28px"
  button-primary-hover:
    backgroundColor: "{colors.terracotta-light}"
  button-dark:
    backgroundColor: "{colors.near-black-ink}"
    textColor: "{colors.warm-paper}"
    rounded: "{rounded.none}"
    padding: "9px 20px"
  button-dark-hover:
    backgroundColor: "{colors.burnt-terracotta}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.warm-charcoal}"
    rounded: "{rounded.none}"
    padding: "11px 24px"
  badge-pill:
    backgroundColor: "{colors.terracotta-wash}"
    textColor: "{colors.burnt-terracotta}"
    rounded: "{rounded.pill}"
    padding: "5px 12px"
---

# Design System: Polyplaces

## Overview

**Creative North Star: "The Field Notebook"**

Polyplaces reads like a hand-measured field record for a place that's about to become an object: warm paper grounds, ink-dark text, and a single terracotta marker-ink accent that flags the thing being surveyed — the price, the chosen location, the call to act. The system is considered and tactile rather than novelty-gift or startup-bright: it earns attention through restraint and typographic confidence, not saturation or motion.

Two typefaces carry the whole system's personality. Fraunces (light weight, often italic) supplies the editorial, hand-annotated voice on headlines, prices, and pull-quotes — the "written in the field" register. DM Sans carries everything functional: body copy, labels, buttons, form fields — the "printed form" register. The pairing itself is the brand: journal entry above, order form below.

Terracotta is rare by design. It marks exactly one thing per view — a step number, a size tag, a hero pill, a call-to-action fill, a selected state — never used as decoration or fill for its own sake.

**Key Characteristics:**
- Warm cream/paper grounds (`#f7f4ef`, `#efe9df`) with near-black ink text (`#1a1714`), never pure gray
- Fraunces light-weight serif (often italic) for editorial moments; DM Sans for everything functional
- Terracotta (`#c94f2c`) as a single, deliberately rare marker color
- Near-square action surfaces (2px radius) against fully round pill labels — the system's signature contrast
- Flat at rest; shadow appears only as a response to interaction

## Colors

Warm, paper-and-ink palette with one rare accent — never more than one saturated color per view.

### Primary
- **Burnt Terracotta** (`#c94f2c`): the marker-ink accent. Fills primary CTAs (`.btn-fill`, `.btn-order`, `.cart-checkout` hover), flags selected/active states (`.size-opt.active`, `.frame-colour-radio:checked`), and labels the one number worth noticing (step numerals, prices tags, section eyebrows).
- **Terracotta Light** (`#e8684a`): hover state for terracotta fills only — never a resting color.
- **Terracotta Wash** (`#fdf0ec`): the accent's paper-tint — selected-card backgrounds, badge fills, proof-note backgrounds. Terracotta made ambient rather than loud.

### Neutral
- **Warm Paper** (`#f7f4ef`): the default page ground.
- **Warm Paper Deep** (`#efe9df`): secondary ground for image placeholders and inset panels (`.prod-img`, `.gallery-stage`) — one step warmer/darker than the page.
- **Pure White** (`#ffffff`): card and panel surfaces that need to lift off the paper ground (product cards, review cards, the store configurator rails).
- **Near-Black Ink** (`#1a1714`): primary text color and the dark-mode-style ground for the hero, footer, and dark CTA fills. Never true black — always this warm near-black.
- **Warm Charcoal** (`#524a41`): secondary text — body copy, descriptions, supporting labels.
- **Warm Taupe** (`#7a7166`): tertiary text — the quietest tier, for de-emphasized metadata (price suffixes, trust-row icons).
- **Ink Border** (`rgba(26,23,20,0.1)`): the only border color in the system, at one consistent opacity.
- **Ink Shadow** (`rgba(26,23,20,0.18)`): the only shadow tint — always ink-warm, never cool gray.

### Named Rules
**The One Marker Rule.** Terracotta appears once per view, for the one thing that matters — a price, a selected state, a call to act. It is never a background fill, a decorative border, or a repeated pattern.

## Typography

**Display Font:** Fraunces (with Georgia, serif fallback)
**Body Font:** DM Sans (with system-ui, sans-serif fallback)

**Character:** Fraunces at light weight (300) is the "handwritten in the field" voice — editorial, unhurried, often italicized for a second, softer register within the same headline. DM Sans is the "printed form" voice — every functional surface (nav, buttons, labels, inputs) uses it, frequently in small, tightly tracked, uppercase labels.

### Hierarchy
- **Display** (300, `clamp(42px, 5vw, 68px)`, line-height 1.05): hero headline only. Pairs a roman clause with an italic, dimmed clause (`.hero-h1 em`) in the same line.
- **Headline** (300, `clamp(28px, 3.5vw, 44px)`, line-height 1.1): section headers (`.section-h`), store title. Same roman/italic pairing pattern available via `em`.
- **Title** (400, `19–22px`, line-height 1.2): product names, order totals, card titles — Fraunces stepped down to regular weight once it's labeling rather than announcing.
- **Body** (400, `15px`, line-height 1.6–1.7): all paragraph copy, in DM Sans.
- **Label** (500, `11–12px`, letter-spacing `0.06–0.1em`, uppercase): section eyebrows, size tags, form field labels, nav CTAs.

### Named Rules
**The Roman/Italic Pairing Rule.** A Fraunces headline that needs a softer second clause uses an italic, opacity-dimmed inline `em` rather than a second color or size — "Your place. *In relief.*" not two differently-styled fragments.

## Layout

Content is capped at `1100px` (marketing pages) or `1380px` (store configurator) and centered, with side padding stepping from `40px` desktop to `20px` at the `640px` breakpoint. Section rhythm on marketing pages runs large — `80–100px` vertical padding between bands — while card/component internals stay tight (`12–28px`). The store page breaks from the single-column marketing rhythm into a three-rail configurator (`280px` sizing rail / fluid map / `300px` order summary) that collapses to a stacked single column under `900px`. Grids are used deliberately and sparingly: a 3-column product/review/step grid on desktop, always reducing to 1 column on mobile rather than 2 — no intermediate tablet-only layout.

## Elevation & Depth

**The Flat-at-Rest Rule.** Surfaces are flat by default — cards, panels, and buttons carry no shadow at rest, only a hairline `ink-border`. Shadow exists exclusively as a response to state: a card lifting on hover (`.prod-card:hover`), a drawer sliding in (`.cart-drawer`, `.nav-drawer`), a floating control docking over the map (`.map-search`, `.frame-controls`), or a modal arriving (`.cookie-consent-card`, `.nl-card`). Depth is earned by interaction, never applied as ambient decoration.

### Shadow Vocabulary
- **Hover lift** (`0 16px 40px rgba(26,23,20,0.1)`): product/review card hover — a wide, soft lift.
- **Floating control** (`0 4px 18px rgba(26,23,20,0.12)` / `0 8px 22px rgba(26,23,20,0.12)`): pill-shaped controls docked over the map (search, frame controls).
- **Drawer / modal** (`-20px 0 50px var(--shadow)`, `0 20px 60px rgba(26,23,20,0.35)`): cart drawer, nav drawer, cookie/newsletter overlays — the deepest shadows in the system, reserved for content that has left the page flow.

## Shapes

**The Sharp Action, Round Label Rule.** Interactive surfaces that *do* something — buttons, inputs, product cards, size options — stay near-square (`2px` radius on buttons, `2–8px` on inputs and cards): deliberate, printed, plate-cut edges. Surfaces that *label or float* — badges, tags, the nav cart pill, drawers' close buttons, map search, frame controls — go fully round (`999px` or `50%`): stamped, informational, weightless. A component's radius tells you whether it's an action or a note. Larger overlay containers (cookie card, newsletter card, cart items) sit in between at `6–14px`, softened just enough to read as a lifted object rather than a form.

## Components

### Buttons
- **Shape:** near-square, `2px` radius — the system's signature restraint (never fully square-cornered elsewhere, never rounded here).
- **Primary (`.btn-fill`, `.btn-order`):** Burnt Terracotta fill, white text, `13–15px 24–32px` padding. Hover shifts to Terracotta Light with a `1px` upward nudge.
- **Dark (`.prod-btn`, `.nav-cta`, `.cart-checkout`):** Near-Black Ink fill, paper text. Hover shifts straight to Terracotta — the dark button's hover state is the one place ink and accent touch directly.
- **Outline / Secondary (`.btn-outline`, `.btn-order-sec`):** transparent fill, hairline border, charcoal text; hover darkens border and text toward ink. Never gains a background fill on hover — outline stays outline.
- **On dark grounds (`.btn-outline` in hero):** border and text shift to warm-paper-tinted rgba rather than the light-mode ink/charcoal pair.

### Badges / Pills
- **Style:** full pill radius (`999px`), small uppercase tracked label type, terracotta-wash background with terracotta text, or solid ink/terracotta fill for on-image badges (`.prod-badge`).
- **State:** no hover state — badges are informational, not interactive.

### Cards / Containers
- **Corner Style:** flat-cornered for grid cards (`.prod-card`, `.review-card` — no radius), `6–10px` for interactive selectable cards (`.size-opt`, `.cart-item`), `14px` for cards that float over a dimmed backdrop (`.cookie-consent-card`, `.nl-card`).
- **Background:** White on paper grounds for cards meant to lift; paper or paper-deep for cards meant to sit flush.
- **Shadow Strategy:** flat at rest; see Elevation & Depth. Selected/hovered cards gain a soft terracotta-tinted glow (`0 4px 12–16px rgba(201,79,44,0.08–0.15)`) rather than a neutral shadow — state feedback stays on-brand even in shadow color.
- **Border:** hairline `ink-border` universally; selectable cards thicken to `1.5px` and shift to terracotta when active.

### Inputs / Fields
- **Style:** hairline border, white or paper background, `2px` radius (matches button sharpness), generous `12–14px` padding.
- **Focus:** border shifts to Burnt Terracotta; no glow or ring — the color change alone carries the state.
- **Inline variants:** the custom-location label input (`.order-label-input`) drops the box entirely for an underline-only field — used only for a single optional, low-commitment input.

### Navigation
- Fixed, `60px`, blurred translucent paper background over content. Logo in Fraunces roman; nav links in small charcoal DM Sans that darkens to ink on hover — no underline. The cart trigger is the one pill-shaped, bordered element in the nav; the primary CTA is the one dark-filled, sharp-cornered element. Mobile collapses to a full-height right-side drawer (same drawer shadow/motion language as the cart drawer) rather than a top-down dropdown.

### Map Controls (signature component)
Floating, pill-shaped, frosted-glass panels (`rgba(255,255,255,0.96)` + `backdrop-filter: blur(8px)`) dock over the Leaflet map for search and frame controls — the one place in the system where UI chrome overlays imagery directly. These always stay pill-radius and carry the "floating control" shadow tier, distinguishing them from the flat, bordered chrome used everywhere else on the page.

## Do's and Don'ts

### Do:
- **Do** keep terracotta to one marker per view — a price, a selected state, or the primary action. Its rarity is what makes it read.
- **Do** pair a Fraunces roman clause with a dimmed italic `em` clause for a two-register headline, rather than introducing a second color or weight.
- **Do** keep buttons and inputs near-square (`2px`) and badges/pills fully round (`999px`) — the contrast is a deliberate rule, not an inconsistency to "fix."
- **Do** hold shadows to interaction-only: hover, open, float. A resting card or button stays flat.
- **Do** use the ink-tinted shadow (`rgba(26,23,20,...)`) everywhere depth is needed — never a cool/neutral gray shadow.

### Don't:
- **Don't** put a thick accent-colored border on one edge of a rounded card (a `border-left`/`border-top` accent stripe clashes with a soft corner radius — pick one language, not both. `.checkout-banner`'s left-border and `.cookie-consent-card`'s top-border are pre-existing exceptions to phase out, not a pattern to extend).
- **Don't** animate `padding`/`width`/`height` for hover or state transitions (`.size-row:hover`'s `padding-left` transition is a pre-existing exception; prefer `transform`).
- **Don't** introduce a second saturated accent color. Every non-neutral color in the system traces back to Burnt Terracotta at some tint or shade.
- **Don't** use pure gray or pure black anywhere — every neutral is warm-tinted off the ink/paper axis.
