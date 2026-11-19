'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkChartColors({ page, open, chartRequests, until, restart }) {
  const native = process.argv.includes('--webview2');
  const chartCalls = () => chartRequests.filter(url => url.endsWith('/api/note-database/chart')).length;
  const block = () => page.locator('.note-database-carrier[data-database-id="charts"]:visible').first();
  const tool = role => block().locator(`[data-db-role="${role}"]`);
  const palettePanel = () => block().getByRole('dialog', { name: 'Chart colors', exact: true });
  const selectRole = (scope, name) => scope.getByRole('combobox', { name, exact: true });
  const noteSettings = () => page.locator('#note-settings-dialog');

  async function checkAppearance(predicate) {
    return until(async () => {
      const views = await page.evaluate(() => [...document.querySelectorAll('.note-database-chart-canvas')].flatMap(node => {
        const chart = window.echarts?.getInstanceByDom(node), option = chart?.getOption();
        if (!option || !node.querySelector('svg')) return [];
        return [{ type: option.series[0].type, total: option.title?.[0]?.text || null,
          legend: option.legend?.[0]?.formatter && option.series[0].data.map(point => option.legend[0].formatter(point.name)),
          colors: Object.fromEntries(option.series[0].data.filter(point => point?.itemStyle).map(point => [point.name, point.itemStyle.color])),
          firstColor: option.color[0], text: node.querySelector('svg').textContent }];
      }));
      return views.length === 2 && predicate(views) && views;
    });
  }
  async function choose(scope, field, value) {
    await selectRole(scope, field).click();
    await scope.getByRole('option', { name: value, exact: true }).click();
  }
  async function globalPalette(name) {
    await page.evaluate(() => __databaseTest.setNoteSettingsOpen(true, { category: 'appearance' }));
    await choose(noteSettings(), 'Chart colors', name);
    assert.equal(await noteSettings().locator('[data-role="note-chart-palette-preview"] i').count(), 16);
    await page.keyboard.press('Escape');
    await noteSettings().waitFor({ state: 'hidden' });
  }
  async function api(action) {
    const url = new URL('/api/note-database' + (action ? '/action' : ''), page.url()).href;
    const context = { path: 'Charts.md', databaseId: 'charts' };
    const response = action ? await page.request.post(url, { data: { ...context, action } })
      : await page.request.get(url, { params: context });
    assert(response.ok(), await response.text());
    return response.json();
  }
  async function change(type, options) {
    return api({ type, revision: type === 'create' ? undefined : (await api()).revision, ...options });
  }
  async function openChart() {
    assert(await open('Charts.md'));
    await page.evaluate(() => { __databaseTest.editor.view.scrollDOM.scrollTop = 0; });
  }
  async function confirm() {
    await tool('chart-color-confirm').click();
    await palettePanel().waitFor({ state: 'hidden' });
  }

  assert(await open('Main.md'));
  assert.equal(await page.evaluate(() => RelatumNoteChartPalette.read()), 'fresh');
  await globalPalette('High contrast');
  assert.deepEqual(chartRequests, [], 'color settings do not load the engine or query chart data');
  const category = (await change('create', { language: 'en' })).columns[0].id;
  const amount = (await change('addColumn', { name: 'Amount', columnType: 'number' })).addedColumn;
  await change('batchCells', { changes: [['A', 12], ['B', 20], ['A', 23]].map(([label, value]) => (
    { row: null, values: { [category]: label, [amount]: value } })) });
  const chart = { type: 'doughnut', groupBy: category, metric: { op: 'sum', column: amount } };
  const initial = await change('setChartView', { mode: 'chart', chart });
  const lookup = '**/api/note-database/chart';
  let finishAggregate;
  const holdAggregate = route => new Promise(resolve => {
    finishAggregate = async () => { await route.continue(); resolve(); };
  });
  await page.route(lookup, holdAggregate, { times: 1 });
  await openChart();
  await until(() => finishAggregate);
  try {
    await tool('chart-palette').click();
    await palettePanel().waitFor();
    assert.equal(await tool('chart-color-category').count(), 0);
  } finally {
    await finishAggregate();
  }
  await palettePanel().getByRole('button', { name: 'B', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await palettePanel().waitFor({ state: 'hidden' });
  const original = (await checkAppearance(views => views.every(view => view.total === '55' && view.firstColor === '#0059a8')))[0];
  assert.deepEqual(original.legend, ['A 63.6%', 'B 36.4%']);
  assert.match(original.text, /A 63\.6%/);
  assert.match(original.text, /B 36\.4%/);
  assert.notEqual(original.colors.A, original.colors.B);
  await block().locator('.note-database-chart-canvas').evaluate(host => {
    echarts.getInstanceByDom(host).dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 0 });
  });
  await block().getByText('A · Amount · Sum 35 · 63.6%', { exact: true }).waitFor();
  await tool('search-toggle').click();
  await tool('search').fill('B');
  const filtered = (await checkAppearance(views => views.every(view => view.total === '20')))[0];
  assert.equal(filtered.colors.B, original.colors.B);
  assert.deepEqual(filtered.legend, ['B 100%']);
  await tool('search').fill('');
  await checkAppearance(views => views.every(view => view.total === '55'));
  await tool('search-toggle').click();

  const beforeColors = chartCalls();
  const canvas = block().locator('.note-database-chart-canvas');
  await canvas.evaluate(host => {
    const chart = echarts.getInstanceByDom(host), render = chart.setOption;
    host.dataset.renderCalls = '0';
    chart.setOption = function (...args) {
      host.dataset.renderCalls = String(Number(host.dataset.renderCalls) + 1);
      return render.apply(this, args);
    };
  });
  await tool('chart-palette').click();
  await palettePanel().getByRole('button', { name: 'B', exact: true }).click();
  await tool('chart-color-auto').click();
  await confirm();
  assert.equal(await canvas.getAttribute('data-render-calls'), '0', 'confirming automatic colors again skips redraw');
  await globalPalette('Earth');
  await checkAppearance(views => views.every(view => view.firstColor === '#476e62'));
  await globalPalette('High contrast');
  await checkAppearance(views => views.every(view => view.firstColor === '#0059a8'));
  await tool('chart-palette').click();
  await choose(palettePanel(), 'Color preset', 'Fresh');
  await palettePanel().getByRole('button', { name: 'B', exact: true }).click();
  await palettePanel().getByRole('button', { name: 'Iris', exact: true }).click();
  await checkAppearance(([first, second]) => first.colors.B === '#8661b1' && second.colors.B === original.colors.B);
  await page.keyboard.press('Escape');
  await checkAppearance(views => views.every(view => view.colors.B === original.colors.B));
  assert.deepEqual((await api()).chartView.style, {});

  await tool('chart-palette').click();
  await choose(palettePanel(), 'Color preset', 'Earth');
  await palettePanel().getByRole('button', { name: 'B', exact: true }).click();
  await palettePanel().getByRole('button', { name: 'Coral', exact: true }).click();
  const routePattern = '**/api/note-database/action';
  const fail = route => route.request().postDataJSON()?.action?.type === 'setChartAppearance'
    ? route.fulfill({ status: 503, json: { error: 'Color save interrupted' } }) : route.continue();
  await page.route(routePattern, fail);
  await tool('chart-color-confirm').click();
  await palettePanel().getByText('Color save interrupted').waitFor();
  assert.deepEqual((await api()).chartView.style, {});
  await page.unroute(routePattern, fail);
  await confirm();
  await checkAppearance(views => views.every(view => view.colors.B === '#be624d' && view.firstColor === '#476e62'));
  const saved = await api();
  assert.equal(saved.revision, initial.revision);
  assert.equal(saved.chartView.style.palette, 'earth');
  assert.deepEqual(Object.values(saved.chartView.style.categories), ['coral']);
  assert.equal(chartCalls(), beforeColors, 'palette, preview, cancel and confirm reuse aggregate data');

  await page.setViewportSize({ width: 805, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.startTheme = document.body.dataset.startTheme = 'dark'; });
  await checkAppearance(views => views.every(view => view.colors.B === '#f29983' && view.firstColor === '#8abcaa'));
  await tool('chart-palette').click();
  const box = await palettePanel().boundingBox();
  const viewport = await page.evaluate(() => [innerWidth, innerHeight]);
  assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport[0] && box.y + box.height <= viewport[1]);
  if (process.env.RELATUM_ARTIFACT_DIR) {
    const folder = path.resolve(process.env.RELATUM_ARTIFACT_DIR);
    fs.mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: path.join(folder, 'note-chart-colors.png') });
  }
  await page.keyboard.press('Escape');

  page = await restart();
  if (native) assert.equal(await page.evaluate(() => RelatumNoteChartPalette.read()), 'contrast');
  assert.deepEqual((await api()).chartView.style, saved.chartView.style);
  await openChart();
  await checkAppearance(views => views.every(view => view.total === '55' && view.colors.B === '#be624d'));

  await tool('chart-palette').click();
  await palettePanel().getByRole('button', { name: 'B', exact: true }).click();
  await tool('chart-color-auto').click();
  await confirm();
  assert.deepEqual((await api()).chartView.style, { palette: 'earth' });
  await tool('chart-palette').click();
  await tool('chart-color-reset').click();
  await confirm();
  assert.deepEqual((await api()).chartView.style, {});

  await change('setChartView', { mode: 'chart', chart: { ...chart, metric: { op: 'avg', column: amount } } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await checkAppearance(views => views.every(view => view.total === null && view.legend.join(',') === 'A,B'));
  await change('setChartView', { mode: 'chart', chart: { ...chart, type: 'column' } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await checkAppearance(views => views.every(view => view.type === 'bar'));
  const beforeMain = chartCalls();
  await tool('chart-palette').click();
  await palettePanel().getByRole('button', { name: 'Mint', exact: true }).click();
  await confirm();
  await checkAppearance(views => views.every(view => view.firstColor === '#348a73'));
  assert.equal(chartCalls(), beforeMain, 'changing the main color reuses the bar aggregation');
}

module.exports = { checkChartColors };
