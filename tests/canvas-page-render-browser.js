'use strict';

// Production homepage and scripts, with disposable server data and controlled API timing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');

const root = path.resolve(__dirname, '..');
const studySpine = '.left-spine [data-action="study-view"]';
const notesSpine = '.left-spine [data-action="notes-view"]';
const routeHosts = [
  { file: 'tree-page', endpoint: 'tree-page', selector: '.tree-page-embedded',
    command: 'tree-page-command', cacheKey: '_relatumTreePageData' },
  { file: 'study-route', endpoint: 'study', selector: '.study-route-overlay',
    command: 'study-goal-tree-command', cacheKey: '_relatumStudyData' },
];

function fixture(count, version = 6) {
  const tasks = Array.from({ length: count }, (_, i) => ({
    id: 'task-' + i, title: '任务 ' + i, status: i % 9 === 0 ? 'done' : 'active',
    taskPage: 1, progress: { current: i % 8, target: 8, milestones: [] },
  }));
  const goalTrees = [tasks.slice(0, -1), tasks.slice(-1)].map((items, treeIndex) => ({
    version: 2, id: 'tree-' + treeIndex, title: '路线 ' + treeIndex,
    nodes: items.map(task => ({ id: 'node-' + task.id, kind: 'task', taskId: task.id })),
    links: items.map((task, order) => ({
      id: 'link-' + task.id, type: 'contains', primary: true, from: null,
      to: 'node-' + task.id, order, side: order % 2 ? 'left' : 'right',
    })),
  }));
  return { version, tasks, trash: [], taskPageNotes: {}, temporaryTaskIds: [], goalTrees, activeTreeId: 'tree-0' };
}

async function installProbes(page, { preload = false, mode = 'list' } = {}) {
  await page.addInitScript(({ preload, mode }) => {
    localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
    localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
    localStorage.setItem('study:viewMode:v2', mode);
    localStorage.setItem('canvas:globalSystem:v1', JSON.stringify({ preload, dailyRetention: 'immediate' }));
    const probe = window.__pageRenderProbe = { renders: {}, parsed: {}, failNext: '' };
    const fetchResponse = window.fetch.bind(window);
    window.fetch = async function (input, options) {
      const response = await fetchResponse(input, options);
      const url = new URL(response.url);
      if (url.pathname.startsWith('/api/study') || url.pathname.startsWith('/api/tree-page')) {
        const read = response.json.bind(response);
        response.json = async function () {
          try { return await read(); }
          finally {
            // Run after the consumer's response microtasks, including failures.
            setTimeout(() => { probe.parsed[url.pathname] = (probe.parsed[url.pathname] || 0) + 1; }, 0);
          }
        };
      }
      return response;
    };
  }, { preload, mode });
  for (const file of ['study', 'tree-page', 'study-route']) {
    const source = fs.readFileSync(path.join(root, 'assets', file + '.js'), 'utf8');
    const entry = '  function render(options) {';
    assert(source.includes(entry), 'missing render entry in ' + file);
    const instrumented = source.replace(entry, [
      entry,
      '    const probe = window.__pageRenderProbe;',
      '    const file = ' + JSON.stringify(file) + ';',
      '    const renders = probe.renders[file] ||= [];',
      '    const start = performance.now();',
      '    try {',
      '      if (probe.failNext === file) {',
      "        probe.failNext = '';",
      "        throw new Error('test render failure');",
      '      }',
      '      return renderPage(options);',
      '    } finally {',
      '      renders.push(performance.now() - start);',
      '    }',
      '  }',
      '  function renderPage(options) {',
    ].join('\n'));
    await page.route('**/' + file + '.js', route => route.fulfill({
      contentType: 'text/javascript', body: instrumented,
    }));
  }
}

async function controlGet(page, endpoint, defaultPayload) {
  const apiPath = '/api/' + endpoint;
  const held = [];
  let hold = defaultPayload === undefined;
  await page.route('**' + apiPath, route => {
    if (hold) held.push(route);
    else return route.fulfill({ json: defaultPayload });
  });
  return {
    hold() { hold = true; },
    async take() {
      for (let attempt = 0; !held.length && attempt < 300; attempt++) await delay(20);
      assert(held.length, 'expected GET ' + apiPath);
      return held.shift();
    },
    async respond(route, payload, status = 200) {
      const before = await page.evaluate(key => __pageRenderProbe.parsed[key] || 0, apiPath);
      await route.fulfill({ json: payload, status });
      await page.waitForFunction(({ key, before }) => __pageRenderProbe.parsed[key] > before,
        { key: apiPath, before });
      await settleFrames(page);
    },
  };
}

function settleFrames(page) {
  return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function renderTimes(page, file) {
  return page.evaluate(file => __pageRenderProbe.renders[file] || [], file);
}

function click(page, selector) {
  return page.locator(selector).evaluate(element => element.click());
}

async function checkCameraWhileWaiting(page, scope, task) {
  const viewport = scope.locator('[data-role="study-route-viewport"]');
  const scene = scope.locator('[data-role="study-route-scene"]');
  const transform = () => scene.evaluate(element => element.style.transform);
  const beforePan = await transform();
  const point = await viewport.evaluate(element => {
    const rect = element.getBoundingClientRect();
    for (const fx of [.25, .65, .15, .75, .5]) {
      for (const fy of [.25, .7, .4, .1, .85]) {
        const x = rect.x + rect.width * fx, y = rect.y + rect.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit && element.contains(hit) && !hit.closest('.study-route-node')) return { x, y };
      }
    }
    return null;
  });
  assert(point, 'viewport has room for a pan gesture');
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 22, point.y + 17);
  await page.mouse.up();
  const afterPan = await transform();
  assert.notEqual(afterPan, beforePan, 'pan moves the live scene');
  await viewport.dispatchEvent('wheel', { deltaY: -200, clientX: point.x, clientY: point.y });
  await settleFrames(page);
  const afterZoom = await transform();
  assert.notEqual(afterZoom, afterPan, 'wheel zooms the live scene');
  await task.evaluate(node => node.focus({ preventScroll: true }));
  assert(await task.evaluate(node => node === document.activeElement));
  return async () => {
    assert.equal(await transform(), afterZoom, 'identical response preserves pan and zoom');
    assert(await task.evaluate(node => node === document.activeElement), 'identical response preserves focus');
  };
}

