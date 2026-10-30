'use strict';

// Real workspace, disposable Markdown, preferences and browser profile only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-viewport-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const baseline = process.argv.includes('--baseline'), quick = process.argv.includes('--quick'), measureOnly = process.argv.includes('--measure');
const resourcesOnly = process.argv.includes('--resources-only');
const results = [], errors = [];
fs.mkdirSync(path.join(root, 'notes'));
fs.writeFileSync(path.join(root, 'notes', 'Other.md'), 'Another short note');
function fixture(bytes) {
  const sections = []; let size = 0, index = 0;
  while (size < bytes) {
    const section = `## Section ${index}\n\n` + Array.from({ length: 5 }, (_, p) => `Para ${index}-${p}: `
      + 'Long document reading position, natural wrapping and stable camera. '.repeat(8)).join('\n\n')
      + (index % 4 === 0 ? '\n\n| Item | Value |\n| --- | --- |\n| A | Table content |\n| B | Another line |' : '')
      + (index % 3 === 0 ? '\n\n```js\nconst x = 1;\nconst y = 2;\nconsole.log(x+y);\n```' : '');
    sections.push(section); size += Buffer.byteLength(section) + 2; index++;
  }
  // All fixture text is ASCII. Stay inside the existing 4MiB note limit.
  return { text: sections.join('\n\n').slice(0, bytes), sections: index };
}
const fixtures = (quick ? [400 * 1024] : [400 * 1024, 1024 * 1024, 4 * 1024 * 1024]).map((size, i) => {
  const data = fixture(size), name = `Long-${i}.md`;
  fs.writeFileSync(path.join(root, 'notes', name), data.text); return { ...data, name };
});
const resources = '---\ntitle: Viewport fixture\n---\n\n## Section 8000\n\n'
  + '<!-- hidden\ncomment -->\n\n%% hidden\ncomment %%\n\n'
  + '```js\nconst resource = "source span";\n```\n\n'
  + '> [!note]- Folded\n> Hidden detail\n>\n> - Nested item\n>   - Nested child\n\n'
  + '- List item\n  - Nested list item\n\n| Column | Value |\n| --- | --- |\n| First | Body |\n| Second | Body |\n\n'
  + '![canvas](canvases/Viewport.canvas)\n\n$$\n\\frac{x^2+1}{2}=y\n$$\n\n'
  + '```mermaid\ngraph TD\nA[Start] --> B[Finish]\n```\n\n![delayed](slow.svg)\n\n'
  + '## Section 90000\n\n' + Array.from({ length: 80 }, (_, i) => `Para ${90000 + i}-0: ` + 'Resource layout and user scrolling. '.repeat(15)).join('\n\n')
  + '\n\nReference[^v].\n\n[^v]: Footnote body\n';
