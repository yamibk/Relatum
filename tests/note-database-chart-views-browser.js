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
  await role('chart-menu').click();
  assert.equal(await panel().getByRole('button').count(), 1, 'a table without charts only offers creation');
  await role('new-chart', panel()).waitFor();
  await page.keyboard.press('Escape');
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
  const fail = route => route.request().postDataJSON()?.action?.type === 'setChartCard'
    ? route.fulfill({ status: 503, json: { error: 'Chart save interrupted' } }) : route.continue();
  await page.route(actionPattern, fail);
  await text('Confirm').click();
  await panel().getByText('Chart save interrupted').waitFor();
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
    await role('chart-card-menu').click();
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
  assert.deepEqual((await api('')).chartView, { mode: 'chart', chart: saved, valid: true, style: {}, styleRevision: null });
  await mode('reading');
  await rendered('pie', [60, 72]);
  assert.equal(await role('chart-settings').count(), 0, 'reading projects the saved chart without edit controls');
  await mode('live');
  await role('data-mode').click();
  await block().locator('table').waitFor();
  assert.equal(await page.locator('.note-database-chart-canvas svg').count(), 0);
  assert.deepEqual((await api('')).chartView, { mode: 'data', chart: saved, valid: true, style: {}, styleRevision: null });

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
  const card = name => block().getByRole('region', { name, exact: true });
  const ringName = '类别分布';
  const defaultTitle = role('rename-chart', card('Doughnut chart'));
  const nameInput = () => panel().getByRole('textbox', { name: 'Chart name', exact: true });
  const beforeRename = await api('');
  await defaultTitle.click();
  assert.equal(await panel().count(), 0);
  await defaultTitle.dblclick();
  assert.equal(await nameInput().inputValue(), 'Doughnut chart');
  await nameInput().press('Enter');
  await panel().waitFor({ state: 'hidden' });
  assert.equal((await api('')).revision, beforeRename.revision);
  await defaultTitle.dblclick();
  await nameInput().fill(' ');
  await nameInput().press('Enter');
  assert(await nameInput().isVisible());
  await page.keyboard.press('Escape');
  await panel().waitFor({ state: 'hidden' });
  assert.equal((await api('')).revision, beforeRename.revision);
  await defaultTitle.dblclick();
  await nameInput().fill(ringName);
  await nameInput().dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
  assert(await nameInput().isVisible());
  assert.equal((await api('')).revision, beforeRename.revision);
  await nameInput().press('Enter');
  await panel().waitFor({ state: 'hidden' });
  assert.equal(await block().locator('[data-db-role="rename-chart"]').first().textContent(), ringName);
  await blocks().nth(1).getByText(ringName, { exact: true }).waitFor();
  assert.equal((await api('')).chartCards[0].valid, false, 'renaming a chart works when its fields need repair');

  const createChart = async (name, type) => {
    await role('chart-menu').click();
    await role('new-chart', panel()).click();
    await role('chart-name', panel()).fill(name);
    await choose('Chart type', type);
  };
  await createChart('Weekly status', 'Column chart');
  await choose('Group by', 'Date');
  await choose('Date interval', 'Week');
  await panel().getByText('Series options', { exact: true }).click();
  await choose('Split series by', 'Done');
  await choose('Bar layout', 'Stacked');
  await text('Confirm').click();
  const weekly = card('Weekly status');
  await weekly.locator('.note-database-chart-canvas svg').waitFor();
  assert.deepEqual(await weekly.locator('.note-database-chart-canvas').evaluate(node =>
    echarts.getInstanceByDom(node).getOption().series.map(item => [item.type, item.stack])), [['bar', 'categories'], ['bar', 'categories']]);
  await createChart('Completed share', 'Number card');
  await choose('Measure', 'Done · Checked rate');
  await text('Confirm').click();
  const number = card('Completed share');
  const numberGraphic = number.locator('.note-database-chart-canvas svg');
  await numberGraphic.waitFor();
  assert.match(await numberGraphic.textContent(), /54\.5%/);
  await role('chart-card-menu', number).click();
  await role('chart-filters', panel()).click();
  await role('chart-filter-search', panel()).fill('Other');
  await role('chart-filter-save', panel()).click();
  await numberGraphic.getByText('100.0%', { exact: true }).waitFor();
  assert.equal((await api('')).chartCards.find(card => card.name === 'Weekly status').query.search, undefined);

  const arrangement = (name, role) => panel().getByRole(role, { name, exact: true });
  const show = name => arrangement('Show ' + name, 'checkbox');
  const saveOrder = () => role('save-chart-order', panel());
  const names = () => block().locator('.note-database-chart-card').evaluateAll(cards => cards.map(card => card.getAttribute('aria-label')));
  async function geometry(sideBySide, count = 2) {
    await page.waitForFunction(({ sideBySide, count }) => {
      const area = [...document.querySelectorAll('.note-database-chart-area')].find(node => node.clientWidth > 0);
      const cards = [...area?.querySelectorAll('.note-database-chart-card') || []].map(card => card.getBoundingClientRect());
      if (cards.length !== count) return false;
      if (sideBySide) return Math.abs(cards[0].y - cards[1].y) < 1 && cards[0].right < cards[1].left
        && Math.abs(cards[0].width - cards[1].width) < 1;
      const width = area.getBoundingClientRect().width;
      return cards.every((card, index) => Math.abs(card.width - width) < 1 && (!index || cards[index - 1].bottom < card.top));
    }, { sideBySide, count });
  }
  await page.setViewportSize({ width: 1450, height: 920 });
  await role('chart-menu').click();
  await panel().getByText('More than two visible charts are arranged vertically.').waitFor();
  assert(await arrangement('Horizontal', 'radio').isDisabled());
  assert.equal(await panel().getByRole('button', { name: 'Organize charts' }).count(), 0);
  await show(ringName).uncheck();
  await text('Cancel').click();
  await panel().waitFor({ state: 'hidden' });
  await geometry(false, 3);
  await role('chart-menu').click();
  assert(await show(ringName).isChecked());
  const sliderColors = await panel().evaluate(node => {
    const theme = document.body.dataset.startTheme;
    const thumb = node.querySelector('.note-database-chart-orientation-slider');
    const selected = node.querySelector('.note-database-chart-orientation input:checked + span');
    try {
      return ['light', 'dark'].map(value => {
        document.body.dataset.startTheme = value;
        return [getComputedStyle(thumb).backgroundColor, getComputedStyle(selected).color];
      });
    } finally {
      if (theme === undefined) delete document.body.dataset.startTheme;
      else document.body.dataset.startTheme = theme;
    }
  });
  assert.deepEqual(sliderColors, [['rgb(25, 25, 25)', 'rgb(255, 255, 255)'], ['rgb(243, 243, 243)', 'rgb(25, 25, 25)']]);
  if (process.env.RELATUM_ARTIFACT_DIR) {
    await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, 'relatum-database-chart-order.png') });
  }
  await show(ringName).uncheck();
  await arrangement('Reorder: Completed share', 'button').press('ArrowUp');
  const dragSource = await panel().getByRole('button', { name: 'Reorder: ' + ringName, exact: true }).boundingBox();
  const dragTarget = await panel().getByRole('button', { name: 'Reorder: Weekly status', exact: true }).boundingBox();
  await page.mouse.move(dragSource.x + dragSource.width / 2, dragSource.y + dragSource.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragTarget.x + dragTarget.width / 2, dragTarget.y + dragTarget.height - 2, { steps: 8 });
  await page.mouse.up();
  await arrangement('Vertical', 'radio').press('ArrowRight');
  assert(await arrangement('Horizontal', 'radio').isChecked());
  await arrangement('Show data table below charts', 'checkbox').check();
  await role('new-chart', panel()).click();
  await panel().getByText('Save or cancel your chart changes first.').waitFor();
  await text('Weekly status').click();
  assert(await panel().getByText('Save or cancel your chart changes first.').isVisible());
  await geometry(false, 3);
  const failArrange = route => route.request().postDataJSON()?.action?.operation === 'arrange'
    ? route.fulfill({ status: 503, json: { error: 'Arrangement save interrupted' } }) : route.continue();
  await page.route(actionPattern, failArrange);
  await saveOrder().click();
  await panel().getByText('Arrangement save interrupted').waitFor();
  assert(await arrangement('Horizontal', 'radio').isChecked());
  assert.equal(await show(ringName).isChecked(), false);
  assert.equal((await api('')).chartOrientation, 'vertical');
  await page.unroute(actionPattern, failArrange);
  await saveOrder().click();
  await panel().getByText('Saved', { exact: true }).waitFor();
  assert.deepEqual(await panel().locator('[data-order-activate]').allTextContents(), ['Completed share', 'Weekly status', ringName]);
  assert(await text(ringName).isDisabled());
  await until(async () => (await names()).join(',') === 'Completed share,Weekly status');
  await geometry(true);
  await block().locator('table').waitFor();
  await text('Weekly status').click();
  await panel().waitFor({ state: 'hidden' });
  assert(await weekly.evaluate(node => document.activeElement === node));
  await weekly.getByText('Weekly status', { exact: true }).waitFor();
  await weekly.locator('.note-database-chart-canvas svg').waitFor();
  const plot = weekly.locator('.note-database-chart-stage');
  const dimensions = await plot.boundingBox();
  assert(Math.abs(dimensions.height - Math.min(300, dimensions.width * .75)) < 1);
  await weekly.locator('svg text').filter({ hasText: 'Checked' }).first().waitFor();
  const chartArea = block().locator('.note-database-chart-area');
  await chartArea.evaluate(node => { node.style.maxWidth = '639px'; });
  await geometry(false);
  await chartArea.evaluate(node => { node.style.maxWidth = '640px'; });
  await geometry(true);
  await chartArea.evaluate(node => { node.style.removeProperty('max-width'); });
  await page.setViewportSize({ width: 770, height: 920 });
  await geometry(false);
  assert.equal((await api('')).chartOrientation, 'horizontal');
  await page.setViewportSize({ width: 1450, height: 920 });
  await geometry(true);
  await role('chart-menu').click();
  await show(ringName).check();
  await saveOrder().click();
  await panel().getByText('Saved', { exact: true }).waitFor();
  await geometry(false, 3);
  await card(ringName).getByText(ringName, { exact: true }).waitFor();
  await panel().getByText('More than two visible charts are arranged vertically.').waitFor();
  await show('Completed share').uncheck();
  await saveOrder().click();
  await panel().getByText('Saved', { exact: true }).waitFor();
  await geometry(false, 2);
  await show(ringName).uncheck();
  await saveOrder().click();
  await panel().getByText('Saved', { exact: true }).waitFor();
  await geometry(false, 1);
  assert(await arrangement('Horizontal', 'radio').isChecked());
  await show('Completed share').check();
  await saveOrder().click();
  await panel().getByText('Saved', { exact: true }).waitFor();
  await geometry(true);
  await text('Weekly status').click();
  await panel().waitFor({ state: 'hidden' });
  const weeklyCanvas = weekly.locator('.note-database-chart-canvas');
  await weeklyCanvas.scrollIntoViewIfNeeded();
  await until(() => weeklyCanvas.evaluate(node => {
    const chart = window.echarts?.getInstanceByDom(node);
    return chart && chart.getWidth() === node.clientWidth && chart.getHeight() === node.clientHeight
      && !!node.querySelector('svg path');
  }));
  // Use the actual SVG mark through its chart coordinates.
  const coordinates = await weeklyCanvas.evaluate(node => {
    const chart = echarts.getInstanceByDom(node), rect = node.getBoundingClientRect();
    const [x, y] = chart.convertToPixel({ seriesIndex: 0 }, [0, 10]);
    return [x + rect.left, y + rect.top];
  });
  await page.mouse.click(...coordinates);
  await panel().getByText(/records$/).waitFor();
  const snapshot = await api('');
  assert.deepEqual(snapshot.chartCards.map(card => card.hidden), [false, false, true]);
  assert.equal(snapshot.chartOrientation, 'horizontal');
  await page.keyboard.press('Escape');
  const renamedNumber = 'Completion rate';
  await role('rename-chart', number).press('Enter');
  assert.equal(await nameInput().inputValue(), 'Completed share');
  await nameInput().fill(renamedNumber);
  const failRename = route => route.request().postDataJSON()?.action?.operation === 'rename'
    ? route.fulfill({ status: 503, json: { error: 'Rename interrupted' } }) : route.continue();
  await page.route(actionPattern, failRename);
  await text('Save name').click();
  await panel().getByText('Rename interrupted').waitFor();
  assert.equal(await nameInput().inputValue(), renamedNumber);
  assert(await number.isVisible());
  await page.unroute(actionPattern, failRename);
  await nameInput().press('Enter');
  await panel().waitFor({ state: 'hidden' });
  await card(renamedNumber).getByText(renamedNumber, { exact: true }).waitFor();
  assert(await role('rename-chart', card(renamedNumber)).evaluate(node => node === document.activeElement));
  await role('chart-menu').click();
  await text(renamedNumber).waitFor();
  const hideTitles = () => arrangement('Hide chart titles', 'checkbox');
  assert.equal(await hideTitles().isChecked(), false);
  await hideTitles().check();
  assert(await role('rename-chart', card(renamedNumber)).isVisible(), 'title setting takes effect on save');
  await page.keyboard.press('Escape');
  await role('chart-menu').click();
  assert.equal(await hideTitles().isChecked(), false);
  await hideTitles().check();
  await saveOrder().click();
  await panel().getByText('Saved', { exact: true }).waitFor();
  await text(renamedNumber).waitFor();
  await page.keyboard.press('Escape');
  await role('rename-chart', card(renamedNumber)).waitFor({ state: 'hidden' });
  await role('chart-card-menu', card(renamedNumber)).waitFor();
  await geometry(true);
  await mode('reading');
  await until(async () => (await names()).join(',') === renamedNumber + ',Weekly status');
  await geometry(true);
  await card(renamedNumber).locator('.note-database-chart-title').waitFor({ state: 'hidden' });
  assert.equal(await role('rename-chart', card(renamedNumber)).count(), 0);
  await block().locator('table').waitFor();
  const print = await page.evaluate(async note => {
    const width = '640px';
    const hosts = Array.from({ length: 2 }, () => {
      const host = document.createElement('div');
      Object.assign(host.style, { position: 'fixed', width, visibility: 'hidden' });
      document.body.append(host);
      return host;
    });
    try {
      const failures = await RelatumNoteDatabase.renderPrint(hosts[0], note, 'charts', 'en', [hosts[1]]);
      return { failures, blocks: hosts.map(host => ({
        titles: [...host.querySelectorAll('figcaption')].map(node => node.textContent),
        widths: [...host.querySelectorAll('figure svg')].map(svg => svg.getAttribute('width')),
        tables: host.querySelectorAll('table').length,
      })) };
    } finally { hosts.forEach(host => host.remove()); }
  }, note);
  assert.deepEqual(print, { failures: 0, blocks: Array.from({ length: 2 }, () => ({
    titles: [renamedNumber, 'Weekly status'], widths: ['640', '640'], tables: 1,
  })) });
  page = await restart();
  await openNote();
  await page.setViewportSize({ width: 1450, height: 920 });
  await until(async () => (await names()).join(',') === renamedNumber + ',Weekly status');
  await geometry(true);
  assert.equal((await api('')).chartCards.find(card => card.name === renamedNumber).query.search, 'Other');
  await block().locator('table').waitFor();
  await role('rename-chart', card(renamedNumber)).waitFor({ state: 'hidden' });
  await role('chart-menu').click();
  assert(await hideTitles().isChecked());
  await hideTitles().uncheck();
  await saveOrder().click();
  await panel().getByText('Saved', { exact: true }).waitFor();
  await role('rename-chart', card(renamedNumber)).waitFor();
}

module.exports = { checkChartViews };
