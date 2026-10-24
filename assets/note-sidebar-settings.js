// Sidebar preferences retain unavailable feature slots; only visible rows move.
(function () {
  'use strict';
  const KEY = 'canvas:noteSidebarPages:v1';
  const IDS = ['notebooks', 'outline', 'canvas', 'guide', 'links', 'ai'];
  const NAMES = { notebooks: ['笔记本', 'Notebooks'], outline: ['大纲', 'Outline'], canvas: ['画布', 'Canvas'], guide: ['引导', 'Guide'], links: ['链接', 'Links'], ai: ['AI', 'AI'] };
  function create(options) {
    let order = IDS.slice(), hidden = new Set(), host = null, drag = null;
    const animations = new Map(), motion = window.RelatumNoteSystem?.motion || matchMedia('(prefers-reduced-motion: reduce)');
    const text = (zh, en) => options.language() === 'en' ? en : zh;
    function read() {
      try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (Array.isArray(raw?.order)) order = [...new Set(raw.order.filter(id => IDS.includes(id))), ...IDS.filter(id => !raw.order.includes(id))];
        if (Array.isArray(raw?.hidden)) hidden = new Set(raw.hidden.filter(id => IDS.includes(id)));
      } catch (_) {}
    }
    read();
    const available = () => order.filter(options.available);
    const visible = () => available().filter(id => !hidden.has(id));
    const rows = () => Array.from(host?.querySelectorAll('[data-sidebar-page]') || []);
    function persist() {
      try { localStorage.setItem(KEY, JSON.stringify({ order, hidden: [...hidden] })); } catch (_) {}
      options.onChange();
    }
    function merge(ids) {
      let index = 0;
      order = order.map(id => options.available(id) ? ids[index++] : id);
    }
    function stopAnimations() { animations.forEach(animation => animation.cancel()); animations.clear(); }
    function flip(change) {
      const before = new Map(rows().map(row => [row, row.getBoundingClientRect().top]));
      stopAnimations(); change();
      if (motion.matches) return;
      rows().forEach(row => {
        if (row === drag?.row || typeof row.animate !== 'function') return;
        const dy = before.get(row) - row.getBoundingClientRect().top;
        if (!Number.isFinite(dy) || Math.abs(dy) < 1) return;
        const animation = row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)' });
        animations.set(row, animation);
        animation.finished.catch(() => {}).then(() => { if (animations.get(row) === animation) animations.delete(row); });
      });
    }
    function finish(cancel = false, instant = false) {
      const current = drag;
      if (!current) return false;
      drag = null; cancelAnimationFrame(current.frame);
      current.listeners.abort();
      try { host.releasePointerCapture(current.pointer); } catch (_) {}
      current.ghost?.remove(); current.row.classList.remove('is-dragging');
      if (cancel) {
        const restore = () => current.original.forEach(id => host.append(current.byId.get(id)));
        stopAnimations(); restore();
      } else if (current.active) {
        merge(rows().map(row => row.dataset.sidebarPage)); persist();
      }
      if (!instant && current.handle.isConnected) current.handle.focus({ preventScroll: true });
      return true;
    }
    function moveAt(clientY) {
      const current = drag;
      if (!current?.active) return;
      const rest = rows().filter(row => row !== current.row);
      const next = rest.find(row => clientY < row.getBoundingClientRect().top + row.offsetHeight / 2) || null;
      if (current.row.nextElementSibling !== next) flip(() => host.insertBefore(current.row, next));
    }
    function frame() {
      const current = drag;
      if (!current?.active) return;
      current.frame = 0;
      current.ghost.style.transform = `translate(${current.x - current.offsetX}px,${current.y - current.offsetY}px)`;
      const scroll = host.closest('.relatum-settings-scroll'), rect = scroll.getBoundingClientRect();
      const previous = scroll.scrollTop;
      if (current.y < rect.top + 30) scroll.scrollTop -= 8;
      else if (current.y > rect.bottom - 30) scroll.scrollTop += 8;
      moveAt(current.y);
      if (scroll.scrollTop !== previous && drag === current) current.frame = requestAnimationFrame(frame);
    }
    function begin(event, row, handle) {
      if (event.button !== 0 || drag || rows().length < 2) return;
      event.preventDefault(); event.stopPropagation();
      host.tabIndex = -1; host.focus({ preventScroll: true });
      const rect = row.getBoundingClientRect(), listeners = new AbortController();
      const current = drag = { row, handle, pointer: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, active: false, frame: 0, ghost: null, listeners, original: rows().map(item => item.dataset.sidebarPage), byId: new Map(rows().map(item => [item.dataset.sidebarPage, item])) };
      // Capture on the stationary list: moving a captured row in the DOM can
      // otherwise emit lostpointercapture and cancel its own reorder.
      try { host.setPointerCapture(event.pointerId); } catch (_) {}
      function move(e) {
        if (drag !== current || e.pointerId !== current.pointer) return;
        current.x = e.clientX; current.y = e.clientY;
        if (!current.active && Math.hypot(current.x - current.startX, current.y - current.startY) >= 6) {
          current.active = true;
          const ghost = current.ghost = row.cloneNode(true);
          ghost.classList.add('note-sidebar-ghost'); ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
          ghost.style.width = rect.width + 'px'; ghost.style.height = rect.height + 'px';
          host.closest('dialog').append(ghost); row.classList.add('is-dragging');
        }
        if (current.active) { e.preventDefault(); if (!current.frame) current.frame = requestAnimationFrame(frame); }
      }
      window.addEventListener('pointermove', move, { passive: false, signal: listeners.signal });
      window.addEventListener('pointerup', e => { if (e.pointerId === current.pointer) { if (current.active) moveAt(e.clientY); finish(); } }, { signal: listeners.signal });
      window.addEventListener('pointercancel', () => finish(true, true), { signal: listeners.signal });
      host.addEventListener('lostpointercapture', () => finish(true, true), { signal: listeners.signal });
    }
    function render() {
      if (!host) return;
      finish(true, true); stopAnimations();
      const focused = document.activeElement?.closest('[data-sidebar-page]')?.dataset.sidebarPage;
      host.replaceChildren();
      available().forEach(id => {
        const row = document.createElement('div'); row.className = 'note-sidebar-setting'; row.dataset.sidebarPage = id;
        const grip = document.createElement('button'); grip.type = 'button'; grip.className = 'note-sidebar-grip'; grip.textContent = '⠿'; grip.setAttribute('aria-label', text('拖动调整顺序：', 'Reorder: ') + NAMES[id][options.language() === 'en' ? 1 : 0]);
        const label = document.createElement('label'), input = document.createElement('input'), name = document.createElement('strong');
        input.type = 'checkbox'; input.checked = !hidden.has(id); input.dataset.sidebarVisible = id;
        name.textContent = NAMES[id][options.language() === 'en' ? 1 : 0]; label.append(input, name);
        input.addEventListener('change', () => { if (input.checked) hidden.delete(id); else hidden.add(id); persist(); });
        grip.addEventListener('pointerdown', event => begin(event, row, grip));
        grip.addEventListener('keydown', event => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || drag) return;
          event.preventDefault(); reorder(id, event.key === 'Home' ? -Infinity : event.key === 'End' ? Infinity : event.key === 'ArrowUp' ? -1 : 1);
        });
        row.append(grip, label);
        [-1, 1].forEach(direction => {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'note-sidebar-step'; button.textContent = direction < 0 ? '↑' : '↓';
          button.setAttribute('aria-label', text(direction < 0 ? '上移' : '下移', direction < 0 ? 'Move up' : 'Move down') + ' ' + name.textContent);
          button.addEventListener('click', () => reorder(id, direction)); row.append(button);
        });
        host.append(row);
      });
      if (focused) rows().find(row => row.dataset.sidebarPage === focused)?.querySelector('.note-sidebar-grip').focus({ preventScroll: true });
    }
    function reorder(id, direction) {
      const items = rows(), index = items.findIndex(row => row.dataset.sidebarPage === id);
      const target = Math.max(0, Math.min(items.length - 1, index + direction));
      if (index === target || index < 0) return;
      const row = items.splice(index, 1)[0]; items.splice(target, 0, row);
      flip(() => items.forEach(item => host.append(item)));
      merge(items.map(item => item.dataset.sidebarPage)); persist();
    }
    function suspend() { finish(true, true); stopAnimations(); }
    window.addEventListener('blur', suspend);
    document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); });
    window.addEventListener('canvasdesktop:visibility', () => { if (document.documentElement.dataset.desktopMinimized === '1') suspend(); });
    window.addEventListener('pagehide', suspend);
    motion.addEventListener('change', suspend);
    return { visible, available, suspend, refresh: render,
      initPanel(element) { host = element; render(); host.addEventListener('keydown', event => { if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); finish(true); } }, true); },
      reset() { suspend(); order = IDS.slice(); hidden.clear(); try { localStorage.removeItem(KEY); } catch (_) {} render(); options.onChange(); },
    };
  }
  window.RelatumNoteSidebarSettings = { create };
})();
