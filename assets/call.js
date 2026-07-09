/* =========================================================================
   Timeless — call room
   Peer-to-peer video + screen sharing over WebRTC, brokered by the free
   public PeerJS cloud. No server of our own: this runs as a static page.

   Two roles share one MediaConnection:
     · host  — opens the room, owns the room code (its Peer id)
     · guest — opens an invite link (?room=CODE) and calls the host

   The call is bidirectional, so a single connection carries both streams.
   ========================================================================= */
(function () {
  'use strict';

  // ---- element refs ------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };

  var lobby = $('lobby');
  var stage = $('stage');
  var dock = $('dock');

  var statusEl = $('status');
  var statusText = $('statusText');

  var lobbyEyebrow = $('lobbyEyebrow');
  var lobbyTitle = $('lobbyTitle');
  var lobbySub = $('lobbySub');
  var hostActions = $('hostActions');
  var guestActions = $('guestActions');
  var lobbyNotice = $('lobbyNotice');

  var openBtn = $('openBtn');
  var enterBtn = $('enterBtn');
  var joinForm = $('joinForm');
  var codeInput = $('codeInput');

  var invite = $('invite');
  var inviteLink = $('inviteLink');
  var inviteCopy = $('inviteCopy');
  var inviteChip = $('inviteChip');
  var inviteChipLink = $('inviteChipLink');
  var inviteChipCopy = $('inviteChipCopy');

  var netBanner = $('netBanner');
  var netBannerText = $('netBannerText');
  var netBannerClose = $('netBannerClose');

  var localVideo = $('localVideo');
  var remoteVideo = $('remoteVideo');
  var remoteWait = $('remoteWait');
  var remoteWaitText = $('remoteWaitText');
  var remoteTile = $('remoteTile');
  var localTile = $('localTile');
  var remoteAvatar = $('remoteAvatar');
  var localAvatar = $('localAvatar');
  var remoteMuteBadge = $('remoteMuteBadge');

  var micBtn = $('micBtn');
  var camBtn = $('camBtn');
  var screenBtn = $('screenBtn');
  var copyBtn = $('copyBtn');
  var endBtn = $('endBtn');
  var toast = $('toast');
  var micMeter = $('micMeter');
  var micMeterBars = micMeter ? micMeter.querySelectorAll('span') : [];

  // ---- state -------------------------------------------------------------
  var peer = null;
  var currentCall = null;
  var dataConn = null;
  var localStream = null;
  var screenStream = null;

  var roomCode = null;
  var isHost = false;
  var micOn = true;
  var camOn = true;
  var sharingScreen = false;
  var startMode = 'camera';
  var ended = false;
  var remoteConnected = false;

  // what we believe about the other participant, kept in sync over a small
  // PeerJS data channel (see "presence" section below)
  var remoteState = { cam: true, mic: true, screen: false };

  // random-but-consistent "camera off" avatar: one colour per session, one
  // face glyph always — see the "avatars" section below
  var localAvatarColor = null;
  var remoteAvatarColor = null;

  // mic-level meter + speaking indicator (Web Audio, local analysis only —
  // nothing is sent anywhere for this)
  var localMeter = null;
  var remoteMeter = null;

  // network banner state
  var netShownFor = null; // 'offline' | 'ice' | null
  var netDismissedFor = null;

  // ---- url params --------------------------------------------------------
  var params = new URLSearchParams(window.location.search);
  var joinCode = (params.get('room') || '').trim();
  startMode = params.get('mode') === 'screen' ? 'screen' : 'camera';

  // =========================================================================
  // helpers
  // =========================================================================
  // Room codes double as PeerJS ids. Anyone who knows the code can reach the
  // host, so make them long enough to be unguessable (10 chars from a 31-char
  // alphabet ≈ 8.2e14 combos) and draw from a CSPRNG, never Math.random().
  var CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
  var CODE_LEN = 10;

  // Explicit, secure signalling config — pinned so it always uses wss:// and
  // matches the Content-Security-Policy connect-src. The broker only relays
  // connection setup; audio/video never touch it (that's peer-to-peer).
  var PEER_OPTS = {
    host: '0.peerjs.com',
    port: 443,
    secure: true,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
  };

  function makeCode() {
    var out = '';
    var n = CODE_ALPHABET.length;
    if (window.crypto && window.crypto.getRandomValues) {
      var buf = new Uint32Array(CODE_LEN);
      window.crypto.getRandomValues(buf);
      for (var i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[buf[i] % n];
    } else {
      for (var j = 0; j < CODE_LEN; j++) out += CODE_ALPHABET[Math.floor(Math.random() * n)];
    }
    return out;
  }

  // Strict allow-list: only ever accept short lowercase-alphanumeric codes.
  // This is the trust boundary for anything derived from the URL or a text
  // field before it is handed to PeerJS or written into a link.
  function isValidCode(c) {
    return typeof c === 'string' && /^[a-z0-9]{4,40}$/.test(c);
  }

  // Same pastel family as the design system (--mint/--sky/--peach/--lilac)
  // plus a couple of siblings, so a random pick never clashes with the brand.
  var AVATAR_COLORS = ['#c4f0d0', '#cbe2f9', '#f4e2d6', '#eddfeb', '#f9e9b8', '#d9e8d3'];

  function randomItem(list) {
    if (window.crypto && window.crypto.getRandomValues) {
      var buf = new Uint32Array(1);
      window.crypto.getRandomValues(buf);
      return list[buf[0] % list.length];
    }
    return list[Math.floor(Math.random() * list.length)];
  }

  function inviteUrl(code) {
    return (
      window.location.origin +
      window.location.pathname +
      '?room=' + encodeURIComponent(code)
    );
  }

  function setStatus(state, text) {
    statusEl.setAttribute('data-state', state);
    statusText.textContent = text;
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      toast.classList.remove('show');
    }, 2400);
  }

  function notice(msg) {
    if (!msg) {
      lobbyNotice.hidden = true;
      return;
    }
    lobbyNotice.hidden = false;
    lobbyNotice.textContent = msg;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // fallback
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  // =========================================================================
  // media
  // =========================================================================
  function getCameraStream() {
    return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }

  async function getScreenStream() {
    var display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    // keep the mic so we can still be heard while presenting
    var tracks = display.getVideoTracks();
    try {
      var mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.getAudioTracks().forEach(function (t) { tracks.push(t); });
    } catch (e) {
      /* presenting without a mic is still valid */
    }
    return new MediaStream(tracks);
  }

  async function acquireLocal() {
    if (startMode === 'screen') {
      localStream = await getScreenStream();
      sharingScreen = true;
      // stopping the share from the browser UI ends the presentation
      var vt = localStream.getVideoTracks()[0];
      if (vt) vt.onended = function () { stopScreen(); };
    } else {
      localStream = await getCameraStream();
    }
    localVideo.srcObject = localStream;
    micOn = true;
    camOn = true;
    updateLocalAvatarVisibility();
    startLocalMeter();
    updateControls();
  }

  function mediaError(e) {
    var name = (e && e.name) || 'Error';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Camera or microphone access was blocked. Allow it in your browser and try again.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No camera or microphone was found on this device.';
    }
    if (name === 'NotReadableError') {
      return 'Your camera is already in use by another app. Close it and try again.';
    }
    return 'Could not start your camera (' + name + ').';
  }

  // swap the outgoing video track (both locally and on the wire)
  async function swapVideo(newTrack) {
    var old = localStream.getVideoTracks()[0];
    if (old) {
      localStream.removeTrack(old);
      old.stop();
    }
    localStream.addTrack(newTrack);
    localVideo.srcObject = localStream;

    if (currentCall && currentCall.peerConnection) {
      var sender = currentCall.peerConnection.getSenders().find(function (s) {
        return s.track && s.track.kind === 'video';
      });
      if (sender) await sender.replaceTrack(newTrack);
    }
  }

  async function startScreen() {
    var stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (e) {
      return; // user dismissed the picker
    }
    screenStream = stream;
    var track = stream.getVideoTracks()[0];
    await swapVideo(track);
    sharingScreen = true;
    camOn = true;
    updateControls();
    track.onended = function () { stopScreen(); };
  }

  async function stopScreen() {
    if (!sharingScreen) return;
    if (screenStream) {
      screenStream.getTracks().forEach(function (t) { t.stop(); });
      screenStream = null;
    }
    var track = null;
    try {
      var cam = await navigator.mediaDevices.getUserMedia({ video: true });
      track = cam.getVideoTracks()[0];
    } catch (e) {
      track = null;
    }
    if (track) {
      track.enabled = camOn;
      await swapVideo(track);
    }
    sharingScreen = false;
    updateControls();
  }

  // =========================================================================
  // avatars — shown on a tile in place of a frozen/black frame when that
  // participant's camera is off. Colour is random per session; the face
  // glyph itself never changes, so it always reads as "this is a person".
  // =========================================================================
  function updateLocalAvatarVisibility() {
    if (!localAvatarColor) {
      localAvatarColor = randomItem(AVATAR_COLORS);
      localAvatar.style.background = localAvatarColor;
    }
    localAvatar.hidden = camOn || sharingScreen;
  }

  function updateRemoteAvatarVisibility() {
    if (!remoteConnected) {
      remoteAvatar.hidden = true;
      return;
    }
    if (!remoteAvatarColor) {
      remoteAvatarColor = randomItem(AVATAR_COLORS);
      remoteAvatar.style.background = remoteAvatarColor;
    }
    remoteAvatar.hidden = remoteState.cam || remoteState.screen;
  }

  // =========================================================================
  // presence — a lightweight PeerJS data channel that tells the other side
  // whether our camera/mic/screen-share is on. This is what lets their tile
  // show an avatar instead of a black frame, and lets them see if we're
  // muted — none of it can be inferred from the media track alone.
  // =========================================================================
  function sendState() {
    if (dataConn && dataConn.open) {
      dataConn.send({ t: 'state', cam: camOn && !sharingScreen, mic: micOn, screen: sharingScreen });
    }
  }

  function wireData(conn) {
    dataConn = conn;
    conn.on('open', sendState);
    conn.on('data', function (msg) {
      if (!msg || msg.t !== 'state') return;
      remoteState = { cam: !!msg.cam, mic: !!msg.mic, screen: !!msg.screen };
      updateRemoteAvatarVisibility();
      remoteMuteBadge.classList.toggle('show', !remoteState.mic);
    });
    conn.on('close', function () { dataConn = null; });
    conn.on('error', function (e) { console.warn('data channel error', e); });
  }

  // =========================================================================
  // audio meters — local Web Audio analysis only; nothing here is sent
  // anywhere. The mic meter is a direct readout of what your microphone is
  // capturing, so you can see for yourself that your voice is registering.
  // The "speaking" ring on a tile is the same idea applied to whichever
  // stream (yours or theirs) currently has sound in it.
  // =========================================================================
  function createMeter(stream, onLevel) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    var track = stream.getAudioTracks()[0];
    if (!track) return null;

    var ctx = new Ctx();
    var source = ctx.createMediaStreamSource(new MediaStream([track]));
    var analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    var data = new Uint8Array(analyser.frequencyBinCount);
    var raf = null;
    var stopped = false;

    function tick() {
      if (stopped) return;
      analyser.getByteTimeDomainData(data);
      var sum = 0;
      for (var i = 0; i < data.length; i++) {
        var v = (data[i] - 128) / 128;
        sum += v * v;
      }
      var rms = Math.sqrt(sum / data.length); // 0..~1
      onLevel(Math.min(1, rms * 4)); // scale up — raw mic RMS reads very quiet
      raf = requestAnimationFrame(tick);
    }
    tick();

    return {
      stop: function () {
        stopped = true;
        if (raf) cancelAnimationFrame(raf);
        try { source.disconnect(); } catch (e) {}
        try { ctx.close(); } catch (e) {}
      },
    };
  }

  var SPEAK_THRESHOLD = 0.06;

  function startLocalMeter() {
    if (localMeter) localMeter.stop();
    localMeter = createMeter(localStream, function (level) {
      var speaking = micOn && level > SPEAK_THRESHOLD;
      localTile.classList.toggle('tile--speaking', speaking);
      if (!micOn) return; // bars already forced flat via [data-muted]
      micMeter.setAttribute('data-active', level > 0.03 ? 'true' : 'false');
      for (var i = 0; i < micMeterBars.length; i++) {
        var bar = (i + 1) / micMeterBars.length; // 0.25, 0.5, 0.75, 1
        var pct = level >= bar ? Math.min(100, 25 + level * 75) : 15;
        micMeterBars[i].style.height = pct + '%';
      }
    });
  }

  function startRemoteMeter(stream) {
    if (remoteMeter) remoteMeter.stop();
    remoteMeter = createMeter(stream, function (level) {
      remoteTile.classList.toggle('tile--speaking', level > SPEAK_THRESHOLD);
    });
  }

  function stopMeters() {
    if (localMeter) { localMeter.stop(); localMeter = null; }
    if (remoteMeter) { remoteMeter.stop(); remoteMeter = null; }
  }

  // =========================================================================
  // network — a slim, non-blocking banner. It never demands action; it just
  // keeps the user in the loop and clears itself the moment things recover.
  // =========================================================================
  function showNetBanner(kind, text) {
    netShownFor = kind;
    if (netDismissedFor === kind) return; // user already saw and closed this one
    netBanner.hidden = false;
    netBanner.setAttribute('data-kind', kind === 'offline' ? 'offline' : 'ice');
    netBannerText.textContent = text;
  }

  function hideNetBanner() {
    if (netShownFor === null) return;
    netShownFor = null;
    netDismissedFor = null;
    netBanner.hidden = true;
  }

  // brief, self-clearing confirmation once a real problem resolves — quieter
  // than the trouble banner, and never shown if nothing was ever wrong
  function flashRecovered() {
    if (netShownFor === null) return; // nothing was showing — say nothing
    var wasDismissed = netDismissedFor !== null;
    netShownFor = null;
    netDismissedFor = null;
    if (wasDismissed) { netBanner.hidden = true; return; }
    netBanner.setAttribute('data-kind', 'ok');
    netBannerText.textContent = "Back online.";
    clearTimeout(flashRecovered._t);
    flashRecovered._t = setTimeout(function () { netBanner.hidden = true; }, 2200);
  }

  function watchNetwork() {
    window.addEventListener('offline', function () {
      showNetBanner('offline', "You're offline — check your internet connection. We'll keep waiting for you.");
    });
    window.addEventListener('online', function () {
      if (netShownFor === 'offline') flashRecovered();
    });
  }

  function watchIce(pc) {
    if (!pc) return;
    pc.addEventListener('iceconnectionstatechange', function () {
      var s = pc.iceConnectionState;
      if (s === 'disconnected' || s === 'failed') {
        showNetBanner('ice', "Connection trouble — check your internet. We'll keep trying to reconnect…");
      } else if (s === 'connected' || s === 'completed') {
        if (netShownFor === 'ice') flashRecovered();
      }
    });
  }

  // =========================================================================
  // controls
  // =========================================================================
  function setPressed(btn, on) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }

  function swapIcon(btn, off) {
    var on = btn.querySelector('.i-on');
    var offIcon = btn.querySelector('.i-off');
    if (on && offIcon) {
      on.hidden = off;
      offIcon.hidden = !off;
    }
  }

  function updateControls() {
    setPressed(micBtn, !micOn);
    swapIcon(micBtn, !micOn);
    micBtn.setAttribute('aria-label', micOn ? 'Mute microphone' : 'Unmute microphone');

    setPressed(camBtn, !camOn);
    swapIcon(camBtn, !camOn);
    camBtn.setAttribute('aria-label', camOn ? 'Turn camera off' : 'Turn camera on');

    setPressed(screenBtn, sharingScreen);
    screenBtn.setAttribute('aria-label', sharingScreen ? 'Stop sharing your screen' : 'Share your screen');
    // camera toggle is meaningless while presenting a screen
    camBtn.disabled = sharingScreen;
    camBtn.style.opacity = sharingScreen ? '0.4' : '';

    micMeter.setAttribute('data-muted', micOn ? 'false' : 'true');
    updateLocalAvatarVisibility();
    sendState();
  }

  function toggleMic() {
    micOn = !micOn;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = micOn; });
    updateControls();
  }

  function toggleCam() {
    if (sharingScreen) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach(function (t) { t.enabled = camOn; });
    updateControls();
  }

  function toggleScreen() {
    if (sharingScreen) stopScreen();
    else startScreen();
  }

  // =========================================================================
  // room lifecycle
  // =========================================================================
  function enterRoomView() {
    lobby.hidden = true;
    stage.hidden = false;
    dock.hidden = false;
  }

  function attachRemote(stream) {
    remoteVideo.srcObject = stream;
    remoteWait.hidden = true;
    remoteConnected = true;
    setStatus('live', 'Live · connected');
    updateRemoteAvatarVisibility();
    startRemoteMeter(stream);
  }

  function wireCall(call) {
    currentCall = call;
    call.on('stream', function (stream) { attachRemote(stream); });
    call.on('close', function () { onPeerLeft(); });
    call.on('error', function (err) {
      console.warn('call error', err);
      showToast('The connection dropped.');
    });
    // PeerJS exposes the underlying RTCPeerConnection synchronously
    watchIce(call.peerConnection);
  }

  function onPeerLeft() {
    if (ended) return;
    remoteVideo.srcObject = null;
    remoteWait.hidden = false;
    remoteConnected = false;
    remoteAvatar.hidden = true;
    remoteMuteBadge.classList.remove('show');
    remoteTile.classList.remove('tile--speaking');
    if (remoteMeter) { remoteMeter.stop(); remoteMeter = null; }
    remoteWaitText.textContent = isHost
      ? 'They left. Your room is still open — share the link again to invite someone.'
      : 'The host closed the room.';
    setStatus('waiting', isHost ? 'Waiting · room open' : 'Disconnected');
  }

  // ---- host --------------------------------------------------------------
  function openAsHost() {
    isHost = true;
    roomCode = makeCode();
    peer = new Peer(roomCode, PEER_OPTS);

    peer.on('open', function (id) {
      roomCode = id;
      var url = inviteUrl(id);
      inviteLink.textContent = url;
      invite.classList.add('show');
      inviteChipLink.textContent = url;
      inviteChip.classList.add('show');
      setStatus('waiting', 'Waiting · room open');
      remoteWaitText.textContent = 'Waiting for someone to open your link…';
      enterRoomView();
    });

    peer.on('call', function (call) {
      call.answer(localStream);
      wireCall(call);
    });

    // the guest opens this once they've called us — see joinAsGuest
    peer.on('connection', function (conn) { wireData(conn); });

    peer.on('error', function (err) {
      if (err && err.type === 'unavailable-id') {
        // extremely unlikely collision — retry with a fresh code
        peer.destroy();
        openAsHost();
        return;
      }
      console.error(err);
      showToast('Signaling error: ' + (err && err.type ? err.type : 'unknown'));
    });
  }

  // ---- guest -------------------------------------------------------------
  function joinAsGuest(code) {
    isHost = false;
    roomCode = code;
    peer = new Peer(undefined, PEER_OPTS);

    setStatus('waiting', 'Connecting…');
    remoteWaitText.textContent = 'Connecting to the room…';
    enterRoomView();
    invite.classList.remove('show'); // guests don't own the invite

    peer.on('open', function () {
      var call = peer.call(code, localStream);
      if (!call) {
        setStatus('ended', 'Failed');
        remoteWaitText.textContent = 'Could not reach that room.';
        return;
      }
      wireCall(call);
      wireData(peer.connect(code, { reliable: true }));
    });

    peer.on('error', function (err) {
      var type = err && err.type;
      if (type === 'peer-unavailable') {
        setStatus('ended', 'Room not found');
        remoteWaitText.textContent =
          'No one is hosting that room. Ask them to open it first, then reload.';
        showToast('Room not found.');
      } else {
        console.error(err);
        showToast('Signaling error: ' + (type || 'unknown'));
      }
    });
  }

  function leave() {
    ended = true;
    setStatus('ended', 'Call ended');
    stopMeters();
    netBanner.hidden = true;
    try { if (dataConn) dataConn.close(); } catch (e) {}
    try { if (currentCall) currentCall.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
    if (screenStream) screenStream.getTracks().forEach(function (t) { t.stop(); });
    // brief beat, then home
    document.body.style.transition = 'opacity 0.5s ease';
    document.body.style.opacity = '0.3';
    setTimeout(function () { window.location.href = 'index.html'; }, 550);
  }

  // =========================================================================
  // lobby wiring
  // =========================================================================
  function configureGuestLobby(code) {
    lobbyEyebrow.textContent = 'The room · invited';
    // built from nodes (no innerHTML) to keep the XSS surface at zero
    lobbyTitle.textContent = "You're ";
    var em = document.createElement('em');
    em.textContent = 'invited.';
    lobbyTitle.appendChild(em);
    lobbySub.textContent =
      'Someone opened a Timeless room and shared it with you. Enter to join — ' +
      "we'll ask for your camera and microphone first.";
    hostActions.hidden = true;
    guestActions.hidden = false;
  }

  async function handleOpen() {
    openBtn.disabled = true;
    notice(null);
    try {
      await acquireLocal();
    } catch (e) {
      openBtn.disabled = false;
      notice(mediaError(e));
      return;
    }
    openAsHost();
  }

  async function handleJoinFromForm(e) {
    e.preventDefault();
    var code = (codeInput.value || '').trim().toLowerCase();
    if (!code) {
      notice('Enter a room code to join.');
      return;
    }
    if (!isValidCode(code)) {
      notice('That room code doesn’t look right — codes are letters and numbers only.');
      return;
    }
    notice(null);
    try {
      await acquireLocal();
    } catch (err) {
      notice(mediaError(err));
      return;
    }
    joinAsGuest(code);
  }

  async function handleEnter() {
    enterBtn.disabled = true;
    notice(null);
    try {
      await acquireLocal();
    } catch (e) {
      enterBtn.disabled = false;
      notice(mediaError(e));
      return;
    }
    joinAsGuest(joinCode);
  }

  // =========================================================================
  // bind events
  // =========================================================================
  openBtn.addEventListener('click', handleOpen);
  joinForm.addEventListener('submit', handleJoinFromForm);
  enterBtn.addEventListener('click', handleEnter);

  micBtn.addEventListener('click', toggleMic);
  camBtn.addEventListener('click', toggleCam);
  screenBtn.addEventListener('click', toggleScreen);
  endBtn.addEventListener('click', leave);

  function doCopy() {
    copyText(inviteUrl(roomCode)).then(function () {
      showToast('Invite link copied');
    });
  }
  copyBtn.addEventListener('click', function () {
    if (!roomCode) return;
    doCopy();
  });
  inviteCopy.addEventListener('click', doCopy);
  inviteChipCopy.addEventListener('click', doCopy);

  netBannerClose.addEventListener('click', function () {
    netDismissedFor = netShownFor;
    netBanner.hidden = true;
  });

  window.addEventListener('beforeunload', function () {
    try { if (peer) peer.destroy(); } catch (e) {}
  });

  // =========================================================================
  // boot
  // =========================================================================
  watchNetwork();

  if (typeof Peer === 'undefined') {
    notice('Could not load the connection library. Check your network and reload.');
  } else if (joinCode) {
    if (isValidCode(joinCode)) {
      configureGuestLobby(joinCode);
    } else {
      // a malformed ?room= value never reaches PeerJS — fall back to hosting
      joinCode = '';
      notice('That invite link looks malformed. You can open a fresh room instead.');
    }
  }
  // host lobby is the default markup — nothing to do
})();
