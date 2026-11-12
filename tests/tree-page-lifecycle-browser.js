'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');

const repo = path.resolve(__dirname, '..');
const tree = '.tree-page-embedded';
const freeItems = tree + ' .tree-page-free-item';
const percent = tree + ' .tree-page-root-progress-value';
const task = tree + ' [data-task-id="task-main"]';
const progressList = tree + ' [data-role="tree-page-progress-list"]';
const canvas = '[data-start-workspace-panel="canvas"]';

function fixture(current, title = '测试任务') {
  return {
    version: 2, activeTreeId: 'tree-main',
    tasks: [{ id: 'task-main', title, status: 'active', progress: { current, target: 500, milestones: [] } }],
    goalTrees: [{ version: 2, id: 'tree-main', title: '测试树',
      nodes: [{ id: 'node-main', kind: 'task', taskId: 'task-main' }],
      links: [{ id: 'link-main', type: 'contains', primary: true, from: null, to: 'node-main', order: 0, side: 'right' }],
      freeItems: Array.from({ length: 40 }, (_, i) => ({ id: `free-${i}`, kind: 'textBox', boxStyle: 'emphasis-card',
        x: i * 30, y: i * 40, width: 200, height: 120, fontSize: 34, text: `便签 ${i}` })),
    }],
  };
}

async function desktopVisibility(page, minimized) {
  return page.evaluate(value => {
    document.documentElement.dataset.desktopMinimized = value ? '1' : '0';
    window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: value } }));
    return document.querySelector('.tree-page-embedded [data-role="study-route-scene"]').style.transform;
  }, minimized);
}

async function assertQuiet(page) {
  const wakes = await page.evaluate(() => window.__treeGoalWakes);
  await delay(320);
  assert.equal(await page.evaluate(() => window.__treeGoalWakes), wakes, 'background tree does not wake for goal breathing');
}

async function checkTree(page, url) {
  let payload = fixture(500);
  await page.route('**/api/tree-page', route => route.fulfill({ json: payload }));
  await page.addInitScript(() => {
    localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
    localStorage.setItem('canvas:globalSystem:v1', JSON.stringify({ preload: false }));
    localStorage.setItem('tree-page:progressPanelOpen:v1', '1');
    localStorage.setItem('tree-page:progressPanelSelections:v1', JSON.stringify({ 'tree-main': 'task-main' }));
    window.__treeGoalWakes = 0;
    const set = window.setTimeout;
    window.setTimeout = function (callback, ms, ...args) {
      if (typeof callback === 'function' && String(callback).includes('visibleTreeGoalNodes().forEach')) {
        const original = callback;
        callback = () => { window.__treeGoalWakes++; original(); };
        ms = 120;
      }
      return set.call(window, callback, ms, ...args);
    };
  });
  await page.goto(url + '/index.html');
  await page.waitForFunction(() => !!window.CanvasTreePage && !!window.RelatumStartWorkspace);
  // Warm only the destination so workspace loading latency cannot consume the reversal window.
  await page.evaluate(async () => {
    await RelatumStartWorkspace.set('notes', { animate: false });
    await RelatumStartWorkspace.set('canvas', { animate: false });
  });
  await page.locator('.left-spine [data-action="tree-page-view"]').evaluate(button => button.click());
  await page.locator(task).waitFor();
  assert.equal(await page.locator(freeItems).count(), 40);
  await page.waitForFunction(() => document.querySelector('.tree-page-embedded .is-goal-breathing'));

  await desktopVisibility(page, true);
  assert.equal(await page.locator(tree + ' .is-goal-breathing').count(), 0);
  await assertQuiet(page);
  assert.equal(await page.locator(freeItems).count(), 40, 'native minimize keeps the active scene mounted');
  await desktopVisibility(page, false);
  await page.waitForFunction(() => document.querySelector('.tree-page-embedded .is-goal-breathing'));

  const scroll = await page.locator(progressList).evaluate(list => { list.scrollTop = 8230; return list.scrollTop; });
  assert.equal(scroll, 8230);
  await page.locator(task).evaluate(element => { window.__treeTask = element; });
  payload = fixture(25);
  await page.evaluate(() => { window.__treeExit = CanvasTreePage.refresh().then(() => RelatumStartWorkspace.set('notes')); });
  await page.locator(canvas + '.workspace-leaving').waitFor();
  assert.equal(await page.locator(freeItems).count(), 40, 'outer exit retains its rendered scene');
  const frozenPercent = await page.locator(percent).textContent();
  assert.notEqual(frozenPercent, '5%', 'summary tween was in flight at workspace departure');
  payload = fixture(75, '迟到的新标题');
  await page.evaluate(() => CanvasTreePage.refresh());
  await delay(100);
  assert.equal(await page.locator(percent).textContent(), frozenPercent, 'root progress stops updating during the outer exit');
  assert(!(await page.locator(task).textContent()).includes('迟到的新标题'), 'late reads do not rebuild the outgoing scene');
  await page.evaluate(async () => { await window.__treeExit; await RelatumStartWorkspace.set('canvas'); });
  assert(await page.locator(task).evaluate(element => element === window.__treeTask), 'rapid workspace reversal keeps the original task DOM');
  assert((await page.locator(task).textContent()).includes('迟到的新标题'), 'quick return presents the deferred authoritative title');
  assert.equal(await page.locator(progressList).evaluate(list => list.scrollTop), scroll);
  await assertQuiet(page);

  await page.evaluate(() => RelatumStartWorkspace.set('notes'));
  await page.locator(canvas + '[hidden]').waitFor({ state: 'attached' });
  assert.equal(await page.locator(freeItems).count(), 0, 'completed workspace exit releases every free object');
  assert.equal(await page.locator(tree + ' .study-route-node,' + tree + ' .study-route-edge,' + tree + ' .study-route-rail-item').count(), 0);
  assert.equal(await page.locator(progressList).evaluate(list => list.childElementCount), 0);
  await assertQuiet(page);

  await page.evaluate(() => RelatumStartWorkspace.set('canvas'));
  await page.locator(task).waitFor();
  assert.equal(await page.locator(freeItems).count(), 40);
  assert.equal(await page.locator(progressList).evaluate(list => list.scrollTop), scroll);
  const camera = await desktopVisibility(page, false);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  assert.equal(await page.locator(freeItems).count(), 0, 'pagehide releases synchronously even if an exit could animate');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.locator(task).waitFor();
  assert.equal(await desktopVisibility(page, false), camera);
  assert.equal(await page.locator(progressList).evaluate(list => list.scrollTop), scroll);

  await page.locator('.left-spine [data-action="study-view"]').evaluate(button => button.click());
  await page.locator(tree + '[hidden]').waitFor({ state: 'attached' });
  assert.equal(await page.locator(freeItems).count(), 0, 'leaving within Canvas also releases free objects');
}

async function main() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-tree-lifecycle-'));
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: dataRoot }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      ready = await fetch(url).then(response => response.ok, () => false);
      if (!ready) await delay(50);
    }
    assert(ready, 'disposable server starts');
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.RELATUM_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await checkTree(page, url);
    assert.deepEqual(errors, []);
    console.log('Tree lifecycle passed: native visibility, frozen exit, deferred data, rapid return, DOM release and pagehide/pageshow.');
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
