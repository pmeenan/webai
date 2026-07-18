# WebAI design system

This is the binding visual and interaction contract for WebAI. It implements the
"Neon horizon" direction in [docs/design-brief.md](docs/design-brief.md) and decisions
D-017 through D-019. Components consume semantic tokens; changing a primitive here
does not authorize hardcoded exceptions in component code.

## Principles

- WebAI is a precise developer instrument: quiet chrome, vivid measured data.
- Cyan is rare and identifies the selected, actionable, or focused thing. Violet and
  magenta are data/brand colors, never application chrome.
- Status colors mean only success, warning, danger, or information. Text and icons
  accompany every status color.
- Dark is the first-visit default. Dark, Light, and System are all complete themes.
- Every visual value is a token. Raster artwork is the sole color-token exception.
- Motion confirms cause and state. The data itself supplies most of the motion.

## Color system

The implementation defines these as CSS custom properties in `src/styles/global.css`.
Hex values show the clipped sRGB result and are references, not alternate component
values.

| Semantic token | Dark | Light |
| --- | --- | --- |
| `--bg` | `oklch(0.18 0.02 270)` (`#0e111b`) | `oklch(0.98 0.008 264)` (`#f6f8fe`) |
| `--surface` | `oklch(0.225 0.03 270)` (`#161b2a`) | `oklch(1 0 0)` (`#fff`) |
| `--surface-raised` | `oklch(0.27 0.035 270)` (`#202638`) | `oklch(0.95 0.015 264)` (`#e9eff9`) |
| `--text` | `oklch(0.88 0.045 275)` (`#ced6f6`) | `oklch(0.25 0.035 264)` (`#192133`) |
| `--text-secondary` | `oklch(0.72 0.045 275)` (`#9ca3c1`) | `oklch(0.38 0.04 264)` (`#384258`) |
| `--text-muted` | `oklch(0.65 0.04 275)` (`#888ea8`) | `oklch(0.46 0.035 264)` (`#4e586c`) |
| `--text-disabled` | `oklch(0.5 0.03 275)` (`#5e6275`) | `oklch(0.64 0.03 264)` (`#838c9f`) |
| `--border` | `oklch(0.34 0.055 268)` (`#2c3755`) | `oklch(0.84 0.03 264)` (`#c1cbdf`) |
| `--border-strong` | `oklch(0.42 0.06 268)` (`#3f4c6e`) | `oklch(0.72 0.045 264)` (`#96a5c2`) |
| `--control-border` | `oklch(0.55 0.06 268)` (`#627195`) | `oklch(0.58 0.06 264)` (`#687a9f`) |
| `--accent` | `oklch(0.78 0.14 232)` (`#40c6ff`) | `oklch(0.48 0.135 225)` (`#006b96`) |
| `--accent-hover` | `oklch(0.83 0.14 232)` (`#54d6ff`) | `oklch(0.43 0.135 225)` (`#005c86`) |
| `--accent-active` | `oklch(0.72 0.14 232)` (`#21b3ed`) | `oklch(0.38 0.12 225)` (`#004d71`) |
| `--accent-foreground` | `oklch(0.17 0.02 270)` (`#0c0f18`) | `oklch(0.99 0.005 264)` (`#fafcff`) |
| `--focus-ring` | `oklch(0.78 0.14 232)` (`#40c6ff`) | `oklch(0.46 0.155 225)` (`#006598`) |
| `--selection` | `oklch(0.32 0.08 232)` (`#003954`) | `oklch(0.88 0.06 225)` (`#aee1f6`) |
| `--success` | `oklch(0.75 0.165 145)` (`#61c968`) | `oklch(0.45 0.135 145)` (`#0d671d`) |
| `--success-soft` | `oklch(0.25 0.05 145)` (`#112812`) | `oklch(0.93 0.04 145)` (`#d8efd8`) |
| `--warning` | `oklch(0.82 0.145 85)` (`#efbc43`) | `oklch(0.48 0.13 65)` (`#8e4a00`) |
| `--warning-soft` | `oklch(0.26 0.05 85)` (`#2f2203`) | `oklch(0.93 0.04 75)` (`#f8e5cb`) |
| `--danger` | `oklch(0.7 0.205 28)` (`#ff5d50`) | `oklch(0.5 0.185 28)` (`#b51f1c`) |
| `--danger-soft` | `oklch(0.25 0.06 28)` (`#391411`) | `oklch(0.93 0.045 28)` (`#ffddd7`) |
| `--info` | `oklch(0.72 0.175 255)` (`#4fa6ff`) | `oklch(0.46 0.17 255)` (`#0054b3`) |
| `--info-soft` | `oklch(0.25 0.06 255)` (`#0b223e`) | `oklch(0.93 0.045 255)` (`#d4eaff`) |
| `--on-status` | `oklch(0.17 0.02 270)` | `oklch(0.99 0.005 264)` |

