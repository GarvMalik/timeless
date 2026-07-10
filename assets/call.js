/* =========================================================================
   Timeless — call.js
   The orchestrator. Owns the lobby step machine (name -> choose -> camera
   preview -> [guests only] wait for the host), boots Room/ContentShare/
   Chat/Theater and wires them to the dock, and keeps the handful of small
   page-wide helpers (toast, notice, the shared banner, copy-to-clipboard).
   See ARCHITECTURE.md for the full protocol this orchestrates.
   ========================================================================= */

import { Room, isValidCode } from './room.js?v=7';
import { ContentShare, isDisplayCaptureSupported } from './content-share.js?v=7';
import { initChat } from './chat.js?v=7';
import { initTheater } from './theater.js?v=7';

const $ = (id) => document.getElementById(id);

// ---- element refs -----------------------------------------------------------
const roomEl = $('roomEl');
const lobby = $('lobby');
const stage = $('stage');
const dock = $('dock');

const statusEl = $('status');
const statusText = $('statusText');

const banner = $('banner');
const bannerText = $('bannerText');
const bannerClose = $('bannerClose');

const lobbyEyebrow = $('lobbyEyebrow');
const lobbyTitle = $('lobbyTitle');
const lobbySub = $('lobbySub');
const lobbyNotice = $('lobbyNotice');

const nameForm = $('nameForm');
const nameInput = $('nameInput');

const stepChoice = $('stepChoice');
const openBtn = $('openBtn');
const joinForm = $('joinForm');
const codeInput = $('codeInput');

const stepPreview = $('stepPreview');
const previewVideo = $('previewVideo');
const previewAvatar = $('previewAvatar');
const previewMicBtn = $('previewMicBtn');
const previewCamBtn = $('previewCamBtn');
const previewSub = $('previewSub');
const previewContinueBtn = $('previewContinueBtn');
const previewBackBtn = $('previewBackBtn');

const stepWaiting = $('stepWaiting');
const waitingText = $('waitingText');
const waitingCancelBtn = $('waitingCancelBtn');

const knockPanel = $('knockPanel');
const knockList = $('knockList');
const knockTemplate = $('knockTemplate');

const stageEmpty = $('stageEmpty');
const stageEmptyText = $('stageEmptyText');
const theaterCta = $('theaterCta');

const localTile = $('localTile');
const localVideo = $('localVideo');
const localAvatar = $('localAvatar');
const localTag = $('localTag');
const tileTemplate = $('tileTemplate');

const micBtn = $('micBtn');
const micLabel = $('micLabel');
const camBtn = $('camBtn');
const movieBtn = $('movieBtn');
const musicBtn = $('musicBtn');
const chatBtn = $('chatBtn');
const chatBadge = $('chatBadge');
const copyBtn = $('copyBtn');
const endBtn = $('endBtn');

const inviteChip = $('inviteChip');
const inviteChipLink = $('inviteChipLink');
const inviteChipCopy = $('inviteChipCopy');
const musicPill = $('musicPill');
const musicPillText = $('musicPillText');

const chatPanel = $('chatPanel');
const chatList = $('chatList');
const chatForm = $('chatForm');
const chatInput = $('chatInput');
const chatClose = $('chatClose');

const theaterView = $('theaterView');
const theaterVideo = $('theaterVideo');
const theaterExit = $('theaterExit');

const toast = $('toast');

// ---- url params ---------------------------------------------------------
const params = new URLSearchParams(window.location.search);
const rawRoomParam = (params.get('room') || '').trim().toLowerCase();
// a malformed ?room= value never reaches PeerJS — fall back to a fresh host flow
const joinCode = isValidCode(rawRoomParam) ? rawRoomParam : '';
const startMode = params.get('mode') === 'movie' ? 'movie' : 'camera';

// ---- module state ---------------------------------------------------------
let myName = '';
let previewStream = null;
let pendingRole = null; // 'host' | 'guest'
let pendingCode = null;
let startModeApplied = false;

// =========================================================================
// small page-wide helpers
// =========================================================================
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 2400);
}

