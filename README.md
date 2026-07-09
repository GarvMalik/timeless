# Timeless

A quiet, peer-to-peer video call for a small group of friends. A handful of
people, one link — video, music, and movies shared directly between browsers
over WebRTC. No accounts, no downloads, nothing to install, and no server of
our own to run.

**Live:** https://garvmalik.github.io/timeless/

---

## How it works

Timeless is a static site. All the meeting logic runs in the browser, in a
full **mesh** — everyone connects directly to everyone else, so no server
ever touches anyone's media. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the
full protocol and the reasoning behind it (mesh vs. a media server, the
join/admission handshake, the shared Music/Movie pipeline).

- **Media & transport** — [WebRTC](https://webrtc.org/) carries audio and
  video directly between every pair of participants.
- **Signalling** — handled by the free public [PeerJS](https://peerjs.com/)
  cloud broker, so there's no backend to host or pay for. The PeerJS library
  itself is **self-hosted** (`assets/vendor/`), so no third-party script runs on
  the page — see [`SECURITY.md`](SECURITY.md).
- **Rooms** — the host's browser owns a short room code (its PeerJS id).
  Guests knock, the host admits or denies them, and once admitted a guest
  meshes directly with everyone already in the room.

```
index.html          → landing page
call.html           → the meeting room (lobby + live call)
assets/
  styles.css        → the design system, in CSS custom properties
  site.js           → landing reveal animations
  call.js           → orchestrator: lobby steps, dock wiring, boots everything below
  room.js           → the mesh manager: join/admission protocol, tiles, presence, grid
  content-share.js  → shared Music Mode + Movie Mode pipeline
  chat.js           → the chat panel
  theater.js        → the local full-screen "watch together" focus view
  guard.js          → early anti-clickjacking guard
  vendor/           → self-hosted PeerJS (no third-party CDN at runtime)
ARCHITECTURE.md     → mesh topology, protocol, Music/Movie Mode engineering decisions
DESIGN.md           → the design system: type, colour, space, motion, components
SECURITY.md         → threat model + hardening (CSP, self-hosted code, etc.)
```

## Design

Visual identity modelled on [The Climate Pledge](https://www.theclimatepledge.com):
warm off-white, a signature green, soft pastel colour-blocks, and generous
rounding. Two fonts, no more: **Lexend** (headings) and **Noto Sans Display**
(everything else). Every colour, size, and timing is a token in `:root` — see
[`DESIGN.md`](DESIGN.md).

## Using it

1. Open the site and click **Start a call** (or **Watch together**).
2. Enter your name, then you'll see a camera preview before anything's sent —
   check your mic/camera, then **Open the room** or **Ask to join**.
3. If you're joining someone else's room, you'll wait until the host lets you
   in — they see who's asking and can admit or deny each request.
4. Copy the invite link (always visible in the room bar) and send it to your
   friends.

During a call you can mute, turn the camera off, chat, and:

- **Call with friends** — not just 1-to-1. A handful of people can be in the
  same room at once, each tile in a grid that adapts to the group size.
- **Movie Mode** — share a window, tab, or your whole screen, audio included,
  tuned for smooth playback rather than screen-share sharpness. Anyone
  watching can drop into a distraction-free **theater view** — tiles, dock,
  and chat all fade away — and leave it any time without affecting anyone
  else's view.
- **Music Mode** — share a browser tab that's playing music (a YouTube tab,
  Spotify Web Player, …) and everyone in the room hears it, unprocessed —
  no echo cancellation fighting the track. Muted by default for the cleanest
  sound; the mic button becomes **"Talk over music"** if you want to add
  commentary. Only one person's Music or Movie share is "the thing" at a
  time, so it actually feels like listening/watching together.
- **Chat** — a lightweight panel, sender name and timestamp on every message,
  auto-scrolling, with an unread badge while it's closed.

A few things happen automatically:

- **Camera-off avatar** — instead of a frozen or black frame, a tile shows a
  simple face glyph on a random pastel background while that person's camera
  is off (a tiny presence signal exchanged over a data channel is what lets
  your camera state show up on *their* screen too).
- **Mic level meter** — a small bar-graph next to the mic button reflects what
  your microphone is actually picking up, so you can see your voice is
  registering. Whoever's currently making sound gets a subtle ring around
  their tile.
- **Connection banner** — if your internet drops, the connection degrades, or
  the call gets large enough that turning cameras off would help, a slim
  banner says so and clears itself once things recover. It never blocks the
  call or forces you to do anything.
- **On-screen invite** — the host's shareable link stays visible in the room
  bar for the whole call, not just tucked in the control dock.

## Run it locally

No build step. Serve the folder over `http` (WebRTC needs a secure context —
`localhost` counts):

```bash
npx serve .
# or
python3 -m http.server 5050
```

Then open `http://localhost:5050`. To test a real call, open the invite link in a
second tab or on another device.

## Deploy

It's already set up for **GitHub Pages** — enable Pages on the `main` branch
(root) in the repository settings and it publishes as-is.

## Notes & limits

- Built and tuned for **small groups (~4-6 people)** — mesh means every
  participant connects to every other one directly, so cost scales per
  person. Past that, a non-blocking banner suggests turning cameras off;
  nothing is hard-capped. See `ARCHITECTURE.md` → "Why mesh, not a media
  server."
- Best in Chrome and Edge. Movie Mode (screen/window/tab + audio) works
  broadly; Music Mode specifically needs **tab-audio capture**, which is
  reliable on Chrome/Edge, partial on Firefox, and unavailable on Safari —
  see `ARCHITECTURE.md`'s browser-support table. Both features disable
  themselves with a clear message rather than failing silently when
  unsupported.
- New joins go through the host — if the host's tab closes, everyone already
  in the mesh stays connected, but nobody new can join until the host
  reopens the room. See `ARCHITECTURE.md` → "Known limitations."
- The PeerJS public broker only relays connection setup — it never sees your
  audio, video, or chat. For heavy production use you'd run your own
  PeerServer, but the public one is perfect for a group of friends.

---

Built with WebRTC + PeerJS. Visual identity inspired by The Climate Pledge.
