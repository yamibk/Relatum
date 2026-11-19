const ENGINE_URL = new URL('./vendor/echarts/echarts.min.js', import.meta.url);
const ENGINE_VERSION = '6.1.0';
const themes = {
  light: { text: '#42453f', axis: '#666962', grid: '#e5e6df',
    colors: ['#476e62', '#a66043', '#61758f', '#9a793a', '#806887', '#567a85', '#a75c65', '#737b45'] },
  dark: { text: '#e5e7de', axis: '#b6b9af', grid: '#3a3f38',
    colors: ['#8abcaa', '#e49b78', '#97b1d5', '#d6b361', '#bd9bc7', '#83bbc7', '#df929d', '#b3be76'] },
};
const chartNames = {
  column: ['柱状图', 'Column chart'], bar: ['条形图', 'Bar chart'],
  line: ['折线图', 'Line chart'], doughnut: ['环形图', 'Doughnut chart'],
};
const metricNames = {
  count: ['记录数', 'Record count'], sum: ['合计', 'Sum'], avg: ['平均值', 'Average'],
  min: ['最小值', 'Minimum'], max: ['最大值', 'Maximum'],
};
const mounted = new WeakMap();
let engineLoad;

function loadEngine() {
  if (!engineLoad) {
    engineLoad = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ENGINE_URL.href;
      const timer = setTimeout(fail, 10000);
      function finish() {
        clearTimeout(timer);
        script.onload = script.onerror = null;
      }
      function fail() {
        finish();
        script.remove();
        reject(new Error('Unable to load the offline chart engine'));
      }
      script.onload = () => {
        if (window.echarts?.version !== ENGINE_VERSION) return fail();
        finish();
        resolve(window.echarts);
      };
      script.onerror = fail;
      document.head.append(script);
    }).catch(error => {
      engineLoad = null;
      throw error;
    });
  }
  return engineLoad;
}

function numberFormat(locale, precision) {
  const normal = new Intl.NumberFormat(locale, { maximumSignificantDigits: precision });
  const scientific = new Intl.NumberFormat(locale, { maximumSignificantDigits: precision, notation: 'scientific' });
  return value => {
    const magnitude = Math.abs(value);
    return (magnitude >= 1e7 || (magnitude && magnitude < 0.001) ? scientific : normal).format(value);
  };
}

function compactLabel(value) {
  let width = 0;
  let label = '';
  for (const character of value.trim().replace(/\s+/g, ' ')) {
    width += character.codePointAt(0) > 0xff ? 2 : 1;
    if (width > 18) return `${label}…`;
    label += character;
  }
  return label;
}

