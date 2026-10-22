'use strict';

// Static, disposable notes. Baseline assets are read from Git without checking
// out files; clipboard operations are captured within this browser context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const reportPath = process.env.RELATUM_NOTE_INPUT_REPORT || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-input-')), 'report.json');
const performanceOnly = process.argv.includes('--performance-only');
const profileOnly = process.argv.includes('--profile');
const benchmark = performanceOnly || profileOnly || process.argv.includes('--performance');
const noRegression = process.argv.includes('--no-regression');
const baselineRef = process.env.RELATUM_NOTE_INPUT_BASELINE || 'fafc085';
const baseline = new Map();
if (benchmark) for (const file of ['note-live-editor.js', 'note-table-editor.js', 'markdown-table.js']) {
  baseline.set(file, execFileSync('git', ['show', `${baselineRef}:assets/${file}`], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
}
const html = prefix => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/${prefix}assets/">
<link rel="stylesheet" href="styles.css"><style>body{margin:0}.note-document-pane{height:100vh;display:flex;flex-direction:column}</style></head>
<body class="start-page"><main class="note-document-pane"><div class="note-document-body"><div class="note-live-editor-host" id="editor"></div></div></main>
<script src="markdown.js"></script><script src="markdown-table.js"></script><script src="note-shortcuts.js"></script>
<script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script><script src="note-live-editor.js"></script>
<script>window.errors=[];addEventListener('error',e=>errors.push(String(e.error||e.message)));window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:'apple',notePath:'input.md'});</script></body></html>`;
const grid = '| A | B |\n| --- | --- |\n| one | two |\n| three | four |';
const output = { keyboard: false, formatting: false, tableFormatting: false, selectionMatchHighlight: false, performance: [] };

(async () => {
  const server = http.createServer((req, res) => {
    let url = new URL(req.url, 'http://localhost').pathname;
    const old = url.startsWith('/baseline/');
    if (old) url = url.slice('/baseline'.length);
    if (url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html(old ? 'baseline/' : '')); return; }
    const filename = path.resolve(repo, '.' + url);
    if (!url.startsWith('/assets/') || !filename.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(filename)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(old && baseline.has(path.basename(filename)) ? baseline.get(path.basename(filename)) : fs.readFileSync(filename));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.editor);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const snapshot = () => page.evaluate(() => editor.snapshot());
    async function reset(value, anchor = value.length, head = anchor, sourceMode = false) {
      await page.evaluate(({ value, anchor, head, sourceMode }) => { editor.setSourceMode(sourceMode); editor.setDocument({ value, notePath: 'input.md', anchor, head, scrollTop: 0 }); editor.focus(); }, { value, anchor, head, sourceMode });
      await settle();
    }
    if (!performanceOnly && !profileOnly) {
      await page.evaluate(() => {
        window.matchHighlightPlugin = RelatumCodeMirror.highlightSelectionMatches().find(extension => extension instanceof RelatumCodeMirror.ViewPlugin);
      });
      const matchingActive = () => page.evaluate(() => !!editor.view.plugin(matchHighlightPlugin));
      assert.equal(await matchingActive(), false, 'matching plugin is absent by default');
      for (const mode of [false, true]) for (const [value, length] of [
        ['a bc ca a aaaaa', 1], ['汉 汉字 汉', 1], ['文字 重复文字 文字', 2], ['match matching match', 5],
      ]) {
        await reset(value, 0, length, mode);
        const before = await snapshot();
        assert.equal(await page.locator('.cm-selectionMatch').count(), 0);
        await page.evaluate(() => { window.matchView = editor.view; window.matchDoc = editor.view.state.doc; editor.setSelectionMatchHighlight(true); });
        await settle();
        assert.equal(await matchingActive(), true);
        assert(await page.locator('.cm-selectionMatch').count() > 0, 'enabled matching marks nearby text');
        await page.evaluate(() => { window.enabledState = editor.view.state; editor.setSelectionMatchHighlight(true); });
        assert(await page.evaluate(() => editor.view.state === enabledState), 'repeating the current setting is a no-op');
        await page.evaluate(() => editor.setSelectionMatchHighlight(false)); await settle();
        assert.equal(await matchingActive(), false, 'disabling removes the matching plugin');
        assert.equal(await page.locator('.cm-selectionMatch').count(), 0);
        assert(await page.evaluate(() => editor.view === matchView && editor.view.state.doc === matchDoc));
        assert.deepEqual(await snapshot(), before, 'toggles preserve source, selection and scroll');
      }
      await reset(Array.from({ length: 180 }, (_, i) => '重复文字 paragraph ' + i).join('\n'), 0, 2);
      await page.evaluate(() => { editor.view.scrollDOM.scrollTop = 720; }); await settle();
      const scrolled = await snapshot();
      await page.evaluate(() => { editor.setSelectionMatchHighlight(true); editor.setSelectionMatchHighlight(false); }); await settle();
      assert.deepEqual(await snapshot(), scrolled, 'scrolled documents retain their viewport');
      await reset('same same');
      await page.keyboard.insertText('!');
      await page.evaluate(() => { editor.setSelectionMatchHighlight(true); editor.setSelectionMatchHighlight(false); RelatumCodeMirror.undo(editor.view); });
      assert.equal((await snapshot()).value, 'same same', 'setting changes do not add undo steps');
      await reset('文字 文字', 0, 2);
      await page.evaluate(() => RelatumCodeMirror.openSearchPanel(editor.view)); await settle();
      assert(await page.locator('.cm-searchMatch').count() > 0, 'explicit search still highlights matches while automatic matching is off');
      assert.equal(await matchingActive(), false);
      await page.evaluate(() => RelatumCodeMirror.closeSearchPanel(editor.view));

      const matchCdp = await page.context().newCDPSession(page);
      for (const enabled of [true, false]) {
        await reset('汉 汉 汉', 0, 1);
        await matchCdp.send('Input.imeSetComposition', { text: 'han', selectionStart: 3, selectionEnd: 3 });
        assert(await page.evaluate(() => editor.inputPending));
        const previouslyActive = await matchingActive();
        await page.evaluate(enabled => {
          editor.setSelectionMatchHighlight(!enabled);
          editor.setSelectionMatchHighlight(enabled);
        }, enabled);
        assert.equal(await matchingActive(), previouslyActive, 'composition defers plugin changes');
        await matchCdp.send('Input.insertText', { text: '汉' });
        await page.waitForFunction(() => !editor.inputPending); await settle();
        assert.equal(await matchingActive(), enabled, 'composition applies only the latest choice');
        assert.equal((await snapshot()).value, '汉 汉 汉');
      }
      await matchCdp.detach();
      await page.evaluate(() => {
        const host = document.createElement('div'); document.body.append(host);
        const temporary = RelatumNoteLiveEditor.create(host, { value: 'x x', selectionMatchHighlight: true });
        window.createdWithMatching = !!temporary.view.plugin(matchHighlightPlugin);
        temporary.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        temporary.setSelectionMatchHighlight(false);
        temporary.destroy();
        temporary.setSelectionMatchHighlight(true);
        host.remove();
      });
      await settle();
      assert.equal(await page.evaluate(() => createdWithMatching), true, 'creation accepts the enabled option');
      output.selectionMatchHighlight = true;
      for (const mode of [false, true]) for (const [value, position] of [['apple', 5], ['apple', 2], ['# apple', 7], ['> apple', 7]]) {
        await reset(value, position, position, mode); await page.keyboard.press('Tab');
        assert.equal((await snapshot()).value, value.slice(0, position) + '\t' + value.slice(position));
        await page.keyboard.press('Shift+Tab'); assert.equal((await snapshot()).value, value);
      }
      await reset('apple\nbanana', 0, 12); await page.keyboard.press('Tab');
      assert.equal((await snapshot()).value, '  apple\n  banana');
      await page.keyboard.press('Shift+Tab'); assert.equal((await snapshot()).value, 'apple\nbanana');
      for (const value of ['- apple', '1. apple', '- [ ] apple']) {
        await reset(value); await page.keyboard.press('Enter'); await settle(); await page.keyboard.press('Enter');
        assert.equal((await snapshot()).value, value + '\n\n', 'the empty list item exits immediately');
      }
      for (const value of ['- parent\n- child', '1. parent\n2. child', '> 1. parent\n> 2. child']) {
        await reset(value); await page.keyboard.press('Tab'); await settle();
        const nested = await page.evaluate(() => ({ source: editor.snapshot().value, tree: RelatumCodeMirror.syntaxTree(editor.view.state).toString() }));
        assert(/ListItem\(ListMark,Paragraph,(?:QuoteMark,)?(?:Bullet|Ordered)List/.test(nested.tree), 'Tab creates a real nested list: ' + JSON.stringify(nested));
        await page.keyboard.press('Shift+Tab'); assert.equal((await snapshot()).value, value);
      }
      await reset('1. parent\n2. child\n   - descendant', 18); await page.keyboard.press('Tab');
      assert.equal((await snapshot()).value, '1. parent\n   2. child\n      - descendant');
      await reset('- first'); await page.keyboard.press('Tab'); assert.equal((await snapshot()).value, '- first');
      await reset('```js\nconst a = 1;\n```', 10); await page.keyboard.press('Tab');
      assert.equal((await snapshot()).value, '```js\n  const a = 1;\n```');
      await reset('> - apple'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
      assert.equal((await snapshot()).value, '> - apple\n> \n> ');
      await reset('- parent\n  - '); await page.keyboard.press('Enter');
      assert.equal((await snapshot()).value, '- parent\n- ');

      for (const [kind, mark] of [['bold', '**'], ['italic', '*'], ['strike', '~~'], ['highlight', '=='], ['inline-code', '`']]) {
        await reset('apple', 0, 5); await page.evaluate(kind => editor.executeCommand(kind), kind);
        assert.equal((await snapshot()).value, mark + 'apple' + mark);
        await page.evaluate(kind => editor.executeCommand(kind), kind); assert.equal((await snapshot()).value, 'apple');
        await reset(''); await page.evaluate(kind => editor.executeCommand(kind), kind);
        assert.equal((await snapshot()).value, mark + mark);
        await page.keyboard.insertText('apple'); await page.evaluate(kind => editor.executeCommand(kind), kind); await page.keyboard.insertText(' pear');
        assert.equal((await snapshot()).value, mark + 'apple' + mark + ' pear');
        await reset(''); await page.evaluate(kind => editor.executeCommand(kind), kind); await page.evaluate(kind => editor.executeCommand(kind), kind);
        assert.equal((await snapshot()).value, '');
      }
      await reset('**apple banana**', 2, 7); await page.keyboard.press('Control+b');
      assert.equal((await snapshot()).value, 'apple **banana**');
      await reset('**apple *pear* banana**', 9, 13); await page.keyboard.press('Control+b');
      assert.equal((await snapshot()).value, '**apple** *pear* **banana**');
      await page.keyboard.press('Control+z'); assert.equal((await snapshot()).value, '**apple *pear* banana**');
      for (const [value, from, to, expected] of [
        [' apple ', 0, 7, ' **apple** '],
        ['*apple*', 0, 7, '***apple***'],
        ['**[apple](https://example.com) banana**', 3, 8, '[apple](https://example.com) **banana**'],
        ['__applebanana__', 2, 7, 'apple**banana**'],
      ]) {
        await reset(value, from, to); await page.keyboard.press('Control+b');
        assert.equal((await snapshot()).value, expected);
        if (value === ' apple ' || value === '*apple*') { await page.keyboard.press('Control+b'); assert.equal((await snapshot()).value, value); }
      }
      for (const value of ['```js\nconst a = 1;\n```', '---\ntitle: apple\n---\n正文']) {
        await reset(value, value.indexOf('a')); await page.keyboard.press('Control+b'); assert.equal((await snapshot()).value, value);
      }
      await reset('', 0); await page.keyboard.press('Shift+Tab'); assert.equal((await snapshot()).value, '');
      for (const value of ['`', ' apple ', '  ']) {
        await reset(value, 0, value.length); await page.evaluate(() => editor.executeCommand('inline-code'));
        await page.evaluate(() => editor.executeCommand('inline-code')); assert.equal((await snapshot()).value, value, 'code span padding must not leak into the document');
      }
      output.keyboard = output.formatting = true;

      await reset(grid, 0);
      assert(!await page.evaluate(() => RelatumCodeMirror.syntaxTree(editor.view.state).toString().includes('TableCell')), 'projected cells do not build a second inline syntax tree');
      await page.evaluate(() => editor.setSourceMode(true)); await settle();
      assert(await page.evaluate(() => RelatumCodeMirror.syntaxTree(editor.view.state).toString().includes('TableCell')), 'source mode retains full GFM cell syntax');
      await page.evaluate(() => { const line = editor.view.state.doc.line(3); editor.view.dispatch({ changes: { from: line.from, to: line.to, insert: '| source | two |' }, userEvent: 'input.type' }); editor.setSourceMode(false); });
      await settle();
      assert.equal(await page.locator('td[data-table-row="1"][data-table-col="0"] .note-table-cell-content').innerText(), 'source');
      await page.evaluate(() => RelatumCodeMirror.undo(editor.view)); await settle(); assert.equal((await snapshot()).value, grid, 'source/live mode changes do not split or lose source history');

      const input = page.locator('textarea.note-table-cell-editor');
      await reset(grid); await page.locator('td[data-table-row="1"][data-table-col="0"]').click();
      const nativeHost = await input.elementHandle();
      await input.evaluate(node => node.setSelectionRange(0, 3)); await input.press('Control+b');
      assert.equal(await input.inputValue(), '**one**');
      assert(await nativeHost.evaluate(node => node === document.activeElement && node.isConnected));
      await input.press('Control+b'); assert.equal(await input.inputValue(), 'one');
      await page.evaluate(() => editor.setShortcutBindings({ bold: ['Mod-Alt-b'], highlight: ['Mod-Shift-h'], strike: ['Mod-Shift-s'] }));
      await input.press('Control+Alt+b'); assert.equal(await input.inputValue(), '**one**');
      await input.press('Control+b'); assert.equal(await input.inputValue(), '**one**', 'disabled default bindings stay disabled');
      await input.press('Control+Alt+b'); assert.equal(await input.inputValue(), 'one');
      await input.press('Control+Shift+h'); assert.equal(await input.inputValue(), '==one==');
      await input.press('Control+Shift+h'); assert.equal(await input.inputValue(), 'one');
      await input.press('Control+Shift+s'); assert.equal(await input.inputValue(), '~~one~~');
      await input.press('Control+z'); await settle();
      assert.equal(await page.locator('td[data-table-row="1"][data-table-col="0"] .note-table-cell-content').innerText(), 'one');
      output.tableFormatting = true;

      await reset(grid);
      await page.evaluate(() => {
        const line = editor.view.state.doc.line(3);
        editor.view.dispatch({ changes: { from: line.from, to: line.to, insert: '| changed | changed too |' }, effects: RelatumNoteTableEditor.cellUpdateEffect.of({ id: 'stale', epoch: -1 }) });
      });
      assert.equal(await page.locator('td[data-table-row="1"][data-table-col="1"] .note-table-cell-content').innerText(), 'changed too', 'invalid local notifications fall back to full source validation');

      for (const value of ['apple\t苹果', 'apple\t', 'apple\t苹果\npear\t梨']) {
        await reset(''); for (const part of value.split('\t').map((text, index) => ({ text, tab: index !== 0 }))) { if (part.tab) await page.keyboard.press('Tab'); await page.keyboard.insertText(part.text); }
        // A pasted newline is literal text, so this reproduces the source's tabs
        // without sending Enter through list continuation.
        assert.equal((await snapshot()).value, value);
        await page.evaluate(() => { editor.view.dispatch({ selection: RelatumCodeMirror.EditorSelection.range(0, editor.view.state.doc.length) }); editor.view.contentDOM.addEventListener('copy', event => { window.copied = event.clipboardData.getData('text/plain'); event.preventDefault(); }, { once: true }); });
        await page.keyboard.press('Control+c'); const copied = await page.evaluate(() => window.copied); assert.equal(copied, value);
        await reset(grid); await page.locator('td[data-table-row="1"][data-table-col="0"]').click();
        await page.evaluate(value => { const data = new DataTransfer(); data.setData('text/plain', value); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); }, copied);
        const rows = await page.evaluate(() => { const model = MarkdownTable.findTables(editor.snapshot().value)[0].model; return model.rows; });
        assert.deepEqual(rows.slice(0, value.split('\n').length), value.split('\n').map(row => row.split('\t')));
      }
    }
    if (benchmark) {
      const cdp = await page.context().newCDPSession(page);
      for (let round = 0; round < (profileOnly ? 1 : 3); round++) for (const rows of (profileOnly ? [400] : [400, 800])) for (const variant of (profileOnly ? ['current'] : round % 2 ? ['current', 'baseline'] : ['baseline', 'current'])) {
        await page.goto(`http://127.0.0.1:${server.address().port}/${variant === 'baseline' ? 'baseline/' : ''}`);
        await page.waitForFunction(() => window.editor);
        const value = ['| ' + Array(10).fill('head').join(' | ') + ' |', '| ' + Array(10).fill('---').join(' | ') + ' |',
          ...Array.from({ length: rows - 1 }, (_, r) => '| ' + Array.from({ length: 10 }, (_, c) => `r${r}c${c}`).join(' | ') + ' |')].join('\n');
        await reset(value, 0); await page.waitForFunction(rows => document.querySelectorAll('.note-table td').length === rows * 10, rows);
        await page.locator('td[data-table-row="1"][data-table-col="0"]').click(); await settle();
        await page.evaluate(() => {
          window.cost = { times: [], visited: 0, fullParse: 0, fullSerialize: 0, replaced: [], otherMutations: 0 };
          window.inputHost = document.activeElement;
          window.otherContent = document.querySelector('td[data-table-row="2"][data-table-col="1"] .note-table-cell-content').firstChild;
          new MutationObserver(records => records.forEach(record => {
            const cell = record.target.closest?.('td[data-table-row]');
            if (cell && (cell.dataset.tableRow !== '1' || cell.dataset.tableCol !== '0')) cost.otherMutations++;
          })).observe(document.querySelector('.note-table tbody'), { childList: true, subtree: true });
          const parse = MarkdownTable.parse, serialize = MarkdownTable.serialize, query = Element.prototype.querySelectorAll;
          MarkdownTable.parse = function (value, ...args) { if (value.length > 1000) cost.fullParse++; return parse.call(this, value, ...args); };
          MarkdownTable.serialize = function (model, ...args) { if (model.rows.length > 1) cost.fullSerialize++; return serialize.call(this, model, ...args); };
          Element.prototype.querySelectorAll = function (selector) { const result = query.call(this, selector); if (selector === 'td[data-table-row]') cost.visited += result.length; return result; };
          editor.view.dispatch({ effects: RelatumCodeMirror.StateEffect.appendConfig.of(RelatumCodeMirror.EditorView.updateListener.of(update => { if (update.docChanged) update.changes.iterChanges((from, to) => cost.replaced.push(to - from)); })) });
          inputHost.addEventListener('input', () => { window.inputStart = performance.now(); }, true);
          inputHost.addEventListener('input', () => cost.times.push(performance.now() - inputStart));
        });
        if (profileOnly) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 }); await cdp.send('Profiler.start'); }
        for (let index = 0; index < 30; index++) { await cdp.send('Input.insertText', { text: 'x' }); await page.waitForTimeout(20); }
        if (profileOnly) {
          const { profile } = await cdp.send('Profiler.stop');
          fs.writeFileSync(reportPath + '.cpu.json', JSON.stringify(profile));
          const totals = new Map();
          profile.samples.forEach((id, index) => totals.set(id, (totals.get(id) || 0) + profile.timeDeltas[index]));
          console.log(JSON.stringify(profile.nodes.map(node => ({ name: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber + 1, ms: (totals.get(node.id) || 0) / 1000 })).sort((a, b) => b.ms - a.ms).slice(0, 20)));
        }
        await settle();
        const result = await page.evaluate(() => ({ ...cost, sameHost: inputHost === document.activeElement && inputHost.isConnected,
          sameOtherContent: otherContent === document.querySelector('td[data-table-row="2"][data-table-col="1"] .note-table-cell-content').firstChild }));
        const times = result.times.slice(5).sort((a, b) => a - b);
        output.performance.push({ variant, round, rows, cells: rows * 10, medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.floor(times.length * .95)],
          visited: result.visited, fullParse: result.fullParse, fullSerialize: result.fullSerialize, maxReplaced: Math.max(...result.replaced), sameHost: result.sameHost, sameOtherContent: result.sameOtherContent, otherMutations: result.otherMutations, samplesMs: result.times.slice(5) });
        fs.writeFileSync(reportPath, JSON.stringify(output, null, 2));
        console.log(JSON.stringify(output.performance.at(-1)));
        if (variant === 'current') { assert(result.sameHost && result.sameOtherContent); assert.equal(result.otherMutations, 0); assert.equal(result.fullParse, 0); assert.equal(result.fullSerialize, 0); assert.equal(result.visited, 0); assert(Math.max(...result.replaced) < 200); }
      }
      for (const rows of (profileOnly ? [] : [400, 800])) {
        const values = variant => output.performance.filter(item => item.rows === rows && item.variant === variant);
        const median = values => values.sort((a, b) => a - b)[1];
        const before = values('baseline'), after = values('current');
        const beforeMedian = median(before.map(item => item.medianMs)), beforeP95 = median(before.map(item => item.p95Ms));
        assert(median(after.map(item => item.medianMs)) <= (noRegression ? Math.max(beforeMedian * 1.1, beforeMedian + 2) : .7 * beforeMedian),
          noRegression ? 'median cell input must stay within the same-host tolerance' : 'median cell input must improve by at least 30%');
        assert(median(after.map(item => item.p95Ms)) <= (noRegression ? Math.max(beforeP95 * 1.1, beforeP95 + 2) : beforeP95), 'p95 must not regress beyond the same-host tolerance');
      }
    }
    assert.deepEqual(await page.evaluate(() => errors), []);
    fs.writeFileSync(reportPath, JSON.stringify(output, null, 2));
    console.log(JSON.stringify({ reportPath, ...output }));
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
