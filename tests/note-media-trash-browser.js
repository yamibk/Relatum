'use strict';

// One production page, disposable files and a local recycle substitute.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-media-browser-'));
const note = 'CustomNotebook/Test/A.md';
const image = 'A.assets/images/shared.png';
const readerImage = 'A.assets/images/reader.png';
const canvas = 'canvases/shared.canvas';
const embed = `![shared|500x220](../../${canvas})`;
const source = `😀 before ![one](${image}) after\n\n![[${image}|80]]\n\n![reader|80](${readerImage})\n\n${embed}\n\n${embed}\n\nend`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
fs.mkdirSync(path.join(root, 'notes', 'CustomNotebook/Test/A.assets/images'), { recursive: true });
fs.mkdirSync(path.join(root, 'notes', 'canvases'), { recursive: true });
fs.mkdirSync(path.join(root, 'recycled'));
fs.writeFileSync(path.join(root, 'notes', note), source);
fs.writeFileSync(path.join(root, 'notes', 'CustomNotebook/Test/B.md'), source);
for (const name of ['shared', 'reader']) fs.writeFileSync(path.join(root, 'notes', `CustomNotebook/Test/A.assets/images/${name}.png`), png);
fs.writeFileSync(path.join(root, 'notes', canvas), JSON.stringify({ version: 2, nodes: [], edges: [] }));

(async () => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const helper = 'import app,shutil; from pathlib import Path; ' +
    'app._move_paths_to_recycle_bin=lambda targets: [shutil.move(str(p),str(Path(app.ROOT)/"recycled"/p.name)) for p in targets]; ' +
    'app.main()';
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', '-c', helper, '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '', browser;
  service.stdout.on('data', value => { logs += value; });
  service.stderr.on('data', value => { logs += value; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'isolated server starts: ' + logs);
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const script = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.__mediaTest = {state, openNote, setViewMode, flushSave, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: script }));
    await page.goto(url);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => window.__mediaTest?.state.initialized && __mediaTest.state.active && !__mediaTest.state.openingPath);
    await page.evaluate(note => __mediaTest.openNote(note), note);
    const menu = page.locator('[data-role="note-context-menu"]');
    const recycle = () => menu.getByRole('menuitem', { name: '移到系统回收站', exact: true });
    const value = () => page.evaluate(() => __mediaTest.editor.snapshot().value);
    async function remove(selector) {
      await page.locator(selector).first().click({ button: 'right' });
      await menu.waitFor({ state: 'visible' });
      assert(await recycle().evaluate(button => button.classList.contains('danger')));
      const response = page.waitForResponse(response => /\/(?:note-image-trash|notes-canvas\/trash)$/.test(new URL(response.url()).pathname));
      await recycle().click();
      const result = await response;
      assert(result.ok(), await result.text());
      await page.waitForFunction(() => !document.querySelector('.note-workspace').inert);
    }
    await page.locator('.cm-content .note-live-image-frame:not(.note-canvas-frame)').first().click({ button: 'right' });
    await menu.waitFor({ state: 'visible' });
    await page.route('**/api/note-image-trash', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"recycle denied"}' }));
    await recycle().click();
    await page.waitForFunction(() => document.querySelector('[data-role="note-toast"]')?.textContent.includes('recycle denied'));
    assert.equal(await value(), source, 'failed recycle preserves editor');
    assert.equal(fs.readFileSync(path.join(root, 'notes', note), 'utf8'), source);
    await page.unroute('**/api/note-image-trash');

    await remove('.cm-content .note-live-image-frame:not(.note-canvas-frame)');
    const noImage = source.replace(`![one](${image})`, '').replace(`![[${image}|80]]`, '');
    assert.equal(await value(), noImage, 'all aliases removed in one operation');
    assert(!fs.existsSync(path.join(root, 'notes', 'CustomNotebook/Test', image)));
    await page.evaluate(() => RelatumCodeMirror.undo(__mediaTest.editor.view));
    assert.equal(await value(), source, 'one undo restores all syntax');
    assert(!fs.existsSync(path.join(root, 'notes', 'CustomNotebook/Test', image)), 'undo never restores a file');
    await page.evaluate(() => RelatumCodeMirror.redo(__mediaTest.editor.view));
    await page.evaluate(() => __mediaTest.flushSave());

    await page.evaluate(() => __mediaTest.setViewMode('reading'));
    await remove('[data-role="note-reading-view"] .md-local-image');
    const noImages = noImage.replace(`![reader|80](${readerImage})`, '');
    assert.equal(await value(), noImages, 'reading image removal updates the hidden editor');
    assert.equal(fs.readFileSync(path.join(root, 'notes', note), 'utf8'), noImages);
    await page.evaluate(() => __mediaTest.setViewMode('live'));
    await page.waitForFunction(() => [...document.querySelectorAll('.note-canvas-frame')].some(frame => frame.__noteCanvas?.session));
    await page.evaluate(() => { window.oldMediaSession = document.querySelector('.note-canvas-frame').__noteCanvas.session; });
    await remove('.cm-content .note-canvas-frame');
    const expected = noImages.replaceAll(embed, '');
    assert.equal(await value(), expected, 'all canvas embeds removed');
    await page.evaluate(async () => { oldMediaSession.generation++; await oldMediaSession.flush(); await __mediaTest.flushSave(); });
    assert(!fs.existsSync(path.join(root, 'notes', canvas)), 'old canvas autosave cannot recreate a recycled file');
    assert.equal(await page.locator('.note-canvas-frame').count(), 0);
    assert.equal(fs.readFileSync(path.join(root, 'notes', 'CustomNotebook/Test/B.md'), 'utf8'), source, 'other notes remain byte-identical');
    assert.equal(fs.readFileSync(path.join(root, 'notes', note), 'utf8'), expected);
    await page.evaluate(note => __mediaTest.openNote(note, { force: true }), note);
    assert.equal(await value(), expected, 'reopen keeps the saved cleanup');
    await page.screenshot({ path: path.join(root, 'media-trash.png') });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, artifacts: root }));
  } finally {
    if (browser) await browser.close();
    service.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
