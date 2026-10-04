'use strict';
// Real Edge and API, with an isolated root and only the Research feature enabled.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-labels-'));
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'), 'utf8'));
  const features = Object.fromEntries(catalog.features.map(f => [f.id, f.id === 'research']));
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port),
    '--launch-profile', JSON.stringify({ version: 1, features })], { cwd: repo,
    env: { ...process.env, RELATUM_DATA_ROOT: root, PYTHONUTF8: '1' }, windowsHide: true, stdio: 'ignore' });
  let browser;
  const errors = [], requests = [];
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url + '/api/research/workspace')).ok) { ready = true; break; } } catch (_) {}
      await sleep(100);
    }
    assert(ready, 'isolated server startup');
    const symbol = (id, label, x, y, extra = {}) => ({ id, kind: 'symbol', type: 'lamp', x, y,
      width: 32, height: 32, rotation: 0, label, labelOffsetY: 50, labelFontSize: 24, ...extra });
    const legacyText = '**R1**\n`$notMath$`';
    const fixture = { researchVersion: 3, subcircuits: [], activePageId: 'research-page-1', pages: [
      { id: 'research-page-1', title: '', nodes: [], edges: [], view: { x: 0, y: 0, scale: 1 }, simulation: { speed: 1 },
        decorations: [symbol('legacy', legacyText, 500, 300), symbol('literal', '**raw**\nU_{s1}', 760, 300, { labelMarkdown: false })] },
      { id: 'research-page-2', title: '', nodes: [], edges: [], view: { x: 0, y: 0, scale: 1 }, simulation: { speed: 1 },
        decorations: Array.from({ length: 300 }, (_, i) => symbol('bulk-' + i, '**R' + i + '**', 350 + i % 20 * 42, 80 + Math.floor(i / 20) * 38,
          { labelFontSize: 12, labelOffsetY: 20 })) },
    ] };
    const seed = await fetch(url + '/api/research/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: fixture, revision: '' }) }); assert(seed.ok, await seed.text());
    browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH || undefined });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    await context.addInitScript(() => localStorage.setItem('research:editorMode:v1', 'orthogonal'));
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    const open = async () => { await page.goto(url + '/research.html'); await page.evaluate(() => RelatumResearchWorkspace.activate()); };
    const label = page.locator('.research-label-layer > [data-research-label-id="legacy"]');
    const input = page.locator('textarea[data-research-decoration-label]');
    const markdown = page.locator('input[data-symbol-field="labelMarkdown"]');
    const saved = async () => (await (await fetch(url + '/api/research/workspace')).json()).document;
    const savedSymbol = async () => (await saved()).pages[0].decorations.find(d => d.id === 'legacy');
    const waitSaved = async (text) => { for (let i = 0; i < 50; i++) { if ((await savedSymbol()).label === text) return; await sleep(100); } assert.equal((await savedSymbol()).label, text); };
    const switchPage = async id => page.locator(`[data-research-page-id="research-page-${id}"]`).evaluate(e => e.click());
    await open(); await label.locator('strong').waitFor();
    assert.equal(await label.locator('strong').textContent(), 'R1');
    assert.equal(await label.locator('code').textContent(), '$notMath$');
    assert.equal(await page.locator('[data-research-label-id="literal"]').count(), 0);
    assert(!requests.some(u => /mathjax|mermaid|\/canvas\.js|note-live-editor/.test(u)), 'ordinary labels use only lightweight Markdown');
    assert(requests.some(u => u.endsWith('/markdown.js')));
    assert(!Object.hasOwn((await savedSymbol()), 'labelMarkdown'), 'legacy document must not be rewritten on read');
    await page.mouse.click(500, 250); // HTML has pointer-events:none; Canvas label bounds must select the symbol.
    await input.waitFor(); assert(await markdown.isChecked()); assert.equal(await input.inputValue(), legacyText);
    await page.evaluate(() => RelatumResearchWorkspace.setLanguage('en'));
    assert.equal(await markdown.locator('..').textContent(), 'Render Markdown');
    await input.fill('**删除**');
    await page.waitForFunction(() => document.querySelector('[data-research-label-id="legacy"]')?.textContent === '删除');
    await sleep(100);
    assert.equal(await label.textContent(), '删除', 'user label text must never be translated as interface text');
    await input.press('Escape');
    await page.evaluate(() => RelatumResearchWorkspace.setLanguage('zh-CN'));
    assert.equal(await input.inputValue(), legacyText);
    await input.fill('**preview**\n*second*'); await label.locator('em').waitFor();
    await sleep(600); assert.equal((await savedSymbol()).label, legacyText, 'live draft stays out of automatic saving');
    const beforeEnter = await input.inputValue();
    await input.press('Enter'); assert.equal((await input.inputValue()).length, beforeEnter.length + 1);
    await input.fill('**preview**\n*second*'); await input.press('Control+Enter'); await waitSaved('**preview**\n*second*');
    await page.keyboard.press('Control+z'); await waitSaved(legacyText);
    await page.keyboard.press('Control+Shift+z'); await waitSaved('**preview**\n*second*');
    await input.fill('discard'); await label.getByText('discard', { exact: true }).waitFor(); await input.press('Escape');
    assert.equal(await input.inputValue(), '**preview**\n*second*');
    await sleep(450); assert.equal((await savedSymbol()).label, '**preview**\n*second*');
    const mathText = '**电压** $U_{s1}$\n==额定值==\n$$\\frac{1}{2}CV^2$$';
    await input.fill(mathText); await input.press('Control+Enter');
    await label.locator('mjx-container').first().waitFor();
    await page.waitForFunction(() => document.querySelector('[data-research-label-id="legacy"] mjx-msub'));
    await waitSaved(mathText);
    // Cold typesetting at each camera scale must honor the explicit font size.
    // These use the same renderer as the canvas and previews, without touching
    // the page model or its saved view.
    await page.evaluate(async () => {
      const { createResearchLabelLayer } = await import('/research/research-label-renderer.js');
      const { defaultSymbol } = await import('/research/research-symbols.js');
      const panel = document.createElement('div'); panel.dataset.userContent = '';
      panel.style.cssText = 'position:fixed;inset:0;z-index:1000;pointer-events:none;background:var(--research-paper);color:var(--research-ink)';
      document.body.appendChild(panel); window.__fontPanel = panel; window.__fontSamples = [];
      for (const [row, scale] of [.5, 1, 3.5].entries()) for (const [column, size] of [14, 24].entries()) {
        const host = document.createElement('div'); panel.appendChild(host);
        const caption = document.createElement('div'); caption.textContent = `${size}px / ${scale * 100}%`;
        caption.style.cssText = `position:absolute;left:${column * 620 + 20}px;top:${row * 220 + 30}px;font:14px system-ui`;
        panel.appendChild(caption);
        const objects = [{ ...defaultSymbol('lamp'), id: `font-${size}-${scale}`, x: 0, y: 0,
          label: 'U $U_{S1}$  $x^2$', labelFontSize: size }];
        const camera = { scale, x: column * 620 + 300, y: row * 220 + 120 };
        const layer = createResearchLabelLayer(host); layer.sync(objects, camera);
        window.__fontSamples.push({ host, layer, objects, camera, size });
      }
    });
    await page.waitForFunction(() => window.__fontSamples.every(s => s.host.querySelector('mjx-msub') && s.host.querySelector('mjx-msup')));
    const fonts = await page.evaluate(() => window.__fontSamples.map(s => {
      const node = s.host.querySelector('.research-symbol-label'), math = node.querySelector('mjx-container');
      s.node = node;
      return { size: s.size, scale: s.camera.scale, mathSize: parseFloat(getComputedStyle(math).fontSize),
        scriptRatio: parseFloat(getComputedStyle(math.querySelector('[size="s"]')).fontSize) / s.size,
        width: node.getBoundingClientRect().width / s.camera.scale, height: node.getBoundingClientRect().height / s.camera.scale };
    }));
    for (const sample of fonts) {
      assert(Math.abs(sample.mathSize - sample.size) < .02, JSON.stringify(sample));
      assert(Math.abs(sample.scriptRatio - .707) < .002, 'native TeX subscript proportions');
      const reference = fonts.find(s => s.size === sample.size && s.scale === 1);
      assert(Math.abs(sample.width - reference.width) < .15 && Math.abs(sample.height - reference.height) < .15,
        'world-space label bounds must agree regardless of cold camera scale');
    }
    await page.screenshot({ path: path.join(root, 'labels-font-scales-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(root, 'labels-font-scales-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    const warm = await page.evaluate(async () => {
      let parses = 0, typesets = 0;
      const parse = MarkdownMini.renderLabelResult, typeset = MathJax.typesetPromise;
      MarkdownMini.renderLabelResult = (...args) => { parses++; return parse(...args); };
      MathJax.typesetPromise = (...args) => { typesets++; return typeset.call(MathJax, ...args); };
      for (const s of window.__fontSamples) { s.layer.sync(s.objects, { ...s.camera, scale: s.camera.scale === 3.5 ? .5 : 3.5 }); }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const reused = window.__fontSamples.every(s => s.node === s.host.querySelector('.research-symbol-label'));
      MarkdownMini.renderLabelResult = parse; MathJax.typesetPromise = typeset;
      for (const s of window.__fontSamples) s.layer.dispose(); window.__fontPanel.remove();
      return { parses, typesets, reused };
    });
    assert.deepEqual(warm, { parses: 0, typesets: 0, reused: true });
    const metric = await label.evaluate(async node => {
      const { symbolLabelBounds } = await import('/research/research-symbols.js');
      const rect = node.getBoundingClientRect();
      return { rect: { width: rect.width, height: rect.height }, bounds: symbolLabelBounds({ label: '**电压** $U_{s1}$\n==额定值==\n$$\\frac{1}{2}CV^2$$',
        labelFontSize: 24, x: 500, y: 300, labelOffsetY: 50 }) };
    });
    assert(Math.abs(metric.rect.width - (metric.bounds.right - metric.bounds.left)) < 1);
    assert(Math.abs(metric.rect.height - (metric.bounds.bottom - metric.bounds.top)) < 1);
    assert(metric.rect.height > 60, 'display formula participates in the real label bounds');
    const edit = async (key, value) => { const field = page.locator(`input[data-symbol-field="${key}"]`); await field.fill(value); await field.press('Tab'); };
    await edit('rotationDegrees', '45'); await edit('labelOffsetX', '35');
    assert.equal(await label.evaluate(n => n.style.transform), '', 'labels stay upright when their symbol rotates');
    assert.equal(await label.evaluate(n => n.style.left), '535px');
    await edit('labelOffsetY', '100');
    await page.locator('select[data-symbol-field="labelColor"]').selectOption('blue');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-research-label-id="legacy"]')).color === 'rgb(66, 121, 176)');
    await page.screenshot({ path: path.join(root, 'labels-light-dpr2.png') });
    await page.emulateMedia({ colorScheme: 'dark' }); await sleep(200);
    await page.screenshot({ path: path.join(root, 'labels-dark-dpr2.png') });
    await page.setViewportSize({ width: 720, height: 600 });
    await input.waitFor(); assert(await markdown.isVisible());
    await page.screenshot({ path: path.join(root, 'labels-narrow.png') });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: 'light' });
    // Reuse the actual DOM and math across camera movement, with no new parse/typeset calls.
    await page.evaluate(() => {
      window.__labelNode = document.querySelector('[data-research-label-id="legacy"]');
      window.__parseCalls = window.__mathCalls = 0;
      const parse = MarkdownMini.renderLabelResult, typeset = MathJax.typesetPromise;
      MarkdownMini.renderLabelResult = (...args) => { window.__parseCalls++; return parse(...args); };
      MathJax.typesetPromise = (...args) => { window.__mathCalls++; return typeset.call(MathJax, ...args); };
    });
    await page.mouse.move(950, 650); await page.mouse.down({ button: 'middle' });
    await page.mouse.move(980, 670, { steps: 12 }); await page.mouse.up({ button: 'middle' });
    await page.mouse.wheel(0, -100); await sleep(300);
    assert(await label.evaluate(n => n === window.__labelNode));
    assert.deepEqual(await page.evaluate(() => [window.__parseCalls, window.__mathCalls]), [0, 0]);
    // A delayed old formula typeset must never overwrite a newer text preview.
    await page.evaluate(() => {
      const original = MathJax.typesetPromise;
      MathJax.typesetPromise = nodes => new Promise(resolve => { window.__releaseMath = () => original.call(MathJax, nodes).then(resolve); });
    });
    await input.fill('$old_{formula}$');
    await page.waitForFunction(() => window.__releaseMath);
    await input.fill('**fresh**'); await label.locator('strong').waitFor();
    await page.evaluate(() => window.__releaseMath()); await sleep(200);
    assert.equal(await label.textContent(), 'fresh');
    await input.press('Control+Enter'); await waitSaved('**fresh**');
    // Candidate text stays hidden; a requested page switch waits for compositionend and saves the committed text.
    await input.focus();
    await input.evaluate(e => { e.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      e.value = 'zhong'; e.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); });
    await sleep(400); assert.equal(await label.textContent(), 'fresh'); assert.equal((await savedSymbol()).label, '**fresh**');
    const bulkStarted = Date.now();
    await switchPage(2); assert(await input.isVisible(), 'composition must finish before the source control is detached');
    await input.evaluate(e => { e.value = '中文'; e.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })); });
    await page.locator('[data-research-label-id="bulk-0"]').waitFor(); await waitSaved('中文');
    try { await page.waitForFunction(() => document.querySelectorAll('[data-research-label-id^="bulk-"]').length === 300); }
    catch (error) {
      console.error('bulk render state', await page.evaluate(() => ({ count: document.querySelectorAll('[data-research-label-id^="bulk-"]').length,
        missing: Array.from({ length: 300 }, (_, i) => 'bulk-' + i).filter(id => !document.querySelector(`[data-research-label-id="${id}"]`)),
        transform: document.querySelector('.research-surface').style.transform,
        viewport: document.querySelector('[data-research-viewport]').getBoundingClientRect().toJSON() })), errors);
      await page.screenshot({ path: path.join(root, 'labels-bulk-failure.png') }); throw error;
    }
    const bulkRenderMs = Date.now() - bulkStarted;
    await switchPage(1); await label.waitFor(); assert.equal(await label.textContent(), '中文');
    const center = await label.boundingBox(); await page.mouse.click(center.x + center.width / 2, center.y + center.height / 2);
    await input.waitFor(); await input.fill('**literal**\nU_{s1}'); await input.press('Control+Enter');
    await markdown.uncheck(); await sleep(500); assert.equal((await savedSymbol()).labelMarkdown, false);
    await open(); await page.mouse.click(500, 300); await input.waitFor(); assert.equal(await markdown.isChecked(), false);
    assert.equal(await input.inputValue(), '**literal**\nU_{s1}');
    assert.equal(await page.locator('[data-research-label-id="legacy"]').count(), 0);
    await page.locator('[data-research-save-preset]').click();
    const dialog = page.locator('[data-research-preset-dialog]');
    await dialog.locator('[data-research-preset-name]').fill('Markdown label');
    assert.equal(await dialog.locator('[data-symbol-field="labelMarkdown"]').isChecked(), false);
    await dialog.locator('[data-symbol-field="labelMarkdown"]').check();
    await dialog.locator('textarea').fill('**shared**\n$U_{s1}$');
    await dialog.locator('textarea').press('Control+Enter');
    await dialog.locator('[data-research-preset-preview] mjx-msub').waitFor();
    await page.screenshot({ path: path.join(root, 'labels-preset-preview.png') });
    await dialog.locator('[data-research-preset-save]').click();
    const preset = page.locator('[data-research-decoration-preset]').first();
    await preset.locator('mjx-msub').waitFor();
    assert(Math.abs(await preset.locator('mjx-container').evaluate(n => parseFloat(getComputedStyle(n).fontSize)) - 24) < .02,
      'preset thumbnail must share the same formula sizing');
    await page.screenshot({ path: path.join(root, 'labels-preset-library.png') });
    const presetData = await page.evaluate(() => JSON.parse(localStorage.getItem('research:decorationPresets:v1')));
    assert.equal(presetData.presets[0].template.labelMarkdown, true);
    await preset.click(); await page.mouse.dblclick(950, 450); await sleep(500);
    assert((await saved()).pages[0].decorations.some(d => d.id !== 'legacy' && d.label === '**shared**\n$U_{s1}$' && d.labelMarkdown === true));
    await page.locator('[data-research-add]').click(); await preset.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '编辑预设' }).click();
    await dialog.locator('[data-research-preset-preview] mjx-msub').waitFor();
    assert(await dialog.locator('[data-symbol-field="labelMarkdown"]').isChecked());
    await dialog.locator('[data-symbol-field="labelMarkdown"]').uncheck(); await dialog.locator('[data-research-preset-save]').click();
    assert.equal(await preset.locator('[data-research-label-id]').count(), 0);
    // Suspending the workspace also waits for candidate input and commits once before saving.
    await page.mouse.click(500, 300); await input.focus();
    await input.evaluate(e => { e.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); e.value = 'li';
      e.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); });
    await page.evaluate(() => { window.__suspendDone = false; RelatumResearchWorkspace.suspend().then(() => { window.__suspendDone = true; }); });
    await sleep(200); assert.equal(await page.evaluate(() => window.__suspendDone), false);
    await input.evaluate(e => { e.value = '离开前提交'; e.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    await page.waitForFunction(() => window.__suspendDone); await waitSaved('离开前提交');
    await page.evaluate(() => RelatumResearchWorkspace.activate());
    // A failed MathJax job keeps readable source and does not break the serial queue or saving.
    await page.mouse.click(500, 300); await markdown.check();
    await page.evaluate(() => { MathJax.typesetPromise = () => Promise.reject(new Error('intentional typeset failure')); });
    await input.fill('$failed_{formula}$'); await input.press('Control+Enter');
    await page.waitForFunction(() => document.querySelector('[data-research-label-id="legacy"]')?.textContent === '$failed_{formula}$');
    await waitSaved('$failed_{formula}$');
    // Local Markdown load failure still displays Canvas source and accepts edits.
    const fallback = await browser.newContext({ reducedMotion: 'reduce' });
    await fallback.addInitScript(() => localStorage.setItem('research:editorMode:v1', 'orthogonal'));
    await fallback.route('**/markdown.js', route => route.abort());
    const failedPage = await fallback.newPage(); failedPage.on('pageerror', error => errors.push(error.message));
    await failedPage.goto(url + '/research.html'); await failedPage.evaluate(() => RelatumResearchWorkspace.activate());
    await failedPage.mouse.click(500, 300); await failedPage.locator('textarea[data-research-decoration-label]').waitFor();
    assert.equal(await failedPage.locator('textarea[data-research-decoration-label]').inputValue(), '$failed_{formula}$');
    await failedPage.screenshot({ path: path.join(root, 'labels-load-fallback.png') }); await fallback.close();
    const mathFallback = await browser.newContext({ reducedMotion: 'reduce' });
    await mathFallback.route('**/vendor/mathjax/tex-mml-chtml.js', route => route.abort());
    const mathFailedPage = await mathFallback.newPage(); mathFailedPage.on('pageerror', error => errors.push(error.message));
    await mathFailedPage.goto(url + '/research.html'); await mathFailedPage.evaluate(() => RelatumResearchWorkspace.activate());
    await mathFailedPage.waitForFunction(() => document.querySelector('[data-research-label-id="legacy"]')?.textContent === '$failed_{formula}$');
    await sleep(200); assert.equal(await mathFailedPage.locator('[data-research-label-id="legacy"] mjx-container').count(), 0);
    await mathFallback.close();
    await page.evaluate(() => RelatumResearchWorkspace.suspend());
    await page.evaluate(() => RelatumResearchWorkspace.activate());
    assert.deepEqual(errors, []);
    assert(!requests.some(u => /\/canvas\.js|note-live-editor|mermaid/.test(u)));
    assert(requests.filter(u => /^https?:/.test(u)).every(u => u.startsWith(url + '/')), 'rendering remains entirely offline');
    console.log(JSON.stringify({ ok: true, root, bulkRenderMs, fonts, screenshots: ['labels-font-scales-light.png', 'labels-font-scales-dark.png', 'labels-light-dpr2.png', 'labels-dark-dpr2.png', 'labels-narrow.png', 'labels-preset-preview.png', 'labels-preset-library.png', 'labels-load-fallback.png'], errors }));
  } finally {
    if (browser) await browser.close(); server.kill(); await sleep(150);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
