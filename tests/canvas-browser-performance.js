'use strict';

// Optional real-browser acceptance harness. Playwright is supplied by the test host;
// this is not an application dependency and introduces no npm/build requirement.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function installProbe(options) {
  localStorage.setItem('canvas:mode', 'normal');
  localStorage.setItem('canvas:normalSubmode', 'clean');
  localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
  localStorage.setItem('canvas:showMindmapFolds', '1');
  if (options.fallback) CanvasRenderingContext2D.prototype.isPointInStroke = undefined;
  let module;
  Object.defineProperty(window, 'CanvasModule', {
    configurable: true,
    get() { return module; },
    set(value) {
      module = value;
      const init = value.init;
      value.init = function (opts) {
        opts.initialViewport = { scale: 1, centerX: 330, centerY: 280 };
        window.__testData = opts.data;
        window.__testApi = init(opts);
        return window.__testApi;
      };
    },
  });
  window.__testLongTasks = [];
  new PerformanceObserver((list) => {
    __testLongTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, ms: entry.duration })));
  }).observe({ type: 'longtask', buffered: true });
  document.addEventListener('editor:selectionchange', (event) => { window.__testSelection = event.detail; });
  const serialize = XMLSerializer.prototype.serializeToString;
  XMLSerializer.prototype.serializeToString = function (node) {
    const result = serialize.call(this, node);
    if (result.includes('canvas-surface')) window.__testExportXml = result;
    return result;
  };
  window.__testBeginFrames = function () {
    let last = 0;
    const sample = { values: [], active: true };
    window.__testFrames = sample;
    requestAnimationFrame(function tick(stamp) {
      if (last) sample.values.push(stamp - last);
      last = stamp;
      if (sample.active) requestAnimationFrame(tick);
    });
  };
  window.__testEndFrames = function () {
    const sample = window.__testFrames;
    sample.active = false;
    const sorted = sample.values.slice().sort((a, b) => a - b);
    return { count: sorted.length, p95: sorted[Math.ceil(sorted.length * .95) - 1] || 0,
      max: sorted[sorted.length - 1] || 0, over33: sorted.filter((ms) => ms > 33.5).length };
  };
}

async function makePage(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 },
    deviceScaleFactor: options.dpr || 1, reducedMotion: options.reduced ? 'reduce' : 'no-preference' });
  await context.addInitScript(installProbe, options);
  if (options.protectFixtures) await context.route('**/api/save', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }),
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.testErrors = [];
  page.on('pageerror', (error) => page.testErrors.push(error.message));
  return page;
}

async function openCanvas(page, config, name) {
  await page.goto(config.url + '/editor.html?perf=1&file=' + encodeURIComponent(path.join(config.root, 'canvases', name + '.canvas')));
  await page.waitForFunction(() => window.__testApi && window.__relatumOpeningPerf?.interactiveMs > 0);
  const opening = await page.evaluate(() => ({ ...__relatumPerfSnapshot().opening,
    longestTaskMs: Math.max(0, ...__testLongTasks.map((task) => task.ms)) }));
  assert.deepEqual(page.testErrors, []);
  return opening;
}

async function edgePoint(page, a = 'a', b = 'b') {
  return page.evaluate(([a, b]) => {
    const first = document.querySelector('.node[data-id="' + a + '"]').getBoundingClientRect();
    const second = document.querySelector('.node[data-id="' + b + '"]').getBoundingClientRect();
    return { x: (first.right + second.left) / 2, y: first.top + first.height / 2 };
  }, [a, b]);
}

async function zoomFrames(page, overview = false) {
  if (overview) {
    await page.mouse.move(720, 420);
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(700);
  }
  return page.evaluate(async (overview) => {
    __testBeginFrames();
    const viewport = document.querySelector('.canvas-viewport');
    for (let i = 0; i < 24; i++) {
      viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
        clientX: 720, clientY: 420, deltaY: (i < 12 ? 1 : -1) * (overview ? 10 : 28) }));
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    return __testEndFrames();
  }, overview);
}

