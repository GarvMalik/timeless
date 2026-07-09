# Timeless — Architecture

Timeless is a static site with no backend of its own. Every feature below —
group calls, Music Mode, Movie Mode, chat, the host waiting room — is built
entirely in the browser, signalled over the free public
[PeerJS](https://peerjs.com/) broker. This document is the map: the network
topology, the join/admission protocol, the message schemas, and the specific
engineering decisions behind Music Mode and Movie Mode, written down so the
"why," not just the "what," survives.

## Why mesh, not a media server (SFU)

Real many-to-many video at scale needs a media server (an SFU) that mixes and
relays streams — otherwise every participant has to upload their own video
once *per other participant*, which gets expensive fast. Timeless doesn't have
one, on purpose. For a small group (this is built and tuned for **~4-6
people**, not a large meeting), a full **WebRTC mesh** — every participant
connects directly to every other participant — has two real advantages over
introducing a server:

1. **It's strictly more private.** Media never leaves the participants' own
   browsers. An SFU is, by definition, a middlebox that receives and
   re-transmits everyone's real audio/video — even a well-run one adds a third
   party (and its cloud provider, jurisdiction, and terms of service) into the
   trust model. Mesh has none of that.
2. **It's free with no new moving parts.** Every "free" SFU option
   (Cloudflare Calls, LiveKit Cloud, …) still requires a third-party account,
   an API secret held somewhere, and a small deployed backend to mint tokens.
   Mesh needs none of it — the existing free PeerJS signalling broker is the
   only external service involved, and it never sees media, only connection
   setup.

The honest trade-off: mesh bandwidth/CPU cost scales per participant, so it
gets rough well before "large meeting" territory. Past ~6 participants,
Timeless shows a quiet, non-blocking advisory suggesting people turn their
cameras off — never a hard cap.

**ICE servers: STUN alone isn't enough for reliable connections.** STUN only
helps two peers *discover* their own public address — it does nothing for two
peers behind symmetric NATs or restrictive/corporate firewalls that can't
open a direct path to each other at all. Without a relay fallback, those
calls simply fail to connect, with no recovery possible. `PEER_OPTS` in
`assets/room.js` adds a free public TURN relay (Open Relay Project) alongside
STUN for exactly this case. Worth being precise about the trust model here,
same spirit as the mesh-vs-SFU reasoning above: a TURN server is a real third
party in the connection path when it's used, but it only ever forwards
already-encrypted DTLS-SRTP packets — it has no way to decrypt media. It's a
reliability improvement, not a privacy concession.

## Topology

```
        ┌─────────┐
        │  Host    │  ← the room code IS this peer's PeerJS id
        └────┬────┘
    knock/admit (gated)
   ┌──────────┼──────────┐
   ▼          ▼          ▼
 Guest A   Guest B    Guest C
   │  \      │  \       │
   │   \─────┼───\──────┤   (once introduced via the roster, every
   │         │    \     │    participant connects directly to every
   └─────────┴─────┴────┘    other participant — full mesh)
```

The host is special in exactly two ways, both only at *join time*:

1. **Discovery** — a newcomer only ever knows the host's peer id (the room
   code), so they always reach the host first.
2. **Admission** — the host decides whether a newcomer gets in at all (see
   below).

Once someone is in the mesh, the host has no further special role in their
connection — media, presence, chat, and content-sharing all flow directly
between whichever two peers are talking.

## Join & admission protocol

Modelled on a normal video-call "waiting room": a guest doesn't just appear in
the call — they knock, the host sees who's asking, and lets them in (or
doesn't) before anything else happens.

1. Guest opens a **data connection** to the host and sends `{t:'knock', name}`.
   Nothing else happens yet — no media call, no roster.
2. The host shows an admit/deny card for that name. If several people knock
   around the same time, each gets its own card.
3. **Admit** → host replies `{t:'admit'}` on that same connection. *Only now*
   does the guest place its media call to the host. The host then sends the
   guest a **roster** — `{peerId, name}` for everyone already in the room —
   and tells everyone else `{t:'joined', peerId, name}` so their tiles are
   labelled correctly the instant the newcomer connects to them directly.
4. **Deny** → host replies `{t:'deny'}` and closes the connection. The guest
   sees a plain "the host didn't let you in" message and can ask again.
5. The guest calls + data-connects to every peer in the roster it received.
   **Nobody but the host gates this step** — once admitted, meshing with the
   rest of the room is automatic, the same way it would be rude for every
   existing participant to also have to approve a newcomer the host already
   let in.

Two things worth being explicit about:

