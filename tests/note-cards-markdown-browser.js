'use strict';
// Real standalone Markdown page, a fake native bridge, synthetic content only.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-cards-markdown-'));
const source = '# 文档\n\n```cards\n@style: outline\n##[book][!Purple]整理笔记\n@subtitle: 第三章\n@badge: 待复习\n@value: 3 个核心概念\n@footer: 来源：[资料](https://example.com)\n正文 **重点**\n```\n\nafter';
(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'), file = path.resolve(repo, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const origin = 'http://127.0.0.1:' + server.address().port;
    for (const language of ['zh-CN', 'en']) for (const dark of [false, true]) for (const width of [1100, 700]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      await context.addInitScript(({ source, language, dark }) => {
        localStorage.setItem('canvas:toolbarLanguage', language); localStorage.setItem('canvas:markdownDark:v1', dark ? '1' : '0');
        window.fixture = { saved: source, dirty: false };
        window.pywebview = { api: {
          async markdown_document(action, content) {
            if (action === 'save') fixture.saved = content;
            return { ok: true, changed: false, settings: { autoSave: false, outline: false }, document: { path: 'C:/fixture/Cards.md', name: 'Cards.md', revision: 'fixture', token: 'fixture', content: fixture.saved } };
          },
          async markdown_files() { return { ok: true, settings: { autoSave: false, outline: false }, recent: [], association: { supported: false } }; },
          async set_dirty(value) { fixture.dirty = value; }, async markdown_set_appearance() { return { ok: true }; },
          async markdown_open_link() { return { ok: true }; },
        } };
      }, { source, language, dark });
      const page = await context.newPage(), errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message)); page.on('request', req => requests.push(req.url()));
      await page.goto(origin + '/assets/markdown-file.html'); await page.waitForSelector('.note-cards-block .note-card');
      const geometry = await page.locator('.note-cards').evaluate(root => ({ group: root.clientWidth, card: root.querySelector('.note-card').getBoundingClientRect().width }));
      assert(Math.abs(geometry.group - geometry.card) < 1, 'standalone single cards fill the note width');
      assert(!requests.some(url => url.includes('note-cards-tools')), 'standalone tools stay cold until clicked');
      await page.locator('.note-card-title').click(); await page.locator('[data-note-cards-control]').click();
      const dialog = page.locator('dialog.note-cards-tools'); await dialog.waitFor();
      assert.deepEqual(await dialog.evaluate(node => [getComputedStyle(node).backgroundColor, getComputedStyle(node).color]), dark ? ['rgb(0, 0, 0)', 'rgb(255, 255, 255)'] : ['rgb(255, 255, 255)', 'rgb(0, 0, 0)']);
      await dialog.getByRole('combobox', { name: language === 'en' ? 'Style' : '样式', exact: true }).click();
      await dialog.getByRole('option', { name: language === 'en' ? 'Side stripe' : '侧边色条', exact: true }).click();
      await dialog.locator('[data-cards-field="target"]').evaluate(node => { node.value = '0'; node.dispatchEvent(new Event('change', { bubbles: true })); });
      await dialog.locator('[data-cards-field="value"]').fill('5 个核心概念');
      await page.screenshot({ path: path.join(output, 'tools-' + language + '-' + dark + '-' + width + '.png') });
      await dialog.getByRole('button', { name: language === 'en' ? 'Apply' : '应用', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.note-card').getAttribute('data-style'), 'stripe');
      await page.keyboard.press('Control+s'); await page.waitForFunction(() => fixture.saved === RelatumMarkdownWindow.editor.snapshot().value);
      assert((await page.evaluate(() => fixture.saved)).includes('@value: 5 个核心概念'));
      await page.keyboard.press('Control+z'); assert.equal(await page.evaluate(() => RelatumMarkdownWindow.editor.snapshot().value), source);
      await page.keyboard.press('Control+s'); await page.waitForFunction(() => fixture.saved === RelatumMarkdownWindow.editor.snapshot().value);
      await page.locator('.cm-line').filter({ hasText: /^after$/ }).click({ button: 'right' });
      await page.getByRole('button', { name: language === 'en' ? 'Insert Cards' : '插入 Cards', exact: true }).click();
      await page.waitForSelector('.note-live-cards-preview'); await page.keyboard.press('Escape');
      await page.keyboard.press('Control+z'); assert.equal(await page.evaluate(() => RelatumMarkdownWindow.editor.snapshot().value), source);
      assert.deepEqual(errors, []); assert(!requests.some(url => !url.startsWith(origin)), 'no external resources');
      await context.close();
    }
    console.log('note cards standalone Markdown: ok (8 cases); ' + output);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
