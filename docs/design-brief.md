# Design brief — look-and-feel direction (M0)

The M0 UI/design deliverable: the direction the M1 design system is built from.
This is a **brief**, not the design system — the binding rulebook (a golemine-style
`Design.md` with full token tables, component rules, and a UI definition-of-done)
lands with the M1 app shell, seeded from this document (D-017). Where this brief
gives concrete color values they are **anchors for derivation, not final tokens**;
final tokens are defined in OKLCH at M1 and AA-validated in both themes.

## Intent

**A vibrant, professional developer instrument.** WebAI should feel native to where
its users already live — the dark, high-contrast world of VS Code themes — with the
calm precision of a measurement tool, contrasted with restrained neon for the data
it measures. Chrome is quiet; data is loud.

Owner direction (2026-07-17): not golemine's warm-gold steampunk — a modern
developer/matrix-adjacent look, styled off popular VS Code theme packs, with neon
visuals (futuristic-movie flavor) for graphical elements.

## Direction: "Neon horizon"

Chosen 2026-07-17 from three candidate directions (D-017; the rejected two are
summarized at the end). Anchored in the Tokyo Night family of editor themes
(2.7M+ VS Code installs) crossed with Blade Runner/Tron instrument panels.

### Palette direction

Reference anchors — Tokyo Night-derived, then **re-tuned 2026-07-17 to the
vibrancy of the Arachne-7 character sheet** (D-018): darker canvas, hotter neon,
text neutrals unchanged. Derive, don't copy-paste:

