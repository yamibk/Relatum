// 活跃页独立运行时：历史读取与预热不依赖学习页。
(function () {
  'use strict';
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function localDay(date) {
    const d = date || new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  const today = localDay();

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function focusDurationLabel(sec) {
    const mins = Math.max(0, Math.round((Number(sec) || 0) / 60));
    if (mins < 60) return mins + ' 分钟';
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    return hours + ' 小时' + (rest ? ' ' + rest + ' 分' : '');
  }

  function T(message) {
    return window.RelatumI18n ? window.RelatumI18n.t(String(message || '')) : String(message || '');
  }

  async function api(path, options) {
    // 本地接口 15s 兜底：服务端挂起时不再让任务 patch 链永久排队（与路线面板 api 对齐）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, Object.assign({}, options, { signal: controller.signal }));
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || '操作失败');
      return json;
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error(T('请求超时，请重试'));
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  // —— 一年活跃热力图（已完成任务，按完成日；含归档历史，数据来自 /api/study-activity）——
  // 算法移植自博客 build.py 的 GitHub 风格贡献图：每页是一整个自然年，横轴按周、纵轴 7 天
  // （周一在上、周日在下），单元格颜色按当日「完成数量」分 5 档。活跃图与 render() 解耦。
  let activityDays = {};
  let activityPayload = null;
  let cadenceYear = '';
  let cadenceFlipping = false;
  let cadenceLoadSeq = 0;
  let activityDirty = true;
  let activityLoadPromise = null;
  let activityPreloadHandle = 0;
  let activityPreloadUsesIdle = false;
  let cadenceVisibleSyncFrame = 0;
  let cadenceYearWheelAccum = 0;
  let cadenceYearWheelTimer = 0;
  let starInstance = null;   // 足迹星图当前实例（活跃图重绘时先销毁旧实例再挂新的）
  let cadenceShown = false;  // 活跃页当前是否被选为前置页（起步页翻页时由 StudyActivity.setActive 同步）
  let starReleaseTimer = 0;
  let starMode = 'normal';
  let cadenceLens = 'canvas';   // v2 首次默认画布；之后记住 canvas / complete / focus
  try {
    const storedLens = localStorage.getItem('canvas:cadenceLens:v2');
    if (storedLens === 'canvas' || storedLens === 'complete' || storedLens === 'focus') cadenceLens = storedLens;
  } catch (e) {}
  let cadenceInteractionCleanup = null;
  const CADENCE = { cell: 16, gap: 4, leftPad: 38, topPad: 28 };
  const CADENCE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function cadenceLevel(n) {
    if (!n) return 0;
    if (n === 1) return 1;
    if (n === 2) return 2;
    if (n <= 4) return 3;
    if (n <= 7) return 4;
    if (n <= 10) return 5;
    if (n <= 14) return 6;
    return 7;
  }

  // 专注热力档位：按当天专注分钟分级（配套独立的暖棕色阶，与完成数的火红区分）。
  function cadenceFocusLevel(min) {
    if (!min) return 0;
    if (min <= 15) return 1;
    if (min <= 30) return 2;
    if (min <= 60) return 3;
    if (min <= 120) return 4;
    if (min <= 180) return 5;
    if (min <= 300) return 6;
    return 7;
  }
  function fmtFocusDur(min) {
    min = Math.round(min || 0);
    if (min < 60) return min + ' 分钟';
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
  }
  // 专注统计卡片的数字 + 单位（<1 小时显示分钟，否则 X.X 小时）。
  function fmtFocusStat(sec) {
    const min = Math.round((sec || 0) / 60);
    if (min < 60) return { num: String(min), unit: '分钟' };
    return { num: (min / 60).toFixed(1).replace(/\.0$/, ''), unit: '小时' };
  }
  function focusStatCell(sec, label) {
    const f = fmtFocusStat(sec);
    return '<div><strong>' + f.num + '<small> ' + f.unit + '</small></strong><span>' + label + '</span></div>';
  }

  function fmtCanvasStat(sec) {
    if (Number(sec) > 0 && Number(sec) < 60) return { num: '&lt;1', unit: '分钟' };
    return fmtFocusStat(sec);
  }

  function cadenceStatMeasure(format, extra) {
    const f = format || { num: '0', unit: '' };
    const className = extra ? ' cadence-stat-addon' : '';
    const attrs = extra
      ? ' tabindex="0" title="学习、树状、速记合计" aria-label="学习、树状、速记合计"'
      : '';
    return '<span class="cadence-stat-measure' + className + '"' + attrs + '><b>'
      + (extra ? '+' : '') + f.num + '</b>'
      + (f.unit ? '<small> ' + f.unit + '</small>' : '') + '</span>';
  }

  function splitCanvasStatCell(primary, extra, label) {
    return '<div><strong class="cadence-stat-pair">' + cadenceStatMeasure(primary, false)
      + (extra ? cadenceStatMeasure(extra, true) : '') + '</strong>'
      + '<span class="cadence-stat-label">' + label + '</span></div>';
  }

  function canvasPageTimeStatCell(canvasSec, pageSec, label) {
    return splitCanvasStatCell(fmtCanvasStat(canvasSec), fmtCanvasStat(pageSec), label);
  }

  function canvasPageCountStatCell(canvasValue, pageValue, unit, label) {
    return splitCanvasStatCell(
      { num: String(Math.max(0, Number(canvasValue) || 0)), unit: unit || '' },
      { num: String(Math.max(0, Number(pageValue) || 0)), unit: unit || '' },
      label
    );
  }

  function fmtCanvasDuration(sec) {
    sec = Math.max(0, Number(sec) || 0);
    if (sec > 0 && sec < 60) return '不足 1 分钟';
    return fmtFocusDur(Math.round(sec / 60));
  }

  function cadenceCanvasDayDetailHtml(day, entries, summary, todayKey) {
    const items = (entries || []).filter((item) => item.day === day);
    const future = day > todayKey;
    const durationSec = Math.max(0, Number(summary && summary.durationSec) || 0);
    let note = '这一天还没有画布使用记录。';
    if (future) note = '这一天还在前方。';
    else if (day === todayKey && !items.length) note = '今天还没有打开画布。';
    const list = items.length
      ? '<div class="cadence-day-detail-list">' + items.map((item, index) => {
        const flags = [];
        if (item.created) flags.push('<i>新建</i>');
        if (item.modified) flags.push('<i>修改</i>');
        if (item.inferred && !item.durationSec) flags.push('<i>历史记录</i>');
        const duration = item.durationSec
          ? '<span>' + escapeHtml(fmtCanvasDuration(item.durationSec)) + '</span>'
          : '<span>历史时长无法还原</span>';
        const open = item.canvasAvailable && window.RelatumFeatureRuntime.enabled('canvas.editor')
          ? '<button type="button" class="cadence-open-canvas cadence-day-open" data-canvas-path="'
            + escapeHtml(item.path) + '">打开画布</button>'
          : '';
        return '<div class="cadence-day-detail-item cadence-canvas-detail-item" style="--detail-delay:'
          + (index * 45) + 'ms"><span aria-hidden="true"></span><div class="cadence-record-copy">'
          + '<strong>' + escapeHtml(item.title || '未命名画布') + '</strong>'
          + '<span class="cadence-canvas-meta">' + flags.join('') + duration + '</span></div>' + open + '</div>';
      }).join('') + '</div>'
      : '<p class="cadence-day-detail-empty">' + note + '</p>';
    const heading = items.length
      ? '使用 ' + items.length + ' 张画布' + (durationSec ? ' · ' + fmtCanvasDuration(durationSec) : '')
      : '安静的一天';
    return '<div class="cadence-day-detail-copy"><p>' + escapeHtml(cadenceDateLabel(day, true)) + '</p>'
      + '<h3>' + heading + '</h3></div>' + list;
  }
  function cadenceFocusDayDetailHtml(day, sec, count, todayKey) {
    const future = day > todayKey;
    const min = Math.round((sec || 0) / 60);
    let note = '这一天没有专注记录。';
    if (future) note = '这一天还在前方。';
    else if (day === todayKey && !min) note = '今天还没有开始专注。';
    const body = min
      ? '<div class="cadence-day-detail-focus"><strong>' + fmtFocusDur(min) + '</strong>'
        + '<span>共 ' + count + ' 段专注</span></div>'
      : '<p class="cadence-day-detail-empty">' + note + '</p>';
    return '<div class="cadence-day-detail-copy"><p>' + escapeHtml(cadenceDateLabel(day, true)) + '</p>'
      + '<h3>' + (min ? '专注 ' + fmtFocusDur(min) : '安静的一天') + '</h3></div>'
      + body;
  }

  function cadenceReflection(reflection) {
    if (!reflection) return '这里会慢慢长出你的节奏。';
    const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月',
      '七月', '八月', '九月', '十月', '十一月', '十二月'];
    const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const month = parseInt(String(reflection.month || '').slice(5, 7), 10);
    return (monthNames[month - 1] || reflection.month) + '，你完成了 ' + reflection.count
      + ' 件事。最常在' + (weekdayNames[reflection.weekday] || '某一天') + '留下痕迹。';
  }

  function cadenceDateLabel(day, withYear) {
    const date = new Date(String(day || '') + 'T00:00:00');
    if (Number.isNaN(date.getTime())) return String(day || '');
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return (withYear ? date.getFullYear() + ' 年 ' : '')
      + (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日 · ' + weekdays[date.getDay()];
  }

  function cadenceRecordCopy(item) {
    const title = '<strong>' + escapeHtml(item.title || '未命名任务') + '</strong>';
    if (item.kind !== 'taskbook') return title;
    const leafCount = Math.max(0, Number(item.leafCount) || 0);
    const duration = focusDurationLabel(Math.max(0, Number(item.durationMs) || 0) / 1000);
    return title + '<span class="cadence-taskbook-meta"><i>任务簿</i><span>'
      + leafCount + ' 项 · ' + escapeHtml(duration) + '</span></span>';
  }

  function cadenceDayDetailHtml(day, entries, count, todayKey) {
    const items = (entries || []).filter((item) => item.day === day);
    const future = day > todayKey;
    let note = '这一天还没有留下完成记录。';
    if (future) note = '这一天还在前方。';
    else if (day === todayKey && !count) note = '今天仍是一张等待落笔的纸。';
    const list = items.length
      ? '<div class="cadence-day-detail-list">' + items.map((item, index) => {
        const canvas = item.canvasAvailable && window.RelatumFeatureRuntime.enabled('canvas.editor')
          ? '<button type="button" class="cadence-open-canvas cadence-day-open" data-canvas-path="'
            + escapeHtml(item.linkedCanvas) + '">打开画布</button>'
          : '';
        return '<div class="cadence-day-detail-item" style="--detail-delay:' + (index * 45) + 'ms">'
          + '<span aria-hidden="true"></span><div class="cadence-record-copy">'
          + cadenceRecordCopy(item) + '</div>' + canvas + '</div>';
      }).join('') + '</div>'
      : '<p class="cadence-day-detail-empty">' + note + '</p>';
    return '<div class="cadence-day-detail-copy"><p>' + escapeHtml(cadenceDateLabel(day, true)) + '</p>'
      + '<h3>' + (count ? '留下 ' + count + ' 道足迹' : '安静的一天') + '</h3></div>'
      + list;
  }

  function recentCadenceHtml(recent) {
    if (!recent.length) {
      return '<p class="cadence-empty">归档过的任务，会安静地留在这里。</p>';
    }
    const groups = [];
    recent.forEach((item) => {
      const day = String(item.day || '');
      let group = groups[groups.length - 1];
      if (!group || group.day !== day) {
        group = { day, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    });
    return '<div class="cadence-recent-list">' + groups.map((group, index) => {
      const date = new Date(group.day + 'T00:00:00');
      const label = Number.isNaN(date.getTime())
        ? group.day
        : CADENCE_MONTHS[date.getMonth()] + ' ' + String(date.getDate()).padStart(2, '0');
      return '<section class="cadence-recent-group" style="--cadence-group-delay:' + (index * 52) + 'ms">'
        + '<time>' + escapeHtml(label) + '</time><div class="cadence-recent-group-items">'
        + group.items.map((item) => {
          const canvas = item.canvasAvailable && window.RelatumFeatureRuntime.enabled('canvas.editor')
            ? '<button type="button" class="cadence-open-canvas" data-canvas-path="'
              + escapeHtml(item.linkedCanvas) + '">打开画布</button>'
            : '';
          return '<div class="cadence-recent-item"><span class="cadence-recent-dot"></span>'
            + '<div class="cadence-record-copy">' + cadenceRecordCopy(item) + '</div>'
            + canvas + '</div>';
        }).join('') + '</div></section>';
    }).join('') + '</div>';
  }

  function cadenceYearSpineHtml(years, activeYear) {
    return '<nav class="cadence-year-spine" data-role="cadence-year-spine" aria-label="活跃年份翻页">'
      + '<span class="cadence-year-orb" data-role="cadence-year-orb" aria-hidden="true"></span>'
      + years.map((year) => '<button type="button" class="cadence-year-dot'
        + (String(year) === String(activeYear) ? ' active' : '') + '" data-cadence-year="' + year
        + '" aria-label="查看 ' + year + ' 年"><i aria-hidden="true"></i><span>' + year + ' 年</span></button>').join('')
      + '</nav>';
  }

  function syncCadenceYearOrb(host, fromYear) {
    const spine = host.querySelector('[data-role="cadence-year-spine"]');
    const orb = host.querySelector('[data-role="cadence-year-orb"]');
    const active = spine && spine.querySelector('.cadence-year-dot.active');
    if (!spine || !orb || !active) return;
    const spineRect = spine.getBoundingClientRect();
    function transformFor(button) {
      const rect = button.getBoundingClientRect();
      return 'translate3d(' + (rect.left - spineRect.left + (rect.width - 14) / 2) + 'px,'
        + (rect.top - spineRect.top + (rect.height - 14) / 2) + 'px,0)';
    }
    const previous = fromYear && spine.querySelector('[data-cadence-year="' + fromYear + '"]');
    if (previous && previous !== active && !prefersReduced) {
      orb.classList.add('no-transition');
      orb.style.transform = transformFor(previous);
      orb.classList.add('show');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        orb.classList.remove('no-transition');
        orb.style.transform = transformFor(active);
      }));
      return;
    }
    orb.style.transform = transformFor(active);
    orb.classList.add('show');
  }

  function placeStarModeSlider(sw, animate) {
    const slider = sw && sw.querySelector('[data-role="star-mode-slider"]');
    const active = sw && sw.querySelector('.star-mode-btn.active');
    if (!slider || !active || !active.offsetWidth) return;
    if (!animate) slider.classList.add('no-transition');
    slider.style.width = active.offsetWidth + 'px';
    slider.style.height = active.offsetHeight + 'px';
    slider.style.transform = 'translate3d(' + active.offsetLeft + 'px,' + active.offsetTop + 'px,0)';
    slider.classList.add('show');
    if (!animate) requestAnimationFrame(() => requestAnimationFrame(() => slider.classList.remove('no-transition')));
  }

  function mountStarGraph(host, payload, options) {
    if (starInstance) { try { starInstance.destroy(); } catch (e) {} starInstance = null; }
    if (!cadenceShown) return;
    const starStage = host.querySelector('[data-role="study-starmap"]');
    if (starStage && window.StudyGraph) {
      const canvasLens = cadenceLens === 'canvas';
      const graph = starMode === 'overview'
        ? (canvasLens ? (payload.canvasOverviewGraph || {}) : (payload.overviewGraph || {}))
        : (canvasLens ? (payload.canvasGraph || {}) : (payload.graph || {}));
      // 隐藏页只缓存数据；真正打开才分配 WebGL 和标签层。
      starInstance = window.StudyGraph.mount(starStage, graph, {
        active: cadenceShown,
        intro: !(options && options.intro === false),
      });
    }
  }

  function setupStarModeSwitch(host, payload) {
    const sw = host.querySelector('[data-role="star-mode-switch"]');
    if (!sw) return;
    const buttons = Array.from(sw.querySelectorAll('.star-mode-btn'));
    function apply(animate, remount) {
      buttons.forEach((button) => button.classList.toggle('active', button.dataset.starMode === starMode));
      placeStarModeSlider(sw, animate);
      if (!remount) return;
      mountStarGraph(host, payload, { intro: true });
    }
    buttons.forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.starMode === starMode) return;
      starMode = button.dataset.starMode;
      apply(true, true);
    }));
    apply(false, false);
    // 动态活动页会先以中文建 DOM，再由 i18n 的 MutationObserver 翻译；
    // 下一帧按最终文案重量一次，避免英文 “Normal” 仍沿用中文按钮宽度而被裁切。
    requestAnimationFrame(() => placeStarModeSlider(sw, false));
  }

  function renderCadence(payload, options) {
    const host = document.querySelector('[data-role="study-cadence"]');
    if (!host) return;
    const days = payload.days || {};
    const entries = payload.entries || payload.recent || [];
    const stats = payload.stats || {};
    const recent = payload.recent || [];
    const focusDays = payload.focusDays || {};   // { 'YYYY-MM-DD': {sec,count} } 当年逐日专注
    const focusStats = payload.focusStats || {};  // { today, month, year, total }（秒）
    const canvasDays = payload.canvasDays || {};
    const canvasEntries = payload.canvasEntries || [];
    const canvasStats = payload.canvasStats || {};
    const startPageStats = payload.startPageStats || {};
    const C = CADENCE;
    const step = C.cell + C.gap;
    const now = new Date();
    const todayKey = localDay(now);
    const year = Number(payload.year) || now.getFullYear();
    const years = (payload.years || [year]).slice();
    const currentYear = year === now.getFullYear();
    // 每页是一整个自然年：左端补到该年元旦所在周的周一，右端补到年末所在周的周日。
    const yearStart = new Date(year, 0, 1);
    const start = new Date(yearStart);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(year, 11, 31);
    end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));
    const weeks = Math.floor((end - start) / (7 * 86400000)) + 1;
    const rects = [];
    const monthLabels = [];
    let prevMonth = -1;
    let lastLabelW = -99;
    for (let w = 0; w < weeks; w++) {
      let columnMonth = -1;
      for (let d = 0; d < 7; d++) {
        const probe = new Date(start);
        probe.setDate(start.getDate() + w * 7 + d);
        if (probe.getFullYear() === year) { columnMonth = probe.getMonth(); break; }
      }
      if (columnMonth !== -1 && columnMonth !== prevMonth) {
        // 相邻月份保持 >=2 列间距，避免短月边界挤成一团。
        if (w - lastLabelW >= 2) {
          monthLabels.push('<text class="cadence-month" data-month="' + columnMonth + '" x="'
            + (C.leftPad + w * step) + '" y="' + (C.topPad - 9) + '">'
            + CADENCE_MONTHS[columnMonth] + '</text>');
          lastLabelW = w;
        }
        prevMonth = columnMonth;
      }
      for (let d = 0; d < 7; d++) {
        const cell = new Date(start);
        cell.setDate(start.getDate() + w * 7 + d);
        if (cell.getFullYear() !== year) continue;
        const key = localDay(cell);
        const count = days[key] || 0;
        const lv = cadenceLevel(count);
        const future = key > todayKey;
        const isToday = key === todayKey;
        const tip = cadenceDateLabel(key, false) + (future
          ? ' · 尚未到来'
          : count ? ' · 完成 ' + count + ' 项' : ' · 暂无记录');
        const fd = focusDays[key];
        const fmin = fd ? Math.round((fd.sec || 0) / 60) : 0;
        const fcount = fd ? (fd.count || 0) : 0;
        const flv = cadenceFocusLevel(fmin);
        const ftip = cadenceDateLabel(key, false) + (future
          ? ' · 尚未到来'
          : fmin ? ' · 专注 ' + fmtFocusDur(fmin) : ' · 未专注');
        const cd = canvasDays[key] || {};
        const csec = Math.max(0, Number(cd.durationSec) || 0);
        const cmin = csec ? Math.max(1, Math.ceil(csec / 60)) : 0;
        const clv = cadenceFocusLevel(cmin);
        const canvasHistorical = !!cd.inferred && !csec;
        const ctip = cadenceDateLabel(key, false) + (future
          ? ' · 尚未到来'
          : csec ? ' · 画布 ' + fmtCanvasDuration(csec)
            : canvasHistorical ? ' · 有历史画布记录，时长无法还原' : ' · 未使用画布');
        const activeTip = cadenceLens === 'canvas' ? ctip : (cadenceLens === 'focus' ? ftip : tip);
        rects.push('<rect x="' + (C.leftPad + w * step) + '" y="' + (C.topPad + d * step)
          + '" width="' + C.cell + '" height="' + C.cell + '" rx="3" class="cadence-cell cadence-l'
          + lv + ' cadence-fl' + flv + ' cadence-cl' + clv + (count ? ' has-activity' : '')
          + (canvasHistorical ? ' has-canvas-history' : '') + (future ? ' is-future' : '')
          + (isToday ? ' is-today' : '')
          + '" style="--cadence-delay:' + Math.round(Math.min(760, d * 92 + w * 5))
          + 'ms" data-wave-x="' + (C.leftPad + w * step + C.cell / 2) + '" data-wave-y="'
          + (C.topPad + d * step + C.cell / 2) + '" data-wave-w="' + w + '" data-wave-d="' + d
          + '" data-month="' + cell.getMonth() + '" data-day-key="' + key + '" data-count="' + count
          + '" data-focus-min="' + fmin + '" data-focus-count="' + fcount
          + '" data-canvas-sec="' + csec + '" data-tip="' + escapeHtml(tip)
          + '" data-tip-focus="' + escapeHtml(ftip) + '" data-tip-canvas="' + escapeHtml(ctip)
          + '" tabindex="' + (future ? '-1' : '0')
          + '" role="button" aria-label="' + escapeHtml(activeTip) + '"></rect>');
      }
    }
    const dayLabels = [[0, 'Mon'], [2, 'Wed'], [4, 'Fri']].map((p) =>
      '<text class="cadence-day" data-day="' + p[0] + '" x="' + (C.leftPad - 7) + '" y="'
        + (C.topPad + p[0] * step + C.cell - 2) + '" text-anchor="end">' + p[1] + '</text>');
    const svgW = C.leftPad + weeks * step + 6;
    const svgH = C.topPad + 7 * step + 4;
    const statOne = currentYear ? (stats.monthTotal || 0) : (payload.pageTotal || 0);
    const statOneLabel = currentYear ? '本月完成' : year + ' 年完成';
    const statTwo = currentYear ? (stats.streak || 0) : (stats.longestStreak || 0);
    const statTwoLabel = currentYear ? '连续推进' : '最长连续';
    const activeSource = cadenceLens === 'canvas' ? canvasDays : (cadenceLens === 'focus' ? focusDays : days);
    const activeKeys = Object.keys(activeSource).filter((key) => activeSource[key] && key <= todayKey).sort();
    const initialDay = currentYear
      ? todayKey
      : (activeKeys[activeKeys.length - 1] || year + '-01-01');
    const contentHtml =
      '<div class="study-cadence-head">'
        + '<div><p class="study-eyebrow">YEAR IN MOTION · ' + year + '</p>'
          + '<div class="cadence-title-row"><h2>年度足迹</h2><span>' + year + '</span></div></div>'
        + '<div class="cadence-head-tools">'
        + '<div class="cadence-lens-switch" data-role="cadence-lens-switch" data-active="' + cadenceLens + '" aria-label="热力图查看">'
          + '<span class="cadence-lens-slider" aria-hidden="true"></span>'
          + '<button type="button" class="cadence-lens-btn' + (cadenceLens === 'canvas' ? ' active' : '') + '" data-lens="canvas">画布</button>'
          + '<button type="button" class="cadence-lens-btn' + (cadenceLens === 'complete' ? ' active' : '') + '" data-lens="complete">完成</button>'
          + '<button type="button" class="cadence-lens-btn' + (cadenceLens === 'focus' ? ' active' : '') + '" data-lens="focus">专注</button>'
        + '</div>'
        + '<div class="cadence-legend" aria-label="足迹浓度从静到丰"><span>静</span>'
        + '<span class="cadence-legend-cells">'
        + '<span class="cadence-legend-cell cadence-l0"></span>'
        + '<span class="cadence-legend-cell cadence-l1"></span>'
        + '<span class="cadence-legend-cell cadence-l2"></span>'
        + '<span class="cadence-legend-cell cadence-l3"></span>'
        + '<span class="cadence-legend-cell cadence-l4"></span>'
        + '<span class="cadence-legend-cell cadence-l5"></span>'
        + '<span class="cadence-legend-cell cadence-l6"></span>'
        + '<span class="cadence-legend-cell cadence-l7"></span>'
        + '</span><span>丰</span></div>'
        + '<button type="button" class="page-refresh" data-cadence-refresh'
        + ' aria-label="重新读取活跃数据" title="手动重新读取活跃数据（包括画布、学习、树状、速记、完成任务和专注）">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>'
        + '<span>更新</span></button>'
        + '</div>'
      + '</div>'
      + '<div class="cadence-chart-shell">'
        + '<div class="cadence-chart-wrap">'
        + '<svg class="cadence-chart" viewBox="0 0 ' + svgW + ' ' + svgH + '" width="' + svgW
        + '" height="' + svgH + '" xmlns="http://www.w3.org/2000/svg" role="img"'
        + ' aria-label="' + year + (cadenceLens === 'canvas' ? ' 年逐日画布使用时长热力图'
          : cadenceLens === 'focus' ? ' 年逐日专注时长热力图' : ' 年逐日已完成任务热力图') + '">'
        + monthLabels.join('') + dayLabels.join('') + rects.join('')
        + '</svg>'
        + '</div>'
        + '<div class="cadence-chart-caption"><span><i class="is-today-mark"></i>今天</span>'
          + '<span><i class="is-future-mark"></i>尚未到来</span>'
          + '<p>' + (cadenceLens === 'canvas' ? '悬停回望，点击展开当天画布' : '悬停回望，点击展开当天成果') + '</p></div>'
      + '</div>'
      + '<section class="cadence-day-detail" data-role="cadence-day-detail" aria-live="polite">'
        + (cadenceLens === 'canvas'
          ? cadenceCanvasDayDetailHtml(initialDay, canvasEntries, canvasDays[initialDay] || {}, todayKey)
          : cadenceLens === 'focus'
            ? cadenceFocusDayDetailHtml(initialDay, (focusDays[initialDay] || {}).sec || 0,
                (focusDays[initialDay] || {}).count || 0, todayKey)
            : cadenceDayDetailHtml(initialDay, entries, days[initialDay] || 0, todayKey))
      + '</section>'
      + '<div class="cadence-stats cadence-stats-canvas" aria-label="画布时间统计">'
        + canvasPageTimeStatCell(currentYear ? canvasStats.monthSec : canvasStats.yearSec,
          currentYear ? startPageStats.monthSec : startPageStats.yearSec,
          currentYear ? '本月画布时间' : '当年画布时间')
        + canvasPageCountStatCell(
          currentYear ? canvasStats.streak : canvasStats.longestStreak,
          currentYear ? startPageStats.streak : startPageStats.longestStreak,
          '天', currentYear ? '连续活跃' : '最长连续')
        + canvasPageCountStatCell(canvasStats.activeCanvasCount, startPageStats.activePageCount, '', '活跃画布')
        + canvasPageTimeStatCell(canvasStats.totalSec, startPageStats.totalSec, '累计画布时间')
      + '</div>'
      + '<div class="cadence-stats cadence-stats-complete" aria-label="活跃统计">'
        + '<div><strong>' + statOne + '</strong><span>' + statOneLabel + '</span></div>'
        + '<div><strong>' + statTwo + '<small> 天</small></strong><span>' + statTwoLabel + '</span></div>'
        + '<div><strong>' + (payload.archiveFolders || 0) + '</strong><span>累计归档</span></div>'
        + '<div><strong>' + (payload.total || 0) + '</strong><span>累计完成</span></div>'
      + '</div>'
      + '<div class="cadence-stats cadence-stats-focus" aria-label="专注时间统计">'
        + focusStatCell(focusStats.today, '今日专注')
        + focusStatCell(focusStats.month, '本月专注')
        + focusStatCell(focusStats.year, '今年专注')
        + focusStatCell(focusStats.total, '累计专注')
      + '</div>'
      + '<section class="cadence-starmap">'
        + '<div class="cadence-starmap-head"><div><p class="study-eyebrow">STARMAP</p>'
          + '<h3 data-role="cadence-starmap-title">' + (cadenceLens === 'canvas' ? '画布星图' : '足迹星图') + '</h3></div>'
          + '<div class="cadence-starmap-tools">'
            + '<div class="star-mode-switch" data-role="star-mode-switch" aria-label="星图查看模式">'
              + '<span class="star-mode-slider" data-role="star-mode-slider" aria-hidden="true"></span>'
              + '<button type="button" class="star-mode-btn" data-star-mode="normal">正常</button>'
              + '<button type="button" class="star-mode-btn" data-star-mode="overview">总览</button>'
            + '</div>'
          + '</div></div>'
        + '<div class="cadence-starmap-stage" data-role="study-starmap"></div>'
      + '</section>'
      + '<section class="cadence-footprint">'
        + '<div class="cadence-footprint-head"><div><p class="study-eyebrow">FOOTPRINT</p>'
          + '<h3>最近完成</h3></div><p>' + escapeHtml(cadenceReflection(payload.reflection)) + '</p></div>'
        + recentCadenceHtml(recent)
      + '</section>';
    if (cadenceInteractionCleanup) {
      cadenceInteractionCleanup();
      cadenceInteractionCleanup = null;
    }
    if (starInstance) { try { starInstance.destroy(); } catch (e) {} starInstance = null; }
    const incoming = options && options.incoming;
    host.innerHTML =
      cadenceYearSpineHtml(years, year)
      + '<div class="cadence-year-page' + (incoming ? ' flip-in-' + incoming : '')
        + '" data-role="cadence-year-page">' + contentHtml + '</div>'
      + '<div class="cadence-tooltip" role="status" aria-hidden="true"></div>';
    host.classList.toggle('cadence-lens-focus', cadenceLens === 'focus');
    host.classList.toggle('cadence-lens-canvas', cadenceLens === 'canvas');
    const yearPage = host.querySelector('[data-role="cadence-year-page"]');
    if (incoming && yearPage && !prefersReduced) {
      void yearPage.offsetHeight;
      yearPage.classList.remove('flip-in-' + incoming);
    }
    syncCadenceYearOrb(host, options && options.orbFromYear);
    host.querySelectorAll('[data-cadence-year]').forEach((button) => {
      button.addEventListener('click', () => navigateCadenceYear(button.dataset.cadenceYear));
    });
    const yearSpine = host.querySelector('[data-role="cadence-year-spine"]');
    if (yearSpine) {
      yearSpine.addEventListener('wheel', (event) => {
        event.preventDefault();
        event.stopPropagation();   // 窄窗口下年份书脊会靠近外层书脊，避免一次滚轮同时翻两层页
        if (cadenceFlipping) return;
        cadenceYearWheelAccum += event.deltaY;
        clearTimeout(cadenceYearWheelTimer);
        cadenceYearWheelTimer = setTimeout(() => { cadenceYearWheelAccum = 0; }, 200);
        if (Math.abs(cadenceYearWheelAccum) < 24) return;
        const delta = cadenceYearWheelAccum > 0 ? 1 : -1;
        cadenceYearWheelAccum = 0;
        flipCadenceYearBy(delta);
      }, { passive: false });
    }
    mountStarGraph(host, payload);
    setupStarModeSwitch(host, payload);
    const wrap = host.querySelector('.cadence-chart-wrap');
    if (wrap) wrap.scrollLeft = 0;
    const tooltip = host.querySelector('.cadence-tooltip');
    const svg = host.querySelector('.cadence-chart');
    const cells = Array.from(host.querySelectorAll('.cadence-cell'));
    const monthEls = Array.from(host.querySelectorAll('.cadence-month'));
    const dayEls = Array.from(host.querySelectorAll('.cadence-day'));
    const cellGrid = new Map(cells.map((cell) => [cell.dataset.waveW + ':' + cell.dataset.waveD, cell]));
    let focusedMonth = '';
    function setCadenceMonthFocus(month) {
      if (month === focusedMonth) return;
      focusedMonth = month;
      monthEls.forEach((label) => label.classList.toggle('is-focused', label.dataset.month === month));
    }
    let selectedDay = initialDay;
    let detailHeightAnim = null;   // 切换日期时的高度补间句柄；快速连切时先取消旧的，避免叠加
    // 当天详情按当前镜头取内容：画布时间 / 完成记录 / 专注时长。
    function detailHtmlForDay(day) {
      if (cadenceLens === 'canvas') {
        return cadenceCanvasDayDetailHtml(day, canvasEntries, canvasDays[day] || {}, todayKey);
      }
      if (cadenceLens === 'focus') {
        const fd = focusDays[day] || {};
        return cadenceFocusDayDetailHtml(day, fd.sec || 0, fd.count || 0, todayKey);
      }
      return cadenceDayDetailHtml(day, entries, days[day] || 0, todayKey);
    }
    // 换内容时先量旧高、换好量新高，用高度补间把跳变磨平，下方区块随之顺滑位移而非硬切。
    function applyDayDetail() {
      const detail = host.querySelector('[data-role="cadence-day-detail"]');
      if (!detail) return;
      const fromHeight = detail.offsetHeight;
      if (detailHeightAnim) { detailHeightAnim.cancel(); detailHeightAnim = null; detail.style.overflow = ''; }
      detail.classList.remove('is-refreshing');
      detail.innerHTML = detailHtmlForDay(selectedDay);
      detail.querySelectorAll('[data-canvas-path]').forEach((button) => {
        button.addEventListener('click', () => window.gotoEditor(button.dataset.canvasPath, null, false));
      });
      if (!prefersReduced) {
        const toHeight = detail.offsetHeight;
        if (fromHeight && toHeight && Math.abs(fromHeight - toHeight) > 0.5) {
          detail.style.overflow = 'hidden';
          const anim = detail.animate(
            [{ height: fromHeight + 'px' }, { height: toHeight + 'px' }],
            { duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
          );
          detailHeightAnim = anim;
          anim.finished.catch(() => {}).then(() => {
            if (detailHeightAnim === anim) { detail.style.overflow = ''; detailHeightAnim = null; }
          });
        }
        void detail.offsetWidth;
        detail.classList.add('is-refreshing');
      }
    }
    function selectCadenceDay(cell, moveFocus) {
      if (!cell || cell.classList.contains('is-future')) return;
      selectedDay = cell.dataset.dayKey || selectedDay;
      cells.forEach((candidate) => candidate.classList.toggle('is-selected',
        candidate.dataset.dayKey === selectedDay));
      applyDayDetail();
      setCadenceMonthFocus(cell.dataset.month || '');
      if (moveFocus) cell.focus();
    }
    // 镜头切换：格子 / 图例 / 卡片靠 CSS 类瞬切，提示实时读，只重渲染「当天详情」一小块，星图不重挂。
    const lensSwitch = host.querySelector('[data-role="cadence-lens-switch"]');
    if (lensSwitch) {
      lensSwitch.querySelectorAll('.cadence-lens-btn').forEach((button) => {
        button.addEventListener('click', () => {
          const next = button.dataset.lens;
          if (next === cadenceLens) return;
          const remountStar = (next === 'canvas') !== (cadenceLens === 'canvas');
          cadenceLens = next;
          try { localStorage.setItem('canvas:cadenceLens:v2', cadenceLens); } catch (e) {}
          lensSwitch.dataset.active = cadenceLens;
          lensSwitch.querySelectorAll('.cadence-lens-btn').forEach((b) =>
            b.classList.toggle('active', b.dataset.lens === cadenceLens));
          host.classList.toggle('cadence-lens-focus', cadenceLens === 'focus');
          host.classList.toggle('cadence-lens-canvas', cadenceLens === 'canvas');
          cells.forEach((cell) => {
            const label = cadenceLens === 'canvas'
              ? (cell.dataset.tipCanvas || cell.dataset.tip)
              : cadenceLens === 'focus' ? (cell.dataset.tipFocus || cell.dataset.tip) : cell.dataset.tip;
            cell.setAttribute('aria-label', label);
          });
          const starTitle = host.querySelector('[data-role="cadence-starmap-title"]');
          if (starTitle) starTitle.textContent = cadenceLens === 'canvas' ? '画布星图' : '足迹星图';
          const chart = host.querySelector('.cadence-chart');
          if (chart) chart.setAttribute('aria-label', year + (cadenceLens === 'canvas'
            ? ' 年逐日画布使用时长热力图'
            : cadenceLens === 'focus' ? ' 年逐日专注时长热力图' : ' 年逐日已完成任务热力图'));
          const chartCaption = host.querySelector('.cadence-chart-caption p');
          if (chartCaption) chartCaption.textContent = cadenceLens === 'canvas'
            ? '悬停回望，点击展开当天画布'
            : '悬停回望，点击展开当天成果';
          if (remountStar) mountStarGraph(host, payload, { intro: true });
          applyDayDetail();
        });
      });
    }
    const cadenceRefresh = host.querySelector('[data-cadence-refresh]');
    if (cadenceRefresh) cadenceRefresh.addEventListener('click', () => refreshCadence(cadenceRefresh));
    const initialCell = cells.find((cell) => cell.dataset.dayKey === initialDay);
    if (initialCell) initialCell.classList.add('is-selected');
    let interactionFrame = 0;
    let pointerEvent = null;
    let geometry = null;
    let activeWaveCells = new Set();
    let tooltipCell = null;
    function refreshCadenceGeometry() {
      geometry = {
        host: host.getBoundingClientRect(),
        svg: svg ? svg.getBoundingClientRect() : null
      };
    }
    function clearCadenceWave() {
      activeWaveCells.forEach((cell) => {
        cell.style.removeProperty('--wave-scale');
        cell.style.removeProperty('--wave-lift');
        cell.classList.remove('is-wave');
      });
      activeWaveCells = new Set();
      dayEls.forEach((label) => label.classList.remove('is-focused'));
    }
    function renderCadenceInteraction() {
      interactionFrame = 0;
      if (!pointerEvent || prefersReduced) return;
      if (!geometry) refreshCadenceGeometry();
      const svgRect = geometry.svg;
      if (svgRect && pointerEvent.clientX >= svgRect.left && pointerEvent.clientX <= svgRect.right
          && pointerEvent.clientY >= svgRect.top && pointerEvent.clientY <= svgRect.bottom) {
        const svgW = C.leftPad + weeks * step + 6;
        const svgH = C.topPad + 7 * step + 4;
        const svgX = (pointerEvent.clientX - svgRect.left) * svgW / svgRect.width;
        const svgY = (pointerEvent.clientY - svgRect.top) * svgH / svgRect.height;
        const centerW = Math.round((svgX - C.leftPad - C.cell / 2) / step);
        const hoveredDay = Math.round((svgY - C.topPad - C.cell / 2) / step);
        const nextWaveCells = new Set();
        dayEls.forEach((label) => {
          label.classList.toggle('is-focused', Math.abs(Number(label.dataset.day) - hoveredDay) <= 1);
        });
        for (let w = Math.max(0, centerW - 5); w <= Math.min(weeks - 1, centerW + 5); w++) {
          for (let d = 0; d < 7; d++) {
            const cell = cellGrid.get(w + ':' + d);
            if (!cell) continue;
            const dx = svgX - Number(cell.dataset.waveX);
            const dy = svgY - Number(cell.dataset.waveY);
            const intensity = Math.max(0, 1 - Math.hypot(dx, dy) / (step * 4.2));
            const eased = intensity * intensity * (3 - 2 * intensity);
            if (eased < 0.015) continue;
            nextWaveCells.add(cell);
            cell.classList.add('is-wave');
            cell.style.setProperty('--wave-scale', (1 + eased * 0.055).toFixed(3));
            cell.style.setProperty('--wave-lift', (-eased * 1.8).toFixed(2) + 'px');
          }
        }
        activeWaveCells.forEach((cell) => {
          if (nextWaveCells.has(cell)) return;
          cell.style.removeProperty('--wave-scale');
          cell.style.removeProperty('--wave-lift');
          cell.classList.remove('is-wave');
        });
        activeWaveCells = nextWaveCells;
      } else {
        clearCadenceWave();
      }
    }
    function scheduleCadenceInteraction(event) {
      pointerEvent = event;
      if (!interactionFrame) interactionFrame = requestAnimationFrame(renderCadenceInteraction);
    }
    cadenceInteractionCleanup = function () {
      if (interactionFrame) cancelAnimationFrame(interactionFrame);
      interactionFrame = 0;
      pointerEvent = null;
      geometry = null;
      clearCadenceWave();
    };
    host.addEventListener('pointerenter', () => refreshCadenceGeometry());
    host.addEventListener('pointermove', (event) => {
      scheduleCadenceInteraction(event);
    });
    host.addEventListener('pointerleave', () => {
      if (interactionFrame) cancelAnimationFrame(interactionFrame);
      interactionFrame = 0;
      pointerEvent = null;
      geometry = null;
      clearCadenceWave();
    });
    if (wrap && tooltip) {
      wrap.addEventListener('scroll', () => { geometry = null; }, { passive: true });
      wrap.addEventListener('pointermove', (event) => {
        const cell = event.target.closest && event.target.closest('.cadence-cell');
        setCadenceMonthFocus(cell ? (cell.dataset.month || '') : '');
        if (!cell || !cell.dataset.tip) {
          tooltipCell = null;
          tooltip.classList.remove('is-visible');
          tooltip.setAttribute('aria-hidden', 'true');
          return;
        }
        const hostRect = geometry ? geometry.host : host.getBoundingClientRect();
        if (cell !== tooltipCell) {
          tooltipCell = cell;
          tooltip.textContent = cadenceLens === 'canvas' && cell.dataset.tipCanvas
            ? cell.dataset.tipCanvas
            : (cadenceLens === 'focus' && cell.dataset.tipFocus) ? cell.dataset.tipFocus : cell.dataset.tip;
          tooltip.classList.add('is-visible');
          tooltip.setAttribute('aria-hidden', 'false');
        }
        const maxLeft = hostRect.width - 154;
        tooltip.style.left = Math.max(8, Math.min(maxLeft, event.clientX - hostRect.left + 12)) + 'px';
        tooltip.style.top = Math.max(8, event.clientY - hostRect.top - 34) + 'px';
      });
      wrap.addEventListener('pointerleave', () => {
        clearCadenceWave();
        tooltipCell = null;
        setCadenceMonthFocus('');
        dayEls.forEach((label) => label.classList.remove('is-focused'));
        tooltip.classList.remove('is-visible');
        tooltip.setAttribute('aria-hidden', 'true');
      });
      wrap.addEventListener('click', (event) => {
        const cell = event.target.closest && event.target.closest('.cadence-cell');
        selectCadenceDay(cell, false);
      });
      wrap.addEventListener('keydown', (event) => {
        const cell = event.target.closest && event.target.closest('.cadence-cell');
        if (!cell) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectCadenceDay(cell, false);
          return;
        }
        const dayOffset = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
        if (!dayOffset) return;
        event.preventDefault();
        const date = new Date(cell.dataset.dayKey + 'T00:00:00');
        date.setDate(date.getDate() + dayOffset);
        const next = cells.find((candidate) => candidate.dataset.dayKey === localDay(date)
          && !candidate.classList.contains('is-future'));
        if (next) selectCadenceDay(next, true);
      });
    }
    host.querySelectorAll('[data-canvas-path]').forEach((button) => {
      button.addEventListener('click', () => window.gotoEditor(button.dataset.canvasPath, null, false));
    });
    const recentList = host.querySelector('.cadence-recent-list');
    if (recentList) {
      recentList.addEventListener('pointerover', (event) => {
        const item = event.target.closest && event.target.closest('.cadence-recent-item');
        if (!item) return;
        const group = item.closest('.cadence-recent-group');
        if (!group) return;
        recentList.classList.add('has-focus');
        recentList.querySelectorAll('.cadence-recent-group').forEach((candidate) => {
          candidate.classList.toggle('is-focused', candidate === group);
        });
      });
      recentList.addEventListener('pointerleave', () => {
        recentList.classList.remove('has-focus');
        recentList.querySelectorAll('.cadence-recent-group.is-focused').forEach((group) => {
          group.classList.remove('is-focused');
        });
      });
    }
  }

  function flipCadenceYearBy(delta) {
    const years = activityPayload && activityPayload.years || [];
    if (years.length < 2) return;
    let index = years.map(String).indexOf(String(cadenceYear));
    if (index < 0) index = 0;
    index = (index + delta) % years.length;
    if (index < 0) index += years.length;
    navigateCadenceYear(String(years[index]), delta > 0);
  }

  function navigateCadenceYear(nextYear, forwardHint) {
    const target = String(nextYear || '');
    if (!target || target === String(cadenceYear) || cadenceFlipping) return;
    const years = activityPayload && activityPayload.years || [];
    const fromYear = String(cadenceYear);
    const forward = typeof forwardHint === 'boolean'
      ? forwardHint
      : years.map(String).indexOf(target) >= years.map(String).indexOf(fromYear);
    const host = document.querySelector('[data-role="study-cadence"]');
    const page = host && host.querySelector('[data-role="cadence-year-page"]');
    cadenceFlipping = true;
    function loadNext() {
      queueActivityLoad(target, { incoming: forward ? 'r' : 'l', orbFromYear: fromYear }).then((loaded) => {
        if (!loaded && page) page.classList.remove('flip-out-l', 'flip-out-r');
        setTimeout(() => { cadenceFlipping = false; }, prefersReduced ? 0 : 240);
      });
    }
    if (prefersReduced || !page) {
      loadNext();
      return;
    }
    page.classList.add(forward ? 'flip-out-l' : 'flip-out-r');
    setTimeout(loadNext, 130);
  }

  async function loadActivity(year, options) {
    const seq = ++cadenceLoadSeq;
    try {
      const selected = year || cadenceYear;
      const json = await api('/api/study-activity' + (selected ? '?year=' + encodeURIComponent(selected) : ''));
      if (seq !== cadenceLoadSeq) return false;
      cadenceYear = String(json.year || '');
      activityPayload = json;
      activityDays = json.days || {};
      activityDirty = false;
      renderCadence(json, options);
      return true;
    } catch (e) {
      return false;   // 活跃图加载失败不打断学习页
    }
  }

  function queueActivityLoad(year, options) {
    const promise = loadActivity(year, options);
    activityLoadPromise = promise;
    promise.finally(() => {
      if (activityLoadPromise === promise) activityLoadPromise = null;
    }).catch(() => undefined);
    return promise;
  }

  function ensureActivityReady() {
    if (activityPayload && !activityDirty) return Promise.resolve(true);
    if (activityLoadPromise) return activityLoadPromise;
    return queueActivityLoad();
  }

  function cancelActivityPreload() {
    if (!activityPreloadHandle) return;
    if (activityPreloadUsesIdle && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(activityPreloadHandle);
    } else {
      window.clearTimeout(activityPreloadHandle);
    }
    activityPreloadHandle = 0;
    activityPreloadUsesIdle = false;
  }

  function scheduleActivityPreload() {
    if (window.RelatumFeatureRuntime?.preloadEnabled === false) return;
    if (activityPreloadHandle || activityLoadPromise || (activityPayload && !activityDirty)) return;
    const warmActivity = () => {
      activityPreloadHandle = 0;
      activityPreloadUsesIdle = false;
      ensureActivityReady().catch(() => undefined);
    };
    activityPreloadUsesIdle = typeof window.requestIdleCallback === 'function';
    activityPreloadHandle = activityPreloadUsesIdle
      ? window.requestIdleCallback(warmActivity, { timeout: 1500 })
      : window.setTimeout(warmActivity, 600);
  }

  function cancelCadenceVisibleSync() {
    if (!cadenceVisibleSyncFrame) return;
    window.cancelAnimationFrame(cadenceVisibleSyncFrame);
    cadenceVisibleSyncFrame = 0;
  }

  function syncCadenceVisibleLayout() {
    const host = document.querySelector('[data-role="study-cadence"]');
    if (!host || !host.childElementCount) return;
    const orb = host.querySelector('[data-role="cadence-year-orb"]');
    if (orb) orb.classList.add('no-transition');
    syncCadenceYearOrb(host);
    placeStarModeSlider(host.querySelector('[data-role="star-mode-switch"]'), false);
    if (orb) window.requestAnimationFrame(() => orb.classList.remove('no-transition'));
  }

  function scheduleCadenceVisibleActivation() {
    cancelCadenceVisibleSync();
    cadenceVisibleSyncFrame = window.requestAnimationFrame(() => {
      cadenceVisibleSyncFrame = window.requestAnimationFrame(() => {
        cadenceVisibleSyncFrame = 0;
        if (!cadenceShown) return;
        syncCadenceVisibleLayout();
        if (!starInstance && activityPayload) {
          const host = document.querySelector('[data-role="study-cadence"]');
          if (host) mountStarGraph(host, activityPayload);
        } else if (starInstance && starInstance.setActive) {
          starInstance.setActive(true);
          if (starInstance.replayIntro) starInstance.replayIntro();
        }
      });
    });
  }

  function invalidateActivity() {
    activityDirty = true;
    if (cadenceShown) queueActivityLoad();
  }

  function releaseStarGraph() {
    window.clearTimeout(starReleaseTimer);
    starReleaseTimer = 0;
    if (starInstance) { try { starInstance.destroy(); } catch (e) {} starInstance = null; }
  }

  // 「更新」按钮：强制重新统计活跃数据并重绘热力图。平时翻进活跃页用缓存，不重读。
  async function refreshCadence(btn) {
    if (btn) btn.classList.add('is-refreshing');
    try {
      const startPageActivity = window.RelatumStartPageActivity;
      if (startPageActivity && typeof startPageActivity.waitForIdle === 'function') {
        try { await startPageActivity.waitForIdle(); } catch (e) {}
      }
      activityDirty = true;
      await queueActivityLoad();
    } catch (e) {
      // 加载失败有各自兜底，这里只防 rejection 冒泡
    } finally {
      if (btn) btn.classList.remove('is-refreshing');
    }
  }

  // 暴露给起步页：速记归档后刷新一年活跃热力图 / 月统计 / 星图（数据已写进学习归档）。
  window.StudyActivity = {
    reload() { invalidateActivity(); },
    // 起步页翻页时调用：只有活跃页是当前前置页时星图才跑 RAF，离开即挂起，避免隐藏页 60fps 空转。
    setActive(active) {
      cadenceShown = !!active && document.body.dataset.startWorkspace === 'canvas';
      window.clearTimeout(starReleaseTimer);
      starReleaseTimer = 0;
      if (!cadenceShown) {
        cancelCadenceVisibleSync();
        if (starInstance && starInstance.setActive) starInstance.setActive(false);
        // 外层翻页保留最后一帧，交接完成才释放；快速返回会取消释放任务。
        if (starInstance) {
          const turnMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--start-turn-ms')) || 260;
          starReleaseTimer = window.setTimeout(() => {
            if (!cadenceShown) releaseStarGraph();
          }, prefersReduced ? 0 : Math.max(800, turnMs + 560));
        }
        return;
      }
      cancelActivityPreload();
      // 预渲染发生在 content-visibility:hidden 下；待外层页面真正可见两帧后，再校准书脊/滑块并唤醒星图。
      scheduleCadenceVisibleActivation();
      if (!activityPayload || activityDirty) ensureActivityReady().catch(() => undefined);
    },
    awaitReady() {
      return ensureActivityReady();
    },
    isReady() {
      return !!(activityPayload && !activityDirty);
    },
    finalizeExitMotion() {
      if (!cadenceShown && !document.querySelector('.cadence-embedded.view-leaving')) releaseStarGraph();
    },
  };
  scheduleActivityPreload();

  window.addEventListener('canvas:starmap-motion-change', () => {
    if (!activityPayload) return;
    const host = document.querySelector('[data-role="study-cadence"]');
    if (host) mountStarGraph(host, activityPayload, { intro: true });
  });
  document.addEventListener('relatum:languagechange', () => {
    if (!activityPayload) return;
    const host = document.querySelector('[data-role="study-cadence"]');
    if (host) renderCadence(activityPayload, { intro: false });
  });
  document.addEventListener('relatum:start-workspacechange', () => {
    window.StudyActivity.setActive(document.querySelector('.book-view')?.dataset.viewName === 'cadence');
  });
  window.addEventListener('pagehide', () => {
    cadenceShown = false;
    cancelActivityPreload();
    cancelCadenceVisibleSync();
    releaseStarGraph();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) window.StudyActivity.setActive(document.querySelector('.book-view')?.dataset.viewName === 'cadence');
  });
})();
