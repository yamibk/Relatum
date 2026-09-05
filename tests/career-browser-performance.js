'use strict';

// Optional acceptance tool; the host supplies Playwright, never the application.
// Every API request goes to a disposable data root or a deterministic report fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

function fixture() {
  const months = Array.from({ length: 24 }, (_, i) => ({ month: `${2024 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`,
    activeDays: 12 + i % 18, canvasSec: 25000 + i * 2345, study: i + 2, quick: i % 4, taskbook: i % 3, canvas: i % 2 }));
  const days = Array.from({ length: 365 }, (_, i) => ({ day: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    canvasSec: i % 5 ? 600 + i * 13 : 0, focusSec: i % 7 * 1800, pageSec: i % 9 * 120, events: i % 3 }));
  const top = Array.from({ length: 12 }, (_, i) => ({ title: `记录 ${i + 1} / Notes`, seconds: 350000 - i * 19000, words: 45000 - i * 1700 }));
  return { version: 1, generatedAt: '2026-09-05T12:00:00', period: { firstDay: '2024-01-01' },
    overview: { activeDays: 514, longestStreak: 38, noteWords: 1255981, archiveCount: 386, canvasSec: 1582400, pageSec: 184500 },
    activity: { days, months, weekdays: Array.from({ length: 7 }, (_, weekday) => ({ weekday, activeDays: 40 + weekday * 9 })) },
    canvases: { count: 120, nodeCount: 15480, edgeCount: 8400, inkCount: 550, spanCount: 1500, top,
      kinds: ['card', 'preview', 'index', 'sticky', 'code', 'table', 'image', 'attachment'].map((key, i) => ({ key, count: 3000 - i * 350 })),
      months: months.map(m => ({ month: m.month, items: top.slice(0, 8) })) },
    notes: { count: 480, wordCount: 1255981, folderCount: 36, linkCount: 1850, orphanCount: 40, top,
      lengthBuckets: { long: 120, medium: 260, short: 100 }, inferredModifiedMonths: months.map(m => ({ month: m.month, count: 20 })),
      network: { nodes: Array.from({ length: 48 }, (_, i) => ({ id: `n${i}`, title: `Note ${i}`, words: 5000, degree: i % 6 + 1 })),
        edges: Array.from({ length: 120 }, (_, i) => ({ from: `n${i % 48}`, to: `n${(i * 7 + 1) % 48}` })) } },
    learning: { activeTasks: 120, goalTreeCount: 8, treeTasks: 200, pageSeconds: { study: 90000, tree: 68000, notes: 26000 },
      archives: { months, recent: days.slice(-12).map(d => ({ day: d.day, kind: 'study', title: '完成记录' })) } },
    habits: { daily: { days: days.filter((_, i) => i % 3).map(d => d.day), checkinCount: 244 },
      diaries: { days: days.filter((_, i) => i % 5 === 0).map(d => d.day), count: 73 } },
    coverage: ['canvases', 'canvasActivity', 'pageActivity', 'notes', 'study', 'tree', 'review', 'focus', 'daily', 'diary', 'archives']
      .map(id => ({ id, status: 'available' })) };
}

