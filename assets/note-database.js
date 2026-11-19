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
    line: ['折线图', 'Line chart'], doughnut: ['环形图', 'Doughnut chart'] };
  const chartMetrics = { sum: ['求和', 'Sum'], avg: ['平均值', 'Average'], min: ['最小值', 'Minimum'], max: ['最大值', 'Maximum'] };
  const chartBuckets = { day: ['日', 'Day'], week: ['周', 'Week'], month: ['月', 'Month'] };
  const chartMessages = {
    loading: ['正在加载图表…', 'Loading chart…'],
    empty: ['没有可绘制的记录。可修改筛选条件，或到数据表添加记录。', 'No chart data. Change the filters or add records in Data.'],
    invalid_chart: ['图表字段已不可用，请重新选择字段。', 'A chart field is unavailable. Choose another field.'],
    chart_group_limit: ['分组太多。请缩小筛选范围，或使用更粗的日期粒度。', 'Too many groups. Narrow the filters or use a larger date interval.'],
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
    settings: 'M2 4h12M2 8h12M2 12h12M5 2.5v3m5.5 1v3M6.5 10.5v3',
    palette: 'M8.1 2.1a5.9 5.9 0 1 0 0 11.8h.8a1.3 1.3 0 0 0 1-2.1 1.1 1.1 0 0 1 .9-1.8h1.3a2 2 0 0 0 2-2.1 5.9 5.9 0 0 0-6-5.8ZM5 6.2h.1M8 4.8h.1M11 6h.1M4.7 9.4h.1',
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
    return String(value);
  }

  function selectedChoices(value, column) {
    const ids = Array.isArray(value) ? value : value == null ? [] : [value];
    return ids.map(id => column.choices?.find(option => option.id === id)).filter(Boolean);
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

  async function renderPrint(host, path, databaseId, language) {
    const tr = pair => translate(language, pair);
    try {
      const page = await loadPage(path, databaseId, makeQuery(), AbortSignal.timeout(10000));
      if (!page.exists) {
        host.textContent = page.deleted ? tr(label('数据库已删除', 'Database deleted')) : tr(label('数据库尚未创建', 'Database not created'));
        return 0;
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
      host.replaceChildren(table);
      const remaining = page.total - page.rows.length;
      if (remaining > 0) host.append(element('p', '', tr(label(`另有 ${remaining} 行`, `${remaining} more rows`))));
      return 0;
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
        read: null, write: null, timer: 0, undo: [], redo: [],
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
      session.chartJob?.controller?.abort();
      session.chartJob = null;
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

    function chartVisible(view) {
      return !!view.chartStage && !view.chartStage.hidden && view.chartStage.isConnected
        && view.visible && (!view.observe || view.chartIntersecting) && isVisible(view.session);
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
      } else if (!view.readOnly && ['invalid_chart', 'chart_group_limit', 'chart_metric_domain', 'chart_numeric_range'].includes(status)) {
        view.chartStatus.append(button(tr(label('图表设置', 'Chart settings')), () => openChartSettings(view, view.chartSettings), 'chart-reconfigure'));
      }
    }

    function paintChart(view, model) {
      const language = options.language?.() || 'zh';
      const dark = document.documentElement.dataset.startTheme === 'dark' || document.body.dataset.startTheme === 'dark';
      const style = view.chartStyleDraft ?? view.session.page?.chartView?.style ?? {};
      const appearance = { language, dark, palette: window.RelatumNoteChartPalette.effective(style.palette),
        ...(model.chart.type === 'doughnut' ? { categories: style.categories ?? {} } : { primary: style.primary }) };
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
        const renderer = view.chartRenderer = runtime.mount(view.chartCanvas, model, appearance);
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

    function requestChart(session, key, revision, chart, query) {
      const controller = new AbortController();
      const job = session.chartJob = { key, controller };
      const { path, databaseId } = session;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
      void request(chartRoute, { path, databaseId, query, chart }, signal).then(async model => {
        if (session.chartJob !== job) return;
        if (!model.exists || model.revision !== revision) {
          session.stale = true;
          await read(session);
          if (session.chartJob !== job) return;
          job.status = 'failed';
        } else if (model.groups.some(point => Number.isFinite(point.value))) job.model = model;
        else job.status = 'empty';
        syncCharts(session);
      }).catch(error => {
        if (session.chartJob !== job) return;
        job.status = Object.hasOwn(chartMessages, error.code) ? error.code : 'failed';
        syncCharts(session);
      });
    }

    function syncCharts(session) {
      const chartView = session.page?.chartView;
      if (chartView?.mode !== 'chart') { clearChart(session); return; }
      const views = Array.from(session.views).filter(chartVisible);
      if (!chartView.valid) {
        clearChart(session);
        for (const view of views) {
          releaseChart(view);
          showChartStatus(view, 'invalid_chart');
        }
        return;
      }
      if (!views.length) {
        const job = session.chartJob;
        if (job?.model && isVisible(session)) offscreenChart = { session, key: job.key, model: job.model };
        stopChartRead(session);
        return;
      }
      const { search, filters } = session.query;
      const { revision } = session.page, { chart } = chartView;
      const key = JSON.stringify([revision, chart, search, filters]);
      if (session.chartJob?.key !== key) {
        stopChartRead(session);
        for (const view of views) {
          releaseChart(view);
          showChartStatus(view, session.readFailed ? 'failed' : 'loading');
        }
        if (session.stale || session.read || session.write || session.renderedQuery !== JSON.stringify(session.query)) return;
        if (session.readFailed) return;
        const cached = offscreenChart?.session === session ? offscreenChart : null;
        if (cached) offscreenChart = null;
        if (cached?.key === key) session.chartJob = { key, model: cached.model };
        else requestChart(session, key, revision, chart, { search, filters });
      }
      const job = session.chartJob;
      for (const view of views) {
        view.syncChartColorCategories?.(job.model?.groups);
        if (job.model) paintChart(view, job.model);
        else showChartStatus(view, job.status || 'loading');
      }
    }

    function repaintChart(view) {
      const model = view.session.chartJob?.model;
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
      const { inverse, addedId, addedRow, updatedRow, addedColumn, deletedCount, ...snapshot } = page;
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
            if (session.page) session.page = { ...session.page, revision: page.revision, chartView: page.chartView };
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
      if (view.table?.hidden) return;
      const range = bounds(view);
      if (!range || event.target.closest('input,textarea,select') || view.readOnly) return;
      if (view.session.draft || view.session.write) return;
      if (event.type === 'copy') {
        if (!event.clipboardData) return;
        const columns = range.columns.slice(range.c0, range.c1 + 1);
        const encode = value => /["\t\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
        const text = range.rows.slice(range.r0, range.r1 + 1).map(row =>
          columns.map(column => encode(display(row.values[column.id], column, tr))).join('\t')).join('\r\n');
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const text = clear ? '' : event.clipboardData?.getData('text/plain');
      if (text === undefined || (!clear && !text)) return;
      event.preventDefault();
      event.stopPropagation();
      if (view.session.renderedQuery !== JSON.stringify(view.session.query)) {
        announce(view.session, tr(label('视图正在更新，更新后可继续编辑范围。', 'The view is updating. Try again when the rows are ready.')));
        return;
      }
      let matrix;
      try {
        if (text.length > 4 * 1024 * 1024) throw new Error('length');
        matrix = clear ? Array.from({ length: range.r1 - range.r0 + 1 }, () => Array(range.c1 - range.c0 + 1).fill('')) : parseClipboard(text);
      } catch (_) {
        announce(view.session, tr(label('无法读取粘贴内容。', 'Could not read the pasted data.')));
        return;
      }
      if (matrix.length > 200) {
        announce(view.session, tr(label('一次最多粘贴 200 行。', 'Paste up to 200 rows at a time.')));
        return;
      }
      const changes = [];
      const { query, page } = view.session;
      const canAppend = !query.search && !query.sort && !query.filters.length && page.page * page.pageSize >= page.total;
      for (const [r, values] of matrix.entries()) {
        const row = range.rows[range.r0 + r];
        if ((!row && !canAppend) || (row && !page.rows.some(item => item.id === row.id))) {
          announce(view.session, tr(label('粘贴超出当前页，表格未修改。', 'The paste extends beyond the current page. No cells changed.')));
          return;
        }
        const parsed = {};
        for (const [c, value] of values.entries()) {
          const column = range.columns[range.c0 + c];
          try {
            if (!column) throw new Error('column');
            parsed[column.id] = clipboardValue(value, column);
          } catch (_) {
            const target = range.columns[Math.min(range.c0 + c, range.columns.length - 1)];
            focusCell(view, [(row || range.rows.at(-1)).id, target.id]);
            announce(view.session, tr(label(
              `粘贴内容第 ${r + 1} 行、第 ${c + 1} 列超出范围或类型不符，表格未修改。`,
              `Pasted row ${r + 1}, column ${c + 1} is out of range or has the wrong type. No cells changed.`)));
            return;
          }
        }
        changes.push({ row: row?.id ?? null, values: parsed });
      }
      void write(view.session, { type: 'batchCells', changes });
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
        if (view.panel?.close === close) view.panel = null;
        if (restore && anchor.isConnected) (returnFocus?.() || anchor).focus({ preventScroll: true });
      };
      view.panel = { anchor, kind, close, choices };
      const initial = content(surface, close, { popup: panel, portal: choicesPortal, signal: controller.signal });
      view.root.append(panel);
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

    async function confirmEdit(view, message) {
      const current = () => view.root.isConnected && isVisible(view.session);
      return current() && (options.confirmEdit ? await options.confirmEdit(message, current) : window.confirm(tr(message))) && current();
    }

    function filterForm(view, container, index) {
      const { page, query } = view.session;
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
      const names = { contains: label('包含', 'Contains'), equals: label('等于', 'Equals'), gt: label('大于', 'Greater than'),
        lt: label('小于', 'Less than'), empty: label('为空', 'Is empty'), notEmpty: label('不为空', 'Is not empty') };
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
        for (const key of operators[type] || []) operator.add(new Option(tr(names[key]), key));
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
        view.panel?.close(true);
        changeQuery(view.session, { filters: query.filters.filter((_, position) => position !== index) });
      }));
      panel.addEventListener('submit', event => {
        event.preventDefault();
        const type = page.columns.find(item => item.id === column.value)?.type;
        const raw = value?.value ?? null;
        const filterValue = raw === null ? null : type === 'number' ? Number(raw) : type === 'checkbox' ? raw === 'true' : raw;
        const filters = query.filters.slice();
        filters[index] = { column: column.value, operator: operator.value, value: filterValue };
        view.panel?.close(true);
        changeQuery(view.session, { filters });
      });
      container.append(panel);
      view.panel?.choices?.enhanceAll();
      (view.panel?.choices?.enhance(column).anchor || column).focus();
    }

    function renameDatabase(view, anchor) {
      panelAt(view, anchor, 'renameDatabase', (panel, close) => {
        const { session } = view;
        const field = input('text', tr(label('数据库名称', 'Database name')), session.page.name);
        field.maxLength = 120;
        const save = async () => {
          const name = field.value.trim();
          if (session.write || !name) return;
          if (name === session.page.name || await write(session, { type: 'renameDatabase', name })) close(true);
        };
        field.addEventListener('keydown', event => {
          if (event.key === 'Enter' && !composing(event)) { event.preventDefault(); void save(); }
        });
        panel.append(field, button(tr(label('保存名称', 'Save name')), save));
        return field;
      }, { name: tr(label('重命名数据库', 'Rename database')) });
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

    function openChartPalette(view) {
      const palette = window.RelatumNoteChartPalette;
      if (!palette || !view.session.page?.chartView?.valid) return;
      panelAt(view, view.chartPalette, 'chart-palette', (panel, close, { signal }) => {
        const { session } = view;
        const current = session.page.chartView;
        const chart = current.chart;
        const ring = chart.type === 'doughnut';
        const groupType = session.page.columns.find(column => column.id === chart.groupBy)?.type;
        const copy = (style = {}) => ({ ...style, categories: { ...style.categories } });
        let draft = copy(current.style), revision = current.styleRevision, target = null, saving = false;
        let categoryGroups, rows = [];

        const form = element('form', 'note-database-chart-form note-database-color-form');
        const preset = select(tr(label('配色预设', 'Color preset')),
          [['', tr(label('跟随笔记设置', 'Follow note settings'))], ...palette.presets.map(([id, names]) => [id, tr(names)])], draft.palette || '');
        preset.dataset.dbRole = 'chart-palette-preset';
        const presetRow = element('label');
        presetRow.append(element('span', '', tr(label('配色预设', 'Color preset'))), preset);
        const sample = element('div', 'note-database-color-preview');
        sample.setAttribute('aria-hidden', 'true');
        const sampleChips = Array.from({ length: 8 }, () => element('i', 'note-database-color-chip'));
        sample.append(...sampleChips);

        const picker = element('div', 'note-database-color-picker');
        const pickerLabel = element('strong', '', tr(label('主色', 'Main color')));
        const swatches = element('div', 'note-database-color-swatches');
        picker.append(pickerLabel, swatches);
        const categories = element('div', 'note-database-color-categories');
        const status = element('div', 'note-database-option-error');
        status.setAttribute('role', 'status');
        status.hidden = true;

        function setChip(node, light, dark) {
          node.style.setProperty('--chart-chip-light', light);
          node.style.setProperty('--chart-chip-dark', dark);
        }
        const swatchButtons = palette.swatches.map(([id, names]) => {
          const swatch = button('', () => chooseColor(id), 'chart-color-swatch');
          swatch.dataset.swatch = id;
          swatch.title = tr(names); swatch.setAttribute('aria-label', swatch.title);
          const chip = element('i', 'note-database-color-chip');
          setChip(chip, palette.swatchColor(id, false), palette.swatchColor(id, true));
          swatch.append(chip);
          return [id, swatch];
        });
        const automatic = button(tr(label('自动', 'Automatic')), () => chooseColor(null), 'chart-color-auto');
        swatches.append(automatic, ...swatchButtons.map(([, swatch]) => swatch));
        categories.hidden = true;

        function syncCategories(groups) {
          if (groups === categoryGroups) return;
          categoryGroups = groups;
          rows = (groups || []).filter(point => Number.isFinite(point.value)).map(point => {
            const name = palette.categoryLabel(point, groupType, options.language?.() === 'en');
            const row = button('', () => {
              if (saving) return;
              target = point.colorKey;
              pickerLabel.textContent = name;
              refreshColors();
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

        function refreshColors() {
          const effective = palette.effective(draft.palette);
          const light = palette.colors(effective, false), dark = palette.colors(effective, true);
          sampleChips.forEach((chip, index) => setChip(chip, light[index], dark[index]));
          picker.hidden = ring && !target;
          const selected = ring ? draft.categories[target] : draft.primary;
          automatic.setAttribute('aria-pressed', String(!selected));
          for (const [id, swatch] of swatchButtons) swatch.setAttribute('aria-pressed', String(selected === id));
          for (const { point, row, chip } of rows) {
            const id = draft.categories[point.colorKey];
            setChip(chip, palette.categoryColor(effective, false, chart.groupBy, point.key, id),
              palette.categoryColor(effective, true, chart.groupBy, point.key, id));
            row.setAttribute('aria-pressed', String(target === point.colorKey));
          }
        }
        function preview() {
          view.chartStyleDraft = copy(draft);
          refreshColors();
          repaintChart(view);
        }
        function chooseColor(id) {
          if (saving || (ring && !target)) return;
          if (ring) {
            if (id) draft.categories[target] = id;
            else delete draft.categories[target];
          } else if (id) draft.primary = id;
          else delete draft.primary;
          preview();
        }
        function resetDraft(style) {
          draft = copy(style);
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
          const saved = session.page.chartView;
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
        form.append(presetRow, sample, picker);
        if (ring) {
          form.append(categories);
          syncCategories(session.chartJob?.model?.groups);
          view.syncChartColorCategories = syncCategories;
        }
        form.append(status, reload, actions);
        panel.append(form);
        refreshColors();
        view.refreshChartColors = refreshColors;
        view.chartStyleTarget = `${chart.type}:${chart.groupBy}`;
        signal.addEventListener('abort', () => {
          delete view.chartStyleDraft;
          delete view.refreshChartColors;
          delete view.syncChartColorCategories;
          delete view.chartStyleTarget;
          repaintChart(view);
        }, { once: true });
        form.addEventListener('submit', async event => {
          event.preventDefault();
          if (saving || !isVisible(session) || !view.host.isConnected) return;
          if (session.page.chartView.styleRevision !== revision) {
            showError(tr(label('配色已在其他窗口更改。可载入已保存的配色。', 'Colors changed in another window. Reload the saved colors.')));
            reload.hidden = false;
            return;
          }
          saving = true;
          save.disabled = reset.disabled = cancel.disabled = preset.disabled = true;
          view.panel?.choices?.sync(preset);
          showError('');
          const result = await write(session, { type: 'setChartAppearance', styleRevision: revision, style: copy(draft) });
          if (signal.aborted) return;
          if (result) { close(true); return; }
          saving = false;
          save.disabled = reset.disabled = cancel.disabled = preset.disabled = false;
          view.panel?.choices?.sync(preset);
          showError(session.status || tr(label('配色保存失败，请重试。', 'Could not save colors. Please try again.')));
          save.focus({ preventScroll: true });
        });
        return preset;
      });
    }

    function openChartSettings(view, anchor) {
      panelAt(view, anchor, 'chart', (panel, close, { signal }) => {
        const { session } = view;
        const { fields = [], suggested } = session.page.chartOptions || {};
        const compatible = Object.entries(chartTypes).filter(([type]) => fields.some(field => field.groupCharts.includes(type)));
        if (!compatible.length) {
          panel.append(element('p', 'note-database-chart-notice', tr(label('先添加可用于分组的字段，例如日期、文本或标签。',
            'Add a grouping field first, such as a date, text, or tag.'))));
          const dismiss = button(tr(label('关闭', 'Close')), () => close(true));
          panel.append(dismiss);
          return dismiss;
        }
        const initial = session.page.chartView?.chart || suggested;
        const form = element('form', 'note-database-chart-form');
        const field = (labelPair, role) => {
          const name = tr(labelPair), wrapper = element('label'), input = select(name, [], '');
          input.dataset.dbRole = role;
          wrapper.append(element('span', '', name), input);
          form.append(wrapper);
          return { wrapper, input };
        };
        const type = field(label('图表类型', 'Chart type'), 'chart-type').input;
        const group = field(label('分组字段', 'Group by'), 'chart-group').input;
        const measure = field(label('统计值', 'Measure'), 'chart-measure').input;
        const aggregation = field(label('汇总方式', 'Aggregation'), 'chart-aggregation');
        const bucket = field(label('日期粒度', 'Date interval'), 'chart-bucket');
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
        const updateFields = (groupId = group.value, measureId = measure.value, op = aggregation.input.value) => {
          const groups = fields.filter(field => field.groupCharts.includes(type.value));
          fill(group, groups.map(field => [field.id, fieldName(field)]), groupId);
          const selected = groups.find(field => field.id === group.value);
          const numbers = selected?.type === 'multiSelect' ? [] : fields.filter(field => field.metrics.length);
          fill(measure, [['', tr(label('记录数', 'Record count'))], ...numbers.map(field => [field.id, fieldName(field)])], measureId);
          const metric = numbers.find(field => field.id === measure.value);
          aggregation.wrapper.hidden = !metric;
          fill(aggregation.input, (metric?.metrics || []).map(key => [key, tr(chartMetrics[key])]), op || 'sum');
          bucket.wrapper.hidden = selected?.type !== 'date';
        };
        fill(type, compatible.map(([key, names]) => [key, tr(names)]), initial?.type);
        fill(bucket.input, Object.entries(chartBuckets).map(([key, names]) => [key, tr(names)]), initial?.bucket || 'day');
        updateFields(initial?.groupBy, initial?.metric?.column, initial?.metric?.op);
        for (const control of [type, group, measure]) control.addEventListener('change', () => updateFields());
        form.addEventListener('submit', async event => {
          event.preventDefault();
          if (save.disabled || !group.value || !isVisible(session) || !view.host.isConnected) return;
          const chart = { type: type.value, groupBy: group.value, metric: measure.value
            ? { op: aggregation.input.value, column: measure.value } : { op: 'count' } };
          if (!bucket.wrapper.hidden) chart.bucket = bucket.input.value;
          save.disabled = cancel.disabled = true;
          const result = await write(session, { type: 'setChartView', mode: 'chart', chart });
          if (signal.aborted) return;
          if (result) close(true);
          else { save.disabled = cancel.disabled = false; save.focus({ preventScroll: true }); }
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
        if (mode === 'chart' && !session.page.chartView?.valid) openChartSettings(view, view.chartMode);
        else {
          view.panel?.close();
          await write(session, { type: 'setChartView', mode });
        }
      } finally {
        session.chartSwitching = false;
      }
    }

    function viewMenu(view, anchor) {
      panelAt(view, anchor, 'view', (panel, close) => {
        const { page, query } = view.session;
        const chartMode = page.chartView?.mode === 'chart';
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
        if (!chartMode) panel.append(sort);
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
        if (chartMode) return add;
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
        const rename = () => afterCellSave(view, () => renameDatabase(view, view.name));
        view.name = button('', event => { if (!event.detail) void rename(); }, 'rename-database');
        view.name.addEventListener('dblclick', () => void rename());
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
        modes.append(view.dataMode, view.chartMode);
        view.bar.append(modes);
      }
      view.bar.append(view.search, tools);
      if (!view.readOnly) {
        view.chartSettings = iconButton('settings', tr(label('图表设置', 'Chart settings')),
          () => openChartSettings(view, view.chartSettings), 'chart-settings');
        view.chartPalette = iconButton('palette', tr(label('图表配色', 'Chart colors')),
          () => openChartPalette(view), 'chart-palette');
        tools.prepend(view.chartSettings, view.chartPalette);
        view.deleteTable = iconButton('trash', tr(label('删除数据库', 'Delete database')), () =>
          afterCellSave(view, () => deleteCurrentTable(view)), 'delete-database');
        tools.append(view.deleteTable);
      }
      tools.append(view.viewToggle);
      view.chartStage = element('div', 'note-database-chart-stage');
      view.chartStage.hidden = true;
      view.chartCanvas = element('div', 'note-database-chart-canvas');
      view.chartStatus = element('div', 'note-database-chart-status');
      view.chartStatus.setAttribute('role', 'status');
      view.chartStage.append(view.chartCanvas, view.chartStatus);
      body.append(view.bar, view.chartStage);
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
        releaseChart(view);
        stopObserving(view.chartStage);
        view.bar = view.grid = view.table = view.chartStage = null;
        view.mode = view.chartStatusKey = view.language = null;
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
      const previousMode = view.mode;
      view.mode = chartMode ? 'chart' : 'data';
      if (!chartMode && !view.grid) buildGrid(view);
      if (view.table) view.table.hidden = chartMode;
      view.chartStage.hidden = !chartMode;
      if (view.observe && previousMode !== view.mode) {
        view.chartIntersecting = false;
        if (chartMode) watch(view, view.chartStage);
        else stopObserving(view.chartStage);
      }
      if (view.chartSettings) view.chartSettings.hidden = !chartMode;
      if (view.chartPalette) {
        view.chartPalette.hidden = !chartMode;
        view.chartPalette.disabled = !page.chartView?.valid;
        if (view.panel?.kind === 'chart-palette' && (!chartMode || !page.chartView.valid
            || `${page.chartView.chart.type}:${page.chartView.chart.groupBy}` !== view.chartStyleTarget)) view.panel.close();
      }
      if (view.modeControls) {
        view.dataMode.setAttribute('aria-pressed', String(!chartMode));
        view.chartMode.setAttribute('aria-pressed', String(chartMode));
      }
      if (previousMode && previousMode !== view.mode) {
        view.modeAnimation?.cancel();
        if (view.panel?.kind === 'view') view.panel.close();
        if (chartMode) showChartStatus(view, 'loading');
        else releaseChart(view);
        const content = chartMode ? view.chartStage : view.table;
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
          controls.push([view.deleteTable, label('删除数据库', 'Delete database')], [view.chartSettings, label('图表设置', 'Chart settings')],
            [view.chartPalette, label('图表配色', 'Chart colors')]);
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
      view.viewToggle.classList.toggle('is-engaged', Boolean(query.filters.length || (!chartMode && (query.sort || page.columns.some(column => column.hidden)))));
      if (chartMode) return;
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
            releaseChart(current);
            if (['chart', 'chart-palette'].includes(current.panel?.kind)) current.panel.close();
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
      const view = { session, host, root, body, status, readOnly, onLayout, onMoveBlock, observe, visible: !observe };
      root.addEventListener('copy', event => clipboard(view, event));
      root.addEventListener('paste', event => clipboard(view, event));
      root.addEventListener('keydown', event => {
        if (readOnly || view.mode === 'chart' || composing(event) || !(event.ctrlKey || event.metaKey) || event.altKey
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
        releaseChart(view);
        view.stopResize?.(false);
        stopObserving(view.root);
        stopObserving(view.chartStage);
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
          releaseChart(view);
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
        releaseChart(view);
        view.stopResize?.(false);
        stopObserving(view.root);
        stopObserving(view.chartStage);
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
        for (const view of session.views) releaseChart(view);
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
      for (const session of sessionsFor(activePath)) for (const view of session.views) {
        view.refreshChartColors?.();
        repaintChart(view);
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
