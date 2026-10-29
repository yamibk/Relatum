'use strict';
// Real workspace and disk round-trip, always in a disposable vault/profile.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-highlights-'));
fs.mkdirSync(path.join(root, 'notes')); fs.writeFileSync(path.join(root, 'notes/Main.md'), 'Main');
(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port, errors = [];
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    for (let n = 0; n < 100; n++) {
      try { if ((await fetch(url + '/api/runtime')).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1300, height: 850 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.stack));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.__highlights={openNote,flushSave,setViewMode,state,get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.goto(url); await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => window.__highlights?.state.initialized && __highlights.state.active);
    await page.evaluate(() => __highlights.openNote('Main.md'));
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const content = page.locator('.note-live-editor-host .cm-content:not(.note-table-cell-editor)');
    const menu = page.locator('.note-highlight-menu');
    const value = () => page.evaluate(() => __highlights.editor.snapshot().value);
    async function reset(text = '', anchor = 0, head = anchor, sourceMode = false) {
      await page.mouse.move(10,10);
      await page.evaluate(({text,anchor,head,sourceMode}) => {
        const e = __highlights.editor; e.setSourceMode(sourceMode); e.setDocument({value:text,notePath:'Main.md',anchor,head,scrollTop:0}); e.focus();
      }, {text,anchor,head,sourceMode}); await settle();
    }
    async function select(anchor, head = anchor) {
      await page.evaluate(({anchor,head}) => __highlights.editor.view.dispatch({selection:RelatumCodeMirror.EditorSelection.range(anchor,head)}), {anchor,head}); await settle();
    }
    async function color(id) { assert(await page.evaluate(id => __highlights.editor.executeCommand('highlight-color:'+id), id)); await settle(); }
    for (const sourceMode of [false,true]) {
      await reset('',0,0,sourceMode); await page.keyboard.type('=='); await menu.waitFor();
      assert(await page.evaluate(() => __highlights.editor.view.hasFocus),'picker preserves editor focus');
      await menu.locator('[data-color="red"][role="option"]').click();
      assert.equal(await value(), '==🔴==');
      await page.keyboard.type('中文'); assert.equal(await value(), '==🔴中文==');
      await page.keyboard.type('=='); assert.equal(await value(), '==🔴中文==', 'owned closing pair is skipped');
      await reset('',0,0,sourceMode); await page.keyboard.type('=='); await menu.waitFor();
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      assert.equal(await value(), '==🔴=='); await page.keyboard.press('Backspace'); assert.equal(await value(), '');
      await reset('',0,0,sourceMode); await page.keyboard.type('=='); await menu.waitFor(); await page.keyboard.press('Escape');
      assert.equal(await value(),'=='); await page.keyboard.type('text=='); assert.equal(await menu.count(),0,'closing marker does not suggest');
    }
    await reset('==🔴apple pear==',5,8); await color('blue');
    assert.equal(await value(),'==🔴a====🔵ppl====🔴e pear==','partial recoloring retains surrounding color');
    await content.press('Control+z'); assert.equal(await value(),'==🔴apple pear==');
    await content.press('Control+y'); assert((await value()).includes('==🔵ppl=='));
    await reset('==🔴apple pear==',5,8); await page.evaluate(() => __highlights.editor.executeCommand('highlight'));
    assert.equal(await value(),'==🔴a==ppl==🔴e pear==','removal consumes the color prefix');
    await reset('==🔴**bold**== tail',6); await color('default'); assert.equal(await value(),'==**bold**== tail');
    await reset('==🔴bold==',4,8); await page.evaluate(() => __highlights.editor.executeCommand('bold'));
    assert.equal(await value(),'==🔴**bold**==','other formatting retains the color selector');
    await reset('==🔴**bold**==',7,9); await color('blue');
    assert.equal(await value(),'==🔴**b**====🔵**ol**====🔴**d**==','nested formatting survives partial recoloring');
    await reset(''); await color('red'); await page.keyboard.press('Backspace'); assert.equal(await value(),'','command-created pair is owned');
    await reset('==',0); await page.keyboard.type('=='); await menu.waitFor();
    await menu.locator('[data-color="red"][role="option"]').click(); assert.equal(await value(),'==🔴==','existing suffix is reused');
    await reset(''); await page.keyboard.insertText('==🔴paste=='); await settle(); assert.equal(await menu.count(),0,'paste is not a suggestion trigger');
    await reset('==🔴text== tail',5); await page.locator('.note-highlight-swatch').click(); await menu.waitFor();
    await menu.locator('[data-color="green"][role="option"]').click(); assert.equal(await value(),'==🟢text== tail');
    await select(13); assert.equal(await page.locator('.note-highlight-swatch').count(),0);
    assert.equal(await content.innerText(),'text tail','inactive projection hides emoji and delimiters');
    await reset('one\ntwo\n\nthree',0,14); await color('purple'); assert.equal(await value(),'==🟣one==\n==🟣two==\n\n==🟣three==');
    await reset('==🔴abcd==',5,6);
    await page.evaluate(() => { const e=__highlights.editor, S=RelatumCodeMirror.EditorSelection;
      e.view.dispatch({selection:S.create([S.range(4,5),S.range(7,8)])}); });
    await color('blue'); assert.equal(await value(),'==🔵a====🔴bc====🔵d==');
    for (const [text, pos] of [['`==`',3],['$x==$ ',4],['%% == %%',5],['```text\n==\n```',10],['---\na: ==\n---',9]]) {
      await reset(text,pos); assert.equal(await page.evaluate(() => __highlights.editor.queryCommand('highlight-color:red').enabled),false,text);
    }
    await reset('hello',1,4); await content.click({button:'right'});
    await page.locator('[data-note-submenu="highlight-color"]').hover();
    await page.locator('[data-note-command="highlight-color:orange"]').click(); assert((await value()).includes('🟠'));
    await reset('| cell | other |\n| --- | --- |\n| next | last |');
    await page.locator('td[data-table-row="0"][data-table-col="0"]').click();
    const cell = page.locator('.note-table-cell-editor'); await cell.press('Control+a'); await page.keyboard.type('=='); await menu.waitFor();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Tab'); await page.keyboard.type('cell');
    assert((await value()).includes('==🔴cell=='), 'cell edits commit to parent Markdown');
    await page.locator('.note-highlight-swatch').click(); await menu.locator('[data-color="blue"][role="option"]').click();
    assert((await value()).includes('==🔵cell=='),await value()); await cell.press('Control+z'); assert((await value()).includes('==🔴cell=='),'cell recolor is one parent undo');
    await reset(''); await page.keyboard.type('=='); await menu.waitFor();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); assert.equal(await menu.count(),0);
    await reset(''); await page.keyboard.type('=='); await menu.waitFor();
    await page.evaluate(() => document.dispatchEvent(new Event('relatum:languagechange'))); assert.equal(await menu.count(),0);
    const cdp=await page.context().newCDPSession(page);
    await reset(''); await page.keyboard.type('=='); await menu.waitFor();
    await cdp.send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});
    assert.equal(await menu.count(),0,'preedit dismisses the picker');
    await cdp.send('Input.insertText',{text:'中'}); await settle();
    assert.equal(await value(),'==中','native preedit commits without choosing a color');
    await reset(''); await cdp.send('Input.imeSetComposition',{text:'==',selectionStart:2,selectionEnd:2});
    await cdp.send('Input.insertText',{text:'=='}); await settle(); assert.equal(await menu.count(),0,'composition is not ordinary == input');
    for (const action of ['document','mode','inactive','workspace','minimize','pagehide','blur']) {
      await reset(''); await page.keyboard.type('=='); await menu.waitFor();
      await page.evaluate(action => {
        window.__oldHighlightButton=document.querySelector('.note-highlight-menu button[data-color="red"]');
        const e=__highlights.editor;
        if(action==='document') e.setDocument({value:'new',notePath:'Main.md'});
        else if(action==='mode') e.setSourceMode(true);
        else if(action==='inactive') e.setExtensionsActive(false);
        else if(action==='workspace') document.dispatchEvent(new CustomEvent('relatum:start-workspacechange',{detail:{workspace:'canvas'}}));
        else if(action==='minimize') window.dispatchEvent(new Event('canvasdesktop:visibility'));
        else window.dispatchEvent(new Event(action));
      },action);
      assert.equal(await menu.count(),0,action+' closes menu'); const before=await value();
      await page.evaluate(() => __oldHighlightButton.click()); assert.equal(await value(),before,'stale click after '+action);
      await page.evaluate(() => __highlights.editor.setExtensionsActive(true));
    }
    await reset('==🔴saved==',6); await color('green');
    await page.evaluate(() => __highlights.flushSave());
    assert.equal(fs.readFileSync(path.join(root,'notes/Main.md'),'utf8'),'==🟢saved==');
    await page.reload(); await page.waitForFunction(() => window.__highlights?.state.initialized && __highlights.editor);
    await page.evaluate(() => __highlights.openNote('Main.md')); assert.equal(await value(),'==🟢saved==','real disk round-trip');
    for (const theme of ['default','claude']) for (const dark of [false,true]) {
      await page.evaluate(({theme,dark}) => { RelatumNoteTheme.apply(theme); document.body.dataset.startTheme=dark?'dark':'light'; },{theme,dark});
      await reset('==🔴红色== ==🟠橙色== ==🟡黄色== ==🟢绿色== ==🔵蓝色== ==🟣紫色==\n\n',56);
      await content.press('End'); await page.keyboard.type('=='); await menu.waitFor();
      await page.screenshot({path:path.join(root,theme+(dark?'-dark':'-light')+'.png')}); await page.keyboard.press('Escape');
    }
    await page.setViewportSize({width:600,height:700}); await reset(''); await page.keyboard.type('=='); await menu.waitFor();
    const bounds=await menu.boundingBox(); assert(bounds.x>=0 && bounds.x+bounds.width<=600 && bounds.y+bounds.height<=700);
    await page.keyboard.press('Escape'); await reset('==🔴read=='); await page.evaluate(() => __highlights.setViewMode('reading')); await settle();
    assert.equal(await page.locator('mark.note-highlight[data-hl="red"]').first().innerText(),'read');
    await page.evaluate(() => {
      const host=document.createElement('div'); host.className='note-live-editor-host'; host.style.cssText='position:fixed;left:50px;top:100px;width:400px'; document.body.appendChild(host);
      window.__disposableEditor=RelatumNoteLiveEditor.create(host,{value:'',notePath:'Disposable.md'}); __disposableEditor.focus();
    });
    await page.keyboard.type('=='); await menu.waitFor();
    await page.evaluate(() => { window.__oldHighlightButton=document.querySelector('.note-highlight-menu button'); __disposableEditor.destroy(); __oldHighlightButton.click(); });
    assert.equal(await menu.count(),0,'destroy removes the popup and invalidates its handlers');
    assert.deepEqual(errors,[]); console.log(JSON.stringify({passed:true,root}));
  } finally { await browser?.close(); service.kill(); }
})().catch(error => { console.error(error); process.exitCode=1; });
