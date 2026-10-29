'use strict';
// Real shells/APIs with synthetic notes and a disposable data root/profile.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-theme-artifacts-'));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function run(browser, minimal) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-theme-data-'));
  fs.mkdirSync(path.join(data, 'notes')); fs.mkdirSync(path.join(data, 'data'));
  const source = '# A quiet place to think · 天光之间\n\nEnglish **bold** and *italic*. 让知识慢慢生长，给思考留一点天空。数学 $x^2 + y^2 = 1$。\n\n## Typography · 阅读与记录\n\n[Follow your curiosity · 跟随好奇心](https://example.com) · `a small idea`\n\n==🔴重要==　==🟠灵感==　==🟡待办==　==🟢理解==　==🔵参考==　==🟣回顾==\n\n> Look up. There is always more sky.\n> 把复杂的想法，写成清楚的句子。\n\n| Moment 时刻 | Practice 练习 |\n| --- | --- |\n| Morning 清晨 | Read a little 阅读 |\n| Afternoon 午后 | Connect ideas 连接 |\n| Evening 傍晚 | Reflect & rest 回顾 |\n\n```js\n// A little clarity, every day.\nfunction collect(ideas) {\n  return ideas.filter(idea => idea.score > 0.8);\n}\nconst sky = "Stay curious";\n```\n\n- [ ] Read a little\n- [x] Keep a good thought\n- Plain list item\n\n> [!NOTE] A small discovery · 小小的发现\n> 笔记连接着今天的好奇，和明天的理解。\n\n> [!WARNING]- Remember · 提醒\n> 留出休息与回顾的时间。\n\n> [!Lavender]\n> Explicit user color · 用户指定颜色\n\n### Third level · 三级标题\n\n#### Fourth level · 四级标题\n\n##### Fifth level · 五级标题\n\n###### Sixth level · 六级标题\n\n```quiz\n哪个数是偶数？\n- [ ] 3\n- [x] 4\n---\n4 可以被 2 整除。\n```\n\n![Sky · 云与山](Main.assets/sky.svg)\n\n' + Array.from({ length: 50 }, (_, i) => 'Paragraph ' + i + '. Long-form reading keeps its place. 这是一段用于验证主题切换和阅读位置的测试文字。\n\n').join('');
  const file = path.join(data, 'notes/Main.md'); fs.writeFileSync(file, source);
  fs.mkdirSync(path.join(data, 'notes/Main.assets'));
  fs.writeFileSync(path.join(data, 'notes/Main.assets/sky.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 600 200"><rect width="600" height="200" fill="#e8eff8"/><circle cx="470" cy="52" r="24" fill="#f8fbff"/><path d="M0 184L160 60L290 170L400 100L600 200H0Z" fill="#afc5dd"/><path d="M0 200L260 110L420 200Z" fill="#5d6e84"/></svg>');
  fs.writeFileSync(path.join(data, 'notes/Diagram.md'), '# Diagram\n\n```mermaid\ngraph LR\n A[English] --> B[中文]\n```\n');
  fs.writeFileSync(path.join(data, 'notes/Nested.md'), '# Nested notes · 嵌套提示\n\n> [!NOTE] A quiet thought · 想法\n> One warm sheet, room for ideas.\n>\n> > [!TIP] A smaller discovery · 发现\n> > Nested content keeps its rounded corners.\n>\n> Back to the outer note.\n\n> [!Lavender] Explicit user color\n> This color belongs to the note.\n');
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json')));
  const profile = minimal ? ['--launch-profile', JSON.stringify({ version: 1, features: Object.fromEntries(catalog.features.map(f => [f.id, f.id === 'notes'])) })] : [];
  const number = await port(), url = 'http://127.0.0.1:' + number;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(number), ...profile], { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; server.stdout.on('data', c => { logs += c; }); server.stderr.on('data', c => { logs += c; });
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' });
  try {
    let ready = false;
    for (let i = 0; i < 160; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, logs);
    const page = await context.newPage(), errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(r.url()));
    page.setDefaultTimeout(15000);
    const workspace = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {', '  window.T = {state, openNote, setViewMode, setNoteSettingsOpen, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: workspace }));
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('theme-test-seeded')) {
        sessionStorage.setItem('theme-test-seeded', '1');
        localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteFocusMode:v1', '0');
        localStorage.setItem('canvas:noteActivePath:v1', 'Main.md'); localStorage.setItem('canvas:noteOpenTabs:v1', '["Main.md"]');
        localStorage.setItem('canvas:noteTheme:v1', 'unknown-old-theme');
      }
    });
    const loaded = () => page.waitForFunction(() => window.T?.state.active && T.state.current?.path === 'Main.md' && !T.state.openingPath);
    await page.goto(url); await loaded();
    assert.equal(await page.evaluate(() => RelatumNoteTheme.read()), 'default');
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTheme:v1')), 'unknown-old-theme');
    assert(!requests.some(u => /source-serif-4/.test(u)), 'default keeps new fonts cold');
    assert(!requests.some(u => /inter-variable/.test(u)), 'default does not request Apple fonts');
    const dialog = page.locator('#note-settings-dialog'), trigger = dialog.locator('.note-settings-theme .review-choice-trigger');
    const panelLayout = async () => {
      const layout = await dialog.evaluate(node => {
        const box = node.getBoundingClientRect(), sidebar = node.querySelector('.relatum-settings-sidebar').getBoundingClientRect();
        const main = node.querySelector('.relatum-settings-main').getBoundingClientRect();
        return { mainBottom: main.bottom - box.bottom, sidebarTop: sidebar.top - box.top,
          seam: innerWidth > 720 ? sidebar.bottom - box.bottom : main.top - sidebar.bottom,
          sidebarHeight: sidebar.height, mainHeight: main.height };
      });
      assert(Math.abs(layout.mainBottom) < 1 && Math.abs(layout.sidebarTop) < 1 && Math.abs(layout.seam) < 1,
        'settings panes fill their rows without a bottom color gap: ' + JSON.stringify(layout));
      return layout;
    };
    const open = async () => {
      await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'appearance' })); await dialog.waitFor(); await panelLayout();
    };
    const choose = async name => {
      const before = await panelLayout(); await trigger.click();
      assert.deepEqual(await panelLayout(), before, 'opening a theme popup does not resize either pane');
      await dialog.getByRole('option', { name, exact: true }).click();
      assert.deepEqual(await panelLayout(), before, 'closing a theme popup does not leave a grid row');
    };
    await page.evaluate(() => {
      window.originalView = T.editor.view; window.originalDoc = T.editor.view.state.doc;
      window.originalSelection = T.editor.view.state.selection;
      window.originalGeneration = T.state.editGeneration;
      window.originalChrome = getComputedStyle(document.querySelector('.top-bar')).backgroundColor;
      const graph = document.querySelector('.note-graph-panel'); window.originalGraphFont = graph && getComputedStyle(graph).fontFamily;
    });
    await open();
    await choose('Claude');
    await page.waitForFunction(() => document.fonts.check('400 16px "Relatum Source Serif 4"'));
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTheme:v1')), 'claude');
    assert(await page.evaluate(() => T.editor.view === originalView && T.editor.view.state.doc === originalDoc && T.editor.view.state.selection === originalSelection && T.state.editGeneration === originalGeneration));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.top-bar')).backgroundColor), 'rgb(243, 242, 238)');
    assert.equal(await page.evaluate(() => {
      const workspace = document.body.dataset.startWorkspace;
      document.body.dataset.startWorkspace = 'canvas';
      const color = getComputedStyle(document.querySelector('.top-bar')).backgroundColor;
      document.body.dataset.startWorkspace = workspace;
      return color;
    }), await page.evaluate(() => originalChrome), 'shared chrome only follows the note theme while Notes is active');
    assert(await page.locator('.note-live-editor-host .cm-editor').evaluate(n => getComputedStyle(n).fontFamily.includes('Relatum Source Serif 4')));
    await choose('Sky');
    await page.waitForFunction(() => document.fonts.check('400 16px "Noto Sans SC"'));
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTheme:v1')), 'sky');
    assert(await page.evaluate(() => T.editor.view === originalView && T.editor.view.state.doc === originalDoc && T.editor.view.state.selection === originalSelection && T.state.editGeneration === originalGeneration));
    assert(await page.locator('.cm-editor').evaluate(n => getComputedStyle(n).fontFamily.indexOf('Noto Sans SC') < getComputedStyle(n).fontFamily.indexOf('Microsoft YaHei')));
    assert.equal(await page.locator('.top-bar').evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(232, 239, 248)');
    await pause(500);
    const idle = await page.evaluate(async () => {
      let frames = 0; const original = window.requestAnimationFrame;
      window.requestAnimationFrame = callback => { frames++; return original(callback); };
      try { await new Promise(resolve => setTimeout(resolve, 500)); return frames; }
      finally { window.requestAnimationFrame = original; }
    });
    assert.equal(idle, 0, 'Sky settings introduce no idle RAF loop');
    assert(!requests.some(u => /inter-variable/.test(u)), 'Claude and Sky do not request Apple fonts');
    await choose('Apple');
    await page.waitForFunction(() => document.fonts.check('400 16px "Relatum Inter"') && document.fonts.check('italic 400 16px "Relatum Inter"'));
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTheme:v1')), 'apple');
    assert(await page.evaluate(() => T.editor.view === originalView && T.editor.view.state.doc === originalDoc && T.editor.view.state.selection === originalSelection && T.state.editGeneration === originalGeneration));
    assert(await page.locator('.cm-editor').evaluate(n => getComputedStyle(n).fontFamily.includes('Relatum Inter')));
    assert.equal(await page.locator('.top-bar').evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(245, 245, 247)');
    assert.equal(await page.locator('.top-bar').evaluate(n => getComputedStyle(n).fontFamily.includes('Relatum Inter')), true);
    if (!minimal) assert.equal(await page.locator('.note-graph-panel').evaluate(n => getComputedStyle(n).fontFamily), await page.evaluate(() => originalGraphFont), 'graph keeps its existing measurement font');
    assert.equal(await page.evaluate(() => {
      document.body.dataset.startWorkspace = 'canvas';
      const color = getComputedStyle(document.querySelector('.top-bar')).backgroundColor;
      document.body.dataset.startWorkspace = 'notes'; return color;
    }), await page.evaluate(() => originalChrome), 'Apple chrome is scoped to active Notes');
    await pause(300);
    assert.equal(await page.evaluate(async () => {
      let frames = 0; const original = requestAnimationFrame;
      window.requestAnimationFrame = callback => { frames++; return original(callback); };
      try { await new Promise(resolve => setTimeout(resolve, 400)); return frames; }
      finally { window.requestAnimationFrame = original; }
    }), 0, 'Apple settings introduce no idle RAF loop');
    await dialog.locator('[data-settings-search]').fill('Apple');
    await dialog.locator('.relatum-settings-result').first().click();
    assert(await trigger.evaluate(n => n === document.activeElement));
    assert(await page.evaluate(() => {
      const view = T.editor.view, before = view.state.doc.toString();
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\nApple history probe' }, userEvent: 'input.type' });
      const edited = view.state.doc;
      RelatumNoteTheme.apply('default'); RelatumNoteTheme.apply('apple');
      const retained = view === T.editor.view && edited === view.state.doc;
      return retained && RelatumCodeMirror.undo(view) && view.state.doc.toString() === before;
    }), 'theme changes preserve the editor and its undo history');
    await trigger.click(); await page.keyboard.press('Escape'); assert(await dialog.isVisible());
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await trigger.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => RelatumNoteTheme.read()), 'default');
    await choose('Apple');
    await dialog.locator('[data-settings-search]').fill('Sky');
    await dialog.locator('.relatum-settings-result').first().click();
    assert(await trigger.evaluate(n => n === document.activeElement), 'search focuses enhanced trigger');
    // Category changes and language refresh close the shared dropdown.
    await trigger.click(); await dialog.locator('nav [data-settings-category="editing"]').click();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await dialog.locator('nav [data-settings-category="appearance"]').click();
    await trigger.click();
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    // Failure must revert the visible selection and preserve the active skin.
    await page.evaluate(() => { window.oldSet = Storage.prototype.setItem; Storage.prototype.setItem = function(k, v) { if (k === 'canvas:noteTheme:v1') throw Error('test quota'); return oldSet.call(this, k, v); }; });
    await choose('Default');
    assert.equal(await page.evaluate(() => RelatumNoteTheme.read()), 'apple');
    assert((await dialog.locator('[data-settings-status]').textContent()).match(/失败|Could not/));
    await page.evaluate(() => { Storage.prototype.setItem = oldSet; });
    await trigger.click();
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await dialog.locator('.note-theme-popovers .review-choice-popup').count(), 0);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await open();
    await dialog.locator('[data-settings-action="close"]').click(); await dialog.waitFor({ state: 'hidden' });
    const fontRace = await page.evaluate(async () => {
      T.editor.view.scrollDOM.scrollTop = 1200;
      const original = document.fonts.load; let release;
      const delayed = new Promise(resolve => { release = resolve; });
      document.fonts.load = () => delayed;
      try {
        RelatumNoteTheme.apply('default'); RelatumNoteTheme.apply('sky'); RelatumNoteTheme.apply('apple');
        await T.openNote('Diagram.md');
        const doc = T.editor.view.state.doc, selection = T.editor.view.state.selection;
        release([]); await new Promise(resolve => setTimeout(resolve, 50));
        return T.state.current.path === 'Diagram.md' && T.editor.view.state.doc === doc && T.editor.view.state.selection === selection;
      } finally { document.fonts.load = original; release([]); }
    });
    assert(fontRace, 'late font completion does not restore an old document anchor');
    await page.evaluate(() => T.openNote('Main.md')); await loaded();
    if (!minimal) {
      const globalColors = await page.evaluate(() => {
        RelatumGlobalSettings.open();
        const dialog = document.querySelector('#global-settings-dialog');
        const snapshot = () => [getComputedStyle(dialog).backgroundColor, getComputedStyle(dialog).color, getComputedStyle(dialog).fontFamily];
        const apple = snapshot(); RelatumNoteTheme.apply('claude'); const claude = snapshot(); RelatumNoteTheme.apply('default'); const original = snapshot(); RelatumNoteTheme.apply('apple');
        RelatumGlobalSettings.close({ instant: true }); return { apple, claude, original };
      });
      assert.deepEqual(globalColors.apple, globalColors.original, 'note theme leaves global settings independent');
      assert.deepEqual(globalColors.claude, globalColors.original, 'Claude leaves global settings independent');
    }
    // 96 combinations per shell cover skins, mode, background, viewport and font scale.
    const matrix = [];
    for (const skin of ['default', 'claude', 'sky', 'apple']) for (const mode of ['light', 'dark']) for (const bg of ['simple', 'scenic']) for (const width of [1440, 650]) for (const scale of [80, 100, 140]) {
      await page.setViewportSize({ width, height: 980 });
      const result = await page.evaluate(({ skin, mode, bg, scale }) => {
        RelatumNoteTheme.apply(skin); document.body.dataset.startTheme = mode; document.body.dataset.startBackground = bg;
        RelatumNotePreferences.applyFontScale(scale, false);
        const root = document.querySelector('.note-workspace'), pane = document.querySelector('.note-document-body');
        const style = getComputedStyle(pane), text = getComputedStyle(document.querySelector('.cm-editor'));
        return { bg: style.backgroundColor, paperImage: getComputedStyle(document.querySelector('.note-document-pane')).backgroundImage,
          paperSurface: getComputedStyle(document.querySelector('.note-document-pane'), '::before').backgroundColor,
          paperRadius: getComputedStyle(document.querySelector('.note-document-pane'), '::before').borderRadius,
          headBg: getComputedStyle(document.querySelector('.note-document-head')).backgroundColor,
          color: text.color, overflow: pane.getBoundingClientRect().right > root.getBoundingClientRect().right + 2, font: text.fontFamily,
          graphFont: document.querySelector('.note-graph-panel') && getComputedStyle(document.querySelector('.note-graph-panel')).fontFamily };
      }, { skin, mode, bg, scale });
      assert(!result.overflow, JSON.stringify({ skin, mode, bg, width, scale, result }));
      if (!minimal) assert.equal(result.graphFont, await page.evaluate(() => getComputedStyle(document.body).fontFamily), skin + ' preserves graph typography in the current language');
      if (skin === 'claude') {
        assert.equal(result.bg, 'rgba(0, 0, 0, 0)', 'Claude paints the paper once behind transparent content');
        assert.equal(result.headBg, 'rgba(0, 0, 0, 0)');
        assert.equal(result.paperImage, 'none');
        assert.equal(result.paperRadius, width > 760 ? '20px' : '16px');
        if (bg === 'simple') {
          assert.equal(result.paperSurface, mode === 'light' ? 'rgb(250, 249, 245)' : 'rgb(25, 25, 25)');
          const nav = mode === 'light' ? 'rgb(243, 242, 238)' : 'rgb(21, 21, 21)';
          assert(await page.evaluate(({ nav, overlay }) => ['.note-tree-pane', '.top-bar'].every(s => getComputedStyle(document.querySelector(s)).backgroundColor === nav)
            && getComputedStyle(document.querySelector('.note-links-pane')).backgroundColor === overlay,
          { nav, overlay: width > 1120 ? nav : mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(36, 36, 36)' }));
        } else assert(result.paperSurface.includes(mode === 'light' ? '0.8)' : '0.84)'), 'Claude scenic retains paper transparency');
        const rules = await page.evaluate(() => ['.note-tree-pane', '.note-tree-pane > .note-pane-head', '.note-tab-bar', '.note-links-head', '.note-tree-foot'].map(selector => {
          const style = getComputedStyle(document.querySelector(selector));
          return { selector, bottom: style.borderBottomColor, right: style.borderRightColor };
        }));
        assert(rules.every(rule => [rule.bottom, rule.right].every(color => color === 'rgba(0, 0, 0, 0)')), JSON.stringify({ mode, bg, width, rules }));
        assert.equal(await page.locator('.note-document-pane').evaluate(n => getComputedStyle(n, '::before').pointerEvents), 'none');
      }
      if (skin === 'sky') {
        if (bg === 'simple') {
          if (mode === 'light') {
            assert.equal(result.bg, 'rgba(0, 0, 0, 0)'); assert.equal(result.headBg, 'rgba(0, 0, 0, 0)');
            assert(result.paperImage.startsWith('linear-gradient(135deg,'));
            for (const color of ['rgb(237, 244, 252)', 'rgb(243, 247, 253)', 'rgb(233, 241, 252)']) assert(result.paperImage.includes(color));
          } else {
            assert.equal(result.bg, 'rgb(22, 35, 56)'); assert.equal(result.paperImage, 'none');
          }
          const navigation = mode === 'light' ? 'rgb(232, 239, 248)' : 'rgb(16, 26, 42)';
          assert(await page.evaluate(expected => ['.note-tree-pane', '.top-bar', '.note-links-pane'].every(selector =>
            getComputedStyle(document.querySelector(selector)).backgroundColor === expected), navigation));
        } else {
          assert(result.bg.includes(mode === 'light' ? '0.8)' : '0.84)'), 'scenic retains paper transparency');
          assert.equal(result.paperImage, 'none', 'scenic keeps its existing translucent surface');
        }
        const text = await page.locator('.cm-editor').evaluate(n => ({ size: parseFloat(getComputedStyle(n).fontSize), line: parseFloat(getComputedStyle(n).lineHeight) }));
        assert(Math.abs(text.size - 16 * scale / 100) < .1);
        assert(Math.abs(text.line / text.size - 1.8) < .01);
      }
      if (skin === 'apple') {
        assert(result.font.includes('Relatum Inter')); assert.equal(result.paperImage, 'none');
        assert.equal(result.bg, 'rgba(0, 0, 0, 0)', 'the document surface paints once behind its transparent content');
        assert.equal(result.paperRadius, width > 760 ? '20px' : '16px');
        if (bg === 'simple') {
          assert.equal(result.paperSurface, mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(28, 28, 30)');
          const nav = mode === 'light' ? 'rgb(245, 245, 247)' : 'rgb(36, 36, 38)';
          assert(await page.evaluate(({ nav, overlay }) => ['.top-bar', '.note-tree-pane'].every(s => getComputedStyle(document.querySelector(s)).backgroundColor === nav)
            && getComputedStyle(document.querySelector('.note-links-pane')).backgroundColor === overlay,
          { nav, overlay: width > 1120 ? nav : mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(44, 44, 46)' }));
        } else assert(result.paperSurface.includes(mode === 'light' ? '0.8)' : '0.84)'), 'Apple scenic retains transparency');
        const text = await page.locator('.note-live-editor-host > .cm-editor').evaluate(n => ({ size: parseFloat(getComputedStyle(n).fontSize), line: parseFloat(getComputedStyle(n).lineHeight) }));
        assert(Math.abs(text.size - 16 * scale / 100) < .1); assert(Math.abs(text.line / text.size - 1.75) < .01);
      }
      matrix.push({ skin, mode, bg, width, scale, ...result });
    }
    // A round trip may change the theme's design, but cannot accumulate typography or layout changes.
    const typography = [];
    await page.setViewportSize({ width: 1440, height: 980 });
    for (const mode of ['live', 'source', 'reading']) for (const skin of ['default', 'claude', 'sky', 'apple']) {
      const result = await page.evaluate(async ({ mode, skin }) => {
        document.body.dataset.startTheme = 'light'; document.body.dataset.startBackground = 'simple';
        RelatumNotePreferences.applyFontScale(100, false); await T.setViewMode(mode);
        const settle = async () => {
          await document.fonts.ready; T.editor.view.requestMeasure();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          // Measure layout at the same scroll position; anchor restoration may round by a CSS pixel.
          const scroller = mode === 'reading' ? document.querySelector('[data-role="note-reading-view"]') : T.editor.view.scrollDOM;
          scroller.scrollTop = 0;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        };
        RelatumNoteTheme.apply(skin); await settle();
        const snapshot = () => {
          const props = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing',
            'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'];
          const metrics = node => Object.fromEntries(props.map(key => [key, getComputedStyle(node)[key]]));
          const rect = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(n => Math.round(n * 100) / 100); };
          const text = document.querySelector(mode === 'reading' ? '.note-reading-content' : '.note-live-editor-host > .cm-editor');
          const title = document.querySelector('.note-inline-title');
          return { text: metrics(text), title: metrics(title), titleBox: rect(title),
            pane: rect(document.querySelector('.note-document-pane')), body: rect(document.querySelector('.note-document-body')),
            width: Math.round(text.getBoundingClientRect().width * 100) / 100 };
        };
        const before = snapshot();
        for (const next of ['apple', 'claude', 'sky', 'default', skin]) { RelatumNoteTheme.apply(next); await settle(); }
        return { skin, mode, before, after: snapshot() };
      }, { mode, skin });
      assert.deepEqual(result.after, result.before, skin + '/' + mode + ' restores exact font, spacing and layout metrics');
      typography.push(result);
    }
    fs.writeFileSync(path.join(artifacts, `${minimal ? 'minimal' : 'full'}-typography.json`), JSON.stringify(typography, null, 2));
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.evaluate(() => { RelatumI18n.setLanguage('zh-CN'); RelatumNotePreferences.applyFontScale(100, false); document.body.dataset.startBackground = 'simple'; });
    for (const skin of ['claude', 'sky', 'apple']) for (const mode of ['light', 'dark']) {
      await page.evaluate(skin => RelatumNoteTheme.apply(skin), skin);
      await page.evaluate(async mode => { document.body.dataset.startTheme = mode; await T.setViewMode('reading'); }, mode);
      await pause(250);
      await page.locator('[data-role="note-reading-view"]').evaluate(n => { n.scrollTop = 0; });
      await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-${skin}-${mode}-reading.png`) });
      const reading = await page.locator('.note-reading-content').evaluate(n => ({ font: getComputedStyle(n).fontFamily, rule: getComputedStyle(n.querySelector('h1')).borderBottomColor,
        size: parseFloat(getComputedStyle(n).fontSize), line: parseFloat(getComputedStyle(n).lineHeight) }));
      assert(reading.font.includes({ claude: 'Relatum Source Serif 4', sky: 'Relatum Open Sans', apple: 'Relatum Inter' }[skin])); assert.equal(reading.rule, 'rgba(0, 0, 0, 0)');
      if (skin === 'claude') {
        if (!minimal) {
          await page.locator('.note-reading-content .note-quiz-carrier').scrollIntoViewIfNeeded();
          await page.locator('.note-reading-content .note-quiz').waitFor();
        }
        const corners = await page.locator('.note-reading-content').evaluate(n => {
          const style = selector => getComputedStyle(n.querySelector(selector));
          return { code: style('pre.md-code').borderRadius, table: style('thead td').borderTopLeftRadius,
            last: style('tbody tr:last-child td:last-child').borderBottomRightRadius,
            callout: style('.md-callout').borderRadius, quiz: n.querySelector('.note-quiz') ? style('.note-quiz').borderRadius : null };
        });
        assert.deepEqual(corners, { code: '12px', table: '12px', last: '12px', callout: '12px', quiz: minimal ? null : '12px' });
        const block = page.locator('.note-reading-content .note-color-block');
        const color = await block.evaluate(n => getComputedStyle(n).backgroundColor);
        const highlights = await page.locator('.note-highlight').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).backgroundColor));
        await page.evaluate(() => RelatumNoteTheme.apply('default'));
        assert.equal(await block.evaluate(n => getComputedStyle(n).backgroundColor), color);
        assert.deepEqual(await page.locator('.note-highlight').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).backgroundColor)), highlights, 'Claude keeps the existing highlight palette');
        await page.evaluate(() => RelatumNoteTheme.apply('claude'));
        await page.locator('.note-reading-content h3').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-claude-${mode}-blocks.png`) });
      }
      if (skin === 'sky' || skin === 'apple') {
        assert(Math.abs(reading.line / reading.size - (skin === 'apple' ? 1.75 : 1.8)) < .01);
        const syntax = await page.locator('.note-reading-content').evaluate(n => {
          const styles = selector => getComputedStyle(n.querySelector(selector));
          return { highlights: [...n.querySelectorAll('.note-highlight')].map(e => getComputedStyle(e).backgroundColor),
            h1: parseFloat(styles('h1').fontSize), h2: parseFloat(styles('h2').fontSize),
            table: styles('thead td').backgroundColor, tableWeight: styles('thead td').fontWeight, tableRadius: styles('thead td').borderTopLeftRadius,
            h2Rule: styles('h2').borderBottomColor, code: styles('pre.md-code').borderRadius,
            quote: styles('blockquote').backgroundColor, body: getComputedStyle(n).backgroundColor };
        });
        assert.equal(new Set(syntax.highlights).size, 6); assert.equal(syntax.h1, 32); assert.equal(syntax.h2, 25.6);
        assert.equal(syntax.code, skin === 'apple' ? '12px' : '10px'); assert.notEqual(syntax.quote, syntax.body);
        assert.equal(syntax.table, skin === 'apple' ? (mode === 'light' ? 'rgb(240, 240, 242)' : 'rgb(44, 44, 46)') : (mode === 'light' ? 'rgb(230, 239, 251)' : 'rgb(32, 51, 78)'));
        if (skin === 'apple') { assert.equal(syntax.tableWeight, '600'); assert.equal(syntax.tableRadius, '12px'); assert.equal(syntax.h2Rule, 'rgba(0, 0, 0, 0)'); }
        const colorBlock = page.locator('.note-reading-content .note-color-block');
        const explicitColor = await colorBlock.evaluate(n => getComputedStyle(n).backgroundColor);
        await page.evaluate(() => RelatumNoteTheme.apply('default'));
        assert.equal(await colorBlock.evaluate(n => getComputedStyle(n).backgroundColor), explicitColor, 'explicit callout color keeps its palette');
        await page.evaluate(skin => RelatumNoteTheme.apply(skin), skin);
        await page.locator('.note-reading-content h3').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-${skin}-${mode}-blocks.png`) });
      }
      // Preserve a paragraph's screen position across a font change.
      const delta = await page.evaluate(async () => {
        const scroller = document.querySelector('[data-role="note-reading-view"]'); scroller.scrollTop = 700;
        const paragraph = Array.from(scroller.querySelectorAll('p')).find(n => n.getBoundingClientRect().top > scroller.getBoundingClientRect().top);
        const top = paragraph.getBoundingClientRect().top; RelatumNoteTheme.apply('default');
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return Math.abs(paragraph.getBoundingClientRect().top - top);
      });
      assert(delta < 3, 'reading anchor moves by ' + delta);
      await page.evaluate(skin => RelatumNoteTheme.apply(skin), skin); await open();
      const closedLayout = await panelLayout(); await trigger.click(); await pause(160);
      assert.deepEqual(await panelLayout(), closedLayout, 'theme portal stays out of the wide dialog grid');
      await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-${skin}-${mode}-settings.png`) });
      const popup = dialog.locator('.note-theme-popovers .review-choice-popup');
      const box = await popup.boundingBox(); assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1441);
      await page.keyboard.press('Escape'); await dialog.locator('[data-settings-action="close"]').click(); await dialog.waitFor({ state: 'hidden' });
    }
    for (const skin of ['claude', 'sky', 'apple']) for (const mode of ['light', 'dark']) {
      await page.evaluate(skin => RelatumNoteTheme.apply(skin), skin);
      await page.evaluate(async mode => {
        document.body.dataset.startTheme = mode; await T.setViewMode('live');
        await new Promise(resolve => requestAnimationFrame(resolve)); T.editor.view.scrollDOM.scrollTop = 0;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, mode);
      await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-${skin}-${mode}-live.png`) });
      if (skin === 'claude') {
        const table = await page.locator('.note-table').first().evaluate(n => ({ overflow: getComputedStyle(n).overflow,
          first: getComputedStyle(n.querySelector('td')).borderTopLeftRadius,
          last: getComputedStyle(n.querySelector('tr:last-child td:last-child')).borderBottomRightRadius,
          scroll: getComputedStyle(n.querySelector('.note-table-scroll')).overflowX }));
        assert.deepEqual(table, { overflow: 'visible', first: '12px', last: '12px', scroll: 'auto' });
      }
      if (skin === 'apple') {
        const table = await page.locator('.note-table').first().evaluate(n => {
          const first = n.querySelector('td'), last = n.querySelector('tr:last-child td:last-child');
          return { overflow: getComputedStyle(n).overflow, radius: getComputedStyle(first).borderTopLeftRadius,
            bottom: getComputedStyle(last).borderBottomRightRadius, weight: getComputedStyle(first).fontWeight,
            header: getComputedStyle(first).backgroundColor, scroll: getComputedStyle(n.querySelector('.note-table-scroll')).overflowX };
        });
        assert.deepEqual(table, { overflow: 'visible', radius: '12px', bottom: '12px', weight: '600',
          header: mode === 'light' ? 'rgb(240, 240, 242)' : 'rgb(44, 44, 46)', scroll: 'auto' });
        assert.equal(await page.locator('.note-live-link').first().evaluate(n => getComputedStyle(n).color),
          mode === 'light' ? 'rgb(0, 102, 204)' : 'rgb(10, 132, 255)');
        assert.notEqual(await page.locator('.note-live-quote-line:not(.note-live-quote-source):not(.note-live-callout-line)').first().evaluate(n => getComputedStyle(n).backgroundImage), 'none', 'quote background keeps native nesting rules');
      }
      await page.locator('.note-table td').first().click();
      const cellEditor = page.locator('.note-table .note-table-cell-input'); await cellEditor.waitFor();
      const cellLine = await cellEditor.evaluate(n => parseFloat(getComputedStyle(n).lineHeight) / parseFloat(getComputedStyle(n).fontSize));
      assert(Math.abs(cellLine - 1.55) < .01, 'body typography preserves the cell editor line metrics');
      assert.equal(await cellEditor.evaluate(n => getComputedStyle(n).fontWeight), { claude: '400', apple: '600', sky: '700' }[skin], 'header editing retains the rendered glyph widths');
      await page.keyboard.press('Escape');
      await page.evaluate(() => { const pos = T.editor.view.state.doc.toString().indexOf('![Sky'); T.editor.revealPosition(pos); });
      await page.locator('.note-live-image-frame img').waitFor();
      const sidebar = page.locator('[data-note-action="toggle-notebooks"]');
      if (!await page.locator('.note-workspace.links-overlay-open').count()) await sidebar.click();
      await page.locator('.note-live-image-frame').click({ position: { x: 30, y: 30 } });
      await page.locator('[data-role="note-image-text-toggle"]').click();
      const tools = page.locator('[data-role="note-image-text-tools"]'); await tools.waitFor();
      assert.equal(await tools.evaluate(n => getComputedStyle(n).backgroundColor), mode === 'light' ? 'rgb(255, 255, 255)' : { claude: 'rgb(36, 36, 36)', apple: 'rgb(44, 44, 46)', sky: 'rgb(29, 45, 68)' }[skin]);
      await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-${skin}-${mode}-image-tools.png`) });
      await page.locator('[data-role="note-image-text-toggle"]').click();
      await page.setViewportSize({ width: 650, height: 980 }); await open();
      const narrowLayout = await panelLayout(); await trigger.click();
      assert.deepEqual(await panelLayout(), narrowLayout, 'theme portal stays out of the narrow dialog grid');
      const popup = await dialog.locator('.note-theme-popovers .review-choice-popup').boundingBox();
      assert(popup.x >= 0 && popup.x + popup.width <= 651);
      await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-${skin}-${mode}-narrow.png`) });
      await page.keyboard.press('Escape'); await dialog.locator('[data-settings-action="close"]').click(); await dialog.waitFor({ state: 'hidden' });
      if (skin === 'claude') await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-claude-${mode}-narrow-workspace.png`) });
      await page.setViewportSize({ width: 1440, height: 980 });
      if (skin === 'claude') {
        await page.locator('[data-role="note-tree"] .note-tree-row[data-note-path="Main.md"]').click({ button: 'right' });
        const menu = page.locator('.note-context-menu:visible'); await menu.waitFor();
        assert.equal(await menu.evaluate(n => getComputedStyle(n).borderRadius), '14px');
        await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-claude-${mode}-menu.png`) });
        await page.keyboard.press('Escape');
      }
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => !RelatumNoteSystem.motion.matches);
    assert.equal(await page.locator('.note-icon-button').first().evaluate(n => getComputedStyle(n).transitionDuration.split(',')[0].trim()), '0.14s');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => RelatumNoteSystem.motion.matches);
    assert.equal(await page.locator('.note-icon-button').first().evaluate(n => getComputedStyle(n).transitionDuration), '0s');
    await page.evaluate(() => T.setViewMode('source', false));
    assert(!(await page.locator('.cm-editor').evaluate(n => getComputedStyle(n).fontFamily)).includes('Source Serif'));
    assert(!(await page.locator('.cm-editor').evaluate(n => getComputedStyle(n).fontFamily)).includes('Relatum Inter'));
    await page.reload(); await loaded(); assert.equal(await page.evaluate(() => RelatumNoteTheme.read()), 'apple');
    const coloring = await page.evaluate(async () => {
      const response = await fetch('/api/note-file-colors/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'Main.md', color: 'red' }) });
      const result = await response.json(); RelatumNoteExtensions.set('file-colors', { enabled: true }); return result.color;
    });
    assert.equal(coloring, 'red');
    const coloredRow = page.locator('[data-role="note-tree"] .note-tree-row[data-note-path="Main.md"][data-file-color="red"]');
    await coloredRow.waitFor();
    const color = await coloredRow.evaluate(n => getComputedStyle(n).backgroundColor);
    await page.evaluate(() => RelatumNoteTheme.apply('default'));
    assert.equal(await coloredRow.evaluate(n => getComputedStyle(n).backgroundColor), color, 'theme does not override file colors');
    await page.evaluate(() => RelatumNoteTheme.apply('sky'));
    assert.equal(await coloredRow.evaluate(n => getComputedStyle(n).backgroundColor), color);
    await page.evaluate(() => RelatumNoteTheme.apply('claude'));
    assert.equal(await coloredRow.evaluate(n => getComputedStyle(n).backgroundColor), color);
    await page.evaluate(() => RelatumNoteTheme.apply('apple'));
    assert.equal(await coloredRow.evaluate(n => getComputedStyle(n).backgroundColor), color);
    if (!minimal) {
      await page.evaluate(async () => { await T.openNote('Diagram.md'); await T.setViewMode('reading'); });
      await page.locator('.note-reading-content .note-mermaid-stage > svg').waitFor();
      const stable = await page.evaluate(async () => {
        const svg = document.querySelector('.note-reading-content .note-mermaid-stage > svg');
        const family = getComputedStyle(svg.closest('.mermaid-diagram')).fontFamily;
        RelatumNoteTheme.apply('default'); RelatumNoteTheme.apply('claude'); RelatumNoteTheme.apply('sky'); RelatumNoteTheme.apply('apple');
        await new Promise(r => setTimeout(r, 200));
        return svg.isConnected && !family.includes('Source Serif') && !getComputedStyle(svg.closest('.mermaid-diagram')).fontFamily.includes('Relatum Inter');
      });
      assert(stable, 'theme changes retain the diagram and worker-compatible font');
      await page.evaluate(() => T.openNote('Main.md')); await loaded();
    }
    await open(); await dialog.locator('[data-settings-action="reset-category"]').click(); await dialog.locator('[data-settings-action="accept-reset"]').click();
    assert.equal(await page.evaluate(() => RelatumNoteTheme.read()), 'default'); assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteTheme:v1')), null);
    await choose('Apple'); await dialog.locator('[data-settings-action="reset-all"]').click(); await dialog.locator('[data-settings-action="accept-reset"]').click();
    await page.waitForFunction(() => RelatumNoteTheme.read() === 'default');
    assert.equal(fs.readFileSync(file, 'utf8'), source, 'theme changes never save note content');
    assert.deepEqual(errors, []);
    assert(requests.every(u => u.startsWith(url + '/') || u.startsWith('blob:' + url + '/') || u.startsWith('data:')), 'all runtime resources stay local');
    await page.setViewportSize({ width: 1440, height: 980 });
    if (await dialog.isVisible()) { await dialog.locator('[data-settings-action="close"]').click(); await dialog.waitFor({ state: 'hidden' }); }
    await page.evaluate(async () => { RelatumNoteTheme.apply('claude'); document.body.dataset.startBackground = 'simple'; await T.openNote('Nested.md'); });
    for (const mode of ['light', 'dark']) for (const view of ['live', 'reading']) {
      await page.evaluate(async ({ mode, view }) => { document.body.dataset.startTheme = mode; await T.setViewMode(view); }, { mode, view });
      await pause(200);
      if (view === 'reading') assert.equal(await page.locator('.note-reading-content .md-callout .md-callout').evaluate(n => getComputedStyle(n).borderRadius), '12px');
      else assert.equal(await page.locator('.note-live-editor-host').evaluate(n => getComputedStyle(n).getPropertyValue('--note-callout-radius').trim()), '12px');
      await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-claude-${mode}-nested-${view}.png`) });
    }
    if (await page.locator('.note-tab').count()) await page.locator('.note-tab-close-all').click();
    await page.waitForFunction(() => !document.querySelector('.note-tab'));
    for (const skin of ['claude', 'apple']) for (const mode of ['light', 'dark']) {
      await page.evaluate(({ skin, mode }) => { RelatumNoteTheme.apply(skin); document.body.dataset.startTheme = mode; }, { skin, mode }); await pause(100);
      await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-${skin}-${mode}-empty.png`) });
      await open();
      const chrome = await dialog.evaluate(n => {
        const card = n.querySelector('.note-settings-theme'), s = getComputedStyle(card);
        return { border: s.borderTopWidth, shadow: s.boxShadow, radius: getComputedStyle(n).borderRadius };
      });
      assert.deepEqual(chrome, { border: '0px', shadow: 'none', radius: '24px' });
      await page.screenshot({ path: path.join(artifacts, `${minimal ? 'minimal' : 'full'}-${skin}-${mode}-settings.png`) });
      await dialog.locator('[data-settings-action="close"]').click(); await dialog.waitFor({ state: 'hidden' });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(artifacts, `${minimal ? 'minimal' : 'full'}-matrix.json`), JSON.stringify(matrix, null, 2));
    console.log((minimal ? 'minimal' : 'full') + ': passed');
  } finally { await context.close(); server.kill(); await new Promise(r => server.exitCode !== null ? r() : server.once('exit', r)); }
}
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.RELATUM_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try { await run(browser, false); await run(browser, true); console.log('Artifacts: ' + artifacts); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); console.error('Artifacts: ' + artifacts); process.exitCode = 1; });
