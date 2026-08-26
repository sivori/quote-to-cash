# UX review against Cloudflare's product UI

Produced by a research agent on 2026-08-25 (prompt 3 in `PROMPTS.md`); applied in prompt 7.

## Sources
Cloudflare publishes no written UX guideline. It publishes a design system as code — **Kumo**
(`@cloudflare/kumo`, MIT, github.com/cloudflare/kumo) — and both `dash.cloudflare.com` and
`developers.cloudflare.com` are built on it (verified by measuring computed styles: the dash
primary button's ring is Kumo's `getEmphasisStyle()` colour-mix; the docs repo imports
`@cloudflare/kumo/styles`). Reference order used: Kumo tokens → measured docs/dash → cloudflare.com
for the brand orange only.

## Component library decision
Kumo is React-only (Tailwind v4, `@base-ui/react`, `motion`, `@phosphor-icons/react` peers) and has
no stepper, timeline or chip. Adopting it would add a build step and ~100 KB gz for three components.
Decision: stay dependency-free and **vendor Kumo's light-mode tokens** (`:root` block of
`theme-kumo.css`) plus its button/badge/input recipes. If a real front end ever appears, Kumo is the
library and the token names already match.

## Applied
**P1 (accessibility)** — orange-on-white text removed everywhere it was body-size (pending badge →
Kumo warning tint `#fef3e7/#944500`; chip hover → ink; current step → ink + orange ring); hero copy at
2.79:1 replaced by a product-style page header (ink on canvas, 15:1); deal rows are `<button
aria-expanded aria-controls>`; `:focus-visible` rings (Kumo `ring-2 ring-kumo-brand`) and the
1.5px focus ring on inputs; control borders from `#F0F0F0` (1.14:1) to Kumo `line` (10% black);
`aria-label` on the deal input, `role="log" aria-live="polite"` on the chat, submit disabled in flight.

**P2 (alignment)** — Kumo type scale (14px body, 16/600 section titles in ink, 13px `#737373`
help, 24/600 page title, 13px mono data with `tabular-nums`, Inter `cv02/cv03/cv04/calt`); 8px
radii on cards and controls, pills only for badges; flat `#fafafa` canvas, `#e9e9e9` hairlines;
36px control height; Kumo semantic badge tints (neutral / warning / info / success / danger /
strong-danger); semantic colours on the stepper and timeline instead of brand orange; Kumo-style
empty state; the listbox trigger at a fixed width with behaviour text in the menu only.

**P3 (polish)** — timeline capped at 240px, chat log 220px–40vh; 8px chat bubbles on `#f8f8f8`;
Phosphor `Check` glyph on done steps; footer links in ink with hover underline;
`<meta name="color-scheme" content="light">`.

**Kept by decision** — orange primaries (`Quote`, `Approve`). Cloudflare's own docs CTA is the same
orange at 2.58:1, so this is on-brand and sub-AA for 14px text; a known trade-off, noted here.

## Measured reference values (for the record)
Body: Inter Variable 16/24 `oklch(0.21 0 0)` (docs), `#313131` (dash) · Kumo app scale 12/13/14/16 ·
h1 docs 35/43.75 600 −0.025em; dash 24/32 600 · muted `oklch(0.556 0 0)` = `#737373` · placeholder
`#a1a1a1` · Kumo button base h36 r8 px-3 14/500; dash uses lg h40 · primary blue `#056dff` ring
`#045ede` · secondary ring 10% black · badge `rounded-full px-2 py-0.5 text-xs font-medium` ·
docs "Beta" badge `#fef3e7 / #944500` · docs CTA `#ff5e1e` r-full h36.
