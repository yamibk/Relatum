'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkCharts({ page, open, blocks, chartRequests }) {
  const origin = new URL(page.url()).origin;
  const fixture = { path: 'Charts.md', databaseId: 'charts' };
  const longLabel = '<b>成本 & 合计</b> ' + '较长的中文分类 '.repeat(12);
  const foreignRequests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) foreignRequests.push(url.href);
  });
  async function post(endpoint, body) {
    const response = await page.request.post(origin + '/api/note-database/' + endpoint, { data: { ...fixture, ...body } });
    assert(response.ok(), await response.text());
    return response.json();
  }

  let table = await post('action', { action: { type: 'create' } });
  async function change(type, fields) {
    table = await post('action', { action: { type, revision: table.revision, ...fields } });
    return table;
  }
  const category = table.columns[0].id;
  const date = (await change('addColumn', { columnType: 'date', name: '日期' })).addedColumn;
  const number = (await change('addColumn', { columnType: 'number', name: 'Amount' })).addedColumn;
  const check = (await change('addColumn', { columnType: 'checkbox', name: 'Status' })).addedColumn;
  const days = [17, 17, 18, 15, 16, 17];
  await change('batchCells', { changes: days.map((day, index) => ({ row: null, values: {
    [category]: index === 0 ? longLabel : 'Study', [date]: `2026-11-${day}`,
    [number]: index - 2, [check]: index < 2,
  } })) });
  assert(await open('Charts.md'));
  await blocks.first().locator('table').waitFor();
  assert.deepEqual(chartRequests, [], 'ordinary notes and table blocks load no chart resources');

  const line = await post('chart', {});
  assert.deepEqual(line.groups.map(({ value }) => value), [1, 1, 3, 1]);
  const metric = { op: 'sum', column: number };
  const [column, bar, doughnut] = await Promise.all([
    post('chart', { chart: { type: 'column', groupBy: category, metric } }),
    post('chart', { chart: { type: 'bar', groupBy: category, metric } }),
    post('chart', { chart: { type: 'doughnut', groupBy: check } }),
  ]);

  const enginePattern = '**/vendor/echarts/echarts.min.js';
  await page.route(enginePattern, route => route.abort());
  const failed = await page.evaluate(async model => {
    const { mount } = await import('/note-database-chart.js');
    const wrapper = document.createElement('section');
    wrapper.id = 'chart-qa';
    wrapper.style.cssText = 'position:fixed;inset:0;z-index:12000;background:#fafaf7;overflow:auto;padding:24px';
    document.body.append(wrapper);
    window.chartQa = {
      mount, wrapper,
      host() {
        const host = document.createElement('div');
        host.style.cssText = 'width:560px;height:250px;margin:8px auto';
        wrapper.append(host);
        return host;
      },
    };
    const host = chartQa.host();
    const controller = mount(host, model);
    try { await controller.ready; } catch (error) { return [error.message, host.children.length]; }
    finally { controller.dispose(); host.remove(); }
    return [];
  }, line);
  assert.deepEqual(failed, ['Unable to load the offline chart engine', 0]);
  await page.unroute(enginePattern);

  const initial = await page.evaluate(async ({ line, column, bar, doughnut }) => {
    const { mount, host } = chartQa;
    const unused = host();
    const canceled = mount(unused, line);
    canceled.dispose();
    const lineHost = host(), columnHost = host(), barHost = host(), ringHost = host();
    const lineView = mount(lineHost, line, { language: 'zh' });
    const columnView = mount(columnHost, column, { language: 'en' });
    const barView = mount(barHost, bar, { language: 'en', dark: true });
    barHost.style.backgroundColor = '#222722';
    const ringView = mount(ringHost, doughnut, { language: 'en', dark: true });
    ringHost.style.backgroundColor = '#222722';
    const rendered = await Promise.all([canceled.ready, lineView.ready, columnView.ready, barView.ready, ringView.ready]);
    unused.remove();
    chartQa.renders = [lineView, columnView, barView, ringView];
    chartQa.hosts = [lineHost, columnHost, barHost, ringHost];
    const options = chartQa.hosts.map(node => echarts.getInstanceByDom(node).getOption());
    return {
      rendered, unused: unused.childElementCount,
      vector: chartQa.hosts.map(node => !!node.querySelector('svg path')),
      series: options.map(option => option.series[0].type),
      points: options[0].series[0].data.map(([date, value]) => [new Date(date).toISOString().slice(0, 10), value]),
      orientation: [options[1].xAxis[0].type, options[2].yAxis[0].type],
      labels: [lineHost, columnHost, ringHost].map(node => node.getAttribute('aria-label')),
      categoryLabels: [columnHost, barHost].map(node => Array.from(node.querySelectorAll('svg text'), item => item.textContent)),
      ring: options[3].series[0].data.map(({ name, value }) => [name, value]),
      color: [options[1].textStyle.color, options[2].textStyle.color],
    };
  }, { line, column, bar, doughnut });
  assert.deepEqual(initial.rendered, [false, true, true, true, true]);
  assert.equal(initial.unused, 0);
  assert.deepEqual(initial.vector, [true, true, true, true]);
  assert.deepEqual(initial.series, ['line', 'bar', 'bar', 'pie']);
  assert.deepEqual(initial.points, line.groups.map(({ key, value }) => [key, value]));
  assert.deepEqual(initial.orientation, ['category', 'category']);
  assert.deepEqual(initial.labels, ['折线图 · 日期 · 记录数', 'Column chart · 名称 · Amount · Sum',
    'Doughnut chart · Status · Record count']);
  assert.deepEqual(initial.ring, [['Unchecked', 4], ['Checked', 2]]);
  assert(initial.categoryLabels.every(labels => labels.includes('Study') && labels.some(label => /(?:…|\.\.\.)$/.test(label))),
    JSON.stringify(initial.categoryLabels));
  assert.notEqual(...initial.color);
  assert.equal(chartRequests.filter(url => url.endsWith('/echarts.min.js')).length, 2,
    'one failed request and one successful shared retry');

  if (process.env.RELATUM_ARTIFACT_DIR) {
    const folder = path.resolve(process.env.RELATUM_ARTIFACT_DIR);
    fs.mkdirSync(folder, { recursive: true });
    for (let index = 0; index < 4; index++) {
      await page.locator('#chart-qa > div').nth(index).screenshot({ path: path.join(folder, `note-chart-${index}.png`) });
    }
  }
  const tooltip = await page.evaluate(async label => {
    const host = chartQa.hosts[1];
    const chart = echarts.getInstanceByDom(host);
    chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 0 });
    const node = Array.from(host.querySelectorAll('div')).find(node => node.textContent.startsWith(label + ' · Amount'));
    const result = [node?.textContent, host.querySelector('b') === null];
    chart.dispatchAction({ type: 'hideTip' });
    return result;
  }, longLabel);
  assert.deepEqual(tooltip, [`${longLabel} · Amount · Sum -2`, true]);

  const alternate = await page.evaluate(async models => {
    await Promise.all(chartQa.renders.map((controller, index) => controller.update(models[index], {
      language: index === 0 ? 'en' : 'zh', dark: index < 2,
    })));
    return chartQa.hosts.map(node => [node.getAttribute('aria-label'), echarts.getInstanceByDom(node).getOption().textStyle.color]);
  }, [line, column, bar, doughnut]);
  assert.deepEqual(alternate, [
    ['Line chart · 日期 · Record count', initial.color[1]],
    ['柱状图 · 名称 · Amount · 合计', initial.color[1]],
    ['条形图 · 名称 · Amount · 合计', initial.color[0]],
    ['环形图 · Status · 记录数', initial.color[0]],
  ]);

  const lifecycle = await page.evaluate(async ({ line, column }) => {
    const [controller] = chartQa.renders;
    const [host] = chartQa.hosts;
    host.style.width = '300px';
    await controller.resize();
    const width = host.querySelector('svg').getAttribute('width');
    host.style.display = 'none';
    const hidden = await controller.update(column, { language: 'en', dark: true });
    host.style.display = '';
    await controller.resize();
    const type = echarts.getInstanceByDom(host).getOption().series[0].type;
    const empty = await controller.update({ ...line, groups: [] });
    const clear = !echarts.getInstanceByDom(host) && !host.querySelector('svg');
    for (const view of chartQa.renders) { view.dispose(); view.dispose(); }
    const disposed = chartQa.hosts.every(node => !echarts.getInstanceByDom(node) && !node.childElementCount);
    chartQa.wrapper.remove();
    return { width, hidden, type, empty, clear, disposed };
  }, { line, column });
  assert.deepEqual(lifecycle, { width: '300', hidden: false, type: 'bar', empty: false, clear: true, disposed: true });
  assert.deepEqual(foreignRequests, []);
}

module.exports = { checkCharts };
