'use strict';

// Production homepage and scripts, with disposable server data and controlled API timing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
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
    await open();
    let request = await api.take();
    await task.waitFor();
    const beforeChange = (await renderTimes(page, host.file)).length;
    await api.respond(request, changed);
    assert.equal(await taskTitle.textContent(), '外部更新');
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