async function checkRoute(browser, url, host) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await installProbes(page);
    const isTreePage = host.endpoint === 'tree-page';
    const original = fixture(80, isTreePage ? 2 : 6);
    if (isTreePage) {
      original.goalTrees[0].nodes.push({ id: 'branch', kind: 'branch', title: '阶段', shape: 'diamond' });
      original.goalTrees[0].links[0].from = 'branch';
      original.goalTrees[0].links.push({ id: 'link-branch', type: 'contains', primary: true,
        from: null, to: 'branch', order: 0, side: 'right' });
    }
    const api = await controlGet(page, host.endpoint, original);
    await page.goto(url + '/index.html');
    const scope = page.locator(host.selector);
    const task = scope.locator('[data-task-id="task-0"]');
    const taskTitle = task.locator('strong').first();
    const open = () => click(page, isTreePage
      ? '.left-spine [data-action="tree-page-view"]'
      : '.study-list [data-action="study-goal-tree-open"]');
    const close = async () => {
      if (isTreePage) await click(page, notesSpine);
      else await page.evaluate(() => StudyRoute.close(false));
      await task.waitFor({ state: 'detached' });
    };
    if (isTreePage) await page.evaluate(() => CanvasTreePage.prefetch());
    else {
      await click(page, studySpine);
      await page.locator('.study-list-row').first().waitFor();
    }
    api.hold();

    // Reopen twice from the same cache. Normalizing the active tree in the first
    // session must not make its unchanged response compare differently next time.
    const unchangedTimes = [];
    for (let i = 0; i < 2; i++) {
      const before = (await renderTimes(page, host.file)).length;
      await open();
      const request = await api.take();
      await task.waitFor();
      if (isTreePage) {
        const branch = scope.locator('[data-node-id="branch"]');
        assert.match(await branch.getAttribute('class'), /\btree-page-shape-diamond\b/);
        assert.equal(await branch.locator('[data-route-action="collapse"]').getAttribute('aria-disabled'), null);
      }
      await settleFrames(page);
      const assertView = await checkCameraWhileWaiting(page, scope, task);
      await api.respond(request, original);
      await assertView();
      const renders = (await renderTimes(page, host.file)).slice(before);
      assert.equal(renders.length, 1, host.file + ' must render an unchanged snapshot once');
      unchangedTimes.push(renders[0]);
      await close();
    }

    const changed = structuredClone(original);
    changed.tasks[0].title = '外部更新';
    if (isTreePage) changed.goalTrees[0].nodes.find(node => node.id === 'branch').shape = 'circle';
    await open();
    let request = await api.take();
    await task.waitFor();
    const beforeChange = (await renderTimes(page, host.file)).length;
    await api.respond(request, changed);
    assert.equal(await taskTitle.textContent(), '外部更新');
    if (isTreePage) assert.match(await scope.locator('[data-node-id="branch"]').getAttribute('class'), /\btree-page-shape-circle\b/);
    assert.equal((await renderTimes(page, host.file)).length, beforeChange + 1);
    await close();

    await open();
    request = await api.take();
    await task.waitFor();
    const beforeFailure = (await renderTimes(page, host.file)).length;
    await api.respond(request, { error: '临时读取失败' }, 500);
    assert.equal(await taskTitle.textContent(), '外部更新');
    assert.equal((await renderTimes(page, host.file)).length, beforeFailure);
    await close();

    await page.evaluate(file => { __pageRenderProbe.failNext = file; }, host.file);
    await open();
    await api.respond(await api.take(), changed);
    await task.waitFor();
    assert.equal(await taskTitle.textContent(), '外部更新', 'authority recovers a failed cache render');
    await close();

    await open();
    const oldRequest = await api.take();
    await task.waitFor();
    await close();
    await open();
    request = await api.take();
    await task.waitFor();
    const latest = structuredClone(changed);
    latest.tasks[0].title = '重开后的更新';
    await api.respond(request, latest);
    const beforeOld = (await renderTimes(page, host.file)).length;
    await api.respond(oldRequest, original);
    assert.equal(await taskTitle.textContent(), '重开后的更新');
    assert.equal((await renderTimes(page, host.file)).length, beforeOld);
    await close();

    const switched = { ...latest, activeTreeId: 'tree-1', treeId: 'tree-1', ok: true };
    await page.route('**/api/' + host.command, route => {
      assert.equal(route.request().postDataJSON().treeId, 'tree-1');
      return route.fulfill({ json: switched });
    });
    await open();
    request = await api.take();
    await task.waitFor();
    await click(page, host.selector + ' [data-route-tree-id="tree-1"]');
    await scope.locator('[data-task-id="task-79"]').waitFor();
    if (!isTreePage) await api.respond(await api.take(), switched); // Refresh the learning list after the command.
    await page.waitForFunction(key => window[key]?.activeTreeId === 'tree-1', host.cacheKey);
    const beforeStale = (await renderTimes(page, host.file)).length;
    await api.respond(request, original);
    assert.equal(await scope.locator('.study-route-rail-item.is-active').getAttribute('data-route-tree-id'), 'tree-1');
    assert.equal((await renderTimes(page, host.file)).length, beforeStale);
    assert.deepEqual(errors, []);
    return { page: host.file, tasks: 80, cachedRenderMs: unchangedTimes };
  } finally {
    await page.close();
  }
}

async function checkStudy(browser, url, { mode, count, preload, failFirst }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await installProbes(page, { preload, mode });
    const api = await controlGet(page, 'study');
    await page.goto(url + '/index.html');
    const payload = fixture(count);
    if (preload) {
      await api.respond(await api.take(), payload);
      assert.deepEqual(await renderTimes(page, 'study'), [], 'preload prepares data without task DOM');
      await click(page, studySpine);
    } else {
      await click(page, studySpine);
      let request = await api.take();
      if (failFirst) {
        await api.respond(request, { error: '测试读取失败' }, 500);
        assert.deepEqual(await renderTimes(page, 'study'), []);
        await click(page, notesSpine);
        await page.waitForFunction(selector => document.querySelector(selector).classList.contains('active'), notesSpine);
        await click(page, studySpine);
        request = await api.take();
      }
      await api.respond(request, payload);
    }
    const items = mode === 'list' ? '.study-list-row' : '.study-progress-card[data-id]';
    await page.waitForFunction(({ items, count }) => document.querySelectorAll(items).length === count,
      { items, count });
    await settleFrames(page);
    const renders = await renderTimes(page, 'study');
    assert.equal(renders.length, 1, 'first data must render once in ' + mode);
    assert.deepEqual(errors, []);
    return { page: 'study', mode, count, preload: !!preload, retried: !!failFirst, renderMs: renders[0] };
  } finally {
    await page.close();
  }
}

async function checkTreeFreeItemComposition(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000);
  const commands = [];
  try {
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
      localStorage.setItem('canvas:globalSystem:v1', JSON.stringify({ preload: false, dailyRetention: 'immediate' }));
    });
    page.on('request', request => {
      if (!request.url().endsWith('/api/tree-page-command') || request.method() !== 'POST') return;
      commands.push(request.postDataJSON());
    });
    await page.goto(url + '/index.html');
    await click(page, '.left-spine [data-action="tree-page-view"]');
    const scope = page.locator('.tree-page-embedded');
    await scope.locator('.study-route-node.is-root').waitFor();
    await scope.locator('[data-role="tree-page-item-dock-collapse"]').click();
    await scope.locator('[data-tree-item-create="note"]').click();
    await scope.locator('[data-role="study-route-viewport"]').click({ position: { x: 210, y: 120 } });
    const editor = scope.locator('.tree-page-free-item .text-box-content');
    await editor.waitFor();
    const cdp = await page.context().newCDPSession(page);
    const preedit = text => cdp.send('Input.imeSetComposition', {
      text, selectionStart: text.length, selectionEnd: text.length,
    });
    const imeKey = (key, isComposing, keyCode) => editor.evaluate((element, init) => {
      return element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    }, { key, isComposing, keyCode });
    const savedTexts = () => commands.filter(command => command.command === 'update-free-item')
      .map(command => command.patch.text);

    await preedit('zhong');
    assert.equal(await editor.innerText(), 'zhong', 'Chromium inserts temporary candidate text');
    await delay(450);
    assert.deepEqual(savedTexts(), [], 'an open candidate must never be autosaved');
    assert.equal(await imeKey('Enter', true, 0), true, 'candidate Enter is left to the IME');
    assert.equal(await imeKey('Escape', false, 229), true, 'candidate Escape is left to the IME');
    assert.equal(await editor.getAttribute('contenteditable'), 'plaintext-only', 'candidate Escape leaves the new note open');
    assert.equal(await editor.innerText(), 'zhong', 'candidate Enter does not add a newline');

    const confirmed = page.waitForRequest(request => request.url().endsWith('/api/tree-page-command')
      && request.method() === 'POST' && request.postDataJSON().patch?.text === '中');
    await cdp.send('Input.insertText', { text: '中' });
    await confirmed;
    await preedit('wen');
    await preedit('');
    await delay(450);
    assert.deepEqual(savedTexts(), ['中'], 'a cancelled candidate never creates a write');

    await page.keyboard.press('Enter');
    await page.keyboard.insertText('文');
    await page.keyboard.press('Control+Enter');
    await page.evaluate(() => window.CanvasTreePage.beforeLeave());
    assert.equal(await editor.getAttribute('contenteditable'), 'false');
    assert.deepEqual(savedTexts(), ['中', '中\n文'], 'ordinary Enter and Ctrl+Enter keep their editing behavior');
    assert.equal(commands.some(command => command.command === 'delete-free-item'), false);

    await editor.dblclick();
    await page.keyboard.insertText('清');
    await editor.evaluate(element => {
      // Model a native composition that has not reported its outcome on blur.
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      element.textContent = 'unfinished';
    });
    await page.evaluate(() => window.CanvasTreePage.beforeLeave());
    assert.equal(await editor.innerText(), '清');
    assert.deepEqual(savedTexts(), ['中', '中\n文', '清'], 'leaving preserves committed text without the unresolved candidate');
  } finally {
    await page.close();
  }
}