function chartOptions(model, { language = 'zh', dark = false }, document) {
  const { chart, fields, groups } = model;
  const group = fields.find(field => field.id === chart.groupBy);
  const metric = fields.find(field => field.id === chart.metric.column);
  const english = language.startsWith('en');
  const local = labels => labels[english ? 1 : 0];
  const locale = english ? 'en' : 'zh-CN';
  const theme = dark ? themes.dark : themes.light;
  const metricText = local(metricNames[chart.metric.op]);
  const seriesName = metric ? `${metric.name} · ${metricText}` : metricText;
  const dateFormat = new Intl.DateTimeFormat(locale, chart.bucket === 'month'
    ? { timeZone: 'UTC', year: 'numeric', month: 'short' }
    : { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
  const dateTime = key => Date.parse(`${key}T00:00:00Z`);
  const label = point => {
    if (group.type === 'date') return dateFormat.format(dateTime(point.key));
    if (group.type === 'checkbox') return point.key === '1'
      ? local(['已勾选', 'Checked']) : local(['未勾选', 'Unchecked']);
    return point.label;
  };
  const labels = groups.map(label);
  const displayNumber = numberFormat(locale, 12);
  const axisNumber = numberFormat(locale, 5);
  const magnitude = Math.max(...groups.map(point => Math.abs(point.value)));
  // Keep the plot range and the sum of pie slices finite at binary64 extremes.
  const exponent = magnitude && (magnitude < 1e-9 || magnitude >= 1e12)
    ? Math.max(-308, Math.floor(Math.log10(magnitude))) : 0;
  const scale = 10 ** exponent;
  const values = groups.map(point => point.value === null ? null : point.value / scale);
  const tooltip = {
    trigger: chart.type === 'line' ? 'axis' : 'item', confine: true, renderMode: 'html', transitionDuration: 0,
    backgroundColor: dark ? '#292e29' : '#fff', borderColor: theme.grid, textStyle: { color: theme.text },
    formatter(params) {
      const dataIndex = (Array.isArray(params) ? params[0] : params)?.dataIndex;
      const node = document.createElement('div');
      node.style.cssText = 'max-width:240px;white-space:normal;overflow-wrap:anywhere';
      const point = groups[dataIndex];
      if (point?.value != null) node.textContent = `${labels[dataIndex]} · ${seriesName} ${displayNumber(point.value)}`;
      return node;
    },
  };
  const options = {
    animation: false, useUTC: true, color: theme.colors, textStyle: { color: theme.text }, tooltip,
    aria: { enabled: true, label: { description: `${local(chartNames[chart.type])} · ${group.name} · ${seriesName}` } },
  };
  if (chart.type === 'doughnut') {
    return { ...options,
      legend: { type: 'scroll', bottom: 4, textStyle: { color: theme.text, width: 110, overflow: 'truncate' },
        pageTextStyle: { color: theme.text }, pageIconColor: theme.axis, pageIconInactiveColor: theme.grid,
        selectedMode: false, formatter: compactLabel },
      series: [{ type: 'pie', name: seriesName, radius: ['46%', '72%'], center: ['50%', '46%'],
        label: { show: false }, emphasis: { scale: false },
        data: labels.map((name, index) => ({ name, value: values[index] })) }],
    };
  }

  const categoryAxis = { type: 'category', data: labels,
    axisLabel: { color: theme.axis, width: 112, overflow: 'truncate', hideOverlap: true, formatter: compactLabel },
    axisLine: { lineStyle: { color: theme.grid } }, axisTick: { show: false } };
  const valueAxis = { type: 'value', minInterval: chart.metric.op === 'count' ? 1 : undefined,
    axisLabel: { color: theme.axis, hideOverlap: true, formatter: value => {
      const unscaled = value * scale;
      return Number.isFinite(unscaled) ? axisNumber(unscaled) : `${axisNumber(value)}e${exponent}`;
    } },
    splitLine: { lineStyle: { color: theme.grid, type: 'dashed' } },
  };
  const grid = { top: 18, right: 22, bottom: 28, left: 18 };
  if (chart.type === 'line') {
    return { ...options, grid, xAxis: { type: 'time', minInterval: 86400000, axisTick: { show: false },
      axisLabel: { color: theme.axis, hideOverlap: true, formatter: value => dateFormat.format(value) },
      axisLine: { lineStyle: { color: theme.grid } } }, yAxis: valueAxis,
      series: [{ type: 'line', name: seriesName, data: groups.map((point, index) => [dateTime(point.key), values[index]]),
        connectNulls: false, showSymbol: groups.length <= 60, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2 } }],
    };
  }
  const horizontal = chart.type === 'bar';
  return { ...options, grid, xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series: [{ type: 'bar', name: seriesName, data: values, barMaxWidth: 38, itemStyle: { borderRadius: 3 } }],
  };
}

// The host owns visibility and sizing. A dedicated, measurable container can be
// updated or resized explicitly, and disposal invalidates any pending load.
export function mount(container, model, appearance = {}) {
  mounted.get(container)?.dispose();
  const originalLabel = container.getAttribute('aria-label');
  let instance, disposed = false, generation = 0, painted = -1;
  const measurable = () => container.isConnected && container.clientWidth > 0 && container.clientHeight > 0;

  function clear() {
    if (!instance) return;
    instance.dispose();
    instance = null;
    if (originalLabel === null) container.removeAttribute('aria-label');
    else container.setAttribute('aria-label', originalLabel);
  }

  async function update(next, look = appearance) {
    if (disposed) return false;
    model = next;
    appearance = look;
    const current = ++generation;
    if (!model?.chart || !model.groups.some(point => Number.isFinite(point.value))) {
      clear();
      return false;
    }
    if (!measurable()) return false;
    try {
      const engine = await loadEngine();
      if (disposed || current !== generation || !measurable()) return false;
      instance?.resize({ silent: true });
      instance ??= engine.init(container, null, { renderer: 'svg' });
      instance.setOption(chartOptions(model, appearance, container.ownerDocument), { notMerge: true });
      painted = current;
      return true;
    } catch (error) {
      if (disposed || current !== generation) return false;
      clear();
      throw error;
    }
  }

  const controller = {
    update,
    async resize() {
      if (disposed || !measurable()) return false;
      if (!instance || painted !== generation) return update(model);
      instance.resize({ silent: true });
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      mounted.delete(container);
    },
  };
  mounted.set(container, controller);
  controller.ready = update(model);
  return controller;
}
