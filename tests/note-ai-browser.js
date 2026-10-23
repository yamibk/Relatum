'use strict';
// Real local backend + disposable data + an entirely local fake provider.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifacts = process.env.RELATUM_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-ai-artifacts-'));
fs.mkdirSync(artifacts, { recursive: true });
async function until(predicate) { for (let index = 0; index < 300; index++) { if (await predicate()) return; await pause(50); } throw new Error('Timed out waiting for local persisted state'); }
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
const calls = [];
const provider = http.createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw); calls.push(body);
  const text = body.messages.at(-1).content;
  if (text.startsWith('error') && !(text === 'error429' && calls.filter(call => call.messages.at(-1).content === text).length > 1)) { response.writeHead(Number(text.slice(5)), { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'private-test-key-1234' } })); return; }
  if (!body.stream) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); return; }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = value => 'data: ' + JSON.stringify(value) + '\r\n\r\n';
  response.write(': heartbeat\r\n\r\n');
  response.write(event({ choices: [{ delta: { reasoning_content: '简短思考' } }] }));
  const answer = text.startsWith('slow') ? 'Partial answer' : '## 回答\n\n**本机模拟**：' + text;
  const encoded = Buffer.from(event({ choices: [{ delta: { content: answer } }] }));
  response.write(encoded.subarray(0, 47)); response.write(encoded.subarray(47));
  const timer = setTimeout(() => { response.end(event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } }) + 'data: [DONE]\r\n\r\n'); }, text.startsWith('slow') ? 2500 : 25);
  response.on('close', () => clearTimeout(timer));
});

