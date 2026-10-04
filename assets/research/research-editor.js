import { createResearchModel } from './research-model.js';
import { createResearchPageSession } from './research-pages.js';
import { createResearchCanvas } from './research-canvas.js';
import { SYMBOL_TYPES, LINE_COLORS } from './research-orthogonal.js';
import { SYMBOL_LABELS, defaultSymbol, symbolTemplateDefaults } from './research-symbols.js';
import { buildSymbolControls, renderSymbolPreview, disposeSymbolPreviews, suspendSymbolPreviews } from './research-symbol-controls.js';
import {
  activateResearchNode, clearResearchTrace, createResearchComputeRuntime, snapshotPersistentResearchState,
  updateResearchComputeRuntime,
} from './research-compute.js';
import { createResearchSimulationController } from './research-runtime.js';
import { loadResearchRegistry } from './research-registry.js';
import { validateResearchDocument } from './research-schema.js';
import { loadResearchWorkspace, saveResearchWorkspace } from './research-persistence.js';
import { formatResearchValue } from './research-values.js';
import { createResearchTutorial } from './research-tutorial.js';
import {
  buildSubcircuitRevisionFromSelection, canUpgradeSubcircuitInstance,
  collectSubcircuitReferences, createResearchSubcircuitCatalog,
  replaceSelectionWithSubcircuit, validateSubcircuitDependencies,
} from './research-subcircuits.js';

const SAVE_DELAY_MS = 350;
const SAVE_RETRY_MS = 1800;
const SIDE_PANEL_COLLAPSED_KEY = 'research:sidePanelCollapsed:v1';
const COMPUTE_DOCK_COLLAPSED_KEY = 'research:computeDockCollapsed:v1';
const CONNECTION_KIND_KEY = 'research:connectionKind:v1';
const EDITOR_MODE_KEY = 'research:editorMode:v1';
const QUICK_SYMBOLS = ['rectangle', 'capacitor', 'inductor', 'voltage-source', 'current-source', 'switch', 'lamp', 'dot', 'ground'];
const COLOR_LABELS = { mono: '黑白色', blue: '蓝色', red: '红色', green: '绿色' };

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