async function dragAndUndo(page, id) {
  const locator = page.locator('.node[data-id="' + id + '"]');
  const box = await locator.boundingBox();
  assert(box && box.x >= 0 && box.y >= 0);
  await page.evaluate((id) => {
    window.__testKeptNode = document.querySelector('.node[data-id="' + id + '"]');
    window.__testKeptRecord = CanvasModule.findNode(id);
    window.__testOriginalXY = { x: __testKeptRecord.x, y: __testKeptRecord.y };
    __testBeginFrames();
  }, id);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(x + i * 3, y + i * 2);
    await page.waitForTimeout(16);
  }
  const activeSvg = await page.evaluate(() => __relatumPerfSnapshot().edges.svgPaths);
  await page.mouse.up();
  await page.waitForTimeout(180);
  const frames = await page.evaluate(() => __testEndFrames());
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(180);
  assert(await page.evaluate((id) => __testKeptNode === document.querySelector('.node[data-id="' + id + '"]')
    && __testKeptRecord === CanvasModule.findNode(id)
    && __testKeptRecord.x === __testOriginalXY.x && __testKeptRecord.y === __testOriginalXY.y, id));
  return page.evaluate(({ frames, activeSvg }) => ({ frames, activeSvg,
    finish: __relatumPerfSnapshot().operations.filter((op) => op.kind === 'finish-node').pop(),
    undo: __relatumPerfSnapshot().operations.filter((op) => op.kind === 'undo').pop(),
    remainingSvg: __relatumPerfSnapshot().edges.svgPaths }), { frames, activeSvg });
}

async function panFrames(page) {
  await page.evaluate(() => __testBeginFrames());
  await page.keyboard.down('Space');
  await page.mouse.move(720, 450);
  await page.mouse.down();
  for (let i = 1; i <= 36; i++) {
    await page.mouse.move(720 + Math.sin(i / 6) * 140, 450 + Math.sin(i / 10) * 70);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForTimeout(300);
  return page.evaluate(() => __testEndFrames());
}

async function interactionRegression(browser, config, options) {
  const page = await makePage(browser, { ...options, protectFixtures: true });
  try {
    await openCanvas(page, config, 'perf-interactions');
    if (options.dark) await page.evaluate(() => {
      document.body.dataset.backgroundTone = 'dark';
      document.body.classList.add('dark-semantic-ui');
      document.dispatchEvent(new Event('canvas:edge-visual-refresh'));
    });
    let point = await edgePoint(page);
    await page.mouse.dblclick(point.x, point.y);
    const editing = page.locator('.canvas-edge-label.editing');
    assert.equal(await editing.getAttribute('data-id'), 'over', 'last edge must win overlap picking');
    await page.keyboard.insertText('连线命名');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => __testData.edges.find((edge) => edge.id === 'over').text), '连线命名');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.canvas-edge-label[data-id="over"]').count(), 0);
    await page.mouse.click(point.x, point.y);
    assert.equal(await page.evaluate(() => __testSelection.edges), 1);
    await page.keyboard.down('Control');
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Control');
    assert.equal(await page.evaluate(() => __testSelection.edges), 0, 'modifier click toggles off');
    await page.mouse.click(point.x, point.y, { button: 'right' });
    assert(await page.locator('[data-role="edge-menu"]').isVisible());
    await page.keyboard.press('Escape');
    // Synthetic composition events plus browser text insertion preserve the Chinese model.
    await page.locator('.node[data-id="a"]').dblclick();
    await page.locator('.node[data-id="a"] .node-text').evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    });
    await page.keyboard.insertText('中文组合输入');
    await page.locator('.node[data-id="a"] .node-text').evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文组合输入' }));
    });
    await page.keyboard.press('Enter');
    await page.evaluate(() => CanvasModule.commitPendingEdits());
    assert(await page.evaluate(() => CanvasModule.findNode('a').text.includes('中文组合输入')));
    const beforeLanguage = await page.evaluate(() => JSON.stringify(__testData));
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.evaluate(() => JSON.stringify(__testData)), beforeLanguage);
    await page.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => JSON.stringify(__testData)), beforeLanguage);
    // Restore a new/deleted node and then a kind change without losing unrelated DOM.
    await page.evaluate(() => { window.__testUnchanged = document.querySelector('.node[data-id="b"]'); });
    await page.locator('.node[data-id="d"]').click();
    await page.keyboard.press('Delete');
    await page.keyboard.press('Control+z');
    assert.equal(await page.locator('.node[data-id="d"]').count(), 1);
    assert(await page.evaluate(() => __testUnchanged === document.querySelector('.node[data-id="b"]')));
    const kindHistory = await page.evaluate(() => {
      const record = CanvasModule.findNode('a');
      const original = JSON.stringify(record);
      return ['code', 'sticky', 'index', 'preview'].map((kind) => {
        CanvasModule.switchSingleNodeKind('a', kind);
        CanvasModule.pushHistory();
        CanvasModule.notify();
        __testApi.undo();
        const el = document.querySelector('.node[data-id="a"]');
        const restored = JSON.stringify(record) === original && el.dataset.kind === 'card'
          && !el.querySelector('.code-node-pre');
        __testApi.redo();
        const redone = document.querySelector('.node[data-id="a"]');
        const replayed = record.kind === kind && redone.dataset.kind === kind
          && (kind !== 'code' || !!redone.querySelector('.code-node-pre'));
        __testApi.undo();
        return { kind, restored, replayed, identity: record === CanvasModule.findNode('a')
          && __testUnchanged === document.querySelector('.node[data-id="b"]') };
      });
    });
    assert(kindHistory.every((result) => result.restored && result.replayed && result.identity),
      'kind undo must restore content and preserve unrelated DOM/record identity');
    // Bending is driven through the same pending-drag handler as the SVG fallback.
    point = await edgePoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 20, point.y + 90, { steps: 6 });
    await page.mouse.up();
    assert(await page.evaluate(() => __testData.edges.find((edge) => edge.id === 'over').waypoints?.length > 0));
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => __testData.edges.find((edge) => edge.id === 'over').waypoints?.length || 0), 0);
    // Export must materialize every data edge despite an empty static SVG layer.
    const exportResult = await page.evaluate(async () => {
      const { blob } = await CanvasModule.exportImage({ scale: 1 });
      const xml = new DOMParser().parseFromString(__testExportXml, 'image/svg+xml');
      const paths = Array.from(xml.querySelectorAll('.canvas-edge'));
      const curve = paths.find((path) => path.getAttribute('data-id') === 'curve');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', curve.getAttribute('d'));
      const mid = path.getPointAtLength(path.getTotalLength() / 2);
      const label = document.querySelector('.canvas-edge-label[data-id="curve"]');
      return { type: blob.type, size: blob.size, paths: paths.length,
        midpointError: Math.hypot(parseFloat(label.style.left) - mid.x, parseFloat(label.style.top) - mid.y) };
    });
    assert.equal(exportResult.type, 'image/png');
    assert(exportResult.size > 1000);
    assert.equal(exportResult.paths, 3);
    assert(exportResult.midpointError < .2, 'curve label must use the native path midpoint');
    assert.deepEqual(page.testErrors, []);
    return { ...options, kindHistory, exportResult, backend: await page.evaluate(() => __relatumPerfSnapshot().edges.hitBackend) };
  } finally { await page.context().close(); }
}

