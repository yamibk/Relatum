'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const { features } = require('../assets/feature-catalog.json');

const args = process.argv.slice(2);
const native = args.includes('--webview2');
const notesOnly = args.includes('--notes-only');
const repo = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-pdf-embed-'));
const notes = path.join(root, 'notes');
const filename = '电路实验.pdf';
const fixture = path.join(root, filename);
const annotatedOrphan = '40000000-0000-4000-8000-000000000000';
const referencedLater = '50000000-0000-4000-8000-000000000000';
const cleanupRoot = path.join(notes, 'Cleanup.assets', 'pdf');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const pageCount = 120;

function makePdf() {
  const itemIds = Array.from({ length: pageCount }, (_, index) => 6 + 2 * index);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>',
    '<< /Type /Pages /Kids [' + itemIds.map(id => id + ' 0 R').join(' ') + '] /Count ' + pageCount + ' >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 1 >>',
    '<< /Title (Lab experiments) /Parent 4 0 R /Dest [20 0 R /Fit] >>',
  ];
  itemIds.forEach((id, index) => {
    const size = index % 2 ? '730 390' : '480 650';
    const content = index === 7 ? '32 32 50 50 re S\n'
      : 'BT /F 18 Tf ' + (index === 3 ? '68 66' : index % 2 ? '30 350' : '30 610') + ' Td (Circuit page ' + (index + 1) + ') Tj ET\n';
    const rotated = index === 3 ? ' /CropBox [40 20 690 365] /Rotate 90' : '';
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + size + ']' + rotated + ' /Resources << /Font << /F 3 0 R >> >> /Contents ' + (id + 1) + ' 0 R >>');
    objects.push('<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream');
  });
  let pdf = '%PDF-1.7\n' + ('%' + ' '.repeat(4095) + '\n').repeat(48);
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
    return offset;
  });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  pdf += offsets.map(value => String(value).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(pdf + 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(check, description = 'the test host') {
  for (let count = 0; count < 120; count++) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  assert.fail('Timed out waiting for ' + description);
}

(async () => {
  fs.mkdirSync(notes);
  const pdf = makePdf();
  fs.writeFileSync(fixture, pdf);
  fs.writeFileSync(path.join(notes, 'Lab.md'), 'Before PDF\n\nAfter PDF\n');
  fs.writeFileSync(path.join(notes, 'Other.md'), 'Other document\n');
  if (native) {
    fs.writeFileSync(path.join(notes, 'Cleanup.md'), 'Cleanup fixture\n');
    for (const [identity, name] of [[annotatedOrphan, 'Marked.pdf'], [referencedLater, 'Plain.pdf']]) {
      const directory = path.join(cleanupRoot, identity);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, name), pdf);
    }
    fs.writeFileSync(path.join(cleanupRoot, annotatedOrphan, 'annotations.json'), JSON.stringify({
      version: 1, pdfHash: 'sha256:' + createHash('sha256').update(pdf).digest('hex'),
      annotations: [{ id: randomUUID(), page: 1, kind: 'note', color: '#f4b740', point: [50, 50], text: 'Keep with PDF' }],
    }));
  }
  const failedId = '10000000-0000-4000-8000-000000000000';
  const failedDirectory = path.join(notes, 'Failed.assets', 'pdf', failedId);
  fs.mkdirSync(failedDirectory, { recursive: true });
  fs.writeFileSync(path.join(failedDirectory, 'Damaged.pdf'), '%PDF-1.7\nInvalid content');
  fs.writeFileSync(path.join(notes, 'Failed.md'), '```pdf-embed ' + failedId + '\n```\n\n```pdf-embed 20000000-0000-4000-8000-000000000000\n```\n');
  for (let number = 1; number <= 52; number++) fs.writeFileSync(path.join(notes, 'Reading ' + number + '.md'), '');
  const canvasPath = path.join(root, 'canvases', 'Lab.canvas');
  const canvasAttachment = path.join(root, 'canvases', 'Lab.assets', 'attachments', 'lab.pdf');
  if (!notesOnly && !native) {
    fs.mkdirSync(path.dirname(canvasAttachment), { recursive: true });
    fs.writeFileSync(canvasAttachment, pdf);
    fs.writeFileSync(canvasPath, JSON.stringify({ version: 2, nodes: [
      { id: 'lab', kind: 'pdf', name: 'PDF fixture', assetPath: 'attachments/lab.pdf', x: 120, y: 120, width: 420, height: 320 },
    ], edges: [] }));
  }
  const port = await freePort(), origin = 'http://127.0.0.1:' + port;
  const python = process.env[native ? 'RELATUM_WEBVIEW_PYTHON' : 'RELATUM_PYTHON'] || 'python';
  const recycled = path.join(root, 'recycled');
  fs.mkdirSync(recycled);
  const command = native
    ? ['-B', '-c', 'import app, desktop, os, sys; from pathlib import Path; '
      + 'app._move_paths_to_recycle_bin = lambda paths: [file.rename(Path(os.environ["RELATUM_DATA_ROOT"]) / "recycled" / file.name) for file in paths]; '
      + 'sys.argv[0] = "desktop.py"; sys.exit(desktop.main())']
    : ['-B', 'app.py', '--no-browser', '--port', String(port)];
  if (notesOnly) command.push('--launch-profile', JSON.stringify({
    version: 1, features: Object.fromEntries(features.map(({ id }) => [id, id === 'notes'])),
  }));
  const host = spawn(python, command, { cwd: repo, windowsHide: true, env: {
    ...process.env, RELATUM_DATA_ROOT: root,
    ...(native ? { LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } : {}),
  } });
  const exited = new Promise(resolve => host.once('exit', resolve));
  let browser, page, logs = '';
  for (const stream of [host.stdout, host.stderr]) stream.on('data', data => { logs = (logs + data).slice(-12000); });
  try {
    await waitFor(async () => {
      try { return (await fetch(origin + (native ? '/json/version' : '/api/runtime'))).ok; } catch { return false; }
    });
    browser = native ? await chromium.connectOverCDP(origin) : await chromium.launch({
      executablePath: process.env.RELATUM_EDGE_PATH, headless: true,
    });
    page = native ? await waitFor(() => browser.contexts()[0].pages().find(item => item.url().startsWith('http://127.0.0.1')))
      : await browser.newPage({ viewport: { width: 1260, height: 820 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    page.on('pageerror', error => { logs = (logs + '\n' + error.stack).slice(-12000); });
    page.on('console', message => { if (message.type() === 'error') logs = (logs + '\n' + message.text()).slice(-12000); });
    page.setDefaultTimeout(12000);
    await page.addInitScript(() => {
      localStorage.setItem('canvas:toolbarLanguage', 'en');
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteView:v1', 'live');
    });
    const workspace = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: workspace.replace(
      '  window.CanvasNoteWorkspace = {',
      '  window.__pdfTest = { state, openNote, setViewMode, movePath };\n  window.CanvasNoteWorkspace = {',
    ) }));
    await page.goto(native ? page.url() : origin);
    await page.waitForFunction(() => window.__pdfTest?.state.initialized && __pdfTest.state.active);
    const open = note => page.evaluate(name => __pdfTest.openNote(name, { reuseActiveTab: false }), note);
    const mode = value => page.evaluate(view => __pdfTest.setViewMode(view), value);
    const block = page.locator('.note-pdf-embed:visible').first();
    const panel = page.locator('#note-pdf-tab-panel');
    const navigation = page.locator('#note-pdf-navigation');
    const stage = panel.locator('.note-pdf-scroll');
    const pageNumber = panel.getByRole('textbox', { name: 'Go to page' });
    const tree = page.locator('.note-sidebar-scroll');
    const tab = page.getByRole('tab', { name: filename });
    async function dragPdfText(span) {
      await span.waitFor();
      const { start, end } = await span.evaluate(node => {
        const text = node.firstChild;
        const caret = document.createRange();
        const position = offset => {
          caret.setStart(text, offset);
          caret.collapse(true);
          const rect = caret.getBoundingClientRect();
          return [rect.x + rect.width / 2, rect.y + rect.height / 2];
        };
        const between = (left, right, fraction) => left.map((value, axis) => value + (right[axis] - value) * fraction);
        return {
          start: between(position(0), position(1), .2),
          end: between(position(text.length - 1), position(text.length), .8),
        };
      });
      await page.mouse.move(...start);
      await page.mouse.down();
      try {
        await page.mouse.move(...end, { steps: 12 });
        return await page.evaluate(() => window.getSelection().toString());
      } finally {
        await page.mouse.up();
      }
    }
    assert.equal(await open('Lab.md'), true);
    assert.equal(await page.evaluate(() => Boolean(window.pdfjsLib)), false);
    const menu = page.locator('[data-role="note-context-menu"]');
    async function choosePdf() {
      await page.locator('[data-role="note-editor"] .cm-line').filter({ hasText: 'Before PDF' }).click({ button: 'right' });
      await menu.locator('[data-note-submenu="insert"]').hover();
      const event = page.waitForEvent('filechooser');
      await menu.locator('[data-note-command="insert:pdf-embed"]').click();
      return event;
    }
    await mode('source');
    const cancelled = await choosePdf();
    await cancelled.element().dispatchEvent('cancel');
    await menu.waitFor({ state: 'hidden' });
    assert.equal(fs.existsSync(path.join(notes, 'Lab.assets')), false);
    await mode('live');
    if (!native) {
      let received = false, resume;
      const pending = new Promise(resolve => { resume = resolve; });
      await page.route('**/api/note-pdf/import?*', async route => {
        received = true;
        await pending;
        await route.fulfill({ json: { id: '30000000-0000-4000-8000-000000000000', name: filename } }).catch(() => {});
      }, { times: 1 });
      const stale = await choosePdf();
      await stale.setFiles(fixture);
      try {
        await waitFor(() => received);
        assert.equal(await open('Other.md'), true);
      } finally { resume(); }
      assert.equal(fs.readFileSync(path.join(notes, 'Other.md'), 'utf8'), 'Other document\n');
      assert.equal(await open('Lab.md'), true);
      assert.equal(await block.count(), 0);
    }
    const chooser = await choosePdf();
    await chooser.setFiles(fixture);
    await block.locator('.note-pdf-page canvas').first().waitFor();
    await page.waitForFunction(value => document.querySelector('.note-pdf-page-label')?.textContent === '1 / ' + value, pageCount);
    const firstInlineText = block.locator('.note-pdf-page[data-page="1"] .note-pdf-text > span').first();
    assert.equal(await dragPdfText(firstInlineText), 'Circuit page 1', 'mouse selects text in the live Markdown PDF block');
    const source = await waitFor(() => {
      const value = fs.readFileSync(path.join(notes, 'Lab.md'), 'utf8');
      return value.includes('pdf-embed') && value;
    });
    const id = /pdf-embed ([0-9a-f-]+)/.exec(source)[1];
    assert.deepEqual(fs.readFileSync(path.join(notes, 'Lab.assets', 'pdf', id, filename)), pdf);
    const handle = block.locator('.note-html-resize');
    await handle.scrollIntoViewIfNeeded();
    const grip = await handle.boundingBox();
    const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 66, { steps: 4 });
    await page.mouse.up();
    await waitFor(() => fs.readFileSync(path.join(notes, 'Lab.md'), 'utf8').includes('autox414'));
    await page.keyboard.press('Control+z');
    await waitFor(() => fs.readFileSync(path.join(notes, 'Lab.md'), 'utf8') === source);

    const appUrl = new URL(page.url()).origin;
    const relative = (name, asset = id) => new URLSearchParams({ note: name, id: asset });
    const range = await fetch(appUrl + '/api/note-pdf/file?' + relative('Lab.md'), { headers: { Range: 'bytes=10-25' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 10-25/' + pdf.length);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), pdf.subarray(10, 26));
    assert.equal((await fetch(appUrl + '/api/note-pdf?' + relative('Other.md'))).status, 404);
    assert.equal((await fetch(appUrl + '/api/note-pdf?' + relative('../Lab.md'))).status, 403);
    const importQuery = new URLSearchParams({ note: 'Lab.md', name: 'Broken.pdf', revision: 'old' });
    const upload = body => fetch(appUrl + '/api/note-pdf/import?' + importQuery, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body });
    assert.equal((await upload('Invalid PDF')).status, 400);
    assert.equal((await upload(pdf)).status, 409);
    const tooLarge = await new Promise((resolve, reject) => {
      const request = http.request(appUrl + '/api/note-pdf/import?' + importQuery, {
        method: 'POST', headers: { 'Content-Type': 'application/pdf', 'Content-Length': 100 * 1024 * 1024 + 1 },
      }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
      request.end();
    });
    assert.equal(tooLarge, 413);
    const encodedFile = path.join(notes, 'Lab.assets', 'pdf', id, filename);
    await block.getByRole('button', { name: 'Remove PDF block' }).click();
    await block.waitFor({ state: 'detached' });
    assert.equal(fs.existsSync(encodedFile), true);
    await page.keyboard.press('Control+z');
    await block.locator('.note-pdf-page canvas').first().waitFor();

    await block.locator('.note-pdf-scroll').evaluate(node => { node.scrollTop = 1800; });
    await page.waitForFunction(() => !document.querySelector('.note-pdf-page-label').textContent.startsWith('1 '));
    const inlinePage = (await block.locator('.note-pdf-page-label').textContent()).split(' ')[0];
    await block.getByRole('button', { name: 'Open in new tab' }).click();
    await panel.waitFor();
    await page.waitForFunction(value => document.querySelector('.note-pdf-page-input')?.value === value, inlinePage);
    await tree.evaluate(node => { node.scrollTop = 350; });
    const treeScroll = await tree.evaluate(node => node.scrollTop);
    assert.ok(treeScroll > 0);
    await panel.getByRole('button', { name: 'Pages', exact: true }).click();
    await navigation.getByRole('button', { name: 'Outline' }).waitFor();
    assert.equal(await tree.isVisible(), false);
    await navigation.getByRole('button', { name: 'Outline' }).click();
    await navigation.getByRole('button', { name: 'Lab experiments' }).click();
    await page.waitForFunction(() => document.querySelector('.note-pdf-page-input')?.value === '8');
    await navigation.getByRole('button', { name: 'Thumbnails' }).click();
    await navigation.locator('[aria-current="page"] canvas').waitFor();
    assert.equal(await navigation.locator('[aria-current="page"]').getAttribute('data-page'), '8');
    await navigation.getByRole('button', { name: 'Files' }).click();
    assert.equal(await tree.evaluate(node => node.scrollTop), treeScroll);
    if (!native) {
      await page.setViewportSize({ width: 530, height: 780 });
      await panel.getByRole('button', { name: 'Pages', exact: true }).click();
      await navigation.getByRole('button', { name: 'Files' }).click();
      assert.equal(await page.locator('.note-workspace').evaluate(node => node.classList.contains('tree-overlay-open')), true);
      assert.equal(await tree.isVisible(), true);
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1260, height: 820 });
    }

    await stage.evaluate(node => {
      window.__mismatchedPdfCanvases = [];
      window.__observePdfCanvases = new MutationObserver(changes => {
        for (const change of changes) for (const add of change.addedNodes) {
          if (add.tagName !== 'CANVAS' || !add.isConnected || !add.width) continue;
          const page = add.parentElement;
          if (Math.abs(add.height / add.width - page.offsetHeight / page.offsetWidth) > .02) {
            window.__mismatchedPdfCanvases.push(page.dataset.page);
          }
        }
      });
      window.__observePdfCanvases.observe(node, { childList: true, subtree: true });
    });
    await pageNumber.fill('4');
    await pageNumber.press('Enter');
    await page.waitForFunction(() => document.querySelector('.note-pdf-page-input')?.value === '4');
    const width = await panel.locator('.note-pdf-page[data-page="4"]').evaluate(node => node.offsetWidth);
    await panel.getByRole('button', { name: 'Zoom in' }).click();
    await page.waitForFunction(value => document.querySelector('#note-pdf-tab-panel .note-pdf-page[data-page="4"]')?.offsetWidth > value, width);
    await panel.getByRole('button', { name: 'Fit width' }).click();
    await panel.locator('.note-pdf-page[data-page="4"] .note-pdf-text > span').first().waitFor();
    assert.deepEqual(await page.evaluate(() => {
      window.__observePdfCanvases.disconnect();
      return window.__mismatchedPdfCanvases;
    }), [], 'mixed-size pages rasterize only into corrected geometry');
    const annotations = panel.getByRole('toolbar', { name: 'PDF annotation tools' });
    const tool = name => annotations.getByRole('button', { name, exact: true });
    const thickness = annotations.getByRole('slider', { name: 'Stroke width' });
    const removeAnnotation = tool('Delete selected annotation');
    const geometry = () => stage.evaluate(node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    });
    const readingGeometry = await geometry();
    assert.equal(await thickness.isVisible(), true);
    assert.equal(await thickness.isDisabled(), true);
    assert.equal(await removeAnnotation.isVisible(), true);
    assert.equal(await removeAnnotation.isDisabled(), true);
    assert.equal(await tool('Pen').locator('svg').count(), 1);
    const goTo = async number => {
      await pageNumber.fill(String(number));
      await pageNumber.press('Enter');
      await page.waitForFunction(value => document.querySelector('.note-pdf-page-input')?.value === String(value), number);
    };
    const sheet = number => panel.locator('.note-pdf-page[data-page="' + number + '"]');
    const rotatedText = sheet(4).locator('.note-pdf-text > span').first();
    assert.equal(await dragPdfText(rotatedText), 'Circuit page 4', 'mouse selects actual PDF text in reading mode');
    assert.equal(await rotatedText.evaluate(node => getComputedStyle(node).cursor), 'text');
    const selectionMark = sheet(4).locator('.note-pdf-selection path[d^="M"]');
    await selectionMark.waitFor();
    assert.equal(await selectionMark.evaluate(node => getComputedStyle(node).fill), 'rgba(87, 151, 208, 0.48)');
    assert.equal(await sheet(4).evaluate(node => {
      const { left, top } = node.getBoundingClientRect();
      return getComputedStyle(document.elementFromPoint(left + 10, top + 10)).cursor;
    }), 'default', 'blank paper has the arrow cursor');
    async function brush(name, number, from, to = from) {
      const button = tool(name);
      if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
      assert.deepEqual(await geometry(), readingGeometry, 'switching annotation tools preserves the reading area');
      const vector = sheet(number).locator('.note-pdf-annotations > svg');
      await vector.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const box = await vector.boundingBox();
      const visible = await stage.boundingBox();
      assert.ok(from[1] + box.y >= visible.y && to[1] + box.y <= visible.y + visible.height, name + ' fits the viewport on page ' + number);
      await page.mouse.move(box.x + from[0], box.y + from[1]);
      await page.mouse.down();
      await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 4 });
      await page.mouse.up();
    }
    await panel.getByRole('button', { name: 'Annotate', exact: true }).click();
    await waitFor(() => tool('Pen').isEnabled());
    assert.deepEqual(await geometry(), readingGeometry, 'entering annotation mode preserves the reading area');
    const metadata = await (await fetch(appUrl + '/api/note-pdf?' + relative('Lab.md'))).json();
    const params = relative('Lab.md');
    params.set('assetRevision', metadata.assetRevision);
    const api = appUrl + '/api/note-pdf/annotations';
    const savedSnapshot = async () => {
      const response = await fetch(api + '?' + params);
      assert.equal(response.status, 200, 'reading persisted annotations');
      return response.json();
    };
    const savedMarks = async () => (await savedSnapshot()).annotations;
    for (const name of ['Highlight text', 'Underline']) {
      await tool(name).click();
      if (name === 'Underline') assert.equal(await dragPdfText(rotatedText), 'Circuit page 4', 'tool-first drag selects the text');
      const mark = await waitFor(async () => (await savedMarks()).find(mark => mark.kind === (name === 'Underline' ? 'underline' : 'highlight')), name);
      assert.equal(mark.text, 'Circuit page 4');
      const [, , end, start] = mark.quads[0];
      assert.ok(Math.abs(end[1] - start[1]) < .1 && end[0] - start[0] > 50,
        name + ' follows the text direction in PDF space: ' + JSON.stringify(mark.quads[0]));
    }
    await brush('Pen', 4, [110, 145], [180, 175]);
    await brush('Highlighter', 4, [200, 145], [260, 163]);
    await brush('Box', 4, [105, 210], [195, 280]);
    const boxMark = await waitFor(async () => (await savedMarks()).find(mark => mark.kind === 'box'), 'rotated-page box');
    assert.ok(boxMark.quad.every(([x, y]) => x >= 40 && x <= 690 && y >= 20 && y <= 365), 'crop-box PDF coordinates');
    const paperBounds = await sheet(4).boundingBox();
    const viewBounds = await stage.boundingBox();
    const noteY = Math.min(paperBounds.height, viewBounds.y + viewBounds.height - paperBounds.y) - 18;
    await brush('Sticky note', 4, [275, noteY]);
    const popupBounds = await sheet(4).locator('.note-pdf-sticky').boundingBox();
    assert.ok(popupBounds.y >= viewBounds.y && popupBounds.y + popupBounds.height <= viewBounds.y + viewBounds.height,
      'sticky note by the lower edge fits the reading viewport');
    await sheet(4).getByRole('textbox', { name: 'Sticky note text' }).fill('旋转页便签');
    await sheet(4).getByRole('button', { name: 'Close note' }).click();
    const sticky = await waitFor(async () => (await savedMarks()).find(mark => mark.text === '旋转页便签'), 'sticky note');
    if (!native) {
      await tool('Sticky note').click();
      await page.setViewportSize({ width: 530, height: 650 });
      await goTo(4);
      await sheet(4).getByRole('button', { name: 'Open sticky note' }).click();
      const popup = await sheet(4).locator('.note-pdf-sticky').boundingBox();
      const view = await stage.boundingBox();
      assert.ok(popup.x >= view.x && popup.x + popup.width <= view.x + view.width, 'sticky note fits the narrow reading viewport');
      await sheet(4).getByRole('button', { name: 'Close note' }).click();
      await page.setViewportSize({ width: 1260, height: 820 });
      await goTo(4);
    }
    await brush('Eraser', 4, [145, 210]);
    await waitFor(async () => !(await savedMarks()).some(mark => mark.id === boxMark.id), 'erasing the box');
    await tool('Undo annotation').click();
    await waitFor(async () => (await savedMarks()).some(mark => mark.id === boxMark.id), 'undo');
    await tool('Redo annotation').click();
    await waitFor(async () => !(await savedMarks()).some(mark => mark.id === boxMark.id), 'redo');
    await tool('Undo annotation').click();
    await tool('Eraser').click();
    await sheet(4).getByRole('button', { name: 'Open sticky note' }).click();
    const color = annotations.getByRole('combobox', { name: 'Annotation color' });
    await color.click();
    const palette = page.getByRole('listbox', { name: 'Annotation color' });
    await palette.waitFor();
    const green = palette.getByRole('option', { name: 'Green', exact: true });
    assert.equal(await green.evaluate(node => getComputedStyle(node, '::before').backgroundColor), 'rgb(58, 166, 110)');
    if (process.env.RELATUM_ARTIFACT_DIR && !native) {
      await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, 'note-pdf-toolbar.png'), scale: 'css' });
    }
    await color.press('Escape');
    await palette.waitFor({ state: 'detached' });
    assert.equal(await color.getAttribute('aria-expanded'), 'false');
    await color.click();
    await green.click();
    await waitFor(async () => (await savedMarks()).some(mark => mark.id === sticky.id && mark.color === '#3aa66e'), 'sticky note color');
    await removeAnnotation.click();
    await page.getByText('Annotation deleted. Undo is available.', { exact: true }).waitFor();
    await waitFor(async () => !(await savedMarks()).some(mark => mark.id === sticky.id), 'removing the selected sticky note');
    assert.equal(await removeAnnotation.isDisabled(), true);
    await tool('Undo annotation').click();
    await waitFor(async () => (await savedMarks()).some(mark => mark.id === sticky.id), 'undo the deletion');
    assert.deepEqual(await geometry(), readingGeometry, 'saving and deleting annotations preserve reading geometry');
    const polygon = sheet(4).locator('[data-annotation-id="' + boxMark.id + '"] polygon');
    const position = () => polygon.evaluate(node => {
      const { width, height } = node.ownerSVGElement.viewBox.baseVal;
      const points = node.getAttribute('points').split(' ').map(pair => pair.split(',').map(Number));
      return { width, ratios: points.flatMap(([x, y]) => [x / width, y / height]) };
    });
    const beforeZoom = await position();
    await panel.getByRole('button', { name: 'Zoom in' }).click();
    const afterZoom = await waitFor(async () => {
      const projection = await position();
      return projection.width > beforeZoom.width && projection;
    });
    afterZoom.ratios.forEach((value, index) => assert.ok(Math.abs(value - beforeZoom.ratios[index]) < 0.001));
    const yRail = panel.getByRole('scrollbar', { name: 'Scroll vertically' });
    await yRail.waitFor();
    assert.equal(await stage.evaluate(node => getComputedStyle(node).scrollbarWidth), 'none');
    assert.equal(await stage.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    assert.notEqual(await stage.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
    await page.evaluate(() => { document.body.dataset.startTheme = 'light'; });
    const track = await yRail.boundingBox();
    await page.mouse.move(track.x + 6, track.y + 18);
    await page.mouse.down();
    await page.mouse.move(track.x + 6, track.y + track.height * .67, { steps: 5 });
    await page.mouse.up();
    await waitFor(async () => Number(await pageNumber.inputValue()) > 40);
    await yRail.press('Home');
    await waitFor(async () => (await pageNumber.inputValue()) === '1');
    await panel.getByRole('button', { name: 'Fit width' }).click();
    await brush('Pen', 1, [90, 145], [155, 165]);
    await waitFor(async () => (await savedMarks()).some(mark => mark.kind === 'pen' && mark.page === 1), 'first-page pen stroke');
    await goTo(8);
    assert.equal(await sheet(8).locator('.note-pdf-text > span').count(), 0, 'page without a text layer');
    await brush('Box', 8, [80, 110], [125, 145]);
    await waitFor(async () => (await savedMarks()).some(mark => mark.page === 8), 'box on the page without text');

    // A separate writer advances the saved revision while the PDF is open.
    const snapshot = await savedSnapshot();
    const remote = { ...sticky, id: randomUUID(), text: 'Second writer' };
    const response = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Lab.md', id, assetRevision: metadata.assetRevision, pdfHash: snapshot.pdfHash,
        revision: snapshot.revision, upsert: [remote], remove: [] }) });
    assert.equal(response.status, 200);
    await brush('Pen', 8, [175, 115], [230, 140]);
    await panel.getByText('Annotations changed in another window.', { exact: false }).waitFor();
    await panel.getByRole('button', { name: 'Reload', exact: true }).click();
    const conflict = page.getByRole('dialog', { name: 'Reload PDF annotations' });
    await conflict.getByRole('button', { name: 'Cancel' }).click();
    await panel.getByRole('button', { name: 'Reload', exact: true }).click();
    await conflict.getByRole('button', { name: 'Reload', exact: true }).click();
    await waitFor(() => tool('Pen').isEnabled());
    assert.ok((await savedMarks()).some(mark => mark.id === remote.id));
    const countBeforeRetry = (await savedMarks()).length;
    await page.route('**/api/note-pdf/annotations', route => route.fulfill({
      status: 500, json: { code: 'annotation_io', error: 'Test write failure' },
    }), { times: 1 });
    await brush('Highlighter', 8, [180, 155], [225, 176]);
    await panel.getByText('Unable to save or read annotations.').waitFor();
    assert.deepEqual(await geometry(), readingGeometry, 'save failure is displayed without shifting the paper');
    assert.equal((await savedMarks()).length, countBeforeRetry);
    await panel.getByRole('button', { name: 'Retry', exact: true }).click();
    await waitFor(async () => (await savedMarks()).length === countBeforeRetry + 1, 'saving on retry');

    await page.route('**/api/note-pdf/annotations', async route => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort();
    }, { times: 1 });
    await brush('Pen', 8, [128, 160], [156, 183]);
    await panel.getByText('Unable to save or read annotations.').waitFor();
    assert.equal((await savedMarks()).length, countBeforeRetry + 2, 'server committed before response was lost');
    await brush('Box', 8, [154, 210], [182, 240]);
    await panel.getByRole('button', { name: 'Retry', exact: true }).click();
    await waitFor(async () => (await savedMarks()).length === countBeforeRetry + 3, 'replaying the committed write before sending newer edits');

    await panel.getByRole('button', { name: 'Annotate', exact: true }).click();
    await panel.getByRole('button', { name: 'Fit width' }).click();
    await page.keyboard.press('Control+f');
    assert.deepEqual(await geometry(), readingGeometry, 'finding text does not shift the paper');
    await panel.getByRole('searchbox').fill('Circuit page 11');
    await panel.locator('.note-pdf-match span').first().waitFor();
    assert.equal(await pageNumber.inputValue(), '11');
    assert.ok(await panel.locator('.note-pdf-page').count() < 8);
    await panel.getByRole('searchbox').press('Escape');

    await open('Other.md');
    assert.equal(await stage.count(), 0);
    assert.equal(await navigation.isVisible(), false);
    await tab.click();
    await page.waitForFunction(() => document.querySelector('.note-pdf-page-input')?.value === '11');
    await open('Lab.md');
    await mode('reading');
    await block.getByRole('button', { name: 'Open in new tab' }).waitFor();
    await block.locator('.note-pdf-scroll').evaluate(node => { node.scrollTop = 0; });
    await block.locator('.note-pdf-page[data-page="1"] .note-pdf-annotations [data-annotation-id]').first().waitFor();
    assert.equal(await dragPdfText(block.locator('.note-pdf-page[data-page="1"] .note-pdf-text > span').first()),
      'Circuit page 1', 'mouse selects text in the read-only Markdown PDF block');
    assert.equal(await block.getByRole('button', { name: 'Remove PDF block' }).count(), 0);
    await block.getByRole('button', { name: 'Open in new tab' }).click();
    assert.equal(await tab.count(), 1);
    assert.equal(await page.evaluate(value => {
      const output = document.createElement('div');
      window.RelatumNoteLiveEditor.renderMarkdown(output, value, 'Lab.md', { print: true });
      return output.querySelector('.note-pdf-embed-print')?.textContent;
    }, source), 'PDF attachment');

    const moved = await page.evaluate(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (await __pdfTest.movePath('Lab.md', 'Moved.md', true)) return { ok: true };
        if (!['move_changed', 'statistics_incomplete'].includes(__pdfTest.state.lastMoveCode)) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return { ok: false, code: __pdfTest.state.lastMoveCode, error: __pdfTest.state.lastMoveError };
    });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal((await fetch(appUrl + '/api/note-pdf?' + relative('Moved.md'))).status, 200);
    assert.equal((await fetch(appUrl + '/api/note-pdf?' + relative('Lab.md'))).status, 404);
    const movedDirectory = path.join(notes, 'Moved.assets', 'pdf', id);
    assert.ok(fs.existsSync(path.join(movedDirectory, 'annotations.json')));
    assert.deepEqual(fs.readFileSync(path.join(movedDirectory, filename)), pdf);
    await tab.waitFor();
    await panel.locator('canvas').first().waitFor();
    if (native) {
      assert.equal(await open('Cleanup.md'), true);
      const row = page.locator('[data-role="note-tree"] [data-path="Cleanup.md"] > .note-tree-row');
      await tree.evaluate(node => { node.scrollTop = 0; });
      for (let offset = 0; offset < 5 && !await row.count(); offset++) {
        await tree.evaluate(node => { node.scrollTop += Math.max(100, node.clientHeight * .8); });
        await delay(100);
      }
      const selectCleanup = async () => {
        await row.click({ button: 'right' });
        await menu.locator('[data-note-action="cleanup-unused-pdf"]').click();
      };
      const dialog = page.getByRole('dialog', { name: 'Clean up unused PDF' });
      await selectCleanup();
      await dialog.getByText('Marked.pdf', { exact: false }).waitFor();
      await dialog.getByText('Annotated', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      assert.ok(fs.existsSync(path.join(cleanupRoot, annotatedOrphan)));
      await selectCleanup();
      await dialog.getByText('Plain.pdf').waitFor();
      fs.writeFileSync(path.join(notes, 'Other.md'), 'New reference to ' + referencedLater + '\n');
      await dialog.getByRole('button', { name: 'Move to Recycle Bin' }).click();
      await dialog.getByText('Marked.pdf', { exact: false }).waitFor();
      assert.equal(await dialog.getByText('Plain.pdf').count(), 0);
      await dialog.getByRole('button', { name: 'Move to Recycle Bin' }).click();
      await waitFor(() => fs.existsSync(path.join(recycled, annotatedOrphan, 'annotations.json')));
      assert.ok(fs.existsSync(path.join(cleanupRoot, referencedLater, 'Plain.pdf')));
      await tab.click();
      await panel.locator('canvas').first().waitFor();
      await page.evaluate(() => window.pywebview.api.minimize());
      await page.waitForFunction(() => document.documentElement.dataset.desktopMinimized === '1');
      assert.equal(await panel.locator('canvas').count(), 0);
    } else {
      assert.equal(await open('Failed.md'), true);
      const damaged = page.locator('[data-pdf-embed-id="' + failedId + '"]:visible');
      const missing = page.locator('[data-pdf-embed-id="20000000-0000-4000-8000-000000000000"]:visible');
      await damaged.scrollIntoViewIfNeeded();
      await damaged.getByText('The PDF file is damaged or invalid', { exact: true }).waitFor();
      await missing.scrollIntoViewIfNeeded();
      await missing.getByText('PDF attachment not found', { exact: true }).waitFor();
    }
    if (!notesOnly && !native) {
      const canvasPage = await browser.newPage({ viewport: { width: 1260, height: 820 }, reducedMotion: 'reduce' });
      try {
        await canvasPage.goto(appUrl + '/editor.html?file=' + encodeURIComponent(canvasPath));
        const node = canvasPage.locator('.node[data-id="lab"]');
        await node.locator('canvas').first().waitFor();
        await node.dblclick();
        const reader = canvasPage.locator('[data-role="pdf-reader"]');
        await reader.locator('.pdf-reader-canvas').first().waitFor();
        await reader.locator('[data-pdf-tool="note"]').click();
        await reader.locator('.pdf-note-layer').first().click({ position: { x: 65, y: 105 } });
        await reader.locator('.pdf-note-text').fill('Lab annotation');
        await waitFor(() => {
          const sidecar = canvasAttachment + '.annot.json';
          if (!fs.existsSync(sidecar)) return false;
          return JSON.parse(fs.readFileSync(sidecar)).pages['1']?.some(item => item.text === 'Lab annotation');
        });
        assert.deepEqual(fs.readFileSync(canvasAttachment), pdf);
      } finally { await canvasPage.close(); }
    }
    console.log('Note PDF embeds passed (' + (native ? 'WebView2' : 'Edge') + (notesOnly ? ', notes-only' : '') + ')');
  } catch (error) {
    console.error(logs.slice(-5800));
    if (page) console.error('Visible PDF states:', await page.locator('.note-pdf-message').allTextContents().catch(() => []));
    throw error;
  } finally {
    if (native && page) {
      await page.evaluate(() => { void window.pywebview?.api?.close_window(); }).catch(() => {});
      await Promise.race([exited, delay(2500)]);
    }
    await browser?.close().catch(() => {});
    if (host.exitCode === null) {
      host.kill();
      await Promise.race([exited, delay(2000)]);
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('relatum-note-pdf-embed-'));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); }
    catch (error) { if (!native) throw error; }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
