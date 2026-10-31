'use strict';

// Production workspace, real assets/API and native mouse gestures. Never opens
// a user library or launches an external image program.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const minimal = process.argv.includes('--notes-only');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-image-preview-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assets = path.join(root, 'notes', 'Image.assets', 'images');
fs.mkdirSync(assets, { recursive: true });
// A transparent 400x200 PNG, also used by the existing image-text regression.
fs.writeFileSync(path.join(assets, '透明 (1).png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAZAAAADICAYAAADGFbfiAAAACXBIWXMAAAsTAAALEwEAmpwYAAABWUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfgG7WgABM7mWAAAAAElFTkSuQmCC', 'base64'));
fs.writeFileSync(path.join(assets, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200"><rect width="600" height="200" rx="15" fill="#aac2a2"/><circle cx="300" cy="100" r="65" fill="#f5f2e6"/></svg>');
const source = '# Images\n\n![small|160](<Image.assets/images/透明 \\(1\\).png>)\n\n'
  + 'Inline ![inline|80](Image.assets/images/vector.svg) end\n\n'
  + '![[Image.assets/images/vector.svg|200]]\n\n'
  + '> [!note] Nested\n> ![nested|180](Image.assets/images/vector.svg)\n\nAfter\n';
fs.writeFileSync(path.join(root, 'notes', 'Image.md'), source);
fs.writeFileSync(path.join(root, 'notes', 'Other.md'), 'Other note');
fs.writeFileSync(path.join(root, 'notes', 'Scroll.md'), Array.from({ length: 35 }, (_, i) => `Paragraph ${i}\n\n`).join('')
  + '![scroll|180](Image.assets/images/vector.svg)\n\n' + Array.from({ length: 35 }, (_, i) => `After ${i}\n\n`).join(''));

(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets', 'feature-catalog.json'), 'utf8'));
  const profile = minimal ? ['--launch-profile', JSON.stringify({ version: 1, features: Object.fromEntries(catalog.features.map(f => [f.id, f.id === 'notes'])) })] : [];
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port), ...profile], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {}
      if (ready) break; await pause(100);
    }
    assert(ready, 'isolated API did not start');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: process.argv.includes('--motion') ? 'no-preference' : 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const instrumented = fs.readFileSync(path.join(repo, 'assets', 'note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.P = {state, openNote, setViewMode, flushSave, openImagePreview, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: instrumented }));
    let externalOpens = 0;
    await page.route('**/api/open-external', route => { externalOpens++; return route.fulfill({ json: { ok: true } }); });
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteOpenTabs:v1', '["Image.md"]');
      localStorage.setItem('canvas:noteActiveTab:v1', 'Image.md');
    });
    await page.goto(url);
    await page.waitForFunction(() => window.P?.state.initialized && P.state.current?.path === 'Image.md');
    const imageFrame = page.locator('.note-live-image-frame').first();
    const modal = page.locator('.note-image-preview');
    const action = name => modal.locator(`[data-image-preview-action="${name}"]`);
    const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const snapshot = () => page.evaluate(() => ({ value: P.editor.snapshot().value,
      selection: P.editor.view.state.selection.toJSON(), scroll: P.editor.view.scrollDOM.scrollTop }));
    const open = async (target = imageFrame) => {
      await target.dblclick({ position: { x: 25, y: 25 } });
      await modal.waitFor();
      await page.waitForFunction(() => !document.querySelector('.note-image-preview-picture')?.hidden);
      await settled();
    };
    await page.waitForFunction(() => document.querySelector('.note-live-image-frame img')?.naturalWidth === 400);
    assert.equal(await imageFrame.evaluate(el => el.classList.contains('is-selected')), false);
    await open(); // Includes replacement of the initially unselected widget.
    assert.equal(externalOpens, 0);
    assert.equal(await modal.locator('button').count(), 4);
    for (const control of await modal.locator('button').all()) {
      assert.equal((await control.textContent()).trim(), '');
      assert(await control.getAttribute('aria-label')); assert(await control.getAttribute('data-ui-tooltip'));
    }
    assert(await page.evaluate(() => !!document.activeElement.closest('.note-image-preview')));
    const fitted = await modal.locator('img').boundingBox();
    assert(fitted.width > 500, 'preview must ignore the 160px Markdown width');
    assert(Math.abs(fitted.width / fitted.height - 2) < .01);
    const before = await snapshot();
    const stage = modal.locator('.note-image-preview-stage');
    const picture = modal.locator('.note-image-preview-picture');
    const originalTransform = await picture.evaluate(el => el.style.transform);
    await action('in').click(); await settled();
    assert.notEqual(await picture.evaluate(el => el.style.transform), originalTransform);
    const stageBox = await stage.boundingBox();
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
    await page.mouse.down(); await page.mouse.move(stageBox.x + stageBox.width / 2 + 120, stageBox.y + stageBox.height / 2 + 30); await page.mouse.up();
    await settled();
    assert(await modal.count(), 'drag release must not close preview');
    assert(await picture.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e > 0));
    await action('reset').click(); await settled();
    assert.equal(await picture.evaluate(el => el.style.transform), originalTransform);
    // Wheel zoom keeps a point under the cursor fixed, subject to pan bounds.
    await page.mouse.move(stageBox.x + stageBox.width * .65, stageBox.y + stageBox.height * .5);
    await page.mouse.wheel(0, -150); await settled();
    assert(await picture.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e < 0));
    await action('close').click(); await modal.waitFor({ state: 'detached' });
    assert.deepEqual(await snapshot(), before, 'viewing must preserve source, selection and scroll');
    assert(await page.evaluate(() => P.editor.view.hasFocus));
    await imageFrame.click(); assert.equal(await modal.count(), 0, 'single click only selects');
    await imageFrame.click({ modifiers: ['Control'] });
    assert.equal(externalOpens, 1, 'modifier click retains system opening');
    for (const target of [page.locator('.note-live-image-frame.is-inline'), page.locator('.note-live-image-frame.is-block').nth(1), page.locator('.note-live-image-frame.is-block').nth(2)]) {
      await open(target);
      assert.match(await modal.locator('img').getAttribute('src'), /vector\.svg/);
      if (process.env.RELATUM_ARTIFACT_DIR) {
        fs.mkdirSync(process.env.RELATUM_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, 'image-preview-vector.png'), animations: 'disabled' });
      }
      await page.keyboard.press('Escape'); await modal.waitFor({ state: 'detached' });
    }
    // Existing image-text editing owns double-click while that mode is active.
    await imageFrame.click();
    await page.evaluate(() => { P.editor.setImageTextMode(true); P.editor.imageTextCommand('add'); });
    await imageFrame.click({ position: { x: 70, y: 40 } });
    const textInput = page.locator('.note-image-text-editor');
    await textInput.fill('预览标注'); await textInput.press('Control+Enter');
    await page.locator('.note-image-text-box').first().dblclick();
    await textInput.waitFor(); assert.equal(await modal.count(), 0);
    await textInput.press('Escape'); await page.evaluate(() => P.editor.setImageTextMode(false));
    const label = page.locator('.note-live-image-frame .note-image-text-box').first();
    const labelSize = await label.boundingBox(), imageSize = await imageFrame.locator('img').boundingBox();
    await open();
    const previewLabel = await modal.locator('.note-image-text-box').boundingBox();
    const previewImage = await modal.locator('img').boundingBox();
    assert.equal(await modal.locator('.note-image-text-box').textContent(), '预览标注');
    assert(Math.abs(previewLabel.width / labelSize.width - previewImage.width / imageSize.width) < .1, 'annotations scale with image');
    await page.keyboard.press('Tab'); assert(await page.evaluate(() => !!document.activeElement.closest('.note-image-preview')));
    await page.mouse.click(3, 3); await modal.waitFor({ state: 'detached' });
    // Window resizing and the four note palettes, in both shell color modes.
    for (const theme of ['default', 'claude', 'sky', 'apple']) {
      for (const dark of [false, true]) {
        await page.evaluate(({ theme, dark }) => {
          RelatumNoteTheme.apply(theme, { persist: false }); document.body.dataset.startTheme = dark ? 'dark' : 'light';
        }, { theme, dark });
        await open();
        await page.setViewportSize({ width: 560, height: 740 }); await settled();
        const box = await modal.boundingBox(); assert(box.x >= 0 && box.x + box.width <= 561 && box.height <= 740);
        const img = await modal.locator('img').boundingBox(); assert(img.width > 0 && img.x >= box.x - 1 && img.x + img.width <= box.x + box.width + 1);
        if (process.env.RELATUM_ARTIFACT_DIR) {
          fs.mkdirSync(process.env.RELATUM_ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, `image-preview-${theme}-${dark ? 'dark' : 'light'}.png`) });
        }
        await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 960 });
      }
    }
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    await open(); assert.equal(await action('reset').getAttribute('aria-label'), 'Fit image');
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await modal.waitFor({ state: 'detached' });
    await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await open(); await page.evaluate(() => P.setViewMode('reading')); await modal.waitFor({ state: 'detached' });
    const count = externalOpens;
    await page.locator('.note-reading-content [data-note-image]').first().click();
    assert.equal(externalOpens, count + 1, 'reading still opens via its existing single-click action');
    await page.evaluate(() => P.setViewMode('live'));
    // Source mode has no preview entry and cannot open a stale image callback.
    await page.evaluate(() => P.setViewMode('source'));
    await page.evaluate(() => { P.openImagePreview({ notePath: 'Image.md', url: '/missing-preview.png' }); });
    assert.equal(await modal.count(), 0);
    await page.evaluate(() => P.setViewMode('live'));
    await open(); await page.evaluate(() => P.openNote('Other.md', { reuseActiveTab: false }));
    await modal.waitFor({ state: 'detached' });
    await page.evaluate(() => P.openNote('Image.md', { reuseActiveTab: false }));
    if (!minimal) {
      await open(); await page.evaluate(() => RelatumStartWorkspace.set('canvas'));
      await modal.waitFor({ state: 'detached' });
      await page.locator('[data-start-workspace="notes"]').click(); await page.waitForFunction(() => P.state.active);
    }
    await page.evaluate(() => P.openNote('Scroll.md', { reuseActiveTab: false }));
    await page.evaluate(() => {
      const view = P.editor.view;
      view.dispatch({ effects: RelatumCodeMirror.EditorView.scrollIntoView(view.state.doc.toString().indexOf('![scroll'), { y: 'center' }) });
    });
    await imageFrame.click(); await settled();
    const scrolled = await snapshot(); assert(scrolled.scroll > 500);
    await open(); await page.keyboard.press('Escape'); await settled();
    assert.deepEqual(await snapshot(), scrolled, 'preview at a nonzero reading position must not jump');
    const historySource = await page.evaluate(() => {
      const view = P.editor.view, value = P.editor.snapshot().value;
      view.dispatch({ changes: { from: view.state.doc.length, insert: 'history probe' }, userEvent: 'input' });
      return value;
    });
    await open(); await page.keyboard.press('Escape');
    await page.evaluate(() => RelatumCodeMirror.undo(P.editor.view));
    assert.equal((await snapshot()).value, historySource, 'preview must not add a document history entry');
    await page.evaluate(() => P.openNote('Image.md', { reuseActiveTab: false }));
    // Preview-only image failure and a late load after close cannot revive it.
    await page.evaluate(() => { P.openImagePreview({ notePath: 'Image.md', url: '/missing-preview.png' }); });
    await modal.waitFor(); await page.waitForFunction(() => document.querySelector('.note-image-preview-status')?.textContent === 'Image could not be loaded');
    await page.keyboard.press('Escape');
    let release;
    await page.route('**/late-preview.png', async route => { await new Promise(resolve => { release = resolve; }); await route.fulfill({ path: path.join(assets, '透明 (1).png') }).catch(() => {}); });
    await page.evaluate(() => { P.openImagePreview({ notePath: 'Image.md', url: '/late-preview.png' }); });
    await modal.waitFor();
    for (let i = 0; i < 50 && !release; i++) await pause(20);
    assert(release); await page.keyboard.press('Escape'); release(); await settled();
    assert.equal(await modal.count(), 0);
    await open(); await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await modal.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    assert.equal(await page.locator('.note-modal-overlay').count(), 0);
    console.log(`note image preview browser regression: ok (${minimal ? 'notes only' : 'full shell'}, ${process.argv.includes('--motion') ? 'motion' : 'reduced motion'})`);
  } finally {
    if (browser) await browser.close(); server.kill();
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(2000)]);
    // Only the exact temporary root created by this test is removed.
    assert(path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('relatum-image-preview-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
