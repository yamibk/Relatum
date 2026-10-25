'use strict';
// Production shells and APIs, with disposable notes, browser profiles and screenshots.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifacts = process.env.RELATUM_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-settings-artifacts-'));
fs.mkdirSync(artifacts, { recursive: true });
async function port() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
async function checkMotion(page, mode) {
  const report = [];
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => !RelatumNoteSystem.motion.matches);
  for (const [theme, width] of [['light', 1440], ['dark', 560]]) {
    await page.setViewportSize({ width, height: 980 });
    await page.evaluate(theme => { document.body.dataset.startTheme = theme; }, theme);
    await pause(220);
    const changes = await page.evaluate(() => {
      const dialog = document.querySelector('[data-role="note-settings-dialog"]');
      const nav = id => dialog.querySelector('nav [data-settings-category="' + id + '"]');
      nav('editing').click();
      const panel = dialog.querySelector('.relatum-settings-page[data-settings-category="editing"]');
      const entry = panel.getAnimations()[0];
      const duration = entry?.effect.getTiming().duration;
      if (entry) entry.currentTime = 60;
      const intermediate = Number(getComputedStyle(panel).opacity);
      nav('editing').click(); const sameCategory = panel.getAnimations().length;
      for (let i = 0; i < 30; i++) nav(i % 2 ? 'appearance' : 'guide').click();
      const running = dialog.getAnimations({ subtree: true }).filter(animation => animation.constructor.name === 'Animation').length;
      return { duration, intermediate, sameCategory, running, visible: dialog.querySelectorAll('.relatum-settings-page:not([hidden])').length };
    });
    assert.equal(changes.duration, 160); assert(changes.intermediate > .45 && changes.intermediate < 1);
    assert.equal(changes.sameCategory, 0, 'same category does not replay an animation');
    assert(changes.running <= 2, 'rapid category changes only retain the current content and title'); assert.equal(changes.visible, 1);
    const geometry = await page.evaluate(() => {
      const dialog = document.querySelector('dialog.relatum-settings');
      dialog.querySelector('nav [data-settings-category="appearance"]').click();
      const input = dialog.querySelector('[data-role="note-font-scale"]'), panel = input.closest('[data-settings-category]');
      let transform = '';
      input.addEventListener('pointerdown', () => { transform = getComputedStyle(panel).transform; }, { once: true });
      input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      return transform;
    });
    assert.equal(geometry, 'none', 'the target receives pointerdown only after content geometry settles');
    const search = await page.evaluate(() => {
      const dialog = document.querySelector('dialog.relatum-settings'), input = dialog.querySelector('[data-settings-search]'), results = dialog.querySelector('.relatum-settings-results');
      input.focus(); input.value = 'mer'; input.dispatchEvent(new Event('input', { bubbles: true }));
      const first = results.getAnimations().length;
      input.value = 'mermaid'; input.dispatchEvent(new Event('input', { bubbles: true }));
      const continued = results.getAnimations().length;
      const focused = document.activeElement === input;
      input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
      return { first, continued, focused };
    });
    assert.equal(search.first, 1); assert.equal(search.continued, 0, 'typing does not repeatedly fade results'); assert(search.focused);
    const confirmation = await page.evaluate(() => {
      const dialog = document.querySelector('dialog.relatum-settings'), confirm = dialog.querySelector('.relatum-settings-confirm');
      const reset = dialog.querySelector('[data-settings-action="reset-category"]'); reset.click();
      confirm.getAnimations()[0].currentTime = 50;
      const before = Number(getComputedStyle(confirm).opacity);
      dialog.querySelector('[data-settings-action="cancel-reset"]').click();
      const disabled = confirm.inert;
      reset.click();
      const after = Number(getComputedStyle(confirm).opacity);
      return { before, after, disabled, focus: document.activeElement.dataset.settingsAction };
    });
    assert(confirmation.disabled, 'closing confirmation is inert immediately');
    assert(Math.abs(confirmation.before - confirmation.after) < .03, 'reversing a confirmation preserves its current opacity');
    assert.equal(confirmation.focus, 'cancel-reset');
    await page.keyboard.press('Escape'); await pause(240);
    assert(await page.locator('.relatum-settings-confirm').isHidden());
    await page.evaluate(() => {
      const nav = document.querySelector('nav [data-settings-category="shortcuts"]'); nav.click();
      document.querySelector('[data-note-shortcut-action="record"]').click();
    });
    await pause(250);
    assert.equal(await page.locator('.note-shortcut-add.is-recording').evaluate(el => el.getAnimations().length), 0, 'recording has no recurring pulse');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(artifacts, mode + '-motion-' + theme + '-' + width + '.png') });
    report.push({ theme, width, ...changes, search, confirmation });
  }
  await page.evaluate(() => {
    const dialog = document.querySelector('dialog.relatum-settings');
    dialog.querySelector('nav [data-settings-category="guide"]').click();
    dialog.querySelector('[data-settings-action="reset-category"]').click();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => RelatumNoteSystem.motion.matches);
  assert.equal(await page.locator('dialog.relatum-settings').evaluate(el => el.getAnimations({ subtree: true }).length), 0, 'switching to reduced motion finishes all active effects');
  await page.keyboard.press('Escape'); assert(await page.locator('.relatum-settings-confirm').isHidden());
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => !RelatumNoteSystem.motion.matches);
  const reversed = await page.evaluate(() => {
    const dialog = document.querySelector('dialog.relatum-settings');
    T.setNoteSettingsOpen(false); dialog.getAnimations()[0].currentTime = 60;
    const before = Number(getComputedStyle(dialog).opacity); T.setNoteSettingsOpen(true);
    return { before, after: Number(getComputedStyle(dialog).opacity) };
  });
  assert(Math.abs(reversed.before - reversed.after) < .03, 'dialog reopen continues from the visible closing state');
  const rootGeometry = await page.evaluate(() => {
    const dialog = document.querySelector('dialog.relatum-settings');
    dialog.querySelector('nav [data-settings-category="appearance"]').click();
    dialog.querySelector('[data-role="note-font-scale"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const transform = getComputedStyle(dialog).transform;
    dialog.querySelector('nav [data-settings-category="guide"]').click();
    return transform;
  });
  assert.equal(rootGeometry, 'none', 'form interaction also settles an opening dialog before anchor measurement');
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  assert.equal(await page.locator('dialog.relatum-settings').evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.constructor.name === 'Animation').length), 0, 'resize settles transient transforms');
  await page.evaluate(() => {
    T.setNoteSettingsOpen(false); document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility'));
  });
  assert(await page.locator('dialog.relatum-settings').isHidden(), 'minimize completes an in-progress close');
  await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new Event('canvasdesktop:visibility')); T.setNoteSettingsOpen(true); });
  await pause(250);
  const fallback = await page.evaluate(() => {
    const original = Element.prototype.animate;
    try {
      Element.prototype.animate = undefined;
      const dialog = document.querySelector('dialog.relatum-settings');
      dialog.querySelector('nav [data-settings-category="appearance"]').click();
      dialog.querySelector('[data-settings-action="reset-category"]').click();
      dialog.querySelector('[data-settings-action="cancel-reset"]').click();
      T.setNoteSettingsOpen(false);
      const hidden = dialog.hidden; T.setNoteSettingsOpen(true);
      return hidden && dialog.matches(':modal') && !dialog.querySelector('.relatum-settings-main').inert;
    } finally { Element.prototype.animate = original; }
  });
  assert(fallback, 'missing animation API keeps the settings usable');
  // Measure only after pending editor/layout work settles; compositor motion requires no JS RAF loop.
  await pause(350);
  const idle = await page.evaluate(async () => {
    const original = window.requestAnimationFrame; let calls = 0;
    window.requestAnimationFrame = callback => { calls++; return original.call(window, callback); };
    try { await new Promise(resolve => setTimeout(resolve, 500)); return { calls, animations: document.querySelector('dialog.relatum-settings').getAnimations({ subtree: true }).length }; }
    finally { window.requestAnimationFrame = original; }
  });
  assert.equal(idle.calls, 0, 'idle settings schedule no animation frames'); assert.equal(idle.animations, 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.evaluate(() => { document.body.dataset.startTheme = 'light'; document.querySelector('nav [data-settings-category="appearance"]').click(); });
  fs.writeFileSync(path.join(artifacts, mode + '-motion.json'), JSON.stringify({ report, reversed, fallback, idle }, null, 2));
}
async function run(browser, mode) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-settings-data-'));
  fs.mkdirSync(path.join(data, 'notes'), { recursive: true }); fs.mkdirSync(path.join(data, 'data'));
  const note = '# Settings fixture\n\n文字 文字\n\n' + Array.from({ length: 70 }, (_, i) => 'Paragraph ' + i + ' with text.\n').join('\n');
  fs.writeFileSync(path.join(data, 'notes/Main.md'), note);
  fs.writeFileSync(path.join(data, 'data/note-notebooks.json'), JSON.stringify({ version: 1, colors: {}, ui: { open: true, mode: 'guide', selectedRoot: '', expanded: [] } }));
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json')));
  const enabled = ['notes', ...(!['no-graph', 'minimal'].includes(mode) ? ['notes.graph'] : []), ...(!['no-canvas', 'minimal'].includes(mode) ? ['notes.canvas'] : []), ...(!['no-mermaid', 'minimal'].includes(mode) ? ['notes.mermaid'] : [])];
  const profile = mode === 'full' ? [] : ['--launch-profile', JSON.stringify({ version: 1, features: Object.fromEntries(catalog.features.map(f => [f.id, enabled.includes(f.id)])) })];
  const number = await port(), url = 'http://127.0.0.1:' + number;
  let logs = '';
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(number), ...profile], { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' });
  let page;
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, logs);
    page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = [], requests = []; page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request.url()));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {', '  window.T = {state, openNote, setViewMode, setSideMode, setSideOpen, setNoteSettingsOpen, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => { localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteFocusMode:v1', '0'); localStorage.setItem('canvas:noteActivePath:v1', 'Main.md'); localStorage.setItem('canvas:noteOpenTabs:v1', '["Main.md"]'); });
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.active && T.state.current?.path === 'Main.md' && !T.state.openingPath);
    await page.locator('[data-role="note-guide"] .note-guide-example').first().waitFor();
    assert(!requests.some(url => /note-mermaid|vendor\/pele|vendor\/mathjax/.test(url)), 'Callout guide keeps heavy runtimes cold');
    const dialog = page.locator('[data-role="note-settings-dialog"]'), button = page.locator('[data-note-action="toggle-settings"]');
    const category = id => dialog.locator('nav [data-settings-category="' + id + '"]');
    const close = async () => { await dialog.locator('[data-settings-action="close"]').click(); await dialog.waitFor({ state: 'hidden' }); };
    if (mode === 'full') {
      // Hold the input handoff deterministically; no test changes reach production code.
      await page.evaluate(() => {
        const editor = T.editor, descriptor = Object.getOwnPropertyDescriptor(editor, 'inputPending'), settled = editor.whenInputSettled;
        const waiting = new Promise(resolve => { window.releaseSettingsInput = () => { Object.defineProperty(editor, 'inputPending', descriptor); editor.whenInputSettled = settled; resolve(true); }; });
        Object.defineProperty(editor, 'inputPending', { configurable: true, get: () => true }); editor.whenInputSettled = () => waiting;
      });
      await button.click(); assert(await dialog.isHidden(), 'settings wait for input handoff');
      await page.evaluate(() => { T.setSideOpen(false); releaseSettingsInput(); delete window.releaseSettingsInput; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert(await dialog.isHidden(), 'a canceled input handoff cannot reopen settings');
      await page.evaluate(() => T.setSideOpen(true));
    }
    await page.evaluate(() => { window.savedView = T.editor.view; window.savedDoc = T.editor.view.state.doc; window.savedGeneration = T.state.editGeneration; });
    await button.click(); await dialog.waitFor();
    assert(await dialog.evaluate(node => node.matches(':modal') && !node.closest('.start-workspace-stage')), 'dialog uses the top layer outside workspace transforms');
    const categoryCount = 7 + Number(enabled.includes('notes.graph') || mode === 'full')
      + Number(enabled.includes('notes.canvas') || mode === 'full') + (mode === 'full' ? 2 : 0);
    assert.equal(await dialog.locator('nav button').count(), categoryCount);
    assert.equal(await button.locator('use').getAttribute('href'), '#note-icon-settings');
    if (process.argv.includes('--motion')) await checkMotion(page, mode);
    await page.keyboard.press('Control+t'); assert.equal(await page.evaluate(() => T.state.tabs.length), 1, 'modal blocks workspace shortcuts');
    await page.keyboard.press('Shift+Tab'); assert(await page.evaluate(() => !!document.activeElement.closest('dialog')));
    await dialog.locator('[data-role="note-font-scale"]').fill('120'); await dialog.locator('[data-role="note-font-scale"]').dispatchEvent('input');
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteFontScale:v1')), '120');
    await category('editing').click(); await dialog.locator('[data-role="note-selection-match-highlight"]').check();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteSelectionMatchHighlight:v1')), '1');
    await category('files').click(); await dialog.locator('[data-note-name-mode="custom"]').click(); await dialog.locator('[data-role="note-library-name-input"]').fill('My note');
    assert((await dialog.locator('[data-role="note-library-name-preview"]').textContent()).includes('My note.md'));
    await dialog.locator('[data-role="note-library-name-input"]').dispatchEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229 });
    assert(await dialog.isVisible(), 'IME Escape does not dismiss settings');
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); assert(await dialog.isVisible(), 'ordinary blur preserves modal');
    assert(await dialog.locator('[data-role="note-library-name-input"]').isVisible(), 'blur does not hide the files category');
    await category('guide').click(); await dialog.locator('input[value="markdown"]').check();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteGuideTopic:v1')), 'markdown');
    await dialog.locator('[data-settings-search]').fill('mermaid'); await dialog.locator('.relatum-settings-result').first().click();
    assert.equal(await category('guide').getAttribute('aria-current'), 'page');
    await category('sidebar').click();
    const sidebarOrder = await dialog.locator('[data-sidebar-page]').evaluateAll(nodes => nodes.map(node => node.dataset.sidebarPage));
    await dialog.locator('[data-sidebar-page="notebooks"] .note-sidebar-grip').focus(); await page.keyboard.press('End');
    const storedSidebarOrder = await page.evaluate(() => JSON.parse(localStorage.getItem('canvas:noteSidebarPages:v1')).order);
    assert.equal(storedSidebarOrder.filter(id => sidebarOrder.includes(id)).at(-1), 'notebooks', 'shared list preserves note sidebar keyboard sorting within available slots');
    if (!sidebarOrder.includes('ai')) assert.equal(storedSidebarOrder.indexOf('ai'), 5, 'a disabled sidebar page keeps its original slot');
    const hiddenSidebar = dialog.locator('[data-sidebar-visible="links"]'); await hiddenSidebar.uncheck();
    assert((await page.evaluate(() => JSON.parse(localStorage.getItem('canvas:noteSidebarPages:v1')).hidden)).includes('links'));
    await dialog.locator('[data-settings-action="reset-category"]').click(); await dialog.locator('[data-settings-action="accept-reset"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteSidebarPages:v1')), null);
    assert.deepEqual(await dialog.locator('[data-sidebar-page]').evaluateAll(nodes => nodes.map(node => node.dataset.sidebarPage)), sidebarOrder);
    if (enabled.includes('notes.canvas') || mode === 'full') {
      await category('canvas').click();
      const width = dialog.locator('[data-canvas-default-fields] [data-field="width"] input');
      await width.fill('222'); await width.dispatchEvent('change');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('canvas:noteCanvasDefaults:v1')).node.width), 222);
      await dialog.locator('[data-default-target="edge"]').click(); await dialog.locator('[data-canvas-default-fields] [data-field="width"] input').fill('3');
      await dialog.locator('[data-canvas-default-fields] [data-field="width"] input').dispatchEvent('change');
    }
    await category('shortcuts').click();
    await dialog.locator('[data-note-shortcut-action="record"]').first().click(); await page.keyboard.press('Control+n');
    assert.equal(await page.evaluate(() => T.state.tabs.length), 1, 'shortcut recording cannot trigger new notes');
    assert(await page.evaluate(() => !!T.state.recordingShortcutCommand), 'conflicting shortcuts remain in recording mode');
    await page.keyboard.press('Escape'); assert(await dialog.isVisible(), 'Escape cancels recording before the dialog');
    await dialog.locator('[data-note-shortcut-action="record"]').first().click(); await page.keyboard.press('Alt+q');
    assert((await page.evaluate(() => localStorage.getItem('canvas:noteShortcuts:v1'))).includes('Alt-q'));
    await category('appearance').click();
    await dialog.locator('[data-settings-action="reset-category"]').click(); await page.keyboard.press('Escape');
    assert(await dialog.locator('.relatum-settings-confirm').isHidden());
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteFontScale:v1')), '120', 'Escape cancels reset without applying defaults');
    await dialog.locator('[data-settings-action="reset-category"]').click(); await dialog.locator('[data-settings-action="accept-reset"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteFontScale:v1')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteGuideTopic:v1')), 'markdown', 'category reset preserves other preferences');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.body.dataset.startTheme = theme; }, theme);
      await page.screenshot({ path: path.join(artifacts, mode + '-settings-' + theme + '.png') });
      const bounds = await dialog.boundingBox(); assert.equal(Math.round(bounds.width), 1200); assert.equal(Math.round(bounds.height), 820);
      assert(Math.abs(bounds.x + bounds.width / 2 - 720) < 2, 'dialog is horizontally centered');
    }
    await page.evaluate(() => RelatumI18n.setLanguage('en')); await category('guide').click();
    assert.equal(await category('files').textContent(), 'Files & library');
    assert((await dialog.locator('[data-settings-category="guide"].relatum-settings-page').textContent()).includes('Everyday formatting'));
    await page.setViewportSize({ width: 560, height: 780 });
    await page.screenshot({ path: path.join(artifacts, mode + '-settings-narrow-en.png') });
    assert(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await close();
    if (mode === 'full') {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.evaluate(() => { T.setNoteSettingsOpen(true); T.setNoteSettingsOpen(false); T.setNoteSettingsOpen(true); });
      await pause(240); assert(await dialog.evaluate(node => node.matches(':modal') && !node.inert), 'rapid reopen cancels the old close');
      for (let i = 0; i < 24; i++) { await page.keyboard.press('Tab'); assert(await page.evaluate(() => !!document.activeElement.closest('dialog')), 'focus stays inside settings'); }
      await page.mouse.click(1, 1); await dialog.waitFor({ state: 'hidden' });
      assert.equal(await button.evaluate(node => document.activeElement === node), true, 'backdrop dismissal restores its entry focus');
      await page.emulateMedia({ reducedMotion: 'reduce' });
    }
    assert(await page.evaluate(() => T.editor.view === savedView && T.editor.view.state.doc === savedDoc && T.state.editGeneration === savedGeneration), 'settings preserve the editor, document and edit generation');
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.locator('[data-role="note-guide"][data-guide-topic="markdown"] .note-guide-example').first().waitFor();
    const first = page.locator('[data-role="note-guide"] .note-guide-copy').first(); await first.click();
    assert((await page.evaluate(() => navigator.clipboard.readText())).startsWith('# '));
    const beforeLink = page.url(); await page.locator('[data-role="note-guide"] a').first().click(); assert.equal(page.url(), beforeLink, 'guide links do not navigate');
    await page.locator('[data-role="note-guide"]').evaluate(node => { node.scrollTop = 300; });
    await button.click(); await category('guide').click(); await dialog.locator('input[value="mermaid"]').check(); await close();
    if (enabled.includes('notes.mermaid') || mode === 'full') {
      await page.locator('[data-role="note-guide"] .mermaid-diagram svg').first().waitFor({ timeout: 25000 });
      for (const block of await page.locator('[data-role="note-guide"] .mermaid-diagram').all()) { await block.scrollIntoViewIfNeeded(); await block.locator('.note-mermaid-stage > svg').waitFor({ timeout: 25000 }); }
      assert.equal(await page.locator('[data-role="note-guide"] .note-mermaid-error').count(), 0, 'all eight Mermaid examples render');
      await page.screenshot({ path: path.join(artifacts, mode + '-guide-mermaid.png') });
      await page.evaluate(() => T.setSideOpen(false));
      assert.equal(await page.locator('[data-role="note-guide"]').evaluate(node => !!node.__noteMermaid), false, 'closing the guide releases its diagram owner and interactions');
      await page.evaluate(() => T.setSideOpen(true));
      await page.waitForFunction(() => !!document.querySelector('[data-role="note-guide"]').__noteMermaid);
      if (mode === 'full') {
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        assert.equal(await page.locator('[data-role="note-guide"]').evaluate(node => !!node.__noteMermaid), false, 'pagehide releases the guide owner');
        await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
        await page.waitForFunction(() => !!document.querySelector('[data-role="note-guide"]').__noteMermaid);
      }
      await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
      assert.equal(await page.locator('[data-role="note-guide"]').evaluate(node => !!node.__noteMermaid), false, 'minimization releases the guide diagram owner');
      await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
      await page.waitForFunction(() => !!document.querySelector('[data-role="note-guide"]').__noteMermaid);
    } else {
      assert.equal(await page.locator('[data-guide-mermaid-disabled]').count(), 1);
      assert(!requests.some(url => /note-mermaid|vendor\/pele/.test(url)), 'disabled Mermaid never requests its runtime');
    }
    await button.click(); await category('guide').click(); await dialog.locator('input[value="markdown"]').check(); await close();
    assert.equal(await page.locator('[data-role="note-guide"]').evaluate(node => node.scrollTop), 300, 'topic scroll restores');
    await page.locator('[data-note-action="toggle-library-settings"]').click(); assert.equal(await category('files').getAttribute('aria-current'), 'page'); await close();
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.T?.state.current?.path === 'Main.md' && T.state.active && !T.state.openingPath);
    await button.click(); await category('guide').click(); assert(await dialog.locator('input[value="markdown"]').isChecked(), 'topic preference survives reload');
    await dialog.locator('[data-settings-action="reset-all"]').click(); await dialog.locator('[data-settings-action="accept-reset"]').click();
    for (const key of ['canvas:noteGuideTopic:v1', 'canvas:noteCanvasDefaults:v1', 'canvas:noteSelectionMatchHighlight:v1', 'canvas:noteShortcuts:v1']) assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await dialog.waitFor({ state: 'hidden' }); await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    assert.equal(fs.readFileSync(path.join(data, 'notes/Main.md'), 'utf8'), note, 'settings never change Markdown');
    assert.deepEqual(errors, []);
    console.log(mode + ': settings, persistence, guide, lifecycle and screenshots passed');
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(artifacts, mode + '-failure.png') }).catch(() => {}); console.error(await page.evaluate(() => ({ ready: !!window.T, errors: document.body.innerText.slice(-1000) })).catch(() => ({}))); }
    throw error;
  } finally {
    await context.close(); server.kill(); await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 });
  }
}
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  try { for (const mode of process.argv.includes('--smoke') ? ['full'] : ['full', 'notes-only', 'no-graph', 'no-canvas', 'no-mermaid', 'minimal']) await run(browser, mode); }
  finally { await browser.close(); console.log('Artifacts: ' + artifacts); }
})().catch(error => { console.error(error); process.exitCode = 1; });
