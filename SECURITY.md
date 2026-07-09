# Security

Timeless is a static site with no backend of its own, so the realistic attack
surface is small — but it's been deliberately hardened rather than left to
defaults. This documents what's in place and, honestly, what a static P2P app
can and can't guarantee.

## Threat model

- **What we protect:** the visitor's browser session and the confidentiality of
  a call. No accounts, no database, no cookies, no personal data at rest — there
  is simply nothing stored to breach.
- **In scope:** cross-site scripting (XSS), clickjacking, supply-chain
  tampering of third-party code, mixed content, injection via the room code,
  and eavesdropping on the media stream.
- **Out of scope (and why):** DoS against GitHub Pages / the public PeerJS
  broker (infrastructure we don't own), and a participant screen-recording their
  own call (not a technical control).

## Controls

### 1. Strict Content-Security-Policy
Every page ships a restrictive CSP (`<meta http-equiv>`):

```
default-src 'none';
script-src  'self';                         ← no inline/eval, no third-party JS
style-src   'self' https://fonts.googleapis.com;
font-src    https://fonts.gstatic.com;
img-src     'self' data:;
media-src   'self' blob: mediastream:;      ← the WebRTC video streams
connect-src 'self' wss://0.peerjs.com https://0.peerjs.com;  ← signalling only
base-uri 'none'; form-action 'self'; frame-ancestors 'none';
object-src 'none'; upgrade-insecure-requests;
```

- `default-src 'none'` means anything not explicitly allowed is blocked.
- **No `'unsafe-inline'` and no `'unsafe-eval'`.** There are zero inline scripts
  and zero inline event handlers in the markup, so an injected `<script>` or
  `onerror=` simply won't execute.

### 2. No third-party code at runtime
The PeerJS library is **self-hosted** (`assets/vendor/peerjs-1.5.4.min.js`),
pinned to an exact version. There is no CDN `<script>` to poison, and
`script-src 'self'` forbids loading one even if markup were injected. The only
third party contacted at runtime is the PeerJS signalling broker, over `wss://`.

### 3. XSS-safe DOM
All dynamic text is written with `textContent` or `createElement`/`appendChild`
— never `innerHTML` with runtime data. The room code is the only external input,
and it is validated before use.

### 4. Room-code validation (injection boundary)
Anything derived from the URL (`?room=`) or the join field is checked against a
strict allow-list — `^[a-z0-9]{4,40}$` — **before** it is handed to PeerJS or
written into an invite link. A malformed value never reaches the signalling
layer; the page falls back to hosting a fresh room.

### 5. Unguessable rooms
Room codes are generated with the Web Crypto CSPRNG
(`crypto.getRandomValues`), 10 characters from a 31-symbol alphabet
(≈ 8×10¹⁴ combinations). Because knowing a code is what lets a peer connect,
this makes rooms impractical to brute-force or enumerate.

### 6. Media confidentiality
Audio and video are **peer-to-peer over WebRTC**, which is encrypted in transit
by mandate (DTLS-SRTP). The broker relays only connection-setup metadata — it
never sees or relays your media.

A small **presence data channel** (also a WebRTC `RTCDataChannel`, so equally
DTLS-encrypted) runs alongside the media for the camera-off-avatar and
muted-badge features. It carries exactly three booleans (`cam`/`mic`/`screen`)
and nothing else — no identifiers, no content, no audio levels. Mic-level
metering and the "speaking" ring are computed entirely with local Web Audio
analysis on streams already present in the browser; nothing about your voice
is ever transmitted for that feature.

### 7. Clickjacking
`frame-ancestors 'none'` is set, and because a `<meta>` CSP can't enforce that
directive, an early synchronous `assets/guard.js` also busts the page out of any
frame.

### 8. Transport & privacy hygiene
- HTTPS is enforced by GitHub Pages, and `upgrade-insecure-requests` blocks any
  accidental mixed content.
- `referrer: no-referrer` and `rel="noopener noreferrer"` on outbound links stop
  URL/room-code leakage via the `Referer` header or `window.opener`.
- Camera and microphone are requested only on an explicit click, and every track
  is stopped on leave.

## Honest limitations

- The **public PeerJS broker** is shared infrastructure. It can't read your
  media, but for a high-assurance deployment you'd run your own PeerServer and
  point `PEER_OPTS` at it.
- A few response headers (`X-Content-Type-Options`, `Permissions-Policy`) can
  only be set as real HTTP headers, which GitHub Pages doesn't allow. Hosting
  behind a CDN/proxy that adds them would close that last gap.

## Reporting

Found something? Open an issue at
https://github.com/GarvMalik/timeless/issues.
