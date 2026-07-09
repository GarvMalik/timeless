/* =========================================================================
   Timeless — room.js
   The mesh manager. Owns the local Peer, every remote Participant, the
   join/roster/admission protocol, per-tile DOM, presence, audio meters, and
   the grid layout. See ARCHITECTURE.md for the full protocol write-up.

   Topology: full WebRTC mesh over the free PeerJS signalling broker (no
   media server — see ARCHITECTURE.md "why mesh, not an SFU"). The room's
   host is the sole rendezvous point for *discovery* (new joiners always
   reach the host first) and the sole *admission gate* (a new joiner must be
   admitted by the host before they're wired into the mesh at all — see
   "Join & admission protocol" below). Once two participants are connected,
   media and chat flow directly between their browsers; the host has no
   further special role in an established connection.
   ========================================================================= */

export const AVATAR_COLORS = ['#c4f0d0', '#cbe2f9', '#f4e2d6', '#eddfeb', '#f9e9b8', '#d9e8d3'];

// Room codes double as PeerJS ids for the host. Anyone who knows the code
// can *knock* — see the admission gate below — so codes are long enough to
// be unguessable (10 chars, 31-symbol alphabet ~ 8.2e14 combinations) and
// drawn from a CSPRNG, never Math.random().
const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const CODE_LEN = 10;

// Explicit, secure signalling config — pinned so it always uses wss:// and
// matches the page's Content-Security-Policy connect-src. The broker only
// relays connection setup; audio/video/chat never touch it (peer-to-peer).
//
// iceServers: STUN alone can't help two peers behind symmetric NATs or
// restrictive/corporate firewalls find each other — without a relay
// fallback, those calls simply fail to connect. The TURN entries below (Open
// Relay Project's public, free relay) only ever forward already-encrypted
// DTLS-SRTP packets when a direct path can't be found — they cannot decrypt
// media. See SECURITY.md / ARCHITECTURE.md for the full trust-model note.
const PEER_OPTS = {
  host: '0.peerjs.com',
  port: 443,
  secure: true,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'turn:global.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:global.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  },
};

const NAME_MAX = 40;
const LARGE_CALL_THRESHOLD = 6; // advisory only — see call.js showBanner('perf', ...)

export function randomItem(list) {
  if (window.crypto && window.crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    window.crypto.getRandomValues(buf);
    return list[buf[0] % list.length];
  }
  return list[Math.floor(Math.random() * list.length)];
}

export function makeCode() {
  let out = '';
  const n = CODE_ALPHABET.length;
  if (window.crypto && window.crypto.getRandomValues) {
    const buf = new Uint32Array(CODE_LEN);
    window.crypto.getRandomValues(buf);
    for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[buf[i] % n];
  } else {
    for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[Math.floor(Math.random() * n)];
  }
  return out;
}

// Strict allow-list: only ever accept short lowercase-alphanumeric codes.
// This is the trust boundary for anything derived from the URL or a text
// field before it's handed to PeerJS or written into an invite link.
export function isValidCode(c) {
  return typeof c === 'string' && /^[a-z0-9]{4,40}$/.test(c);
}

export function cleanName(raw) {
  return (raw || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

// ---------------------------------------------------------------------------
// audio meter — local Web Audio analysis only; nothing here is ever sent
// anywhere. Reused for the local mic-level bars and for "who's speaking"
// highlighting on every tile (local and remote alike).
// ---------------------------------------------------------------------------
const SPEAK_THRESHOLD = 0.06;

function createMeter(stream, onLevel) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  const track = stream.getAudioTracks()[0];
  if (!track) return null;

  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);
  let raf = null;
  let stopped = false;

  function tick() {
    if (stopped) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length); // 0..~1
    onLevel(Math.min(1, rms * 4)); // raw mic RMS reads very quiet — scale up
    raf = requestAnimationFrame(tick);
  }
  tick();

  return {
    stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      try { source.disconnect(); } catch (e) {}
      try { ctx.close(); } catch (e) {}
    },
  };
}