function notice(msg) {
  if (!msg) { lobbyNotice.hidden = true; return; }
  lobbyNotice.hidden = false;
  lobbyNotice.textContent = msg;
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
  return Promise.resolve();
}

function inviteUrl(code) {
  return window.location.origin + window.location.pathname + '?room=' + encodeURIComponent(code);
}

function mediaError(e) {
  const name = (e && e.name) || 'Error';
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

function setTitle(prefix, emphasis) {
  lobbyTitle.textContent = prefix;
  const em = document.createElement('em');
  em.textContent = emphasis;
  lobbyTitle.appendChild(em);
}

// ---- shared banner: network trouble > perf advisory > back-online flash ---
let bannerShownFor = null; // 'offline' | 'ice' | 'perf' | null
let bannerDismissedFor = null;

function showBanner(kind, text) {
  if (kind === 'perf' && bannerShownFor && bannerShownFor !== 'perf') return; // trouble wins
  bannerShownFor = kind;
  if (bannerDismissedFor === kind) return;
  banner.hidden = false;
  banner.setAttribute('data-kind', kind);
  bannerText.textContent = text;
}

function hideBanner() {
  if (bannerShownFor === null) return;
  bannerShownFor = null;
  bannerDismissedFor = null;
  banner.hidden = true;
}

function flashRecovered() {
  if (bannerShownFor === null) return;
  const wasDismissed = bannerDismissedFor !== null;
  bannerShownFor = null;
  bannerDismissedFor = null;
  if (wasDismissed) { banner.hidden = true; return; }
  banner.setAttribute('data-kind', 'ok');
  bannerText.textContent = 'Back online.';
  clearTimeout(flashRecovered._t);
  flashRecovered._t = setTimeout(() => { banner.hidden = true; }, 2200);
}

bannerClose.addEventListener('click', () => {
  bannerDismissedFor = bannerShownFor;
  banner.hidden = true;
});

window.addEventListener('offline', () => showBanner('offline', "You're offline — check your internet connection. We'll keep waiting for you."));
window.addEventListener('online', () => { if (bannerShownFor === 'offline') flashRecovered(); });

// =========================================================================
// lobby step machine
// =========================================================================
const lobbyCard = document.querySelector('.lobby .card');

function showStep(id) {
  [nameForm, stepChoice, stepPreview, stepWaiting].forEach((el) => { el.hidden = el.id !== id; });
  // the preview step widens the card into a Meet-style two-column layout
  // (big camera preview left, actions vertically centered right)
  lobbyCard.classList.toggle('card--preview', id === 'stepPreview');
}

function enterRoomView() {
  lobby.hidden = true;
  stage.hidden = false;
  dock.hidden = false;
  roomEl.classList.add('room--live'); // the dark cinematic call theme — see styles.css
}

// Voice profile: good speech defaults, made explicit rather than left to
// whatever a given browser's implicit default happens to be. This is
// distinct from — and never applied to — Music/Movie Mode's content audio,
// which explicitly disables all three (see content-share.js).
const VOICE_AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

async function acquireCamera() {
  return navigator.mediaDevices.getUserMedia({ video: true, audio: VOICE_AUDIO_CONSTRAINTS });
}

function applyPreviewAvatarState() {
  const camOn = previewStream.getVideoTracks()[0]?.enabled !== false;
  previewAvatar.hidden = camOn;
}

async function goToPreview() {
  notice(null);
  if (!previewStream) {
    try {
      previewStream = await acquireCamera();
      previewVideo.srcObject = previewStream;
      applyPreviewAvatarState();
    } catch (e) {
      notice(mediaError(e));
      return;
    }
  }
  if (pendingRole === 'host') {
    setTitle('Ready to ', 'open?');
    previewSub.textContent = 'Just you so far — invite friends once the room is open.';
    previewContinueBtn.textContent = 'Open the room';
  } else {
    setTitle("Ready to ", 'join?');
    previewSub.textContent = "You're about to ask the host to let you in.";
    previewContinueBtn.textContent = 'Ask to join';
  }
  showStep('stepPreview');
}

previewMicBtn.addEventListener('click', () => {
  const track = previewStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  previewMicBtn.setAttribute('aria-pressed', track.enabled ? 'false' : 'true');
  previewMicBtn.querySelector('.i-on').hidden = !track.enabled;
  previewMicBtn.querySelector('.i-off').hidden = track.enabled;
});

previewCamBtn.addEventListener('click', () => {
  const track = previewStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  previewCamBtn.setAttribute('aria-pressed', track.enabled ? 'false' : 'true');
  previewCamBtn.querySelector('.i-on').hidden = !track.enabled;
  previewCamBtn.querySelector('.i-off').hidden = track.enabled;
  applyPreviewAvatarState();
});

previewBackBtn.addEventListener('click', () => {
  notice(null);
  if (joinCode) showStep('nameForm'); // came from an invite link — only "back" is redoing your name
  else showStep('stepChoice');
});

// =========================================================================
// Room / ContentShare / Chat / Theater — constructed once, reused across a
// cancel + retry (Room's join methods create a fresh Peer each call)
// =========================================================================
const room = new Room({
  stageEl: stage,
  tileTemplate,
  localVideoEl: localVideo,
  localAvatarEl: localAvatar,
  localTagEl: localTag,
  localTileEl: localTile,
});
const contentShare = new ContentShare(room);
const chat = initChat(room, { panel: chatPanel, list: chatList, form: chatForm, input: chatInput, closeBtn: chatClose, toggleBtn: chatBtn, badge: chatBadge }, () => myName);
const theater = initTheater(contentShare, room, { overlay: theaterView, video: theaterVideo, exitBtn: theaterExit, cta: theaterCta });

function syncStatus() {
  const count = room.getParticipantCount();
  stageEmpty.hidden = count > 0;
  if (count > 0) {
    statusEl.setAttribute('data-state', 'live');
    statusText.textContent = `Live · ${count + 1} in the room`;
  } else if (room.amHost) {
    statusEl.setAttribute('data-state', 'waiting');
    statusText.textContent = 'Waiting · room open';
    stageEmptyText.textContent = 'Waiting for someone to open your link…';
  } else {
    statusEl.setAttribute('data-state', 'waiting');
    statusText.textContent = 'Connected';
    stageEmptyText.textContent = 'Everyone else has left.';
  }
}

room.addEventListener('host-ready', (e) => {
  const url = inviteUrl(e.detail.code);
  inviteChipLink.textContent = url;
  inviteChip.classList.add('show');
  syncStatus();
  enterRoomView();
  maybeAutoStartMovie();
});

room.addEventListener('knock', (e) => {
  const { peerId, name } = e.detail;
  const el = knockTemplate.content.firstElementChild.cloneNode(true);
  el.dataset.peerId = peerId;
  el.querySelector('.knock__name').textContent = `${name} wants to join`;
  el.querySelector('.knock__admit').addEventListener('click', () => { room.admit(peerId); removeKnockCard(peerId); });
  el.querySelector('.knock__deny').addEventListener('click', () => { room.deny(peerId); removeKnockCard(peerId); });
  knockList.appendChild(el);
  knockPanel.hidden = false;
});

room.addEventListener('knock-cancelled', (e) => removeKnockCard(e.detail.peerId));

function removeKnockCard(peerId) {
  const el = knockList.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`);
  if (el) el.remove();
  knockPanel.hidden = knockList.children.length === 0;
}

room.addEventListener('knocking', () => {
  waitingText.textContent = 'Waiting for the host to let you in…';
  showStep('stepWaiting');
});

room.addEventListener('admitted', () => {
  syncStatus();
  enterRoomView();
  maybeAutoStartMovie();
});

room.addEventListener('denied', () => {
  notice("The host didn't let you in this time. You can ask again.");
  showStep('stepPreview');
});

room.addEventListener('join-cancelled', () => showStep('stepPreview'));

room.addEventListener('join-failed', (e) => {
  notice(e.detail.message);
  showStep(joinCode ? 'stepPreview' : 'stepChoice');
});

room.addEventListener('signal-error', (e) => showToast('Connection error: ' + e.detail.type));
room.addEventListener('peer-disconnected', () => showToast('Lost the signalling connection — try reloading.'));

room.addEventListener('participant-added', syncStatus);
room.addEventListener('participant-removed', syncStatus);

room.addEventListener('quality-changed', (e) => {
  if (e.detail.troubled) showBanner('ice', "Connection trouble — check your internet. We'll keep trying to reconnect…");
  else if (bannerShownFor === 'ice') flashRecovered();
});

room.addEventListener('grid-changed', (e) => {
  if (e.detail.large) showBanner('perf', 'Big call! Turning off cameras can help keep things smooth for everyone.');
  else if (bannerShownFor === 'perf') hideBanner();
});

room.addEventListener('local-state', syncDockUI);

function maybeAutoStartMovie() {
  if (startMode === 'movie' && !startModeApplied) {
    startModeApplied = true;
    contentShare.startMovie().catch(() => {});
  }
}

// =========================================================================
// dock — mic / camera
// =========================================================================
function setPressed(btn, on) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
function swapIcon(btn, off) {
  const on = btn.querySelector('.i-on');
  const offIcon = btn.querySelector('.i-off');
  if (on && offIcon) { on.hidden = off; offIcon.hidden = !off; }
}

function syncDockUI(e) {
  const state = e && e.detail ? e.detail : room.localState;
  setPressed(micBtn, !state.mic);
  swapIcon(micBtn, !state.mic);
  micBtn.setAttribute('aria-label', state.mic ? 'Mute microphone' : 'Unmute microphone');
  if (!state.mic) micBtn.classList.remove('ctrl--speaking'); // no glow while muted

  setPressed(camBtn, !state.cam);
  swapIcon(camBtn, !state.cam);
  camBtn.setAttribute('aria-label', state.cam ? 'Turn camera off' : 'Turn camera on');
  camBtn.disabled = state.content === 'movie';
}

micBtn.addEventListener('click', () => room.setLocalMic(!room.localState.mic));
camBtn.addEventListener('click', () => {
  if (room.localState.content === 'none') room.setLocalCam(!room.localState.cam);
});

room.addEventListener('mic-level', (e) => {
  micBtn.classList.toggle('ctrl--speaking', e.detail.speaking);
});

// re-acquiring the camera (after it was fully stopped) is a real async
// operation now, not an instant flag flip — reflect that honestly
room.addEventListener('cam-loading', (e) => {
  camBtn.disabled = e.detail.loading;
  camBtn.setAttribute('aria-busy', e.detail.loading ? 'true' : 'false');
  camBtn.querySelector('.ctrl__spinner').hidden = !e.detail.loading;
});
room.addEventListener('cam-error', (e) => showToast(mediaError(e.detail.error)));

// =========================================================================
// dock — Movie Mode / Music Mode
// =========================================================================
function syncModeUI() {
  const kind = contentShare.kind;
  setPressed(movieBtn, kind === 'movie');
  movieBtn.setAttribute('aria-label', kind === 'movie' ? 'Stop Movie Mode' : 'Start Movie Mode');
  setPressed(musicBtn, kind === 'music');
  musicBtn.setAttribute('aria-label', kind === 'music' ? 'Stop Music Mode' : 'Start Music Mode');
  micLabel.textContent = kind === 'music' ? 'Talk over music' : 'Microphone';
  syncClaimUI();
}

function syncClaimUI() {
  const claim = contentShare.getActiveClaim();
  const blockedByOther = !!claim && claim.peerId !== room.getMyPeerId();
  const kind = contentShare.kind;
  movieBtn.disabled = blockedByOther || kind === 'music';
  musicBtn.disabled = blockedByOther || kind === 'movie';

  const showPill = !!claim && claim.kind === 'music' && claim.peerId !== room.getMyPeerId();
  musicPill.classList.toggle('show', showPill);
  if (showPill) musicPillText.textContent = `${claim.name || 'Someone'}'s music`;
}

movieBtn.addEventListener('click', () => {
  if (contentShare.kind === 'movie') contentShare.stop();
  else if (contentShare.kind === 'none') contentShare.startMovie();
});
musicBtn.addEventListener('click', () => {
  if (contentShare.kind === 'music') contentShare.stop();
  else if (contentShare.kind === 'none') contentShare.startMusic();
});

contentShare.addEventListener('started', syncModeUI);
contentShare.addEventListener('stopped', syncModeUI);
contentShare.addEventListener('remote-claim', syncClaimUI);
contentShare.addEventListener('blocked', (e) => showToast(`${e.detail.by} is already sharing — ask them to stop first.`));
contentShare.addEventListener('preempted', (e) => showToast(`${e.detail.by} started sharing first.`));
contentShare.addEventListener('unsupported', () => showToast('Your browser cannot share tab audio — try Chrome or Edge.'));
contentShare.addEventListener('no-audio', () => showToast('That share had no audio — pick a tab that is playing sound.'));

if (!isDisplayCaptureSupported()) {
  movieBtn.disabled = true;
  musicBtn.disabled = true;
  movieBtn.querySelector('.ctrl__label').textContent = 'Not supported here';
  musicBtn.querySelector('.ctrl__label').textContent = 'Not supported here';
}

// =========================================================================
// dock — copy invite / leave
// =========================================================================
function doCopy() {
  const code = room.getRoomCode();
  if (!code) return;
  copyText(inviteUrl(code)).then(() => showToast('Invite link copied'));
}
copyBtn.addEventListener('click', doCopy);
inviteChipCopy.addEventListener('click', doCopy);

function leave() {
  room.leave();
  document.body.style.transition = 'opacity 0.5s ease';
  document.body.style.opacity = '0.3';
  setTimeout(() => { window.location.href = 'index.html'; }, 550);
}
endBtn.addEventListener('click', leave);

window.addEventListener('beforeunload', () => { try { room.leave(); } catch (e) {} });

// =========================================================================
// lobby wiring
// =========================================================================
nameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!name) { notice('Enter a name to continue.'); return; }
  notice(null);
  myName = name;
  room.setName(name);

  if (joinCode) {
    pendingRole = 'guest';
    pendingCode = joinCode;
    goToPreview();
  } else {
    showStep('stepChoice');
  }
});

