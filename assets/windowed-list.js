(function (root) {
  'use strict';
  // Variable-height, keyed rows with one viewport of overscan on either side.
  // Focused editors stay mounted independently of the visible range.
  function create(options) {
    const host = options.host, scroller = options.scroller || host;
    const gap = options.gap || 0, estimate = options.estimate || 80;
    let items = [], prefix = [0], keyIndex = new Map(), heights = new Map();
    let mounted = new Map(), frame = 0, disposed = false, active = true;
    const originalGap = host.style.gap;
    const originalAnchor = host.style.overflowAnchor;
    host.style.gap = '0px';
    host.style.overflowAnchor = 'none';
    host.classList.add('is-windowed-list');
    function rebuildOffsets() {
      prefix = [0];
      items.forEach(function (item, i) { prefix.push(prefix[i] + (heights.get(options.key(item)) || estimate) + gap); });
    }
    function lowerBound(value) {
      let lo = 0, hi = items.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (prefix[mid + 1] <= value) lo = mid + 1; else hi = mid; }
      return lo;
    }
    function metrics() {
      const rect = host.getBoundingClientRect(), outer = scroller.getBoundingClientRect();
      const offset = host === scroller ? 0 : rect.top - outer.top + scroller.scrollTop;
      return { top: Math.max(0, scroller.scrollTop - offset), height: scroller.clientHeight || 600, offset: offset };
    }
    function schedule() { if (!frame && active && !disposed) frame = requestAnimationFrame(render); }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(function (entries) {
      if (disposed) return;
      const view = metrics(), anchor = lowerBound(view.top), within = view.top - prefix[anchor];
      let changed = false;
      entries.forEach(function (entry) {
        const row = entry.target, key = row.__windowedKey;
        if (mounted.get(key) !== row) return;
        const size = entry.borderBoxSize && entry.borderBoxSize[0];
        const height = size ? size.blockSize : row.getBoundingClientRect().height;
        if (height > 0 && Math.abs((heights.get(key) || estimate) - height) > .5) { heights.set(key, height); changed = true; }
      });
      if (changed) {
        rebuildOffsets();
        scroller.scrollTop = view.offset + prefix[anchor] + within;
        schedule();
      }
    }) : null;
    function spacer(height) {
      const el = document.createElement(host.tagName === 'UL' || host.tagName === 'OL' ? 'li' : 'div');
      el.className = 'windowed-list-spacer';
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'height:' + Math.max(0, height) + 'px;min-height:0;flex-shrink:0;pointer-events:none;list-style:none';
      return el;
    }
    function render() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!active || disposed) return;
      const view = metrics();
      const first = lowerBound(Math.max(0, view.top - view.height));
      const last = Math.min(items.length, lowerBound(view.top + view.height * 2) + 1);
      const wanted = new Set();
      for (let i = first; i < last; i++) wanted.add(i);
      mounted.forEach(function (row, key) {
        if (row.contains(document.activeElement) || (options.pin && options.pin(row, key))) {
          const index = keyIndex.get(key);
          if (index !== undefined) wanted.add(index);
        }
      });
      const next = new Map(), children = [];
      let cursor = 0;
      Array.from(wanted).sort(function (a, b) { return a - b; }).forEach(function (index) {
        if (index > cursor) children.push(spacer(prefix[index] - prefix[cursor]));
        const item = items[index], key = options.key(item);
        let row = mounted.get(key);
        if (!row) { row = options.render(item, index); row.__windowedKey = key; row.style.marginBottom = gap + 'px'; if (observer) observer.observe(row); }
        if (options.update) options.update(row, item, index);
        row.setAttribute('aria-posinset', String(index + 1)); row.setAttribute('aria-setsize', String(items.length));
        next.set(key, row); children.push(row); cursor = index + 1;
      });
      if (cursor < items.length) children.push(spacer(prefix[items.length] - prefix[cursor]));
      mounted.forEach(function (row, key) { if (!next.has(key) && observer) observer.unobserve(row); });
      // Move focused rows without detaching them (IME composition and selection survive).
      const focused = document.activeElement;
      const kept = new Set(children);
      Array.from(host.children).forEach(function (child) {
        if (!kept.has(child)) child.remove();
      });
      const focusIndex = children.findIndex(function (child) { return child.contains(focused); });
      if (!host.moveBefore && focusIndex >= 0) {
        // Older WebView2: reorder around the focused row, never reinsert its editor.
        let anchor = null;
        for (let i = children.length - 1; i > focusIndex; i--) {
          const child = children[i];
          if (child.parentNode !== host || child.nextSibling !== anchor) host.insertBefore(child, anchor);
          anchor = child;
        }
        anchor = children[focusIndex];
        for (let i = focusIndex - 1; i >= 0; i--) {
          const child = children[i];
          if (child.parentNode !== host || child.nextSibling !== anchor) host.insertBefore(child, anchor);
          anchor = child;
        }
      } else {
        let nextChild = host.firstChild;
        children.forEach(function (child) {
          if (child === nextChild) nextChild = nextChild.nextSibling;
          else if (host.moveBefore && child.parentNode === host) host.moveBefore(child, nextChild);
          else host.insertBefore(child, nextChild);
        });
      }
      mounted = next;
      if (focused && focused !== document.activeElement && focused.isConnected && !focused.isContentEditable && focused.tagName !== 'INPUT' && focused.tagName !== 'TEXTAREA') focused.focus({ preventScroll: true });
      if (options.onMount) options.onMount();
    }
    function setItems(nextItems, renderer) {
      if (renderer) options.render = renderer;
      const oldKeys = new Set(nextItems.map(options.key));
      mounted.forEach(function (row, key) {
        if (!oldKeys.has(key) || !row.contains(document.activeElement)) { if (observer) observer.unobserve(row); row.remove(); mounted.delete(key); }
      });
      items = nextItems; keyIndex = new Map(items.map(function (item, i) { return [options.key(item), i]; }));
      heights.forEach(function (_, key) { if (!oldKeys.has(key)) heights.delete(key); });
      rebuildOffsets(); render();
    }
    function scrollToKey(key) {
      const index = keyIndex.get(key);
      if (index === undefined) return null;
      const view = metrics(), top = prefix[index], bottom = prefix[index + 1];
      if (top < view.top) scroller.scrollTop = view.offset + top;
      else if (bottom > view.top + view.height) scroller.scrollTop = view.offset + bottom - view.height;
      render(); return mounted.get(key) || null;
    }
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    host.addEventListener('focusout', schedule);
    const visibility = typeof IntersectionObserver === 'function' ? new IntersectionObserver(function (entries) {
      if (entries.some(function (entry) { return entry.isIntersecting; })) schedule();
    }) : null;
    if (visibility) visibility.observe(host);
    return { setItems: setItems, scrollToKey: scrollToKey, row: function (key) { return mounted.get(key); },
      refresh: schedule, suspend: function () { active = false; if (frame) cancelAnimationFrame(frame); frame = 0; },
      resume: function () { active = true; schedule(); },
      dispose: function () {
        disposed = true; if (frame) cancelAnimationFrame(frame); if (observer) observer.disconnect(); if (visibility) visibility.disconnect();
        scroller.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); host.removeEventListener('focusout', schedule);
        host.style.gap = originalGap; host.style.overflowAnchor = originalAnchor; host.classList.remove('is-windowed-list'); mounted.clear();
      } };
  }
  root.RelatumWindowedList = { create: create };
})(window);
