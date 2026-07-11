/* =========================================================================
   Timeless — content-share.js
   One shared pipeline for Music Mode and Movie Mode. See ARCHITECTURE.md
   "Why one content pipeline" and "Why Web Audio mixing, not a second track"
   for the full reasoning; short version:

   - Both modes need to send "audio that isn't the mic, at full quality" to
     everyone. Rather than adding a second audio track per connection (SDP
     renegotiation across every mesh connection — fragile at N peers), a
     small Web Audio graph mixes content audio + optional mic audio, and the
     mixed track is pushed onto every existing sender via replaceTrack — the
     same technique already used for camera<->screen swaps.
   - Movie Mode = video + that same audio pipeline, tuned for playback.
   - Music Mode = audio-only: a browser TAB's audio (not "system audio" —
     see the browser-support note below), mixed and sent the same way.
   - Only one participant's content is "the shared thing" at a time — a
     lightweight claim/tie-break over the room's existing data channel.
   ========================================================================= */

export function isDisplayCaptureSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

// Content-audio profile: the opposite of the voice profile in call.js.
// Display audio already bypasses mic-only processing by default in most
// browsers, but disabling these explicitly documents the intent in code
// (not just a comment) and is belt-and-suspenders against any browser that
// applies its own defaults here — echo cancellation tuned for silence
// detection, or noise suppression, actively damages music/movie audio.
//
// IMPORTANT: this must never be passed directly as getDisplayMedia's `audio`
// option. Unlike getUserMedia, browser support for detailed audio
// constraints on getDisplayMedia is inconsistent — passing an object here
// (rather than a plain `true`) can make the whole call throw or silently
// fail instead of opening the share picker at all, in some browsers/
// versions. Request `audio: true` (maximally compatible) and apply this
// afterwards via track.applyConstraints — a non-destructive best-effort
// refinement that can't break the capture if it's not supported.
const CONTENT_AUDIO_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

function refineContentAudio(track) {
  if (track && typeof track.applyConstraints === 'function') {
    track.applyConstraints(CONTENT_AUDIO_CONSTRAINTS).catch(() => {}); // best-effort only
  }
}

// Opus's default bitrate is tuned for speech (~24-32 kbps) — nowhere near
// enough for music or a movie's soundtrack. This is the single highest-value,
// safely-implementable lever available without SDP-level surgery: true Opus
// *stereo* needs an SDP fmtp `stereo=1` parameter that isn't reachable via
// RTCRtpSender.setParameters and isn't safely reachable through PeerJS's
// internal offer/answer handling — see ARCHITECTURE.md's honest note on
// that limitation. Raising the bitpool this way is real, audible, and safe.
const CONTENT_AUDIO_MAX_BITRATE = 128_000;

export class ContentShare extends EventTarget {
  constructor(room) {
    super();
    this.room = room;
    this.kind = 'none'; // 'movie' | 'music'
    this.captureStream = null;
    this.audioCtx = null;
    this.mixDest = null;
    this.contentSourceNode = null;
    this.micSourceNode = null;
    this.activeClaim = null; // { kind, peerId, ts, name }
    // whatever's currently actually being sent, if anything — kept so a
    // participant who joins *mid-share* gets it too, not just whoever was
    // already connected when sharing started (see _applyCurrentContentTo)
    this.currentVideoTrack = null;
    this.currentAudioTrack = null;
    // the mic state Music Mode found and must hand back — see stop()
    this._micWasOnBeforeMusic = null;

    room.addEventListener('data', (e) => this._handleRoomData(e.detail));
    room.addEventListener('participant-connected', (e) => this._applyCurrentContentTo(e.detail.participant));
    // if the participant who holds the active claim disconnects without a
    // clean "claim: none" (tab crash, network death), the claim would stay
    // stuck forever — everyone's share buttons disabled, the music pill and
    // theater CTA pointing at a ghost. Clear it the moment they're gone.
    room.addEventListener('participant-removed', (e) => {
      if (this.activeClaim && this.activeClaim.peerId === e.detail.peerId) {
        this.activeClaim = null;
        this.dispatchEvent(new CustomEvent('remote-claim', { detail: { kind: 'none' } }));
      }
    });
  }

  // A newcomer's connection is negotiated with room.localStream's tracks —
  // fine normally, but if Movie/Music Mode is already active when they join,
  // that's the sharer's stale camera/mic, not the shared content. Re-apply
  // whatever's actually active to their senders right after they connect
  // (the senders are already cached by room.js by this point).
  _applyCurrentContentTo(p) {
    if (this.kind === 'none') return;
    if (this.currentVideoTrack && p.videoSender) {
      p.videoSender.replaceTrack(this.currentVideoTrack).catch(() => {});
      this._tuneVideoEncoding(this.currentVideoTrack);
    }
    if (this.currentAudioTrack && p.audioSender) {
      p.audioSender.replaceTrack(this.currentAudioTrack).catch(() => {});
      this._tuneAudioEncoding(this.currentAudioTrack);
    }
  }