async function lifecycleRegression(browser, config) {
  const page = await makePage(browser, { protectFixtures: true });
  const results = {};
  try {
    await openCanvas(page, config, 'perf-tree');
    await page.evaluate(() => { window.__testChild = document.querySelector('.node[data-id="child"]'); });
    await page.locator('.node[data-id="root"] .node-mindmap-fold').dispatchEvent('click');
    assert(await page.locator('.node[data-id="child"]').evaluate((el) => el.classList.contains('mindmap-fold-hidden')));
    await page.evaluate(() => __testApi.undo());
    assert(await page.evaluate(() => __testChild === document.querySelector('.node[data-id="child"]')
      && !__testChild.classList.contains('mindmap-fold-hidden')));
    await page.locator('.node[data-id="group"] .group-collapse-btn').dispatchEvent('click');
    assert(await page.locator('.node[data-id="member"]').evaluate((el) => el.classList.contains('group-fold-hidden')));
    await page.evaluate(() => __testApi.undo());
    assert(await page.locator('.node[data-id="member"]').evaluate((el) => !el.classList.contains('group-fold-hidden')));
    await page.locator('.node[data-id="root"]').click();
    await page.evaluate(() => CanvasModule.applyMindmap('right'));
    await page.waitForTimeout(650);
    assert.equal(await page.evaluate(() => __relatumPerfSnapshot().edges.activeSvg), 0);
    await page.evaluate(() => __testApi.undo());
    assert(await page.evaluate(() => __testChild === document.querySelector('.node[data-id="child"]')));
    results.foldingAndMindmap = true;
    results.taskbook = await page.evaluate(() => {
      const root = CanvasModule.createTopLevelTask({ title: '回归任务' });
      const task = CanvasModule.addTaskbookTask(root.id, null, { title: '任务叶子' });
      CanvasModule.updateTaskbookTask(root.id, task.id, { done: true });
      const completed = __testData.taskbook.roots.find((item) => item.id === root.id).completed;
      __testApi.undo();
      const undone = __testData.taskbook.roots.find((item) => item.id === root.id).completed;
      __testApi.redo();
      const redone = __testData.taskbook.roots.find((item) => item.id === root.id).completed;
      return { completed, undone, redone };
    });
    assert.deepEqual(results.taskbook, { completed: true, undone: false, redone: true });
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('canvas:taskbook-leaf-timer-buttons-enabled', { detail: false }));
      document.dispatchEvent(new CustomEvent('canvas:taskbook-leaf-timer-buttons-enabled', { detail: true }));
    });

    for (const [fixture, id, type] of [['perf-images', 'image-0', 'image'], ['perf-markdown', 'md-0', 'md'], ['perf-pdf', 'pdf-0', 'pdf']]) {
      await openCanvas(page, config, fixture);
      await page.waitForFunction((type) => {
        const perf = __relatumPerfSnapshot();
        return type === 'image' ? perf.images.loaded > 0
          : type === 'pdf' ? perf.attachments.pdfCanvases > 0 : perf.attachments.markdown > 0 && perf.attachments.markdownInflight === 0;
      }, type);
      await page.evaluate((id) => {
        window.__testAsset = document.querySelector('.node[data-id="' + id + '"]');
        window.__testHeavy = __testAsset.querySelector('img, canvas, .attach-body')?.firstElementChild
          || __testAsset.querySelector('img, canvas, .attach-body');
        window.__testAssetCount = __testData.nodes.length;
      }, id);
      await page.mouse.dblclick(1100, 730);
      await page.keyboard.insertText('附件旁的卡片');
      await page.keyboard.press('Enter');
      await page.evaluate(() => CanvasModule.commitPendingEdits());
      assert.equal(await page.evaluate(() => __testData.nodes.length - __testAssetCount), 1);
      await page.evaluate(() => __testApi.undo());
      assert(await page.evaluate((id) => __testAsset === document.querySelector('.node[data-id="' + id + '"]')
        && __testHeavy && __testHeavy.isConnected && __testData.nodes.length === __testAssetCount, id), type + ' runtime was unnecessarily rebuilt');
      results[type] = await page.evaluate(() => ({ images: __relatumPerfSnapshot().images, attachments: __relatumPerfSnapshot().attachments }));
    }
    assert.deepEqual(page.testErrors, []);
    return results;
  } finally { await page.context().close(); }
}

