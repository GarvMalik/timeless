# Timeless — Design System

A small, strict system so the whole site stays consistent. Everything below is
encoded as CSS custom properties in `assets/styles.css` (`:root`). **Never
hardcode a colour, size, or timing** — reach for a token.

Concept: **a technical dossier that happens to be beautiful.** Monospace body,
an avant-garde display face, hairline grids, numbered everything, one dark
inverted band for contrast, one warm accent used sparingly. Deliberately *not*
the soft, centered, rounded look of a default app UI.

---

## 1. Type — exactly two families

| Role | Family | Token | Weights |
|------|--------|-------|---------|
| Display / headings | **Syne** (geometric, avant-garde) | `--display` | 600, 700, 800 |
| Everything else / body / UI | **Space Mono** (monospace) | `--mono` | 400, 700 |

No third font. Ever. Body is monospace on purpose — it reads like a spec sheet
and reinforces the "secure / technical" idea.

**Fluid scale** (`clamp()`), token → use:

```
--fs-hero    clamp(3.2rem, 13vw, 12rem)   the one giant headline
--fs-xl      clamp(2rem, 5.5vw, 4.2rem)    section titles, dark statement
--fs-lg      clamp(1.5rem, 3vw, 2.4rem)    card titles, feature names
--fs-md      1.25rem                        sub-headings
--fs-body    0.95rem                        paragraphs (mono)
--fs-sm      0.8125rem                      secondary UI
--fs-label   0.6875rem                      uppercase tracked micro-labels
```

Labels: `--fs-label`, uppercase, `letter-spacing: 0.18em`, `--ink-45`.

## 2. Colour

```
--paper      #e8e3d6   page background (warm bone)
--surface    #f1ecdf   raised cells / cards
--ink        #141109   near-black warm ink (text)
--ink-70 / --ink-45    muted ink for secondary / tertiary text
--line       rgba(20,17,9,.20)   hairline borders (structure)
--line-soft  rgba(20,17,9,.09)
--accent     #bf4a25   clay-orange — used ONLY for: the live dot, one word in
                        the statement, hover ink, focus rings. Never for big fills.
--inverse    #141109   the single dark band's background
--inverse-ink #e8e3d6  text on the dark band
```

Contrast: ink on paper ≈ 14:1, ink-70 on paper ≈ 6:1 — both pass WCAG AA.

## 3. Space & layout

- Page gutter: `--edge` = `clamp(1.25rem, 4vw, 4.5rem)`.
- Spacing steps: `--s1 .5rem`, `--s2 1rem`, `--s3 1.5rem`, `--s4 2.5rem`,
  `--s5 4rem`, `--s6 6rem`.
- **Grid is visible.** Structure is drawn with 1px `--line` borders, not shadows.
- **Sharp corners** everywhere (`--radius: 0`). The only round things are the
  status dot and the status pill — nothing else.
- Asymmetric section heads: a narrow label column + a wide title column.

## 4. Motion

```
--ease  cubic-bezier(.22, 1, .36, 1)
--dur   .55s
```

- Reveal-on-scroll: fade + 24px rise, staggered.
- Hover: blocks invert (paper↔ink) or nudge; no bounce, no scale-up on text.
- All motion is disabled under `prefers-reduced-motion`.

## 5. Components

- **`.action`** — the primary CTA block. Large, bordered, numbered, arrow;
  inverts to ink on hover. This is the loudest thing on the page by design.
- **`.signals`** — static labelled band (replaces the old moving marquee). A row
  of numbered keyword cells divided by hairlines. No animation.
- **`.step` / `.feat`** — dossier rows: number + name + description on a grid.
- **`.statement`** — the one inverted (dark) band.
- **Room**: `.action`-consistent buttons, hairline tiles, circular controls,
  pill status. Same tokens as the marketing pages.

## 6. Accessibility & security are part of the system

- Focus-visible ring on every interactive element (`--accent`, 2px offset).
- All motion respects `prefers-reduced-motion`.
- Strict Content-Security-Policy, self-hosted scripts, validated room codes —
  see `SECURITY.md`.