function installProbe() {
  localStorage.setItem('canvas:startWorkspace:v1', 'career');
  localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
  window.__careerProbe = { active: false, reads: {}, mutations: 0, frames: [], longTasks: [], maxAnimations: 0 };
  for (const key of ['scrollHeight', 'clientHeight', 'scrollTop']) {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, key);
    Object.defineProperty(Element.prototype, key, { ...original, get() {
      if (__careerProbe.active && this.matches?.('.career-scroll')) __careerProbe.reads[key] = (__careerProbe.reads[key] || 0) + 1;
      return original.get.call(this);
    } });
  }
  new PerformanceObserver(list => {
    if (__careerProbe.active) __careerProbe.longTasks.push(...list.getEntries().map(e => e.duration));
  }).observe({ type: 'longtask' });
  window.__careerSample = async function (duration = 13000) {
    const scroll = document.querySelector('.career-scroll');
    const probe = __careerProbe;
    probe.active = true;
    const observer = new MutationObserver(records => { probe.mutations += records.filter(r => r.target.closest?.('[data-career-number]')).length; });
    observer.observe(scroll, { childList: true, subtree: true });
    const start = performance.now();
    let last = 0, inputAt = 0;
    await new Promise(resolve => requestAnimationFrame(function frame(now) {
      if (last) probe.frames.push(now - last);
      last = now;
      if (now - inputAt > 100) {
        const event = new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true });
        Object.defineProperty(event, 'wheelDeltaY', { value: -120 });
        scroll.dispatchEvent(event);
        inputAt = now;
      }
      if (now - start < duration) requestAnimationFrame(frame);
      else resolve();
    }));
    probe.active = false;
    observer.disconnect();
    const frames = probe.frames.sort((a, b) => a - b);
    return { frames: frames.length, p95: frames[Math.ceil(frames.length * .95) - 1], max: frames.at(-1),
      over25: frames.filter(n => n > 25).length, longTasks: probe.longTasks,
      reads: probe.reads, numberReplacements: probe.mutations, top: scroll.scrollTop, height: scroll.scrollHeight };
  };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-career-perf-'));
  const output = path.resolve(process.argv[2] || path.join(dataRoot, 'report.json'));
  const mode = process.argv[3] || 'benchmark';
  const baseline = process.env.RELATUM_CAREER_BASELINE === '1';
  const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
  const port = await new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => { const port = reservation.address().port; reservation.close(() => resolve(port)); });
  });
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: root, env: { ...process.env, RELATUM_DATA_ROOT: dataRoot }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOutput = '';
  server.stdout.on('data', c => { serverOutput += c; });
  server.stderr.on('data', c => { serverOutput += c; });
  let browser;
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode != null) throw Error(serverOutput);
      let runtime;
      try { const response = await fetch(url + '/api/runtime'); if (response.ok) runtime = await response.json(); } catch {}
      if (runtime) {
        assert.equal(path.resolve(runtime.root).toLowerCase(), dataRoot.toLowerCase(), 'refuse to test against another data root');
        break;
      }
      await new Promise(r => setTimeout(r, 100));
      if (i === 99) throw Error('Server timeout: ' + serverOutput);
    }
    browser = await chromium.launch({ executablePath: process.env.RELATUM_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const baselineRef = process.env.RELATUM_CAREER_BASE_REF || 'HEAD';
    const results = { baseline, baselineRef: baseline ? baselineRef : null, browser: browser.version(), viewport: '1440x900', dpr: Number(process.env.RELATUM_CAREER_DPR || 1),
      cpuSlowdown: Number(process.env.RELATUM_CAREER_CPU || 1), dataRoot, runs: [] };
    for (let round = 0; round < Number(process.env.RELATUM_CAREER_ROUNDS || 3); round++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: results.dpr });
      await context.addInitScript(installProbe);
      await context.route('**/api/career-report', route => route.fulfill({ json: { version: 1, exists: true, report: fixture() } }));
      if (baseline) {
        for (const name of ['career-report.js', 'styles.css']) {
          const body = execFileSync('git', ['show', `${baselineRef}:assets/${name}`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
          await context.route(`**/${name}`, route => route.fulfill({ body, contentType: name.endsWith('css') ? 'text/css' : 'application/javascript' }));
        }
      }
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(url);
      await page.waitForFunction(() => window.RelatumCareerReport?.report && document.querySelector('.career-hero-metrics[data-visible="1"]'));
      await page.waitForTimeout(1900);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      if (process.env.RELATUM_CAREER_CPU) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.RELATUM_CAREER_CPU) });
      if (process.env.RELATUM_CAREER_TRACE) await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' });
      const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      const sample = await page.evaluate(duration => __careerSample(duration), process.env.RELATUM_CAREER_SKIP_BENCHMARK ? 100 : 13000);
      const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      sample.work = Object.fromEntries(['LayoutCount', 'LayoutDuration', 'RecalcStyleCount', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'].map(k => [k, after[k] - before[k]]));
      if (process.env.RELATUM_CAREER_TRACE) {
        const ended = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
        await cdp.send('Tracing.end');
        const { stream } = await ended;
        let json = '';
        for (;;) { const chunk = await cdp.send('IO.read', { handle: stream }); json += chunk.data; if (chunk.eof) break; }
        await cdp.send('IO.close', { handle: stream });
        sample.trace = {};
        for (const event of JSON.parse(json).traceEvents) {
          if (!['Layout', 'UpdateLayoutTree', 'Paint', 'PrePaint', 'Layerize', 'RasterTask'].includes(event.name) || event.ph !== 'X') continue;
          const stat = sample.trace[event.name] ||= { count: 0, ms: 0 };
          stat.count++; stat.ms += (event.dur || 0) / 1000;
        }
        fs.writeFileSync(path.join(dataRoot, `trace-${round}.json`), json);
      }
      assert.deepEqual(errors, []);
      results.runs.push(sample);
      console.log(JSON.stringify({ round, baseline, ...sample }));
      if (mode === 'regression' && round === 0) await regression(page, context, results, dataRoot);
      assert.deepEqual(errors, []);
      await context.close();
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(results, null, 2));
    console.log(output);
  } finally {
    if (browser) await browser.close();
    server.kill();
    await new Promise(resolve => { if (server.exitCode != null) resolve(); else server.once('exit', resolve); });
  }
}

