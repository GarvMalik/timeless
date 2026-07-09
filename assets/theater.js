/* =========================================================================
   Timeless — theater.js
   The full-screen "watch together" focus view. Purely local UI state — it
   is never synced between participants, so anyone can enter or leave their
   own focus view independently without affecting anyone else. It only
   auto-exits when the underlying shared content itself stops (the sharer
   ends it, or the browser's own "Stop sharing" control is used) — that's a
   real state change everyone needs to see, not a preference.
   ========================================================================= */

const IDLE_DELAY = 2600;

export function initTheater(contentShare, room, els) {
  const { overlay, video, exitBtn, cta } = els;
  let idleTimer = null;
  let open = false;

  function currentSourceEl() {
    const claim = contentShare.getActiveClaim();
    if (!claim || claim.kind !== 'movie') return null;
    if (claim.peerId === room.getMyPeerId()) return room.localVideoEl;
    const p = room.getParticipants().get(claim.peerId);
    return p ? p.video : null;
  }

  function updateCta() {
    const claim = contentShare.getActiveClaim();
    cta.hidden = open || !claim || claim.kind !== 'movie';
  }

  function resetIdle() {
    overlay.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => overlay.classList.add('idle'), IDLE_DELAY);
  }

  function enter() {
    const src = currentSourceEl();
    if (!src || !src.srcObject) return;
    video.srcObject = src.srcObject;
    overlay.classList.add('show');
    open = true;
    updateCta();
    resetIdle();
  }

  function exit() {
    overlay.classList.remove('show', 'idle');
    video.srcObject = null;
    clearTimeout(idleTimer);
    open = false;
    updateCta();
  }

  cta.addEventListener('click', enter);
  exitBtn.addEventListener('click', exit);
  overlay.addEventListener('mousemove', resetIdle);
  overlay.addEventListener('click', resetIdle);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) exit();
  });

  contentShare.addEventListener('started', updateCta);
  contentShare.addEventListener('stopped', () => { if (open) exit(); else updateCta(); });
  contentShare.addEventListener('content-ended', () => { if (open) exit(); });
  contentShare.addEventListener('remote-claim', updateCta);
  contentShare.addEventListener('preempted', () => { if (open) exit(); });

  return { enter, exit };
}