function mergeFixture(scenario) {
  const tasks = [], nodes = [], links = [];
  function add(id, title, from, { task = false, requires = false, side = 'right' } = {}) {
    const taskId = 'task-' + id;
    if (task) tasks.push({ id: taskId, title, status: 'active', progress: { current: 0, target: 1 } });
    nodes.push(task ? { id, kind: 'task', taskId } : { id, kind: 'branch', title });
    links.push({ id: 'link-' + id, from, to: id, order: links.length, primary: true,
      type: requires ? 'requires' : 'contains',
      ...(requires ? { trigger: { kind: 'complete' } } : {}),
      ...(!from ? { side } : {}) });
  }
  add('year', '大二', null);
  add('math', '数学', 'year');
  add('electrical', '电气', 'year');
  add('probability', '概率论', 'math', { task: true });
  add('complex', '复变函数', 'math', { task: true });
  add('magnetism', '电磁场', 'electrical', { task: true });
  add('circuits', '电路', 'electrical', { task: true });
  if (scenario === 'blocked' || scenario === 'fallback') {
    add('neighbor', '同列卡片', 'magnetism', { requires: true });
  }
  const sources = ['probability', 'complex', 'circuits'];
  if (scenario === 'visual-only') {
    add('carrier', '父阶段', 'electrical');
    add('target', '大二下学期', 'carrier');
    sources.push('magnetism');
  } else {
    add('target', '大二下学期', 'magnetism', { requires: true });
  }
  if (scenario === 'fallback') sources.push('neighbor');
  if (scenario === 'branch') {
    add('major', '专业课', 'target');
    add('machines', '电机学', 'major', { task: true });
    add('digital', '数字电子技术', 'major', { task: true });
    add('analog', '模拟电子技术', 'major', { task: true });
    add('plants', '发电厂部分', 'major', { task: true });
    add('earlier', '上游任务', null, { task: true, side: 'left' });
    for (const task of tasks) {
      if (['task-magnetism', 'task-machines'].includes(task.id)) task.status = 'done';
    }
  }
  if (scenario === 'split') {
    add('another', '另一条路线', 'year');
    add('mid', '后续阶段', 'another');
    add('far', '后续节点', 'mid');
    add('one', '右侧来源一', 'far', { task: true });
    add('two', '右侧来源二', 'far', { task: true });
    add('prerequisite', '附加条件', 'math', { task: true });
    links.push({ id: 'require-prerequisite', from: 'prerequisite', to: 'target', type: 'requires',
      primary: false, trigger: { kind: 'complete' } });
    sources.push('one', 'two');
  }
  const visualLinks = sources.map(from => ({ from, to: 'target' }));
  const goalTrees = [{ version: 2, id: 'merge-tree', title: '大二', nodes, links, visualLinks },
    { version: 2, id: 'empty-tree', title: '另一棵树', nodes: [], links: [], visualLinks: [] }];
  return { version: 2, tasks, goalTrees, activeTreeId: 'merge-tree' };
}

async function checkBranchCenterAndProgress(page, scope, node, fixture, filename, open) {
  const target = node('target');
  const scopeButton = target.getByRole('button', { name: '独立进度' });
  const subtree = ['target', 'major', 'machines', 'digital', 'analog', 'plants'];
  const coords = (id) => node(id).evaluate(card => ({
    x: card.__layoutX, y: card.__layoutY + card.offsetHeight / 2,
  }));
  const baseline = await scope.evaluate((host, payload) => {
    const sizes = new Map(Array.from(host.querySelectorAll('.study-route-node'), card => [
      card.dataset.nodeId, { width: card.offsetWidth, height: card.offsetHeight },
    ]));
    const tree = window.RelatumStudyGoalTree.layout(payload.goalTrees[0], payload.tasks, { sizes });
    return Object.fromEntries(tree.nodes.map(card => [card.id, { x: card.x, y: card.y }]));
  }, fixture);
  const desired = (baseline.probability.y + baseline.circuits.y) / 2;
  const shift = desired - baseline.target.y;
  assert(Math.abs(shift) > 20);
  for (const id of subtree) {
    assert.deepEqual(await coords(id), { x: baseline[id].x, y: baseline[id].y + shift }, id + ' moves with its branch');
  }
  for (const id of ['probability', 'complex', 'magnetism', 'circuits', 'electrical']) {
    assert.deepEqual(await coords(id), baseline[id], id + ' keeps its original position');
  }
  const trunk = scope.locator('path[data-to="target"][data-merge-part="trunk"]');
  const checkEndpoint = async () => {
    const end = await trunk.evaluate(path => {
      const point = path.getPointAtLength(path.getTotalLength());
      return { x: point.x, y: point.y };
    });
    const position = await coords('target');
    assert(Math.abs(end.x - position.x) < .1 && Math.abs(end.y - position.y) < .1);
  };
  await checkEndpoint();

  const fold = target.locator('[data-route-action="collapse"]');
  await fold.click();
  await node('major').waitFor({ state: 'detached' });
  assert.equal(await trunk.count(), 1);
  await fold.click();
  await node('plants').waitFor();
  await page.waitForFunction(({ y, id }) => {
    const card = document.querySelector('.tree-page-embedded [data-node-id="' + id + '"]');
    return Math.abs(card.__layoutY + card.offsetHeight / 2 - y) < .03;
  }, { id: 'plants', y: baseline.plants.y + shift });
  await checkEndpoint();

  const start = await target.locator('.study-route-branch-main > strong').boundingBox();
  const beforeDrag = await coords('target');
  const childBefore = await node('major').boundingBox();
  await page.mouse.move(start.x + 8, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 23, start.y + start.height / 2 + 28, { steps: 6 });
  await page.waitForFunction(() => document.querySelector('.tree-page-embedded [data-node-id="major"]')
    .classList.contains('is-subtree-dragging'));
  assert.notEqual((await node('major').boundingBox()).y, childBefore.y);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await page.waitForFunction(y => {
    const card = document.querySelector('.tree-page-embedded [data-node-id="target"]');
    return Math.abs(card.__layoutY + card.offsetHeight / 2 - y) < .03;
  }, beforeDrag.y);
  await checkEndpoint();

  const metadata = id => node(id).locator('[data-route-action="progress-breakdown"]');
  const progress = async (root, electrical, completed) => {
    assert.equal(await metadata('root').textContent(), root);
    assert.equal(await metadata('electrical').textContent(), electrical);
    assert.equal(await metadata('target').textContent(), '25% · 4 项任务');
    assert.equal(await scope.locator('[data-role="study-route-summary"] > span').textContent(), completed);
  };
  await progress('22% · 9 项任务', '33% · 6 项任务', '2 / 9 已完成');
  assert.equal(await scopeButton.getAttribute('aria-pressed'), 'false');
  assert(await scopeButton.locator('.tree-page-progress-scope-slash').isVisible());
  const cardSize = await target.evaluate(card => [card.offsetWidth, card.offsetHeight]);

  const changed = page.waitForResponse(response => response.url().endsWith('/api/tree-page-command'));
  await scopeButton.focus();
  await page.keyboard.press('Enter');
  const response = await changed;
  assert(response.ok());
  assert.equal(response.request().postDataJSON().independentProgress, true);
  await page.waitForFunction(() => document.activeElement.matches(
    '[data-route-action="progress-scope"][aria-pressed="true"]:not([aria-busy])'));
  assert.equal(await scopeButton.locator('.tree-page-progress-scope-slash').isVisible(), false);
  assert.deepEqual(await target.evaluate(card => [card.offsetWidth, card.offsetHeight]), cardSize);
  await progress('20% · 5 项任务', '50% · 2 项任务', '1 / 5 已完成');
  for (const [id, titles] of [
    ['root', ['概率论', '复变函数', '电磁场', '电路', '上游任务']],
    ['electrical', ['电磁场', '电路']],
    ['target', ['电机学', '数字电子技术', '模拟电子技术', '发电厂部分']],
  ]) {
    await metadata(id).evaluate(button => button.click());
    const rows = scope.locator('.study-route-progress-detail li [data-user-content]');
    assert.deepEqual(await rows.allTextContents(), titles);
    await page.keyboard.press('Escape');
  }

  await page.route('**/api/tree-page-command', route => route.fulfill({
    status: 500, json: { error: '模拟写入失败' },
  }), { times: 1 });
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/tree-page-command') && response.status() === 500),
    scopeButton.press('Space'),
  ]);
  await page.waitForFunction(() => !document.querySelector(
    '.tree-page-embedded [data-node-id="target"] [data-route-action="progress-scope"]').hasAttribute('aria-busy'));
  assert.equal(await scopeButton.getAttribute('aria-pressed'), 'true');
  await progress('20% · 5 项任务', '50% · 2 项任务', '1 / 5 已完成');
  const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(saved.goalTrees[0].nodes.find(item => item.id === 'target').independentProgress, true);

  const completeSource = node('magnetism').locator('[data-route-action="complete"]');
  const dependent = node('digital').locator('[data-route-action="complete"]');
  async function toggleSource() {
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/tree-page-command')),
      completeSource.press('Enter'),
    ]);
    assert(response.ok());
  }
  await toggleSource();
  await node('digital').and(scope.locator('.is-blocked')).waitFor();
  assert.equal(await dependent.getAttribute('aria-disabled'), 'true', 'independent progress preserves the incoming requirement');
  await toggleSource();
  await page.waitForFunction(() => !document.querySelector('.tree-page-embedded [data-node-id="digital"]').classList.contains('is-blocked'));
  assert.equal(await dependent.getAttribute('aria-disabled'), null);

  await page.reload();
  await open();
  await scopeButton.waitFor();
  assert.equal(await scopeButton.getAttribute('aria-pressed'), 'true');
  await progress('20% · 5 项任务', '50% · 2 项任务', '1 / 5 已完成');
  await page.setViewportSize({ width: 960, height: 680 });
  await page.locator('[data-action="start-theme-toggle"]').first().evaluate(button => button.click());
  assert.equal(await scopeButton.evaluate(button => getComputedStyle(button).color), 'rgb(214, 235, 216)');
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/tree-page-command')),
    scopeButton.press('Space'),
  ]);
  await page.waitForFunction(() => document.activeElement.matches('[data-route-action="progress-scope"][aria-pressed="false"]'));
  await progress('22% · 9 项任务', '33% · 6 项任务', '2 / 9 已完成');
}