async function regression(page, context, results, dataRoot) {
  const checks = [];
  const check = (name, value) => { assert(value, name); checks.push(name); };
  await page.route('**/api/career-report-generate', route => route.fulfill({ json: { version: 1, exists: true, report: fixture() } }));
  const fresh = async () => {
    await page.evaluate(async () => {
      await RelatumCareerReport.generate();
      document.querySelector('.career-scroll').scrollTo({ top: 0, behavior: 'instant' });
    });
    await page.waitForTimeout(160);
  };
  const top = () => page.evaluate(() => document.querySelector('.career-scroll').scrollTop);
  const wheel = (options = {}) => page.evaluate(options => {
    const event = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true, ...options });
    if (!options.precise) Object.defineProperty(event, 'wheelDeltaY', { value: -120 });
    document.querySelector('.career-scroll').dispatchEvent(event);
    return event.defaultPrevented;
  }, options);
  const jump = async (selector, index = 0) => {
    await page.evaluate(([selector, index]) => {
      const scroll = document.querySelector('.career-scroll');
      const node = document.querySelectorAll(selector)[index];
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 100;
    }, [selector, index]);
  };
  await fresh();
  await jump('.career-bars');
  const stable = await page.evaluate(async () => {
    const scroll = document.querySelector('.career-scroll');
    const track = document.querySelector('.career-bar-track');
    const widths = [], heights = [];
    for (let i = 0; i < 80; i++) {
      await new Promise(requestAnimationFrame);
      widths.push(track.getBoundingClientRect().width);
      heights.push(scroll.scrollHeight);
    }
    return { widthChange: Math.max(...widths) - Math.min(...widths), heightChange: Math.max(...heights) - Math.min(...heights) };
  });
  check('counting keeps bar width and document height stable', stable.widthChange < .1 && stable.heightChange === 0);

  await fresh();
  await page.waitForTimeout(1700);
  await page.screenshot({ path: path.join(dataRoot, 'career-hero.png') });
  await jump('.career-dot-matrix');
  await page.waitForTimeout(2200);
  await page.screenshot({ path: path.join(dataRoot, 'career-charts.png') });
  check('dot reveal uses at most one transition per four marks', await page.evaluate(() => {
    const matrix = document.querySelector('.career-dot-matrix');
    return matrix.querySelectorAll('.career-dot-band').length === Math.ceil(matrix.querySelectorAll('.career-dot').length / 4);
  }));
  await jump('.career-line-point');
  await page.waitForTimeout(2100);
  await page.locator('.career-line-point').first().hover();
  check('chart tooltip remains available at rest', await page.locator('.career-chart-tooltip.visible').count() === 1);
  const nativeTop = await top();
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(180);
  check('real browser wheel moves the report and hides the tooltip', await top() > nativeTop && await page.locator('.career-chart-tooltip.visible').count() === 0);
  await fresh();
  await jump('.career-dot-matrix');
  await page.waitForTimeout(240);
  await jump('.career-report-end');
  await page.waitForTimeout(150);
  check('departed charts stop their transitions and number jobs', await page.evaluate(() => {
    const panel = document.querySelector('.career-dot-matrix').closest('.career-panel');
    return !panel.getAnimations({ subtree: true }).some(a => a.playState === 'running') && !panel.querySelector('.is-counting');
  }));

  await fresh();
  check('coarse wheel uses inertia', await wheel());
  await page.waitForTimeout(80);
  check('precise wheel stays native', !(await wheel({ deltaY: 2.5, precise: true })));
  const precisionTop = await top();
  await page.waitForTimeout(200);
  check('precise input cancels the old wheel tail', (await top()) === precisionTop);
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { deltaX: 180, deltaY: 40 }]) {
    check('zoom/horizontal gesture stays native ' + JSON.stringify(options), !(await wheel(options)));
  }
  for (const type of ['pointerdown', 'keydown']) {
    await wheel();
    await page.waitForTimeout(60);
    await page.evaluate(type => {
      const scroll = document.querySelector('.career-scroll');
      scroll.dispatchEvent(type === 'keydown' ? new KeyboardEvent(type, { key: 'Home', bubbles: true }) : new PointerEvent(type, { bubbles: true }));
    }, type);
    const stopped = await top();
    await page.waitForTimeout(180);
    check(type + ' takes ownership of scrolling', stopped === await top());
  }
  await page.setViewportSize({ width: 720, height: 760 });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const s = document.querySelector('.career-scroll');
    s.scrollTop = s.scrollHeight - s.clientHeight - 60;
  });
  await wheel();
  await page.waitForTimeout(600);
  check('resizing refreshes the bottom boundary', await page.evaluate(() => {
    const s = document.querySelector('.career-scroll');
    return Math.abs(s.scrollTop - (s.scrollHeight - s.clientHeight)) <= 1;
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await fresh();
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('relatum:career-scroll-feel', { detail: { inertia: 0, pauseReveal: true } }));
    document.dispatchEvent(new CustomEvent('relatum:career-scroll-idle', { detail: { ms: 160 } }));
    const s = document.querySelector('.career-scroll');
    const target = document.querySelectorAll('.career-panel')[8];
    window.__skipTarget = document.querySelectorAll('.career-panel')[3];
    s.scrollTop += target.getBoundingClientRect().top - s.getBoundingClientRect().top - 90;
    s.dispatchEvent(new Event('scroll'));
    window.__pausedTarget = target;
  });
  await page.waitForTimeout(70);
  check('pause reveal waits for the selected idle window', await page.evaluate(() => __pausedTarget.dataset.visible !== '1'));
  await page.waitForTimeout(240);
  check('pause reveal resumes visible cards and skips passed chapters', await page.evaluate(() => __pausedTarget.dataset.visible === '1' && __skipTarget.dataset.visible !== '1'));

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  check('live reduced motion reveals all numbers and stops animations', await page.evaluate(() => {
    const report = document.querySelector('.career-report');
    return !report.querySelector('.career-reveal:not([data-visible="1"])') && !report.querySelector('.is-counting')
      && !report.getAnimations({ subtree: true }).some(a => a.playState === 'running');
  }));
  check('reduced motion wheel stays native', !(await wheel()));
  const values = await page.evaluate(() => Array.from(document.querySelectorAll('[data-career-number]'), node => {
    const value = Number(node.dataset.careerNumber), suffix = node.dataset.careerSuffix;
    let expected;
    if (!value && node.dataset.careerZeroText) expected = node.dataset.careerZeroText;
    else if (node.dataset.careerFormat === 'duration') {
      const minutes = Math.round(Math.round(value) / 60), hours = Math.floor(minutes / 60);
      expected = hours ? `${hours} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
    } else expected = Math.round(value).toLocaleString('zh-CN') + suffix;
    return { actual: node.querySelector('.career-number-value').textContent, expected };
  }));
  assert.deepEqual(values.map(v => v.actual), values.map(v => v.expected));
  checks.push('all final statistics match the frozen values');
  await page.evaluate(() => RelatumI18n.setLanguage('en'));
  await page.waitForTimeout(100);
  check('language repaint is complete and preserves item names', await page.evaluate(() =>
    document.querySelector('.career-hero h1').textContent === 'Usage report'
    && document.querySelector('.career-bar-label').textContent === '记录 1 / Notes'));

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    RelatumI18n.setLanguage('zh-CN');
    document.dispatchEvent(new CustomEvent('relatum:career-scroll-feel', { detail: { inertia: 45, pauseReveal: false } }));
  });
  await fresh();
  await wheel();
  await page.waitForTimeout(80);
  await page.evaluate(() => document.querySelector('button[data-start-workspace="canvas"]').click());
  await page.waitForFunction(() => document.body.dataset.startWorkspace === 'canvas');
  const leftTop = await top();
  const leavingPositions = await page.evaluate(async () => {
    const values = [], s = document.querySelector('.career-scroll');
    for (let i = 0; i < 24; i++) {
      await new Promise(requestAnimationFrame);
      // display:none returns zero geometry; it is not a changed saved position.
      if (s.clientHeight) values.push(s.scrollTop);
    }
    return values;
  });
  check('leaving the workspace cancels inertia', leavingPositions.every(value => value === leftTop));
  check('leaving stops report animations', await page.evaluate(() => !document.querySelector('.career-report').getAnimations({ subtree: true }).some(a => a.playState === 'running')));
  await page.evaluate(() => document.querySelector('button[data-start-workspace="career"]').click());
  await page.waitForFunction(() => document.body.dataset.startWorkspace === 'career');
  await page.waitForTimeout(400);
  check('return keeps the report and scroll position', Math.abs(await top() - leftTop) < 1);

  await wheel();
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenTop = await top();
  await page.waitForTimeout(180);
  check('hidden page stops inertia and animations', await top() === hiddenTop && await page.evaluate(() => !document.querySelector('.career-report').getAnimations({ subtree: true }).some(a => a.playState === 'running')));
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });

  await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
  await jump('.career-dot-matrix');
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(dataRoot, 'career-dark.png') });
  await page.setViewportSize({ width: 560, height: 800 });
  await page.waitForTimeout(200);
  check('narrow report has no horizontal overflow', await page.evaluate(() => {
    const s = document.querySelector('.career-scroll');
    return getComputedStyle(s).overflowX === 'hidden' && document.documentElement.scrollWidth === innerWidth;
  }));
  await page.screenshot({ path: path.join(dataRoot, 'career-narrow.png') });
  await page.route('**/api/career-report-generate', route => route.fulfill({ status: 500, json: { error: 'Simulated generation failure' } }));
  const beforeFailure = await page.evaluate(() => JSON.stringify(RelatumCareerReport.report));
  await page.evaluate(() => RelatumCareerReport.generate());
  check('failed regeneration preserves the frozen report', await page.evaluate(() => JSON.stringify(RelatumCareerReport.report)) === beforeFailure);
  results.regression = checks;
  results.screenshots = ['career-hero.png', 'career-charts.png', 'career-dark.png', 'career-narrow.png'].map(name => path.join(dataRoot, name));
  console.log(JSON.stringify({ regression: checks }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
