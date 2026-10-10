'use strict';
// Real Edge/WebGL comparison in one page. No application server or user data.
// This isolates geometry/CPU upload cost; notebook title/whole-host tests are separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');

function installBenchmark() {
  window.runGraphCacheSample = async ({ count, cache, timeStyle, frames }) => {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:1200px;height:720px;';
    document.body.replaceChildren(canvas);
    const stats = { nodeStyles: 0, edgeStyles: 0, uploads: 0, uploadBytes: 0, draws: 0, drawCpuMs: 0 };
    let renderer;
    const make = GraphGL.create;
    GraphGL.create = element => {
      renderer = make(element);
      const upload = renderer.gl.bufferData.bind(renderer.gl), draw = renderer.draw;
      renderer.gl.bufferData = (target, data, usage) => {
        if (usage === renderer.gl.DYNAMIC_DRAW) { stats.uploads++; stats.uploadBytes += data.byteLength; }
        return upload(target, data, usage);
      };
      renderer.draw = (...args) => {
        const began = performance.now();
        draw(...args); stats.draws++; stats.drawCpuMs += performance.now() - began;
      };
      return renderer;
    };
    const engine = GraphEngine.create({ canvas, backend: 'webgl', cacheInstances: cache,
      nodeStyleTimeDependent: timeStyle,
      nodeStyle(node) {
        stats.nodeStyles++;
        return { r: 5, fill: [.31, .58, .44, 1], stroke: [1, 1, 1, .94], strokeW: 1.8,
          scale: timeStyle ? 1 + .04 * Math.sin(performance.now() * .0009) : 1 };
      },
      edgeStyle() { stats.edgeStyles++; return { color: [.11, .12, .13, .22], width: 1.2 }; },
    });
    GraphGL.create = make;
    if (engine?.backendKind !== 'webgl') throw new Error('real WebGL2 backend is required');
    const columns = Math.ceil(Math.sqrt(count * 1.6));
    engine.setData(Array.from({ length: count }, (_, i) => ({ id: String(i),
      x: 100 + i % columns * 24, y: 100 + Math.floor(i / columns) * 24, r: 5 })),
    Array.from({ length: count - 1 }, (_, i) => ({ source: i, target: i + 1 })));
    engine.requestRender();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (const key of Object.keys(stats)) stats[key] = 0;
    const longTasks = [];
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration });
    });
    observer.observe({ type: 'longtask', buffered: false });
    const interactionStart = performance.now();
    const scriptStarted = await window.graphInteractionScriptDuration();
    const intervals = [];
    let previous = 0;
    const event = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type,
      { pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y }));
    event('pointerdown', -100, -100);
    for (let i = 0; i < frames; i++) {
      await new Promise(resolve => requestAnimationFrame(time => {
        if (previous) intervals.push(time - previous);
        previous = time;
        event('pointermove', -100 + Math.sin(i * .05) * 60, -100 + Math.cos(i * .05) * 60);
        resolve();
      }));
    }
    event('pointerup', -100, -100);
    await new Promise(resolve => requestAnimationFrame(resolve));
    const interactionEnd = performance.now();
    const interactionScriptCpuMs = ((await window.graphInteractionScriptDuration()) - scriptStarted) * 1000;
    const active = { ...stats };
    await new Promise(resolve => setTimeout(resolve, 120));
    const idleDraws = stats.draws - active.draws;
    observer.disconnect();
    const interactionTasks = longTasks.filter(item => item.start >= interactionStart && item.start <= interactionEnd);
    const uploaded = { ...active };
    const glInfo = { version: renderer.gl.getParameter(renderer.gl.VERSION),
      renderer: renderer.gl.getParameter(renderer.gl.RENDERER) };
    engine.destroy();
    renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
    intervals.sort((a, b) => a - b);
    return { count, edges: count - 1, cache, timeStyle, frames: active.draws,
      frameIntervalP50Ms: intervals[Math.floor(intervals.length * .5)],
      frameIntervalP95Ms: intervals[Math.floor(intervals.length * .95)],
      idleDraws, ...uploaded, interactionScriptCpuMs, longTasks: interactionTasks.length,
      longestTaskMs: Math.max(0, ...interactionTasks.map(item => item.duration)), glInfo };
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
  const report = { measuredAt: new Date().toISOString(), scope: 'real WebGL geometry; same page cached/uncached instances; no DOM titles', samples: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html><body style="margin:0"></body></html>');
    for (const filename of ['graph-gl.js', 'graph-engine.js']) {
      await page.addScriptTag({ path: path.resolve(__dirname, '../assets', filename) });
    }
    await page.evaluate(installBenchmark);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    async function scriptDuration() {
      const metrics = await cdp.send('Performance.getMetrics');
      return metrics.metrics.find(item => item.name === 'ScriptDuration').value;
    }
    await page.exposeFunction('graphInteractionScriptDuration', scriptDuration);
    // Warm JavaScript and shaders before timed pairs; setup CPU is still reported separately.
    const timeStyles = process.argv.includes('--fallback-only') ? [] : [false, true];
    if (timeStyles.length) {
      await page.evaluate(config => window.runGraphCacheSample(config), { count: 150, cache: false, timeStyle: false, frames: 20 });
    }
    for (const timeStyle of timeStyles) {
      for (const count of [150, 1500, 3000]) {
        for (const cache of [false, true]) {
          const started = await scriptDuration();
          const sample = await page.evaluate(config => window.runGraphCacheSample(config), { count, cache, timeStyle, frames: 90 });
          sample.totalScriptCpuMs = ((await scriptDuration()) - started) * 1000;
          assert.equal(sample.idleDraws, 0, 'time style declarations cannot create idle RAF');
          assert.equal(sample.edgeStyles, cache ? 0 : sample.draws * (count - 1));
          assert.equal(sample.nodeStyles, cache && !timeStyle ? 0 : sample.draws * count);
          assert.equal(sample.uploads, cache ? (timeStyle ? sample.draws : 0) : sample.draws * 2);
          report.samples.push(sample);
          console.log(JSON.stringify(sample));
        }
      }
    }
    report.shaderFallback = await page.evaluate(async () => {
      const original = document.createElement('canvas');
      original.style.cssText = 'width:1200px;height:720px;';
      document.body.replaceChildren(original);
      let activePrograms = 0, replaced = 0, labelFrames = 0;
      const lost = new Promise(resolve => original.addEventListener('webglcontextlost', resolve, { once: true }));
      const make = GraphGL.create;
      let failedGL;
      GraphGL.create = canvas => {
        failedGL = canvas.getContext('webgl2');
        const createProgram = failedGL.createProgram.bind(failedGL), deleteProgram = failedGL.deleteProgram.bind(failedGL);
        failedGL.createProgram = () => { activePrograms++; return createProgram(); };
        failedGL.deleteProgram = program => { activePrograms--; return deleteProgram(program); };
        failedGL.getShaderParameter = () => false;
        return make(canvas);
      };
      const engine = GraphEngine.create({ canvas: original, backend: 'webgl', labelVisibility: 'always',
        domOverlayOnCanvas2D: true, onCanvasReplace() { replaced++; },
        drawNode(ctx) { ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill(); },
        domOverlay: { sync(state) { if (state.labelAlpha === 1) labelFrames++; }, destroy() {} } });
      GraphGL.create = make;
      if (!engine || engine.backendKind !== 'canvas2d') throw new Error('shader failure did not fall back to Canvas2D');
      engine.setData([{ id: 'fallback', x: 600, y: 360, r: 6 }], []);
      engine.requestRender();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.race([lost, new Promise(resolve => setTimeout(resolve, 500))]);
      const result = { backend: engine.backendKind, replaced, activePrograms, labelFrames,
        freshCanvas: engine.canvas !== original && document.body.firstChild === engine.canvas,
        contextLost: failedGL.isContextLost() };
      engine.destroy(); engine.canvas.remove();
      return result;
    });
    assert.deepEqual({ ...report.shaderFallback, labelFrames: undefined },
      { backend: 'canvas2d', replaced: 1, activePrograms: 0, labelFrames: undefined, freshCanvas: true, contextLost: true });
    assert(report.shaderFallback.labelFrames > 0);
    console.log(JSON.stringify({ shaderFallback: report.shaderFallback }));
    await cdp.detach();
    assert.deepEqual(errors, []);
    const output = process.argv.slice(2).find(arg => !arg.startsWith('--')) || process.env.RELATUM_GRAPH_CACHE_REPORT;
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
