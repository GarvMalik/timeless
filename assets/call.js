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

  var localVideo = $('localVideo');
  var remoteVideo = $('remoteVideo');
  var remoteWait = $('remoteWait');
  var remoteWaitText = $('remoteWaitText');

  var micBtn = $('micBtn');
  var camBtn = $('camBtn');
  var screenBtn = $('screenBtn');
  var copyBtn = $('copyBtn');
  var endBtn = $('endBtn');
  var toast = $('toast');

  // ---- state -------------------------------------------------------------
  var peer = null;
  var currentCall = null;
  var localStream = null;
  var screenStream = null;

  var roomCode = null;
  var isHost = false;
  var micOn = true;
  var camOn = true;
  var sharingScreen = false;
  var startMode = 'camera';
  var ended = false;

  // ---- url params --------------------------------------------------------
  var params = new URLSearchParams(window.location.search);
  var joinCode = (params.get('room') || '').trim();
  startMode = params.get('mode') === 'screen' ? 'screen' : 'camera';

  // =========================================================================
  // helpers
  // =========================================================================
  function makeCode() {
    // 6 lowercase alphanumerics — readable, valid PeerJS id
    var abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    var s = '';
    for (var i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
    return s;
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
    setStatus('live', 'Live · connected');
  }

  function wireCall(call) {
    currentCall = call;
    call.on('stream', function (stream) { attachRemote(stream); });
    call.on('close', function () { onPeerLeft(); });
    call.on('error', function (err) {
      console.warn('call error', err);
      showToast('The connection dropped.');
    });
  }

  function onPeerLeft() {
    if (ended) return;
    remoteVideo.srcObject = null;
    remoteWait.hidden = false;
    remoteWaitText.textContent = isHost
      ? 'They left. Your room is still open — share the link again to invite someone.'
      : 'The host closed the room.';
    setStatus('waiting', isHost ? 'Waiting · room open' : 'Disconnected');
  }

  // ---- host --------------------------------------------------------------
  function openAsHost() {
    isHost = true;
    roomCode = makeCode();
    peer = new Peer(roomCode);

    peer.on('open', function (id) {
      roomCode = id;
      var url = inviteUrl(id);
      inviteLink.textContent = url;
      invite.classList.add('show');
      setStatus('waiting', 'Waiting · room open');
      remoteWaitText.textContent = 'Waiting for someone to open your link…';
      enterRoomView();
    });

    peer.on('call', function (call) {
      call.answer(localStream);
      wireCall(call);
    });

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
    peer = new Peer();

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
    lobbyTitle.innerHTML = "You're <em>invited.</em>";
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

  window.addEventListener('beforeunload', function () {
    try { if (peer) peer.destroy(); } catch (e) {}
  });

  // =========================================================================
  // boot
  // =========================================================================
  if (typeof Peer === 'undefined') {
    notice('Could not load the connection library. Check your network and reload.');
  } else if (joinCode) {
    configureGuestLobby(joinCode);
  }
  // host lobby is the default markup — nothing to do
})();
