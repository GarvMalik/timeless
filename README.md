# Timeless

A quiet, peer-to-peer meeting room. Two people, one link — video and screen
sharing drawn directly between browsers over WebRTC. No accounts, no downloads,
nothing to install, and no server of our own to run.

**Live:** https://garvmalik.github.io/timeless/

---

## How it works

Timeless is a static site. All the meeting logic runs in the browser:

- **Media & transport** — [WebRTC](https://webrtc.org/) carries audio and video
  peer-to-peer between the two participants.
- **Signalling** — handled by the free public [PeerJS](https://peerjs.com/)
  cloud broker, so there's no backend to host or pay for. The PeerJS library
  itself is **self-hosted** (`assets/vendor/`), so no third-party script runs on
  the page — see [`SECURITY.md`](SECURITY.md).
- **Rooms** — the host's browser owns a short room code (its PeerJS id). The
  guest opens `call.html?room=CODE` and connects straight to the host. A single
  connection carries both directions.

```
index.html      → landing page
call.html       → the meeting room (lobby + live call)
assets/
  styles.css    → the design system, in CSS custom properties
  site.js       → landing reveal animations
  call.js       → PeerJS / WebRTC call logic
  guard.js      → early anti-clickjacking guard
  vendor/       → self-hosted PeerJS (no third-party CDN at runtime)
DESIGN.md       → the design system: type, colour, space, motion, components
SECURITY.md     → threat model + hardening (CSP, self-hosted code, etc.)
```

## Design

Visual identity modelled on [The Climate Pledge](https://www.theclimatepledge.com):
warm off-white, a signature green, soft pastel colour-blocks, generous rounding,
and generous rounding. Two fonts, no more: **Lexend** (headings) and
**Noto Sans Display** (everything else). Every colour, size, and timing is a
token in `:root` — see [`DESIGN.md`](DESIGN.md).

## Using it

1. Open the site and click **Start a call** (or **Share a screen**).
2. Click **Open the room**, allow camera + microphone.
3. Copy the invite link and send it to one other person.
4. They open the link, allow their camera, and you're connected.

During a call you can mute, turn the camera off, switch between your camera and
your screen, copy the invite again, or leave. A few things happen automatically:

- **Camera-off avatar** — instead of a frozen or black frame, a tile shows a
  simple face glyph on a random pastel background while that person's camera
  is off (a tiny presence signal exchanged over a PeerJS data channel is what
  lets your camera state show up on *their* screen too).
- **Mic level meter** — a small bar-graph next to the mic button reflects what
  your microphone is actually picking up, so you can see your voice is
  registering. Whichever side is currently making sound gets a subtle ring
  around their tile.
- **Connection banner** — if your internet drops or the peer connection
  degrades, a slim banner says so and clears itself once things recover. It
  never blocks the call or forces you to do anything.
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

- Best in Chrome, Edge, Safari, and Firefox. Screen sharing uses
  `getDisplayMedia`, which desktop browsers support (mobile support varies).
- The PeerJS public broker only relays connection setup — it never sees your
  audio or video. For heavy production use you'd run your own PeerServer, but the
  public one is perfect for a demo.
- Rooms are 1-to-1 by design, in keeping with the "unhurried conversation" idea.

---

Built with WebRTC + PeerJS. Visual identity inspired by The Climate Pledge.