async function checkTreeVisualMerges(browser, url, dataRoot, scenario) {
  const filename = path.join(dataRoot, 'data', 'tree-page.json');
  const fixture = mergeFixture(scenario);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(fixture));
  const reducedMotion = scenario === 'blocked' ? 'reduce' : 'no-preference';
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(12000);
  try {
    await page.addInitScript(enforceUnlock => {
      localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
      localStorage.setItem('canvas:startTheme', 'light');
      localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
      localStorage.setItem('canvas:globalSystem:v1', JSON.stringify({ preload: false, dailyRetention: 'immediate' }));
      if (enforceUnlock) localStorage.setItem('canvas:goalTreeEnforceUnlock:v1', '1');
    }, scenario === 'branch');
    await page.goto(url + '/index.html');
    const open = async () => {
      await page.evaluate(() => CanvasTreePage.prefetch());
      await click(page, '.left-spine [data-action="tree-page-view"]');
    };
    await open();
    const scope = page.locator('.tree-page-embedded');
    const node = id => scope.locator('.study-route-node[data-node-id="' + id + '"]');
    await node('target').waitFor();
    const edges = scope.locator('path[data-to="target"]');
    const arrows = edges.locator('xpath=self::*[@marker-end]');
    const trunk = edges.locator('xpath=self::*[@data-merge-part="trunk"]');
    const preview = scope.locator('path.is-link-preview');
    const sharedPreview = scope.locator('path.is-link-preview-shared');
    const mousePoint = async id => {
      const box = await node(id).boundingBox();
      return { x: box.x + box.width * .43, y: box.y + box.height / 2 };
    };
    async function dragLink(fromId) {
      const from = await mousePoint(fromId), to = await mousePoint('target');
      await page.mouse.move(from.x, from.y);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(to.x, to.y, { steps: 10 });
    }
    async function cancelLink() {
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.mouse.up({ button: 'right' });
      assert.equal(await preview.count(), 0);
      assert.equal(await sharedPreview.count(), 0);
    }
    async function checkGroupStyle(stroke) {
      const styles = await edges.locator('xpath=self::*[@data-merge-part]').evaluateAll(paths =>
        paths.map(path => [getComputedStyle(path).stroke, getComputedStyle(path).strokeWidth].join(' ')));
      assert.deepEqual([...new Set(styles)], [stroke + ' 1.7px']);
    }
    async function checkMergedRemoval(fromId, side, red, arrowColor) {
      await sharedPreview.waitFor();
      assert.equal(await preview.getAttribute('marker-end'), null);
      assert.equal(await sharedPreview.getAttribute('marker-end'), null);
      await page.waitForFunction(color => {
        const host = document.querySelector('.tree-page-embedded');
        return ['.is-link-preview.is-removing', '.is-link-preview-shared'].every(selector =>
          getComputedStyle(host.querySelector(selector)).stroke === color);
      }, red);
      assert.equal(await sharedPreview.evaluate(path => getComputedStyle(path).strokeDasharray), '5px, 4px');
      const aligned = await sharedPreview.evaluate((path, { fromId, side, arrowColor }) => {
        const svg = path.ownerSVGElement;
        const branch = svg.querySelector('path[data-from="' + fromId + '"][data-to="target"]');
        const solid = svg.querySelector('.is-link-preview.is-removing');
        const trunk = svg.querySelector('path[data-edge-id="merge|target|' + side + '|trunk"]');
        const join = branch.getPointAtLength(branch.getTotalLength());
        const start = path.getPointAtLength(0), end = path.getPointAtLength(path.getTotalLength());
        const elbow = trunk.getPointAtLength(0), tip = trunk.getPointAtLength(trunk.getTotalLength());
        const corner = path.getPointAtLength(Math.abs(start.y - elbow.y));
        const dir = Math.sign(tip.x - elbow.x), pocket = dir * (tip.x - end.x);
        const arrow = svg.querySelector(trunk.getAttribute('marker-end').slice(4, -1) + ' path');
        return solid.getAttribute('d') === branch.getAttribute('d')
          && Math.hypot(start.x - join.x, start.y - join.y) < .1
          && Math.hypot(corner.x - elbow.x, corner.y - elbow.y) < .1
          && Math.abs(end.y - tip.y) < .1
          && Math.abs(pocket - Math.min(8, Math.abs(tip.x - elbow.x))) < .1
          && getComputedStyle(arrow).fill === arrowColor;
      }, { fromId, side, arrowColor });
      assert(aligned, 'the dashed preview traces the shared route up to the original arrowhead');
    }
    const arrowCount = scenario === 'fallback' ? 5 : scenario === 'split' ? 3 : 1;
    await page.waitForFunction(count => document.querySelectorAll(
      '.tree-page-embedded path[data-to="target"][marker-end]').length === count, arrowCount);
    if (scenario === 'fallback') {
      assert.equal(await trunk.count(), 0, 'overlapping columns preserve individual paths');
      await dragLink('probability');
      await node('target').and(scope.locator('.is-visual-unlink-target')).waitFor();
      assert.equal(await preview.getAttribute('marker-end'), 'url(#tree-page-visual-remove-arrow)');
      assert.equal(await preview.getAttribute('d'), await edges.locator('xpath=self::*[@data-from="probability"]').getAttribute('d'));
      assert.equal(await sharedPreview.count(), 0, 'a single edge retains its red arrow without a dashed overlay');
      await cancelLink();
      assert.deepEqual(errors, []);
      return;
    }
    assert.equal(await trunk.count(), scenario === 'split' ? 2 : 1);
    assert.equal(await edges.locator('xpath=self::*[@data-merge-part="branch"]').count(), scenario === 'split' ? 6 : 4);
    assert.equal(await edges.locator('xpath=self::*[@data-from="magnetism"]').getAttribute('marker-end'), null);
    await checkGroupStyle('rgb(89, 103, 93)');

    const xy = id => node(id).evaluate(card => ({ x: card.__layoutX, y: card.__layoutY + card.offsetHeight / 2 }));
    const centerBetween = async (first, last) => ((await xy(first)).y + (await xy(last)).y) / 2;
    const baselineY = (await xy('magnetism')).y;
    if (scenario === 'visual-only') {
      assert.equal((await xy('target')).y, await centerBetween('probability', 'circuits'));
      assert.equal(await trunk.getAttribute('marker-end'), 'url(#tree-page-visual-arrow)');
      assert.deepEqual(errors, []);
      return;
    }
    if (scenario === 'blocked') {
      const targetY = (await xy('target')).y;
      const candidateY = await centerBetween('probability', 'circuits');
      const gap = await node('neighbor').evaluate(card => {
        const target = document.querySelector('.tree-page-embedded [data-node-id="target"]');
        return target.__layoutY - card.__layoutY - card.offsetHeight;
      });
      assert.equal(gap, 12, 'the target uses the available part of its original slot');
      assert(candidateY < targetY && candidateY < baselineY, 'the proposed move would cross the preceding card');
      assert.deepEqual(errors, []);
      return;
    }
    if (scenario === 'branch') {
      await checkBranchCenterAndProgress(page, scope, node, fixture, filename, open);
      assert.deepEqual(errors, []);
      return;
    }
    if (scenario === 'split') {
      assert.equal((await xy('target')).y, baselineY, 'sources on both sides keep tree placement');
      const directions = await trunk.evaluateAll(paths => paths.map(path => {
        const length = path.getTotalLength();
        return Math.sign(path.getPointAtLength(length).x - path.getPointAtLength(0).x);
      }).sort());
      assert.deepEqual(directions, [-1, 1], 'each side has a single inward arrow');
      const dashed = edges.locator('xpath=self::*[@data-from="prerequisite"]');
      assert.equal(await dashed.getAttribute('data-merge-part'), null);
      assert.equal(await dashed.evaluate(edge => getComputedStyle(edge).strokeDasharray), '5px, 5px');
      await dragLink('one');
      await checkMergedRemoval('one', 'right', 'rgb(227, 93, 82)', 'rgb(89, 103, 93)');
      assert.equal(await arrows.count(), 3);
      await cancelLink();
      assert.deepEqual(errors, []);
      return;
    }

    const target = await xy('target');
    assert.equal(target.y, await centerBetween('probability', 'circuits'));
    assert.notEqual(target.y, baselineY, 'terminal card leaves primary source height when there is room');
    const endpoint = await trunk.evaluate(path => {
      const point = path.getPointAtLength(path.getTotalLength());
      return { x: point.x, y: point.y };
    });
    assert.deepEqual(endpoint, target, 'the shared arrow meets the left center of the moved card');

    const fold = node('math').locator('[data-route-action="collapse"]');
    await fold.click();
    await node('probability').waitFor({ state: 'detached' });
    assert.equal(await arrows.count(), 1, 'remaining sources still share an arrow');
    assert.equal(await edges.locator('xpath=self::*[@data-from="probability"]').count(), 0);
    await fold.click();
    await node('probability').waitFor();
    async function waitForCenteredTarget() {
      const centered = await page.waitForFunction(() => {
        function y(id) {
          const card = document.querySelector('.tree-page-embedded [data-node-id="' + id + '"]');
          return card && card.__layoutY + card.offsetHeight / 2;
        }
        return y('probability') != null && Math.abs(y('target') - (y('probability') + y('circuits')) / 2) < .03;
      }, undefined, { timeout: 2000 }).then(() => true, () => false);
      if (!centered) {
        const points = await Promise.all(['target', 'probability', 'complex', 'magnetism', 'circuits'].map(xy));
        assert.fail('target failed to recenter: ' + JSON.stringify(points));
      }
    }
    await waitForCenteredTarget();

    const sourcePoint = await mousePoint('probability');
    const sourceBranch = edges.locator('xpath=self::*[@data-from="probability"]');
    const branchBefore = await sourceBranch.getAttribute('d');
    await page.mouse.move(sourcePoint.x, sourcePoint.y);
    await page.mouse.down();
    await page.mouse.move(sourcePoint.x + 18, sourcePoint.y + 30, { steps: 5 });
    await settleFrames(page);
    assert.notEqual(await sourceBranch.getAttribute('d'), branchBefore, 'branch follows real structural drag');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await page.waitForFunction(({ d, selector }) => document.querySelector(selector)?.getAttribute('d') === d, {
      d: branchBefore, selector: '.tree-page-embedded path[data-from="probability"][data-to="target"]',
    });

    for (const id of ['complex', 'circuits']) {
      await dragLink(id);
      await checkMergedRemoval(id, 'left', 'rgb(227, 93, 82)', 'rgb(89, 103, 93)');
      await page.mouse.move(100, 75);
      await sharedPreview.waitFor({ state: 'detached' });
      const to = await mousePoint('target');
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await sharedPreview.waitFor();
      await cancelLink();
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).goalTrees[0].visualLinks, fixture.goalTrees[0].visualLinks);

    async function toggleProbability() {
      await dragLink('probability');
      await checkMergedRemoval('probability', 'left', 'rgb(227, 93, 82)', 'rgb(89, 103, 93)');
      await page.mouse.up({ button: 'right' });
      assert.equal(await sharedPreview.count(), 0);
      assert.equal(await preview.count(), 0);
    }
    let rejectSave;
    const pending = new Promise(resolve => { rejectSave = resolve; });
    const rejectCommand = async route => {
      rejectSave(route);
    };
    await page.route('**/api/tree-page-command', rejectCommand, { times: 1 });
    await Promise.all([
      page.waitForRequest(request => request.url().endsWith('/api/tree-page-command')),
      toggleProbability(),
    ]);
    const rejected = await pending;
    assert.equal(rejected.request().postDataJSON().command, 'set-visual-link');
    assert.equal(rejected.request().postDataJSON().active, false);
    assert.equal(await sourceBranch.count(), 0, 'branch is removed before the save response');
    assert.equal(await arrows.count(), 1);
    await rejected.fulfill({ status: 500, json: { error: '模拟写入失败' } });
    await sourceBranch.waitFor();
    await waitForCenteredTarget();
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).goalTrees[0].visualLinks.length, 3);

    const saved = page.waitForResponse(response => response.url().endsWith('/api/tree-page-command'));
    await toggleProbability();
    assert((await saved).ok());
    const persisted = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.deepEqual(persisted.goalTrees[0].visualLinks, fixture.goalTrees[0].visualLinks.slice(1));
    assert.equal(persisted.goalTrees[0].links.find(link => link.to === 'target').from, 'magnetism');
    assert.equal(await arrows.count(), 1);

    const added = page.waitForResponse(response => response.url().endsWith('/api/tree-page-command'));
    await dragLink('probability');
    await node('target').and(scope.locator('.is-visual-link-target')).waitFor();
    assert.equal(await preview.getAttribute('marker-end'), null);
    assert.equal(await sharedPreview.count(), 0);
    await page.mouse.up({ button: 'right' });
    assert((await added).ok());
    await sourceBranch.waitFor();
    await page.locator('[data-action="start-theme-toggle"]').first().evaluate(element => element.click());
    await page.waitForFunction(() => getComputedStyle(document.querySelector(
      '.tree-page-embedded path[data-to="target"][data-merge-part="trunk"]')).stroke === 'rgb(255, 255, 255)');
    await checkGroupStyle('rgb(255, 255, 255)');
    await dragLink('complex');
    await checkMergedRemoval('complex', 'left', 'rgb(255, 117, 105)', 'rgb(255, 255, 255)');
    await cancelLink();
    await page.setViewportSize({ width: 900, height: 650 });
    assert.equal(await arrows.count(), 1);
    await page.reload();
    await open();
    await sourceBranch.waitFor();
    assert.equal(await arrows.count(), 1, 'reload builds the merge from persisted individual links');
    const viewport = scope.locator('[data-role="study-route-viewport"]');
    const scene = scope.locator('[data-role="study-route-scene"]');
    const beforeZoom = await scene.evaluate(element => element.style.transform);
    const beforePath = await trunk.getAttribute('d');
    const viewportBox = await viewport.boundingBox();
    await page.mouse.move(viewportBox.x + viewportBox.width * .62, viewportBox.y + viewportBox.height * .4);
    await page.mouse.wheel(0, -180);
    await page.waitForFunction(transform => document.querySelector(
      '.tree-page-embedded [data-role="study-route-scene"]').style.transform !== transform, beforeZoom);
    assert.equal(await trunk.getAttribute('d'), beforePath, 'zoom moves the scene without recomputing the shared path');

    const switchTo = async id => {
      const [response] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/api/tree-page-command')
          && response.request().postDataJSON().treeId === id),
        scope.locator('[data-route-tree-id="' + id + '"]').evaluate(button => button.click()),
      ]);
      assert(response.ok());
      await settleFrames(page);
    };
    await switchTo('empty-tree');
    await node('target').waitFor({ state: 'detached' });
    assert.equal(await scope.locator('path[data-merge-part]').count(), 0, 'switching trees clears merge paths');
    await switchTo('merge-tree');
    await sourceBranch.waitFor();
    assert.equal(await arrows.count(), 1, 'returning to the first tree rebuilds just one arrow');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

