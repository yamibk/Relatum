'use strict';

// Real CodeMirror and Chromium with a database mount test double.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');

const assets = path.resolve(__dirname, '../assets');
const fence = '```database sample\n```';
const generatedFence = /```database [a-f0-9-]{36}\n```/;
const resources = ['markdown.js', 'markdown-table.js', 'vendor/codemirror/relatum-codemirror.min.js', 'note-table-editor.js', 'note-live-editor.js'];
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css">
<div id="editor" class="note-live-editor-host" style="height:60vh"></div><div id="reading"></div><div id="external"></div>
${resources.map(resource => `<script src="${resource}"></script>`).join('')}
<script>
window.mounts = [];
window.disposals = [];
window.imports = [];
window.images = [];
window.dropCandidates = [];
window.database = { mount(element, options) {
  const id = mounts.length + 1;
  mounts.push({ id, path: options.path, databaseId: options.databaseId, readOnly: options.readOnly, observe: options.observe });
  element.textContent = 'Database ' + id;
  return () => disposals.push(id);
} };
window.editor = RelatumNoteLiveEditor.create(document.querySelector('#editor'), {
  database, notePath: 'A.md', onImageFiles: files => images.push(...files.map(file => file.name)),
  onDatabaseFiles(files, insert, candidates) {
    imports.push(...files.map(file => file.name));
    dropCandidates.push(candidates);
    return new Promise(resolve => { window.completeImport = () => { const inserted = insert(); resolve(); return inserted; }; });
  },
});
</script>`;

(async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fixture); return; }
    const url = new URL(request.url, 'http://127.0.0.1');
    const file = path.resolve(assets, url.pathname.replace(/^\/assets\//, ''));
    if (!file.startsWith(assets + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)];
    response.setHeader('Content-Type', type || 'application/octet-stream');
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const page = await browser.newPage({ viewport: { width: 900, height: 740 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    await page.goto(origin);
    const open = (value, path = 'A.md') => page.evaluate(([value, path]) => editor.setDocument({ value, notePath: path }), [value, path]);
    const markers = '# Before\n\n' + fence + '\n\nwords\n\n' + fence + '\n\nAfter';
    const examples = [
      ['```database sample  \r\n \t\r\n``` \r\n', true],
      ['```database\n```', false],
      ['```database\n``` trailing', false],
      ['```database\nSELECT 1\n```', false],
      ['```database', false],
      ['````md\n' + fence + '\n````', false],
      ['---\n' + fence + '\n---\nFollow', false],
      ['%%\n' + fence + '\n%%', false],
      ['$$\n' + fence + '\n$$', false],
      ['\\[\n' + fence, false],
      ['$$\nx + y\n$$\n\n' + fence, true],
      ['<!--\n' + fence + '\n-->', false],
      ['> ```database\n> ```', false],
      ['- List\n\n  ```database\n  ```', false],
      ['    ```database\n    ```', false],
      ['```DATABASE\n```', false],
    ];
    assert.deepEqual(await page.evaluate(values => values.map(RelatumNoteLiveEditor.hasDatabaseBlock), examples.map(entry => entry[0])), examples.map(entry => entry[1]));
    await open('$$\n' + fence + '\n$$');
    assert.equal(await page.locator('#editor .note-database-carrier').count(), 0);
    await open(markers);
    await page.waitForFunction(() => document.querySelectorAll('#editor .note-database-carrier').length === 2);
    assert.deepEqual(await page.evaluate(() => mounts.map(({ path, databaseId, readOnly, observe }) => [path, databaseId, readOnly, observe])), [['A.md', 'sample', false, true], ['A.md', 'sample', false, true]]);
    await page.evaluate(() => editor.setSourceMode(true));
    await page.waitForFunction(() => !document.querySelector('#editor .note-database-carrier'));
    assert.equal(await page.locator('#editor .cm-line').filter({ hasText: 'database' }).count(), 2);
    assert.deepEqual(await page.evaluate(() => disposals.slice().sort()), [1, 2]);
    await page.evaluate(value => {
      RelatumNoteLiveEditor.renderMarkdown(document.querySelector('#reading'), value, 'A.md', { database });
      RelatumNoteLiveEditor.renderMarkdown(document.querySelector('#external'), value, 'external.md');
    }, markers);
    assert.equal(await page.locator('#reading .note-database-carrier').count(), 2);
    assert.equal(await page.locator('#external .note-database-carrier').count(), 0);
    assert.equal(await page.evaluate(() => mounts.filter(entry => entry.readOnly).length), 2);
    await page.evaluate(() => RelatumNoteLiveEditor.releaseReadingDocument(document.querySelector('#reading')));
    assert.deepEqual(await page.evaluate(() => disposals.slice().sort()), [1, 2, 3, 4]);

    await open('');
    await page.evaluate(() => { editor.setSourceMode(false); editor.focus(); });
    await page.keyboard.insertText(fence);
    await page.waitForSelector('#editor .note-database-carrier');
    assert.equal(await page.evaluate(() => editor.snapshot().value), fence);

    await open('# heading\n\nBody');
    await page.evaluate(() => { editor.setSourceMode(false); editor.view.dispatch({ selection: { anchor: 5 } }); });
    assert.equal(await page.evaluate(() => editor.executeCommand('insert:database')), true);
    assert.equal((await page.evaluate(() => editor.snapshot().value)).replace(generatedFence, '[database]'), '# heading\n\n[database]\n\nBody');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => editor.snapshot().value), '# heading\n\nBody');

    async function drop() {
      const target = page.locator('#editor .cm-line').filter({ hasText: 'drop here' });
      await target.evaluate(element => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File(['pdf'], 'lesson.pdf', { type: 'application/pdf' }));
        dataTransfer.items.add(new File(['png'], 'image.png', { type: 'image/png' }));
        const box = element.getBoundingClientRect();
        element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: box.left + 5, clientY: box.top + 5 }));
      });
      await page.waitForFunction(() => !!window.completeImport);
    }
    await open('Start\n\ndrop here\n\nEnd');
    await drop();
    assert.deepEqual(await page.evaluate(() => imports), ['lesson.pdf']);
    assert.deepEqual(await page.evaluate(() => images), ['image.png']);
    await page.evaluate(() => editor.view.dispatch({ changes: { from: 0, insert: 'New\n\n' } }));
    assert.equal(await page.evaluate(() => window.completeImport()), true);
    assert.equal((await page.evaluate(() => editor.snapshot().value)).replace(generatedFence, '[database]'), 'New\n\nStart\n\ndrop here\n\n[database]\n\nEnd');

    await open('drop here');
    await page.evaluate(() => { window.completeImport = null; });
    await drop();
    await open('Other note', 'B.md');
    assert.equal(await page.evaluate(() => window.completeImport()), false);
    assert.equal(await page.evaluate(() => editor.snapshot().value), 'Other note');

    await open(fence + '\n\n' + 'A longer paragraph. '.repeat(25) + '\n\ndrop here\n\n' + fence.replace('sample', 'nearby'), 'B.md');
    await page.evaluate(() => { window.completeImport = null; });
    await drop();
    assert.deepEqual(await page.evaluate(() => dropCandidates.at(-1)), ['nearby', 'sample']);

    await page.route('**/assets/note-database.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      window.renderedDatabases = [];
      window.RelatumNoteDatabase = { async renderPrint(host, path, databaseId, language) {
        renderedDatabases.push({ path, databaseId, language });
        const table = document.createElement('table'), cell = table.insertRow().insertCell();
        cell.textContent = 'Database print contents ' + databaseId;
        host.append(table);
        return 0;
      } };
    ` }));
    await page.goto(origin + '/assets/note-print.html');
    assert.deepEqual(await page.evaluate(async value => RelatumNotePrint.render({ path: 'A.md', value, language: 'en' }), markers + '\n\n' + fence.replace('sample', 'second')), { warnings: 0 });
    assert.deepEqual(await page.locator('.note-database-carrier table').allTextContents(), ['Database print contents sample', 'Database print contents sample', 'Database print contents second']);
    assert.deepEqual(await page.evaluate(() => renderedDatabases), [{ path: 'A.md', databaseId: 'sample', language: 'en' }, { path: 'A.md', databaseId: 'second', language: 'en' }]);
    assert.deepEqual(errors, []);
    console.log('Database editing, reading, PDF projection, history, mapped drop and late response verified.');
  } finally {
    await browser?.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
