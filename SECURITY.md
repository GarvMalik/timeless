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
by mandate (DTLS-SRTP), in a full mesh — every participant connects directly
to every other participant, so nobody's media ever passes through a server we
(or anyone else) run. The broker relays only connection-setup metadata for
each pair — it never sees or relays media.

A small **data channel** (also a WebRTC `RTCDataChannel`, so equally
DTLS-encrypted) runs alongside the media on every pairwise connection, for
presence (camera-off-avatar, muted badge), the join/roster/admission
handshake, chat, and content-sharing coordination. Every message is a small,
typed, primitive-only JSON object — see `ARCHITECTURE.md` for the exact
schemas — with names capped at 40 characters and chat text at 2,000. Mic-level
metering and the "speaking" ring are computed entirely with local Web Audio
analysis on streams already present in the browser; nothing about your voice
is ever transmitted for that feature. Movie/Music Mode's captured audio and
video flow the same peer-to-peer way as camera/mic — no new server, no new
origin (see the CSP above, unchanged for these features).

### 7. Host-gated admission (waiting room)
Joining isn't automatic: a new participant's data connection to the host
sends a "knock," and the host must explicitly admit or deny them — see
`ARCHITECTURE.md` → "Join & admission protocol". This gives the host real-time
visibility and control over who enters, on top of the room code itself. It's
worth being precise about what this is and isn't: **it's a cooperative-client
UX gate, not a cryptographic access control.** The room code remains the actual
secret — the host-side code defensively answers only calls from peer ids it
explicitly admitted, but a custom client that skipped the knock step
entirely could still attempt to reach a known code. Don't share a room code
with anyone you wouldn't want in the call, waiting room or not.

### 8. Clickjacking
`frame-ancestors 'none'` is set, and because a `<meta>` CSP can't enforce that
directive, an early synchronous `assets/guard.js` also busts the page out of any
frame.

### 9. Transport & privacy hygiene
- HTTPS is enforced by GitHub Pages, and `upgrade-insecure-requests` blocks any
  accidental mixed content.
- `referrer: no-referrer` and `rel="noopener noreferrer"` on outbound links stop
  URL/room-code leakage via the `Referer` header or `window.opener`.
- Camera and microphone are requested only on an explicit click, and every track
  is stopped on leave — including when the camera itself is toggled off
  mid-call, which now actually stops the hardware track (not just mutes it;
  see `assets/room.js`'s `setLocalCam`) so the camera's hardware indicator
  light genuinely turns off, not just the on-screen preview.

### 10. TURN relay — encrypted-only, not a media access point
`PEER_OPTS` (`assets/room.js`) adds a free public TURN relay (Open Relay
Project) alongside STUN, so two participants behind restrictive/symmetric-NAT
networks can still connect (STUN alone can't help there — see
`ARCHITECTURE.md`). This is a real third party in the connection-setup path
when it's actually used, so it's worth being precise: a TURN server only ever
relays already-encrypted DTLS-SRTP packets — it has no key material and
cannot decrypt media. It's a reliability improvement, not a new party with
access to your call.

*Not a security control, but adjacent and worth naming:* `assets/room.js`
also now attempts `pc.restartIce()` on a degraded/failed connection before
giving up — a resilience mechanism (see `ARCHITECTURE.md` → "Reconnection"),
not a security boundary.

## Honest limitations

- The **public PeerJS broker** is shared infrastructure. It can't read your
  media, but for a high-assurance deployment you'd run your own PeerServer and
  point `PEER_OPTS` at it.
- A few response headers (`X-Content-Type-Options`, `Permissions-Policy`) can
  only be set as real HTTP headers, which GitHub Pages doesn't allow. Hosting
  behind a CDN/proxy that adds them would close that last gap.
- **The waiting room is cooperative, not cryptographic** — see control 7
  above. The room code is still the real access boundary.
- **New joins depend on the host staying reachable** — a mesh limitation of
  not running a server, documented in full in `ARCHITECTURE.md` → "Known
  limitations."

## Not applicable — and why

A generic "production security checklist" includes a lot of controls that
presuppose a backend, a database, or a login system: authentication and
authorization, session management, JWT/refresh-token handling, secure
cookies, CSRF protection, SQL/NoSQL injection, rate limiting and brute-force
protection, file-upload security, dependency/audit-logging pipelines, request
signing, server TLS/certificate configuration.

Timeless has none of those things to protect, on purpose — there is no
server we run, no database, no accounts, no login, no file uploads, no API
endpoints. That's not an oversight this document is working around; it's the
same architectural decision documented throughout `ARCHITECTURE.md` (mesh
instead of a media server, specifically chosen for privacy and to avoid
introducing exactly this category of infrastructure and its attack surface).
Adding session/JWT/SQL-injection-style controls here wouldn't be a smaller
version of that work — it would mean building the backend this project
deliberately doesn't have. If that's ever wanted, it's the SFU/server fork
described in `ARCHITECTURE.md`, not an incremental addition to what exists
today.

What *does* exist in that spirit and is genuinely reviewed above: the room
code is the de facto credential (control 5), the host admission gate is the
closest thing to "authorization" this architecture has (control 7, with its
limits stated plainly), and the CSP/self-hosted-script/XSS discipline
(controls 1-3) are this app's actual equivalent of "input validation and
output sanitization" for the one real trust boundary it has — a room code
and a handful of small JSON messages, not a request body or a form upload.

## Reporting

Found something? Open an issue at
https://github.com/GarvMalik/timeless/issues.
