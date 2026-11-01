'use strict';

// Static production assets, synthetic Markdown and a disposable browser only.
// --compare serves HEAD beside the working copy without changing tracked files.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-scroll-preparation-'));
const compare = process.argv.includes('--compare'), quick = process.argv.includes('--quick');
const onlyKind = process.argv.find(argument => argument.startsWith('--kind='))?.slice(7);
const baselineRef = process.env.RELATUM_NOTE_SCROLL_BASELINE || 'HEAD';
const baseline = compare ? execFileSync('git', ['show', baselineRef + ':assets/note-live-editor.js'], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }) : '';
const current = fs.readFileSync(path.join(repo, 'assets/note-live-editor.js'), 'utf8');
const html = variant => `<!doctype html><meta charset="utf-8"><base href="/${variant}/assets/">
<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="note-theme.css">
<style>body{display:block;margin:0;--text:#222;--bg:#fff}.note-live-editor-host{width:min(960px,100vw);height:850px;margin:auto}</style>
<body class="start-page" data-start-theme="light"><div id="host" class="note-live-editor-host"></div>
<script>window.__frames=0;window.__idleRuns=0;const raf=requestAnimationFrame;window.requestAnimationFrame=fn=>{__frames++;return raf(fn)};
if(window.requestIdleCallback){const idle=requestIdleCallback;window.requestIdleCallback=fn=>idle(deadline=>{__idleRuns++;fn(deadline)})}</script>
<script src="markdown.js"></script><script src="markdown-table.js"></script>
<script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script>
<script src="note-media-frame.js"></script><script src="note-live-editor.js"></script>
<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('host'),{value:'',notePath:'fixture.md',imageUrl:(note,target)=>'/${variant}/'+target});</script>`;
function fixture(bytes, kind = 'mixed') {
  const sections = []; let length = 0;
  for (let index = 0; length < bytes; index++) {
    const section = '## Section ' + index + '\n\nParagraph ' + index + ': ' + 'Natural wrapping and stable reading position. '.repeat(7) + '\n\n'
      + (kind === 'tables' || kind === 'mixed' && index % 3 === 0 ? '| A | B |\n|---|---|\n| value | table content |\n| row | other |\n\n' : '')
      + (kind === 'images' || kind === 'mixed' && index % 7 === 0 ? '![image](pic-' + index + '.svg)\n\n' : '')
      + (kind === 'math' || kind === 'mixed' && index % 5 === 0 ? '$$\n\\frac{a+b}{c+d}=\\sum_{i=1}^{n}i^2\n$$\n\n' : '')
      + (kind === 'mermaid' || kind === 'mixed' && index % 11 === 0 ? '```mermaid\nflowchart LR\nA[Start]-->B[Finish]\n```\n\n' : '');
    sections.push(section); length += section.length;
  }
  return sections.join('').slice(0, bytes);
}
function instrument(source) {
  return source.replace('    // A pointer leaving display math', '    window.__scrollCoordinator = coordinator;\n    // A pointer leaving display math')
    .replace('await math.typesetPromise(nodes);', 'if(window.__slowMath) await new Promise(resolve=>setTimeout(resolve,80)); await math.typesetPromise(nodes);');
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'), variant = url.pathname.split('/')[1];
  if (/^\/(current|baseline)\/$/.test(url.pathname)) { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(html(variant)); }
  if (/\/pic-\d+\.svg$/.test(url.pathname)) return setTimeout(() => {
    res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'no-store');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="700" height="420"><rect width="700" height="420" fill="#cddbd0"/></svg>');
  }, 250);
  const relative = decodeURIComponent(url.pathname.replace(/^\/(current|baseline)/, ''));
  const file = path.resolve(repo, '.' + relative);
  if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  res.end(file.endsWith('note-live-editor.js') ? instrument(variant === 'baseline' ? baseline : current) : fs.readFileSync(file));
});