export async function createResearchEditor(stage) {
  if (!stage) throw new Error('研究工作区舞台不存在');
  const T = (source) => window.RelatumI18n ? window.RelatumI18n.t(source) : String(source || '');
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
  const dockCollapse = required('[data-research-dock-collapse]');
  const addButton = required('[data-research-add]');
  const sidePanel = required('[data-research-side-panel]');
  const sidePanelBody = required('.research-side-panel-body');
  const nodeLibrary = required('[data-research-node-library]');
  const paletteSearch = required('[data-research-add-search]');
  const paletteList = required('[data-research-add-list]');
  const inspector = required('[data-research-inspector]');
  const inspectorTitle = required('[data-research-inspector-title]');
  const inspectorFields = required('[data-research-inspector-fields]');
  const inspectorClose = required('[data-research-inspector-close]');
  const selectionSummary = required('[data-research-selection-summary]');
  const selectionCopy = required('[data-research-selection-copy]');
  const selectionDuplicate = required('[data-research-selection-duplicate]');
  const tracePanel = required('[data-research-trace]');
  const traceSummary = required('[data-research-trace-summary]');
  const traceList = required('[data-research-trace-list]');
  const traceClear = required('[data-research-trace-clear]');
  const speedSelect = required('[data-research-speed]');
  const subcircuitCreate = required('[data-research-subcircuit-create]');
  const subcircuitOverlay = required('[data-research-subcircuit-overlay]');
  const subcircuitTarget = required('[data-research-subcircuit-target]');
  const subcircuitName = required('[data-research-subcircuit-name]');
  const subcircuitNameRow = required('[data-research-subcircuit-name-row]');
  const subcircuitSummary = required('[data-research-subcircuit-summary]');
  const subcircuitPorts = required('[data-research-subcircuit-ports]');
  const subcircuitConfirm = required('[data-research-subcircuit-confirm]');
  const helpOpen = required('[data-research-help-open]');
  const helpOverlay = required('[data-research-help-overlay]');
  const helpClose = required('[data-research-help-close]');
  const tutorialRoot = required('[data-research-tutorial-root]');
  const settingsOpen = required('[data-research-settings-open]');
  const settingsPanel = required('[data-research-settings-panel]');
  const settingsResetOpen = required('[data-research-settings-reset-open]');
  const settingsResetConfirm = required('[data-research-settings-reset-confirm]');
  const settingsResetCancel = required('[data-research-settings-reset-cancel]');
  const settingsResetAccept = required('[data-research-settings-reset-accept]');
  const panSpeedInput = required('[data-research-pan-speed]');
  const panInertiaInput = required('[data-research-pan-inertia]');
  const zoomSpeedInput = required('[data-research-zoom-speed]');
  const axisOpacityInput = required('[data-research-axis-opacity]');
  const panSpeedValue = required('[data-research-pan-speed-value]');
  const panInertiaValue = required('[data-research-pan-inertia-value]');
  const zoomSpeedValue = required('[data-research-zoom-speed-value]');
  const axisOpacityValue = required('[data-research-axis-opacity-value]');
  const coordinatesVisibleInput = required('[data-research-coordinates-visible]');
  const coordinateLabelsVisibleInput = required('[data-research-coordinate-labels-visible]');
  const centerOriginButton = required('[data-research-center-origin]');
  const persistenceStatus = required('[data-research-persistence-status]');
  const modeSelect = required('button[data-research-editor-mode]');
  const modeMenu = required('[data-research-mode-menu]');
  const modeLabel = required('[data-research-mode-label]');
  const defaultDockTools = required('[data-research-default-tools]');
  const orthogonalDockTools = required('[data-research-orthogonal-tools]');
  const quickSymbols = required('[data-research-quick-symbols]');
  const unitLengthInput = required('[data-research-unit-length]');
  const lineWidthInput = required('[data-research-line-width]');
  const endpointSizeInput = required('[data-research-endpoint-size]');
  let editorMode = 'default';
  let presetDialog = null, presetContextMenu = null, symbolPreview = null;
  let symbolLabelEditor = null;
  function finishLabelEdit(retry) {
    if (symbolLabelEditor?.isComposing()) {
      symbolLabelEditor.commit().then(() => { if (!disposed) retry(); }); return false;
    }
    symbolLabelEditor?.commit(); return true;
  }
  let dockResizeAnimation = null;
  let decorationControlCommit = false, renderedDecorationId = '';
  try { if (localStorage.getItem(EDITOR_MODE_KEY) === 'orthogonal') editorMode = 'orthogonal'; } catch (_error) {}

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

  const subcircuitCatalog = createResearchSubcircuitCatalog(loadedWorkspace.document && loadedWorkspace.document.subcircuits);
  registry.setSubcircuitCatalog(subcircuitCatalog);
  const session = createResearchPageSession({
    createModel: (state) => createResearchModel(state || { nodes: [], edges: [] }, registry),
    document: loadedWorkspace.document,
    subcircuitCatalog,
  });
  let renderedPageId = session.activePage().id;
  let disposed = false;
  let active = false;
  let activeController = null;
  let modelUnsubscribe = null;
  let computeFrame = 0;
  let computeRevision = 0;
  let selectedNodeId = '';
  let selectedNodeIds = [];
  let selectedEdgeId = '';
  let selectedEdgeIds = [];
  let pendingSubcircuit = null;
  let saveTimer = 0;
  let saveRetryTimer = 0;
  let saveStatusTimer = 0;
  let saveDirty = false;
  let saveInFlight = null;
  let railHideTimer = 0;
  let railOrbY = null;
  let railFlipTimer = 0;
  let railWheelAccum = 0;
  let railWheelTimer = 0;
  let pageSwitchMotion = null;
  let pageSwitchMotionId = 0;
  let sidePanelCollapsed = false;
  let dockCollapsed = false;
  let panelHitGuardTimer = 0;
  let subcircuitCloseTimer = 0;
  let subcircuitReturnFocus = null;
  let settingsCloseTimer = 0;
  let persistenceRevision = String(loadedWorkspace.revision || '');

  try {
    sidePanelCollapsed = localStorage.getItem(SIDE_PANEL_COLLAPSED_KEY) === '1';
    dockCollapsed = localStorage.getItem(COMPUTE_DOCK_COLLAPSED_KEY) === '1';
  } catch (_error) {}

  const canvas = createResearchCanvas({
    stage,
    registry,
    model: session.activePage().model,
    view: session.activePage().view,
    panSpeedInput,
    panInertiaInput,
    zoomSpeedInput,
    axisOpacityInput,
    panSpeedValue,
    panInertiaValue,
    zoomSpeedValue,
    axisOpacityValue,
    coordinatesVisibleInput,
    coordinateLabelsVisibleInput,
    onViewChange: (view) => {
      if (session.setPageView(renderedPageId, view)) scheduleSave();
    },
    onCreationToolChange: () => renderPalette(paletteSearch.value),
    onSelectionChange: (selection) => {
      selectedNodeIds = selection.nodeIds.slice();
      selectedEdgeIds = selection.edgeIds.slice();
      selectionDuplicate.hidden = selectedNodeIds.length === 0;
      subcircuitCreate.hidden = selectedNodeIds.length === 0;
      selectedNodeId = selection.primaryNode ? selection.primaryNode.id : '';
      selectedEdgeId = selection.primaryEdge ? selection.primaryEdge.id : '';
      if (editorMode === 'orthogonal') { renderDecorationSelection(selection); return; }
      renderSelectionPanel(selection);
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

  const tutorial = createResearchTutorial({
    canInsert: () => editorMode === 'default',
    openButton: helpOpen,
    overlay: helpOverlay,
    closeButton: helpClose,
    root: tutorialRoot,
    canvas,
    getModel: () => {
      const page = session.page(renderedPageId);
      return page ? page.model : null;
    },
    beforeOpen: () => closeSettingsPanel({ focus: false, immediate: true }),
    onInserted: (title) => setPersistenceStatus(`已生成“${title}”，可按 Ctrl+Z 整组撤销`, 'saved'),
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
    if (page.id === renderedPageId) {
      canvas.setComputeProjection(page.runtime.computeProjection, {
        deferred: !!meta.simulation && !meta.step && !meta.reset,
      });
    }
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
    if (editorMode === 'orthogonal') return;
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
      if (change.decorationsOnly && change.live) return;
      scheduleSave();
      if (change.decorationsOnly) return;
      if (change && change.kind === 'node-move') return;
      if (change && change.topology) {
        page.runtime.topologyDirty = true;
        page.runtime.dirtyNodeIds.clear();
      } else (change && change.nodeIds || []).forEach((id) => page.runtime.dirtyNodeIds.add(String(id)));
      scheduleCompute(page.id);
      if (selectedNodeId) renderInspector(page.model.node(selectedNodeId));
      else if (selectedEdgeId) renderEdgeInspector(page.model.edge(selectedEdgeId));
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
  else if (loadedWorkspace.legacyDiscarded) setPersistenceStatus('旧版研究数据已放弃，已创建 V3 空白工作区', 'warning');
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
    saveDirty = false;
    let completed = false;
    saveInFlight = saveResearchWorkspace(document, expectedRevision, options).then((result) => {
      persistenceRevision = String(result.revision || ''); completed = true; setPersistenceStatus(''); return result;
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

  function prefersReducedMotion() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function clearRailTransients() {
    if (railFlipTimer) clearTimeout(railFlipTimer);
    railFlipTimer = 0;
    rail.classList.remove('is-flipping');
    rail.style.height = '';
    rail.querySelectorAll('.is-ghost').forEach((element) => element.remove());
    railList.querySelectorAll('.is-flip').forEach((element) => {
      element.classList.remove('is-flip');
      element.style.transform = '';
      element.style.opacity = '';
    });
    railAdd.classList.remove('is-flip');
    railAdd.style.transform = '';
    railAdd.style.opacity = '';
    const maxScroll = Math.max(0, railList.scrollHeight - railList.clientHeight);
    if (railList.scrollTop > maxScroll) railList.scrollTop = maxScroll;
  }

  function railSnapshot() {
    clearRailTransients();
    const activeButton = railList.querySelector('.research-page-button.is-active');
    return {
      activeId: activeButton ? activeButton.dataset.researchPageId : '',
      buttons: Array.from(railList.querySelectorAll('.research-page-button')).map((button) => ({
        element: button,
        pageId: button.dataset.researchPageId,
        y: button.getBoundingClientRect().top,
      })),
      addY: railAdd.getBoundingClientRect().top,
      height: rail.getBoundingClientRect().height,
      orbY: railOrbY,
      scrollTop: railList.scrollTop,
    };
  }

  function animateRailChange(snapshot) {
    if (!snapshot || snapshot.initial || prefersReducedMotion()) return;
    const live = new Map(Array.from(railList.querySelectorAll('.research-page-button'))
      .map((button) => [button.dataset.researchPageId, button]));
    const oldById = new Map(snapshot.buttons.map((item) => [item.pageId, item]));
    const addedIds = session.pages().map((page) => page.id).filter((id) => !oldById.has(id));
    const removed = snapshot.buttons.filter((item) => !live.has(item.pageId));
    const scrollDelta = railList.scrollTop - snapshot.scrollTop;
    const shifts = [];
    snapshot.buttons.forEach((item) => {
      const element = live.get(item.pageId);
      if (!element) return;
      const dy = item.y - (element.getBoundingClientRect().top + scrollDelta);
      if (Math.abs(dy) > 0.5) shifts.push({ element, dy });
    });
    const addDy = snapshot.addY - railAdd.getBoundingClientRect().top;
    const newHeight = rail.getBoundingClientRect().height;
    if (!addedIds.length && !removed.length && !shifts.length
      && Math.abs(addDy) < 0.5 && Math.abs(newHeight - snapshot.height) < 0.5) return;

    shifts.forEach(({ element, dy }) => { element.style.transform = `translate3d(0,${dy}px,0)`; });
    if (Math.abs(addDy) >= 0.5) railAdd.style.transform = `translate3d(0,${addDy}px,0)`;
    addedIds.forEach((id) => {
      const element = live.get(id);
      if (!element) return;
      const dy = snapshot.addY - (element.getBoundingClientRect().top + scrollDelta);
      element.style.transform = `translate3d(0,${dy}px,0) scale(0.3)`;
      element.style.opacity = '0';
    });
    const railTop = rail.getBoundingClientRect().top;
    const ghostDrift = (newHeight - snapshot.height) / 2;
    removed.forEach((item) => {
      const ghost = item.element;
      ghost.classList.add('is-ghost');
      ghost.style.top = `${item.y - railTop}px`;
      if (Math.abs(ghostDrift) >= 0.5) ghost.style.transform = `translate3d(0,${ghostDrift}px,0)`;
      rail.appendChild(ghost);
    });
    rail.style.height = `${snapshot.height}px`;
    rail.classList.add('is-flipping');
    void rail.offsetHeight;
    shifts.forEach(({ element }) => { element.classList.add('is-flip'); element.style.transform = ''; });
    if (Math.abs(addDy) >= 0.5) { railAdd.classList.add('is-flip'); railAdd.style.transform = ''; }
    addedIds.forEach((id) => {
      const element = live.get(id);
      if (!element) return;
      element.classList.add('is-flip'); element.style.transform = ''; element.style.opacity = '';
    });
    removed.forEach((item) => { item.element.style.transform = ''; item.element.classList.add('is-ghost-out'); });
    rail.style.height = `${newHeight}px`;
    railFlipTimer = setTimeout(clearRailTransients, 320);
  }

  function renderRail(options = {}) {
    const snapshot = options.initial ? {
      activeId: '', buttons: [], addY: railAdd.getBoundingClientRect().top,
      height: rail.getBoundingClientRect().height, orbY: null, scrollTop: 0, initial: true,
    } : (options.snapshot || railSnapshot());
    const activePageId = String(options.activePageId || session.activePageId || '');
    const fragment = document.createDocumentFragment();
    const orb = document.createElement('span'); orb.className = 'research-page-orb'; orb.dataset.researchPageOrb = '';
    fragment.appendChild(orb);
    session.pages().forEach((page, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'research-page-button';
      button.dataset.researchPageId = page.id; button.textContent = String(index + 1);
      button.classList.toggle('is-active', page.id === activePageId);
      button.setAttribute('aria-label', `研究页 ${index + 1}`);
      if (page.id === activePageId) button.setAttribute('aria-current', 'page');
      fragment.appendChild(button);
    });
    railList.replaceChildren(fragment);
    railList.scrollTop = snapshot.scrollTop;
    const activeButton = railList.querySelector('.is-active');
    if (activeButton && activePageId !== snapshot.activeId && railList.clientHeight < railList.scrollHeight) {
      const activeTop = activeButton.offsetTop;
      const activeBottom = activeTop + activeButton.offsetHeight;
      if (activeTop < railList.scrollTop) railList.scrollTop = activeTop;
      else if (activeBottom > railList.scrollTop + railList.clientHeight) {
        railList.scrollTop = activeBottom - railList.clientHeight;
      }
    }
    const toY = activeButton ? activeButton.offsetTop : 0;
    const fromY = snapshot.orbY;
    const animateOrb = fromY != null && fromY !== toY && !prefersReducedMotion();
    orb.classList.add('no-transition');
    orb.style.transform = `translate3d(0,${animateOrb ? fromY : toY}px,0)`;
    void orb.offsetWidth;
    if (animateOrb) orb.classList.remove('no-transition');
    orb.style.transform = `translate3d(0,${toY}px,0)`;
    if (!animateOrb) orb.classList.remove('no-transition');
    railOrbY = toY;
    animateRailChange(snapshot);
  }

  function previewRailTarget(pageId) {
    let target = null;
    railList.querySelectorAll('.research-page-button').forEach((button) => {
      const selected = button.dataset.researchPageId === pageId;
      button.classList.toggle('is-active', selected);
      if (selected) { button.setAttribute('aria-current', 'page'); target = button; }
      else button.removeAttribute('aria-current');
    });
    if (!target) return false;
    const targetTop = target.offsetTop;
    const targetBottom = targetTop + target.offsetHeight;
    if (targetTop < railList.scrollTop) railList.scrollTop = targetTop;
    else if (targetBottom > railList.scrollTop + railList.clientHeight) {
      railList.scrollTop = targetBottom - railList.clientHeight;
    }
    const orb = railList.querySelector('[data-research-page-orb]');
    if (orb) {
      orb.classList.remove('no-transition');
      railOrbY = targetTop;
      orb.style.transform = `translate3d(0,${railOrbY}px,0)`;
    }
    return true;
  }

  function updateDeleteVisibility() { pageDelete.hidden = !session.canDeleteActivePage(); }

  function applyPageNow(pageId, options = {}) {
    const page = session.page(pageId);
    if (!page) return false;
    const current = session.page(renderedPageId);
    if (current) session.setPageView(current.id, canvas.getViewState());
    session.activatePage(page.id); renderedPageId = page.id; selectedNodeId = ''; selectedNodeIds = [];
    selectedEdgeId = ''; selectedEdgeIds = [];
    canvas.setModel(page.model, page.view); bindModel();
    const runtime = ensureRuntime(page); canvas.setComputeProjection(page.runtime.computeProjection);
    speedSelect.value = String(page.simulation.speed);
    simulation.selectPage(page.id, page.simulation.speed);
    if (editorMode === 'orthogonal') simulation.pause();
    if (options.renderRail !== false) renderRail();
    updateDeleteVisibility(); showLibrary(); scheduleSave();
    return !!runtime;
  }

  function finishPageSwitchMotion(motion, preserveVisual = false) {
    if (!motion || pageSwitchMotion !== motion) return;
    if (motion.frame) cancelAnimationFrame(motion.frame);
    motion.frame = 0; motion.cancelled = true; pageSwitchMotion = null;
    if (preserveVisual) return;
    viewport.style.opacity = '';
    viewport.style.transform = '';
    viewport.classList.remove('is-page-switching');
  }

  function settlePageSwitchMotion() {
    const motion = pageSwitchMotion;
    if (!motion) return false;
    const targetPageId = motion.targetPageId;
    const railAlreadyRendered = motion.railAlreadyRendered;
    finishPageSwitchMotion(motion);
    if (renderedPageId !== targetPageId) {
      applyPageNow(targetPageId, { renderRail: !railAlreadyRendered });
    } else {
      renderRail({ activePageId: targetPageId });
    }
    return true;
  }

  function tickPageSwitchMotion(motion, timestamp) {
    if (!active || disposed || motion.cancelled || pageSwitchMotion !== motion) {
      finishPageSwitchMotion(motion);
      return;
    }
    if (motion.startedAt == null) motion.startedAt = timestamp;
    const duration = motion.phase === 'out' ? motion.outDuration : 180;
    const progress = Math.min(1, (timestamp - motion.startedAt) / duration);
    const eased = motion.phase === 'out' ? progress * progress : 1 - Math.pow(1 - progress, 3);
    if (motion.phase === 'out') {
      motion.currentOpacity = motion.startOpacity * (1 - eased);
      motion.currentOffset = motion.startOffset + ((motion.direction * 8) - motion.startOffset) * eased;
    } else {
      motion.currentOpacity = eased;
      motion.currentOffset = motion.direction * 34 * (1 - eased);
    }
    viewport.style.opacity = String(Math.max(0, Math.min(1, motion.currentOpacity)));
    viewport.style.transform = `translate3d(${motion.currentOffset}px,0,0)`;
    if (progress < 1) {
      motion.frame = requestAnimationFrame((nextTimestamp) => tickPageSwitchMotion(motion, nextTimestamp));
      return;
    }
    if (motion.phase === 'out') {
      if (!applyPageNow(motion.targetPageId, { renderRail: !motion.railAlreadyRendered })) {
        finishPageSwitchMotion(motion); renderRail(); return;
      }
      motion.railAlreadyRendered = false;
      motion.phase = 'in'; motion.startedAt = null;
      motion.currentOpacity = 0; motion.currentOffset = motion.direction * 34;
      viewport.style.opacity = '0';
      viewport.style.transform = `translate3d(${motion.currentOffset}px,0,0)`;
      motion.frame = requestAnimationFrame((nextTimestamp) => tickPageSwitchMotion(motion, nextTimestamp));
      return;
    }
    finishPageSwitchMotion(motion);
  }

  function switchPage(pageId, options = {}) {
    if (!finishLabelEdit(() => switchPage(pageId, options))) return true;
    cancelSymbolPreview(); cancelDockResize(); closeModeMenu(); closePresetContextMenu(); closePresetDialog();
    const page = session.page(pageId);
    if (!page) return false;
    if (!pageSwitchMotion && page.id === renderedPageId) return false;
    if (pageSwitchMotion && pageSwitchMotion.targetPageId === page.id) return true;
    const oldMotion = pageSwitchMotion;
    const startOpacity = oldMotion ? oldMotion.currentOpacity : 1;
    const startOffset = oldMotion ? oldMotion.currentOffset : 0;
    if (oldMotion) finishPageSwitchMotion(oldMotion, true);
    const fromIndex = session.indexOf(renderedPageId);
    const toIndex = session.indexOf(page.id);
    const direction = options.direction || (toIndex < fromIndex ? -1 : 1);
    // 数字、高亮与滑块已经在点击瞬间完成目标态同步；页面交换到透明点时
    // 不要重建 rail，否则新滑块会截断仍在进行的位移动画并直接跳到终点。
    const railAlreadyRendered = options.railAlreadyRendered === true || previewRailTarget(page.id);
    if (prefersReducedMotion()) {
      viewport.style.opacity = ''; viewport.style.transform = ''; viewport.classList.remove('is-page-switching');
      return applyPageNow(page.id, { renderRail: !railAlreadyRendered });
    }
    const motion = {
      id: ++pageSwitchMotionId,
      frame: 0,
      cancelled: false,
      phase: 'out',
      startedAt: null,
      targetPageId: page.id,
      direction: direction < 0 ? -1 : 1,
      startOpacity: Number.isFinite(startOpacity) ? startOpacity : 1,
      startOffset: Number.isFinite(startOffset) ? startOffset : 0,
      currentOpacity: Number.isFinite(startOpacity) ? startOpacity : 1,
      currentOffset: Number.isFinite(startOffset) ? startOffset : 0,
      outDuration: Math.max(24, 80 * Math.max(0.2, Math.min(1, startOpacity))),
      railAlreadyRendered,
    };
    pageSwitchMotion = motion;
    viewport.classList.add('is-page-switching');
    motion.frame = requestAnimationFrame((timestamp) => tickPageSwitchMotion(motion, timestamp));
    return true;
  }

  function resetRailWheel() {
    railWheelAccum = 0;
    if (railWheelTimer) clearTimeout(railWheelTimer);
    railWheelTimer = 0;
  }

  function createPage() {
    resetRailWheel(); settlePageSwitchMotion();
    const snapshot = railSnapshot();
    const page = session.createPage({ activate: false });
    scheduleSave();
    renderRail({ activePageId: page.id, snapshot });
    switchPage(page.id, { direction: 1, railAlreadyRendered: true });
  }

  function deletePage() {
    resetRailWheel(); settlePageSwitchMotion();
    const snapshot = railSnapshot();
    const result = session.deleteActiveEmptyPage();
    if (!result) return;
    simulation.removePage(result.removed.id);
    scheduleSave();
    renderRail({ activePageId: result.active.id, snapshot });
    switchPage(result.active.id, { direction: -1, railAlreadyRendered: true });
  }

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function setPanelView(view, title) {
    sidePanelBody.scrollTop = 0;
    nodeLibrary.hidden = view !== 'library';
    inspector.hidden = view !== 'inspector';
    selectionSummary.hidden = view !== 'selection';
    delete inspectorTitle.dataset.i18nSourceText;
    inspectorTitle.textContent = title;
  }

  function setSidePanelCollapsed(collapsed, persist = true) {
    sidePanelCollapsed = !!collapsed;
    if (sidePanelCollapsed && sidePanel.contains(document.activeElement)) {
      viewport.focus({ preventScroll: true });
    }
    sidePanel.classList.toggle('is-collapsed', sidePanelCollapsed);
    sidePanel.setAttribute('aria-hidden', sidePanelCollapsed ? 'true' : 'false');
    sidePanel.toggleAttribute('inert', sidePanelCollapsed);
    addButton.setAttribute('aria-expanded', sidePanelCollapsed ? 'false' : 'true');
    document.documentElement.classList.remove('research-side-panel-pref-collapsed');
    if (persist) {
      try { localStorage.setItem(SIDE_PANEL_COLLAPSED_KEY, sidePanelCollapsed ? '1' : '0'); } catch (_error) {}
    }
  }

  function setDockCollapsed(collapsed, persist = true) {
    closeModeMenu();
    dockCollapsed = !!collapsed;
    dock.classList.toggle('is-collapsed', dockCollapsed);
    const row = dock.querySelector('.research-compute-row');
    if (row) {
      row.setAttribute('aria-hidden', dockCollapsed ? 'true' : 'false');
      row.toggleAttribute('inert', dockCollapsed);
    }
    dockCollapse.setAttribute('aria-expanded', dockCollapsed ? 'false' : 'true');
    dockCollapse.setAttribute('aria-label', dockCollapsed ? '展开下方工具栏' : '收起下方工具栏');
    if (persist) {
      try { localStorage.setItem(COMPUTE_DOCK_COLLAPSED_KEY, dockCollapsed ? '1' : '0'); } catch (_error) {}
    }
  }

  function guardPanelHitTesting() {
    if (panelHitGuardTimer) clearTimeout(panelHitGuardTimer);
    sidePanel.classList.add('is-hit-guarded');
    panelHitGuardTimer = setTimeout(() => {
      panelHitGuardTimer = 0;
      sidePanel.classList.remove('is-hit-guarded');
    }, 360);
  }

  function showLibrary(options = {}) {
    setPanelView('library', editorMode === 'orthogonal' ? T('研究 · 装饰绘图') : '研究 · 添加节点');
    inspectorTitle.dataset.i18nSourceText = editorMode === 'orthogonal' ? '研究 · 装饰绘图' : '研究 · 添加节点';
    renderPalette(paletteSearch.value);
    renderTrace(null);
    if (options.expand) setSidePanelCollapsed(false);
    if (options.focusSearch) requestAnimationFrame(() => paletteSearch.focus({ preventScroll: true }));
  }

  function renderPalette(query = '') {
    if (editorMode === 'orthogonal') { renderDecorationPalette(query); return; }
    query = String(query || '').trim().toLowerCase();
    let creation = canvas.getCreationTool();
    if (creation.type === 'subcircuit' && (!creation.config
      || !subcircuitCatalog.revision(creation.config.definitionId, creation.config.revision))) {
      canvas.setCreationTool('note');
      return;
    }
    const fragment = document.createDocumentFragment();
    registry.categories.forEach((category) => {
      if (category.id === 'subcircuit') return;
      const definitions = registry.definitions().filter((definition) => definition.category === category.id
        && (!query || definition.label.toLowerCase().includes(query) || definition.type.includes(query)));
      if (!definitions.length) return;
      const section = document.createElement('section');
      const heading = document.createElement('h3'); heading.textContent = category.label; section.appendChild(heading);
      const row = document.createElement('div');
      definitions.forEach((definition) => {
        const button = document.createElement('button'); button.type = 'button';
        button.dataset.researchNodeType = definition.type; button.textContent = definition.label;
        const selected = creation.type === definition.type && creation.type !== 'subcircuit';
        button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        row.appendChild(button);
      });
      section.appendChild(row); fragment.appendChild(section);
    });
    const reusable = subcircuitCatalog.definitions().filter((definition) => !query
      || definition.name.toLowerCase().includes(query) || definition.id.toLowerCase().includes(query));
    if (reusable.length) {
      const section = document.createElement('section');
      const heading = document.createElement('h3'); heading.textContent = '子电路'; section.appendChild(heading);
      const row = document.createElement('div');
      reusable.forEach((definition) => {
        const button = document.createElement('button'); button.type = 'button';
        button.dataset.researchSubcircuitId = definition.id;
        button.dataset.researchSubcircuitRevision = String(definition.latestRevision);
        button.textContent = `${definition.name} · r${definition.latestRevision}`;
        const selected = creation.type === 'subcircuit' && creation.config
          && creation.config.definitionId === definition.id
          && Number(creation.config.revision) === Number(definition.latestRevision);
        button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        row.appendChild(button);
      });
      section.appendChild(row); fragment.appendChild(section);
    }
    paletteList.replaceChildren(fragment);
  }

  function renderSubcircuitDraft() {
    const page = session.page(renderedPageId);
    if (!page || !selectedNodeIds.length) return false;
    const targetId = subcircuitTarget.value === 'new' ? '' : subcircuitTarget.value;
    const targetDefinition = targetId && subcircuitCatalog.definition(targetId);
    const previous = targetDefinition && subcircuitCatalog.revision(targetId, targetDefinition.latestRevision);
    const built = buildSubcircuitRevisionFromSelection(page.model, selectedNodeIds, registry, previous);
    if (!built) return false;
    pendingSubcircuit = {
      ...built, nodeIds: selectedNodeIds.slice(), targetId,
      previousPorts: previous ? previous.ports.map((port) => ({ ...port })) : [],
    };
    subcircuitNameRow.hidden = !!targetDefinition;
    subcircuitSummary.textContent = `${built.revision.nodes.length} 个节点、${built.revision.edges.length} 条内部连线、${built.revision.ports.length} 个边界端口`;
    const fragment = document.createDocumentFragment();
    built.revision.ports.forEach((port) => {
      const row = document.createElement('div'); row.className = 'research-subcircuit-port-row'; row.dataset.portId = port.id;
      const direction = document.createElement('span'); direction.textContent = port.direction === 'input' ? '输入' : '输出';
      const name = document.createElement('input'); name.type = 'text'; name.value = port.name; name.dataset.portName = '';
      const type = document.createElement('select'); type.dataset.portType = '';
      type.disabled = port.channel === 'event' || !built.unresolvedPortIds.includes(port.id);
      const choices = port.channel === 'event' ? ['pulse'] : ['number', 'boolean', 'string', 'time', 'bits'];
      if (built.unresolvedPortIds.includes(port.id)) {
        const option = document.createElement('option'); option.value = ''; option.textContent = '请选择类型'; type.appendChild(option);
      }
      choices.forEach((choice) => { const option = document.createElement('option'); option.value = choice; option.textContent = choice; type.appendChild(option); });
      type.value = built.unresolvedPortIds.includes(port.id) ? '' : port.valueType;
      const width = document.createElement('input'); width.type = 'number'; width.min = '1'; width.max = '64'; width.value = String(port.bitsWidth || 8); width.dataset.portWidth = ''; width.hidden = port.valueType !== 'bits';
      type.addEventListener('change', () => { width.hidden = type.value !== 'bits'; });
      row.append(direction, name, type, width);
      if (previous) {
        row.classList.add('has-port-match');
        const match = document.createElement('select'); match.dataset.portMatch = '';
        const fresh = document.createElement('option'); fresh.value = ''; fresh.textContent = '新端口'; match.appendChild(fresh);
        previous.ports.filter((candidate) => candidate.direction === port.direction && candidate.channel === port.channel).forEach((candidate) => {
          const option = document.createElement('option'); option.value = candidate.id;
          option.textContent = `${candidate.name} · ${candidate.valueType}${candidate.valueType === 'bits' ? candidate.bitsWidth : ''}`;
          match.appendChild(option);
        });
        match.value = previous.ports.some((candidate) => candidate.id === port.id) ? port.id : '';
        row.appendChild(match);
      }
      fragment.appendChild(row);
    });
    subcircuitPorts.replaceChildren(fragment);
    return true;
  }

  function openSubcircuitDialog() {
    if (!selectedNodeIds.length) return;
    if (subcircuitCloseTimer) clearTimeout(subcircuitCloseTimer);
    subcircuitCloseTimer = 0;
    subcircuitOverlay.classList.remove('is-closing');
    subcircuitReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const options = [new Option('新建定义', 'new')];
    subcircuitCatalog.definitions().forEach((definition) => options.push(new Option(`发布 ${definition.name} 的新修订`, definition.id)));
    subcircuitTarget.replaceChildren(...options); subcircuitTarget.value = 'new';
    subcircuitName.value = T('新子电路');
    if (!renderSubcircuitDraft()) return;
    subcircuitOverlay.hidden = false;
    requestAnimationFrame(() => subcircuitName.focus({ preventScroll: true }));
  }

  function closeSubcircuitDialog(options = {}) {
    if (subcircuitOverlay.hidden || subcircuitOverlay.classList.contains('is-closing')) return;
    pendingSubcircuit = null;
    const finish = () => {
      if (subcircuitCloseTimer) clearTimeout(subcircuitCloseTimer);
      subcircuitCloseTimer = 0;
      subcircuitOverlay.hidden = true;
      subcircuitOverlay.classList.remove('is-closing');
      subcircuitPorts.replaceChildren();
      if (options.restoreFocus !== false && subcircuitReturnFocus && subcircuitReturnFocus.isConnected) {
        subcircuitReturnFocus.focus({ preventScroll: true });
      }
      subcircuitReturnFocus = null;
    };
    if (prefersReducedMotion()) { finish(); return; }
    subcircuitOverlay.classList.add('is-closing');
    subcircuitCloseTimer = setTimeout(finish, 190);
  }

  function readSubcircuitPorts() {
    if (!pendingSubcircuit) return { ports: [], error: '没有待发布的子电路' };
    const byId = new Map(pendingSubcircuit.revision.ports.map((port) => [port.id, port]));
    const previousById = new Map(pendingSubcircuit.previousPorts.map((port) => [port.id, port]));
    const usedIds = new Set();
    const ports = [];
    for (const row of subcircuitPorts.querySelectorAll('[data-port-id]')) {
      const original = byId.get(row.dataset.portId);
      const type = row.querySelector('[data-port-type]').value;
      if (original.channel === 'value' && !type) return { ports: [], error: '请先为所有未知值端口选择具体类型' };
      const width = type === 'bits' ? Math.min(64, Math.max(1, Number(row.querySelector('[data-port-width]').value) || 8)) : 0;
      const match = row.querySelector('[data-port-match]');
      const matchedId = match && match.value;
      const previous = matchedId && previousById.get(matchedId);
      if (previous && (previous.direction !== original.direction || previous.channel !== original.channel
        || previous.valueType !== type || (type === 'bits' && Number(previous.bitsWidth) !== width))) {
        return { ports: [], error: `旧端口“${previous.name}”的方向、通道或类型不兼容` };
      }
      const id = previous ? previous.id : original.id;
      if (usedIds.has(id)) return { ports: [], error: '同一个旧端口不能映射到多个新端口' };
      usedIds.add(id);
      ports.push({
        ...original,
        id,
        name: row.querySelector('[data-port-name]').value.trim() || original.name,
        valueType: original.channel === 'event' ? 'pulse' : type,
        ...(type === 'bits' ? { bitsWidth: width } : {}),
      });
    }
    return { ports, error: '' };
  }

  function publishSubcircuit() {
    if (!pendingSubcircuit) return;
    const page = session.page(renderedPageId);
    if (!page) return;
    const portResult = readSubcircuitPorts();
    if (portResult.error) { setPersistenceStatus(portResult.error, 'error'); return; }
    const revisionSource = { ...pendingSubcircuit.revision, ports: portResult.ports };
    let definition; let revision;
    if (pendingSubcircuit.targetId) {
      const preview = createResearchSubcircuitCatalog(subcircuitCatalog.snapshot());
      preview.addRevision(pendingSubcircuit.targetId, revisionSource);
      if (validateSubcircuitDependencies(preview).length) {
        setPersistenceStatus('该修订会形成递归子电路，已拒绝发布', 'error'); return;
      }
      revision = subcircuitCatalog.addRevision(pendingSubcircuit.targetId, revisionSource);
      definition = subcircuitCatalog.definition(pendingSubcircuit.targetId);
    } else {
      const name = subcircuitName.value.trim() || T('新子电路');
      const created = subcircuitCatalog.addDefinition(name, revisionSource);
      definition = subcircuitCatalog.definition(created.id); revision = definition.revisions[0];
    }
    const instance = replaceSelectionWithSubcircuit(page.model, pendingSubcircuit.nodeIds, definition, revision);
    if (!instance) { setPersistenceStatus('选区已经变化，请重新封装', 'error'); return; }
    closeSubcircuitDialog({ restoreFocus: false }); canvas.clearSelection(); renderPalette(paletteSearch.value); scheduleSave(0);
  }

  function setConnectionKind(kind, persist = true) {
    if (editorMode === 'orthogonal' && persist) return canvas.getConnectionKind();
    const selectedKind = canvas.setConnectionKind(kind);
    dock.querySelectorAll('[data-research-connection-kind]').forEach((button) => {
      const selected = button.dataset.researchConnectionKind === selectedKind;
      button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    if (persist) {
      try { localStorage.setItem(CONNECTION_KIND_KEY, selectedKind); } catch (_error) {}
    }
    return selectedKind;
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

  function inspectorHeading(text) {
    const heading = document.createElement('div');
    heading.className = 'research-inspector-heading';
    heading.textContent = text;
    return heading;
  }

  function renderInspector(node) {
    if (!node) { showLibrary(); return; }
    const definition = registry.definition(node.type);
    if (!definition) { showLibrary(); return; }
    setPanelView('inspector', definition.label + ' · 属性');
    const fragment = document.createDocumentFragment();
    fragment.appendChild(inspectorHeading('基本信息'));
    const labelRow = document.createElement('label'); labelRow.textContent = '标签';
    const labelInput = document.createElement('input'); labelInput.type = 'text'; labelInput.value = node.label;
    const commitLabel = () => session.page(renderedPageId).model.updateNode(node.id, { label: labelInput.value });
    labelInput.addEventListener('change', commitLabel); labelInput.addEventListener('blur', commitLabel);
    labelRow.appendChild(labelInput); fragment.appendChild(labelRow);
    if (node.type === 'subcircuit') {
      fragment.appendChild(inspectorHeading('子电路修订'));
      const item = subcircuitCatalog.definition(node.config.definitionId);
      const info = document.createElement('p');
      info.className = 'research-subcircuit-version';
      info.textContent = item ? `${item.name} · 当前 r${node.config.revision} · 最新 r${item.latestRevision}` : '定义已经缺失';
      fragment.appendChild(info);
      if (item && item.latestRevision > Number(node.config.revision)) {
        const latest = subcircuitCatalog.revision(item.id, item.latestRevision);
        const checked = canUpgradeSubcircuitInstance(session.page(renderedPageId).model, node, latest, registry);
        const upgrade = document.createElement('button'); upgrade.type = 'button';
        upgrade.textContent = checked.ok ? `升级到 r${item.latestRevision}` : `有 ${checked.blockers.length} 条连线不兼容，无法升级`;
        upgrade.disabled = !checked.ok;
        upgrade.addEventListener('click', () => {
          const page = session.page(renderedPageId);
          page.model.updateNode(node.id, {
            config: { definitionId: item.id, revision: item.latestRevision }, savedState: null,
          });
        });
        fragment.appendChild(upgrade);
      }
    }
    if (definition.configFields.length) fragment.appendChild(inspectorHeading('节点配置'));
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
      fragment.appendChild(inspectorHeading('状态'));
      const row = document.createElement('label'); row.className = 'research-persist-row'; row.textContent = '重开后保留状态';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = node.statePolicy === 'persist';
      input.addEventListener('change', () => session.page(renderedPageId).model.updateNode(node.id, { statePolicy: input.checked ? 'persist' : 'reset' }));
      row.appendChild(input); fragment.appendChild(row);
    }
    fragment.appendChild(inspectorHeading('操作'));
    const duplicate = document.createElement('button'); duplicate.type = 'button';
    duplicate.dataset.researchSelectionDuplicate = '';
    duplicate.textContent = '复制当前节点';
    duplicate.addEventListener('click', () => canvas.duplicateSelection());
    const publish = document.createElement('button'); publish.type = 'button';
    publish.dataset.researchSubcircuitCreate = '';
    publish.textContent = '封装当前节点为子电路';
    publish.addEventListener('click', openSubcircuitDialog);
    fragment.append(duplicate, publish);
    inspectorFields.replaceChildren(fragment);
    renderTrace(node);
  }

  function edgeEndpointLabel(nodeId, portId) {
    const page = session.page(renderedPageId);
    const node = page && page.model.node(nodeId);
    return (node && node.label || nodeId) + (portId ? '.' + portId : '');
  }

  function renderEdgeInspector(edge) {
    if (!edge) { showLibrary(); return; }
    setPanelView('inspector', (edge.kind === 'wire' ? '导线' : '关系线') + ' · 属性');
    renderTrace(null);
    const fragment = document.createDocumentFragment();
    fragment.appendChild(inspectorHeading('基本信息'));
    const type = document.createElement('p'); type.className = 'research-inspector-readonly';
    type.textContent = '类型：' + (edge.kind === 'wire' ? '类型化导线' : '知识关系线');
    const endpoints = document.createElement('p'); endpoints.className = 'research-inspector-readonly';
    endpoints.textContent = edge.kind === 'wire'
      ? `${edgeEndpointLabel(edge.from.nodeId, edge.from.portId)} → ${edgeEndpointLabel(edge.to.nodeId, edge.to.portId)}`
      : `${edgeEndpointLabel(edge.fromNodeId)} → ${edgeEndpointLabel(edge.toNodeId)}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'research-edge-delete';
    remove.textContent = '删除这条连线';
    remove.addEventListener('click', () => {
      const page = session.page(renderedPageId);
      if (!page || !page.model.edge(edge.id)) return;
      page.model.remove(new Set(), new Set([edge.id]));
      canvas.clearSelection();
    });
    fragment.append(type, endpoints, inspectorHeading('操作'), remove);
    inspectorFields.replaceChildren(fragment);
  }

  function renderSelectionSummary(selection) {
    delete selectionCopy.dataset.i18nSourceText;
    setPanelView('selection', '选区 · 属性');
    renderTrace(null);
    inspectorFields.replaceChildren();
    const nodeCount = selection.nodeIds.length;
    const edgeCount = selection.edgeIds.length;
    selectionCopy.textContent = `已选 ${nodeCount} 个节点${edgeCount ? `、${edgeCount} 条连线` : ''}。可复制节点选区，或发布为可复用子电路。`;
    selectionDuplicate.hidden = nodeCount === 0;
    subcircuitCreate.hidden = nodeCount === 0;
  }

  function renderSelectionPanel(selection) {
    if (selection.primaryNode && selection.nodeIds.length === 1 && !selection.edgeIds.length) {
      renderInspector(selection.primaryNode); return;
    }
    if (selection.primaryEdge && selection.edgeIds.length === 1 && !selection.nodeIds.length) {
      renderEdgeInspector(selection.primaryEdge); return;
    }
    if (selection.nodeIds.length || selection.edgeIds.length) {
      renderSelectionSummary(selection); return;
    }
    showLibrary();
  }

  function syncDecorationSettings() {
    const tools = canvas.getDecorationTools();
    unitLengthInput.value = String(tools.unitLength); lineWidthInput.value = String(tools.width);
    stage.querySelector('[data-research-unit-length-value]').textContent = tools.unitLength + 'px';
    stage.querySelector('[data-research-line-width-value]').textContent = tools.width + 'px';
    endpointSizeInput.value = String(tools.endpointDiameter);
    stage.querySelector('[data-research-endpoint-size-value]').textContent = tools.endpointDiameter + 'px';
  }

  function decorationText(element, source) {
    element.dataset.i18nSourceText = source; element.textContent = T(source);
  }

  function setEditorMode(mode, persist = true) {
    if (!finishLabelEdit(() => setEditorMode(mode, persist))) return;
    const previousDock = active && editorMode !== mode ? dock.getBoundingClientRect() : null;
    cancelDockResize();
    cancelSymbolPreview(); closeModeMenu(); closePresetContextMenu(); closePresetDialog();
    editorMode = mode === 'orthogonal' ? 'orthogonal' : 'default';
    dock.classList.toggle('is-orthogonal', editorMode === 'orthogonal');
    defaultDockTools.hidden = editorMode === 'orthogonal'; orthogonalDockTools.hidden = editorMode !== 'orthogonal';
    syncDecorationDock();
    modeSelect.dataset.value = editorMode;
    decorationText(modeLabel, editorMode === 'orthogonal' ? '直角模式' : '默认模式');
    modeMenu.querySelectorAll('[data-research-mode-option]').forEach((button) => {
      button.setAttribute('aria-checked', button.dataset.researchModeOption === editorMode ? 'true' : 'false');
    });
    if (editorMode === 'orthogonal') { simulation.pause(); cancelCompute(); }
    canvas.setEditorMode(editorMode);
    showLibrary();
    if (editorMode === 'default') scheduleCompute();
    if (previousDock) animateDockResize(previousDock);
    if (persist) { try { localStorage.setItem(EDITOR_MODE_KEY, editorMode); } catch (_error) {} }
  }

  function cancelDockResize() {
    if (dockResizeAnimation) dockResizeAnimation.cancel();
    dockResizeAnimation = null;
  }
  function animateDockResize(before) {
    if (prefersReducedMotion() || !dock.animate) return;
    const after = dock.getBoundingClientRect(), parent = stage.getBoundingClientRect();
    if (Math.abs(before.width - after.width) < .5 && Math.abs(before.left - after.left) < .5) return;
    const frame = (rect) => ({ width: rect.width + 'px', left: rect.left - parent.left + rect.width / 2 + 'px', minWidth: '0px', maxWidth: 'none' });
    const animation = dock.animate([frame(before), frame(after)], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' });
    dockResizeAnimation = animation;
    animation.finished.then(() => { if (dockResizeAnimation === animation) dockResizeAnimation = null; }, () => {});
  }

  function syncDecorationDock() {
    if (!quickSymbols.childElementCount) QUICK_SYMBOLS.forEach((type) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.researchQuickSymbol = type;
      decorationText(button, type === 'rectangle' ? '电阻' : type === 'switch' ? '电路开关' : SYMBOL_LABELS[type]);
      quickSymbols.appendChild(button);
    });
    const tools = canvas.getDecorationTools();
    orthogonalDockTools.querySelectorAll('button').forEach((button) => {
      const selected = button.dataset.researchQuickSymbol
        ? !tools.presetId && button.dataset.researchQuickSymbol === tools.symbol
        : button.dataset.researchQuickLineAction
          ? button.dataset.researchQuickLineAction === tools.lineAction
          : tools.lineAction === 'draw' && button.dataset.researchQuickLineStyle === tools.lineStyle;
      button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function renderDecorationPalette(query = '') {
    syncDecorationDock();
    const tools = canvas.getDecorationTools(), fragment = document.createDocumentFragment();
    const group = (title, key, entries) => {
      const section = document.createElement('section'); section.className = 'research-decoration-tool-group';
      const heading = document.createElement('strong'); decorationText(heading, title); section.appendChild(heading);
      const choices = document.createElement('div');
      entries.forEach(([value, label, toolKey = key]) => {
        if (query && !label.toLowerCase().includes(query.toLowerCase()) && !T(label).toLowerCase().includes(query.toLowerCase())) return;
        const button = document.createElement('button'); button.type = 'button'; decorationText(button, label);
        button.dataset.researchDecorationTool = toolKey; button.dataset.value = value;
        const active = tools[toolKey] === value && (toolKey !== 'lineStyle' || tools.lineAction === 'draw');
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false'); choices.appendChild(button);
      });
      section.appendChild(choices); fragment.appendChild(section);
    };
    const section = document.createElement('section'); section.className = 'research-decoration-tool-group';
    const heading = document.createElement('strong'); decorationText(heading, '装饰符号'); section.appendChild(heading);
    const grid = document.createElement('div'); grid.className = 'research-symbol-grid';
    const matches = (name) => !query || name.toLowerCase().includes(query.toLowerCase()) || T(name).toLowerCase().includes(query.toLowerCase());
    const tile = (name, template, selected, preset = false) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'research-symbol-tile';
      button.setAttribute('aria-label', preset ? name : T(name));
      if (!preset) button.dataset.i18nSourceAriaLabel = name;
      else button.dataset.userContent = '';
      button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      renderSymbolPreview(button, template); grid.appendChild(button); return button;
    };
    SYMBOL_TYPES.forEach((type) => {
      if (!matches(SYMBOL_LABELS[type])) return;
      const button = tile(SYMBOL_LABELS[type], defaultSymbol(type), !tools.presetId && tools.symbol === type);
      button.dataset.researchDecorationTool = 'symbol'; button.dataset.value = type;
    });
    canvas.getDecorationPresetStore().list().forEach((preset) => {
      if (!matches(preset.name)) return;
      const button = tile(preset.name, preset.template, tools.presetId === preset.id, true);
      button.dataset.researchDecorationPreset = preset.id;
    });
    const add = document.createElement('button'); add.type = 'button'; add.className = 'research-symbol-tile'; add.textContent = '＋';
    add.dataset.researchPresetAdd = '';
    add.setAttribute('aria-label', T('新建预设')); add.dataset.i18nSourceAriaLabel = '新建预设'; grid.appendChild(add);
    section.appendChild(grid); fragment.appendChild(section);
    group('线段', 'arrowhead', [['none', '默认线段'], ['end', '单向箭头']]);
    group('线段类型', 'lineStyle', [['solid', '实线'], ['dashed', '虚线'], ['delete', '删除', 'lineAction']]);
    group('线段颜色', 'color', LINE_COLORS.map((color) => [color, COLOR_LABELS[color]]));
    disposeSymbolPreviews(paletteList); paletteList.replaceChildren(fragment);
  }

  function renderDecorationSelection(selection) {
    const ids = selection.decorationIds || [];
    if (!ids.length) { renderedDecorationId = ''; showLibrary(); return; }
    subcircuitCreate.hidden = true;
    if (ids.length !== 1 || !selection.primaryDecoration) {
      renderedDecorationId = '';
      setPanelView('selection', T('研究 · 装饰选区'));
      decorationText(inspectorTitle, '研究 · 装饰选区');
      decorationText(selectionCopy, '已选装饰对象：' + ids.length);
      selectionDuplicate.hidden = false; return;
    }
    // A property commit updates the existing controls in place. Rebuilding on
    // blur would remove the button the user is about to click (e.g. Save preset).
    if (decorationControlCommit && renderedDecorationId === selection.primaryDecoration.id && !inspector.hidden) return;
    const d = { ...selection.primaryDecoration }; renderedDecorationId = d.id;
    setPanelView('inspector', T(d.kind === 'line' ? '研究 · 装饰线段' : '研究 · 装饰符号'));
    decorationText(inspectorTitle, d.kind === 'line' ? '研究 · 装饰线段' : '研究 · 装饰符号');
    renderTrace(null); inspectorFields.replaceChildren();
    const update = (patch) => {
      decorationControlCommit = true;
      try {
        let changed;
        if (symbolPreview) {
          const pending = symbolPreview; symbolPreview = null;
          pending.model.updateDecorations({ [d.id]: patch }, { live: true });
          changed = pending.model.commitFrom(pending.before, { kind: 'decoration-edit', decorationsOnly: true });
        } else changed = canvas.updateDecoration(d.id, patch);
        Object.assign(d, patch); return changed;
      } finally { decorationControlCommit = false; }
    };
    const field = (title, control) => {
      const label = document.createElement('label'); label.className = 'research-decoration-field';
      const text = document.createElement('span'); decorationText(text, title);
      label.append(text, control); inspectorFields.appendChild(label);
    };
    const numeric = (title, key, min, max, step = 1) => {
      const input = document.createElement('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step;
      input.value = d[key];
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(value) || value < min || value > max || !update({ [key]: value })) input.value = d[key];
      }); field(title, input);
    };
    const choice = (title, key, entries) => {
      const select = document.createElement('select');
      entries.forEach(([value, text]) => { const option = document.createElement('option'); option.value = value; decorationText(option, text); select.appendChild(option); });
      select.value = String(d[key]); select.addEventListener('change', () => update({ [key]: key === 'rotation' ? Number(select.value) : select.value })); field(title, select);
    };
    if (d.kind === 'line') {
      numeric('单位数', 'units', 1, 100000);
      numeric('线宽', 'width', 1, 6, .5);
      choice('线段', 'arrowhead', [['none', '默认线段'], ['end', '单向箭头']]);
      choice('线段类型', 'lineStyle', [['solid', '实线'], ['dashed', '虚线']]);
      choice('线段颜色', 'color', LINE_COLORS.map((color) => [color, COLOR_LABELS[color]]));
    } else {
      symbolLabelEditor = buildSymbolControls(inspectorFields, d, { T,
        onChange: update,
        onPreview: (patch, control) => {
          const model = session.page(renderedPageId).model;
          if (!symbolPreview) symbolPreview = { model, before: model.capture(), control, objectId: d.id };
          model.updateDecorations({ [d.id]: patch }, { live: true });
        }, onCancelPreview: cancelSymbolPreview,
      });
    }
    const actions = document.createElement('div'); actions.className = 'research-decoration-actions'; inspectorFields.appendChild(actions);
    if (d.kind === 'symbol') {
      const preset = document.createElement('button'); preset.type = 'button'; decorationText(preset, '保存为预设');
      preset.dataset.researchSavePreset = ''; preset.addEventListener('click', () => openPresetDialog(d)); actions.appendChild(preset);
    }
    const duplicate = document.createElement('button'); duplicate.type = 'button'; decorationText(duplicate, '复制选区');
    duplicate.addEventListener('click', () => canvas.duplicateSelection()); actions.appendChild(duplicate);
  }

  function cancelSymbolPreview() {
    if (!symbolPreview) return;
    const previous = symbolPreview; symbolPreview = null;
    if (previous.control?.type === 'number' || previous.control?.tagName === 'TEXTAREA') {
      const original = previous.before.decorations.find((d) => d.id === previous.objectId);
      previous.control.value = original?.[previous.control.dataset.symbolField] ?? '';
    }
    previous.model.restore(previous.before, true);
  }
  function closeModeMenu(focus = false) {
    dock.classList.remove('is-menu-open');
    modeMenu.classList.remove('is-open'); modeMenu.inert = true; modeSelect.setAttribute('aria-expanded', 'false');
    if (focus) modeSelect.focus({ preventScroll: true });
  }
  function openModeMenu() {
    if (!finishLabelEdit(openModeMenu)) return;
    cancelSymbolPreview(); canvas.cancelDecorationGesture(); closePresetContextMenu();
    const anchor = modeSelect.getBoundingClientRect(), parent = dock.getBoundingClientRect();
    modeMenu.style.left = Math.max(8, Math.min(anchor.left, window.innerWidth - 164)) - parent.left + 'px';
    dock.classList.add('is-menu-open');
    modeMenu.inert = false; modeMenu.classList.add('is-open'); modeSelect.setAttribute('aria-expanded', 'true');
    modeMenu.querySelector('[aria-checked="true"]').focus({ preventScroll: true });
  }
  function closePresetDialog() {
    if (!presetDialog) return;
    const dialog = presetDialog; presetDialog = null; disposeSymbolPreviews(dialog); dialog.close(); dialog.remove();
  }
  function openPresetDialog(template = canvas.getDecorationSymbolTemplate(), existing = null) {
    if (!finishLabelEdit(() => openPresetDialog(template, existing))) return;
    cancelSymbolPreview(); canvas.cancelDecorationGesture(); closeModeMenu(); closePresetContextMenu(); closePresetDialog();
    const returnFocus = document.activeElement;
    let draft = symbolTemplateDefaults(template);
    let presetLabelEditor = null;
    const dialog = document.createElement('dialog'); dialog.className = 'research-preset-dialog'; dialog.dataset.researchPresetDialog = '';
    const form = document.createElement('form'), header = document.createElement('header'), title = document.createElement('h2');
    title.id = 'research-preset-title'; decorationText(title, existing ? '编辑预设' : '新建预设'); dialog.setAttribute('aria-labelledby', title.id);
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', T('取消')); close.dataset.i18nSourceAriaLabel = '取消';
    const dismiss = () => { closePresetDialog(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); };
    close.addEventListener('click', dismiss); header.append(title, close); form.appendChild(header);
    const nameRow = document.createElement('label'); nameRow.className = 'research-decoration-field';
    const caption = document.createElement('span'); decorationText(caption, '预设名称');
    const name = document.createElement('input'); name.type = 'text'; name.required = true; name.maxLength = 120; name.value = existing?.name || '';
    name.dataset.researchPresetName = ''; nameRow.append(caption, name); form.appendChild(nameRow);
    const preview = document.createElement('div'); preview.className = 'research-preset-preview'; preview.dataset.researchPresetPreview = ''; form.appendChild(preview);
    const controls = document.createElement('div'); controls.className = 'research-preset-fields'; form.appendChild(controls);
    const rebuild = () => {
      controls.replaceChildren(); renderSymbolPreview(preview, draft);
      presetLabelEditor = buildSymbolControls(controls, draft, { T, inDialog: true, allowType: true,
        onTypeChange: (type) => { const defaults = defaultSymbol(type); draft = { ...draft, type, width: defaults.width, height: defaults.height }; rebuild(); },
        onChange: (patch) => { Object.assign(draft, patch); renderSymbolPreview(preview, draft); },
        onPreview: (patch) => renderSymbolPreview(preview, { ...draft, ...patch }),
        onCancelPreview: () => renderSymbolPreview(preview, draft),
      });
    }; rebuild();
    dialog.addEventListener('research:themechange', () => renderSymbolPreview(preview, draft));
    const error = document.createElement('p'); error.className = 'research-preset-error'; error.hidden = true; error.setAttribute('role', 'alert'); form.appendChild(error);
    const footer = document.createElement('footer'), cancel = document.createElement('button'), save = document.createElement('button');
    cancel.type = 'button'; decorationText(cancel, '取消'); cancel.addEventListener('click', dismiss);
    save.type = 'submit'; save.className = 'research-preset-save'; save.dataset.researchPresetSave = ''; decorationText(save, '保存'); footer.append(cancel, save); form.appendChild(footer);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (form.contains(document.activeElement)) document.activeElement.blur();
      await presetLabelEditor?.commit();
      if (!dialog.isConnected) return;
      if (!form.reportValidity()) return;
      try {
        const preset = canvas.getDecorationPresetStore().save(name.value, draft, existing?.id || '');
        canvas.setDecorationTools({ symbol: preset.template.type, presetId: preset.id });
        closePresetDialog(); showLibrary({ expand: true }); viewport.focus({ preventScroll: true });
      } catch (_error) { decorationText(error, '预设未能保存，请检查输入或本机存储空间。'); error.hidden = false; }
    });
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); dismiss(); });
    dialog.addEventListener('click', (event) => { const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dismiss(); });
    dialog.appendChild(form); stage.appendChild(dialog); presetDialog = dialog; dialog.showModal(); name.focus();
  }
  function closePresetContextMenu(focus = false) {
    if (!presetContextMenu) return;
    const { element, trigger } = presetContextMenu; presetContextMenu = null; element.remove();
    if (focus && trigger.isConnected) trigger.focus({ preventScroll: true });
  }
  function openPresetContextMenu(trigger, x, y) {
    const preset = canvas.getDecorationPresetStore().find(trigger.dataset.researchDecorationPreset); if (!preset) return;
    closePresetContextMenu(); closeModeMenu();
    const element = document.createElement('div'); element.className = 'research-preset-menu'; element.setAttribute('role', 'menu');
    const entries = [['编辑预设', () => openPresetDialog(preset.template, preset)], ['删除预设', () => {
      try {
        canvas.getDecorationPresetStore().remove(preset.id);
        if (canvas.getDecorationTools().presetId === preset.id) canvas.setDecorationTools({ presetId: '', symbol: 'rectangle' });
        renderDecorationPalette(paletteSearch.value); paletteSearch.focus({ preventScroll: true });
      } catch (_error) { setPersistenceStatus(T('预设未能保存，请检查输入或本机存储空间。'), 'error'); }
    }]];
    entries.forEach(([title, action]) => { const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); decorationText(button, title);
      button.addEventListener('click', () => { closePresetContextMenu(); action(); }); element.appendChild(button); });
    stage.appendChild(element); element.style.left = Math.max(8, Math.min(x, window.innerWidth - element.offsetWidth - 8)) + 'px';
    element.style.top = Math.max(8, Math.min(y, window.innerHeight - element.offsetHeight - 8)) + 'px';
    presetContextMenu = { element, trigger }; element.firstElementChild.focus({ preventScroll: true });
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePresetContextMenu(true); }
      else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const buttons = [...element.children], i = buttons.indexOf(document.activeElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
      } else if (event.key === 'Tab') closePresetContextMenu();
    });
  }

  function closeSettingsResetConfirmation() {
    settingsResetConfirm.hidden = true;
    settingsResetOpen.setAttribute('aria-expanded', 'false');
  }

  function openSettingsPanel() {
    if (tutorial.isOpen()) tutorial.close({ focus: false, immediate: true });
    if (settingsCloseTimer) clearTimeout(settingsCloseTimer);
    settingsCloseTimer = 0;
    settingsPanel.classList.remove('is-closing');
    settingsPanel.hidden = false;
    settingsOpen.setAttribute('aria-expanded', 'true');
  }

  function closeSettingsPanel(options = {}) {
    if (settingsPanel.hidden || (settingsPanel.classList.contains('is-closing') && !options.immediate)) return;
    settingsOpen.setAttribute('aria-expanded', 'false');
    closeSettingsResetConfirmation();
    const finish = () => {
      if (settingsCloseTimer) clearTimeout(settingsCloseTimer);
      settingsCloseTimer = 0;
      settingsPanel.hidden = true;
      settingsPanel.classList.remove('is-closing');
      if (options.focus !== false) settingsOpen.focus({ preventScroll: true });
    };
    if (options.immediate || prefersReducedMotion()) { finish(); return; }
    settingsPanel.classList.add('is-closing');
    settingsCloseTimer = setTimeout(finish, 150);
  }

  function installListeners() {
    activeController = new AbortController(); const signal = activeController.signal;
    tutorial.activate(signal);
    modeSelect.addEventListener('click', () => { modeMenu.classList.contains('is-open') ? closeModeMenu(true) : openModeMenu(); }, { signal });
    modeSelect.addEventListener('keydown', (event) => {
      if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); openModeMenu(); }
    }, { signal });
    modeMenu.addEventListener('click', (event) => {
      const option = event.target.closest('[data-research-mode-option]'); if (!option) return;
      if (option.dataset.researchModeOption !== editorMode) setEditorMode(option.dataset.researchModeOption);
      else closeModeMenu();
      modeSelect.focus({ preventScroll: true });
    }, { signal });
    modeMenu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeModeMenu(true); }
      else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const buttons = [...modeMenu.children], i = buttons.indexOf(document.activeElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus({ preventScroll: true });
      } else if (event.key === 'Tab') closeModeMenu();
    }, { signal });
    window.addEventListener('resize', () => { cancelDockResize(); closeModeMenu(); closePresetContextMenu(); }, { signal });
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => { if (prefersReducedMotion()) cancelDockResize(); }, { signal });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (editorMode === 'orthogonal' && !nodeLibrary.hidden) renderDecorationPalette(paletteSearch.value);
      if (presetDialog) {
        // Rebuild the preview using the unchanged draft when the theme switches.
        presetDialog.dispatchEvent(new Event('research:themechange'));
      }
    }, { signal });
    dock.querySelector('.research-compute-row').addEventListener('scroll', () => closeModeMenu(), { signal });
    unitLengthInput.addEventListener('input', () => { canvas.setDecorationTools({ unitLength: Number(unitLengthInput.value) }); syncDecorationSettings(); }, { signal });
    lineWidthInput.addEventListener('input', () => { canvas.setDecorationTools({ width: Number(lineWidthInput.value) }); syncDecorationSettings(); }, { signal });
    endpointSizeInput.addEventListener('input', () => { canvas.setDecorationTools({ endpointDiameter: Number(endpointSizeInput.value) }); syncDecorationSettings(); }, { signal });
    dock.addEventListener('click', (event) => {
      if (event.target.closest('[data-research-add]')) { showLibrary({ expand: true, focusSearch: true }); return; }
      const quickSymbol = event.target.closest('[data-research-quick-symbol]');
      const quickLine = event.target.closest('[data-research-quick-line-style]');
      const quickLineAction = event.target.closest('[data-research-quick-line-action]');
      if (editorMode === 'orthogonal' && (quickSymbol || quickLine || quickLineAction)) {
        canvas.setDecorationTools(quickSymbol ? { symbol: quickSymbol.dataset.researchQuickSymbol, presetId: '' }
          : quickLineAction ? { lineAction: quickLineAction.dataset.researchQuickLineAction }
            : { lineStyle: quickLine.dataset.researchQuickLineStyle });
        syncDecorationDock();
        if (quickSymbol) showLibrary(); else if (!nodeLibrary.hidden) renderDecorationPalette(paletteSearch.value);
        viewport.focus({ preventScroll: true }); return;
      }
      if (editorMode === 'orthogonal') return;
      const kind = event.target.closest('[data-research-connection-kind]');
      if (kind) { setConnectionKind(kind.dataset.researchConnectionKind); viewport.focus({ preventScroll: true }); return; }
      if (event.target.closest('[data-research-add]')) { showLibrary({ expand: true, focusSearch: true }); return; }
      if (event.target.closest('[data-research-run]')) simulation.run();
      else if (event.target.closest('[data-research-pause]')) { simulation.pause(); scheduleSave(0); }
      else if (event.target.closest('[data-research-step]')) simulation.step();
      else if (event.target.closest('[data-research-reset]')) simulation.reset();
    }, { signal });
    // 主键按下即切换，避免快速连续操作时按钮自身的旋转/命中变化取消 click。
    // 键盘与辅助技术产生的 detail=0 click 仍保留标准按钮行为。
    dockCollapse.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      setDockCollapsed(!dock.classList.contains('is-collapsed'));
    }, { signal });
    dockCollapse.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.detail === 0) setDockCollapsed(!dock.classList.contains('is-collapsed'));
    }, { signal });
    subcircuitCreate.addEventListener('click', openSubcircuitDialog, { signal });
    speedSelect.addEventListener('change', () => {
      if (editorMode === 'orthogonal') { speedSelect.value = String(session.page(renderedPageId).simulation.speed); return; }
      const speed = Number(speedSelect.value); simulation.setSpeed(speed);
      if (session.setPageSpeed(renderedPageId, speed)) scheduleSave();
    }, { signal });
    paletteSearch.addEventListener('input', () => renderPalette(paletteSearch.value), { signal });
    paletteList.addEventListener('click', (event) => {
      if (event.target.closest('[data-research-preset-add]')) { openPresetDialog(); return; }
      const presetTile = event.target.closest('[data-research-decoration-preset]');
      if (presetTile) {
        const preset = canvas.getDecorationPresetStore().find(presetTile.dataset.researchDecorationPreset);
        if (preset) canvas.setDecorationTools({ symbol: preset.template.type, presetId: preset.id });
        renderDecorationPalette(paletteSearch.value); viewport.focus({ preventScroll: true }); return;
      }
      const tool = event.target.closest('[data-research-decoration-tool]');
      if (tool) {
        canvas.setDecorationTools({ [tool.dataset.researchDecorationTool]: tool.dataset.value,
          ...(tool.dataset.researchDecorationTool === 'symbol' ? { presetId: '' } : {}) });
        renderDecorationPalette(paletteSearch.value); viewport.focus({ preventScroll: true }); return;
      }
      if (editorMode === 'orthogonal') return;
      const reusable = event.target.closest('[data-research-subcircuit-id]');
      if (reusable) {
        const definition = subcircuitCatalog.definition(reusable.dataset.researchSubcircuitId);
        if (!definition) return;
        canvas.setCreationTool({
          type: 'subcircuit', label: definition.name,
          config: { definitionId: definition.id, revision: definition.latestRevision },
          width: 192,
          height: Math.max(80, 48 + (subcircuitCatalog.revision(definition.id, definition.latestRevision).ports.length * 18)),
        });
        renderPalette(paletteSearch.value); viewport.focus({ preventScroll: true }); return;
      }
      const button = event.target.closest('[data-research-node-type]');
      if (!button) return;
      canvas.setCreationTool(button.dataset.researchNodeType); renderPalette(paletteSearch.value); viewport.focus({ preventScroll: true });
    }, { signal });
    paletteList.addEventListener('contextmenu', (event) => {
      const presetTile = event.target.closest('[data-research-decoration-preset]');
      if (presetTile) { event.preventDefault(); openPresetContextMenu(presetTile, event.clientX, event.clientY); return; }
      const button = event.target.closest('[data-research-subcircuit-id]');
      if (!button) return;
      event.preventDefault();
      const definition = subcircuitCatalog.definition(button.dataset.researchSubcircuitId);
      if (!definition) return;
      const pages = session.pages().map((page) => page.model.snapshot());
      const references = collectSubcircuitReferences(pages, subcircuitCatalog);
      const key = definition.id + '@' + definition.latestRevision;
      if (references.has(key)) { setPersistenceStatus('该修订仍被页面或其他子电路引用，不能删除', 'error'); return; }
      if (!window.confirm(T(`删除“${definition.name}”的 r${definition.latestRevision}？此操作不进入页面撤销。`))) return;
      if (subcircuitCatalog.removeRevision(definition.id, definition.latestRevision, references)) {
        renderPalette(paletteSearch.value); scheduleSave(0);
      }
    }, { signal });
    paletteList.addEventListener('keydown', (event) => {
      const tile = event.target.closest('[data-research-decoration-preset]');
      if (tile && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
        event.preventDefault(); const rect = tile.getBoundingClientRect(); openPresetContextMenu(tile, rect.right, rect.bottom);
      }
    }, { signal });
    subcircuitTarget.addEventListener('change', renderSubcircuitDraft, { signal });
    subcircuitConfirm.addEventListener('click', publishSubcircuit, { signal });
    subcircuitOverlay.querySelectorAll('[data-research-subcircuit-cancel]').forEach((button) => {
      button.addEventListener('click', closeSubcircuitDialog, { signal });
    });
    subcircuitOverlay.addEventListener('mousedown', (event) => { if (event.target === subcircuitOverlay) closeSubcircuitDialog(); }, { signal });
    inspectorClose.addEventListener('click', () => setSidePanelCollapsed(true), { signal });
    selectionDuplicate.addEventListener('click', () => canvas.duplicateSelection(), { signal });
    traceClear.addEventListener('click', () => {
      const page = session.page(renderedPageId);
      const node = page && page.model.node(selectedNodeId);
      if (!page || !node || node.type !== 'probe') return;
      const runtime = ensureRuntime(page);
      clearResearchTrace(runtime, node.id);
      applyProjection(page, runtime.result);
    }, { signal });
    railList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-research-page-id]');
      if (!button) return;
      event.preventDefault(); resetRailWheel(); switchPage(button.dataset.researchPageId);
    }, { signal });
    railAdd.addEventListener('click', createPage, { signal });
    pageDelete.addEventListener('click', deletePage, { signal });
    centerOriginButton.addEventListener('click', () => canvas.centerOrigin(), { signal });
    settingsOpen.addEventListener('click', () => {
      if (settingsPanel.hidden || settingsPanel.classList.contains('is-closing')) openSettingsPanel();
      else closeSettingsPanel();
    }, { signal });
    settingsResetOpen.addEventListener('click', () => {
      const opening = settingsResetConfirm.hidden;
      settingsResetConfirm.hidden = !opening;
      settingsResetOpen.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (opening) settingsResetCancel.focus({ preventScroll: true });
    }, { signal });
    settingsResetCancel.addEventListener('click', () => {
      closeSettingsResetConfirmation();
      settingsResetOpen.focus({ preventScroll: true });
    }, { signal });
    settingsResetAccept.addEventListener('click', () => {
      canvas.resetInteractionPreferences();
      canvas.resetDecorationTools(); syncDecorationSettings();
      if (editorMode === 'orthogonal') renderDecorationPalette(paletteSearch.value);
      closeSettingsResetConfirmation();
      settingsResetOpen.focus({ preventScroll: true });
    }, { signal });
    document.addEventListener('pointerdown', (event) => {
      if (!modeSelect.contains(event.target) && !modeMenu.contains(event.target)) closeModeMenu();
      if (presetContextMenu && !presetContextMenu.element.contains(event.target)) closePresetContextMenu();
      if (symbolPreview && symbolPreview.control !== event.target) {
        if (symbolPreview.control?.type === 'number' || symbolPreview.control?.tagName === 'TEXTAREA') symbolPreview.control.blur();
        else if (!event.target.closest('input[type="color"]')) cancelSymbolPreview();
      }
      if (settingsPanel.hidden || settingsPanel.contains(event.target) || settingsOpen.contains(event.target)) return;
      closeSettingsPanel({ focus: false });
    }, { capture: true, signal });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) cancelDockResize();
      if (document.hidden && editorMode === 'orthogonal') {
        if (symbolPreview?.control?.tagName === 'TEXTAREA') symbolLabelEditor?.commit(); else cancelSymbolPreview();
        canvas.cancelDecorationGesture(); closeModeMenu(); closePresetContextMenu();
      }
      simulation.setVisible(!document.hidden);
      if (document.hidden) scheduleSave(0);
    }, { signal });
    window.addEventListener('keydown', (event) => {
      if (presetDialog) return;
      if (event.isComposing || event.keyCode === 229 || (symbolLabelEditor?.isComposing() && event.target.tagName === 'TEXTAREA')) return;
      if (modeMenu.classList.contains('is-open') && event.key === 'Escape') { event.preventDefault(); closeModeMenu(true); return; }
      if (event.key === 'Escape' && symbolPreview) {
        event.preventDefault();
        if (symbolPreview.control?.tagName === 'TEXTAREA') symbolLabelEditor?.cancel(); else cancelSymbolPreview();
      }
      if (event.key === 'Escape' && !settingsResetConfirm.hidden) {
        event.preventDefault(); closeSettingsResetConfirmation(); settingsResetOpen.focus({ preventScroll: true });
      }
      else if (event.key === 'Escape' && !settingsPanel.hidden) { event.preventDefault(); closeSettingsPanel(); }
      else if (event.key === 'Escape' && !subcircuitOverlay.hidden) { event.preventDefault(); closeSubcircuitDialog(); }
      else if (event.key === '?' && !tutorial.isOpen() && !event.target.closest('input,select,textarea,[contenteditable="true"]')) { event.preventDefault(); tutorial.open(); }
      else if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
        && !event.isComposing && event.keyCode !== 229 && subcircuitOverlay.hidden && !tutorial.isOpen() && settingsPanel.hidden
        && !event.target.closest('input,select,textarea,button,[contenteditable="true"]')
        && !sidePanel.contains(event.target)) {
        event.preventDefault();
        setSidePanelCollapsed(!sidePanelCollapsed);
      }
    }, { capture: true, signal });
    stage.addEventListener('pointerdown', (event) => {
      if (event.button === 0 && event.target.closest('[data-node-id]')) guardPanelHitTesting();
    }, { capture: true, signal });
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
    rail.addEventListener('wheel', (event) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const direction = event.deltaY > 0 ? 1 : -1;
      const targetInList = railList.contains(event.target);
      const maxScroll = Math.max(0, railList.scrollHeight - railList.clientHeight);
      const atEdge = direction > 0 ? railList.scrollTop >= maxScroll - 1 : railList.scrollTop <= 1;
      if (targetInList && !atEdge) { event.stopPropagation(); return; }
      event.preventDefault(); event.stopPropagation();
      railWheelAccum += event.deltaY;
      if (railWheelTimer) clearTimeout(railWheelTimer);
      railWheelTimer = setTimeout(resetRailWheel, 200);
      if (Math.abs(railWheelAccum) < 24) return;
      const visualPageId = pageSwitchMotion ? pageSwitchMotion.targetPageId : renderedPageId;
      const currentIndex = session.indexOf(visualPageId);
      const nextIndex = currentIndex + (railWheelAccum > 0 ? 1 : -1);
      railWheelAccum = 0;
      const pages = session.pages();
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= pages.length) return;
      switchPage(pages[nextIndex].id, { direction });
    }, { passive: false, signal });
  }

  let initialConnectionKind = 'wire';
  try { initialConnectionKind = localStorage.getItem(CONNECTION_KIND_KEY) === 'relation' ? 'relation' : 'wire'; } catch (_error) {}
  bindModel(); renderRail({ initial: true }); showLibrary(); updateDeleteVisibility();
  ensureRuntime(session.activePage()); canvas.setComputeProjection(session.activePage().runtime.computeProjection);
  simulation.selectPage(renderedPageId, session.activePage().simulation.speed);
  setConnectionKind(initialConnectionKind, false);
  setSidePanelCollapsed(sidePanelCollapsed, false);
  setDockCollapsed(dockCollapsed, false);
  syncDecorationSettings(); setEditorMode(editorMode, false);

  function activate() {
    if (disposed || active) return !disposed;
    if (editorMode === 'orthogonal' && !nodeLibrary.hidden) renderDecorationPalette(paletteSearch.value);
    active = true; installListeners(); canvas.activate(); simulation.activate(); scheduleCompute(); return true;
  }

  function suspend() {
    if (disposed) return true;
    if (symbolLabelEditor?.isComposing()) return symbolLabelEditor.commit().then(() => suspend());
    symbolLabelEditor?.commit(); suspendSymbolPreviews(stage);
    cancelSymbolPreview(); cancelDockResize(); closeModeMenu(); closePresetContextMenu(); closePresetDialog();
    settlePageSwitchMotion(); resetRailWheel(); clearRailTransients();
    simulation.suspend(); cancelCompute();
    if (railHideTimer) clearTimeout(railHideTimer); railHideTimer = 0; rail.classList.remove('is-revealed');
    if (panelHitGuardTimer) clearTimeout(panelHitGuardTimer); panelHitGuardTimer = 0; sidePanel.classList.remove('is-hit-guarded');
    if (subcircuitCloseTimer) {
      clearTimeout(subcircuitCloseTimer); subcircuitCloseTimer = 0;
      subcircuitOverlay.hidden = true; subcircuitOverlay.classList.remove('is-closing');
      subcircuitPorts.replaceChildren(); pendingSubcircuit = null; subcircuitReturnFocus = null;
    }
    tutorial.suspend();
    if (settingsCloseTimer) clearTimeout(settingsCloseTimer);
    settingsCloseTimer = 0;
    settingsPanel.hidden = true;
    settingsPanel.classList.remove('is-closing');
    settingsOpen.setAttribute('aria-expanded', 'false');
    closeSettingsResetConfirmation();
    if (activeController) activeController.abort(); activeController = null;
    session.setPageView(renderedPageId, canvas.getViewState());
    scheduleSave(0);
    active = false; return canvas.suspend();
  }

  function dispose() {
    if (disposed) return true;
    if (symbolLabelEditor?.isComposing()) return symbolLabelEditor.commit().then(() => dispose());
    symbolLabelEditor?.commit(); disposeSymbolPreviews(stage);
    suspend(); flushSave({ force: true, keepalive: true }); disposed = true;
    if (saveTimer) clearTimeout(saveTimer); if (saveRetryTimer) clearTimeout(saveRetryTimer); if (saveStatusTimer) clearTimeout(saveStatusTimer);
    if (railHideTimer) clearTimeout(railHideTimer); railHideTimer = 0;
    if (panelHitGuardTimer) clearTimeout(panelHitGuardTimer); panelHitGuardTimer = 0;
    if (subcircuitCloseTimer) clearTimeout(subcircuitCloseTimer); subcircuitCloseTimer = 0;
    if (settingsCloseTimer) clearTimeout(settingsCloseTimer); settingsCloseTimer = 0;
    tutorial.dispose(); simulation.dispose(); if (modelUnsubscribe) modelUnsubscribe(); modelUnsubscribe = null;
    return canvas.dispose();
  }

  return Object.freeze({ activate, suspend, dispose });
}
