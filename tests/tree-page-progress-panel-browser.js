'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');

const repo = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-tree-progress-panel-'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser, logs = '';
  server.stdout.on('data', chunk => { logs += chunk; });
  server.stderr.on('data', chunk => { logs += chunk; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {}
      if (ready || server.exitCode != null) break;
      await pause(100);
    }
    assert(ready, 'isolated service starts: ' + logs);
    const seedResponse = await fetch(url + '/api/tree-page-command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'create-task', treeId: 'goal_default', title: '虚拟列表测试', target: 9999,
        primaryLink: { type: 'contains', from: null, side: 'right' },
      }),
    });
    const seed = await seedResponse.json();
    assert(seedResponse.ok, JSON.stringify(seed));
    browser = await chromium.launch({ headless: true,
      ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(taskId => {
      localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
      localStorage.setItem('tree-page:progressPanelOpen:v1', '1');
      localStorage.setItem('tree-page:progressPanelSelections:v1', JSON.stringify({ goal_default: taskId }));
    }, seed.tasks[0].id);
    await page.goto(url + '/index.html?view=tree');
    const list = page.locator('[data-role="tree-page-progress-list"]');
    const card = list.locator('[data-progress-at="5"] [data-progress-point-card]');
    await card.dblclick();
    const input = card.locator('input');
    await input.fill('进度点草稿');
    await input.evaluate(element => element.setSelectionRange(1, 3));

    const scroll = top => list.evaluate(async (element, nextTop) => {
      const spacer = element.querySelector('.tree-page-progress-virtual-spacer');
      const input = element.querySelector('input');
      let added = 0, removed = 0;
      const observer = new MutationObserver(records => records.forEach(record => {
        added += record.addedNodes.length;
        removed += record.removedNodes.length;
      }));
      observer.observe(spacer, { childList: true });
      element.scrollTop = nextTop;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      observer.disconnect();
      return {
        scrollTop: element.scrollTop, added, removed,
        focus: !!input && document.activeElement === input,
        selection: input && [input.selectionStart, input.selectionEnd],
        indices: Array.from(spacer.children, row => Number(row.dataset.progressAt)),
      };
    }, top);
    const firstScroll = await scroll(1);
    assert.equal(firstScroll.scrollTop, 1);
    assert(firstScroll.focus, 'scrolling one pixel preserves the still-visible editor: ' + JSON.stringify(firstScroll));
    assert.deepEqual(firstScroll.selection, [1, 3]);
    assert(firstScroll.added <= 1 && firstScroll.removed === 0, 'scrolling one pixel does not move the existing window');
    const crossedRow = await scroll(59);
    assert(crossedRow.focus, 'crossing a row boundary preserves an editor still in range');
    assert(crossedRow.added <= 2 && crossedRow.removed === 0);
    assert(crossedRow.indices.length < 40, '9,999 progress points stay virtualized');
    assert.deepEqual(crossedRow.indices, crossedRow.indices.slice().sort((a, b) => a - b));
    assert(await page.evaluate(() => CanvasTreePage.refresh()));
    assert.deepEqual(await input.evaluate(element => [document.activeElement === element,
      element.selectionStart, element.selectionEnd]), [true, 1, 3], 'refresh also preserves the active editor');
    assert.equal(await input.inputValue(), '进度点草稿');
    await input.press('Enter');
    await page.waitForFunction(async taskId => {
      const data = await (await fetch('/api/tree-page')).json();
      const task = data.tasks.find(item => item.id === taskId);
      return task?.progress?.milestones?.some(point => point.at === 5 && point.name === '进度点草稿');
    }, seed.tasks[0].id, { polling: 100 });
    assert.equal(await card.textContent(), '进度点草稿');
    const far = await scroll(900 * 58);
    const back = await scroll(890 * 58);
    assert.equal(far.added, far.indices.length);
    assert.equal(far.removed, crossedRow.indices.length);
    assert.equal(back.added, 10);
    assert.equal(back.removed, 10);
    assert.deepEqual(back.indices, back.indices.slice().sort((a, b) => a - b));
    assert.deepEqual(errors, []);
    console.log('tree progress panel: scroll retains editor focus and selection, changes only boundary rows, and saves the name');
    console.log(`1px: ${firstScroll.added} rows added, ${firstScroll.removed} removed; 59px: ${crossedRow.added} added, ${crossedRow.removed} removed`);
  } catch (error) {
    console.error(logs);
    throw error;
  } finally {
    if (browser) await browser.close();
    server.kill();
    console.log('Isolated fixtures: ' + root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
