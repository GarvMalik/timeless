/* =========================================================================
   Timeless — theater.js
   The full-screen "watch together" view for people WATCHING a shared movie.
   Strictly viewer-side: the presenter never sees the CTA or the More-menu
   entry for it — they're already looking at the source. Purely local UI
   state, never synced between participants; anyone can enter or leave
   independently without affecting anyone else.

   Uses the real Fullscreen API (address bar/tabs/toolbars disappear, like a
   streaming site) with the overlay as the experience itself — if the
   fullscreen request is rejected (unsupported, iframe policy), the overlay
   alone still delivers the focus view rather than failing.

   Auto-exits when the shared content genuinely goes away: the presenter
   stops or is preempted, the browser's own "Stop sharing" fires, the
   presenter disconnects (content-share clears the stale claim), or native
   fullscreen is dismissed (Esc handled by the browser itself).
   ========================================================================= */

const IDLE_DELAY = 2600;

export function initTheater(contentShare, room, els) {
  const { overlay, video, exitBtn, cta } = els;
  let idleTimer = null;
  let open = false;

  // viewer-only: a movie claim held by someone OTHER than you
  function viewableClaim() {
    const claim = contentShare.getActiveClaim();
    if (!claim || claim.kind !== 'movie') return null;
    if (claim.peerId === room.getMyPeerId()) return null;
    return claim;
  }

  function currentSourceEl() {
    const claim = viewableClaim();
    if (!claim) return null;
    const p = room.getParticipants().get(claim.peerId);
    return p ? p.video : null;
  }

  function updateCta() {
    cta.hidden = open || !viewableClaim();
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
    // same autoplay caution as the tiles — Safari can refuse silently
    video.play().catch(() => {});
    overlay.classList.add('show');
    open = true;
    updateCta();
    resetIdle();
    // Real browser fullscreen, best-effort: entering from a click satisfies
    // the user-gesture requirement; if it's rejected anyway the overlay
    // already covers the app, so the experience degrades gracefully.
    if (overlay.requestFullscreen && !document.fullscreenElement) {
      overlay.requestFullscreen().catch(() => {});
    }
  }

  function exit() {
    overlay.classList.remove('show', 'idle');
    video.srcObject = null;
    clearTimeout(idleTimer);
    open = false;
    updateCta();
    // no recursion risk with the fullscreenchange listener below: by the
    // time it re-runs exit(), fullscreenElement is already null and open is
    // false, so both sides no-op
    if (document.fullscreenElement === overlay) {
      document.exitFullscreen().catch(() => {});
    }
  }

  // the browser exits fullscreen on its own Esc handling (our keydown never
  // sees it) and via UI affordances — keep theater state in sync either way
  document.addEventListener('fullscreenchange', () => {
    if (open && !document.fullscreenElement) exit();
  });

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
  contentShare.addEventListener('remote-claim', () => {
    // a remote presenter stopping (or vanishing) must close an OPEN theater,
    // not just hide the CTA — otherwise the viewer is stuck on a dead frame
    if (open && !viewableClaim()) exit();
    updateCta();
  });
  contentShare.addEventListener('preempted', () => { if (open) exit(); });

  return { enter, exit };
}
