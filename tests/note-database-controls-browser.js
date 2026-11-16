'use strict';

// Drive the real database component in Chromium with a small in-memory HTTP fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');

const columns = [
  { id: 'name', name: '名称', type: 'text' }, { id: 'number', name: '数字', type: 'number' },
  { id: 'date', name: '日期', type: 'date' }, { id: 'check', name: '勾选', type: 'checkbox' },
  { id: 'file', name: '附件', type: 'attachment' },
];
const rows = Array.from({ length: 52 }, (_, index) => ({ id: `r${index}`, values: { name: `名称${index}`, number: index } }));
const note = { kind: 'note', path: 'folder/实验记录.md', name: '实验记录.md', exists: true };
const attachment = { kind: 'attachment', id: 'pdf', name: '实验记录.pdf', exists: true };
const calls = [];
let revision = 1, conflict = false, beforeSetCell = null;
const html = `<!doctype html><html lang="zh-CN" data-note-theme="apple"><meta charset="utf-8">
<link rel="stylesheet" href="/review-controls.css"><link rel="stylesheet" href="/note-database.css"><body class="start-page" data-start-theme="dark">
<style>body{background:#1c1c1e;color:#eee;--note-theme-paper:#1c1c1e;--note-theme-surface:#2c2c2e;
--note-theme-nav:#242426;--note-theme-link:#0a84ff;--note-theme-table-line:#535355}</style>
<main id="first"></main><main id="second"></main><script src="/review-controls.js"></script><script src="/note-database.js"></script>
<script>
window.opened = [];
window.layouts = 0;
window.database = RelatumNoteDatabase.create({language: () => 'zh', onOpenNote: path => window.opened.push(path)});
database.setActive('note.md');
database.mount(document.querySelector('#first'), {path: 'note.md'});
database.mount(document.querySelector('#second'), {path: 'note.md', onLayout: () => window.layouts++});
</script>`;