The quiet `--border` tokens are decorative only. Inputs, selected-state outlines,
standalone icons, and any boundary that communicates state use `--control-border`.

### Data palette

These colors are for chart strokes, metric highlights, progress, and brand artwork.
They do not style controls or status messages.

| Token | Dark | Light |
| --- | --- | --- |
| `--chart-cyan` | `oklch(0.78 0.155 220)` | `oklch(0.48 0.135 225)` |
| `--chart-blue` | `oklch(0.68 0.205 260)` | `oklch(0.5 0.205 260)` |
| `--chart-violet` | `oklch(0.7 0.205 300)` | `oklch(0.49 0.2 300)` |
| `--chart-magenta` | `oklch(0.72 0.225 335)` | `oklch(0.5 0.205 335)` |
| `--chart-green` | `oklch(0.75 0.165 145)` | `oklch(0.45 0.135 145)` |
| `--chart-amber` | `oklch(0.82 0.145 85)` | `oklch(0.48 0.13 65)` |

Magenta stays at hue 335 and danger at red-orange hue 28. This separation is
load-bearing when benchmark series and failures appear together.

### Contrast validation

Values were converted from OKLCH to linear sRGB with the CSS Color 4 matrices,
clipped to the displayed sRGB gamut, and measured with WCAG 2.x relative luminance:
`(Llighter + 0.05) / (Ldarker + 0.05)`. Ratios are rounded to two decimals.

| Required pairing | Dark minimum | Light minimum | Required |
| --- | ---: | ---: | ---: |
| Primary text on bg/surface/raised | 10.49 | 13.85 | 4.5 |
| Secondary text on bg/surface/raised | 6.06 | 8.67 | 4.5 |
| Muted text on bg/surface/raised | 4.65 | 6.17 | 4.5 |
| Accent link on bg | 9.63 | 5.63 | 4.5 |
| Accent foreground on all accent states | 7.92 | 5.79 | 4.5 |
| Status foreground on soft status surface | 5.40 | 5.22 | 4.5 |
| `--on-status` on solid status | 6.33 | 6.41 | 4.5 |
| Control border on bg/surface/raised | 3.10 | 3.71 | 3.0 |
| Focus ring on bg/surface/raised | 7.73 | 5.45 | 3.0 |
| Chart stroke on surface | 5.58 | 5.96 | 3.0 |

The Tokyo Night comment-color anchor from the brief is intentionally not a token: it
failed AA. Rendered colors must be rechecked in Chromium when tokens change because
the browser's gamut mapping is authoritative.

## Typography

- UI: Inter Variable, self-hosted. Data: JetBrains Mono Variable, self-hosted.
- Weights are 400 for body, 500 for controls/data labels, 600 for headings, and 700
  only for landing display type.
- The type scale is `12/16`, `13/18`, `14/20` (base), `16/24`, `20/28`, `24/32`,
  `32/40`, and `40/48` pixels for size/line-height.