async function checkTreeGestureBudget(browser, url, count, baseline) {
  const tasks = fixture(count).tasks;
  const nodes = [{ id: 'branch', kind: 'branch', title: 'Motion sample' },
    ...tasks.map(task => ({ id: task.id, kind: 'task', taskId: task.id }))];
  const links = nodes.map((node, order) => ({ id: 'link-' + node.id, from: order ? 'branch' : null,
    to: node.id, type: 'contains', primary: true, order, side: 'right' }));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  try {
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
      localStorage.setItem('canvas:globalSystem:v1', JSON.stringify({ preload: false }));
    });
    await page.route('**/api/tree-page', route => route.fulfill({ json: { tasks, activeTreeId: 'motion',
      goalTrees: [{ version: 2, id: 'motion', title: 'Motion', nodes, links }] } }));
    if (baseline) {
      for (const [file, type] of [['tree-page.js', 'text/javascript'], ['styles.css', 'text/css']]) {
        const source = execFileSync('git', ['show', baseline + ':assets/' + file], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
        await page.route('**/' + file, route => route.fulfill({ contentType: type, body: source }));
      }
    }
    await page.goto(url + '/index.html');
    await page.evaluate(() => CanvasTreePage.prefetch());
    await click(page, '.left-spine [data-action="tree-page-view"]');
    const viewport = page.locator('.tree-page-embedded .study-route-viewport');
    const branch = viewport.locator('[data-node-id="branch"]');
    await branch.waitFor();
    await settleFrames(page);
    await viewport.evaluate(element => {
      element.addEventListener('pointerdown', event => { window.treeProbePointer = event.pointerId; }, true);
    });
    const camera = () => viewport.evaluate(element => {
      const matrix = new DOMMatrix(getComputedStyle(element.querySelector('.study-route-scene')).transform);
      return { x: matrix.e, y: matrix.f, zoom: matrix.a };
    });
    const measure = (pan, point) => viewport.evaluate(async (element, options) => {
      const scene = element.querySelector('.study-route-scene');
      const counter = { scene: 0, nodeLayer: 0, card: 0, path: 0, edgeLayer: 0, hit: 0 };
      const raf = window.requestAnimationFrame;
      const hitTest = document.elementsFromPoint;
      let callbackMs = 0;
      window.requestAnimationFrame = callback => raf(time => {
        const start = performance.now();
        callback(time);
        callbackMs += performance.now() - start;
      });
      document.elementsFromPoint = (...args) => { counter.hit++; return hitTest.apply(document, args); };
      const observer = new MutationObserver(records => {
        records.forEach(({ target, attributeName }) => {
          if (target === scene && attributeName === 'style') counter.scene++;
          if (target.matches('.tree-page-drag-layer') && attributeName === 'style') counter.nodeLayer++;
          if (target.matches('.study-route-node') && attributeName === 'style') counter.card++;
          if (target.matches('path[data-edge-id]') && attributeName === 'd') counter.path++;
          if (target.matches('[data-tree-drag-edges]') && attributeName === 'transform') counter.edgeLayer++;
        });
      });
      observer.observe(scene, { subtree: true, attributes: true, attributeFilter: ['style', 'd', 'transform'] });
      const timing = [], frameIntervals = [], frames = 24;
      const frame = () => new Promise(resolve => raf(resolve));
      try {
        let timestamp = await frame();
        for (let batch = 0; batch < frames; batch++) {
          const start = performance.now();
          callbackMs = 0;
          for (let i = 1; i <= 12; i++) {
            const offset = 8 + i + batch % 2;
            (options.pan ? element : window).dispatchEvent(new PointerEvent('pointermove', {
              clientX: options.point.x + offset, clientY: options.point.y + offset / 2,
              buttons: 1, button: -1, pointerId: window.treeProbePointer, bubbles: true,
            }));
          }
          const inputMs = performance.now() - start;
          const nextTimestamp = await frame();
          frameIntervals.push(nextTimestamp - timestamp);
          timestamp = nextTimestamp;
          timing.push(inputMs + callbackMs);
        }
      } finally {
        observer.disconnect();
        window.requestAnimationFrame = raf;
        document.elementsFromPoint = hitTest;
      }
      const p95 = values => +values.sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1].toFixed(2);
      return { ...counter, frames, workP95ms: p95(timing), frameP95ms: p95(frameIntervals) };
    }, { pan, point });
    const rect = await viewport.boundingBox();
    const blank = { x: rect.x + 110, y: rect.y + 100 };
    const originalCamera = await camera();
    await page.mouse.move(blank.x, blank.y);
    await page.mouse.down();
    const pan = await measure(true, blank);
    if (!baseline) {
      assert.equal(pan.scene, pan.frames);
      await viewport.evaluate((element, point) => element.dispatchEvent(new PointerEvent('pointerup', {
        clientX: point.x, clientY: point.y, button: 0, pointerId: window.treeProbePointer, bubbles: true,
      })), { x: blank.x + 36, y: blank.y + 40 });
      const moved = await camera();
      assert(Math.abs(moved.x - originalCamera.x - 36) < .001 && Math.abs(moved.y - originalCamera.y - 40) < .001,
        'pointerup commits its own coordinates before the next frame');
    }
    await page.mouse.up();
    await page.evaluate(() => CanvasTreePage.resetView());
    const cardOrder = () => viewport.locator('.study-route-nodes > .study-route-node')
      .evaluateAll(cards => cards.map(card => card.dataset.nodeId));
    const initialOrder = await cardOrder();
    const box = await branch.boundingBox();
    const start = { x: box.x + box.width * .25, y: box.y + box.height * .35 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    const drag = await measure(false, start);
    if (!baseline) {
      assert.equal(drag.nodeLayer, drag.frames);
      assert.equal(drag.edgeLayer, drag.frames);
      assert.equal(drag.card, drag.frames, 'the pointer-capture owner follows the layer without being moved in the DOM');
      assert.equal(drag.path, drag.frames, 'only the root-to-branch edge changes shape');
      assert.equal(drag.hit, drag.frames);
      assert.equal(await viewport.locator('[data-tree-drag-edges] > path').count(), count);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      assert.equal(await viewport.locator('[data-tree-drag-edges], .tree-page-drag-layer, .is-subtree-dragging').count(), 0);
      assert.deepEqual(await cardOrder(), initialOrder, 'cancelling restores card and keyboard traversal order');
    }
    console.log(JSON.stringify({ revision: baseline || 'working tree', tasks: count, pan, drag }));
  } finally {
    await page.close();
  }
}

