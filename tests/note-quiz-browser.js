'use strict';
// Synthetic Markdown and disposable browser contexts; no production data or server.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-quiz-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fence = (body = '电流是多少？\n\n- [ ] 0 mA\n- [x] 6 mA\n- [ ] 12 mA\n\n---\n**解析**保持不变。') => '```quiz\n' + body + '\n```';
const sample = '# Quiz\n\n' + fence() + '\n\n最后正文';
function html(off) { return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><style>body{display:block;margin:0;--bg:#fbfbfa;--text:#222;--text-secondary:#777;--border:#ddd;color:var(--text);background:var(--bg)}
main{width:min(850px,100%);box-sizing:border-box;margin:auto;padding:24px;height:100vh}#editor,#reading,#guide{height:calc(100vh - 48px);overflow:auto}[hidden]{display:none!important}
body[data-start-theme=dark]{--bg:#202320;--text:#eee;--text-secondary:#bbb}</style><body class="start-page"><main><div id="editor" class="note-live-editor-host"></div><div id="reading" hidden></div><div id="guide" hidden></div></main>
<script>window.RelatumFeatureRuntime={enabled:key=>key!=='notes.canvas'&&key!=='notes.mermaid'&&(${!off}||key!=='notes.quiz')};window.changes=0;window.saves=0;window.rafCount=0;const realRaf=requestAnimationFrame;window.requestAnimationFrame=fn=>{rafCount++;return realRaf(fn)};</script>
<script src="markdown-table.js"></script><script src="markdown.js"></script><script src="vendor/codemirror/relatum-codemirror.min.js"></script>
<script src="note-table-editor.js"></script><script src="note-media-frame.js"></script><script src="note-live-editor.js"></script><script src="note-guide.js"></script>
<script>window.testEditor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:'普通文字',notePath:'plain.md',onDocChanged:()=>changes++,onSaveRequest:()=>saves++,onOpenExternal:value=>window.openedLink=value});
window.setSample=(source,mode='live',note='fixture.md')=>{const e=document.getElementById('editor'),r=document.getElementById('reading'),g=document.getElementById('guide');
 testEditor.snapshot();RelatumNoteLiveEditor.releaseReadingDocument(r);window.quizGuide?.suspend();e.hidden=mode==='reading';r.hidden=mode!=='reading';g.hidden=true;
 testEditor.setSourceMode(mode==='source');testEditor.setDocument({value:source,notePath:note,anchor:source.length,head:source.length,scrollTop:0});
 if(mode==='reading')RelatumNoteLiveEditor.renderMarkdown(r,source,note,{onOpenExternal:value=>window.openedLink=value});};
window.showGuide=()=>{document.getElementById('editor').hidden=true;document.getElementById('reading').hidden=true;const host=document.getElementById('guide');host.hidden=false;
 window.quizGuide ||= RelatumNoteGuide.create({host,language:()=>document.documentElement.lang,isCurrent:()=>!host.hidden,quizFence:RelatumNoteLiveEditor.quizFence,attachQuiz:RelatumNoteLiveEditor.attachQuiz});quizGuide.show('quiz');};
</script></body></html>`; }
(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/off') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html(url.pathname === '/off')); return; }
    const file = path.resolve(repo, '.' + url.pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  const errors = [], requests = [], external = [], report = { checks: [] }; let context, page;
  async function fresh(off = false, before) {
    await context?.close(); context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await before?.(context); page = await context.newPage(); page.on('pageerror', error => errors.push(error.stack));
    page.on('request', req => { requests.push(req.url()); if (!req.url().startsWith(base)) external.push(req.url()); });
    await page.goto(base + (off ? '/off' : '/')); await page.waitForFunction(() => !!window.testEditor); return page;
  }
  const set = (value, mode = 'live', note = 'fixture.md') => page.evaluate(([source, mode, note]) => setSample(source, mode, note), [value, mode, note]);
  const quiz = () => page.locator('#editor .note-quiz').first();
  const option = (root, index) => root.locator('[data-quiz-option="' + index + '"]');
  try {
    await fresh(); const initial = requests.length;
    await set('普通文字\n\n- [ ] 普通任务', 'live'); await pause(180);
    await set(sample, 'source'); await pause(180);
    assert.equal(requests.slice(initial).filter(url => /note-quiz/.test(url)).length, 0, 'plain/source notes load no quiz assets');
    await set(sample); await quiz().waitFor(); const q = quiz();
    assert.equal(await page.locator('#editor .note-live-code-line,#editor .note-live-code-language').count(), 0, 'projected quiz has no leftover code background or badge');
    assert.equal(await q.getAttribute('data-quiz-state'), 'unanswered'); assert.equal(await q.locator('.note-quiz-feedback').isVisible(), false);
    const before = await page.evaluate(() => ({ source: testEditor.snapshot().value, changes, saves, history: RelatumCodeMirror.undoDepth?.(testEditor.view.state) }));
    await option(q, 0).click(); assert.equal(await q.getAttribute('data-quiz-state'), 'incorrect');
    const feedback = await q.locator('.note-quiz-feedback-body').textContent();
    await page.evaluate(() => window.feedbackIdentity = document.querySelector('#editor .note-quiz-feedback-body'));
    await option(q, 1).click(); assert.equal(await q.getAttribute('data-quiz-state'), 'correct');
    assert.equal(await q.locator('.note-quiz-feedback-body').textContent(), feedback);
    assert(await page.evaluate(() => feedbackIdentity === document.querySelector('#editor .note-quiz-feedback-body')));
    assert.deepEqual(await page.evaluate(() => ({ source: testEditor.snapshot().value, changes, saves, history: RelatumCodeMirror.undoDepth?.(testEditor.view.state) })), before);
    assert.equal(await page.locator('#editor .is-quiz').count(), 1, 'answering keeps the projected quiz');
    await set(sample, 'reading'); const reading = page.locator('#reading .note-quiz').first(); await reading.waitFor();
    assert.equal(await reading.getAttribute('data-quiz-state'), 'correct');
    await set('Other note', 'live', 'other.md'); await set(sample); await quiz().waitFor(); assert.equal(await quiz().getAttribute('data-quiz-state'), 'correct');
    await quiz().locator('.note-quiz-reset').click(); assert.equal(await quiz().getAttribute('data-quiz-state'), 'unanswered');
    await option(quiz(), 0).focus(); await page.keyboard.press('ArrowDown'); assert.equal(await quiz().getAttribute('data-quiz-state'), 'correct');
    await page.evaluate(() => testEditor.view.dispatch({ changes: { from: 0, insert: '前缀\n\n' } }));
    await quiz().waitFor(); assert.equal(await quiz().getAttribute('data-quiz-state'), 'correct', 'unrelated edit maps the answer');
    const changed = '前缀\n\n' + sample; await set(changed, 'reading'); await page.locator('#reading .note-quiz').waitFor();
    assert.equal(await page.locator('#reading .note-quiz').getAttribute('data-quiz-state'), 'correct', 'source ranges agree across modes');
    await set(changed); await quiz().waitFor(); await quiz().hover(); await quiz().locator('.note-quiz-edit').click();
    await page.waitForFunction(() => !document.querySelector('#editor .note-quiz'));
    await page.evaluate(() => { const view = testEditor.view, at = view.state.doc.toString().indexOf('电流是多少'); view.dispatch({ changes: { from: at, to: at + 5, insert: '改后的题目' } }); view.dispatch({ selection: { anchor: view.state.doc.length } }); view.focus(); });
    await quiz().waitFor(); assert.equal(await quiz().getAttribute('data-quiz-state'), 'unanswered', 'editing a question resets it');
    report.checks.push('interaction/source/history/modes/positions/editing');
    await set(fence() + '\n\n' + fence() + '\n\n尾段', 'reading', 'duplicates.md');
    const duplicates = page.locator('#reading .note-quiz'); await duplicates.nth(1).waitFor();
    await option(duplicates.nth(0), 1).click(); assert.equal(await duplicates.nth(1).getAttribute('data-quiz-state'), 'unanswered');
    await page.evaluate(() => RelatumNoteLiveEditor.remapQuiz('duplicates.md', 'moved.md'));
    await set(fence() + '\n\n' + fence() + '\n\n尾段', 'reading', 'moved.md'); await page.locator('#reading .note-quiz').nth(1).waitFor();
    assert.equal(await page.locator('#reading .note-quiz').first().getAttribute('data-quiz-state'), 'correct');
    await set('# 外部替换\n\n' + fence() + '\n\n尾段', 'reading', 'moved.md'); await page.locator('#reading .note-quiz').waitFor();
    assert.equal(await page.locator('#reading .note-quiz').getAttribute('data-quiz-state'), 'unanswered');
    await set('> [!note]\n>\n' + fence().split('\n').map(line => '> ' + line).join('\n') + '\n\n尾段'); await quiz().waitFor(); await option(quiz(), 1).click();
    assert.equal(await quiz().getAttribute('data-quiz-state'), 'correct');
    const quoteSource = await page.evaluate(() => testEditor.snapshot().value); await set(quoteSource, 'reading'); await page.locator('#reading .note-quiz').waitFor();
    assert.equal(await page.locator('#reading .note-quiz').getAttribute('data-quiz-state'), 'correct');
    const frontmatter = '---\ntitle: Example\n---\n\n# 标题\n\n' + fence() + '\n\n尾段';
    await set(frontmatter, 'live', 'frontmatter.md'); await quiz().waitFor(); await option(quiz(), 1).click(); await set(frontmatter, 'reading', 'frontmatter.md');
    await page.locator('#reading .note-quiz').waitFor(); assert.equal(await page.locator('#reading .note-quiz').getAttribute('data-quiz-state'), 'correct');
    report.checks.push('duplicates/remap/external/callout/frontmatter');
    await set(fence('无效题\n- [x] a\n- [x] b'), 'reading'); await page.locator('#reading .note-quiz-error').waitFor();
    assert.equal(await page.locator('#reading input[type=radio]').count(), 0);
    await set('```quiz\n未闭合\n- [x] a\n- [ ] b'); await pause(100); assert.equal(await quiz().count(), 0);
    await set(fence('链接 [说明](https://example.com)\n- [x] **正确**\n- [ ] `错误`'), 'reading'); await page.locator('#reading .note-quiz a').click();
    assert.equal(await page.evaluate(() => openedLink), 'https://example.com'); assert.equal(await page.locator('#reading .note-quiz').getAttribute('data-quiz-state'), 'unanswered');
    await page.evaluate(() => showGuide()); await page.locator('#guide .note-quiz').first().waitFor();
    await option(page.locator('#guide .note-quiz').first(), 1).click(); assert.equal(await page.locator('#guide .note-quiz').first().getAttribute('data-quiz-state'), 'correct');
    assert.equal(await page.locator('#guide .note-quiz').nth(1).getAttribute('data-quiz-state'), 'unanswered');
    await page.evaluate(() => { quizGuide.suspend(); quizGuide.show('quiz'); }); await page.locator('#guide .note-quiz').first().waitFor();
    assert.equal(await page.locator('#guide .note-guide-copy').count(), 2); report.checks.push('invalid/link/guide');
    await set(fence('公式 $I=U/R$\n- [x] $6$ mA\n- [ ] $0$ mA\n---\n$I=12/2000$'), 'reading', 'math.md');
    await page.locator('#reading .note-quiz-question mjx-container').waitFor({ timeout: 30000 });
    await option(page.locator('#reading .note-quiz'), 0).click(); await page.locator('#reading .note-quiz-feedback mjx-container').first().waitFor();
    await page.setViewportSize({ width: 480, height: 850 }); await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; document.documentElement.lang = 'en'; document.dispatchEvent(new Event('relatum:languagechange')); });
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.locator('#reading .note-quiz-reset').getByText('Try again').waitFor();
    await page.screenshot({ path: path.join(output, 'quiz-dark-narrow.png') });
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await pause(100); const frozen = await page.evaluate(() => rafCount); await pause(180); assert.equal(await page.evaluate(() => rafCount), frozen);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    assert.equal(await page.locator('#reading .note-quiz').getAttribute('data-quiz-state'), 'correct'); report.checks.push('math/language/dark/narrow/reduced/minimized');
    await fresh(); await set(Array.from({ length: 100 }, (_, i) => '## ' + i + '\n\n' + fence()).join('\n\n'), 'reading'); await page.locator('#reading .note-quiz').first().waitFor();
    assert((await page.locator('#reading input[type=radio]').count()) < 45, 'only visible quizzes mount');
    await page.evaluate(() => { window.firstQuiz = document.querySelector('#reading .note-quiz'); const view = document.getElementById('reading'); view.scrollTop = view.scrollHeight; });
    await page.waitForFunction(() => document.querySelectorAll('#reading .note-quiz').length >= 2);
    await page.evaluate(() => document.getElementById('reading').scrollTop = 0); assert(await page.evaluate(() => firstQuiz === document.querySelector('#reading .note-quiz')));
    await pause(250); const idle = await page.evaluate(() => rafCount); await pause(250); assert.equal(await page.evaluate(() => rafCount), idle);
    report.checks.push('100-questions/lazy/DOM-reuse/idle');
    await fresh(true); const offStart = requests.length; await set(sample); await pause(150); await set(sample, 'reading'); await pause(150); await page.evaluate(() => showGuide()); await pause(150);
    assert.equal(requests.slice(offStart).filter(url => /note-quiz/.test(url)).length, 0); assert.equal(await page.locator('.note-quiz').count(), 0); assert.equal(await page.locator('[data-guide-quiz-disabled]').count(), 1);
    report.checks.push('disabled/resources');
    await fresh(false, ctx => ctx.route('**/note-quiz.js', async route => { await pause(250); await route.continue(); }));
    await set(sample); await page.locator('.note-quiz-carrier').waitFor(); await set('已切换的普通笔记', 'live', 'late.md'); await pause(400);
    assert.equal(await page.locator('.note-quiz').count(), 0); report.checks.push('late-load');
    await fresh(false, ctx => { let failed = false; return ctx.route('**/note-quiz.js', route => { if (!failed) { failed = true; return route.abort(); } return route.continue(); }); });
    await set(sample); await page.locator('[data-note-quiz-retry]').click(); await quiz().waitFor(); await option(quiz(), 1).click();
    assert.equal(await quiz().getAttribute('data-quiz-state'), 'correct');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const pagehideSource = await page.evaluate(() => testEditor.snapshot().value); await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    assert.equal(await page.evaluate(() => testEditor.snapshot().value), pagehideSource); assert.equal(await quiz().getAttribute('data-quiz-state'), 'correct');
    await page.screenshot({ path: path.join(output, 'quiz-light-live.png') });
    await page.reload(); await page.waitForFunction(() => !!window.testEditor); await set(sample); await quiz().waitFor(); assert.equal(await quiz().getAttribute('data-quiz-state'), 'unanswered');
    report.checks.push('retry/pagehide/reload');
    let releaseQuiz;
    const quizGate = new Promise(resolve => { releaseQuiz = resolve; });
    await fresh(false, ctx => ctx.route('**/note-quiz.js', async route => { await quizGate; await route.continue(); }));
    const pendingQuiz = page.waitForRequest('**/note-quiz.js'); await set(sample); await pendingQuiz;
    assert.equal(await page.locator('.note-quiz-fallback').isVisible(), false, 'loading never flashes the answer markers');
    await page.evaluate(() => testEditor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
    releaseQuiz(); await pause(100); assert.equal(await page.locator('.note-quiz').count(), 0);
    await page.evaluate(() => testEditor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
    await quiz().waitFor();
    await page.evaluate(() => {
      testEditor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      document.querySelector('#editor [data-quiz-option="1"]').click();
    });
    assert.equal(await quiz().getAttribute('data-quiz-state'), 'unanswered'); assert.equal(await option(quiz(), 1).isChecked(), false);
    await page.evaluate(() => testEditor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
    await page.waitForFunction(() => !testEditor.inputPending); await option(quiz(), 1).click(); assert.equal(await quiz().getAttribute('data-quiz-state'), 'correct');
    report.checks.push('IME/late-mount/answer-guard');
    assert.deepEqual(errors, []); assert.deepEqual(external, []); console.log('note quiz browser: ok ' + JSON.stringify(report));
  } finally { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ...report, errors, external }, null, 2)); await browser.close(); await new Promise(resolve => server.close(resolve)); console.log(output); }
})().catch(error => { console.error(error); process.exitCode = 1; });
