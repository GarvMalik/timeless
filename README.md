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

Two typefaces, no more: **Syne** (display) and **Space Mono** (everything
else). Warm paper, near-black ink, one clay accent, hairline grids, and a single
dark inverted band. Every colour, size, and timing is a token in `:root` — see
[`DESIGN.md`](DESIGN.md).

## Using it

1. Open the site and click **Start a call** (or **Share a screen**).
2. Click **Open the room**, allow camera + microphone.
3. Copy the invite link and send it to one other person.
4. They open the link, allow their camera, and you're connected.

During a call you can mute, turn the camera off, switch between your camera and
your screen, copy the invite again, or leave.

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

Built with WebRTC + PeerJS. Design inspired by the restraint of studio sites
like bymonolog and The Line Studio.
