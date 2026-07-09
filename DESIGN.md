# Timeless — Design System

Visual identity modelled on **The Climate Pledge** (theclimatepledge.com):
warm optimistic off-white, a signature green, soft pastel colour-blocks, big
high-contrast **serif** headlines mixed with a clean **grotesk**, a hand-drawn
script accent, and generously rounded corners. Everything is a token in
`:root` (`assets/styles.css`) — **never hardcode a value.**

---

## 1. Type — exactly two families, no more

| Role | Family | Token |
|------|--------|-------|
| Headings / display | **Lexend** | `--serif` (kept the token name; it now points at Lexend) |
| Body / UI / everything else | **Noto Sans Display** | `--sans` |

No third font. `.hand` is not a different typeface — it's Lexend at 700, set in
`--green`, used to pick out one word per headline. Use sparingly (once/page).
The hand-drawn `.uline` squiggle underline still works under any font; it's an
independent SVG accent, not tied to a script face.

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
- **`.hand`** — bold green Lexend accent word; **`.uline`** — the hand-drawn
  SVG squiggle underline (best on mid-size headings, not the giant hero).
- **Room** — rounded video tiles, pill controls, green live status, same tokens.
- **`.avatar`** — shown on a video tile in place of a frozen/black frame when
  a participant's camera is off. A colour is chosen at random (from the pastel
  palette) once per session and paired with a single consistent face glyph —
  the colour varies, the mark never does.
- **`.meter`** — a small live bar-graph next to the mic control reflecting the
  local mic's captured input level, so a speaker can see their voice is
  registering. A `.tile--speaking` ring highlights whichever tile (you or them)
  is currently making sound.
- **`.banner`** — one shared slim, dismissible, non-blocking bar: network
  trouble, the quiet large-call performance advisory, and the "back online"
  flash all use the same slot (network trouble always wins). Never blocks
  interaction.
- **`.invite-chip`** — the host's shareable link, visible in the room bar for
  the whole call (not just inside the control dock), one tap to copy.
- **`.stage`** — the video grid. Tile count sets a `--cols` custom property
  (a small balanced-columns heuristic, same family as Meet/Zoom); the
  wrapping itself is plain CSS grid. Your own tile is fixed; every remote
  participant's tile is cloned from `#tileTemplate`.
- **`.preview-tile`** — the pre-join camera check ("Ready to join?"): the same
  `.avatar`/`.ctrl` components, scaled down inside the lobby card, mirrored
  like a real mirror (`scaleX(-1)`) the way every video-call preview does.
- **`.knock-panel` / `.knock`** — floating cards for pending join requests,
  host-only, one per waiting guest, Admit/Deny.
- **`.chat`** — a slide-in panel (transform, not `[hidden]`, so it actually
  animates), pastel/rounded like the rest of the system. `.msg--me` picks out
  your own messages in green; `.msg--system` is centered, quiet join/leave
  copy.
- **`.theater`** — the full-screen "watch together" focus view: a dark
  overlay, the shared video blown up, minimal chrome that fades on idle and
  returns on any movement. Local-only state — never synced between
  participants.
- **`.music-pill`** — a small mint chip in the room bar naming whoever's
  music is currently playing.

## 6. Accessibility & security are part of the system

Focus-visible green ring everywhere; motion respects reduced-motion; strict CSP,
self-hosted scripts, validated room codes — see `SECURITY.md`.
