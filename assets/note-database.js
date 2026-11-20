// Database views share the current note's query, data, and pending edit.
(function () {
  'use strict';

  const snapshotRoute = '/api/note-database';
  const actionRoute = snapshotRoute + '/action';
  const chartRoute = snapshotRoute + '/chart';
  const chartModuleUrl = new URL('note-database-chart.js', document.currentScript?.src || document.baseURI).href;
  const importRoute = snapshotRoute + '/attachment/import';
  const downloadRoute = snapshotRoute + '/attachment/download';
  const documentExtensions = ['.pdf', '.md', '.markdown', '.csv', '.tsv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.txt', '.rtf'];
  const imageExtensions = ['.png', '.jpeg', '.jpg', '.webp', '.gif', '.bmp', '.svg'];
  const attachmentPickerAccept = [...documentExtensions, ...imageExtensions].join(',');
  const maxFileSize = 100 * 1024 * 1024;
  const columnTypes = {
    text: ['文本', 'Text'], number: ['数字', 'Number'], date: ['日期', 'Date'],
    checkbox: ['勾选', 'Checkbox'], attachment: ['附件', 'Attachment'],
    select: ['单标签', 'Single tag'], multiSelect: ['多标签', 'Multiple tags'], status: ['状态', 'Status'],
  };
  const chartTypes = { column: ['柱状图', 'Column chart'], bar: ['横向条形图', 'Horizontal bar chart'],
    line: ['折线图', 'Line chart'], doughnut: ['环形图', 'Doughnut chart'], number: ['数字卡', 'Number card'],
    histogram: ['直方图', 'Histogram'], scatter: ['散点图', 'Scatter plot'] };
  const chartMetrics = { sum: ['求和', 'Sum'], avg: ['平均值', 'Average'], min: ['最小值', 'Minimum'], max: ['最大值', 'Maximum'],
    checkedRate: ['勾选率', 'Checked rate'] };
  const chartBuckets = { day: ['日', 'Day'], week: ['周', 'Week'], month: ['月', 'Month'] };
  const filterNames = { contains: ['包含', 'Contains'], equals: ['等于', 'Equals'], gt: ['大于', 'Greater than'],
    lt: ['小于', 'Less than'], empty: ['为空', 'Is empty'], notEmpty: ['不为空', 'Is not empty'] };
  const chartColorTarget = chart => JSON.stringify([chart.type, chart.groupBy, chart.bucket, chart.seriesBy, chart.compare]);
  const chartTitle = (card, tr) => card.name || tr(chartTypes[card.chart.type] || ['图表', 'Chart']);
  const chartHasData = model => model?.series
    ? model.series.some(series => Object.values(series.values).some(Number.isFinite))
    : model?.groups.some(point => Number.isFinite(point.value));
  const makeChartQuery = ({ search = '', filters = [] } = {}) => ({ search, filters });
  const chartMessages = {
    loading: ['正在加载图表…', 'Loading chart…'],
    empty: ['没有可绘制的记录。可修改筛选条件，或到数据表添加记录。', 'No chart data. Change the filters or add records in Data.'],
    invalid_chart: ['图表字段已不可用，请重新选择字段。', 'A chart field is unavailable. Choose another field.'],
    chart_group_limit: ['分组太多。请缩小筛选范围，或使用更粗的日期粒度。', 'Too many groups. Narrow the filters or use a larger date interval.'],
    chart_series_limit: ['系列太多。请缩小筛选范围或更换系列字段。', 'Too many series. Narrow the filters or choose another series field.'],
    chart_point_limit: ['散点太多。请缩小筛选范围。', 'Too many scatter points. Narrow the filters.'],
    chart_metric_domain: ['环形图需要非负数值且至少一组大于零。可改用记录数或另一种图表。', 'A doughnut chart needs non-negative values with at least one positive group. Try record count or another chart type.'],
    chart_numeric_range: ['汇总数值超出范围。请缩小筛选范围或更换统计方式。', 'The result is out of range. Narrow the filters or change the aggregation.'],
    chart_timeout: ['汇总耗时较长。可缩小筛选范围后重试。', 'Aggregation took too long. Narrow the filters and try again.'],
    failed: ['图表未能加载。', 'Could not load the chart.'],
  };
  const typeSymbols = { text: 'Aa', number: '#' };
  const choiceTones = { default: ['默认', 'Default'], neutral: ['灰色', 'Gray'], brown: ['棕色', 'Brown'],
    orange: ['橙色', 'Orange'], amber: ['黄色', 'Yellow'], green: ['绿色', 'Green'], blue: ['蓝色', 'Blue'],
    violet: ['紫色', 'Purple'], rose: ['粉色', 'Pink'], red: ['红色', 'Red'] };
  const choiceType = type => ['select', 'multiSelect', 'status'].includes(type);
  const shownColumns = page => page.columns.filter(column => !column.hidden);
  const clampWidth = width => Math.round(Math.min(640, Math.max(96, width)));
  const sameCell = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];
  const iconPaths = { plus: 'M8 3.5v9M3.5 8h9', search: 'M10.3 10.3l3.1 3.1M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z',
    view: 'M2.5 4h11m-9 4h7m-5 4h3', more: 'M3.5 8h.2M7.9 8h.2M12.3 8h.2', prev: 'm10 4-4 4 4 4',
    next: 'm6 4 4 4-4 4', '×': 'm5 5 6 6m0-6-6 6', check: 'm3.5 8 3 3 6-6',
    date: 'M3 4h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM2 7h12M5 2v3m6-3v3',
    file: 'M4 2h5l4 4v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1ZM9 2v4h4',
    checkbox: 'M4 2.5h8A1.5 1.5 0 0 1 13.5 4v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5Zm1 5.5 2 2 4-4',
    attachment: 'm11 5-5.2 5.2a1.4 1.4 0 0 0 2 2l5.6-5.6a2.8 2.8 0 0 0-4-4L3.8 8.2a4.2 4.2 0 0 0 5.9 5.9l4-4',
    select: 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0ZM5.5 7l2.5 2.5L10.5 7',
    multiSelect: 'M6 4h7M6 8h7m-7 4h7M3 4h.1M3 8h.1M3 12h.1',
    status: 'M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0ZM8 4.5v4l2.5 1.5',
    trash: 'M2.5 4.5h11M6 4.5V3a.8.8 0 0 1 .8-.8h2.4a.8.8 0 0 1 .8.8v1.5m2 0-.6 8a1.3 1.3 0 0 1-1.3 1.3H5.9a1.3 1.3 0 0 1-1.3-1.3l-.6-8m2.7 2.2v4.8m2.6-4.8v4.8',
    download: 'M8 2.5v7m-3-3 3 3 3-3M3 11v2.5h10V11' };
  let listSequence = 0, chartRuntime;

  function loadChartRuntime() {
    return chartRuntime ||= import(chartModuleUrl).catch(error => { chartRuntime = null; throw error; });
  }

  const translate = (language, pair) => pair[language === 'en' ? 1 : 0];
  const label = (zh, en) => [zh, en];
  const makeQuery = () => ({ page: 1, search: '', sort: null, filters: [] });
  const acceptsFile = file => documentExtensions.includes(fileSuffix(file?.name || ''));
  const composing = event => event.isComposing || event.keyCode === 229;

  function fileSuffix(name) {
    const separator = name.lastIndexOf('.');
    return separator < 0 ? '' : name.slice(separator).toLowerCase();
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, onClick, role) {
    const node = element('button', '', text);
    node.type = 'button';
    if (role) node.dataset.dbRole = role;
    node.addEventListener('click', onClick);
    return node;
  }

  function icon(symbol) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('d', iconPaths[symbol]);
    svg.append(path);
    return svg;
  }

  function typeIcon(type, name) {
    const glyph = element('span', 'note-database-type', typeSymbols[type]);
    glyph.setAttribute('aria-hidden', 'true');
    if (name) glyph.title = name;
    if (!typeSymbols[type]) glyph.append(icon(type));
    return glyph;
  }

  async function request(url, body, signal) {
    const response = await fetch(url, body === undefined ? { signal, cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || response.statusText);
      error.status = response.status;
      error.code = result.code;
      throw error;
    }
    return result;
  }

  function loadPage(path, databaseId, query, signal) {
    const parameters = new URLSearchParams({ path, databaseId, query: JSON.stringify(query) });
    return request(snapshotRoute + '?' + parameters, undefined, signal);
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.onabort = () => reject(new DOMException('File read cancelled', 'AbortError'));
      reader.readAsDataURL(file);
    });
  }

  function input(type, name, value = '') {
    const node = element('input');
    node.type = type;
    node.setAttribute('aria-label', name);
    node.value = value;
    return node;
  }

  function select(name, options, value) {
    const node = element('select');
    node.setAttribute('aria-label', name);
    for (const [key, text] of options) node.add(new Option(text, key));
    node.value = value;
    return node;
  }

  function display(value, column, tr) {
    if (value === null || value === undefined) return '';
    if (column.type === 'attachment') return value.name || '';
    if (column.type === 'checkbox') return tr(value ? label('已勾选', 'Checked') : label('未勾选', 'Unchecked'));
    if (choiceType(column.type)) {
      return selectedChoices(value, column).map(option => option.name).join('、');
    }
    if (column.type === 'number' && column.numberFormat) {
      const { unit, decimals, percent } = column.numberFormat;
      const locale = tr(label('zh-CN', 'en'));
      const config = percent ? { style: 'percent' } : {};
      if (decimals !== undefined) config.minimumFractionDigits = config.maximumFractionDigits = decimals;
      else config.maximumSignificantDigits = 15;
      const formatted = !percent && decimals === undefined ? String(value) : new Intl.NumberFormat(locale, config).format(value);
      return unit ? formatted + ' ' + unit : formatted;
    }
    return String(value);
  }

  function selectedChoices(value, column) {
    const ids = Array.isArray(value) ? value : value == null ? [] : [value];
    return ids.map(id => column.choices?.find(option => option.id === id)).filter(Boolean);
  }

  function chartFilterText(card, columns, tr) {
    const { search, filters } = makeChartQuery(card.query);
    const parts = search.trim() ? [tr(label(`搜索「${search}」`, `Search “${search}”`))] : [];
    for (const rule of filters) {
      const column = columns.find(item => item.id === rule.column);
      if (column && filterNames[rule.operator]) {
        const value = display(rule.value, column, tr);
        parts.push([column.name, tr(filterNames[rule.operator]), value].filter(Boolean).join(' '));
      }
    }
    return parts.join(' · ');
  }

  function choiceChip(option, type) {
    const chip = element('span', 'note-database-choice', option.name);
    chip.dataset.dbTone = option.tone || 'neutral';
    chip.classList.toggle('is-status', type === 'status');
    return chip;
  }

  function clickedTextOffset(control, event) {
    const position = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    const range = position ? null : document.caretRangeFromPoint?.(event.clientX, event.clientY);
    const node = position?.offsetNode || range?.startContainer;
    return node?.nodeType === Node.TEXT_NODE && node.parentNode === control
      ? position?.offset ?? range.startOffset : null;
  }

  function anchorMoved(anchor, position, scrollTarget) {
    if (!anchor.isConnected) return true;
    if (!scrollTarget.contains(anchor)) return false;
    const rect = anchor.getBoundingClientRect();
    return Math.abs(rect.left - position.left) > .5 || Math.abs(rect.top - position.top) > .5;
  }

  function parseClipboard(text) {
    const lines = [[]];
    let value = '', quoted = false, closed = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch !== '"') value += ch;
        else if (text[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else if (ch === '\t' || ch === '\r' || ch === '\n') {
        lines.at(-1).push(value);
        value = ''; closed = false;
        if (ch !== '\t') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          if (i + 1 < text.length) lines.push([]);
          else return lines;
        }
      } else if (!value && !closed && ch === '"') quoted = true;
      else {
        if (closed) throw new Error('clipboard');
        value += ch;
      }
    }
    if (quoted) throw new Error('clipboard');
    lines.at(-1).push(value);
    return lines;
  }

  function clipboardValue(value, column) {
    if (value === '') return null;
    if (column.type === 'text') {
      if ([...value].length > 4096) throw new Error('text');
      return value.replace(/\r\n?/g, '\n');
    }
    if (column.type === 'number' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
      const number = Number(value);
      if (Number.isFinite(number) && Math.abs(number) <= 1e308) return number;
    }
    if (column.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '0001-01-01') {
      const date = new Date(value + 'T00:00:00Z');
      if (!isNaN(date) && date.toISOString().slice(0, 10) === value) return value;
    }
    if (column.type === 'checkbox') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', '☑', '已勾选', 'checked'].includes(normalized)) return true;
      if (['false', '0', '☐', '未勾选', 'unchecked'].includes(normalized)) return false;
    }
    if (choiceType(column.type)) {
      const find = name => column.choices?.find(option => option.name === name)?.id;
      const exact = find(value);
      if (exact) return column.type === 'multiSelect' ? [exact] : exact;
      if (column.type === 'multiSelect') {
        const ids = value.split('、').map(find);
        if (ids.every(Boolean)) return ids;
      }
    }
    throw new Error(column.type);
  }

  function rememberHistory(stack, changes) {
    const size = JSON.stringify(changes).length;
    stack.push({ changes, size });
    let units = size;
    let keep = stack.length - 1;
    while (keep > 0 && stack.length - keep < 50 && units + stack[keep - 1].size <= 4 * 1024 * 1024) {
      units += stack[--keep].size;
    }
    if (keep) stack.splice(0, keep);
  }

  async function readPrintDatabase(path, databaseId) {
    const query = makeQuery();
    const readPage = () => loadPage(path, databaseId, query, AbortSignal.timeout(10000));
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await readPage();
      if (page.chartView?.mode !== 'chart') return { page, cards: [] };
      const requests = new Map();
      const cards = await Promise.all(page.chartCards.filter(card => !card.hidden).map(async card => {
        if (!card.valid) return { card };
        const key = JSON.stringify([card.chart, makeChartQuery(card.query)]);
        if (!requests.has(key)) requests.set(key, request(chartRoute, { path, databaseId, query, chartId: card.id },
          AbortSignal.timeout(10000)).catch(error => error.status === 409 ? { revision: null } : null));
        const model = await requests.get(key);
        return { card, model };
      }));
      if (attempt === 0 && cards.some(({ model }) => model && model.revision !== page.revision)) continue;
      return { page, cards: cards.map(({ card, model }) => ({ card, model: model?.revision === page.revision ? model : null })) };
    }
  }

  async function printChartFigure(host, page, card, model, language, runtime) {
    const { style } = card;
    const width = host.clientWidth;
    if (!width) throw new Error('Chart print width unavailable');
    const { svg, description, legendItems } = await runtime.renderPrintChart(model, {
      language, dark: false, palette: style.palette, primary: style.primary, categories: style.categories,
    }, width);
    const figure = element('figure', 'note-database-print-figure');
    figure.append(element('figcaption', '', card.name || page.name || description));
    if (card.name || page.name) figure.append(element('p', 'note-database-print-description', description));
    const filters = chartFilterText(card, page.columns, pair => translate(language, pair));
    if (filters) figure.append(element('p', 'note-database-print-description', filters));
    figure.append(svg);
    if (legendItems.length) {
      const legend = element('ul', 'note-database-print-legend');
      for (const { text, color } of legendItems) {
        const item = element('li');
        const swatch = element('span', 'note-database-print-swatch');
        swatch.style.backgroundColor = color;
        item.append(swatch, text);
        legend.append(item);
      }
      figure.append(legend);
    }
    return figure;
  }

  async function renderPrint(host, path, databaseId, language, duplicates = []) {
    const tr = pair => translate(language, pair);
    try {
      const { page, cards } = await readPrintDatabase(path, databaseId);
      const hosts = [host, ...duplicates];
      if (!page.exists) {
        host.textContent = page.deleted ? tr(label('数据库已删除', 'Database deleted')) : tr(label('数据库尚未创建', 'Database not created'));
        return 0;
      }
      const chartMode = page.chartView?.mode === 'chart' && cards.length > 0;
      let printedCharts = false, warnings = 0;
      if (cards.some(({ model }) => chartHasData(model))) {
        try {
          const runtime = await loadChartRuntime();
          let failures = 0, drawn = 0;
          for (const target of hosts) {
            const figures = [];
            for (const { card, model } of cards) {
              if (chartHasData(model)) {
                try {
                  figures.push(await printChartFigure(target, page, card, model, language, runtime));
                  drawn++;
                  continue;
                } catch (_) {}
              }
              const notice = model && !chartHasData(model) ? tr(label('没有可绘制的数据', 'No plottable data'))
                : tr(label('图表无法导出', 'Chart could not be exported'));
              figures.push(element('p', '', chartTitle(card, tr) + ' · ' + notice));
              failures++;
            }
            target.replaceChildren(...figures);
          }
          printedCharts = Boolean(drawn);
          warnings = Math.min(cards.length, failures);
          if (printedCharts && !page.chartShowData) return warnings;
        } catch (_) { /* Print the data table if the chart cannot be drawn. */ }
      }
      const table = element('table', 'md-table note-database-print-table');
      if (page.name) table.createCaption().textContent = page.name;
      const header = table.createTHead().insertRow();
      const columns = shownColumns(page);
      for (const column of columns) header.append(element('th', '', column.name));
      const body = table.createTBody();
      for (const row of page.rows) {
        const line = body.insertRow();
        for (const column of columns) line.insertCell().textContent = display(row.values[column.id], column, tr);
      }
      const remaining = page.total - page.rows.length;
      const tableNodes = [table];
      if (remaining > 0) tableNodes.push(element('p', '', tr(label(`另有 ${remaining} 行`, `${remaining} more rows`))));
      if (printedCharts) {
        for (const target of duplicates) target.append(...tableNodes.map(node => node.cloneNode(true)));
        host.append(...tableNodes);
        return warnings;
      }
      host.replaceChildren(...tableNodes);
      if (chartMode) host.prepend(element('p', '', cards.some(({ model }) => model && !chartHasData(model))
        ? tr(label('图表没有可绘制的数据，以下为数据表。', 'The chart has no plottable data. The table is shown below.'))
        : tr(label('图表无法导出，以下为数据表。', 'The chart could not be exported. The table is shown below.'))));
      for (const target of duplicates) target.replaceChildren();
      return Number(chartMode);
    } catch (_) {
      host.textContent = tr(label('数据库读取失败', 'Database unavailable'));
      return 1;
    }
  }

  function create(options = {}) {
    const tr = pair => translate(options.language?.(), pair);
    const sessions = new Map();
    const observed = new Map();
    const drawingCharts = new Set();
    let observer = null;
    let chartThemeObserver = null;
    let offscreenChart = null;
    let activePath = null;
    let activeVisible = true;
    let destroyed = false;
    let channel = null;
    let lastDirty = false;
    try { channel = new BroadcastChannel('relatum:note-database:v2'); } catch (_) {}
    const sessionKey = (path, databaseId) => path + '\0' + databaseId;
    const sessionsFor = path => Array.from(sessions.values()).filter(session => session.path === path);
    const present = session => !destroyed && sessions.get(sessionKey(session.path, session.databaseId)) === session;

    function dirty() {
      return Array.from(sessions.values()).some(session => session.draft?.changed || session.draft?.composition || session.draft?.uploading || session.write);
    }

    function notifyDirty() {
      const value = dirty();
      if (value === lastDirty) return;
      lastDirty = value;
      options.onDirtyChange?.(value);
    }

    function getSession(path, databaseId) {
      const key = sessionKey(path, databaseId);
      if (!sessions.has(key)) sessions.set(key, {
        path, databaseId, page: null, query: makeQuery(), views: new Set(), draft: null, status: '', stale: true,
        read: null, write: null, timer: 0, undo: [], redo: [], chartJobs: new Map(),
      });
      return sessions.get(key);
    }

    function isVisible(session) {
      return !destroyed && activeVisible && activePath === session.path && !document.hidden
        && document.documentElement.dataset.desktopMinimized !== '1';
    }

    function canRead(session) {
      return isVisible(session) && Array.from(session.views).some(view => view.visible && view.host.isConnected);
    }

    function stopChartRead(session) {
      for (const job of session.chartJobs.values()) job.controller?.abort();
      session.chartJobs.clear();
    }

    function clearChart(session) {
      stopChartRead(session);
      if (offscreenChart?.session === session) offscreenChart = null;
    }

    function releaseChart(view) {
      view.chartPaint = null;
      view.chartResize?.disconnect();
      view.chartResize = null;
      view.chartRenderer?.dispose();
      view.chartRenderer = null;
      if (drawingCharts.delete(view) && !drawingCharts.size) {
        chartThemeObserver?.disconnect();
        chartThemeObserver = null;
      }
    }

    function releaseCharts(view, unobserve = false) {
      for (const card of view.cards.values()) {
        releaseChart(card);
        if (unobserve) stopObserving(card.chartStage);
      }
    }

    function chartVisible(view) {
      return !!view.chartStage && !view.chartStage.hidden && view.chartStage.isConnected
        && view.owner.mode === 'chart' && view.owner.visible
        && (!view.owner.observe || view.chartIntersecting) && isVisible(view.session);
    }

    function showChartStatus(view, status) {
      const key = `${status}:${options.language?.()}`;
      if (view.chartStatusKey === key) return;
      view.chartStatusKey = key;
      view.chartStatus.hidden = !status;
      view.chartStatus.replaceChildren();
      if (!status) return;
      view.chartStatus.append(element('span', '', tr(chartMessages[status])));
      if (status === 'failed' || status === 'chart_timeout') {
        const retry = button(tr(label('重试', 'Retry')), () => {
          clearChart(view.session);
          view.session.stale = true;
          void read(view.session);
          syncCharts(view.session);
        }, 'chart-retry');
        view.chartStatus.append(retry);
      } else if (!view.owner.readOnly && ['invalid_chart', 'chart_group_limit', 'chart_series_limit', 'chart_point_limit',
        'chart_metric_domain', 'chart_numeric_range'].includes(status)) {
        view.chartStatus.append(button(tr(label('图表设置', 'Chart settings')),
          () => openChartSettings(view.owner, view.menu, view.model), 'chart-reconfigure'));
      }
    }

    function paintChart(view, model) {
      const language = options.language?.() || 'zh';
      const dark = document.documentElement.dataset.startTheme === 'dark' || document.body.dataset.startTheme === 'dark';
      const style = view.chartStyleDraft ?? view.model.style;
      const appearance = { language, dark, palette: window.RelatumNoteChartPalette.effective(style.palette),
        ...(model.chart.type !== 'doughnut' && { primary: style.primary }),
        categories: style.categories ?? {} };
      const appearanceKey = JSON.stringify(appearance);
      if (view.chartPaint?.model === model && view.chartPaint.appearanceKey === appearanceKey) return;
      const paint = view.chartPaint = { model, appearanceKey };
      const current = () => view.chartPaint === paint && chartVisible(view);
      const failed = () => {
        if (!current()) return;
        releaseChart(view);
        showChartStatus(view, 'failed');
      };
      if (!view.chartRenderer) showChartStatus(view, 'loading');
      drawingCharts.add(view);
      if (!chartThemeObserver && window.MutationObserver) {
        chartThemeObserver = new MutationObserver(() => {
          for (const mounted of drawingCharts) if (chartVisible(mounted)) paintChart(mounted, mounted.chartPaint.model);
        });
        chartThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-start-theme'] });
        chartThemeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-start-theme'] });
      }
      void loadChartRuntime().then(async runtime => {
        if (!current()) return;
        if (view.chartRenderer) {
          if (await view.chartRenderer.update(model, appearance) && current()) showChartStatus(view, '');
          return;
        }
        const renderer = view.chartRenderer = runtime.mount(view.chartCanvas, model, appearance,
          mark => openChartDetails(view, mark));
        const painted = await renderer.ready;
        if (painted && current()) showChartStatus(view, '');
        // A language or theme update can reuse this instance while its engine is loading.
        if (view.chartRenderer !== renderer || !chartVisible(view) || !window.ResizeObserver) return;
        let width = painted ? view.chartCanvas.clientWidth : 0, height = painted ? view.chartCanvas.clientHeight : 0;
        view.chartResize = new ResizeObserver(() => {
          const nextWidth = view.chartCanvas.clientWidth, nextHeight = view.chartCanvas.clientHeight;
          if (view.chartRenderer !== renderer || !chartVisible(view) || (nextWidth === width && nextHeight === height)) return;
          width = nextWidth; height = nextHeight;
          const currentPaint = view.chartPaint;
          void renderer.resize().then(ok => {
            if (ok && view.chartPaint === currentPaint && chartVisible(view)) showChartStatus(view, '');
          }).catch(() => {
            if (view.chartRenderer === renderer && chartVisible(view)) {
              releaseChart(view);
              showChartStatus(view, 'failed');
            }
          });
        });
        view.chartResize.observe(view.chartCanvas);
      }).catch(failed);
    }

    function requestChart(session, key, revision, chartId, query) {
      const controller = new AbortController();
      const job = { key, controller };
      session.chartJobs.set(key, job);
      const { path, databaseId } = session;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
      void request(chartRoute, { path, databaseId, query, chartId }, signal).then(async model => {
        if (session.chartJobs.get(key) !== job) return;
        if (!model.exists || model.revision !== revision) {
          session.stale = true;
          await read(session);
          if (session.chartJobs.get(key) !== job) return;
          job.status = 'failed';
        } else if (chartHasData(model)) job.model = model;
        else job.status = 'empty';
        syncCharts(session);
      }).catch(error => {
        if (session.chartJobs.get(key) !== job) return;
        job.status = Object.hasOwn(chartMessages, error.code) ? error.code : 'failed';
        if (error.status === 409) void refresh(session.path, true, session.databaseId);
        syncCharts(session);
      });
    }

    function syncCharts(session) {
      if (session.page?.chartView?.mode !== 'chart') { clearChart(session); return; }
      const { revision } = session.page;
      const query = makeChartQuery(session.query);
      const required = new Set();
      for (const owner of session.views) for (const view of owner.cards.values()) {
        if (!chartVisible(view)) continue;
        const card = view.model;
        if (!card.valid) {
          releaseChart(view);
          showChartStatus(view, 'invalid_chart');
          continue;
        }
        const key = JSON.stringify([revision, card.chart, makeChartQuery(card.query), query]);
        required.add(key);
        if (view.job?.key !== key && owner.panel?.kind === 'chart-details' && view.root.contains(owner.panel.anchor)) {
          owner.panel.close();
        }
        let job = session.chartJobs.get(key);
        if (!job) {
          releaseChart(view);
          showChartStatus(view, session.readFailed ? 'failed' : 'loading');
          if (session.stale || session.read || session.write || session.readFailed
              || session.renderedQuery !== JSON.stringify(session.query)) continue;
          if (offscreenChart?.session === session && offscreenChart.key === key) {
            session.chartJobs.set(key, offscreenChart);
            offscreenChart = null;
          } else requestChart(session, key, revision, card.id, query);
          job = session.chartJobs.get(key);
        }
        view.job = job;
        view.syncChartColorCategories?.(job.model?.series || job.model?.groups);
        if (job.model) paintChart(view, job.model);
        else showChartStatus(view, job.status || 'loading');
      }
      for (const [key, job] of session.chartJobs) {
        if (required.has(key)) continue;
        if (job.model && isVisible(session)) offscreenChart = { session, key, model: job.model };
        job.controller?.abort();
        session.chartJobs.delete(key);
      }
    }

    function repaintChart(view) {
      const model = view.chartPaint?.model;
      if (model && chartVisible(view)) paintChart(view, model);
    }

    function announce(session, message) {
      if (session.status === message) return;
      session.status = message;
      for (const view of session.views) {
        view.status.textContent = message;
        view.status.hidden = !message;
        view.onLayout?.();
      }
    }

    function applyPage(session, page, ownWrite = false) {
      const { inverse, addedId, addedRow, updatedRow, addedColumn, deletedCount, changedChartId, ...snapshot } = page;
      page = snapshot;
      if (!ownWrite && session.page && session.page.revision !== page.revision) {
        session.undo.length = 0;
        session.redo.length = 0;
      }
      session.page = page;
      session.readFailed = false;
      if (page.exists) {
        session.query.page = page.page;
        const columns = new Map(page.columns.map(column => [column.id, column]));
        if (!columns.has(session.query.sort?.column)) session.query.sort = null;
        session.query.filters = session.query.filters.filter(filter => {
          const column = columns.get(filter.column);
          return column && (!choiceType(column.type) || ['empty', 'notEmpty'].includes(filter.operator)
            || column.choices?.some(option => option.id === filter.value));
        });
      }
      session.renderedQuery = JSON.stringify(session.query);
      for (const view of session.views) if (view.visible) draw(view);
      syncCharts(session);
    }

    function markChanged(path, databaseId) {
      try { channel?.postMessage({ path, databaseId }); } catch (_) {}
    }

    async function refresh(path = activePath, followRead = false, databaseId) {
      const targets = databaseId ? [sessions.get(sessionKey(path, databaseId))] : sessionsFor(path);
      return Promise.all(targets.map(session => {
        if (!session || session.read && !followRead) return;
        session.stale = true;
        return read(session);
      }));
    }

    function stopRead(session) {
      clearTimeout(session.timer);
      session.timer = 0;
      session.read?.abort();
      session.read = null;
    }

    function read(session) {
      if (session.read) return session.readDone;
      if (!session.stale || !canRead(session) || session.write || options.pending?.(session.path, session.databaseId)) return;
      session.stale = false;
      session.readFailed = false;
      const controller = new AbortController();
      session.read = controller;
      const task = async () => {
        try {
          const page = await loadPage(session.path, session.databaseId, session.query, controller.signal);
          if (!controller.signal.aborted && canRead(session)) {
            if (page.exists || page.deleted) session.creationFailed = false;
            if (!session.draft?.error && !session.creationFailed) announce(session, '');
            if (session.renderedQuery !== JSON.stringify(session.query) || JSON.stringify(session.page) !== JSON.stringify(page)) applyPage(session, page);
          } else if (!controller.signal.aborted) session.stale = true;
        } catch (error) {
          if (!controller.signal.aborted && canRead(session)) {
            session.readFailed = true;
            announce(session, tr(label('读取数据库失败', 'Could not load database')));
            for (const view of session.views) if (!session.page && view.visible) draw(view);
          }
        } finally {
          if (session.read === controller) {
            session.read = null;
            session.readDone = null;
            if (session.stale) void read(session);
            else syncCharts(session);
          }
        }
      };
      return (session.readDone = task());
    }

    async function write(session, action, replay = '', file) {
      if (session.write) {
        try { await session.write; } catch (_) { return false; }
        if (session.write) return false;
      }
      if (!present(session)) return false;
      stopRead(session);
      session.stale = false;
      const requestedQuery = JSON.stringify(session.query);
      const { path, databaseId, query } = session;
      const operation = { revision: session.page?.revision, ...action };
      const task = file ? request(importRoute, { path, query, ...file, target: { databaseId, ...operation } })
        : request(actionRoute, { path, databaseId, query, action: operation });
      session.write = task;
      notifyDirty();
      try {
        const page = await task;
        if (present(session)) {
          if (page.exists || page.deleted) session.creationFailed = false;
          announce(session, '');
          if (page.inverse?.length) {
            if (replay) {
              const source = replay === 'undo' ? session.undo : session.redo;
              const target = replay === 'undo' ? session.redo : session.undo;
              source.pop();
              rememberHistory(target, page.inverse);
            } else {
              rememberHistory(session.undo, page.inverse);
              session.redo.length = 0;
            }
          } else if (['create', 'delete', 'cleanup', 'deleteColumn', 'setChoices'].includes(action.type)) {
            session.undo.length = 0;
            session.redo.length = 0;
          }
          if (page.updatedRow) for (const view of session.views) {
            if (view.pinned?.id === page.updatedRow.id) view.pinned = page.updatedRow;
          }
          if (JSON.stringify(session.query) === requestedQuery) applyPage(session, page, true);
          else {
            if (session.page) session.page = { ...session.page, revision: page.revision, chartView: page.chartView,
              chartCards: page.chartCards, chartShowData: page.chartShowData, chartOrientation: page.chartOrientation,
              chartHideTitles: page.chartHideTitles };
            session.stale = true;
          }
          markChanged(session.path, session.databaseId);
        }
        return page;
      } catch (error) {
        if (!present(session)) return false;
        if (session.draft) session.draft.error = true;
        announce(session, error.code === 'options_in_use' ? error.message : error.status === 409
          ? tr(label('数据库已修改，已保留当前输入。请确认后重试。', 'The database changed. Your edit is kept. Review it and retry.'))
          : error.message || tr(label('操作失败，请重试。', 'Could not save. Please try again.')));
        if (['delete', 'cleanup'].includes(action.type)) options.onError?.(error);
        if (error.status === 409 && error.code !== 'options_in_use') session.stale = true;
        return false;
      } finally {
        if (session.write === task) {
          session.write = null;
          notifyDirty();
          if (session.stale) void read(session);
          else syncCharts(session);
        }
      }
    }

    async function commitDraft(draft, nextCell, restoreFocus = false) {
      if (draft.composition || draft.picker || draft.session.draft !== draft) return false;
      if (draft.saving) return draft.saving;
      const { session } = draft;
      dismissSuggestions(draft);
      const value = draft.value;
      if (draft.input && !draft.input.validity.valid) {
        draft.input.reportValidity();
        return false;
      }
      const job = async () => {
        if (draft.error) {
          if (!canRead(session)) return false;
          await read(session);
        }
        if (!draft.changed) return true;
        return await saveCell(draft.view, draft.row, draft.column, value);
      };
      draft.saving = job().then(ok => {
        draft.saving = null;
        if (ok) finishDraft(draft, nextCell, restoreFocus);
        return ok;
      });
      return draft.saving;
    }

    function finishDraft(draft, nextCell, restoreFocus) {
      const { session, view, row, column } = draft;
      if (session.draft !== draft) return;
      session.draft = null;
      notifyDirty();
      if (view.visible) draw(view);
      syncCharts(session);
      if (restoreFocus && view.visible && isVisible(session)) focusCell(view, nextCell || [row.id, column.id]);
      else if (!view.root.contains(document.activeElement)) releasePinned(view);
    }

    function abandonDraft(draft) {
      if (draft.saving) return;
      removeAttachmentPicker(draft);
      dismissSuggestions(draft);
      const { session, row, column, view } = draft;
      if (session.draft !== draft) return;
      session.draft = null;
      notifyDirty();
      announce(session, '');
      if (view.visible) draw(view);
      if (isVisible(session)) focusCell(view, [row.id, column.id]);
    }

    function focusCell(view, [row, column]) {
      selectCell(view, [row, column], false, true, true);
    }

    function revealCell(view, control) {
      let rect = control.getBoundingClientRect();
      const scroller = view.overflow;
      const box = scroller.getBoundingClientRect();
      const editor = control.closest('.cm-scroller');
      const editorBox = editor?.getBoundingClientRect();
      if (rect.top < Math.max(0, editorBox?.top || 0) || rect.bottom > Math.min(innerHeight, editorBox?.bottom || innerHeight)) {
        control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        rect = control.getBoundingClientRect();
      }
      const right = box.left + scroller.clientWidth - (view.lane?.offsetWidth || 0);
      if (rect.left < box.left) scroller.scrollLeft -= box.left - rect.left;
      else if (rect.right > right) scroller.scrollLeft += rect.right - right;
    }

    function visibleRows(view) {
      const rows = view.session.page?.rows || [];
      return view.pinned && !rows.some(row => row.id === view.pinned.id) ? [...rows, view.pinned] : rows;
    }

    function bounds(view) {
      if (!view.selection) return null;
      const rows = visibleRows(view), columns = shownColumns(view.session.page);
      const { anchor, head } = view.selection;
      const r0 = rows.findIndex(row => row.id === anchor[0]), r1 = rows.findIndex(row => row.id === head[0]);
      const c0 = columns.findIndex(column => column.id === anchor[1]), c1 = columns.findIndex(column => column.id === head[1]);
      if ([r0, r1, c0, c1].includes(-1)) return null;
      return { rows, columns, r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: Math.min(c0, c1), c1: Math.max(c0, c1) };
    }

    function paintSelection(view) {
      const range = bounds(view), current = new Set();
      if (range && !view.readOnly) {
        for (let row = range.r0; row <= range.r1; row++) {
          for (let col = range.c0; col <= range.c1; col++) {
            const target = view.cells.get(range.rows[row].id)?.get(range.columns[col].id);
            if (target) current.add(target);
          }
        }
      }
      for (const cell of view.painted || []) if (!current.has(cell)) cell.classList.remove('is-selected');
      for (const cell of current) if (!view.painted?.has(cell)) cell.classList.add('is-selected');
      view.painted = current;
      const head = view.selection?.head;
      const active = head && view.cells.get(head[0])?.get(head[1]);
      if (active !== view.activeCell) view.activeCell?.classList.remove('is-active');
      active?.classList.add('is-active');
      view.activeCell = active;
      const tabStop = active || view.cells.values().next().value?.values().next().value;
      if (!view.readOnly && tabStop !== view.tabStop) {
        if (view.tabStop) view.tabStop.tabIndex = -1;
        if (tabStop) tabStop.tabIndex = 0;
      }
      view.tabStop = tabStop;
    }

    function selectCell(view, cell, extend, focus, reveal = false) {
      if (!view.cells?.get(cell[0])?.has(cell[1])) return;
      const anchor = extend && view.selection ? view.selection.anchor : cell;
      if (!sameCell(view.selection?.head, cell) || !sameCell(view.selection?.anchor, anchor)) {
        view.selection = { anchor, head: cell };
        paintSelection(view);
      }
      if (focus) {
        const control = view.cells.get(cell[0])?.get(cell[1]);
        control?.focus({ preventScroll: true });
        if (reveal && control?.isConnected) revealCell(view, control);
      }
      releasePinned(view, cell[0]);
    }

    function clipboard(view, event, clear = false) {
      if (view.table?.hidden || event.defaultPrevented || view.readOnly) return;
      const range = bounds(view);
      if (!range) return;
      const { session } = view;
      const draft = session.draft;
      const editing = event.type === 'paste' && draft?.view === view && event.target === draft.input
        && draft.column.type !== 'attachment';
      if (!editing && (event.target.closest('input,textarea,select') || draft || session.write)) return;
      if (event.type === 'copy') {
        if (!event.clipboardData) return;
        const columns = range.columns.slice(range.c0, range.c1 + 1);
        const encode = value => /["\t\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
        const text = range.rows.slice(range.r0, range.r1 + 1).map(row =>
          columns.map(column => encode(column.type === 'number' ? row.values[column.id] ?? ''
            : display(row.values[column.id], column, tr))).join('\t')).join('\r\n');
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const text = clear ? '' : event.clipboardData?.getData('text/plain');
      if (text === undefined || (!clear && !text)) return;
      const oversized = text.length > 4 * 1024 * 1024;
      const markdown = !oversized && text.includes('|') && /[\r\n]/.test(text) ? window.MarkdownTable?.parse(text) : null;
      // Leave ordinary text paste to the input, including multiline cell text.
      if (editing && !text.includes('\t') && !markdown?.ok) return;
      event.preventDefault();
      event.stopPropagation();
      if (editing && (draft.composition || draft.saving || session.write)) return;
      if (session.renderedQuery !== JSON.stringify(session.query)) {
        announce(session, tr(label('视图正在更新，更新后可继续编辑范围。', 'The view is updating. Try again when the rows are ready.')));
        return;
      }
      let matrix;
      try {
        if (oversized) throw new Error('length');
        if (clear) matrix = Array.from({ length: range.r1 - range.r0 + 1 }, () => Array(range.c1 - range.c0 + 1).fill(''));
        else if (markdown?.ok) matrix = [markdown.model.header, ...markdown.model.rows];
        else matrix = parseClipboard(text);
      } catch (_) {
        announce(session, tr(label('无法读取粘贴内容。', 'Could not read the pasted data.')));
        return;
      }
      if (matrix.length > 200) {
        announce(session, tr(label('一次最多粘贴 200 行。', 'Paste up to 200 rows at a time.')));
        return;
      }
      const changes = [];
      const { query, page } = session;
      const canAppend = !query.search && !query.sort && !query.filters.length && page.page * page.pageSize >= page.total;
      for (const [r, values] of matrix.entries()) {
        const row = range.rows[range.r0 + r];
        if ((!row && !canAppend) || (row && !page.rows.some(item => item.id === row.id))) {
          announce(session, tr(label('粘贴超出当前页，表格未修改。', 'The paste extends beyond the current page. No cells changed.')));
          return;
        }
        const parsed = {};
        for (const [c, value] of values.entries()) {
          const column = range.columns[range.c0 + c];
          try {
            if (!column) throw new Error('column');
            parsed[column.id] = clipboardValue(value, column);
          } catch (_) {
            if (!editing) {
              const target = range.columns[Math.min(range.c0 + c, range.columns.length - 1)];
              focusCell(view, [(row || range.rows.at(-1)).id, target.id]);
            }
            announce(session, tr(label(
              `粘贴内容第 ${r + 1} 行、第 ${c + 1} 列超出范围或类型不符，表格未修改。`,
              `Pasted row ${r + 1}, column ${c + 1} is out of range or has the wrong type. No cells changed.`)));
            return;
          }
        }
        changes.push({ row: row?.id ?? null, values: parsed });
      }
      const operation = { type: 'batchCells', changes };
      if (!editing) { void write(session, operation); return; }
      // The batch replaces the active cell with its top-left value in one undo step.
      draft.saving = write(session, operation).then(result => {
        draft.saving = null;
        if (result) finishDraft(draft, null, document.activeElement === draft.input);
        return Boolean(result);
      });
    }

    function afterCellSave(view, callback) {
      const { session } = view;
      const saving = session.draft?.saving;
      if (!saving) return callback();
      return saving.then(ok => {
        if (ok && view.host.isConnected && isVisible(session)) return callback();
      });
    }

    async function settleSession(session) {
      if (session.write) {
        try { await session.write; } catch (_) { return false; }
      }
      const draft = session.draft;
      if (!draft) return true;
      await draft.composition;
      if (draft.error) return false;
      return session.draft !== draft || await commitDraft(draft);
    }

    function adjacentCell(view, row, column, key, shift) {
      const rows = visibleRows(view), columns = shownColumns(view.session.page);
      const rowIndex = rows.findIndex(item => item.id === row.id);
      const columnIndex = columns.findIndex(item => item.id === column.id);
      const width = columns.length;
      if (key === 'Tab') {
        const next = rowIndex * width + columnIndex + (shift ? -1 : 1);
        if (next < 0 || next >= width * rows.length) return null;
        return [rows[Math.floor(next / width)].id, columns[next % width].id];
      }
      const vertical = { ArrowUp: -1, ArrowDown: 1 }[key] || 0;
      const horizontal = { ArrowLeft: -1, ArrowRight: 1 }[key] || 0;
      const targetRow = rows[rowIndex + vertical], targetColumn = columns[columnIndex + horizontal];
      return targetRow && targetColumn ? [targetRow.id, targetColumn.id] : null;
    }

    function dismissSuggestions(draft) {
      clearTimeout(draft.suggestionTimer);
      draft.suggestionFetch?.abort();
      draft.suggestionFetch = null;
      draft.removePopupListeners?.();
      draft.removePopupListeners = null;
      const popup = draft.popup;
      draft.popup = null;
      popup?.remove();
      draft.input?.setAttribute('aria-expanded', 'false');
      draft.input?.removeAttribute('aria-activedescendant');
    }

    function pickAttachment(draft, item) {
      draft.value = item ? item.kind === 'note' ? { kind: 'note', path: item.path } : { kind: 'attachment', id: item.id } : null;
      draft.term = item?.name || '';
      draft.input.value = draft.term;
      draft.changed = true;
      notifyDirty();
      void commitDraft(draft, null, true);
    }

    function selectSuggestion(draft, index) {
      const list = draft.popup?.firstElementChild;
      const items = list?.querySelectorAll('[role="option"]');
      if (!items?.length) return;
      draft.suggestionIndex = (index + items.length) % items.length;
      items.forEach((item, index) => item.setAttribute('aria-selected', String(index === draft.suggestionIndex)));
      const active = items[draft.suggestionIndex];
      draft.input.setAttribute('aria-activedescendant', active.id);
      const bounds = active.getBoundingClientRect(), viewport = list.getBoundingClientRect();
      if (bounds.top < viewport.top) list.scrollTop -= viewport.top - bounds.top;
      else if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom;
    }

    function attachmentDraftCurrent(draft) {
      return draft.session.draft === draft && draft.input?.isConnected && draft.view.visible && isVisible(draft.session);
    }

    function restoreAttachmentPicker(draft) {
      if (!attachmentDraftCurrent(draft)) return;
      draft.input.focus({ preventScroll: true });
      if (!draft.popup) suggestions(draft);
    }

    async function uploadAttachment(draft, file, revision) {
      const { session, row, column, view } = draft;
      const image = imageExtensions.includes(fileSuffix(file.name));
      const limit = image ? 40 : 100;
      if (!image && !acceptsFile(file)) {
        announce(session, tr(label('不支持此附件格式。', 'This attachment format is not supported.')));
        restoreAttachmentPicker(draft);
        return;
      }
      if (!file.size || file.size > limit * 1024 * 1024) {
        announce(session, tr(file.size ? label(`文件不能超过 ${limit} MiB。`, `The file cannot exceed ${limit} MiB.`) : label('文件为空。', 'The file is empty.')));
        restoreAttachmentPicker(draft);
        return;
      }
      const path = session.path;
      dismissSuggestions(draft);
      draft.uploading = true;
      notifyDirty();
      draft.input.setAttribute('aria-busy', 'true');
      const task = (async () => {
        try {
          const data = await readFile(file);
          if (!attachmentDraftCurrent(draft) || session.path !== path) return false;
          return await write(session, { type: 'setCell', revision, row: row.id, column: column.id,
            includeRow: view.pinned?.id === row.id }, '', { name: file.name, data });
        } catch (error) {
          if (attachmentDraftCurrent(draft)) announce(session, error.message || tr(label('读取文件失败。', 'Could not read the file.')));
          return false;
        }
      })();
      draft.saving = task;
      const saved = await task;
      if (!saved && session.draft === draft && draft.error && !draft.changed) {
        const error = session.status;
        await session.readDone;
        if (session.draft === draft) {
          draft.error = false;
          if (attachmentDraftCurrent(draft)) announce(session, error);
        }
      }
      draft.saving = null;
      draft.uploading = false;
      draft.input?.removeAttribute('aria-busy');
      if (saved) finishDraft(draft, null, true);
      notifyDirty();
      if (!saved) restoreAttachmentPicker(draft);
    }

    function chooseAttachmentFile(draft) {
      if (!attachmentDraftCurrent(draft) || draft.composition || draft.saving || draft.picker) return;
      const revision = draft.session.page.revision;
      const picker = element('input');
      picker.type = 'file';
      picker.accept = attachmentPickerAccept;
      picker.hidden = true;
      draft.picker = picker;
      draft.view.root.append(picker);
      const complete = file => {
        if (draft.picker !== picker) return;
        removeAttachmentPicker(draft);
        if (!attachmentDraftCurrent(draft)) return;
        if (file) void uploadAttachment(draft, file, revision);
        else restoreAttachmentPicker(draft);
      };
      picker.addEventListener('change', () => complete(picker.files?.[0]), { once: true });
      picker.addEventListener('cancel', () => complete(), { once: true });
      picker.click();
    }

    function removeAttachmentPicker(draft) {
      draft.picker?.remove();
      draft.picker = null;
    }

    async function downloadAttachment(draft, control) {
      if (!attachmentDraftCurrent(draft) || !draft.value?.exists || draft.downloading || draft.saving) return;
      const { session, row, column, value } = draft;
      const { path, databaseId } = session;
      draft.downloading = true;
      if (document.activeElement === control) draft.input.focus({ preventScroll: true });
      control.disabled = true;
      try {
        const result = await request(downloadRoute, { path, databaseId, row: row.id, column: column.id, value });
        if (isVisible(session) && session.path === path) options.onNotice?.(tr(label(`已保存到下载文件夹 · ${result.name}`, `Saved to Downloads · ${result.name}`)));
      } catch (error) {
        if (!isVisible(session) || session.path !== path) return;
        if (error.status === 404 || error.status === 409) {
          if (session.draft === draft) abandonDraft(draft);
          void refresh(path, true, databaseId);
        }
        options.onError?.(error);
      } finally {
        draft.downloading = false;
        control.disabled = false;
      }
    }

    function suggestions(draft) {
      dismissSuggestions(draft);
      if (draft.composition || draft.saving || draft.picker || !attachmentDraftCurrent(draft)) return;
      const popup = element('div', 'note-database-suggestions');
      const list = element('div', 'note-database-suggestion-list');
      list.id = draft.input.getAttribute('aria-controls');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', tr(label('匹配的附件', 'Matching attachments')));
      const actions = element('div', 'note-database-attachment-actions');
      if (draft.value?.exists) {
        const download = button(tr(label('下载文件', 'Download file')), () => void downloadAttachment(draft, download), 'download-attachment');
        download.prepend(icon('download'));
        download.disabled = Boolean(draft.downloading);
        actions.append(download);
      }
      actions.append(button(tr(label('上传文件', 'Upload file')), () => chooseAttachmentFile(draft), 'upload-attachment'));
      popup.append(list, actions);
      popup.addEventListener('focusout', event => {
        if (draft.popup === popup) leaveAttachmentEditor(draft, event.relatedTarget);
      });
      popup.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          draft.input.focus({ preventScroll: true });
          dismissSuggestions(draft);
        }
        if (event.key === 'Tab' && event.shiftKey && event.target === actions.querySelector('button:not(:disabled)')) {
          event.preventDefault();
          draft.input.focus({ preventScroll: true });
        }
      });
      // Use the top layer when available so a scrolling table never clips the list.
      if (popup.showPopover) popup.setAttribute('popover', 'manual');
      draft.view.root.append(popup);
      draft.popup = popup;
      if (popup.showPopover) popup.showPopover();
      const rect = draft.input.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const width = Math.min(Math.max(rect.width, 224), viewportWidth - 16);
      const below = viewportHeight - rect.bottom - 8, above = rect.top - 8;
      const openAbove = below < 180 && above > below;
      popup.style.width = width + 'px';
      popup.style.left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8)) + 'px';
      popup.style.maxHeight = Math.max(72, Math.min(256, openAbove ? above : below)) + 'px';
      if (openAbove) popup.style.bottom = viewportHeight - rect.top + 'px';
      else popup.style.top = rect.bottom + 'px';
      draft.input.setAttribute('aria-expanded', 'true');
      const onScroll = event => { if (!draft.picker && anchorMoved(draft.input, rect, event.target)) dismissSuggestions(draft); };
      const onResize = () => { if (!draft.picker) dismissSuggestions(draft); };
      document.addEventListener('scroll', onScroll, { capture: true, passive: true });
      window.addEventListener('resize', onResize);
      draft.removePopupListeners = () => {
        document.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
      };
      draft.suggestionItems = [];
      draft.suggestionIndex = -1;
      const query = draft.input.value.trim();
      const load = async () => {
        const controller = new AbortController();
        draft.suggestionFetch = controller;
        try {
          const result = await request(actionRoute, {
            path: draft.session.path, databaseId: draft.session.databaseId, action: { type: 'searchAttachments', query },
          }, controller.signal);
          if (controller.signal.aborted || draft.popup !== popup || !attachmentDraftCurrent(draft) || draft.composition) return;
          const items = result.items.filter(item => item.exists !== false);
          if (draft.value) items.push(null);
          draft.suggestionItems = items;
          draft.suggestionIndex = -1;
          items.forEach((item, index) => {
            const option = button(item?.name || tr(label('清除链接', 'Clear link')), () => pickAttachment(draft, item));
            option.tabIndex = -1;
            option.id = list.id + '-' + index;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            option.addEventListener('pointerdown', event => event.preventDefault());
            if (item) option.append(element('small', '', item.kind === 'note' ? item.path : tr(label('已导入附件', 'Imported attachment'))));
            list.append(option);
          });
          if (!items.length) list.append(element('div', 'note-database-suggestion-empty', tr(label('没有匹配文件', 'No matching files'))));
        } catch (error) {
          if (!controller.signal.aborted && draft.popup === popup && attachmentDraftCurrent(draft))
            announce(draft.session, tr(label('文件搜索失败，请重试。', 'Could not find files. Please try again.')));
        }
      };
      draft.suggestionTimer = setTimeout(load, query ? 150 : 0);
    }

    function leaveAttachmentEditor(draft, next) {
      if (draft.picker || draft.uploading || next === draft.input || draft.popup?.contains(next)) return;
      dismissSuggestions(draft);
      if (!draft.composition && !draft.error) void commitDraft(draft);
    }

    function editorFor(draft) {
      const { view, session, column, row } = draft;
      const attachment = column.type === 'attachment';
      const type = { date: 'date', number: 'number' }[column.type] || 'text';
      const field = column.type === 'text' ? element('textarea') : input(type, column.name);
      field.setAttribute('aria-label', column.name);
      field.value = attachment ? draft.term ?? draft.value?.name ?? '' : draft.value ?? '';
      if (field instanceof HTMLTextAreaElement) field.rows = 1;
      field.className = 'note-database-cell-input';
      field.dataset.dbType = column.type;
      if (type === 'number') field.step = 'any';
      draft.input = field;
      if (attachment) {
        field.setAttribute('role', 'combobox');
        field.setAttribute('aria-autocomplete', 'list');
        field.setAttribute('aria-expanded', 'false');
        field.setAttribute('aria-controls', 'note-database-suggestions-' + ++listSequence);
        field.placeholder = tr(label('搜索文件名', 'Find a file'));
        field.maxLength = 256;
      } else if (type === 'text') {
        field.maxLength = 4096;
      }
      const update = () => {
        if (attachment) {
          draft.term = field.value;
          suggestions(draft);
        } else {
          draft.value = field.value === '' ? null : type === 'number' ? field.valueAsNumber : field.value;
          draft.changed = true;
          notifyDirty();
        }
      };
      field.addEventListener('input', event => { if (!draft.composition && !composing(event)) update(); });
      if (type === 'date') field.addEventListener('change', () => {
        if (!draft.datePickerOpen) return;
        draft.datePickerOpen = false;
        if (draft.changed) void commitDraft(draft, null, true);
      });
      field.addEventListener('compositionstart', () => {
        dismissSuggestions(draft);
        draft.composition = new Promise(resolve => { draft.endComposition = resolve; });
        notifyDirty();
      });
      field.addEventListener('compositionend', () => {
        // The final input event can arrive after compositionend in WebView2.
        setTimeout(() => {
          draft.composition = null;
          if (session.draft === draft && draft.input === field) update();
          draft.endComposition?.();
          notifyDirty();
          if (!draft.error && session.draft === draft && document.activeElement !== field) {
            if (attachment) leaveAttachmentEditor(draft, document.activeElement);
            else void commitDraft(draft);
          }
        }, 0);
      });
      field.addEventListener('focus', () => { if (attachment && !draft.popup) suggestions(draft); });
      field.addEventListener('blur', event => {
        if (attachment) leaveAttachmentEditor(draft, event.relatedTarget);
        else if (!draft.composition && !draft.error) void commitDraft(draft);
      });
      field.addEventListener('keydown', event => {
        event.stopPropagation();
        if (type === 'date') draft.datePickerOpen = false;
        if (draft.composition || draft.uploading || draft.picker || composing(event)) return;
        if (attachment && draft.popup && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          selectSuggestion(draft, draft.suggestionIndex < 0 ? event.key === 'ArrowDown' ? 0 : -1
            : draft.suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1));
        } else if (event.key === 'Escape') {
          event.preventDefault();
          if (draft.popup) dismissSuggestions(draft);
          else abandonDraft(draft);
        } else if (event.key === 'Enter' || event.key === 'Tab') {
          if (event.key === 'Enter' && event.shiftKey && field instanceof HTMLTextAreaElement) return;
          if (attachment && draft.popup && draft.suggestionIndex >= 0) {
            event.preventDefault();
            pickAttachment(draft, draft.suggestionItems[draft.suggestionIndex]);
            return;
          }
          if (attachment && draft.popup && event.key === 'Tab' && !event.shiftKey) {
            const action = draft.popup.querySelector('.note-database-attachment-actions button:not(:disabled)');
            if (action) {
              event.preventDefault();
              action.focus({ preventScroll: true });
              return;
            }
          }
          const next = event.key === 'Tab' && adjacentCell(view, row, column, 'Tab', event.shiftKey);
          if (event.key === 'Enter' || next) event.preventDefault();
          void commitDraft(draft, next, event.key === 'Enter' || Boolean(next));
        }
      });
      return field;
    }

    function beginEdit(view, row, column, value, pointer) {
      const { session } = view;
      if (session.write || session.draft || !isVisible(session)) return;
      if (column.type === 'checkbox') {
        void saveCell(view, row, column, !row.values[column.id]);
        return;
      }
      const control = view.cells.get(row.id)?.get(column.id);
      const cell = control?.parentElement;
      if (!cell) return;
      if (choiceType(column.type)) { choiceEditor(view, control, row, column); return; }
      const draft = { session, view, row, column, value: row.values[column.id] ?? null, changed: false };
      if (value !== undefined && (column.type === 'text' || column.type === 'number' && /^\d$/.test(value))) {
        draft.value = column.type === 'number' ? Number(value) : value;
        draft.changed = true;
      }
      session.draft = draft;
      const field = editorFor(draft);
      cell.replaceChildren(field);
      view.cells.get(row.id).set(column.id, field);
      field.focus({ preventScroll: true });
      if (draft.changed) notifyDirty();
      else if (field instanceof HTMLTextAreaElement && pointer) {
        const offset = pointer.offset ?? field.value.length;
        field.setSelectionRange(offset, offset);
      } else if ('select' in field && ['textarea', 'text'].includes(field.type)) field.select();
      if (column.type === 'date' && pointer && field.showPicker) {
        try {
          field.showPicker();
          draft.datePickerOpen = true;
        } catch (_) { /* The focused native input still accepts dates. */ }
      }
    }

    function saveCell(view, row, column, value) {
      return write(view.session, { type: 'setCell', row: row.id, column: column.id, value,
        includeRow: view.pinned?.id === row.id });
    }

    async function openLink(view, row, column, value) {
      const session = view.session;
      const visiblyCurrent = () => view.host.isConnected && isVisible(session);
      try {
        if (value.kind === 'note') {
          const originalPage = session.page;
          const originalQuery = JSON.stringify(session.query);
          const page = await loadPage(session.path, session.databaseId, session.query, AbortSignal.timeout(10000));
          if (!visiblyCurrent() || session.write || session.page !== originalPage || JSON.stringify(session.query) !== originalQuery) return;
          const current = page.rows.find(item => item.id === row.id)?.values[column.id];
          if (JSON.stringify(originalPage) !== JSON.stringify(page)) applyPage(session, page);
          if (current?.exists && current.kind === 'note' && current.path === value.path) await options.onOpenNote?.(current.path);
        } else {
          await request('/api/open-external', { note: session.path, target: value.id, kind: 'note-database-attachment' });
        }
      } catch (error) {
        if (!visiblyCurrent()) return;
        if (error.status === 404) void refresh(session.path, false, session.databaseId);
        else options.onError?.(error);
      }
    }

    function cellControl(view, row, column) {
      const value = row.values[column.id];
      const choices = choiceType(column.type) ? selectedChoices(value, column) : null;
      const name = choices ? choices.map(option => option.name).join('、') : display(value, column, tr);
      const liveLink = column.type === 'attachment' && value?.exists;
      const interactive = !view.readOnly || liveLink;
      const control = interactive ? button(name, event => {
        const gesture = view.cellGesture;
        view.cellGesture = null;
        if (event.detail && gesture?.extended) return;
        const open = liveLink && (view.readOnly || event.ctrlKey || event.metaKey);
        const pointer = event.detail ? { offset: column.type === 'text' ? clickedTextOffset(control, event) : null } : null;
        void afterCellSave(view, () => {
          if (open) return openLink(view, row, column, value);
          if (!view.readOnly) {
            selectCell(view, [row.id, column.id], event.shiftKey, true);
            if (!(event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)) beginEdit(view, row, column, undefined, pointer);
          }
        });
      }) : element('span', '', name);
      control.className = 'note-database-cell-value' + (liveLink ? ' is-link' : '');
      control.dataset.dbType = column.type;
      control.setAttribute('aria-label', name ? column.name + ' · ' + name : column.name);
      if (name) control.title = name;
      if (!view.readOnly) control.tabIndex = -1;
      if (choices?.length) {
        const chips = element('span', 'note-database-choices');
        for (const option of choices) chips.append(choiceChip(option, column.type));
        control.replaceChildren(chips);
      } else if (column.type === 'checkbox') {
        control.setAttribute('role', 'checkbox');
        control.setAttribute('aria-checked', String(Boolean(value)));
        if (view.readOnly) control.setAttribute('aria-readonly', 'true');
        const mark = element('span', 'note-database-checkbox');
        mark.setAttribute('aria-hidden', 'true');
        if (value) mark.append(icon('check'));
        control.replaceChildren(mark);
      } else if (name && (column.type === 'date' || liveLink)) {
        const content = element('span', 'note-database-icon-value');
        content.append(icon(column.type === 'date' ? 'date' : 'file'), element('span', '', name));
        control.replaceChildren(content);
      }
      if (!interactive) return control;
      control.addEventListener('keydown', event => {
        if (view.readOnly || composing(event)) return;
        const mod = event.ctrlKey || event.metaKey;
        if (liveLink && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          void openLink(view, row, column, value);
        } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(event.key)) {
          const next = adjacentCell(view, row, column, event.key, event.shiftKey);
          if (!next && event.key === 'Tab') return;
          event.preventDefault();
          event.stopPropagation();
          if (next) selectCell(view, next, event.shiftKey && event.key !== 'Tab', true, true);
        } else if (event.key === 'Backspace' || event.key === 'Delete') {
          clipboard(view, event, true);
        } else if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
          event.preventDefault(); event.stopPropagation();
          const menu = view.rowEntries.get(row.id)?.menu;
          if (menu) showRowMenu(view, menu, row);
        } else if (event.key === 'Escape') {
          selectCell(view, [row.id, column.id], false, true);
          event.stopPropagation();
        } else if (event.key === 'Enter' || (!mod && !event.altKey && [...event.key].length === 1)) {
          event.preventDefault();
          event.stopPropagation();
          const literal = event.key === 'Enter' ? undefined : event.key;
          beginEdit(view, row, column, literal);
        }
      });
      if (!view.readOnly) {
        control.addEventListener('focus', () => {
          if (!sameCell(view.selection?.head, [row.id, column.id])) selectCell(view, [row.id, column.id], false, false);
        });
        control.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          view.cellGesture = null;
          if (event.ctrlKey || event.metaKey) return;
          view.cellGesture = { id: event.pointerId, start: [row.id, column.id] };
          selectCell(view, [row.id, column.id], event.shiftKey, false);
        });
        control.addEventListener('pointerenter', event => {
          const gesture = view.cellGesture, target = [row.id, column.id];
          if (!gesture || gesture.ended || gesture.id !== event.pointerId || event.pointerType === 'touch' || event.buttons !== 1) return;
          if (!sameCell(gesture.start, target)) gesture.extended = true;
          if (gesture.extended) selectCell(view, target, true, true);
        });
      }
      return control;
    }

    function changeQuery(session, patch, delay = 0) {
      stopRead(session);
      session.readFailed = false;
      for (const view of session.views) view.pinned = null;
      Object.assign(session.query, { page: 1 }, patch);
      session.stale = true;
      syncCharts(session);
      if (delay) session.timer = setTimeout(() => { session.timer = 0; void read(session); }, delay);
      else void read(session);
    }

    function panelAt(view, anchor, kind, content, { name, returnFocus } = {}) {
      const same = view.panel?.kind === kind && view.panel.anchor === anchor;
      view.panel?.close();
      if (same || !anchor?.isConnected) return;
      const panel = element('div', 'note-database-panel');
      const surface = element('div', 'note-database-panel-content');
      const choicesPortal = element('div', 'note-database-choice-portal');
      panel.append(surface, choicesPortal);
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', name || anchor.getAttribute('aria-label') || anchor.textContent);
      if (panel.showPopover) panel.setAttribute('popover', 'manual');
      const controller = new AbortController();
      const choices = window.RelatumReviewControls?.createManager(surface, choicesPortal);
      const close = (restore = false) => {
        controller.abort();
        choices?.dispose();
        panel.remove();
        if (anchor.hasAttribute('aria-haspopup')) anchor.setAttribute('aria-expanded', 'false');
        if (view.panel?.close === close) view.panel = null;
        if (restore && anchor.isConnected) (returnFocus?.() || anchor).focus({ preventScroll: true });
      };
      view.panel = { anchor, kind, close, choices };
      const initial = content(surface, close, { popup: panel, portal: choicesPortal, signal: controller.signal });
      view.root.append(panel);
      if (anchor.hasAttribute('aria-haspopup')) anchor.setAttribute('aria-expanded', 'true');
      panel.showPopover?.();
      const rect = anchor.getBoundingClientRect(), width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      panel.style.left = Math.max(8, Math.min(rect.left, width - panel.offsetWidth - 8)) + 'px';
      const top = rect.bottom + panel.offsetHeight + 8 > height && rect.top > height - rect.bottom;
      surface.style.maxHeight = Math.max(80, Math.min(384, top ? rect.top - 12 : height - rect.bottom - 12)) + 'px';
      if (top) panel.style.bottom = height - rect.top + 4 + 'px';
      else panel.style.top = rect.bottom + 4 + 'px';
      const { signal } = controller;
      document.addEventListener('pointerdown', event => {
        if (!panel.contains(event.target) && !anchor.contains(event.target)) close();
      }, { signal });
      document.addEventListener('scroll', event => {
        if (anchorMoved(anchor, rect, event.target)) close();
      }, { signal, capture: true, passive: true });
      window.addEventListener('resize', close.bind(null, false), { signal });
      panel.addEventListener('keydown', event => {
        if (composing(event)) return;
        if (event.key === 'Escape') { event.stopPropagation(); close(true); return; }
        if (event.target.closest('.review-choice-trigger') || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        if (event.target.closest('input,textarea,select') && (kind !== 'addColumn' || event.key !== 'ArrowDown')) return;
        const buttons = Array.from(surface.querySelectorAll('button:not(:disabled):not(.review-choice-trigger):not(.note-database-choice-more)'))
          .filter(button => !button.closest('[hidden]'));
        if (!buttons.length) return;
        const current = document.activeElement.classList.contains('note-database-choice-more')
          ? document.activeElement.parentElement.querySelector('[data-choice]') : document.activeElement;
        const index = buttons.indexOf(current);
        const next = index < 0 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault(); event.stopPropagation(); buttons[next].focus();
      });
      choices?.enhanceAll();
      const focus = initial instanceof HTMLSelectElement ? choices?.enhance(initial).anchor || initial : initial;
      (focus || surface.querySelector('button,input,select'))?.focus({ preventScroll: true });
    }

    function addColumn(view, anchor) {
      panelAt(view, anchor, 'addColumn', (panel, close) => {
        const name = input('text', tr(label('字段名称', 'Field name')));
        name.placeholder = tr(label('字段名称（可选）', 'Field name (optional)'));
        name.maxLength = 120;
        const types = element('div', 'note-database-types');
        for (const [type, names] of Object.entries(columnTypes)) {
          const option = button(tr(names), () => {
            const base = tr(names);
            const namesInUse = new Set(view.session.page.columns.map(column => column.name.toLocaleLowerCase()));
            let generated = base, number = 2;
            while (namesInUse.has(generated.toLocaleLowerCase())) generated = base + ' ' + number++;
            close(true);
            void write(view.session, { type: 'addColumn', name: name.value.trim() || generated,
              columnType: type, language: options.language?.() });
          }, 'type-' + type);
          option.prepend(typeIcon(type));
          types.append(option);
        }
        panel.append(name, types);
        return name;
      });
    }

    function moveColumn(view, source, target, side) {
      const columns = view.session.page.columns;
      const visible = shownColumns(view.session.page).map(column => column.id);
      if (source === target || !visible.includes(source) || !visible.includes(target)) return;
      const moved = visible.filter(id => id !== source);
      moved.splice(moved.indexOf(target) + Number(side === 'after'), 0, source);
      if (moved.every((id, index) => id === visible[index])) return;
      let next = 0;
      const order = columns.map(column => column.hidden ? column.id : moved[next++]);
      return write(view.session, { type: 'columnLayout', column: source, order });
    }

    function choiceEditor(view, anchor, row, column) {
      const cell = anchor.parentElement;
      const { session } = view;
      panelAt(view, cell, 'cellChoices', (panel, close, parent) => {
        const multi = column.type === 'multiSelect';
        const configurable = column.type !== 'status';
        const search = input('text', tr(label('搜索选项', 'Search options')));
        search.placeholder = tr(label('搜索或创建选项', 'Search or create an option'));
        search.maxLength = 120;
        const list = element('div', 'note-database-choice-list');
        const latest = () => session.page.columns.find(field => field.id === column.id);
        const alive = () => panel.isConnected && isVisible(session);
        const selection = () => {
          const value = visibleRows(view).find(record => record.id === row.id)?.values[column.id];
          return new Set(multi ? value || [] : value ? [value] : []);
        };
        let busy = false, optionMenu = null;
        parent.signal.addEventListener('abort', () => optionMenu?.close(), { once: true });
        const save = async (action, focusId) => {
          if (busy || session.write || !alive()) return;
          busy = true;
          panel.setAttribute('aria-busy', 'true');
          for (const item of panel.querySelectorAll('button')) item.disabled = true;
          const page = await write(session, action);
          busy = false;
          if (!alive()) return;
          panel.removeAttribute('aria-busy');
          if (!page) {
            for (const item of panel.querySelectorAll('button')) item.disabled = false;
            if (list.isConnected) listView();
            else panel.querySelector('input')?.focus();
            return;
          }
          if (!multi && ['setCell', 'createChoiceValue'].includes(action.type)) { close(true); return; }
          listView(focusId);
        };
        const setValue = (value, focusId) => save({ type: 'setCell', row: row.id, column: column.id, value,
          includeRow: view.pinned?.id === row.id }, focusId);
        const updateChoices = (choices, clearRemoved = false) => ({ type: 'setChoices', column: column.id, choices, clearRemoved });
        const fold = text => text.trim().normalize('NFC').toLowerCase();
        function listView(focusId, focusMore = false) {
          optionMenu?.close();
          if (search.parentNode !== panel && configurable) panel.replaceChildren(search, list);
          else if (list.parentNode !== panel) panel.replaceChildren(list);
          const options = latest()?.choices || [];
          const selected = selection();
          const term = configurable ? fold(search.value) : '';
          const entries = [];
          let target;
          for (const option of options) {
            if (!fold(option.name).includes(term)) continue;
            const entry = element('div', 'note-database-choice-row');
            const item = button('', () => {
              if (!multi) { void setValue(option.id, option.id); return; }
              const next = selection();
              if (!next.delete(option.id)) next.add(option.id);
              void setValue(Array.from(next), option.id);
            });
            item.className = 'note-database-menu-option';
            item.dataset.choice = option.id;
            item.append(choiceChip(option, column.type), icon('check'));
            item.setAttribute('aria-pressed', String(selected.has(option.id)));
            entry.append(item);
            let more;
            if (configurable) {
              more = iconButton('more', tr(label('编辑选项', 'Edit option')) + ' · ' + option.name, () => editOption(option, more));
              more.classList.add('note-database-choice-more');
              more.setAttribute('aria-haspopup', 'dialog');
              more.setAttribute('aria-expanded', 'false');
              entry.append(more);
            }
            entries.push(entry);
            if (option.id === focusId) target = focusMore ? more : item;
          }
          if (term && !options.some(option => fold(option.name) === term)) {
            const create = button(tr(label(`创建「${search.value.trim()}」`, `Create “${search.value.trim()}”`)), () => {
              void save({ type: 'createChoiceValue', row: row.id, column: column.id, name: search.value.trim(),
                includeRow: view.pinned?.id === row.id });
            }, 'create-choice');
            entries.push(create);
          }
          if (!entries.length && configurable) entries.push(element('div', 'note-database-choice-empty', tr(label('输入名称以创建选项', 'Type a name to create an option'))));
          if (selected.size) entries.push(button(tr(label('清空', 'Clear')), () => setValue(null)));
          list.replaceChildren(...entries);
          if (busy) for (const item of list.querySelectorAll('button')) item.disabled = true;
          if (focusId || !panel.contains(document.activeElement)) (target || (configurable ? search : list.querySelector('button')))?.focus({ preventScroll: true });
        }

        function editOption(option, trigger) {
          if (optionMenu?.trigger === trigger) { optionMenu.close(true); return; }
          optionMenu?.close();
          const submenu = element('div', 'note-database-panel note-database-option-menu');
          submenu.setAttribute('role', 'dialog');
          submenu.setAttribute('aria-label', tr(label('编辑选项', 'Edit option')));
          const content = element('div', 'note-database-panel-content');
          submenu.append(content);
          const events = new AbortController();
          const { signal } = events;
          let committed = latest()?.choices.find(item => item.id === option.id);
          if (!committed) { listView(); return; }
          const name = input('text', tr(label('选项名称', 'Option name')), committed.name);
          name.maxLength = 120;
          const header = element('div', 'note-database-option-heading');
          const tones = element('div', 'note-database-choice-tones');
          tones.setAttribute('role', 'group');
          tones.setAttribute('aria-label', tr(label('颜色', 'Colors')));
          const message = element('div', 'note-database-option-error');
          message.hidden = true;
          const topLayer = typeof submenu.showPopover === 'function';
          let compact = false;
          const closeMenu = (restore = false) => {
            events.abort();
            submenu.remove();
            panel.inert = false;
            panel.classList.remove('note-database-options-covered');
            trigger.setAttribute('aria-expanded', 'false');
            if (optionMenu?.trigger === trigger) optionMenu = null;
            if (restore && alive()) listView(option.id, true);
          };
          optionMenu = { trigger, close: closeMenu };
          trigger.setAttribute('aria-expanded', 'true');

          function place() {
            const bounds = parent.popup.getBoundingClientRect();
            const anchor = trigger.getBoundingClientRect();
            const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
            const edge = 8, gap = 5;
            submenu.style.width = '';
            const sideWidth = submenu.offsetWidth;
            const fitsRight = bounds.right + gap + sideWidth <= width - edge;
            const fitsLeft = bounds.left - gap - sideWidth >= edge;
            compact = !fitsRight && !fitsLeft;
            panel.inert = compact;
            panel.classList.toggle('note-database-options-covered', compact);
            submenu.dataset.placement = compact ? 'over' : fitsRight ? 'right' : 'left';
            if (compact) submenu.style.width = Math.min(parent.popup.offsetWidth, width - 2 * edge) + 'px';
            content.style.maxHeight = Math.max(0, height - 2 * edge - 2) + 'px';
            const left = compact ? Math.max(edge, Math.min(bounds.left, width - submenu.offsetWidth - edge))
              : fitsRight ? bounds.right + gap : bounds.left - gap - sideWidth;
            const top = Math.max(edge, Math.min(compact ? bounds.top : anchor.top - gap, height - submenu.offsetHeight - edge));
            const base = topLayer ? { left: 0, top: 0 } : bounds;
            submenu.style.left = left - base.left + 'px';
            submenu.style.top = top - base.top + 'px';
          }

          const showColors = () => {
            for (const swatch of tones.children) swatch.setAttribute('aria-pressed', String(swatch.dataset.color === committed.tone));
            const chip = trigger.parentElement.querySelector('.note-database-choice');
            if (chip) { chip.dataset.dbTone = committed.tone; chip.textContent = committed.name; }
          };
          async function writeOption(patch) {
            if (busy || session.write || signal.aborted || !alive()) return;
            const choices = latest()?.choices;
            const current = choices?.find(item => item.id === option.id);
            if (!current) { closeMenu(true); return; }
            if (Object.keys(patch).every(key => patch[key] === current[key])) {
              if (name.value.trim() === committed.name) closeMenu(true);
              return;
            }
            const active = document.activeElement;
            busy = true;
            submenu.setAttribute('aria-busy', 'true');
            message.hidden = true;
            for (const item of submenu.querySelectorAll('button')) item.disabled = true;
            const beforeName = committed.name;
            const page = await write(session, updateChoices(choices.map(item => item.id === option.id ? { ...item, ...patch } : item)));
            const error = session.status;
            if (!page && !signal.aborted) await session.readDone;
            busy = false;
            if (signal.aborted || !alive()) {
              if (page && alive() && !optionMenu) listView();
              return;
            }
            submenu.removeAttribute('aria-busy');
            for (const item of submenu.querySelectorAll('button')) item.disabled = false;
            const saved = (page?.columns?.find(field => field.id === column.id) || latest())?.choices.find(item => item.id === option.id);
            if (!saved) { closeMenu(true); return; }
            committed = saved;
            showColors();
            const draft = name.value.trim();
            if (!page) {
              if (draft === beforeName) name.value = committed.name;
              message.textContent = error || tr(label('操作失败，请重试。', 'Could not save. Please try again.'));
              message.hidden = false;
              place();
              active?.focus({ preventScroll: true });
            } else if (draft === (patch.name ?? beforeName)) closeMenu(true);
            else active?.focus({ preventScroll: true });
          }
          const rename = () => {
            const value = name.value.trim();
            if (!value) { name.focus(); return; }
            void writeOption({ name: value });
          };
          for (const [color, names] of Object.entries(choiceTones)) {
            const swatch = button('', () => void writeOption({ tone: color }));
            const square = element('span', 'note-database-color-square');
            square.dataset.dbTone = color;
            square.setAttribute('aria-hidden', 'true');
            swatch.dataset.color = color;
            swatch.append(square, element('span', '', tr(names)), icon('check'));
            tones.append(swatch);
          }
          const remove = button(tr(label('删除选项', 'Delete option')), async () => {
            const revision = session.page.revision;
            close(true);
            if (!await confirmEdit(view, label('删除此选项会清除整列对它的引用。继续？', 'Delete this option and clear all its references in this field?'))) return;
            if (session.page.revision !== revision) {
              announce(session, tr(label('选项已变化，请重新打开菜单确认。', 'Options changed. Reopen the menu to confirm.')));
              return;
            }
            await write(session, updateChoices(latest().choices.filter(item => item.id !== option.id), true));
          });
          remove.className = 'note-database-option-delete';
          remove.prepend(icon('trash'));
          header.append(iconButton('prev', tr(label('返回选项', 'Back to options')), () => closeMenu(true)),
            name, iconButton('check', tr(label('保存名称', 'Save name')), rename));
          content.append(header, remove, element('div', 'note-database-option-color-heading', tr(label('颜色', 'Colors'))), tones, message);
          showColors();
          if (topLayer) submenu.setAttribute('popover', 'manual');
          else submenu.classList.add('note-database-option-menu-fallback');
          parent.portal.append(submenu);
          submenu.showPopover?.();
          place();
          document.addEventListener('pointerdown', event => {
            if (!submenu.contains(event.target) && !trigger.contains(event.target)) closeMenu();
          }, { signal });
          panel.addEventListener('scroll', () => {
            if (compact) return;
            const anchor = trigger.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
            if (anchor.bottom <= bounds.top || anchor.top >= bounds.bottom) closeMenu();
            else place();
          }, { signal, passive: true });
          submenu.addEventListener('keydown', event => {
            if (composing(event)) return;
            if (event.key === 'Escape') {
              event.preventDefault(); event.stopPropagation(); closeMenu(true);
            } else if (event.key === 'Enter' && event.target === name) {
              event.preventDefault(); event.stopPropagation(); rename();
            } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
              if (event.target === name && event.key !== 'ArrowDown') return;
              const buttons = Array.from(tones.children);
              if (!tones.contains(event.target) && event.target !== name) return;
              const index = buttons.indexOf(event.target);
              const next = event.key === 'Home' || index < 0 ? 0 : event.key === 'End' ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
              event.preventDefault(); event.stopPropagation(); buttons[next].focus();
            } else if (event.key === 'Tab') {
              const controls = Array.from(submenu.querySelectorAll('input:not(:disabled),button:not(:disabled)'));
              const edge = event.shiftKey ? controls[0] : controls.at(-1);
              if (event.target === edge) {
                event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0]).focus();
              }
            }
          }, { signal });
          name.focus({ preventScroll: true });
          name.select();
        }

        search.addEventListener('input', event => { if (!composing(event)) listView(); });
        search.addEventListener('compositionend', () => listView());
        search.addEventListener('keydown', event => {
          if (composing(event) || !['Enter', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const first = list.querySelector('button');
          if (event.key === 'ArrowDown') first?.focus();
          else {
            const exact = latest().choices.find(option => fold(option.name) === fold(search.value));
            const target = exact ? list.querySelector('[data-choice="' + exact.id + '"]')
              : search.value.trim() ? list.querySelector('[data-db-role="create-choice"]') : first;
            target?.click();
          }
        });
        listView();
        return configurable ? search : list.querySelector('button');
      }, { name: column.name, returnFocus: () => view.cells.get(row.id)?.get(column.id) });
    }

    function editChoices(view, anchor, column) {
      panelAt(view, anchor, 'fieldChoices', (panel, close) => {
        const list = element('div', 'note-database-option-list');
        const fields = new Map();
        const add = option => {
          const row = element('div', 'note-database-form');
          const name = input('text', tr(label('选项名称', 'Option name')), option?.name);
          name.maxLength = 120;
          const remove = iconButton('×', tr(label('移除选项', 'Remove option')), () => {
            fields.delete(name); row.remove();
          });
          fields.set(name, option?.id);
          row.append(name, remove); list.append(row);
          return name;
        };
        for (const option of column.choices || []) add(option);
        panel.append(list, button(tr(label('＋ 选项', '+ Option')), () => add().focus()));
        panel.append(button(tr(label('保存选项', 'Save options')), async () => {
          const choices = Array.from(fields, ([field, id]) => ({ id, name: field.value.trim() })).filter(option => option.name);
          const removed = column.choices?.some(option => !choices.some(item => item.id === option.id));
          if (removed) {
            close(true);
            if (!await confirmEdit(view, label('移除选项会清除记录中对应的值。继续？', 'Removing options clears their values in records. Continue?'))) return;
          }
          if (await write(view.session, { type: 'setChoices', column: column.id, choices, clearRemoved: !!removed })) close(true);
        }));
        return fields.keys().next().value;
      });
    }

    function iconButton(symbol, name, action, role) {
      const node = button('', action, role);
      node.className = 'note-database-icon';
      node.dataset.glyph = symbol;
      node.title = name;
      node.setAttribute('aria-label', name);
      if (iconPaths[symbol]) node.append(icon(symbol));
      return node;
    }

    function columnMenu(view, anchor, column) {
      panelAt(view, anchor, 'column', (panel, close) => {
        const { session } = view, columns = shownColumns(session.page), index = columns.findIndex(item => item.id === column.id);
        const name = input('text', tr(label('字段名称', 'Field name')), column.name);
        name.maxLength = 120;
        const rename = () => {
          const value = name.value.trim();
          close(true);
          if (value && value !== column.name) void write(session, { type: 'renameColumn', column: column.id, name: value });
        };
        name.addEventListener('keydown', event => { if (!composing(event) && event.key === 'Enter') rename(); });
        panel.append(name, button(tr(label('重命名', 'Rename')), rename));
        if (choiceType(column.type)) panel.append(button(tr(label('管理选项', 'Manage options')), () => { close(); editChoices(view, anchor, column); }));
        if (column.type === 'number') panel.append(button(tr(label('数字格式', 'Number format')), () => {
          close();
          openNumberFormat(view, anchor, column);
        }, 'number-format'));
        for (const [offset, msg] of [[-1, label('左移', 'Move left')], [1, label('右移', 'Move right')]]) {
          const item = button(tr(msg), () => { close(true); void moveColumn(view, column.id, columns[index + offset]?.id, offset < 0 ? 'before' : 'after'); });
          item.disabled = !columns[index + offset];
          panel.append(item);
        }
        const hide = button(tr(label('隐藏字段', 'Hide field')), () => { close(); void write(session, { type: 'columnLayout', column: column.id, hidden: true }); });
        const remove = button(tr(label('删除字段', 'Delete field')), async () => {
          close(true);
          if (await confirmEdit(view, label('删除这一列及其中的值？', 'Delete this field and its values?'))) {
            void write(session, { type: 'deleteColumn', column: column.id });
          }
        });
        hide.disabled = remove.disabled = columns.length <= 1;
        panel.append(hide, remove);
      });
    }

    function openNumberFormat(view, anchor, column) {
      panelAt(view, anchor, 'number-format', (panel, close, { signal }) => {
        const current = column.numberFormat || {};
        const form = element('form', 'note-database-chart-form');
        const field = (names, control) => {
          const wrapper = element('label');
          wrapper.append(element('span', '', tr(names)), control);
          form.append(wrapper);
          return control;
        };
        const styles = label('显示方式', 'Display as');
        const style = field(styles, select(tr(styles), [['number', tr(label('数字', 'Number'))],
          ['percent', tr(label('百分比（0.5 显示为 50%）', 'Percentage (0.5 displays as 50%)'))]], current.percent ? 'percent' : 'number'));
        const units = label('单位后缀', 'Unit suffix');
        const unit = field(units, input('text', tr(units), current.unit));
        unit.maxLength = 16;
        const precision = label('小数位数', 'Decimal places');
        field(precision, select(tr(precision), [['', tr(label('自动', 'Automatic'))],
          ...Array.from({ length: 9 }, (_, value) => [String(value), String(value)])], String(current.decimals ?? '')));
        const decimals = form.lastElementChild.querySelector('select');
        const toggle = () => {
          unit.parentElement.hidden = style.value === 'percent';
        };
        style.addEventListener('change', toggle);
        toggle();
        const actions = element('div', 'note-database-chart-actions');
        const save = element('button', 'note-database-chart-confirm', tr(label('确定', 'Confirm')));
        save.type = 'submit';
        actions.append(button(tr(label('取消', 'Cancel')), () => close(true)), save);
        form.append(actions);
        form.addEventListener('submit', async event => {
          event.preventDefault();
          if (save.disabled) return;
          save.disabled = true;
          const percent = style.value === 'percent';
          const format = { percent, unit: percent ? '' : unit.value, decimals: decimals.value === '' ? null : Number(decimals.value) };
          if (await write(view.session, { type: 'setNumberFormat', column: column.id, format })) close(true);
          else if (!signal.aborted) save.disabled = false;
        });
        panel.append(form);
        return style;
      }, { name: tr(label('数字格式', 'Number format')) });
    }

    async function confirmEdit(view, message) {
      const current = () => view.root.isConnected && isVisible(view.session);
      return current() && (options.confirmEdit ? await options.confirmEdit(message, current) : window.confirm(tr(message))) && current();
    }

    function filterForm(view, container, index, query = view.session.query, applyFilters) {
      const { page } = view.session;
      const applyRules = applyFilters || (filters => {
        view.panel?.close(true);
        changeQuery(view.session, { filters });
      });
      const panel = element('form', 'note-database-form');
      const current = query.filters[index];
      const column = select(tr(label('筛选列', 'Filter column')), page.columns.map(item => [item.id, item.name]),
        current?.column || page.columns[0]?.id);
      const operators = {
        text: ['contains', 'equals', 'empty', 'notEmpty'], number: ['equals', 'gt', 'lt', 'empty', 'notEmpty'],
        date: ['equals', 'gt', 'lt', 'empty', 'notEmpty'], checkbox: ['equals', 'empty', 'notEmpty'],
        attachment: ['contains', 'empty', 'notEmpty'], select: ['equals', 'empty', 'notEmpty'],
        multiSelect: ['contains', 'empty', 'notEmpty'], status: ['equals', 'empty', 'notEmpty'],
      };
      const operator = select(tr(label('筛选条件', 'Filter condition')), [], '');
      const valueHost = element('span');
      let value;
      function showValue(initial) {
        valueHost.replaceChildren();
        value = null;
        if (operator.value === 'empty' || operator.value === 'notEmpty') {
          if (panel.isConnected) view.panel?.choices?.enhanceAll();
          return;
        }
        const selected = page.columns.find(item => item.id === column.value);
        const type = selected?.type;
        const name = tr(label('筛选值', 'Filter value'));
        value = choiceType(type) ? select(name, (selected.choices || []).map(item => [item.id, item.name]), initial ?? selected.choices?.[0]?.id)
          : type === 'checkbox' ? select(name, [['true', tr(label('已勾选', 'Checked'))], ['false', tr(label('未勾选', 'Unchecked'))]], String(initial ?? true))
          : input({ date: 'date', number: 'number' }[type] || 'text', name, initial);
        if (type === 'number') value.step = 'any';
        value.required = true;
        if (value instanceof HTMLInputElement) value.placeholder = name;
        valueHost.append(value);
        if (panel.isConnected) view.panel?.choices?.enhanceAll();
      }
      function showOperators(initial) {
        operator.replaceChildren();
        const type = page.columns.find(item => item.id === column.value)?.type;
        for (const key of operators[type] || []) operator.add(new Option(tr(filterNames[key]), key));
        if (initial) operator.value = initial.operator;
        showValue(initial?.value);
        if (panel.isConnected) view.panel?.choices?.refresh(operator);
      }
      column.addEventListener('change', () => showOperators());
      operator.addEventListener('change', () => showValue());
      showOperators(current);
      const apply = element('button', '', tr(label('应用筛选', 'Apply filter')));
      apply.type = 'submit';
      panel.append(column, operator, valueHost, apply, button(tr(label('移除条件', 'Remove rule')), () => {
        applyRules(query.filters.filter((_, position) => position !== index));
      }));
      panel.addEventListener('submit', event => {
        event.preventDefault();
        const type = page.columns.find(item => item.id === column.value)?.type;
        const raw = value?.value ?? null;
        const filterValue = raw === null ? null : type === 'number' ? Number(raw) : type === 'checkbox' ? raw === 'true' : raw;
        const filters = query.filters.slice();
        filters[index] = { column: column.value, operator: operator.value, value: filterValue };
        applyRules(filters);
      });
      container.append(panel);
      view.panel?.choices?.enhanceAll();
      (view.panel?.choices?.enhance(column).anchor || column).focus();
    }

    function renameTrigger(role, activate) {
      const trigger = button('', event => { if (!event.detail) void activate(trigger); }, role);
      trigger.addEventListener('dblclick', () => void activate(trigger));
      return trigger;
    }

    function renamePanel(view, anchor, kind, title, fieldName, initial, action) {
      panelAt(view, anchor, kind, (panel, close, { signal }) => {
        const { session } = view;
        const field = input('text', tr(fieldName), initial);
        field.maxLength = 120;
        const status = element('p', 'note-database-chart-notice');
        status.setAttribute('role', 'alert');
        status.hidden = true;
        const saveButton = button(tr(label('保存名称', 'Save name')), () => void save());
        const save = async () => {
          const name = field.value.trim();
          if (saveButton.disabled || session.write || !name) return;
          if (name === initial) { close(true); return; }
          status.hidden = true;
          saveButton.disabled = true;
          field.readOnly = true;
          const saved = await write(session, { ...action, name });
          if (signal.aborted) return;
          if (saved) { close(true); return; }
          saveButton.disabled = false;
          field.readOnly = false;
          status.textContent = session.status || tr(label('名称保存失败，请重试。', 'Could not save the name. Try again.'));
          status.hidden = false;
          field.focus({ preventScroll: true });
        };
        field.addEventListener('keydown', event => {
          if (event.key === 'Enter' && !composing(event)) { event.preventDefault(); void save(); }
        });
        panel.append(field, saveButton, status);
        return field;
      }, { name: tr(title) });
    }

    function renameDatabase(view, anchor) {
      renamePanel(view, anchor, 'renameDatabase', label('重命名数据库', 'Rename database'),
        label('数据库名称', 'Database name'), view.session.page.name, { type: 'renameDatabase' });
    }

    function renameChart(card, anchor) {
      const { owner, model } = card;
      renamePanel(owner, anchor, 'chart-rename', label('重命名图表', 'Rename chart'),
        label('图表名称', 'Chart name'), chartTitle(model, tr),
        { type: 'setChartCard', operation: 'rename', chartId: model.id });
    }

    async function deleteCurrentTable(view) {
      const { session } = view;
      if (session.deleting || session.draft || session.write || !session.page?.exists || !isVisible(session)) return;
      const { path, databaseId } = session;
      const { name, revision } = session.page;
      session.deleting = true;
      try {
        if (!await confirmEdit(view, label(`永久删除「${name}」及其字段和记录？`, `Permanently delete “${name}” and its fields and records?`))) return;
        if (!isVisible(session) || !view.host.isConnected || session.path !== path) return;
        await deleteTables(path, { type: 'deleteTables', tables: [{ id: databaseId, revision }] });
      } catch (error) {
        if (session.path === path && isVisible(session)) {
          if (error.status === 409) void refresh(path, true, databaseId);
          options.onError?.(error);
        }
      } finally {
        session.deleting = false;
      }
    }

    function openChartPalette(card, anchor) {
      const view = card.owner;
      const palette = window.RelatumNoteChartPalette;
      if (!palette || !card.model.valid) return;
      panelAt(view, anchor, 'chart-palette', (panel, close, { signal }) => {
        const { session } = view;
        const current = card.model;
        const chart = current.chart;
        const ring = chart.type === 'doughnut';
        const bar = chart.type === 'column' || chart.type === 'bar' || !!chart.seriesBy;
        const categoryField = chart.seriesBy || chart.groupBy;
        const groupType = session.page.columns.find(column => column.id === categoryField)?.type;
        const english = (options.language?.() || 'zh').startsWith('en');
        const dates = groupType === 'date' ? palette.dateFormatter(chart.bucket, english) : null;
        const groupName = point => dates ? dates.format(Date.parse(`${point.key}T00:00:00Z`))
          : palette.categoryLabel(point, groupType, english);
        const copy = (style = {}) => ({ ...style, categories: { ...style.categories } });
        let draft = copy(current.style), revision = current.styleRevision, target = null, saving = false;
        let categoryGroups, rows = [], tone = palette.swatchTone(draft.primary) || 'light';

        const form = element('form', 'note-database-chart-form note-database-color-form');
        const preset = select(tr(label('配色预设', 'Color preset')),
          [['', tr(label('跟随笔记设置', 'Follow note settings'))], ...palette.presets.map(([id, names]) => [id, tr(names)])], draft.palette || '');
        preset.dataset.dbRole = 'chart-palette-preset';
        const presetRow = element('label');
        presetRow.append(element('span', '', tr(label('配色预设', 'Color preset'))), preset);
        const sample = element('div', 'note-database-color-preview');
        sample.setAttribute('aria-hidden', 'true');
        let sampleChips = [];

        const mainColor = tr(label('主色', 'Main color'));
        const targetName = tr(label('配色对象', 'Color target'));
        const targetSelect = bar ? select(targetName, [['', mainColor]], '') : null;
        if (targetSelect) {
          const targetRow = element('label');
          targetRow.append(element('span', '', targetName), targetSelect);
          form.append(presetRow, sample, targetRow);
          view.panel?.choices?.enhance(targetSelect, { searchable: true });
        } else form.append(presetRow, sample);

        const picker = element('div', 'note-database-color-picker');
        const pickerLabel = element('strong', '', mainColor);
        const toneControls = element('div', 'note-database-color-tones');
        toneControls.setAttribute('role', 'group');
        toneControls.setAttribute('aria-label', tr(label('色彩深浅', 'Color shade')));
        if (!bar) picker.append(pickerLabel);
        picker.append(toneControls);
        const categories = element('div', 'note-database-color-categories');
        const status = element('div', 'note-database-option-error');
        status.setAttribute('role', 'status');
        status.hidden = true;

        function setChip(node, light, dark) {
          node.style.setProperty('--chart-chip-light', light);
          node.style.setProperty('--chart-chip-dark', dark);
        }
        const automatic = button(tr(label('自动', 'Automatic')), () => chooseColor(null), 'chart-color-auto');
        toneControls.append(automatic);
        const swatchGroups = palette.swatchGroups.map(({ tone: group, label: names, swatches }) => {
          const control = button(tr(names), () => { tone = group; refreshPicker(); }, 'chart-color-tone');
          toneControls.append(control);
          const grid = element('div', 'note-database-color-swatches');
          const buttons = swatches.map(([id, names]) => {
            const swatch = button('', () => chooseColor(id), 'chart-color-swatch');
            swatch.dataset.swatch = id;
            swatch.title = tr(names); swatch.setAttribute('aria-label', swatch.title);
            const chip = element('i', 'note-database-color-chip');
            setChip(chip, palette.swatchColor(id, false), palette.swatchColor(id, true));
            swatch.append(chip);
            grid.append(swatch);
            return [id, swatch];
          });
          picker.append(grid);
          return { group, control, grid, buttons };
        });
        categories.hidden = true;

        function selectTarget(key) {
          target = key || null;
          tone = palette.swatchTone(target ? draft.categories[target] : draft.primary) || 'light';
          refreshColors();
        }
        targetSelect?.addEventListener('change', () => { if (!saving) selectTarget(targetSelect.value); });

        function syncCategories(groups) {
          if (groups === categoryGroups) return;
          categoryGroups = groups;
          const available = (groups || []).filter(point => point.colorKey &&
            (point.values ? Object.values(point.values).some(Number.isFinite) : Number.isFinite(point.value)));
          if (target && !available.some(point => point.colorKey === target)) target = null;
          if (targetSelect) {
            const entries = [{ value: '', label: mainColor }, ...available.map(point => ({ value: point.colorKey, label: groupName(point) }))];
            const choices = view.panel?.choices;
            if (choices) choices.setOptions(targetSelect, entries, target || '');
            else {
              targetSelect.replaceChildren(...entries.map(({ value, label }) => new Option(label, value)));
              targetSelect.value = target || '';
            }
            refreshPicker();
            return;
          }
          rows = available.map(point => {
            const name = groupName(point);
            const row = button('', () => {
              if (saving) return;
              pickerLabel.textContent = name;
              selectTarget(point.colorKey);
              automatic.focus({ preventScroll: true });
            }, 'chart-color-category');
            const chip = element('i', 'note-database-color-chip');
            row.append(chip, element('span', '', name));
            return { point, name, row, chip };
          });
          const selected = rows.find(({ point }) => point.colorKey === target);
          if (selected) pickerLabel.textContent = selected.name;
          else target = null;
          categories.replaceChildren(...rows.map(({ row }) => row));
          categories.hidden = !rows.length;
          refreshColors();
        }

        function refreshPicker() {
          picker.hidden = ring && !target;
          const selected = target ? draft.categories[target] : draft.primary;
          automatic.setAttribute('aria-pressed', String(!selected));
          for (const { group, control, grid, buttons } of swatchGroups) {
            grid.hidden = group !== tone;
            control.setAttribute('aria-pressed', String(group === tone));
            for (const [id, swatch] of buttons) swatch.setAttribute('aria-pressed', String(selected === id));
          }
        }

        function refreshColors() {
          const effective = palette.effective(draft.palette);
          const light = palette.colors(effective, false), dark = palette.colors(effective, true);
          if (sampleChips.length !== light.length) {
            sampleChips = light.map(() => element('i', 'note-database-color-chip'));
            sample.replaceChildren(...sampleChips);
          }
          sampleChips.forEach((chip, index) => setChip(chip, light[index], dark[index]));
          refreshPicker();
          for (const { point, row, chip } of rows) {
            const id = draft.categories[point.colorKey];
            setChip(chip, palette.categoryColor(effective, false, categoryField, point.key, id),
              palette.categoryColor(effective, true, categoryField, point.key, id));
            row.setAttribute('aria-pressed', String(target === point.colorKey));
          }
        }
        function preview() {
          card.chartStyleDraft = copy(draft);
          refreshColors();
          repaintChart(card);
        }
        function chooseColor(id) {
          if (saving || (ring && !target)) return;
          if (target) {
            if (id) draft.categories[target] = id;
            else delete draft.categories[target];
          } else if (id) draft.primary = id;
          else delete draft.primary;
          preview();
        }
        function resetDraft(style) {
          draft = copy(style);
          tone = palette.swatchTone(target ? draft.categories[target] : draft.primary) || 'light';
          preset.value = draft.palette || '';
          view.panel?.choices?.sync(preset);
          preview();
        }
        function showError(message) {
          status.textContent = message;
          status.hidden = !message;
        }
        preset.addEventListener('change', () => {
          if (saving) return;
          if (preset.value) draft.palette = preset.value;
          else delete draft.palette;
          preview();
        });
        const reload = button(tr(label('重新载入配色', 'Reload colors')), () => {
          const saved = card.model;
          revision = saved.styleRevision;
          resetDraft(saved.style);
          reload.hidden = true;
          showError('');
        });
        reload.hidden = true;
        const actions = element('div', 'note-database-chart-actions note-database-color-actions');
        const reset = button(tr(label('恢复自动配色', 'Reset colors')), () => resetDraft({}), 'chart-color-reset');
        const cancel = button(tr(label('取消', 'Cancel')), () => close(true), 'chart-color-cancel');
        const save = element('button', 'note-database-chart-confirm', tr(label('确定', 'Confirm')));
        save.type = 'submit'; save.dataset.dbRole = 'chart-color-confirm';
        actions.append(reset, cancel, save);
        form.append(picker);
        if (ring) form.append(categories);
        if (ring || bar) {
          syncCategories(card.job?.model?.series || card.job?.model?.groups);
          card.syncChartColorCategories = syncCategories;
        }
        form.append(status, reload, actions);
        panel.append(form);
        refreshColors();
        card.refreshChartColors = refreshColors;
        card.chartStyleTarget = chartColorTarget(chart);
        signal.addEventListener('abort', () => {
          delete card.chartStyleDraft;
          delete card.refreshChartColors;
          delete card.syncChartColorCategories;
          delete card.chartStyleTarget;
          repaintChart(card);
        }, { once: true });
        form.addEventListener('submit', async event => {
          event.preventDefault();
          if (saving || !isVisible(session) || !view.host.isConnected) return;
          if (card.model.styleRevision !== revision) {
            showError(tr(label('配色已在其他窗口更改。可载入已保存的配色。', 'Colors changed in another window. Reload the saved colors.')));
            reload.hidden = false;
            return;
          }
          saving = true;
          save.disabled = reset.disabled = cancel.disabled = preset.disabled = true;
          if (targetSelect) targetSelect.disabled = true;
          view.panel?.choices?.sync([preset, targetSelect]);
          showError('');
          const result = await write(session, { type: 'setChartAppearance', chartId: current.id, styleRevision: revision, style: copy(draft) });
          if (signal.aborted) return;
          if (result) { close(true); return; }
          saving = false;
          save.disabled = reset.disabled = cancel.disabled = preset.disabled = false;
          if (targetSelect) targetSelect.disabled = false;
          view.panel?.choices?.sync([preset, targetSelect]);
          showError(session.status || tr(label('配色保存失败，请重试。', 'Could not save colors. Please try again.')));
          save.focus({ preventScroll: true });
        });
        return preset;
      }, { name: tr(label('图表配色', 'Chart colors')) });
    }

    function openChartSettings(view, anchor, card) {
      panelAt(view, anchor, 'chart', (panel, close, { signal }) => {
        const { session } = view;
        const { fields = [], suggested } = session.page.chartOptions || {};
        const numericFields = fields.filter(field => field.metrics.length);
        const compatible = Object.entries(chartTypes).filter(([type]) => type === 'number'
          || type === 'scatter' && numericFields.length >= 2
          || type !== 'scatter' && fields.some(field => field.groupCharts.includes(type)));
        const initial = card?.chart || suggested;
        const form = element('form', 'note-database-chart-form');
        const title = element('label');
        const titleLabel = tr(label('图表名称', 'Chart name'));
        const titleInput = input('text', titleLabel, card?.name);
        titleInput.dataset.dbRole = 'chart-name';
        titleInput.placeholder = tr(label('使用图表类型作为默认名称', 'Use the chart type as the default name'));
        titleInput.maxLength = 120;
        title.append(element('span', '', titleLabel), titleInput);
        form.append(title);
        const field = (labelPair, role) => {
          const name = tr(labelPair), wrapper = element('label'), input = select(name, [], '');
          input.dataset.dbRole = role;
          wrapper.append(element('span', '', name), input);
          form.append(wrapper);
          return { wrapper, input };
        };
        const type = field(label('图表类型', 'Chart type'), 'chart-type').input;
        const grouping = field(label('分组字段', 'Group by'), 'chart-group');
        const group = grouping.input;
        const measureField = field(label('统计值', 'Measure'), 'chart-measure');
        const measure = measureField.input;
        const aggregation = field(label('汇总方式', 'Aggregation'), 'chart-aggregation');
        const bucket = field(label('日期粒度', 'Date interval'), 'chart-bucket');
        const bins = field(label('区间数', 'Number of bins'), 'chart-bins');
        const series = field(label('按类别拆系列', 'Split series by'), 'chart-series');
        const comparison = field(label('对比数字字段', 'Compare number field'), 'chart-comparison');
        const layout = field(label('柱形排列', 'Bar layout'), 'chart-layout');
        const extra = element('details', 'note-database-chart-extra');
        extra.open = Boolean(initial?.seriesBy || initial?.compare);
        const extraFields = element('div');
        extraFields.append(series.wrapper, comparison.wrapper, layout.wrapper);
        extra.append(element('summary', '', tr(label('系列选项', 'Series options'))), extraFields);
        form.append(extra);
        const failure = element('p', 'note-database-chart-notice');
        failure.hidden = true;
        failure.setAttribute('role', 'alert');
        form.append(failure);
        const actions = element('div', 'note-database-chart-actions');
        const cancel = button(tr(label('取消', 'Cancel')), () => close(true), 'chart-cancel');
        const save = element('button', 'note-database-chart-confirm', tr(label('确定', 'Confirm')));
        save.type = 'submit'; save.dataset.dbRole = 'chart-confirm';
        actions.append(cancel, save);
        form.append(actions);
        panel.append(form);
        const fill = (control, entries, value) => {
          if (view.panel?.choices) view.panel.choices.setOptions(control, entries.map(([key, name]) => ({ value: key, label: name })), value);
          else {
            control.replaceChildren(...entries.map(([key, name]) => new Option(name, key)));
            control.value = entries.some(([key]) => key === value) ? value : entries[0]?.[0] || '';
          }
        };
        const fieldName = field => field.name + (field.hidden ? tr(label('（隐藏）', ' (hidden)')) : '');
        const noSeries = tr(label('无', 'None'));
        fill(bins.input, Array.from({ length: 27 }, (_, i) => [String(i + 4), String(i + 4)]), String(initial?.bins || 10));
        fill(layout.input, [['grouped', tr(label('并排', 'Grouped'))], ['stacked', tr(label('堆叠', 'Stacked'))]],
          initial?.stack ? 'stacked' : 'grouped');
        const unit = field => JSON.stringify([Boolean(field?.numberFormat?.percent), field?.numberFormat?.unit || '']);
        const updateFields = (groupId = group.value, measureId = measure.value, op = aggregation.input.value,
          seriesId = series.input.value, compareId = comparison.input.value) => {
          const numberCard = type.value === 'number';
          const scatter = type.value === 'scatter';
          const histogram = type.value === 'histogram';
          const groups = fields.filter(field => field.groupCharts.includes(type.value));
          fill(group, groups.map(field => [field.id, fieldName(field)]), groupId);
          grouping.wrapper.hidden = numberCard;
          const groupName = tr(scatter ? label('横轴数字字段', 'X-axis number field')
            : histogram ? label('数字字段', 'Number field') : label('分组字段', 'Group by'));
          grouping.wrapper.firstElementChild.textContent = groupName;
          group.setAttribute('aria-label', groupName);
          const measureName = tr(scatter ? label('纵轴数字字段', 'Y-axis number field') : label('统计值', 'Measure'));
          measureField.wrapper.firstElementChild.textContent = measureName;
          measure.setAttribute('aria-label', measureName);
          measureField.wrapper.hidden = histogram;
          bins.wrapper.hidden = !histogram;
          const selected = groups.find(field => field.id === group.value);
          const numbers = selected?.type === 'multiSelect' ? [] : numericFields.filter(field => !scatter || field.id !== group.value);
          const rates = type.value === 'doughnut' || selected?.type === 'multiSelect' ? [] : fields.filter(field => field.type === 'checkbox');
          const metrics = numbers.map(field => [field.id, fieldName(field)]);
          fill(measure, scatter ? metrics : [['', tr(label('记录数', 'Record count'))], ...metrics,
            ...rates.map(field => [field.id, fieldName(field) + ' · ' + tr(chartMetrics.checkedRate)])], measureId);
          const metric = numbers.find(field => field.id === measure.value);
          aggregation.wrapper.hidden = !metric || scatter || histogram;
          fill(aggregation.input, (metric?.metrics || []).map(key => [key, tr(chartMetrics[key])]), op || 'sum');
          bucket.wrapper.hidden = selected?.type !== 'date';
          const split = ['line', 'column', 'bar'].includes(type.value) && selected?.type !== 'multiSelect';
          const seriesFields = split ? fields.filter(field => field.id !== group.value &&
            ['text', 'select', 'status', 'checkbox'].includes(field.type)) : [];
          fill(series.input, [['', noSeries], ...seriesFields.map(field => [field.id, fieldName(field)])], seriesId);
          series.wrapper.hidden = !seriesFields.length;
          const compareFields = split && metric && !series.input.value
            ? numbers.filter(field => field !== metric && unit(field) === unit(metric)) : [];
          fill(comparison.input, [['', noSeries], ...compareFields.map(field => [field.id, fieldName(field)])], compareId);
          comparison.wrapper.hidden = !compareFields.length;
          layout.wrapper.hidden = !series.input.value || !['column', 'bar'].includes(type.value)
            || (measure.value && (!metric || aggregation.input.value !== 'sum'));
          extra.hidden = series.wrapper.hidden && comparison.wrapper.hidden;
          view.panel?.choices?.sync([group, measure]);
        };
        fill(type, compatible.map(([key, names]) => [key, tr(names)]), initial?.type);
        fill(bucket.input, Object.entries(chartBuckets).map(([key, names]) => [key, tr(names)]), initial?.bucket || 'day');
        updateFields(initial?.groupBy, initial?.metric?.column, initial?.metric?.op, initial?.seriesBy, initial?.compare);
        for (const control of [type, group, measure, series.input, aggregation.input]) control.addEventListener('change', () => updateFields());
        form.addEventListener('submit', async event => {
          event.preventDefault();
          if (save.disabled || (!grouping.wrapper.hidden && !group.value) || !isVisible(session) || !view.host.isConnected) return;
          const chart = { type: type.value, metric: !measureField.wrapper.hidden && measure.value
            ? { op: type.value === 'scatter' ? 'value' : aggregation.wrapper.hidden ? 'checkedRate' : aggregation.input.value, column: measure.value }
            : { op: 'count' } };
          if (!grouping.wrapper.hidden) chart.groupBy = group.value;
          if (!bucket.wrapper.hidden) chart.bucket = bucket.input.value;
          if (!bins.wrapper.hidden) chart.bins = Number(bins.input.value);
          if (series.input.value) chart.seriesBy = series.input.value;
          if (comparison.input.value) chart.compare = comparison.input.value;
          if (!layout.wrapper.hidden && layout.input.value === 'stacked') chart.stack = true;
          save.disabled = cancel.disabled = true;
          failure.hidden = true;
          if (!await settleSession(session) || signal.aborted) {
            save.disabled = cancel.disabled = false;
            return;
          }
          const result = await write(session, { type: 'setChartCard', operation: card ? 'edit' : 'add', chartId: card?.id,
            chart, name: titleInput.value, show: true });
          if (signal.aborted) return;
          if (result) {
            close(true);
            if (!card && session.page.chartCards.length > 1) jumpToChart(view, result.changedChartId);
          } else {
            save.disabled = cancel.disabled = false;
            failure.textContent = session.status;
            failure.hidden = false;
            save.focus({ preventScroll: true });
          }
        });
        return type;
      }, { name: tr(label('图表设置', 'Chart settings')) });
    }

    async function switchDatabaseMode(view, mode) {
      const { session } = view;
      if (session.chartSwitching || mode === (session.page?.chartView?.mode || 'data')) return;
      session.chartSwitching = true;
      try {
        if (!await settleSession(session) || !view.host.isConnected || !isVisible(session) || !session.page?.exists) return;
        const cards = session.page.chartCards;
        if (mode === 'chart' && !cards.some(card => card.valid)) openChartSettings(view, view.chartMode, cards.length === 1 ? cards[0] : null);
        else {
          view.panel?.close();
          await write(session, { type: 'setChartView', mode });
        }
      } finally {
        session.chartSwitching = false;
      }
    }

    function jumpToChart(view, identity) {
      const card = view.cards.get(identity);
      if (!card || view.mode !== 'chart') return;
      card.root.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      card.root.focus({ preventScroll: true });
    }

    function chartMenu(view) {
      panelAt(view, view.chartToggle, 'charts', (panel, close, { popup, signal }) => {
        const { session } = view;
        const cards = session.page.chartCards;
        const canAdd = cards.length < session.page.chartOptions.maxCards;
        const add = button(tr(label('＋ 新建图表', '+ New chart')), () => {
          if (cards.length && !canNavigate()) return;
          close();
          afterCellSave(view, () => openChartSettings(view, view.chartToggle));
        }, 'new-chart');
        add.disabled = !canAdd;
        panel.append(add);
        if (!cards.length) return add;

        const savedLayout = page => page.chartCards.map(card => ({ id: card.id, hidden: Boolean(card.hidden) }));
        const savedState = page => JSON.stringify([savedLayout(page), page.chartShowData, page.chartOrientation, page.chartHideTitles]);
        let baseline = savedState(session.page);
        let arrangement = { order: cards.map(card => card.id), hidden: cards.filter(card => card.hidden).map(card => card.id) };
        let saving = false;
        const makeLayout = () => arrangement.order.map(id => ({ id, hidden: arrangement.hidden.includes(id) }));
        const dirty = () => JSON.stringify([makeLayout(), showData.checked, orientation.dataset.orientation, hideTitles.checked]) !== baseline;
        const list = element('div', 'note-database-chart-order');
        const displayOption = (names, checked) => {
          const row = element('label', 'note-database-chart-display-option');
          const caption = tr(names);
          const control = input('checkbox', caption);
          control.checked = checked;
          control.addEventListener('change', () => { clearMessage(); updateControls(); });
          row.append(control, caption);
          return { row, control };
        };
        const { row: showDataRow, control: showData } = displayOption(
          label('在图表下显示数据表', 'Show data table below charts'), session.page.chartShowData);
        const { row: hideTitlesRow, control: hideTitles } = displayOption(
          label('隐藏图表标题', 'Hide chart titles'), session.page.chartHideTitles);
        const orientation = element('fieldset', 'note-database-chart-orientation');
        orientation.setAttribute('aria-label', tr(label('图表排列方式', 'Chart orientation')));
        orientation.dataset.orientation = session.page.chartOrientation;
        const slider = element('span', 'note-database-chart-orientation-slider');
        slider.setAttribute('aria-hidden', 'true');
        orientation.append(slider);
        const radioName = `note-chart-orientation-${++listSequence}`;
        let horizontal;
        for (const [value, name] of [['vertical', label('纵向', 'Vertical')], ['horizontal', label('横向', 'Horizontal')]]) {
          const control = input('radio', tr(name), value);
          control.name = radioName;
          control.checked = value === orientation.dataset.orientation;
          control.addEventListener('change', () => {
            orientation.dataset.orientation = control.value;
            clearMessage();
            updateControls();
          });
          if (value === 'horizontal') horizontal = control;
          const option = element('label');
          option.append(control, element('span', '', tr(name)));
          orientation.append(option);
        }
        const fallback = element('p', 'note-database-chart-notice',
          tr(label('超过两张可见图表时使用纵向排列。', 'More than two visible charts are arranged vertically.')));
        const message = element('p', 'note-database-chart-notice');
        message.setAttribute('role', 'status');
        const showMessage = text => {
          message.textContent = text;
          message.hidden = !text;
        };
        const clearMessage = () => showMessage('');
        const cancel = button(tr(label('取消', 'Cancel')), () => close(true));
        const save = button(tr(label('保存', 'Save')), async () => {
          if (saving || !dirty()) return;
          saving = true;
          clearMessage();
          updateControls();
          try {
            if (!await settleSession(session) || signal.aborted) return;
            if (!session.page?.exists || savedState(session.page) !== baseline) {
              showMessage(tr(label('已保存的图表排列发生变化。关闭下拉后重新打开即可查看最新设置。',
                'The saved chart arrangement changed. Reopen the list to see the latest settings.')));
              return;
            }
            const result = await write(session, { type: 'setChartCard', operation: 'arrange', layout: makeLayout(),
              showData: showData.checked, orientation: orientation.dataset.orientation, hideTitles: hideTitles.checked });
            if (signal.aborted) return;
            if (result) {
              baseline = savedState(result);
              showMessage(tr(label('已保存', 'Saved')));
            } else showMessage(session.status || tr(label('图表设置保存失败，请重试。', 'Could not save chart settings. Try again.')));
          } finally {
            if (!signal.aborted) {
              saving = false;
              updateControls();
              if (popup.contains(document.activeElement) || document.activeElement === document.body) {
                (save.disabled ? (list.querySelector('[data-order-activate]:not(:disabled)') || cancel) : save)
                  .focus({ preventScroll: true });
              }
            }
          }
        }, 'save-chart-order');
        function updateControls() {
          const count = arrangement.order.length - arrangement.hidden.length;
          add.disabled = saving || !canAdd;
          cancel.disabled = saving;
          save.disabled = saving || !dirty();
          showData.disabled = saving;
          hideTitles.disabled = saving;
          orientation.disabled = saving;
          horizontal.disabled = (count === 0 || count > 2) && orientation.dataset.orientation !== 'horizontal';
          fallback.hidden = count <= 2;
          list.inert = saving;
        }
        function canNavigate() {
          if (!dirty()) return true;
          showMessage(tr(label('请先保存或取消图表设置。', 'Save or cancel your chart changes first.')));
          save.focus({ preventScroll: true });
          return false;
        }
        const names = Object.fromEntries(cards.map(card => {
          const title = chartTitle(card, tr);
          return [card.id, [title, title]];
        }));
        const orderList = window.RelatumSettingsOrderList.create({
          ids: arrangement.order, names, available: () => true, read: () => arrangement,
          commit: next => { arrangement = next; clearMessage(); updateControls(); },
          activate: async identity => {
            if (!canNavigate()) return;
            close();
            if (view.mode !== 'chart') {
              if (!await settleSession(session) || !isVisible(session)) return;
              const current = session.page?.chartCards || [];
              const card = current.find(item => item.id === identity && !item.hidden);
              if (!card) return;
              if (!current.some(item => item.valid)) {
                openChartSettings(view, view.chartToggle, card);
                return;
              }
              if (!await write(session, { type: 'setChartView', mode: 'chart' })) return;
            }
            jumpToChart(view, identity);
          },
          language: () => tr(label('zh', 'en')),
          visibilityLabel: name => tr(label(`显示 ${name}`, `Show ${name}`)),
          scrollHost: panel, ghostHost: popup,
        });
        orderList.initPanel(list);
        signal.addEventListener('abort', () => orderList.destroy(), { once: true });
        const actions = element('div', 'note-database-chart-actions');
        actions.append(cancel, save);
        const settings = element('div', 'note-database-chart-list-settings');
        settings.append(orientation, fallback, showDataRow, hideTitlesRow, message, actions);
        panel.append(list, settings);
        clearMessage();
        updateControls();
      });
    }

    function openChartFilters(card) {
      const view = card.owner;
      panelAt(view, card.menu, 'chart-filters', (panel, close, { signal }) => {
        const { session } = view;
        const query = makeChartQuery(card.model.query);
        const searchText = tr(label('搜索此图表', 'Search this chart'));
        const search = input('search', searchText, query.search);
        search.placeholder = searchText;
        search.maxLength = 256;
        search.dataset.dbRole = 'chart-filter-search';
        const rules = element('div', 'note-database-view-rules');
        const actions = element('div', 'note-database-chart-actions');
        const cancel = button(tr(label('取消', 'Cancel')), () => close(true));
        const save = button(tr(label('保存筛选', 'Save filters')), async () => {
          if (save.disabled) return;
          save.disabled = true;
          const result = await write(session, { type: 'setChartCard', operation: 'edit', chartId: card.model.id,
            query: { search: search.value, filters: query.filters } });
          if (signal.aborted) return;
          if (result) close(true);
          else save.disabled = false;
        }, 'chart-filter-save');
        function renderRules() {
          rules.replaceChildren();
          const edit = index => {
            rules.replaceChildren();
            save.disabled = true;
            filterForm(view, rules, index, query, filters => {
              query.filters = filters;
              save.disabled = false;
              renderRules();
            });
            rules.append(button(tr(label('返回筛选列表', 'Back to filters')), () => {
              save.disabled = false;
              renderRules();
            }));
          };
          query.filters.forEach((rule, index) => {
            const column = session.page.columns.find(item => item.id === rule.column);
            const description = column ? [column.name, display(rule.value, column, tr)].filter(Boolean).join(' · ')
              : tr(label('字段已移除', 'Field removed'));
            rules.append(button(description, () => {
              if (column) edit(index);
              else { query.filters = query.filters.filter((_, position) => position !== index); renderRules(); }
            }));
          });
          const add = button(tr(label('＋ 筛选条件', '+ Filter rule')), () => edit(query.filters.length));
          add.disabled = query.filters.length >= 32;
          rules.append(add);
        }
        renderRules();
        actions.append(cancel, save);
        panel.append(search, rules, actions);
        return search;
      }, { name: tr(label('图表筛选', 'Chart filters')) });
    }

    function cardMenu(card) {
      const view = card.owner, { session } = view;
      panelAt(view, card.menu, 'chart-card', (panel, close) => {
        const follow = action => () => { close(); action(); };
        const edit = button(tr(label('编辑图表', 'Edit chart')), follow(() => openChartSettings(view, card.menu, card.model)), 'chart-settings');
        const colors = button(tr(label('图表配色', 'Chart colors')), follow(() => openChartPalette(card, card.menu)), 'chart-palette');
        colors.disabled = !card.model.valid;
        const filters = button(tr(label('图表筛选', 'Chart filters')), follow(() => openChartFilters(card)), 'chart-filters');
        const duplicate = button(tr(label('复制图表', 'Duplicate chart')), async () => {
          close();
          const name = Array.from(chartTitle(card.model, tr)).slice(0, 110).join('');
          const result = await write(session, { type: 'setChartCard', operation: 'duplicate',
            chartId: card.model.id, name: tr(label(name + ' 副本', name + ' copy')) });
          if (result && isVisible(session)) jumpToChart(view, result.changedChartId);
        }, 'duplicate-chart');
        duplicate.disabled = session.page.chartCards.length >= session.page.chartOptions.maxCards;
        const remove = button(tr(label('删除图表', 'Delete chart')), async () => {
          close();
          const name = chartTitle(card.model, tr);
          if (await confirmEdit(view, label(`删除图表「${name}」？`, `Delete the chart “${name}”?`))) {
            if (await write(session, { type: 'setChartCard', operation: 'delete', chartId: card.model.id })) {
              view.chartToggle?.focus({ preventScroll: true });
            }
          }
        }, 'delete-chart');
        panel.append(edit, filters, colors, duplicate, remove);
      }, { name: chartTitle(card.model, tr) });
    }

    function openChartDetails(card, mark) {
      if (!chartVisible(card)) return;
      const view = card.owner, { session } = view;
      const revision = session.page.revision;
      const query = makeChartQuery(session.query);
      const rendered = card.chartPaint?.model;
      const anchor = card.menu || card.root;
      panelAt(view, anchor, 'chart-details', (panel, close, { popup, signal }) => {
        popup.classList.add('note-database-panel-details');
        const title = element('strong', '', [chartTitle(card.model, tr), mark.label].filter(Boolean).join(' · '));
        const tableHost = element('div', 'note-database-chart-detail-table');
        const status = element('p', 'note-database-chart-notice');
        status.setAttribute('role', 'status');
        const actions = element('div', 'note-database-chart-actions');
        panel.append(title, status, tableHost, actions);
        const dismiss = button(tr(label('关闭', 'Close')), () => close(true));
        let sequence = 0;
        async function load(page) {
          const current = ++sequence;
          status.textContent = tr(label('正在读取记录…', 'Loading records…'));
          actions.replaceChildren(dismiss);
          try {
            const records = await request(chartRoute, { path: session.path, databaseId: session.databaseId, chartId: card.model.id,
              query, detail: { key: mark.key, series: mark.series || '', page } },
              AbortSignal.any([signal, AbortSignal.timeout(10000)]));
            if (signal.aborted || current !== sequence) return;
            if (!records.exists || records.revision !== revision || chartPaintChanged()) {
              tableHost.replaceChildren();
              status.textContent = tr(label('图表已更新，请重新选择数据点。', 'The chart changed. Select a point again.'));
              return;
            }
            status.textContent = tr(label(`共 ${records.total} 条记录`, `${records.total} records`));
            const table = element('table');
            const columns = shownColumns(records);
            const header = table.createTHead().insertRow();
            for (const column of columns) header.append(element('th', '', column.name));
            const body = table.createTBody();
            for (const record of records.rows) {
              const row = body.insertRow();
              for (const column of columns) row.insertCell().textContent = display(record.values[column.id], column, tr);
            }
            tableHost.replaceChildren(table);
            const prev = button(tr(label('上一页', 'Previous')), () => void load(records.page - 1));
            const next = button(tr(label('下一页', 'Next')), () => void load(records.page + 1));
            prev.disabled = records.page <= 1;
            next.disabled = records.page * records.pageSize >= records.total;
            if (!prev.disabled || !next.disabled) actions.prepend(prev, next);
          } catch (_) {
            if (signal.aborted || current !== sequence) return;
            status.textContent = tr(label('读取明细失败', 'Could not load records'));
            actions.prepend(button(tr(label('重试', 'Retry')), () => void load(page)));
          }
        }
        const chartPaintChanged = () => card.chartPaint?.model !== rendered;
        void load(1);
        return dismiss;
      }, { name: tr(label('图表明细', 'Chart records')) });
    }

    function viewMenu(view, anchor) {
      panelAt(view, anchor, 'view', (panel, close) => {
        const { page, query } = view.session;
        const chartOnly = page.chartView?.mode === 'chart' && !page.chartShowData;
        if (!view.readOnly) panel.append(button(tr(label('重命名数据库', 'Rename database')), () => {
          close();
          renameDatabase(view, anchor);
        }));
        const sortValues = [['', tr(label('默认顺序', 'Default order'))]];
        for (const column of page.columns) {
          sortValues.push([column.id + ':asc', column.name + ' ↑'], [column.id + ':desc', column.name + ' ↓']);
        }
        const sort = select(tr(label('排序', 'Sort')), sortValues, query.sort ? query.sort.column + ':' + query.sort.direction : '');
        sort.addEventListener('change', () => {
          const [column, direction] = sort.value.split(':');
          close(true);
          changeQuery(view.session, { sort: column ? { column, direction } : null });
        });
        if (!chartOnly) panel.append(sort);
        const rules = element('div', 'note-database-view-rules');
        query.filters.forEach((rule, index) => {
          const column = page.columns.find(item => item.id === rule.column);
          if (column) {
            const value = display(rule.value, column, tr);
            rules.append(button(column.name + (value ? ' · ' + value : ''), () => {
              rules.replaceChildren(); filterForm(view, rules, index);
            }));
          }
        });
        const add = button(tr(label('＋ 筛选条件', '+ Filter rule')), () => {
          rules.replaceChildren(); filterForm(view, rules, query.filters.length);
        }, 'filter');
        add.disabled = query.filters.length >= 32;
        rules.append(add);
        panel.append(rules);
        if (chartOnly) return add;
        const fields = element('fieldset', 'note-database-visible-fields');
        fields.append(element('legend', '', tr(label('显示字段', 'Visible fields'))));
        const visible = shownColumns(page).length;
        for (const column of page.columns) {
          const item = element('label'), toggle = element('input');
          toggle.type = 'checkbox';
          toggle.checked = !column.hidden;
          toggle.disabled = view.readOnly || (visible <= 1 && !column.hidden);
          toggle.addEventListener('change', async () => {
            const saved = await write(view.session, { type: 'columnLayout', column: column.id, hidden: !toggle.checked });
            if (saved) close(true);
            else toggle.checked = !column.hidden;
          });
          item.append(toggle, document.createTextNode(column.name));
          fields.append(item);
        }
        panel.append(fields);
        return sort;
      });
    }

    function draw(view) {
      if (view.session.draft?.view === view && view.body.contains(view.session.draft.input)) return;
      renderView(view);
      view.onLayout?.();
    }

    function releasePinned(view, nextRow) {
      if (!view.pinned || view.pinned.id === nextRow || view.session.draft?.view === view || view.panel) return;
      view.pinned = null;
      queueMicrotask(() => { if (view.visible && view.host.isConnected) draw(view); });
    }

    async function addRow(view) {
      const { session } = view;
      if (view.addingRow) return;
      view.addingRow = true;
      view.addRow.disabled = true;
      try {
        const page = await write(session, { type: 'addRow', focusAdded: true });
        if (!page?.addedRow || session.renderedQuery !== JSON.stringify(session.query)
            || !view.host.isConnected || !isVisible(session)) return;
        const previousPin = view.pinned?.id;
        view.pinned = page.rows.some(row => row.id === page.addedRow.id) ? null : page.addedRow;
        if (view.pinned || previousPin) draw(view);
        const columns = shownColumns(page);
        const column = columns.find(item => item.type === 'text') || columns[0];
        if (column) {
          focusCell(view, [page.addedRow.id, column.id]);
          view.cells.get(page.addedRow.id)?.get(column.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      } finally {
        view.addingRow = false;
        if (view.addRow) view.addRow.disabled = false;
      }
    }

    function orderNodes(parent, nodes) {
      const wanted = new Set(nodes);
      for (const child of Array.from(parent.children)) if (!wanted.has(child)) child.remove();
      let previous = null;
      for (const node of nodes) {
        const next = previous ? previous.nextElementSibling : parent.firstElementChild;
        if (node !== next) parent.insertBefore(node, next);
        previous = node;
      }
    }

    function widthOf(column) { return column.width || 176; }

    function resizeColumn(view, column, handle, event) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      view.panel?.close();
      const track = view.headers.get(column.id)?.track;
      if (!track) return;
      const start = event.clientX, original = widthOf(column);
      let width = original;
      const controller = new AbortController(), { signal } = controller;
      const finish = commit => {
        controller.abort();
        view.stopResize = null;
        view.root.classList.remove('is-resizing');
        if (commit && width !== original) {
          void write(view.session, { type: 'columnLayout', column: column.id, width }).then(page => {
            if (!page && track.isConnected) draw(view);
          });
        } else if (track.isConnected) draw(view);
      };
      view.stopResize?.(false);
      view.stopResize = finish;
      view.root.classList.add('is-resizing');
      handle.setPointerCapture?.(event.pointerId);
      handle.addEventListener('pointermove', move => {
        if (move.pointerId !== event.pointerId) return;
        width = clampWidth(original + move.clientX - start);
        track.style.width = width + 'px';
        view.grid.style.width = 'max(100%, ' + (view.gridWidth - original + width) + 'px)';
      }, { signal });
      handle.addEventListener('pointerup', up => {
        if (up.pointerId === event.pointerId) finish(true);
      }, { signal });
      handle.addEventListener('lostpointercapture', () => finish(false), { signal });
      window.addEventListener('blur', () => finish(false), { signal });
    }

    function buildHeader(view, column) {
      const track = element('col'), cell = element('th', 'note-database-field');
      cell.scope = 'col';
      const shell = element('div', 'note-database-field-inner');
      const typeName = tr(columnTypes[column.type]);
      if (view.readOnly) shell.append(typeIcon(column.type, typeName), element('span', '', column.name));
      else {
        const title = button(column.name, event => afterCellSave(view, () => columnMenu(view, event.currentTarget || title, column)), 'edit-' + column.id);
        title.className = 'note-database-field-title';
        title.title = column.name;
        title.prepend(typeIcon(column.type, typeName));
        const handle = iconButton('', tr(label('调整列宽', 'Resize field')), () => {}, 'size-' + column.id);
        handle.className = 'note-database-resize';
        handle.addEventListener('pointerdown', event => resizeColumn(view, column, handle, event));
        handle.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const width = clampWidth(widthOf(column) + (event.key === 'ArrowRight' ? 16 : -16));
          void write(view.session, { type: 'columnLayout', column: column.id, width });
        });
        title.draggable = true;
        title.addEventListener('dragstart', event => {
          view.dragColumn = column.id;
          event.dataTransfer?.setData('application/x-relatum-database-field', column.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        const clearDrop = () => {
          if (view.dropField) delete view.dropField.dataset.dbDrop;
          view.dropField = null;
        };
        const dropSide = event => {
          const rect = cell.getBoundingClientRect();
          return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
        };
        title.addEventListener('dragend', () => { view.dragColumn = null; clearDrop(); });
        cell.addEventListener('dragover', event => {
          if (!view.dragColumn || view.dragColumn === column.id) { clearDrop(); return; }
          event.preventDefault(); event.stopPropagation();
          if (view.dropField !== cell) clearDrop();
          view.dropField = cell;
          const side = dropSide(event);
          if (cell.dataset.dbDrop !== side) cell.dataset.dbDrop = side;
        });
        cell.addEventListener('dragleave', event => { if (view.dropField === cell && !cell.contains(event.relatedTarget)) clearDrop(); });
        cell.addEventListener('drop', event => {
          const dragged = view.dragColumn;
          if (!dragged) return;
          event.preventDefault(); event.stopPropagation();
          const side = dropSide(event);
          view.dragColumn = null;
          clearDrop();
          void moveColumn(view, dragged, column.id, side);
        });
        shell.append(title, handle);
      }
      cell.append(shell);
      return { cell, track };
    }

    function showRowMenu(view, anchor, row) {
      panelAt(view, anchor, 'row', (panel, close) => {
        panel.append(button(tr(label('删除记录', 'Delete row')), () => {
          const index = visibleRows(view).findIndex(item => item.id === row.id);
          close();
          void write(view.session, { type: 'deleteRow', row: row.id }).then(saved => {
            if (saved && view.pinned?.id === row.id) { view.pinned = null; draw(view); }
            if (!saved || !view.host.isConnected || !isVisible(view.session)) return;
            const neighbor = visibleRows(view)[Math.max(0, Math.min(index, visibleRows(view).length - 1))];
            const first = shownColumns(view.session.page)[0];
            if (neighbor && first) focusCell(view, [neighbor.id, first.id]);
            else view.addRow?.focus({ preventScroll: true });
          });
        }));
      });
    }

    function buildToolbar(view) {
      const { session, body } = view;
      body.replaceChildren();
      view.bar = element('div', 'note-database-toolbar');
      const nameSlot = element('div', 'note-database-name-slot');
      if (view.readOnly) view.name = element('span');
      else {
        view.name = renameTrigger('rename-database', anchor => afterCellSave(view, () => renameDatabase(view, anchor)));
      }
      view.name.className = 'note-database-name';
      nameSlot.append(view.name);
      if (!view.readOnly && view.onMoveBlock) {
        const grip = view.moveGrip = element('button', 'note-database-move note-table-grip');
        grip.type = 'button';
        grip.setAttribute('aria-label', tr(label('移动整个数据库', 'Move database block')));
        for (let i = 0; i < 6; i++) grip.append(element('i'));
        const canMove = () => isVisible(session) && session.page?.exists
          && !view.searchComposing && !sessionsFor(session.path).some(item => item.draft || item.write);
        grip.addEventListener('pointerdown', event => {
          if (canMove()) view.onMoveBlock(event, canMove);
        });
        nameSlot.prepend(grip);
      }
      view.search = input('search', tr(label('搜索数据库', 'Search database')), session.query.search);
      view.search.dataset.dbRole = 'search';
      view.search.placeholder = tr(label('搜索', 'Search'));
      view.search.maxLength = 256;
      view.search.hidden = true;
      view.search.addEventListener('input', event => {
        if (!composing(event)) changeQuery(session, { search: view.search.value }, 120);
      });
      view.search.addEventListener('compositionstart', () => { view.searchComposing = true; });
      view.search.addEventListener('compositionend', () => {
        view.searchComposing = false;
        changeQuery(session, { search: view.search.value }, 120);
      });
      view.search.addEventListener('keydown', event => {
        if (!composing(event) && event.key === 'Escape') {
          view.searchOpen = false;
          if (session.query.search) changeQuery(session, { search: '' });
          view.search.hidden = true;
          view.searchToggle.focus();
        }
      });
      view.searchToggle = iconButton('search', tr(label('搜索', 'Search')), () => {
        view.searchOpen = view.search.hidden;
        view.search.hidden = !view.searchOpen;
        view.searchToggle.setAttribute('aria-expanded', String(view.searchOpen));
        if (view.searchOpen) view.search.focus();
      }, 'search-toggle');
      view.viewToggle = iconButton('view', tr(label('视图选项', 'View options')), () =>
        afterCellSave(view, () => viewMenu(view, view.viewToggle)), 'view');
      const tools = element('div', 'note-database-tools');
      tools.append(view.searchToggle);
      view.bar.append(nameSlot);
      if (!view.readOnly) {
        const modes = element('div', 'note-database-modes');
        modes.setAttribute('role', 'group');
        view.modeControls = modes;
        view.dataMode = button('', () => void switchDatabaseMode(view, 'data'), 'data-mode');
        view.chartMode = button('', () => void switchDatabaseMode(view, 'chart'), 'chart-mode');
        view.chartToggle = button('▾', () => chartMenu(view), 'chart-menu');
        view.chartToggle.className = 'note-database-chart-toggle';
        view.chartToggle.setAttribute('aria-haspopup', 'dialog');
        view.chartToggle.setAttribute('aria-expanded', 'false');
        modes.append(view.dataMode, view.chartMode, view.chartToggle);
        view.bar.append(modes);
      }
      view.bar.append(view.search, tools);
      if (!view.readOnly) {
        view.deleteTable = iconButton('trash', tr(label('删除数据库', 'Delete database')), () =>
          afterCellSave(view, () => deleteCurrentTable(view)), 'delete-database');
        tools.append(view.deleteTable);
      }
      tools.append(view.viewToggle);
      view.chartArea = element('div', 'note-database-chart-area');
      view.chartArea.hidden = true;
      view.chartList = element('div', 'note-database-chart-list');
      view.chartArea.append(view.chartList);
      view.noCharts = element('p', 'note-database-chart-notice');
      body.append(view.bar, view.chartArea);
    }

    function renderChartCards(view) {
      const { page } = view.session;
      const visible = page.chartCards.filter(model => !model.hidden);
      const horizontal = page.chartOrientation === 'horizontal' && visible.length === 2 && visible.every(model => model.valid);
      view.chartList.classList.toggle('can-show-side-by-side', horizontal);
      const retained = new Set();
      const nodes = [];
      for (const model of visible) {
        let card = view.cards.get(model.id);
        if (!card) {
          const root = element('section', 'note-database-chart-card');
          root.dataset.chartId = model.id;
          root.tabIndex = -1;
          const tools = element('div', 'note-database-chart-tools');
          const heading = view.readOnly ? element('strong')
            : renameTrigger('rename-chart', anchor => afterCellSave(view, () => renameChart(card, anchor)));
          heading.className = 'note-database-chart-title';
          const meta = element('span', 'note-database-chart-filter-summary');
          const chartStage = element('div', 'note-database-chart-stage');
          const chartCanvas = element('div', 'note-database-chart-canvas');
          const chartStatus = element('div', 'note-database-chart-status');
          chartStatus.setAttribute('role', 'status');
          card = { owner: view, session: view.session, root, tools, heading, meta, chartStage, chartCanvas, chartStatus };
          tools.append(heading, meta);
          if (!view.readOnly) {
            card.menu = iconButton('more', '', () => afterCellSave(view, () => cardMenu(card)), 'chart-card-menu');
            card.menu.setAttribute('aria-haspopup', 'dialog');
            card.menu.setAttribute('aria-expanded', 'false');
            tools.append(card.menu);
          }
          chartStage.append(chartCanvas, chartStatus);
          root.append(tools, chartStage);
          view.cards.set(model.id, card);
        }
        card.model = model;
        card.root.classList.toggle('is-number-card', model.chart.type === 'number');
        const title = chartTitle(model, tr);
        if (card.root.getAttribute('aria-label') !== title) card.root.setAttribute('aria-label', title);
        if (card.heading.textContent !== title) card.heading.textContent = title;
        const titleHint = view.readOnly ? title : title + ' · ' + tr(label('双击重命名图表', 'Double-click to rename chart'));
        if (card.heading.title !== titleHint) card.heading.title = titleHint;
        card.heading.hidden = page.chartHideTitles;
        if (card.heading.hidden && view.panel?.anchor === card.heading) view.panel.close();
        const filters = chartFilterText(model, page.columns, tr);
        if (card.meta.textContent !== filters) card.meta.textContent = card.meta.title = filters;
        card.meta.hidden = !filters;
        card.tools.hidden = card.heading.hidden && card.meta.hidden && !card.menu;
        if (card.menu) {
          card.menu.title = tr(label(`${title}的操作`, `Actions for ${title}`));
          card.menu.setAttribute('aria-label', card.menu.title);
        }
        if (card.chartStyleTarget && (!model.valid || chartColorTarget(model.chart) !== card.chartStyleTarget)) {
          view.panel?.close();
        }
        retained.add(model.id);
        nodes.push(card.root);
      }
      for (const [id, card] of view.cards) {
        if (retained.has(id)) continue;
        if (card.root.contains(view.panel?.anchor)) view.panel.close();
        releaseChart(card);
        stopObserving(card.chartStage);
        view.cards.delete(id);
      }
      if (!nodes.length) {
        view.noCharts.textContent = tr(label('所有图表已隐藏', 'All charts are hidden'));
        nodes.push(view.noCharts);
      }
      orderNodes(view.chartList, nodes);
      if (view.observe) for (const card of view.cards.values()) {
        if (!observed.has(card.chartStage)) {
          card.chartIntersecting = false;
          watch(card, card.chartStage);
        }
      }
    }

    function buildGrid(view) {
      const { session, body } = view;
      view.table = element('div', 'note-database-data');
      view.overflow = element('div', 'note-database-overflow');
      view.grid = element('table', 'note-database-grid');
      view.tracks = element('colgroup');
      view.grid.append(view.tracks);
      view.header = view.grid.createTHead().insertRow();
      view.rows = view.grid.createTBody();
      view.headers = new Map();
      view.rowEntries = new Map();
      view.fillerTrack = element('col');
      view.fillerHeader = element('th', 'note-database-filler');
      view.fillerHeader.setAttribute('aria-hidden', 'true');
      view.laneTrack = element('col', 'note-database-lane-track');
      view.lane = element('th', 'note-database-lane');
      view.lane.scope = 'col';
      const plus = tr(label('添加字段', 'Add field'));
      view.addColumn = iconButton('plus', plus, () => afterCellSave(view, () => addColumn(view, view.addColumn)), 'add-column');
      view.lane.append(view.addColumn);
      view.overflow.append(view.grid);
      view.addRow = iconButton('plus', tr(label('添加记录', 'Add row')), () => afterCellSave(view, () => addRow(view)), 'add-row');
      view.addRow.classList.add('note-database-add-row');
      view.pager = element('div', 'note-database-pagination');
      view.prev = iconButton('prev', tr(label('上一页', 'Previous')), () => changeQuery(session, { page: session.page.page - 1 }), 'prev');
      view.next = iconButton('next', tr(label('下一页', 'Next')), () => changeQuery(session, { page: session.page.page + 1 }), 'next');
      view.pageText = element('span');
      view.pager.append(view.prev, view.pageText, view.next);
      view.table.append(view.overflow);
      if (!view.readOnly) view.table.append(view.addRow);
      view.table.append(view.pager);
      body.append(view.table);
    }

    function renderView(view) {
      const { session, body } = view;
      const page = session.page;
      if (!page?.exists) {
        view.panel?.close();
        releaseCharts(view, true);
        view.cards.clear();
        view.bar = view.grid = view.table = view.chartArea = view.chartList = null;
        view.mode = view.language = null;
        body.replaceChildren();
        if (!page && session.status) body.append(button(tr(label('重试', 'Retry')), () => refresh(session.path, false, session.databaseId)));
        if (page?.deleted) body.append(element('span', 'note-database-placeholder', tr(label('数据库已删除', 'Database deleted'))));
        if (page && !page.deleted && !options.pending?.(session.path, session.databaseId)) {
          if (view.readOnly) body.append(element('span', 'note-database-placeholder', tr(label('数据库尚未创建', 'Database not created'))));
          else body.append(element('span', 'note-database-placeholder', tr(label('数据库尚未创建', 'Database not created'))),
            button(tr(label('重试', 'Retry')), () => write(session, { type: 'create', language: options.language?.() }), 'retry-create'));
        }
        return;
      }
      if (!view.bar) buildToolbar(view);
      const chartMode = page.chartView?.mode === 'chart';
      const showTable = !chartMode || page.chartShowData;
      const previousMode = view.mode;
      view.mode = chartMode ? 'chart' : 'data';
      if (showTable && !view.grid) buildGrid(view);
      if (view.table) view.table.hidden = !showTable;
      view.chartArea.hidden = !chartMode;
      if (chartMode) renderChartCards(view);
      if (view.modeControls) {
        view.dataMode.setAttribute('aria-pressed', String(!chartMode));
        view.chartMode.setAttribute('aria-pressed', String(chartMode));
      }
      if (previousMode && previousMode !== view.mode) {
        view.modeAnimation?.cancel();
        if (view.panel?.kind === 'view' || !chartMode && view.panel?.anchor.closest('.note-database-chart-card')) view.panel.close();
        if (!chartMode) releaseCharts(view, true);
        const content = chartMode ? view.chartArea : view.table;
        if (view.visible && isVisible(session) && document.documentElement.dataset.noteReducedMotion !== '1'
            && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          view.modeAnimation = content.animate?.([{ opacity: .55 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
        }
      }
      if (view.name.textContent !== (page.name || '')) view.name.textContent = page.name || '';
      const { query } = session;
      const language = options.language?.() || 'zh';
      if (view.language !== language) {
        view.language = language;
        view.root.setAttribute('aria-label', tr(label('数据库', 'Database')));
        view.moveGrip?.setAttribute('aria-label', tr(label('移动整个数据库', 'Move database block')));
        view.search.placeholder = tr(label('搜索', 'Search'));
        view.search.setAttribute('aria-label', tr(label('搜索数据库', 'Search database')));
        const controls = [[view.searchToggle, label('搜索', 'Search')], [view.viewToggle, label('视图选项', 'View options')],
          [view.addColumn, label('添加字段', 'Add field')], [view.addRow, label('添加记录', 'Add row')],
          [view.prev, label('上一页', 'Previous')], [view.next, label('下一页', 'Next')]];
        if (view.deleteTable) {
          controls.push([view.deleteTable, label('删除数据库', 'Delete database')],
            [view.chartToggle, label('展开图表列表', 'Open chart list')]);
          view.name.title = tr(label('双击重命名数据库', 'Double-click to rename database'));
          view.modeControls.setAttribute('aria-label', tr(label('数据库显示方式', 'Database display')));
          view.dataMode.textContent = tr(label('数据', 'Data'));
          view.chartMode.textContent = tr(label('图表', 'Chart'));
        }
        for (const [control, names] of controls) {
          if (!control) continue;
          control.title = tr(names);
          control.setAttribute('aria-label', control.title);
        }
      }
      if (!view.searchComposing && view.search.value !== query.search) view.search.value = query.search;
      view.search.hidden = !(view.searchOpen ?? Boolean(query.search));
      view.searchToggle.setAttribute('aria-expanded', String(!view.search.hidden));
      view.searchToggle.classList.toggle('is-engaged', Boolean(query.search));
      view.viewToggle.classList.toggle('is-engaged', Boolean(query.filters.length || (showTable && (query.sort || page.columns.some(column => column.hidden)))));
      if (!showTable) return;
      const activeBefore = document.activeElement;
      const focusedCell = view.grid.contains(activeBefore) && activeBefore.classList.contains('note-database-cell-value');
      const focusedHeader = view.header.contains(activeBefore) && activeBefore.dataset.dbRole;
      const columns = shownColumns(page);
      const headers = new Map();
      let width = view.readOnly ? 0 : 34;
      for (const column of columns) {
        const contentKey = JSON.stringify([column.name, column.type, column.choices, language]);
        const existing = view.headers.get(column.id);
        const header = existing?.contentKey === contentKey && existing.width === column.width
          ? existing : { ...buildHeader(view, column), contentKey, width: column.width };
        const sort = query.sort?.column === column.id ? query.sort.direction : null;
        header.cell.setAttribute('aria-sort', sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : 'none');
        header.track.style.width = widthOf(column) + 'px';
        width += widthOf(column);
        headers.set(column.id, header);
      }
      view.headers = headers;
      view.gridWidth = width;
      view.grid.style.width = 'max(100%, ' + width + 'px)';
      view.addColumn.disabled = page.columns.length >= 32;
      const heads = Array.from(headers.values());
      orderNodes(view.tracks, [...heads.map(header => header.track), view.fillerTrack, ...(view.readOnly ? [] : [view.laneTrack])]);
      orderNodes(view.header, [...heads.map(header => header.cell), view.fillerHeader, ...(view.readOnly ? [] : [view.lane])]);
      const nextRows = new Map(), focused = view.selection?.head;
      view.cells = new Map();
      for (const row of visibleRows(view)) {
        const entry = view.rowEntries.get(row.id) || { line: element('tr'), entries: new Map(),
          filler: element('td', 'note-database-filler') };
        const { line } = entry, nextCells = new Map(), controls = new Map();
        line.dataset.record = row.id;
        line.classList.toggle('is-pinned', view.pinned?.id === row.id);
        for (const column of columns) {
          const saved = entry.entries.get(column.id);
          const cell = saved?.cell || element('td');
          const value = row.values[column.id];
          const valueKey = value && typeof value === 'object' ? JSON.stringify(value) : value;
          const contentKey = headers.get(column.id).contentKey;
          const draft = session.draft;
          let control = saved?.control;
          if (!view.readOnly && draft?.detached && draft.row.id === row.id && draft.column.id === column.id) {
            draft.view = view;
            draft.detached = false;
            control = editorFor(draft);
          } else if (saved?.contentKey !== contentKey || saved.valueKey !== valueKey || !control?.isConnected
              || !cell.contains(control) || control.classList.contains('note-database-cell-input')) {
            control = cellControl(view, row, column);
          }
          if (cell.firstChild !== control) cell.replaceChildren(control);
          nextCells.set(column.id, { cell, control, contentKey, valueKey });
          controls.set(column.id, control);
        }
        if (!view.readOnly) {
          if (!entry.lane) {
            entry.lane = element('td', 'note-database-lane note-database-row-action');
            entry.menu = iconButton('more', '', () => showRowMenu(view, entry.menu, row), 'row-menu');
            entry.menu.tabIndex = -1;
            entry.lane.append(entry.menu);
            line.addEventListener('contextmenu', event => {
              event.preventDefault(); event.stopPropagation(); showRowMenu(view, entry.menu, row);
            });
          }
          if (entry.language !== language) {
            entry.language = language;
            entry.menu.title = tr(label('记录操作', 'Row actions'));
            entry.menu.setAttribute('aria-label', entry.menu.title);
          }
        }
        entry.filler.setAttribute('aria-hidden', 'true');
        orderNodes(line, [...Array.from(nextCells.values(), item => item.cell), entry.filler, ...(view.readOnly ? [] : [entry.lane])]);
        entry.entries = nextCells;
        nextRows.set(row.id, entry);
        view.cells.set(row.id, controls);
      }
      view.rowEntries = nextRows;
      orderNodes(view.rows, Array.from(nextRows.values(), item => item.line));
      if (view.panel && !view.panel.anchor.isConnected) view.panel.close();
      if (!bounds(view)) view.selection = null;
      paintSelection(view);
      const count = Math.max(1, Math.ceil(page.total / page.pageSize));
      view.pager.hidden = count <= 1;
      view.prev.disabled = page.page <= 1;
      view.next.disabled = page.page >= count;
      view.pageText.textContent = page.page + ' / ' + count;
      if (focusedCell && focused && activeBefore !== document.activeElement) {
        (view.cells.get(focused[0])?.get(focused[1]) || view.tabStop || view.addRow)?.focus({ preventScroll: true });
      } else if (focusedHeader && !activeBefore.isConnected) {
        view.header.querySelector('[data-db-role="' + CSS.escape(focusedHeader) + '"]')?.focus({ preventScroll: true });
      }
    }

    function stopObserving(target) {
      if (!target || !observed.delete(target)) return;
      observer.unobserve(target);
      if (!observed.size) {
        observer.disconnect();
        observer = null;
      }
    }

    function watch(view, target = view.root) {
      if (!observer) observer = new IntersectionObserver(entries => {
        const changed = new Set();
        for (const entry of entries) {
          const current = observed.get(entry.target);
          if (current && entry.target === current.chartStage) {
            current.chartIntersecting = entry.isIntersecting;
            if (!current.chartIntersecting) releaseChart(current);
            changed.add(current.session);
            continue;
          }
          if (!current || current.visible === entry.isIntersecting) continue;
          current.visible = entry.isIntersecting;
          if (current.visible) {
            draw(current);
            void read(current.session);
          } else {
            releaseCharts(current);
            if (current.panel?.kind?.startsWith('chart')) current.panel.close();
            if (current.session.draft?.view === current) dismissSuggestions(current.session.draft);
          }
          changed.add(current.session);
        }
        for (const session of changed) syncCharts(session);
      });
      observed.set(target, view);
      observer.observe(target);
    }

    function mount(host, { path, databaseId, readOnly = false, observe = false, onLayout, onMoveBlock } = {}) {
      if (destroyed || !path || !databaseId) return () => {};
      const session = getSession(path, databaseId);
      const root = element('section', 'note-database');
      root.contentEditable = 'false';
      root.setAttribute('aria-label', tr(label('数据库', 'Database')));
      const body = element('div', 'note-database-body');
      const status = element('div', 'note-database-status', session.status);
      status.hidden = !session.status;
      status.setAttribute('role', 'status');
      root.append(body, status);
      host.append(root);
      observe = observe && !!window.IntersectionObserver;
      const view = { session, host, root, body, status, readOnly, onLayout, onMoveBlock, observe, visible: !observe, cards: new Map() };
      root.addEventListener('copy', event => clipboard(view, event));
      root.addEventListener('paste', event => clipboard(view, event));
      root.addEventListener('keydown', event => {
        if (readOnly || (view.mode === 'chart' && !view.table?.contains(event.target)) || composing(event) || !(event.ctrlKey || event.metaKey) || event.altKey
            || event.target.closest('input,textarea,select') || view.panel || session.draft) return;
        const key = event.key.toLowerCase();
        if (key !== 'z' && key !== 'y') return;
        event.preventDefault(); event.stopPropagation();
        const replay = key === 'y' || event.shiftKey ? 'redo' : 'undo';
        const changes = session[replay].at(-1)?.changes;
        if (changes && !session.write) void write(session, { type: 'applyRecords', changes }, replay);
      });
      root.addEventListener('pointerup', event => {
        if (view.cellGesture?.id === event.pointerId) view.cellGesture.ended = true;
      });
      root.addEventListener('pointerleave', event => {
        if (view.cellGesture?.id === event.pointerId) view.cellGesture.ended = true;
      });
      root.addEventListener('pointercancel', () => { view.cellGesture = null; });
      root.addEventListener('focusout', () => queueMicrotask(() => {
        if (!view.visible || !root.isConnected) return;
        const next = document.activeElement?.closest('[data-record]')?.dataset.record;
        if (!view.addingRow) releasePinned(view, next);
      }));
      session.views.add(view);
      if (view.visible) { draw(view); void read(session); syncCharts(session); }
      else {
        if (session.page?.chartView?.mode === 'chart') draw(view);
        watch(view);
      }
      return () => {
        view.panel?.close();
        view.modeAnimation?.cancel();
        releaseCharts(view, true);
        view.stopResize?.(false);
        stopObserving(view.root);
        view.visible = false;
        session.views.delete(view);
        const draft = session.draft;
        if (draft?.view === view) {
          removeAttachmentPicker(draft);
          dismissSuggestions(draft);
          draft.detached = true;
          if (!draft.composition && !draft.error && !destroyed && isVisible(session)) void commitDraft(draft);
        }
        root.remove();
        syncCharts(session);
      };
    }

    async function confirm(message, callback = options.confirm) {
      return callback ? await callback(message) : window.confirm(tr(message));
    }

    const noteAction = (path, action) => request(actionRoute, { path, action });

    async function deleteTables(path, action) {
      const result = await noteAction(path, action);
      for (const databaseId of result.deletedIds) {
        const session = sessions.get(sessionKey(path, databaseId));
        if (session) {
          stopRead(session);
          session.stale = false;
          session.undo.length = session.redo.length = 0;
          applyPage(session, { exists: false, deleted: true, revision: null });
        }
        markChanged(path, databaseId);
      }
      return result;
    }

    async function cleanup(path, callback) {
      try {
        const preview = await noteAction(path, { type: 'previewCleanup' });
        if (destroyed) return false;
        if (!preview.count) {
          options.onNotice?.(tr(label('没有可清理的附件。', 'There are no unused attachments.')));
          return false;
        }
        const message = label(`将 ${preview.count} 个未使用附件移到系统回收站？`, `Move ${preview.count} unused attachment(s) to the Recycle Bin?`);
        if (!await confirm(message, callback) || destroyed) return false;
        const { deletedCount } = await noteAction(path, { type: 'cleanup', candidateToken: preview.candidateToken });
        if (!destroyed) options.onNotice?.(tr(label(`已回收 ${deletedCount} 个未使用附件。`, `Moved ${deletedCount} unused attachment(s) to the Recycle Bin.`)));
        return true;
      } catch (error) {
        if (!destroyed) options.onError?.(error);
        return false;
      }
    }

    async function importFiles(path, files, candidates, current) {
      let imported = 0;
      let error = null;
      let databaseId = null;
      for (const file of files) {
        if (destroyed || !current()) break;
        if (!acceptsFile(file)) continue;
        if (file.size > maxFileSize) { error = new Error(tr(label('单个附件不能超过 100 MiB。', 'An attachment cannot exceed 100 MiB.'))); continue; }
        try {
          const data = await readFile(file);
          if (destroyed || !current()) break;
          ({ databaseId } = await request(importRoute, { path, name: file.name, data, candidates }));
          imported++;
        } catch (failure) { error = failure; }
      }
      if (!destroyed && current()) {
        if (imported) options.onNotice?.(tr(label(`已导入 ${imported} 个附件。`, `Imported ${imported} attachment(s).`)));
        if (error) options.onError?.(error);
      }
      return { imported, databaseId };
    }

    function setActive(path, visible = true) {
      if (activePath === path && activeVisible === visible) return;
      for (const previous of sessionsFor(activePath)) {
        stopRead(previous);
        clearChart(previous);
        previous.stale = true;
        if (previous.draft) {
          removeAttachmentPicker(previous.draft);
          dismissSuggestions(previous.draft);
        }
        for (const view of previous.views) {
          view.panel?.close();
          view.modeAnimation?.cancel();
          releaseCharts(view);
          view.stopResize?.(false);
          view.pinned = null;
        }
      }
      activePath = path;
      activeVisible = visible;
      if (visible) void refresh(path);
    }

    function clearSession(session, force) {
      stopRead(session);
      clearChart(session);
      if (session.draft) {
        removeAttachmentPicker(session.draft);
        dismissSuggestions(session.draft);
      }
      for (const view of session.views) {
        view.panel?.close();
        view.modeAnimation?.cancel();
        releaseCharts(view, true);
        view.stopResize?.(false);
        stopObserving(view.root);
        view.visible = false;
        view.root.remove();
      }
      session.views.clear();
      if (!force && (session.draft?.changed || session.draft?.composition || session.draft?.uploading || session.write)) {
        if (session.draft) session.draft.detached = true;
        session.stale = true;
        return;
      }
      sessions.delete(sessionKey(session.path, session.databaseId));
      notifyDirty();
    }

    function clear(path, force = false) {
      for (const session of sessionsFor(path)) clearSession(session, force);
    }

    function remap(source, destination) {
      if (!source || !destination || source === destination) return;
      const movedPath = path => path === source || path?.startsWith(source + '/') ? destination + path.slice(source.length) : path;
      for (const [key, session] of Array.from(sessions)) {
        const { path, databaseId } = session;
        const moved = movedPath(path);
        if (moved === path) continue;
        stopRead(session);
        clearChart(session);
        for (const view of session.views) releaseCharts(view);
        if (session.draft) {
          removeAttachmentPicker(session.draft);
          dismissSuggestions(session.draft);
        }
        sessions.delete(key);
        session.path = moved;
        session.stale = true;
        sessions.set(sessionKey(moved, databaseId), session);
      }
      activePath = movedPath(activePath);
      void refresh();
    }

    const focus = () => { if (activeVisible) void refresh(); };
    const dismiss = () => {
      for (const session of sessionsFor(activePath)) if (session.draft && !session.draft.picker) dismissSuggestions(session.draft);
    };
    const languageChange = () => {
      for (const session of sessionsFor(activePath)) {
        for (const view of session.views) if (view.visible) { view.panel?.close(); draw(view); }
        syncCharts(session);
      }
    };
    const paletteEvent = window.RelatumNoteChartPalette?.changed;
    const paletteChange = () => {
      for (const session of sessionsFor(activePath)) for (const view of session.views) for (const card of view.cards.values()) {
        card.refreshChartColors?.();
        repaintChart(card);
      }
    };
    window.addEventListener('focus', focus);
    window.addEventListener('blur', dismiss);
    if (paletteEvent) window.addEventListener(paletteEvent, paletteChange);
    document.addEventListener('relatum:languagechange', languageChange);
    if (channel) channel.onmessage = event => {
      if (event.data?.path === activePath) void refresh(activePath, true, event.data.databaseId);
    };

    return {
      mount, setActive, refresh, clear, remap, acceptsFile, importFiles,
      noteSaved(path, created = {}, failed = []) {
        for (const [id, page] of Object.entries(created)) {
          const session = getSession(path, id);
          stopRead(session);
          session.stale = false;
          applyPage(session, page);
          markChanged(path, id);
        }
        for (const session of sessionsFor(path)) {
          if (failed.includes(session.databaseId)) {
            session.creationFailed = true;
            announce(session, tr(label('建库失败，请重试。', 'Could not create the database. Try again.')));
          }
          if (session.stale) void read(session);
        }
      },
      cleanup, deleteTables,
      list: path => noteAction(path, { type: 'list' }),
      inputPending: () => sessionsFor(activePath).some(session => session.draft || session.write),
      get dirty() { return dirty(); },
      async whenInputSettled(path) {
        const targets = path ? sessionsFor(path) : sessions.values();
        for (const session of targets) if (!await settleSession(session)) return false;
        return true;
      },
      destroy() {
        destroyed = true;
        for (const session of sessions.values()) clearSession(session, true);
        channel?.close();
        window.removeEventListener('focus', focus);
        window.removeEventListener('blur', dismiss);
        if (paletteEvent) window.removeEventListener(paletteEvent, paletteChange);
        document.removeEventListener('relatum:languagechange', languageChange);
      },
    };
  }

  window.RelatumNoteDatabase = { create, renderPrint, acceptsFile };
})();
