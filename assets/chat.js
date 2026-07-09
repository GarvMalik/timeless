/* =========================================================================
   Timeless — chat.js
   Text chat, fanned out over the room's existing per-participant data
   connections (mesh means no relay is needed once everyone's joined — a
   message is just sent directly to every open connection). Every write to
   the DOM here uses textContent/createElement, never innerHTML — the sender
   name and message text are the only participant-controlled input in this
   whole module, so that's the one invariant that actually matters.
   ========================================================================= */

const TEXT_MAX = 2000;

function messageId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return 'm' + Math.random().toString(36).slice(2);
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

export function initChat(room, els, getMyName) {
  const { panel, list, form, input, closeBtn, toggleBtn, badge } = els;
  const seen = new Set(); // de-dupe defence, keyed by message id
  let isOpen = false;
  let unread = 0;

  function isNearBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  }

  function render({ name, text, ts, mine, system }) {
    const wasNearBottom = isNearBottom();
    const row = document.createElement('div');
    row.className = 'msg' + (mine ? ' msg--me' : '') + (system ? ' msg--system' : '');

    if (!system) {
      const meta = document.createElement('div');
      meta.className = 'msg__meta';
      const nameEl = document.createElement('span');
      nameEl.className = 'msg__name';
      nameEl.textContent = name;
      const timeEl = document.createElement('span');
      timeEl.className = 'msg__time';
      timeEl.textContent = formatTime(ts);
      meta.append(nameEl, timeEl);
      row.appendChild(meta);
    }

    const textEl = document.createElement('div');
    textEl.className = 'msg__text';
    textEl.textContent = text;
    row.appendChild(textEl);

    list.appendChild(row);
    if (wasNearBottom || isOpen) list.scrollTop = list.scrollHeight;
  }

  function setUnread(n) {
    unread = Math.max(0, n);
    badge.hidden = unread === 0 || isOpen;
  }

  function open() {
    isOpen = true;
    panel.classList.add('show');
    toggleBtn.setAttribute('aria-pressed', 'true');
    setUnread(0);
    setTimeout(() => input.focus(), 260); // after the slide-in transition
  }

  function close() {
    isOpen = false;
    panel.classList.remove('show');
    toggleBtn.setAttribute('aria-pressed', 'false');
  }

  function toggle() {
    if (isOpen) close(); else open();
  }

  toggleBtn.addEventListener('click', toggle);
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) close();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim().slice(0, TEXT_MAX);
    if (!text) return;
    const msg = { t: 'chat', id: messageId(), name: getMyName(), text, ts: Date.now() };
    seen.add(msg.id);
    room.broadcast(msg);
    render({ name: msg.name, text: msg.text, ts: msg.ts, mine: true });
    input.value = '';
  });

  room.addEventListener('data', (e) => {
    const { msg } = e.detail;
    if (!msg || msg.t !== 'chat' || !msg.id || seen.has(msg.id)) return;
    seen.add(msg.id);
    render({
      name: typeof msg.name === 'string' ? msg.name.slice(0, 40) : 'Someone',
      text: typeof msg.text === 'string' ? msg.text.slice(0, TEXT_MAX) : '',
      ts: typeof msg.ts === 'number' ? msg.ts : Date.now(),
      mine: false,
    });
    if (!isOpen) setUnread(unread + 1);
  });

  room.addEventListener('participant-added', (e) => {
    render({ text: `${e.detail.participant.name} joined the room`, system: true, ts: Date.now() });
  });
  room.addEventListener('participant-removed', (e) => {
    render({ text: `${e.detail.name || 'Someone'} left the room`, system: true, ts: Date.now() });
  });

  return { open, close, toggle };
}
