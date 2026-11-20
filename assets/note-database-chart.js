const ENGINE_URL = new URL('./vendor/echarts/echarts.min.js', import.meta.url);
const ENGINE_VERSION = '6.1.0';
const themes = {
  light: { text: '#42453f', axis: '#666962', grid: '#e5e6df' },
  dark: { text: '#e5e7de', axis: '#b6b9af', grid: '#3a3f38' },
};
const chartNames = {
  column: ['柱状图', 'Column chart'], bar: ['条形图', 'Bar chart'],
  line: ['折线图', 'Line chart'], doughnut: ['环形图', 'Doughnut chart'], number: ['数字卡', 'Number card'],
  histogram: ['直方图', 'Histogram'], scatter: ['散点图', 'Scatter plot'],
};
const metricNames = {
  count: ['记录数', 'Record count'], sum: ['合计', 'Sum'], avg: ['平均值', 'Average'],
  min: ['最小值', 'Minimum'], max: ['最大值', 'Maximum'], checkedRate: ['勾选数 / 总记录数', 'Checked rows / total rows'],
  value: ['原值', 'Value'],
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

function displayFormat(locale, format, precision) {
  const base = numberFormat(locale, precision);
  if (!format) return base;
  const { percent, unit, decimals } = format;
  const opts = percent ? { style: 'percent' } : {};
  if (decimals != null) opts.minimumFractionDigits = opts.maximumFractionDigits = decimals;
  else opts.maximumSignificantDigits = precision;
  const formatter = new Intl.NumberFormat(locale, opts);
  return value => {
    const formatted = percent || (decimals != null && Math.abs(value) < 1e12) ? formatter.format(value) : base(value);
    return unit ? formatted + ' ' + unit : formatted;
  };
}

function hasData(model) {
  return model?.series
    ? model.series.some(series => Object.values(series.values).some(Number.isFinite))
    : model?.groups.some(point => Number.isFinite(point.value));
}

function scaleExponent(magnitude) {
  if (magnitude && (magnitude < 1e-9 || magnitude >= 1e12)) return Math.max(-308, Math.floor(Math.log10(magnitude)));
  return 0;
}

function scatterOptions({ groups }, appearance) {
  const { group, metric, locale, theme, color, english, document } = appearance;
  const exponent = key => scaleExponent(groups.reduce((max, point) => Math.max(max, Math.abs(point[key])), 0));
  const xPower = exponent('x'), yPower = exponent('value');
  const xScale = 10 ** xPower, yScale = 10 ** yPower;
  const xFormat = displayFormat(locale, group.numberFormat, 8), yFormat = displayFormat(locale, metric.numberFormat, 8);
  const axis = (field, format, scale, power) => ({
    type: 'value', scale: true, name: compactLabel(field.name, 18), nameLocation: 'middle', nameGap: 28,
    nameTextStyle: { color: theme.axis }, axisLabel: { color: theme.axis, hideOverlap: true, formatter: value => {
      const original = value * scale;
      return Number.isFinite(original) ? format(original) : `${value}e${power}`;
    } },
    splitLine: { lineStyle: { color: theme.grid, type: 'dashed' } },
  });
  return {
    animation: false, grid: { top: 16, right: 26, bottom: 48, left: 18 },
    aria: { enabled: true, label: { description: `${chartNames.scatter[english ? 1 : 0]} · ${group.name} / ${metric.name}` } },
    xAxis: axis(group, xFormat, xScale, xPower), yAxis: { ...axis(metric, yFormat, yScale, yPower), nameLocation: 'end', nameGap: 4 },
    tooltip: { trigger: 'item', confine: true, renderMode: 'html', transitionDuration: 0,
      formatter({ dataIndex }) {
        const node = document.createElement('div');
        const point = groups[dataIndex];
        if (point) node.textContent = `${group.name} ${xFormat(point.x)} · ${metric.name} ${yFormat(point.value)}`;
        return node;
      } },
    series: [{ type: 'scatter', name: metric.name, data: groups.map(point => [point.x / xScale, point.value / yScale]),
      symbolSize: groups.length > 200 ? 4 : 7, itemStyle: { color, opacity: .75 } }],
  };
}

function compactLabel(value, limit = 18) {
  let width = 0;
  let label = '';
  for (const character of value.trim().replace(/\s+/g, ' ')) {
    width += character.codePointAt(0) > 0xff ? 2 : 1;
    if (width > limit) return `${label}…`;
    label += character;
  }
  return label;
}

function chartOptions(model, { language = 'zh', dark = false, palette, primary, categories = {} }, document) {
  const { chart, fields, groups, series } = model;
  const group = fields.find(field => field.id === chart.groupBy);
  const metric = fields.find(field => field.id === chart.metric.column);
  const english = language.startsWith('en');
  const local = labels => labels[english ? 1 : 0];
  const locale = english ? 'en' : 'zh-CN';
  const theme = dark ? themes.dark : themes.light;
  const palettes = window.RelatumNoteChartPalette;
  const preset = palettes.effective(palette);
  const colors = palettes.colors(preset, dark);
  colors[0] = palettes.swatchColor(primary, dark) || colors[0];
  const metricText = local(metricNames[chart.metric.op]);
  const seriesName = metric ? `${metric.name} · ${metricText}` : metricText;
  const format = chart.metric.op === 'checkedRate' ? { percent: true, decimals: 1 } : metric?.numberFormat;
  const displayNumber = displayFormat(locale, format, 12);
  const axisNumber = displayFormat(locale, format, 5);
  if (chart.type === 'number') {
    const text = displayNumber(groups[0].value);
    return {
      animation: false,
      title: { text, subtext: seriesName, left: 'center', top: 'middle', itemGap: 4, triggerEvent: true,
        textStyle: { color: colors[0], fontSize: 25, width: 210, overflow: 'truncate' },
        subtextStyle: { color: theme.axis, fontSize: 12, width: 210, overflow: 'truncate' } },
      aria: { enabled: true, label: { description: `${seriesName} · ${text}` } },
    };
  }
  if (chart.type === 'scatter') return scatterOptions(model, { group, metric, locale, theme, color: colors[0], english, document });
  const histogram = chart.type === 'histogram';
  const formatBoundary = histogram ? displayFormat(locale, group.numberFormat && { ...group.numberFormat, decimals: undefined }, 8) : null;
  const dateFormat = group.type === 'date' ? palettes.dateFormatter(chart.bucket, english) : null;
  const dateTime = key => Date.parse(`${key}T00:00:00Z`);
  const label = point => {
    if (histogram) {
      const lower = formatBoundary(point.lower), upper = formatBoundary(point.upper);
      return point.lower === point.upper ? lower : `${lower} – ${upper}`;
    }
    if (group.type === 'date') return dateFormat.format(dateTime(point.key));
    return palettes.categoryLabel(point, group.type, english);
  };
  const labels = groups.map(label);
  let magnitude = 0;
  const seriesValues = series ? series.flatMap(item => Object.values(item.values)) : groups.map(point => point.value);
  for (const value of seriesValues) magnitude = Math.max(magnitude, Math.abs(value));
  // Keep the plot range and the sum of pie slices finite at binary64 extremes.
  const exponent = scaleExponent(magnitude);
  const scale = 10 ** exponent;
  const values = groups.map(point => point.value === null ? null : point.value / scale);
  const total = chart.type === 'doughnut' && ['count', 'sum'].includes(chart.metric.op)
    ? values.reduce((sum, value) => sum + (value ?? 0), 0) : 0;
  const formatPercent = total > 0 ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }) : null;
  const percent = index => formatPercent && Number.isFinite(values[index]) ? formatPercent.format(values[index] / total) : '';
  const splitField = fields.find(field => field.id === chart.seriesBy);
  const splitSeriesLabel = item => splitField ? palettes.categoryLabel(item, splitField.type, english) : item.label;
  const seriesValue = (item, point) => Object.hasOwn(item.values, point.key) ? item.values[point.key]
    : chart.metric.op === 'count' ? 0 : null;
  const pointAt = params => {
    const point = groups[params.dataIndex];
    const item = series?.[params.seriesIndex];
    if (!point || (series && !item)) return null;
    const value = item ? seriesValue(item, point) : point.value;
    const name = item ? splitSeriesLabel(item) : seriesName;
    return { point, name, value };
  };
  const tooltip = {
    trigger: chart.type === 'line' ? 'axis' : 'item', confine: true, renderMode: 'html', transitionDuration: 0,
    backgroundColor: dark ? '#292e29' : '#fff', borderColor: theme.grid, textStyle: { color: theme.text },
    formatter(params) {
      const node = document.createElement('div');
      node.style.cssText = 'max-width:240px;white-space:normal;overflow-wrap:anywhere';
      const rows = Array.isArray(params) ? params : [params];
      if (rows.length > 1) node.append(document.createTextNode(labels[rows[0].dataIndex]));
      for (const row of rows) {
        const point = pointAt(row);
        if (point?.value == null) continue;
        const share = percent(row.dataIndex);
        const entry = document.createElement('div');
        entry.textContent = `${rows.length === 1 ? labels[row.dataIndex] + ' · ' : ''}${point.name} ${displayNumber(point.value)}${share ? ` · ${share}` : ''}`;
        node.append(entry);
      }
      return node;
    },
  };
  const options = {
    animation: false, useUTC: true, color: colors, textStyle: { color: theme.text }, tooltip,
    aria: { enabled: true, label: { description: `${local(chartNames[chart.type])} · ${group.name} · ${seriesName}` } },
  };
  if (chart.type === 'doughnut') {
    const nameIndex = new Map(labels.map((name, index) => [name, index]));
    let title;
    if (formatPercent) {
      const unscaled = total * scale;
      let displayed;
      if (Number.isFinite(unscaled)) displayed = displayFormat(locale, format, 7)(unscaled);
      else {
        const [coefficient, power] = total.toExponential(5).split('e');
        displayed = `${numberFormat(locale, 6)(Number(coefficient))}E${Number(power) + exponent}`;
      }
      const caption = local(group.type === 'multiSelect' ? ['标签合计', 'Tag total'] : ['总计', 'Total']);
      options.aria.label.description += ` · ${caption} ${displayed}`;
      title = { text: displayed, subtext: caption, left: 'center', top: '38%', padding: 0, itemGap: 3,
        textStyle: { color: theme.text, fontSize: 16, fontWeight: 600 }, subtextStyle: { color: theme.axis, fontSize: 11 } };
    }
    return { ...options,
      title,
      legend: { type: 'scroll', bottom: 4, textStyle: { color: theme.text, width: 125, overflow: 'truncate' },
        pageTextStyle: { color: theme.text }, pageIconColor: theme.axis, pageIconInactiveColor: theme.grid,
        selectedMode: false, formatter: name => {
          const share = percent(nameIndex.get(name));
          return share ? `${compactLabel(name, 12)} ${share}` : compactLabel(name);
        } },
      series: [{ type: 'pie', name: seriesName, radius: ['46%', '72%'], center: ['50%', '46%'],
        label: { show: false }, emphasis: { scale: false },
        data: labels.map((name, index) => {
          const point = groups[index];
          const color = palettes.categoryColor(preset, dark, chart.groupBy, point.key, categories[point.colorKey]);
          return { name, value: values[index], itemStyle: { color } };
        }) }],
    };
  }

  const categoryAxis = { type: 'category', data: labels,
    axisLabel: { color: theme.axis, width: 112, overflow: 'truncate', hideOverlap: true, formatter: value => compactLabel(value) },
    axisLine: { lineStyle: { color: theme.grid } }, axisTick: { show: false } };
  const valueAxis = { type: 'value', minInterval: chart.metric.op === 'count' ? 1 : undefined,
    axisLabel: { color: theme.axis, hideOverlap: true, formatter: value => {
      const unscaled = value * scale;
      return Number.isFinite(unscaled) ? axisNumber(unscaled) : `${axisNumber(value)}e${exponent}`;
    } },
    splitLine: { lineStyle: { color: theme.grid, type: 'dashed' } },
  };
  const grid = { top: 18, right: 22, bottom: series ? 54 : 28, left: 18 };
  if (series) {
    const names = series.map(splitSeriesLabel);
    options.legend = { type: 'scroll', bottom: 4, textStyle: { color: theme.text }, pageTextStyle: { color: theme.text },
      pageIconColor: theme.axis, pageIconInactiveColor: theme.grid, data: series.map(item => item.key),
      formatter: key => compactLabel(names[series.findIndex(item => item.key === key)] || key) };
    options.aria.label.description += ` · ${splitField ? splitField.name + ' · ' : ''}${names.join(', ')}`;
  }
  const splitData = (shape, build) => series.map((item, index) => {
    const color = palettes.swatchColor(categories[item.colorKey], dark) || colors[index % colors.length];
    return { type: shape, id: item.key, name: item.key, itemStyle: { color }, ...build(groups.map(point => {
      const raw = seriesValue(item, point);
      return raw === null ? null : raw / scale;
    })) };
  });
  if (chart.type === 'line') {
    const line = values => ({ data: groups.map((point, index) => [dateTime(point.key), values[index]]),
      connectNulls: false, showSymbol: groups.length * (series?.length || 1) <= 60,
      symbol: 'circle', symbolSize: 6, lineStyle: { width: 2 } });
    return { ...options, grid, xAxis: { type: 'time', minInterval: 86400000, axisTick: { show: false },
      axisLabel: { color: theme.axis, hideOverlap: true, formatter: value => dateFormat.format(value) },
      axisLine: { lineStyle: { color: theme.grid } } }, yAxis: valueAxis,
      series: series ? splitData('line', line) : [{ type: 'line', name: seriesName, ...line(values) }],
    };
  }
  const horizontal = chart.type === 'bar';
  const data = values.map((value, index) => {
    const color = palettes.swatchColor(categories[groups[index].colorKey], dark);
    return color ? { value, itemStyle: { color } } : value;
  });
  return { ...options, grid, xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series: series ? splitData('bar', values => ({ data: values, barMaxWidth: 38, stack: chart.stack ? 'categories' : undefined }))
      : [{ type: 'bar', name: seriesName, data, barMaxWidth: histogram ? undefined : 38,
        barCategoryGap: histogram ? '8%' : undefined, itemStyle: { borderRadius: histogram ? 0 : 3 } }],
  };
}