- Headings use `-0.015em`; compact labels use `0.04em`; body copy uses normal
  tracking. Prose is at most 72 characters wide.
- Model IDs, quantizations, hashes, sizes, durations, and benchmark values use mono,
  tabular figures, and no decorative glow.
- Sentence case is universal. All labels, at every size, meet 4.5:1.

The fonts are OFL-1.1. Their complete notices and license texts ship at
`public/licenses/`, and the root `NOTICE` identifies them.

## Space, shape, and elevation

Spacing tokens: `0`, `2`, `4`, `6`, `8`, `12`, `16`, `20`, `24`, `32`, `40`, `48`,
`64`, and `80px`.

Radius tokens: `0`, `4`, `6`, `8`, `12`, and `999px`. Controls use 6px, cards 8px,
and dialogs 12px. Pills are reserved for tags and compact status, not general chrome.

Control heights are 32px compact, 36px default, 40px large, and 44px on coarse
pointers. Icon sizes are 14, 16, 20, and 24px.

Elevation uses surface steps before shadows. The three shadow tokens are a 1px/2px
resting shadow, an 8px/24px floating shadow, and a 16px/48px modal shadow. Dark shadow
alpha is 0.45, 0.50, and 0.58; light is 0.12, 0.16, and 0.20. Glow is not elevation:
it is allowed only on data visuals, the landing hero, and mascot/brand art.

## Layout

- The app bar is sticky and 56px high. It holds the W mark/wordmark, current
  navigation, and three-state theme control.
- Main content is at most 1440px wide with 24px desktop, 16px tablet, and 12px mobile
  gutters. Prose remains at most 72ch.
- M1 navigation is Home, Capabilities, and About. Do not add dead future destinations.
- At 1024px and wider a 240px side rail may be introduced when feature count warrants
  it. The M1 shell does not need one.
- The home hero uses copy first and Arachne-7 second; it stacks below 768px.
- Capability reports put the summary first, then evidence grouped by execution or
  storage domain. Unsupported states name cause and consequence in text.
- Every document has one `main`, a first-focusable skip link, and a unique page title.

## Components

The M1 shell vendors and token-maps shadcn's Button pattern; add future general-purpose
shadcn primitives locally as the product needs them. Radix supplies interaction
behavior for menus, dialogs, tooltips, and other composite controls; domain surfaces
remain hand-written. In shadcn terms, map background/foreground/card/popover/primary/
muted/destructive/ring, but map `input` specifically to `--control-border`.

- Focus is a 2px `--focus-ring` plus a 2px offset. Never remove focus without an
  equally visible replacement.
- Links are underlined in prose. Navigation has location, weight, and indicator cues
  in addition to color.
- Buttons implement default, hover, active, focus-visible, disabled, and busy states.
  Busy controls retain their label and expose a textual status.
- Inputs use a visible label and `--control-border`. Errors add icon and text via
  `aria-describedby`; a red border is insufficient.
- Status badges use text/icon plus their soft background. Status hue is never the
  sole carrier.
- Tables use real header cells and scopes. Numeric cells are right aligned and use
  mono/tabular figures.
- Dialogs restore focus; Escape and outside-click behavior follow the Radix primitive.
- Lucide stroke icons inherit text color. Emoji are not controls.

## Theme implementation

The root element has a resolved `data-theme="dark|light"` and a persisted
`data-theme-preference="dark|light|system"`. The local-storage key is
`webai-theme`; missing or invalid data resolves to dark. A head-inline pre-paint
script resolves System before the stylesheet paints and sets `color-scheme`.

The theme control is a labelled Radix radio menu. System follows media-query changes;
explicit themes do not. Storage failure preserves the in-memory choice. Styling uses
semantic tokens only and does not branch on theme in component JavaScript.

## Motion

Durations are 0ms instant, 80ms micro, 140ms fast, 200ms standard, and 320ms
deliberate. Easing tokens are standard `cubic-bezier(.2,0,0,1)`, enter
`cubic-bezier(0,0,.2,1)`, and exit `cubic-bezier(.4,0,1,1)`.

