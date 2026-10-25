'use strict';
// Real servers with disposable data. No packaged build or user library is touched.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'), 'utf8'));
const ids = catalog.workspaces.map(item => item.id), key = 'canvas:workspaceLayout:v1', pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-global-settings-'));
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
async function run(browser, mode) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-global-data-'));
  fs.mkdirSync(path.join(data, 'notes')); fs.writeFileSync(path.join(data, 'notes/Main.md'), '# Main\n\nOriginal text\n');
  const enabled = { notes: ['notes'], research: ['research'], career: ['career'], library: ['canvas', 'canvas.library'], mixed: ['notes', 'career'] }[mode];
  const choices = Object.fromEntries(catalog.features.map(item => [item.id, enabled ? enabled.includes(item.id) : mode === 'cold' || item.id !== 'runtime.preload']));
  const args = ['app.py', '--no-browser', '--port', String(await freePort()), '--launch-profile', JSON.stringify({ version: 1, features: choices })];
  const url = 'http://127.0.0.1:' + args[3];
  let logs = '';
  const server = spawn(process.env.RELATUM_PYTHON || 'python', args, { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(new URL(request.url()).pathname));
  const dialog = page.locator('#global-settings-dialog');
  const category = id => dialog.locator('nav [data-settings-category="' + id + '"]');
  const input = id => dialog.locator('[data-sidebar-visible="' + id + '"]');
  const layout = () => page.evaluate(() => RelatumStartWorkspace.layout);
  const current = () => page.evaluate(() => RelatumStartWorkspace.current);
  const check = async (id, checked) => { await input(id).setChecked(checked); await page.waitForFunction(id => !document.querySelector('#global-settings-dialog [data-sidebar-visible="' + id + '"]').disabled, id); };
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch(url + '/api/runtime')).ok) break; } catch (_) {} await pause(100); }
    await context.addInitScript(() => { localStorage.setItem('canvas:noteFocusMode:v1', '0'); localStorage.setItem('canvas:noteActivePath:v1', 'Main.md'); localStorage.setItem('canvas:noteOpenTabs:v1', '["Main.md"]'); });
    if (mode === 'cold') await context.addInitScript(({ ids, key }) => {
      localStorage.setItem(key, JSON.stringify({ order: ids, hidden: ids }));
      localStorage.setItem('canvas:startBackgroundStyle', 'scenic'); localStorage.setItem('canvas:noteGraphPreload:v1', '1');
      function firstFrame() {
        if (!document.body || !document.querySelector('.start-workspace-stage')) { requestAnimationFrame(firstFrame); return; }
        window.firstWorkspaceFrame = { name: document.documentElement.dataset.startWorkspace,
          stage: getComputedStyle(document.querySelector('.start-workspace-stage')).display, sky: getComputedStyle(document.querySelector('.start-sky')).display };
      }
      requestAnimationFrame(firstFrame);
    }, { ids, key });
    await page.goto(url); await page.waitForFunction(() => window.RelatumStartWorkspace && window.RelatumGlobalSettings);
    if (mode === 'cold') {
      await page.waitForFunction(() => window.firstWorkspaceFrame);
      assert.deepEqual(await page.evaluate(() => firstWorkspaceFrame), { name: 'none', stage: 'none', sky: 'none' }, 'the first rendered frame is already blank');
      await pause(1000);
      assert(!requests.some(url => /note-workspace|note-system|note-graph|career-report|research\.html|\/api\/(focus|daily)$/.test(url)), 'empty startup suppresses workspace preparation even with preloading enabled');
      await page.locator('[data-action="start-speed-toggle"]').click(); await category('workspaces').click();
      await page.route('**/note-workspace.js', route => route.abort());
      assert(await page.evaluate(ids => RelatumStartWorkspace.applyLayout({ order: ids, hidden: ids.filter(id => id !== 'notes') }), ids));
      assert.equal(await current(), 'none', 'a failed workspace with no usable fallback leaves a blank main area');
      await page.unroute('**/note-workspace.js');
      assert(await page.evaluate(() => RelatumStartWorkspace.set('notes'))); assert.equal(await current(), 'notes', 'failed loading can retry');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.evaluate(() => RelatumGlobalSettings.close({ instant: true }));
      await page.locator('[data-action="close-start-notice"]').click();
      await page.evaluate(ids => RelatumStartWorkspace.applyLayout({ order: ids, hidden: ['research', 'career'] }), ids);
      await page.evaluate(() => RelatumStartWorkspace.set('canvas'));
      await page.evaluate(() => RelatumStartWorkspace.applyLayout({ order: ['notes', 'canvas', 'research', 'career'], hidden: ['research', 'career'] }));
      await page.evaluate(() => RelatumStartWorkspace.set('notes'));
      assert(await page.locator('#start-notes-workspace').evaluate(node => node.classList.contains('workspace-back')), 'animation direction follows the new relative order');
      await page.evaluate(() => RelatumStartWorkspace.set('canvas'));
      assert(await page.locator('#start-canvas-workspace').evaluate(node => node.classList.contains('workspace-forward')));
      await page.locator('button[data-start-workspace="canvas"]').focus(); await page.keyboard.press('Home');
      await page.waitForFunction(() => RelatumStartWorkspace.current === 'notes');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.startWorkspace), 'notes', 'keyboard traversal follows order and keeps focus');
      await page.evaluate(ids => Promise.all([
        RelatumStartWorkspace.applyLayout({ order: ids.slice().reverse(), hidden: ids }),
        RelatumStartWorkspace.applyLayout({ order: ids, hidden: ids.filter(id => id !== 'canvas') }),
        RelatumStartWorkspace.applyLayout({ order: ids, hidden: ids }),
      ]), ids);
      assert.equal(await current(), 'none'); assert.deepEqual((await layout()).hidden, ids, 'queued edits commit in order');
      assert.deepEqual(errors, []);
      console.log('cold: first frame, hidden preloads, failed load/retry and queued changes passed');
      return;
    }
    const available = await page.evaluate(() => RelatumFeatureRuntime.workspaces.filter(item => RelatumFeatureRuntime.workspaceEnabled(item.id)).map(item => item.id));
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null, 'startup does not write layout defaults');
    await page.evaluate(() => RelatumGlobalSettings.open()); await dialog.waitFor();
    assert(await dialog.evaluate(node => node.matches(':modal') && !node.closest('.start-workspace-stage')));
    assert.deepEqual(await dialog.locator('nav button').evaluateAll(nodes => nodes.map(node => node.dataset.settingsCategory)), mode === 'full'
      ? ['appearance', 'workspaces', 'navigation', 'daily', 'learning', 'starmap', 'career', 'usage']
      : ['appearance', 'workspaces', ...(mode === 'library' ? ['navigation'] : []), ...(['career', 'mixed'].includes(mode) ? ['career'] : []), ...(mode === 'career' ? [] : ['usage'])]);
    const bounds = await dialog.boundingBox(); assert.equal(Math.round(bounds.width), 1200); assert.equal(Math.round(bounds.height), 820);
    await category('workspaces').click();
    assert.deepEqual(await dialog.locator('[data-sidebar-visible]').evaluateAll(nodes => nodes.map(node => node.dataset.sidebarVisible)), available);
    if (mode === 'full') {
      for (const id of ['appearance', 'navigation', 'learning', 'starmap', 'career', 'usage']) {
        await category(id).click(); await page.screenshot({ path: path.join(artifacts, 'category-' + id + '.png') });
      }
      await category('appearance').click();
      assert(await dialog.locator('.start-panel-theme .start-theme-toggle').evaluate(button => {
        const rect = button.getBoundingClientRect(), row = button.closest('.start-panel-theme').getBoundingClientRect();
        return rect.left >= row.left && rect.right <= row.right && rect.top >= row.top && rect.bottom <= row.bottom;
      }), 'the theme toggle stays inside its settings row');
      await dialog.locator('.start-panel-theme .start-theme-toggle').click();
      assert.equal(await page.evaluate(() => document.body.dataset.startTheme), 'dark');
      await dialog.locator('.start-panel-theme .start-theme-toggle').click();
      await category('navigation').click(); await dialog.locator('[data-role="library-search-toggle"]').check();
      await dialog.locator('[data-role="start-speed-range"]').fill('350'); await dialog.locator('[data-role="start-speed-range"]').dispatchEvent('input');
      await category('career').click(); await dialog.locator('[data-role="career-scroll-feel-range"][data-setting="strength"]').fill('150'); await dialog.locator('[data-role="career-scroll-feel-range"][data-setting="strength"]').dispatchEvent('input');
      await dialog.locator('[data-settings-action="reset-category"]').click(); await dialog.locator('[data-settings-action="accept-reset"]').click();
      assert.equal(await page.evaluate(() => localStorage.getItem('canvas:startTurnMs')), '350', 'category restore preserves another category');
      await dialog.locator('[data-settings-search]').fill('画布名称搜索'); await dialog.locator('.relatum-settings-result').first().click();
      assert.equal(await category('navigation').getAttribute('aria-current'), 'page');
      await category('workspaces').click();
      await dialog.locator('[data-sidebar-page="notes"] .note-sidebar-grip').focus(); await page.keyboard.press('End');
      await page.waitForFunction(() => RelatumStartWorkspace.layout.order.at(-1) === 'notes');
      assert.equal(await current(), 'canvas', 'reordering keeps the current workspace');
      const from = await dialog.locator('[data-sidebar-page="career"] .note-sidebar-grip').boundingBox();
      const to = await dialog.locator('[data-sidebar-page="canvas"]').boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
      await page.mouse.move(to.x + 30, to.y + 5, { steps: 12 }); await page.mouse.up();
      await page.waitForFunction(() => RelatumStartWorkspace.layout.order[0] === 'career');
      const beforeCancel = await layout();
      const grip = await dialog.locator('[data-sidebar-page="career"] .note-sidebar-grip').boundingBox();
      await page.mouse.move(grip.x + 8, grip.y + 8); await page.mouse.down(); await page.mouse.move(grip.x + 8, grip.y + 160, { steps: 8 });
      await page.keyboard.press('Escape'); await page.mouse.up(); assert.deepEqual(await layout(), beforeCancel, 'Escape cancels a real drag'); assert(await dialog.isVisible());
      await page.screenshot({ path: path.join(artifacts, 'workspaces-light.png') });
    }
    // Hide inactive items first, then the current workspace: no needless activations.
    if (mode === 'mixed') {
      await dialog.locator('[data-sidebar-page="career"] .note-sidebar-grip').focus(); await page.keyboard.press('Home');
      await page.waitForFunction(() => RelatumStartWorkspace.layout.order[1] === 'career');
      assert.deepEqual((await layout()).order, ['canvas', 'career', 'research', 'notes', 'daily'], 'unavailable workspaces retain their slots while available rows reorder');
    }
    const active = await current();
    for (const id of available.filter(id => id !== active)) await check(id, false);
    await check(active, false); assert.equal(await current(), 'none');
    assert(await dialog.isVisible(), 'settings survives its own workspace changes');
    await dialog.locator('[data-settings-action="close"]').click();
    assert.equal(await page.locator('.start-workspace-panel:visible').count(), 0);
    assert.equal(await page.locator('.start-sky:visible,.top-actions:visible,.desktop-settings-trigger:visible').count(), 0);
    assert(await page.locator('[data-action="start-speed-toggle"]').isVisible());
    await page.reload(); assert.equal(await current(), 'none', 'empty state survives reload');
    assert.equal(await page.locator('.start-workspace-panel:visible').count(), 0);
    await page.locator('[data-action="start-speed-toggle"]').click(); await category('workspaces').click();
    await check(available[0], true); assert.equal(await current(), available[0]);
    if (mode === 'full' || mode === 'notes' || mode === 'mixed') {
      if (available[0] !== 'notes') { await check('notes', true); await page.evaluate(() => RelatumStartWorkspace.set('notes')); }
      await page.waitForFunction(() => window.CanvasNoteWorkspace?.currentPath === 'Main.md');
      await page.evaluate(() => { window.originalDeactivate = CanvasNoteWorkspace.deactivate; CanvasNoteWorkspace.deactivate = async () => false; });
      const before = await layout(); await input('notes').click();
      await page.waitForFunction(() => !document.querySelector('#global-settings-dialog [data-sidebar-visible="notes"]').disabled);
      assert.equal(await current(), 'notes'); assert.deepEqual(await layout(), before); assert(await input('notes').isChecked(), 'a rejected handoff restores the checkbox');
      assert((await dialog.locator('[data-settings-status]').textContent()).length > 0);
      await page.evaluate(() => { CanvasNoteWorkspace.deactivate = originalDeactivate; });
      assert.equal(await page.evaluate(() => { const all = [...document.querySelectorAll('[id]')].map(node => node.id); return all.length - new Set(all).size; }), 0, 'note and global settings have unique IDs');
      // Commit text through the real editor, then leave through the settings checklist.
      await dialog.locator('[data-settings-action="close"]').click();
      await page.route('**/api/note-save', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"isolated save failure"}' }));
      await page.locator('.note-live-editor-host .cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\nSaved before hiding');
      await page.evaluate(() => RelatumGlobalSettings.open({ category: 'workspaces' }));
      await input('notes').click(); await page.waitForFunction(() => !document.querySelector('#global-settings-dialog [data-sidebar-visible="notes"]').disabled);
      assert.equal(await current(), 'notes'); assert(await input('notes').isChecked(), 'real save failure also restores visibility');
      assert(!fs.readFileSync(path.join(data, 'notes/Main.md'), 'utf8').includes('Saved before hiding'));
      await page.unroute('**/api/note-save');
      await check('notes', false); assert.notEqual(await current(), 'notes');
      assert(fs.readFileSync(path.join(data, 'notes/Main.md'), 'utf8').includes('Saved before hiding'), 'hiding flushes real note edits');
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.body.dataset.startTheme = document.documentElement.dataset.startTheme = theme; }, theme);
      await page.screenshot({ path: path.join(artifacts, mode + '-' + theme + '.png') });
    }
    await page.evaluate(() => RelatumI18n.setLanguage('en')); assert.equal(await category('workspaces').textContent(), 'Workspaces');
    await page.setViewportSize({ width: 560, height: 780 });
    assert(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await page.screenshot({ path: path.join(artifacts, mode + '-narrow.png') });
    await dialog.locator('[data-settings-search]').dispatchEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229 }); assert(await dialog.isVisible());
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => { RelatumGlobalSettings.close(); RelatumGlobalSettings.open(); RelatumGlobalSettings.close(); RelatumGlobalSettings.open(); });
    await pause(240); assert(await dialog.evaluate(node => node.matches(':modal') && !node.inert));
    await page.evaluate(() => { localStorage.setItem('canvas:noteFontScale:v1', '120'); localStorage.setItem('canvas:startTheme', 'dark'); });
    await dialog.locator('[data-settings-action="reset-all"]').click(); await dialog.locator('[data-settings-action="accept-reset"]').click();
    await page.waitForFunction(key => localStorage.getItem(key) === null, key);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteFontScale:v1')), '120');
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:startTheme')), 'dark');
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:toolbarLanguage')), 'en');
    assert.deepEqual((await layout()).hidden, ['daily'], 'reset keeps Daily hidden by default');
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    assert(await dialog.isHidden(), 'native minimization closes settings');
    await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    if (!choices.notes) assert(!requests.some(url => /note-workspace|note-live-editor|note-system|note-graph|vendor\/codemirror/.test(url)), 'global settings never loads disabled notes resources');
    if (mode === 'library') {
      await page.setViewportSize({ width: 1440, height: 980 }); await page.evaluate(() => RelatumGlobalSettings.open()); await pause(300);
      const calls = await page.evaluate(async () => { const original = window.requestAnimationFrame; let calls = 0; window.requestAnimationFrame = callback => { calls++; return original(callback); }; try { await new Promise(resolve => setTimeout(resolve, 500)); return calls; } finally { window.requestAnimationFrame = original; } });
      assert.equal(calls, 0, 'global settings adds no idle RAF loop');
    }
    assert.deepEqual(errors, []);
    console.log(mode + ': global settings, workspace handoff, persistence and lifecycle passed');
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, mode + '-failure.png') }).catch(() => {}); console.error({ mode, errors, logs: logs.slice(-2500) }); throw error;
  } finally {
    await context.close(); server.kill(); await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    // Only the freshly created absolute fixture directory is removed.
    assert(data.startsWith(path.join(os.tmpdir(), 'relatum-global-data-'))); fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 });
  }
}
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  try { for (const mode of process.argv.length > 2 ? process.argv.slice(2) : ['full', 'notes', 'research', 'career', 'library', 'mixed', 'cold']) await run(browser, mode); }
  finally { await browser.close(); console.log('Artifacts: ' + artifacts); }
})().catch(error => { console.error(error); process.exitCode = 1; });
