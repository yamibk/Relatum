'use strict';

// Regression for Notes -> canvas Tree page -> Notes, with disposable user data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-workspace-tab-'));
  fs.mkdirSync(path.join(root, 'notes'));
  const note = path.join(root, 'notes', 'A.md'), original = '用于工作区切换的正文\n';
  fs.writeFileSync(note, original);
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
    browser = await chromium.launch({ headless: true,
      ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      window.workspaceChanges = 0;
      document.addEventListener('relatum:start-workspacechange', () => { window.workspaceChanges++; });
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:hideSpecialPages', '0');
      localStorage.setItem('canvas:noteOpenTabs:v1', '["A.md"]');
      localStorage.setItem('canvas:noteActiveTab:v1', 'A.md');
      localStorage.setItem('canvas:noteActivePath:v1', 'A.md');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url + '/index.html?view=tree');
    await page.waitForFunction(() => window.CanvasNoteWorkspace?.currentPath === 'A.md');
    const notes = page.locator('.note-workspace');
    const fileTree = page.locator('[data-role="note-tree"]');
    const tree = page.locator('[data-role="tree-page-view"]');
    const notesOpen = () => notes.evaluate(el => el.classList.contains('links-overlay-open'));
    const treeOpen = () => tree.getAttribute('data-progress-panel-open');
    async function switchWorkspace(name) {
      const changes = await page.evaluate(() => window.workspaceChanges);
      await page.locator(`button[data-start-workspace="${name}"]`).click();
      await page.waitForFunction(({ name, changes }) => window.workspaceChanges > changes
        && document.body.dataset.startWorkspace === name
        && !document.body.classList.contains('start-workspace-turning'), { name, changes });
      if (name === 'notes') {
        await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'A.md' && !CanvasNoteWorkspace.backgroundBusy);
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    async function checkNotesTab(label) {
      // Explicit non-input focus preserves the editor's own Tab indentation.
      await fileTree.focus();
      const before = await notesOpen(), treeBefore = await treeOpen();
      await page.keyboard.press('Tab');
      assert.equal(await notesOpen(), !before, label + ': Tab toggles the Notes sidebar');
      await page.keyboard.press('Tab');
      assert.equal(await notesOpen(), before, label + ': the next Tab restores the sidebar');
      assert.equal(await treeOpen(), treeBefore, label + ': the hidden Tree panel stays unchanged');
      assert.equal(await fileTree.evaluate(el => el === document.activeElement), true, label + ': focus stays in Notes');
    }
    await checkNotesTab('before visiting Tree');
    await switchWorkspace('canvas');
    await page.waitForFunction(() => document.querySelector('[data-role="tree-page-view"]')?.dataset.active === '1'
      && document.querySelector('.tree-page-embedded .study-route-node.is-root'));
    const viewport = tree.locator('[data-role="study-route-viewport"]');
    await viewport.focus();
    const initialTreeOpen = await treeOpen();
    await page.keyboard.press('Tab');
    assert.notEqual(await treeOpen(), initialTreeOpen, 'Tab still toggles the visible Tree progress panel');
    await page.keyboard.press('Tab');
    assert.equal(await treeOpen(), initialTreeOpen);
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await page.emulateMedia({ reducedMotion });
      await switchWorkspace('notes');
      await checkNotesTab('after visiting Tree, motion=' + reducedMotion);
      await switchWorkspace('canvas');
      await viewport.focus();
      const before = await treeOpen();
      await page.keyboard.press('Tab');
      assert.notEqual(await treeOpen(), before, 'returning to Tree restores its own Tab shortcut');
      await page.keyboard.press('Tab');
      assert.equal(await treeOpen(), before);
    }
    assert.equal(fs.readFileSync(note, 'utf8'), original, 'sidebar shortcuts never modify the note');
    assert.deepEqual(errors, []);
    console.log('note workspace Tab after Tree round-trip: ok');
  } finally {
    if (browser) await browser.close();
    server.kill();
    console.log('Isolated fixtures: ' + root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