Chrome animates opacity and transform only. Data updates can animate when the motion
helps interpretation. Determinate progress replaces spinners whenever a total exists.
With `prefers-reduced-motion: reduce`, nonessential durations and smooth scrolling are
removed; state and progress update immediately.

## Charts and live data

- Every series has a marker shape, dash pattern, or direct label in addition to hue.
- Every chart has a text/table equivalent exposing the same values.
- Axes and labels meet 4.5:1; strokes, markers, and focus indicators meet 3:1.
- Status marks use status tokens rather than a convenient nearby series color.
- Glow may emphasize a selected series but cannot be its only selected-state cue.
- Streaming and progress displays include real counts such as bytes and tokens.

## Arachne-7 and logo assets

`docs/assets/arachne-7-character-sheet.jpg` is the canonical identity reference. New
artwork is generated with that sheet supplied as image context, never from text alone.
The sheet itself never ships.

The M1 hero pair in `src/assets/` was generated with the built-in image-generation
workflow using the canonical sheet as reference. Prompt intent: preserve the friendly
front three-quarter chrome spider, twin cyan optics, eight articulated legs with blue
light strips, copper gear joints, and a holographic web spinner; reserve quiet space
for copy; generate no labels, signage, UI, or logo. The dark and light outputs are
opaque RGB WebP assets, encoded from the generated masters at quality 0.88, not
color-keyed transparency. The 1448×1086 pair totals about 306 KiB; the generation
masters remain outside the repository.

The raster backgrounds are theme-coupled. D-022 records the deliberate M1 exception
to D-018's exact-token-background default: the generated perimeters are compatible
night/near-white fields but do not equal `--bg` pixel-for-pixel, so the asset is
presented as a bounded illustration rather than relied on as page color. If either
background token changes, inspect both at 1x and 2x and regenerate/recompose them if
the boundary becomes distracting. Do not color-key chrome or glow. A future
transparent WebP requires demonstrated true alpha or validated edge decontamination.

Illustrations appear only on the landing page, major empty states, and capability-gate
explanations. They are decorative (`alt=""` or CSS decoration), and never carry
meaning unavailable in text. Every placement needs dark and light variants. Copper is
artwork-only, never UI chrome.

The repo-native W mark is a fresh geometric SVG derived from the sheet's woven-strand
idea, not a crop or trace. It uses `currentColor`, has no gradient or header glow, and
pairs with an Inter wordmark. Adjacent text provides its accessible name. At very small
sizes, use the simplified mark if the doubled strands blur.

## Voice and microcopy

Use factual, quantified, sentence-case language: “Downloaded 3.2 GB of 4.1 GB” and
“38.4 tok/s decode (median of 5).” Errors state what happened, what it affects, and an
action when one exists. Capability failures name the missing or indeterminate probe;
they never infer browser support from a user-agent string. Energy comes from the
visuals, not exclamation marks.

## UI definition of done

A screen is complete only when all applicable checks pass:

- Both explicit themes and System render without flash, missing assets, or illegible
  states; a reload preserves preference.
- Required text pairs meet 4.5:1, large text/non-text indicators meet 3:1, and all
  component values come from tokens.
- Keyboard users can reach every action in logical order, see focus, operate composite
  controls, dismiss overlays, and return focus.
- Screen-reader names, landmarks, headings, status announcements, table semantics,
  and relationships are present.
- Information does not depend on hue, imagery, hover, motion, or pointer precision.
- The screen works at 200% zoom, on narrow viewports, and with coarse pointers.
- Reduced motion removes nonessential animation; forced-colors mode remains usable.
- Loading, empty, error, unavailable, stale, and retry states are designed where
  applicable.
- Remote metadata and model output render as text, never interpolated HTML.
- No emoji control icons, hardcoded component values, or theme-specific JS styling.