- **This is a cooperative-client gate, not a cryptographic access control.**
  The room *code* is still the actual secret (same as before this feature) —
  anyone running their own code instead of the Timeless page could in
  principle skip the knock step. The host-side code defensively answers only
  calls from peer ids it explicitly admitted, but the real privacy boundary
  remains "don't share your room code with people you don't want in the
  room." The waiting room's value is UX and host control for everyone using
  the actual site, not a hard security guarantee beyond that.
- **No explicit "left" broadcast exists.** Early drafts of this protocol had
  the host relay `{t:'left', peerId}` to everyone when someone disconnected —
  but in a full mesh, every participant already has a *direct* connection to
  every other participant, so each of them independently observes that
  connection close. Relaying it from the host would just be a slower,
  redundant copy of information everyone already has. Removed rather than
  built, on purpose.

## Data channel message schemas

All JSON, sent over each pairwise PeerJS `DataConnection`:

```
{ t: 'knock',  name }                                       // guest -> host only
{ t: 'admit' }  |  { t: 'deny' }                             // host -> that guest only
{ t: 'roster', peers: [{ peerId, name }] }                   // host -> new guest only
{ t: 'joined', peerId, name }                                // host -> everyone else
{ t: 'state',  name, cam, mic, content: 'none'|'movie'|'music' }  // to all, on any change
{ t: 'chat',   id, name, text, ts }                          // fan-out to all
{ t: 'claim',  kind: 'movie'|'music'|'none', peerId, ts }    // fan-out to all
```

Every field is a primitive. `name` is capped at 40 characters, `text` at
2,000. Every one of these is rendered with `textContent`/`createElement`,
**never** `innerHTML` — the same invariant `SECURITY.md` has documented from
the start, now extended to a few more message types.

## Why one content pipeline for Music Mode and Movie Mode

Both features need to send "audio that isn't the mic, at full quality" to
everyone. The naive approach — add a second audio track to each connection —
requires SDP renegotiation (`onnegotiationneeded`) on every mesh connection,
which gets fragile fast once there are several peers to keep in sync.

Instead, both modes share one pipeline (`assets/content-share.js`) built
around a technique already used elsewhere in this codebase for camera↔screen
swaps: **`RTCRtpSender.replaceTrack`**. A small Web Audio graph
(`AudioContext` + `MediaStreamAudioDestinationNode`) mixes the content audio
with the (optionally muted) mic, and the single mixed track is pushed onto
every existing sender via `replaceTrack` — no renegotiation, no new tracks,
same technique at 1 peer or 6.

Movie Mode is Music Mode's video-carrying sibling, not a separate feature: it
reuses the exact same mixing/replace/claim machinery, plus a video track.

**Only one participant's content is "the shared thing" at a time,** so it
feels like watching/listening together, not N independent shares. Starting
Movie/Music broadcasts a `claim`; if someone else already holds one, the
requester gets a clear "X is already sharing" message and nothing starts. A
rare simultaneous-start race is resolved by comparing claim timestamps
(peer-id as a tiebreaker) — no server needed to arbitrate this at this scale.

## Music Mode: what "sharing music" actually captures

**We capture a browser tab's audio, not "system audio."** True OS-wide
system-audio capture from a browser is inconsistent across platforms:

| Browser / OS | Tab audio | Full "system audio" |
|---|---|---|
| Chrome / Edge (Windows, ChromeOS, Linux) | ✅ reliable | ⚠️ only via "Entire Screen" + "Share system audio," Windows-only |
| Chrome / Edge (macOS) | ✅ reliable | ❌ not exposed — macOS restricts it |
| Firefox | ⚠️ partial, inconsistent | ❌ |
| Safari | ❌ no display-audio capture at all | ❌ |