// ---------------------------------------------------------------------------
// grid layout — a small "balanced columns" heuristic (same family of
// algorithm Meet/Zoom use), applied as a CSS custom property so the actual
// wrapping stays pure CSS grid.
// ---------------------------------------------------------------------------
function columnsFor(count) {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Participant — one remote peer's DOM + connection state
// ---------------------------------------------------------------------------
class Participant {
  constructor(peerId, tileEl) {
    this.peerId = peerId;
    this.name = 'Someone';
    this.call = null; // PeerJS MediaConnection
    this.conn = null; // PeerJS DataConnection
    this.stream = null;
    this.tile = tileEl;
    this.video = tileEl.querySelector('video');
    this.avatar = tileEl.querySelector('.avatar');
    this.badge = tileEl.querySelector('.tile__badge');
    this.tag = tileEl.querySelector('.tile__tag');
    this.avatarColor = null;
    this.state = { cam: true, mic: true, content: 'none' };
    this.meter = null;
    this.troubled = false;
    this.reconnectTimer = null;
    // cached senders — see replaceSenderTrack() for why these must be
    // cached rather than looked up fresh by track.kind every time
    this.videoSender = null;
    this.audioSender = null;
  }

  applyName(name) {
    this.name = name || 'Someone';
    this.tag.textContent = this.name;
  }

  updateAvatar() {
    if (!this.avatarColor) {
      this.avatarColor = randomItem(AVATAR_COLORS);
      this.avatar.style.background = this.avatarColor;
    }
    this.avatar.hidden = this.state.cam || this.state.content !== 'none';
  }

  updateBadge() {
    this.badge.classList.toggle('show', !this.state.mic);
  }

  startMeter() {
    if (this.meter) this.meter.stop();
    if (!this.stream) return;
    this.meter = createMeter(this.stream, (level) => {
      this.tile.classList.toggle('tile--speaking', level > SPEAK_THRESHOLD);
    });
  }

  stopMeter() {
    if (this.meter) { this.meter.stop(); this.meter = null; }
  }

  destroy() {
    this.stopMeter();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { if (this.call) this.call.close(); } catch (e) {}
    try { if (this.conn) this.conn.close(); } catch (e) {}
    this.tile.remove();
  }
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------
export class Room extends EventTarget {
  constructor({ stageEl, tileTemplate, localVideoEl, localAvatarEl, localTagEl, localTileEl }) {
    super();
    this.stageEl = stageEl;
    this.tileTemplate = tileTemplate;
    this.localVideoEl = localVideoEl;
    this.localAvatarEl = localAvatarEl;
    this.localTagEl = localTagEl;
    this.localTileEl = localTileEl;

    this.peer = null;
    this.amHost = false;
    this.roomCode = null;
    this.myName = 'You';

    this.localStream = null;
    /** @type {Map<string, Participant>} */
    this.participants = new Map();

    // host-only: pending join requests, keyed by peerId
    this.pendingKnocks = new Map(); // peerId -> { conn: DataConnection, name: string }
    this.admittedPeerIds = new Set();

    // guest-only: the in-flight knock connection to the host, before admission
    this.knockConn = null;

    this.localState = { cam: true, mic: true, content: 'none' };
    this.localMeter = null;
    this.ended = false;
  }

  // ---- local media --------------------------------------------------------
  setLocalStream(stream) {
    this.localStream = stream;
    this.localVideoEl.srcObject = stream;
    if (this.localMeter) this.localMeter.stop();
    this.localMeter = createMeter(stream, (level) => {
      const speaking = this.localState.mic && level > SPEAK_THRESHOLD;
      this.localTileEl.classList.toggle('tile--speaking', speaking);
      this.dispatchEvent(new CustomEvent('mic-level', { detail: { level, speaking } }));
    });
    this._updateLocalAvatar();
  }

  setName(name) {
    this.myName = cleanName(name) || 'You';
  }

  _updateLocalAvatar() {
    if (!this.localAvatarColor) this.localAvatarColor = randomItem(AVATAR_COLORS);
    this.localAvatarEl.style.background = this.localAvatarColor;
    this.localAvatarEl.hidden = this.localState.cam || this.localState.content !== 'none';
  }

  // Turning the camera "off" used to just set track.enabled = false — per
  // the WebRTC spec that mutes the track's *output* (frames become silent)
  // but the underlying hardware capture keeps running, so the camera's LED
  // stays lit. That's a real bug, not a cosmetic one. Fix: actually stop and
  // release the track when going off, and re-acquire a fresh one (no new
  // permission prompt — the origin already has a grant) when going back on.
  //
  // Both directions are genuinely async (stopping still awaits the sender
  // replaceTrack; turning back on awaits a fresh getUserMedia). A busy guard
  // is required, not optional — without it, a rapid off/on/off double-click
  // (or a slow re-acquire overlapping the next click) races two in-flight
  // calls against the same track/sender state and can leave things
  // inconsistent. Confirmed by testing rapid toggles end-to-end.
  async setLocalCam(on) {
    if (this._camBusy) return;
    this._camBusy = true;
    this.dispatchEvent(new CustomEvent('cam-loading', { detail: { loading: true } }));
    try {
      if (on) {
        let track;
        try {
          const cam = await navigator.mediaDevices.getUserMedia({ video: true });
          track = cam.getVideoTracks()[0];
        } catch (e) {
          this.dispatchEvent(new CustomEvent('cam-error', { detail: { error: e } }));
          return; // stay off — camera unavailable (unplugged, permission revoked, in use elsewhere)
        }
        await this.replaceSenderTrack('video', track);
        this.localStream.addTrack(track);
        this.localVideoEl.srcObject = this.localStream;
      } else {
        const track = this.localStream.getVideoTracks()[0];
        if (track) {
          this.localStream.removeTrack(track);
          track.stop(); // <-- this is what actually turns off the hardware/LED
        }
        await this.replaceSenderTrack('video', null);
      }
    } finally {
      this._camBusy = false;
      this.dispatchEvent(new CustomEvent('cam-loading', { detail: { loading: false } }));
    }
    this.localState.cam = on;
    this._updateLocalAvatar();
    this._broadcastState();
    this.dispatchEvent(new CustomEvent('local-state', { detail: { ...this.localState } }));
  }

  setLocalMic(on) {
    this.localState.mic = on;
    this.localStream.getAudioTracks().forEach((t) => { t.enabled = on; });
    this._broadcastState();
    this.dispatchEvent(new CustomEvent('local-state', { detail: { ...this.localState } }));
  }

  setLocalContent(kind) {
    this.localState.content = kind; // 'none' | 'movie' | 'music'
    // a mirrored self-view makes sense for a camera, not for a shared screen
    this.localTileEl.classList.toggle('tile--sharing', kind !== 'none');
    this._updateLocalAvatar();
    this._broadcastState();
    this.dispatchEvent(new CustomEvent('local-state', { detail: { ...this.localState } }));
  }

  // ---- generic replace-track fan-out (camera<->screen, camera on/off, and
  // the shared content-share pipeline all funnel through this — see
  // content-share.js) -------------------------------------------------------
  //
  // Senders are cached on the Participant the first time they're found by
  // kind, then always reused. This matters once a track has ever been
  // replaced with `null` (camera fully stopped, releasing hardware — see
  // setLocalCam): at that point `sender.track` is null, so a fresh
  // `getSenders().find(s => s.track && s.track.kind === kind)` lookup can no
  // longer find it, and turning the camera back on would have nowhere to
  // send the new track. Caching the reference the first time (while the
  // original non-null track still identifies it) sidesteps that entirely.
  async replaceSenderTrack(kind, track) {
    const cacheKey = kind === 'video' ? 'videoSender' : 'audioSender';
    const jobs = [];
    this.participants.forEach((p) => {
      if (!p.call || !p.call.peerConnection) return;
      let sender = p[cacheKey];
      if (!sender) {
        sender = p.call.peerConnection.getSenders().find((s) => s.track && s.track.kind === kind);
        if (sender) p[cacheKey] = sender;
      }
      if (sender) jobs.push(sender.replaceTrack(track));
    });
    await Promise.all(jobs);
  }

  // ---- data plane -----------------------------------------------------------
  broadcast(obj) {
    this.participants.forEach((p) => {
      if (p.conn && p.conn.open) {
        try { p.conn.send(obj); } catch (e) { /* connection mid-teardown */ }
      }
    });
  }

  _broadcastState() {
    this.broadcast({ t: 'state', name: this.myName, cam: this.localState.cam, mic: this.localState.mic, content: this.localState.content });
  }

  // =========================================================================
  // Join & admission protocol
  //
  // A newcomer always talks to the host first. The host is the sole
  // admission gate: a guest's data connection opens, sends a "knock," and
  // waits — nothing else happens until the host admits or denies them. Only
  // once admitted does the guest place its media call, and only then does
  // the host relay a roster of everyone else already in the room so the
  // newcomer can mesh directly with them (no gating from anyone else —
  // "the host" is the one gatekeeper, matching a normal video-call host
  // controlling who's let in).
  //
  // Note: this is a cooperative-client UX gate, not a cryptographic access
  // control — the room *code* is still the real secret (same as before).
  // See ARCHITECTURE.md.
  // =========================================================================

  openAsHost() {
    this.amHost = true;
    this.roomCode = makeCode();
    this.peer = new Peer(this.roomCode, PEER_OPTS);

    this.peer.on('open', (id) => {
      this.roomCode = id;
      this.dispatchEvent(new CustomEvent('host-ready', { detail: { code: id } }));
    });

    this.peer.on('connection', (conn) => this._handleHostConnection(conn));
    this.peer.on('call', (call) => this._handleHostCall(call));
    this.peer.on('error', (err) => this._handlePeerError(err, true));
    this.peer.on('disconnected', () => this.dispatchEvent(new CustomEvent('peer-disconnected')));
  }

  _handleHostConnection(conn) {
    const peerId = conn.peer;
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'knock' && !this.admittedPeerIds.has(peerId)) {
        const name = cleanName(msg.name) || 'Someone';
        this.pendingKnocks.set(peerId, { conn, name });
        this.dispatchEvent(new CustomEvent('knock', { detail: { peerId, name } }));
        return;
      }
      // already-admitted participant using this same conn for normal traffic
      this._routeData(peerId, msg);
    });
    conn.on('close', () => {
      if (this.pendingKnocks.has(peerId)) {
        this.pendingKnocks.delete(peerId);
        this.dispatchEvent(new CustomEvent('knock-cancelled', { detail: { peerId } }));
      }
      if (this.admittedPeerIds.has(peerId)) this._removeParticipant(peerId);
    });
  }

  admit(peerId) {
    const pending = this.pendingKnocks.get(peerId);
    if (!pending) return;
    const { conn, name } = pending;
    this.pendingKnocks.delete(peerId);
    this.admittedPeerIds.add(peerId);
    try { conn.send({ t: 'admit' }); } catch (e) {}

    // pre-seed the name so it's already set by the time 'participant-added'
    // dispatches — otherwise listeners (e.g. chat.js's "X joined" message)
    // would read the placeholder default name at event time
    this._pendingNames = this._pendingNames || new Map();
    this._pendingNames.set(peerId, name);
    const p = this._getOrCreateParticipant(peerId);
    p.conn = conn;
    this._sendRosterTo(peerId);
    this._broadcastJoined(peerId, p);
  }

  deny(peerId) {
    const pending = this.pendingKnocks.get(peerId);
    if (!pending) return;
    this.pendingKnocks.delete(peerId);
    try { pending.conn.send({ t: 'deny' }); } catch (e) {}
    setTimeout(() => { try { pending.conn.close(); } catch (e) {} }, 150); // let the send flush
  }

  _handleHostCall(call) {
    const peerId = call.peer;
    if (!this.admittedPeerIds.has(peerId)) {
      // shouldn't happen from our own client, but never wire an unadmitted call
      try { call.close(); } catch (e) {}
      return;
    }
    call.answer(this.localStream);
    const p = this._getOrCreateParticipant(peerId);
    this._wireCall(p, call);
  }

  _sendRosterTo(peerId) {
    const p = this.participants.get(peerId);
    if (!p || !p.conn) return;
    const peers = [];
    this.participants.forEach((other, id) => {
      if (id !== peerId) peers.push({ peerId: id, name: other.name });
    });
    try { p.conn.send({ t: 'roster', peers }); } catch (e) {}
  }

  _broadcastJoined(newPeerId, newParticipant) {
    this.participants.forEach((p, id) => {
      if (id === newPeerId || !p.conn || !p.conn.open) return;
      try { p.conn.send({ t: 'joined', peerId: newPeerId, name: newParticipant.name }); } catch (e) {}
    });
  }

  // ---- guest ----------------------------------------------------------------
  joinAsGuest(code) {
    this.amHost = false;
    this.roomCode = code;
    this.peer = new Peer(undefined, PEER_OPTS);

    this.peer.on('open', () => {
      const conn = this.peer.connect(code, { reliable: true });
      this.knockConn = conn;
      conn.on('open', () => {
        try { conn.send({ t: 'knock', name: this.myName }); } catch (e) {}
        this.dispatchEvent(new CustomEvent('knocking'));
      });
      conn.on('data', (msg) => this._handleKnockReply(code, conn, msg));
      conn.on('close', () => {
        if (this.knockConn === conn && !this.admittedPeerIds.has(code)) {
          this.dispatchEvent(new CustomEvent('join-failed', { detail: { message: 'The host closed the room before letting you in.' } }));
        }
      });
    });

    // incoming call/connection from a fellow guest we've been introduced to
    // via the roster — no admission gate between guests, only the host gates
    this.peer.on('connection', (conn) => this._handlePeerConnection(conn));
    this.peer.on('call', (call) => this._handlePeerCall(call));
    this.peer.on('error', (err) => this._handlePeerError(err, false));
    this.peer.on('disconnected', () => this.dispatchEvent(new CustomEvent('peer-disconnected')));
  }

  _handleKnockReply(hostCode, conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'admit') {
      this.admittedPeerIds.add(hostCode); // reuse the set to mean "host admitted us"
      const p = this._getOrCreateParticipant(hostCode);
      p.conn = conn;
      const call = this.peer.call(hostCode, this.localStream);
      if (!call) {
        this.dispatchEvent(new CustomEvent('join-failed', { detail: { message: 'Could not reach that room.' } }));
        return;
      }
      this._wireCall(p, call);
      conn.on('data', (m) => this._routeData(hostCode, m)); // future traffic on this conn
      this.dispatchEvent(new CustomEvent('admitted'));
    } else if (msg.t === 'deny') {
      this.dispatchEvent(new CustomEvent('denied'));
      this._teardownPeer();
    }
  }

  cancelJoin() {
    this._teardownPeer();
    this.dispatchEvent(new CustomEvent('join-cancelled'));
  }

  _handlePeerConnection(conn) {
    const peerId = conn.peer;
    const p = this._getOrCreateParticipant(peerId);
    p.conn = conn;
    conn.on('data', (msg) => this._routeData(peerId, msg));
    conn.on('close', () => this._removeParticipant(peerId));
  }

  _handlePeerCall(call) {
    const peerId = call.peer;
    call.answer(this.localStream);
    const p = this._getOrCreateParticipant(peerId);
    this._wireCall(p, call);
  }

  _handlePeerError(err, isHost) {
    const type = err && err.type;
    if (isHost && type === 'unavailable-id') {
      // vanishingly unlikely code collision — retry with a fresh one
      try { this.peer.destroy(); } catch (e) {}
      this.openAsHost();
      return;
    }
    if (!isHost && type === 'peer-unavailable') {
      this.dispatchEvent(new CustomEvent('join-failed', { detail: { message: 'No one is hosting that room. Ask them to open it first, then reload.' } }));
      return;
    }
    this.dispatchEvent(new CustomEvent('signal-error', { detail: { type: type || 'unknown' } }));
  }

  // ---- shared: newcomer meshes with everyone in the roster it receives -----
  _routeData(peerId, msg) {
    if (!msg || typeof msg !== 'object') return;
    const p = this.participants.get(peerId);
    switch (msg.t) {
      case 'roster':
        (msg.peers || []).forEach(({ peerId: id, name }) => {
          if (id === this.peer.id || this.participants.has(id)) return;
          const np = this._getOrCreateParticipant(id);
          np.applyName(name);
          const call = this.peer.call(id, this.localStream);
          if (call) this._wireCall(np, call);
          const conn = this.peer.connect(id, { reliable: true });
          np.conn = conn;
          conn.on('data', (m) => this._routeData(id, m));
          conn.on('close', () => this._removeParticipant(id));
        });
        break;
      case 'joined':
        if (msg.peerId && msg.peerId !== this.peer.id && !this.participants.has(msg.peerId)) {
          // the newcomer will call/connect to us directly — just note the name
          // ahead of time so the tile is labelled correctly the instant it appears
          this._pendingNames = this._pendingNames || new Map();
          this._pendingNames.set(msg.peerId, msg.name);
        }
        break;
      case 'state':
        if (p) {
          p.applyName(msg.name);
          p.state = { cam: !!msg.cam, mic: !!msg.mic, content: msg.content === 'movie' || msg.content === 'music' ? msg.content : 'none' };
          p.updateAvatar();
          p.updateBadge();
          this.dispatchEvent(new CustomEvent('participant-state', { detail: { participant: p } }));
        }
        break;
      case 'chat':
      case 'claim':
        this.dispatchEvent(new CustomEvent('data', { detail: { participant: p, msg } }));
        break;
      default:
        break;
    }
  }

  // ---- shared plumbing ------------------------------------------------------
  _getOrCreateParticipant(peerId) {
    let p = this.participants.get(peerId);
    if (p) return p;

    const tile = this.tileTemplate.content.firstElementChild.cloneNode(true);
    tile.dataset.peerId = peerId;
    this.stageEl.appendChild(tile);
    p = new Participant(peerId, tile);
    if (this._pendingNames && this._pendingNames.has(peerId)) {
      p.applyName(this._pendingNames.get(peerId));
      this._pendingNames.delete(peerId);
    }
    this.participants.set(peerId, p);
    this._layoutGrid();
    this.dispatchEvent(new CustomEvent('participant-added', { detail: { participant: p } }));
    return p;
  }

  _wireCall(p, call) {
    p.call = call;
    call.on('stream', (stream) => {
      p.stream = stream;
      p.video.srcObject = stream;
      p.updateAvatar();
      p.startMeter();
      // by now the connection is fully negotiated with real tracks, so this
      // is a safe, guaranteed-non-null moment to cache the senders — see
      // replaceSenderTrack() for why the cache exists at all
      const pc = call.peerConnection;
      if (pc) {
        if (!p.videoSender) p.videoSender = pc.getSenders().find((s) => s.track && s.track.kind === 'video') || null;
        if (!p.audioSender) p.audioSender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio') || null;
      }
      this.dispatchEvent(new CustomEvent('participant-connected', { detail: { participant: p } }));
    });
    call.on('close', () => this._removeParticipant(p.peerId));
    call.on('error', () => this.dispatchEvent(new CustomEvent('call-error', { detail: { participant: p } })));

    const pc = call.peerConnection;
    if (pc) {
      pc.addEventListener('iceconnectionstatechange', () => {
        const s = pc.iceConnectionState;
        const troubled = s === 'disconnected' || s === 'failed';
        if (p.troubled !== troubled) {
          p.troubled = troubled;
          this._emitQuality();
        }
        this._handleIceState(p, pc, s);
      });
    }
  }

  // ---- reconnect: a real recovery attempt, not just a "trouble" banner ----
  // `disconnected` often self-resolves in a second or two (brief NAT
  // rebinding, a wifi hiccup); restartIce() is only worth the renegotiation
  // cost once it's had a moment to recover on its own. `failed` never
  // self-resolves, so that gets a restart immediately.
  _handleIceState(p, pc, state) {
    if (state === 'connected' || state === 'completed') {
      if (p.reconnectTimer) { clearTimeout(p.reconnectTimer); p.reconnectTimer = null; }
      return;
    }
    if (state === 'failed') {
      if (p.reconnectTimer) { clearTimeout(p.reconnectTimer); p.reconnectTimer = null; }
      this._restartIce(pc);
      return;
    }
    if (state === 'disconnected' && !p.reconnectTimer) {
      p.reconnectTimer = setTimeout(() => {
        p.reconnectTimer = null;
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') this._restartIce(pc);
      }, 5000);
    }
  }

  _restartIce(pc) {
    try {
      if (typeof pc.restartIce === 'function') pc.restartIce();
    } catch (e) {
      // best-effort — if the browser can't restart ICE, the existing
      // troubled/quality-changed banner already keeps the user informed
    }
  }

  _emitQuality() {
    let anyTroubled = false;
    this.participants.forEach((p) => { if (p.troubled) anyTroubled = true; });
    this.dispatchEvent(new CustomEvent('quality-changed', { detail: { troubled: anyTroubled } }));
  }

  _removeParticipant(peerId) {
    const p = this.participants.get(peerId);
    if (!p) return;
    const name = p.name;
    this.participants.delete(peerId);
    this.admittedPeerIds.delete(peerId);
    p.destroy();
    this._layoutGrid();
    this._emitQuality();
    this.dispatchEvent(new CustomEvent('participant-removed', { detail: { peerId, name } }));
  }

  _layoutGrid() {
    const count = this.participants.size + 1; // + yourself
    this.stageEl.style.setProperty('--cols', String(columnsFor(count)));
    this.dispatchEvent(new CustomEvent('grid-changed', { detail: { count, large: count > LARGE_CALL_THRESHOLD } }));
  }

  // ---- lifecycle --------------------------------------------------------------
  getMyPeerId() { return this.peer ? this.peer.id : null; }
  getRoomCode() { return this.roomCode; }
  getParticipants() { return this.participants; }
  getParticipantCount() { return this.participants.size; }

  _teardownPeer() {
    try { if (this.knockConn) this.knockConn.close(); } catch (e) {}
    this.knockConn = null;
    this.participants.forEach((p) => p.destroy());
    this.participants.clear();
    this.pendingKnocks.clear();
    this.admittedPeerIds.clear();
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.peer = null;
  }

  leave() {
    this.ended = true;
    if (this.localMeter) { this.localMeter.stop(); this.localMeter = null; }
    this._teardownPeer();
    if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
  }
}
