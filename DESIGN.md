# Timeless — Design System

Visual identity modelled on **The Climate Pledge** (theclimatepledge.com):
warm optimistic off-white, a signature green, soft pastel colour-blocks, big
high-contrast **serif** headlines mixed with a clean **grotesk**, a hand-drawn
script accent, and generously rounded corners. Everything is a token in
`:root` (`assets/styles.css`) — **never hardcode a value.**

---

## 1. Type — three roles, close free analogues of the brand fonts

| Role | The Climate Pledge uses | We use (free) | Token |
|------|------------------------|---------------|-------|
| Display / headings | **Editorial New** (high-contrast serif) | **Instrument Serif** | `--serif` |
| Body / UI | **ClimatePledgeSans / Trio Grotesk** | **Space Grotesk** | `--sans` |
| Hand-drawn accent | **Kalam** | **Kalam** (exact) | `--hand` |

- Headlines are large, roman **mixed with italic** (`.serif em`), lowercase or
  sentence case — never all-caps.
- One word per headline may get the **Kalam** treatment (green) with a
  hand-drawn underline — the signature "human" touch. Use sparingly (once/page).
- Body is Space Grotesk, 400/500.

**Fluid scale**
```
--fs-hero  clamp(3rem, 11vw, 10rem)      the one giant serif headline
--fs-xl    clamp(2.2rem, 5.5vw, 4.5rem)  section titles, statement
--fs-lg    clamp(1.6rem, 3vw, 2.6rem)    card titles
--fs-md    1.25rem                        sub-headings
--fs-body  1.0625rem                      paragraphs
--fs-sm    0.875rem                       secondary UI
--fs-label 0.75rem                        tracked micro-labels (grotesk)
```

## 2. Colour

```
--bg      #fffcfa   warm white page background
--surface #f7f5f2   raised neutral panels
--ink     #312f2d   primary charcoal text
--ink-2   #666464   secondary text
--line    rgba(49,47,45,.14)

Brand green (primary / CTAs / "live"):
--green   #1b945a   --green-600 #157a49 (hover)  --green-bright #3dcc68

Pastel colour-blocks (section & card backgrounds):
--mint    #c4f0d0   --sky #cbe2f9   --peach #f4e2d6   --lilac #eddfeb

Punch accents (use sparingly, non-body):
--red #e1252e   --blue #00b3ff
```

Rule: **pastels are backgrounds, green is the action, red is a rare punch.**
Charcoal text sits on white and on every pastel (all pass AA for large text).

## 3. Shape & space

- Rounding is the signature: `--r-pill 100px` (buttons/chips),
  `--r-lg 28px` (cards/blocks), `--r-md 18px`, `--r-sm 12px`, `50%` (circles).
- **No hard hairline dossier grid** — structure comes from soft rounded
  colour-blocks with air between them.
- Page gutter `--edge` = `clamp(1.25rem, 4vw, 5rem)`.
- Space steps `--s1…--s6` (`.5rem` → `6rem`).

## 4. Motion

`--ease cubic-bezier(.22,1,.36,1)`, `--dur .5s`. Reveal-on-scroll (fade + rise),
buttons lift/darken on hover, arrows nudge. Disabled under
`prefers-reduced-motion`.

## 5. Components

- **`.btn`** — pill. Primary = green fill / white; ghost = charcoal outline.
- **`.action`** — the two hero CTAs: large rounded pastel cards (mint / sky)
  with a serif title and a circular arrow. The focal point of the page.
- **`.block`** — a rounded pastel section card (method steps, principles).
- **`.statement`** — one full **green** rounded block, white serif.
- **`.hand`** — Kalam accent; **`.uline`** — the hand-drawn SVG squiggle
  underline (best on mid-size headings, not the giant hero — the em scales up).
- **Room** — rounded video tiles, pill controls, green live status, same tokens.

## 6. Accessibility & security are part of the system

Focus-visible green ring everywhere; motion respects reduced-motion; strict CSP,
self-hosted scripts, validated room codes — see `SECURITY.md`.
