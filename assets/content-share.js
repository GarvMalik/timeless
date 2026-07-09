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
const CONTENT_AUDIO_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

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

    room.addEventListener('data', (e) => this._handleRoomData(e.detail));
    room.addEventListener('participant-connected', (e) => this._applyCurrentContentTo(e.detail.participant));
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
        audio: CONTENT_AUDIO_CONSTRAINTS,
      });
    } catch (e) {
      return; // user dismissed the picker — not an error worth surfacing
    }

    this.captureStream = display;
    const videoTrack = display.getVideoTracks()[0];
    videoTrack.contentHint = 'motion'; // bias the encoder toward frame rate, not sharpness
    videoTrack.onended = () => this._onCaptureEnded();

    const audioTrack = display.getAudioTracks()[0];
    const outAudioTrack = audioTrack ? this._buildMixGraph(audioTrack) : this.room.localStream.getAudioTracks()[0];

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
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: CONTENT_AUDIO_CONSTRAINTS });
    } catch (e) {
      return;
    }

    const audioTrack = display.getAudioTracks()[0];
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

    const outAudioTrack = this._buildMixGraph(audioTrack);
    await this.room.replaceSenderTrack('audio', outAudioTrack);
    this._tuneAudioEncoding(outAudioTrack);

    // clean audio is the point of Music Mode — mute the mic by default. The
    // existing mic button becomes "talk over music" while this is active
    // (see call.js), rather than a second, easy-to-forget toggle.
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
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: true });
        const camTrack = cam.getVideoTracks()[0];
        camTrack.enabled = this.room.localState.cam;
        await this.room.replaceSenderTrack('video', camTrack);
        const old = this.room.localStream.getVideoTracks()[0];
        if (old) { this.room.localStream.removeTrack(old); old.stop(); }
        this.room.localStream.addTrack(camTrack);
        this.room.localVideoEl.srcObject = this.room.localStream;
      } catch (e) {
        this.room.setLocalCam(false); // no camera to restore to — avatar takes over
      }
    } else {
      const micTrack = this.room.localStream.getAudioTracks()[0];
      if (micTrack) await this.room.replaceSenderTrack('audio', micTrack);
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
  _buildMixGraph(contentAudioTrack) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new Ctx();
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

    return this.mixDest.stream.getAudioTracks()[0];
  }

  _teardownGraph() {
    if (this.captureStream) {
      this.captureStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      this.captureStream = null;
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
