'use strict';
// Real shells/APIs with synthetic notes and a disposable data root/profile.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-theme-artifacts-'));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function run(browser, minimal) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-theme-data-'));
  fs.mkdirSync(path.join(data, 'notes')); fs.mkdirSync(path.join(data, 'data'));
  const source = '# A quiet place to think · 安静思考\n\n## Typography 字体\n\nEnglish **bold** and *italic*. 中文正文保持黑体，数学 $x^2 + y^2 = 1$。\n\n[An ordinary link](https://example.com)\n\n- [ ] Read a little\n- Plain list item\n\n> A small quotation 引用。\n\n| Item | Value |\n| --- | --- |\n| Alpha | 中文 |\n\n```js\nconst answer = 42;\n```\n\n```quiz\n哪个数是偶数？\n- [ ] 3\n- [x] 4\n---\n4 可以被 2 整除。\n```\n\n' + Array.from({ length: 50 }, (_, i) => 'Paragraph ' + i + '. Long-form reading keeps its place. 这是一段用于验证主题切换和阅读位置的测试文字。\n\n').join('');
  const file = path.join(data, 'notes/Main.md'); fs.writeFileSync(file, source);
  fs.writeFileSync(path.join(data, 'notes/Diagram.md'), '# Diagram\n\n```mermaid\ngraph LR\n A[English] --> B[中文]\n```\n');
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json')));
  const profile = minimal ? ['--launch-profile', JSON.stringify({ version: 1, features: Object.fromEntries(catalog.features.map(f => [f.id, f.id === 'notes'])) })] : [];
  const number = await port(), url = 'http://127.0.0.1:' + number;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(number), ...profile], { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; server.stdout.on('data', c => { logs += c; }); server.stderr.on('data', c => { logs += c; });
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' });
  try {
    let ready = false;
    for (let i = 0; i < 160; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, logs);
    const page = await context.newPage(), errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(r.url()));
    page.setDefaultTimeout(15000);
    const workspace = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {', '  window.T = {state, openNote, setViewMode, setNoteSettingsOpen, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: workspace }));
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('theme-test-seeded')) {
        sessionStorage.setItem('theme-test-seeded', '1');
        localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteFocusMode:v1', '0');
        localStorage.setItem('canvas:noteActivePath:v1', 'Main.md'); localStorage.setItem('canvas:noteOpenTabs:v1', '["Main.md"]');
        localStorage.setItem('canvas:noteTheme:v1', 'unknown-old-theme');
      }
    });
    const loaded = () => page.waitForFunction(() => window.T?.state.active && T.state.current?.path === 'Main.md' && !T.state.openingPath);
    await page.goto(url); await loaded();
    assert.equal(await page.evaluate(() => RelatumNoteTheme.read()), 'default');
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTheme:v1')), 'unknown-old-theme');
    assert(!requests.some(u => /source-serif-4/.test(u)), 'default keeps new fonts cold');
    const dialog = page.locator('#note-settings-dialog'), trigger = dialog.locator('.note-settings-theme .review-choice-trigger');
    const open = async () => { await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'appearance' })); await dialog.waitFor(); };
    const choose = async name => { await trigger.click(); await dialog.getByRole('option', { name, exact: true }).click(); };
    await page.evaluate(() => {
      window.originalView = T.editor.view; window.originalDoc = T.editor.view.state.doc;
      window.originalSelection = T.editor.view.state.selection;
      window.originalGeneration = T.state.editGeneration;
      window.originalChrome = getComputedStyle(document.querySelector('.top-bar')).backgroundColor;
    });
    await open();
    await choose('Claude');
    await page.waitForFunction(() => document.fonts.check('400 16px "Relatum Source Serif 4"'));
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTheme:v1')), 'claude');
    assert(await page.evaluate(() => T.editor.view === originalView && T.editor.view.state.doc === originalDoc && T.editor.view.state.selection === originalSelection && T.state.editGeneration === originalGeneration));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.top-bar')).backgroundColor), 'rgb(250, 249, 245)');
    assert.equal(await page.evaluate(() => {
      const workspace = document.body.dataset.startWorkspace;
      document.body.dataset.startWorkspace = 'canvas';
      const color = getComputedStyle(document.querySelector('.top-bar')).backgroundColor;
      document.body.dataset.startWorkspace = workspace;
      return color;
    }), await page.evaluate(() => originalChrome), 'shared chrome only follows the note theme while Notes is active');
    assert(await page.locator('.note-live-editor-host .cm-editor').evaluate(n => getComputedStyle(n).fontFamily.includes('Relatum Source Serif 4')));
    await pause(500);
    const idle = await page.evaluate(async () => {
      let frames = 0; const original = window.requestAnimationFrame;
      window.requestAnimationFrame = callback => { frames++; return original(callback); };
      try { await new Promise(resolve => setTimeout(resolve, 500)); return frames; }
      finally { window.requestAnimationFrame = original; }
    });
    assert.equal(idle, 0, 'Claude settings introduce no idle RAF loop');
    await trigger.click(); await page.keyboard.press('Escape'); assert(await dialog.isVisible());
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await trigger.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => RelatumNoteTheme.read()), 'default');
    await choose('Claude');
    await dialog.locator('[data-settings-search]').fill('Claude');
    await dialog.locator('.relatum-settings-result').first().click();
    assert(await trigger.evaluate(n => n === document.activeElement), 'search focuses enhanced trigger');
    // Category changes and language refresh close the shared dropdown.
    await trigger.click(); await dialog.locator('nav [data-settings-category="editing"]').click();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await dialog.locator('nav [data-settings-category="appearance"]').click();
    await trigger.click();
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    // Failure must revert the visible selection and preserve the active skin.
    await page.evaluate(() => { window.oldSet = Storage.prototype.setItem; Storage.prototype.setItem = function(k, v) { if (k === 'canvas:noteTheme:v1') throw Error('test quota'); return oldSet.call(this, k, v); }; });
    await choose('Default');
    assert.equal(await page.evaluate(() => RelatumNoteTheme.read()), 'claude');
    assert((await dialog.locator('[data-settings-status]').textContent()).match(/失败|Could not/));
    await page.evaluate(() => { Storage.prototype.setItem = oldSet; });
    await trigger.click();
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await dialog.locator('.note-theme-popovers .review-choice-popup').count(), 0);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await open();
    await dialog.locator('[data-settings-action="close"]').click(); await dialog.waitFor({ state: 'hidden' });
    // 48 combinations cover skins, mode, background, viewport and user font scale.
    const matrix = [];
    for (const skin of ['default', 'claude']) for (const mode of ['light', 'dark']) for (const bg of ['simple', 'scenic']) for (const width of [1440, 650]) for (const scale of [80, 100, 140]) {
      await page.setViewportSize({ width, height: 980 });
      const result = await page.evaluate(({ skin, mode, bg, scale }) => {
        RelatumNoteTheme.apply(skin); document.body.dataset.startTheme = mode; document.body.dataset.startBackground = bg;
        RelatumNotePreferences.applyFontScale(scale, false);
        const root = document.querySelector('.note-workspace'), pane = document.querySelector('.note-document-body');
        const style = getComputedStyle(pane), text = getComputedStyle(document.querySelector('.cm-editor'));
        return { bg: style.backgroundColor, color: text.color, overflow: pane.getBoundingClientRect().right > root.getBoundingClientRect().right + 2, font: text.fontFamily };
      }, { skin, mode, bg, scale });
      assert(!result.overflow, JSON.stringify({ skin, mode, bg, width, scale, result }));
      if (skin === 'claude' && bg === 'simple') {
        const expected = mode === 'light' ? 'rgb(250, 249, 245)' : 'rgb(25, 25, 25)';
        assert.equal(result.bg, expected);
        if (mode === 'dark') assert(await page.evaluate(expected =>
          ['.note-tree-pane', '.top-bar', '.note-links-pane'].every(selector =>
            getComputedStyle(document.querySelector(selector)).backgroundColor === expected), expected), 'dark chrome and document use one black');
      }
      matrix.push({ skin, mode, bg, width, scale, ...result });
    }
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.evaluate(() => { RelatumI18n.setLanguage('zh-CN'); RelatumNoteTheme.apply('claude'); RelatumNotePreferences.applyFontScale(100, false); document.body.dataset.startBackground = 'simple'; });
    for (const mode of ['light', 'dark']) {
      await page.evaluate(mode => { document.body.dataset.startTheme = mode; T.setViewMode('reading', false); }, mode);
      await pause(250);
      await page.locator('[data-role="note-reading-view"]').evaluate(n => { n.scrollTop = 0; });
      await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-${mode}-reading.png`) });
      const reading = await page.locator('.note-reading-content').evaluate(n => ({ font: getComputedStyle(n).fontFamily, rule: getComputedStyle(n.querySelector('h1')).borderBottomColor }));
      assert(reading.font.includes('Relatum Source Serif 4')); assert.equal(reading.rule, 'rgba(0, 0, 0, 0)');
      // Preserve a paragraph's screen position across a font change.
      const delta = await page.evaluate(async () => {
        const scroller = document.querySelector('[data-role="note-reading-view"]'); scroller.scrollTop = 700;
        const paragraph = Array.from(scroller.querySelectorAll('p')).find(n => n.getBoundingClientRect().top > scroller.getBoundingClientRect().top);
        const top = paragraph.getBoundingClientRect().top; RelatumNoteTheme.apply('default');
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return Math.abs(paragraph.getBoundingClientRect().top - top);
      });
      assert(delta < 3, 'reading anchor moves by ' + delta);
      await page.evaluate(() => RelatumNoteTheme.apply('claude')); await open();
      await trigger.click(); await pause(160);
      await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-${mode}-settings.png`) });
      const popup = dialog.locator('.note-theme-popovers .review-choice-popup');
      const box = await popup.boundingBox(); assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1441);
      await page.keyboard.press('Escape'); await dialog.locator('[data-settings-action="close"]').click(); await dialog.waitFor({ state: 'hidden' });
    }
    await page.evaluate(() => T.setViewMode('source', false));
    assert(!(await page.locator('.cm-editor').evaluate(n => getComputedStyle(n).fontFamily)).includes('Source Serif'));
    await page.reload(); await loaded(); assert.equal(await page.evaluate(() => RelatumNoteTheme.read()), 'claude');
    const coloring = await page.evaluate(async () => {
      const response = await fetch('/api/note-file-colors/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'Main.md', color: 'red' }) });
      const result = await response.json(); RelatumNoteExtensions.set('file-colors', { enabled: true }); return result.color;
    });
    assert.equal(coloring, 'red');
    const coloredRow = page.locator('[data-role="note-tree"] .note-tree-row[data-note-path="Main.md"][data-file-color="red"]');
    await coloredRow.waitFor();
    const color = await coloredRow.evaluate(n => getComputedStyle(n).backgroundColor);
    await page.evaluate(() => RelatumNoteTheme.apply('default'));
    assert.equal(await coloredRow.evaluate(n => getComputedStyle(n).backgroundColor), color, 'theme does not override file colors');
    await page.evaluate(() => RelatumNoteTheme.apply('claude'));
    if (!minimal) {
      await page.evaluate(async () => { await T.openNote('Diagram.md'); T.setViewMode('reading', false); });
      await page.locator('.note-reading-content .note-mermaid-stage > svg').waitFor();
      const stable = await page.evaluate(async () => {
        const svg = document.querySelector('.note-reading-content .note-mermaid-stage > svg');
        const family = getComputedStyle(svg.closest('.mermaid-diagram')).fontFamily;
        RelatumNoteTheme.apply('default'); RelatumNoteTheme.apply('claude');
        await new Promise(r => setTimeout(r, 200));
        return svg.isConnected && !family.includes('Source Serif');
      });
      assert(stable, 'theme changes retain the diagram and worker-compatible font');
      await page.evaluate(() => T.openNote('Main.md')); await loaded();
    }
    await open(); await dialog.locator('[data-settings-action="reset-category"]').click(); await dialog.locator('[data-settings-action="accept-reset"]').click();
    assert.equal(await page.evaluate(() => RelatumNoteTheme.read()), 'default'); assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTheme:v1')), null);
    await choose('Claude'); await dialog.locator('[data-settings-action="reset-all"]').click(); await dialog.locator('[data-settings-action="accept-reset"]').click();
    await page.waitForFunction(() => RelatumNoteTheme.read() === 'default');
    assert.equal(fs.readFileSync(file, 'utf8'), source, 'theme changes never save note content');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(artifacts, `${minimal ? 'minimal' : 'full'}-matrix.json`), JSON.stringify(matrix, null, 2));
    console.log((minimal ? 'minimal' : 'full') + ': passed');
  } finally { await context.close(); server.kill(); await new Promise(r => server.exitCode !== null ? r() : server.once('exit', r)); }
}
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.RELATUM_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try { await run(browser, false); await run(browser, true); console.log('Artifacts: ' + artifacts); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); console.error('Artifacts: ' + artifacts); process.exitCode = 1; });