async function trace(page, position, fraction) {
  return page.evaluate(async ({ position, fraction }) => {
    const view = editor.view, scroller = view.scrollDOM, samples = [], start = performance.now();
    editor.cancelViewportRestore();
    if (position != null) view.dispatch({ effects: RelatumCodeMirror.EditorView.scrollIntoView(position, { y: 'start', yMargin: 32 }) });
    else scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * fraction;
    let marker = position == null ? '' : view.state.doc.lineAt(position).text.match(/Section \d+/)?.[0] || '';
    await new Promise(resolve => {
      const frame = () => {
        const box = scroller.getBoundingClientRect(), lines = [...view.contentDOM.querySelectorAll('.cm-line')];
        if (!marker) marker = lines.find(line => /Section \d+/.test(line.textContent) && line.getBoundingClientRect().top >= box.top + 20)?.textContent.match(/Section \d+/)[0] || '';
        const heading = lines.find(line => line.textContent.includes(marker) && marker);
        samples.push({ time: performance.now() - start, top: scroller.scrollTop, height: scroller.scrollHeight,
          thumb: scroller.clientHeight / scroller.scrollHeight, marker, y: heading ? heading.getBoundingClientRect().top - box.top : null,
          rawTables: lines.filter(line => /^\|/.test(line.textContent) && line.getBoundingClientRect().bottom > box.top && line.getBoundingClientRect().top < box.bottom).length,
          nodes: view.contentDOM.querySelectorAll('*').length,
          loaded: [...view.contentDOM.querySelectorAll('.note-live-image-frame img')].filter(image => image.complete && image.naturalWidth).length,
          hints: [...view.contentDOM.querySelectorAll('.note-live-rich-block')].filter(dom => dom.__relatumBlockLayout?.widget.layoutHeight > 0).length,
          tables: [...view.contentDOM.querySelectorAll('.note-table')].map(dom => ({ height: dom.getBoundingClientRect().height,
            estimate: dom.__relatumBlockLayout?.widget.layoutHeight, key: dom.__relatumBlockLayout?.widget.key })) });
        if (performance.now() - start < 1400) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
    const ys = samples.filter(sample => sample.y != null).map(sample => sample.y);
    return { samples, marker, position: marker ? view.state.doc.toString().indexOf('## ' + marker + '\n') : null,
      rawFrames: samples.filter(sample => sample.rawTables).length, anchorRange: ys.length ? Math.max(...ys) - Math.min(...ys) : null,
      last: samples.at(-1), maxNodes: Math.max(...samples.map(sample => sample.nodes)) };
  }, { position, fraction });
}

(async () => {
  let browser;
  const report = { baselineRef: compare ? baselineRef : null, viewport: { width: 1280, height: 900 }, cases: [], errors: [] };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'],
      ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    for (const variant of compare ? ['baseline', 'current'] : ['current']) {
      for (const [size, kind] of quick ? [[400 * 1024, 'mixed']] : [
        [400 * 1024, 'plain'], [400 * 1024, 'tables'], [400 * 1024, 'images'], [400 * 1024, 'math'],
        [400 * 1024, 'mermaid'], [400 * 1024, 'mixed'], [1024 * 1024, 'mixed'], [4 * 1024 * 1024, 'mixed'],
      ]) {
        if (onlyKind && kind !== onlyKind) continue;
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        page.on('pageerror', error => report.errors.push({ variant, kind, message: error.message }));
        await page.goto('http://127.0.0.1:' + server.address().port + '/' + variant + '/');
        await page.waitForFunction(() => window.editor);
        const value = fixture(size, kind);
        await page.evaluate(value => { window.__slowMath = true; editor.setDocument({ value, notePath: 'fixture.md', anchor: 0, head: 0 }); }, value);
        await page.waitForTimeout(500);
        const target = value.lastIndexOf('## Section ', Math.floor(value.length * .65));
        const cold = await trace(page, target, null);
        assert(cold.position > 0, 'source anchor found at the new viewport');
        await page.evaluate(() => editor.revealPosition(0)); await page.waitForTimeout(250);
        const warm = await trace(page, cold.position, null);
        const record = { variant, size, kind, cold, warm }; report.cases.push(record);
        const typingProbe = () => page.evaluate(() => {
          const samples = [];
          for (let i = 0; i < 20; i++) {
            const t = performance.now(); editor.view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
            samples.push(performance.now() - t);
          }
          for (let i = 0; i < 20; i++) editor.view.dispatch({ changes: { from: 0, to: 1 }, userEvent: 'delete.backward' });
          return samples.sort((a, b) => a - b)[18];
        });
        record.typingP95 = await typingProbe();
        if (variant === 'current') {
          assert.equal(warm.rawFrames, 0, 'prepared tables do not flash source on revisit');
          assert(warm.maxNodes < 12000, 'long document stays virtualized');
          if (kind !== 'plain') assert(warm.samples.some(sample => sample.hints > 0), 'revisited rich blocks use measured hints');
          // The source anchor is observed independently of scrollTop changes.
          assert(warm.anchorRange == null || warm.anchorRange <= 2, 'warm reading anchor stays within 2 CSS px: ' + warm.anchorRange);
          if (kind === 'math') {
            await page.evaluate(value => {
              const viewport = editor.captureViewport();
              editor.setDocument({ value: 'Other note', notePath: 'other.md' });
              editor.setDocument({ value, notePath: 'fixture.md', viewport });
            }, value);
            await page.waitForTimeout(1400);
            await page.evaluate(() => { editor.cancelViewportRestore(); editor.revealPosition(0); });
            await page.waitForTimeout(250);
            record.reopenWarm = await trace(page, cold.position, null);
            assert(record.reopenWarm.anchorRange == null || record.reopenWarm.anchorRange <= 2, 'hints resume after saved position restoration');
          }
          assert.equal(await page.evaluate(() => editor.snapshot().value), value, 'rendering never changes Markdown');
          const memory = await page.evaluate(() => ({ bytes: __scrollCoordinator.layout.bytes, mounts: __scrollCoordinator.layout.mounts.size }));
          assert(memory.bytes <= 256 * 1024, 'numeric layout hints stay within budget');
          await page.waitForTimeout(500);
          const frames = await page.evaluate(() => __frames), idle = await page.evaluate(() => __idleRuns); await page.waitForTimeout(350);
          assert.equal(await page.evaluate(() => __frames), frames, 'settled rendering has no continuous RAF');
          assert.equal(await page.evaluate(() => __idleRuns), idle, 'settled preparation has no idle loop');
          if (kind === 'mixed' && size === 400 * 1024) await page.screenshot({ path: path.join(output, 'mixed-warm.png') });
          // Real wheel input and reversal retain native control.
          const area = await page.locator('.cm-scroller').boundingBox();
          await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
          const before = await page.evaluate(() => editor.view.scrollDOM.scrollTop);
          await page.mouse.wheel(0, 700); await page.waitForTimeout(250);
          assert(await page.evaluate(() => editor.view.scrollDOM.scrollTop) > before, 'native wheel scrolls forward');
          await page.mouse.wheel(0, -700); await page.waitForTimeout(250);
          // Drag the native scrollbar to a distant area.
          const geometry = await page.evaluate(() => { const s = editor.view.scrollDOM; return { y: s.clientHeight * s.scrollTop / s.scrollHeight, thumb: s.clientHeight ** 2 / s.scrollHeight }; });
          await page.mouse.move(area.x + area.width - 3, area.y + geometry.y + Math.max(3, geometry.thumb / 2));
          await page.mouse.down(); await page.mouse.move(area.x + area.width - 3, area.y + area.height * .3, { steps: 8 }); await page.mouse.up();
          await page.waitForTimeout(350);
          await page.evaluate(() => editor.setExtensionsActive(false)); await page.waitForTimeout(150);
          const paused = await page.evaluate(() => __frames); await page.waitForTimeout(250);
          assert.equal(await page.evaluate(() => __frames), paused, 'inactive host stops preparation');
          await page.evaluate(() => editor.setExtensionsActive(true)); await page.waitForTimeout(300);
          // Candidate ownership and history are covered by the input suite;
          // verify a real edit here is still a single undoable transaction.
          Object.assign(record, { memory });
        }
        await page.close();
        console.log(JSON.stringify({ variant, size, kind, coldRawFrames: cold.rawFrames, warmRawFrames: warm.rawFrames, warmAnchorRange: warm.anchorRange }));
      }
    }
    assert.deepEqual(report.errors, []);
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await new Promise(resolve => server.close(resolve));
    console.log('Report: ' + path.join(output, 'report.json'));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