async function groupAndTextRegression(browser, config, options = {}) {
  const name = options.reduced ? 'group-text-reduced' : 'group-text';
  const fixtureFile = path.join(config.root, 'canvases', name + '.canvas');
  const group = { kind: 'shape', shapeType: 'group-box', x: -40, y: 280, width: 380, title: '旧分组' };
  fs.writeFileSync(fixtureFile, JSON.stringify({ version: 2, nodes: [
    { id: 'a', kind: 'card', text: '标题', x: 0, y: 55 },
    { id: 'b', kind: 'card', text: '组员', x: 180, y: 105 },
    { id: 'c', kind: 'card', text: '组外', x: 390, y: 105 },
    { id: 'legacy', ...group, height: 46, groupExpandedHeight: 160, groupCollapsed: true, groupMemberIds: ['d', 'b'] },
    { id: 'd', kind: 'card', text: '旧组员', x: 60, y: 340 },
    { id: 'box', ...group, x: 480, height: 80, title: '空盒子' },
  ], edges: [{ id: 'member-link', from: 'b', to: 'c', arrow: 'end' }] }), { flag: 'wx' });

  const page = await makePage(browser, options);
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  try {
    await openCanvas(page, config, name);
    if (options.dark) await page.evaluate(() => {
      document.documentElement.classList.add('dark-semantic-ui');
      document.querySelector('.editor-page').dataset.backgroundTone = 'dark';
    });
    const node = (id) => page.locator('.node[data-id="' + id + '"]');
    const text = node('a').locator(':scope > .node-text');
    const dimensions = (element) => element.evaluate((el) => [el.offsetWidth, el.offsetHeight]);
    const model = (id) => page.evaluate((id) => CanvasModule.findNode(id), id);
    const undo = () => page.evaluate(() => __testApi.undo());
    const redo = () => page.evaluate(() => __testApi.redo());
    const edit = async () => {
      await text.dblclick();
      await page.keyboard.press('Control+a');
    };

    await edit();
    await page.keyboard.insertText('123');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('456');
    assert.equal(await text.innerText(), '123\n456');
    const editSize = await dimensions(node('a'));
    await page.keyboard.press('Control+Enter');
    assert.equal((await model('a')).text, '123\n456');
    assert.equal(await text.innerText(), '123\n456');
    assert.deepEqual(await dimensions(node('a')), editSize, 'plain text keeps its edit-time dimensions');
    await undo();
    assert.equal(await text.innerText(), '标题');
    await redo();
    assert.equal(await text.innerText(), '123\n456');

    const legacy = node('legacy');
    const legacyPill = legacy.locator('.group-header');
    assert(await legacyPill.isVisible());
    assert((await dimensions(legacy))[0] < 380, 'legacy fold opens as a compact capsule');
    assert.equal(await node('d').isVisible(), false);
    assert.equal(await node('box').locator('.group-collapse-btn').count(), 0);
    await legacy.locator('.group-collapse-btn').click();
    assert(await node('d').isVisible());
    assert.deepEqual(await dimensions(legacy), [380, 160], 'legacy expanded dimensions survive');

    const a = await node('a').boundingBox(), b = await node('b').boundingBox();
    await page.mouse.move(a.x - 24, a.y - 24);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width + 24, b.y + b.height + 24, { steps: 7 });
    await page.mouse.up();
    await page.getByRole('button', { name: '+ 分组', exact: true }).click();
    const newGroup = await page.evaluate(() => __testData.nodes.find((node) => node.groupMemberIds?.includes('a')));
    assert.deepEqual(newGroup.groupMemberIds, ['a', 'b']);
    const frame = node(newGroup.id);
    const expanded = await dimensions(frame);
    const title = frame.locator('.decor-box-title');
    const foldButton = frame.locator('.group-collapse-btn');
    const menu = page.locator('[data-role="node-menu"]');
    const fold = menu.locator('[data-action="group-fold"]');
    const ungroup = menu.locator('[data-action="group-ungroup"]');
    const openMenu = () => title.click({ button: 'right' });
    const screenshot = async (state) => {
      const output = !options.reduced && process.env.RELATUM_ARTIFACT_DIR;
      if (!output) return;
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, 'canvas-group-' + state + '.png'), animations: 'disabled' });
    };

    await title.click();
    assert.equal(await frame.evaluate((el) => el.classList.contains('selected')), true);
    assert.equal(await title.evaluate((el) => el.isContentEditable), false, 'single click selects the title');
    await title.dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText('123');
    await page.keyboard.press('Enter');
    assert.equal((await model(newGroup.id)).title, '123');
    await screenshot('expanded');
    await openMenu();
    assert.equal(await fold.innerText(), '折叠分组');
    assert.equal(await ungroup.innerText(), '解散分组');
    await fold.click();
    await node('a').waitFor({ state: 'hidden' });
    await node('b').waitFor({ state: 'hidden' });
    const beforeResize = await dimensions(frame);
    assert(beforeResize[0] < expanded[0] && beforeResize[1] < expanded[1]);
    assert.equal(await frame.locator('.decor-group-box').isVisible(), false);
    assert.match(await foldButton.innerText(), /^\+\s*2$/);
    assert(await frame.locator('.group-header').evaluate((header) => (
      header.contains(header.querySelector('.decor-box-title')) && header.contains(header.querySelector('.group-collapse-btn'))
      && getComputedStyle(header).borderRadius !== '0px'
    )));
    if (options.reduced) assert.equal(await frame.evaluate((el) => el.getAnimations({ subtree: true }).length), 0);
    await screenshot('collapsed');

    await title.click();
    const handle = await frame.locator('.decor-resize-se').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 50, handle.y + handle.height / 2 + 25, { steps: 5 });
    await page.mouse.up();
    const resized = await dimensions(frame);
    assert(resized[0] > beforeResize[0] && resized[1] > beforeResize[1], 'selected capsule resizes in canvas mode');
    assert.deepEqual([(await model(newGroup.id)).width, (await model(newGroup.id)).height], expanded);
    await undo();
    assert.deepEqual(await dimensions(frame), beforeResize);
    await redo();
    assert.deepEqual(await dimensions(frame), resized);

    await openMenu();
    assert.equal(await fold.innerText(), '展开分组');
    await fold.click();
    assert.deepEqual(await dimensions(frame), expanded);
    assert(await node('a').isVisible());
    const transition = await frame.evaluate((el) => {
      const button = el.querySelector('.group-collapse-btn');
      button.click();
      button.click();
      return { overlays: el.querySelectorAll('.group-fold-motion').length, expanded: button.getAttribute('aria-expanded') };
    });
    assert.deepEqual(transition, { overlays: options.reduced ? 0 : 1, expanded: 'true' });
    await openMenu();
    await fold.click();
    assert.deepEqual(await dimensions(frame), resized);
    const exportInfo = await page.evaluate(async (groupId) => {
      const result = await CanvasModule.exportImage({ scale: 1 });
      const exportDom = new DOMParser().parseFromString(__testExportXml, 'image/svg+xml');
      const exportGroup = exportDom.querySelector('.node[data-id="' + groupId + '"]');
      return { type: result.blob.type, copies: exportDom.querySelectorAll('.node[data-id="' + groupId + '"]').length,
        capsule: exportGroup?.classList.contains('group-collapsed'),
        noOverlay: !exportGroup?.querySelector('.group-fold-motion'),
        hiddenEdge: !exportDom.querySelector('.canvas-edge[data-id="member-link"]') };
    }, newGroup.id);
    assert.deepEqual(exportInfo, { type: 'image/png', copies: 1, capsule: true, noOverlay: true, hiddenEdge: true });
    const overlaysOnHide = await frame.evaluate((el) => {
      const button = el.querySelector('.group-collapse-btn');
      button.click();
      button.click();
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      return el.querySelectorAll('.group-fold-motion').length;
    });
    assert.equal(overlaysOnHide, 0);
    assert.equal(await page.evaluate(() => EditorShell.saveNow()), true);
    const saved = JSON.parse(fs.readFileSync(fixtureFile, 'utf8')).nodes;
    assert.equal(saved.find((item) => item.id === 'a').text, '123\n456');
    const savedGroup = saved.find((item) => item.id === newGroup.id);
    assert.equal(savedGroup.groupCollapsed, true);
    assert.deepEqual([savedGroup.groupCollapsedWidth, savedGroup.groupCollapsedHeight], resized);
    await openCanvas(page, config, name);
    assert.deepEqual(await dimensions(frame), resized);
    assert(await node('a').evaluate((el) => el.classList.contains('group-fold-hidden')));
    await node('a').waitFor({ state: 'hidden' });
    await legacy.locator('.group-collapse-btn').click();
    await openMenu();
    await ungroup.click();
    await frame.waitFor({ state: 'detached' });
    await node('a').waitFor({ state: 'visible' });
    assert.equal(await text.innerText(), '123\n456');
    await node('b').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => __testData.edges.some((edge) => edge.id === 'member-link')), true);
    await undo();
    assert(await frame.isVisible());
    await node('a').waitFor({ state: 'hidden' });
    await redo();
    await frame.waitFor({ state: 'detached' });
    await node('a').waitFor({ state: 'visible' });
    await legacy.locator('.group-collapse-btn').click();
    await node('b').waitFor({ state: 'visible' });

    await edit();
    await page.keyboard.insertText('第一行');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('第三行');
    const blankLineSize = await dimensions(node('a'));
    await page.keyboard.press('Control+Enter');
    assert.equal((await model('a')).text, '第一行\n\n第三行');
    assert.deepEqual(await dimensions(node('a')), blankLineSize);
    await undo();

    await edit();
    const markdownSource = '**粗体**\n<样本>\n\n- 项目\n\n```js\nconst a = 1;\nconst b = 2;\n```';
    await text.evaluate((el, source) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', source.replace(/\n/g, '\r\n'));
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    }, markdownSource);
    await page.keyboard.press('Control+Enter');
    assert.equal((await model('a')).text, markdownSource.replace('**粗体**', '粗体'));
    assert.equal((await model('a')).textMarks[0].bold, true);
    assert.equal(await text.locator('strong').innerText(), '粗体');
    assert.equal(await text.locator('p').first().innerText(), '粗体\n<样本>');
    assert.equal(await text.locator('li').innerText(), '项目');
    assert.match(await text.locator('pre code').innerText(), /const a = 1;\nconst b = 2;/);
    await undo();
    assert.equal(await text.innerText(), '123\n456');

    await edit();
    await page.keyboard.insertText('第一行');
    await page.keyboard.press('Enter');
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
      assert.equal((await model('a')).text, '123\n456', 'IME preedit stays outside saved source');
      await cdp.send('Input.insertText', { text: '中文' });
      await page.keyboard.press('Control+Enter');
    } finally { await cdp.detach(); }
    assert.equal((await model('a')).text, '第一行\n中文');
    assert.equal(await text.innerText(), '第一行\n中文');
    assert(!requests.some((url) => /\/vendor\/(?:mathjax|mermaid)\//i.test(url)), 'plain text and code do not load diagram or math runtimes');
    assert.deepEqual(page.testErrors, []);
    return { ...options, editSize, expanded, beforeResize, resized };
  } finally { await page.context().close(); }
}