openBtn.addEventListener('click', () => {
  pendingRole = 'host';
  pendingCode = null;
  goToPreview();
});

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = (codeInput.value || '').trim().toLowerCase();
  if (!code) { notice('Enter a room code to join.'); return; }
  if (!isValidCode(code)) { notice('That room code doesn’t look right — codes are letters and numbers only.'); return; }
  notice(null);
  pendingRole = 'guest';
  pendingCode = code;
  goToPreview();
});

previewContinueBtn.addEventListener('click', async () => {
  room.setLocalStream(previewStream);
  // carry over any mic/camera choice made during the preview — awaited so
  // a camera turned off in preview is actually stopped/released (not just
  // muted) before the room opens, same guarantee as toggling it mid-call
  if (previewStream.getVideoTracks()[0]?.enabled === false) await room.setLocalCam(false);
  if (previewStream.getAudioTracks()[0]?.enabled === false) room.setLocalMic(false);
  syncDockUI();

  if (pendingRole === 'host') {
    room.openAsHost();
  } else {
    room.joinAsGuest(pendingCode);
  }
});

waitingCancelBtn.addEventListener('click', () => room.cancelJoin());

// =========================================================================
// boot
// =========================================================================
if (typeof Peer === 'undefined') {
  notice('Could not load the connection library. Check your network and reload.');
} else if (joinCode) {
  setTitle("You're ", 'invited.');
  lobbySub.textContent = "Someone opened a Timeless room and shared it with you. We'll ask your name, then your camera — the host lets you in from there.";
} else if (rawRoomParam) {
  notice('That invite link looks malformed. You can open a fresh room instead.');
}
showStep('nameForm');
