'use strict';

// Real notebook UI/API acceptance on an isolated disposable data root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-notebooks-'));
const notes = path.join(dataRoot, 'notes');
const container = path.join(notes, 'CustomNotebook');
const settingsFile = path.join(dataRoot, 'data', 'note-notebooks.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(path.join(notes, 'Legacy'), { recursive: true });
fs.mkdirSync(path.join(container, 'Physics', 'Chapter'), { recursive: true });
fs.mkdirSync(path.join(container, 'Empty'));
fs.writeFileSync(path.join(notes, 'Root.md'), 'Original note\n');
fs.writeFileSync(path.join(container, 'Physics', 'P.md'), 'Physics note\n');
fs.writeFileSync(path.join(container, 'Physics', 'Chapter', 'C.md'), 'Chapter note\n');

async function waitFor(check, message) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(100); }
  throw new Error(message);
}
function settings() { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

(async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: dataRoot }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    await waitFor(async () => { try { return (await fetch(url + '/api/runtime')).ok; } catch { return false; } }, 'server did not start');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let source = fs.readFileSync(path.join(repo, 'assets', 'note-workspace.js'), 'utf8');
    source = source.replace('  window.CanvasNoteWorkspace = {',
      '  window.__notebooksTest = {state, editor: liveEditor, flushNotebookSettings, triggerExternalSync};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    let treeRequests = 0, settingRequests = 0, creationRequests = 0;
    page.on('request', request => {
      if (request.url().includes('/api/notes-tree')) treeRequests++;
      if (request.url().includes('/api/note-notebooks-settings')) settingRequests++;
      if (/\/api\/note-(create|import-begin)$/.test(request.url())) creationRequests++;
    });
    async function enter() {
      await page.goto(url);
      await page.waitForFunction(() => window.CanvasNoteWorkspace);
      await page.locator('button[data-start-workspace="notes"]').click();
      await page.waitForFunction(() => window.__notebooksTest?.state.initialized && window.__notebooksTest.state.active);
    }
    const left = '[data-role="note-tree"]';
    const right = '[data-role="note-notebook-tree"]';
    const row = (host, value) => page.locator(`${host} .note-tree-row[data-note-path="${value}"]`);
    const rootRow = value => page.locator(`${right} > .note-notebook-root > .note-tree-row[data-note-path="${value}"]`);
    const notebookBlank = page.locator('[data-role="note-notebooks-content"]');
    async function clickNotebookBlank(button = 'left') {
      const bounds = await notebookBlank.boundingBox();
      await notebookBlank.click({ button, position: { x: bounds.width / 2, y: bounds.height - 12 } });
    }
    const toolPositions = () => page.locator('.note-document-tools > button').evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect(); return [Math.round(rect.x * 100), Math.round(rect.y * 100)];
    }));
    const emptyPositions = () => page.locator('.note-empty-state > *').evaluateAll(items => items.map(item => {
      const rect = item.getBoundingClientRect(); return [Math.round((rect.x + rect.width / 2) * 100), Math.round(rect.y * 100)];
    }));
    const settleSide = () => page.waitForTimeout(280);
    async function checkSideTools(mode) {
      const visibleActions = await page.locator('[data-role="note-side-toolbar"] > button').evaluateAll(buttons =>
        buttons.filter(button => !button.hidden).map(button => button.dataset.noteAction));
      assert.deepEqual(visibleActions, mode === 'notebooks'
        ? ['new-notebook', 'toggle-all-notebooks', 'toggle-image-text', 'toggle-settings']
        : ['toggle-image-text', 'toggle-settings']);
    }
    async function checkRowsAndBoundary() {
      const geometry = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const tabs = rect('.note-tab-bar'), heading = rect('.note-links-head');
        const left = rect('.note-tree-pane > .note-pane-head'), main = rect('.note-document-head'), tools = rect('.note-side-toolbar');
        const leftStyle = getComputedStyle(document.querySelector('.note-tree-pane'));
        const sideStyle = getComputedStyle(document.querySelector('.note-links-pane'));
        return { first: [tabs.height, heading.height, tabs.bottom - heading.bottom], second: [left.height, main.height, tools.height, left.top - main.top, tools.top - main.top],
          border: [leftStyle.borderRightColor, sideStyle.borderLeftColor], shadow: sideStyle.boxShadow };
      });
      assert.deepEqual(geometry.first, [40, 40, 0]);
      assert.deepEqual(geometry.second, [48, 48, 48, 0, 0]);
      assert.equal(geometry.border[0], geometry.border[1]);
      assert.equal(geometry.shadow, 'none');
    }
    async function toggleAndCheckAnimation() {
      const drift = await page.evaluate(async () => {
        const elements = [...document.querySelectorAll('.note-document-tools > button, .note-empty-state > *')];
        const positions = () => elements.map(el => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y]; });
        const baseline = positions(); let delta = 0;
        document.querySelector('[data-note-action="toggle-notebooks"]').click();
        const start = performance.now();
        do {
          await new Promise(requestAnimationFrame);
          positions().forEach((point, i) => point.forEach((value, axis) => { delta = Math.max(delta, Math.abs(value - baseline[i][axis])); }));
        } while (performance.now() - start < 280);
        return delta;
      });
      assert(drift < 1, 'toolbar and empty hint stay stationary throughout the sidebar transition');
    }
    async function checkSettingsPopover() {
      await page.locator('[data-note-action="toggle-settings"]').click();
      const popover = page.locator('[data-role="note-settings-pop"]');
      await popover.waitFor();
      assert.equal(await popover.evaluate(el => el.parentElement.classList.contains('note-workspace')), true);
      const bounds = await popover.boundingBox(), surface = await page.locator('.note-workspace').boundingBox();
      assert(bounds.x >= surface.x + 11 && bounds.x + bounds.width <= surface.x + surface.width - 11);
      assert(bounds.y >= surface.y + 11 && bounds.y + bounds.height <= surface.y + surface.height - 11);
      await popover.locator('input').first().focus();
      await page.evaluate(() => document.querySelector('[data-note-action="close-links"]').click());
      assert.equal(await popover.evaluate(el => el.inert), true);
      assert.equal(await page.locator('[data-note-action="toggle-settings"]').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.noteAction), 'toggle-notebooks', 'closing returns hidden popover focus to the sole toggle');
      await settleSide(); assert.equal(await popover.isHidden(), true);
      await page.locator('[data-note-action="toggle-notebooks"]').click(); await settleSide();
    }
    const notebookNames = () => page.locator(`${right} > .note-notebook-root > .note-tree-row .note-tree-label`).allTextContents();
    const sync = () => page.evaluate(() => __notebooksTest.triggerExternalSync({ silentErrors: true }));
    const flush = () => page.evaluate(() => __notebooksTest.flushNotebookSettings());
    async function screenshot(name) {
      if (process.env.RELATUM_ARTIFACT_DIR) {
        fs.mkdirSync(process.env.RELATUM_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, name + '.png') });
      }
    }

    await enter();
    assert.equal(await page.locator('.note-document-tools > button').count(), 3);
    assert.equal(await page.locator('[data-note-action="toggle-links"]').count(), 0);
    assert.equal(await page.locator('.note-workspace.links-overlay-open').count(), 0);
    const closedEmptyPositions = await emptyPositions();
    await toggleAndCheckAnimation();
    await checkRowsAndBoundary(); await checkSideTools('notebooks');
    assert.deepEqual(await emptyPositions(), closedEmptyPositions, 'wide empty prompt stays fixed when sidebar opens');
    await page.locator('[data-note-action="side-links"]').click();
    await checkSideTools('links');
    assert.deepEqual(await emptyPositions(), closedEmptyPositions, 'empty prompt stays fixed across sidebar views');
    await toggleAndCheckAnimation();
    assert.deepEqual(await emptyPositions(), closedEmptyPositions, 'wide empty prompt stays fixed when sidebar closes');
    await toggleAndCheckAnimation();
    assert.equal(await page.locator('[data-note-action="side-links"]').getAttribute('aria-pressed'), 'true', 'sole toggle restores the last sidebar view');
    await page.locator('[data-note-action="side-notebooks"]').click();
    await page.locator('[data-note-action="close-links"]').click(); await settleSide();
    await page.evaluate(() => {
      const toggle = document.querySelector('[data-note-action="toggle-notebooks"]');
      toggle.click(); requestAnimationFrame(() => { toggle.click(); requestAnimationFrame(() => { toggle.click(); toggle.click(); }); });
    });
    await settleSide();
    assert.equal(await page.locator('.note-workspace.links-overlay-open').count(), 0, 'continuous reversals settle at the last closed intent');
    assert.deepEqual(await emptyPositions(), closedEmptyPositions);
    assert.deepEqual(await page.evaluate(async () => [
      (await fetch('/api/note-history?path=Root.md')).status,
      (await fetch('/api/note-history-restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status,
    ]), [404, 404], 'removed history APIs use ordinary missing responses');
    assert.equal(await row(left, 'CustomNotebook').count(), 0, 'container must not appear in default notebook');
    await row(left, 'Root.md').click();
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'Root.md');
    await page.evaluate(() => { window.__originalDoc = __notebooksTest.editor.view.state.doc; window.__originalView = __notebooksTest.editor.view; });
    const closedToolPositions = await toolPositions();
    await page.locator('[data-note-action="toggle-notebooks"]').click(); await settleSide();
    assert.deepEqual(await toolPositions(), closedToolPositions, 'wide toolbar stays fixed when sidebar opens');
    for (const mode of ['links', 'notebooks']) {
      await page.locator(`[data-note-action="side-${mode}"]`).click();
      assert.deepEqual(await toolPositions(), closedToolPositions, 'sidebar mode does not move toolbar');
      await checkSideTools(mode); await checkSettingsPopover();
      assert.equal(await page.locator(`[data-note-action="side-${mode}"]`).getAttribute('aria-pressed'), 'true');
      if (mode === 'links') {
        await page.locator('[data-role="note-links-content"]').dispatchEvent('contextmenu', { button: 2 });
        assert.equal(await page.locator('[data-role="note-context-menu"]').isHidden(), true, 'links blank area does not show notebook actions');
      }
    }
    assert.deepEqual(await notebookNames(), ['notes', 'Empty', 'Physics']);
    assert.equal(await page.locator('.note-icon-definitions').count(), 1);
    assert.deepEqual(await page.locator('.note-workspace svg.note-icon use').evaluateAll(uses =>
      uses.filter(use => !document.getElementById(use.getAttribute('href').slice(1))).map(use => use.getAttribute('href'))), [], 'all local icon references resolve');
    for (const [action, icon] of Object.entries({ 'new-note': 'file-plus-corner', 'new-folder': 'folder-plus',
      'toggle-library-settings': 'folder-cog', 'toggle-settings': 'sliders-horizontal', 'toggle-focus': 'panel-top-close', 'current-menu': 'ellipsis' })) {
      assert.equal(await page.locator(`[data-note-action="${action}"] svg use`).first().getAttribute('href'), '#note-icon-' + icon);
    }
    assert.equal(await page.locator('[data-note-action="toggle-focus"] svg').evaluateAll(items => items.filter(el => getComputedStyle(el).display !== 'none').length), 1);
    assert.deepEqual(await page.locator('.note-document-tools svg').evaluateAll(items => items.map(el => {
      const style = getComputedStyle(el); return [el.getAttribute('viewBox'), style.width, style.height, style.strokeLinecap];
    })), Array(3).fill(['0 0 24 24', '18px', '18px', 'round']));
    await clickNotebookBlank('right');
    const blankMenu = page.locator('[data-role="note-context-menu"]');
    await blankMenu.waitFor();
    assert.deepEqual(await blankMenu.locator('button').allTextContents(), ['新建笔记本', '在资源管理器中打开']);
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), '', 'blank context menu preserves selection');
    let revealed;
    await page.route('**/api/note-reveal', route => {
      revealed = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true } });
    });
    await blankMenu.locator('button').last().click();
    await waitFor(() => !!revealed, 'blank explorer action was not dispatched');
    assert.equal(revealed.path, '', 'blank explorer always targets notes/');
    await page.unroute('**/api/note-reveal');
    await rootRow('').locator('.note-tree-label').dblclick();
    assert.equal(await page.locator(`${right} .note-tree-rename`).count(), 0, 'default notebook cannot rename');
    await rootRow('CustomNotebook/Physics').locator('.note-notebook-icon').dblclick();
    assert.equal(await page.locator(`${right} .note-tree-rename`).count(), 0, 'icon double click does not rename');
    await clickNotebookBlank('right'); await blankMenu.waitFor();
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), 'CustomNotebook/Physics', 'blank context menu also preserves a custom selection');
    await rootRow('CustomNotebook/Physics').locator('.note-tree-label').dblclick();
    let renameNotebook = page.locator(`${right} .note-tree-rename`);
    await renameNotebook.waitFor(); await renameNotebook.fill('Empty'); await renameNotebook.press('Enter');
    await page.locator(`${right} .note-tree-inline-error`).waitFor();
    await clickNotebookBlank();
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), 'CustomNotebook/Physics', 'failed rename prevents deselection');
    assert.equal(await renameNotebook.count(), 1);
    await renameNotebook.press('Escape');
    await rootRow('').click();
    const retained = await page.evaluate(() => ({ tabs: __notebooksTest.state.tabs.slice(),
      left: [...__notebooksTest.state.expanded], right: [...__notebooksTest.state.notebookExpanded] }));
    await clickNotebookBlank();
    await page.waitForFunction(() => __notebooksTest.state.notebookRoot === null);
    assert.equal(await page.locator(left).innerHTML(), '', 'unselected left tree is entirely empty');
    assert.equal(await page.locator('.note-tree-foot').isHidden(), true);
    assert.equal(await page.locator(`${right} .selected-notebook`).count(), 0);
    assert.equal(await page.evaluate(() => __notebooksTest.editor.view === __originalView && __notebooksTest.editor.view.state.doc === __originalDoc), true);
    assert.deepEqual(await page.evaluate(() => ({ tabs: __notebooksTest.state.tabs.slice(),
      left: [...__notebooksTest.state.expanded], right: [...__notebooksTest.state.notebookExpanded] })), retained);
    for (const action of ['new-note', 'new-folder', 'reveal-root']) {
      assert.equal(await page.locator(`[data-note-action="${action}"]`).evaluateAll(items => items.every(el => el.disabled && el.dataset.uiTooltip === '请先选择笔记本')), true);
    }
    const beforeCreation = creationRequests;
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+n');
    await page.locator(left).evaluate(el => {
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File(['blocked'], 'Blocked.md', { type: 'text/markdown' }));
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    });
    await page.waitForTimeout(200);
    assert.equal(creationRequests, beforeCreation, 'unselected new-note and tree drop make no filesystem request');
    assert(!fs.existsSync(path.join(notes, 'Blocked.md')));
    await page.locator('[data-note-action="toggle-browser"]').click();
    await page.locator('.note-browser-result').first().waitFor();
    const browserHeading = await page.locator('.note-browser-results-head').textContent();
    await clickNotebookBlank();
    await page.waitForFunction(() => !document.querySelector('.note-workspace').classList.contains('note-browser-mode'));
    assert.equal(await page.locator(left).innerHTML(), '');
    await page.locator('[data-note-action="toggle-browser"]').click();
    await page.locator('.note-browser-result').first().waitFor();
    assert.equal(await page.locator('.note-browser-results-head').textContent(), browserHeading, 'browse conditions survive blank deselection');
    await clickNotebookBlank();
    await page.waitForFunction(() => !document.querySelector('.note-workspace').classList.contains('note-browser-mode'));
    fs.writeFileSync(path.join(notes, 'Root.md'), 'Externally changed note\n');
    await sync();
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), null, 'external body refresh cannot select a notebook');
    assert.equal(await page.locator(left).innerHTML(), '');
    await flush(); assert.equal(settings().ui.selectedRoot, null);
    await page.reload(); await page.waitForFunction(() => window.__notebooksTest?.state.initialized);
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), null, 'null selection survives restart with an open note');
    assert.equal(await page.locator(left).innerHTML(), '');
    assert.equal(await page.evaluate(() => CanvasNoteWorkspace.currentPath), 'Root.md');
    await page.locator('button[data-start-workspace="canvas"]').click();
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => __notebooksTest.state.active);
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), null, 'workspace return keeps null selection');
    await page.locator('.note-tab[data-note-tab-path="Root.md"]').click();
    await page.waitForFunction(() => __notebooksTest.state.notebookRoot === '');
    await row(left, 'Root.md').waitFor();
    await page.evaluate(() => { window.__originalDoc = __notebooksTest.editor.view.state.doc; window.__originalView = __notebooksTest.editor.view; });
    assert.equal(await rootRow('CustomNotebook/Physics').getAttribute('aria-expanded'), 'false');
    await rootRow('CustomNotebook/Physics').click();
    assert.equal(await rootRow('CustomNotebook/Physics').getAttribute('aria-expanded'), 'false', 'row selection does not expand notebook');
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), 'CustomNotebook/Physics');
    assert.equal(await page.evaluate(() => __notebooksTest.editor.view === __originalView && __notebooksTest.editor.view.state.doc === __originalDoc), true, 'classification must preserve editor and document');
    assert.equal(await row(left, 'Root.md').count(), 0);
    await row(left, 'CustomNotebook/Physics/P.md').waitFor();
    assert.equal(await page.evaluate(() => CanvasNoteWorkspace.currentPath), 'Root.md');
    assert.equal(Math.round((await page.locator('.note-links-pane').boundingBox()).width), 300);
    assert.equal(await page.locator('.note-links-pane').evaluate(el => getComputedStyle(el).position), 'relative');
    await rootRow('CustomNotebook/Physics').press('Enter');
    await rootRow('CustomNotebook/Physics').press('Space');
    assert.equal(await rootRow('CustomNotebook/Physics').getAttribute('aria-expanded'), 'false', 'keyboard activation only selects');
    const arrowBox = await rootRow('CustomNotebook/Physics').locator('.note-tree-toggle').boundingBox();
    await page.mouse.click(arrowBox.x - 4, arrowBox.y + arrowBox.height / 2);
    assert.equal(await rootRow('CustomNotebook/Physics').getAttribute('aria-expanded'), 'true', 'near-arrow hit expands notebook');
    await rootRow('CustomNotebook/Physics').locator('.note-notebook-icon').click();
    await rootRow('CustomNotebook/Physics').locator('.note-tree-label').click();
    assert.equal(await rootRow('CustomNotebook/Physics').getAttribute('aria-expanded'), 'true', 'icon and label preserve expanded state');
    await rootRow('CustomNotebook/Physics').press('ArrowLeft');
    assert.equal(await rootRow('CustomNotebook/Physics').getAttribute('aria-expanded'), 'false');
    await rootRow('CustomNotebook/Physics').press('ArrowRight');
    assert.equal(await rootRow('CustomNotebook/Physics').getAttribute('aria-expanded'), 'true');

    await row(left, 'CustomNotebook/Physics/Chapter').click();
    assert.equal(await row(right, 'CustomNotebook/Physics/Chapter').getAttribute('aria-expanded'), 'false', 'trees have separate expansion state');
    await row(right, 'CustomNotebook/Physics/Chapter').click();
    await row(right, 'CustomNotebook/Physics/Chapter/C.md').waitFor();
    await row(right, 'CustomNotebook/Physics/Chapter/C.md').click();
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'CustomNotebook/Physics/Chapter/C.md');
    await page.locator('.cm-content').click();
    assert.equal(await page.locator('.note-workspace.links-overlay-open').count(), 1);
    await page.locator('[data-note-action="toggle-all-notebooks"]').click();
    assert.equal(await rootRow('CustomNotebook/Physics').getAttribute('aria-expanded'), 'false');
    assert.equal(await row(left, 'CustomNotebook/Physics/Chapter').getAttribute('aria-expanded'), 'true');
    for (let i = 0; i < 5; i++) await rootRow('CustomNotebook/Physics').locator('.note-tree-toggle').click();
    await page.waitForTimeout(400);
    assert.equal(await rootRow('CustomNotebook/Physics').getAttribute('aria-expanded'), 'true');
    await rootRow('CustomNotebook/Physics').click({ button: 'right' });
    await page.locator('.note-notebook-colors button[data-color="blue"]').click();
    await rootRow('').locator('.note-tree-label').click();
    assert.equal(await rootRow('').getAttribute('aria-expanded'), 'false', 'default notebook selection also preserves expansion');
    await rootRow('').locator('.note-tree-toggle').click();
    assert.equal(await rootRow('').getAttribute('aria-expanded'), 'true');
    await rootRow('').press('ArrowLeft');
    await rootRow('CustomNotebook/Physics').locator('.note-tree-label').click();
    await flush();
    assert.equal(settings().colors['CustomNotebook/Physics'], 'blue');
    await screenshot('notebooks-light');
    for (const theme of ['light', 'dark']) for (const background of ['plain', 'scenic']) {
      await page.evaluate(({ theme, background }) => { document.body.dataset.startTheme = theme; document.body.dataset.startBackground = background; }, { theme, background: background === 'plain' ? 'simple' : background });
      await checkRowsAndBoundary();
    }
    await screenshot('notebooks-dark');
    await page.evaluate(() => { document.body.dataset.startTheme = 'light'; document.body.dataset.startBackground = 'simple'; });
    await rootRow('').click({ button: 'right' });
    assert.equal(await page.locator('[data-role="note-context-menu"]').isVisible(), false, 'default notes has no delete menu');

    await clickNotebookBlank('right');
    await blankMenu.locator('button').first().click();
    await rootRow('CustomNotebook/Untitled1').waitFor();
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), 'CustomNotebook/Untitled1');
    assert.equal(await page.locator('.note-modal-card').count(), 0, 'creation does not ask for a name');
    await page.locator('[data-note-action="new-notebook"]').click();
    await rootRow('CustomNotebook/Untitled2').waitFor();
    await rootRow('CustomNotebook/Untitled2').click({ button: 'right' });
    assert.equal(await blankMenu.locator('button').filter({ hasText: /^重命名$/ }).count(), 1);
    await page.locator('.note-notebook-colors button[data-color="purple"]').click(); await flush();
    await rootRow('CustomNotebook/Untitled2').locator('.note-tree-label').dblclick();
    const notebookRename = page.locator(`${right} .note-tree-rename`);
    await notebookRename.fill('New'); await notebookRename.press('Enter');
    await rootRow('CustomNotebook/New').waitFor();
    await flush(); assert.equal(settings().colors['CustomNotebook/New'], 'purple', 'double-click rename retains color');
    assert(fs.statSync(path.join(container, 'New')).isDirectory());
    assert.equal(await page.evaluate(() => CanvasNoteWorkspace.currentPath), 'CustomNotebook/Physics/Chapter/C.md');
    await page.locator('[data-note-action="new-folder"]').click();
    const rename = page.locator(`${left} .note-tree-rename`);
    await rename.waitFor(); await rename.fill('Folder'); await rename.press('Enter');
    await row(left, 'CustomNotebook/New/Folder').waitFor();
    await waitFor(() => fs.existsSync(path.join(container, 'New', 'Folder')), 'renamed folder not committed');
    assert(fs.statSync(path.join(container, 'New', 'Folder')).isDirectory());
    await page.locator('.note-tree-pane [data-note-action="new-note"]').click();
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath.startsWith('CustomNotebook/New/Folder/'));
    await page.locator('.note-inline-title').press('Escape');
    await page.locator('.cm-content').click();
    await page.keyboard.type('Notebook saved content');
    await page.evaluate(() => CanvasNoteWorkspace.flushSave());
    const createdPath = await page.evaluate(() => CanvasNoteWorkspace.currentPath);
    assert(fs.readFileSync(path.join(notes, createdPath), 'utf8').includes('Notebook saved content'));
    await rootRow('CustomNotebook/Physics').click();
    await flush();
    await page.reload();
    await page.waitForFunction(() => window.__notebooksTest?.state.initialized);
    assert.equal(await page.locator('.note-workspace.links-overlay-open').count(), 1, 'open state restores');
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), 'CustomNotebook/Physics', 'selected classification restores even with another notebook open');
    assert.equal(await page.evaluate(() => CanvasNoteWorkspace.currentPath), createdPath);
    assert.equal(await rootRow('CustomNotebook/Physics').locator('.note-notebook-icon').getAttribute('data-color'), 'blue');
    assert.equal(await page.locator('[data-note-action="side-history"]').count(), 0);
    await page.route('**/api/notes-tree?notebookSettings=1', async route => {
      const response = await route.fetch(); const payload = await response.json();
      payload.notebookSettings.ui.mode = 'history';
      await route.fulfill({ response, json: payload });
    }, { times: 1 });
    await page.reload();
    await page.waitForFunction(() => window.__notebooksTest?.state.initialized);
    assert.equal(await page.evaluate(() => __notebooksTest.state.sideMode), 'notebooks', 'legacy history preference falls back to notebooks');
    assert.equal(await page.locator('.note-side-modes button').count(), 2);

    await page.locator('[data-note-action="toggle-sort"]').click();
    await page.locator('#note-sort-menu [data-note-sort-mode="name-asc"]').click();
    await flush(); await sync();
    const writes = settingRequests;
    await page.evaluate(() => {
      window.__treeMutations = 0;
      const observer = new MutationObserver(records => { __treeMutations += records.length; });
      for (const host of document.querySelectorAll('[data-role="note-tree"], [data-role="note-notebook-tree"]')) observer.observe(host, { childList: true, subtree: true, attributes: true });
      window.__treeObserver = observer;
    });
    for (let i = 0; i < 3; i++) await sync();
    assert.equal(await page.evaluate(() => __treeMutations), 0, 'unchanged trees must not mutate DOM');
    assert.equal(settingRequests, writes, 'unchanged checks must not write settings');
    await page.evaluate(() => __treeObserver.disconnect());
    fs.mkdirSync(path.join(container, 'Added'));
    await sync(); assert((await notebookNames()).includes('Added'));
    fs.renameSync(path.join(container, 'Physics'), path.join(container, 'Renamed'));
    await sync(); await flush();
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), '');
    assert.equal(settings().colors['CustomNotebook/Physics'], undefined);
    assert.equal(await rootRow('CustomNotebook/Renamed').locator('.note-notebook-icon').getAttribute('data-color'), 'gray');

    await rootRow('CustomNotebook/New').click();
    await page.route('**/api/note-trash', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'simulated recycle failure' }) }));
    await rootRow('CustomNotebook/New').click({ button: 'right' });
    await page.locator('[data-role="note-context-menu"] button.danger').click();
    await rootRow('CustomNotebook/New').waitFor();
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), 'CustomNotebook/New');
    assert(fs.existsSync(path.join(container, 'New')), 'failed recycle preserves folder');
    await page.unroute('**/api/note-trash');
    await rootRow('CustomNotebook/New').click({ button: 'right' });
    await page.locator('.note-notebook-colors button[data-color="green"]').click(); await flush();
    await page.route('**/api/notes-tree*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'simulated read failure' }) }));
    await sync();
    assert((await notebookNames()).includes('New'), 'read failures preserve notebook tree');
    assert.equal(settings().colors['CustomNotebook/New'], 'green', 'read failure must not prune colors');
    await page.unroute('**/api/notes-tree*');
    fs.renameSync(path.join(container, 'New'), path.join(dataRoot, 'removed-notebook'));
    await sync(); await flush();
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), '');
    assert.equal(await row(left, 'Root.md').count(), 1);
    assert.equal(await page.evaluate(() => __notebooksTest.state.tabs.some(path => path.startsWith('CustomNotebook/New/'))), false);
    assert(!fs.existsSync(path.join(container, 'New')), 'autosave cannot recreate externally removed notebook');
    assert.equal(settings().colors['CustomNotebook/New'], undefined);
    fs.renameSync(container, path.join(dataRoot, 'removed-container'));
    await sync(); await flush();
    assert.deepEqual(await notebookNames(), ['notes']);
    assert(!fs.existsSync(container), 'ordinary refresh cannot recreate container');
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; document.body.dataset.startBackground = 'scenic'; });
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    assert.equal(await page.locator('[data-note-action="side-notebooks"]').textContent(), 'Notebooks');
    await clickNotebookBlank(); await page.waitForFunction(() => __notebooksTest.state.notebookRoot === null);
    assert.equal(await page.locator('.note-tree-pane [data-note-action="new-note"]').getAttribute('data-ui-tooltip'), 'Select a notebook first');
    assert.equal(await page.locator('.note-tree-pane [data-note-action="new-note"]').evaluate(el => getComputedStyle(el).cursor), 'default');
    await rootRow('').click();
    await page.setViewportSize({ width: 680, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.note-workspace').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    assert.equal(await page.locator('.note-links-pane').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    if (await page.locator('[data-note-action="close-all-tabs"]').isEnabled()) await page.locator('[data-note-action="close-all-tabs"]').click();
    await page.locator('.note-empty-state').waitFor();
    assert.equal(await page.locator('.note-links-pane').evaluate(el => getComputedStyle(el).position), 'absolute');
    await screenshot('notebooks-narrow');
    await page.locator('[data-note-action="side-links"]').click();
    await checkSideTools('links'); await checkSettingsPopover();
    assert.equal(await page.locator('[data-role="note-links-content"]').isVisible(), true);
    await page.locator('[data-note-action="side-notebooks"]').click();
    await checkSideTools('notebooks'); await checkSettingsPopover();
    const narrowOpenToolPositions = await toolPositions();
    const narrowOpenEmptyPositions = await emptyPositions();
    await page.locator('[data-note-action="close-links"]').click();
    assert.deepEqual(await toolPositions(), narrowOpenToolPositions, 'narrow toolbar stays fixed when overlay closes');
    assert.deepEqual(await emptyPositions(), narrowOpenEmptyPositions, 'narrow empty prompt stays fixed when overlay closes');
    await flush(); assert.equal(settings().ui.open, false);
    await page.locator('[data-note-action="toggle-notebooks"]').click();
    assert.deepEqual(await emptyPositions(), narrowOpenEmptyPositions, 'narrow empty prompt stays fixed when overlay opens');
    await page.locator('[data-note-action="close-links"]').click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await toggleAndCheckAnimation();
    await page.evaluate(() => {
      const toggle = document.querySelector('[data-note-action="toggle-notebooks"]');
      toggle.click(); requestAnimationFrame(() => { toggle.click(); requestAnimationFrame(() => toggle.click()); });
    });
    await settleSide();
    assert.equal(await page.locator('.note-workspace.links-overlay-open').count(), 0, 'narrow overlay reversals settle at the last intent');
    assert.deepEqual(await emptyPositions(), narrowOpenEmptyPositions);
    await toggleAndCheckAnimation();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('button[data-start-workspace="canvas"]').click();
    const inactiveRequests = treeRequests;
    await delay(2300); assert.equal(treeRequests, inactiveRequests, 'inactive workspace must stop directory checks');
    assert.equal(settings().ui.open, true, 'workspace switch preserves panel state');
    assert.deepEqual(errors, []);
    console.log('note notebooks browser: ok');
  } finally {
    if (browser) await browser.close();
    server.kill();
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
    assert.equal(path.dirname(path.resolve(dataRoot)), path.resolve(os.tmpdir()));
    assert(path.basename(dataRoot).startsWith('relatum-notebooks-'));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
