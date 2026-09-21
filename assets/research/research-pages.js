const DEFAULT_VIEW = Object.freeze({ x: 0, y: 0, scale: 1 });

function normalizeView(source) {
  const view = source && typeof source === 'object' ? source : DEFAULT_VIEW;
  return {
    x: Number.isFinite(Number(view.x)) ? Number(view.x) : DEFAULT_VIEW.x,
    y: Number.isFinite(Number(view.y)) ? Number(view.y) : DEFAULT_VIEW.y,
    scale: Number.isFinite(Number(view.scale)) ? Number(view.scale) : DEFAULT_VIEW.scale,
  };
}

function modelIsEmpty(model) {
  if (!model) return true;
  if (typeof model.isEmpty === 'function') return model.isEmpty();
  const nodes = typeof model.nodes === 'function' ? model.nodes() : [];
  const edges = typeof model.edges === 'function' ? model.edges() : [];
  return nodes.length === 0 && edges.length === 0;
}

function normalizeSimulation(source) {
  const speed = source && Number(source.speed);
  return { speed: [0.25, 0.5, 1, 2, 4].includes(speed) ? speed : 1 };
}

export class ResearchPageSession {
  constructor(options = {}) {
    if (typeof options.createModel !== 'function') {
      throw new Error('研究分页需要模型工厂');
    }
    this.createModel = options.createModel;
    this.subcircuitCatalog = options.subcircuitCatalog || null;
    this.nextPageNumber = 1;
    this.pageRecords = [];
    this.activePageId = '';
    const document = options.document && typeof options.document === 'object' ? options.document : {};
    const sourcePages = Array.isArray(document.pages) ? document.pages : [];
    sourcePages.forEach((source) => this.pageRecords.push(this.makePage(source)));
    if (!this.pageRecords.length) this.pageRecords.push(this.makePage());
    const requestedActive = String(document.activePageId || '');
    this.activePageId = this.page(requestedActive) ? requestedActive : this.pageRecords[0].id;
    this.pageRecords.forEach((page) => {
      const match = /^research-page-(\d+)$/.exec(page.id);
      if (match) this.nextPageNumber = Math.max(this.nextPageNumber, Number(match[1]) + 1);
    });
  }

  makePage(source = {}) {
    let pageId = String(source.id || '');
    if (!pageId) {
      do {
        pageId = 'research-page-' + this.nextPageNumber;
        this.nextPageNumber += 1;
      } while (this.page(pageId));
    }
    return {
      id: pageId,
      title: String(source.title || ''),
      model: this.createModel({ nodes: source.nodes, edges: source.edges }),
      view: normalizeView(source.view),
      simulation: normalizeSimulation(source.simulation),
      runtime: {
        computeProjection: null,
        lastRun: null,
        computeCache: null,
        dirtyNodeIds: new Set(),
        topologyDirty: true,
        simulationState: null,
      },
    };
  }

  pages() {
    return this.pageRecords.slice();
  }

  page(pageId) {
    return this.pageRecords.find((page) => page.id === String(pageId || '')) || null;
  }

  activePage() {
    return this.page(this.activePageId) || this.pageRecords[0] || null;
  }

  activeIndex() {
    return this.pageRecords.findIndex((page) => page.id === this.activePageId);
  }

  toDocument(stateProvider = null) {
    return {
      researchVersion: 3,
      subcircuits: this.subcircuitCatalog ? this.subcircuitCatalog.snapshot() : [],
      pages: this.pageRecords.map((page) => {
        const snapshot = page.model.snapshot();
        const persisted = typeof stateProvider === 'function' ? stateProvider(page) || {} : {};
        return {
          id: page.id,
          title: page.title,
          nodes: snapshot.nodes.map((node) => {
            if (node.statePolicy !== 'persist') {
              const clean = { ...node }; delete clean.savedState; return clean;
            }
            return persisted[node.id] ? { ...node, savedState: persisted[node.id] } : node;
          }),
          edges: snapshot.edges,
          view: normalizeView(page.view),
          simulation: normalizeSimulation(page.simulation),
        };
      }),
      activePageId: this.activePageId,
    };
  }

  indexOf(pageId) {
    return this.pageRecords.findIndex((page) => page.id === String(pageId || ''));
  }

  setPageView(pageId, view) {
    const page = this.page(pageId);
    if (!page) return false;
    const next = normalizeView(view);
    if (page.view.x === next.x && page.view.y === next.y && page.view.scale === next.scale) return false;
    page.view = next;
    return true;
  }

  setPageSpeed(pageId, speed) {
    const page = this.page(pageId);
    if (!page || ![0.25, 0.5, 1, 2, 4].includes(Number(speed))) return false;
    if (page.simulation.speed === Number(speed)) return false;
    page.simulation = { speed: Number(speed) };
    return true;
  }

  createPage(options = {}) {
    const page = this.makePage();
    this.pageRecords.push(page);
    if (options.activate !== false) this.activePageId = page.id;
    return page;
  }

  activatePage(pageId) {
    const page = this.page(pageId);
    if (!page) return null;
    this.activePageId = page.id;
    return page;
  }

  canDeleteActivePage() {
    const index = this.activeIndex();
    const page = this.activePage();
    return index > 0 && !!page && modelIsEmpty(page.model);
  }

  deleteActiveEmptyPage() {
    if (!this.canDeleteActivePage()) return null;
    const index = this.activeIndex();
    const removed = this.pageRecords.splice(index, 1)[0];
    const fallback = this.pageRecords[Math.max(0, index - 1)] || this.pageRecords[0] || null;
    this.activePageId = fallback ? fallback.id : '';
    return { removed, active: fallback };
  }
}

export function createResearchPageSession(options) {
  return new ResearchPageSession(options);
}