async function checkTreeGestureHandoffs(browser, url) {
  const data = mergeFixture('branch');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
      localStorage.setItem('canvas:globalSystem:v1', JSON.stringify({ preload: false }));
    });
    await page.route('**/api/tree-page', route => route.fulfill({ json: data }));
    await page.goto(url + '/index.html');
    await page.evaluate(() => CanvasTreePage.prefetch());
    await click(page, '.left-spine [data-action="tree-page-view"]');
    const viewport = page.locator('.tree-page-embedded .study-route-viewport');
    const scene = viewport.locator('.study-route-scene');
    const card = id => viewport.locator('.study-route-node[data-node-id="' + id + '"]');
    await card('math').waitFor();
    const scope = await viewport.boundingBox();
    const anchor = { x: Math.round(scope.x + scope.width * .62), y: Math.round(scope.y + scope.height * .44) };
    const transform = () => scene.evaluate((element, point) => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      const rect = element.parentElement.getBoundingClientRect();
      return { zoom: matrix.a, worldX: (point.x - rect.left - matrix.e) / matrix.a,
        worldY: (point.y - rect.top - matrix.f) / matrix.a };
    }, anchor);
    const initial = await transform();
    await page.mouse.move(anchor.x, anchor.y);
    await page.mouse.wheel(0, -100);
    await settleFrames(page);
    const zoomed = await transform();
    assert(Math.abs(zoomed.zoom / initial.zoom - Math.sqrt(1.1)) < .00001);
    assert(Math.abs(zoomed.worldX - initial.worldX) < .02 && Math.abs(zoomed.worldY - initial.worldY) < .02,
      JSON.stringify({ initial, zoomed }));
    const smallReverse = [{ deltaY: 1, deltaMode: 1 }, ...Array.from({ length: 10 }, () => ({ deltaY: 8.2, deltaMode: 0 }))];
    await viewport.evaluate(async (element, { anchor, inputs }) => {
      inputs.forEach(input => element.dispatchEvent(new WheelEvent('wheel', {
        ...input, clientX: anchor.x, clientY: anchor.y, ctrlKey: true, bubbles: true, cancelable: true,
      })));
    }, { anchor, inputs: smallReverse });
    await settleFrames(page);
    assert(Math.abs((await transform()).zoom - initial.zoom) < .00001, 'line and small pixel deltas accumulate in order');

    const trunk = viewport.locator('path[data-to="target"][data-merge-part="trunk"]');
    const sourceEdge = viewport.locator('path[data-from="probability"][data-merge-part="branch"]');
    const dragCard = async id => {
      const box = await card(id).boundingBox();
      const point = { x: box.x + box.width * .25, y: box.y + box.height * .35 };
      await page.mouse.move(point.x, point.y); await page.mouse.down();
      await page.mouse.move(point.x + 40, point.y + 16);
      await settleFrames(page);
    };
    const original = await sourceEdge.getAttribute('d');
    const originalBounds = await sourceEdge.boundingBox();
    await dragCard('year');
    assert(await trunk.evaluate(path => !!path.closest('[data-tree-drag-edges]')), 'a merge wholly inside the branch translates intact');
    assert.equal(await sourceEdge.getAttribute('d'), original);
    const movedX = await sourceEdge.evaluate(path => path.parentElement.transform.baseVal.getItem(0).matrix.e);
    assert(Math.abs(movedX * initial.zoom - 40) < .01, 'the SVG offset matches the card offset at the current zoom');
    const movedBounds = await sourceEdge.boundingBox();
    assert(Math.abs(movedBounds.x - originalBounds.x - 40) < .02 && Math.abs(movedBounds.y - originalBounds.y - 16) < .02);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    assert.equal(await trunk.evaluate(path => !!path.closest('[data-tree-drag-edges]')), false);
    assert.equal(await sourceEdge.getAttribute('d'), original);
    await dragCard('math');
    assert.equal(await trunk.evaluate(path => !!path.closest('[data-tree-drag-edges]')), false);
    assert.notEqual(await sourceEdge.getAttribute('d'), original, 'mixed merge recomputes its shape');

    await page.route('**/api/tree-page-command', route => route.fulfill({ status: 500, json: { error: 'test rollback' } }));
    const target = await card('electrical').boundingBox();
    const matched = page.waitForRequest(request => request.url().endsWith('/api/tree-page-command'));
    await viewport.evaluate((element, position) => {
      const anchor = element.querySelector('[data-node-id="math"]');
      for (let id = 1; id < 8; id++) {
        if (anchor.hasPointerCapture(id)) {
          anchor.dispatchEvent(new PointerEvent('pointerup', { ...position, pointerId: id, button: 0, bubbles: true, cancelable: true }));
          return;
        }
      }
      throw new Error('expected the dragged node to own pointer capture');
    }, { clientX: target.x + target.width / 2, clientY: target.y + target.height / 2 });
    const request = await matched;
    assert.equal(request.postDataJSON().primaryLink.from, 'electrical', 'release hit uses final pointer position');
    await request.response();
    await page.waitForFunction(d => document.querySelector('.tree-page-embedded path[data-from="probability"][data-merge-part="branch"]')?.getAttribute('d') === d, original);
    await page.mouse.up();
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

