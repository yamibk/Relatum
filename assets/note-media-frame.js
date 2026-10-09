// Existing note image corner gesture, shared with optional embedded media.
// Source/history remain owned by the caller. This helper never loads a runtime.
(function () {
  'use strict';
  function resize(frame, options) {
    if (!options.selected) return () => {};
    const handle = document.createElement('span'); handle.className = 'note-live-image-resize-handle';
    handle.setAttribute('role', 'separator'); handle.setAttribute('aria-label', options.label || '等比例调整大小');
    frame.appendChild(handle); let cancelGesture = null;
    const down = event => {
      if (event.button !== 0 || options.blocked?.()) return;
      event.preventDefault(); event.stopPropagation();
      const initial = options.resolve(); if (!initial) return;
      const rect = frame.getBoundingClientRect(), max = Math.max(48, options.maxWidth());
      let next = Math.round(rect.width), finished = false;
      frame.classList.add('is-resizing');
      try { handle.setPointerCapture(event.pointerId); } catch (_) {}
      const preview = event => { next = Math.round(Math.max(48, Math.min(max, rect.width + event.clientX - downX))); options.preview(next, rect); };
      const downX = event.clientX;
      const cleanup = () => {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', cancel); handle.removeEventListener('lostpointercapture', cancel);
        document.removeEventListener('keydown', key, true); window.removeEventListener('blur', cancel);
        document.removeEventListener('visibilitychange', visibility);
        try { if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); } catch (_) {}
        frame.classList.remove('is-resizing'); cancelGesture = null;
      };
      const finish = commit => {
        if (finished) return; finished = true; cleanup();
        if (commit && options.resolve()) options.commit(next, rect); else options.restore(initial);
      };
      const move = e => { if (e.pointerId === event.pointerId) { e.preventDefault(); preview(e); } };
      const up = e => { if (e.pointerId === event.pointerId) { e.preventDefault(); preview(e); finish(true); } };
      const cancel = () => finish(false);
      const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
      const visibility = () => { if (document.hidden) cancel(); };
      cancelGesture = cancel;
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', cancel); handle.addEventListener('lostpointercapture', cancel);
      document.addEventListener('keydown', key, true); window.addEventListener('blur', cancel); document.addEventListener('visibilitychange', visibility);
    };
    handle.addEventListener('pointerdown', down);
    return () => { if (cancelGesture) cancelGesture(); handle.removeEventListener('pointerdown', down); handle.remove(); };
  }
  window.RelatumNoteMediaFrame = Object.freeze({ resize });
})();
