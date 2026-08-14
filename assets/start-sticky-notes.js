// 起步页跨页便签：安全空白处双击创建，单击选中，双击编辑，拖动摆放，Backspace 删除。
// 它只服务当前起步页页面，不进入「速记」页，也不承接连线、叠摞、惯性或缩放。
(function () {
  'use strict';

  const bookView = document.querySelector('.book-view');
  const main = document.querySelector('.start-main');
  const bookStage = document.querySelector('[data-role="book-stage"]');
  const leftSpine = document.querySelector('.left-spine');
  if (!bookView || !main) return;

  const hosts = {
    recent: bookStage,
    study: document.querySelector('[data-role="study-view"]'),
    cadence: document.querySelector('[data-role="cadence-view"]'),
    calendar: document.querySelector('[data-role="calendar-view"]'),
    review: document.querySelector('[data-role="review-view"]'),
    focus: document.querySelector('[data-role="focus-view"]'),
  };
  const scopes = new Set(Object.keys(hosts));
  const stickyPalette = window.RelatumStickyPalette;
  const NOTE_W = 180;
  const NOTE_H = 132;
  const EDGE = 12;
  const DRAG_THRESHOLD = 6;
  const TEXT_MAX = 2000;
  const TOTAL_MAX = 240;
  const SCOPE_MAX = 60;
  const blockedCreateSelector = [
    '.start-page-note',
    'button', 'a[href]', 'input', 'textarea', 'select', 'option', 'label',
    '[contenteditable]:not([contenteditable="false"])', '[data-action]',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="dialog"]',
    '[tabindex]:not([tabindex="-1"])', '[draggable="true"]',
    'canvas', 'svg', 'iframe', 'img', 'video', 'audio',
    '.context-menu', '.start-speed-pop', '.start-notice', '.desktop-settings',
    '.study-dialog', '.focus-daily',
  ].join(',');

  let notes = [];
  let loaded = false;
  let loadPromise = null;
  let loadFailed = false;
  let activeRawView = '';
  let activeScope = '';
  let activeHost = null;
  let layer = null;
  let selectedId = '';
  let selectedEl = null;
  let editingEl = null;
  let editingData = null;
  let editingOriginalText = '';
  let saveTimer = 0;
  let saveChain = Promise.resolve();
  let lastColor = '';
  let lastColorFamily = '';
  let suppressClickUntil = 0;

  function tr(text) {
    return window.RelatumI18n && typeof window.RelatumI18n.t === 'function'
      ? window.RelatumI18n.t(text) : text;
  }

  function noteId() {
    return 'start_note_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function nextColor() {
    if (!stickyPalette) return 'yellow';
    const picked = stickyPalette.pick({
      excludeKey: lastColor,
      excludeFamily: lastColorFamily,
    });
    lastColor = picked.key;
    lastColorFamily = picked.family;
    return picked.key;
  }

  function recolorNote(data, el) {
    const current = stickyPalette && stickyPalette.byKey(data.color);
    const picked = stickyPalette && stickyPalette.pick({
      excludeKey: data.color,
      excludeFamily: current ? current.family : '',
    });
    data.color = picked ? picked.key : 'yellow';
    lastColor = data.color;
    lastColorFamily = picked ? picked.family : '';
    el.dataset.color = data.color;
    scheduleSave();
  }

  function rotateNote(data, el, straighten) {
    const current = Number(data.rotate) || 0;
    let next = 0;
    if (!straighten) {
      next = Math.round((Math.random() * 8 - 4) * 10) / 10;
      if (Math.abs(next - current) < 0.05) next = current >= 0 ? -2.4 : 2.4;
    }
    if (Math.abs(next - current) < 0.05) return;
    data.rotate = next;
    el.style.setProperty('--start-note-rotate', next + 'deg');
    scheduleSave();
  }

  function scopeForView(view) {
    if (view === 'empty') return 'recent';
    return scopes.has(view) ? view : '';
  }

  function hostForView(view) {
    if (view === 'empty') return main;
    const scope = scopeForView(view);
    return scope ? hosts[scope] : null;
  }

  function ensureLayer(host) {
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'start-sticky-layer';
      layer.setAttribute('aria-label', tr('页面便签'));
    }
    if (layer.parentElement !== host) {
      if (host) {
        host.classList.add('start-sticky-host');
        if (window.getComputedStyle(host).position === 'static') {
          host.classList.add('start-sticky-host-static');
        }
        host.appendChild(layer);
      } else {
        layer.remove();
      }
    }
    return layer;
  }

  function syncLayerSize() {
    if (!activeHost || !layer) return;
    layer.style.height = '100%';
    const height = Math.max(activeHost.clientHeight, activeHost.scrollHeight);
    layer.style.height = Math.max(1, height) + 'px';
  }

  function pageBounds() {
    syncLayerSize();
    if (!activeHost) return { minX: EDGE, minY: EDGE, maxX: EDGE, maxY: EDGE };
    const hostRect = activeHost.getBoundingClientRect();
    const width = Math.max(activeHost.clientWidth, hostRect.width);
    const height = Math.max(activeHost.clientHeight, activeHost.scrollHeight);
    let minX = EDGE;
    if (leftSpine && activeRawView !== 'empty') {
      const spineRect = leftSpine.getBoundingClientRect();
      const overlapsVertically = spineRect.bottom > hostRect.top && spineRect.top < hostRect.bottom;
      if (overlapsVertically && spineRect.right > hostRect.left) {
        minX = Math.max(minX, spineRect.right - hostRect.left + activeHost.scrollLeft + EDGE);
      }
    }
    return {
      minX,
      minY: EDGE,
      maxX: Math.max(minX, width - NOTE_W - EDGE),
      maxY: Math.max(EDGE, height - NOTE_H - EDGE),
    };
  }

  function clampToBounds(x, y, bounds) {
    return {
      x: Math.round(Math.max(bounds.minX, Math.min(bounds.maxX, Number(x) || 0))),
      y: Math.round(Math.max(bounds.minY, Math.min(bounds.maxY, Number(y) || 0))),
    };
  }

  function localPoint(clientX, clientY) {
    const rect = activeHost.getBoundingClientRect();
    return {
      x: clientX - rect.left + activeHost.scrollLeft,
      y: clientY - rect.top + activeHost.scrollTop,
    };
  }

  function overlaps(a, b) {
    const dx = Math.max(0, Math.min(a.x + NOTE_W, b.x + NOTE_W) - Math.max(a.x, b.x));
    const dy = Math.max(0, Math.min(a.y + NOTE_H, b.y + NOTE_H) - Math.max(a.y, b.y));
    return dx * dy;
  }

  function uncrowdedPosition(x, y) {
    const bounds = pageBounds();
    const origin = clampToBounds(x, y, bounds);
    const current = notes.filter((note) => note.scope === activeScope);
    if (!current.length) return origin;
    const candidates = [origin];
    [42, 78, 116].forEach((radius) => {
      for (let index = 0; index < 8; index++) {
        const angle = Math.PI * 2 * index / 8;
        candidates.push(clampToBounds(
          origin.x + Math.cos(angle) * radius,
          origin.y + Math.sin(angle) * radius,
          bounds
        ));
      }
    });
    let best = origin;
    let bestScore = Infinity;
    candidates.forEach((candidate) => {
      const cover = current.reduce((sum, note) => sum + overlaps(candidate, note), 0);
      const distance = Math.hypot(candidate.x - origin.x, candidate.y - origin.y);
      const score = cover * 6 + distance;
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    });
    return best;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushSave, 450);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    const body = JSON.stringify({ notes });
    const operation = saveChain.catch(() => undefined).then(() => fetch('/api/start-sticky-notes-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })).then((response) => {
      if (!response.ok) throw new Error('跨页便签保存失败');
      return response;
    });
    saveChain = operation.catch((error) => {
      console.warn(error && error.message ? error.message : error);
    });
    return saveChain;
  }

  function load() {
    if (loaded) return Promise.resolve(true);
    if (loadFailed) return Promise.resolve(false);
    if (loadPromise) return loadPromise;
    loadPromise = fetch('/api/start-sticky-notes')
      .then((response) => {
        if (!response.ok) throw new Error('跨页便签加载失败');
        return response.json();
      })
      .then((payload) => {
        notes = payload && Array.isArray(payload.notes) ? payload.notes : [];
        loaded = true;
        return true;
      })
      .catch((error) => {
        loadFailed = true;
        console.warn(error && error.message ? error.message : error);
        return false;
      })
      .finally(() => { loadPromise = null; });
    return loadPromise;
  }

  function clearSelected() {
    if (selectedEl) {
      selectedEl.classList.remove('is-selected');
      selectedEl.setAttribute('aria-selected', 'false');
    }
    selectedId = '';
    selectedEl = null;
  }

  function selectNote(data, el, focus) {
    if (selectedEl && selectedEl !== el) {
      selectedEl.classList.remove('is-selected');
      selectedEl.setAttribute('aria-selected', 'false');
    }
    selectedId = data.id;
    selectedEl = el;
    el.classList.add('is-selected');
    el.setAttribute('aria-selected', 'true');
    if (focus !== false) {
      try { el.focus({ preventScroll: true }); } catch (error) { el.focus(); }
    }
  }

  function finishEdit() {
    if (!editingEl || !editingData) return;
    const el = editingEl;
    const data = editingData;
    const body = el.querySelector('.start-page-note-body');
    let nextText = body ? (body.textContent || '') : '';
    if (nextText.length > TEXT_MAX) nextText = nextText.slice(0, TEXT_MAX);
    if (body && body.textContent !== nextText) body.textContent = nextText;
    if (body) body.removeAttribute('contenteditable');
    el.classList.remove('is-editing');
    editingEl = null;
    editingData = null;
    if (nextText !== editingOriginalText) {
      data.text = nextText;
      scheduleSave();
    }
    editingOriginalText = '';
  }

  function enterEdit(el, data) {
    if (editingEl === el) return;
    if (editingEl) finishEdit();
    selectNote(data, el, false);
    const body = el.querySelector('.start-page-note-body');
    if (!body) return;
    editingEl = el;
    editingData = data;
    editingOriginalText = data.text || '';
    el.classList.add('is-editing');
    body.setAttribute('contenteditable', 'plaintext-only');
    body.focus();
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(false);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function removeNote(data, el) {
    const index = notes.findIndex((note) => note.id === data.id);
    if (index < 0) return;
    if (editingEl === el) finishEdit();
    notes.splice(index, 1);
    clearSelected();
    el.classList.add('is-leaving');
    const remove = () => { if (el.isConnected) el.remove(); };
    el.addEventListener('animationend', remove, { once: true });
    window.setTimeout(remove, 240);
    scheduleSave();
  }

  function startDrag(event, el, data) {
    if (event.button !== 0) return;
    if (editingEl === el) {
      event.stopPropagation();
      return;
    }
    if (bookView.classList.contains('view-switching')) return;
    if (editingEl) finishEdit();
    event.stopPropagation();
    selectNote(data, el, true);
    const origin = {
      x: Number.parseFloat(el.style.left) || 0,
      y: Number.parseFloat(el.style.top) || 0,
    };
    const startX = event.clientX;
    const startY = event.clientY;
    const dragBounds = pageBounds();
    let dragging = false;
    let frame = 0;
    let latest = event;
    let next = origin;

    const draw = () => {
      frame = 0;
      const dx = latest.clientX - startX;
      const dy = latest.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        el.classList.add('is-dragging');
        try { el.setPointerCapture(event.pointerId); } catch (error) {}
      }
      next = clampToBounds(origin.x + dx, origin.y + dy, dragBounds);
      el.style.setProperty('--start-note-drag-x', (next.x - origin.x) + 'px');
      el.style.setProperty('--start-note-drag-y', (next.y - origin.y) + 'px');
    };

    const onMove = (moveEvent) => {
      latest = moveEvent;
      if (!frame) frame = requestAnimationFrame(draw);
      if (dragging) moveEvent.preventDefault();
    };

    const finish = (upEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      if (frame) {
        cancelAnimationFrame(frame);
        draw();
      }
      try { el.releasePointerCapture(event.pointerId); } catch (error) {}
      if (!dragging) return;
      data.x = next.x;
      data.y = next.y;
      el.style.left = next.x + 'px';
      el.style.top = next.y + 'px';
      el.style.removeProperty('--start-note-drag-x');
      el.style.removeProperty('--start-note-drag-y');
      el.classList.remove('is-dragging');
      suppressClickUntil = performance.now() + 320;
      if (upEvent) {
        upEvent.preventDefault();
        upEvent.stopPropagation();
      }
      scheduleSave();
    };

    const cancel = (cancelEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      if (frame) cancelAnimationFrame(frame);
      try { el.releasePointerCapture(event.pointerId); } catch (error) {}
      el.style.removeProperty('--start-note-drag-x');
      el.style.removeProperty('--start-note-drag-y');
      el.classList.remove('is-dragging');
      if (cancelEvent) cancelEvent.stopPropagation();
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  }

  function buildNote(data, entering, bounds) {
    const position = clampToBounds(data.x, data.y, bounds || pageBounds());
    const el = document.createElement('div');
    el.className = 'start-page-note' + (entering ? ' is-entering' : '');
    el.dataset.id = data.id;
    el.dataset.color = data.color || 'yellow';
    el.tabIndex = 0;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', tr('页面便签'));
    el.setAttribute('aria-selected', 'false');
    el.style.left = position.x + 'px';
    el.style.top = position.y + 'px';
    el.style.setProperty('--start-note-rotate', (Number(data.rotate) || 0) + 'deg');

    const body = document.createElement('div');
    body.className = 'start-page-note-body';
    body.setAttribute('data-user-content', '');
    body.textContent = data.text || '';
    el.appendChild(body);

    el.addEventListener('pointerdown', (event) => startDrag(event, el, data));
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      if (performance.now() < suppressClickUntil) {
        event.preventDefault();
        return;
      }
      selectNote(data, el, true);
    });
    el.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      if (editingEl === el) return;
      event.preventDefault();
      enterEdit(el, data);
    });
    el.addEventListener('keydown', (event) => {
      if (editingEl === el) return;
      if (event.key === 'Backspace' && selectedId === data.id) {
        event.preventDefault();
        event.stopPropagation();
        removeNote(data, el);
      } else if ((event.key === 'Enter' || event.key === 'F2') && selectedId === data.id) {
        event.preventDefault();
        event.stopPropagation();
        enterEdit(el, data);
      } else if (event.key.toLowerCase() === 'c' && selectedId === data.id
        && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        recolorNote(data, el);
      } else if (event.key.toLowerCase() === 'r' && selectedId === data.id
        && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        rotateNote(data, el, event.shiftKey);
      } else if (event.key === 'Escape' && selectedId === data.id) {
        event.preventDefault();
        event.stopPropagation();
        clearSelected();
      }
    });
    body.addEventListener('keydown', (event) => {
      if (editingEl !== el) return;
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        body.blur();
        requestAnimationFrame(() => {
          if (el.isConnected && selectedId === data.id) selectNote(data, el, true);
        });
      }
    });
    body.addEventListener('blur', () => {
      if (editingEl === el) finishEdit();
    });
    if (entering) {
      el.addEventListener('animationend', () => el.classList.remove('is-entering'), { once: true });
      window.setTimeout(() => el.classList.remove('is-entering'), 320);
    }
    return el;
  }

  function render() {
    if (!loaded || !activeScope || !activeHost) return;
    const targetLayer = ensureLayer(activeHost);
    clearSelected();
    targetLayer.replaceChildren();
    syncLayerSize();
    const bounds = pageBounds();
    notes.forEach((data) => {
      if (data.scope === activeScope) targetLayer.appendChild(buildNote(data, false, bounds));
    });
  }

  function createAt(clientX, clientY) {
    if (!loaded || !activeScope || !activeHost || !layer) return;
    const scopedCount = notes.reduce((count, note) => count + (note.scope === activeScope ? 1 : 0), 0);
    if (notes.length >= TOTAL_MAX || scopedCount >= SCOPE_MAX) return;
    const point = localPoint(clientX, clientY);
    const position = uncrowdedPosition(point.x - NOTE_W / 2, point.y - NOTE_H / 2);
    const data = {
      id: noteId(),
      scope: activeScope,
      x: position.x,
      y: position.y,
      color: nextColor(),
      text: '',
      rotate: Math.round((Math.random() * 6 - 3) * 10) / 10,
      createdAt: new Date().toISOString(),
    };
    notes.push(data);
    const el = buildNote(data, true, pageBounds());
    layer.appendChild(el);
    scheduleSave();
    requestAnimationFrame(() => {
      if (el.isConnected && data.scope === activeScope) enterEdit(el, data);
    });
  }

  function safeCreateTarget(event) {
    if (!activeScope || !activeHost || bookView.classList.contains('view-switching')) return false;
    // 学习页暂不需要双击创建便签
    if (activeScope === 'study') return false;
    const target = event.target;
    if (!(target instanceof Element) || !activeHost.contains(target)) return false;
    if (target.closest(blockedCreateSelector)) return false;
    return true;
  }

  function clearNativeSelection() {
    try {
      const selection = window.getSelection && window.getSelection();
      if (selection) selection.removeAllRanges();
    } catch (error) {}
  }

  function activateView(view) {
    if (editingEl) finishEdit();
    clearSelected();
    activeRawView = view || '';
    activeScope = scopeForView(activeRawView);
    activeHost = hostForView(activeRawView);
    if (!activeScope || !activeHost) {
      ensureLayer(null);
      return;
    }
    ensureLayer(activeHost);
    syncLayerSize();
    if (loaded) render();
    else {
      const scope = activeScope;
      const host = activeHost;
      load().then((ok) => {
        if (ok && activeScope === scope && activeHost === host) render();
      });
    }
  }

  document.addEventListener('dblclick', (event) => {
    if (event.button !== 0 || event.defaultPrevented || !safeCreateTarget(event)) return;
    event.preventDefault();
    event.stopPropagation();
    clearNativeSelection();
    const clientX = event.clientX;
    const clientY = event.clientY;
    const scope = activeScope;
    const host = activeHost;
    load().then((ok) => {
      if (ok && scope === activeScope && host === activeHost) createAt(clientX, clientY);
    });
  });

  document.addEventListener('pointerdown', (event) => {
    const note = event.target && event.target.closest && event.target.closest('.start-page-note');
    if (note) return;
    if (editingEl) finishEdit();
    clearSelected();
  }, true);

  document.addEventListener('selectstart', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
    event.preventDefault();
  });

  document.addEventListener('start:viewchange', (event) => {
    activateView(event.detail && event.detail.current ? event.detail.current : '');
  });

  if (window.RelatumI18n && typeof window.RelatumI18n.onChange === 'function') {
    window.RelatumI18n.onChange(() => {
      if (layer) layer.setAttribute('aria-label', tr('页面便签'));
      if (layer) layer.querySelectorAll('.start-page-note').forEach((el) => {
        el.setAttribute('aria-label', tr('页面便签'));
      });
    });
  }

  window.addEventListener('resize', () => {
    if (!activeScope || !loaded) return;
    syncLayerSize();
    if (!editingEl) render();
  });

  window.addEventListener('pagehide', () => {
    if (editingEl) finishEdit();
    if (saveTimer) flushSave();
  });

  const initialView = bookView.dataset.viewName || main.dataset.state || '';
  activateView(initialView);
})();