async function translationAndDualRegression(browser, config) {
  const page = await makePage(browser, { protectFixtures: true });
  try {
    await openCanvas(page, config, 'perf-interactions');
    const translation = await page.evaluate(async () => {
      RelatumI18n.setLanguage('en');
      await new Promise((resolve) => setTimeout(resolve, 0));
      let globalWrites = 0;
      const observer = new MutationObserver((records) => { globalWrites += records.length; });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang', 'data-ui-language'] });
      const geometry = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      geometry.classList.add('canvas-edges-layer');
      for (let i = 0; i < 1000; i++) geometry.appendChild(document.createElementNS(geometry.namespaceURI, 'path'));
      document.body.appendChild(geometry);
      const button = document.createElement('button');
      button.textContent = '保存';
      document.body.appendChild(button);
      const user = document.createElement('div');
      user.dataset.userContent = 'true';
      user.innerHTML = '<span>保存</span><input placeholder="保存" value="保存">';
      document.body.appendChild(user);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const dynamic = button.textContent === RelatumI18n.t('保存');
      observer.disconnect();
      RelatumI18n.setLanguage('zh-CN');
      RelatumI18n.setLanguage('en');
      const protectedContent = user.querySelector('span').textContent === '保存'
        && user.querySelector('input').value === '保存'
        && user.querySelector('input').placeholder === RelatumI18n.t('保存');
      geometry.remove(); button.remove(); user.remove();
      RelatumI18n.setLanguage('zh-CN');
      return { globalWrites, dynamic, protectedContent };
    });
    assert.deepEqual(translation, { globalWrites: 0, dynamic: true, protectedContent: true });
    await page.evaluate(() => {
      window.__testAppearanceReads = 0;
      const original = window.getComputedStyle;
      window.getComputedStyle = function (...args) {
        if (new Error().stack.includes('appearancePayload')) __testAppearanceReads++;
        return original.apply(this, args);
      };
    });
    const churnClasses = async () => page.evaluate(async () => {
      __testAppearanceReads = 0;
      for (let i = 0; i < 12; i++) {
        document.querySelector('.canvas-viewport').classList.toggle('test-interaction');
        await new Promise(requestAnimationFrame);
      }
      return __testAppearanceReads;
    });
    assert.equal(await churnClasses(), 0, 'closed dual view must not read appearance');
    await page.locator('[data-action="dual-screen"]').evaluate((button) => button.click());
    await page.waitForFunction(() => document.body.classList.contains('dual-screen-open'));
    await page.waitForTimeout(350);
    assert.equal(await churnClasses(), 0, 'unrelated interaction classes must not resync appearance');
    const appearanceReads = await page.evaluate(async () => {
      __testAppearanceReads = 0;
      const viewport = document.querySelector('.canvas-viewport');
      for (let i = 0; i < 20; i++) viewport.style.setProperty('--canvas-background-fill', 'rgb(' + i + ', 30, 40)');
      await new Promise((resolve) => setTimeout(resolve, 100));
      return __testAppearanceReads;
    });
    assert(appearanceReads > 0 && appearanceReads <= 3, 'background updates must coalesce into one payload');
    await page.locator('[data-role="dual-files"]').getByText('perf-tree', { exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some((frame) => frame.contentWindow?.__testApi));
    const reference = page.frames().find((frame) => frame.url().includes('dual-viewer.html'));
    assert(reference);
    await reference.locator('.node[data-id="child"]').click();
    assert(await reference.locator('.node[data-id="child"]').evaluate((el) => el.classList.contains('selected')));
    const backingAligned = await page.evaluate(() => {
      const viewport = document.querySelector('.canvas-viewport').getBoundingClientRect();
      return Math.abs(document.querySelector('.canvas-edges-canvas').width - Math.round(viewport.width * devicePixelRatio)) <= 1;
    });
    assert(backingAligned);
    await page.locator('[data-action="close-dual-screen"]').click();
    await page.waitForFunction(() => !document.body.classList.contains('dual-screen-open'));
    assert.equal(await churnClasses(), 0);
    assert.deepEqual(page.testErrors, []);
    return { translation, appearanceReads, backingAligned, referenceSelection: true };
  } finally { await page.context().close(); }
}

async function startRegression(browser, config) {
  const page = await makePage(browser);
  try {
    await page.goto(config.url + '/index.html');
    await page.locator('.study-spine-tab[data-action="study-view"]').waitFor({ state: 'visible' });
    await page.waitForTimeout(700);
    const views = ['study', 'tree-page', 'notes', 'cadence', 'calendar', 'review', 'focus'];
    const frames = {};
    for (const view of views) {
      await page.evaluate(() => __testBeginFrames());
      await page.locator('.study-spine-tab[data-action="' + view + '-view"]').click();
      await page.waitForTimeout(700);
      frames[view] = await page.evaluate(() => __testEndFrames());
    }
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    await page.evaluate(() => __testBeginFrames());
    for (const view of ['study', 'calendar', 'study', 'focus', 'tree-page', 'notes']) {
      await page.locator('.study-spine-tab[data-action="' + view + '-view"]').evaluate((button) => button.click());
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(800);
    frames.reversal = await page.evaluate(() => __testEndFrames());
    await page.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    assert.deepEqual(page.testErrors, []);
    return frames;
  } finally { await page.context().close(); }
}

async function benchmark(playwright, config) {
  const results = [];
  for (const [fixture, count, id] of [['perf-edges', 1200, 'node-0'], ['perf-3000', 3000, 'large-0']]) {
    for (let run = 1; run <= config.runs; run++) {
      const browser = await playwright.chromium.launch({ headless: true, executablePath: config.edge });
      try {
        const page = await makePage(browser);
        const cold = await openCanvas(page, config, fixture);
        // Same page/context keeps the HTTP/V8/font caches for the warm run.
        const warm = await openCanvas(page, config, fixture);
        await page.waitForTimeout(500);
        const drag = await dragAndUndo(page, id);
        const localZoom = await zoomFrames(page);
        const pan = await panFrames(page);
        const overviewZoom = await zoomFrames(page, true);
        const item = { count, run, cold, warm, drag, localZoom, pan, overviewZoom, errors: page.testErrors };
        assert.deepEqual(item.errors, []);
        results.push(item);
        console.log(JSON.stringify(item));
      } finally { await browser.close(); }
    }
  }
  return results;
}

async function main() {
  const [url, runtimeRoot, outputPath, mode = 'all'] = process.argv.slice(2);
  if (!url || !runtimeRoot || !outputPath) {
    console.log('Optional browser test: node tests/canvas-browser-performance.js <local URL> <isolated runtime root> <report.json> [all|regression|benchmark]');
    return;
  }
  const root = fs.realpathSync(runtimeRoot);
  const source = fs.realpathSync(path.resolve(__dirname, '..'));
  assert(root !== source && !root.startsWith(source + path.sep), 'use an isolated runtime directory');
  assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
  const config = { url, root, edge: process.env.RELATUM_EDGE_PATH, runs: Number(process.env.RELATUM_PERF_RUNS) || 5 };
  const playwright = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
  const report = { viewport: { width: 1440, height: 900 }, fixedCamera: { scale: 1, centerX: 330, centerY: 280 } };
  if (mode !== 'benchmark') {
    const browser = await playwright.chromium.launch({ headless: true, executablePath: config.edge });
    try {
      report.browser = browser.version();
      report.regressions = [];
      for (const options of [{}, { dark: true, dpr: 2, reduced: true }, { fallback: true }]) {
        report.regressions.push(await interactionRegression(browser, config, options));
      }
      report.lifecycle = await lifecycleRegression(browser, config);
      report.translationAndDual = await translationAndDualRegression(browser, config);
      report.start = await startRegression(browser, config);
    } finally { await browser.close(); }
  }
  if (mode !== 'regression') report.benchmarks = await benchmark(playwright, config);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log('Browser report: ' + outputPath);
}

module.exports = { installProbe, makePage, openCanvas, edgePoint, zoomFrames, dragAndUndo, panFrames,
  interactionRegression, lifecycleRegression, groupAndTextRegression, translationAndDualRegression, startRegression };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