export async function renderPrintChart(model, appearance, width) {
  const engine = await loadEngine();
  const height = model.chart.type === 'number' ? 104 :
    model.chart.type === 'bar' ? Math.min(560, Math.max(300, 48 + model.groups.length * 18)) : 300;
  const container = document.createElement('div');
  const { aria, legend, tooltip, ...options } = chartOptions(model, appearance, document);
  const seriesField = model.fields.find(field => field.id === model.chart.seriesBy);
  const english = appearance.language?.startsWith('en');
  const instance = engine.init(container, null, { renderer: 'svg', width, height });
  try {
    instance.setOption(options);
    // Keep a detached vector copy before disposing the temporary renderer.
    const svg = container.querySelector('svg')?.cloneNode(true);
    if (!svg) throw new Error('Chart SVG unavailable');
    svg.removeAttribute('style');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('aria-hidden', 'true');
    return {
      svg,
      description: aria.label.description,
      legendItems: !legend ? [] : model.series ? options.series.map((series, index) => ({
        text: seriesField ? window.RelatumNoteChartPalette.categoryLabel(model.series[index], seriesField.type, english) :
          model.series[index].label,
        color: series.itemStyle.color,
      })) : options.series[0].data.map(point => ({ text: legend.formatter(point.name), color: point.itemStyle.color })),
    };
  } finally {
    instance.dispose();
  }
}

// The host owns visibility and sizing. A dedicated, measurable container can be
// updated or resized explicitly, and disposal invalidates any pending load.
export function mount(container, model, appearance = {}, onMark) {
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
    if (!model?.chart || !hasData(model)) {
      clear();
      return false;
    }
    if (!measurable()) return false;
    try {
      const engine = await loadEngine();
      if (disposed || current !== generation || !measurable()) return false;
      if (instance && (instance.getWidth() !== container.clientWidth || instance.getHeight() !== container.clientHeight)) {
        instance.resize({ silent: true });
      }
      if (!instance) {
        instance = engine.init(container, null, { renderer: 'svg' });
        if (onMark) instance.on('click', event => {
          if (model.chart.type === 'number' && event.componentType === 'title') {
            onMark({ key: '' });
            return;
          }
          if (event.componentType !== 'series' || !model.groups[event.dataIndex]) return;
          const point = model.groups[event.dataIndex];
          const series = model.series?.[event.seriesIndex];
          onMark({ key: point.key, series: series?.key, label: [point.label, series?.label].filter(Boolean).join(' · ') });
        });
      }
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