Targeting a **tab that's playing the music** (a YouTube tab, Spotify Web
Player, SoundCloud, …) is the one technique that's actually reliable
cross-platform — the same idea Discord's tab-audio sharing and similar
"share this tab's sound" features use. The UI says exactly this ("share a tab
that's playing music") instead of promising system audio it can't always
deliver. If `getDisplayMedia` isn't available at all, or the captured stream
comes back with no audio track, Music Mode disables itself with a clear
message rather than failing silently — see `assets/content-share.js`'s
`unsupported`/`no-audio` events.

Bonus: display-captured audio bypasses mic-only processing entirely — echo
cancellation, noise suppression, and automatic gain control are
`getUserMedia` mic constraints; display audio is raw. That's exactly the "no
distortion, no aggressive noise suppression" requirement, with no special
handling needed.

**Default behavior is music-only (mic muted).** Talking over music while
your own mic is live and unprocessed risks feedback without headphones, so
rather than a second, easy-to-forget "include my mic" toggle, the existing
mic button becomes **"Talk over music"** (same control, relabelled) while
Music Mode is active — unmuting it is the opt-in.

## Movie Mode: quality tuning

`getDisplayMedia` is requested with `frameRate: {ideal: 30, max: 60}` and
`width/height: {ideal: 1920/1080}`, the video track's `contentHint` is set to
`'motion'` (bias the encoder toward frame rate over sharpness — the opposite
of what you'd want for sharing a spreadsheet), and each sender's
`degradationPreference` is set to `'maintain-framerate'` with a raised
`maxBitrate` (~3 Mbps) so WebRTC's congestion control has headroom to keep
motion smooth rather than aggressively downscaling resolution first. Audio
goes through the same mixing pipeline as Music Mode.

Movie Mode **replaces the old "Share screen" button rather than sitting
alongside it** — plain screen-share (video only, no audio, no tuning) was
exactly the gap Movie Mode closes, so there's one button, upgraded, not two
overlapping ones.

Theater/focus view (`assets/theater.js`) is **purely local UI state, never
synced** — any viewer can enter or exit their own full-screen focus view of
the current shared content independent of everyone else. It only auto-exits
when the underlying content itself actually stops (the sharer ends it, the
browser's own "Stop sharing" control is used, or the shared tab/window
closes) — a real state change everyone needs to see, not a preference.

## Audio profiles: voice, music, movie

Three distinct, explicit constraint/bitrate profiles, rather than one
default used everywhere:

- **Voice** (camera calls, `assets/call.js`'s `acquireCamera`) —
  `echoCancellation: true, noiseSuppression: true, autoGainControl: true`.
  Good defaults for speech, made explicit rather than left to whatever a
  given browser's implicit default happens to be.
- **Content audio** (Music/Movie Mode, shared pipeline in
  `assets/content-share.js`) — the opposite:
  `echoCancellation: false, noiseSuppression: false, autoGainControl: false`
  on the `getDisplayMedia` request. Display audio already bypasses mic-only
  processing by default in most browsers; disabling these explicitly is
  belt-and-suspenders and documents the intent in code, not just a comment —
  echo cancellation tuned for silence detection, or noise suppression,
  actively damages music/movie audio.
- **Bitrate** — Opus's default is speech-tuned (~24-32 kbps), nowhere near
  enough for music or a movie's soundtrack. `_tuneAudioEncoding` raises the
  content-audio sender's `maxBitrate` to 128 kbps via
  `RTCRtpSender.setParameters` for both Music and Movie Mode. This applies
  retroactively too: a participant who joins **while** content is already
  being shared gets the same tuning applied to their connection the moment
  they connect (`_applyCurrentContentTo`) — otherwise they'd be seeded from
  the sharer's stale camera/mic, since a new connection is negotiated with
  `room.localStream`'s tracks, and content sharing only touches individual
  senders, not that base stream.
- **Honest limitation: no Opus stereo.** True stereo needs an SDP-level
  `stereo=1` fmtp parameter, which isn't reachable through
  `RTCRtpSender.setParameters` and isn't safely reachable through PeerJS's
  internal offer/answer handling without risking connection stability by
  hand-editing SDP underneath it. The bitrate increase above is the real,
  safely-implementable win; stereo would need deeper SDP-level negotiation
  control than this architecture currently takes on.

## Reconnection

`assets/room.js` watches each connection's `iceConnectionState` and attempts
real recovery, not just a "trouble" banner: a `disconnected` state gets a
5-second grace period to self-resolve (common for a brief wifi hiccup or NAT
rebinding) before calling `pc.restartIce()`; a `failed` state gets one
immediately. This is a standards-based recovery path — PeerJS listens for the
resulting `negotiationneeded` internally, so no signalling changes were
needed to support it.

What this doesn't do: resume a session after a connection is fully and
permanently gone (e.g. the other tab actually closed, or `restartIce()`
itself can't find a path even with TURN available) — that's not a
"reconnect," that's someone having left, and the existing participant-left
handling covers it correctly.

## Known limitations

- **New joins depend on the host staying reachable.** If the host's tab
  closes, everyone already in the mesh stays connected to each other (mesh
  connections are direct, not routed through the host) — but a brand-new
  invite link names the host specifically, so nobody new can get in until
  the host reopens the room. Not solved in this pass; a future iteration
  could let any participant mint a fresh invite that points at themselves,
  but that changes what "the room code" means and was out of scope here.
- **The admission gate is cooperative, not cryptographic** — see above.
- **Mesh has a practical ceiling.** Designed and tuned for ~4-6 participants;
  past that, a non-blocking advisory suggests turning cameras off, but
  nothing is hard-blocked.
- **Reconnection is best-effort, not guaranteed.** `restartIce()` (see
  "Reconnection" above) recovers many transient network hiccups, but if a
  connection is fully and permanently gone — the other side actually closed,
  or no path exists even via TURN — there's no automatic session resume;
  that participant needs to rejoin.
