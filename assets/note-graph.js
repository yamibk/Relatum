// Notebook graph tab. Files and links are read-only; layouts live only in this session.
(function (global) {
  'use strict';
  const CACHE_LIMIT = 24, CACHE_BYTES = 16 * 1024 * 1024;
  const VIEW_W = 1200, VIEW_H = 720;
  const LABEL_HIDE_UNIT = .25, LABEL_SHOW_UNIT = .65;
  const GROWTH_BLANK_MS = 100, GROWTH_SPAN_MS = 3000;
  const COPY = {
    title: ['关系图谱', 'Graph'], notebooks: ['笔记本', 'Notebooks'], directory: ['显示笔记目录', 'Show note directory'],
    relax: ['舒展', 'Spread'], reset: ['复位', 'Reset'],
    grow: ['播放关系图谱生长动画', 'Play graph growth animation'],
    nodes: ['节点', 'nodes'], edges: ['连线', 'edges'], retry: ['重试', 'Retry'],
    loading: ['正在读取笔记图谱…', 'Loading notebook graph…'], empty: ['当前笔记本还没有笔记', 'This notebook has no notes yet'],
    disconnected: ['当前笔记之间还没有链接', 'These notes do not have links yet'],
    failed: ['无法读取笔记图谱', 'Could not read the notebook graph'],
    incomplete: ['部分笔记无法读取，图谱统计未完成', 'Some notes could not be read. Graph statistics are incomplete.'],
    select: ['请先选择笔记本', 'Select a notebook first'],
  };
  const mapPath = (path, source, destination) => path === source ? destination
    : path.startsWith(source + '/') ? destination + path.slice(source.length) : path;

  function create(options) {
    const host = options.host;
    if (!host || !global.GraphEngine) return null;
    const copy = key => COPY[key][options.language() === 'en' ? 1 : 0];
    // Only this fixed shell is HTML; filenames, paths and errors always use textContent.
    host.innerHTML = '<div class="graph-stage note-graph-stage" data-role="graph-stage"><canvas class="graph-canvas" data-role="graph-canvas"></canvas>'
      + '<div class="note-graph-tools">'
      + '<button type="button" class="graph-tool-btn note-mobile-pane-button" data-note-action="toggle-tree" data-note-graph-control-label="directory"><svg class="graph-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#note-icon-panel-left"/></svg></button>'
      + '<button type="button" class="graph-tool-btn" data-action="graph-grow" data-note-graph-control-label="grow"><svg class="graph-tool-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m4 16 9-9 3 3-9 9-3-3ZM10.5 9.5l3 3M5 2v4M3 4h4M14 1v3M12.5 2.5h3M17 12v4M15 14h4"/></svg></button>'
      + '<button type="button" class="graph-tool-btn" data-action="graph-relax"><svg class="graph-tool-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M7.2 4.2H4.2v3M12.8 4.2h3v3M7.2 15.8h-3v-3M12.8 15.8h3v-3M8 8 4.4 4.4M12 8l3.6-3.6M8 12l-3.6 3.6M12 12l3.6 3.6"/></svg><span data-note-graph-copy="relax"></span></button>'
      + '<button type="button" class="graph-tool-btn" data-action="graph-reset-view"><svg class="graph-tool-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M15.7 7.1A6.2 6.2 0 1 0 16 12M15.7 3.8v3.5h-3.5"/></svg><span data-note-graph-copy="reset"></span></button>'
      + '<button type="button" class="graph-tool-btn" data-note-action="graph-notebooks" data-note-graph-control-label="notebooks" aria-controls="note-shared-side-panel" aria-expanded="false"><svg class="graph-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#note-icon-panel-right-frame"/><use href="#note-icon-panel-right-bar"/></svg></button></div>'
      + '<div class="graph-tooltip" data-role="graph-tooltip" hidden></div><div class="graph-hint" data-role="graph-hint" hidden></div>'
      + '<div class="graph-empty" data-role="graph-empty" hidden></div><div class="note-graph-message" data-role="note-graph-message" role="status" hidden>'
      + '<span></span><button type="button" data-note-graph-retry></button></div>'
      + '<div class="graph-legend"><span><strong data-role="graph-node-count">0</strong> <span data-note-graph-copy="nodes"></span></span>'
      + '<span><strong data-role="graph-edge-count">0</strong> <span data-note-graph-copy="edges"></span></span></div></div>';
    const find = selector => host.querySelector(selector);
    const stage = find('[data-role="graph-stage"]');
    const tooltip = find('[data-role="graph-tooltip"]'), empty = find('[data-role="graph-empty"]');
    const hint = find('[data-role="graph-hint"]'), message = find('[data-role="note-graph-message"]');
    const retry = find('[data-note-graph-retry]');
    let canvas = find('[data-role="graph-canvas"]');
    let nodes = [], edges = [], signature = '', scope = null;
    let wanted = false, destroyed = false, operation = 0, engine = null, needsLayout = false, selecting = false;
    let openJob = null, refreshJob = null, status = '', failure = null;
    let growthView = null;
    const scenes = new Map();
    let sceneBytes = 0;
    function current(ticket, expectedRoot) {
      return !destroyed && wanted && options.isActive()
        && operation === ticket && scope === expectedRoot && options.getRoot() === expectedRoot;
    }
    function updateLanguage() {
      host.querySelectorAll('[data-note-graph-copy]').forEach(element => { element.textContent = copy(element.dataset.noteGraphCopy); });
      host.querySelectorAll('[data-note-graph-control-label]').forEach(element => { element.setAttribute('aria-label', copy(element.dataset.noteGraphControlLabel)); element.title = copy(element.dataset.noteGraphControlLabel); });
      host.setAttribute('aria-label', copy('title') + ' · ' + (scope ? scope.split('/').pop() : 'notes'));
      canvas.setAttribute('aria-label', host.getAttribute('aria-label'));
      empty.textContent = copy('empty'); hint.textContent = copy('disconnected'); retry.textContent = copy('retry');
      if (status) message.querySelector('span').textContent = status === 'select' ? copy('select') : status === 'loading' ? copy('loading')
        : failure?.code === 'statistics_incomplete' ? copy('incomplete') : failure?.message || copy('failed');
    }
    function showStatus(next, error) {
      status = next; failure = error || null;
      message.hidden = !next; retry.hidden = next !== 'error';
      message.classList.toggle('is-full', nodes.length === 0);
      empty.hidden = !!next || nodes.length !== 0;
      hint.hidden = !!next || nodes.length === 0 || edges.length !== 0;
      host.setAttribute('aria-busy', String(next === 'loading')); updateLanguage();
    }
    function syncTheme() {
      const dark = document.body.dataset.startTheme === 'dark';
      theme.fill = dark ? '#b9b9b9' : '#5f5f5f'; theme.fillGL = dark ? [185 / 255, 185 / 255, 185 / 255] : [95 / 255, 95 / 255, 95 / 255];
      theme.focus = dark ? '#f5f5f5' : '#202020'; theme.focusGL = dark ? [245 / 255, 245 / 255, 245 / 255] : [32 / 255, 32 / 255, 32 / 255];
      theme.edge = dark ? 'rgba(190,190,190,.23)' : 'rgba(96,96,96,.22)';
      theme.edgeHi = dark ? 'rgba(245,245,245,.8)' : 'rgba(32,32,32,.66)';
      theme.edgeGL = dark ? [190 / 255, 190 / 255, 190 / 255, .23] : [96 / 255, 96 / 255, 96 / 255, .22];
      theme.edgeHiGL = dark ? [245 / 255, 245 / 255, 245 / 255, .8] : [32 / 255, 32 / 255, 32 / 255, .66];
      engine?.requestRender();
    }
    const theme = {};

    function createLabelLayer() {
      const layer = document.createElement('div'); layer.className = 'note-graph-label-layer'; layer.setAttribute('aria-hidden', 'true');
      const world = document.createElement('div'); world.className = 'note-graph-label-world'; layer.appendChild(world); stage.appendChild(layer);
      // Widths belong to graph data; DOM belongs to the viewport. Keep a small detached LRU.
      const visible = new Map(), recycled = new Map(), measurements = new Map();
      const RECYCLE_LIMIT = 256;
      const measure = document.createElement('canvas').getContext('2d');
      const family = getComputedStyle(stage).fontFamily || 'system-ui';
      if (measure) measure.font = '500 12px ' + family;
      let stamp = 0, previousMatrix = '', previousUnit = 0, previousNodes = null, previousLabelAlpha = -1;
      function metric(node) {
        let value = measurements.get(node.id);
        if (!value || value.text !== node.label) {
          value = { text: node.label, width: measure ? measure.measureText(node.label).width : node.label.length * 12 };
          measurements.set(node.id, value);
        }
        return value;
      }
      function recycle(entry, id) {
        entry.anchor.remove(); recycled.delete(id); recycled.set(id, entry);
        while (recycled.size > RECYCLE_LIMIT) recycled.delete(recycled.keys().next().value);
      }
      return {
        sync(state) {
          stamp++;
          if (previousNodes !== state.nodes) {
            const ids = new Set(state.nodes.map(node => node.id));
            visible.forEach((entry, id) => { if (!ids.has(id)) { entry.anchor.remove(); visible.delete(id); } });
            recycled.forEach((entry, id) => { if (!ids.has(id)) recycled.delete(id); });
            measurements.forEach((entry, id) => { if (!ids.has(id)) measurements.delete(id); });
            previousNodes = state.nodes;
          }
          const unit = state.unit, inverse = 1 / unit;
          const progress = Math.max(0, Math.min(1, (unit - LABEL_HIDE_UNIT) / (LABEL_SHOW_UNIT - LABEL_HIDE_UNIT)));
          const labelAlpha = progress * progress * (3 - 2 * progress);
          if (labelAlpha !== previousLabelAlpha) {
            world.style.setProperty('--note-graph-label-alpha', String(labelAlpha)); previousLabelAlpha = labelAlpha;
          }
          const tx = state.offsetX - state.viewX * unit, ty = state.offsetY - state.viewY * unit;
          const matrix = 'matrix(' + unit + ',0,0,' + unit + ',' + tx + ',' + ty + ')';
          if (matrix !== previousMatrix) { world.style.transform = matrix; previousMatrix = matrix; }
          if (unit !== previousUnit) {
            world.style.setProperty('--note-graph-inverse', String(inverse));
            world.style.setProperty('--note-graph-unit', String(unit)); previousUnit = unit;
          }
          for (let index = 0; index < state.nodes.length; index++) {
            const node = state.nodes[index];
            const sx = node._rx * unit + tx, sy = node._ry * unit + ty;
            let entry = visible.get(node.id);
            const measurement = metric(node), width = measurement.width;
            const y = sy + node.r * unit + 8;
            if (sx + width / 2 < 0 || sx - width / 2 > state.cssW || y + 16 < 0 || y > state.cssH) continue;
            if (!entry) {
              entry = recycled.get(node.id); recycled.delete(node.id);
              if (!entry) {
                const anchor = document.createElement('div'); anchor.className = 'note-graph-label-anchor';
                const label = document.createElement('span'); label.className = 'note-graph-label'; anchor.appendChild(label);
                entry = { anchor, label, text: '', path: '', radius: -1, opacity: -1, hovered: false, x: NaN, y: NaN };
              }
              world.appendChild(entry.anchor); visible.set(node.id, entry);
            }
            entry.stamp = stamp;
            const hovered = index === state.focusIndex;
            if (entry.hovered !== hovered) { entry.anchor.classList.toggle('is-hovered', hovered); entry.hovered = hovered; }
            // Fully faded titles keep their DOM/measurement but defer invisible style work.
            // Cached values stay unchanged so the next visible/hovered frame catches up.
            const visibleTitle = labelAlpha > 0 || hovered;
            if (visibleTitle && (entry.x !== node._rx || entry.y !== node._ry)) {
              entry.anchor.style.transform = 'translate(' + node._rx + 'px,' + node._ry + 'px)'; entry.x = node._rx; entry.y = node._ry;
            }
            if (entry.radius !== node.r) { entry.anchor.style.setProperty('--note-graph-radius', String(node.r)); entry.radius = node.r; }
            const alpha = (node._appearOpacity ?? 1) * (node._dim ? .26 : 1);
            if (visibleTitle && entry.opacity !== alpha) { entry.anchor.style.opacity = String(alpha); entry.opacity = alpha; }
            if (entry.text !== node.label) {
              entry.label.textContent = node.label; entry.text = node.label;
            }
            if (entry.path !== node.path) { entry.anchor.dataset.noteGraphLabel = node.path; entry.path = node.path; }
          }
          visible.forEach((entry, id) => { if (entry.stamp !== stamp) { visible.delete(id); recycle(entry, id); } });
        },
        destroy() { visible.clear(); recycled.clear(); measurements.clear(); previousNodes = null; layer.remove(); },
      };
    }
    function nodeStyle(node, environment) {
      const dim = environment.dim ? .22 : 1, color = environment.focus ? theme.focusGL : theme.fillGL;
      return { r: node.r, fill: [color[0], color[1], color[2], dim],
        stroke: [color[0], color[1], color[2], environment.focus ? dim : 0],
        strokeW: environment.focus ? 2 : 0, scale: environment.focus ? 1.18 : 1 };
    }
    function edgeStyle(edge, source, target, environment) {
      const color = environment.highlighted ? theme.edgeHiGL : theme.edgeGL;
      return { color: [color[0], color[1], color[2], color[3] * (environment.dim ? .14 : 1)], width: environment.highlighted ? 2 : 1.2 };
    }
    function createEngine(nextCanvas) {
      canvas = nextCanvas;
      const labelLayer = createLabelLayer();
      const engine = global.GraphEngine.create({ canvas, backend: 'webgl', active: false,
        cacheInstances: true, labelVisibility: 'always', domOverlayOnCanvas2D: true,
        ignoreHiddenNodes: true,
        onCanvasReplace: replacement => { canvas = replacement; },
        config: { viewW: VIEW_W, viewH: VIEW_H, repulsion: 7200, spring: .048, springRest: 112, gravity: .0055,
          alphaDecay: .022, alphaReheat: .28, theta: .92, velocityDamp: .84,
          zoomMin: .04, zoomMax: 3.5, fitScaleMin: .04, fitScaleMax: 3.5, fitPad: 26, fitMargin: 44 },
        reduceMotion: global.matchMedia('(prefers-reduced-motion: reduce)').matches,
        nodeStyle, edgeStyle, domOverlay: labelLayer,
        getGravity: node => node.degree >= 6 ? .022 : node.degree >= 3 ? .009 : node.degree ? .005 : .0035,
        getEdgeRest: edge => edge.rest,
        onLayoutSettled() { needsLayout = false; growthView = null; },
        drawNode(context, node, environment) {
          context.globalAlpha *= environment.dim ? .22 : 1;
          context.beginPath(); context.arc(0, 0, node.r * (environment.focus ? 1.18 : 1), 0, Math.PI * 2);
          context.fillStyle = environment.focus ? theme.focus : theme.fill; context.fill();
        },
        drawEdge(context, edge, source, target, environment) {
          context.globalAlpha *= environment.dim ? .14 : 1;
          context.beginPath(); context.moveTo(source._rx, source._ry); context.lineTo(target._rx, target._ry);
          context.strokeStyle = environment.highlighted ? theme.edgeHi : theme.edge;
          context.lineWidth = environment.highlighted ? 2 : 1.2; context.stroke();
        },
        onNodeClick: selectNode,
        onNodeHover(node, event) {
          if (!node) { tooltip.hidden = true; return; }
          tooltip.textContent = node.path;
          const bounds = stage.getBoundingClientRect();
          tooltip.style.left = Math.max(4, Math.min(event.clientX - bounds.left + 14, bounds.width - 284)) + 'px';
          tooltip.style.top = Math.max(4, Math.min(event.clientY - bounds.top + 14, bounds.height - 45)) + 'px'; tooltip.hidden = false;
        },
      });
      if (!engine) labelLayer.destroy();
      else {
        let inertia = .15;
        try { const saved = parseFloat(localStorage.getItem('canvas:panInertia')); if (Number.isFinite(saved)) inertia = Math.max(0, Math.min(1, saved)); } catch (_) {}
        engine.setPanInertia(inertia);
      }
      return engine;
    }
    function updateCounts() {
      find('[data-role="graph-node-count"]').textContent = String(nodes.length);
      find('[data-role="graph-edge-count"]').textContent = String(edges.length);
      ['graph-grow', 'graph-relax', 'graph-reset-view'].forEach(action => { find('[data-action="' + action + '"]').disabled = nodes.length === 0; });
    }
    function ensureEngine() {
      if (engine) return engine;
      syncTheme();
      engine = createEngine(canvas);
      if (!engine) throw new Error(copy('failed'));
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-start-theme'] });
      document.addEventListener('relatum:languagechange', updateLanguage);
      return engine;
    }
    function releaseEngine() {
      themeObserver.disconnect(); document.removeEventListener('relatum:languagechange', updateLanguage);
      if (!engine) return;
      const previous = engine.canvas;
      engine.destroy(); engine = null;
      canvas = previous.cloneNode(false); canvas.width = canvas.height = 1; previous.replaceWith(canvas);
      try { previous.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {}
      previous.width = previous.height = 1;
    }
    function forgetScene(path) {
      const scene = scenes.get(path);
      if (scene) { sceneBytes -= scene.bytes; scenes.delete(path); }
    }
    function storeScene(path, scene) {
      forgetScene(path);
      // Serialized UTF-8 × 2 bounds strings/records conservatively; this is not a heap measurement.
      scene.bytes = (new TextEncoder().encode(JSON.stringify(scene)).length + 128) * 2;
      if (scene.bytes > CACHE_BYTES) return;
      scenes.set(path, scene); sceneBytes += scene.bytes;
      while (scenes.size > CACHE_LIMIT || sceneBytes > CACHE_BYTES) forgetScene(scenes.keys().next().value);
    }
    function rememberScene() {
      if (scope === null || !signature) return;
      needsLayout = needsLayout || !!engine?.layoutPending;
      // Stop first: a sliced presolve restores its seeds when cancelled.
      engine?.setActive(false);
      storeScene(scope, { signature, needsLayout, view: engine ? engine.view : null,
        nodes: nodes.map(node => ({ id: node.id, path: node.path, label: node.label, degree: node.degree, r: node.r, x: node.x, y: node.y })),
        edges: edges.map(edge => ({ source: edge.source, target: edge.target, rest: edge.rest })) });
    }
    function restoreScene(scene) {
      nodes = scene.nodes.map(node => ({ ...node })); edges = scene.edges.map(edge => ({ ...edge }));
      signature = scene.signature; needsLayout = scene.needsLayout;
      updateCounts();
      if (nodes.length) {
        const drawing = ensureEngine(); drawing.setData(nodes, edges);
        if (!drawing.restoreView(scene.view)) drawing.fitView(false);
        drawing.setActive(true);
        if (needsLayout) drawing.kick();
      }
      showStatus('');
    }
    function seedPositions() {
      const count = Math.max(1, nodes.length);
      // A uniform disk avoids near-coincident neighbors in a dense single ring.
      const radius = Math.min(VIEW_W, VIEW_H) * .29 * Math.max(1, Math.sqrt(count / 180));
      nodes.forEach((node, index) => {
        const angle = index * 2.399963229728653, spread = radius * Math.sqrt((index + .5) / count);
        node.x = VIEW_W / 2 + Math.cos(angle) * spread; node.y = VIEW_H / 2 + Math.sin(angle) * spread;
      });
    }
    function installData(result, first) {
      growthView = null;
      const previous = new Map(nodes.map(node => [node.id, node]));
      const byId = new Map();
      const next = (result.nodes || []).filter(node => node && typeof node.path === 'string' && typeof node.id === 'string');
      nodes = next.map((node, index) => {
        byId.set(node.id, index);
        const old = previous.get(node.id);
        return { id: node.id, path: node.path, label: String(node.title || node.path.split('/').pop().replace(/\.md$/i, '')),
          degree: 0, r: 6, x: old?.x ?? VIEW_W / 2, y: old?.y ?? VIEW_H / 2 };
      });
      const seen = new Set(); edges = [];
      (result.edges || []).forEach(edge => {
        const source = byId.get(edge.from), target = byId.get(edge.to);
        if (source === undefined || target === undefined || source === target) return;
        const key = Math.min(source, target) + ':' + Math.max(source, target);
        if (seen.has(key)) return; seen.add(key);
        edges.push({ source, target, rest: 112 }); nodes[source].degree++; nodes[target].degree++;
      });
      nodes.forEach(node => { node.r = Math.max(6, Math.min(17, 6 + node.degree * 1.5)); });
      if (first || previous.size === 0) seedPositions();
      else nodes.forEach((node, index) => {
        if (!previous.has(node.id)) { node.x += Math.cos(index * 2.4) * 30; node.y += Math.sin(index * 2.4) * 30; }
      });
      signature = result.signature || '';
      updateCounts(); needsLayout = nodes.length !== 0;
      if (nodes.length) {
        const drawing = ensureEngine(); drawing.setData(nodes, edges); drawing.setActive(true);
        if (first || previous.size === 0) drawing.start({ intro: true, fit: true });
        else { drawing.kick(); drawing.requestRender(); }
      } else releaseEngine();
      showStatus('');
    }
    async function queryGraph(ticket, expectedRoot, first) {
      try {
        const url = '/api/note-graph?root=' + encodeURIComponent(expectedRoot)
          + (!first && signature ? '&signature=' + encodeURIComponent(signature) : '');
        const result = await options.request(url);
        if (!current(ticket, expectedRoot)) return false;
        if (result.root !== expectedRoot) throw new Error(copy('failed'));
        if (result.unchanged && !first) { showStatus(''); return true; }
        if (!Array.isArray(result.nodes) || !Array.isArray(result.edges)) throw new Error(copy('failed'));
        if (!first && result.signature === signature) { showStatus(''); return true; }
        installData(result, first && nodes.length === 0); return true;
      } catch (error) {
        if (!current(ticket, expectedRoot)) return false;
        showStatus('error', error); return false;
      }
    }
    function activate() {
      if (destroyed || !options.isActive()) return Promise.resolve(false);
      const expectedRoot = options.getRoot();
      if (wanted && scope === expectedRoot) return openJob || refreshJob || Promise.resolve(true);
      deactivate();
      const ticket = ++operation; scope = expectedRoot; wanted = true;
      if (scope === null) { showStatus('select'); return Promise.resolve(true); }
      const scene = scenes.get(scope);
      if (scene) { scenes.delete(scope); scenes.set(scope, scene); restoreScene(scene); }
      else showStatus('loading');
      const task = queryGraph(ticket, expectedRoot, !signature);
      const wrapped = task.finally(() => { if (openJob === wrapped) openJob = null; });
      openJob = wrapped; return wrapped;
    }
    function deactivate(settings) {
      growthView = null;
      wanted = false; operation++; openJob = null; refreshJob = null; selecting = false;
      rememberScene(); releaseEngine(); tooltip.hidden = true;
      nodes = []; edges = []; signature = ''; needsLayout = false;
      updateCounts(); host.setAttribute('aria-busy', 'false');
      if (settings?.clearCache) { scenes.clear(); sceneBytes = 0; }
    }
    async function selectNode(node) {
      if (selecting) return;
      const expectedRoot = scope, ticket = ++operation;
      const valid = () => current(ticket, expectedRoot);
      selecting = true;
      try {
        if (!valid()) return;
        const opened = await options.onSelect(node.path, valid);
        if (!opened && valid()) options.showError(copy('failed'));
      } catch (error) { if (current(ticket, expectedRoot)) options.showError(error.message || copy('failed')); }
      finally { if (valid()) selecting = false; }
    }
    function checkExternalChanges() {
      if (!wanted || destroyed || selecting || !options.isActive()) return Promise.resolve(false);
      if (options.getRoot() !== scope) return activate();
      if (scope === null) return Promise.resolve(true);
      if (openJob) return openJob;
      if (refreshJob) return refreshJob;
      const ticket = operation, expectedRoot = scope;
      const job = queryGraph(ticket, expectedRoot, !signature);
      const wrapped = job.finally(() => { if (refreshJob === wrapped) refreshJob = null; });
      refreshJob = wrapped; return wrapped;
    }
    function remap(source, destination) {
      const inBook = (path, root) => root === '' ? !/^CustomNotebook(?:\/|$)/i.test(path)
        : path === root || path.startsWith(root + '/');
      const affected = root => root !== null && (mapPath(root, source, destination) !== root
        || inBook(source, root) || inBook(destination, root));
      const active = wanted && affected(scope);
      if (active) deactivate();
      const records = Array.from(scenes); scenes.clear(); sceneBytes = 0;
      records.forEach(([path, scene]) => {
        if (affected(path)) {
          scene.nodes = scene.nodes.map(node => {
            const path = mapPath(node.path, source, destination);
            return { ...node, id: mapPath(node.id, source, destination), path, label: path.split('/').pop().replace(/\.md$/i, '') };
          });
          scene.signature = '';
        }
        delete scene.bytes; storeScene(mapPath(path, source, destination), scene);
      });
      if (scope !== null) scope = mapPath(scope, source, destination);
      if (active && options.isActive()) activate();
    }
    function prune(path) {
      if (scope === path || scope && scope.startsWith(path + '/')) deactivate();
      scenes.forEach((value, key) => { if (key === path || key.startsWith(path + '/')) forgetScene(key); });
    }
    retry.addEventListener('click', () => { if (wanted) { showStatus(nodes.length ? '' : 'loading'); checkExternalChanges(); } });
    find('[data-action="graph-grow"]').addEventListener('click', () => {
      if (!wanted || !engine || !nodes.length) return;
      tooltip.hidden = true; needsLayout = true;
      // Everything is armed transparent before the next paint, including during a cancelled presolve.
      engine.setData(nodes, edges, { intro: true });
      if (growthView) engine.restoreView(growthView);
      else { engine.fitView(false); growthView = engine.view; }
      seedPositions();
      engine.start({ intro: true, fit: false, preserveView: true, introDelayMs: GROWTH_BLANK_MS, introSpanMs: GROWTH_SPAN_MS });
    });
    find('[data-action="graph-relax"]').addEventListener('click', () => {
      if (!wanted || !engine || !nodes.length) return;
      tooltip.hidden = true; growthView = null; needsLayout = true;
      engine.setData(nodes, edges); seedPositions();
      engine.start({ intro: false, fit: false, preserveView: true });
    });
    find('[data-action="graph-reset-view"]').addEventListener('click', () => { growthView = null; engine?.fitView(true); });
    const themeObserver = new MutationObserver(() => { if (wanted) syncTheme(); });
    updateLanguage(); updateCounts();
    return { activate, deactivate, isOpen: () => wanted, checkExternalChanges,
      invalidate() { return openJob ? Promise.resolve(false) : checkExternalChanges(); },
      setLanguage: updateLanguage, remap, prune,
      destroy() {
        if (destroyed) return;
        deactivate({ clearCache: true }); destroyed = true; host.replaceChildren();
      },
    };
  }
  global.RelatumNoteGraph = Object.freeze({ create });
})(window);