| Role | Dark anchor | Notes |
| --- | --- | --- |
| App background | `#0E111A` | Near-black indigo (the sheet's night-city canvas) — darker than Tokyo Night's `#16161E` to buy contrast headroom and make the neon read as glow |
| Surface / panes | `#161B2A` | Stepped surfaces give depth |
| Borders | `#223052` / `#2C3A5E` | Hairlines, cool-tinted |
| Text | `#C0CAF5` primary, `#565F89` secondary | Cool periwinkle-tinted neutrals — **deliberately low-chroma and unchanged by the vibrancy re-tune**: high-saturation text on near-black causes halation/vibration in sustained reading (the sheet itself keeps its labels near-white). **Known sub-AA anchor:** `#565F89` is Tokyo Night's *comment* color (~3:1 here) — the derived secondary-text token must be lightened substantially (roughly `#787FA8`+, ~4.8:1) to pass AA; primary passes as-is |
| **Accent** | electric blue-cyan `#40C4FF` | Matched to Arachne-7's optics; ~9.5:1 on the background. Primary actions, active nav, selection, focus — rare by design |
| Neon set | electric blue `#2E7CFF`, violet `#B44CFF`, hot magenta `#FF2E9E`, plus derived hues | **Reserved for data**: charts, benchmark visuals, per-runtime series colors, glow. Magenta ~5.3:1; the deep blue is ~4.7:1 — fine for graphics and large text, not body copy |

Rules that carry into Design.md:

- **Accent is rare.** Cyan marks what is chosen or active; if a screen has accent in
  more than ~3 places, something is wrong (golemine's discipline, new hue).
- **Neon is for data, never chrome.** The violet/magenta neon set appears only in
  charts, metric highlights, progress visuals, and brand/mascot imagery. UI chrome
  stays in neutrals + cyan.
- **Functional colors stay unambiguous.** Success green, warning amber, danger red,
  info blue are distinct from both the cyan accent and the neon set — this tool's
  product *is* diagnostics; status colors can never be decorative. **Derivation
  requirement:** the hot-magenta anchor `#FF2E9E` sits near danger red, and
  benchmark charts will show failure marks next to data series — Design.md must
  keep the derived magenta series color decisively pink (~330° hue, high
  chroma) and danger red decisively red-orange, or exclude red-adjacent hues
  from the series set. The sheet-tuned vibrancy makes this rule *more*
  load-bearing than the original rose anchor did.
- **Glow is permitted, bounded.** As the deliberate departure from golemine's
  no-decoration rule: subtle outer glow is allowed on data visuals, the landing
  hero, and mascot imagery — never on text, controls, or chrome, and never as the
  only signal. AA contrast and `prefers-reduced-motion` remain non-negotiable.
- **Light theme is real.** Cool near-white neutrals (Tokyo Night Light territory),
  with the vibrant accents darkened *aggressively* — the neon anchors collapse on
  white (`#40C4FF` is ~2:1 there); the light-theme accent and neon set are
  separate derivations, not lightness-shifted copies. Every screen ships in both
  themes, meeting AA in both — precisely: **4.5:1 for normal text at any size,
  including control labels** (WCAG SC 1.4.3); **3:1 for large text** (≥24px, or
  ≥18.66px bold) **and for non-text UI indicators** — control borders, focus
  rings, icons, chart strokes (SC 1.4.11).

### Theming model

- **Dark by default** for first-time visitors (owner call, 2026-07-17) — the
  signature look matches the editor-native identity. This intentionally differs
  from golemine's system-default.
- Three-state toggle **Dark / Light / System** in the top bar, persisted in
  `localStorage`; an inline pre-paint script applies the stored (or default)
  theme before first render; `color-scheme` set so native controls match.
- Components are theme-blind: semantic tokens only, never theme queries in JS for
  styling.

### Tokens & stack

- **Every color, size, radius, shadow, and duration is a token** — CSS custom
  properties in OKLCH, semantic layer (`--bg`, `--surface`, `--accent`, …) consumed
  by components; no hardcoded values.
- **Tailwind v4** (4.3, CSS-first config) via `@tailwindcss/vite` — the old
  `@astrojs/tailwind` integration is deprecated/archived. Tokens map into Tailwind
  through `@theme`; components use utilities or `var(--token)`.
- **shadcn/ui vendored and restyled** onto our tokens (fully updated for Tailwind
  v4 + React 19); Radix primitives for interaction (dialogs, menus, tooltips);
  hand-roll domain surfaces (chat stream, virtualized lists, charts).
  Licenses: Tailwind/shadcn/Radix MIT, lucide ISC — NOTICE entries at M1 vendoring.
- **Icons:** lucide, stroke style, color inherits text tokens. No emoji as UI icons.

### Typography

- **UI:** Inter (variable), self-hosted (D-005 — no CDN fonts); tabular numbers
  wherever metrics align.
- **Data:** JetBrains Mono for everything measured or verbatim — tok/s, hashes,
  file sizes, model IDs, quant names, GGUF metadata. Mono signals "instrument
  reading," and this app is full of them.
- Both faces SIL OFL-1.1 — allowed under the anti-viral license policy and on
  the CI allowlist (D-019); the assets ship with their upstream copyright
  notices and OFL text, with NOTICE pointing to them.
- Data-dense scale (~14px base) like golemine; desktop-first, mobile best-effort
  (D-010).

### Motion

Calm chrome, live data. The primary motion of the app *is* the data: streaming
tokens, progress bars with real byte/token counts, live metric readouts. UI motion
is short, compositor-safe (opacity/transform), and confirms causality; determinate
progress over spinners wherever a total is known (downloads always have one).
`prefers-reduced-motion` disables all non-essential animation.

### Mascot & imagery

Owner confirmed a mascot + spot illustrations (2026-07-17), and settled the
identity the same day (D-018): **Arachne-7**, a chrome spider automaton that
**weaves the web** — twin neon-blue optics, articulated chrome legs with neon
light strips, copper-gear "steampunk" joints, and a holographic web spinner
emitting cyan web filaments. The web-weaver metaphor is the product pun (WebAI),
and the palette (electric blue/cyan glow, dark neon-city backdrop, magenta/pink
signage accents) is native to the Neon horizon direction.

**Character sheet:** `docs/assets/arachne-7-character-sheet.jpg` is the canonical
reference (owner-generated). Any new Arachne-7 artwork must be generated with the
character sheet supplied as image context — never from a text prompt alone. The
sheet also contains a web-styled "W" WebAI logomark concept to develop at M1.

Rules inherited from golemine §12 (kept): illustrations appear only on the
landing page, empty states of major surfaces, and capability-gate explanations;
decorative (`alt=""`), never sole carriers of information; light and dark
variants of every asset. The sheet is a JPEG (no alpha) and never ships in the
app. **In-app asset pipeline (D-018):** the default is **opaque per-theme
renders composed on the exact token background color** — glowing, reflective
artwork keyed naively to transparency fringes at the anti-aliased edges or loses
its glow. Transparent WebP is permitted only via a demonstrated true-alpha
workflow (a real alpha channel from the generation/compositing tool, or
validated edge decontamination), verified halo-free on both themes. Raster
artwork is exempt from the tokens-only rule (the copper joints' warm metallics
live in artwork only, never in UI chrome).

### Voice

Precise, factual, quantified — "Downloaded 3.2 GB of 4.1 GB", "38.4 tok/s decode
(median of 5)". Errors say what happened and what to do next; failures name the
missing capability (the "why not" is the product). Sentence case everywhere.
Energy comes from the visuals, not exclamation marks.

## What the M1 Design.md must contain

Full OKLCH token tables for both themes (AA-checked pairs) · type scale · spacing/
radius/elevation system · motion tokens and choreography rules · component rules on
the shadcn base · theming implementation contract · glow/neon usage rules · chart
accessibility rules (series identity carried by non-color cues — markers, dash
patterns, direct labels — never hue alone, and an accessible table/text equivalent
for every chart) · mascot character sheet + asset rules · voice/microcopy rules ·
a UI definition-of-done (both themes verified, AA checked per the split contrast
rule above, keyboard path, reduced motion, loading/empty/error states, no
hardcoded values).

## Rejected directions (D-017)

- **Phosphor** — Matrix/terminal: green-tinted near-black, phosphor-green accent,
  mono-forward. Strongest personality, but the green accent collides with
  success-green status semantics (unacceptable in a diagnostics tool) and reads
  retro over professional.
- **Aurora** — Catppuccin/Dracula: dark plum neutrals, violet accent, pastel-neon
  viz set. Community-beloved but softer/cozier than the futuristic-instrument
  brief; weaker contrast between chrome and neon data.
