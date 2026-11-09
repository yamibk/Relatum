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

const mixedParent = 'zFolder/Mixed';
const pagedParent = 'zFolder/Paged';
const prefixGroups = {
  digit: ['2.实验', '10.实验', '３.实验'],
  latin: ['Alpha2', 'aLPHA10', 'ＡI学习'],
  han: ['第2章', '第10章', '𠀀练习', '﨑练习'],
  other: ['📌索引', '_索引', 'Ω索引'],
};
const priorityKey = 'canvas:noteTreeNamePriority:v1';

async function checkNamePriority(page) {
  const left = '[data-role="note-tree"]', right = '[data-role="note-notebook-tree"]';
  const row = (host, file) => page.locator(`${host} .note-tree-row[data-note-path="${file}"]`);
  const children = (host, parent) => page.locator(`${host} .note-tree-entry[data-path="${parent}"] > .note-tree-children-shell > .note-tree-children > .note-tree-entry > .note-tree-row`);
  const expand = async (host, folder) => {
    const target = row(host, folder);
    if (await target.getAttribute('aria-expanded') !== 'true') await target.locator('.note-tree-toggle').click();
  };
  const settings = page.locator('#note-settings-dialog');
  const selector = settings.locator('[data-role="note-library-name-priority-setting"] .review-choice-trigger');
  const select = settings.locator('#note-tree-name-priority');
  const sort = mode => settings.locator(`[data-note-sort-mode="${mode}"]`).click();
  const openSettings = () => page.locator('[data-note-action="toggle-library-settings"]').click();
  const choosePriority = async label => {
    await selector.click();
    await settings.getByRole('option', { name: label, exact: true }).click();
  };
  const expectMixed = async (priority, locale = 'zh-CN', direction = 1) => {
    const expected = await page.evaluate(({ groups, priority, locale, direction, parent }) => {
      const compare = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }).compare;
      const preferred = groups[priority] || [];
      const names = Object.values(groups).flat().sort((a, b) => Number(preferred.includes(b)) - Number(preferred.includes(a)) || direction * compare(a, b));
      return [parent + '/ZChild', ...names.map(name => `${parent}/${name}.md`)];
    }, { groups: prefixGroups, priority, locale, direction, parent: mixedParent });
    for (const host of [left, right]) {
      assert.deepEqual(await children(host, mixedParent).evaluateAll(rows => rows.map(row => row.dataset.notePath)), expected);
    }
  };

  await page.keyboard.press('Escape');
  const notebookToggle = page.locator('[data-note-action="toggle-notebooks"]');
  if (await notebookToggle.getAttribute('aria-expanded') !== 'true') await notebookToggle.click();
  await expand(left, 'zFolder');
  await expand(left, mixedParent);
  await expand(right, '');
  await expand(right, 'zFolder');
  await expand(right, mixedParent);
  const openedPath = mixedParent + '/第2章.md';
  await row(left, openedPath).click();
  await page.waitForFunction(path => CanvasNoteWorkspace.currentPath === path, openedPath);
  const originalRow = await row(left, openedPath).elementHandle();
  const originalEditor = await page.locator('.cm-editor').elementHandle();

  await page.evaluate(() => RelatumNoteTheme.apply('apple'));
  await openSettings();
  assert.equal(await selector.isVisible(), false);
  await sort('name-asc');
  assert.equal(await select.inputValue(), 'auto');
  await expectMixed('auto');
  await choosePriority('汉字开头优先');
  await expectMixed('han');
  await selector.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await select.inputValue(), 'digit');
  await expectMixed('digit');
  await sort('name-desc');
  await expectMixed('digit', 'zh-CN', -1);
  await sort('modified-desc');
  assert.equal(await selector.isVisible(), false);
  assert.equal(await select.inputValue(), 'digit');
  await sort('name-asc');
  await choosePriority('英文字母开头优先');
  await expectMixed('latin');
  await page.evaluate(() => RelatumI18n.setLanguage('en'));
  assert.equal(await selector.getAttribute('aria-label'), 'File name prefix priority');
  await expectMixed('latin', 'en');
  await choosePriority('Follow interface language (default)');
  await expectMixed('auto', 'en');
  await choosePriority('English letters first');
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    window.__restoreSortStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Test write failure', 'QuotaExceededError');
      return original.call(this, name, value);
    };
  }, priorityKey);
  await choosePriority('Han characters first');
  await page.evaluate(() => window.__restoreSortStorage());
  assert.equal(await select.inputValue(), 'latin');
  assert.match(await settings.locator('[data-settings-status]').textContent(), /Could not save/);
  await expectMixed('latin', 'en');
  await choosePriority('Digits first');
  await choosePriority('English letters first');

  await settings.locator('[data-settings-search]').fill('file name prefix priority');
  await settings.getByRole('button', { name: /File name prefix priority/ }).click();
  assert(await selector.evaluate(button => button === document.activeElement));
  for (const [width, mode] of [[1440, 'light'], [1440, 'dark'], [575, 'light'], [575, 'dark']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.body.dataset.startTheme = theme; }, mode);
    await selector.click();
    const list = settings.getByRole('listbox', { name: 'File name prefix priority' });
    const bounds = await list.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    assert.equal(await list.getByRole('option').count(), 4);
    await list.evaluate(node => Promise.all(node.closest('.review-choice-popup').getAnimations().map(animation => animation.finished)));
    await page.screenshot({ path: path.join(root, `priority-apple-${width}-${mode}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await settings.isVisible(), true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await settings.locator('[data-settings-action="close"]').click();
  assert(await originalRow.evaluate(node => node.isConnected), 'reordering should reuse the selected row');
  assert(await originalEditor.evaluate(node => node.isConnected), 'reordering should preserve the editor');
  assert.equal(await page.evaluate(() => CanvasNoteWorkspace.currentPath), openedPath);

  await page.reload();
  await page.locator('button[data-start-workspace="notes"]').click();
  await row(left, openedPath).waitFor();
  await openSettings();
  assert.equal(await select.inputValue(), 'latin');
  await settings.locator('[data-settings-action="close"]').click();
  await expand(left, pagedParent);
  const firstHan = await page.evaluate(async parent => {
    const response = await fetch(`/api/note-children?parent=${encodeURIComponent(parent)}&sort=name-asc&namePriority=han&limit=1`);
    return (await response.json()).items[0].path;
  }, pagedParent);
  assert.equal(firstHan, pagedParent + '/汉字优先.md');
  const more = page.locator(`${left} [data-note-more="${pagedParent}"]`);
  await more.waitFor({ state: 'attached' });
  const pattern = '**/api/note-children?*';
  let release, started, delivered, intercepted = false;
  const gate = new Promise(resolve => { release = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  const responseDelivered = new Promise(resolve => { delivered = resolve; });
  await page.route(pattern, async route => {
    const params = new URL(route.request().url()).searchParams;
    if (intercepted || params.get('parent') !== pagedParent || params.get('namePriority') !== 'latin' || !Number(params.get('offset'))) return route.continue();
    intercepted = true;
    started();
    await gate;
    const result = { items: [{ kind: 'note', path: pagedParent + '/LateResult.md', name: 'LateResult' }], hasMore: false };
    await route.fulfill({ json: result });
    delivered();
  });
  try {
    await more.evaluate(button => button.click());
    await Promise.race([requestStarted, sleep(5000).then(() => { throw Error('directory request did not start'); })]);
    await openSettings();
    await choosePriority('Han characters first');
    await choosePriority('Digits first');
    await choosePriority('English letters first');
    release();
    await responseDelivered;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await row(left, pagedParent + '/LateResult.md').count(), 0, 'late response from the original Latin order must be discarded');
    const treePattern = '**/api/notes-tree?*';
    const isHanView = url => {
      const request = new URL(url);
      return request.pathname === '/api/notes-tree' && JSON.parse(request.searchParams.get('view') || '{}').namePriority === 'han';
    };
    const failFirstPage = route => isHanView(route.request().url())
      ? route.fulfill({ status: 503, json: { error: 'Test unavailable directory', code: 'index_unavailable' } }) : route.continue();
    await page.route(treePattern, failFirstPage);
    try {
      const failure = page.waitForResponse(response => isHanView(response.url()) && response.status() === 503);
      await choosePriority('Han characters first');
      await failure;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert(await children(left, pagedParent).count(), 'keep the loaded rows after a first-page failure');
    } finally { await page.unroute(treePattern, failFirstPage); }
    const retry = page.waitForResponse(response => isHanView(response.url()) && response.ok());
    await more.evaluate(button => button.click());
    await retry;
    await page.waitForFunction(parent => document.querySelector(`[data-role="note-tree"] .note-tree-entry[data-path="${parent}"] .note-tree-children .note-tree-row`)?.dataset.notePath === parent + '/汉字优先.md', pagedParent);
    await settings.locator('[data-settings-action="reset-category"]').click();
    await settings.locator('[data-settings-action="accept-reset"]').click();
    assert.equal(await select.inputValue(), 'auto');
    assert.equal(await selector.isVisible(), false);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), priorityKey), null);
    await sort('name-asc');
    await choosePriority('Digits first');
    await settings.locator('[data-settings-action="reset-all"]').click();
    await settings.locator('[data-settings-action="accept-reset"]').click();
    await page.waitForFunction(() => document.querySelector('[data-settings-status]').textContent === 'Defaults restored');
    assert.equal(await select.inputValue(), 'auto');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), priorityKey), null);
  } finally {
    release();
    await page.unroute(pattern);
  }
}

(async () => {
  fs.mkdirSync(path.join(notes, 'aFolder'), { recursive: true });
  fs.mkdirSync(path.join(notes, 'zFolder'));
    fs.mkdirSync(path.join(notes, mixedParent, 'ZChild'), { recursive: true });
    fs.mkdirSync(path.join(notes, pagedParent));
    for (const name of Object.values(prefixGroups).flat()) fs.writeFileSync(path.join(notes, mixedParent, `${name}.md`), 'Mixed note');
    for (const name of [...Array.from({ length: 56 }, (_, i) => `A${i}`), '汉字优先', '9.实验']) {
      fs.writeFileSync(path.join(notes, pagedParent, `${name}.md`), 'Paged note');
    }
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
    const resetAppearance = async () => page.locator('[data-settings-action="reset-category"]').evaluate(node => {
      const style = getComputedStyle(node);
      return { border: style.borderTopWidth, background: style.backgroundColor };
    });
    assert.deepEqual(await resetAppearance(), { border: '0px', background: 'rgba(0, 0, 0, 0)' });
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await sleep(240);
    await page.screenshot({ path: path.join(root, 'settings-dark.png') });
    assert.deepEqual(await resetAppearance(), { border: '0px', background: 'rgba(0, 0, 0, 0)' });
    await page.locator('[data-settings-action="reset-category"]').click();
    const confirmRect = await page.locator('.relatum-settings-confirm').boundingBox();
    assert(confirmRect && confirmRect.x >= 0 && confirmRect.y >= 0 && confirmRect.x + confirmRect.width <= 1440);
    await sleep(200);
    await page.screenshot({ path: path.join(root, 'settings-reset-dark.png') });
    await page.locator('[data-settings-action="cancel-reset"]').click();
    await page.setViewportSize({ width: 700, height: 900 });
    await page.evaluate(() => document.querySelector('.note-workspace').classList.add('tree-overlay-open'));
    await sleep(300);
    await page.screenshot({ path: path.join(root, 'settings-narrow.png') });
    await page.locator('[data-settings-action="reset-category"]').click();
    const narrowConfirm = await page.locator('.relatum-settings-confirm').boundingBox();
    assert(narrowConfirm && narrowConfirm.x >= 0 && narrowConfirm.x + narrowConfirm.width <= 700);
    await sleep(200);
    await page.screenshot({ path: path.join(root, 'settings-reset-narrow.png') });
    await page.locator('[data-settings-action="cancel-reset"]').click();
    await page.evaluate(() => { document.body.dataset.startTheme = 'light'; document.querySelector('.note-workspace').classList.remove('tree-overlay-open'); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    assert.equal(await page.locator('[data-settings-title]').textContent(), 'Files & library');
    assert.equal(await page.locator('[data-settings-action="reset-category"]').textContent(), 'Reset category');
    await page.locator('[data-settings-action="reset-category"]').click();
    assert.equal(await page.locator('#relatum-settings-confirm-title').textContent(), 'Reset this category?');
    await page.locator('[data-settings-action="cancel-reset"]').click();
    await page.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    await page.locator('[data-settings-action="close"]').click();
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
    await page.locator('[data-note-action="toggle-notebooks"]').click();
    await page.waitForTimeout(280);
    await page.locator('[data-note-action="toggle-sort"]').click();
    await page.locator('[data-note-action="toggle-settings"]').click();
    assert.equal(await page.locator('[data-note-action="toggle-sort"]').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-note-action="toggle-settings"]').getAttribute('aria-expanded'), 'true');
    await page.locator('nav [data-settings-category="files"]').click();
    assert.equal(await page.locator('[data-note-action="toggle-settings"]').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('[data-note-action="toggle-library-settings"]').getAttribute('aria-expanded'), 'true');
    await page.locator('[data-settings-action="close"]').click();

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
    assert(await row.evaluate(node => node.isConnected), 'order changes move existing rows and preserve their focus/transition');

    await page.locator('[data-note-action="toggle-library-settings"]').click();
    await page.locator('[data-note-name-mode="custom"]').click();
    await page.locator('[data-role="note-library-name-input"]').fill('Ideas');
    await page.locator('[data-role="note-library-name-input"]').fill('CON');
    assert(await page.locator('[data-role="note-library-name-error"]').isVisible());
    await page.locator('[data-role="note-library-name-input"]').evaluate(node => node.blur());
    assert.equal(await page.locator('[data-role="note-library-name-input"]').inputValue(), 'Ideas');
    await page.locator('[data-settings-action="close"]').click();
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
    await page.locator('[data-settings-action="reset-category"]').click();
    assert(await page.locator('.relatum-settings-confirm').isVisible());
    await page.locator('[data-settings-action="cancel-reset"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTreeSort:v1')), 'name-desc');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('canvas:noteNewName:v1')).baseName), 'Ideas');
    await page.locator('[data-settings-action="reset-category"]').click();
    await page.keyboard.press('Escape');
    assert(await page.locator('#note-library-settings').isVisible(), 'Escape should dismiss confirmation before settings');
    assert(await page.locator('.relatum-settings-confirm').evaluate(node => node.inert), 'confirmation stops accepting input before its exit transition');
    await page.locator('.relatum-settings-confirm').waitFor({ state: 'hidden' });
    await page.locator('[data-settings-action="reset-category"]').click();
    await page.locator('[data-settings-action="accept-reset"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTreeSort:v1')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteNewName:v1')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteFontScale:v1')), '137');
    assert.equal(await page.locator('#note-library-settings [data-note-sort-mode="modified-desc"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-note-name-mode="timestamp"]').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('[data-role="note-library-name-preview"]').textContent(), /\d{4}-\d{2}-\d{2}-\d{6}\.md/);
    assert.equal(fs.readFileSync(path.join(notes, 'Ideas.md'), 'utf8'), '');
    await page.locator('[data-settings-action="close"]').click();
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
    await checkNamePriority(page);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('note tree sorting and naming browser: ok');
  } finally {
    if (browser) await browser.close();
    server.kill();
    console.log('Isolated fixtures: ' + root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
