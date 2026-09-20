import { createResearchModel } from './research-model.js';
import { createResearchPageSession } from './research-pages.js';
import { createResearchCanvas } from './research-canvas.js';
import {
  activateResearchNode, clearResearchTrace, createResearchComputeRuntime, snapshotPersistentResearchState,
  updateResearchComputeRuntime,
} from './research-compute.js';
import { createResearchSimulationController } from './research-runtime.js';
import { loadResearchRegistry } from './research-registry.js';
import { validateResearchDocument } from './research-schema.js';
import { loadResearchWorkspace, saveResearchWorkspace } from './research-persistence.js';
import { formatResearchValue } from './research-values.js';

const SAVE_DELAY_MS = 350;
const SAVE_RETRY_MS = 1800;

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

export async function createResearchEditor(stage) {
  if (!stage) throw new Error('研究工作区舞台不存在');
  const registry = await loadResearchRegistry();
  const required = (selector) => {
    const element = stage.querySelector(selector);
    if (!element) throw new Error('研究工作区 DOM 不完整：' + selector);
    return element;
  };
  const viewport = required('[data-research-viewport]');
  const rail = required('[data-research-page-rail]');
  const railHotspot = required('[data-research-page-hotspot]');
  const railList = required('[data-research-page-list]');
  const railAdd = required('[data-research-page-add]');
  const pageDelete = required('[data-research-page-delete]');
  const dock = required('[data-research-compute-dock]');
  const addButton = required('[data-research-add]');
  const palette = required('[data-research-add-palette]');
  const paletteSearch = required('[data-research-add-search]');
  const paletteList = required('[data-research-add-list]');
  const inspector = required('[data-research-inspector]');
  const inspectorTitle = required('[data-research-inspector-title]');
  const inspectorFields = required('[data-research-inspector-fields]');
  const inspectorClose = required('[data-research-inspector-close]');
  const tracePanel = required('[data-research-trace]');
  const traceSummary = required('[data-research-trace-summary]');
  const traceList = required('[data-research-trace-list]');
  const traceClear = required('[data-research-trace-clear]');
  const speedSelect = required('[data-research-speed]');
  const helpOpen = required('[data-research-help-open]');
  const helpOverlay = required('[data-research-help-overlay]');
  const helpClose = required('[data-research-help-close]');
  const persistenceStatus = required('[data-research-persistence-status]');

  let loadedWorkspace;
  let persistenceBlocked = false;
  try {
    loadedWorkspace = await loadResearchWorkspace();
    const checked = validateResearchDocument(loadedWorkspace.document, registry);
    if (!checked.ok) throw new Error('本地研究数据未通过 V2 校验');
    loadedWorkspace.document = checked.document;
  } catch (_error) {
    persistenceBlocked = true;
    loadedWorkspace = { document: null, revision: '', recovered: false };
  }

  const session = createResearchPageSession({
    createModel: (state) => createResearchModel(state || { nodes: [], edges: [] }, registry),
    document: loadedWorkspace.document,
  });
  let renderedPageId = session.activePage().id;
  let disposed = false;
  let active = false;
  let activeController = null;
  let modelUnsubscribe = null;
  let computeFrame = 0;
  let computeRevision = 0;
  let selectedNodeId = '';
  let saveTimer = 0;
  let saveRetryTimer = 0;
  let saveStatusTimer = 0;
  let saveDirty = false;
  let saveInFlight = null;
  let railHideTimer = 0;
  let persistenceRevision = String(loadedWorkspace.revision || '');

  const canvas = createResearchCanvas({
    stage,
    registry,
    model: session.activePage().model,
    view: session.activePage().view,
    onViewChange: (view) => {
      if (session.setPageView(renderedPageId, view)) scheduleSave();
    },
    onCreationToolChange: () => {},
    onSelectionChange: (selection) => {
      selectedNodeId = selection.primaryNode ? selection.primaryNode.id : '';
      renderInspector(selection.primaryNode);
    },
    onNodeAction: (nodeId) => {
      const page = session.page(renderedPageId);
      const runtime = ensureRuntime(page);
      activateResearchNode(runtime, nodeId);
      applyProjection(page, runtime.result, { persistent: runtime.persistentDirty });
      simulation.refresh();
    },
  });

  const simulation = createResearchSimulationController({
    getRuntime: (pageId) => {
      const page = session.page(pageId);
      return page ? ensureRuntime(page) : null;
    },
    onUpdate: (pageId, result, meta) => {
      const page = session.page(pageId);
      if (page) applyProjection(page, result, meta);
    },
    onStateChange: (_pageId, state) => syncRunControls(state),
  });

  function visibleProjection(projection) {
    const result = {};
    Object.entries(projection || {}).forEach(([nodeId, item]) => {
      if (item && item.error && item.error.code === 'missing-input') result[nodeId] = { ...item, error: null, output: null, status: 'idle' };
      else result[nodeId] = item;
    });
    return result;
  }

  function ensureRuntime(page) {
    if (!page.runtime.computeCache) {
      page.runtime.computeCache = createResearchComputeRuntime(page.model.snapshot(), { registry });
      page.runtime.lastRun = page.runtime.computeCache.result;
      page.runtime.computeProjection = visibleProjection(page.runtime.lastRun.projection);
      page.runtime.topologyDirty = false;
    }
    return page.runtime.computeCache;
  }

  function applyProjection(page, result, meta = {}) {
    if (!page || !result) return;
    page.runtime.lastRun = result;
    page.runtime.computeProjection = visibleProjection(result.projection);
    if (page.id === renderedPageId) canvas.setComputeProjection(page.runtime.computeProjection);
    if (meta.persistent || page.runtime.computeCache && page.runtime.computeCache.persistentDirty) scheduleSave();
    if (selectedNodeId && page.id === renderedPageId) {
      const selected = page.model.node(selectedNodeId);
      if (selected && selected.type === 'probe') renderTrace(selected);
    }
  }

  function cancelCompute() {
    if (computeFrame) cancelAnimationFrame(computeFrame);
    computeFrame = 0;
    computeRevision += 1;
  }

  function scheduleCompute(pageId = renderedPageId) {
    if (computeFrame) cancelAnimationFrame(computeFrame);
    const revision = ++computeRevision;
    computeFrame = requestAnimationFrame(() => {
      computeFrame = 0;
      if (disposed || revision !== computeRevision) return;
      const page = session.page(pageId);
      if (!page || page.id !== renderedPageId) return;
      let runtime = page.runtime.computeCache;
      if (!runtime) runtime = ensureRuntime(page);
      else if (page.runtime.topologyDirty) {
        updateResearchComputeRuntime(runtime, page.model.snapshot(), { topology: true });
        page.runtime.topologyDirty = false;
        page.runtime.dirtyNodeIds.clear();
      } else if (page.runtime.dirtyNodeIds.size) {
        const dirty = new Set(page.runtime.dirtyNodeIds);
        const nodes = Array.from(dirty).map((id) => page.model.node(id)).filter(Boolean);
        updateResearchComputeRuntime(runtime, { nodes }, { dirtyNodeIds: dirty });
        page.runtime.dirtyNodeIds.clear();
      }
      applyProjection(page, runtime.result, { persistent: runtime.persistentDirty });
    });
  }

  function bindModel() {
    if (modelUnsubscribe) modelUnsubscribe();
    const page = session.page(renderedPageId);
    modelUnsubscribe = page.model.subscribe((change) => {
      updateDeleteVisibility();
      scheduleSave();
      if (change && change.kind === 'node-move') return;
      if (change && change.topology) {
        page.runtime.topologyDirty = true;
        page.runtime.dirtyNodeIds.clear();
      } else (change && change.nodeIds || []).forEach((id) => page.runtime.dirtyNodeIds.add(String(id)));
      scheduleCompute(page.id);
      if (selectedNodeId) renderInspector(page.model.node(selectedNodeId));
    });
  }

  function setPersistenceStatus(message, state = '') {
    if (saveStatusTimer) clearTimeout(saveStatusTimer);
    persistenceStatus.textContent = String(message || '');
    persistenceStatus.dataset.state = state;
    persistenceStatus.hidden = !message;
    if (state === 'saved') saveStatusTimer = setTimeout(() => { persistenceStatus.hidden = true; }, 1200);
  }

  if (persistenceBlocked) setPersistenceStatus('研究数据暂时无法读取；已停止自动保存', 'error');
  else if (loadedWorkspace.legacyDiscarded) setPersistenceStatus('旧版研究数据已放弃，已创建 V2 空白工作区', 'warning');
  else if (loadedWorkspace.recovered) setPersistenceStatus('研究数据已安全恢复', 'warning');

  function currentDocument() {
    const page = session.page(renderedPageId);
    if (page) session.setPageView(page.id, canvas.getViewState());
    return session.toDocument((record) => record.runtime.computeCache
      ? snapshotPersistentResearchState(record.runtime.computeCache) : {});
  }

  function scheduleSave(delay = SAVE_DELAY_MS) {
    if (persistenceBlocked || disposed) return;
    saveDirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = 0; flushSave(); }, Math.max(0, delay));
  }

  function flushSave(options = {}) {
    if (persistenceBlocked || (!saveDirty && !options.force)) return saveInFlight || Promise.resolve(null);
    if (saveTimer) clearTimeout(saveTimer);
    if (saveRetryTimer) clearTimeout(saveRetryTimer);
    saveTimer = 0; saveRetryTimer = 0;
    if (saveInFlight) { saveDirty = true; return saveInFlight; }
    const document = currentDocument(); const expectedRevision = persistenceRevision;
    saveDirty = false; setPersistenceStatus('正在保存…', 'saving');
    let completed = false;
    saveInFlight = saveResearchWorkspace(document, expectedRevision, options).then((result) => {
      persistenceRevision = String(result.revision || ''); completed = true; setPersistenceStatus('已保存', 'saved'); return result;
    }).catch((error) => {
      saveDirty = true;
      if (disposed) return null;
      if (error && error.code === 'revision-conflict') {
        persistenceBlocked = true; setPersistenceStatus('其他窗口已更新研究数据；请重新打开', 'error');
      } else {
        setPersistenceStatus('保存失败，稍后自动重试', 'error');
        saveRetryTimer = setTimeout(() => { saveRetryTimer = 0; flushSave(); }, SAVE_RETRY_MS);
      }
      return null;
    }).finally(() => {
      saveInFlight = null;
      if (completed && saveDirty && !persistenceBlocked) scheduleSave(0);
    });
    return saveInFlight;
  }

  function renderRail() {
    const fragment = document.createDocumentFragment();
    const orb = document.createElement('span'); orb.className = 'research-page-orb'; orb.dataset.researchPageOrb = '';
    fragment.appendChild(orb);
    session.pages().forEach((page, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'research-page-button';
      button.dataset.researchPageId = page.id; button.textContent = String(index + 1);
      button.classList.toggle('is-active', page.id === session.activePageId);
      button.setAttribute('aria-label', `研究页 ${index + 1}`);
      if (page.id === session.activePageId) button.setAttribute('aria-current', 'page');
      fragment.appendChild(button);
    });
    railList.replaceChildren(fragment);
    const activeButton = railList.querySelector('.is-active');
    if (activeButton) orb.style.transform = `translate3d(0,${activeButton.offsetTop}px,0)`;
  }

  function updateDeleteVisibility() { pageDelete.hidden = !session.canDeleteActivePage(); }

  function applyPage(pageId) {
    const page = session.page(pageId);
    if (!page) return false;
    const current = session.page(renderedPageId);
    if (current) session.setPageView(current.id, canvas.getViewState());
    session.activatePage(page.id); renderedPageId = page.id; selectedNodeId = '';
    canvas.setModel(page.model, page.view); bindModel();
    const runtime = ensureRuntime(page); canvas.setComputeProjection(page.runtime.computeProjection);
    speedSelect.value = String(page.simulation.speed);
    simulation.selectPage(page.id, page.simulation.speed);
    renderRail(); updateDeleteVisibility(); renderInspector(null); scheduleSave();
    return !!runtime;
  }

  function createPage() {
    const page = session.createPage({ activate: false });
    renderRail(); scheduleSave(); applyPage(page.id);
  }

  function deletePage() {
    const result = session.deleteActiveEmptyPage();
    if (!result) return;
    simulation.removePage(result.removed.id); renderRail(); scheduleSave(); applyPage(result.active.id);
  }

  function renderPalette(query = '') {
    query = String(query || '').trim().toLowerCase();
    const fragment = document.createDocumentFragment();
    registry.categories.forEach((category) => {
      const definitions = registry.definitions().filter((definition) => definition.category === category.id
        && (!query || definition.label.toLowerCase().includes(query) || definition.type.includes(query)));
      if (!definitions.length) return;
      const section = document.createElement('section');
      const heading = document.createElement('h3'); heading.textContent = category.label; section.appendChild(heading);
      const row = document.createElement('div');
      definitions.forEach((definition) => {
        const button = document.createElement('button'); button.type = 'button';
        button.dataset.researchNodeType = definition.type; button.textContent = definition.label; row.appendChild(button);
      });
      section.appendChild(row); fragment.appendChild(section);
    });
    paletteList.replaceChildren(fragment);
  }

  function setPaletteOpen(open) {
    palette.hidden = !open; addButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { renderPalette(paletteSearch.value); requestAnimationFrame(() => paletteSearch.focus({ preventScroll: true })); }
  }

  function setMode(mode) {
    canvas.setInteractionMode(mode);
    dock.querySelectorAll('[data-research-mode]').forEach((button) => {
      const selected = button.dataset.researchMode === mode;
      button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function syncRunControls(state) {
    dock.querySelector('[data-research-run]').classList.toggle('is-active', !!state.running);
    dock.querySelector('[data-research-pause]').classList.toggle('is-active', !state.running);
    speedSelect.value = String(state.speed || 1);
  }

  function appendTypedValueControl(container, field, value, onChange) {
    const type = document.createElement('select');
    ['number', 'boolean', 'string', 'time', 'bits'].forEach((name) => {
      const option = document.createElement('option'); option.value = name; option.textContent = name; type.appendChild(option);
    });
    type.value = value.type;
    const input = document.createElement('input'); input.type = value.type === 'boolean' ? 'checkbox' : 'text';
    if (value.type === 'boolean') input.checked = value.value; else input.value = value.type === 'bits' ? value.value : String(value.value);
    const width = document.createElement('input'); width.type = 'number'; width.min = '1'; width.max = '64'; width.value = String(value.width || 8); width.hidden = value.type !== 'bits';
    const commit = () => {
      const selectedType = type.value;
      let next;
      if (selectedType === 'boolean') next = { type: 'boolean', value: input.checked };
      else if (selectedType === 'bits') next = { type: 'bits', width: Number(width.value), value: input.value || '0x0' };
      else if (selectedType === 'number' || selectedType === 'time') next = { type: selectedType, value: Number(input.value) };
      else next = { type: 'string', value: input.value };
      onChange(next);
    };
    type.addEventListener('change', () => {
      input.type = type.value === 'boolean' ? 'checkbox' : 'text'; width.hidden = type.value !== 'bits';
      if (type.value === 'boolean') input.checked = false; else input.value = type.value === 'bits' ? '0x0' : '';
      commit();
    });
    input.addEventListener('change', commit); input.addEventListener('blur', commit);
    width.addEventListener('change', commit); width.addEventListener('blur', commit);
    container.append(type, input, width);
  }

  function renderTrace(node) {
    if (!node || node.type !== 'probe') {
      tracePanel.hidden = true; traceSummary.textContent = ''; traceList.replaceChildren(); return;
    }
    const page = session.page(renderedPageId);
    const projection = page && page.runtime.computeProjection && page.runtime.computeProjection[node.id];
    const entries = projection && Array.isArray(projection.trace) ? projection.trace : [];
    const limit = Number(projection && projection.traceLimit || node.config.historyLimit || 64);
    tracePanel.hidden = false;
    traceSummary.textContent = entries.length ? `已记录 ${entries.length}/${limit}，新记录在上`
      : `尚无记录 · 上限 ${limit}`;
    const fragment = document.createDocumentFragment();
    entries.slice().reverse().forEach((entry) => {
      const row = document.createElement('li'); row.dataset.traceKind = entry.kind;
      const time = document.createElement('time'); time.textContent = `t=${Number(entry.simulationTime) || 0} ms`;
      const source = document.createElement('span');
      const label = entry.source && (entry.source.label || entry.source.nodeId) || '未知来源';
      const port = entry.source && entry.source.portId ? '.' + entry.source.portId : '';
      source.textContent = label + port;
      const value = document.createElement('code');
      value.textContent = entry.kind === 'event' ? `Pulse #${entry.sequence}` : formatResearchValue(entry.value);
      row.append(time, source, value); fragment.appendChild(row);
    });
    traceList.replaceChildren(fragment);
  }

  function renderInspector(node) {
    if (!node) { inspector.hidden = true; inspectorFields.replaceChildren(); renderTrace(null); return; }
    const definition = registry.definition(node.type);
    if (!definition) { inspector.hidden = true; return; }
    inspector.hidden = false; inspectorTitle.textContent = definition.label + ' · 属性';
    const fragment = document.createDocumentFragment();
    const labelRow = document.createElement('label'); labelRow.textContent = '标签';
    const labelInput = document.createElement('input'); labelInput.type = 'text'; labelInput.value = node.label;
    const commitLabel = () => session.page(renderedPageId).model.updateNode(node.id, { label: labelInput.value });
    labelInput.addEventListener('change', commitLabel); labelInput.addEventListener('blur', commitLabel);
    labelRow.appendChild(labelInput); fragment.appendChild(labelRow);
    definition.configFields.forEach((field) => {
      const row = document.createElement('label'); row.textContent = field.label;
      const commit = (value) => {
        const live = session.page(renderedPageId).model.node(node.id);
        session.page(renderedPageId).model.updateNode(node.id, { config: { ...live.config, [field.key]: value } });
      };
      if (field.type === 'select') {
        const select = document.createElement('select');
        field.options.forEach((optionName) => { const option = document.createElement('option'); option.value = optionName; option.textContent = optionName; select.appendChild(option); });
        select.value = node.config[field.key]; select.addEventListener('change', () => commit(select.value)); row.appendChild(select);
      } else if (field.type === 'integer') {
        const input = document.createElement('input'); input.type = 'number'; input.min = String(field.min); input.max = String(field.max); input.value = String(node.config[field.key]);
        input.addEventListener('change', () => commit(Number(input.value)));
        input.addEventListener('blur', () => commit(Number(input.value))); row.appendChild(input);
      } else if (field.type === 'boolean') {
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!node.config[field.key];
        input.addEventListener('change', () => commit(input.checked)); row.appendChild(input);
      } else if (field.type === 'typedValue') appendTypedValueControl(row, field, clone(node.config[field.key]), commit);
      fragment.appendChild(row);
    });
    if (definition.stateful) {
      const row = document.createElement('label'); row.className = 'research-persist-row'; row.textContent = '重开后保留状态';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = node.statePolicy === 'persist';
      input.addEventListener('change', () => session.page(renderedPageId).model.updateNode(node.id, { statePolicy: input.checked ? 'persist' : 'reset' }));
      row.appendChild(input); fragment.appendChild(row);
    }
    inspectorFields.replaceChildren(fragment);
    renderTrace(node);
  }

  function installListeners() {
    activeController = new AbortController(); const signal = activeController.signal;
    dock.addEventListener('click', (event) => {
      const mode = event.target.closest('[data-research-mode]');
      if (mode) { setMode(mode.dataset.researchMode); setPaletteOpen(false); return; }
      if (event.target.closest('[data-research-add]')) { setPaletteOpen(palette.hidden); return; }
      if (event.target.closest('[data-research-run]')) simulation.run();
      else if (event.target.closest('[data-research-pause]')) { simulation.pause(); scheduleSave(0); }
      else if (event.target.closest('[data-research-step]')) simulation.step();
      else if (event.target.closest('[data-research-reset]')) simulation.reset();
    }, { signal });
    speedSelect.addEventListener('change', () => {
      const speed = Number(speedSelect.value); simulation.setSpeed(speed);
      if (session.setPageSpeed(renderedPageId, speed)) scheduleSave();
    }, { signal });
    paletteSearch.addEventListener('input', () => renderPalette(paletteSearch.value), { signal });
    paletteList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-research-node-type]');
      if (!button) return;
      canvas.setCreationTool(button.dataset.researchNodeType); setMode('select'); setPaletteOpen(false); viewport.focus({ preventScroll: true });
    }, { signal });
    inspectorClose.addEventListener('click', () => { inspector.hidden = true; }, { signal });
    traceClear.addEventListener('click', () => {
      const page = session.page(renderedPageId);
      const node = page && page.model.node(selectedNodeId);
      if (!page || !node || node.type !== 'probe') return;
      const runtime = ensureRuntime(page);
      clearResearchTrace(runtime, node.id);
      applyProjection(page, runtime.result);
    }, { signal });
    railList.addEventListener('click', (event) => { const button = event.target.closest('[data-research-page-id]'); if (button) applyPage(button.dataset.researchPageId); }, { signal });
    railAdd.addEventListener('click', createPage, { signal });
    pageDelete.addEventListener('click', deletePage, { signal });
    helpOpen.addEventListener('click', () => { helpOverlay.hidden = false; helpOpen.setAttribute('aria-expanded', 'true'); helpClose.focus({ preventScroll: true }); }, { signal });
    helpClose.addEventListener('click', () => { helpOverlay.hidden = true; helpOpen.setAttribute('aria-expanded', 'false'); helpOpen.focus({ preventScroll: true }); }, { signal });
    helpOverlay.addEventListener('mousedown', (event) => { if (event.target === helpOverlay) helpClose.click(); }, { signal });
    document.addEventListener('visibilitychange', () => {
      simulation.setVisible(!document.hidden);
      if (document.hidden) scheduleSave(0);
    }, { signal });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !helpOverlay.hidden) { event.preventDefault(); helpClose.click(); }
      else if (event.key === '?' && helpOverlay.hidden && !event.target.closest('input,select,textarea,[contenteditable="true"]')) { event.preventDefault(); helpOpen.click(); }
    }, { capture: true, signal });
    stage.addEventListener('pointerdown', (event) => {
      if (!palette.hidden && !palette.contains(event.target) && !addButton.contains(event.target)) setPaletteOpen(false);
    }, { signal });
    const revealRail = () => {
      if (railHideTimer) clearTimeout(railHideTimer);
      railHideTimer = 0;
      rail.classList.add('is-revealed');
    };
    const scheduleRailHide = () => {
      if (railHideTimer) clearTimeout(railHideTimer);
      railHideTimer = setTimeout(() => {
        railHideTimer = 0;
        if (!rail.matches(':hover') && !railHotspot.matches(':hover')) rail.classList.remove('is-revealed');
      }, 120);
    };
    railHotspot.addEventListener('pointerenter', revealRail, { signal });
    railHotspot.addEventListener('pointerleave', scheduleRailHide, { signal });
    rail.addEventListener('pointerenter', revealRail, { signal });
    rail.addEventListener('pointerleave', scheduleRailHide, { signal });
  }

  bindModel(); renderRail(); renderPalette(); updateDeleteVisibility();
  ensureRuntime(session.activePage()); canvas.setComputeProjection(session.activePage().runtime.computeProjection);
  simulation.selectPage(renderedPageId, session.activePage().simulation.speed);
  setMode('select');

  function activate() {
    if (disposed || active) return !disposed;
    active = true; installListeners(); canvas.activate(); simulation.activate(); scheduleCompute(); return true;
  }

  function suspend() {
    if (disposed) return true;
    simulation.suspend(); cancelCompute();
    if (railHideTimer) clearTimeout(railHideTimer); railHideTimer = 0; rail.classList.remove('is-revealed');
    if (activeController) activeController.abort(); activeController = null;
    session.setPageView(renderedPageId, canvas.getViewState());
    scheduleSave(0);
    active = false; return canvas.suspend();
  }

  function dispose() {
    if (disposed) return true;
    suspend(); flushSave({ force: true, keepalive: true }); disposed = true;
    if (saveTimer) clearTimeout(saveTimer); if (saveRetryTimer) clearTimeout(saveRetryTimer); if (saveStatusTimer) clearTimeout(saveStatusTimer);
    if (railHideTimer) clearTimeout(railHideTimer); railHideTimer = 0;
    simulation.dispose(); if (modelUnsubscribe) modelUnsubscribe(); modelUnsubscribe = null;
    return canvas.dispose();
  }

  return Object.freeze({ activate, suspend, dispose });
}
