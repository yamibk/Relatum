import { RESEARCH_TUTORIAL_CHAPTERS, RESEARCH_TUTORIAL_PAGES } from './research-tutorial-content.js';
import { buildResearchTutorialExample } from './research-tutorial-examples.js';

const PROGRESS_KEY = 'research:tutorialProgress:v1';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function reducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function boundsOf(nodes) {
  return nodes.reduce((result, node) => ({
    left: Math.min(result.left, Number(node.x) || 0),
    top: Math.min(result.top, Number(node.y) || 0),
    right: Math.max(result.right, (Number(node.x) || 0) + (Number(node.width) || 168)),
    bottom: Math.max(result.bottom, (Number(node.y) || 0) + (Number(node.height) || 80)),
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
}

function overlaps(left, right, gap = 48) {
  return left.left < right.right + gap && left.right > right.left - gap
    && left.top < right.bottom + gap && left.bottom > right.top - gap;
}

function placeTemplate(template, model, visible) {
  const sourceBounds = boundsOf(template.nodes);
  const width = sourceBounds.right - sourceBounds.left;
  const height = sourceBounds.bottom - sourceBounds.top;
  const center = {
    x: (visible.left + visible.right) / 2,
    y: (visible.top + visible.bottom) / 2,
  };
  const base = {
    x: center.x - (sourceBounds.left + sourceBounds.right) / 2,
    y: center.y - (sourceBounds.top + sourceBounds.bottom) / 2,
  };
  const occupied = model.nodes().map((node) => ({
    left: node.x, top: node.y, right: node.x + node.width, bottom: node.y + node.height,
  }));
  const stepX = Math.max(320, width + 96);
  const stepY = Math.max(240, height + 96);
  const candidates = [{ x: 0, y: 0 }];
  for (let ring = 1; ring <= 6; ring += 1) {
    for (let x = -ring; x <= ring; x += 1) {
      candidates.push({ x: x * stepX, y: -ring * stepY }, { x: x * stepX, y: ring * stepY });
    }
    for (let y = -ring + 1; y < ring; y += 1) {
      candidates.push({ x: -ring * stepX, y: y * stepY }, { x: ring * stepX, y: y * stepY });
    }
  }
  let offset = null;
  for (const candidate of candidates) {
    const next = {
      left: sourceBounds.left + base.x + candidate.x,
      top: sourceBounds.top + base.y + candidate.y,
      right: sourceBounds.right + base.x + candidate.x,
      bottom: sourceBounds.bottom + base.y + candidate.y,
    };
    if (!occupied.some((item) => overlaps(next, item))) {
      offset = { x: base.x + candidate.x, y: base.y + candidate.y };
      break;
    }
  }
  if (!offset) {
    const content = occupied.length ? occupied.reduce((result, item) => ({
      left: Math.min(result.left, item.left), top: Math.min(result.top, item.top),
      right: Math.max(result.right, item.right), bottom: Math.max(result.bottom, item.bottom),
    }), occupied[0]) : { right: visible.right, top: visible.top };
    offset = { x: content.right + 96 - sourceBounds.left, y: content.top - sourceBounds.top };
  }
  return {
    ...template,
    nodes: template.nodes.map((node) => ({ ...node, x: node.x + offset.x, y: node.y + offset.y })),
  };
}

function appendSection(host, title, body) {
  const section = element('section', 'research-tutorial-section');
  section.append(element('h4', '', title), element('p', '', body));
  host.append(section);
}

function appendListSection(host, title, items) {
  const section = element('section', 'research-tutorial-section');
  section.append(element('h4', '', title));
  const list = element('ul');
  items.forEach((item) => list.append(element('li', '', item)));
  section.append(list); host.append(section);
}

function appendPorts(host, ports) {
  const section = element('section', 'research-tutorial-section research-tutorial-ports');
  section.append(element('h4', '', '端口'));
  if (!ports.length) {
    section.append(element('p', '', '没有计算端口；这个节点只参与知识关系。'));
    host.append(section); return;
  }
  const table = element('table');
  const head = element('thead'); const headRow = element('tr');
  ['端口', '方向', '通道与类型', '语义'].forEach((label) => headRow.append(element('th', '', label)));
  head.append(headRow); table.append(head);
  const body = element('tbody');
  ports.forEach((port) => {
    const row = element('tr'); port.forEach((cell) => row.append(element('td', '', cell))); body.append(row);
  });
  table.append(body); section.append(table); host.append(section);
}

function appendNodeDiagram(host, tutorialPage) {
  const ports = tutorialPage.ports || [];
  const inputs = ports.filter((port) => String(port[1] || '').includes('输入')).map((port) => port[0]);
  const outputs = ports.filter((port) => String(port[1] || '').includes('输出')).map((port) => port[0]);
  const figure = element('figure', 'research-tutorial-diagram');
  figure.append(element('figcaption', '', '连接示意'));
  const lane = element('div', 'research-tutorial-diagram-lane');
  const left = element('span', 'research-tutorial-diagram-terminal', inputs.length ? inputs.join(' / ') : (
    tutorialPage.nodeType === 'note' ? '说明与证据' : '配置或用户操作'
  ));
  const center = element('strong', '', tutorialPage.title.split('·')[0].trim());
  const right = element('span', 'research-tutorial-diagram-terminal', outputs.length ? outputs.join(' / ') : (
    tutorialPage.nodeType === 'note' ? '关系线' : '显示、记录或状态变化'
  ));
  lane.append(left, element('i', '', '→'), center, element('i', '', '→'), right);
  figure.append(lane); host.append(figure);
}

export function createResearchTutorial(options = {}) {
  const openButton = options.openButton;
  const overlay = options.overlay;
  const closeButton = options.closeButton;
  const root = options.root;
  if (!openButton || !overlay || !closeButton || !root) throw new Error('研究教程 DOM 不完整');
  const pageById = new Map(RESEARCH_TUTORIAL_PAGES.map((item, index) => [item.id, { item, index }]));
  let pageIndex = 0;
  let closeTimer = 0;
  let renderTimer = 0;
  let active = false;
  let returnFocus = null;

  try {
    const saved = pageById.get(localStorage.getItem(PROGRESS_KEY));
    if (saved) pageIndex = saved.index;
  } catch (_error) {}

  const layout = element('div', 'research-tutorial-layout');
  const navigation = element('nav', 'research-tutorial-nav');
  navigation.setAttribute('aria-label', '研究教程目录');
  const reading = element('div', 'research-tutorial-reading');
  const scroller = element('article', 'research-tutorial-page');
  scroller.setAttribute('tabindex', '0');
  const error = element('p', 'research-tutorial-error');
  error.hidden = true; error.tabIndex = -1; error.setAttribute('role', 'alert');
  const footer = element('footer', 'research-tutorial-footer');
  const previous = element('button', 'research-tutorial-previous', '上一步'); previous.type = 'button';
  const position = element('span', 'research-tutorial-position');
  const next = element('button', 'research-tutorial-next', '下一步'); next.type = 'button';
  footer.append(previous, position, next);
  reading.append(scroller, error, footer); layout.append(navigation, reading); root.replaceChildren(layout);

  function buildNavigation() {
    const fragment = document.createDocumentFragment();
    RESEARCH_TUTORIAL_CHAPTERS.forEach((chapter) => {
      const section = element('section', 'research-tutorial-chapter');
      section.dataset.chapter = chapter.id;
      section.append(element('h3', '', chapter.label), element('p', '', chapter.description));
      const list = element('div', 'research-tutorial-chapter-pages');
      RESEARCH_TUTORIAL_PAGES.forEach((tutorialPage, index) => {
        if (tutorialPage.chapter !== chapter.id) return;
        const button = element('button', '', tutorialPage.title); button.type = 'button';
        button.dataset.tutorialPage = String(index);
        button.setAttribute('aria-label', `${index + 1}. ${tutorialPage.title}`);
        list.append(button);
      });
      section.append(list); fragment.append(section);
    });
    navigation.replaceChildren(fragment);
  }

  function renderPage(options = {}) {
    if (renderTimer) clearTimeout(renderTimer);
    const tutorialPage = RESEARCH_TUTORIAL_PAGES[pageIndex];
    error.hidden = true; error.textContent = '';
    const header = element('header', 'research-tutorial-page-head');
    header.append(element('p', 'research-tutorial-kicker', tutorialPage.kicker));
    header.append(element('h3', '', tutorialPage.title));
    header.append(element('p', 'research-tutorial-lead', tutorialPage.lead));
    const content = element('div', 'research-tutorial-page-content');
    tutorialPage.sections.forEach((section) => appendSection(content, section.title, section.body));
    if (tutorialPage.nodeType) {
      appendNodeDiagram(content, tutorialPage);
      appendPorts(content, tutorialPage.ports || []);
      appendListSection(content, '属性配置', tutorialPage.settings || []);
      appendSection(content, '真实例子', tutorialPage.realExample);
      appendListSection(content, '常见错误', tutorialPage.pitfalls || []);
    }
    if (tutorialPage.exampleId) {
      const action = element('section', 'research-tutorial-example-action');
      action.append(element('strong', '', '把这一页变成可操作的电路'));
      action.append(element('p', '', '节点群会插入当前研究页，作为一次历史操作，可用 Ctrl+Z 整组撤销。'));
      const button = element('button', '', '生成此示例'); button.type = 'button';
      button.dataset.tutorialExample = tutorialPage.exampleId;
      action.append(button); content.append(action);
    }
    scroller.replaceChildren(header, content);
    scroller.scrollTop = 0;
    previous.disabled = pageIndex === 0;
    next.disabled = pageIndex === RESEARCH_TUTORIAL_PAGES.length - 1;
    next.textContent = next.disabled ? '已到最后一页' : '下一步';
    position.textContent = `${String(pageIndex + 1).padStart(2, '0')} / ${String(RESEARCH_TUTORIAL_PAGES.length).padStart(2, '0')}`;
    navigation.querySelectorAll('[data-tutorial-page]').forEach((button) => {
      const selected = Number(button.dataset.tutorialPage) === pageIndex;
      button.classList.toggle('is-active', selected);
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    const activeButton = navigation.querySelector(`[data-tutorial-page="${pageIndex}"]`);
    if (activeButton) activeButton.scrollIntoView({ block: 'nearest' });
    try { localStorage.setItem(PROGRESS_KEY, tutorialPage.id); } catch (_error) {}
    if (options.animate && !reducedMotion()) {
      scroller.classList.add('is-page-entering');
      scroller.dataset.direction = options.direction < 0 ? 'back' : 'forward';
      renderTimer = setTimeout(() => { renderTimer = 0; scroller.classList.remove('is-page-entering'); }, 240);
    }
  }

  function goTo(index, options = {}) {
    const target = Math.max(0, Math.min(RESEARCH_TUTORIAL_PAGES.length - 1, Number(index) || 0));
    if (target === pageIndex && !options.force) return;
    const direction = target < pageIndex ? -1 : 1;
    pageIndex = target; renderPage({ animate: options.animate !== false, direction });
  }

  function finishClose(focus, callback) {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = 0; overlay.hidden = true; overlay.classList.remove('is-closing');
    openButton.setAttribute('aria-expanded', 'false');
    if (typeof callback === 'function') callback();
    if (focus !== false && returnFocus && returnFocus.focus) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  function close(closeOptions = {}) {
    if (overlay.hidden) return false;
    if (closeTimer) clearTimeout(closeTimer);
    const done = () => finishClose(closeOptions.focus, closeOptions.afterClose);
    if (closeOptions.immediate || reducedMotion()) done();
    else {
      overlay.classList.add('is-closing');
      closeTimer = setTimeout(done, 190);
    }
    return true;
  }

  function open() {
    if (typeof options.beforeOpen === 'function') options.beforeOpen();
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = 0; overlay.classList.remove('is-closing'); overlay.hidden = false;
    openButton.setAttribute('aria-expanded', 'true'); returnFocus = document.activeElement;
    renderPage({ animate: false }); closeButton.focus({ preventScroll: true });
    return true;
  }

  function showError(message) {
    error.textContent = String(message || '无法生成示例，请稍后重试。'); error.hidden = false;
    error.focus?.({ preventScroll: true });
  }

  function insertExample(exampleId) {
    const template = buildResearchTutorialExample(exampleId);
    const model = typeof options.getModel === 'function' ? options.getModel() : null;
    const canvas = options.canvas;
    if (!template || !model || !canvas) { showError('示例或当前研究页不可用，没有改动画布。'); return; }
    const placed = placeTemplate(template, model, canvas.getVisibleWorldRect());
    const result = model.insertGraph(placed, { kind: 'tutorial-example-insert', tutorialExampleId: exampleId });
    if (!result) { showError('示例没有通过节点与端口校验，没有改动画布。'); return; }
    const title = template.title;
    close({
      focus: false,
      afterClose: () => {
        canvas.selectNodes(result.nodeIds);
        canvas.focusNodes(result.nodeIds);
        if (typeof options.onInserted === 'function') options.onInserted(title, result);
      },
    });
  }

  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(overlay.querySelectorAll('button:not(:disabled), [tabindex="0"]'))
      .filter((item) => !item.hidden && item.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function activate(signal) {
    if (active) return;
    active = true;
    openButton.addEventListener('click', open, { signal });
    closeButton.addEventListener('click', () => close(), { signal });
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); }, { signal });
    navigation.addEventListener('click', (event) => {
      const button = event.target.closest('[data-tutorial-page]');
      if (button) goTo(Number(button.dataset.tutorialPage));
    }, { signal });
    previous.addEventListener('click', () => goTo(pageIndex - 1), { signal });
    next.addEventListener('click', () => goTo(pageIndex + 1), { signal });
    scroller.addEventListener('click', (event) => {
      const button = event.target.closest('[data-tutorial-example]');
      if (button) insertExample(button.dataset.tutorialExample);
    }, { signal });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'ArrowLeft' && !event.target.closest('input,textarea,select')) {
        event.preventDefault(); event.stopPropagation(); goTo(pageIndex - 1); return;
      }
      if (event.key === 'ArrowRight' && !event.target.closest('input,textarea,select')) {
        event.preventDefault(); event.stopPropagation(); goTo(pageIndex + 1); return;
      }
      trapFocus(event);
    }, { signal });
  }

  function suspend() {
    active = false;
    if (renderTimer) clearTimeout(renderTimer); renderTimer = 0;
    close({ immediate: true, focus: false });
  }

  buildNavigation(); renderPage({ animate: false });
  return Object.freeze({
    activate, suspend, dispose: suspend, open, close,
    isOpen: () => !overlay.hidden,
    currentPage: () => RESEARCH_TUTORIAL_PAGES[pageIndex],
  });
}
