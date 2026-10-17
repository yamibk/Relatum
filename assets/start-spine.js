// Fixed-size navigation carrier. Its clipped glyph track moves by the exact
// opposite transform, so a glyph changes ink only where the carrier covers it.
(function () {
  'use strict';

  const COLORS = {
    review: ['#d8796d', 'rgba(216,121,109,.3)'],
    calendar: ['#b6814d', 'rgba(182,129,77,.3)'],
    notes: ['#c4a143', 'rgba(196,161,67,.3)'],
    cadence: ['#6f987a', 'rgba(111,152,122,.3)'],
    tree: ['#4f8b76', 'rgba(79,139,118,.3)'],
    study: ['#8b74ad', 'rgba(139,116,173,.3)'],
    focus: ['#87915b', 'rgba(135,145,91,.3)'],
    recent: ['#847a71', 'rgba(132,122,113,.3)'],
    favorite: ['#d28b55', 'rgba(210,139,85,.3)'],
    inbox: ['#76858a', 'rgba(118,133,138,.3)']
  };
  const GROUP_COLORS = [
    ['#9f7188', 'rgba(159,113,136,.3)'], ['#a36f5d', 'rgba(163,111,93,.3)'],
    ['#7d8f68', 'rgba(125,143,104,.3)'], ['#9a805d', 'rgba(154,128,93,.3)'],
    ['#806f91', 'rgba(128,111,145,.3)']
  ];

  function kind(target) {
    for (const name of ['review', 'calendar', 'notes', 'cadence', 'focus']) {
      if (target.classList.contains(name + '-spine-tab')) return name;
    }
    if (target.classList.contains('tree-page-spine-tab')) return 'tree';
    if (target.classList.contains('study-spine-tab')) return 'study';
    if (target.dataset.groupId === '__favorites__') return 'favorite';
    if (target.dataset.groupId === '__inbox__') return 'inbox';
    return target.dataset.groupId ? 'group' : 'recent';
  }

  function create(options) {
    const { spine, bookView } = options;
    if (!spine || !bookView) return null;
    const orb = spine.querySelector('[data-role="spine-active-orb"]');
    const hover = spine.querySelector('[data-role="spine-hover-orb"]');
    const rail = spine.querySelector('[data-role="spine-hover-rail"]');
    if (!orb || !hover || !rail) return null;
    const shadows = ['tab', 'dot'].map(name => {
      const shadow = document.createElement('span');
      shadow.className = 'spine-orb-shadow spine-orb-shadow-' + name;
      shadow.setAttribute('aria-hidden', 'true');
      return shadow;
    });
    const surface = document.createElement('span');
    surface.className = 'spine-orb-surface';
    const clip = document.createElement('span');
    clip.className = 'spine-glyph-clip';
    clip.setAttribute('aria-hidden', 'true');
    const track = document.createElement('span');
    track.className = 'spine-glyph-track';
    clip.append(track);
    orb.replaceChildren(...shadows, surface, clip);
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const listeners = [];
    const bindings = new Map();
    const glyphs = new Map();
    const styles = new WeakMap();
    let frame = 0, restoreFrame = 0, breatheTimer = 0;
    let dirty = true, instant = true, ready = false, destroyed = false, pageHidden = false;
    let preview = null, bubbleTarget = null, currentTarget = null;
    let boxes = new Map();
    let bounds = { left: 0, right: 0, scrollable: false };
    let layout = null;

    function listen(element, name, callback, opts) {
      element.addEventListener(name, callback, opts);
      listeners.push(() => element.removeEventListener(name, callback, opts));
    }
    function toggle(element, name, enabled) {
      if (element.classList.contains(name) !== enabled) element.classList.toggle(name, enabled);
    }
    function style(element, name, value) {
      let values = styles.get(element);
      if (!values) { values = new Map(); styles.set(element, values); }
      if (values.get(name) === value) return;
      values.set(name, value);
      element.style.setProperty(name, value);
    }
    function visible() {
      return !destroyed && !pageHidden && !document.hidden && !bookView.hidden
        && document.documentElement.dataset.desktopMinimized !== '1'
        && (!options.visible || options.visible());
    }
    function stopBreathe() {
      if (breatheTimer) clearTimeout(breatheTimer);
      breatheTimer = 0;
      toggle(orb, 'orb-breathing', false);
    }
    function suspend() {
      if (frame) cancelAnimationFrame(frame);
      if (restoreFrame) cancelAnimationFrame(restoreFrame);
      frame = restoreFrame = 0;
      stopBreathe();
      preview = bubbleTarget = null;
      instant = dirty = true;
      ready = false;
      toggle(spine, 'spine-motion-suspended', true);
      toggle(spine, 'spine-hovering', false);
      toggle(spine, 'spine-marker-previewing', false);
    }
    function sync(config) {
      if (destroyed) return;
      if (config && config.animate === false) instant = true;
      if (!visible()) { suspend(); return; }
      if (!frame) frame = requestAnimationFrame(render);
    }
    function invalidate(config) { dirty = true; sync(config); }
    function color(target) {
      const targetKind = kind(target);
      if (targetKind !== 'group') return COLORS[targetKind];
      const id = target.dataset.groupId || '';
      let index = options.getGroupIndex ? options.getGroupIndex(id) : -1;
      if (!(index >= 0)) {
        index = 0;
        for (let i = 0; i < id.length; i++) index = ((index * 31) + id.charCodeAt(i)) >>> 0;
      }
      return GROUP_COLORS[index % GROUP_COLORS.length];
    }
    function sanitize(element) {
      for (const attr of Array.from(element.attributes)) {
        if (attr.name === 'id' || attr.name.startsWith('data-') || attr.name.startsWith('on')
          || attr.name === 'tabindex' || attr.name === 'role' || attr.name.startsWith('aria-')) {
          element.removeAttribute(attr.name);
        }
      }
      for (const child of element.children) sanitize(child);
    }
    function measure() {
      const rect = spine.getBoundingClientRect();
      const scrollTop = spine.scrollTop;
      const height = spine.clientHeight;
      const nextBoxes = new Map();
      const glyphReads = [];
      spine.querySelectorAll('.study-spine-tab, .page-dot').forEach(target => {
        const box = target.getBoundingClientRect();
        if (!box.width || !box.height) return;
        nextBoxes.set(target, {
          x: box.left - rect.left, y: box.top - rect.top + scrollTop,
          width: box.width, height: box.height, right: box.right, top: box.top
        });
        if (!target.classList.contains('study-spine-tab')) return;
        const glyph = target.querySelector(':scope > span:not(.dot-bubble)');
        if (!glyph) return;
        const computed = getComputedStyle(glyph);
        glyphReads.push({ target, glyph, font: {
          'font-family': computed.fontFamily, 'font-size': computed.fontSize,
          'font-weight': computed.fontWeight, 'line-height': computed.lineHeight,
          'letter-spacing': computed.letterSpacing
        }});
      });
      boxes = nextBoxes;
      layout = { scrollTop, height };
      bounds = { left: rect.left, right: rect.right, scrollable: spine.scrollHeight > height + 2 };
      // All geometry/style reads finish before the replica DOM is updated.
      const present = new Set();
      for (const { target, glyph, font } of glyphReads) {
        present.add(target);
        let replica = glyphs.get(target);
        const source = glyph.outerHTML;
        if (!replica) {
          const slot = document.createElement('span');
          slot.className = 'spine-glyph-slot';
          replica = { slot, source: '', glyph: null };
          glyphs.set(target, replica);
          track.append(slot);
        }
        if (replica.source !== source) {
          const copy = glyph.cloneNode(true);
          sanitize(copy);
          copy.className = 'spine-copy-' + kind(target);
          replica.slot.replaceChildren(copy);
          replica.glyph = copy;
          replica.source = source;
        }
        for (const name of Object.keys(font)) style(replica.glyph, name, font[name]);
        const box = boxes.get(target);
        style(replica.slot, 'left', box.x + 'px');
        style(replica.slot, 'top', box.y + 'px');
        style(replica.slot, 'width', box.width + 'px');
        style(replica.slot, 'height', box.height + 'px');
        replica.slot.hidden = box.y + box.height < scrollTop - 48 || box.y > scrollTop + height + 48;
      }
      for (const [target, replica] of glyphs) {
        if (!present.has(target)) { replica.slot.remove(); glyphs.delete(target); }
      }
      dirty = false;
    }
    function shape(target) {
      return target.classList.contains('study-spine-tab') ? 'tab'
        : target.dataset.groupId === '__favorites__' ? 'star' : 'dot';
    }
    function render() {
      frame = 0;
      if (!visible()) { suspend(); return; }
      if (dirty || !layout) measure();
      const active = options.getTarget();
      const activeBox = boxes.get(active);
      if (!activeBox) {
        toggle(orb, 'show', false);
        toggle(spine, 'spine-marker-visible', false);
        return;
      }
      if (!boxes.has(preview)) preview = null;
      if (!boxes.has(bubbleTarget)) bubbleTarget = null;
      const marker = preview || active;
      const markerBox = boxes.get(marker);
      const noMotion = instant || !ready || media.matches;
      instant = false;
      if (restoreFrame) cancelAnimationFrame(restoreFrame);
      restoreFrame = 0;
      toggle(spine, 'spine-marker-no-transition', noMotion);
      toggle(spine, 'spine-motion-suspended', false);
      const x = activeBox.x + (activeBox.width - 38) / 2;
      const y = activeBox.y + (activeBox.height - 38) / 2;
      const activeShape = shape(active);
      if (orb.dataset.shape !== activeShape) orb.dataset.shape = activeShape;
      style(orb, 'transform', 'translate3d(' + x + 'px,' + y + 'px,0)');
      style(track, 'transform', 'translate3d(' + (-x) + 'px,' + (-y) + 'px,0)');
      const hoverShape = shape(marker);
      if (hover.dataset.shape !== hoverShape) hover.dataset.shape = hoverShape;
      style(hover, 'transform', 'translate3d(' + (markerBox.x + (markerBox.width - 38) / 2)
        + 'px,' + (markerBox.y + (markerBox.height - 38) / 2) + 'px,0)');
      style(rail, 'transform', 'translate3d(0,' + (markerBox.y + markerBox.height / 2 - 9) + 'px,0)');
      const palette = color(marker);
      style(spine, '--spine-hover-color', palette[0]);
      style(spine, '--spine-hover-glow', palette[1]);
      const bubble = bubbleTarget && bubbleTarget.querySelector('.dot-bubble');
      if (bubble) {
        const box = boxes.get(bubbleTarget);
        style(bubble, 'left', Math.round(box.right + 8) + 'px');
        style(bubble, 'top', Math.round(box.top + box.height / 2) + 'px');
      }
      toggle(orb, 'show', true);
      toggle(spine, 'spine-marker-visible', true);
      toggle(spine, 'spine-hovering', !!preview);
      toggle(spine, 'spine-marker-previewing', !!preview);
      toggle(spine, 'spine-hover-current', marker === active);
      toggle(spine, 'spine-marker-resting', !preview);
      if (active !== currentTarget) {
        currentTarget = active;
        stopBreathe();
        if (!media.matches) breatheTimer = setTimeout(() => {
          breatheTimer = 0;
          if (visible() && !preview && options.getTarget() === active) toggle(orb, 'orb-breathing', true);
        }, 2800);
      }
      ready = true;
      if (noMotion && !media.matches) restoreFrame = requestAnimationFrame(() => {
        restoreFrame = 0;
        if (visible()) toggle(spine, 'spine-marker-no-transition', false);
      });
    }
    function clearHover(config) { preview = bubbleTarget = null; sync(config); }
    function bindTarget(target) {
      if (!target || bindings.has(target)) return;
      const enter = () => {
        bubbleTarget = target;
        if (!target.classList.contains('dot-add')) preview = target;
        stopBreathe();
        sync();
      };
      target.addEventListener('pointerenter', enter);
      target.addEventListener('focus', enter);
      bindings.set(target, () => {
        target.removeEventListener('pointerenter', enter);
        target.removeEventListener('focus', enter);
      });
    }
    spine.querySelectorAll('.study-spine-tab, .page-dot').forEach(bindTarget);
    listen(spine, 'pointerleave', () => clearHover());
    listen(spine, 'focusout', event => { if (!spine.contains(event.relatedTarget)) clearHover(); });
    listen(spine, 'scroll', () => { preview = bubbleTarget = null; invalidate({ animate: false }); }, { passive: true });
    listen(orb, 'animationend', event => {
      if (event.animationName === 'spine-orb-breathe') toggle(orb, 'orb-breathing', false);
    });
    const visibility = () => { if (visible()) invalidate({ animate: false }); else suspend(); };
    listen(window, 'resize', () => invalidate({ animate: false }));
    listen(document, 'relatum:start-workspacechange', visibility);
    listen(document, 'visibilitychange', visibility);
    listen(window, 'canvasdesktop:visibility', visibility);
    listen(window, 'pagehide', () => { pageHidden = true; suspend(); });
    listen(window, 'pageshow', () => { pageHidden = false; visibility(); });
    listen(media, 'change', () => { stopBreathe(); visibility(); });
    if (document.fonts) listen(document.fonts, 'loadingdone', () => invalidate({ animate: false }));
    // Page chrome can change the host height by 1px during navigation. Refresh
    // the geometry without cancelling its in-flight carrier/glyph transitions.
    // Explicit viewport, scroll and visibility handlers still snap calibration.
    const resize = new ResizeObserver(() => invalidate());
    resize.observe(spine);
    resize.observe(bookView);
    const mutation = new MutationObserver(records => {
      if (records.some(record => {
        const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        return element && !element.closest('.spine-active-orb, .spine-hover-orb, .spine-hover-rail')
          && (record.type !== 'attributes' || element === document.documentElement || element === document.body);
      })) invalidate({ animate: false });
      for (const [target, remove] of bindings) {
        if (!spine.contains(target)) { remove(); bindings.delete(target); }
      }
    });
    mutation.observe(spine, { subtree: true, childList: true, characterData: true });
    mutation.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    mutation.observe(document.body, { attributes: true, attributeFilter: ['data-hide-special', 'data-start-theme'] });
    sync({ animate: false });
    return {
      sync, invalidate, clearHover, bindTarget, getBounds: () => bounds, suspend,
      destroy() {
        if (destroyed) return;
        suspend();
        destroyed = true;
        resize.disconnect();
        mutation.disconnect();
        for (const remove of listeners) remove();
        for (const remove of bindings.values()) remove();
        bindings.clear();
        glyphs.clear();
        boxes.clear();
        orb.replaceChildren();
      }
    };
  }

  window.RelatumStartSpine = Object.freeze({ create });
})();
