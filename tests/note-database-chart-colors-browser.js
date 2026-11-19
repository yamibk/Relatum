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
  const colorButton = name => palettePanel().getByRole('button', { name, exact: true });

  async function checkAppearance(predicate) {
    return until(async () => {
      const views = await page.evaluate(() => [...document.querySelectorAll('.note-database-chart-canvas')].flatMap(node => {
        const chart = window.echarts?.getInstanceByDom(node), option = chart?.getOption();
        if (!option || !node.querySelector('svg')) return [];
        const { type, data } = option.series[0];
        const horizontal = option.yAxis?.[0]?.type === 'category';
        const labels = (horizontal ? option.yAxis : option.xAxis)?.[0]?.data;
        const colors = type === 'bar' ? Object.fromEntries(labels.map((label, i) => [label, data[i]?.itemStyle?.color || option.color[0]]))
          : Object.fromEntries(data.filter(point => point?.itemStyle).map(point => [point.name, point.itemStyle.color]));
        return [{ type, horizontal, total: option.title?.[0]?.text || null,
          legend: option.legend?.[0]?.formatter && data.map(point => option.legend[0].formatter(point.name)), colors,
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
    assert.equal(await noteSettings().locator('[data-role="note-chart-palette-preview"] i').count(), name === 'Deep' ? 16 : 24);
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
  assert.equal(await page.evaluate(() => RelatumNoteChartPalette.read()), 'soft');
  assert.deepEqual(await page.evaluate(() => RelatumNoteChartPalette.presets.map(([id]) => id)), ['vivid', 'soft', 'deep', 'contrast']);
  assert.deepEqual(await page.evaluate(() => ['fresh', 'earth'].map(RelatumNoteChartPalette.effective)), ['soft', 'deep']);
  await globalPalette('Vivid');
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
  const original = (await checkAppearance(views => views.every(view => view.total === '55' && view.firstColor === '#0056a6')))[0];
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
  await globalPalette('Deep');
  await checkAppearance(views => views.every(view => view.firstColor === '#397ab9'));
  await globalPalette('High contrast');
  await checkAppearance(views => views.every(view => view.firstColor === '#0056a6'));
  await tool('chart-palette').click();
  await choose(palettePanel(), 'Color preset', 'Soft');
  await palettePanel().getByRole('button', { name: 'B', exact: true }).click();
  await colorButton('Deep').click();
  await colorButton('Iris').click();
  await checkAppearance(([first, second]) => first.colors.B === '#8661b1' && second.colors.B === original.colors.B);
  await page.keyboard.press('Escape');
  await checkAppearance(views => views.every(view => view.colors.B === original.colors.B));
  assert.deepEqual((await api()).chartView.style, {});

  await tool('chart-palette').click();
  await choose(palettePanel(), 'Color preset', 'Deep');
  await palettePanel().getByRole('button', { name: 'B', exact: true }).click();
  await colorButton('Deep').click();
  await colorButton('Coral').click();
  const routePattern = '**/api/note-database/action';
  const fail = route => route.request().postDataJSON()?.action?.type === 'setChartAppearance'
    ? route.fulfill({ status: 503, json: { error: 'Color save interrupted' } }) : route.continue();
  await page.route(routePattern, fail);
  await tool('chart-color-confirm').click();
  await palettePanel().getByText('Color save interrupted').waitFor();
  assert.deepEqual((await api()).chartView.style, {});
  await page.unroute(routePattern, fail);
  await confirm();
  await checkAppearance(views => views.every(view => view.colors.B === '#be624d' && view.firstColor === '#397ab9'));
  const saved = await api();
  assert.equal(saved.revision, initial.revision);
  assert.equal(saved.chartView.style.palette, 'deep');
  assert.deepEqual(Object.values(saved.chartView.style.categories), ['coral']);
  assert.equal(chartCalls(), beforeColors, 'palette, preview, cancel and confirm reuse aggregate data');

  await page.setViewportSize({ width: 805, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.startTheme = document.body.dataset.startTheme = 'dark'; });
  await checkAppearance(views => views.every(view => view.colors.B === '#f29983' && view.firstColor === '#84b8ec'));
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
  assert.deepEqual((await api()).chartView.style, { palette: 'deep' });
  await tool('chart-palette').click();
  await tool('chart-color-reset').click();
  await confirm();
  assert.deepEqual((await api()).chartView.style, {});

  await change('setChartView', { mode: 'chart', chart: { ...chart, metric: { op: 'avg', column: amount } } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await checkAppearance(views => views.every(view => view.total === null && view.legend.join(',') === 'A,B'));
  const trip = [['交通', 170], ['住宿', 200], ['门票', 100], ['餐饮', 130]];
  const existing = (await api()).rows;
  await change('batchCells', { changes: trip.map(([name, value], i) => (
    { row: existing[i]?.id || null, values: { [category]: name, [amount]: value } })) });
  const column = { ...chart, type: 'column' };
  await change('setChartView', { mode: 'chart', chart: column });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await globalPalette('Soft');
  const primary = '#699ad1', sky = '#82b5dd';
  const uniformly = view => Object.values(view.colors).every(color => color === view.firstColor);
  await checkAppearance(views => views.every(view => view.type === 'bar' && !view.horizontal
    && Object.keys(view.colors).length === 4 && view.firstColor === primary && uniformly(view)));
  const beforeMain = chartCalls();
  await tool('chart-palette').click();
  const swatches = () => palettePanel().locator('[data-db-role="chart-color-swatch"]:visible');
  assert.equal(await swatches().count(), 12);
  await colorButton('Medium').click();
  assert.equal(await swatches().count(), 12);
  await colorButton('Deep').click();
  assert.equal(await swatches().count(), 12);
  await colorButton('Mint').click();
  await confirm();
  await checkAppearance(views => views.every(view => view.firstColor === '#348a73' && uniformly(view)));

  async function pickTransport() {
    await tool('chart-palette').click();
    await selectRole(palettePanel(), 'Color target').click();
    await palettePanel().locator('.review-choice-search').fill('交通');
    await palettePanel().getByRole('option', { name: '交通', exact: true }).click();
  }
  const hasOverride = view => view.colors['交通'] === sky && Object.entries(view.colors)
    .every(([name, color]) => name === '交通' || color === view.firstColor);
  await pickTransport();
  await colorButton('Light Sky blue').click();
  await checkAppearance(([first, second]) => hasOverride(first) && uniformly(second));
  await page.keyboard.press('Escape');
  await checkAppearance(views => views.every(uniformly));
  await pickTransport();
  await colorButton('Light Sky blue').click();
  await confirm();
  await checkAppearance(views => views.every(hasOverride));
  assert.equal(chartCalls(), beforeMain, 'changing the main or category color reuses the bar aggregation');
  await page.evaluate(() => { document.documentElement.dataset.startTheme = document.body.dataset.startTheme = 'dark'; });
  await checkAppearance(views => views.every(view => view.colors['交通'] === '#95d3f6' && view.firstColor === '#78cfb2'));
  await page.evaluate(() => { document.documentElement.dataset.startTheme = document.body.dataset.startTheme = 'light'; });
  await checkAppearance(views => views.every(hasOverride));
  assert.equal(chartCalls(), beforeMain, 'the two theme variants reuse the bar aggregation');

  await tool('search-toggle').click();
  await tool('search').fill('交通');
  await checkAppearance(views => views.every(view => Object.keys(view.colors).length === 1 && hasOverride(view)));
  await tool('search').fill('');
  await checkAppearance(views => views.every(view => Object.keys(view.colors).length === 4 && hasOverride(view)));
  await tool('search-toggle').click();
  await change('setChartView', { mode: 'chart', chart: { ...column, type: 'bar' } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await checkAppearance(views => views.every(view => view.horizontal && hasOverride(view)));
  page = await restart();
  await openChart();
  await checkAppearance(views => views.every(view => view.horizontal && hasOverride(view)));
  await pickTransport();
  if (process.env.RELATUM_ARTIFACT_DIR) {
    const folder = path.resolve(process.env.RELATUM_ARTIFACT_DIR);
    await page.screenshot({ path: path.join(folder, 'note-chart-bar-colors.png') });
  }
  await tool('chart-color-auto').click();
  await confirm();
  await checkAppearance(views => views.every(uniformly));

  await change('batchCells', { changes: Array.from({ length: 200 }, (_, i) => (
    { row: null, values: { [category]: `测试 ${i + 1}`, [amount]: 1 } })) });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await checkAppearance(views => views.every(view => Object.keys(view.colors).length === 204));
  await tool('chart-palette').click();
  await selectRole(palettePanel(), 'Color target').click();
  await palettePanel().locator('.review-choice-search').fill('测试 200');
  await palettePanel().getByRole('option', { name: '测试 200', exact: true }).click();
  await colorButton('Light Leaf green').click();
  await confirm();
  assert.deepEqual(Object.values((await api()).chartView.style.categories), ['leaf-light']);

  const date = (await change('addColumn', { name: 'Date', columnType: 'date' })).addedColumn;
  const dated = (await api()).rows.slice(0, 2);
  await change('batchCells', { changes: dated.map((row, index) => (
    { row: row.id, values: { [date]: `2026-11-${15 + index}` } })) });
  await change('setChartView', { mode: 'chart', chart: { type: 'line', groupBy: date } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await checkAppearance(views => views.every(view => view.type === 'line' && view.firstColor === '#348a73'));
  const beforeLine = chartCalls();
  await tool('chart-palette').click();
  await colorButton('Medium').click();
  await colorButton('Medium Apricot').click();
  await confirm();
  await checkAppearance(views => views.every(view => view.type === 'line' && view.firstColor === '#db996d'));
  assert.equal(chartCalls(), beforeLine, 'the line main color reuses its aggregation');
}

module.exports = { checkChartColors };
