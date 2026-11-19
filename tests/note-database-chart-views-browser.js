'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkChartViews({ page, open, mode, chartRequests, until, restart }) {
  const native = process.argv.includes('--webview2');
  let note = 'Charts.md';
  const blocks = () => page.locator('.note-database-carrier[data-database-id="charts"]:visible');
  const block = () => blocks().first();
  const role = (name, scope = block()) => scope.locator(`[data-db-role="${name}"]`);
  const panel = () => block().locator('.note-database-panel:visible');
  const text = (name, scope = panel()) => scope.getByRole('button', { name, exact: true });
  const chartCalls = () => chartRequests.filter(url => url.endsWith('/api/note-database/chart')).length;
  const marker = '```database charts\n```';

  async function api(endpoint, body) {
    const url = new URL('/api/note-database' + endpoint, page.url()).href;
    const response = body ? await page.request.post(url, { data: { path: note, databaseId: 'charts', ...body } })
      : await page.request.get(url, { params: { path: note, databaseId: 'charts' } });
    assert(response.ok(), await response.text());
    return response.json();
  }
  async function change(type, fields = {}) {
    const revision = type === 'create' ? undefined : (await api('')).revision;
    return api('/action', { action: { type, revision, ...fields } });
  }
  async function choose(field, value) {
    await panel().getByRole('combobox', { name: field, exact: true }).click();
    await panel().getByRole('option', { name: value, exact: true }).click();
  }
  async function rendered(series, values, horizontal = null) {
    await page.waitForFunction(({ series, values, horizontal }) => {
      const hosts = Array.from(document.querySelectorAll('.note-database-chart-stage:not([hidden]) .note-database-chart-canvas'));
      return hosts.filter(host => {
        const option = window.echarts?.getInstanceByDom(host)?.getOption(), item = option?.series[0];
        if (!host.querySelector('svg') || item?.type !== series) return false;
        if (horizontal !== null && (option.yAxis[0].type === 'category') !== horizontal) return false;
        if (!values) return true;
        return JSON.stringify(item.data.map(value => Array.isArray(value) ? value[1] : value?.value ?? value)) === JSON.stringify(values);
      }).length >= 2;
    }, { series, values, horizontal });
  }
  async function openNote() {
    assert(await open(note));
    await page.evaluate(() => { __databaseTest.editor.view.scrollDOM.scrollTop = 0; });
  }
  async function minimize(value) {
    if (native) {
      await page.evaluate(value => value ? pywebview.api.minimize() : pywebview.api.toggle_maximize(), value);
      await page.waitForFunction(value => document.documentElement.dataset.desktopMinimized === (value ? '1' : '0'), value);
      if (!value) await page.evaluate(() => pywebview.api.toggle_maximize());
    } else await page.evaluate(value => {
      document.documentElement.dataset.desktopMinimized = value ? '1' : '0';
      window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: value } }));
    }, value);
  }

  const table = await change('create', { language: 'en' });
  const title = table.columns[0].id;
  const date = (await change('addColumn', { columnType: 'date', name: 'Date' })).addedColumn;
  const amount = (await change('addColumn', { columnType: 'number', name: 'Amount' })).addedColumn;
  const done = (await change('addColumn', { columnType: 'checkbox', name: 'Done' })).addedColumn;
  const days = [17, 17, 18, 15, 16, 17];
  await change('batchCells', { changes: Array.from({ length: 66 }, (_, index) => ({ row: null, values: {
    [title]: (index < 60 ? 'Keep ' : 'Other ') + index, [date]: `2026-11-${days[index % 6]}`,
    [amount]: 2, [done]: Math.floor(index / 6) % 2 === 0,
  } })) });
  await openNote();
  await block().locator('table').waitFor();
  assert.equal(await role('data-mode').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(chartRequests, []);
  const sourceAndSelection = () => page.evaluate(() => {
    const state = __databaseTest.editor.view.state;
    return [state.doc.toString(), state.selection.main.anchor, state.selection.main.head];
  });
  await page.locator('[data-role="note-editor"] .cm-line').filter({ hasText: 'Before chart' }).click();
  const before = await sourceAndSelection();
  await role('chart-mode').click();
  assert.equal(await panel().getByRole('combobox', { name: 'Chart type' }).textContent(), 'Line chart');
  assert.equal(await panel().getByRole('combobox', { name: 'Group by' }).textContent(), 'Date');
  assert.equal(await panel().getByRole('combobox', { name: 'Measure' }).textContent(), 'Record count');
  await page.keyboard.press('Escape');
  await panel().waitFor({ state: 'hidden' });
  assert.equal((await api('')).chartView.mode, 'data');
  assert.deepEqual(chartRequests, []);

  await role('chart-mode').click();
  const actionPattern = '**/api/note-database/action';
  const fail = route => route.request().postDataJSON()?.action?.type === 'setChartView'
    ? route.fulfill({ status: 503, json: { error: 'Chart save interrupted' } }) : route.continue();
  await page.route(actionPattern, fail);
  await text('Confirm').click();
  await block().getByText('Chart save interrupted').waitFor();
  assert.equal(await panel().getByRole('combobox', { name: 'Chart type' }).textContent(), 'Line chart');
  assert.equal((await api('')).chartView.mode, 'data');
  await page.unroute(actionPattern, fail);
  await text('Confirm').click();
  await rendered('line', [11, 11, 33, 11]);
  assert.equal(chartCalls(), 1, 'same database projections share one aggregation');
  assert.deepEqual(await sourceAndSelection(), before, 'view switching preserves Markdown and caret');

  await role('search-toggle').click();
  await role('search').fill('Keep');
  await rendered('line', [10, 10, 30, 10]);
  await role('view').click();
  await role('filter', panel()).click();
  await choose('Filter column', 'Done');
  await text('Apply filter').click();
  await rendered('line', [5, 5, 15, 5]);

  for (const [type, series, values] of [['Horizontal bar chart', 'bar', [30]], ['Column chart', 'bar', [30]], ['Doughnut chart', 'pie', [60]]]) {
    await role('chart-settings').click();
    await choose('Chart type', type);
    await choose('Group by', 'Done');
    if (series === 'pie') await choose('Measure', 'Amount');
    await text('Confirm').click();
    await rendered(series, values, series === 'bar' ? type === 'Horizontal bar chart' : null);
  }
  const saved = { type: 'doughnut', groupBy: done, metric: { op: 'sum', column: amount } };
  assert.deepEqual((await api('')).chartView.chart, saved);

  const calls = chartCalls();
  await page.setViewportSize({ width: 810, height: 920 });
  await page.evaluate(() => { document.documentElement.dataset.startTheme = document.body.dataset.startTheme = 'dark'; });
  await page.waitForFunction(() => {
    const host = document.querySelector('.note-database-chart-canvas'), svg = host?.querySelector('svg');
    return svg && Number(svg.getAttribute('width')) === host.clientWidth
      && echarts.getInstanceByDom(host).getOption().textStyle.color === '#e5e7de';
  });
  assert.equal(chartCalls(), calls, 'resize and theme reuse the aggregation');
  assert(await block().evaluate(node => {
    const viewport = node.closest('.note-document-body').getBoundingClientRect();
    const items = node.querySelectorAll('.note-database-chart-stage, .note-database-tools button:not([hidden])');
    return Array.from(items).every(item => item.getBoundingClientRect().right <= viewport.right + 1);
  }), 'narrowing a rendered chart keeps its toolbar inside the document');
  if (process.env.RELATUM_ARTIFACT_DIR) {
    const folder = path.resolve(process.env.RELATUM_ARTIFACT_DIR);
    fs.mkdirSync(folder, { recursive: true });
    await block().screenshot({ path: path.join(folder, 'relatum-database-chart-view.png') });
    await page.screenshot({ path: path.join(folder, 'relatum-database-chart-workspace.png') });
  }
  await minimize(true);
  await page.locator('.note-database-chart-canvas svg').first().waitFor({ state: 'detached' });
  assert.equal(await page.locator('.note-database-chart-canvas svg').count(), 0);
  await minimize(false);
  await rendered('pie', [60]);
  const beforeScroll = chartCalls();
  await page.evaluate(() => { __databaseTest.editor.view.scrollDOM.scrollTop = 3000; });
  await page.locator('.note-database-chart-canvas svg').first().waitFor({ state: 'detached' });
  assert.equal(await page.locator('.note-database-chart-canvas svg').count(), 0);
  await page.evaluate(() => { __databaseTest.editor.view.scrollDOM.scrollTop = 0; });
  await rendered('pie', [60]);
  assert.equal(chartCalls(), beforeScroll, 'returning to the same chart revision reuses the offscreen data');

  await page.evaluate(() => { __databaseTest.editor.view.scrollDOM.scrollTop = 3000; });
  await page.locator('.note-database-chart-canvas svg').first().waitFor({ state: 'detached' });
  await change('renameDatabase', { name: 'Renamed database' });
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    __databaseTest.editor.view.scrollDOM.scrollTop = 0;
  });
  await rendered('pie', [60]);
  await block().getByText('Renamed database', { exact: true }).waitFor();
  assert.equal(chartCalls(), beforeScroll + 1, 'a changed database revision invalidates the offscreen data');

  const snapshotPattern = '**/api/note-database?*';
  const failSnapshot = route => route.fulfill({ status: 503, json: { error: 'Temporary snapshot failure' } });
  await page.route(snapshotPattern, failSnapshot);
  await role('search').fill('Temporary');
  await role('chart-retry').waitFor();
  await page.unroute(snapshotPattern, failSnapshot);
  await role('chart-retry').click();
  await block().getByText(/No chart data\./).waitFor();
  await role('search').fill('Keep');
  await rendered('pie', [60]);

  let intercepted = false, release;
  const pending = new Promise(resolve => { release = resolve; });
  const hold = async route => { intercepted = true; await pending; await route.continue().catch(() => {}); };
  await page.route('**/api/note-database/chart', hold);
  try {
    await role('search').fill('No chart data');
    await until(() => intercepted);
    await mode('source');
    assert.equal(await page.locator('.note-database-chart-canvas svg').count(), 0);
    assert.equal((await sourceAndSelection())[0].split(marker).length, 3);
  } finally { release(); await page.unroute('**/api/note-database/chart', hold); }
  await mode('live');
  await block().getByText(/No chart data\./).waitFor();

  page = await restart();
  await openNote();
  await rendered('pie', [60, 72]);
  assert.deepEqual((await api('')).chartView, { mode: 'chart', chart: saved, valid: true });
  await mode('reading');
  await rendered('pie', [60, 72]);
  assert.equal(await role('chart-settings').count(), 0, 'reading projects the saved chart without edit controls');
  await mode('live');
  await role('data-mode').click();
  await block().locator('table').waitFor();
  assert.equal(await page.locator('.note-database-chart-canvas svg').count(), 0);
  assert.deepEqual((await api('')).chartView, { mode: 'data', chart: saved, valid: true });

  const beforeRestart = chartRequests.length;
  page = await restart();
  await openNote();
  await block().locator('table').waitFor();
  assert.equal(await role('data-mode').getAttribute('aria-pressed'), 'true');
  assert.equal(chartRequests.length, beforeRestart, 'restored data mode makes zero requests for charts');
  await role('chart-mode').click();
  await rendered('pie', [60, 72]);
  assert.equal(await panel().count(), 0);
  await until(async () => {
    const response = await page.request.get(new URL('/api/note-index-state', page.url()).href);
    if ((await response.json()).phase !== 'ready') return false;
    const result = await page.evaluate(async () => {
      const { movePath, state } = __databaseTest;
      const ok = await movePath('Charts.md', 'Renamed.md', true);
      return { ok, code: state.lastMoveCode, error: state.lastMoveError };
    });
    if (!result.ok && result.code === 'statistics_incomplete') return false;
    assert(result.ok, result.error);
    return true;
  });
  note = 'Renamed.md';
  await rendered('pie', [60, 72]);
  assert.deepEqual((await api('')).chartView.chart, saved);
  await change('deleteColumn', { column: amount });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await block().getByText('A chart field is unavailable. Choose another field.').waitFor();
  assert.equal(await role('chart-mode').getAttribute('aria-pressed'), 'true');
  assert.equal(await role('chart-reconfigure').count(), 1);
}

module.exports = { checkChartViews };