async function run(browser, mode, providerURL) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-ai-data-'));
  fs.mkdirSync(path.join(data, 'notes')); fs.mkdirSync(path.join(data, 'data'));
  const note = '# Original\n\nKeep this text and selection.\n\n' + 'Long paragraph.\n\n'.repeat(180);
  fs.writeFileSync(path.join(data, 'notes/Main.md'), note);
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json')));
  const features = Object.fromEntries(catalog.features.map(feature => [feature.id, mode === 'full' || mode === 'no-editor-ai' ? !(mode === 'no-editor-ai' && feature.id === 'editor.ai') : feature.id === 'notes' || feature.id.startsWith('notes.') && !(mode === 'no-canvas' && feature.id === 'notes.canvas') && !(mode === 'no-ai' && feature.id === 'notes.ai')]));
  const legacy = new Map();
  if(features['notes.ai']) for(const suffix of ['', '-wal', '-shm']) {
    const file=path.join(data,'data/note-ai.sqlite3'+suffix), bytes=Buffer.from('legacy-chat-is-not-opened'+suffix);
    fs.writeFileSync(file,bytes);legacy.set(file,bytes);
  }
  const port = await freePort(), url = 'http://127.0.0.1:' + port;
  let logs = '';
  const launch=()=>{
    const child=spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port), '--launch-profile', JSON.stringify({ version: 1, features })], { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data',chunk=>{logs+=chunk;});child.stderr.on('data',chunk=>{logs+=chunk;});return child;
  };
  let server=launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  let page;
  const request = async (endpoint, body) => { const response = await fetch(url + '/api/note-ai/' + endpoint, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  try {
    let ready = false;
    for (let index = 0; index < 140; index++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, logs);
    page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = [], resources = []; page.on('pageerror', error => errors.push(error.message)); page.on('request', req => resources.push(req.url()));
    let keyWrites=0; const chatPosts=[];
    page.on('request', req => {
      if(req.url()===url+'/api/note-ai/config'&&req.method()==='POST'&&Object.hasOwn(req.postDataJSON(),'apiKey')) keyWrites++;
      if(req.url()===url+'/api/note-ai/chat'&&req.method()==='POST') chatPosts.push(req.postDataJSON());
    });
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {', '  window.T = { state, setSideMode, setSideOpen, setNoteSettingsOpen, get editor(){return liveEditor;} };\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => { localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteFocusMode:v1', '0'); localStorage.setItem('canvas:noteActivePath:v1', 'Main.md'); localStorage.setItem('canvas:noteOpenTabs:v1', '["Main.md"]'); });
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.active && T.state.current?.path === 'Main.md' && !T.state.openingPath);
    assert(!resources.some(url => /note-ai\.(js|css)/.test(url)), 'AI runtime stays cold until requested');
    if(!features['canvas.review']) assert(!resources.some(url=>/review-controls\.(js|css)/.test(url)),'note-only choices load on demand');
    await page.evaluate(() => { window.originalEditor = T.editor; window.originalDoc = T.editor.view.state.doc; T.editor.view.dispatch({ selection: { anchor: 5, head: 12 } }); window.originalSelection = T.editor.view.state.selection.toJSON(); });
    const dialog = page.locator('[data-role="note-settings-dialog"]'), gear = page.locator('[data-note-action="toggle-library-settings"]');
    const category = id => dialog.locator('nav [data-settings-category="' + id + '"]');
    const closeSettings = async () => { await dialog.locator('[data-settings-action="close"]').click(); await dialog.waitFor({ state: 'hidden' }); };
    const resetCategory = async () => { await dialog.locator('[data-settings-action="reset-category"]').click(); await dialog.locator('[data-settings-action="accept-reset"]').click(); };
    await gear.click(); await category('sidebar').click();
    const sidebarRows = dialog.locator('[data-sidebar-page]');
    assert.equal(await sidebarRows.count(), 6 - (!features['notes.canvas'] ? 1 : 0) - (!features['notes.ai'] ? 1 : 0));
    await sidebarRows.locator('[data-sidebar-visible="links"]').uncheck();
    assert(await page.locator('[data-note-action="side-links"]').isHidden());
    await sidebarRows.locator('[data-sidebar-visible="links"]').check();
    const guideGrip = dialog.locator('[data-sidebar-page="guide"] .note-sidebar-grip');
    await guideGrip.focus(); await page.keyboard.press('Home');
    const ids = await sidebarRows.evaluateAll(rows => rows.map(row => row.dataset.sidebarPage)); assert.equal(ids[0], 'guide');
    const oldPref = await page.evaluate(() => localStorage.getItem('canvas:noteSidebarPages:v1'));
    const grip = await guideGrip.boundingBox(), last = await sidebarRows.last().boundingBox();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await pause(60);
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down(); await page.mouse.move(last.x + 22, last.y + last.height - 3, { steps: 12 });
    await page.waitForFunction(() => !!document.querySelector('.note-sidebar-ghost'));
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert(await dialog.isVisible()); assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteSidebarPages:v1')), oldPref);
    assert.deepEqual(await sidebarRows.evaluateAll(rows => rows.map(row => row.dataset.sidebarPage)), ids);
    // Commit a real pointer reorder, then check its persisted visible order.
    const from = await guideGrip.boundingBox(), to = await sidebarRows.last().boundingBox();
    await page.mouse.move(from.x + 10, from.y + 10); await page.mouse.down(); await page.mouse.move(to.x + 20, to.y + to.height - 2, { steps: 12 }); await page.mouse.up();
    const reordered = await sidebarRows.evaluateAll(rows => rows.map(row => row.dataset.sidebarPage)); assert.equal(reordered.at(-1), 'guide');
    if (!features['notes.canvas']) assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('canvas:noteSidebarPages:v1')).order.indexOf('canvas')), 2, 'disabled canvas keeps its full-list slot');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const checkbox of await sidebarRows.locator('input').all()) await checkbox.uncheck();
    assert(await dialog.isVisible(), 'all-hidden does not dismiss the settings');
    await closeSettings(); assert(await page.locator('[data-note-action="toggle-notebooks"]').isHidden());
    await gear.click(); await category('sidebar').click(); await resetCategory();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteSidebarPages:v1')), null);
    if (!features['notes.ai']) {
      assert.equal(await category('ai').count(), 0); assert.equal(await page.locator('[data-note-action="side-ai"]').count(), 0);
      assert.equal((await request('config')).status, 403); assert.equal((await request('chat', {})).status, 403);
      assert.equal((await fetch(url + '/note-ai.js')).status, 403);
      assert(!fs.existsSync(path.join(data, 'data/note-ai.json'))); assert(!fs.existsSync(path.join(data, 'data/note-ai.sqlite3')));
      await closeSettings(); assert.deepEqual(errors, []); console.log(mode + ': sidebar and disabled AI resource/API gates passed'); return;
    }
    await dialog.locator('[data-settings-search]').fill('模型');
    await dialog.locator('.relatum-settings-result').filter({ hasText: '模型名称' }).first().click();
    assert.equal(await category('ai').getAttribute('aria-current'), 'page');
    const field = name => dialog.locator('[data-ai-field="' + name + '"]');
    const trigger=selector=>dialog.locator(selector).locator('..').locator('.review-choice-trigger');
    async function choose(selector,value) {
      const label=await dialog.locator(selector).locator('option[value="'+value+'"]').textContent();
      await trigger(selector).click();await dialog.getByRole('option',{name:label,exact:true}).click();
    }
    await field('model').waitFor();
    assert.equal(await field('model').inputValue(), ''); assert.equal(await field('apiKey').inputValue(), ''); assert.equal(await field('thinking').inputValue(), 'auto');
    await field('baseUrl').fill(providerURL + '/v1'); await field('model').fill('test-model'); await field('apiKey').fill('private-test-key-1234'); await field('apiKey').blur();
    await until(async () => { const config = (await request('config')).body; return config.hasKey && config.model === 'test-model'; });
    assert(!JSON.stringify((await request('config')).body).includes('private-test-key-1234'));
    const savedKeyWrites=keyWrites;
    await field('apiKey').focus();await until(async()=>await field('apiKey').inputValue()==='private-test-key-1234');
    assert.equal(await field('apiKey').getAttribute('type'),'text');
    await field('apiKey').blur();assert.equal(await field('apiKey').getAttribute('type'),'password');assert.equal(await field('apiKey').inputValue(),'');
    assert.equal(await dialog.getByRole('button',{name:'显示输入',exact:true}).count(),0);
    await dialog.locator('[data-ai-test]').click(); await page.waitForFunction(() => document.querySelector('[data-ai-settings-status]')?.textContent.includes('连接成功'));
    assert.equal(keyWrites,savedKeyWrites,'viewing the saved key never rewrites configuration');
    async function delayedReveal(action) {
      let release,received,finished;
      const ready=new Promise(resolve=>{received=resolve;}),gate=new Promise(resolve=>{release=resolve;}),done=new Promise(resolve=>{finished=resolve;});
      const routeHandler=async route=>{const response=await route.fetch();received();await gate;await route.fulfill({response});finished();};
      await page.route('**/api/note-ai/reveal-key',routeHandler);
      try {await field('apiKey').focus();await ready;await action();}
      finally {release();await done;await page.unroute('**/api/note-ai/reveal-key',routeHandler);}
      await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
    }
    await delayedReveal(async()=>{await field('apiKey').fill('replacement-test-key-5678');await field('apiKey').blur();});
    await until(async()=>(await request('config')).body.keyHint==='••••5678');
    await field('apiKey').focus();await until(async()=>await field('apiKey').inputValue()==='replacement-test-key-5678');await field('apiKey').blur();
    await delayedReveal(async()=>{await dialog.locator('[data-ai-clear-key]').click();await dialog.locator('[data-ai-clear-key]').click();await until(async()=>!(await request('config')).body.hasKey);});
    assert.equal(await field('apiKey').inputValue(),'','a late reveal cannot resurrect a cleared key');
    await field('apiKey').fill('private-test-key-1234');await field('apiKey').blur();await until(async()=>(await request('config')).body.hasKey);
    const beforeCloseWrites=keyWrites;
    await delayedReveal(closeSettings);
    assert.equal(await field('apiKey').inputValue(),'','a late reveal cannot refill closed settings');
    assert.equal(keyWrites,beforeCloseWrites);
    await gear.click();await category('ai').click();await field('model').waitFor();
    assert.equal(await dialog.locator('[data-ai-preset-name]').isVisible(),false,'no-preset hides the empty editor');
    assert.equal(await category('ai').locator('use').getAttribute('href'),'#note-icon-sparkles');
    assert(await field('thinking').isHidden());assert(await trigger('[data-ai-field="effort"]').isDisabled());
    await dialog.locator('[data-settings-search]').fill('思考模式');await dialog.locator('.relatum-settings-result').filter({hasText:'思考模式'}).first().click();
    assert(await trigger('[data-ai-field="thinking"]').evaluate(el=>document.activeElement===el),'search focuses the custom control');
    await trigger('[data-ai-field="thinking"]').press('ArrowDown');await page.keyboard.press('End');await page.keyboard.press('Enter');
    assert.equal(await field('thinking').inputValue(),'enabled');assert(await trigger('[data-ai-field="effort"]').isEnabled());
    await choose('[data-ai-field="effort"]','max'); await field('temperature').fill('-1');
    assert.equal(await field('temperature').getAttribute('aria-invalid'), 'true');
    await field('temperature').fill('0.3'); await field('maxTokens').fill('500');
    await choose('[data-ai-preset-editor]','dictionary');
    assert((await dialog.locator('[data-ai-preset-prompt]').inputValue()).includes('【搭配与辨析】'));
    await dialog.locator('[data-ai-preset-duplicate]').click();
    await dialog.locator('[data-ai-preset-name]').fill('Tutor'); await dialog.locator('[data-ai-preset-prompt]').fill('Custom tutor prompt'); await field('model').focus();
    await until(async () => (await request('config')).body.presets.some(item => item.name === 'Tutor' && item.prompt === 'Custom tutor prompt'));
    const savedConfig = (await request('config')).body;
    assert(savedConfig.presets.some(item => item.name === 'Tutor'), JSON.stringify(savedConfig.presets));
    const custom = savedConfig.presets.find(item => item.name === 'Tutor').id;
    if(mode==='notes') await request('config',{presets:[...savedConfig.presets.filter(item=>!item.builtin),...Array.from({length:9},(_,i)=>({id:'search-'+i,name:'Search preset '+i,prompt:'Prompt '+i}))]});
    await resetCategory();
    await page.waitForFunction(() => document.querySelector('[data-ai-field="baseUrl"]')?.value === 'https://api.deepseek.com');
    const reset = (await request('config')).body; assert.equal(reset.model, 'test-model'); assert(reset.hasKey); assert(reset.presets.some(item => item.id === custom));
    if(mode==='notes') {
      await trigger('[data-ai-preset-editor]').click();await dialog.locator('.review-choice-search').fill('Tutor');
      assert.equal(await dialog.getByRole('option').count(),1);await dialog.getByRole('option',{name:'Tutor',exact:true}).click();
      await trigger('[data-ai-preset-editor]').click();await category('appearance').click();assert.equal(await dialog.locator('.review-choice-popup').count(),0,'changing category releases the popup');await category('ai').click();
    }
    await field('baseUrl').fill(providerURL + '/v1'); await field('model').focus();
    await closeSettings(); await page.locator('[data-note-action="toggle-notebooks"]').click(); await page.locator('[data-note-action="side-ai"]').click();
    const ai = page.locator('[data-role="note-ai"]'), input = ai.locator('[data-ai-input]'), send = ai.locator('[data-ai-send]');
    await input.waitFor();await until(async()=>await input.isEnabled());
    assert.equal(await ai.locator('.note-ai-top,.note-ai-history,.note-ai-empty,select,button[aria-label="AI 设置"]').count(),0,'the sidebar has no top controls or empty-state copy');
    assert.equal(await ai.locator('.note-ai-composer [data-ai-new]').textContent(),'+');
    assert.equal(await dialog.locator('[data-ai-preset]').inputValue(),'none');
    await input.fill('hello'); const callCount = calls.length;
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 }); await pause(70); assert.equal(calls.length, callCount);
    await input.press('Enter'); await input.press('Enter'); await page.waitForFunction(() => document.querySelector('[data-ai-send]')?.getAttribute('aria-label') === '发送' && document.querySelector('.note-ai-answer strong'));
    assert.equal(calls.slice(callCount).filter(call => call.messages.at(-1).content === 'hello').length, 1, 'rapid Enter does not duplicate a request');
    const first = calls.at(-1); assert.deepEqual(first.messages, [{ role: 'user', content: 'hello' }]); assert(!Object.hasOwn(first, 'thinking'));
    await ai.locator('[data-ai-role="assistant"] [data-ai-copy]').click(); assert((await page.evaluate(() => navigator.clipboard.readText())).includes('**本机模拟**'));
    assert((await ai.locator('.note-ai-message-foot').last().textContent()).includes('12 / 7 tokens'));
    const usePreset=async value=>{await page.evaluate(()=>T.setNoteSettingsOpen(true,{category:'ai'}));await field('model').waitFor();await choose('[data-ai-preset]',value);await closeSettings();};
    const answerReady=async text=>page.waitForFunction(text=>{
      const users=document.querySelectorAll('[data-ai-role="user"] .note-ai-answer'),answers=document.querySelectorAll('[data-ai-role="assistant"] .note-ai-message-foot');
      return users[users.length-1]?.textContent===text&&answers[answers.length-1]?.textContent.includes('tokens')&&document.querySelector('[data-ai-send]').getAttribute('aria-label')==='发送';
    },text);
    await input.fill('follow up');await input.press('Enter');await answerReady('follow up');assert.equal(calls.at(-1).messages.length,3,'the temporary conversation keeps multi-turn context');
    await usePreset('dictionary'); assert.equal(await ai.locator('[data-ai-role]').count(), 0);
    await input.fill('serendipity'); await input.press('Enter'); await answerReady('serendipity');
    assert(calls.at(-1).messages[0].content.includes('【词频】'));
    await usePreset(custom); await input.fill('custom question'); await input.press('Enter');await answerReady('custom question');
    assert.equal(calls.at(-1).messages[0].content, 'Custom tutor prompt');
    const selectedId = chatPosts.at(-1).sessionId;
    assert.equal((await request('messages?id=' + selectedId)).body.session.prompt, 'Custom tutor prompt');
    assert(await page.evaluate(() => T.editor === originalEditor && T.editor.view.state.doc === originalDoc && JSON.stringify(T.editor.view.state.selection.toJSON()) === JSON.stringify(originalSelection)));
    await page.screenshot({ path: path.join(artifacts, mode + '-ai-light-zh-wide.png') });
    await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'ai' })); await field('model').waitFor();
    await page.screenshot({ path: path.join(artifacts, mode + '-settings-light-zh-wide.png') });
    await closeSettings();
    if (mode === 'full') {
      await ai.locator('[data-ai-new]').click();
      assert(await input.evaluate(el=>document.activeElement===el));assert.equal(await ai.locator('[data-ai-role]').count(),0);
      assert.equal(await ai.locator('.note-ai-notice').textContent(),'');
      await until(async()=>(await request('messages?id='+selectedId)).status===404);
      await ai.locator('[data-ai-new]').click();assert.equal((await request('sessions')).body.items.length,0,'repeated new-chat clicks create no empty histories');
      await input.fill('slow stop'); await input.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-ai-role="assistant"] .note-ai-answer')?.textContent === 'Partial answer');
      await send.click(); await page.waitForFunction(() => document.querySelector('[data-ai-role="assistant"] .note-ai-message-foot')?.textContent.includes('已停止'));
      await usePreset('deepseek'); await input.fill('slow switch'); await input.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-ai-role="assistant"] .note-ai-answer')?.textContent === 'Partial answer');
      const switching=chatPosts.at(-1).sessionId;
      await ai.locator('[data-ai-new]').click();await until(async()=>(await request('messages?id='+switching)).status===404);
      assert.equal(await ai.locator('[data-ai-role]').count(),0,'late output cannot refill a discarded conversation');
      await usePreset('none');
      await input.fill('slow minimized'); await input.press('Enter'); await page.waitForFunction(() => document.querySelector('[data-ai-role="assistant"] .note-ai-answer')?.textContent === 'Partial answer');
      await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
      await pause(80); await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
      await page.waitForFunction(() => document.querySelector('[data-ai-send]')?.getAttribute('aria-label') === '发送');
      const count = calls.length; await pause(150); assert.equal(calls.length, count, 'restore does not resend');
      await ai.locator('[data-ai-new]').click(); await input.fill('error429'); await input.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-ai-role="assistant"] [data-ai-retry]')?.hidden === false);
      assert(!await ai.textContent().then(value => value.includes('private-test-key-1234')));
      await ai.locator('[data-ai-role="assistant"] [data-ai-retry]').click();
      await page.waitForFunction(() => document.querySelector('[data-ai-send]')?.getAttribute('aria-label') === '发送' && document.querySelector('.note-ai-answer strong'));
      const retried = chatPosts.at(-1).sessionId; assert.equal((await request('messages?id=' + retried)).body.messages.length, 2);
      await ai.locator('[data-ai-new]').click();
      await until(async () => (await request('messages?id=' + retried)).status === 404);
    }
    await input.fill('keep within this run');await input.press('Enter');await answerReady('keep within this run');
    await page.evaluate(()=>T.setSideMode('outline'));await page.evaluate(()=>T.setSideMode('ai'));await input.waitFor();
    assert((await ai.textContent()).includes('keep within this run'),'sidebar changes keep the current temporary conversation');
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; RelatumI18n.setLanguage('en'); });
    await page.setViewportSize({ width: 560, height: 780 });
    await page.screenshot({ path: path.join(artifacts, mode + '-ai-dark-en-narrow.png') });
    await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'ai' })); await field('model').waitFor();
    assert((await dialog.textContent()).includes('System prompt presets'));
    await trigger('[data-ai-field="thinking"]').click();
    const popup=dialog.locator('.review-choice-popup');assert(await popup.isVisible());
    assert(await popup.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}));
    await page.screenshot({path:path.join(artifacts,mode+'-choices-dark-en-narrow.png')});
    await page.keyboard.press('Escape');assert.equal(await popup.count(),0);assert(await dialog.isVisible());
    await page.screenshot({ path: path.join(artifacts, mode + '-settings-dark-en-narrow.png') });
    await closeSettings(); await pause(450);
    const idle = await page.evaluate(async () => { const original = window.requestAnimationFrame; let frames = 0; window.requestAnimationFrame = callback => { frames++; return original.call(window, callback); }; await new Promise(resolve => setTimeout(resolve, 350)); window.requestAnimationFrame = original; return frames; });
    assert.equal(idle, 0, 'idle AI/settings do not schedule animation frames');
    assert.equal(fs.readFileSync(path.join(data, 'notes/Main.md'), 'utf8'), note);
    assert(!resources.some(resource=>/\/api\/note-ai\/(sessions|messages)(?:\?|$)/.test(resource)),'the frontend never requests conversation history');
    for(const [file,bytes] of legacy) assert(fs.readFileSync(file).equals(bytes),'legacy chat files are untouched');
    const configBeforeRestart=(await request('config')).body;
    await pause(450);const exiting=new Promise(resolve=>server.once('exit',resolve));server.kill();await exiting;
    server=launch();await until(async()=>{try{return(await fetch(url+'/api/runtime')).ok;}catch(_){return false;}});
    assert.deepEqual((await request('sessions')).body,{items:[],more:false,active:null},'a restarted service has no chat');
    assert.deepEqual((await request('config')).body,configBeforeRestart,'connection settings and custom presets survive restart');
    await page.reload();await page.waitForFunction(()=>window.T?.state.active);await page.evaluate(()=>{T.setSideOpen(true);T.setSideMode('ai');});
    await input.waitFor();await until(async()=>await input.isEnabled());assert.equal(await ai.locator('[data-ai-role]').count(),0);
    await page.evaluate(()=>T.setNoteSettingsOpen(true,{category:'ai'}));await field('model').waitFor();assert.equal(await dialog.locator('[data-ai-preset]').inputValue(),'none');await closeSettings();
    for(const [file,bytes] of legacy) assert(fs.readFileSync(file).equals(bytes));
    assert.deepEqual(errors, []);
    console.log(mode + ': sidebar, AI, lifecycle, screenshots passed');
  } catch (error) { if (page) await page.screenshot({ path: path.join(artifacts, mode + '-failure.png') }).catch(() => {}); fs.writeFileSync(path.join(artifacts, mode + '-server.log'), logs); throw error; }
  finally { await context.close(); server.kill(); await new Promise(resolve => server.once('exit', resolve)); fs.rmSync(data, { recursive: true, force: true }); }
}
(async () => {
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.RELATUM_EDGE_PATH || undefined, headless: true });
  try { for (const mode of (process.env.RELATUM_TEST_MODE ? process.env.RELATUM_TEST_MODE.split(',') : ['full', 'notes', 'no-canvas', 'no-ai', 'no-editor-ai'])) await run(browser, mode, 'http://127.0.0.1:' + provider.address().port); console.log('Artifacts: ' + artifacts); }
  finally { await browser.close(); provider.closeAllConnections(); provider.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
