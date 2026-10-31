'use strict';

// Real offline MathJax + CodeMirror, synthetic Markdown and disposable output.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const net = require('node:net'), { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-math-preview-'));
const equation = String.raw`$$
\begin{aligned}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla \cdot \mathbf{B} &= 0 \\
\nabla \times \mathbf{E} &= -\frac{\partial \mathbf{B}}{\partial t} \\
\nabla \times \mathbf{B} &= \mu_0\mathbf{J}
+\mu_0\varepsilon_0\frac{\partial \mathbf{E}}{\partial t}
\end{aligned}
$$`;
const headingEquation = String.raw`\[
E_{t+1}
=
E_t+\eta_{\mathrm{ch}}P_{\mathrm{ch},t}\Delta t
-\frac{P_{\mathrm{dis},t}}{\eta_{\mathrm{dis}}}\Delta t
\]`;
const optimizationEquation = String.raw`\[
\boxed{
\begin{aligned}
\min_{\boldsymbol{x},\boldsymbol{u}}\quad
&J(\boldsymbol{x},\boldsymbol{u})\\
\text{s.t.}\quad
&\boldsymbol{x}_{t+1}
=f(\boldsymbol{x}_t,\boldsymbol{u}_t,\boldsymbol{w}_t)\\
&\boldsymbol{g}(\boldsymbol{x}_t,\boldsymbol{u}_t)\le0\\
&\boldsymbol{h}(\boldsymbol{x}_t,\boldsymbol{u}_t)=0
\end{aligned}
}
\]`;
const syntaxEquation = String.raw`> [!note]
> $$
> \frac{a_1+[
> (b+2)
> ]}{\sqrt{c}} \{ x \} \% % ignored { [ ( \frac
> +0
> $$`;
const tokenSelector = '.cm-content span:is(.note-live-math-delimiter,.note-live-math-command,.note-live-math-operator,.note-live-math-script,.note-live-math-number,.note-live-math-comment,.note-live-math-bracket-0,.note-live-math-bracket-1,.note-live-math-bracket-2)';
const syntaxTokens = page => page.locator(tokenSelector).evaluateAll(nodes => nodes.map(node => ({
  text: node.textContent, kind: [...node.classList].find(name => /^note-live-math-/.test(name)), color: getComputedStyle(node).color,
})));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><style>
body{margin:0;background:var(--bg,#fbfbfa)}.note-workspace{display:block;position:static;width:100%;height:100vh;transform:none;animation:none}
.note-live-editor-host{height:100vh}.note-live-editor-host .cm-content{font-size:calc(16px * var(--note-font-scale,1))}
</style></head><body class="start-page" data-start-theme="light"><main class="note-workspace"><div class="note-live-editor-host" id="editor"></div></main>
<script src="markdown-table.js"></script><script src="markdown.js"></script>
<script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script>
<script src="note-media-frame.js"></script><script src="note-live-editor.js"></script>
<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:'ordinary text',notePath:'math.md'});</script></body></html>`;

async function checkMathAutoload(browser, url) {
  const report = [];
  for (const kind of ['blocks', 'editing', 'inline', 'reading-live']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    try {
      // Keep the extension in flight long enough to expose concurrent TeX
      // parsing. Each case has a new JS context and no warmed math packages.
      await page.route('**/mathjax/input/tex/extensions/boldsymbol.js', async route => {
        await new Promise(resolve => setTimeout(resolve, 150)); await route.continue();
      });
      await page.goto(url); await page.waitForFunction(() => window.editor?.view);
      const value = (kind === 'inline' ? 'Inline $\\boldsymbol{\\alpha}$\n\n' : '')
        + optimizationEquation + '\n\n' + optimizationEquation.replace('\\[', () => '$$').replace('\\]', () => '$$') + '\n\ntail';
      await page.evaluate(({ value, kind }) => {
        const at = kind === 'editing' ? value.indexOf('J(') : value.length;
        editor.setDocument({ value, notePath: 'autoload.md', anchor: at, head: at }); editor.focus();
        if (kind === 'reading-live') {
          const host = document.createElement('div'); host.style.width = '820px'; document.body.appendChild(host);
          RelatumNoteLiveEditor.renderMarkdown(host, value, 'reading.md');
        }
      }, { value, kind });
      const count = kind === 'reading-live' ? 4 : kind === 'inline' ? 3 : 2;
      await page.waitForFunction(count => document.querySelectorAll('mjx-container').length === count
        && !document.querySelector('.note-live-math-stage'), count);
      const metrics = await page.evaluate(() => ({
        red: [...document.querySelectorAll('mtext[mathcolor="red"]')].map(node => node.textContent),
        errors: [...document.querySelectorAll('mjx-merror,[data-mjx-error],merror')].map(node => node.textContent),
        incomplete: [...document.querySelectorAll('.note-live-math-status')].some(node => !node.hidden),
        widths: [...document.querySelectorAll('.note-live-rich-block.is-math')].map(node => ({ width: node.clientWidth, scroll: node.scrollWidth })),
        value: editor.snapshot().value,
      }));
      assert.deepEqual(metrics.red, [], kind + ': auto-loaded boldsymbol is defined in every formula');
      assert.deepEqual(metrics.errors, []); assert.equal(metrics.incomplete, false);
      assert(metrics.widths.every(item => item.scroll <= item.width + 1), kind + ': the short boxed formula needs no horizontal scrollbar');
      assert.equal(metrics.value, value); assert.deepEqual(errors, []);
      assert(requests.some(url => url.includes('/extensions/boldsymbol.js')), 'the real local extension is loaded');
      assert(requests.every(request => new URL(request).origin === new URL(url).origin), 'math stays fully offline');
      report.push({ kind, ...metrics, value: undefined });
      await page.screenshot({ path: path.join(output, 'autoload-' + kind + '.png') });
      if (kind === 'blocks') await page.locator('.note-live-rich-block.is-math').first().screenshot({ path: path.join(output, 'boxed-optimization.png') });
    } finally { await page.close(); }
  }
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  try {
    await page.goto(url); await page.waitForFunction(() => window.editor?.view);
    for (const editing of [false, true]) {
      const value = '$$' + Array.from({ length: 75 }, (_, i) => 'x_{' + i + '}').join('+') + '$$\n\ntail';
      await page.evaluate(({ value, editing }) => {
        editor.view.contentDOM.blur(); const at = editing ? 5 : value.length;
        editor.setDocument({ value, notePath: 'wide.md', anchor: at, head: at, scrollTop: 0 }); editor.focus();
      }, { value, editing });
      await page.waitForFunction(() => document.querySelector('.is-math mjx-container'));
      const before = await page.locator('.note-live-rich-block.is-math').evaluate(node => {
        const box = node.getBoundingClientRect(), height = node.offsetHeight - node.clientHeight;
        const thumb = node.clientWidth * node.clientWidth / node.scrollWidth;
        return { x: box.left + Math.max(20, thumb / 2), y: box.bottom - height / 2,
          height, scroll: node.scrollLeft, width: node.clientWidth, total: node.scrollWidth,
          overflow: getComputedStyle(node).overflowX, scrollbar: getComputedStyle(node, '::-webkit-scrollbar').height };
      });
      assert(before.total > before.width * 2 && before.height >= 6, 'a truly wide formula has a real native scrollbar: ' + JSON.stringify({ editing, before }));
      await page.mouse.move(before.x, before.y); await page.mouse.down();
      await page.mouse.move(before.x + 180, before.y, { steps: 6 }); await page.mouse.up();
      const left = await page.locator('.note-live-rich-block.is-math').evaluate(node => node.scrollLeft);
      assert(left > before.scroll + 80, 'dragging the real thumb scrolls the formula');
      const track = await page.locator('.note-live-rich-block.is-math').boundingBox();
      await page.mouse.click(track.x + track.width - 20, before.y);
      await page.waitForFunction(left => document.querySelector('.note-live-rich-block.is-math').scrollLeft > left + 40, left);
      assert.equal(await page.locator('.note-live-math-preview').count(), editing ? 1 : 0, 'scrollbar dragging does not open or close source');
      assert.equal(await page.evaluate(() => editor.snapshot().value), value);
      if (!editing) {
        const box = await page.locator('.note-live-rich-block.is-math').boundingBox();
        await page.mouse.click(box.x + 40, box.y + 10);
        await page.waitForFunction(() => document.querySelector('.note-live-math-preview mjx-container'));
      }
    }
    // A rejected, removed host must release the shared slot and clear its
    // MathItems; otherwise one failed formula can block the whole workspace.
    const recovery = await page.evaluate(async () => {
      const native = MathJax.typesetPromise, clear = MathJax.typesetClear;
      const removed = document.createElement('div'), next = document.createElement('div');
      removed.textContent = '$$x$$'; next.textContent = '$$y$$'; document.body.append(removed, next);
      let current = true, release, entered, cleared = false;
      const started = new Promise(resolve => { entered = resolve; });
      MathJax.typesetPromise = function (nodes) {
        if (nodes[0] === removed) return new Promise((resolve, reject) => { release = reject; entered(); });
        return native.call(this, nodes);
      };
      MathJax.typesetClear = function (nodes) { if (nodes[0] === removed) cleared = true; return clear.call(this, nodes); };
      try {
        const first = RelatumNoteLiveEditor.typesetMath(removed, () => current).catch(error => error.message);
        await started;
        const second = RelatumNoteLiveEditor.typesetMath(next, () => next.isConnected);
        current = false; removed.remove(); release(new Error('deliberate math failure'));
        return { first: await first, second: await second, cleared, rendered: !!next.querySelector('mjx-container') };
      } finally { MathJax.typesetPromise = native; MathJax.typesetClear = clear; clear.call(MathJax, [removed, next]); next.remove(); }
    });
    assert.deepEqual(recovery, { first: 'deliberate math failure', second: true, cleared: true, rendered: true });
  } finally { await page.close(); }
  fs.writeFileSync(path.join(output, 'autoload-report.json'), JSON.stringify(report, null, 2));
  return { cases: report.length, nativeScrollbars: 2, queueRecovery: true };
}

async function checkMathHeadings(page, set, settle) {
  let checks = 0;
  for (const dollars of [false, true]) for (const prefix of ['', '> ', '> > ']) for (const gap of ['', '1\n', '\n']) {
    const formula = dollars ? headingEquation.replace('\\[', () => '$$').replace('\\]', () => '$$') : headingEquation;
    const value = ('例如电池能量约束：\n' + gap + formula).split('\n').map(line => prefix + line).join('\n');
    await set(value, value.indexOf('E_{t+1}') + 1);
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content mjx-container'));
    for (const active of [true, false]) {
      if (!active) await page.evaluate(() => editor.view.contentDOM.blur());
      await settle();
      const metrics = await page.evaluate(() => {
        const text = [...document.querySelectorAll('.cm-line')].find(line => line.textContent.includes('例如电池能量约束'));
        return { size: getComputedStyle(text).fontSize, base: getComputedStyle(editor.view.contentDOM).fontSize,
          heading: !!document.querySelector('.cm-line.note-live-heading, .cm-line.note-live-setext-marker-line'), value: editor.snapshot().value };
      });
      assert.equal(metrics.heading, false, JSON.stringify({ dollars, prefix, gap, active }));
      assert.equal(metrics.size, metrics.base, 'ordinary text keeps the configured body font size');
      assert.equal(metrics.value, value);
    }
    await page.evaluate(() => editor.setSourceMode(true)); await settle();
    assert.equal(await page.locator('.cm-line.note-live-heading, .cm-line.note-live-setext-marker-line').count(), 0);
    assert.equal(await page.evaluate(() => editor.snapshot().value), value);
    await page.evaluate(() => { editor.setSourceMode(false); editor.focus(); }); await settle();
    assert.equal(await page.locator('.cm-line.note-live-heading, .cm-line.note-live-setext-marker-line').count(), 0);
    checks++;
  }
  const value = '例如电池能量约束：\n' + headingEquation + '\n真实标题\n---';
  await set(value, value.indexOf('E_{t+1}') + 1);
  assert.equal(await page.locator('.cm-line.note-live-heading').textContent(), '真实标题');
  await page.evaluate(() => {
    const at = editor.view.state.doc.toString().lastIndexOf('\\]');
    editor.view.dispatch({ changes: { from: at, to: at + 2 }, userEvent: 'input.type', annotations: RelatumCodeMirror.isolateHistory.of('full') });
  });
  await settle();
  assert.equal(await page.locator('.cm-line.note-live-heading, .cm-line.note-live-setext-marker-line').count(), 0, 'removing the closer protects the unfinished formula');
  await page.keyboard.press('Control+z'); await settle();
  assert.equal(await page.evaluate(() => editor.snapshot().value), value);
  assert.equal(await page.locator('.cm-line.note-live-heading').textContent(), '真实标题');
  await page.keyboard.press('Control+y'); await settle();
  assert.equal(await page.locator('.cm-line.note-live-heading, .cm-line.note-live-setext-marker-line').count(), 0);
  await page.keyboard.press('Control+z'); await settle();
  await page.screenshot({ path: path.join(output, 'heading-math.png') });
  return checks;
}

async function checkMathPointerScroll(page, filename) {
  const report = [], reportPath = path.join(output, 'pointer-scroll.json');
  const prepare = async (scenario) => {
    const open = scenario.brackets ? '\\[' : '$$', close = scenario.brackets ? '\\]' : '$$';
    const formula = (open + '\nx_0\n' + Array.from({ length: 12 }, (_, i) => '+x_{' + (i + 1) + '}').join('\n') + '\n' + close)
      .split('\n').map(line => (scenario.callout ? '> ' : '') + line).join('\n');
    const value = Array.from({ length: scenario.short ? 2 : 50 }, (_, i) => '前文段落 ' + i + '：用于检查阅读位置的正文。').join('\n\n')
      + '\n\nBEFORE target paragraph\n\n' + (scenario.callout ? '> [!note]\n' : '') + formula + '\n\nAFTER target paragraph\n\n'
      + Array.from({ length: scenario.end ? 1 : scenario.short ? 2 : 60 }, (_, i) => '后文段落 ' + i + '：用于检查阅读位置的正文。').join('\n\n');
    await page.evaluate(value => {
      const e = T.editor, at = value.indexOf('x_0') + 2;
      e.view.contentDOM.blur(); e.setSourceMode(false);
      e.setDocument({ value, notePath: 'Formula.md', anchor: at, head: at, scrollTop: 0 }); e.focus();
    }, value);
    await page.waitForTimeout(80);
    await page.evaluate(() => {
      const v = T.editor.view, at = v.state.doc.toString().indexOf('x_0') + 2;
      v.dispatch({ changes: { from: at, to: at + 1, insert: '9' }, selection: { anchor: at + 1 },
        userEvent: 'input.type', annotations: RelatumCodeMirror.isolateHistory.of('full'), scrollIntoView: true });
    });
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content mjx-container'));
    await page.waitForTimeout(100);
    assert(await page.evaluate(() => T.flushSave()));
    const saved = value.replace('x_0', 'x_9');
    assert.equal(fs.readFileSync(filename, 'utf8'), saved);
    const target = await page.evaluate(scenario => {
      const v = T.editor.view, d = v.state.doc.toString(), from = d.indexOf(scenario.brackets ? '\\[' : '$$');
      const top = v.coordsAtPos(from)?.top ?? v.documentTop + v.lineBlockAt(from).top;
      v.scrollDOM.scrollTop += top - v.scrollDOM.getBoundingClientRect().top - scenario.align;
      v.requestMeasure();
      return d.indexOf(scenario.target || 'AFTER') + 8;
    }, scenario);
    await page.waitForTimeout(100);
    const before = await page.evaluate(target => {
      const v = T.editor.view, s = v.scrollDOM, r = v.coordsAtPos(target), box = s.getBoundingClientRect();
      return { target, top: s.scrollTop, max: s.scrollHeight - s.clientHeight, origin: box.top, end: box.bottom,
        x: r?.left, y: r?.top, bottom: r?.bottom };
    }, target);
    assert(before.y >= before.origin && before.bottom <= before.end, 'click target is visible: ' + JSON.stringify({ scenario, before }));
    return { value, saved, before };
  };
  const sample = async (before) => page.evaluate(before => {
    window.__pointerFrames = []; window.__pointerSampling = true;
    const sample = () => {
      if (!__pointerSampling) return;
      const v = T.editor.view, s = v.scrollDOM, r = v.coordsAtPos(before.target);
      if (r) {
        const origin = s.getBoundingClientRect().top, max = s.scrollHeight - s.clientHeight;
        const docY = r.top - origin + s.scrollTop, desired = docY - (before.y - before.origin);
        __pointerFrames.push({ y: r.top, top: s.scrollTop, max,
          expected: docY - Math.max(0, Math.min(max, desired)) + origin });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, before);
  const collect = async (scenario, before) => {
    const result = await page.evaluate(before => {
      window.__pointerSampling = false;
      const v = T.editor.view, r = v.coordsAtPos(before.target);
      return { before, y: r?.top, head: v.state.selection.main.head, value: T.editor.snapshot().value,
        preview: !!document.querySelector('.note-live-math-preview'), frames: __pointerFrames };
    }, before);
    report.push({ scenario, ...result, value: undefined }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    assert.equal(result.head, before.target, 'native click retains the exact character');
    assert.equal(result.preview, false, 'leaving math closes the source preview');
    assert(result.frames.length >= 3 && result.frames.every(frame => Math.abs(frame.y - frame.expected) <= 2),
      'every visible frame preserves the click or its clamped position: ' + JSON.stringify(report.at(-1)));
    return result;
  };
  const scenarios = [
    { name: 'visible-below', align: 80 }, { name: 'top-inside-source', align: -180 },
    { name: 'click-above', align: 180, target: 'BEFORE' },
    { name: 'source-above-viewport', align: -650, target: '后文段落 8' },
    { name: 'document-end', align: -180, end: true }, { name: 'short-document', align: 0, short: true },
    { name: 'callout-below', align: 80, callout: true },
  ];
  for (const brackets of [false, true]) for (const scenario of scenarios) {
    const sc = { ...scenario, brackets }, { value, saved, before } = await prepare(sc);
    await sample(before); await page.mouse.click(before.x, (before.y + before.bottom) / 2);
    await page.waitForTimeout(250);
    const result = await collect(sc, before);
    assert.equal(result.value, saved); assert(await page.evaluate(() => T.flushSave()));
    assert.equal(fs.readFileSync(filename, 'utf8'), saved, 'a click and scroll correction do not change disk contents');
    assert(await page.evaluate(() => RelatumCodeMirror.undo(T.editor.view)));
    assert.equal(await page.evaluate(() => T.editor.snapshot().value), value, 'one undo reaches the edit before the click');
    assert(await page.evaluate(() => RelatumCodeMirror.redo(T.editor.view)));
    assert.equal(await page.evaluate(() => T.editor.snapshot().value), saved);
  }
  await page.setViewportSize({ width: 780, height: 950 });
  await page.evaluate(() => {
    document.body.dataset.startTheme = 'dark'; document.querySelector('.note-workspace').style.setProperty('--note-font-scale', '1.35');
  });
  const narrow = { name: 'dark-narrow-large-font', align: 40, brackets: true };
  const { saved: narrowSaved, before: narrowBefore } = await prepare(narrow);
  await sample(narrowBefore); await page.mouse.click(narrowBefore.x, (narrowBefore.y + narrowBefore.bottom) / 2);
  await page.waitForTimeout(250); assert.equal((await collect(narrow, narrowBefore)).value, narrowSaved);
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.evaluate(() => {
    document.body.dataset.startTheme = 'light'; document.querySelector('.note-workspace').style.removeProperty('--note-font-scale');
  });
  // Hold only the new rendered projection, after the editing preview is ready.
  // This makes the second layout change and cancellation deterministic.
  for (const action of ['settle', 'wheel', 'click', 'drag', 'input', 'document', 'source', 'workspace', 'hidden', 'minimize', 'pagehide']) {
    const scenario = { name: 'delayed-' + action, align: 80 }, { saved, before } = await prepare(scenario);
    await page.evaluate(() => {
      const original = MathJax.typesetPromise;
      MathJax.typesetPromise = function (nodes) {
        if (!nodes.some(node => node.matches?.('.note-live-rich-block.is-math:not(.note-live-math-preview)'))) return original.call(this, nodes);
        window.__pointerHeld = true;
        return new Promise((resolve, reject) => {
          window.__pointerRelease = async () => {
            MathJax.typesetPromise = original;
            try { resolve(await original.call(MathJax, nodes)); } catch (error) { reject(error); }
          };
        });
      };
    });
    await sample(before); await page.mouse.click(before.x, (before.y + before.bottom) / 2);
    await page.waitForFunction(() => window.__pointerHeld);
    await page.waitForTimeout(80);
    if (action === 'settle') {
      await page.evaluate(() => __pointerRelease()); await page.waitForTimeout(180);
      assert.equal((await collect(scenario, before)).value, saved);
    } else {
      await collect(scenario, before);
      if (action === 'wheel') {
        await page.mouse.move(before.x, before.y); await page.mouse.wheel(0, 220);
      } else if (action === 'click' || action === 'drag') {
        const point = await page.evaluate(() => {
          const v = T.editor.view, at = v.state.doc.toString().indexOf('BEFORE') + 8, r = v.coordsAtPos(at);
          return { at, x: r.left, y: (r.top + r.bottom) / 2 };
        });
        if (action === 'click') await page.mouse.click(point.x, point.y);
        else {
          await page.mouse.move(before.x, (before.y + before.bottom) / 2); await page.mouse.down();
          await page.mouse.move(point.x, point.y, { steps: 5 }); await page.mouse.up();
          assert(await page.evaluate(() => !T.editor.view.state.selection.main.empty), 'native dragging still selects text');
        }
      } else if (action === 'input') await page.keyboard.type('!');
      else await page.evaluate(action => {
        const e = T.editor;
        if (action === 'document') e.setDocument({ value: 'A different document\n\n' + 'ordinary paragraph\n\n'.repeat(100), notePath: 'Other.md', anchor: 4, head: 4, scrollTop: 300 });
        if (action === 'source') e.setSourceMode(true);
        if (action === 'workspace') {
          document.dispatchEvent(new CustomEvent('relatum:start-workspacechange', { detail: { workspace: 'canvas' } }));
          document.dispatchEvent(new CustomEvent('relatum:start-workspacechange', { detail: { workspace: 'notes' } }));
        }
        if (action === 'hidden') {
          const host = document.querySelector('.note-workspace');
          host.hidden = true; e.setExtensionsActive(false); host.hidden = false; e.setExtensionsActive(true);
        }
        if (action === 'minimize') {
          document.documentElement.dataset.desktopMinimized = '1'; dispatchEvent(new Event('canvasdesktop:visibility'));
          document.documentElement.dataset.desktopMinimized = '0'; dispatchEvent(new Event('canvasdesktop:visibility'));
        }
        if (action === 'pagehide') { dispatchEvent(new Event('pagehide')); dispatchEvent(new Event('pageshow')); }
      }, action);
      await page.waitForTimeout(150);
      const stable = await page.evaluate(() => {
        const v = T.editor.view, block = v.lineBlockAtHeight(v.scrollDOM.scrollTop + 12), r = v.coordsAtPos(block.from);
        return { position: block.from, y: r?.top, head: v.state.selection.main.head, anchor: v.state.selection.main.anchor, value: T.editor.snapshot().value };
      });
      await page.evaluate(() => __pointerRelease()); await page.waitForTimeout(180);
      const after = await page.evaluate(position => {
        const v = T.editor.view;
        return { y: v.coordsAtPos(position)?.top, head: v.state.selection.main.head, anchor: v.state.selection.main.anchor, value: T.editor.snapshot().value };
      }, stable.position);
      assert.equal(after.head, stable.head, action + ': a late typeset does not change the new caret');
      assert.equal(after.anchor, stable.anchor, action + ': a late typeset does not change the new selection');
      assert.equal(after.value, stable.value);
      assert(stable.y != null && after.y != null && Math.abs(after.y - stable.y) <= 2,
        action + ': a late typeset does not restore the cancelled pointer target: ' + JSON.stringify({ stable, after }));
    }
    await page.evaluate(() => { delete window.__pointerHeld; delete window.__pointerRelease; });
  }
  return { cases: report.length, report: reportPath };
}

async function checkWorkspace(browser, pointerOnly = false) {
  const root = path.join(output, 'workspace');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  const value = '前文\n\n' + equation + '\n\n后文';
  const filename = path.join(root, 'notes/Formula.md');
  fs.writeFileSync(filename, value);
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', context;
  service.stdout.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  service.stderr.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  service.on('error', error => { logs += error.message; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch (error) {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'isolated workspace service starts: ' + logs);
    context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, flushSave, setViewMode, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteOpenTabs:v1', '["Formula.md"]');
      localStorage.setItem('canvas:noteActiveTab:v1', 'Formula.md');
      localStorage.setItem('canvas:noteGraphPreload:v1', '0');
    });
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.active && T.state.current?.path === 'Formula.md' && T.editor);
    if (pointerOnly) {
      const result = await checkMathPointerScroll(page, filename); assert.deepEqual(errors, []); return result;
    }
    await page.evaluate(() => {
      const at = T.editor.view.state.doc.toString().indexOf('\\rho');
      T.editor.view.dispatch({ selection: { anchor: at, head: at }, scrollIntoView: true }); T.editor.focus();
      window.__originalEditor = T.editor;
    });
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content mjx-container'));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(output, 'workspace-light.png') });
    assert.equal(fs.readFileSync(filename, 'utf8'), value, 'opening the preview does not write Markdown');
    const before = await page.evaluate(() => ({ top: T.editor.view.scrollDOM.scrollTop,
      y: T.editor.view.coordsAtPos(T.editor.view.state.selection.main.head).top }));
    await page.evaluate(() => {
      const at = T.editor.view.state.doc.toString().indexOf('\\rho');
      T.editor.view.dispatch({ changes: { from: at, to: at + 4, insert: '\\frac{a}{b}' }, userEvent: 'input.type' });
    });
    await page.waitForFunction(() => document.querySelectorAll('.note-live-math-preview-content mjx-mfrac').length >= 4);
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({ top: T.editor.view.scrollDOM.scrollTop,
      y: T.editor.view.coordsAtPos(T.editor.view.state.selection.main.head).top, same: __originalEditor === T.editor }));
    assert(after.same && Math.abs(after.top - before.top) <= 1 && Math.abs(after.y - before.y) <= 1, JSON.stringify({ before, after }));
    assert(await page.evaluate(() => T.flushSave()));
    assert.equal(fs.readFileSync(filename, 'utf8'), value.replace('\\rho', '\\frac{a}{b}'), 'only actual input reaches disk');
    await page.evaluate(() => T.setViewMode('reading'));
    await page.waitForFunction(() => document.querySelector('.note-reading-content mjx-container'));
    assert.equal(await page.locator('.note-live-math-preview-content').count(), 0, 'reading mode suspends the editing preview');
    await page.evaluate(async () => { await T.setViewMode('live'); T.editor.focus(); });
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content mjx-container'));
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await page.screenshot({ path: path.join(output, 'workspace-dark.png') });
    const headingValue = '例如电池能量约束：\n' + headingEquation + '\n真实标题\n---';
    await page.evaluate(value => {
      T.editor.view.dispatch({ changes: { from: 0, to: T.editor.view.state.doc.length, insert: value },
        selection: { anchor: value.indexOf('E_{t+1}') + 1 }, userEvent: 'input.type' }); T.editor.focus();
    }, headingValue);
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content mjx-container'));
    assert.equal(await page.locator('.cm-line.note-live-heading').textContent(), '真实标题');
    const editorBeforeModes = await page.evaluate(() => { window.__headingEditor = T.editor; return T.editor.snapshot().value; });
    assert.equal(editorBeforeModes, headingValue);
    for (const mode of ['source', 'live', 'reading', 'live']) {
      await page.evaluate(mode => T.setViewMode(mode), mode);
      if (mode === 'reading') {
        await page.waitForFunction(() => document.querySelector('.note-reading-content mjx-container'));
        assert.equal(await page.locator('.note-reading-content h2').textContent(), '真实标题');
        assert.equal(await page.locator('.note-reading-content h1').count(), 0, 'reading never invents a heading before math');
      } else {
        assert.equal(await page.evaluate(() => T.editor.snapshot().value), headingValue);
        if (mode === 'live') assert.equal(await page.locator('.cm-line.note-live-heading').textContent(), '真实标题');
      }
    }
    assert(await page.evaluate(() => T.editor === __headingEditor), 'mode changes retain the original editor');
    await page.screenshot({ path: path.join(output, 'heading-math-workspace.png') });
    const pointerScroll = await checkMathPointerScroll(page, filename);
    assert.deepEqual(errors, []);
    return { saved: true, reading: true, scrollStable: true, editorReused: true, mathHeadings: true, pointerScroll };
  } finally {
    await context?.close();
    if (service.pid && service.exitCode === null && service.signalCode === null) {
      const exited = new Promise(resolve => service.once('exit', resolve));
      service.kill(); await exited;
    }
  }
}

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html); return; }
    const file = path.resolve(repo, '.' + pathname);
    if (!pathname.startsWith('/assets/') || !file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    const body = fs.readFileSync(file);
    res.end(file.endsWith('note-live-editor.js') ? body.toString().replace('function scanMathSourceTokens(source, block) {',
      'function scanMathSourceTokens(source, block) { window.__mathLexRuns = (window.__mathLexRuns || 0) + 1;') : body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'],
      ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(12000);
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.editor);
    if (process.argv.includes('--pointer-only')) {
      console.log(JSON.stringify({ output, workspace: await checkWorkspace(browser, true) })); return;
    }
    const autoload = await checkMathAutoload(browser, page.url());
    if (process.argv.includes('--autoload-only')) { console.log(JSON.stringify({ output, autoload })); return; }
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const set = async (value, at = value.indexOf('x') >= 0 ? value.indexOf('x') + 1 : value.indexOf('\\begin') + 3) => {
      await page.evaluate(({ value, at }) => {
        editor.view.contentDOM.blur();
        editor.setDocument({ value, notePath: 'math.md', anchor: at, head: at, scrollTop: 0 });
        editor.focus();
      }, { value, at });
      await settle();
    };
    const previewReady = () => page.waitForFunction(() => document.querySelector('.note-live-math-preview-content mjx-container'));
    // No eager math load, including ordinary edits and an unclosed delimiter.
    await set('ordinary text', 4);
    assert.equal(await page.evaluate(() => !!window.MathJax), false);
    await set('$$\nx^2', 5);
    assert.equal(await page.locator('.note-live-math-preview').count(), 0);
    assert.equal(await page.evaluate(() => !!window.MathJax), false);

    // Syntax colors work before MathJax is loaded, and both editing modes
    // share the same tokens rather than interpreting TeX as Markdown.
    const inline = String.raw`inline $\frac{x_1}{2.5}+\alpha$ only`;
    await page.evaluate(() => editor.setSourceMode(true));
    await set(inline, inline.indexOf('x_1') + 1);
    const inlineSource = await syntaxTokens(page);
    assert(inlineSource.some(token => token.text === '\\frac' && token.kind === 'note-live-math-command'));
    assert(inlineSource.some(token => token.text === '2.5' && token.kind === 'note-live-math-number'));
    assert.equal(await page.evaluate(() => !!window.MathJax), false, 'source coloring never loads MathJax');
    await set(String.raw`$$\frac{x_1}{2.5}$$`, 5);
    assert.equal(await page.evaluate(() => !!window.MathJax), false, 'source-mode display math also stays cold');
    await set(inline, inline.indexOf('x_1') + 1);
    await page.evaluate(() => { editor.setSourceMode(false); editor.focus(); }); await settle();
    assert.deepEqual(await syntaxTokens(page), inlineSource, 'active inline math has identical syntax colors');
    assert.equal(await page.evaluate(() => !!window.MathJax), false, 'editing inline source does not need MathJax');
    const parenInline = String.raw`inline \(\frac{x_1}{2.5}+\alpha\) only`;
    await set(parenInline, parenInline.indexOf('x_1') + 1);
    const parenColors = await syntaxTokens(page);
    assert.equal(await page.locator('.note-live-math-source .is-escape, .note-live-math-source .note-live-emphasis').count(), 0,
      'inline TeX does not inherit Markdown escapes or emphasis');
    await page.evaluate(() => editor.setSourceMode(true)); await settle();
    assert.deepEqual(await syntaxTokens(page), parenColors, 'parenthesis-delimited inline math has identical colors');
    await page.evaluate(() => editor.setSourceMode(true));
    await set(syntaxEquation, syntaxEquation.indexOf('a_1') + 1);
    const nested = await syntaxTokens(page);
    assert.deepEqual(nested.filter(token => token.kind.includes('bracket')).map(token => token.kind),
      [0, 1, 2, 2, 1, 0, 0, 1, 1, 0].map(level => 'note-live-math-bracket-' + level), 'nesting survives quote prefixes and line breaks');
    assert(nested.some(token => token.text === '\\{' && token.kind === 'note-live-math-command'), 'escaped braces are commands, not group nesting');
    assert(nested.some(token => token.text === '\\%' && token.kind === 'note-live-math-command'));
    assert(nested.some(token => token.text === '% ignored { [ ( \\frac' && token.kind === 'note-live-math-comment'));
    assert(new Set(nested.map(token => token.color)).size >= 7, 'syntax categories have distinct colors');
    const scans = await page.evaluate(() => window.__mathLexRuns);
    await page.evaluate(() => {
      const at = editor.view.state.doc.toString().indexOf('a_1');
      for (let i = 0; i < 12; i++) editor.view.dispatch({ selection: { anchor: at + i % 2 } });
    }); await settle();
    assert.equal(await page.evaluate(() => window.__mathLexRuns), scans, 'selection changes reuse lexical results');
    await page.evaluate(() => { editor.setSourceMode(false); editor.focus(); }); await settle();
    assert.deepEqual(await syntaxTokens(page), nested, 'quoted block math uses the same colors in live mode');
    const liveScans = await page.evaluate(() => __mathLexRuns);
    await page.evaluate(() => {
      const at = editor.view.state.doc.toString().indexOf('a_1');
      for (let i = 0; i < 12; i++) editor.view.dispatch({ selection: { anchor: at + i % 2 } });
    }); await settle();
    assert.equal(await page.evaluate(() => __mathLexRuns), liveScans, 'live-mode selection also reuses lexical results');

    // Only real formulas are colored: comments, code, frontmatter, escaped
    // dollars and unclosed outer delimiters must not leak into following text.
    const excluded = '---\nmath: "$x_1+2$"\n---\n\n```text\n$$\\frac{a}{2}$$\n```\n\n`$x_1+2$`\n\n%%\n$x_1+2$\n%%\n\n<!--\n$x_1+2$\n-->\n\n\\$x_1+2\\$\n\n$$\nx_1+2\n\nordinary';
    for (const source of [true, false]) {
      await page.evaluate(source => editor.setSourceMode(source), source);
      await set(excluded, excluded.length);
      assert.equal((await syntaxTokens(page)).length, 0, 'protected syntax is not math in mode ' + source);
    }
    for (const source of [true, false]) {
      await page.evaluate(source => editor.setSourceMode(source), source);
      const value = '---\ncomment: %%\n---\n\n$\\frac{x_1}{2}$';
      await set(value, value.indexOf('x_1') + 1);
      assert((await syntaxTokens(page)).some(token => token.text === '\\frac'), 'frontmatter comment examples do not hide later formulas');
    }
    // Return to ordinary text before the original preview cases.
    await set('ordinary text', 4);

    const headingChecks = await checkMathHeadings(page, set, settle);
    await set(equation);
    await previewReady();
    assert.equal(await page.locator('.note-live-math-delimiter').count(), 2);
    const appearance = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('.cm-line.note-live-math-source')];
      const marker = document.querySelector('.note-live-math-delimiter');
      const preview = document.querySelector('.note-live-math-preview');
      window.__previewDOM = preview;
      return { backgrounds: lines.map(line => getComputedStyle(line).backgroundColor),
        marker: getComputedStyle(marker).color, text: getComputedStyle(lines[1]).color,
        after: preview.getBoundingClientRect().top >= lines.at(-1).getBoundingClientRect().bottom - 1,
        readonly: preview.contentEditable, value: editor.snapshot().value };
    });
    assert(appearance.backgrounds.every(value => value === 'rgba(0, 0, 0, 0)'), JSON.stringify(appearance));
    assert.notEqual(appearance.marker, appearance.text);
    assert(appearance.after); assert.equal(appearance.readonly, 'false'); assert.equal(appearance.value, equation);
    await page.screenshot({ path: path.join(output, 'maxwell-light.png') });
    await page.evaluate(() => {
      const view = editor.view, value = view.state.doc.toString();
      const from = value.indexOf('\\nabla'), to = value.lastIndexOf('$$') + 2;
      view.dispatch({ selection: { anchor: from, head: to } });
      const clipboard = new DataTransfer();
      view.contentDOM.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: clipboard }));
      if (clipboard.getData('text/plain') !== value.slice(from, to)) throw new Error('copy must contain exact Markdown, without the preview');
    });

    // Keep only the latest typing result, reuse the preview DOM, preserve source history.
    await set('before\n\n$$x^2$$\n\nafter'); await previewReady();
    await page.evaluate(() => {
      window.__previewDOM = document.querySelector('.note-live-math-preview');
      window.__mathCalls = 0; window.__mathParallel = 0; window.__mathPeak = 0;
      const original = MathJax.typesetPromise.bind(MathJax);
      MathJax.typesetPromise = async nodes => {
        __mathCalls++; __mathParallel++; __mathPeak = Math.max(__mathPeak, __mathParallel);
        try { return await original(nodes); } finally { __mathParallel--; }
      };
      for (const digit of ['3', '4', '5', '6']) {
        const at = editor.view.state.doc.toString().indexOf('^') + 1;
        editor.view.dispatch({ changes: { from: at, to: at + 1, insert: digit }, userEvent: 'input.type' });
      }
    });
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content')?.textContent.includes('6'));
    assert.deepEqual(await page.evaluate(() => ({ calls: __mathCalls, peak: __mathPeak, reused: __previewDOM === document.querySelector('.note-live-math-preview') })),
      { calls: 1, peak: 1, reused: true });
    await page.evaluate(() => {
      const at = editor.view.state.doc.toString().indexOf('^') + 1;
      editor.view.dispatch({ selection: { anchor: at, head: at } });
    });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => __mathCalls), 1, 'caret movement and idle must not typeset unchanged source');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => editor.snapshot().value.includes('x^2'));
    await page.keyboard.press('Control+y');
    await page.waitForFunction(() => editor.snapshot().value.includes('x^6'));
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content')?.textContent.includes('6'));

    // An older slow render must not replace a newer edit, or start concurrent work.
    await page.evaluate(() => {
      const original = MathJax.typesetPromise;
      MathJax.typesetPromise = nodes => {
        MathJax.typesetPromise = original;
        return new Promise((resolve, reject) => {
          window.__releaseEdit = async () => { try { resolve(await original.call(MathJax, nodes)); } catch (error) { reject(error); } };
        });
      };
      const at = editor.view.state.doc.toString().indexOf('^') + 1;
      editor.view.dispatch({ changes: { from: at, to: at + 1, insert: '7' } });
    });
    await page.waitForFunction(() => typeof __releaseEdit === 'function');
    await page.evaluate(() => {
      const at = editor.view.state.doc.toString().indexOf('^') + 1;
      editor.view.dispatch({ changes: { from: at, to: at + 1, insert: '8' } });
    });
    await page.waitForTimeout(150);
    assert((await page.locator('.note-live-math-preview-content').textContent()).includes('6'));
    await page.evaluate(async () => { await __releaseEdit(); delete window.__releaseEdit; });
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content')?.textContent.includes('8'));
    assert.equal(await page.evaluate(() => __mathPeak), 1);

    // Invalid input keeps the last good result without exposing MathJax's error box.
    await page.evaluate(() => {
      const at = editor.view.state.doc.toString().indexOf('x^8');
      editor.view.dispatch({ changes: { from: at, to: at + 3, insert: '\\frac{' } });
    });
    await page.waitForFunction(() => !document.querySelector('.note-live-math-status').hidden);
    assert.equal(await page.locator('.note-live-math-preview mjx-merror').count(), 0);
    assert((await page.locator('.note-live-math-preview-content').textContent()).includes('8'));
    await page.evaluate(() => {
      const at = editor.view.state.doc.toString().indexOf('\\frac{');
      editor.view.dispatch({ changes: { from: at, to: at + 6, insert: '\\frac{1}{2}' } });
    });
    await page.waitForFunction(() => document.querySelector('.note-live-math-status').hidden && document.querySelector('.note-live-math-preview-content mjx-mfrac'));
    await page.evaluate(() => {
      const value = editor.view.state.doc.toString(), from = value.indexOf('$$') + 2, to = value.lastIndexOf('$$');
      editor.view.dispatch({ changes: { from, to, insert: '\\fra' } });
    });
    await page.waitForFunction(() => document.querySelector('.note-live-math-status').hidden === false);
    assert.equal(await page.locator('.note-live-math-preview-content mjx-mfrac').count(), 1, 'an incomplete command keeps the last fraction');
    assert.equal(await page.locator('.note-live-math-preview-content mtext[mathcolor="red"]').count(), 0);

    // First-invalid and corrected input; delimiter removal removes the preview.
    await set('$$\n\\frac{\n$$', 8);
    await page.waitForFunction(() => document.querySelector('.note-live-math-status')?.hidden === false);
    assert.equal(await page.locator('.note-live-math-preview-content').count(), 0);
    await page.evaluate(() => {
      const length = editor.view.state.doc.length;
      editor.view.dispatch({ changes: { from: length - 2, to: length } });
    });
    await settle(); assert.equal(await page.locator('.note-live-math-preview').count(), 0);

    const variants = [];
    for (const [theme, width, scale] of [['light', 1100, 1], ['dark', 620, 1.4]]) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate(({ theme, scale }) => { document.body.dataset.startTheme = theme; document.body.style.setProperty('--note-font-scale', scale); }, { theme, scale });
      for (const [name, value] of [
        ['single', '$$x^2$$'], ['brackets', '\\[x^2\\]'], ['integral', '$$\n\\int_0^\\infty e^{-x}dx\n$$'],
        ['matrix', '$$\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$$'], ['number', '$$\\frac{a}{b}\\tag{6}$$'],
        ['literal', '$$\\text{**bold** [link](https://example.test)}$$'],
        ['quote', '> $$\n> x^2\n> $$'], ['callout', '> [!note]\n> $$x^2$$'], ['color', '> [!blue]\n> $$x^2$$'],
      ]) {
        await set(value + '\n\nafter', value.indexOf('x') >= 0 ? value.indexOf('x') + 1 : value.indexOf('\\') + 3);
        await previewReady();
        assert.equal(await page.locator('.note-live-math-preview').count(), 1, name);
        assert.equal(await page.locator('.note-live-math-delimiter').count(), 2, name);
        assert.equal(await page.locator('.note-live-math-preview mjx-merror').count(), 0, name);
        assert.equal(await page.locator('.cm-line.note-live-math-source .note-live-strong, .cm-line.note-live-math-source .note-live-inline-code, .cm-line.note-live-math-source .note-live-link, .cm-line.note-live-math-source .is-escape').count(), 0,
          'formula source must not acquire Markdown formatting: ' + name);
        if (name === 'number') assert.equal(await page.locator('.note-live-math-preview mjx-labels').count(), 1);
        if (name === 'callout' || name === 'color') {
          const colors = await page.evaluate(() => [document.querySelector('.note-live-math-preview'), document.querySelector('.cm-line.note-live-math-source')].map(el => getComputedStyle(el).backgroundColor));
          assert.equal(colors[0], colors[1]); assert.notEqual(colors[0], 'rgba(0, 0, 0, 0)');
        }
        variants.push({ name, theme });
      }
      await set(equation); await previewReady();
      await page.screenshot({ path: path.join(output, 'maxwell-' + theme + '.png') });
      const visualEquation = syntaxEquation.replace(String.raw`\{ x \} \% % ignored { [ ( \frac`, '');
      await set(visualEquation, visualEquation.indexOf('a_1') + 1); await previewReady();
      const liveColors = await syntaxTokens(page);
      await page.screenshot({ path: path.join(output, 'syntax-' + theme + '.png') });
      await page.evaluate(() => editor.setSourceMode(true)); await settle();
      assert.deepEqual(await syntaxTokens(page), liveColors, theme + ' source/live colors match');
      await page.screenshot({ path: path.join(output, 'syntax-source-' + theme + '.png') });
      await page.evaluate(() => { editor.setSourceMode(false); editor.focus(); }); await settle();
      const wide = '$$' + Array.from({ length: 75 }, (_, i) => 'x_{' + i + '}').join('+') + '$$';
      await set(wide + '\n\nafter', 5); await previewReady();
      const sizing = await page.evaluate(() => {
        const el = document.querySelector('.note-live-math-preview');
        el.scrollLeft = 70;
        return { width: el.clientWidth, scrollWidth: el.scrollWidth, scrolled: el.scrollLeft > 0, editor: editor.view.contentDOM.getBoundingClientRect().width, viewport: innerWidth };
      });
      assert(sizing.scrollWidth > sizing.width && sizing.scrolled && sizing.editor <= sizing.viewport, JSON.stringify(sizing));
    }

    // Composition uses the browser's actual provisional text, never a rebuilt source line.
    await set('$$x^2$$\n\nafter'); await previewReady();
    const cdp = await page.context().newCDPSession(page);
    const callsBeforeIme = await page.evaluate(() => __mathCalls);
    for (const text of ['h', 'han']) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await page.waitForTimeout(180);
    assert.equal(await page.evaluate(() => __mathCalls), callsBeforeIme);
    await cdp.send('Input.insertText', { text: '汉' });
    await page.waitForFunction(() => editor.snapshot().value.includes('汉') && document.querySelector('.note-live-math-preview-content')?.textContent.includes('汉'));
    assert.equal(await page.locator('.note-live-math-preview').count(), 1);
    for (const text of ['z', 'zi']) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await settle(); assert(!await page.evaluate(() => editor.snapshot().value.includes('zi')));

    await page.evaluate(() => editor.setSourceMode(true));
    await set('$$x^2$$', 3);
    const sourceScans = await page.evaluate(() => __mathLexRuns);
    const sourceCalls = await page.evaluate(() => __mathCalls);
    for (const text of ['h', 'han']) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await page.waitForTimeout(180);
    assert.equal(await page.evaluate(() => __mathLexRuns), sourceScans, 'source-mode candidates only map existing colors');
    await cdp.send('Input.insertText', { text: '汉' }); await settle();
    assert.equal(await page.evaluate(() => editor.snapshot().value), '$$x汉^2$$');
    assert((await page.evaluate(() => __mathLexRuns)) > sourceScans, 'committed source input refreshes lexical colors');
    assert.equal(await page.evaluate(() => __mathCalls), sourceCalls, 'source IME does not render a preview');
    await page.keyboard.press('Control+z'); await settle();
    assert.equal(await page.evaluate(() => editor.snapshot().value), '$$x^2$$', 'source IME is one undoable edit');
    await page.keyboard.press('Control+y'); await settle();
    assert.equal(await page.evaluate(() => editor.snapshot().value), '$$x汉^2$$');

    const tall = '$$\n{[\n' + 'x+1\n'.repeat(250) + '(2)]}\n$$';
    await set(tall, 4);
    await page.evaluate(() => {
      const at = editor.view.state.doc.toString().lastIndexOf('(2)');
      editor.view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    }); await settle();
    const tailColors = (await syntaxTokens(page)).filter(token => token.kind.includes('bracket'));
    assert.deepEqual(tailColors.slice(-4).map(token => token.kind), [2, 2, 1, 0].map(level => 'note-live-math-bracket-' + level),
      'visible tail keeps the nesting opened outside the viewport');
    await page.evaluate(() => { editor.setSourceMode(false); editor.focus(); });

    // Source/read-only presentation, folding, and leaving the formula retain the old behavior.
    await set('> [!note]+ Title\n> $$x^2$$\n\nafter'); await previewReady();
    await page.locator('.note-callout-fold').click(); await settle();
    assert.equal(await page.locator('.note-live-math-preview').count(), 0);
    await set(equation); await previewReady();
    await page.evaluate(() => editor.setSourceMode(true)); await settle();
    assert.equal(await page.locator('.note-live-math-preview').count(), 0);
    assert.equal(await page.locator('.note-live-math-delimiter').count(), 2, 'source mode keeps formula boundary colors');
    await page.evaluate(() => { editor.setSourceMode(false); editor.focus(); }); await previewReady();
    await page.evaluate(() => { editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length, head: editor.view.state.doc.length } }); editor.view.contentDOM.blur(); });
    await settle(); assert.equal(await page.locator('.note-live-math-preview').count(), 0);
    await set('inline $x^2$ only', 10); await settle();
    assert.equal(await page.locator('.note-live-math-preview').count(), 0);

    // Visibility cancellation releases all MathItems and resumes only the current formula.
    for (const kind of ['minimize', 'hidden', 'workspace', 'pagehide']) {
      await set('$$x^2$$\n\nafter'); await previewReady();
      await page.evaluate(kind => {
        if (kind === 'minimize') { document.documentElement.dataset.desktopMinimized = '1'; dispatchEvent(new Event('canvasdesktop:visibility')); }
        if (kind === 'hidden') document.querySelector('.note-workspace').hidden = true;
        if (kind === 'workspace') document.dispatchEvent(new CustomEvent('relatum:start-workspacechange', { detail: { workspace: 'canvas' } }));
        if (kind === 'pagehide') dispatchEvent(new Event('pagehide'));
      }, kind);
      await settle();
      assert.equal(await page.evaluate(() => Array.from(MathJax.startup.document.math).length), 0, kind);
      await page.waitForTimeout(180);
      assert.equal(await page.locator('.note-live-math-preview-content').count(), 0, kind);
      await page.evaluate(kind => {
        if (kind === 'minimize') { document.documentElement.dataset.desktopMinimized = '0'; dispatchEvent(new Event('canvasdesktop:visibility')); }
        if (kind === 'hidden') document.querySelector('.note-workspace').hidden = false;
        if (kind === 'workspace') document.dispatchEvent(new CustomEvent('relatum:start-workspacechange', { detail: { workspace: 'notes' } }));
        if (kind === 'pagehide') dispatchEvent(new Event('pageshow'));
      }, kind);
      await previewReady();
    }
    // A delayed typeset cannot populate a new document or retain detached MathItems.
    await page.evaluate(() => {
      const original = MathJax.typesetPromise;
      MathJax.typesetPromise = nodes => new Promise((resolve, reject) => {
        window.__releaseMath = async () => { MathJax.typesetPromise = original; try { resolve(await original.call(MathJax, nodes)); } catch (error) { reject(error); } };
      });
      const at = editor.view.state.doc.toString().indexOf('^') + 1;
      editor.view.dispatch({ changes: { from: at, to: at + 1, insert: '8' } });
    });
    await page.waitForFunction(() => typeof __releaseMath === 'function');
    await page.evaluate(async () => { editor.setDocument({ value: 'ordinary text', notePath: 'other.md' }); await __releaseMath(); delete window.__releaseMath; });
    await settle();
    assert.equal(await page.locator('.note-live-math-preview').count(), 0);
    assert.equal(await page.evaluate(() => Array.from(MathJax.startup.document.math).length), 0);
    const idle = await page.evaluate(() => __mathCalls); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => __mathCalls), idle);
    await set('$$x^2$$\n\nafter'); await previewReady();
    await page.evaluate(() => editor.destroy()); await settle();
    assert.equal(await page.evaluate(() => Array.from(MathJax.startup.document.math).length), 0);
    assert.deepEqual(errors, []);
    const workspace = await checkWorkspace(browser);
    console.log(JSON.stringify({ output, autoload, variants, headingChecks, typing: true, history: true, errors: true, ime: true, lifecycle: true, workspace }));
  } catch (error) {
    console.error('math preview output:', output);
    if (page) {
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      console.error(await page.evaluate(() => ({ value: editor.snapshot().value, html: document.querySelector('.note-live-math-preview')?.outerHTML.slice(0, 1800),
        records: window.MathJax?.startup?.document && Array.from(MathJax.startup.document.math).length, calls: window.__mathCalls })).catch(() => null));
    }
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
