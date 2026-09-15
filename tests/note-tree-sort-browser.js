'use strict';

// Real UI and API smoke test against an isolated notes root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-sort-'));
const notes = path.join(root, 'notes');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function port() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const value = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return value;
}
async function paths(page, scope = '.note-tree-scroll') {
  return page.locator(`${scope} > .note-tree-entry > .note-tree-row`).evaluateAll(rows => rows.map(row => row.dataset.notePath));
}
async function chooseSort(page, mode) {
  await page.locator('[data-note-action="toggle-sort"]').click();
  await page.locator(`#note-sort-menu [data-note-sort-mode="${mode}"]`).click();
}

(async () => {
  fs.mkdirSync(path.join(notes, 'aFolder'), { recursive: true });
  fs.mkdirSync(path.join(notes, 'zFolder'));
  fs.writeFileSync(path.join(notes, 'aFolder', 'B.md'), 'B');
  fs.writeFileSync(path.join(notes, 'aFolder', 'C.md'), 'C');
  for (const name of ['A', 'Z', 'M']) {
    fs.writeFileSync(path.join(notes, `${name}.md`), name);
    await sleep(30);
  }
  const now = Date.now() / 1000;
  for (const [name, offset] of [['A', -100], ['Z', 0], ['M', -200]]) {
    fs.utimesSync(path.join(notes, `${name}.md`), now + offset, now + offset);
  }
  fs.utimesSync(path.join(notes, 'aFolder', 'B.md'), now, now);
  fs.utimesSync(path.join(notes, 'aFolder', 'C.md'), now - 100, now - 100);
  const listenPort = await port();
  const url = `http://127.0.0.1:${listenPort}`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(listenPort)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url + '/api/runtime')).ok) break; } catch (error) {}
      await sleep(100);
    }
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.locator('.note-tree-row[data-note-path="Z.md"]').waitFor();
    const expectPaths = async expected => assert.deepEqual(await paths(page), ['aFolder', 'zFolder', ...expected.map(name => `${name}.md`)]);
    await expectPaths(['Z', 'A', 'M']);
    await page.locator('.note-tree-row[data-note-path="aFolder"]').click();
    assert.deepEqual(await page.locator('.note-tree-entry[data-path="aFolder"] > .note-tree-children-shell > .note-tree-children > .note-tree-entry > .note-tree-row').evaluateAll(rows => rows.map(row => row.dataset.notePath)), ['aFolder/B.md', 'aFolder/C.md']);
    await page.locator('.note-tree-row[data-note-path="aFolder"]').click();
    await sleep(500);
    await page.locator('[data-note-action="toggle-sort"]').click();
    await sleep(240);
    await page.screenshot({ path: path.join(root, 'sort-light.png') });
    await page.locator('[data-note-action="toggle-sort"]').click();
    await page.locator('[data-note-action="toggle-library-settings"]').click();
    await sleep(240);
    await page.screenshot({ path: path.join(root, 'settings-light.png') });
    const resetAppearance = async () => page.locator('[data-note-library-action="reset-open"]').evaluate(node => {
      const style = getComputedStyle(node);
      return { border: style.borderTopWidth, background: style.backgroundColor };
    });
    assert.deepEqual(await resetAppearance(), { border: '0px', background: 'rgba(0, 0, 0, 0)' });
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await sleep(240);
    await page.screenshot({ path: path.join(root, 'settings-dark.png') });
    assert.deepEqual(await resetAppearance(), { border: '0px', background: 'rgba(0, 0, 0, 0)' });
    await page.locator('[data-note-library-action="reset-open"]').click();
    const confirmRect = await page.locator('[data-role="note-library-reset-confirm"]').boundingBox();
    assert(confirmRect && confirmRect.x >= 0 && confirmRect.y >= 0 && confirmRect.x + confirmRect.width <= 1440);
    await sleep(200);
    await page.screenshot({ path: path.join(root, 'settings-reset-dark.png') });
    await page.locator('[data-note-library-action="reset-cancel"]').click();
    await page.setViewportSize({ width: 700, height: 900 });
    await page.evaluate(() => document.querySelector('.note-workspace').classList.add('tree-overlay-open'));
    await sleep(300);
    await page.screenshot({ path: path.join(root, 'settings-narrow.png') });
    await page.locator('[data-note-library-action="reset-open"]').click();
    const narrowConfirm = await page.locator('[data-role="note-library-reset-confirm"]').boundingBox();
    assert(narrowConfirm && narrowConfirm.x >= 0 && narrowConfirm.x + narrowConfirm.width <= 700);
    await sleep(200);
    await page.screenshot({ path: path.join(root, 'settings-reset-narrow.png') });
    await page.locator('[data-note-library-action="reset-cancel"]').click();
    await page.evaluate(() => { document.body.dataset.startTheme = 'light'; document.querySelector('.note-workspace').classList.remove('tree-overlay-open'); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    assert.equal(await page.locator('[data-role="note-library-settings-title"]').textContent(), 'Library settings');
    assert.equal(await page.locator('[data-role="note-library-reset-label"]').textContent(), 'Reset');
    await page.locator('[data-note-library-action="reset-open"]').click();
    assert.equal(await page.locator('[data-role="note-library-reset-title"]').textContent(), 'Restore default Library settings?');
    await page.locator('[data-note-library-action="reset-cancel"]').click();
    await page.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    await page.locator('[data-note-action="toggle-library-settings"]').click();
    for (const [mode, expected] of [
      ['name-asc', ['A', 'M', 'Z']], ['name-desc', ['Z', 'M', 'A']],
      ['modified-desc', ['Z', 'A', 'M']], ['modified-asc', ['M', 'A', 'Z']],
      ['created-desc', ['M', 'Z', 'A']], ['created-asc', ['A', 'Z', 'M']],
    ]) {
      await chooseSort(page, mode);
      await expectPaths(expected);
    }
    await page.locator('[data-note-action="toggle-sort"]').click();
    assert.equal(await page.locator('#note-sort-menu').isVisible(), true);
    await page.keyboard.press('Escape');
    await sleep(180);
    assert(await page.locator('#note-sort-menu').evaluate(node => node.hidden && node.inert));
    assert.equal(await page.locator('[data-note-action="toggle-sort"]').getAttribute('aria-expanded'), 'false');
    await page.locator('[data-note-action="toggle-sort"]').click();
    await page.locator('.note-tree-foot').click();
    assert.equal(await page.locator('[data-note-action="toggle-sort"]').getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => {
      const trigger = document.querySelector('[data-note-action="toggle-sort"]');
      for (let i = 0; i < 8; i++) trigger.click();
    });
    await sleep(220);
    assert.equal(await page.locator('[data-note-action="toggle-sort"]').getAttribute('aria-expanded'), 'false', 'rapid toggles must settle closed');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[data-note-action="toggle-sort"]').click();
    assert.equal(await page.locator('#note-sort-menu').evaluate(node => getComputedStyle(node).animationName), 'none');
    await page.locator('[data-note-action="toggle-sort"]').click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('[data-note-action="toggle-sort"]').click();
    await page.locator('[data-note-action="toggle-settings"]').click();
    assert.equal(await page.locator('[data-note-action="toggle-sort"]').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-note-action="toggle-settings"]').getAttribute('aria-expanded'), 'true');
    await page.locator('[data-note-action="toggle-library-settings"]').click();
    assert.equal(await page.locator('[data-note-action="toggle-settings"]').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-note-action="toggle-library-settings"]').getAttribute('aria-expanded'), 'true');
    await page.locator('[data-note-action="toggle-library-settings"]').click();

    await page.locator('[data-note-action="toggle-library-settings"]').click();
    await page.locator('#note-library-settings [data-note-sort-mode="modified-desc"]').click();
    await expectPaths(['Z', 'A', 'M']);
    await page.reload();
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.locator('.note-tree-row[data-note-path="Z.md"]').waitFor();
    await expectPaths(['Z', 'A', 'M']);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTreeSort:v1')), 'modified-desc');

    const row = await page.locator('.note-tree-row[data-note-path="A.md"]').elementHandle();
    const unchanged = await page.evaluate(async () => {
      const tree = document.querySelector('[data-role="note-tree"]');
      const before = tree.firstElementChild;
      await CanvasNoteWorkspace.refresh(false);
      return before === tree.firstElementChild;
    });
    assert(unchanged, 'unchanged polling should reuse tree DOM');
    fs.utimesSync(path.join(notes, 'Z.md'), now + 1, now + 1);
    await page.evaluate(() => CanvasNoteWorkspace.refresh(false));
    assert(await row.evaluate(node => node.isConnected), 'metadata refresh without order change should reuse rows');
    fs.utimesSync(path.join(notes, 'M.md'), now + 200, now + 200);
    await page.evaluate(() => CanvasNoteWorkspace.refresh(false));
    await expectPaths(['M', 'Z', 'A']);
    assert(await row.evaluate(node => node.isConnected) === false, 'order change should update tree DOM');

    await page.locator('[data-note-action="toggle-library-settings"]').click();
    await page.locator('[data-note-name-mode="custom"]').click();
    await page.locator('[data-role="note-library-name-input"]').fill('Ideas');
    await page.locator('[data-role="note-library-name-input"]').fill('CON');
    assert(await page.locator('[data-role="note-library-name-error"]').isVisible());
    await page.locator('[data-role="note-library-name-input"]').evaluate(node => node.blur());
    assert.equal(await page.locator('[data-role="note-library-name-input"]').inputValue(), 'Ideas');
    await page.locator('[data-note-action="toggle-library-settings"]').click();
    await page.locator('.note-head-actions [data-note-action="new-note"]').click();
    await page.locator('.note-tree-row[data-note-path="Ideas.md"]').waitFor();
    await page.locator('.note-head-actions [data-note-action="new-note"]').click();
    await page.locator('.note-tree-row[data-note-path="Ideas-2.md"]').waitFor();
    await page.keyboard.press('Control+n');
    await page.locator('.note-tree-row[data-note-path="Ideas-3.md"]').waitFor();
    await page.locator('.note-tree-scroll').click({ button: 'right', position: { x: 100, y: 600 } });
    await page.locator('[data-role="note-context-menu"] button').first().click();
    await page.locator('.note-tree-row[data-note-path="Ideas-4.md"]').waitFor();
    const conflict = await page.evaluate(async () => {
      const response = await fetch('/api/note-move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'Ideas-3.md', destination: 'Ideas.md' }) });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'exists');
    assert.equal(fs.readFileSync(path.join(notes, 'Ideas.md'), 'utf8'), '');
    await page.locator('[data-note-action="toggle-library-settings"]').click();
    await page.locator('#note-library-settings [data-note-sort-mode="name-desc"]').click();
    await page.evaluate(() => localStorage.setItem('canvas:noteFontScale:v1', '137'));
    await page.locator('[data-note-library-action="reset-open"]').click();
    assert(await page.locator('[data-role="note-library-reset-confirm"]').isVisible());
    await page.locator('[data-note-library-action="reset-cancel"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTreeSort:v1')), 'name-desc');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('canvas:noteNewName:v1')).baseName), 'Ideas');
    await page.locator('[data-note-library-action="reset-open"]').click();
    await page.keyboard.press('Escape');
    assert(await page.locator('#note-library-settings').isVisible(), 'Escape should dismiss confirmation before settings');
    assert.equal(await page.locator('[data-role="note-library-reset-confirm"]').isVisible(), false);
    await page.locator('[data-note-library-action="reset-open"]').click();
    await page.locator('[data-note-library-action="reset-accept"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTreeSort:v1')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteNewName:v1')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteFontScale:v1')), '137');
    assert.equal(await page.locator('#note-library-settings [data-note-sort-mode="modified-desc"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-note-name-mode="timestamp"]').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('[data-role="note-library-name-preview"]').textContent(), /\d{4}-\d{2}-\d{2}-\d{6}\.md/);
    assert.equal(fs.readFileSync(path.join(notes, 'Ideas.md'), 'utf8'), '');
    await page.locator('[data-note-action="toggle-library-settings"]').click();
    await page.reload();
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.locator('.note-tree-row[data-note-path="Ideas.md"]').waitFor();
    assert.equal(await page.locator('[data-note-name-mode="timestamp"]').getAttribute('aria-pressed'), 'true');
    await page.locator('.note-head-actions [data-note-action="new-note"]').click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.note-tree-row')).some(row => /^\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.md$/.test(row.dataset.notePath || '')));

    const folderRow = page.locator('.note-tree-row[data-note-path="aFolder"]');
    if (await folderRow.getAttribute('aria-expanded') !== 'true') await folderRow.click();
    await page.locator('.note-tree-row[data-note-path="aFolder/B.md"]').click();
    await folderRow.click();
    assert.equal(await folderRow.evaluate(node => node.classList.contains('selected-folder')), true);
    const treeBox = await page.locator('[data-role="note-tree"]').boundingBox();
    assert(treeBox, 'note tree must have a clickable blank area');
    await page.mouse.click(treeBox.x + treeBox.width - 8, treeBox.y + treeBox.height - 8);
    assert.equal(await page.locator('.note-tree-row.selected-folder').count(), 0, 'blank tree click must clear folder selection');
    await page.locator('.note-head-actions [data-note-action="new-folder"]').click();
    await page.locator('.note-tree-scroll > .note-tree-entry[data-path="新建文件夹"] > .note-tree-row').waitFor();
    assert.equal(await page.locator('.note-tree-entry[data-path="aFolder"] .note-tree-entry[data-path="aFolder/新建文件夹"]').count(), 0,
      'blank tree click must target the notes root even while a nested note is open');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('note tree sorting and naming browser: ok');
  } finally {
    if (browser) await browser.close();
    server.kill();
    console.log('Isolated fixtures: ' + root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