  getActiveClaim() {
    return this.activeClaim;
  }

  // ---- Movie Mode -----------------------------------------------------------
  async startMovie() {
    if (this.kind !== 'none') return;
    if (this._blockedByOther()) return;

    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: true,
        // Chrome-only dictionary members, safely ignored elsewhere:
        // excluding the current tab prevents the accidental hall-of-mirrors
        // self-capture (infinite video recursion + audio feedback that can
        // take the whole tab down); systemAudio surfaces the system-audio
        // checkbox on entire-screen shares where supported
        selfBrowserSurface: 'exclude',
        systemAudio: 'include',
      });
    } catch (e) {
      // NotAllowedError = the user dismissed the picker — silence is right.
      // Anything else (e.g. InvalidStateError when ?mode=movie auto-starts
      // without a fresh user gesture) deserves a visible explanation.
      if (e && e.name !== 'NotAllowedError') {
        this.dispatchEvent(new CustomEvent('share-failed', { detail: { kind: 'movie' } }));
      }
      return;
    }

    this.captureStream = display;
    const videoTrack = display.getVideoTracks()[0];
    videoTrack.contentHint = 'motion'; // bias the encoder toward frame rate, not sharpness
    videoTrack.onended = () => this._onCaptureEnded();

    const audioTrack = display.getAudioTracks()[0];
    refineContentAudio(audioTrack);
    const outAudioTrack = audioTrack ? await this._ensureContentAudioTrack(audioTrack) : this.room.localStream.getAudioTracks()[0];

    await this.room.replaceSenderTrack('video', videoTrack);
    if (outAudioTrack) {
      await this.room.replaceSenderTrack('audio', outAudioTrack);
      if (audioTrack) this._tuneAudioEncoding(outAudioTrack); // only the mixed/content track, never the plain mic fallback
    }
    this._tuneVideoEncoding(videoTrack);

    // the sharer's own tile previews what's being sent, same as a normal screen share
    this.room.localVideoEl.srcObject = new MediaStream([videoTrack]);

    this.currentVideoTrack = videoTrack;
    this.currentAudioTrack = outAudioTrack || null;
    this.kind = 'movie';
    this.room.setLocalContent('movie');
    this._broadcastClaim('movie');
    this.dispatchEvent(new CustomEvent('started', { detail: { kind: 'movie' } }));
  }

  // ---- Music Mode -------------------------------------------------------------
  // Captures a browser TAB's audio via getDisplayMedia, not "system audio":
  // true OS-wide capture is inconsistent (partial on Windows Chrome, absent
  // on macOS and in Safari/Firefox). Tab audio — e.g. a YouTube or Spotify
  // Web Player tab — is the reliable, cross-platform technique, and it
  // bypasses mic-only processing (echo cancellation/noise suppression/AGC
  // are getUserMedia constraints; display audio is raw).
  async startMusic() {
    if (this.kind !== 'none') return;
    if (this._blockedByOther()) return;
    if (!isDisplayCaptureSupported()) {
      this.dispatchEvent(new CustomEvent('unsupported', { detail: { kind: 'music' } }));
      return;
    }

    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        selfBrowserSurface: 'exclude', // see startMovie — prevents self-capture feedback
        systemAudio: 'include',
      });
    } catch (e) {
      if (e && e.name !== 'NotAllowedError') {
        this.dispatchEvent(new CustomEvent('share-failed', { detail: { kind: 'music' } }));
      }
      return;
    }

    const audioTrack = display.getAudioTracks()[0];
    refineContentAudio(audioTrack);
    // a video track is required to open the picker, but Music Mode never
    // sends it — stop it immediately
    display.getVideoTracks().forEach((t) => t.stop());

    if (!audioTrack) {
      display.getTracks().forEach((t) => t.stop());
      this.dispatchEvent(new CustomEvent('no-audio', { detail: { kind: 'music' } }));
      return;
    }

    this.captureStream = new MediaStream([audioTrack]);
    audioTrack.onended = () => this._onCaptureEnded();

    const outAudioTrack = await this._ensureContentAudioTrack(audioTrack);
    await this.room.replaceSenderTrack('audio', outAudioTrack);
    this._tuneAudioEncoding(outAudioTrack);

    // clean audio is the point of Music Mode — mute the mic by default. The
    // existing mic button becomes "talk over music" while this is active
    // (see call.js), rather than a second, easy-to-forget toggle. Remember
    // what we found so stop() can hand the mic back exactly as it was.
    this._micWasOnBeforeMusic = this.room.localState.mic;
    this.room.setLocalMic(false);

    this.currentAudioTrack = outAudioTrack;
    this.kind = 'music';
    this.room.setLocalContent('music');
    this._broadcastClaim('music');
    this.dispatchEvent(new CustomEvent('started', { detail: { kind: 'music' } }));
  }

  // ---- stop / revert ----------------------------------------------------------
  async stop() {
    if (this.kind === 'none') return;
    const wasMovie = this.kind === 'movie';
    this._teardownGraph();

    if (wasMovie) {
      if (this.room.localState.cam) {
        try {
          const cam = await navigator.mediaDevices.getUserMedia({ video: true });
          const camTrack = cam.getVideoTracks()[0];
          await this.room.replaceSenderTrack('video', camTrack);
          const old = this.room.localStream.getVideoTracks()[0];
          if (old) { this.room.localStream.removeTrack(old); old.stop(); }
          this.room.localStream.addTrack(camTrack);
          this.room.localVideoEl.srcObject = this.room.localStream;
        } catch (e) {
          this.room.setLocalCam(false); // no camera to restore to — avatar takes over
        }
      } else {
        // the camera is meant to be OFF: never touch the hardware (that
        // lights the LED while the UI says off) — restore room.js's
        // placeholder invariant instead, keeping a video sender alive
        const old = this.room.localStream.getVideoTracks()[0];
        if (old) { this.room.localStream.removeTrack(old); old.stop(); }
        const ph = this.room._makePlaceholderVideoTrack();
        this.room._placeholderVideo = ph;
        this.room.localStream.addTrack(ph);
        await this.room.replaceSenderTrack('video', ph);
        this.room.localVideoEl.srcObject = this.room.localStream;
      }
    } else {
      const micTrack = this.room.localStream.getAudioTracks()[0];
      if (micTrack) await this.room.replaceSenderTrack('audio', micTrack);
      // Restore the mic to how Music Mode found it — but never override a
      // choice the user made mid-share: if they opted into "talk over
      // music" (mic currently on), that stands. Only the automatic mute is
      // undone: mic still off now + was on before => turn it back on.
      if (!this.room.localState.mic && this._micWasOnBeforeMusic) {
        this.room.setLocalMic(true);
      }
      this._micWasOnBeforeMusic = null;
    }

    this.currentVideoTrack = null;
    this.currentAudioTrack = null;
    this.kind = 'none';
    this.room.setLocalContent('none');
    this._broadcastClaim('none');
    this.dispatchEvent(new CustomEvent('stopped'));
  }

  _onCaptureEnded() {
    // fires when the browser's own "Stop sharing" control is used, or the
    // shared tab/window/screen is closed — same idea as the old screen-share
    // onended hook, generalized
    this.stop();
    this.dispatchEvent(new CustomEvent('content-ended'));
  }

  // ---- Web Audio mixing graph -------------------------------------------------
  // CRITICAL ORDERING BUG THIS GUARDS AGAINST: this runs after the
  // getDisplayMedia picker resolves, and the seconds the user spends
  // choosing a tab consume the button click's transient user activation —
  // so the AudioContext can be constructed in the 'suspended' state, whose
  // destination node outputs pure silence. Both modes route ALL outgoing
  // audio (content + mic mix) through this graph, so a suspended context
  // silenced everything, including the presenter's voice in Movie Mode.
  //
  // Defense in depth: (1) explicitly resume() — Chrome permits it once a
  // capture grant exists; (2) resume()'s promise can hang forever when
  // blocked (it never rejects), so race it against a short timeout; (3) if
  // the context still isn't running, fall back to sending the RAW content
  // track — audio delivery is guaranteed, only live mic-mixing degrades
  // (surfaced via the 'mix-unavailable' event).
  async _ensureContentAudioTrack(contentAudioTrack) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new Ctx();

    if (this.audioCtx.state !== 'running') {
      await Promise.race([
        this.audioCtx.resume().catch(() => {}),
        new Promise((r) => setTimeout(r, 400)),
      ]);
    }

    if (this.audioCtx.state !== 'running') {
      try { this.audioCtx.close(); } catch (e) {}
      this.audioCtx = null;
      this.dispatchEvent(new CustomEvent('mix-unavailable'));
      return contentAudioTrack;
    }

    this.mixDest = this.audioCtx.createMediaStreamDestination();
    this.contentSourceNode = this.audioCtx.createMediaStreamSource(new MediaStream([contentAudioTrack]));
    this.contentSourceNode.connect(this.mixDest);

    // The mic track's own .enabled flag already silences it when muted (the
    // spec has a disabled track output silence, not stop the graph), so
    // muting continues to work exactly as it did before content sharing —
    // no separate "include mic" flag needed.
    const micTrack = this.room.localStream.getAudioTracks()[0];
    if (micTrack) {
      this.micSourceNode = this.audioCtx.createMediaStreamSource(new MediaStream([micTrack]));
      this.micSourceNode.connect(this.mixDest);
    }

    // if the context gets suspended mid-share (OS interruption, tab policy),
    // any interaction revives it
    const revive = () => { if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {}); };
    this._reviveHandler = revive;
    document.addEventListener('pointerdown', revive, true);

    return this.mixDest.stream.getAudioTracks()[0];
  }

  _teardownGraph() {
    if (this.captureStream) {
      this.captureStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      this.captureStream = null;
    }
    if (this._reviveHandler) {
      document.removeEventListener('pointerdown', this._reviveHandler, true);
      this._reviveHandler = null;
    }
    if (this.contentSourceNode) { try { this.contentSourceNode.disconnect(); } catch (e) {} this.contentSourceNode = null; }
    if (this.micSourceNode) { try { this.micSourceNode.disconnect(); } catch (e) {} this.micSourceNode = null; }
    if (this.audioCtx) { try { this.audioCtx.close(); } catch (e) {} this.audioCtx = null; }
    this.mixDest = null;
  }

  // ---- encoding tuning: prioritize frame rate over resolution for movie
  // playback, and raise the bitrate ceiling above the conservative default
  // WebRTC picks for screen-share-shaped content --------------------------
  _tuneVideoEncoding(videoTrack) {
    this.room.getParticipants().forEach((p) => {
      if (!p.call || !p.call.peerConnection) return;
      const sender = p.call.peerConnection.getSenders().find((s) => s.track === videoTrack);
      if (!sender) return;
      const params = sender.getParameters();
      params.degradationPreference = 'maintain-framerate';
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 3_000_000; // ~3 Mbps: headroom for 1080p30 playback
      sender.setParameters(params).catch(() => {}); // best-effort — never block sharing on this
    });
  }

  // Opus's speech-tuned default (~24-32 kbps) is nowhere near enough for
  // music or a movie soundtrack — this is the real, safely-implementable
  // audio-quality lever for both modes (see CONTENT_AUDIO_MAX_BITRATE above
  // for why stereo itself isn't attempted here).
  _tuneAudioEncoding(audioTrack) {
    this.room.getParticipants().forEach((p) => {
      if (!p.call || !p.call.peerConnection) return;
      const sender = p.call.peerConnection.getSenders().find((s) => s.track === audioTrack);
      if (!sender) return;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = CONTENT_AUDIO_MAX_BITRATE;
      sender.setParameters(params).catch(() => {});
    });
  }

  // ---- mutual exclusion: one shared thing at a time --------------------------
  _blockedByOther() {
    if (this.activeClaim && this.activeClaim.peerId !== this.room.getMyPeerId()) {
      this.dispatchEvent(new CustomEvent('blocked', { detail: { by: this.activeClaim.name || 'Someone' } }));
      return true;
    }
    return false;
  }

  _broadcastClaim(kind) {
    const ts = Date.now();
    this.activeClaim = kind === 'none' ? null : { kind, peerId: this.room.getMyPeerId(), ts };
    this.room.broadcast({ t: 'claim', kind, peerId: this.room.getMyPeerId(), ts });
  }

  _handleRoomData({ participant, msg }) {
    if (!msg || msg.t !== 'claim') return;
    if (msg.kind === 'none') {
      if (this.activeClaim && this.activeClaim.peerId === msg.peerId) this.activeClaim = null;
      this.dispatchEvent(new CustomEvent('remote-claim', { detail: { kind: 'none' } }));
      return;
    }
    const name = participant ? participant.name : 'Someone';
    // race: if we believe we're the active sharer but a competing claim shows
    // up, the earlier timestamp (peerId as tiebreak) wins and we back off
    if (this.kind !== 'none' && this.activeClaim && this.activeClaim.peerId === this.room.getMyPeerId()) {
      const iWon = this.activeClaim.ts < msg.ts || (this.activeClaim.ts === msg.ts && this.activeClaim.peerId < msg.peerId);
      if (!iWon) {
        this.stop();
        this.dispatchEvent(new CustomEvent('preempted', { detail: { by: name } }));
      }
    }
    this.activeClaim = { kind: msg.kind, peerId: msg.peerId, ts: msg.ts, name };
    this.dispatchEvent(new CustomEvent('remote-claim', { detail: { kind: msg.kind, name } }));
  }
}
