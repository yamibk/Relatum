// 起步页「生涯」：只读冻结快照，用原生 SVG 绘制本地使用报告。
(function () {
  'use strict';

  const root = document.querySelector('[data-start-workspace-panel="career"]');
  if (!root) return;
  const scroll = root.querySelector('[data-role="career-scroll"]');
  const entry = root.querySelector('[data-role="career-entry"]');
  const loading = root.querySelector('[data-role="career-loading"]');
  const reportHost = root.querySelector('[data-role="career-report"]');
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SCROLL_IDLE_MS = 80;
  const SCROLL_REVEAL_WINDOW_MS = 240;
  const WEEKDAYS_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const WEEKDAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const KIND_ZH = {
    card: '卡片', preview: '预览', index: '索引', sticky: '便签', code: '代码',
    table: '表格', 'task-root': '任务', image: '图片', attachment: '附件',
    group: '分组', shape: '图形', other: '其他',
  };
  const KIND_EN = {
    card: 'Cards', preview: 'Previews', index: 'Indexes', sticky: 'Notes', code: 'Code',
    table: 'Tables', 'task-root': 'Tasks', image: 'Images', attachment: 'Files',
    group: 'Groups', shape: 'Shapes', other: 'Other',
  };
  // Keep category colors in tonal order so adjacent groups form one neutral
  // spectrum, from pure black to a warm near-white.
  const DOT_SPECTRUM = [
    '#000000', '#171717', '#2e2e2e', '#454545',
    '#5c5c5c', '#737373', '#8a8a8a', '#a1a1a1',
    '#b8b8b8', '#cecece', '#e2e2e0', '#f1f1ed',
  ];
  const COPY = {
    zh: {
      entryKicker: 'RELATUM · CAREER', entryTitle: '查看我的使用报告',
      entryCopy: '统计画布、笔记、学习、使用习惯与完成记录。\n全部计算在本机完成。',
      generate: '查看我的使用报告', generating: '正在生成报告', reading: '正在读取本地记录…',
      retry: '重新生成', retrying: '正在重新生成…', generated: '报告已生成',
      reportTitle: '使用报告', local: '全部统计在本机完成。',
      activeDays: '活跃天数', longestStreak: '最长连续活跃', noteWords: 'Markdown 字数', archives: '完成记录', days: '天', items: '项',
      overview: '使用概况', overviewCopy: '这里使用已有计时和完成记录。未记录的时间不会被填入。',
      daily: '最近 365 天', dailyCopy: '线高按当天三个独立计时中的最高值显示，圆点表示完成、打卡或复习。时长不会相加。',
      monthly: '月度使用', monthlyCopy: '按月查看有记录的天数。画布、专注和起步页时长不会合并。',
      weekday: '星期分布', weekdayCopy: '每个点表示一个有记录的日期。',
      recordedCanvas: '画布时长', recordedFocus: '专注时长', canvasSessions: '画布会话', recordedPages: '学习页时长',
      canvas: '画布', canvasCopy: '结构统计来自当前可用的画布。使用时长来自活动账本。',
      topCanvas: '使用时间较多的画布', topCanvasEmpty: '暂时没有画布计时记录。',
      canvasStructure: '画布结构', currentCanvases: '当前画布', nodes: '节点', edges: '连线', ink: '墨迹',
      nodeKinds: '节点类型', nodeKindsCopy: '点的数量按当前节点类型分组。',
      canvasMonths: '阶段中的主要画布', canvasMonthsCopy: '每行是一个月。圆点越大，表示当月记录时长越多。',
      notes: '笔记', notesCopy: '字数来自生成报告时的 Markdown 文件。报告不保存正文。',
      noteTotal: 'Markdown 字数', noteCount: '笔记篇数', folders: '文件夹', links: '双链',
      lengths: '篇幅分布', short: '500 字以内', medium: '500–1,999 字', long: '2,000 字以上',
      longestNotes: '篇幅较长的笔记', notesNetwork: '笔记连接', networkCopy: '显示连接较多的部分笔记。不显示正文。',
      learning: '学习与完成', learningCopy: '当前任务和历史归档分开统计。',
      learningCurrent: '当前学习结构', activeTasks: '进行中任务', goalTrees: '目标树', treeTasks: '树状页任务',
      archiveMonths: '月度完成记录', recentCompleted: '最近完成', noCompleted: '暂时没有完成记录。',
      studyPage: '学习页', treePage: '树状页', quickPage: '速记页', notTimed: '未记录时长',
      habits: '使用习惯', habitsCopy: '这里分别显示画布使用、笔记整理、打卡和日记。',
      canvasUsageMonths: '月度画布时长', recentCanvasDays: '近一年活跃日', averageCanvasDay: '近一年日均时长', recordedMonths: '记录月份', monthsUnit: '个月',
      noteMaintenance: '笔记整理', noteMaintenanceCopy: '按当前文件最后修改月份统计。这不是完整写作历史。', linkedNotes: '有双链笔记', orphanNotes: '孤立笔记', notesUnit: '篇',
      checkinDiary: '打卡与日记', recordDays: '记录日期', checkins: '打卡次数', diaries: '日记天数',
      range: '数据范围', rangeCopy: '每个来源单独读取。数据不可用时，其他部分仍会保留。',
      concentratedMonths: '记录较集中的月份', concentratedMonthsCopy: '横条表示每月留下画布、学习、完成、打卡或日记等记录的日期数。同一天有多种记录也只算 1 天，并按天数从高到低排列。',
      sourceCanvas: '画布结构', sourceCanvasActivity: '画布活动账本', sourcePageActivity: '起步页计时', sourceNotes: '笔记', sourceStudy: '学习', sourceTree: '树状页', sourceReview: '复习',
      sourceFocus: '专注', sourceDaily: '每日打卡', sourceDiary: '日记日期', sourceArchives: '归档',
      available: '可用', partial: '部分可用', empty: '暂无记录', unavailable: '无法读取', skipped: '项未读取',
      coverageFrom: '可追溯记录从 {date} 开始。', coverageEmpty: '暂时没有可用的历史记录。',
      frozen: '这份报告生成于 {date}。之后产生的数据尚未加入。学习页时长是学习页、树状页和速记页三类已启用前台计时之和。活跃天数指当天至少存在画布前台使用或真实创建/修改、三页前台计时、完成归档、打卡、日记、专注或复习中的一项记录；同一天有多项记录仍只算一天。最长连续活跃、月度使用、星期分布和记录较集中的月份均按这些活跃日期计算。完成记录只统计学习、速记、任务簿和画布归档，未归档的已完成项目不计入。画布会话是画布活动账本合并后的前台使用区间数量。Markdown 字数只统计托管笔记库，不包含画布文字。',
      loadFailed: '读取使用报告失败。', generateFailed: '生成使用报告失败。',
      noData: '暂时没有可用记录。', minute: '分钟', hour: '小时',
      dotScale: '每个点约表示 {count} 条记录；图例中的数字为实际数量。',
      archiveStudy: '学习', archiveQuick: '速记', archiveTaskbook: '任务簿', archiveCanvas: '画布',
    },
    en: {
      entryKicker: 'RELATUM · CAREER', entryTitle: 'View my usage report',
      entryCopy: 'Canvas, Notes, Study, usage habits, and completion records.\nEverything is calculated on this device.',
      generate: 'View my usage report', generating: 'Generating report', reading: 'Reading local records…',
      retry: 'Regenerate', retrying: 'Regenerating…', generated: 'Report generated',
      reportTitle: 'Usage report', local: 'All statistics were calculated on this device.',
      activeDays: 'Active days', longestStreak: 'Longest streak', noteWords: 'Markdown words', archives: 'Completed records', days: 'days', items: 'items',
      overview: 'Usage overview', overviewCopy: 'This section uses existing timing and completion records. Missing history is not filled in.',
      daily: 'Last 365 days', dailyCopy: 'Line height uses the largest of the three independent timers for that day. Dots mark completion, check-in, or review. Times are not added together.',
      monthly: 'Monthly usage', monthlyCopy: 'Shows days with records by month. Canvas, Focus, and start-page times are not combined.',
      weekday: 'Weekday distribution', weekdayCopy: 'Each dot represents one day with a record.',
      recordedCanvas: 'Canvas time', recordedFocus: 'Focus time', canvasSessions: 'Canvas sessions', recordedPages: 'Study-page time',
      canvas: 'Canvas', canvasCopy: 'Structure uses currently available canvases. Time comes from the activity ledger.',
      topCanvas: 'Most-used canvases', topCanvasEmpty: 'No Canvas timing has been recorded yet.',
      canvasStructure: 'Canvas structure', currentCanvases: 'Canvases', nodes: 'Nodes', edges: 'Edges', ink: 'Ink',
      nodeKinds: 'Node types', nodeKindsCopy: 'Dots are grouped by current node type.',
      canvasMonths: 'Main canvases by month', canvasMonthsCopy: 'Each row is a month. Larger dots mean more recorded time in that month.',
      notes: 'Notes', notesCopy: 'Word counts use the Markdown files present when this report was generated. Bodies are not stored.',
      noteTotal: 'Markdown words', noteCount: 'Notes', folders: 'Folders', links: 'Links',
      lengths: 'Length distribution', short: 'Under 500 words', medium: '500–1,999 words', long: '2,000+ words',
      longestNotes: 'Longer notes', notesNetwork: 'Note links', networkCopy: 'Shows a small set of more connected notes. Bodies are not shown.',
      learning: 'Study and completion', learningCopy: 'Current tasks and archived completion records are counted separately.',
      learningCurrent: 'Current study structure', activeTasks: 'Active tasks', goalTrees: 'Goal trees', treeTasks: 'Tree-page tasks',
      archiveMonths: 'Monthly completed records', recentCompleted: 'Recently completed', noCompleted: 'No completion records yet.',
      studyPage: 'Study', treePage: 'Tree', quickPage: 'Quick Notes', notTimed: 'No time recorded',
      habits: 'Usage habits', habitsCopy: 'Canvas use, note maintenance, check-ins, and diaries are shown separately.',
      canvasUsageMonths: 'Monthly Canvas time', recentCanvasDays: 'Active days, last year', averageCanvasDay: 'Average active day', recordedMonths: 'Months recorded', monthsUnit: ' months',
      noteMaintenance: 'Note maintenance', noteMaintenanceCopy: 'Grouped by each current file’s last modified month. This is not a complete writing history.', linkedNotes: 'Linked notes', orphanNotes: 'Unlinked notes', notesUnit: ' notes',
      checkinDiary: 'Check-ins and diaries', recordDays: 'Recorded dates', checkins: 'Check-ins', diaries: 'Diary days',
      range: 'Data range', rangeCopy: 'Each source is read independently. Other sections remain when one source is unavailable.',
      concentratedMonths: 'Months with more records', concentratedMonthsCopy: 'Each bar shows the number of dates with Canvas, Study, completion, check-in, diary, or related records. Multiple records on one date still count as one day, ranked from highest to lowest.',
      sourceCanvas: 'Canvas structure', sourceCanvasActivity: 'Canvas activity ledger', sourcePageActivity: 'Start-page timing', sourceNotes: 'Notes', sourceStudy: 'Study', sourceTree: 'Tree page', sourceReview: 'Review',
      sourceFocus: 'Focus', sourceDaily: 'Daily check-ins', sourceDiary: 'Diary dates', sourceArchives: 'Archives',
      available: 'Available', partial: 'Partly available', empty: 'No records', unavailable: 'Unavailable', skipped: 'items unread',
      coverageFrom: 'Traceable records begin on {date}.', coverageEmpty: 'No historical records are available yet.',
      frozen: 'This report was generated on {date}. Later activity has not been added. Study-page time is the combined enabled foreground timing for Study, Tree, and Quick Notes. An active day has at least one Canvas foreground-use or real create/edit record, timed start-page activity, archived completion, check-in, diary, Focus, or Review record; multiple records on one date still count as one day. Longest streak, monthly usage, weekday distribution, and concentrated months use those active dates. Completed records include only Study, Quick Notes, Taskbook, and Canvas archives; completed items not yet archived are excluded. Canvas sessions are merged foreground-use intervals in the Canvas activity ledger. Markdown words cover only the managed note library and exclude Canvas text.',
      loadFailed: 'Failed to read the usage report.', generateFailed: 'Failed to generate the usage report.', noData: 'No records are available yet.',
      dotScale: 'Each dot represents about {count} records; legend totals are exact.',
      minute: 'min', hour: 'hr', archiveStudy: 'Study', archiveQuick: 'Quick notes', archiveTaskbook: 'Taskbook', archiveCanvas: 'Canvas',
    },
  };

  const state = {
    initialized: false,
    initializePromise: null,
    loading: false,
    active: false,
    report: null,
    observer: null,
    error: '',
    scrolling: false,
    scrollIdleTimer: 0,
    scrollSettledAt: 0,
    revealFrame: 0,
    pendingReveals: new Set(),
    numberFrame: 0,
    numberLastFrame: 0,
    numberJobs: new Map(),
  };
  function reducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function language() { return window.RelatumI18n && window.RelatumI18n.language === 'en' ? 'en' : 'zh'; }
  function tr(key, vars) {
    let value = COPY[language()][key] || COPY.zh[key] || key;
    Object.entries(vars || {}).forEach(([name, replacement]) => { value = value.replaceAll('{' + name + '}', String(replacement)); });
    return value;
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function svgElement(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }
  function append(parent, ...children) { children.filter(Boolean).forEach((child) => parent.appendChild(child)); return parent; }
  function number(value) { return Math.max(0, Number(value) || 0); }
  function formatNumber(value) { return Math.round(number(value)).toLocaleString(language() === 'en' ? 'en-US' : 'zh-CN'); }
  function formatDate(value) {
    if (!value) return '';
    const parsed = new Date(String(value).length === 10 ? value + 'T00:00:00' : value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return new Intl.DateTimeFormat(language() === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(parsed);
  }
  function formatMonth(value) {
    const parsed = new Date(String(value) + '-01T00:00:00');
    if (Number.isNaN(parsed.getTime())) return String(value);
    return new Intl.DateTimeFormat(language() === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'short' }).format(parsed);
  }
  function formatDuration(seconds) {
    const total = Math.round(number(seconds));
    if (!total) return '0 ' + tr('minute');
    const roundedMinutes = Math.round(total / 60);
    const hours = Math.floor(roundedMinutes / 60);
    const minutes = roundedMinutes % 60;
    if (!hours) return `${minutes} ${tr('minute')}`;
    return language() === 'en' ? `${hours} ${tr('hour')} ${minutes} ${tr('minute')}` : `${hours} ${tr('hour')} ${minutes} ${tr('minute')}`;
  }
  function kindLabel(key) { return (language() === 'en' ? KIND_EN : KIND_ZH)[key] || key; }
  function archiveKind(key) { return tr('archive' + key.charAt(0).toUpperCase() + key.slice(1)); }

  function reveal(node, delay) {
    node.classList.add('career-reveal');
    if (delay) node.style.setProperty('--career-delay', delay + 'ms');
    return node;
  }
  function animatedNumber(node, value, format, suffix, zeroText) {
    node.dataset.careerNumber = String(number(value));
    node.dataset.careerFormat = format || 'number';
    node.dataset.careerSuffix = suffix || '';
    if (zeroText) node.dataset.careerZeroText = zeroText;
    node.textContent = number(value) === 0 && zeroText
      ? zeroText : format === 'duration' ? formatDuration(0) : '0' + (suffix || '');
    return node;
  }
  function sectionHeader(kicker, title, copy) {
    const header = reveal(element('header', 'career-section-head'));
    const left = element('div');
    append(left, element('p', 'career-section-kicker', kicker), element('h2', '', title));
    append(header, left, element('p', '', copy));
    return header;
  }
  function panel(kicker, title, copy, classes) {
    const node = reveal(element('section', 'career-panel' + (classes ? ' ' + classes : '')));
    append(node, element('p', 'career-panel-kicker', kicker), element('h3', '', title));
    if (copy) append(node, element('p', 'career-panel-copy', copy));
    return node;
  }
  function metric(label, value, suffix) {
    const node = element('div', 'career-hero-metric');
    const strong = animatedNumber(element('strong'), value, 'number', suffix);
    append(node, strong, element('span', '', label));
    return node;
  }
  function stat(label, value, format, suffix) {
    const node = element('div');
    append(node, animatedNumber(element('strong'), value, format, suffix), element('span', '', label));
    return node;
  }
  function bigNumber(value) { return animatedNumber(element('div', 'career-big-number'), value, 'number'); }
  function chartTooltip(container) {
    const tip = element('div', 'career-chart-tooltip');
    tip.setAttribute('role', 'status');
    container.appendChild(tip);
    return tip;
  }
  function showTooltip(tip, container, target, text) {
    const box = target.getBoundingClientRect();
    const parent = container.getBoundingClientRect();
    tip.textContent = text;
    tip.style.left = `${box.left - parent.left + box.width / 2}px`;
    tip.style.top = `${box.top - parent.top}px`;
    tip.classList.add('visible');
  }
  function bindTooltip(target, tip, container, text) {
    const show = () => showTooltip(tip, container, target, text);
    target.addEventListener('mouseenter', show);
    target.addEventListener('focus', show);
    target.addEventListener('mouseleave', () => tip.classList.remove('visible'));
    target.addEventListener('blur', () => tip.classList.remove('visible'));
  }

  function lineChart(items, series) {
    const container = element('div', 'career-chart');
    if (!items.length) { container.appendChild(element('p', 'career-panel-copy', tr('noData'))); return container; }
    const width = 720, height = 238, padX = 25, padY = 24;
    const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': series.ariaLabel || tr('monthly') });
    const values = items.map((item) => number(series.value(item)));
    const max = Math.max(1, ...values);
    for (let line = 0; line <= 3; line += 1) {
      const y = padY + (height - padY * 2) * line / 3;
      svg.appendChild(svgElement('line', { x1: padX, x2: width - padX, y1: y, y2: y, class: 'career-chart-grid' }));
    }
    const points = values.map((value, index) => {
      const x = items.length === 1 ? width / 2 : padX + (width - padX * 2) * index / (items.length - 1);
      const y = height - padY - (height - padY * 2) * value / max;
      return [x, y];
    });
    const path = svgElement('path', { d: points.map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(2)},${point[1].toFixed(2)}`).join(' '), class: 'career-chart-line career-line-draw' });
    svg.appendChild(path);
    const tip = chartTooltip(container);
    points.forEach((point, index) => {
      const circle = svgElement('circle', { cx: point[0], cy: point[1], r: 5, fill: 'currentColor', tabindex: 0, class: 'career-chart-focus career-line-point' });
      circle.style.setProperty('--career-index', String(index));
      circle.setAttribute('aria-label', series.label(items[index], values[index]));
      bindTooltip(circle, tip, container, series.label(items[index], values[index]));
      svg.appendChild(circle);
    });
    container.appendChild(svg);
    return container;
  }

  function dailyBarcode(days) {
    const container = element('div', 'career-chart');
    const items = days.slice(-365);
    if (!items.length) { container.appendChild(element('p', 'career-panel-copy', tr('noData'))); return container; }
    const width = 900, height = 238, baseline = 198, pad = 18;
    const max = Math.max(1, ...items.map((item) => Math.max(number(item.canvasSec), number(item.focusSec), number(item.pageSec))));
    const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': tr('daily') });
    svg.appendChild(svgElement('line', { x1: pad, x2: width - pad, y1: baseline, y2: baseline, class: 'career-chart-grid' }));
    const series = svgElement('g', { class: 'career-daily-series' });
    const step = (width - pad * 2) / Math.max(1, items.length);
    const tip = chartTooltip(container);
    items.forEach((item, index) => {
      const total = Math.max(number(item.canvasSec), number(item.focusSec), number(item.pageSec));
      const x = pad + step * index + step / 2;
      const barHeight = total ? 12 + 150 * total / max : 3;
      const group = svgElement('g', { tabindex: 0, class: 'career-chart-focus career-daily-mark' });
      group.appendChild(svgElement('line', { x1: x, x2: x, y1: baseline, y2: baseline - barHeight, stroke: 'currentColor', 'stroke-width': Math.max(1, Math.min(3.2, step * .54)), 'stroke-linecap': 'round', opacity: total ? .82 : .14 }));
      if (number(item.events) || number(item.completed) || number(item.reviewed) || number(item.daily) || number(item.diary)) {
        group.appendChild(svgElement('circle', { cx: x, cy: baseline - barHeight - 7, r: 2.6, fill: 'var(--career-accent)' }));
      }
      const label = `${formatDate(item.day)} · ${tr('recordedCanvas')} ${formatDuration(item.canvasSec)} · ${tr('recordedFocus')} ${formatDuration(item.focusSec)} · ${tr('recordedPages')} ${formatDuration(item.pageSec)} · ${formatNumber(item.events)} ${tr('items')}`;
      group.setAttribute('aria-label', label);
      bindTooltip(group, tip, container, label);
      series.appendChild(group);
    });
    svg.appendChild(series);
    container.appendChild(svg);
    return container;
  }

  function barList(items, options) {
    const chart = element('div', 'career-chart career-bars');
    if (!items.length) { chart.appendChild(element('p', 'career-panel-copy', options.empty || tr('noData'))); return chart; }
    const max = Math.max(1, ...items.map(options.value));
    items.forEach((item, index) => {
      const row = element('div', 'career-bar-row');
      row.style.setProperty('--career-index', String(Math.min(index, 12)));
      const label = element('span', 'career-bar-label', options.label(item));
      label.title = options.label(item);
      const track = element('span', 'career-bar-track');
      const fill = element('i', 'career-bar-fill');
      fill.style.setProperty('--career-value', `${Math.max(2, options.value(item) / max * 100)}%`);
      track.appendChild(fill);
      const valueNode = animatedNumber(element('span', 'career-bar-value'), options.value(item), options.numberFormat || 'number', options.numberSuffix || '', options.zeroText || '');
      append(row, label, track, valueNode);
      chart.appendChild(row);
    });
    return chart;
  }

  function dotMatrix(groups, options) {
    const chart = element('div', 'career-chart');
    const visual = element('div', 'career-dot-visual');
    const staggered = !!(options && options.staggered);
    const matrix = element('div', 'career-dot-matrix' + (staggered ? ' is-staggered' : ''));
    const safeGroups = groups.filter((item) => number(item.count) > 0);
    const total = safeGroups.reduce((sum, item) => sum + number(item.count), 0);
    if (!total) { chart.appendChild(element('p', 'career-panel-copy', tr('noData'))); return chart; }
    const cap = 120;
    const scale = Math.max(1, Math.ceil(total / cap));
    let dotIndex = 0;
    const legend = element('div', 'career-dot-legend');
    safeGroups.forEach((group, groupIndex) => {
      const colorIndex = safeGroups.length === 1
        ? Math.floor(DOT_SPECTRUM.length / 2)
        : Math.round(groupIndex * (DOT_SPECTRUM.length - 1) / (safeGroups.length - 1));
      const color = DOT_SPECTRUM[colorIndex];
      const amount = Math.max(1, Math.ceil(number(group.count) / scale));
      for (let count = 0; count < amount; count += 1) {
        const dot = element('span', 'career-dot active');
        if (staggered) dot.style.setProperty('--career-index', String(dotIndex++));
        dot.style.setProperty('--career-dot-color', color);
        dot.title = `${group.label}: ${formatNumber(group.count)}`;
        matrix.appendChild(dot);
      }
      const row = element('div', 'career-dot-legend-row');
      const swatch = element('i', 'career-dot-legend-swatch');
      swatch.style.setProperty('--career-dot-color', color);
      append(row, swatch, element('span', 'career-dot-legend-label', group.label), element('strong', '', formatNumber(group.count)));
      legend.appendChild(row);
    });
    append(visual, matrix, legend);
    append(chart, visual, element('p', 'career-dot-scale', tr('dotScale', { count: formatNumber(scale) })));
    return chart;
  }

  function canvasMonthMatrix(months) {
    const chart = element('div', 'career-chart career-month-matrix-chart');
    const safeMonths = Array.isArray(months) ? months.slice(-24) : [];
    const totals = new Map();
    safeMonths.forEach((month) => (month.items || []).forEach((item) => {
      totals.set(item.title, number(totals.get(item.title)) + number(item.seconds));
    }));
    const titles = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map((item) => item[0]);
    if (!safeMonths.length || !titles.length) { chart.appendChild(element('p', 'career-panel-copy', tr('noData'))); return chart; }
    const max = Math.max(1, ...safeMonths.flatMap((month) => (month.items || []).map((item) => number(item.seconds))));
    const matrix = element('div', 'career-month-matrix');
    matrix.style.setProperty('--career-matrix-cols', String(titles.length));
    matrix.appendChild(element('span', 'career-month-matrix-corner'));
    titles.forEach((title) => { const label = element('span', 'career-month-matrix-head', title); label.title = title; matrix.appendChild(label); });
    let dotIndex = 0;
    safeMonths.forEach((month) => {
      matrix.appendChild(element('time', 'career-month-matrix-label', formatMonth(month.month)));
      const byTitle = new Map((month.items || []).map((item) => [item.title, item]));
      titles.forEach((title) => {
        const item = byTitle.get(title), seconds = number(item && item.seconds);
        const cell = element('span', 'career-month-matrix-cell');
        if (seconds) {
          const dot = element('i', 'career-month-matrix-dot');
          dot.style.setProperty('--career-dot-scale', String(.38 + .62 * Math.sqrt(seconds / max)));
          dot.style.setProperty('--career-index', String(Math.min(dotIndex++, 24)));
          dot.tabIndex = 0;
          dot.title = `${formatMonth(month.month)} · ${title} · ${formatDuration(seconds)}`;
          dot.setAttribute('aria-label', dot.title);
          cell.appendChild(dot);
        }
        matrix.appendChild(cell);
      });
    });
    chart.appendChild(matrix);
    return chart;
  }

  function noteNetwork(network) {
    const chart = element('div', 'career-chart career-network');
    const nodes = Array.isArray(network && network.nodes) ? network.nodes : [];
    const edges = Array.isArray(network && network.edges) ? network.edges : [];
    if (!nodes.length) { chart.appendChild(element('p', 'career-panel-copy', tr('noData'))); return chart; }
    const width = 700, height = 340, cx = width / 2, cy = height / 2;
    const maxDegree = Math.max(1, ...nodes.map((node) => number(node.degree)));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const adjacency = new Map(nodes.map((node) => [node.id, []]));
    edges.forEach((edge) => {
      if (!nodeById.has(edge.from) || !nodeById.has(edge.to) || edge.from === edge.to) return;
      adjacency.get(edge.from).push(edge.to);
      adjacency.get(edge.to).push(edge.from);
    });
    const rootNode = nodes.slice().sort((a, b) => (adjacency.get(b.id).length - adjacency.get(a.id).length) || (number(b.degree) - number(a.degree)))[0];
    const depth = new Map([[rootNode.id, 0]]), parent = new Map(), queue = [rootNode.id];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const id = queue[cursor];
      (adjacency.get(id) || []).slice().sort((a, b) => adjacency.get(b).length - adjacency.get(a).length).forEach((next) => {
        if (depth.has(next)) return;
        depth.set(next, depth.get(id) + 1);
        parent.set(next, id);
        queue.push(next);
      });
    }
    nodes.forEach((node) => { if (!depth.has(node.id)) depth.set(node.id, 2); });
    const levels = new Map();
    nodes.forEach((node) => {
      const level = depth.get(node.id);
      if (!levels.has(level)) levels.set(level, []);
      levels.get(level).push(node);
    });
    const positions = new Map();
    positions.set(rootNode.id, { x: cx, y: cy });
    Array.from(levels.entries()).filter(([level]) => level > 0).sort((a, b) => a[0] - b[0]).forEach(([level, levelNodes]) => {
      levelNodes.sort((a, b) => {
        const parentA = parent.get(a.id) || '', parentB = parent.get(b.id) || '';
        return parentA.localeCompare(parentB) || adjacency.get(b.id).length - adjacency.get(a.id).length || String(a.id).localeCompare(String(b.id));
      });
      const radiusX = Math.min(305, level === 1 ? 122 : 122 + level * 74);
      const radiusY = Math.min(145, level === 1 ? 78 : 62 + level * 34);
      levelNodes.forEach((node, index) => {
        const angle = -Math.PI / 2 + index * Math.PI * 2 / Math.max(1, levelNodes.length);
        positions.set(node.id, { x: cx + Math.cos(angle) * radiusX, y: cy + Math.sin(angle) * radiusY });
      });
    });
    const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': tr('notesNetwork') });
    edges.forEach((edge, index) => {
      const from = positions.get(edge.from), to = positions.get(edge.to);
      if (from && to) {
        const line = svgElement('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: 'career-network-line career-network-line-fade' });
        line.style.setProperty('--career-index', String(Math.min(index, 24)));
        svg.appendChild(line);
      }
    });
    const tip = chartTooltip(chart);
    nodes.forEach((node, index) => {
      const point = positions.get(node.id);
      const circle = svgElement('circle', { cx: point.x, cy: point.y, r: 4 + 10 * number(node.degree) / maxDegree, class: 'career-network-node career-chart-focus', tabindex: 0 });
      circle.style.setProperty('--career-index', String(Math.min(index, 24)));
      const label = `${node.title} · ${formatNumber(node.words)} ${tr('noteWords')}`;
      circle.setAttribute('aria-label', label);
      bindTooltip(circle, tip, chart, label);
      svg.appendChild(circle);
    });
    chart.appendChild(svg);
    return chart;
  }

  function stackedArchiveChart(months) {
    const chart = element('div', 'career-chart');
    if (!months.length) { chart.appendChild(element('p', 'career-panel-copy', tr('noData'))); return chart; }
    const width = 720, height = 240, padX = 24, padY = 26;
    const keys = ['study', 'quick', 'taskbook', 'canvas'];
    const max = Math.max(1, ...months.map((month) => keys.reduce((sum, key) => sum + number(month[key]), 0)));
    const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': tr('archiveMonths') });
    const gap = 4, step = (width - padX * 2) / months.length;
    const barWidth = Math.max(3, Math.min(22, step - gap));
    const opacities = [.95, .68, .45, .24];
    const tip = chartTooltip(chart);
    months.forEach((month, index) => {
      const total = keys.reduce((sum, key) => sum + number(month[key]), 0);
      let y = height - padY;
      const group = svgElement('g', { tabindex: 0, class: 'career-chart-focus career-stack-bar' });
      group.style.setProperty('--career-index', String(Math.min(index, 12)));
      keys.forEach((key, keyIndex) => {
        const value = number(month[key]);
        const part = (height - padY * 2) * value / max;
        y -= part;
        if (part) group.appendChild(svgElement('rect', { x: padX + index * step + (step - barWidth) / 2, y, width: barWidth, height: Math.max(1, part), rx: 2, fill: 'currentColor', opacity: opacities[keyIndex] }));
      });
      const label = `${formatMonth(month.month)} · ${formatNumber(total)} ${tr('items')}`;
      group.setAttribute('aria-label', label);
      bindTooltip(group, tip, chart, label);
      svg.appendChild(group);
    });
    chart.appendChild(svg);
    return chart;
  }

  function heatmap(daysMap) {
    const chart = element('div', 'career-chart');
    const grid = element('div', 'career-heatmap');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today); start.setDate(today.getDate() - 370 - ((today.getDay() + 6) % 7));
    const values = Object.values(daysMap || {}).map(number);
    const max = Math.max(1, ...values);
    for (let index = 0; index < 371; index += 1) {
      const current = new Date(start); current.setDate(start.getDate() + index);
      const key = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
      const value = number(daysMap && daysMap[key]);
      const cell = element('span', 'career-heat-cell');
      const level = value ? Math.max(1, Math.min(4, Math.ceil(value / max * 4))) : 0;
      cell.dataset.level = String(level);
      cell.title = `${formatDate(key)} · ${formatNumber(value)}`;
      grid.appendChild(cell);
    }
    chart.appendChild(grid);
    return chart;
  }

  function buildHero(report) {
    const shell = element('div', 'career-report-shell');
    const hero = element('section', 'career-hero');
    const first = report.period && report.period.firstDay;
    append(hero,
      reveal(element('p', 'career-section-kicker', 'RELATUM · ' + tr('reportTitle').toUpperCase())),
      reveal(element('p', 'career-hero-date', `${formatDate(report.generatedAt)} · ${tr('local')}`), 70),
      reveal(element('h1', '', tr('reportTitle')), 120),
      reveal(element('p', 'career-hero-copy', first ? tr('coverageFrom', { date: formatDate(first) }) : tr('coverageEmpty')), 170),
    );
    const rule = reveal(element('div', 'career-hero-rule'), 210);
    const metrics = reveal(element('div', 'career-hero-metrics'), 250);
    append(metrics,
      metric(tr('activeDays'), report.overview.activeDays),
      metric(tr('longestStreak'), report.overview.longestStreak, language() === 'en' ? ' d' : ' 天'),
      metric(tr('noteWords'), report.overview.noteWords),
      metric(tr('archives'), report.overview.archiveCount),
    );
    append(hero, rule, metrics); shell.appendChild(hero); return shell;
  }

  function buildOverview(report) {
    const shell = element('div', 'career-report-shell');
    const chapter = element('section', 'career-chapter');
    chapter.appendChild(sectionHeader('01', tr('overview'), tr('overviewCopy')));
    const grid = element('div', 'career-editorial-grid');
    const daily = panel(tr('daily'), tr('daily'), tr('dailyCopy'), 'is-wide');
    daily.appendChild(dailyBarcode(report.activity.days || []));
    const monthly = panel(tr('monthly'), tr('monthly'), tr('monthlyCopy'));
    monthly.appendChild(lineChart(report.activity.months || [], {
      value: (item) => number(item.activeDays),
      label: (item, value) => `${formatMonth(item.month)} · ${formatNumber(value)} ${tr('days')}`,
    }));
    const weekday = panel(tr('weekday'), tr('weekday'), tr('weekdayCopy'));
    const weekdayGroups = (report.activity.weekdays || []).map((item) => ({ label: (language() === 'en' ? WEEKDAYS_EN : WEEKDAYS_ZH)[item.weekday], count: item.activeDays }));
    weekday.appendChild(dotMatrix(weekdayGroups, { staggered: true }));
    const strip = element('div', 'career-stat-strip');
    append(strip,
      stat(tr('recordedCanvas'), report.overview.canvasSec, 'duration'),
      stat(tr('canvasSessions'), report.canvases && report.canvases.spanCount),
      stat(tr('recordedPages'), report.overview.pageSec, 'duration'),
    );
    weekday.appendChild(strip);
    append(grid, daily, monthly, weekday); chapter.appendChild(grid); shell.appendChild(chapter); return shell;
  }

  function buildCanvas(report) {
    const data = report.canvases || {};
    const shell = element('div', 'career-report-shell');
    const chapter = element('section', 'career-chapter');
    chapter.appendChild(sectionHeader('02', tr('canvas'), tr('canvasCopy')));
    const grid = element('div', 'career-editorial-grid');
    const top = panel(tr('topCanvas'), tr('topCanvas'), '', 'is-wide');
    top.appendChild(barList(data.top || [], {
      label: (item) => item.title, value: (item) => number(item.seconds),
      numberFormat: 'duration', empty: tr('topCanvasEmpty'),
    }));
    const structure = panel(tr('canvasStructure'), tr('canvasStructure'), '');
    structure.appendChild(bigNumber(data.nodeCount));
    structure.appendChild(element('p', 'career-big-unit', tr('nodes')));
    const strip = element('div', 'career-stat-strip');
    append(strip, stat(tr('currentCanvases'), data.count), stat(tr('edges'), data.edgeCount), stat(tr('ink'), data.inkCount));
    structure.appendChild(strip);
    const kinds = panel(tr('nodeKinds'), tr('nodeKinds'), tr('nodeKindsCopy'));
    kinds.appendChild(dotMatrix(
      (data.kinds || []).map((item) => ({ label: kindLabel(item.key), count: item.count })),
      { staggered: true },
    ));
    const months = panel(tr('canvasMonths'), tr('canvasMonths'), tr('canvasMonthsCopy'), 'is-wide');
    months.appendChild(canvasMonthMatrix(data.months || []));
    append(grid, top, structure, kinds, months); chapter.appendChild(grid); shell.appendChild(chapter); return shell;
  }

  function buildNotes(report) {
    const data = report.notes || {};
    const shell = element('div', 'career-report-shell');
    const chapter = element('section', 'career-chapter');
    chapter.appendChild(sectionHeader('03', tr('notes'), tr('notesCopy')));
    const grid = element('div', 'career-editorial-grid');
    const total = panel(tr('noteTotal'), tr('noteTotal'), '', 'is-dark');
    total.appendChild(bigNumber(data.wordCount));
    total.appendChild(element('p', 'career-big-unit', tr('noteWords')));
    const strip = element('div', 'career-stat-strip');
    append(strip, stat(tr('noteCount'), data.count), stat(tr('folders'), data.folderCount), stat(tr('links'), data.linkCount));
    total.appendChild(strip);
    const lengths = panel(tr('lengths'), tr('lengths'), '');
    const buckets = data.lengthBuckets || {};
    lengths.appendChild(dotMatrix([
      { label: tr('long'), count: buckets.long }, { label: tr('medium'), count: buckets.medium }, { label: tr('short'), count: buckets.short },
    ], { staggered: true }));
    const longest = panel(tr('longestNotes'), tr('longestNotes'), '', 'is-wide');
    longest.appendChild(barList(data.top || [], {
      label: (item) => item.title, value: (item) => number(item.words), format: (item) => formatNumber(item.words),
    }));
    const network = panel(tr('notesNetwork'), tr('notesNetwork'), tr('networkCopy'), 'is-wide');
    network.appendChild(noteNetwork(data.network || {}));
    append(grid, total, lengths, longest, network); chapter.appendChild(grid); shell.appendChild(chapter); return shell;
  }

  function buildLearning(report) {
    const data = report.learning || {}, archives = data.archives || {};
    const shell = element('div', 'career-report-shell');
    const chapter = element('section', 'career-chapter');
    chapter.appendChild(sectionHeader('04', tr('learning'), tr('learningCopy')));
    const grid = element('div', 'career-editorial-grid');
    const current = panel(tr('learningCurrent'), tr('learningCurrent'), '');
    const strip = element('div', 'career-stat-strip');
    append(strip, stat(tr('activeTasks'), data.activeTasks), stat(tr('goalTrees'), data.goalTreeCount), stat(tr('treeTasks'), data.treeTasks));
    current.appendChild(strip);
    const pageBars = [
      { title: tr('studyPage'), seconds: number(data.pageSeconds && data.pageSeconds.study) },
      { title: tr('treePage'), seconds: number(data.pageSeconds && data.pageSeconds.tree) },
      { title: tr('quickPage'), seconds: number(data.pageSeconds && data.pageSeconds.notes) },
    ];
    current.appendChild(barList(pageBars, { label: (item) => item.title, value: (item) => item.seconds, numberFormat: 'duration', zeroText: tr('notTimed') }));
    const monthly = panel(tr('archiveMonths'), tr('archiveMonths'), '', 'is-dark');
    monthly.appendChild(stackedArchiveChart(archives.months || []));
    const recent = panel(tr('recentCompleted'), tr('recentCompleted'), '', 'is-wide');
    const timeline = element('div', 'career-timeline');
    if (!(archives.recent || []).length) timeline.appendChild(element('p', 'career-panel-copy', tr('noCompleted')));
    (archives.recent || []).forEach((item, index) => {
      const row = element('div', 'career-timeline-row');
      row.style.setProperty('--career-index', String(Math.min(index, 12)));
      append(row, element('time', '', item.day), element('i', 'career-timeline-dot'), element('span', 'career-timeline-title', item.title || archiveKind(item.kind)), element('span', 'career-timeline-kind', archiveKind(item.kind)));
      timeline.appendChild(row);
    });
    recent.appendChild(timeline);
    append(grid, current, monthly, recent); chapter.appendChild(grid); shell.appendChild(chapter); return shell;
  }

  function buildHabits(report) {
    const activityData = report.activity || {}, notes = report.notes || {};
    const habits = report.habits || {}, daily = habits.daily || {}, diaries = habits.diaries || {};
    const shell = element('div', 'career-report-shell');
    const chapter = element('section', 'career-chapter');
    chapter.appendChild(sectionHeader('05', tr('habits'), tr('habitsCopy')));
    const grid = element('div', 'career-editorial-grid');
    const canvasMonths = (activityData.months || []).filter((item) => number(item.canvasSec));
    const canvasPanel = panel(tr('canvasUsageMonths'), tr('canvasUsageMonths'), '', 'is-wide');
    canvasPanel.appendChild(lineChart(canvasMonths, {
      value: (item) => number(item.canvasSec),
      label: (item, value) => `${formatMonth(item.month)} · ${formatDuration(value)}`,
      ariaLabel: tr('canvasUsageMonths'),
    }));
    const recentCanvasDays = (activityData.days || []).filter((item) => number(item.canvasSec));
    const recentCanvasSeconds = recentCanvasDays.reduce((sum, item) => sum + number(item.canvasSec), 0);
    const canvasStrip = element('div', 'career-stat-strip');
    append(canvasStrip,
      stat(tr('recentCanvasDays'), recentCanvasDays.length),
      stat(tr('averageCanvasDay'), recentCanvasDays.length ? recentCanvasSeconds / recentCanvasDays.length : 0, 'duration'),
      stat(tr('recordedMonths'), canvasMonths.length, 'number', tr('monthsUnit')),
    );
    canvasPanel.appendChild(canvasStrip);

    const notePanel = panel(tr('noteMaintenance'), tr('noteMaintenance'), tr('noteMaintenanceCopy'), 'is-dark');
    notePanel.appendChild(lineChart(notes.inferredModifiedMonths || [], {
      value: (item) => number(item.count),
      label: (item, value) => `${formatMonth(item.month)} · ${formatNumber(value)} ${tr('notesUnit')}`,
      ariaLabel: tr('noteMaintenance'),
    }));
    const hasOrphanCount = notes.orphanCount != null && Number.isFinite(Number(notes.orphanCount));
    const orphanCount = hasOrphanCount ? number(notes.orphanCount) : 0;
    const linkedCount = hasOrphanCount ? Math.max(0, number(notes.count) - orphanCount) : 0;
    const noteStrip = element('div', 'career-stat-strip');
    append(noteStrip, stat(tr('linkedNotes'), linkedCount), stat(tr('orphanNotes'), orphanCount), stat(tr('links'), notes.linkCount));
    notePanel.appendChild(noteStrip);

    const activity = panel(tr('checkinDiary'), tr('checkinDiary'), '', '');
    const dayMap = {};
    (daily.days || []).forEach((day) => { dayMap[day] = 1; });
    (diaries.days || []).forEach((day) => { dayMap[day] = number(dayMap[day]) + 1; });
    if (Object.keys(dayMap).length) activity.appendChild(heatmap(dayMap));
    else activity.appendChild(element('p', 'career-panel-copy', tr('noData')));
    const activityStrip = element('div', 'career-stat-strip');
    append(activityStrip, stat(tr('checkins'), daily.checkinCount), stat(tr('diaries'), diaries.count), stat(tr('recordDays'), Object.keys(dayMap).length));
    activity.appendChild(activityStrip);
    append(grid, canvasPanel, notePanel, activity); chapter.appendChild(grid); shell.appendChild(chapter); return shell;
  }

  function buildRange(report) {
    const shell = element('div', 'career-report-shell');
    const chapter = element('section', 'career-chapter');
    chapter.appendChild(sectionHeader('06', tr('range'), tr('rangeCopy')));
    const grid = element('div', 'career-editorial-grid');
    const concentrated = panel(tr('concentratedMonths'), tr('concentratedMonths'), tr('concentratedMonthsCopy'), 'is-wide is-dark');
    const rankedMonths = (report.activity && report.activity.months || []).map((month) => ({
      month: month.month,
      activeDays: number(month.activeDays),
    })).filter((month) => month.activeDays).sort((a, b) => b.activeDays - a.activeDays).slice(0, 12);
    concentrated.appendChild(barList(rankedMonths, {
      label: (item) => formatMonth(item.month), value: (item) => item.activeDays,
      numberSuffix: language() === 'en' ? ' days' : ' 天', empty: tr('noData'),
    }));
    const coverage = reveal(element('div', 'career-coverage'));
    const sourceNames = {
      canvases: tr('sourceCanvas'), canvasActivity: tr('sourceCanvasActivity'), pageActivity: tr('sourcePageActivity'),
      notes: tr('sourceNotes'), study: tr('sourceStudy'), tree: tr('sourceTree'), review: tr('sourceReview'),
      focus: tr('sourceFocus'), daily: tr('sourceDaily'), diary: tr('sourceDiary'), archives: tr('sourceArchives'),
    };
    (report.coverage || []).forEach((item, index) => {
      const row = element('div', 'career-coverage-row');
      row.style.setProperty('--career-index', String(Math.min(index, 12)));
      const suffix = number(item.skippedCount) ? ` · ${formatNumber(item.skippedCount)} ${tr('skipped')}` : '';
      append(row, element('span', '', sourceNames[item.id] || item.id), element('span', '', tr(item.status || 'unavailable') + suffix));
      coverage.appendChild(row);
    });
    append(grid, concentrated, coverage); chapter.appendChild(grid); shell.appendChild(chapter); return shell;
  }

  function buildEnd(report) {
    const end = element('section', 'career-report-end');
    append(end, reveal(element('p', 'career-section-kicker', tr('generated'))), reveal(element('h2', '', tr('reportTitle')), 80), reveal(element('p', '', tr('frozen', { date: formatDate(report.generatedAt) })), 130));
    const button = reveal(element('button', 'career-regenerate', tr('retry')), 180);
    button.type = 'button'; button.dataset.careerAction = 'generate';
    end.appendChild(button);
    if (state.error) end.appendChild(element('p', 'career-inline-error', state.error));
    return end;
  }

  function render(report) {
    stopRuntime({ finishNumbers: false });
    state.report = report;
    reportHost.replaceChildren();
    append(reportHost, buildHero(report), buildOverview(report), buildCanvas(report), buildNotes(report), buildLearning(report), buildHabits(report), buildRange(report), buildEnd(report));
    reportHost.querySelectorAll('.career-editorial-grid').forEach((grid) => {
      Array.from(grid.children).forEach((child, index) => {
        if (child.classList.contains('career-reveal')) child.style.setProperty('--career-delay', `${Math.min(index, 5) * 65}ms`);
      });
    });
    entry.hidden = true; loading.hidden = true; reportHost.hidden = false;
    bindActions(reportHost);
    if (state.active) startReveals();
  }

  function cancelRevealFrame() {
    if (!state.revealFrame) return;
    cancelAnimationFrame(state.revealFrame);
    state.revealFrame = 0;
  }

  function targetStillVisible(target, rootBox) {
    if (!target.isConnected || target.dataset.visible === '1') return false;
    const box = target.getBoundingClientRect();
    const revealBottom = rootBox.bottom - rootBox.height * .08;
    return box.bottom > rootBox.top && box.top < revealBottom;
  }

  function revealPendingTargets() {
    state.revealFrame = 0;
    if (!state.active || state.scrolling || !state.pendingReveals.size) return;
    const targets = Array.from(state.pendingReveals);
    const rootBox = scroll.getBoundingClientRect();
    const visibleTargets = targets.filter((target) => targetStillVisible(target, rootBox));
    const scrollReveal = state.scrollSettledAt > 0
      && performance.now() - state.scrollSettledAt <= SCROLL_REVEAL_WINDOW_MS;
    targets.forEach((target) => {
      if (!target.isConnected || target.dataset.visible === '1') state.pendingReveals.delete(target);
    });
    visibleTargets.forEach((target) => {
      state.pendingReveals.delete(target);
      if (scrollReveal) target.dataset.careerScrollReveal = '1';
      target.dataset.visible = '1';
      animateNumbers(target);
      if (state.observer) state.observer.unobserve(target);
    });
  }

  function scheduleRevealFlush() {
    if (state.revealFrame || state.scrolling || !state.active || !state.pendingReveals.size) return;
    state.revealFrame = requestAnimationFrame(revealPendingTargets);
  }

  function startReveals() {
    if (state.observer) state.observer.disconnect();
    state.pendingReveals.clear();
    cancelRevealFrame();
    const targets = reportHost.querySelectorAll('.career-reveal:not([data-visible="1"])');
    if (reducedMotion() || !('IntersectionObserver' in window)) {
      targets.forEach((target) => target.dataset.visible = '1');
      animateNumbers(reportHost);
      return;
    }
    state.observer = new IntersectionObserver((entries) => {
      entries.forEach((item) => {
        if (item.isIntersecting) state.pendingReveals.add(item.target);
        else state.pendingReveals.delete(item.target);
      });
      scheduleRevealFlush();
    }, { root: scroll, rootMargin: '0px 0px -8% 0px', threshold: .06 });
    targets.forEach((target) => state.observer.observe(target));
  }

  function renderNumberValue(job, value) {
    if (job.target === 0 && job.zeroText) return job.zeroText;
    return job.format === 'duration' ? formatDuration(value) : formatNumber(value) + job.suffix;
  }

  function finishNumberJob(node, job) {
    if (node.isConnected) {
      node.textContent = renderNumberValue(job, job.target);
      node.classList.remove('is-counting');
      node.classList.add('is-counted');
    }
    state.numberJobs.delete(node);
  }

  function stopNumberFrame() {
    if (state.numberFrame) cancelAnimationFrame(state.numberFrame);
    state.numberFrame = 0;
    state.numberLastFrame = 0;
  }

  function runNumberFrame(now) {
    state.numberFrame = 0;
    if (!state.active || state.scrolling || !state.numberJobs.size) {
      state.numberLastFrame = 0;
      return;
    }
    const delta = state.numberLastFrame ? Math.min(64, now - state.numberLastFrame) : 0;
    state.numberLastFrame = now;
    state.numberJobs.forEach((job, node) => {
      if (!node.isConnected) {
        state.numberJobs.delete(node);
        return;
      }
      job.elapsed += delta;
      const progress = Math.min(1, job.elapsed / job.duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      const text = renderNumberValue(job, job.target * eased);
      if (text !== job.lastText) {
        node.textContent = text;
        job.lastText = text;
      }
      if (progress >= 1) finishNumberJob(node, job);
    });
    if (state.numberJobs.size) state.numberFrame = requestAnimationFrame(runNumberFrame);
    else state.numberLastFrame = 0;
  }

  function scheduleNumberFrame() {
    if (state.numberFrame || !state.active || state.scrolling || !state.numberJobs.size) return;
    state.numberLastFrame = 0;
    state.numberFrame = requestAnimationFrame(runNumberFrame);
  }

  function clearNumberJobs(finish) {
    stopNumberFrame();
    state.numberJobs.forEach((job, node) => {
      if (finish) finishNumberJob(node, job);
      else if (node.isConnected) node.classList.remove('is-counting');
    });
    state.numberJobs.clear();
  }

  function animateNumbers(scope) {
    scope.querySelectorAll('[data-career-number]:not([data-career-counted])').forEach((node) => {
      node.dataset.careerCounted = '1';
      const target = number(node.dataset.careerNumber);
      const suffix = node.dataset.careerSuffix || '';
      const format = node.dataset.careerFormat || 'number';
      const zeroText = node.dataset.careerZeroText || '';
      const job = {
        target,
        suffix,
        format,
        zeroText,
        duration: Math.min(1480, 900 + Math.log10(target + 1) * 105),
        elapsed: 0,
        lastText: '',
      };
      if (reducedMotion() || target === 0) {
        node.textContent = renderNumberValue(job, target);
        node.classList.add('is-counted');
        return;
      }
      node.classList.add('is-counting');
      state.numberJobs.set(node, job);
    });
    scheduleNumberFrame();
  }

  function finishScroll() {
    state.scrollIdleTimer = 0;
    state.scrolling = false;
    state.scrollSettledAt = performance.now();
    scheduleRevealFlush();
    scheduleNumberFrame();
  }

  function handleScroll() {
    if (!state.active) return;
    if (!state.scrolling) {
      state.scrolling = true;
      stopNumberFrame();
    }
    if (state.scrollIdleTimer) clearTimeout(state.scrollIdleTimer);
    state.scrollIdleTimer = window.setTimeout(finishScroll, SCROLL_IDLE_MS);
  }

  function stopRuntime(options) {
    const finishNumbers = !options || options.finishNumbers !== false;
    if (state.observer) state.observer.disconnect();
    state.observer = null;
    state.pendingReveals.clear();
    cancelRevealFrame();
    if (state.scrollIdleTimer) clearTimeout(state.scrollIdleTimer);
    state.scrollIdleTimer = 0;
    state.scrolling = false;
    state.scrollSettledAt = 0;
    clearNumberJobs(finishNumbers);
  }

  function showEntry() {
    reportHost.hidden = true; loading.hidden = true; entry.hidden = false;
    const kicker = entry.querySelector('.career-kicker');
    const title = entry.querySelector('h1');
    const copy = entry.querySelector('p:not(.career-kicker)');
    const button = entry.querySelector('[data-career-action="generate"]');
    if (kicker) kicker.textContent = tr('entryKicker');
    if (title) title.textContent = tr('entryTitle');
    if (copy) copy.textContent = tr('entryCopy');
    if (button) button.textContent = tr('generate');
    bindActions(entry);
  }

  function showLoading(regenerate) {
    if (!regenerate) { entry.hidden = true; reportHost.hidden = true; }
    loading.hidden = !!regenerate;
    const strong = loading.querySelector('strong'), copy = loading.querySelector('p');
    if (strong) strong.textContent = tr('generating');
    if (copy) copy.textContent = tr('reading');
    reportHost.querySelectorAll('[data-career-action="generate"]').forEach((button) => { button.disabled = true; button.textContent = tr('retrying'); });
  }

  async function request(url, options) {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...options });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
    return json;
  }

  async function generate() {
    if (state.loading) return;
    state.loading = true;
    const regenerate = !!state.report;
    state.error = '';
    showLoading(regenerate);
    try {
      const json = await request('/api/career-report-generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!json.exists || !json.report) throw new Error(tr('generateFailed'));
      render(json.report);
      scroll.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } catch (error) {
      state.error = `${tr('generateFailed')} ${error.message || ''}`.trim();
      if (state.report) render(state.report);
      else { showEntry(); const message = element('p', 'career-inline-error', state.error); entry.appendChild(message); }
    } finally {
      state.loading = false;
      loading.hidden = true;
      root.querySelectorAll('[data-career-action="generate"]').forEach((button) => { button.disabled = false; button.textContent = state.report ? tr('retry') : tr('generate'); });
    }
  }

  function bindActions(scope) {
    scope.querySelectorAll('[data-career-action="generate"]:not([data-career-bound])').forEach((button) => {
      button.dataset.careerBound = '1';
      button.addEventListener('click', generate);
    });
  }

  function initialize() {
    if (state.initializePromise) return state.initializePromise;
    state.initialized = true;
    state.initializePromise = (async () => {
      showLoading(false);
      try {
        const json = await request('/api/career-report');
        if (json.exists && json.report) render(json.report);
        else showEntry();
      } catch (error) {
        state.error = `${tr('loadFailed')} ${error.message || ''}`.trim();
        showEntry();
        entry.appendChild(element('p', 'career-inline-error', state.error));
      } finally {
        loading.hidden = true;
      }
    })();
    return state.initializePromise;
  }

  async function preload() { await initialize(); }
  async function activate() {
    state.active = true;
    await initialize();
    if (state.report && !state.observer) startReveals();
  }
  scroll.addEventListener('scroll', handleScroll, { passive: true });
  document.addEventListener('relatum:start-workspacechange', (event) => {
    const active = !!(event.detail && event.detail.workspace === 'career');
    state.active = active;
    if (!active) stopRuntime({ finishNumbers: true });
  });
  document.addEventListener('relatum:languagechange', () => {
    if (state.report) {
      const top = scroll.scrollTop;
      render(state.report);
      scroll.scrollTop = top;
    } else showEntry();
  });

  window.RelatumCareerReport = { activate, preload, generate, get report() { return state.report; } };
})();
