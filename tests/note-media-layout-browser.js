'use strict';
// Static production assets, synthetic Markdown, disposable browser/artifacts.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-media-layout-'));
const scripts = ['markdown-table.js', 'markdown.js', 'vendor/codemirror/relatum-codemirror.min.js', 'note-table-editor.js', 'note-media-frame.js', 'note-media.js', 'note-live-editor.js'];
const html = '<!doctype html><meta charset="utf-8"><base href="/assets/"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="note-theme.css">'
  + '<style>body{margin:0;display:block}.note-workspace{display:block!important;height:100vh}.note-document-pane{height:100%;margin:0!important}.note-document-pane::before{display:none}.note-document-body{height:100%;margin:0!important}.note-live-editor-host{width:min(960px,100vw);height:100vh;margin:auto}</style><body class="start-page" data-start-theme="light" data-start-workspace="notes">'
  + '<main class="note-workspace"><section class="note-document-pane"><div class="note-document-body"><div id="host" class="note-live-editor-host"></div></div></section></main>' + scripts.map(file => '<script src="' + file + '"></script>').join('')
  + '<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById("host"),{value:"",notePath:"layout.md",imageUrl:()=>"/image.svg"});</script>';
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (name === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(html); }
  if (name === '/image.svg') { res.setHeader('Content-Type', 'image/svg+xml'); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="#ddd"/></svg>'); }
  const file = path.resolve(repo, '.' + decodeURIComponent(name));
  if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file));
});
(async () => {
  const report = { cases: [], errors: [] }; let browser;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => report.errors.push(error.stack));
    await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction(() => window.editor);
    for (const standalone of [false, true]) {
      if (standalone) { await page.addStyleTag({ url: '/assets/markdown-file.css' }); await page.evaluate(() => document.body.classList.add('markdown-window')); }
      for (const theme of ['default', 'claude', 'sky', 'apple']) for (const dark of [false, true]) for (const narrow of [false, true]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width: narrow ? 480 : 1280, height: 1100 });
        const result = await page.evaluate(async ({ theme, dark, scale }) => {
          const pause = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          document.documentElement.dataset.noteTheme = theme; document.body.dataset.startTheme = dark ? 'dark' : 'light';
          document.querySelector('.note-document-pane').style.setProperty('--note-font-scale', scale);
          const lines = ['# TOKENH1', '## TOKENH2', '### TOKENH3', '#### TOKENH4', '##### TOKENH5', '###### TOKENH6', '',
            'PLAINTOKEN normal text with automatic wrapping '.repeat(3), '**BOLDTOKEN** and `CODETOKEN`', '', '',
            '## GAPTOKEN', 'PARATOKEN', '', '- LISTTOKEN item', '- NEXTTOKEN item', '', '3. NUMTOKEN item', '4. FOURTOKEN item', '', 'ENDTOKEN'];
          const source = '> [!media]\n> ![image|200](image.svg)\n>\n' + lines.map(row => '> ' + row).join('\n');
          editor.setDocument({ value: source, notePath: 'layout.md' }); await pause(); await document.fonts.ready; await pause();
          const root = document.querySelector('.note-media'), surface = root.__noteMedia;
          const tokens = ['TOKENH1', 'TOKENH2', 'TOKENH3', 'TOKENH4', 'TOKENH5', 'TOKENH6', 'PLAINTOKEN', 'BOLDTOKEN', 'CODETOKEN', 'GAPTOKEN', 'PARATOKEN', 'LISTTOKEN', 'NEXTTOKEN', 'NUMTOKEN', 'FOURTOKEN', 'ENDTOKEN'];
          function geometry() {
            const base = root.getBoundingClientRect(), result = {};
            for (const token of tokens) {
              const walker = document.createTreeWalker(surface.body, NodeFilter.SHOW_TEXT); let node;
              while ((node = walker.nextNode()) && !node.textContent.includes(token)) {}
              if (!node) throw Error('Missing ' + token);
              const at = node.textContent.indexOf(token), range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + token.length);
              const rect = range.getBoundingClientRect(), style = getComputedStyle(node.parentElement);
              const line = node.parentElement.closest('.cm-line, .note-live-heading, p, li'), lineStyle = getComputedStyle(line);
              result[token] = { x: rect.x - base.x, y: rect.y - base.y, width: rect.width, height: rect.height,
                line: { height: line.getBoundingClientRect().height, top: line.getBoundingClientRect().y - base.y, padding: lineStyle.padding, border: lineStyle.border, display: lineStyle.display },
                font: style.fontFamily, fontSize: style.fontSize, weight: style.fontWeight, spacing: style.letterSpacing, lineHeight: style.lineHeight };
            }
            return result;
          }
          const before = geometry(); surface.open(); await pause(); await pause(); const editing = geometry();
          surface.close(); await pause(); await pause(); const after = geometry();
          const box = root.getBoundingClientRect(), target = after.TOKENH3;
          surface.open({ x: box.x + target.x + target.width / 2, y: box.y + target.y + target.height / 2 });
          await pause();
          if (!surface.input.state.doc.lineAt(surface.input.state.selection.main.head).text.includes('TOKENH3')) throw Error('Heading click resolved to the wrong line');
          const focused = geometry();
          for (const token of tokens) if (Math.abs(focused[token].y - before[token].y) > 1) throw Error('Heading caret shifted ' + token);
          surface.close(); await pause();
          if (editor.snapshot().value !== source) throw Error('Focus changed Markdown');
          return { before, editing, after };
        }, { theme, dark, scale });
        const identity = { standalone, theme, dark, narrow, scale };
        fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify({ ...identity, ...result }, null, 2));
        for (const token of Object.keys(result.before)) for (const phase of ['editing', 'after']) {
          const a = result.before[token], b = result[phase][token];
          for (const metric of ['x', 'y', 'width', 'height']) assert(Math.abs(a[metric] - b[metric]) <= 1, JSON.stringify({ ...identity, token, phase, metric, a, b }));
          for (const metric of ['font', 'fontSize', 'weight', 'spacing', 'lineHeight']) assert.equal(b[metric], a[metric], JSON.stringify({ ...identity, token, phase, metric }));
        }
        report.cases.push(identity);
        if (theme === 'apple' && !dark && !narrow && scale === 1) await page.screenshot({ path: path.join(output, 'apple-' + standalone + '.png') });
      }
    }
    assert.deepEqual(report.errors, []);
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await new Promise(resolve => server.close(resolve)); console.log('Report: ' + path.join(output, 'report.json'));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
