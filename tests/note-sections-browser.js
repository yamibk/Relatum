'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');

const repo = path.resolve(__dirname, '..');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fence = '`'.repeat(3);
const review = '# Review\n\n## Background\n\n![[Papers/Source#Methods]]\n\n![[Papers/Source#Methods]]\n\n## Next\n\nKeep this visible.\n\n[[Papers/Source#Methods]]\n';
const original = ['# Study', '', 'Methods', '-------', '', 'Original method.', '', '![Sample](sample.png)', '', '$x^2$', '',
  '### Child', '', 'Nested text.', '', fence + 'database records', fence, '', '![[Review#Next]]', '', '## Results', '', 'Excluded result.'].join('\n');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-sections-'));
  const notes = path.join(root, 'notes'), papers = path.join(notes, 'Papers');
  fs.mkdirSync(papers, { recursive: true });
  fs.writeFileSync(path.join(notes, 'Review.md'), review);
  fs.writeFileSync(path.join(papers, 'Source.md'), original);
  fs.writeFileSync(path.join(papers, 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xv4QAAAAASUVORK5CYII=', 'base64'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) { await pause(100); }
    }
    assert(ready);
    browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await context.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteHeadingFolding:v1', 'always');
      if (!localStorage.getItem('canvas:noteOpenTabs:v1')) {
        localStorage.setItem('canvas:noteOpenTabs:v1', '["Review.md"]');
        localStorage.setItem('canvas:noteActiveTab:v1', 'Review.md');
        localStorage.setItem('canvas:noteActivePath:v1', 'Review.md');
      }
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error));
    page.on('request', item => requests.push(new URL(item.url())));
    const workspace = fs.readFileSync(path.join(repo, 'assets', 'note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = { state, setViewMode, openNote, jumpToHeading, triggerExternalSync, persistViewStates, get editor() { return liveEditor; } };\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: workspace }));
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.current?.path === 'Review.md' && T.editor);
    const editor = page.locator('[data-role="note-editor"]');
    const cards = editor.locator('.note-section-reference');
    try { await cards.first().getByText('Original method.').waitFor({ timeout: 8000 }); }
    catch (error) {
      console.error({ editor: await editor.textContent(), viewMode: await page.evaluate(() => T.state.viewMode),
        requests: requests.filter(item => item.pathname.startsWith('/api/note')).map(item => item.pathname + item.search), errors });
      throw error;
    }
    await cards.nth(1).scrollIntoViewIfNeeded();
    try { await cards.nth(1).getByText('Original method.').waitFor(); }
    catch (error) {
      console.error({ boxes: await cards.evaluateAll(nodes => nodes.map(node => ({ text: node.innerText, bounds: node.getBoundingClientRect().toJSON() }))), errors });
      throw error;
    }
    assert.equal(requests.filter(item => item.pathname === '/api/note-links' && item.searchParams.has('target')).length, 1);
    assert.equal(requests.filter(item => item.pathname === '/api/note' && item.searchParams.get('path') === 'Papers/Source.md').length, 1);
    assert(requests.some(item => item.pathname === '/api/note-asset' && item.searchParams.get('note') === 'Papers/Source.md'));
    assert.equal(await cards.first().getByText('Excluded result.').count(), 0);
    assert.equal(await cards.first().locator('.note-section-placeholder').count(), 2);
    await cards.first().locator('mjx-container').waitFor();

    const foldOn = (surface, title) => surface.locator('.cm-line, [data-note-heading-from]').filter({ hasText: title }).locator('.note-heading-fold');
    const background = foldOn(editor, 'Background');
    await background.click();
    await cards.first().waitFor({ state: 'detached' });
    assert.equal(await background.getAttribute('aria-expanded'), 'false');
    assert.equal(fs.readFileSync(path.join(notes, 'Review.md'), 'utf8'), review);
    await page.evaluate(() => T.persistViewStates());
    await page.reload();
    await page.waitForFunction(() => window.T?.state.current?.path === 'Review.md' && T.editor);
    await background.waitFor();
    assert.equal(await background.getAttribute('aria-expanded'), 'false');
    assert.equal(await cards.count(), 0);

    await page.evaluate(() => T.setViewMode('source'));
    assert.equal(await editor.locator('.note-heading-fold').count(), 0);
    assert((await editor.locator('.cm-content').innerText()).includes('![[Papers/Source#Methods]]'));
    await page.evaluate(() => T.setViewMode('reading'));
    const reading = page.locator('[data-role="note-reading-view"]');
    const readingFold = foldOn(reading, 'Background');
    await readingFold.waitFor();
    assert.equal(await readingFold.getAttribute('aria-expanded'), 'false');
    await readingFold.focus(); await page.keyboard.press('Enter');
    await reading.getByText('Original method.').first().waitFor();
    await reading.locator('.note-section-source').first().click();
    await page.waitForFunction(() => T.state.current?.path === 'Papers/Source.md');
    await reading.getByRole('heading', { name: 'Methods', exact: true }).waitFor();
    const methods = foldOn(reading, 'Methods'), child = foldOn(reading, 'Child');
    await child.click(); await methods.click();
    assert.equal(await page.evaluate(() => T.jumpToHeading('Child')), true);
    assert.equal(await methods.getAttribute('aria-expanded'), 'true');
    assert.equal(await child.getAttribute('aria-expanded'), 'false');
    await child.click();
    await reading.getByText('Nested text.').waitFor();
    await reading.getByRole('heading', { name: 'Methods', exact: true }).click({ button: 'right' });
    await page.locator('[data-role="note-context-menu"] button').filter({ hasText: /复制章节链接|Copy section link/ }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(link, '[[Papers/Source#Methods]]');

    await page.evaluate(() => T.openNote('Review.md', { reuseActiveTab: false }));
    await reading.getByText('Original method.').first().waitFor();
    fs.writeFileSync(path.join(papers, 'Source.md'), original.replace('Original method.', 'Updated method.'));
    await page.waitForFunction(async () => {
      await T.triggerExternalSync({ metadataOnly: true, background: true });
      return document.querySelector('.note-reading-content')?.textContent.includes('Updated method.');
    });
    await reading.locator('[data-wikilink="' + link.slice(2, -2) + '"]').click();
    await page.waitForFunction(() => T.state.current?.path === 'Papers/Source.md');
    await reading.getByRole('heading', { name: 'Methods', exact: true }).waitFor();

    const printed = await page.evaluate(source => {
      const host = document.createElement('div');
      return RelatumNoteLiveEditor.renderMarkdown(host, source, 'Review.md', { print: true }).content.textContent;
    }, review);
    assert(printed.includes('Papers/Source › Methods') && printed.includes('Keep this visible.'));
    assert(!printed.includes('Updated method.'));
    assert.deepEqual(errors.map(error => error.stack), []);
  } finally {
    await browser?.close();
    server.kill();
    if (server.exitCode == null) await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(1000)]);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().then(() => console.log('note sections browser: ok')).catch(error => { console.error(error); process.exitCode = 1; });
