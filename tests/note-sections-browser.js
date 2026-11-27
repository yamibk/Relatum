'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');

const repo = path.resolve(__dirname, '..');
const native = process.argv.includes('--webview2');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fence = '`'.repeat(3);
const reference = '![[Papers/Source#Methods]]';
const review = ['# Review', '## Background', reference, reference, '## Next', 'Keep this visible.', '[[Papers/Source#Methods]]', ''].join('\n\n');
const boundarySource = ['前文', reference, '后文'].join('\n\n');
const annotated = Buffer.from(JSON.stringify({ items: [{ id: 'label', x: .5, y: .5, color: 'white', size: 'md', text: 'Image annotation' }] })).toString('base64url');
const original = ['# Study', '', 'Methods', '-------', '', 'Original method.', '',
  '![Sample|120x60](Source.assets/images/sample.png) <!--relatum:image-text:v1:' + annotated + '-->', '',
  '![[Source.assets/images/vector.svg|180]]', '', '> [!media]', '> ![Diagram|240](Source.assets/images/vector.svg)', '>', '> Diagram explanation.', '',
  '| Setting | Value |', '| --- | --- |', '| Gain | 2 |', '', '$x^2$', '',
  '![Missing](Source.assets/images/missing.png)', '', '![Remote](https://example.invalid/no-request.png)', '',
  '### Child', '', 'Nested text.', '', fence + 'database records', fence, '', fence + 'pdf-embed 2355875c-6648-4c4e-acd7-69a6514840de', fence, '',
  '![[canvases/Example.canvas]]', '', '![[Review#Next]]', '', '## Results', '', 'Excluded result.'].join('\n');

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-sections-'));
  const notes = path.join(root, 'notes'), papers = path.join(notes, 'Papers');
  const images = path.join(papers, 'Source.assets', 'images');
  fs.mkdirSync(images, { recursive: true });
  fs.writeFileSync(path.join(notes, 'Review.md'), review);
  fs.writeFileSync(path.join(notes, 'Boundaries.md'), boundarySource);
  fs.writeFileSync(path.join(notes, 'Long.md'), [reference, ...Array.from({ length: 120 }, (_, i) => 'Paragraph ' + i), reference].join('\n\n'));
  fs.writeFileSync(path.join(papers, 'Source.md'), original);
  fs.mkdirSync(path.join(notes, 'canvases'));
  fs.writeFileSync(path.join(notes, 'canvases', 'Example.canvas'), '{"version":2,"nodes":[],"edges":[]}');
  fs.writeFileSync(path.join(notes, 'Canvas.md'), '![[canvases/Example.canvas|320x220]]\n');
  fs.writeFileSync(path.join(images, 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xv4QAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(path.join(images, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect width="400" height="200" fill="teal"/></svg>');
  const ownerImages = path.join(notes, 'Source.assets', 'images');
  fs.mkdirSync(ownerImages, { recursive: true });
  fs.writeFileSync(path.join(ownerImages, 'sample.png'), 'Broken image at the same relative path in the referencing note');
  const port = await freePort(), debug = native ? await freePort() : 0;
  const cdpOrigin = 'http://127.0.0.1:' + debug;
  let url = 'http://127.0.0.1:' + port;
  const python = process.env[native ? 'RELATUM_WEBVIEW_PYTHON' : 'RELATUM_PYTHON'] || 'python';
  const server = spawn(python, native ? ['-B', 'desktop.py'] : ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root,
      ...(native ? { LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debug } : {}) },
    windowsHide: true });
  const exited = new Promise(resolve => server.once('exit', resolve));
  let browser, context, page, logs = '';
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { logs = (logs + data).slice(-12000); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200 && !ready; attempt++) {
      try { ready = (await fetch(native ? cdpOrigin + '/json/version' : url + '/api/runtime')).ok; } catch (_) {}
      if (!ready) await pause(100);
    }
    assert(ready, logs || 'isolated note host did not start');
    if (native) {
      browser = await chromium.connectOverCDP(cdpOrigin);
      context = browser.contexts()[0];
      for (let attempt = 0; attempt < 100 && !page; attempt++) {
        page = context.pages().find(item => item.url().startsWith('http://127.0.0.1'));
        if (!page) await pause(100);
      }
      assert(page, logs || 'WebView2 did not open a note host');
      url = page.url();
      await page.setViewportSize({ width: 1440, height: 1050 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
    } else {
      browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
      context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
      page = await context.newPage();
    }
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
    await context.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteHeadingFolding:v1', 'always');
      if (!localStorage.getItem('canvas:noteActivePath:v1')) localStorage.setItem('canvas:noteActivePath:v1', 'Review.md');
      if (!localStorage.getItem('canvas:noteOpenTabs:v1')) {
        localStorage.setItem('canvas:noteOpenTabs:v1', '["Review.md"]');
        localStorage.setItem('canvas:noteActiveTab:v1', 'Review.md');
        localStorage.setItem('canvas:noteActivePath:v1', 'Review.md');
      }
    });
    page.setDefaultTimeout(12000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error));
    page.on('request', item => requests.push(new URL(item.url())));
    const workspace = fs.readFileSync(path.join(repo, 'assets', 'note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = { state, setViewMode, openNote, jumpToHeading, triggerExternalSync, persistViewStates, flushSave, get editor() { return liveEditor; } };\n  window.CanvasNoteWorkspace = {');
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
    await cards.first().scrollIntoViewIfNeeded();
    await cards.first().getByText('Original method.').waitFor();
    assert.equal(await cards.first().getByText('Excluded result.').count(), 0);
    assert.equal(await cards.first().locator('.note-section-placeholder').count(), 4);
    assert.equal(await cards.first().locator('iframe, [data-pdf-embed-id], [data-database-id]').count(), 0);
    await cards.first().locator('mjx-container').waitFor();
    const checkMedia = async card => {
      for (const [target, width, naturalWidth] of [['sample.png', 120, 1], ['vector.svg', 180, 400]]) {
        const image = card.locator('img[data-note-image$="' + target + '"]').first();
        await image.scrollIntoViewIfNeeded();
        const element = await image.elementHandle();
        await page.waitForFunction(({ element, width }) => element.offsetWidth === width && element.naturalWidth > 0, { element, width });
        assert.equal(await image.evaluate(node => node.naturalWidth), naturalWidth);
        assert.equal(await image.evaluate(node => node.offsetWidth), width);
      }
      const annotation = card.getByText('Image annotation', { exact: true });
      await annotation.waitFor();
      assert((await annotation.evaluate(node => getComputedStyle(node).getPropertyValue('--note-image-text-unit'))).trim());
      await card.locator('.note-media').getByText('Diagram explanation.').waitFor();
      await card.locator('table').getByText('Gain').waitFor();
      const missing = card.locator('.md-local-image[data-note-image-wrap$="missing.png"]');
      await missing.scrollIntoViewIfNeeded();
      await missing.getByText(/图片不存在|Image not found/).waitFor();
      assert(!requests.some(request => request.host === 'example.invalid'));
    };
    await checkMedia(cards.first());

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
    await checkMedia(reading.locator('.note-section-reference').first());
    await page.setViewportSize({ width: 490, height: 900 });
    const narrowMedia = reading.locator('.note-section-reference .note-media').first();
    await narrowMedia.scrollIntoViewIfNeeded();
    const narrowLayout = await narrowMedia.evaluate(node => {
      const image = node.querySelector('.note-media-image').getBoundingClientRect();
      const body = node.querySelector('.note-media-body').getBoundingClientRect();
      return { wraps: body.top >= image.bottom, spills: node.scrollWidth > node.clientWidth + 1 };
    });
    assert.deepEqual(narrowLayout, { wraps: true, spills: false });
    await page.setViewportSize({ width: 1440, height: 1050 });
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

    await page.evaluate(() => T.openNote('Long.md', { reuseActiveTab: false }));
    await reading.getByText('Updated method.').first().waitFor();
    const longCards = reading.locator('.note-section-reference');
    const scroller = await reading.elementHandle();
    const initialHeight = (await longCards.first().boundingBox()).height;
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await longCards.last().getByText('Updated method.').waitFor();
    await page.waitForFunction(() => document.querySelector('.note-reading-content .note-section-reference .note-section-content')?.childElementCount === 0);
    assert((await longCards.first().boundingBox()).height >= initialHeight - 2);
    const readScrollTop = await scroller.evaluate(node => node.scrollTop);
    await page.evaluate(() => {
      document.documentElement.dataset.desktopMinimized = '1';
      window.dispatchEvent(new Event('canvasdesktop:visibility'));
    });
    await longCards.last().getByText('Updated method.').waitFor({ state: 'detached' });
    await page.evaluate(() => {
      delete document.documentElement.dataset.desktopMinimized;
      window.dispatchEvent(new Event('canvasdesktop:visibility'));
    });
    await longCards.last().getByText('Updated method.').waitFor();
    assert(Math.abs(await scroller.evaluate(node => node.scrollTop) - readScrollTop) < 30);

    await page.evaluate(() => T.setViewMode('live'));
    await page.evaluate(() => T.openNote('Boundaries.md', { reuseActiveTab: false }));
    const value = () => page.evaluate(() => T.editor.snapshot().value);
    const head = () => page.evaluate(() => T.editor.view.state.selection.main.head);
    const sourceLines = editor.locator('.cm-content > .cm-line');
    const cdp = await context.newCDPSession(page);
    const clickLine = async index => {
      const line = sourceLines.nth(index);
      await line.scrollIntoViewIfNeeded();
      const { x, y, height } = await line.boundingBox();
      await page.mouse.click(x + 1, y + height / 2);
      const caret = await page.evaluate(() => {
        const view = T.editor.view;
        const rect = view.coordsAtPos(view.state.selection.main.head);
        return rect && { y: (rect.top + rect.bottom) / 2 };
      });
      assert(caret && caret.y >= y && caret.y <= y + height, 'caret is on the clicked editable line');
    };
    const resetSection = async (source, at = 0) => {
      await page.evaluate(({ source, at }) => {
        T.editor.setDocument({ value: source, notePath: T.state.current.path, anchor: at, head: at });
        T.editor.focus();
      }, { source, at });
      await cards.first().waitFor();
    };

    await cards.first().waitFor();
    assert.deepEqual(await sourceLines.allTextContents(), ['前文', '', '', '后文']);
    await clickLine(1);
    assert.equal(await head(), '前文\n'.length);
    await page.keyboard.press('Delete');
    assert.equal(await value(), boundarySource);
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    assert.equal(await value(), boundarySource);
    await cdp.send('Input.insertText', { text: '中' });
    await page.waitForFunction(() => T.editor.snapshot().value.startsWith('前文\n中\n'));
    await clickLine(2);
    await page.keyboard.press('Backspace');
    assert.equal(await value(), boundarySource.replace('前文\n\n', '前文\n中\n'));
    await page.evaluate(() => navigator.clipboard.writeText('Pasted below'));
    await page.keyboard.press('Control+v');
    const saved = boundarySource.replace('前文\n\n', '前文\n中\n').replace('\n\n后文', '\nPasted below\n后文');
    assert.equal(await value(), saved);
    assert.equal(await page.evaluate(() => T.flushSave()), true);
    assert.equal(fs.readFileSync(path.join(notes, 'Boundaries.md'), 'utf8'), saved);
    await page.keyboard.press('Control+z');
    assert.equal(await value(), saved.replace('Pasted below', ''));

    const packed = ['Above', reference, reference, 'Below'].join('\n');
    await resetSection(packed);
    assert.deepEqual(await sourceLines.allTextContents(), ['Above', 'Below']);
    await clickLine(0);
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowRight');
    assert.equal(await head(), packed.indexOf('Below'));
    await page.keyboard.type('2');
    assert.equal(await value(), packed.replace('Below', '2Below'));
    await resetSection(packed);
    await clickLine(0);
    await page.keyboard.press('ArrowDown');
    assert.equal(await head(), packed.indexOf('Below'));
    await page.keyboard.press('ArrowUp');
    assert.equal(await head(), 0);

    for (const side of ['before', 'after']) {
      await resetSection(reference);
      assert.equal(await sourceLines.count(), 0);
      await cards.first().locator('[data-note-section-action="' + side + '"]').focus();
      await page.keyboard.press('Enter');
      const withLine = side === 'before' ? '\n' + reference : reference + '\n';
      assert.equal(await value(), withLine);
      assert.equal(await sourceLines.count(), 1);
      await clickLine(0);
      await page.keyboard.type('1');
      assert.equal(await value(), side === 'before' ? '1\n' + reference : reference + '\n1');
      await page.keyboard.press('Control+z');
      assert.equal(await value(), withLine);
      await page.keyboard.press('Control+z');
      assert.equal(await value(), reference);
    }
    await resetSection(reference);
    await cards.first().locator('[data-note-section-action="edit"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await cards.count(), 0);
    assert.equal(await sourceLines.first().textContent(), reference);
    await page.keyboard.press('End');
    await cards.first().waitFor();
    assert.equal(await value(), reference);

    for (const before of [true, false]) {
      await resetSection(reference, before ? 0 : reference.length);
      await page.keyboard.type('a');
      assert.equal(await value(), before ? 'a\n' + reference : reference + '\na');
    }

    const resetFold = async (source, title) => {
      await page.evaluate(value => {
        T.editor.setDocument({ value, notePath: T.state.current.path, anchor: 0, head: 0 });
        T.editor.focus();
      }, source);
      const heading = editor.locator('.cm-line').filter({ hasText: title });
      const arrow = heading.locator('.note-heading-fold');
      await arrow.click();
      const marker = heading.locator('.note-heading-ellipsis');
      await marker.waitFor();
      assert.equal(await arrow.getAttribute('aria-expanded'), 'false');
      return { heading, marker, arrow };
    };
    const consecutive = '# First\nAlpha\n# Next\nBeta';
    const first = await resetFold(consecutive, 'First');
    assert.deepEqual(await editor.locator('.cm-line').allTextContents(), ['# First…', 'Next', 'Beta']);
    const markerBox = await first.marker.boundingBox();
    await page.mouse.click(markerBox.x + markerBox.width + 2, markerBox.y + markerBox.height / 2);
    assert.equal(await page.evaluate(() => T.editor.view.state.selection.main.head), consecutive.indexOf('\n# Next'));
    assert.equal(await first.arrow.getAttribute('aria-expanded'), 'false');
    await page.keyboard.type('!');
    assert.equal(await value(), consecutive.replace('Alpha', 'Alpha!'));
    assert.equal(await first.arrow.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Control+z');
    assert.equal(await value(), consecutive);
    assert.equal(await first.arrow.getAttribute('aria-expanded'), 'true');

    const atEnd = '# Final\n\nExisting text';
    const last = await resetFold(atEnd, 'Final');
    assert.equal(await editor.locator('.cm-line').count(), 1);
    await page.evaluate(() => T.editor.view.dispatch({ selection: { anchor: T.editor.view.state.doc.line(1).to } }));
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => T.editor.view.state.selection.main.head), atEnd.length);
    await page.keyboard.press('Backspace');
    assert.equal(await value(), atEnd);
    assert.equal(await last.arrow.getAttribute('aria-expanded'), 'true');

    const underlined = 'Setext\n------\n\nText here\n# Next\nBeta';
    const setext = await resetFold(underlined, 'Setext');
    assert.deepEqual(await editor.locator('.cm-line').allTextContents(), ['Setext…', 'Next', 'Beta']);
    await setext.marker.click();
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    assert.equal(await setext.arrow.getAttribute('aria-expanded'), 'true');
    assert.equal(await value(), underlined, 'preedit stays out of the committed snapshot');
    await cdp.send('Input.insertText', { text: '中' });
    await page.waitForFunction(() => T.editor.snapshot().value.includes('Text here中'));
    assert.equal(await value(), underlined.replace('Text here', 'Text here中'));

    const pasted = await resetFold(atEnd, 'Final');
    await pasted.marker.click();
    await page.evaluate(() => navigator.clipboard.writeText(' pasted'));
    await page.keyboard.press('Control+v');
    assert.equal(await value(), atEnd + ' pasted');
    const entered = await resetFold(consecutive, 'First');
    await entered.marker.click();
    await page.keyboard.press('Enter');
    assert.equal(await value(), consecutive.replace('Alpha', 'Alpha\n'));
    await page.evaluate(() => T.openNote('Canvas.md', { reuseActiveTab: false }));
    await editor.locator('[data-canvas-source="canvases/Example.canvas"]').waitFor();
    await page.evaluate(() => T.setViewMode('reading'));
    await reading.locator('[data-canvas-source="canvases/Example.canvas"]').waitFor();
    assert(!requests.some(item => item.pathname === '/api/note-asset' && item.searchParams.get('src')?.endsWith('.canvas')));
    assert.deepEqual(errors.map(error => error.stack), []);
  } finally {
    if (native && page && server.exitCode === null) {
      await page.evaluate(() => { void window.pywebview?.api?.close_window(); }).catch(() => {});
      await Promise.race([exited, pause(3000)]);
    }
    await browser?.close().catch(() => {});
    if (server.exitCode === null && !server.signalCode) {
      server.kill();
      await Promise.race([exited, pause(2000)]);
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('relatum-sections-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

run().then(() => console.log('note sections ' + (native ? 'WebView2' : 'browser') + ': ok')).catch(error => { console.error(error); process.exitCode = 1; });