async function checkTreeStageDimming(browser, url, dataRoot) {
  const fixture = mergeFixture('branch');
  const tree = fixture.goalTrees[0];
  const digital = fixture.tasks.find(task => task.id === 'task-digital');
  digital.progress = { current: 0, target: 3, milestones: [{ id: 'checkpoint', at: 2, name: '节点检查' }] };
  tree.nodes.find(node => node.id === 'target').title = '大二下学期课程安排和需要完成的全部学习任务';
  tree.visualLinks.push({ from: 'major', to: 'earlier' });
  const filename = path.join(dataRoot, 'data', 'tree-page.json');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(fixture));

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(12000);
  try {
    await installProbes(page);
    await page.goto(url + '/index.html?view=tree');
    const scope = page.locator('.tree-page-embedded');
    const card = id => scope.locator('.study-route-node[data-node-id="' + id + '"]');
    const dimButton = id => card(id).locator('[data-route-action="dim-stage"]');
    const checkpoint = scope.locator('[data-milestone-id="checkpoint"]');
    const checkOpacity = (locator, value) => locator.evaluate(async (element, expected) => {
      await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
      return Number(getComputedStyle(element).opacity) === expected;
    }, value);
    const clickInScene = locator => locator.evaluate(element => element.click());
    const paths = () => scope.locator('path[data-edge-id]').evaluateAll(nodes => nodes.map(node => [node.getAttribute('d'), getComputedStyle(node).stroke, getComputedStyle(node).opacity]));
    const rootMeta = () => card('root').locator('[data-route-action="progress-breakdown"]').textContent();
    const switchTo = async id => {
      const [response] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/api/tree-page-command')
          && response.request().postDataJSON().treeId === id),
        clickInScene(scope.locator('[data-route-tree-id="' + id + '"]')),
      ]);
      assert(response.ok());
    };

    const outer = dimButton('target');
    const inner = dimButton('major');
    await outer.waitFor();
    await checkpoint.waitFor();
    assert.equal(await outer.getAttribute('aria-pressed'), 'false');
    assert.equal(await outer.locator('svg').evaluate(icon => getComputedStyle(icon).opacity), '0.12');
    assert(await outer.locator('.tree-page-stage-toggle-slash').isVisible());
    assert(await card('target').evaluate(element => {
      const title = element.querySelector('.study-route-branch-main > strong');
      return title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === 'ellipsis';
    }));
    const edgesBefore = await paths();
    const statsBefore = await rootMeta();
    const renderCount = (await renderTimes(page, 'tree-page')).length;
    await outer.press('Enter');
    assert.equal(await outer.getAttribute('aria-pressed'), 'true');
    assert.equal(await outer.locator('.tree-page-stage-toggle-slash').isVisible(), false);
    for (const node of [card('major'), card('digital'), card('machines'), checkpoint]) assert(await checkOpacity(node, .2));
    for (const id of ['root', 'target', 'earlier', 'probability']) assert(await checkOpacity(card(id), 1));
    assert.deepEqual(await paths(), edgesBefore);
    assert.equal(await rootMeta(), statsBefore);
    assert.equal((await renderTimes(page, 'tree-page')).length, renderCount);

    await clickInScene(inner);
    await clickInScene(outer);
    assert(await checkOpacity(card('major'), 1));
    assert(await checkOpacity(card('digital'), .2));
    const collapse = card('major').locator('[data-route-action="collapse"]');
    await clickInScene(collapse);
    await card('digital').waitFor({ state: 'detached' });
    await clickInScene(collapse);
    assert(await checkOpacity(card('digital'), .2));

    const rendersBeforeSlider = (await renderTimes(page, 'tree-page')).length;
    await page.evaluate(() => RelatumGlobalSettings.open());
    await page.locator('button[data-settings-category="learning"]').click();
    const slider = page.locator('[data-role="tree-page-descendant-opacity-range"]');
    await slider.press('End');
    assert(await checkOpacity(card('machines'), 1));
    await slider.press('Home');
    assert(await checkOpacity(card('digital'), 0));
    assert.equal((await renderTimes(page, 'tree-page')).length, rendersBeforeSlider);
    await page.locator('[data-settings-action="close"]').click();
    const plus = card('digital').locator('[data-delta="1"]');
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/tree-page-command') && response.ok()),
      plus.click(),
    ]);
    assert.equal(await card('digital').locator('.study-route-task-value').textContent(), '1 / 3');
    assert(await checkOpacity(card('digital'), 0));

    const moved = await fetch(url + '/api/tree-page-command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'move-node', treeId: tree.id, nodeId: 'analog',
        primaryLink: { from: 'math', type: 'contains' } }),
    });
    assert(moved.ok, await moved.text());
    assert(await page.evaluate(() => CanvasTreePage.refresh()));
    assert(await checkOpacity(card('analog'), 1));
    assert(await checkOpacity(card('digital'), 0));

    await switchTo('empty-tree');
    await card('major').waitFor({ state: 'detached' });
    await switchTo(tree.id);
    assert.equal(await inner.getAttribute('aria-pressed'), 'true');
    await page.reload();
    await click(page, '.left-spine [data-action="tree-page-view"]');
    await inner.waitFor();
    assert.equal(await inner.getAttribute('aria-pressed'), 'true');
    assert(await checkOpacity(card('digital'), 0));
    await page.evaluate(() => RelatumGlobalSettings.open());
    await page.locator('button[data-settings-category="appearance"]').click();
    await page.locator('#global-settings-dialog .start-theme-toggle').first().click();
    assert.equal(await page.evaluate(() => document.body.dataset.startTheme), 'dark');
    await page.locator('button[data-settings-category="learning"]').click();
    await page.locator('[data-settings-action="reset-category"]').click();
    await page.locator('[data-settings-action="accept-reset"]').click();
    assert(await checkOpacity(card('digital'), .2));
    assert.equal(await inner.getAttribute('aria-pressed'), 'true');
    assert.equal(await outer.locator('svg').evaluate(icon => getComputedStyle(icon).opacity), '0.12');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

