// Shared, blur-free graph window. Rendering and graph data stay in each adapter.
(function (global) {
  'use strict';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function create(options) {
    const overlay = options.overlay;
    const find = selector => overlay.querySelector(selector);
    const frame = find('[data-role="graph-window"]');
    const handle = find('[data-role="graph-drag-handle"]');
    const opacity = find('[data-role="graph-opacity"]');
    const opacityValue = find('[data-role="graph-opacity-val"]');
    const trigger = options.trigger;
    if (!frame || !handle || !find('[data-role="graph-canvas"]')) return null;
    const motion = global.matchMedia('(prefers-reduced-motion: reduce)');
    let engine = null, opened = false, closing = false, destroyed = false;
    let closeTimer = 0, resizeTimer = 0, drag = null, amount = 94;
    let previousFocus = null, restoreFocus = true;
    const listeners = [];
    function listen(target, type, callback, settings) {
      target.addEventListener(type, callback, settings);
      listeners.push(() => target.removeEventListener(type, callback, settings));
    }
    function canvas() { return engine?.canvas || find('[data-role="graph-canvas"]'); }
    function keepVisible() {
      if (overlay.hidden) return;
      const bounds = overlay.getBoundingClientRect();
      const maxLeft = Math.max(12, bounds.width - Math.min(frame.offsetWidth, bounds.width - 24) - 12);
      const maxTop = Math.max(12, bounds.height - Math.min(frame.offsetHeight, bounds.height - 24) - 12);
      frame.style.left = clamp(parseFloat(frame.style.left) || 12, 12, maxLeft) + 'px';
      frame.style.top = clamp(parseFloat(frame.style.top) || 12, 12, maxTop) + 'px';
    }
    function state() {
      return { opacity: amount, rect: { left: parseFloat(frame.style.left) || 12,
        top: parseFloat(frame.style.top) || 12, width: frame.offsetWidth, height: frame.offsetHeight } };
    }
    function persist() {
      if (!opened || overlay.hidden || destroyed) return;
      options.writePreferences?.(state());
    }
    function applyOpacity(value) {
      const parsed = Number(value);
      amount = clamp(Number.isFinite(parsed) && parsed > 0 ? parsed : 94, 36, 100);
      if (opacity) {
        opacity.value = String(amount);
        opacity.style.setProperty('--graph-opacity-pct', ((amount - 36) / 64 * 100).toFixed(2) + '%');
      }
      if (opacityValue) opacityValue.textContent = amount + '%';
      frame.style.setProperty('--graph-window-alpha', (amount / 100).toFixed(2));
    }
    function stopDrag(event) {
      if (!drag || event && event.pointerId !== drag.pointerId) return;
      const pointerId = drag.pointerId; drag = null;
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      keepVisible(); persist();
    }
    function release() {
      clearTimeout(resizeTimer); resizeTimer = 0;
      if (!engine) return;
      const previous = canvas();
      engine?.destroy(); engine = null;
      if (previous) {
        const replacement = previous.cloneNode(false);
        replacement.width = replacement.height = 1;
        previous.replaceWith(replacement);
        try { previous.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {}
        previous.width = previous.height = 1;
        options.onRelease?.(replacement);
      }
    }
    function finishClose() {
      if (!closing) return;
      closing = false; clearTimeout(closeTimer); closeTimer = 0;
      overlay.classList.remove('closing'); overlay.hidden = true;
      release(); options.onVisibilityChange?.(false);
      const focus = trigger || previousFocus;
      if (restoreFocus && focus?.isConnected && !focus.disabled) focus.focus({ preventScroll: true });
      previousFocus = null;
    }
    function close(settings) {
      if (!opened && !closing) return;
      if (opened) {
        restoreFocus = settings?.restoreFocus !== false;
        persist(); opened = false; closing = true;
        engine?.setActive(false); stopDrag();
        if (trigger) { trigger.classList.remove('active'); trigger.setAttribute('aria-expanded', 'false'); }
        options.onCloseStart?.();
      }
      if (motion.matches || settings?.immediate) finishClose();
      else { overlay.classList.add('closing'); clearTimeout(closeTimer); closeTimer = setTimeout(finishClose, 280); }
    }
    function open() {
      if (destroyed) return null;
      if (!opened || overlay.hidden) previousFocus = document.activeElement;
      clearTimeout(closeTimer); closeTimer = 0; closing = false;
      overlay.classList.remove('closing'); overlay.hidden = false;
      if (!engine) engine = options.createEngine?.(canvas()) || null;
      if (!engine) { overlay.hidden = true; return null; }
      opened = true;
      const preferences = options.readPreferences?.() || {};
      applyOpacity(preferences.opacity);
      const bounds = overlay.getBoundingClientRect(), rect = preferences.rect;
      if (options.restoreRect && rect && ['left', 'top', 'width', 'height'].every(key => Number.isFinite(rect[key]))) {
        frame.style.width = clamp(rect.width, Math.min(540, bounds.width - 24), bounds.width - 24) + 'px';
        frame.style.height = clamp(rect.height, Math.min(430, bounds.height - 24), bounds.height - 24) + 'px';
        frame.style.left = rect.left + 'px'; frame.style.top = rect.top + 'px';
      } else {
        if (options.restoreRect) { frame.style.width = ''; frame.style.height = ''; }
        frame.style.left = Math.max(12, (bounds.width - frame.offsetWidth) / 2) + 'px';
        frame.style.top = Math.max(12, (bounds.height - frame.offsetHeight) / 2) + 'px';
      }
      keepVisible();
      if (trigger) { trigger.classList.add('active'); trigger.setAttribute('aria-expanded', 'true'); }
      options.onVisibilityChange?.(true);
      closeButton?.focus({ preventScroll: true });
      return engine;
    }
    if (opacity) listen(opacity, 'input', () => { applyOpacity(opacity.value); persist(); });
    const closeButton = find('[data-action="graph-close"]');
    if (closeButton) listen(closeButton, 'click', () => close());
    listen(document, 'keydown', event => {
      if (!opened || overlay.hidden || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close();
      } else if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const controls = Array.from(frame.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]'))
          .filter(element => !element.hidden && !element.closest('[hidden]'));
        if (!controls.length) return;
        const current = controls.indexOf(document.activeElement);
        if (current < 0 || event.shiftKey && current === 0 || !event.shiftKey && current === controls.length - 1) {
          event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus({ preventScroll: true });
        }
      }
    }, true);
    listen(overlay, 'mousedown', event => { if (event.target === overlay) close(); });
    listen(frame, 'animationend', event => { if (closing && event.target === frame && event.animationName === 'graph-window-out') finishClose(); });
    listen(handle, 'pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button, input, label')) return;
      const rect = frame.getBoundingClientRect(), bounds = overlay.getBoundingClientRect();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        left: rect.left - bounds.left, top: rect.top - bounds.top };
      handle.setPointerCapture(event.pointerId);
    });
    listen(handle, 'pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      frame.style.left = drag.left + event.clientX - drag.x + 'px';
      frame.style.top = drag.top + event.clientY - drag.y + 'px'; keepVisible();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => listen(handle, type, stopDrag));
    listen(global, 'blur', () => stopDrag());
    listen(global, 'resize', keepVisible);
    listen(global, 'pagehide', () => close({ immediate: true, restoreFocus: false }));
    listen(motion, 'change', () => { engine?.setReduceMotion(motion.matches); if (motion.matches && closing) finishClose(); });
    const observer = new ResizeObserver(() => {
      if (!opened || overlay.hidden) return;
      keepVisible(); clearTimeout(resizeTimer); resizeTimer = setTimeout(persist, 200);
    });
    observer.observe(frame);
    return {
      open, close, release,
      hide() { persist(); engine?.setActive(false); overlay.hidden = true; stopDrag(); },
      isOpen: () => opened,
      get engine() { return engine; },
      get canvas() { return canvas(); },
      get reduceMotion() { return motion.matches; },
      destroy() {
        if (destroyed) return;
        close({ immediate: true, restoreFocus: false }); destroyed = true;
        clearTimeout(closeTimer); clearTimeout(resizeTimer); observer.disconnect();
        listeners.splice(0).forEach(remove => remove());
        if (engine) release();
      },
    };
  }
  global.GraphWindow = Object.freeze({ create });
})(window);