function list(query = {}) {
  let selected = rows.filter(row => (!query.search || row.values.name.includes(query.search))
    && (!query.filters?.length || query.filters.every(rule => rule.operator !== 'gt' || row.values[rule.column] > rule.value)));
  if (query.sort) {
    const { column, direction } = query.sort;
    selected.sort((a, b) => (a.values[column] - b.values[column]) * (direction === 'desc' ? -1 : 1));
  }
  const page = Math.min(query.page || 1, Math.max(1, Math.ceil(selected.length / 50)));
  return { exists: true, revision: String(revision), columns, rows: selected.slice((page - 1) * 50, page * 50), page, pageSize: 50, total: selected.length };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const json = (data, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  if (url.pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  if (['/note-database.js', '/note-database.css', '/review-controls.js', '/review-controls.css'].includes(url.pathname)) {
    const contentType = url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css';
    return res.writeHead(200, { 'Content-Type': contentType }).end(fs.readFileSync(path.join(__dirname, '..', 'assets', url.pathname)));
  }
  if (url.pathname === '/api/note-database') {
    const query = JSON.parse(url.searchParams.get('query'));
    calls.push({ query });
    return json(list(query));
  }
  if (!['/api/note-database/action', '/api/open-external'].includes(url.pathname)) return res.writeHead(404).end();
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  calls.push(body);
  if (url.pathname === '/api/open-external') return json({ error: 'missing' }, 404);
  const { action } = body;
  if (action.type === 'searchAttachments') return json({ items: [note, attachment].filter(item => item.name.includes(action.query)) });
  if (action.type === 'setCell') {
    const gate = beforeSetCell;
    beforeSetCell = null;
    if (gate) await gate();
    if (conflict) { conflict = false; revision++; }
    if (action.revision !== String(revision)) return json({ code: 'revision_conflict', error: 'changed' }, 409);
    const value = action.column === 'file' && action.value ? action.value.kind === 'note' ? note : attachment : action.value;
    rows.find(row => row.id === action.row).values[action.column] = value;
    revision++;
  }
  return json(list(body.query));
}

async function main() {
  const server = http.createServer((req, res) => handle(req, res).catch(error => { console.error(error); res.writeHead(500).end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
    const page = await browser.newPage({ viewport: { width: 410, height: 800 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    const first = page.locator('#first');
    const second = page.locator('#second');
    const data = (host, row = 0) => host.locator('.note-database-grid tbody tr').nth(row).locator('td');
    const cell = index => data(first).nth(index).locator('button');
    const field = first.locator('.note-database-cell-input');
    const getTitle = host => data(host).nth(0).innerText();
    const waitTitle = title => Promise.all([first, second].map(host => host.locator('.note-database-grid tbody tr').first().getByText(title, { exact: true }).waitFor()));
    await waitTitle('名称0');
    assert.equal(calls.filter(call => call.query && !call.action).length, 1, 'duplicate views share the initial page');
    assert(await first.locator('.note-database-overflow').evaluate(node => node.scrollWidth > node.clientWidth));
    await cell(0).click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const revealed = await cell(2).evaluate(node => {
      const right = node.closest('table').querySelector('thead .note-database-lane').getBoundingClientRect().left;
      return document.activeElement === node && node.getBoundingClientRect().right <= right + 1;
    });
    assert(revealed, 'keyboard navigation reveals the cell before the sticky add-field edge');
    assert.equal(await first.locator('.note-database-grid th').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(28, 28, 30)');
    assert.equal(await first.getByRole('searchbox').count(), 0, 'search stays collapsed on first render');
    const addColumn = first.locator('[data-db-role="add-column"]');
    assert((await addColumn.boundingBox()).x + (await addColumn.boundingBox()).width <= 410);
    await addColumn.click();
    await first.locator('[data-db-role="type-status"]').waitFor();
    assert.equal(await first.locator('.note-database-panel').evaluate(node => getComputedStyle(node).animationName), 'none');
    await page.keyboard.press('Escape');

    await first.getByRole('button', { name: '下一页' }).click();
    await waitTitle('名称50');
    assert.equal(await second.locator('.note-database-pagination span').textContent(), '2 / 2');
    const menu = () => first.getByRole('button', { name: '视图选项' }).click();
    async function choose(field, value) {
      await first.getByRole('combobox', { name: field, exact: true }).click();
      await first.getByRole('option', { name: value, exact: true }).click();
    }
    await menu();
    await choose('排序', '数字 ↑');
    await waitTitle('名称0');
    await menu();
    await choose('排序', '数字 ↓');
    await waitTitle('名称51');
    await menu();
    await first.locator('[data-db-role="filter"]').click();
    await choose('筛选列', '数字');
    await choose('筛选条件', '大于');
    await first.getByLabel('筛选值').fill('49');
    await first.getByRole('button', { name: '应用筛选' }).click();
    await page.waitForFunction(() => document.querySelector('#first tbody').rows.length === 2);
    assert.equal(await second.locator('tbody tr').count(), 2);
    assert(calls.some(call => call.query?.filters?.[0]?.value === 49));
    await menu();
    await first.getByRole('button', { name: '数字 · 49' }).click();
    await first.getByRole('button', { name: '移除条件' }).click();
    await menu();
    await choose('排序', '默认顺序');
    await waitTitle('名称0');

    // A conflict retains both the draft and the focus. Only explicit Enter retries.
    await cell(0).dblclick();
    await field.fill('保留的草稿');
    conflict = true;
    await field.press('Enter');
    await first.getByRole('status').getByText(/已保留当前输入/).waitFor();
    assert.equal(await field.inputValue(), '保留的草稿');
    assert.equal(await page.evaluate(() => database.dirty), true);
    assert.equal(await page.evaluate(() => database.whenInputSettled('note.md')), false);
    await field.press('Enter');
    await waitTitle('保留的草稿');
    assert.equal(await page.evaluate(() => database.dirty), false);

    const beforeEdit = await page.evaluate(() => window.layouts);
    await cell(1).dblclick();
    await field.fill('83.25');
    await field.press('Enter');
    await cell(1).getByText('83.25').waitFor();
    assert.equal(await page.evaluate(() => window.layouts), beforeEdit + 1, 'other visible view lays out once per cell commit');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await cell(0).click();
    await cell(0).press('Shift+ArrowRight');
    await page.keyboard.press('Control+C');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '保留的草稿\t83.25');
    await cell(2).dblclick();
    await field.fill('2026-11-16');
    await field.press('Enter');
    await cell(2).getByText('2026-11-16').waitFor();
    await cell(3).click();
    await first.getByRole('checkbox', { name: '勾选 · 已勾选', checked: true }).waitFor();
    assert.deepEqual(rows[0].values, { name: '保留的草稿', number: 83.25, date: '2026-11-16', check: true });

    await cell(4).dblclick();
    const picker = first.getByRole('combobox', { name: '附件' });
    // Chromium generates compositionstart, input, compositionend in the native path.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '实验', selectionStart: 2, selectionEnd: 2 });
    assert.equal(await page.evaluate(() => database.inputPending()), true);
    assert(!calls.some(call => call.action?.type === 'searchAttachments' && call.action.query === '实验'));
    await cdp.send('Input.insertText', { text: '实验' });
    await first.getByRole('option', { name: /实验记录\.md/ }).waitFor();
    await picker.press('ArrowDown');
    await picker.press('Enter');
    await cell(4).getByText('实验记录.md').waitFor();
    await cell(4).click({ modifiers: ['Control'] });
    await page.waitForFunction(() => opened.length === 1);
    assert.deepEqual(await page.evaluate(() => opened), [note.path]);
    note.exists = false;
    await cell(4).click({ modifiers: ['Control'] });
    await page.waitForFunction(() => !document.querySelector('#first tbody tr td:nth-child(5) button').classList.contains('is-link'));
    assert.equal(await page.evaluate(() => opened.length), 1, 'a deleted note never opens a cached tab');

    await cell(4).dblclick();
    await picker.fill('pdf');
    await first.getByRole('option', { name: /实验记录\.pdf/ }).click();
    await cell(4).getByText('实验记录.pdf').waitFor();
    attachment.exists = false;
    await cell(4).click({ modifiers: ['Control'] });
    await first.locator('tbody tr').first().getByText('实验记录.pdf').waitFor();
    await page.waitForFunction(() => !document.querySelector('#first tbody tr td:nth-child(5) button').classList.contains('is-link'));
    assert(calls.some(call => call.kind === 'note-database-attachment' && call.target === 'pdf'));

    // Clicking Search while committing a cell on blur must leave Search focused.
    await cell(0).dblclick();
    await page.evaluate(() => navigator.clipboard.writeText('失焦保存'));
    await field.press('Control+A');
    await field.press('Control+V');
    assert.equal(await field.inputValue(), '失焦保存');
    const search = first.getByRole('searchbox');
    await first.locator('[data-db-role="search-toggle"]').click();
    await waitTitle('失焦保存');
    assert.equal(await search.evaluate(node => node === document.activeElement), true);
    await search.fill('失焦');
    await page.waitForFunction(() => document.querySelector('#first tbody').rows.length === 1);
    assert.equal(await getTitle(second), '失焦保存');

    await cell(0).dblclick();
    await field.fill('筛选切换时保存');
    const layoutsBeforeSwitch = await page.evaluate(() => window.layouts);
    let releaseWrite, markWaiting;
    const waiting = new Promise(resolve => { markWaiting = resolve; });
    beforeSetCell = async () => {
      markWaiting();
      await new Promise(resolve => { releaseWrite = resolve; });
    };
    try {
      await search.click();
      await waiting;
      await search.fill('名称51');
    } finally { releaseWrite?.(); }
    await waitTitle('名称51');
    assert.equal(await page.evaluate(() => window.layouts), layoutsBeforeSwitch + 1,
      'a save result from the previous query never replaces the visible rows');
    assert.deepEqual(errors, []);
    console.log('Note database controls browser checks passed');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
