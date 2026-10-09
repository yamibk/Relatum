// Instance-scoped port of canvas.js interaction/rendering optimizations.
// Camera easing, 4px drag threshold, latest-event rAF paint and release-before-
// history mirror the main editor. No panel, file API or global CanvasModule.
(function () {
  'use strict';
  const G = window.RelatumNoteCanvasGeometry, SVG = 'http://www.w3.org/2000/svg';
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const id = () => 'nc-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  function create(opts) {
    const { host, session, readOnly } = opts;
    const viewport = document.createElement('div'); viewport.className = 'note-canvas-viewport'; viewport.tabIndex = 0;
    viewport.setAttribute('role', 'group'); viewport.setAttribute('aria-label', document.documentElement.lang === 'en' ? 'Embedded canvas' : '内嵌画布');
    const canvas = document.createElement('canvas'); canvas.className = 'note-canvas-edges';
    const live = document.createElementNS(SVG, 'svg'); live.classList.add('note-canvas-live');
    const world = document.createElement('div'); world.className = 'note-canvas-world';
    viewport.append(canvas, live, world); host.appendChild(viewport);
    const context = canvas.getContext('2d'), hitContext = document.createElement('canvas').getContext('2d');
    const geometryHit = typeof Path2D === 'function' && !!hitContext?.isPointInStroke;
    const nodes = new Map(), rects = new Map(), edgeCache = new Map(), grid = new G.SpatialGrid();
    const labels = new Map(), svgEdges = new Map(), dirtyEdges = new Set();
    let selectedNodes = new Set(), selectedEdges = new Set(), active = false, destroyed = false;
    let raf = 0, cameraRaf = 0, inertiaRaf = 0, gesture = null, pendingPointer = null, space = false;
    let draft = null, width = 0, height = 0, factor = 1, frameRect = null, geometryBuilds = 0;
    let staticDirty = true, painting = false, staticDraws = 0, previewPath = null;
    let camera = Object.assign({ scale: 1, cx: 0, cy: 0 }, opts.viewport || {}), target = Object.assign({}, camera);
    camera = { scale: Number.isFinite(camera.scale) ? clamp(camera.scale, .25, 4) : 1,
      cx: Number.isFinite(camera.cx) ? camera.cx : 0, cy: Number.isFinite(camera.cy) ? camera.cy : 0 }; target = Object.assign({}, camera);
    const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    const disposers = [];
    const engine = { activate, suspend, destroy, refreshSize, whenInputSettled, stats };
    function listen(el, type, fn, options) { el.addEventListener(type, fn, options); disposers.push(() => el.removeEventListener(type, fn, options)); }
    function locked() { return !!(session.owner && session.owner !== engine); }
    function nodeRect(node) { const size = rects.get(node.id); return { x: node.x, y: node.y, w: size?.w || node.width || 160, h: size?.h || node.height || 48, r: 8 }; }
    function worldPoint(event) {
      frameRect = viewport.getBoundingClientRect();
      return { x: camera.cx + (event.clientX - frameRect.left - width / 2) / (camera.scale * factor),
        y: camera.cy + (event.clientY - frameRect.top - height / 2) / (camera.scale * factor) };
    }
    function related(ids) { const edges = new Set(); ids.forEach(key => session.adjacent.get(key)?.forEach(edge => edges.add(edge))); return edges; }
    function invalidate(ids) { for (const key of ids) dirtyEdges.add(key); }
    function schedule(redraw = true) { if (redraw) staticDirty = true; if (!destroyed && !raf && !painting) raf = requestAnimationFrame(paint); }
    function nodeAt(event) {
      const direct = event.target.closest?.('[data-canvas-node]');
      const hit = direct || document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-canvas-node]');
      return hit && viewport.contains(hit) ? hit.dataset.canvasNode : '';
    }
    function selection(nextNodes, nextEdges) {
      selectedNodes.forEach(key => { if (!nextNodes.has(key)) nodes.get(key)?.classList.remove('is-selected'); });
      nextNodes.forEach(key => { if (!selectedNodes.has(key)) nodes.get(key)?.classList.add('is-selected'); });
      selectedEdges.forEach(key => { if (!nextEdges.has(key)) labels.get(key)?.classList.remove('is-selected'); });
      nextEdges.forEach(key => { if (!selectedEdges.has(key)) labels.get(key)?.classList.add('is-selected'); });
      const changed = selectedEdges.size !== nextEdges.size || [...selectedEdges].some(key => !nextEdges.has(key));
      selectedNodes = nextNodes; selectedEdges = nextEdges; if (changed) schedule();
    }
    function measure(keys) {
      let changed = false;
      keys.forEach(key => {
        const el = nodes.get(key), node = session.nodes.get(key); if (!el || !node) return;
        const next = { w: el.offsetWidth, h: el.offsetHeight }, previous = rects.get(key);
        if (!previous || previous.w !== next.w || previous.h !== next.h) { changed = true; rects.set(key, next); invalidate(related([key])); }
      });
      return changed;
    }
    const resize = new ResizeObserver(entries => {
      if (destroyed) return;
      const ids = []; let size = false;
      entries.forEach(entry => { if (entry.target === viewport) size = true; else ids.push(entry.target.dataset.canvasNode); });
      if (size) refreshSize();
      if (ids.length && measure(ids)) schedule();
    });
    resize.observe(viewport);
    function sync(change) {
      if (destroyed) return;
      if (change.renamed) return;
      const ids = change.all ? session.data.nodes.map(n => n.id) : change.nodes || [];
      if (change.all) {
        nodes.forEach((el, key) => { if (!session.nodes.has(key)) { resize.unobserve(el); el.remove(); nodes.delete(key); rects.delete(key); } });
        edgeCache.forEach((_, key) => { if (!session.edges.has(key)) { edgeCache.delete(key); grid.remove(key); labels.get(key)?.remove(); labels.delete(key); svgEdges.get(key)?.remove(); svgEdges.delete(key); } });
        selectedNodes = new Set([...selectedNodes].filter(key => session.nodes.has(key)));
        selectedEdges = new Set([...selectedEdges].filter(key => session.edges.has(key)));
      }
      const fragment = document.createDocumentFragment();
      ids.forEach(key => {
        const node = session.nodes.get(key); if (!node) return;
        let el = nodes.get(key);
        if (!el) {
          el = document.createElement('div'); el.className = 'note-canvas-node'; el.dataset.canvasNode = key;
          const text = document.createElement('div'); text.className = 'note-canvas-text'; el.appendChild(text);
          nodes.set(key, el); fragment.appendChild(el); resize.observe(el);
          if (selectedNodes.has(key)) el.classList.add('is-selected');
        }
        const style = (name, value) => { if (el.style[name] !== value) el.style[name] = value; };
        style('left', node.x + 'px'); style('top', node.y + 'px');
        if (change.positionOnly) return;
        style('width', (node.width || 160) + 'px'); style('minHeight', (node.height || 48) + 'px');
        if (!draft || draft.node !== key) {
          const text = el.querySelector('.note-canvas-text'); if (text.textContent !== node.text) text.textContent = node.text || '';
        }
      });
      if (fragment.childNodes.length) world.appendChild(fragment);
      const measured = !change.positionOnly && ids.length ? measure(ids) : false;
      if (change.all) invalidate(session.edges.keys());
      else if (change.positionOnly) invalidate(gesture?.kind === 'nodes' && gesture.moved ? gesture.edges : related(ids));
      if (change.edges) change.edges.forEach(key => { const cached = edgeCache.get(key); if (cached && !change.structure) renderLabel(cached); else dirtyEdges.add(key); });
      const lockValue = locked() ? 'true' : 'false';
      if (viewport.dataset.locked !== lockValue) viewport.dataset.locked = lockValue;
      if (change.all || change.structure || ids.length || change.edges?.length) {
        const moving = change.positionOnly && gesture?.kind === 'nodes' && gesture.moved;
        schedule(!moving && !!(change.all || change.structure || change.positionOnly || measured));
      }
    }
    function renderLabel(item) {
      const key = item.edge.id; let label = labels.get(key);
      if (item.edge.text) {
        if (!label) { label = document.createElement('div'); label.className = 'note-canvas-edge-label'; label.dataset.canvasEdge = key; world.appendChild(label); labels.set(key, label); }
        if (!draft || draft.edge !== key) { if (label.textContent !== item.edge.text) label.textContent = item.edge.text; }
        label.style.left = item.midpoint.x + 'px'; label.style.top = item.midpoint.y + 'px';
        label.classList.toggle('is-selected', selectedEdges.has(key));
      } else if (label && (!draft || draft.edge !== key)) { label.remove(); labels.delete(key); }
    }
    function buildEdges() {
      dirtyEdges.forEach(key => {
        const entry = session.edges.get(key); if (!entry) return;
        const source = session.nodes.get(entry.edge.from), targetNode = session.nodes.get(entry.edge.to); if (!source || !targetNode) return;
        const item = Object.assign(G.build(entry.edge, nodeRect(source), nodeRect(targetNode)), { edge: entry.edge, order: entry.order });
        geometryBuilds++; edgeCache.set(key, item); grid.insert(key, item.bounds);
        renderLabel(item);
      });
      dirtyEdges.clear();
    }
    function svgEdge(item) {
      let group = svgEdges.get(item.edge.id);
      if (!group) {
        group = document.createElementNS(SVG, 'g'); const path = document.createElementNS(SVG, 'path');
        const arrow = document.createElementNS(SVG, 'polygon'); arrow.setAttribute('fill', 'currentColor');
        group.append(path, arrow); live.appendChild(group); svgEdges.set(item.edge.id, group);
        if (!geometryHit) { path.dataset.canvasEdge = item.edge.id; path.style.pointerEvents = 'stroke'; }
      }
      group.firstChild.setAttribute('d', item.d);
      group.firstChild.style.strokeWidth = String(selectedEdges.has(item.edge.id) ? 3 : 1.6);
      group.children[1].setAttribute('points', item.arrow.map(p => p.x + ',' + p.y).join(' '));
      if (!geometryHit) {
        let hit = group.querySelector('[data-canvas-hit]');
        if (!hit) { hit = document.createElementNS(SVG, 'path'); hit.dataset.canvasHit = '1'; hit.dataset.canvasEdge = item.edge.id; hit.style.stroke = 'transparent'; hit.style.pointerEvents = 'stroke'; group.appendChild(hit); }
        hit.setAttribute('d', item.d); hit.style.strokeWidth = String(22 / (camera.scale * factor));
      }
    }
    function applyCamera() {
      const scale = camera.scale * factor;
      const transform = `translate(${width / 2 - camera.cx * scale}px, ${height / 2 - camera.cy * scale}px) scale(${scale})`;
      world.style.transform = transform; live.style.transformOrigin = '0 0'; live.style.transform = transform;
      opts.onViewChange?.(Object.assign({}, camera)); schedule();
    }
    function paint() {
      raf = 0; if (destroyed) return;
      painting = true;
      if (pendingPointer) { const event = pendingPointer; pendingPointer = null; moveGesture(event); }
      const geometryChanged = dirtyEdges.size > 0;
      buildEdges();
      const ratio = Math.min(devicePixelRatio || 1, 3, 8192 / Math.max(1, width, height), Math.sqrt(4e6 / Math.max(1, width * height)));
      const w = Math.max(1, Math.round(width * ratio)), h = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== w || canvas.height !== h) { staticDirty = true; canvas.width = w; canvas.height = h; canvas.style.width = width + 'px'; canvas.style.height = height + 'px'; }
      const scale = camera.scale * factor, px = width / 2 - camera.cx * scale, py = height / 2 - camera.cy * scale;
      const dark = document.body.dataset.startTheme === 'dark', ink = dark ? '#eeeeee' : '#262626'; live.style.color = ink;
      const moving = gesture?.kind === 'nodes' && gesture.moved ? gesture.edges : new Set();
      svgEdges.forEach((el, key) => { if (geometryHit && !moving.has(key)) { el.remove(); svgEdges.delete(key); } });
      if (staticDirty || !geometryHit && geometryChanged) {
        staticDraws++;
        context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
        context.translate(px, py); context.scale(scale, scale); context.strokeStyle = context.fillStyle = ink;
        const candidates = grid.query({ left: -px / scale - 24, right: (width - px) / scale + 24, top: -py / scale - 24, bottom: (height - py) / scale + 24 });
        if (!geometryHit) svgEdges.forEach((el, key) => { if (!candidates.has(key)) { el.remove(); svgEdges.delete(key); } });
        [...candidates].map(key => edgeCache.get(key)).filter(Boolean).sort((a, b) => a.order - b.order).forEach(item => {
          if (!geometryHit) { svgEdge(item); return; }
          if (moving.has(item.edge.id)) return;
          context.lineWidth = selectedEdges.has(item.edge.id) ? 3 : 1.6; context.stroke(item.path);
          context.beginPath(); item.arrow.forEach((p, i) => i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)); context.closePath(); context.fill();
        });
        staticDirty = false;
      }
      if (geometryHit) moving.forEach(key => { const item = edgeCache.get(key); if (item) svgEdge(item); });
      if (gesture?.kind === 'edge' && gesture.point) {
        const source = session.nodes.get(gesture.source), start = G.exit(nodeRect(source), gesture.point);
        if (!previewPath) { previewPath = document.createElementNS(SVG, 'path'); live.appendChild(previewPath); }
        previewPath.setAttribute('d', `M ${start.x} ${start.y} L ${gesture.point.x} ${gesture.point.y}`);
      } else if (previewPath) { previewPath.remove(); previewPath = null; }
      painting = false;
    }
    function edgeAt(event) {
      const key = event.target.closest?.('[data-canvas-edge]')?.dataset.canvasEdge; if (key) return key;
      if (!geometryHit) return '';
      const p = worldPoint(event), hit = 11 / (camera.scale * factor);
      const candidates = [...grid.query({ left: p.x - hit, right: p.x + hit, top: p.y - hit, bottom: p.y + hit })]
        .map(key => edgeCache.get(key)).filter(Boolean).sort((a, b) => b.order - a.order);
      hitContext.lineWidth = hit * 2;
      return candidates.find(item => hitContext.isPointInStroke(item.path, p.x, p.y))?.edge.id || '';
    }
    function stopCamera() {
      if (cameraRaf) cancelAnimationFrame(cameraRaf); if (inertiaRaf) cancelAnimationFrame(inertiaRaf);
      cameraRaf = inertiaRaf = 0; target = Object.assign({}, camera);
    }
    function animateCamera() {
      if (reduced()) { camera = Object.assign({}, target); applyCamera(); return; }
      if (cameraRaf) return;
      let previous = performance.now();
      const tick = time => {
        cameraRaf = 0; if (destroyed) return;
        const t = 1 - Math.exp(-Math.min(time - previous, 50) / 34); previous = time;
        camera.scale += (target.scale - camera.scale) * t; camera.cx += (target.cx - camera.cx) * t; camera.cy += (target.cy - camera.cy) * t;
        if (Math.abs(target.scale - camera.scale) > .0008 || Math.hypot(target.cx - camera.cx, target.cy - camera.cy) > .08) cameraRaf = requestAnimationFrame(tick);
        else camera = Object.assign({}, target);
        applyCamera();
      };
      cameraRaf = requestAnimationFrame(tick);
    }
    function refreshSize() {
      if (destroyed) return;
      const nextWidth = viewport.clientWidth || 640, nextHeight = viewport.clientHeight || 360;
      if (width === nextWidth && height === nextHeight) return;
      width = nextWidth; height = nextHeight; factor = width / 640;
      frameRect = viewport.getBoundingClientRect(); applyCamera();
    }
    function activate() { if (destroyed) return; active = true; opts.onActivate?.(); if (!readOnly) host.classList.add('is-selected'); }
    function suspend() { active = false; space = false; stopCamera(); cancelGesture(); finishEdit(true); }
    function startGesture(event, kind, extra) {
      gesture = Object.assign({ kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: worldPoint(event), moved: false, camera: Object.assign({}, camera), time: performance.now(), vx: 0, vy: 0 }, extra);
      if (kind === 'pan' || kind === 'edge') { try { viewport.setPointerCapture(event.pointerId); } catch (_) {} }
      document.addEventListener('pointermove', pointerMove, true); document.addEventListener('pointerup', pointerUp, true); document.addEventListener('pointercancel', pointerCancel, true);
      if (kind === 'pan') viewport.classList.add('is-panning');
      if (kind === 'nodes') gesture.edges = related(gesture.ids);
      if (kind === 'box') gesture.original = new Set(selectedNodes);
    }
    function removeGestureListeners() {
      document.removeEventListener('pointermove', pointerMove, true); document.removeEventListener('pointerup', pointerUp, true); document.removeEventListener('pointercancel', pointerCancel, true);
      viewport.classList.remove('is-panning');
      if (gesture) { gesture.box?.remove(); try { if (viewport.hasPointerCapture(gesture.pointerId)) viewport.releasePointerCapture(gesture.pointerId); } catch (_) {} }
    }
    function cancelGesture() {
      if (!gesture) return; pendingPointer = null;
      const cancelled = gesture; gesture = null;
      // Release before dropping the gesture, so capture cleanup still knows its id.
      gesture = cancelled; removeGestureListeners(); gesture = null;
      if (cancelled.kind === 'nodes' && session.owner === engine) session.commit(engine, false, { nodes: cancelled.ids, positionOnly: true });
      if (cancelled.kind === 'pan') { camera = cancelled.camera; target = Object.assign({}, camera); applyCamera(); }
      schedule();
    }
    function pointerMove(event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      pendingPointer = { clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, target: event.target };
      event.preventDefault(); schedule(false);
    }
    function moveGesture(event) {
      if (!gesture) return;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      const wasMoved = gesture.moved; gesture.moved ||= Math.hypot(dx, dy) > 4;
      if (!wasMoved && gesture.moved) {
        try { viewport.setPointerCapture(event.pointerId); } catch (_) {}
        if (gesture.kind === 'nodes') staticDirty = true;
        if (gesture.kind === 'box') { gesture.box = document.createElement('div'); gesture.box.className = 'note-canvas-box'; world.appendChild(gesture.box); }
      }
      const point = worldPoint(event);
      if (gesture.kind === 'nodes' && gesture.moved) {
        if (session.owner !== engine && !session.begin(engine)) return;
        gesture.ids.forEach(key => { const node = session.nodes.get(key), start = gesture.positions.get(key); node.x = start.x + point.x - gesture.start.x; node.y = start.y + point.y - gesture.start.y; });
        session.emit({ nodes: gesture.ids, positionOnly: true });
      } else if (gesture.kind === 'edge') { gesture.point = point; }
      else if (gesture.kind === 'pan') {
        const time = performance.now(), elapsed = Math.max(1, time - gesture.time);
        const nextX = gesture.camera.cx - dx / (camera.scale * factor), nextY = gesture.camera.cy - dy / (camera.scale * factor);
        gesture.vx = (nextX - camera.cx) / elapsed; gesture.vy = (nextY - camera.cy) / elapsed; gesture.time = time;
        camera.cx = nextX; camera.cy = nextY; target = Object.assign({}, camera); applyCamera();
      } else if (gesture.kind === 'box' && gesture.moved) {
        const left = Math.min(point.x, gesture.start.x), top = Math.min(point.y, gesture.start.y), right = Math.max(point.x, gesture.start.x), bottom = Math.max(point.y, gesture.start.y);
        Object.assign(gesture.box.style, { left: left + 'px', top: top + 'px', width: right - left + 'px', height: bottom - top + 'px' });
        const next = new Set(gesture.extend ? gesture.original : []);
        session.data.nodes.forEach(node => { const r = nodeRect(node); if (r.x <= right && r.x + r.w >= left && r.y <= bottom && r.y + r.h >= top) next.add(node.id); });
        selection(next, new Set());
      }
    }
    function pointerUp(event) {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      pendingPointer = null; moveGesture(event);
      const completed = gesture;
      removeGestureListeners(); gesture = null;
      const insideWindow = event.clientX >= 0 && event.clientY >= 0 && event.clientX <= innerWidth && event.clientY <= innerHeight;
      if (completed.kind === 'nodes' && session.owner === engine) session.commit(engine, completed.moved && insideWindow, { nodes: completed.ids, positionOnly: true });
      if (completed.kind === 'edge' && completed.moved && insideWindow) {
        const targetNode = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-canvas-node]');
        const key = targetNode?.dataset.canvasNode;
        if (key && viewport.contains(targetNode) && key !== completed.source && !session.data.edges.some(e => e.from === completed.source && e.to === key)) {
          session.change(engine, data => data.edges.push({ id: id(), from: completed.source, to: key, text: '', curve: 'straight' }));
        }
      }
      if (completed.kind === 'pan' && completed.moved && !reduced() && insideWindow) {
        let vx = completed.vx * .15, vy = completed.vy * .15, previous = performance.now();
        const tick = time => {
          inertiaRaf = 0; if (destroyed || !active) return;
          const dt = Math.min(32, time - previous); previous = time;
          camera.cx += vx * dt; camera.cy += vy * dt; vx *= Math.pow(.88, dt / 16.67); vy *= Math.pow(.88, dt / 16.67);
          target = Object.assign({}, camera); applyCamera();
          if (Math.hypot(vx, vy) > .015) inertiaRaf = requestAnimationFrame(tick);
        };
        if (Math.hypot(vx, vy) > .015) inertiaRaf = requestAnimationFrame(tick);
      }
      schedule();
    }
    function pointerCancel(event) { if (event.pointerId === gesture?.pointerId) cancelGesture(); }
    async function whenInputSettled() {
      cancelGesture(); stopCamera();
      if (!draft) return true;
      const promise = draft.settled; finishEdit(true); draft?.input.blur(); return promise;
    }
    function finishEdit(commit) {
      if (!draft) return;
      if (draft.composing || draft.frame) { draft.pending = commit; return; }
      const current = draft; draft = null;
      if (current.frame) cancelAnimationFrame(current.frame);
      const value = current.input.value.replace(/\r\n?/g, '\n');
      current.input.remove(); if (current.text) current.text.hidden = false;
      const record = current.node ? session.nodes.get(current.node) : session.edges.get(current.edge)?.edge;
      const changed = commit && record && (value !== current.original || current.isNew);
      if (changed) record.text = value;
      const info = changed ? current.node ? { nodes: [current.node], structure: !!current.isNew } : { edges: [current.edge] }
        : current.isNew ? { all: true } : { unchanged: true };
      session.commit(engine, changed, info);
      if (current.edge && edgeCache.has(current.edge)) renderLabel(edgeCache.get(current.edge));
      if (current.isNew && !changed) selection(new Set(), new Set());
      current.resolve(true); schedule(false);
    }
    function edit(key, edge, isNew) {
      if (readOnly || locked()) return;
      finishEdit(true); if (draft) return;
      if (!session.begin(engine)) return;
      const record = edge ? session.edges.get(key)?.edge : session.nodes.get(key); if (!record) { session.commit(engine, false); return; }
      let el = edge ? labels.get(key) : nodes.get(key);
      if (!el && edge) {
        el = document.createElement('div'); el.className = 'note-canvas-edge-label'; el.dataset.canvasEdge = key;
        const geom = edgeCache.get(key); if (geom) { el.style.left = geom.midpoint.x + 'px'; el.style.top = geom.midpoint.y + 'px'; }
        world.appendChild(el); labels.set(key, el);
      }
      const text = edge ? null : el.querySelector('.note-canvas-text'); if (text) text.hidden = true; else el.textContent = '';
      const input = document.createElement('textarea'); input.className = 'note-canvas-input'; input.value = record.text || ''; el.appendChild(input);
      let resolve; const settled = new Promise(done => { resolve = done; });
      draft = { node: edge ? '' : key, edge: edge ? key : '', original: input.value, input, text, settled, resolve, composing: false, pending: null, isNew, frame: 0 };
      const current = draft;
      const fit = () => { input.style.height = '0px'; input.style.height = Math.max(22, input.scrollHeight) + 'px'; const changed = measure(current.node ? [key] : []); schedule(changed); };
      input.addEventListener('input', fit);
      input.addEventListener('compositionstart', () => { current.composing = true; if (current.frame) cancelAnimationFrame(current.frame); });
      input.addEventListener('compositionend', () => {
        current.composing = false;
        current.frame = requestAnimationFrame(() => { current.frame = requestAnimationFrame(() => { current.frame = 0; if (draft === current && current.pending !== null) finishEdit(current.pending); }); });
      });
      input.addEventListener('blur', () => { if (draft === current) { current.pending = true; if (!current.composing) finishEdit(true); } });
      input.addEventListener('keydown', event => {
        event.stopPropagation(); if (event.isComposing || current.composing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); finishEdit(false); viewport.focus({ preventScroll: true }); }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); finishEdit(true); viewport.focus({ preventScroll: true }); }
      });
      ['pointerdown', 'mousedown', 'dblclick', 'paste', 'copy', 'cut', 'input', 'compositionstart', 'compositionend'].forEach(type => input.addEventListener(type, event => event.stopPropagation()));
      fit(); input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length);
    }
    listen(viewport, 'pointerdown', event => {
      if (event.button !== 0 || event.target.closest('.note-canvas-input') || locked()) return;
      event.preventDefault(); event.stopPropagation(); activate(); stopCamera(); finishEdit(true); if (draft) return;
      viewport.focus({ preventScroll: true });
      if (space) { startGesture(event, 'pan'); return; }
      const key = nodeAt(event);
      if (key) {
        if (readOnly) return;
        if (event.altKey) { startGesture(event, 'edge', { source: key, point: worldPoint(event) }); return; }
        const next = new Set(selectedNodes);
        if (event.shiftKey) { next.has(key) ? next.delete(key) : next.add(key); }
        else if (!next.has(key)) { next.clear(); next.add(key); }
        selection(next, new Set());
        if (next.has(key)) startGesture(event, 'nodes', { ids: [...next], positions: new Map([...next].map(id => { const n = session.nodes.get(id); return [id, { x: n.x, y: n.y }]; })) });
        return;
      }
      const edge = edgeAt(event);
      if (edge) { if (!readOnly) selection(new Set(), new Set([edge])); return; }
      if (!readOnly) { if (!event.shiftKey) selection(new Set(), new Set()); startGesture(event, 'box', { extend: event.shiftKey }); }
    });
    listen(viewport, 'dblclick', event => {
      event.preventDefault(); event.stopPropagation(); if (readOnly || locked() || draft) return;
      activate(); const key = nodeAt(event);
      if (key) { edit(key, false, false); return; }
      const edge = edgeAt(event); if (edge) { edit(edge, true, false); return; }
      const point = worldPoint(event), scale = opts.nodeScale?.() || 1, keyNew = id();
      // Creation and its initial text edit form one history operation.
      if (!session.begin(engine)) return;
      const node = { id: keyNew, kind: 'index', x: point.x - 80 * scale, y: point.y - 24 * scale, width: 160 * scale, height: 48 * scale, text: '' };
      session.data.nodes.push(node); session.nodes.set(keyNew, node); session.adjacent.set(keyNew, new Set());
      session.emit({ nodes: [keyNew], structure: true }); selection(new Set([keyNew]), new Set());
      edit(keyNew, false, true);
    });
    listen(viewport, 'wheel', event => {
      if (!active) return;
      event.preventDefault(); event.stopPropagation();
      if (inertiaRaf) cancelAnimationFrame(inertiaRaf); inertiaRaf = 0;
      const point = worldPoint(event), next = clamp(target.scale * Math.exp((event.deltaY > 0 ? -1 : 1) * Math.min(Math.abs(event.deltaY), 200) / 200 * Math.log(1.1)), .25, 4);
      const rect = viewport.getBoundingClientRect();
      target = { scale: next, cx: point.x - (event.clientX - rect.left - width / 2) / (next * factor), cy: point.y - (event.clientY - rect.top - height / 2) / (next * factor) };
      animateCamera();
    }, { passive: false });
    listen(viewport, 'keydown', event => {
      if (event.target.closest('.note-canvas-input')) return;
      if (!active) return;
      if (event.code === 'Space') { event.preventDefault(); event.stopPropagation(); space = true; return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelGesture(); selection(new Set(), new Set()); return; }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'c') { event.preventDefault(); event.stopPropagation(); opts.onCopyReference?.(); return; }
      if (readOnly || locked()) { if (event.key === 'Delete' || event.key === 'Backspace' || mod && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); } return; }
      if (mod && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); session.travel(event.key.toLowerCase() === 'y' || event.shiftKey); return; }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault(); event.stopPropagation();
        if (!selectedNodes.size && !selectedEdges.size) { opts.onDeleteReference?.(); return; }
        session.change(engine, data => { data.nodes = data.nodes.filter(n => !selectedNodes.has(n.id)); data.edges = data.edges.filter(e => !selectedEdges.has(e.id) && !selectedNodes.has(e.from) && !selectedNodes.has(e.to)); });
        selection(new Set(), new Set());
      } else if (event.key === 'F2' && selectedNodes.size === 1) { event.preventDefault(); event.stopPropagation(); edit([...selectedNodes][0], false, false); }
    });
    listen(viewport, 'keyup', event => { if (event.code === 'Space') { space = false; event.preventDefault(); event.stopPropagation(); } });
    listen(document, 'pointerdown', event => { if (!host.contains(event.target)) { active = false; space = false; stopCamera(); finishEdit(true); } }, true);
    listen(window, 'blur', () => { cancelGesture(); stopCamera(); finishEdit(true); space = false; });
    listen(document, 'visibilitychange', () => { if (document.hidden) suspend(); });
    listen(viewport, 'lostpointercapture', () => { if (gesture) cancelGesture(); });
    const themeObserver = new MutationObserver(schedule); themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-start-theme'] });
    session.listeners.add(sync); sync({ all: true }); refreshSize();
    if (!opts.viewport && session.data.nodes.length) {
      const bounds = session.data.nodes.map(nodeRect), left = Math.min(...bounds.map(r => r.x)), right = Math.max(...bounds.map(r => r.x + r.w));
      const top = Math.min(...bounds.map(r => r.y)), bottom = Math.max(...bounds.map(r => r.y + r.h));
      camera = { scale: clamp(Math.min(592 / Math.max(1, right - left), (height / factor - 48) / Math.max(1, bottom - top), 1), .25, 4), cx: (left + right) / 2, cy: (top + bottom) / 2 };
      target = Object.assign({}, camera); applyCamera();
    }
    function stats() { return { nodes: nodes.size, edges: edgeCache.size, geometryBuilds, staticDraws, svgEdges: svgEdges.size, spatialBuckets: grid.buckets.size, framesPending: !!(raf || cameraRaf || inertiaRaf), destroyed }; }
    function destroy() {
      if (destroyed) return;
      cancelGesture(); stopCamera(); finishEdit(true);
      if (draft) return; // Native IME host is released only after it settles.
      destroyed = true; if (raf) cancelAnimationFrame(raf); raf = 0;
      resize.disconnect(); themeObserver.disconnect(); disposers.forEach(fn => fn()); session.listeners.delete(sync);
      nodes.clear(); rects.clear(); edgeCache.clear(); grid.clear(); labels.clear(); svgEdges.clear();
      canvas.width = canvas.height = 1; viewport.remove();
    }
    return engine;
  }
  window.RelatumNoteCanvasEngine = Object.freeze({ create });
})();