async function checkTreeProgressUpdates(browser, url, dataRoot) {
  const fixture = mergeFixture('branch');
  const tree = fixture.goalTrees[0];
  tree.nodes.find(node => node.id === 'target').independentProgress = true;
  const first = fixture.tasks.find(task => task.id === 'task-probability');
  first.progress.target = 3;
  first.progress.milestones = [{ id: 'checkpoint', at: 1, name: '阶段题' }];
  tree.links.push({ id: 'unlock-digital', from: 'probability', to: 'digital',
    type: 'requires', primary: false, trigger: { kind: 'milestone', milestoneId: 'checkpoint' } });
  const filename = path.join(dataRoot, 'data', 'tree-page.json');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(fixture));

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(12000);
  try {
    await installProbes(page);
    await page.addInitScript(() => localStorage.setItem('canvas:goalTreeEnforceUnlock:v1', '1'));
    await page.goto(url + '/index.html');
    await page.evaluate(() => CanvasTreePage.prefetch());
    await click(page, '.left-spine [data-action="tree-page-view"]');
    const scope = page.locator('.tree-page-embedded');
    const card = id => scope.locator('[data-node-id="' + id + '"]');
    const task = card('probability');
    const plus = task.locator('[data-delta="1"]');
    const current = () => task.locator('.study-route-task-value').textContent();
    const root = scope.locator('.tree-page-root-progress-value');
    const trunk = scope.locator('path[data-to="target"][data-merge-part="trunk"]');
    const digitalCheck = card('digital').locator('[data-route-action="complete"]');
    await plus.waitFor();
    await trunk.waitFor({ state: 'attached' });
    assert.equal(await current(), '0 / 3');
    assert.equal(await digitalCheck.getAttribute('aria-disabled'), 'true');
    assert.equal(await root.textContent(), '20%');

    const untouched = card('circuits').locator('.study-route-task-value');
    await untouched.focus();
    await untouched.evaluate(element => { window.__treeUntouchedButton = element; });
    await trunk.evaluate(element => { window.__treeUntouchedTrunk = element; });
    const originalPath = await trunk.getAttribute('d');
    const commandPath = '/api/tree-page-command';
    async function takeProgressWrite() {
      let capture;
      const held = new Promise(resolve => { capture = resolve; });
      await page.route('**' + commandPath, route => { capture(route); }, { times: 1 });
      await Promise.all([
        page.waitForRequest(request => request.url().endsWith(commandPath)),
        plus.evaluate(button => button.click()),
      ]);
      return held;
    }
    async function reply(route, options) {
      const seen = await page.evaluate(key => __pageRenderProbe.parsed[key] || 0, commandPath);
      await route.fulfill(options);
      await page.waitForFunction(({ key, seen }) => __pageRenderProbe.parsed[key] > seen, { key: commandPath, seen });
    }
    const rendersBefore = (await renderTimes(page, 'tree-page')).length;
    const firstWrite = await takeProgressWrite();
    assert.equal(await current(), '1 / 3', 'quantity is updated before the save');
    assert.equal(await root.textContent(), '27%');
    assert.equal(await card('math').locator('[data-route-action="progress-breakdown"]').textContent(), '17% · 2 项任务');
    assert.equal(await digitalCheck.getAttribute('aria-disabled'), null, 'an affected dependency is refreshed');
    assert(await scope.locator('[data-milestone-id="checkpoint"]').evaluate(element => element.classList.contains('is-complete')));
    assert(await untouched.evaluate(element => element === window.__treeUntouchedButton && element === document.activeElement));
    assert(await trunk.evaluate(element => element === window.__treeUntouchedTrunk));
    assert.equal(await trunk.getAttribute('d'), originalPath);
    const firstResponse = await firstWrite.fetch();
    assert(firstResponse.ok());
    await reply(firstWrite, { response: firstResponse });
    assert.equal((await renderTimes(page, 'tree-page')).length, rendersBefore + 1, 'matching authority needs no second render');
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).tasks.find(task => task.id === first.id).progress.current, 1);

    await page.addStyleTag({ content: '.tree-page-embedded [data-node-id="probability"][data-progress="67"] { width: 520px !important; }' });
    const secondWrite = await takeProgressWrite();
    assert.equal(await current(), '2 / 3');
    assert.equal(await task.evaluate(element => element.offsetWidth), 520);
    assert.notEqual(await trunk.getAttribute('d'), originalPath, 'a measured width change recomputes the merged route');
    const secondResponse = await secondWrite.fetch();
    assert(secondResponse.ok());
    const authority = await secondResponse.json();
    authority.tasks.find(task => task.id === 'task-circuits').title = '外部更新';
    await reply(secondWrite, { json: authority });
    assert.equal(await card('circuits').locator('strong').textContent(), '外部更新', 'different authority still refreshes other cards');

    const rejected = await takeProgressWrite();
    assert.equal(await current(), '3 / 3');
    await reply(rejected, { status: 500, json: { error: '模拟写入失败' } });
    assert.equal(await current(), '2 / 3');
    assert.equal(await root.textContent(), '33%');
    assert.equal(await task.evaluate(element => element.offsetWidth), 520);
    assert.equal(await card('circuits').locator('strong').textContent(), '外部更新');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

async function main() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-canvas-page-render-'));
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)], {
    cwd: root, env: { ...process.env, RELATUM_DATA_ROOT: dataRoot }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    let ready = false;
    for (let attempt = 0; !ready && attempt < 100; attempt++) {
      ready = await fetch(url + '/index.html').then(response => response.ok, () => false);
      if (!ready) await delay(50);
    }
    assert(ready, 'disposable server starts');
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.RELATUM_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    });
    if (process.argv.includes('--tree-visual-merges')) {
      for (const scenario of ['basic', 'visual-only', 'blocked', 'split', 'fallback', 'branch']) {
        await checkTreeVisualMerges(browser, url, dataRoot, scenario);
        console.log('tree-page visual merge passed: ' + scenario);
      }
      return;
    }
    if (process.argv.includes('--tree-progress-updates')) {
      await checkTreeProgressUpdates(browser, url, dataRoot);
      console.log('tree-page progress updates passed');
      return;
    }
    if (process.argv.includes('--tree-stage-dimming')) {
      await checkTreeStageDimming(browser, url, dataRoot);
      console.log('tree-page stage dimming passed');
      return;
    }
    if (process.argv.includes('--tree-gestures')) {
      const baseline = process.argv.find(arg => arg.startsWith('--baseline='))?.slice('--baseline='.length);
      for (const count of [24, 240]) {
        if (baseline) await checkTreeGestureBudget(browser, url, count, baseline);
        await checkTreeGestureBudget(browser, url, count);
      }
      await checkTreeGestureHandoffs(browser, url);
      console.log('tree-page gesture handoffs passed');
      return;
    }
    await checkTreeFreeItemComposition(browser, url);
    console.log('tree-page free item composition passed');
    for (const host of routeHosts) console.log(JSON.stringify(await checkRoute(browser, url, host)));
    for (const mode of ['list', 'progress']) {
      for (const count of [80, 400]) console.log(JSON.stringify(await checkStudy(browser, url, { mode, count })));
      console.log(JSON.stringify(await checkStudy(browser, url, { mode, count: 80, preload: true })));
      console.log(JSON.stringify(await checkStudy(browser, url, { mode, count: 80, failFirst: true })));
    }
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      server.kill();
      await new Promise(resolve => server.once('exit', resolve));
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
