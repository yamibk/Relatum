'use strict';
// Resource and entry-point checks against isolated real servers and Edge.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'), 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
function only(ids) { return Object.fromEntries(catalog.features.map(item => [item.id, ids.includes(item.id)])); }
const cases = [
  ['full', null],
  ['notes', only(['notes'])],
  ['notes-mermaid', only(['notes', 'notes.mermaid', 'runtime.preload'])],
  ['notes-mermaid-mixed-off', only(['notes', 'canvas', 'canvas.quicknotes', 'runtime.preload'])],
  ['notes-mermaid-parent-off', only(['canvas', 'canvas.quicknotes', 'notes.mermaid'])],
  ['notes-quiz', only(['notes', 'notes.quiz', 'runtime.preload'])],
  ['notes-quiz-off', only(['notes', 'runtime.preload'])],
  ['notes-quiz-parent-off', only(['canvas', 'canvas.quicknotes', 'notes.quiz'])],
  ['research', only(['research'])],
  ['career', only(['career'])],
  ['notes-career', only(['notes', 'career'])],
  ['library', only(['canvas', 'canvas.library'])],
  ...catalog.features.filter(item => item.view).map(item => [item.view, only([item.parent, item.id])]),
  ['daily-tasks', only(['daily', 'daily.tasks'])],
  ['daily-ledger', only(['daily', 'daily.ledger'])],
  ['editor', only(['canvas', 'canvas.editor'])],
];
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  try {
    const selected = process.argv.slice(2);
    for (const [name, choices] of cases.filter(([name]) => !selected.length || selected.includes(name))) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-features-'));
      fs.mkdirSync(path.join(root, 'canvases'));
      const canvas = path.join(root, 'canvases', 'test.canvas');
      fs.writeFileSync(canvas, JSON.stringify({ nodes: [], edges: [] }));
      const quizFixture = ['notes-quiz', 'notes-quiz-off'].includes(name);
      const noteFixture = (!choices || choices.notes) && (quizFixture || ['full', 'notes', 'notes-mermaid', 'notes-mermaid-mixed-off'].includes(name));
      if (noteFixture) {
        fs.mkdirSync(path.join(root, 'notes'));
        fs.writeFileSync(path.join(root, 'notes', 'Diagram.md'), quizFixture ? '# 选择题\n\n```quiz\n哪项正确？\n- [ ] 错误\n- [x] 正确\n```\n\n正文' : '# 图表\n\n```mermaid\nflowchart LR\n A[开始] --> B[完成]\n```\n\n正文', 'utf8');
      }
      if (name === 'career') {
        fs.mkdirSync(path.join(root, 'notes'));
        fs.writeFileSync(path.join(root, 'notes', 'A.md'), 'A [[B]]', 'utf8');
        fs.writeFileSync(path.join(root, 'notes', 'B.md'), 'B [A](A.md)', 'utf8');
      }
      const port = await freePort();
      const base = `http://127.0.0.1:${port}`;
      const args = ['app.py', '--no-browser', '--port', String(port)];
      if (choices) args.push('--launch-profile', JSON.stringify({ version: 1, features: choices }));
      if (name === 'editor') args.push(canvas);
      const server = spawn(process.env.RELATUM_SERVER_EXE || process.env.RELATUM_PYTHON || 'python', process.env.RELATUM_SERVER_EXE ? args.slice(1) : args, { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
      // Restore a workspace/page that may have been disabled in this session.
      await context.addInitScript(({ noteFixture, dailyCase, ids }) => {
        if (dailyCase) localStorage.setItem('canvas:workspaceLayout:v1', JSON.stringify({ order: ids, hidden: [] }));
        localStorage.setItem('canvas:startWorkspace:v1', 'notes');
        localStorage.setItem('canvas:hideSpecialPages', '1');
        localStorage.setItem('canvas:noteFocusMode:v1', '0');
        if (noteFixture) {
          localStorage.setItem('canvas:noteOpenTabs:v1', '["Diagram.md"]');
          localStorage.setItem('canvas:noteActiveTab:v1', 'Diagram.md');
        }
        window.pywebview = { api: { set_dirty() {}, set_note_workspace_active() {}, get_window_state: async () => ({ maximized: false }), close_window() {}, minimize_window() {}, toggle_maximize_window() {} } };
        function firstHeader() {
          const header = document.querySelector('body > .top-bar');
          if (!header) { requestAnimationFrame(firstHeader); return; }
          window.__firstHeader = { height: header.getBoundingClientRect().height, opacity: getComputedStyle(header).opacity };
        }
        requestAnimationFrame(firstHeader);
      }, { noteFixture, dailyCase: choices?.daily, ids: catalog.workspaces.map(item => item.id) });
      try {
        let ready = false;
        for (let i = 0; i < 100; i++) {
          try { if ((await fetch(base + '/api/runtime')).ok) { ready = true; break; } } catch (_) {}
          await sleep(100);
        }
        assert(ready, `${name}: server startup`);
        const page = await context.newPage();
        const errors = [], requests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => requests.push(new URL(request.url()).pathname));
        const runtime = await (await fetch(base + '/api/runtime')).json();
        const enabled = id => runtime.features[id];
        const home = catalog.features.some(item => item.id !== 'canvas.editor' && item.id.startsWith('canvas.') && enabled(item.id));
        if (name === 'career') {
          let job = await (await fetch(base + '/api/career/generate', { method: 'POST', body: '{}' })).json();
          for (let i = 0; job.status === 'running' && i < 100; i++) {
            await sleep(100); job = await (await fetch(base + '/api/career/jobs/' + job.id)).json();
          }
          assert.equal(job.status, 'complete', 'Career-only inventory generation');
        }
        const url = name === 'editor' ? base + '/editor.html?file=' + encodeURIComponent(canvas) : base + (enabled('canvas.study') ? '/?desktop=1&view=study' : '/?desktop=1');
        await page.goto(url, { waitUntil: 'load' });
        if (name === 'full' || enabled('notes')) await page.waitForFunction(() => window.CanvasNoteWorkspace);
        if (name === 'research') await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow.RelatumResearchWorkspace);
        if (name === 'career') await page.waitForFunction(() => window.RelatumCareerReport);
        if (name === 'editor') await page.waitForFunction(() => document.body.classList.contains('canvas-ready'));
        if (choices?.daily) await page.waitForSelector('.daily-navigation');
        await sleep(2400); // includes the existing idle prewarm jobs
        if (noteFixture) {
          await page.waitForSelector('.note-live-editor-host .cm-editor');
          if (quizFixture) {
            if (enabled('notes.quiz')) { await page.waitForSelector('.note-live-rich-block.is-quiz .note-quiz'); await page.locator('.note-quiz [data-quiz-option="1"]').click(); assert.equal(await page.locator('.note-quiz').getAttribute('data-quiz-state'), 'correct'); }
            else { assert.equal(await page.locator('.note-quiz').count(), 0); assert(!requests.some(url => url.includes('note-quiz')), 'disabled quizzes stay cold'); }
          } else if (enabled('notes.mermaid')) await page.waitForSelector('.note-live-rich-block.is-mermaid [data-note-mermaid-rendered] svg');
          else {
            assert.equal(await page.locator('.note-live-rich-block.is-mermaid').count(), 0, name + ': disabled blocks remain code');
            assert(!requests.some(url => url.includes('note-mermaid') || url.includes('vendor/pele/')), name + ': disabled note resources');
          }
          assert(!requests.some(url => url.includes('vendor/mermaid/')), name + ': notes never request the legacy engine');
        }
        assert.deepEqual(errors, [], `${name}: page errors`);
        if (name !== 'editor') {
          const header = page.locator('body > .top-bar');
          if (name === 'career') {
            assert.equal(await header.evaluate(el => getComputedStyle(el).opacity), '0', 'career keeps its existing edge header');
            await header.locator('button').first().focus();
          } else {
            assert.equal(await header.evaluate(el => getComputedStyle(el).opacity), '1', 'workspace count does not hide the header');
          }
          const labels = { 'zh-CN': { canvas: '画布', notes: '笔记', research: '研究', career: '生涯', daily: '日常' }, en: { canvas: 'Canvas', notes: 'Notes', research: 'Research', career: 'Career', daily: 'Daily' } };
          for (const language of ['en', 'zh-CN']) {
            await page.evaluate(language => window.RelatumI18n.setLanguage(language), language);
            for (const width of [1280, 720]) {
              await page.setViewportSize({ width, height: 800 });
              const navigation = await page.evaluate(() => {
                const slider = document.querySelector('.start-workspace-slider').getBoundingClientRect();
                const active = document.querySelector('button[data-start-workspace].active');
                const button = active.getBoundingClientRect();
                return { text: active.textContent.trim(), name: active.dataset.startWorkspace, offset: Math.abs(slider.left - button.left), width: Math.abs(slider.width - button.width), buttons: Array.from(document.querySelectorAll('button[data-start-workspace]')).map(el => ({ name: el.dataset.startWorkspace, text: el.textContent.trim() })) };
              });
              for (const button of navigation.buttons) assert.equal(button.text, labels[language][button.name], `${name}: ${language} workspace label`);
              assert(navigation.offset < 1 && navigation.width < 1, `${name}: ${language} active slider covers its button at ${width}px (${JSON.stringify(navigation)})`);
            }
          }
          if (name === 'notes-career') {
            await page.locator('button[data-start-workspace="career"]').click();
            await sleep(100);
            const offset = await page.evaluate(() => Math.abs(document.querySelector('.start-workspace-slider').getBoundingClientRect().left - document.querySelector('button[data-start-workspace="career"]').getBoundingClientRect().left));
            assert(offset < 1, 'two-workspace slider follows the actual order');
          }
          await page.setViewportSize({ width: 1280, height: 800 });
          if (name === 'notes' && enabled('notes') && process.env.RELATUM_NOTES_PREVIEW) await page.screenshot({ path: process.env.RELATUM_NOTES_PREVIEW });
          assert.deepEqual(errors, [], `${name}: language and viewport changes`);
        }
        if (name === 'calendar') assert(!await page.evaluate(() => !!window.RelatumLedgerModel), 'calendar does not load the ledger');
        if (name === 'career') {
          await page.evaluate(() => {
            const panel = document.querySelector('[data-chart-key="note-network"]').closest('.career-panel');
            document.querySelector('.career-scroll').scrollTop = panel.offsetTop;
          });
          await page.waitForSelector('[data-chart-key="note-network"] canvas');
          await page.waitForFunction(() => !!window.GraphEngine && document.querySelector('[data-chart-key="note-network"] canvas').width > 1);
          assert.equal(requests.filter(r => r === '/graph-gl.js').length, 1, 'Career-only loads the shared GL runtime once');
          assert.equal(requests.filter(r => r === '/graph-engine.js').length, 1, 'Career-only loads the shared engine once');
          assert.deepEqual(errors, [], 'Career-only chart runtime errors');
        }
        if (name === 'library') assert(await page.evaluate(() => !!window.RelatumStickyPalette), 'library keeps the shared floating-note palette');
        if (home) {
          const visible = await page.evaluate(() => document.querySelector('.book-view').dataset.viewName);
          assert(runtime.features['canvas.library'] || catalog.features.some(item => item.view === visible && enabled(item.id)), `${name}: selected enabled page (${visible})`);
          await page.evaluate(() => document.dispatchEvent(new CustomEvent('relatum:startnavigate', { detail: { view: 'study' } })));
          if (!enabled('canvas.study')) assert.notEqual(await page.evaluate(() => document.querySelector('.book-view').dataset.viewName), 'study');
          // Exercise the spine's circular page route.
          await page.locator('.left-spine').dispatchEvent('wheel', { deltaY: 120, clientX: 40, clientY: 200 });
          await sleep(100);
          assert.deepEqual(errors, [], `${name}: navigation errors`);
        }
        if (choices) {
          for (const item of catalog.features) {
            if (enabled(item.id)) continue;
            for (const src of item.scripts || []) {
              // Shared assets can remain available for another enabled owner.
              const owners = catalog.sharedScripts[src] || [];
              if (owners.some(enabled)) continue;
              assert(!requests.some(request => src.endsWith('/') ? request.slice(1).startsWith(src) : request === '/' + src), `${name}: disabled request ${src}`);
              assert.equal((await fetch(base + '/' + src + (src.endsWith('/') ? 'research-workspace.js' : ''))).status, 403, `${name}: direct asset ${src}`);
            }
            for (const resource of item.pages || []) assert.equal((await fetch(base + '/' + resource)).status, 403);
            if (item.view) assert.equal((await fetch(base + '/?view=' + item.view)).status, 403, `${name}: direct page ${item.view}`);
            for (const api of item.writePaths || []) assert.equal((await fetch(base + api, { method: 'POST', body: '{}' })).status, 403, `${name}: write ${api}`);
            for (const prefix of item.writePrefixes || []) assert.equal((await fetch(base + prefix + 'disabled-test', { method: 'POST', body: '{}' })).status, 403, `${name}: prefix ${prefix}`);
          }
          if (!enabled('canvas.editor')) assert.equal((await fetch(base + '/api/load?file=' + encodeURIComponent(canvas))).status, 403);
          if (!enabled('canvas.editor')) assert.equal((await fetch(base + '/EDITOR.HTML')).status, 403, 'Windows case alias');
          if (name === 'editor') assert.equal((await fetch(base + '/%5Cignored')).status, 403, 'Windows path alias must not serve an unfiltered homepage');
          assert.equal((await fetch(base + '/api/study-activity')).status, 200, 'historical activity stays readable');
          assert.equal((await fetch(base + '/api/career/report')).status, enabled('career')?200:403, 'new frozen report follows the Career feature');
        }
        if (name === 'full') {
          const state = await page.evaluate(() => ({ study: !!window.StudyView, activity: !!window.StudyActivity, career: !!window.RelatumCareerReport }));
          assert(state.study && state.activity && state.career, 'full mode keeps enabled runtimes and career prewarm');
        }
        console.log(`${name}: passed (${requests.length} requests)`);
      } finally {
        await context.close();
        server.kill();
        await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
