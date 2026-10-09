'use strict';
// Real API, CodeMirror and Edge; no user documents or external dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json')));
async function port() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const number = socket.address().port; await new Promise(resolve => socket.close(resolve)); return number;
}
async function run(browser, enabled, prewarm = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-canvas-'));
  fs.mkdirSync(path.join(root, 'notes', 'Book'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes', 'A.md'), '正文保留\n\n后文');
  fs.writeFileSync(path.join(root, 'notes', 'Book', 'B.md'), '共享正文');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/note-notebooks.json'), JSON.stringify({ version: 1, colors: {}, ui: { open: true, mode: 'canvas', selectedRoot: '', expanded: [] } }));
  if (prewarm) {
    fs.mkdirSync(path.join(root, 'notes/canvases'));
    fs.writeFileSync(path.join(root, 'notes/canvases/seed.canvas'), JSON.stringify({ version: 2, nodes: [], edges: [] }));
    fs.writeFileSync(path.join(root, 'notes/A.md'), '![seed.canvas|640x360](canvases/seed.canvas)\n');
  }
  const choices = Object.fromEntries(catalog.features.map(f => [f.id, f.id === 'notes' || enabled && f.id === 'notes.canvas' || prewarm && ['canvas', 'canvas.library', 'runtime.preload'].includes(f.id)]));
  const number = await port(), url = `http://127.0.0.1:${number}`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(number), '--launch-profile', JSON.stringify({ version: 1, features: choices })], { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  const context = await browser.newContext({ viewport: { width: 1600, height: 960 }, reducedMotion: 'reduce' });
  let page;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/runtime')).ok) break; } catch (_) {} await pause(100); }
    page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    let workspace = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8');
    workspace = workspace.replace('  window.CanvasNoteWorkspace = {', '  window.T = {state, openNote, setViewMode, openBodyContextMenu, renameCanvas, movePath, resetNoteSettings, flushNotebookSettings, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: workspace }));
    await page.addInitScript(prewarm => {
      localStorage.setItem('canvas:startWorkspace:v1', prewarm ? 'canvas' : 'notes'); localStorage.setItem('canvas:noteView:v1', 'live');
      if (prewarm) { localStorage.setItem('canvas:noteOpenTabs:v1', JSON.stringify(['A.md'])); localStorage.setItem('canvas:noteActivePath:v1', 'A.md'); }
    }, prewarm);
    await page.goto(url); await page.waitForFunction(() => window.T?.state.initialized);
    if (prewarm) {
      await page.waitForFunction(() => T.state.current?.path === 'A.md' && !T.state.active);
      await pause(150);
      assert.equal(requests.filter(r => /note-canvas\/|notes-canvas\//.test(r)).length, 0, 'hidden restored canvas never loads during prewarm');
      await page.locator('button[data-start-workspace="notes"]').click();
      await page.waitForFunction(() => document.querySelector('.is-canvas .note-live-image-frame')?.__noteCanvas?.engine);
      await page.evaluate(() => { localStorage.setItem('canvas:noteView:v1', 'source'); localStorage.setItem('canvas:startWorkspace:v1', 'notes'); });
      // Replace the initial storage script with source-only restoration.
      await context.addInitScript(() => { localStorage.setItem('canvas:noteView:v1', 'source'); localStorage.setItem('canvas:startWorkspace:v1', 'notes'); });
      const before = requests.filter(r => /note-canvas\/|notes-canvas\//.test(r)).length;
      await page.reload(); await page.waitForFunction(() => window.T?.state.current?.path === 'A.md' && T.state.viewMode === 'source');
      assert.equal(requests.filter(r => /note-canvas\/|notes-canvas\//.test(r)).length, before);
      assert.equal(await page.evaluate(() => !!window.RelatumNoteCanvas), false);
      assert.deepEqual(errors, []); return { prewarm: true, sourceColdStart: true, dedicatedRequestsWhileHidden: 0 };
    }
    await page.evaluate(() => T.openNote('A.md'));
    assert.equal(requests.filter(r => /note-canvas\/|notes-canvas\//.test(r)).length, 0, 'ordinary notes never load canvas resources');
    assert(!fs.existsSync(path.join(root, 'notes/canvases')), 'no resource directory during startup');
    const snap = () => page.evaluate(() => T.editor.snapshot().value);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (!enabled) {
      assert.equal(await page.locator('[data-note-action="side-canvas"], [data-role="note-canvas-settings"]').count(), 0);
      assert.equal(await page.evaluate(() => T.state.sideMode), 'notebooks', 'disabled restored tab falls back');
      const literal = '![示意图.canvas|640x360](canvases/示意图.canvas)';
      await page.evaluate(value => T.editor.replaceSelection('\n\n' + value), literal);
      await settle();
      assert.equal(await page.locator('.is-canvas').count(), 0);
      assert((await page.locator('.cm-content').innerText()).includes(literal));
      await page.evaluate(() => T.setViewMode('reading'));
      assert((await page.locator('.note-reading-content').innerText()).includes(literal));
      assert.equal(requests.filter(r => /note-canvas\/|notes-canvas\//.test(r)).length, 0, 'disabled plugin has zero requests');
      assert.equal((await fetch(url + '/note-canvas/runtime.js')).status, 403);
      assert.equal((await fetch(url + '/api/notes-canvas/read?note=A.md&src=canvases/a.canvas')).status, 403);
      assert.deepEqual(errors, []); return { enabled, dedicatedRequests: 0 };
    }
    assert.equal(await page.evaluate(() => T.state.sideMode), 'canvas', 'canvas sidebar restores without a canvas');
    await page.locator('[data-note-action="side-canvas"]').click();
    const settings = page.locator('[data-role="note-canvas-settings"]');
    assert.equal(await settings.isVisible(), true);
    assert.equal(await page.locator('[data-role="note-settings-pop"] [data-role="note-canvas-node-scale"]').count(), 0);
    assert.equal(await settings.locator('details').count(), 0);
    assert.equal(await settings.locator('[role="tab"]').count(), 4);
    assert.equal(await settings.locator('[data-canvas-group]:visible').getAttribute('data-canvas-group'), 'defaults');
    assert.equal(await settings.locator('[data-canvas-group="defaults"] [data-shape]').count(), 12);
    assert.equal(await settings.locator('[data-canvas-group="node"] input:enabled').count(), 0, 'object controls require a selection');
    assert.equal((await settings.innerText()).includes('规划中'), false);
    await page.evaluate(() => { const slider = document.querySelector('[data-role="note-canvas-node-scale"]'); slider.value = '150'; slider.dispatchEvent(new Event('input', { bubbles: true })); T.resetNoteSettings(); });
    assert.equal(await settings.locator('[data-role="note-canvas-node-scale"]').inputValue(), '150', 'note reset does not reset canvas defaults');
    await settings.locator('[data-note-action="reset-canvas-settings"]').click();
    assert.equal(await settings.locator('[data-role="note-canvas-node-scale"]').inputValue(), '100');
    await page.evaluate(() => T.flushNotebookSettings());
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/note-notebooks.json'))).ui.mode, 'canvas');
    assert.equal(requests.filter(r => /note-canvas\/|notes-canvas\//.test(r)).length, 0, 'opening settings does not load canvas resources');
    await page.locator('[data-note-action="close-links"]').click();
    // Use the actual Insert submenu, preserving selected prose.
    await page.evaluate(() => {
      T.editor.view.dispatch({ selection: { anchor: 0, head: 4 } });
      T.openBodyContextMenu({ context: T.editor.commandContext(), x: 700, y: 330 });
    });
    await page.locator('[data-note-submenu="insert"]').hover();
    await page.locator('[data-note-command="insert:canvas"]').click();
    const frame = page.locator('.is-canvas .note-live-image-frame').first();
    await frame.locator('.note-canvas-viewport').waitFor();
    assert((await snap()).startsWith('正文保留\n'));
    assert(fs.existsSync(path.join(root, 'notes/canvases')));
    assert.equal(await page.locator('[data-note-path="canvases"]').count(), 0);
    const viewport = frame.locator('.note-canvas-viewport');
    const compactSource = await snap();
    const compactLayout = await page.evaluate(() => {
      const content = T.editor.view.contentDOM;
      const line = [...content.children].find(el => el.classList.contains('cm-line') && el.textContent === '后文');
      const rect = line.getBoundingClientRect();
      return { blanks: [...content.children].filter(el => el.classList.contains('cm-line') && !el.textContent).length,
        expected: T.editor.snapshot().value.split('\n').filter(line => !line).length,
        point: { x: rect.left + 3, y: (rect.top + rect.bottom) / 2 } };
    });
    assert.equal(compactLayout.blanks, compactLayout.expected, 'live canvases must not add phantom boundary lines');
    await page.mouse.click(compactLayout.point.x, compactLayout.point.y); await settle();
    const proseCaret = await page.evaluate(() => {
      const head = T.editor.view.state.selection.main.head, rect = T.editor.view.coordsAtPos(head);
      return { head, y: (rect.top + rect.bottom) / 2 };
    });
    assert.equal(proseCaret.head, compactSource.indexOf('后文'));
    assert(Math.abs(proseCaret.y - compactLayout.point.y) < 5, 'canvas height must agree with the following paragraph hit test');
    await page.keyboard.type('Z'); await settle();
    assert.equal(await snap(), compactSource.replace('后文', 'Z后文'));
    await page.keyboard.press('Control+z'); await settle();
    assert.equal(await snap(), compactSource);
    async function createNode(x, y, text) {
      const box = await viewport.boundingBox(); await page.mouse.dblclick(box.x + x, box.y + y);
      const input = viewport.locator('textarea'); await input.waitFor();
      await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
      await input.fill(text);
      assert.equal(await page.evaluate(() => CanvasNoteWorkspace.flushSave(undefined, false, true)), true);
      assert.equal(await input.count(), 1, 'body autosave never interrupts a canvas composition');
      await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: el.value })));
      await settle(); await input.press('Control+Enter'); await settle();
    }
    await createNode(130, 105, '中文节点\n第二行');
    await createNode(460, 245, '目标');
    assert.equal(await viewport.locator('.note-canvas-node').count(), 2);
    assert.equal(await page.evaluate(() => T.editor.inputPending), false, 'canvas IME does not open a body composition session');
    const first = viewport.locator('.note-canvas-node').first(), second = viewport.locator('.note-canvas-node').nth(1);
    const firstId = await first.getAttribute('data-canvas-node');
    for (const spot of ['text', 'padding', 'border']) {
      const rect = await first.boundingBox();
      if (spot === 'text') await first.locator('.note-canvas-text').dblclick();
      else await page.mouse.dblclick(rect.x + (spot === 'border' ? .5 : 5), rect.y + rect.height / 2);
      assert.equal(await viewport.locator('textarea').evaluate(el => el.closest('[data-canvas-node]').dataset.canvasNode), firstId);
      assert.equal(await viewport.locator('.note-canvas-node').count(), 2, 'node double click never creates a node');
      await viewport.locator('textarea').press('Escape'); await settle();
    }
    const nodeHistory = await frame.evaluate(el => el.__noteCanvas.session.past.length);
    await first.dblclick(); await viewport.locator('textarea').fill('双击编辑\n中文换行'); await viewport.locator('textarea').press('Control+Enter'); await settle();
    assert.equal(await first.innerText(), '双击编辑\n中文换行');
    assert.equal(await frame.evaluate(el => el.__noteCanvas.session.past.length), nodeHistory + 1);
    await viewport.press('Control+z'); await settle(); assert.equal(await first.innerText(), '中文节点\n第二行');
    await viewport.press('Control+y'); await settle(); assert.equal(await first.innerText(), '双击编辑\n中文换行');
    await viewport.press('Control+z'); await settle();
    // Overlapping nodes edit the topmost hit, within this canvas only.
    await frame.evaluate(el => { const s = el.__noteCanvas.session; s.change({}, data => { data.nodes[1].x = data.nodes[0].x; data.nodes[1].y = data.nodes[0].y; }, { nodes: [s.data.nodes[1].id], positionOnly: true }); });
    await second.dblclick();
    assert.equal(await viewport.locator('textarea').evaluate(el => el.closest('[data-canvas-node]').dataset.canvasNode), await second.getAttribute('data-canvas-node'));
    await viewport.locator('textarea').press('Escape'); await viewport.press('Control+z'); await settle();
    // Unrelated prose edits must retain the live projection and its file session.
    const proseBefore = await snap(), readsBeforeProse = requests.filter(r => r.includes('/api/notes-canvas/read')).length;
    await frame.evaluate(el => { window.proseFrame = el; window.proseEngine = el.__noteCanvas.engine; window.proseSession = el.__noteCanvas.session; window.proseProjectionChanges = 0;
      window.proseObserver = new MutationObserver(records => { for (const record of records) for (const node of [...record.addedNodes, ...record.removedNodes]) if (node.nodeType === 1 && (node.matches('.is-canvas,.note-canvas-viewport') || node.querySelector('.note-canvas-viewport'))) proseProjectionChanges++; });
      proseObserver.observe(T.editor.view.dom, { subtree: true, childList: true });
    });
    async function stableProjection() {
      await settle();
      assert.equal(await frame.evaluate(el => el === proseFrame && el.__noteCanvas.engine === proseEngine && el.__noteCanvas.session === proseSession && !proseEngine.stats().destroyed), true);
      assert.equal(await page.evaluate(() => proseProjectionChanges), 0);
    }
    for (const position of [0, 1, proseBefore.length - 1, 2]) {
      const point = await page.evaluate(position => { const c = T.editor.view.coordsAtPos(position); return { x: c.left + 1, y: (c.top + c.bottom) / 2 }; }, position);
      await page.mouse.click(point.x, point.y); await stableProjection();
    }
    await page.keyboard.type('a'); await stableProjection(); await page.keyboard.press('Enter'); await stableProjection();
    await page.keyboard.type('**'); await stableProjection();
    await page.locator('.cm-content').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await page.keyboard.insertText('中文');
    await page.locator('.cm-content').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })));
    await page.evaluate(() => T.editor.whenInputSettled()); await stableProjection();
    let undoCount = 0;
    while (await snap() !== proseBefore && undoCount++ < 12) { await page.keyboard.press('Control+z'); await stableProjection(); }
    assert.equal(await snap(), proseBefore);
    for (let i = 0; i < undoCount; i++) { await page.keyboard.press('Control+y'); await stableProjection(); }
    for (let i = 0; i < undoCount; i++) { await page.keyboard.press('Control+z'); await stableProjection(); }
    await page.evaluate(() => proseObserver.disconnect());
    assert.equal(requests.filter(r => r.includes('/api/notes-canvas/read')).length, readsBeforeProse);
    assert.equal(await viewport.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    let a = await first.boundingBox(), b = await second.boundingBox();
    await page.keyboard.down('Alt'); await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    await page.evaluate(() => CanvasNoteWorkspace.flushSave(undefined, false, true));
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 }); await page.mouse.up(); await page.keyboard.up('Alt'); await settle();
    assert.equal(await frame.evaluate(el => el.__noteCanvas.session.data.edges.length), 1);
    assert.equal(await frame.locator('.note-canvas-live g').count(), 0, 'static edges stay out of SVG');
    // Multi-selection connects every source in one file-history transaction.
    await createNode(420, 55, '批量目标');
    const third=viewport.locator('.note-canvas-node').nth(2);
    await first.click();await second.click({modifiers:['Shift']});
    const batchHistory=await frame.evaluate(el=>el.__noteCanvas.session.past.length);
    async function batchConnect(cancel=false) {
      const from=await first.boundingBox(),to=await third.boundingBox();
      await page.keyboard.down('Alt');await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();
      await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:5});await settle();
      assert.equal(await frame.locator('.note-canvas-live > path').count(),2,'each selected source has a preview');
      if(cancel) await viewport.press('Escape');
      await page.mouse.up();await page.keyboard.up('Alt');await settle();
      assert.equal(await frame.locator('.note-canvas-live > path').count(),0,'previews release after finish or cancellation');
    }
    await batchConnect(true);assert.equal(await frame.evaluate(el=>el.__noteCanvas.session.past.length),batchHistory);
    // Escape deliberately clears the selection; restore both sources before
    // checking the next batch rather than relying on the canceled gesture.
    await first.click();await second.click({modifiers:['Shift']});
    await batchConnect();assert.equal(await frame.evaluate(el=>el.__noteCanvas.session.data.edges.length),3);
    assert.equal(await frame.evaluate(el=>el.__noteCanvas.session.past.length),batchHistory+1);
    await batchConnect();assert.equal(await frame.evaluate(el=>el.__noteCanvas.session.past.length),batchHistory+1,'duplicates do not add history');
    await viewport.press('Control+z');await settle();assert.equal(await frame.evaluate(el=>el.__noteCanvas.session.data.edges.length),1);
    await viewport.press('Control+y');await settle();assert.equal(await frame.evaluate(el=>el.__noteCanvas.session.data.edges.length),3);
    await viewport.press('Control+z');await viewport.press('Control+z');await settle();await first.click();
    const originalX = await frame.evaluate(el => el.__noteCanvas.session.data.nodes[0].x);
    a = await first.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 - 25, a.y + a.height / 2 + 12, { steps: 5 }); await settle();
    assert.equal(await frame.locator('.note-canvas-live g').count(), 1, 'drag attaches only adjacent SVG edges');
    await page.mouse.up(); await settle();
    assert.equal(await frame.evaluate(el => el.__noteCanvas.session.data.nodes[0].x), originalX - 25);
    assert.equal(await frame.locator('.note-canvas-live g').count(), 0);
    // Edit a line label by double-clicking its actual geometry.
    a = await first.boundingBox(); b = await second.boundingBox();
    const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 }, end = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await page.mouse.dblclick((start.x + end.x) / 2, (start.y + end.y) / 2);
    const edgeInput = viewport.locator('.note-canvas-edge-label textarea'); await edgeInput.waitFor(); await edgeInput.fill('连线文字'); await edgeInput.press('Control+Enter'); await settle();
    assert.equal(await viewport.locator('.note-canvas-edge-label').innerText(), '连线文字');
    // Rectangle selection and Shift selection operate on the shared model.
    let area = await viewport.boundingBox();
    await page.mouse.move(area.x + 5, area.y + 5); await page.mouse.down(); await page.mouse.move(area.x + 600, area.y + 340, { steps: 6 }); await page.mouse.up(); await settle();
    assert.equal(await viewport.locator('.note-canvas-node.is-selected').count(), 2);
    await viewport.press('Delete'); await settle(); assert.equal(await viewport.locator('.note-canvas-node').count(), 0);
    await viewport.press('Control+z'); await settle();
    await first.click(); await page.keyboard.down('Shift'); await second.click(); await page.keyboard.up('Shift');
    assert.equal(await viewport.locator('.note-canvas-node.is-selected').count(), 2);
    await viewport.click({ position: { x: 15, y: 15 } });
    // Delete and file history are owned by the active canvas.
    await second.click(); await viewport.press('Delete'); await settle();
    assert.equal(await viewport.locator('.note-canvas-node').count(), 1);
    await viewport.press('Control+z'); await settle();
    assert.equal(await viewport.locator('.note-canvas-node').count(), 2);
    await viewport.press('Control+y'); await settle(); await viewport.press('Control+z'); await settle();
    await page.evaluate(() => { const slider = document.querySelector('[data-role="note-canvas-node-scale"]'); slider.value = '200'; slider.dispatchEvent(new Event('input', { bubbles: true })); });
    await createNode(360, 35, '大节点');
    assert.equal(await frame.evaluate(el => el.__noteCanvas.session.data.nodes.at(-1).width), 320);
    assert.equal(await frame.evaluate(el => el.__noteCanvas.session.data.nodes[0].width), 160, 'slider never resizes existing nodes');
    await viewport.press('Control+z'); await settle();
    await page.evaluate(() => RelatumNotePreferences.resetCanvasNodeScale());
    // Moving the camera never rebuilds cached edge geometry.
    const before = await frame.evaluate(el => el.__noteCanvas.engine.stats().geometryBuilds);
    const box = await viewport.boundingBox(); await page.mouse.move(box.x + 300, box.y + 50); await page.mouse.wheel(0, -200); await settle();
    assert.equal(await frame.evaluate(el => el.__noteCanvas.engine.stats().geometryBuilds), before);
    await first.dblclick(); assert.equal(await viewport.locator('textarea').count(), 1); await viewport.locator('textarea').press('Escape');
    await page.keyboard.down('Space'); await page.mouse.down(); await page.mouse.move(box.x + 340, box.y + 80, { steps: 4 }); await page.mouse.up(); await page.keyboard.up('Space'); await settle();
    assert.equal(await frame.evaluate(el => el.__noteCanvas.engine.stats().geometryBuilds), before);
    // Container resizing belongs to Markdown history and preserves aspect.
    await viewport.click({ position: { x: 30, y: 25 } }); await settle();
    const handle = frame.locator('.note-live-image-resize-handle'), corner = await handle.boundingBox();
    await page.mouse.move(corner.x + 5, corner.y + 5); await page.mouse.down(); await page.mouse.move(corner.x - 115, corner.y - 60, { steps: 5 }); await page.mouse.up(); await settle();
    assert(/\|520x293\]/.test(await snap()), await snap());
    assert.equal(await frame.evaluate(el => el === proseFrame && el.__noteCanvas.engine === proseEngine), true, 'resizing reuses the engine');
    await first.dblclick(); assert.equal(await viewport.locator('.note-canvas-node').count(), 2); await viewport.locator('textarea').press('Escape');
    assert.equal(await CanvasFlush(page), true);
    const canvasPath = await frame.evaluate(el => el.__noteCanvas.session.path);
    const ref = await page.evaluate(() => MarkdownMini.canvasReferences(T.editor.snapshot().value)[0].parsed.source);
    const bPath = path.join(root, 'notes/Book/B.md'); fs.writeFileSync(bPath, '共享正文\n\n' + ref.replace('](canvases/', '](../canvases/'));
    await page.evaluate(() => T.setViewMode('source'));
    await page.evaluate(() => { window.nativePath2D = Path2D; window.Path2D = undefined; });
    await page.evaluate(() => T.setViewMode('live'));
    await frame.locator('.note-canvas-live [data-canvas-hit]').waitFor();
    assert.equal(await frame.locator('.note-canvas-live g').count(), 1, 'geometry capability fallback keeps SVG hit targets');
    assert.equal(await frame.locator('[data-canvas-hit]').evaluate(el => Math.abs(parseFloat(getComputedStyle(el).strokeWidth) - parseFloat(el.style.strokeWidth)) < .01), true, 'fallback hit width overrides visible line CSS');
    await frame.locator('.note-canvas-edge-label').dblclick();
    await frame.locator('textarea').waitFor(); await frame.locator('textarea').press('Escape');
    await page.evaluate(() => T.setViewMode('source'));
    await page.evaluate(() => { window.Path2D = nativePath2D; });
    await page.evaluate(() => T.setViewMode('live'));
    await page.waitForFunction(() => document.querySelector('.is-canvas .note-live-image-frame')?.__noteCanvas?.engine);
    // Preserve a real redo branch across successive renames.
    await page.evaluate(() => {
      const view = T.editor.view; view.dispatch({ changes: { from: view.state.doc.length, insert: '\n尾部' }, annotations: RelatumCodeMirror.Transaction.time.of(Date.now() + 3000), userEvent: 'input' });
      RelatumCodeMirror.undo(view);
    });
    async function rename(name) {
      await page.waitForFunction(() => document.querySelector('.is-canvas .note-live-image-frame')?.__noteCanvas?.session);
      await page.evaluate(() => { T.renameCanvas(document.querySelector('.is-canvas .note-live-image-frame').__noteCanvas); });
      const input = page.locator('.note-modal-card input'); await input.waitFor(); await input.fill(name); await input.press('Enter');
      await page.waitForFunction(name => !document.querySelector('.note-modal-card') && T.editor.snapshot().value.includes(name + '.canvas'), name);
      await page.waitForFunction(() => document.querySelector('.is-canvas .note-live-image-frame')?.__noteCanvas?.engine);
    }
    await rename('第一次'); await rename('最终画布');
    assert(!fs.existsSync(path.join(root, 'notes', canvasPath)));
    assert(fs.readFileSync(bPath, 'utf8').includes(encodeURIComponent('最终画布') + '.canvas'));
    await page.evaluate(() => RelatumCodeMirror.redo(T.editor.view)); assert((await snap()).endsWith('尾部'));
    await page.evaluate(() => RelatumCodeMirror.undo(T.editor.view));
    await page.evaluate(() => RelatumCodeMirror.undo(T.editor.view)); // resize
    assert((await snap()).includes('|640x360]'));
    await page.evaluate(() => RelatumCodeMirror.undo(T.editor.view)); // original insertion
    assert(!(await snap()).includes('.canvas'));
    await page.evaluate(() => RelatumCodeMirror.redo(T.editor.view)); assert((await snap()).includes('最终画布.canvas'));
    await page.evaluate(() => RelatumCodeMirror.redo(T.editor.view));
    await page.evaluate(() => RelatumCodeMirror.redo(T.editor.view));
    assert((await snap()).includes('最终画布.canvas|520x293]'));
    assert.equal(await CanvasFlush(page), true);
    await page.evaluate(() => T.setViewMode('source'));
    assert.equal(await page.locator('.is-canvas').count(), 0);
    assert((await page.locator('.cm-content').innerText()).includes('最终画布.canvas'));
    await page.evaluate(() => T.setViewMode('reading'));
    await page.waitForFunction(() => document.querySelector('.note-reading-content .note-canvas-viewport'));
    const reading = page.locator('.note-reading-content .note-canvas-viewport');
    const nodes = await reading.locator('.note-canvas-node').count(); await reading.dblclick({ position: { x: 20, y: 20 } });
    assert.equal(await reading.locator('.note-canvas-node').count(), nodes);
    assert.equal(await reading.locator('.note-live-image-resize-handle, textarea').count(), 0);
    assert.equal(await reading.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.evaluate(() => T.setViewMode('live'));
    await page.evaluate(() => T.openNote('Book/B.md'));
    await page.waitForFunction(() => document.querySelector('.is-canvas .note-live-image-frame')?.__noteCanvas?.engine);
    assert.equal(await frame.locator('.note-canvas-node').count(), 2);
    assert.equal(await page.evaluate(() => T.movePath('Book/B.md', 'B.md')), true);
    assert((await snap()).includes('](canvases/'));
    assert(!(await snap()).includes('../canvases/'));
    // Two visible references share file/history, but keep independent sizes.
    await page.evaluate(() => {
      const ref = MarkdownMini.canvasReferences(T.editor.snapshot().value)[0].parsed.source.replace('|520x293', '|320x180');
      T.editor.view.dispatch({ changes: { from: T.editor.view.state.doc.length, insert: '\n\n' + ref } });
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.is-canvas .note-live-image-frame')].filter(el => el.__noteCanvas?.engine).length === 2);
    assert.equal(await page.evaluate(() => { const refs = [...document.querySelectorAll('.is-canvas .note-live-image-frame')]; return refs[0].__noteCanvas.session === refs[1].__noteCanvas.session; }), true);
    await page.evaluate(() => { const s = document.querySelector('.is-canvas .note-live-image-frame').__noteCanvas.session; s.change({}, data => { data.nodes[0].text = '共享更新'; }, { nodes: [s.data.nodes[0].id] }); });
    assert.equal(await page.locator('.is-canvas .note-canvas-text').filter({ hasText: '共享更新' }).count(), 2);
    assert.deepEqual(await page.locator('.is-canvas .note-live-image-frame').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().width))), [520, 320]);
    assert.equal(await CanvasFlush(page), true);
    // Release all models on document departure, and no work on idle frames.
    await page.evaluate(() => T.openNote('A.md')); await page.waitForFunction(() => document.querySelector('.is-canvas .note-live-image-frame')?.__noteCanvas?.engine);
    const count = await page.evaluate(() => RelatumNoteCanvasSessions.sessions.size); assert.equal(count, 1);
    await settle(); await pause(100);
    assert.equal(await frame.evaluate(el => el.__noteCanvas.engine.stats().framesPending), false);
    const large = { version: 2, nodes: Array.from({ length: 1500 }, (_, i) => ({ id: 'n' + i, kind: 'index', x: (i % 50) * 200 - 5000, y: Math.floor(i / 50) * 110 - 1650, width: 160, height: 48, text: '节点 ' + i })), edges: Array.from({ length: 1499 }, (_, i) => ({ id: 'e' + i, from: 'n' + i, to: 'n' + (i + 1), curve: 'straight', text: '' })) };
    fs.writeFileSync(path.join(root, 'notes/canvases/large.canvas'), JSON.stringify(large));
    fs.writeFileSync(path.join(root, 'notes/Large.md'), Array(6).fill('![大画布|640x360](canvases/large.canvas)\n\n间隔\n\n').join(''));
    const readsBefore = requests.filter(r => r.includes('/api/notes-canvas/read')).length;
    await page.evaluate(() => T.openNote('Large.md'));
    await page.waitForFunction(() => document.querySelector('.is-canvas .note-live-image-frame')?.__noteCanvas?.engine?.stats().edges === 1499);
    assert.equal(requests.filter(r => r.includes('/api/notes-canvas/read')).length - readsBefore, 1, 'many embeds use one file read');
    assert.equal(await page.locator('.note-canvas-live g').count(), 0);
    const scrollBefore = await page.evaluate(() => T.editor.view.scrollDOM.scrollTop);
    await frame.hover(); await page.mouse.wheel(0, 80); await pause(120);
    assert((await page.evaluate(() => T.editor.view.scrollDOM.scrollTop)) > scrollBefore, 'inactive wheel scrolls the note');
    const largeBefore = await frame.evaluate(el => el.__noteCanvas.engine.stats().geometryBuilds);
    await frame.locator('.note-canvas-viewport').click({ position: { x: 15, y: 15 } });
    await page.mouse.wheel(0, -200); await settle();
    assert.equal(await frame.evaluate(el => el.__noteCanvas.engine.stats().geometryBuilds), largeBefore);
    // Measure actual hot-path work after all initial size observations settle.
    await settle(); await pause(60);
    await page.evaluate(() => {
      window.perf = { sizes: 0, indexes: 0 }; window.sizeDescriptors = {};
      for (const name of ['offsetWidth', 'offsetHeight']) { const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name); sizeDescriptors[name] = original;
        Object.defineProperty(HTMLElement.prototype, name, { ...original, get() { if (this.classList.contains('note-canvas-node')) perf.sizes++; return original.get.call(this); } }); }
      const s = document.querySelector('.is-canvas .note-live-image-frame').__noteCanvas.session;
      const reindex = s.reindex.bind(s); s.reindex = () => { perf.indexes++; return reindex(); };
    });
    const measuredNode = frame.locator('[data-canvas-node="n775"]'); await measuredNode.click(); await viewport.press('F2'); await settle(); await pause(40);
    await page.evaluate(() => { perf.sizes = perf.indexes = 0; });
    await viewport.locator('textarea').press('Escape'); await settle();
    assert.deepEqual(await page.evaluate(() => perf), { sizes: 0, indexes: 0 }, 'unchanged edit does no full rollback or measurements');
    const staticBeforeDrag = await frame.evaluate(el => el.__noteCanvas.engine.stats().staticDraws);
    const measured = await measuredNode.boundingBox();
    await page.mouse.move(measured.x + measured.width / 2, measured.y + measured.height / 2); await page.mouse.down();
    await page.mouse.move(measured.x + measured.width / 2 + 24, measured.y + measured.height / 2 + 10, { steps: 12 }); await page.mouse.up(); await settle();
    assert.deepEqual(await page.evaluate(() => perf), { sizes: 0, indexes: 0 }, 'moving uses cached dimensions and indexes');
    const dragStaticDraws = await frame.evaluate(el => el.__noteCanvas.engine.stats().staticDraws) - staticBeforeDrag;
    assert(dragStaticDraws <= 3, 'static edges only redraw at drag boundaries: ' + dragStaticDraws);
    const dragX = await frame.evaluate(el => el.__noteCanvas.session.nodes.get('n775').x), historyBeforeCancel = await frame.evaluate(el => el.__noteCanvas.session.past.length);
    const moved = await measuredNode.boundingBox(); await page.mouse.move(moved.x + 10, moved.y + 10); await page.mouse.down(); await page.mouse.move(moved.x + 35, moved.y + 20, { steps: 5 });
    await viewport.press('Escape'); await page.mouse.up(); await settle();
    assert.equal(await frame.evaluate(el => el.__noteCanvas.session.nodes.get('n775').x), dragX);
    assert.equal(await frame.evaluate(el => el.__noteCanvas.session.past.length), historyBeforeCancel);
    assert.equal(await page.evaluate(() => perf.indexes), 0);
    // Alt preview changes only its local SVG, not the static connection layer.
    const previewStart = await measuredNode.boundingBox(), previewArea = await viewport.boundingBox();
    const staticBeforePreview = await frame.evaluate(el => el.__noteCanvas.engine.stats().staticDraws);
    await page.keyboard.down('Alt'); await page.mouse.move(previewStart.x + previewStart.width / 2, previewStart.y + previewStart.height / 2); await page.mouse.down();
    await page.mouse.move(previewArea.x + previewArea.width - 10, previewArea.y + 8, { steps: 10 }); await settle();
    assert.equal(await frame.evaluate(el => el.__noteCanvas.engine.stats().staticDraws), staticBeforePreview);
    await viewport.press('Escape'); await page.mouse.up(); await page.keyboard.up('Alt'); await settle();
    await page.evaluate(() => { for (const [name, descriptor] of Object.entries(sizeDescriptors)) Object.defineProperty(HTMLElement.prototype, name, descriptor); });
    await page.evaluate(() => { window.oldEngine = document.querySelector('.is-canvas .note-live-image-frame').__noteCanvas.engine; T.editor.view.scrollDOM.scrollTop = T.editor.view.scrollDOM.scrollHeight; });
    await page.waitForFunction(() => oldEngine.stats().destroyed);
    assert.equal(await page.evaluate(() => oldEngine.stats().framesPending), false);
    await page.evaluate(() => T.openNote('A.md'));
    await page.waitForFunction(() => document.querySelector('.is-canvas .note-live-image-frame')?.__noteCanvas?.engine);
    assert.equal(await page.evaluate(() => RelatumNoteCanvasSessions.sessions.size), 1, 'clean large models released on departure');
    // Verify sidebar language, neutral theme feedback and narrow-window layout.
    if (!await page.evaluate(() => document.querySelector('.note-workspace').classList.contains('links-overlay-open'))) await page.locator('[data-note-action="toggle-notebooks"]').click();
    await page.locator('[data-note-action="side-canvas"]').click();
    await page.evaluate(() => RelatumI18n.setLanguage('en')); await settle();
    assert.equal(await settings.locator('#note-canvas-settings-title').innerText(), 'Canvas settings');
    await frame.locator('.note-canvas-node').first().click();
    assert.equal(await settings.locator('[data-canvas-group="node"] button[aria-label="Diamond"]').count(), 1);
    await page.evaluate(() => RelatumI18n.setLanguage('zh')); await settle();
    assert.equal(await settings.locator('[data-canvas-group="node"] button[aria-label="菱形"]').count(), 1);
    await page.screenshot({ path: path.join(root, 'canvas-light-settings.png') });
    await page.evaluate(() => { document.documentElement.dataset.startTheme = document.body.dataset.startTheme = 'dark'; }); await settle();
    assert.equal(await viewport.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    await frame.locator('.note-canvas-node').first().click();
    const darkFeedback = await frame.locator('.note-canvas-node').first().evaluate(el => ({ fill: getComputedStyle(el.querySelector('.note-canvas-fill')).fill, ring: getComputedStyle(el.querySelector('.note-canvas-selection-outline')).stroke }));
    assert.equal(darkFeedback.fill, 'rgb(32, 32, 32)'); assert(darkFeedback.ring.includes('255, 255, 255'));
    await page.setViewportSize({ width: 940, height: 800 }); await settle();
    const settingsBox = await settings.boundingBox(); assert(settingsBox.width <= 300 && settingsBox.x >= 0 && settingsBox.x + settingsBox.width <= 940);
    await page.screenshot({ path: path.join(root, 'canvas-dark-narrow.png') });
    await page.setViewportSize({ width: 1600, height: 960 });
    await page.evaluate(() => { document.documentElement.dataset.startTheme = document.body.dataset.startTheme = 'light'; });
    await page.locator('[data-note-action="close-links"]').click(); await settle();
    // External revision conflict retains the local model and blocks switching.
    const file = await frame.evaluate(el => el.__noteCanvas.session.path);
    const diskPath = path.join(root, 'notes', file), external = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
    external.nodes[0].text = '外部修改'; fs.writeFileSync(diskPath, JSON.stringify(external));
    await page.evaluate(() => { const s = document.querySelector('.is-canvas .note-live-image-frame').__noteCanvas.session; s.change({}, data => { data.nodes[0].text = '待保存草稿'; }, { nodes: [s.data.nodes[0].id] }); });
    assert.equal(await page.evaluate(() => T.openNote('B.md')), false);
    assert.equal(await page.evaluate(() => CanvasNoteWorkspace.currentPath), 'A.md');
    assert.equal(await frame.locator('.note-canvas-text').first().innerText(), '待保存草稿');
    assert.equal(await page.evaluate(() => CanvasNoteWorkspace.dirty), true);
    await settle(); await pause(80);
    assert.deepEqual(errors, []);
    assert.equal(requests.filter(r => /\/canvas\.js(?:\?|$)/.test(r)).length, 0, 'notes plugin never imports the main canvas singleton');
    await page.screenshot({ path: path.join(root, 'canvas.png') });
    return { enabled, nodes: 2, geometryBuilds: before, proseProjectionChanges: 0, noOpMeasurements: 0, dragMeasurements: 0, dragIndexRebuilds: 0, dragStaticDraws, screenshot: path.join(root, 'canvas.png') };
  } catch (error) {
    if (page) console.error('Diagnostics', JSON.stringify(await page.evaluate(() => ({ value: window.T?.editor?.snapshot().value,
      canvases: [...document.querySelectorAll('.is-canvas .note-live-image-frame')].map(el => ({
        stats: el.__noteCanvas?.engine?.stats(), nodes: el.__noteCanvas?.session?.data.nodes.length, edges: el.__noteCanvas?.session?.data.edges.length,
      })), active: document.activeElement?.className })).catch(() => null)));
    throw error;
  } finally { await context.close(); server.kill(); }
}
function CanvasFlush(page) { return page.evaluate(() => CanvasNoteWorkspace.flushSave()); }
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  try { console.log(JSON.stringify([await run(browser, true), await run(browser, false), await run(browser, true, true)], null, 2)); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