fs.mkdirSync(path.join(root, 'notes', 'canvases'));
fs.writeFileSync(path.join(root, 'notes', 'Resources.md'), resources);
fs.writeFileSync(path.join(root, 'notes', 'canvases', 'Viewport.canvas'), '{"version":2,"nodes":[],"edges":[]}');
fs.writeFileSync(path.join(root, 'notes', 'slow.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#b2c9b5"/></svg>');
const paragraph = '# Long paragraph\n\n' + Array.from({ length: 25000 }, (_, i) => 'Word' + i).join(' ') + '\n\nEnd';
fs.writeFileSync(path.join(root, 'notes', 'Paragraph.md'), paragraph);
function source(file) {
  return baseline ? execFileSync('git', ['show', (process.env.RELATUM_NOTE_VIEWPORT_BASELINE || 'HEAD') + ':' + file],
    { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 12 * 1024 * 1024 }) : fs.readFileSync(path.join(repo, file), 'utf8');
}
function visiblePosition() {
  const reading = T.state.viewMode === 'reading', view = T.editor.view;
  const area = reading ? document.querySelector('[data-role="note-reading-view"]') : view.scrollDOM;
  const box = area.getBoundingClientRect(); let text, top, from, nearby;
  if (reading) {
    const content = area.querySelector('.note-reading-content');
    const hit = document.elementFromPoint(Math.min(box.right - 16, content.getBoundingClientRect().left + 24), box.top + 12);
    const element = hit?.closest('p,h1,h2,h3,pre,tr,li,[data-note-block-from]')
      || [...content.children].find(node => node.getBoundingClientRect().bottom > box.top + 12);
    text = element?.textContent; top = element?.getBoundingClientRect().top - box.top;
    from = Number(element?.dataset.noteBlockFrom ?? element?.dataset.noteHeadingFrom);
    nearby = [element?.previousElementSibling, element, element?.nextElementSibling].filter(Boolean).map(node => ({
      from: Number(node.dataset.noteBlockFrom ?? node.dataset.noteHeadingFrom), y: node.getBoundingClientRect().top - box.top,
    }));
  } else {
    const block = view.lineBlockAtHeight(Math.max(0, box.top + 12 - view.documentTop));
    text = view.state.doc.sliceString(block.from, Math.min(block.to, block.from + 200));
    top = view.documentTop + block.top - box.top; from = block.from;
  }
  const match = /(?:Section |Para )(\d+)/.exec(text || '');
  return { mode: T.state.viewMode, section: match ? Number(match[1]) : null, text: text?.slice(0, 90), from, y: top,
    scroll: area.scrollTop, height: area.scrollHeight, client: area.clientHeight, ...(nearby ? { nearby } : {}),
    anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };
}
function paintedSection() {
  const reading = T.state.viewMode === 'reading', area = reading ? document.querySelector('[data-role="note-reading-view"]') : T.editor.view.scrollDOM;
  const point = area.getBoundingClientRect().top + 12;
  const nodes = reading ? area.querySelector('.note-reading-content').children : T.editor.view.contentDOM.querySelectorAll('.cm-line');
  const node = [...nodes].find(node => { const box = node.getBoundingClientRect(); return box.bottom > point && box.top < point + 50; });
  const match = /(?:Section |Para )(\d+)/.exec(node?.textContent || '');
  return match ? Number(match[1]) : null;
}
(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, 'isolated service starts');
    browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'],
      ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    let page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    const workspace = source('assets/note-workspace.js').replace('  window.CanvasNoteWorkspace = {',
      '  window.paintedSection=' + paintedSection.toString() + ';\n  window.T={state,openNote,closeAllTabs,setViewMode,flushSave,persistViewStates,rememberEditorState,get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: workspace }));
    if (baseline) for (const name of ['note-live-editor.js', 'markdown.js']) {
      const body = source('assets/' + name);
      await page.route('**/' + name + '*', route => route.fulfill({ contentType: 'text/javascript', body }));
    }
    await page.addInitScript(() => { if (!localStorage.getItem('canvas:startWorkspace:v1')) {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteGraphPreload:v1', '0');
    } });
    await page.goto(url); await page.waitForFunction(() => window.T?.state.initialized && T.state.active && T.editor);
    await page.evaluate(() => document.fonts.ready);
    const position = () => page.evaluate(visiblePosition);
    async function settle() { await page.waitForTimeout(650); }
    async function seek(section) {
      await page.evaluate(section => {
        const view = T.editor.view, from = view.state.doc.toString().indexOf(`## Section ${section}\n`);
        if (from < 0) throw Error('fixture heading missing'); T.editor.revealPosition(from, { align: 'start' });
      }, section); await settle();
      await page.evaluate(() => T.editor.view.dispatch({ selection: { anchor: 0, head: 0 } }));
    }
    function checkSame(before, after, exact, label) {
      if (measureOnly) return;
      // A subpixel boundary can expose the preceding paragraph's last pixel.
      // Compare the tracked source block itself, including its screen position.
      const tracked = exact && after.nearby?.find(node => node.from === before.from);
      if (!tracked) assert.equal(after.section, before.section, label + ': same content ' + JSON.stringify({ before, after }));
      if (exact) {
        assert.equal(tracked?.from ?? after.from, before.from, label + ': source block');
        assert(Math.abs((tracked?.y ?? after.y) - before.y) <= 2, label + ': at most 2px drift ' + JSON.stringify({ before, after }));
      }
      assert.equal(after.anchor, before.anchor, label + ': editing anchor'); assert.equal(after.head, before.head, label + ': editing head');
    }
    for (const data of resourcesOnly ? [] : fixtures) {
      await page.evaluate(() => T.setViewMode('live'));
      const openMs = await page.evaluate(async name => { const start = performance.now(); await T.openNote(name, { reuseActiveTab: false }); return performance.now() - start; }, data.name);
      await settle(); const section = Math.floor(data.sections * .65);
      await seek(section); const before = await position();
      await page.evaluate(() => { window.originalDoc = T.editor.view.state.doc; });
      for (const mode of ['source', 'reading', 'live']) {
        const switchMs = await page.evaluate(async mode => { const start = performance.now(); await T.setViewMode(mode); return performance.now() - start; }, mode);
        await settle(); const after = await position(); results.push({ name: data.name, bytes: Buffer.byteLength(data.text), scenario: 'mode-' + mode, before, after, openMs, switchMs });
        checkSame(before, after, false, data.name + '/' + mode);
        assert(await page.evaluate(() => originalDoc === T.editor.view.state.doc), 'mode changes retain the editor document');
      }
      for (const mode of ['live', 'source', 'reading']) {
        await page.evaluate(mode => T.setViewMode(mode), mode); await settle();
        if (mode !== 'reading') await seek(section);
        const saved = await position();
        await page.evaluate(() => T.openNote('Other.md', { reuseActiveTab: false })); await settle();
        const frames = await page.evaluate(async name => {
          await T.openNote(name, { reuseActiveTab: false }); const frames = [];
          for (let i = 0; i < 8; i++) { await new Promise(requestAnimationFrame); frames.push(paintedSection()); }
          return frames;
        }, data.name); await settle();
        const after = await position(); results.push({ name: data.name, scenario: 'reopen-' + mode, before: saved, after });
        if (!measureOnly) assert(frames.every(section => section == null || section === saved.section), 'reopen does not paint a different section: ' + JSON.stringify({ mode, expected: saved.section, frames }));
        checkSame(saved, after, true, data.name + '/' + mode + '/reopen');
        await page.evaluate(() => { T.rememberEditorState(T.state.current); T.persistViewStates(); });
        await page.reload(); await page.waitForFunction(name => T.state.active && T.state.current?.path === name, data.name); await settle();
        const reloaded = await position(); results.push({ name: data.name, scenario: 'reload-' + mode, before: after, after: reloaded });
        checkSame(after, reloaded, true, data.name + '/' + mode + '/reload');
      }
      const closed = await position();
      await page.evaluate(() => T.closeAllTabs());
      await page.evaluate(name => T.openNote(name, { reuseActiveTab: false }), data.name); await settle();
      const reopened = await position(); checkSame(closed, reopened, true, data.name + '/close-and-reopen');
      results.push({ name: data.name, scenario: 'close-and-reopen', before: closed, after: reopened });
      assert.equal(fs.readFileSync(path.join(root, 'notes', data.name), 'utf8'), data.text, 'navigation leaves Markdown byte-identical');
    }
    if (!baseline && !measureOnly) {
      if (!resourcesOnly) {
        const before = await position(), name = fixtures.at(-1).name;
        await page.evaluate(() => { T.rememberEditorState(T.state.current); T.persistViewStates(); });
        const storageState = await context.storageState(); await context.close();
        const fresh = await browser.newContext({ storageState, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
        page = await fresh.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
        await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: workspace }));
        await page.goto(url); await page.waitForFunction(name => window.T?.state.current?.path === name && T.state.active, name); await settle();
        const after = await position(); checkSame(before, after, true, 'fresh browser profile'); results.push({ scenario: 'fresh-profile', before, after });
        for (const mode of ['source', 'live', 'reading']) {
          await page.evaluate(mode => T.setViewMode(mode), mode); await settle(); const saved = await position();
          await page.evaluate(() => RelatumStartWorkspace.set('canvas'));
          await page.waitForFunction(() => !T.state.active && document.querySelector('.note-workspace').hidden);
          await page.reload();
          await page.waitForFunction(name => window.T?.state.initialized && !T.state.active && T.state.current?.path === name, name);
          await page.locator('button[data-start-workspace="notes"]').click();
          await page.waitForFunction(() => T.state.active); await settle(); const restored = await position();
          checkSame(saved, restored, true, 'hidden startup preload/' + mode);
          results.push({ scenario: 'hidden-preload/' + mode, before: saved, after: restored });
        }
      }
      await page.evaluate(async () => { await T.setViewMode('live'); await T.openNote('Resources.md', { reuseActiveTab: false }); });
      await settle(); await page.evaluate(() => T.setViewMode('reading')); await settle();
      const spans = await page.evaluate(() => {
        const host = document.querySelector('[data-role="note-reading-view"]'), text = T.state.current.content;
        const at = selector => { const node = host.querySelector(selector).closest('[data-note-block-from]'); return { from: Number(node.dataset.noteBlockFrom), to: Number(node.dataset.noteBlockTo) }; };
        return { code: at('pre.md-code'), math: at('.md-math-block'), table: at('.md-scroll-x'), row: at('tbody tr'),
          list: at('.note-reading-content > ul > li'), nested: at('.note-reading-content > ul > li li'), fold: at('.note-block'), canvas: at('.note-live-image-frame').from,
          heading: at('[data-note-heading-from="' + text.indexOf('## Section 90000') + '"]'),
          allValid: [...host.querySelectorAll('[data-note-block-from]')].every(node => {
            const from = Number(node.dataset.noteBlockFrom), to = Number(node.dataset.noteBlockTo);
            return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from && to <= text.length;
          }) };
      });
      assert(spans.allValid, 'all note source spans use the original normalized Markdown');
      for (const [key, prefix] of [['code', '```js'], ['math', '$$'], ['table', '| Column'], ['row', '| First'], ['list', '- List'], ['nested', '  - Nested list'], ['fold', '> [!note]'], ['heading', '## Section 90000']]) {
        assert(resources.slice(spans[key].from, spans[key].to).startsWith(prefix), key + ': original source position ' + JSON.stringify(spans[key]));
      }
      assert.equal(spans.heading.from, resources.indexOf('## Section 90000'), 'canvas placeholders do not shift later paragraphs');
      assert.equal(spans.canvas, resources.indexOf('![canvas]'), 'embedded canvas retains its source span');
      // Restore into an already folded block without opening it or moving the caret.
      await page.evaluate(() => {
        const host = document.querySelector('[data-role="note-reading-view"]'), from = T.state.current.content.indexOf('> Hidden detail');
        RelatumNoteLiveEditor.restoreReadingViewport(host, { from, to: from + 15, ratio: 0, offset: 12 }, { isCurrent: () => T.state.viewMode === 'reading' });
      }); await settle();
      assert(await page.locator('.note-reading-content .md-callout-body').first().evaluate(node => node.hidden), 'position restoration preserves folds');
      await page.evaluate(() => {
        const host = document.querySelector('[data-role="note-reading-view"]'); RelatumNoteLiveEditor.cancelViewportRestore(host);
        host.querySelector('[data-note-heading-from="' + T.state.current.content.indexOf('## Section 90000') + '"]').scrollIntoView({ block: 'start' });
      }); await settle();
      const saved = await position();
      async function delayedReopen(userScroll) {
        await page.evaluate(() => T.openNote('Other.md', { reuseActiveTab: false })); await settle();
        await page.evaluate(() => {
          window.nativeTypeset = MathJax.typesetPromise; window.heldTypesets = [];
          MathJax.typesetPromise = function (nodes) {
            if ([...nodes].some(node => node.closest('[data-role="note-reading-view"]'))) return new Promise((resolve, reject) => {
              heldTypesets.push(() => nativeTypeset.call(MathJax, nodes).then(resolve, reject));
            });
            return nativeTypeset.call(this, nodes);
          };
        });
        let release; const held = new Promise(resolve => { release = resolve; });
        await page.route('**/api/note-asset?*', async route => {
          if (new URL(route.request().url()).searchParams.get('src') === 'slow.svg') await held;
          await route.continue();
        });
        try {
          await page.evaluate(() => T.openNote('Resources.md', { reuseActiveTab: false })); await settle();
          if (userScroll) {
            const box = await page.locator('[data-role="note-reading-view"]').boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 600); await settle();
          }
          const before = await position();
          assert(await page.evaluate(() => heldTypesets.length > 0), 'formula layout is deliberately delayed');
          release(); await page.evaluate(() => Promise.all(heldTypesets.splice(0).map(run => run())));
          await page.waitForFunction(() => [...document.querySelectorAll('.note-reading-content img')].some(img => img.complete && img.naturalWidth));
          await page.evaluate(() => document.fonts.ready); await settle();
          const after = await position(); results.push({ scenario: userScroll ? 'resource-user-scroll' : 'resource-layout', before, after });
          checkSame(userScroll ? before : saved, after, true, 'late resource layout');
          if (userScroll) assert(after.section !== saved.section, 'user wheel changes the reading position');
        } finally {
          release(); await page.evaluate(() => { MathJax.typesetPromise = nativeTypeset; heldTypesets.splice(0).forEach(run => run()); });
          await page.unroute('**/api/note-asset?*');
        }
      }
      await delayedReopen(false); await delayedReopen(true);
      // Drag a real native thumb while a content restore is still active.
      const drag = await page.evaluate(() => {
        const area = document.querySelector('[data-role="note-reading-view"]'), box = area.getBoundingClientRect();
        window.dragRestore = RelatumNoteLiveEditor.restoreReadingViewport(area, RelatumNoteLiveEditor.captureReadingViewport(area), { isCurrent: () => T.state.viewMode === 'reading' });
        const thumb = Math.max(32, area.clientHeight * area.clientHeight / area.scrollHeight);
        return { x: box.right - 5, y: box.top + (area.clientHeight - thumb) * area.scrollTop / (area.scrollHeight - area.clientHeight) + thumb / 2 };
      }); await settle();
      const dragBefore = await position();
      await page.mouse.move(drag.x, drag.y); await page.mouse.down(); await page.mouse.move(drag.x, drag.y + 60, { steps: 6 }); await page.mouse.up(); await settle();
      const dragged = await position(); assert(dragged.scroll > dragBefore.scroll + 400, 'native thumb supersedes pending restoration');
      await page.evaluate(() => dragRestore.schedule()); await settle(); const dragAfter = await position();
      checkSame(dragged, dragAfter, true, 'native thumb rejects old correction'); results.push({ scenario: 'native-thumb', before: dragBefore, after: dragAfter });
      // Late callbacks after a mode change, native minimization or pagehide cannot reapply the old anchor.
      for (const action of ['mode', 'minimize', 'hidden', 'pagehide']) {
        await page.evaluate(async () => { await T.setViewMode('reading'); if (T.state.current.path !== 'Resources.md') await T.openNote('Resources.md'); }); await settle();
        await page.evaluate(() => {
          const host = document.querySelector('[data-role="note-reading-view"]');
          window.oldRestore = RelatumNoteLiveEditor.restoreReadingViewport(host, RelatumNoteLiveEditor.captureReadingViewport(host), { isCurrent: () => T.state.viewMode === 'reading' });
        }); await settle();
        await page.evaluate(async action => {
          if (action === 'mode') await T.setViewMode('source');
          if (action === 'minimize') { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); }
          if (action === 'hidden') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); }
          if (action === 'pagehide') window.dispatchEvent(new Event('pagehide'));
        }, action);
        await page.evaluate(action => {
          if (action === 'minimize') { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); }
          if (action === 'hidden') { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }
          if (action === 'pagehide') window.dispatchEvent(new Event('pageshow'));
        }, action); await settle();
        const before = await position(); await page.evaluate(() => { oldRestore.schedule(); document.fonts.dispatchEvent(new Event('loadingdone')); }); await settle();
        const after = await position(); checkSame(before, after, true, 'obsolete restoration/' + action);
        results.push({ scenario: 'cancel-' + action, before, after });
      }
      for (const edge of ['start', 'end']) {
        await page.evaluate(async ({ edge, name }) => {
          await T.setViewMode('live'); await T.openNote(name, { reuseActiveTab: false });
          T.editor.revealPosition(edge === 'start' ? 0 : T.editor.view.state.doc.length, { align: 'start' });
        }, { edge, name: fixtures[0].name }); await settle();
        await page.evaluate(edge => {
          T.editor.cancelViewportRestore();
          T.editor.view.scrollDOM.scrollTop = edge === 'start' ? 0 : T.editor.view.scrollDOM.scrollHeight;
        }, edge); await settle();
        for (const mode of ['source', 'reading', 'live']) {
          await page.evaluate(mode => T.setViewMode(mode), mode); await settle(); const actual = await position();
          assert((edge === 'start' ? actual.scroll : actual.height - actual.client - actual.scroll) <= 2, edge + '/' + mode);
          results.push({ scenario: edge + '/' + mode, after: actual });
        }
      }
      assert.equal(fs.readFileSync(path.join(root, 'notes', 'Resources.md'), 'utf8'), resources);
      await page.evaluate(async () => { await T.setViewMode('live'); await T.openNote('Paragraph.md', { reuseActiveTab: false }); }); await settle();
      await page.evaluate(() => { T.editor.cancelViewportRestore(); const area = T.editor.view.scrollDOM; area.scrollTop = area.scrollHeight * .45; }); await settle();
      const paragraphProgress = () => page.evaluate(() => {
        const view = T.editor.view, reading = T.state.viewMode === 'reading';
        const area = reading ? document.querySelector('[data-role="note-reading-view"]') : view.scrollDOM, origin = area.getBoundingClientRect().top + 12;
        if (reading) { const rect = area.querySelector('.note-reading-content > p').getBoundingClientRect(); return (origin - rect.top) / rect.height; }
        const block = view.lineBlockAt(view.state.doc.line(3).from); return (origin - view.documentTop - block.top) / block.height;
      });
      const progress = await paragraphProgress();
      for (const mode of ['source', 'reading', 'live']) {
        await page.evaluate(mode => T.setViewMode(mode), mode); await settle();
        const after = await paragraphProgress(); assert(Math.abs(after - progress) < .001, 'long paragraph progress/' + mode);
        results.push({ scenario: 'paragraph/' + mode, before: progress, after });
      }
      assert.equal(fs.readFileSync(path.join(root, 'notes', 'Paragraph.md'), 'utf8'), paragraph);
      // Responsive widths and all local note fonts share the same source anchors.
      await page.setViewportSize({ width: 760, height: 900 });
      for (const theme of ['default', 'claude', 'sky', 'apple']) {
        await page.evaluate(async ({ theme, name }) => { await T.setViewMode('live'); RelatumNoteTheme.apply(theme); await T.openNote(name, { reuseActiveTab: false }); }, { theme, name: fixtures[0].name });
        await page.evaluate(() => document.fonts.ready); await settle(); await seek(90);
        const before = await position();
        for (const mode of ['source', 'reading', 'live']) {
          await page.evaluate(mode => T.setViewMode(mode), mode); await settle(); const after = await position();
          checkSame(before, after, false, 'narrow/' + theme + '/' + mode); results.push({ scenario: 'narrow/' + theme + '/' + mode, before, after });
        }
      }
      await settle();
      const frames = await page.evaluate(async () => {
        const native = window.requestAnimationFrame; let count = 0;
        window.requestAnimationFrame = callback => { count++; return native.call(window, callback); };
        try { await new Promise(resolve => setTimeout(resolve, 450)); return count; } finally { window.requestAnimationFrame = native; }
      });
      assert.equal(frames, 0, 'settled viewport restoration adds no idle RAF loop');
    }
    assert.deepEqual(errors, []);
    console.log('note viewport browser: ok (' + results.length + ' scenarios)');
  } finally {
    fs.writeFileSync(path.join(root, 'viewport-report.json'), JSON.stringify({ baseline, results, errors }, null, 2));
    console.log('Viewport report: ' + root); await browser?.close(); server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
