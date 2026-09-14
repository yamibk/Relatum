// Relatum 托管笔记的单表面 Markdown Live Preview。
// Markdown 字符串始终是唯一事实来源；CodeMirror/Lezer 只维护编辑状态和视觉投影。
(function () {
  'use strict';

  const CM = window.RelatumCodeMirror;
  if (!CM) return;

  const INLINE_MATH_LIMIT = 4 * 1024;
  const BLOCK_MATH_LIMIT = 32 * 1024;
  const MERMAID_LIMIT = 64 * 1024;
  const RICH_BLOCK_LIMIT = 256 * 1024;
  const MAX_RICH_LINE = 64 * 1024;
  const VIEWPORT_PARSE_SLICE = 12;
  const MERMAID_LANGS = new Set([
    'mermaid', 'flowchart', 'graph', 'flow', 'sequence', 'sequencediagram',
    'timeline', 'gantt', 'class', 'classdiagram', 'state', 'statediagram',
    'er', 'erdiagram', 'mindmap',
  ]);

  const {
    EditorState, EditorSelection, StateEffect, StateField, EditorView, Decoration, WidgetType, Prec, Compartment,
    ViewPlugin, keymap, drawSelection, dropCursor, highlightSpecialChars,
    rectangularSelection, crosshairCursor, placeholder, highlightActiveLine,
    syntaxTree, forceParsing, indentOnInput,
    bracketMatching, markdown, markdownLanguage, markdownKeymap, history,
    historyKeymap, defaultKeymap, indentWithTab, searchKeymap,
    highlightSelectionMatches, closeBrackets, closeBracketsKeymap,
    relatumCodeLanguages, relatumCodeHighlighting,
  } = CM;
  const focusEffect = StateEffect.define();
  const inputReconcileEffect = StateEffect.define();
  const notePathEffect = StateEffect.define();
  const viewportScanEffect = StateEffect.define();
  const viewportParseRequestEffect = StateEffect.define();
  let nextBlockSpecId = 1;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function selectionTouches(selection, from, to) {
    return selection.ranges.some((range) => range.from <= to && range.to >= from);
  }

  function sameStringSet(left, right) {
    if (left.size !== right.size) return false;
    for (const value of left) if (!right.has(value)) return false;
    return true;
  }

  function sourceFingerprint(source) {
    let hash = 5381;
    const value = String(source || '');
    for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
    return (hash >>> 0).toString(36) + '-' + value.length;
  }

  function isRemoteTarget(target) {
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(String(target || '').trim());
  }

  function isDangerousTarget(target) {
    return /^\s*(?:javascript|data|vbscript):/i.test(String(target || ''));
  }

  function normalizedImageTarget(raw) {
    let target = String(raw || '').trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
    const titled = /^(\S+)[ \t]+(?:"[^"]*"|'[^']*')$/.exec(target);
    if (titled) target = titled[1];
    return target;
  }

  function parseMarkdownImage(text) {
    const markdownMini = window.MarkdownMini;
    const parsed = markdownMini && typeof markdownMini.parseImage === 'function'
      ? markdownMini.parseImage(text) : null;
    return parsed && parsed.syntax === 'markdown' ? parsed : null;
  }

  function parseStandaloneImage(text) {
    const markdownMini = window.MarkdownMini;
    return markdownMini && typeof markdownMini.parseImageBlock === 'function'
      ? markdownMini.parseImageBlock(text)
      : (markdownMini && typeof markdownMini.parseImage === 'function' ? markdownMini.parseImage(text) : null);
  }

  function fenceStart(text) {
    const match = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)[^\n]*$/.exec(text);
    return match ? {
      marker: match[1],
      label: String(match[2] || ''),
      language: String(match[2] || '').toLowerCase(),
    } : null;
  }

  function isFenceEnd(text, opener) {
    const match = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(text);
    return !!match && match[1][0] === opener.marker[0] && match[1].length >= opener.marker.length;
  }

  function sameLineBlockMath(text) {
    const source = String(text || '').trim();
    if (source.length <= 4 || !source.startsWith('$$')) return null;
    for (let index = 2; index < source.length - 1; index += 1) {
      if (source[index] !== '$' || source[index + 1] !== '$' || escapedAt(source, index)) continue;
      if (source.slice(index + 2).trim()) return null;
      const body = source.slice(2, index);
      return body.trim() ? { source, body } : null;
    }
    return null;
  }

  function parseCalloutSource(source) {
    const first = String(source || '').split(/\r?\n/, 1)[0];
    const match = /^\s*(?:>\s*)+\[!([A-Za-z][\w-]*)\]([+-]?)\s*(.*)$/.exec(first);
    if (!match) return null;
    return {
      type: match[1].toLowerCase(),
      suffix: match[2] || '',
      title: match[3].trim(),
      collapsed: match[2] === '-',
    };
  }

  function completeSpec(spec, prior) {
    const source = String(spec.source || '');
    return Object.assign({}, spec, {
      id: prior && prior.id || 'note-block-' + nextBlockSpecId++,
      source,
      fingerprint: sourceFingerprint(source),
    });
  }

  function rangeHasLongLine(doc, from, to) {
    let number = doc.lineAt(from).number;
    const last = doc.lineAt(Math.max(from, to - 1)).number;
    while (number <= last) {
      if (doc.line(number).length > MAX_RICH_LINE) return true;
      number += 1;
    }
    return false;
  }

  function scanBlockSpecs(state, from, to, reusable) {
    const doc = state.doc;
    const specs = [];
    if (!doc.length) return specs;
    const start = clamp(from, 0, doc.length);
    const end = clamp(typeof to === 'number' ? to : doc.length, start, doc.length);
    const raw = [];
    const seen = new Set();
    const protectedBlocks = [];
    const push = (spec) => {
      const key = spec.kind + ':' + spec.from + ':' + spec.to;
      if (seen.has(key)) return;
      seen.add(key); raw.push(spec);
    };

    const tree = syntaxTree(state);
    tree.iterate({
      from: start, to: end,
      enter(node) {
        if (node.name === 'Table') {
          const source = doc.sliceString(node.from, node.to);
          if (source.length <= RICH_BLOCK_LIMIT && !rangeHasLongLine(doc, node.from, node.to)) push({ from: node.from, to: node.to, kind: 'table', source });
          return false;
        }
        if (node.name === 'HorizontalRule') {
          push({ from: node.from, to: node.to, kind: 'rule', source: doc.sliceString(node.from, node.to) });
          return false;
        }
        if (node.name === 'FencedCode') {
          protectedBlocks.push({ from: node.from, to: node.to });
          const opener = fenceStart(doc.lineAt(node.from).text);
          if (!opener) return false;
          const kind = opener.language === 'derive' ? 'derive' : MERMAID_LANGS.has(opener.language) ? 'mermaid' : '';
          const limit = kind === 'mermaid' ? MERMAID_LIMIT : RICH_BLOCK_LIMIT;
          if (!kind || node.to - node.from > limit || !isFenceEnd(doc.lineAt(Math.max(node.from, node.to - 1)).text, opener)) return false;
          if (!rangeHasLongLine(doc, node.from, node.to)) push({ from: node.from, to: node.to, kind, source: doc.sliceString(node.from, node.to), language: opener.language });
          return false;
        }
        if (/^(?:CodeBlock|IndentedCode|HTMLBlock)$/.test(node.name)) {
          protectedBlocks.push({ from: node.from, to: node.to });
          return false;
        }
        if (node.name === 'Blockquote') {
          const source = doc.sliceString(node.from, node.to);
          const callout = parseCalloutSource(source);
          if (callout && source.length <= RICH_BLOCK_LIMIT && !rangeHasLongLine(doc, node.from, node.to)) push(Object.assign({ from: node.from, to: node.to, kind: 'callout', source }, callout));
          return false;
        }
        if (node.name === 'Image') {
          const line = doc.lineAt(node.from);
          if (node.to <= line.to && !doc.sliceString(line.from, node.from).trim() && !doc.sliceString(node.to, line.to).trim()) {
            const image = parseStandaloneImage(line.text);
            if (image && image.target && !isRemoteTarget(image.target) && line.length <= MAX_RICH_LINE) {
              push({
                from: line.from, to: line.to, kind: 'image', source: line.text,
                target: image.target, alt: image.alt, width: image.width, height: image.height,
              });
            }
          }
          return false;
        }
        return undefined;
      },
    });

    // $$ is a Relatum extension rather than a Lezer Markdown block. Its search is
    // deliberately bounded, so an edit can never walk an entire large document.
    const mathFrom = Math.max(0, start - BLOCK_MATH_LIMIT);
    const parsedTo = typeof tree.length === 'number' ? tree.length : doc.length;
    const mathTo = Math.min(doc.length, parsedTo, end + BLOCK_MATH_LIMIT);
    let number = doc.lineAt(mathFrom).number;
    const finalLine = doc.lineAt(mathTo).number;
    while (number <= finalLine) {
      const line = doc.line(number);
      // Ancestor expansion can include a whole long code/HTML block. Its
      // contents cannot contain Markdown math, so skip the known range instead
      // of inspecting every line again on each viewport refresh.
      const protectedBlock = protectedBlocks.find((range) => range.from <= line.from && range.to >= line.to);
      if (protectedBlock) { number = doc.lineAt(protectedBlock.to).number + 1; continue; }
      if (line.length > MAX_RICH_LINE) { number += 1; continue; }
      const standaloneImage = parseStandaloneImage(line.text);
      if (standaloneImage && standaloneImage.target && !isRemoteTarget(standaloneImage.target)) {
        push({
          from: line.from, to: line.to, kind: 'image', source: line.text,
          target: standaloneImage.target, alt: standaloneImage.alt,
          width: standaloneImage.width, height: standaloneImage.height,
        });
        number += 1;
        continue;
      }
      const singleLine = sameLineBlockMath(line.text);
      if (singleLine) {
        const protectedSource = protectedBlocks.some((range) => range.from < line.to && range.to > line.from);
        if (!protectedSource && line.length <= BLOCK_MATH_LIMIT && line.to >= start && line.from <= end) {
          push({ from: line.from, to: line.to, kind: 'math', source: line.text });
        }
        number += 1;
        continue;
      }
      if (line.text.trim() !== '$$') { number += 1; continue; }
      let close = number + 1;
      while (close <= doc.lines && doc.line(close).from - line.from <= BLOCK_MATH_LIMIT && doc.line(close).text.trim() !== '$$') close += 1;
      if (close <= doc.lines && doc.line(close).text.trim() === '$$') {
        const closeLine = doc.line(close);
        const source = doc.sliceString(line.from, closeLine.to);
        const protectedSource = protectedBlocks.some((range) => range.from < closeLine.to && range.to > line.from);
        if (!protectedSource && source.length <= BLOCK_MATH_LIMIT && closeLine.to >= start && line.from <= end) push({ from: line.from, to: closeLine.to, kind: 'math', source });
        number = close + 1;
      } else number += 1;
    }

    raw.sort((a, b) => a.from - b.from || b.to - a.to);
    const pool = Array.isArray(reusable) ? reusable.slice() : [];
    return raw.map((spec) => {
      const index = pool.findIndex((old) => old.kind === spec.kind && old.from <= spec.to && old.to >= spec.from);
      const prior = index >= 0 ? pool.splice(index, 1)[0] : null;
      return completeSpec(spec, prior);
    });
  }

  function changedBounds(transaction) {
    let oldFrom = transaction.startState.doc.length;
    let oldTo = 0;
    let newFrom = transaction.state.doc.length;
    let newTo = 0;
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      oldFrom = Math.min(oldFrom, fromA); oldTo = Math.max(oldTo, toA);
      newFrom = Math.min(newFrom, fromB); newTo = Math.max(newTo, toB);
    });
    return { oldFrom, oldTo, newFrom, newTo };
  }

  function blockSyntaxMayChange(transaction, previous, bounds) {
    if (previous.some((spec) => spec.from <= bounds.oldTo && spec.to >= bounds.oldFrom)) return true;
    let structural = false;
    transaction.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (structural) return;
      const insertedText = inserted.length <= MAX_RICH_LINE ? inserted.sliceString(0) : '\n';
      const removedLength = toA - fromA;
      const removedText = removedLength <= MAX_RICH_LINE ? transaction.startState.doc.sliceString(fromA, toA) : '\n';
      structural = /[\r\n|>$`~!#*_\-\[\](){}]/.test(insertedText) || /[\r\n|>$`~!#*_\-\[\](){}]/.test(removedText);
    });
    return structural;
  }

  function expandScanRange(state, from, to) {
    const doc = state.doc;
    if (!doc.length) return { from: 0, to: 0 };
    let start = doc.lineAt(clamp(from, 0, doc.length));
    let end = doc.lineAt(clamp(to, 0, doc.length));
    if (start.length > MAX_RICH_LINE || end.length > MAX_RICH_LINE) {
      return { from: Math.max(0, clamp(from, 0, doc.length) - 1), to: Math.min(doc.length, clamp(to, 0, doc.length) + 1) };
    }
    if (start.number > 1) start = doc.line(start.number - 1);
    if (end.number < doc.lines) end = doc.line(end.number + 1);
    const tree = syntaxTree(state);
    [clamp(from, 0, doc.length), clamp(to, 0, doc.length)].forEach((position) => {
      let node = tree.resolveInner(position, position === doc.length ? -1 : 1);
      while (node.parent && node.parent.name !== 'Document') node = node.parent;
      if (node && node.name !== 'Document') {
        start = doc.lineAt(Math.min(start.from, node.from));
        end = doc.lineAt(Math.max(end.to, node.to));
      }
    });
    return { from: start.from, to: end.to };
  }

  function updateBlockSpecs(previous, transaction) {
    if (!transaction.docChanged) return previous;
    const bounds = changedBounds(transaction);
    let scanFrom = bounds.newFrom;
    let scanTo = bounds.newTo;
    const mapped = [];
    const reusable = [];
    previous.forEach((spec) => {
      const overlaps = spec.from <= bounds.oldTo && spec.to >= bounds.oldFrom;
      const nextFrom = transaction.changes.mapPos(spec.from, -1);
      const nextTo = transaction.changes.mapPos(spec.to, 1);
      if (overlaps) {
        scanFrom = Math.min(scanFrom, nextFrom);
        scanTo = Math.max(scanTo, nextTo);
        reusable.push(Object.assign({}, spec, { from: nextFrom, to: nextTo }));
      } else {
        mapped.push(Object.assign({}, spec, { from: nextFrom, to: nextTo }));
      }
    });
    if (!blockSyntaxMayChange(transaction, previous, bounds)) {
      return mapped.sort((a, b) => a.from - b.from || a.to - b.to);
    }
    const expanded = expandScanRange(transaction.state, scanFrom, scanTo);
    mapped.forEach((spec) => {
      if (spec.from <= expanded.to && spec.to >= expanded.from) reusable.push(spec);
    });
    const rescanned = scanBlockSpecs(transaction.state, expanded.from, expanded.to, reusable);
    const actualTo = rescanned.reduce((value, spec) => Math.max(value, spec.to), expanded.to);
    const kept = mapped.filter((spec) => spec.to < expanded.from || spec.from > actualTo);
    return kept.concat(rescanned).sort((a, b) => a.from - b.from || a.to - b.to);
  }

  function refreshVisibleBlockSpecs(previous, state, ranges) {
    const visible = Array.isArray(ranges) && ranges.length
      ? ranges
      : [{ from: 0, to: Math.min(state.doc.length, 1) }];
    let from = state.doc.length;
    let to = 0;
    visible.forEach((range) => {
      from = Math.min(from, clamp(range.from, 0, state.doc.length));
      to = Math.max(to, clamp(range.to, 0, state.doc.length));
    });
    const expanded = expandScanRange(state, from, to);
    const reusable = previous.filter((spec) => spec.from <= expanded.to && spec.to >= expanded.from);
    const rescanned = scanBlockSpecs(state, expanded.from, expanded.to, reusable);
    const replaceFrom = rescanned.reduce((value, spec) => Math.min(value, spec.from), expanded.from);
    const replaceTo = rescanned.reduce((value, spec) => Math.max(value, spec.to), expanded.to);
    const kept = previous.filter((spec) => spec.to < replaceFrom || spec.from > replaceTo);
    return kept.concat(rescanned).sort((a, b) => a.from - b.from || a.to - b.to);
  }

  let mathLoadPromise = null;
  function ensureMathJax() {
    if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') return Promise.resolve(window.MathJax);
    if (mathLoadPromise) return mathLoadPromise;
    if (!window.MathJax || typeof window.MathJax !== 'object') {
      window.MathJax = {
        tex: { inlineMath: [['$', '$']], displayMath: [['$$', '$$']], processEscapes: true },
        startup: { typeset: false },
      };
    }
    mathLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/mathjax/tex-mml-chtml.js';
      script.async = true;
      script.dataset.noteMathjax = '1';
      script.onload = () => resolve(window.MathJax);
      script.onerror = reject;
      document.head.appendChild(script);
    });
    return mathLoadPromise;
  }

  class TaskWidget extends WidgetType {
    constructor(checked, from, options) { super(); this.checked = checked; this.from = from; this.options = options; }
    eq(other) { return other.checked === this.checked && other.from === this.from; }
    toDOM(view) {
      const box = document.createElement('input');
      box.type = 'checkbox'; box.checked = this.checked; box.className = 'note-live-task';
      box.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为完成');
      box.addEventListener('mousedown', (event) => event.preventDefault());
      box.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: this.checked ? ' ' : 'x' } });
        view.focus();
      });
      return box;
    }
    ignoreEvent() { return false; }
  }

  class BulletWidget extends WidgetType {
    constructor(ordered, label) { super(); this.ordered = ordered; this.label = label; }
    eq(other) { return other.ordered === this.ordered && other.label === this.label; }
    toDOM() {
      const span = document.createElement('span');
      span.className = 'note-live-list-marker';
      span.textContent = this.ordered ? this.label : '•';
      span.setAttribute('aria-hidden', 'true');
      return span;
    }
  }

  class InlineMathWidget extends WidgetType {
    constructor(source, from, to, coordinator) {
      super(); this.source = source; this.from = from; this.to = to;
      this.coordinator = coordinator; this.epoch = coordinator.epoch;
    }
    eq(other) {
      return other.source === this.source && other.from === this.from && other.to === this.to
        && other.epoch === this.epoch;
    }
    reveal(view, event) {
      if (compositionActive(view)) return;
      if (event) { event.preventDefault(); event.stopPropagation(); }
      const inside = Math.max(this.from + 1, this.to - 1);
      // Atomic ranges intentionally clamp a selection that starts inside the
      // hidden source. First touch the boundary so this widget is removed,
      // then place the real caret in the now-visible formula source.
      view.dispatch({ selection: EditorSelection.cursor(this.from), scrollIntoView: true });
      const doc = view.state.doc;
      requestAnimationFrame(() => {
        if (!view.dom.isConnected || view.state.doc !== doc || compositionActive(view)) return;
        view.dispatch({ selection: EditorSelection.cursor(inside), scrollIntoView: true });
        view.focus();
      });
    }
    toDOM(view) {
      const span = document.createElement('span');
      span.className = 'note-live-inline-math';
      span.textContent = this.source;
      span.setAttribute('aria-label', '点击编辑公式源码');
      span.addEventListener('mousedown', (event) => this.reveal(view, event));
      span.addEventListener('click', (event) => this.reveal(view, event));
      const token = {};
      this.token = token;
      ensureMathJax().then((math) => {
        if (this.token !== token || !span.isConnected || this.coordinator.epoch !== this.epoch) return;
        return runWhenInputSettled(view, () => (
          this.token === token && span.isConnected && this.coordinator.epoch === this.epoch
            ? math.typesetPromise([span]) : undefined
        )).then(() => {
          if (this.token !== token || !span.isConnected || this.coordinator.epoch !== this.epoch) return;
          return runWhenInputSettled(view, () => {
            if (this.token === token && span.isConnected && this.coordinator.epoch === this.epoch) view.requestMeasure();
          });
        });
      }).catch(() => { span.classList.add('is-failed'); });
      return span;
    }
    destroy() { this.token = null; }
    ignoreEvent() { return false; }
  }

  function imageSelectionMatches(viewOrState, from, to) {
    const state = viewOrState && viewOrState.state ? viewOrState.state : viewOrState;
    const range = state.selection.main;
    return !range.empty && range.from === from && range.to === to;
  }

  function currentImageRange(view, from, to) {
    if (from < 0 || to <= from || to > view.state.doc.length) return null;
    const source = view.state.doc.sliceString(from, to);
    const parsed = parseStandaloneImage(source);
    return parsed ? { from: from, to: to, parsed: parsed } : null;
  }

  function imageRangeForLiveMode(state) {
    const selection = state.selection.main;
    const accepts = (from, to) => selection.empty
      ? selection.head > from && selection.head < to
      : selection.from < to && selection.to > from;
    const line = state.doc.lineAt(selection.head);
    const standalone = parseStandaloneImage(line.text);
    if (standalone && !isRemoteTarget(standalone.target) && accepts(line.from, line.to)) {
      return { from: line.from, to: line.to };
    }

    const tree = syntaxTree(state);
    for (const side of [1, -1]) {
      let node = tree.resolveInner(clamp(selection.head, 0, state.doc.length), side);
      while (node && node.name !== 'Image') node = node.parent;
      if (!node || !accepts(node.from, node.to)) continue;
      const parsed = parseMarkdownImage(state.doc.sliceString(node.from, node.to));
      if (parsed && !isRemoteTarget(parsed.target)) return { from: node.from, to: node.to };
    }

    const wiki = /!\[\[[^\]\n]+?\]\]/g;
    let match;
    while ((match = wiki.exec(line.text))) {
      const from = line.from + match.index;
      const to = from + match[0].length;
      const parsed = parseStandaloneImage(match[0]);
      if (parsed && !isRemoteTarget(parsed.target) && accepts(from, to)) return { from: from, to: to };
    }
    return null;
  }

  function exactSelectedImageRange(state) {
    const selection = state.selection.main;
    if (selection.empty) return null;
    const image = imageRangeForLiveMode(state);
    return image && image.from === selection.from && image.to === selection.to ? image : null;
  }

  function adjacentImageRange(state, backward) {
    const selection = state.selection.main;
    if (!selection.empty) return exactSelectedImageRange(state);
    const head = selection.head;
    const line = state.doc.lineAt(head);
    const standaloneAt = (candidate) => {
      if (!candidate) return null;
      const parsed = parseStandaloneImage(candidate.text);
      return parsed && !isRemoteTarget(parsed.target)
        ? { from: candidate.from, to: candidate.to, parsed: parsed }
        : null;
    };
    const current = standaloneAt(line);
    // A block replacement has one visual object but two source boundaries.
    // Either deletion key at either boundary should remove that object whole.
    if (current && (head === line.from || head === line.to)) return current;

    // A block image visually occupies its own line. When the caret is on the
    // adjacent empty line, treat Backspace/Delete as an object operation too,
    // instead of peeling one hidden Markdown delimiter off the image token.
    if (!line.length && head === line.from) {
      const number = line.number + (backward ? -1 : 1);
      if (number >= 1 && number <= state.doc.lines) {
        const neighbour = standaloneAt(state.doc.line(number));
        if (neighbour) return neighbour;
      }
    }

    let node = syntaxTree(state).resolveInner(clamp(head, 0, state.doc.length), backward ? -1 : 1);
    while (node && node.name !== 'Image') node = node.parent;
    if (node && (backward ? node.to === head : node.from === head)) {
      const parsed = parseMarkdownImage(state.doc.sliceString(node.from, node.to));
      if (parsed && !isRemoteTarget(parsed.target)) return { from: node.from, to: node.to, parsed: parsed };
    }

    const wiki = /!\[\[[^\]\n]+?\]\]/g;
    let match;
    while ((match = wiki.exec(line.text))) {
      const from = line.from + match.index;
      const to = from + match[0].length;
      if (backward ? to !== head : from !== head) continue;
      const parsed = parseStandaloneImage(match[0]);
      if (parsed && !isRemoteTarget(parsed.target)) return { from: from, to: to, parsed: parsed };
    }
    return null;
  }

  function applyImageDimensions(frame, parsed) {
    frame.classList.toggle('has-explicit-size', !!parsed.width);
    frame.classList.toggle('has-explicit-box', !!(parsed.width && parsed.height));
    if (!parsed.width) return;
    frame.style.width = 'min(100%,' + parsed.width + 'px)';
    if (parsed.height) frame.style.aspectRatio = parsed.width + ' / ' + parsed.height;
  }

  function createImageTextSizer() {
    const frames = new Set();
    const update = (frame) => {
      if (!frame || !frame.isConnected) return;
      const width = frame.getBoundingClientRect().width;
      if (width > 0) frame.style.setProperty('--note-image-text-unit', (width / 100) + 'px');
    };
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => entries.forEach((entry) => update(entry.target))) : null;
    return {
      observe(frame) {
        if (!frame || frames.has(frame)) return;
        frames.add(frame); update(frame);
        if (observer) observer.observe(frame);
      },
      unobserve(frame) {
        frames.delete(frame);
        if (observer) observer.unobserve(frame);
      },
      update,
      destroy() { if (observer) observer.disconnect(); frames.clear(); },
    };
  }

  function imageTextItemId() {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'image-text-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function createInteractiveImage(owner, view, parsed, notePath, options, resolveRange, block) {
    const initial = resolveRange();
    const frame = document.createElement('span');
    frame.className = 'note-live-image-frame ' + (block ? 'is-block' : 'is-inline');
    frame.setAttribute('role', 'img');
    frame.setAttribute('aria-label', parsed.alt || parsed.target.split('/').pop() || '图片');
    applyImageDimensions(frame, parsed);
    if (initial && imageSelectionMatches(view, initial.from, initial.to)) frame.classList.add('is-selected');

    const image = document.createElement('img');
    image.alt = parsed.alt || parsed.target.split('/').pop() || '';
    image.loading = 'lazy'; image.decoding = 'async';
    image.src = options.imageUrl(notePath, parsed.target);
      image.addEventListener('load', () => {
        if (!frame.isConnected) return;
        if (options.imageTextSizer) options.imageTextSizer.update(frame);
        runWhenInputSettled(view, () => { if (frame.isConnected) view.requestMeasure(); });
      }, { once: true });
    image.addEventListener('error', () => {
      if (!frame.isConnected) return;
      frame.classList.add('is-failed');
      frame.dataset.errorLabel = '图片无法加载 · ' + image.alt;
    }, { once: true });
    frame.appendChild(image);

    const imageTextItems = block && Array.isArray(parsed.imageTextItems) ? parsed.imageTextItems : [];
    const imageTextController = block && parsed.imageTextEditable !== false ? options.imageTextController : null;
    let imageTextLayer = null;
    let imageTextDraftCleanup = null;
    let unregisterImageText = null;

    function currentItems() {
      const current = resolveRange();
      return current && Array.isArray(current.parsed.imageTextItems)
        ? current.parsed.imageTextItems.map((item) => Object.assign({}, item)) : [];
    }

    function commitImageTextItems(items, selectedId) {
      const current = resolveRange();
      const markdownMini = window.MarkdownMini;
      if (!current || !current.parsed.imageTextEditable || !markdownMini
          || typeof markdownMini.serializeImageBlock !== 'function') return false;
      const replacement = markdownMini.serializeImageBlock(current.parsed, items);
      if (!replacement || replacement === current.parsed.source) return false;
      if (imageTextController) imageTextController.prepareRange(current.from, current.from + replacement.length, selectedId || '');
      view.dispatch({
        changes: { from: current.from, to: current.to, insert: replacement },
        selection: EditorSelection.range(current.from, current.from + replacement.length),
        scrollIntoView: true,
        userEvent: 'input.image-text',
      });
      return true;
    }

    function positionStyle(element, item) {
      element.style.left = (item.x * 100) + '%';
      element.style.top = (item.y * 100) + '%';
      element.dataset.imageTextSize = item.size;
      element.dataset.imageTextColor = item.color;
    }

    function clampImageTextPosition(item, element) {
      const imageRect = image.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      if (!imageRect.width || !imageRect.height) return item;
      const halfX = Math.min(.49, elementRect.width / imageRect.width / 2);
      const halfY = Math.min(.49, elementRect.height / imageRect.height / 2);
      return Object.assign({}, item, {
        x: clamp(item.x, halfX, 1 - halfX),
        y: clamp(item.y, halfY, 1 - halfY),
      });
    }

    function cancelDraft() {
      if (imageTextDraftCleanup) imageTextDraftCleanup(false);
    }

    function beginTextEdit(item, point) {
      if (!imageTextLayer || !imageTextController || !imageTextController.active) return;
      cancelDraft();
      const isNew = !item;
      const draft = item ? Object.assign({}, item) : {
        id: imageTextItemId(), text: '', x: point.x, y: point.y,
        size: imageTextController.defaults.size, color: imageTextController.defaults.color,
      };
      const prior = item && Array.from(imageTextLayer.querySelectorAll('[data-image-text-id]'))
        .find((candidate) => candidate.dataset.imageTextId === item.id);
      if (prior) prior.hidden = true;
      const editor = document.createElement('textarea');
      editor.className = 'note-image-text-editor';
      editor.value = draft.text;
      editor.maxLength = 1000;
      editor.rows = 1;
      editor.setAttribute('aria-label', document.documentElement.lang === 'en' ? 'Image text' : '图片文字');
      positionStyle(editor, draft);
      imageTextLayer.appendChild(editor);
      const measurer = document.createElement('span');
      measurer.className = 'note-image-text-box note-image-text-measurer';
      positionStyle(measurer, draft);
      imageTextLayer.appendChild(measurer);
      imageTextController.beginDraft();
      imageTextController.select(draft.id);
      const fit = () => {
        const value = editor.value || '\u200b';
        measurer.textContent = value.endsWith('\n') ? value + '\u200b' : value;
        const measured = measurer.getBoundingClientRect();
        editor.style.width = Math.max(1, Math.ceil(measured.width)) + 'px';
        editor.style.height = Math.max(1, Math.ceil(measured.height)) + 'px';
        const fitted = clampImageTextPosition(draft, editor);
        draft.x = fitted.x; draft.y = fitted.y;
        positionStyle(editor, draft);
      };
      fit();
      let finished = false;
      let textComposing = false;
      let pendingCommit = false;
      let finishFrame = 0;
      let pagePointerPreeditText = null;
      const finish = (commit) => {
        if (finished) return;
        finished = true;
        if (finishFrame) cancelAnimationFrame(finishFrame);
        editor.removeEventListener('blur', onBlur);
        editor.removeEventListener('keydown', onKeyDown);
        editor.removeEventListener('input', fit);
        editor.removeEventListener('compositionstart', onCompositionStart);
        editor.removeEventListener('compositionend', onCompositionEnd);
        document.removeEventListener('pointerdown', onPagePointerDown, true);
        editor.remove();
        measurer.remove();
        if (prior) prior.hidden = false;
        imageTextDraftCleanup = null;
        const text = editor.value.replace(/\r\n?/g, '\n').slice(0, 1000);
        if (!commit || !text.trim()) {
          imageTextController.select(isNew ? '' : draft.id);
          imageTextController.endDraft();
          return;
        }
        const items = currentItems();
        const next = Object.assign({}, draft, { text: text });
        const index = items.findIndex((candidate) => candidate.id === draft.id);
        if (index >= 0) items[index] = next; else items.push(next);
        try {
          commitImageTextItems(items, draft.id);
        } finally {
          imageTextController.endDraft();
        }
      };
      const finishCommittedText = () => {
        if (finished || textComposing) { pendingCommit = true; return; }
        if (finishFrame) cancelAnimationFrame(finishFrame);
        let quietFrames = 0;
        const settle = () => {
          finishFrame = 0;
          if (finished || textComposing) { pendingCommit = true; return; }
          if (quietFrames < 1) {
            quietFrames += 1;
            finishFrame = requestAnimationFrame(settle);
            return;
          }
          pendingCommit = false;
          finish(true);
        };
        finishFrame = requestAnimationFrame(settle);
      };
      const onBlur = () => finishCommittedText();
      const onKeyDown = (event) => {
        event.stopPropagation();
        if (event.isComposing || event.keyCode === 229 || textComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); finish(false); view.focus(); }
        else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault(); finishCommittedText(); view.focus();
        }
      };
      const onCompositionStart = () => {
        pagePointerPreeditText = null;
        textComposing = true;
        if (finishFrame) cancelAnimationFrame(finishFrame);
        finishFrame = 0;
      };
      const onCompositionEnd = () => {
        textComposing = false;
        if (pagePointerPreeditText !== null) {
          // A page-side pointer ends the text box without choosing an OS
          // candidate. Preserve exactly what was visible at pointerdown even
          // if the IME emits a different final input while losing focus.
          editor.value = pagePointerPreeditText;
          pagePointerPreeditText = null;
          fit();
          pendingCommit = true;
        }
        if (pendingCommit || document.activeElement !== editor) finishCommittedText();
      };
      const onPagePointerDown = (event) => {
        if (finished || !textComposing || editor.contains(event.target)) return;
        pagePointerPreeditText = editor.value;
        pendingCommit = true;
        if (view.dom.contains(event.target)) {
          // Do not let CodeMirror replace the selected image range before the
          // textarea has converted its frozen preedit into one image-block
          // transaction. The first blank click finishes the overlay; a later
          // click may place the document caret normally.
          event.preventDefault();
          event.stopImmediatePropagation();
          editor.blur();
        }
      };
      editor.addEventListener('blur', onBlur);
      editor.addEventListener('keydown', onKeyDown);
      editor.addEventListener('input', fit);
      editor.addEventListener('compositionstart', onCompositionStart);
      editor.addEventListener('compositionend', onCompositionEnd);
      document.addEventListener('pointerdown', onPagePointerDown, true);
      ['pointerdown', 'mousedown', 'click', 'dblclick'].forEach((name) => {
        editor.addEventListener(name, (event) => event.stopPropagation());
      });
      imageTextDraftCleanup = finish;
      requestAnimationFrame(() => { editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); });
    }

    function renderImageTextItem(item) {
      const label = document.createElement('span');
      label.className = 'note-image-text-box';
      label.dataset.imageTextId = item.id;
      label.textContent = item.text;
      positionStyle(label, item);
      label.addEventListener('pointerdown', (event) => {
        if (!imageTextController || !imageTextController.active || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        view.focus();
        imageTextController.select(item.id);
        const imageRect = image.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        const halfX = Math.min(.49, labelRect.width / Math.max(1, imageRect.width) / 2);
        const halfY = Math.min(.49, labelRect.height / Math.max(1, imageRect.height) / 2);
        const startX = item.x; const startY = item.y;
        let nextX = startX; let nextY = startY; let moved = false; let finished = false;
        label.classList.add('is-dragging');
        try { label.setPointerCapture(event.pointerId); } catch (captureError) {}
        const remove = () => {
          label.classList.remove('is-dragging');
          label.removeEventListener('pointermove', onMove);
          label.removeEventListener('pointerup', onUp);
          label.removeEventListener('pointercancel', onCancel);
          try { if (label.hasPointerCapture(event.pointerId)) label.releasePointerCapture(event.pointerId); } catch (captureError) {}
        };
        const onMove = (moveEvent) => {
          if (moveEvent.pointerId !== event.pointerId) return;
          const dx = (moveEvent.clientX - event.clientX) / Math.max(1, imageRect.width);
          const dy = (moveEvent.clientY - event.clientY) / Math.max(1, imageRect.height);
          moved = moved || Math.abs(moveEvent.clientX - event.clientX) > 3 || Math.abs(moveEvent.clientY - event.clientY) > 3;
          nextX = clamp(startX + dx, halfX, 1 - halfX);
          nextY = clamp(startY + dy, halfY, 1 - halfY);
          label.style.left = (nextX * 100) + '%'; label.style.top = (nextY * 100) + '%';
        };
        const finish = (commit) => {
          if (finished) return;
          finished = true; remove();
          if (!commit || !moved) { positionStyle(label, item); return; }
          const items = currentItems();
          const index = items.findIndex((candidate) => candidate.id === item.id);
          if (index >= 0) {
            items[index] = Object.assign({}, items[index], { x: nextX, y: nextY });
            commitImageTextItems(items, item.id);
          }
        };
        const onUp = (upEvent) => { if (upEvent.pointerId === event.pointerId) finish(true); };
        const onCancel = (cancelEvent) => { if (cancelEvent.pointerId === event.pointerId) finish(false); };
        label.addEventListener('pointermove', onMove);
        label.addEventListener('pointerup', onUp);
        label.addEventListener('pointercancel', onCancel);
      });
      label.addEventListener('dblclick', (event) => {
        if (!imageTextController || !imageTextController.active) return;
        event.preventDefault(); event.stopPropagation(); beginTextEdit(item);
      });
      imageTextLayer.appendChild(label);
    }

    if (imageTextItems.length || (imageTextController && frame.classList.contains('is-selected'))) {
      imageTextLayer = document.createElement('span');
      imageTextLayer.className = 'note-image-text-layer';
      frame.appendChild(imageTextLayer);
      imageTextItems.forEach(renderImageTextItem);
      if (options.imageTextSizer) options.imageTextSizer.observe(frame);
    }

    if (imageTextController && frame.classList.contains('is-selected')) {
      const adapter = {
        frame,
        setMode(active, armed, selectedId) {
          frame.classList.toggle('is-image-text-mode', !!active);
          frame.classList.toggle('is-image-text-armed', !!(active && armed));
          frame.querySelectorAll('.note-image-text-box').forEach((label) => {
            label.classList.toggle('is-selected', !!active && label.dataset.imageTextId === selectedId);
          });
        },
        command(name, value) {
          if (name === 'add') { imageTextController.arm(); return; }
          const id = imageTextController.selectedId;
          if (!id) return;
          if (name === 'edit') {
            const item = currentItems().find((candidate) => candidate.id === id);
            if (item) beginTextEdit(item);
            return;
          }
          const items = currentItems();
          const index = items.findIndex((candidate) => candidate.id === id);
          if (index < 0) return;
          if (name === 'delete') items.splice(index, 1);
          else if (name === 'size') {
            items[index].size = value;
            const label = Array.from(imageTextLayer.querySelectorAll('.note-image-text-box[data-image-text-id]'))
              .find((candidate) => candidate.dataset.imageTextId === id);
            if (label) {
              positionStyle(label, items[index]);
              items[index] = clampImageTextPosition(items[index], label);
            }
          }
          else if (name === 'color') items[index].color = value;
          else if (name === 'move' && value && Number.isFinite(value.dx) && Number.isFinite(value.dy)) {
            const rect = image.getBoundingClientRect();
            const label = Array.from(imageTextLayer.querySelectorAll('.note-image-text-box[data-image-text-id]'))
              .find((candidate) => candidate.dataset.imageTextId === id);
            items[index].x += value.dx / Math.max(1, rect.width);
            items[index].y += value.dy / Math.max(1, rect.height);
            if (label) items[index] = clampImageTextPosition(items[index], label);
          }
          else return;
          commitImageTextItems(items, name === 'delete' ? '' : id);
        },
        cancelDraft,
      };
      unregisterImageText = imageTextController.register(adapter);
      frame.addEventListener('click', (event) => {
        if (!imageTextController.active || !imageTextController.armed
            || event.target.closest('.note-image-text-box, .note-image-text-editor, .note-live-image-resize-handle')) return;
        event.preventDefault(); event.stopPropagation();
        const rect = image.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        imageTextController.disarm();
        beginTextEdit(null, {
          x: clamp((event.clientX - rect.left) / rect.width, .04, .96),
          y: clamp((event.clientY - rect.top) / rect.height, .04, .96),
        });
      });
    }

    const select = (event) => {
      if (compositionActive(view)) return;
      if (event) { event.preventDefault(); event.stopPropagation(); }
      const current = resolveRange();
      if (!current) return;
      view.dispatch({ selection: EditorSelection.range(current.from, current.to), scrollIntoView: true });
      view.focus();
    };
    frame.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.note-live-image-resize-handle')) return;
      select(event);
    });

    let cleanupResize = null;
    if (frame.classList.contains('is-selected')) {
      const handle = document.createElement('span');
      handle.className = 'note-live-image-resize-handle';
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-label', '等比例调整图片大小');
      frame.appendChild(handle);
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const start = resolveRange();
        if (!start) return;
        const startRect = frame.getBoundingClientRect();
        const line = frame.closest('.cm-line');
        const contentRect = (line || view.contentDOM).getBoundingClientRect();
        const startWidth = startRect.width;
        const maxWidth = Math.max(48, contentRect.right - startRect.left);
        let previewWidth = Math.round(startWidth);
        let finished = false;
        frame.classList.add('is-resizing');
        try { handle.setPointerCapture(event.pointerId); } catch (captureError) {}

        const preview = (clientX) => {
          previewWidth = Math.round(clamp(startWidth + clientX - event.clientX, 48, maxWidth));
          frame.classList.remove('has-explicit-box');
          frame.style.aspectRatio = '';
          frame.style.width = previewWidth + 'px';
          frame.style.maxWidth = '100%';
          view.requestMeasure();
        };
        const removeListeners = () => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onCancel);
          document.removeEventListener('keydown', onKeyDown, true);
          try {
            if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
          } catch (captureError) {}
          cleanupResize = null;
        };
        const cancel = () => {
          if (finished) return;
          finished = true;
          removeListeners();
          frame.classList.remove('is-resizing');
          frame.style.width = '';
          frame.style.maxWidth = '';
          frame.style.aspectRatio = '';
          applyImageDimensions(frame, start.parsed);
          view.requestMeasure();
        };
        const commit = () => {
          if (finished) return;
          finished = true;
          removeListeners();
          const current = resolveRange();
          const markdownMini = window.MarkdownMini;
          if (!current || !markdownMini || typeof markdownMini.serializeImage !== 'function') {
            finished = false; cancel(); return;
          }
          const resizedImage = markdownMini.serializeImage(current.parsed.image || current.parsed, { width: previewWidth });
          const replacement = current.parsed.imageTextItems && typeof markdownMini.serializeImageBlock === 'function'
            ? markdownMini.serializeImageBlock(current.parsed, current.parsed.imageTextItems, resizedImage)
            : resizedImage;
          if (!replacement || replacement === current.parsed.source) {
            frame.classList.remove('is-resizing');
            frame.style.width = '';
            frame.style.maxWidth = '';
            frame.style.aspectRatio = '';
            applyImageDimensions(frame, current.parsed);
            view.requestMeasure();
            return;
          }
          view.dispatch({
            changes: { from: current.from, to: current.to, insert: replacement },
            selection: EditorSelection.range(current.from, current.from + replacement.length),
            scrollIntoView: true,
            userEvent: 'input.image-text',
          });
          view.focus();
        };
        const onMove = (moveEvent) => {
          if (moveEvent.pointerId !== event.pointerId) return;
          moveEvent.preventDefault();
          preview(moveEvent.clientX);
        };
        const onUp = (upEvent) => {
          if (upEvent.pointerId !== event.pointerId) return;
          upEvent.preventDefault();
          commit();
        };
        const onCancel = (cancelEvent) => {
          if (cancelEvent.pointerId === event.pointerId) cancel();
        };
        const onKeyDown = (keyEvent) => {
          if (keyEvent.key !== 'Escape') return;
          keyEvent.preventDefault(); keyEvent.stopPropagation(); cancel();
        };
        cleanupResize = cancel;
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onCancel);
        document.addEventListener('keydown', onKeyDown, true);
      });
    }
    owner.imageCleanup = () => {
      if (cleanupResize) cleanupResize();
      cancelDraft();
      if (unregisterImageText) unregisterImageText();
      if (options.imageTextSizer) options.imageTextSizer.unobserve(frame);
    };
    return frame;
  }

  class InlineImageWidget extends WidgetType {
    constructor(parsed, from, to, selected, notePath, options) {
      super(); this.parsed = parsed; this.from = from; this.to = to; this.selected = selected;
      this.notePath = notePath; this.options = options; this.imageCleanup = null;
    }
    eq(other) {
      return other.from === this.from && other.to === this.to && other.selected === this.selected
        && other.parsed.source === this.parsed.source && other.notePath === this.notePath;
    }
    toDOM(view) {
      return createInteractiveImage(this, view, this.parsed, this.notePath, this.options,
        () => currentImageRange(view, this.from, this.to), false);
    }
    destroy() { if (this.imageCleanup) this.imageCleanup(); this.imageCleanup = null; }
    ignoreEvent() { return false; }
  }

  function safeIsolatedResult(source) {
    const markdownMini = window.MarkdownMini;
    if (!markdownMini || typeof markdownMini.renderResult !== 'function') {
      return { html: '', features: { math: false, mermaid: false }, error: true };
    }
    return markdownMini.renderResult(source, { localImages: true });
  }

  function renderMarkdown(host, source, notePath, options) {
    if (!host) throw new Error('Markdown reading host is required');
    const safeOptions = Object.assign({
      imageUrl(path, target) {
        return '/api/note-asset?note=' + encodeURIComponent(path || '') + '&src=' + encodeURIComponent(target || '');
      },
    }, options || {});
    const epoch = String((Number(host.dataset.noteReadingEpoch) || 0) + 1);
    host.dataset.noteReadingEpoch = epoch;
    if (window.MathJax && typeof window.MathJax.typesetClear === 'function') {
      try { window.MathJax.typesetClear([host]); } catch (error) {}
    }
    if (host.__relatumImageTextSizer) host.__relatumImageTextSizer.destroy();
    const imageTextSizer = createImageTextSizer();
    host.__relatumImageTextSizer = imageTextSizer;
    const result = safeIsolatedResult(String(source || ''));
    const content = document.createElement('article');
    content.className = 'note-reading-content node-text';
    content.innerHTML = result.html;
    content.querySelectorAll('[data-note-image]').forEach((image) => {
      image.src = safeOptions.imageUrl(String(notePath || ''), image.dataset.noteImage || '');
      const frame = image.closest('.md-local-image');
      if (frame && frame.classList.contains('has-image-text')) {
        imageTextSizer.observe(frame);
        image.addEventListener('load', () => imageTextSizer.update(frame), { once: true });
      }
      image.addEventListener('error', () => image.removeAttribute('src'), { once: true });
    });
    content.querySelectorAll('input.md-task-box').forEach((box) => { box.disabled = true; });
    host.replaceChildren(content);
    host.classList.toggle('is-failed', !!result.error);
    const current = () => host.dataset.noteReadingEpoch === epoch && content.isConnected;
    if (result.features && result.features.mermaid && window.MermaidRenderer) {
      window.MermaidRenderer.renderAll(content).catch(() => {
        if (current()) host.classList.add('is-failed');
      });
    }
    if (result.features && result.features.math) {
      ensureMathJax().then((math) => {
        if (!current()) return;
        return math.typesetPromise([content]);
      }).catch(() => { if (current()) host.classList.add('is-failed'); });
    }
    return result;
  }

  function richBlockEditPosition(spec) {
    const source = String(spec && spec.source || '');
    const from = Number(spec && spec.from) || 0;
    if (spec && spec.kind === 'math') {
      const opener = source.indexOf('$$');
      const closer = source.lastIndexOf('$$');
      if (opener >= 0 && closer > opener) {
        let offset = opener + 2;
        if (source[offset] === '\r' && source[offset + 1] === '\n') offset += 2;
        else if (source[offset] === '\n') offset += 1;
        while (offset < closer && /[\t ]/.test(source[offset])) offset += 1;
        return from + Math.min(offset, closer);
      }
    }
    if (spec && (spec.kind === 'mermaid' || spec.kind === 'derive')) {
      const newline = source.indexOf('\n');
      if (newline >= 0) return from + newline + 1;
    }
    if (spec && spec.kind === 'table') {
      const content = /^(\s*\|?\s*)/.exec(source);
      return from + (content ? content[0].length : 0);
    }
    return from;
  }

  class RichBlockWidget extends WidgetType {
    constructor(spec, notePath, options, coordinator, selected) {
      super(); this.spec = spec; this.notePath = notePath; this.options = options; this.coordinator = coordinator;
      this.epoch = coordinator.epoch; this.token = null; this.selected = !!selected; this.imageCleanup = null;
    }
    eq(other) {
      return other.spec.id === this.spec.id && other.spec.fingerprint === this.spec.fingerprint
        && other.notePath === this.notePath && other.epoch === this.epoch && other.selected === this.selected;
    }
    isCurrent(view, wrap, token) {
      if (this.token !== token || !wrap.isConnected || this.coordinator.epoch !== this.epoch) return false;
      const current = this.coordinator.spec(view, this.spec.id);
      return !!current && current.fingerprint === this.spec.fingerprint && current.source === this.spec.source;
    }
    reveal(view, event) {
      if (event) { event.preventDefault(); event.stopPropagation(); }
      if (compositionActive(view)) {
        runWhenInputSettled(view, () => this.reveal(view));
        return;
      }
      const current = this.coordinator.spec(view, this.spec.id);
      if (!current) return;
      const at = clamp(richBlockEditPosition(current), current.from, current.to);
      // See InlineMathWidget.reveal: an atomic projection must be removed
      // before CodeMirror can retain a caret inside its hidden source range.
      view.dispatch({ selection: EditorSelection.cursor(current.from), scrollIntoView: true });
      const doc = view.state.doc;
      requestAnimationFrame(() => {
        if (!view.dom.isConnected || view.state.doc !== doc || compositionActive(view)) return;
        const refreshed = this.coordinator.spec(view, this.spec.id);
        if (!refreshed) return;
        view.dispatch({ selection: EditorSelection.cursor(clamp(at, refreshed.from, refreshed.to)), scrollIntoView: true });
        view.focus();
      });
    }
    toDOM(view) {
      const wrap = document.createElement('div');
      wrap.className = 'note-live-rich-block is-' + this.spec.kind;
      const token = {};
      this.token = token;

      if (this.spec.kind === 'image') {
        const parsed = parseStandaloneImage(this.spec.source);
        if (parsed) {
          wrap.appendChild(createInteractiveImage(this, view, parsed, this.notePath, this.options, () => {
            const current = this.coordinator.spec(view, this.spec.id);
            return current ? currentImageRange(view, current.from, current.to) : null;
          }, true));
        }
      } else if (this.spec.kind === 'math') {
        wrap.tabIndex = 0;
        wrap.setAttribute('aria-label', '点击编辑 ' + this.spec.kind + ' 源码');
        wrap.addEventListener('mousedown', (event) => this.reveal(view, event));
        wrap.addEventListener('click', (event) => this.reveal(view, event));
        wrap.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') this.reveal(view, event); });
        wrap.classList.add('md-math-block');
        wrap.textContent = this.spec.source;
        ensureMathJax().then((math) => {
          if (!this.isCurrent(view, wrap, token)) return;
          return runWhenInputSettled(view, () => (
            this.isCurrent(view, wrap, token) ? math.typesetPromise([wrap]) : undefined
          )).then(() => {
            if (!this.isCurrent(view, wrap, token)) return;
            return runWhenInputSettled(view, () => {
              if (this.isCurrent(view, wrap, token)) view.requestMeasure();
            });
          });
        }).catch(() => wrap.classList.add('is-failed'));
      } else if (this.spec.kind === 'rule') {
        wrap.tabIndex = 0;
        wrap.setAttribute('aria-label', '点击编辑 ' + this.spec.kind + ' 源码');
        wrap.addEventListener('mousedown', (event) => this.reveal(view, event));
        wrap.addEventListener('click', (event) => this.reveal(view, event));
        wrap.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') this.reveal(view, event); });
        wrap.appendChild(document.createElement('hr')).className = 'md-hr';
      } else {
        wrap.tabIndex = 0;
        wrap.setAttribute('aria-label', '点击编辑 ' + this.spec.kind + ' 源码');
        wrap.addEventListener('mousedown', (event) => this.reveal(view, event));
        wrap.addEventListener('click', (event) => this.reveal(view, event));
        wrap.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') this.reveal(view, event); });
        const result = safeIsolatedResult(this.spec.source);
        wrap.innerHTML = result.html;
        wrap.querySelectorAll('[data-note-image]').forEach((image) => {
          image.src = this.options.imageUrl(this.notePath, image.dataset.noteImage || '');
        });
        if (this.spec.kind === 'callout' && this.spec.collapsed) {
          wrap.classList.add('is-collapsed');
          wrap.querySelectorAll('.md-callout-body').forEach((body) => { body.hidden = true; });
        }
        const hasMermaid = this.spec.kind === 'mermaid' || !!(result.features && result.features.mermaid);
        const hasMath = this.spec.kind === 'derive' || !!(result.features && result.features.math);
        if (hasMermaid && window.MermaidRenderer) {
          runWhenInputSettled(view, () => (
            this.isCurrent(view, wrap, token) ? window.MermaidRenderer.renderAll(wrap) : undefined
          )).then(() => {
            if (!this.isCurrent(view, wrap, token)) return;
            return runWhenInputSettled(view, () => {
              if (this.isCurrent(view, wrap, token)) view.requestMeasure();
            });
          }).catch(() => wrap.classList.add('is-failed'));
        }
        if (hasMath) {
          ensureMathJax().then((math) => {
            if (!this.isCurrent(view, wrap, token)) return;
            return runWhenInputSettled(view, () => (
              this.isCurrent(view, wrap, token) ? math.typesetPromise([wrap]) : undefined
            )).then(() => {
              if (!this.isCurrent(view, wrap, token)) return;
              return runWhenInputSettled(view, () => {
                if (this.isCurrent(view, wrap, token)) view.requestMeasure();
              });
            });
          }).catch(() => wrap.classList.add('is-failed'));
        }
      }
      return wrap;
    }
    destroy() { this.token = null; if (this.imageCleanup) this.imageCleanup(); this.imageCleanup = null; }
    ignoreEvent() { return false; }
  }

  class CalloutTitleWidget extends WidgetType {
    constructor(spec, sourceOffset, coordinator) {
      super();
      this.spec = spec;
      this.sourceOffset = sourceOffset;
      this.coordinator = coordinator;
    }
    eq(other) {
      return other.spec.id === this.spec.id
        && other.spec.fingerprint === this.spec.fingerprint
        && other.sourceOffset === this.sourceOffset;
    }
    reveal(view, event) {
      if (event) { event.preventDefault(); event.stopPropagation(); }
      const current = this.coordinator.spec(view, this.spec.id);
      if (!current) return;
      view.dispatch({
        selection: EditorSelection.cursor(Math.min(current.to, current.from + this.sourceOffset)),
        scrollIntoView: true,
      });
      view.focus();
    }
    toDOM(view) {
      const wrap = document.createElement('span');
      wrap.className = 'note-live-callout-title-widget';
      wrap.dataset.callout = this.spec.type || 'note';
      wrap.tabIndex = 0;
      wrap.setAttribute('aria-label', '点击编辑 Callout 源码');
      const rendered = document.createElement('span');
      rendered.innerHTML = safeIsolatedResult(this.spec.source).html;
      const title = rendered.querySelector('.md-callout-title');
      if (title) {
        Array.from(title.childNodes).forEach((node) => wrap.appendChild(node.cloneNode(true)));
      } else {
        wrap.textContent = this.spec.title || this.spec.type || 'Note';
      }
      wrap.addEventListener('mousedown', (event) => this.reveal(view, event));
      wrap.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') this.reveal(view, event);
      });
      return wrap;
    }
    ignoreEvent() { return true; }
  }

  function fencedCodeBody(source) {
    const lines = String(source || '').split('\n');
    const opener = fenceStart(lines[0]);
    const closed = opener && lines.length > 1 && isFenceEnd(lines[lines.length - 1], opener);
    return lines.slice(1, closed ? -1 : undefined).join('\n');
  }

  async function copyPlainText(value) {
    const text = String(value == null ? '' : value);
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      const active = document.activeElement;
      const area = document.createElement('textarea');
      area.value = text;
      area.readOnly = true;
      area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
      document.body.appendChild(area);
      area.select();
      let copied = false;
      try { copied = !!document.execCommand('copy'); } catch (copyError) {}
      area.remove();
      if (active && typeof active.focus === 'function') {
        try { active.focus({ preventScroll: true }); } catch (focusError) { active.focus(); }
      }
      return copied;
    }
  }

  class CodeLanguageWidget extends WidgetType {
    constructor(label, doc, from, to) {
      super(); this.label = String(label || ''); this.doc = doc; this.from = from; this.to = to; this.timer = 0;
    }
    // Keep the immutable document reference. Scrolling/selection must not copy a
    // potentially huge fence just to compare or display its tiny language badge.
    get code() { return fencedCodeBody(this.doc.sliceString(this.from, this.to)); }
    eq(other) { return other.label === this.label && other.doc === this.doc && other.from === this.from && other.to === this.to; }
    toDOM() {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'note-live-code-language';
      button.textContent = this.label;
      const copyLabel = (document.documentElement.lang === 'en' ? 'Copy ' : '复制 ') + this.label + (document.documentElement.lang === 'en' ? ' code' : ' 代码');
      button.title = copyLabel;
      button.setAttribute('aria-label', copyLabel);
      button.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
      button.addEventListener('click', async (event) => {
        event.preventDefault(); event.stopPropagation();
        const copied = await copyPlainText(this.code);
        clearTimeout(this.timer);
        button.classList.toggle('is-copied', copied);
        button.classList.toggle('is-copy-failed', !copied);
        button.dataset.copyState = copied
          ? (document.documentElement.lang === 'en' ? 'Copied' : '已复制')
          : (document.documentElement.lang === 'en' ? 'Copy failed' : '复制失败');
        button.setAttribute('aria-label', button.dataset.copyState);
        this.timer = setTimeout(() => {
          button.classList.remove('is-copied', 'is-copy-failed');
          delete button.dataset.copyState;
          button.setAttribute('aria-label', copyLabel);
        }, 1200);
      });
      return button;
    }
    destroy() { clearTimeout(this.timer); }
    ignoreEvent() { return true; }
  }

  function activeBlockIds(specs, state, focused, composing) {
    const active = new Set();
    if (!focused && !composing) return active;
    specs.forEach((spec) => { if (selectionTouches(state.selection, spec.from, spec.to)) active.add(spec.id); });
    return active;
  }

  function selectedBlockImageIds(specs, state) {
    const selected = new Set();
    specs.forEach((spec) => {
      if (spec.kind === 'image' && imageSelectionMatches(state, spec.from, spec.to)) selected.add(spec.id);
    });
    return selected;
  }

  function usesBlockReplacement(spec) {
    // Callouts deliberately remain CodeMirror-owned lines. Replacing the whole
    // block makes the source range collapse into a widget boundary, so clicks on
    // the neighbouring visual lines can resolve inside the Callout instead.
    return spec && spec.kind !== 'callout';
  }

  function blockIsProjected(spec, activeIds) {
    return usesBlockReplacement(spec) && (spec.kind === 'image' || !activeIds.has(spec.id));
  }

  function createBlockField(notePath, options, coordinator, inputSession) {
    const field = StateField.define({
      create(state) {
        const tree = syntaxTree(state);
        const parsedTo = typeof tree.length === 'number' ? Math.min(state.doc.length, tree.length) : state.doc.length;
        const specs = scanBlockSpecs(state, 0, parsedTo);
        const byId = new Map(specs.map((spec) => [spec.id, spec]));
        const selectedImageIds = selectedBlockImageIds(specs, state);
        const decorations = Decoration.set(specs.filter(usesBlockReplacement).map((spec) => Decoration.replace({
          widget: new RichBlockWidget(spec, notePath(), options, coordinator,
            selectedImageIds.has(spec.id)),
          block: true, inclusive: false, blockId: spec.id,
        }).range(spec.from, spec.to)), true);
        return { specs, byId, activeIds: new Set(), selectedImageIds, focused: false, decorations };
      },
      update(value, transaction) {
        let focused = value.focused;
        transaction.effects.forEach((effect) => { if (effect.is(focusEffect)) focused = !!effect.value; });
        if (inputSession.pending()) {
          // The browser owns the preedit text until compositionend. Preserve
          // all projections and only map their positions through native edits;
          // reparsing/replacing neighbouring blocks can move the IME caret.
          const specs = transaction.docChanged ? value.specs.map((spec) => Object.assign({}, spec, {
            // Rich replacements are non-inclusive. Text inserted exactly before
            // an object shifts it right; text inserted after it stays outside.
            from: transaction.changes.mapPos(spec.from, 1),
            to: transaction.changes.mapPos(spec.to, -1),
          })) : value.specs;
          return Object.assign({}, value, {
            specs, byId: transaction.docChanged ? new Map(specs.map((spec) => [spec.id, spec])) : value.byId,
            selectedImageIds: value.selectedImageIds,
            focused,
            decorations: transaction.docChanged ? value.decorations.map(transaction.changes) : value.decorations,
          });
        }
        let specs = updateBlockSpecs(value.specs, transaction);
        let viewportRefreshed = false;
        let inputReconcileRanges;
        transaction.effects.forEach((effect) => {
          if (!effect.is(viewportScanEffect) && !effect.is(inputReconcileEffect)) return;
          specs = refreshVisibleBlockSpecs(specs, transaction.state, effect.value);
          if (effect.is(inputReconcileEffect)) inputReconcileRanges = effect.value;
          viewportRefreshed = true;
        });
        const notePathChanged = transaction.effects.some((effect) => effect.is(notePathEffect));
        const inputReconciled = inputReconcileRanges !== undefined;
        const selectionChanged = !!transaction.selection;
        if (!transaction.docChanged && !selectionChanged && focused === value.focused && !notePathChanged && !viewportRefreshed) return value;

        const byId = new Map(specs.map((spec) => [spec.id, spec]));
        const activeIds = activeBlockIds(specs, transaction.state, focused, false);
        const selectedImageIds = selectedBlockImageIds(specs, transaction.state);
        const refresh = new Set();
        value.byId.forEach((old, id) => {
          const current = byId.get(id);
          if (!current || old.from !== current.from || old.to !== current.to || old.fingerprint !== current.fingerprint) refresh.add(id);
        });
        byId.forEach((current, id) => { if (!value.byId.has(id)) refresh.add(id); });
        value.activeIds.forEach((id) => { if (!activeIds.has(id)) refresh.add(id); });
        activeIds.forEach((id) => { if (!value.activeIds.has(id)) refresh.add(id); });
        value.selectedImageIds.forEach((id) => { if (!selectedImageIds.has(id)) refresh.add(id); });
        selectedImageIds.forEach((id) => { if (!value.selectedImageIds.has(id)) refresh.add(id); });
        // Mapped widgets still carry their pre-composition source positions.
        // The bounded reconciliation scan refreshes visible widgets once after
        // the browser has committed the candidate text.
        if (notePathChanged) specs.forEach((spec) => refresh.add(spec.id));
        else if (inputReconciled) {
          const ranges = Array.isArray(inputReconcileRanges) ? inputReconcileRanges : [];
          specs.forEach((spec) => {
            if (ranges.some((range) => spec.from <= range.to && spec.to >= range.from)) refresh.add(spec.id);
          });
        }

        let decorations = transaction.docChanged ? value.decorations.map(transaction.changes) : value.decorations;
        if (refresh.size) {
          decorations = decorations.update({
            filter(from, to, decoration) { return !refresh.has(decoration.spec.blockId); },
            add: specs.filter((spec) => blockIsProjected(spec, activeIds) && refresh.has(spec.id)).map((spec) => Decoration.replace({
              widget: new RichBlockWidget(spec, notePath(), options, coordinator,
                selectedImageIds.has(spec.id)),
              block: true, inclusive: false, blockId: spec.id,
            }).range(spec.from, spec.to)),
            sort: true,
          });
        }
        return { specs, byId, activeIds, selectedImageIds, focused, decorations };
      },
      provide: (field) => [
        EditorView.decorations.from(field, (value) => value.decorations),
        EditorView.atomicRanges.of((view) => {
          const value = view.state.field(field, false);
          return value ? value.decorations : Decoration.none;
        }),
      ],
    });
    coordinator.field = field;
    coordinator.spec = (view, id) => {
      const value = view.state.field(field, false);
      return value && value.byId.get(id) || null;
    };
    return field;
  }

  function lineProtectedRanges(state, from, to) {
    const ranges = [];
    const seen = new Set();
    const tree = syntaxTree(state);
    const add = (node) => {
      if (!node || !/^(?:FencedCode|CodeBlock|IndentedCode|InlineCode|HTMLBlock|HTMLTag|URL)$/.test(node.name)) return;
      const key = node.name + ':' + node.from + ':' + node.to;
      if (seen.has(key)) return;
      seen.add(key);
      ranges.push({ from: node.from, to: node.to, kind: node.name });
    };
    tree.iterate({
      from, to,
      enter(node) {
        if (/^(?:FencedCode|CodeBlock|IndentedCode|InlineCode|HTMLBlock|HTMLTag|URL)$/.test(node.name)) {
          add(node);
          return false;
        }
        return undefined;
      },
    });
    // A viewport may begin in the middle of a fenced code block after a table,
    // formula, or image widget changes document geometry. Tree iteration bounded
    // to that viewport does not necessarily visit ancestors that start above it.
    // Resolve both boundaries explicitly so the visible middle lines still know
    // that they belong to code/raw HTML and cannot be mistaken for Markdown.
    [from, Math.max(from, to - 1)].forEach((position) => {
      let node = tree.resolveInner(clamp(position, 0, state.doc.length), position >= state.doc.length ? -1 : 1);
      while (node) {
        add(node);
        node = node.parent;
      }
    });
    return ranges;
  }

  function insideRange(ranges, from, to, pattern) {
    return ranges.some((range) => (!pattern || pattern.test(range.kind)) && range.from < to && range.to > from);
  }

  function compositionActive(view) {
    const session = view && view.__relatumInputSession;
    return !!(view && ((session && session.pending()) || view.compositionStarted || view.composing));
  }

  function runWhenInputSettled(view, callback) {
    if (!compositionActive(view)) return Promise.resolve(callback());
    const session = view && view.__relatumInputSession;
    if (session && typeof session.whenSettled === 'function') {
      return session.whenSettled().then((settled) => settled ? callback() : undefined);
    }
    return new Promise((resolve) => requestAnimationFrame(() => resolve(runWhenInputSettled(view, callback))));
  }

  function constructActive(view, from, to) {
    // IME activity is local to the selection, never a request to expose every
    // Markdown marker in the document.
    return (view.hasFocus || compositionActive(view)) && selectionTouches(view.state.selection, from, to);
  }

  function escapedAt(text, index) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1;
    return slashes % 2 === 1;
  }

  function syntaxNodeForRef(tree, nodeRef) {
    const position = nodeRef.to > nodeRef.from ? Math.min(nodeRef.to - 1, nodeRef.from) : nodeRef.from;
    let node = tree.resolveInner(position, 1);
    while (node && (node.name !== nodeRef.name || node.from !== nodeRef.from || node.to !== nodeRef.to)) node = node.parent;
    return node;
  }

  function ancestorOf(node, pattern) {
    while (node) {
      if (pattern.test(node.name)) return node;
      node = node.parent;
    }
    return null;
  }

  function headingMarkerProjectionEnd(doc, from, to) {
    const line = doc.lineAt(from);
    const before = doc.sliceString(line.from, from);
    if (!/^[\t ]{0,3}$/.test(before)) return to;
    const separator = /^[\t ]+/.exec(doc.sliceString(to, line.to));
    return separator ? to + separator[0].length : to;
  }

  function createInlineDecorations(view, blockField, notePath, options) {
    const ranges = [];
    const seen = new Set();
    const blockValue = view.state.field(blockField);
    const blockSpecs = blockValue.specs;
    const add = (from, to, decoration) => {
      if (from < 0 || to < from || to > view.state.doc.length) return;
      const key = from + ':' + to + ':' + String(decoration.spec && (decoration.spec.class || decoration.spec.widget && decoration.spec.widget.constructor.name || 'replace'));
      if (seen.has(key)) return;
      seen.add(key); ranges.push(decoration.range(from, to));
    };
    const replace = (from, to) => { if (to > from) add(from, to, Decoration.replace({ inclusive: false })); };
    const mark = (from, to, name) => { if (to > from) add(from, to, Decoration.mark({ class: name })); };
    const lineClass = (position, name) => add(position, position, Decoration.line({ class: name }));
    const inactiveBlockAt = (from, to) => blockSpecs.some((spec) => blockIsProjected(spec, blockValue.activeIds) && spec.from < to && spec.to > from);
    const inactiveBlockContains = (from, to) => blockSpecs.some((spec) => blockIsProjected(spec, blockValue.activeIds) && spec.from <= from && spec.to >= to);
    const sourceMark = (from, to, unitFrom, unitTo, role) => {
      if (constructActive(view, unitFrom, unitTo)) mark(from, to, 'note-live-source-mark' + (role ? ' is-' + role : ''));
      else replace(from, to);
    };

    const decoratedSyntax = new Set();
    view.visibleRanges.forEach((visible) => {
      const first = view.state.doc.lineAt(visible.from);
      const last = view.state.doc.lineAt(visible.to);
      const protectedRanges = lineProtectedRanges(view.state, first.from, last.to);
      const tree = syntaxTree(view.state);
      const inactiveCalloutHeaders = [];
      blockSpecs.forEach((spec) => {
        if (spec.kind !== 'callout' || spec.to < first.from || spec.from > last.to) return;
        const startLine = view.state.doc.lineAt(spec.from);
        const endLine = view.state.doc.lineAt(Math.max(spec.from, spec.to - 1));
        const active = blockValue.activeIds.has(spec.id) || constructActive(view, spec.from, spec.to);
        const type = String(spec.type || 'note').replace(/[^a-z0-9-]/g, '') || 'note';
        for (let number = Math.max(first.number, startLine.number); number <= Math.min(last.number, endLine.number); number += 1) {
          let className = 'note-live-callout-line is-callout-' + type;
          if (number === startLine.number) className += ' note-live-callout-first';
          if (number === endLine.number) className += ' note-live-callout-last';
          lineClass(view.state.doc.line(number).from, className);
        }
        if (!active && startLine.number >= first.number && startLine.number <= last.number) {
          const header = /^(\s*(?:>\s*)+)(\[![A-Za-z][\w-]*\][+-]?\s*.*)$/.exec(startLine.text);
          if (header) {
            const from = startLine.from + header[1].length;
            inactiveCalloutHeaders.push({ from, to: startLine.to });
            add(from, startLine.to, Decoration.replace({
              widget: new CalloutTitleWidget(spec, from - spec.from, options.coordinator),
              inclusive: false,
            }));
          }
        }
      });
      protectedRanges.forEach((range) => {
        if (/^(?:FencedCode|CodeBlock|IndentedCode)$/.test(range.kind)) {
          const blockFirst = view.state.doc.lineAt(range.from).number;
          const blockLast = view.state.doc.lineAt(Math.max(range.from, range.to - 1)).number;
          const visibleFirst = Math.max(first.number, blockFirst);
          const visibleLast = Math.min(last.number, blockLast);
          for (let number = visibleFirst; number <= visibleLast; number += 1) {
            let className = 'note-live-code-line';
            if (number === blockFirst) className += ' note-live-code-first';
            if (number === blockLast) className += ' note-live-code-last';
            lineClass(view.state.doc.line(number).from, className);
          }
          if (range.kind === 'FencedCode') {
            const codeNode = ancestorOf(tree.resolveInner(range.from, 1), /^FencedCode$/);
            // Only the fence markers belong to the Markdown projection. The
            // mounted language tree is already highlighted by CodeMirror.
            if (codeNode) {
              for (let child = codeNode.firstChild; child; child = child.nextSibling) {
                if (/^(?:CodeMark|CodeInfo)$/.test(child.name) && child.from >= first.from && child.to <= last.to) {
                  sourceMark(child.from, child.to, range.from, range.to, 'code');
                }
              }
            }
            const openingLine = view.state.doc.line(blockFirst);
            const opener = fenceStart(openingLine.text);
            if (!constructActive(view, range.from, range.to) && opener && opener.label && openingLine.from >= first.from && openingLine.to <= last.to) {
              add(openingLine.to, openingLine.to, Decoration.widget({
                widget: new CodeLanguageWidget(opener.label, view.state.doc, range.from, range.to),
                side: 1,
              }));
            }
          }
        } else if (/^HTML/.test(range.kind)) {
          const blockFirst = view.state.doc.lineAt(range.from).number;
          const blockLast = view.state.doc.lineAt(Math.max(range.from, range.to - 1)).number;
          for (let number = Math.max(first.number, blockFirst); number <= Math.min(last.number, blockLast); number += 1) {
            lineClass(view.state.doc.line(number).from, 'note-live-raw-html-line');
          }
        }
      });
      tree.iterate({
        from: first.from, to: last.to,
        enter(nodeRef) {
          // Protected blocks were handled above, bounded to visible lines. Do
          // not walk all lines again or interpret embedded code as Markdown.
          if (/^(?:FencedCode|CodeBlock|IndentedCode|HTMLBlock|HTMLTag)$/.test(nodeRef.name)) return false;
          const node = syntaxNodeForRef(tree, nodeRef);
          const key = nodeRef.name + ':' + nodeRef.from + ':' + nodeRef.to;
          // Rich block replacements split visibleRanges. An ancestor already seen
          // in an earlier segment can still contain unseen nodes in this segment.
          if (decoratedSyntax.has(key)) return undefined;
          decoratedSyntax.add(key);
          if (nodeRef.name !== 'Document' && view.state.doc.lineAt(nodeRef.from).length > MAX_RICH_LINE) return false;
          if (inactiveBlockContains(nodeRef.from, nodeRef.to)) return false;
          if (inactiveCalloutHeaders.some((range) => range.from <= nodeRef.from && range.to >= nodeRef.to)) return false;

          const heading = /^ATXHeading([1-6])$/.exec(nodeRef.name) || /^SetextHeading([12])$/.exec(nodeRef.name);
          if (heading) {
            const line = view.state.doc.lineAt(nodeRef.from);
            lineClass(line.from, 'note-live-heading note-live-h' + heading[1]);
            if (/^Setext/.test(nodeRef.name)) {
              const markerLine = view.state.doc.lineAt(Math.max(nodeRef.from, nodeRef.to - 1));
              lineClass(markerLine.from, constructActive(view, nodeRef.from, nodeRef.to) ? 'note-live-setext-marker-line' : 'note-live-setext-marker-line is-hidden');
            }
          } else if (nodeRef.name === 'StrongEmphasis') {
            mark(nodeRef.from, nodeRef.to, 'note-live-strong');
          } else if (nodeRef.name === 'Emphasis') {
            mark(nodeRef.from, nodeRef.to, 'note-live-emphasis');
          } else if (nodeRef.name === 'Strikethrough') {
            mark(nodeRef.from, nodeRef.to, 'note-live-strike');
          } else if (nodeRef.name === 'InlineCode') {
            mark(nodeRef.from, nodeRef.to, 'note-live-inline-code');
          } else if (nodeRef.name === 'Escape') {
            // Lezer only emits Escape for punctuation that Markdown can actually
            // escape. Mark just the backslash; invalid escapes and code stay raw.
            mark(nodeRef.from, Math.min(nodeRef.to, nodeRef.from + 1), 'note-live-source-mark is-escape');
          } else if (nodeRef.name === 'Link') {
            const url = node && node.getChild('URL');
            if (url && isDangerousTarget(view.state.doc.sliceString(url.from, url.to))) {
              mark(nodeRef.from, nodeRef.to, 'note-live-dangerous-source');
              return false;
            }
            mark(nodeRef.from, nodeRef.to, 'note-live-link');
          } else if (nodeRef.name === 'Autolink') {
            const url = node && node.getChild('URL');
            if (url) mark(url.from, url.to, 'note-live-link');
          } else if (nodeRef.name === 'Image') {
            const raw = view.state.doc.sliceString(nodeRef.from, nodeRef.to);
            const parsed = parseMarkdownImage(raw);
            if (parsed && parsed.target && !isRemoteTarget(parsed.target) && raw.length <= RICH_BLOCK_LIMIT) {
              add(nodeRef.from, nodeRef.to, Decoration.replace({
                widget: new InlineImageWidget(parsed, nodeRef.from, nodeRef.to,
                  imageSelectionMatches(view, nodeRef.from, nodeRef.to), notePath(), options),
                inclusive: false, relatumAtomic: true,
              }));
              return false;
            } else if (parsed) {
              mark(nodeRef.from, nodeRef.to, 'note-live-image-source');
              return false;
            }
          } else if (nodeRef.name === 'HeaderMark') {
            const unit = ancestorOf(node, /^(?:ATXHeading|SetextHeading)/);
            if (unit) {
              if (constructActive(view, unit.from, unit.to)) {
                mark(nodeRef.from, nodeRef.to, 'note-live-source-mark is-heading');
              } else {
                replace(nodeRef.from, headingMarkerProjectionEnd(view.state.doc, nodeRef.from, nodeRef.to));
              }
            }
          } else if (nodeRef.name === 'EmphasisMark') {
            const unit = ancestorOf(node, /^(?:StrongEmphasis|Emphasis)$/);
            if (unit) sourceMark(nodeRef.from, nodeRef.to, unit.from, unit.to, 'emphasis');
          } else if (nodeRef.name === 'StrikethroughMark') {
            const unit = ancestorOf(node, /^Strikethrough$/);
            if (unit) sourceMark(nodeRef.from, nodeRef.to, unit.from, unit.to, 'emphasis');
          } else if (nodeRef.name === 'CodeMark') {
            const unit = ancestorOf(node, /^(?:InlineCode|FencedCode)$/);
            if (unit) sourceMark(nodeRef.from, nodeRef.to, unit.from, unit.to, 'code');
          } else if (nodeRef.name === 'CodeInfo') {
            const unit = ancestorOf(node, /^FencedCode$/);
            if (unit) sourceMark(nodeRef.from, nodeRef.to, unit.from, unit.to, 'code');
          } else if (nodeRef.name === 'LinkMark') {
            const unit = ancestorOf(node, /^(?:Link|Image|Autolink)$/);
            const calloutSpec = blockSpecs.find((item) => item.kind === 'callout' && blockValue.activeIds.has(item.id)
              && item.from <= nodeRef.from && item.to >= nodeRef.to);
            if (calloutSpec) mark(nodeRef.from, nodeRef.to, 'note-live-source-mark is-callout');
            else if (unit) sourceMark(nodeRef.from, nodeRef.to, unit.from, unit.to, 'link');
          } else if (nodeRef.name === 'URL') {
            const unit = ancestorOf(node, /^(?:Link|Image|Autolink)$/);
            if (unit && unit.name !== 'Autolink') sourceMark(nodeRef.from, nodeRef.to, unit.from, unit.to, 'link');
          } else if (nodeRef.name === 'ListMark') {
            const line = view.state.doc.lineAt(nodeRef.from);
            lineClass(line.from, 'note-live-list-line');
            const unit = ancestorOf(node, /^ListItem$/) || node;
            if (constructActive(view, unit.from, unit.to)) mark(nodeRef.from, nodeRef.to, 'note-live-source-mark is-list');
            else if (unit && unit.getChild('Task') && !/^\d/.test(view.state.doc.sliceString(nodeRef.from, nodeRef.to))) {
              // An unordered task uses its checkbox as the list marker. Keep
              // indentation, but do not display a second bullet beside it.
              const gap = /^[\t ]*/.exec(view.state.doc.sliceString(nodeRef.to, line.to))[0];
              replace(nodeRef.from, nodeRef.to + gap.length);
            } else add(nodeRef.from, nodeRef.to, Decoration.replace({
              widget: new BulletWidget(/^\d/.test(view.state.doc.sliceString(nodeRef.from, nodeRef.to)), view.state.doc.sliceString(nodeRef.from, nodeRef.to)),
              inclusive: false,
            }));
          } else if (nodeRef.name === 'TaskMarker') {
            const unit = ancestorOf(node, /^ListItem$/) || node;
            if (constructActive(view, unit.from, unit.to)) mark(nodeRef.from, nodeRef.to, 'note-live-source-mark is-list');
            else {
              const marker = view.state.doc.sliceString(nodeRef.from, nodeRef.to);
              add(nodeRef.from, nodeRef.to, Decoration.replace({
                widget: new TaskWidget(/x/i.test(marker), nodeRef.from, options), inclusive: false,
              }));
            }
          } else if (nodeRef.name === 'QuoteMark') {
            const unit = ancestorOf(node, /^Blockquote$/) || node;
            const line = view.state.doc.lineAt(nodeRef.from);
            const spec = blockSpecs.find((item) => item.kind === 'callout' && item.from <= nodeRef.from && item.to >= nodeRef.to);
            if (!spec) lineClass(line.from, 'note-live-quote-line');
            sourceMark(nodeRef.from, nodeRef.to, unit.from, unit.to, spec ? 'callout' : 'quote');
          } else if (nodeRef.name === 'TableDelimiter') {
            const unit = ancestorOf(node, /^Table$/) || node;
            sourceMark(nodeRef.from, nodeRef.to, unit.from, unit.to, 'table');
          }
          return undefined;
        },
      });

      const visited = new Set();
      for (let number = first.number; number <= last.number; number += 1) {
        const line = view.state.doc.line(number);
        if (visited.has(line.from)) continue;
        visited.add(line.from);
        if (line.length > MAX_RICH_LINE) {
          lineClass(line.from, 'note-live-long-source-line');
          continue;
        }
        if (inactiveBlockAt(line.from, Math.max(line.from + 1, line.to))) continue;
        const lineIsBlockMath = blockSpecs.some((spec) => spec.kind === 'math' && spec.from <= line.to && spec.to >= line.from);
        if (lineIsBlockMath) {
          lineClass(line.from, 'note-live-math-source');
          continue;
        }
        const text = line.text;
        const lineIsCode = protectedRanges.some((range) => /^(?:FencedCode|CodeBlock|IndentedCode)$/.test(range.kind) && range.from <= line.from && range.to >= line.to);
        const lineIsHtml = protectedRanges.some((range) => /^HTML/.test(range.kind) && range.from <= line.from && range.to >= line.to);
        if (lineIsCode) continue;
        if (lineIsHtml || /^\s*<\/?[A-Za-z][^>]*>/.test(text)) {
          lineClass(line.from, 'note-live-raw-html-line');
          continue;
        }

        const localProtected = [];
        const protect = (from, to) => localProtected.push({ from, to });
        const isProtected = (from, to) => localProtected.some((item) => item.from < to && item.to > from)
          || insideRange(protectedRanges, from, to);

        function matches(regex, callback) {
          regex.lastIndex = 0;
          let match;
          while ((match = regex.exec(text))) {
            const from = line.from + match.index;
            const to = from + match[0].length;
            if (!escapedAt(text, match.index) && !isProtected(from, to)) callback(match, from, to);
            if (!match[0].length) regex.lastIndex += 1;
          }
        }

        matches(/!\[\[[^\]\n]+?\]\]/g, (match, from, to) => {
          const parsed = parseStandaloneImage(match[0]);
          protect(from, to);
          if (parsed && parsed.target && !isRemoteTarget(parsed.target)) {
            add(from, to, Decoration.replace({
              widget: new InlineImageWidget(parsed, from, to, imageSelectionMatches(view, from, to), notePath(), options),
              relatumAtomic: true,
            }));
          } else mark(from, to, 'note-live-image-source');
        });

        matches(/\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g, (match, from, to) => {
          protect(from, to); mark(from, to, 'note-live-wikilink');
          if (!constructActive(view, from, to)) {
            replace(from, from + 2); replace(to - 2, to);
            if (match[2]) replace(from + 2, from + 2 + match[1].length + 1);
          } else {
            mark(from, from + 2, 'note-live-source-mark is-link');
            mark(to - 2, to, 'note-live-source-mark is-link');
          }
        });

        matches(/\$([^$\n]+)\$/g, (match, from, to) => {
          if (text[match.index - 1] === '$' || text[match.index + match[0].length] === '$' || escapedAt(text, match.index + match[0].length - 1)) return;
          if (match[0].length > INLINE_MATH_LIMIT) return;
          protect(from, to);
          if (!constructActive(view, from, to)) add(from, to, Decoration.replace({
            widget: new InlineMathWidget(match[0], from, to, options.coordinator), relatumAtomic: true,
          }));
          else {
            mark(from, to, 'note-live-math-source');
            mark(from, from + 1, 'note-live-source-mark is-math');
            mark(to - 1, to, 'note-live-source-mark is-math');
          }
        });

        matches(/\{(hl|tc|fs):([a-z]+)\|([^{}\n]+)\}/g, (match, from, to) => {
          const contentFrom = from + match[0].indexOf('|') + 1;
          const className = 'note-live-' + match[1] + '-' + match[2];
          mark(contentFrom, to - 1, className);
          if (!constructActive(view, from, to)) { replace(from, contentFrom); replace(to - 1, to); }
          else { mark(from, contentFrom, 'note-live-source-mark'); mark(to - 1, to, 'note-live-source-mark'); }
        });

        matches(/==([^=\n]+)==/g, (match, from, to) => {
          mark(from + 2, to - 2, 'note-live-highlight');
          if (!constructActive(view, from, to)) { replace(from, from + 2); replace(to - 2, to); }
          else { mark(from, from + 2, 'note-live-source-mark'); mark(to - 2, to, 'note-live-source-mark'); }
        });

        const callout = parseCalloutSource(text);
        if (callout) {
          const marker = /\[![A-Za-z][\w-]*\][+-]?/.exec(text);
          if (marker) mark(line.from + marker.index, line.from + marker.index + marker[0].length, 'note-live-source-mark is-callout');
        }
      }
    });
    return Decoration.set(ranges, true);
  }

  function atomicDecorationSubset(decorations, length) {
    const ranges = [];
    decorations.between(0, length, (from, to, decoration) => {
      if (decoration.spec && decoration.spec.relatumAtomic) ranges.push(decoration.range(from, to));
    });
    return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
  }

  function createInlinePlugin(blockField, notePath, options) {
    const plugin = ViewPlugin.fromClass(class {
      constructor(view) {
        this.decorations = createInlineDecorations(view, blockField, notePath, options);
        this.atomic = atomicDecorationSubset(this.decorations, view.state.doc.length);
        this.compositionPending = false;
      }
      update(update) {
        if (compositionActive(update.view)) {
          this.decorations = this.decorations.map(update.changes);
          this.atomic = this.atomic.map(update.changes);
          this.compositionPending = true;
          return;
        }
        const lifecycleChanged = update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(inputReconcileEffect) || effect.is(focusEffect) || effect.is(notePathEffect) || effect.is(viewportScanEffect) || effect.is(viewportParseRequestEffect)));
        const syntaxChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
        if (this.compositionPending || update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || lifecycleChanged || syntaxChanged) {
          this.compositionPending = false;
          this.decorations = createInlineDecorations(update.view, blockField, notePath, options);
          this.atomic = atomicDecorationSubset(this.decorations, update.state.doc.length);
        }
      }
    }, {
      decorations: (value) => value.decorations,
      provide: (extension) => EditorView.atomicRanges.of((view) => {
        const value = view.plugin(extension);
        return value ? value.atomic : Decoration.none;
      }),
    });
    return plugin;
  }

  function createViewportParsePlugin() {
    return ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view;
        this.frame = 0;
        this.stopped = false;
        this.rerun = false;
        this.settlePasses = 0;
        this.onScroll = () => this.schedule();
        view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
        this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.schedule()) : null;
        if (this.resizeObserver) {
          this.resizeObserver.observe(view.dom);
          this.resizeObserver.observe(view.contentDOM);
        }
        this.schedule();
      }
      update(update) {
        const explicitlyRequested = update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(viewportParseRequestEffect)));
        if (update.docChanged || update.viewportChanged || explicitlyRequested) this.schedule();
      }
      schedule() {
        if (this.stopped) return;
        // Replacing a source table/formula with a widget can move the blocks below
        // it into the viewport after this pass has already chosen visibleRanges.
        // Always take one bounded follow-up pass against the settled geometry.
        this.settlePasses = Math.max(this.settlePasses, 1);
        this.queueFrame();
      }
      queueFrame() {
        if (this.stopped) return;
        if (this.frame) {
          this.rerun = true;
          return;
        }
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          this.rerun = false;
          this.parseViewport();
          if (this.rerun) this.queueFrame();
        });
      }
      parseViewport() {
        const view = this.view;
        if (this.stopped || !view.dom.isConnected) return;
        // compositionend explicitly schedules a fresh pass. Do not force the
        // parser or replace DOM while Windows is still editing a candidate.
        if (compositionActive(view)) return;
        const target = Math.min(view.state.doc.length, view.viewport.to + BLOCK_MATH_LIMIT);
        const complete = typeof forceParsing !== 'function' || forceParsing(view, target, VIEWPORT_PARSE_SLICE);
        if (!complete) {
          this.rerun = true;
          return;
        }
        const ranges = (view.visibleRanges && view.visibleRanges.length ? view.visibleRanges : [view.viewport])
          .map((range) => ({
            from: Math.max(0, range.from - BLOCK_MATH_LIMIT),
            to: Math.min(view.state.doc.length, range.to + BLOCK_MATH_LIMIT),
          }));
        view.dispatch({ effects: viewportScanEffect.of(ranges) });
        if (this.settlePasses > 0) {
          this.settlePasses -= 1;
          this.rerun = true;
        }
      }
      destroy() {
        this.stopped = true;
        this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.rerun = false;
        this.settlePasses = 0;
      }
    });
  }

  function wrapSelection(view, before, after, placeholderText) {
    const transaction = view.state.changeByRange((range) => {
      const selected = view.state.doc.sliceString(range.from, range.to);
      const body = selected || placeholderText || '';
      return {
        changes: { from: range.from, to: range.to, insert: before + body + after },
        range: EditorSelection.range(range.from + before.length, range.from + before.length + body.length),
      };
    });
    view.dispatch(Object.assign({}, transaction, { userEvent: 'input' }));
    return true;
  }

  function wrapCodeBlock(view) {
    const transaction = view.state.changeByRange((range) => {
      const doc = view.state.doc;
      const selected = doc.sliceString(range.from, range.to);
      const leadingBreak = range.from > 0 && doc.sliceString(range.from - 1, range.from) !== '\n' ? '\n' : '';
      const trailingBreak = range.to < doc.length && doc.sliceString(range.to, range.to + 1) !== '\n' ? '\n' : '';
      const bodyBreak = selected ? (selected.endsWith('\n') ? '' : '\n') : '\n';
      const insert = leadingBreak + '```\n' + selected + bodyBreak + '```' + trailingBreak;
      const contentFrom = range.from + leadingBreak.length + 4;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: selected
          ? EditorSelection.range(contentFrom, contentFrom + selected.length)
          : EditorSelection.cursor(contentFrom),
      };
    });
    view.dispatch(Object.assign({}, transaction, { userEvent: 'input' }));
    return true;
  }

  function exitEmptyQuoteMarkup(view) {
    if (!view || !view.state || view.state.selection.ranges.length !== 1) return false;
    const range = view.state.selection.main;
    if (!range.empty) return false;
    const line = view.state.doc.lineAt(range.head);
    const text = line.text;
    const match = /^([ \t]{0,3})((?:>[ \t]*)+)$/.exec(text);
    if (!match || text.slice(range.head - line.from).trim()) return false;
    const markerStart = match[1].length;
    const finalMarker = text.lastIndexOf('>');
    if (finalMarker < markerStart) return false;
    const replacement = finalMarker === markerStart
      ? ''
      : text.slice(0, finalMarker).replace(/[ \t]*$/, ' ');
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: replacement },
      selection: EditorSelection.cursor(line.from + replacement.length),
      userEvent: 'input',
    });
    return true;
  }

  function linkAt(state, position) {
    const line = state.doc.lineAt(position);
    const wiki = /\[\[([^\]\n]+)\]\]/g;
    let match;
    while ((match = wiki.exec(line.text))) {
      const from = line.from + match.index;
      const to = from + match[0].length;
      if (position >= from && position <= to) return { kind: 'wiki', target: match[1], from, to };
    }
    let node = syntaxTree(state).resolveInner(position, 1);
    while (node && !/^(?:Link|Autolink)$/.test(node.name)) node = node.parent;
    if (node) {
      const url = node.getChild('URL');
      if (url) return { kind: 'url', target: state.doc.sliceString(url.from, url.to), from: node.from, to: node.to };
    }
    return null;
  }

  function create(host, options) {
    if (host && !host.nodeType && !options) { options = host; host = options.host; }
    options = options || {};
    if (!host) throw new Error('Live Preview host is required');
    let currentPath = String(options.notePath || '');
    let suppressChanges = false;
    let documentSetSeq = 0;
    let destroyed = false;
    let pendingSourceMode = null;
    let pendingShortcutBindings = null;
    let pendingDocumentState = null;
    let pendingDocumentWait = false;
    let sourceMode = !!options.sourceMode;
    const coordinator = { epoch: 1, field: null, spec() { return null; } };
    const imageTextSizer = createImageTextSizer();
    const safeOptions = Object.assign({
      imageUrl(notePath, target) {
        return '/api/note-asset?note=' + encodeURIComponent(notePath || '') + '&src=' + encodeURIComponent(target || '');
      },
      onDocChanged() {}, onSaveRequest() {}, onOpenWiki() {}, onOpenExternal() {}, onImageFiles() {},
      onImageSelectionChange() {}, onImageTextDefaultsChange() {},
      imageTextDefaults: { size: 'md', color: 'white' },
    }, options);
    const inputSession = {
      phase: 'idle',
      dirty: false,
      frame: 0,
      sequence: 0,
      stableFrames: 0,
      waiters: [],
      committedDoc: null,
      committedAnchor: 0,
      committedHead: 0,
      committedScrollTop: 0,
      pending() { return this.phase !== 'idle'; },
      capture(view) {
        if (!view || this.pending()) return;
        const main = view.state.selection.main;
        this.committedDoc = view.state.doc;
        this.committedAnchor = main.anchor;
        this.committedHead = main.head;
        this.committedScrollTop = view.scrollDOM.scrollTop;
      },
      begin(view) {
        const carriedDirty = this.pending() && this.dirty;
        this.cancelFinish();
        if (this.phase === 'idle') this.capture(view);
        this.phase = 'composing';
        this.dirty = carriedDirty;
        this.stableFrames = 0;
        host.dataset.inputPhase = this.phase;
        host.classList.add('is-composing');
      },
      changed() { if (this.pending()) this.dirty = true; },
      cancelFinish() {
        this.sequence += 1;
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = 0;
      },
      end(view) {
        if (this.phase === 'idle') return;
        this.cancelFinish();
        this.phase = 'settling';
        this.stableFrames = 0;
        host.dataset.inputPhase = this.phase;
        const sequence = this.sequence;
        const settle = () => {
          this.frame = 0;
          if (destroyed || sequence !== this.sequence || !view.dom.isConnected) return;
          if (view.compositionStarted || view.composing) {
            this.stableFrames = 0;
            this.frame = requestAnimationFrame(settle);
            return;
          }
          // Chromium may flush the final DOM mutation in a microtask after
          // compositionend. Require two quiet animation frames before Relatum
          // is allowed to rebuild projections or expose the value to saving.
          if (this.stableFrames < 1) {
            this.stableFrames += 1;
            this.frame = requestAnimationFrame(settle);
            return;
          }
          this.finish(view);
        };
        this.frame = requestAnimationFrame(settle);
      },
      finish(view) {
        const changed = this.dirty;
        this.cancelFinish();
        this.phase = 'idle';
        this.dirty = false;
        this.stableFrames = 0;
        delete host.dataset.inputPhase;
        host.classList.remove('is-composing');
        this.capture(view);
        const ranges = (view.visibleRanges && view.visibleRanges.length ? view.visibleRanges : [view.viewport])
          .map((range) => ({ from: range.from, to: range.to }));
        view.dispatch({ effects: [inputReconcileEffect.of(ranges), focusEffect.of(view.hasFocus)] });
        if (changed) notifyDocChanged(view);
        if (pendingSourceMode !== null) {
          const next = pendingSourceMode;
          pendingSourceMode = null;
          setSourceMode(next);
        }
        if (pendingShortcutBindings !== null) {
          const next = pendingShortcutBindings;
          pendingShortcutBindings = null;
          setShortcutBindings(next);
        }
        const waiters = this.waiters.splice(0);
        waiters.forEach((resolve) => resolve(true));
      },
      reset(view) {
        this.cancelFinish();
        this.phase = 'idle';
        this.dirty = false;
        this.stableFrames = 0;
        delete host.dataset.inputPhase;
        host.classList.remove('is-composing');
        this.capture(view);
        const waiters = this.waiters.splice(0);
        waiters.forEach((resolve) => resolve(false));
      },
      whenSettled() {
        return this.pending() ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve(true);
      },
      snapshot(view) {
        if (!this.pending()) this.capture(view);
        const doc = this.committedDoc || view.state.doc;
        return {
          value: doc.toString(),
          anchor: this.committedAnchor,
          head: this.committedHead,
          scrollTop: this.pending() ? this.committedScrollTop : view.scrollDOM.scrollTop,
        };
      },
      destroy() {
        this.cancelFinish();
        this.phase = 'idle';
        const waiters = this.waiters.splice(0);
        waiters.forEach((resolve) => resolve(false));
      },
    };
    const requestedImageTextDefaults = safeOptions.imageTextDefaults || {};
    const imageTextSizes = ['sm', 'md', 'lg', 'xl'];
    const imageTextColors = ['black', 'white', 'yellow', 'orange', 'red', 'purple', 'blue', 'cyan', 'green', 'gray'];
    const imageTextController = {
      active: false,
      armed: false,
      available: false,
      selectedId: '',
      activeRange: null,
      pendingRange: null,
      adapter: null,
      draftActive: false,
      draftWaiters: [],
      defaults: {
        size: imageTextSizes.includes(requestedImageTextDefaults.size) ? requestedImageTextDefaults.size : 'md',
        color: imageTextColors.includes(requestedImageTextDefaults.color) ? requestedImageTextDefaults.color : 'white',
      },
      persistDefaults() {
        safeOptions.onImageTextDefaultsChange({ size: this.defaults.size, color: this.defaults.color });
      },
      beginDraft() { this.draftActive = true; },
      endDraft() {
        this.draftActive = false;
        const waiters = this.draftWaiters.splice(0);
        waiters.forEach((resolve) => resolve(true));
      },
      whenSettled() {
        return this.draftActive ? new Promise((resolve) => this.draftWaiters.push(resolve)) : Promise.resolve(true);
      },
      notify() {
        const selected = this.adapter && this.selectedId
          ? Array.from(this.adapter.frame.querySelectorAll('[data-image-text-id]'))
            .find((candidate) => candidate.dataset.imageTextId === this.selectedId) : null;
        safeOptions.onImageSelectionChange({
          available: !!this.available,
          active: !!this.active,
          armed: !!this.armed,
          selectedId: this.selectedId,
          size: selected ? selected.dataset.imageTextSize : this.defaults.size,
          color: selected ? selected.dataset.imageTextColor : this.defaults.color,
          canDelete: !!selected,
        });
      },
      render() {
        host.classList.toggle('is-image-text-mode', this.active);
        if (this.adapter) this.adapter.setMode(this.active, this.armed, this.selectedId);
        this.notify();
      },
      register(adapter) {
        this.adapter = adapter;
        adapter.setMode(this.active, this.armed, this.selectedId);
        this.notify();
        return () => { if (this.adapter === adapter) this.adapter = null; };
      },
      prepareRange(from, to, selectedId) {
        this.pendingRange = { from, to };
        this.activeRange = { from, to };
        this.selectedId = selectedId || '';
      },
      syncSelection(view) {
        const range = !sourceMode ? exactSelectedImageRange(view.state) : null;
        let available = false;
        if (range) {
          const line = view.state.doc.lineAt(range.from);
          const parsed = range.from === line.from && range.to === line.to ? parseStandaloneImage(line.text) : null;
          available = !!(parsed && !isRemoteTarget(parsed.target) && parsed.imageTextEditable !== false);
        }
        this.available = available;
        if (this.pendingRange && range && range.from === this.pendingRange.from && range.to === this.pendingRange.to) {
          this.activeRange = { from: range.from, to: range.to };
          this.pendingRange = null;
        } else if (this.active && (!range || !this.activeRange
                   || range.from !== this.activeRange.from || range.to !== this.activeRange.to)) {
          this.setActive(false);
          return;
        }
        if (!available && this.active) { this.setActive(false); return; }
        this.notify();
      },
      setActive(value, view) {
        const next = !!value && this.available;
        if (next && view) {
          const range = exactSelectedImageRange(view.state);
          this.activeRange = range ? { from: range.from, to: range.to } : null;
        }
        if (!next) {
          if (this.adapter) this.adapter.cancelDraft();
          this.armed = false; this.selectedId = ''; this.activeRange = null; this.pendingRange = null;
        }
        this.active = next;
        this.render();
        return this.active;
      },
      select(id) {
        this.selectedId = id || '';
        this.armed = false;
        this.render();
      },
      arm() { if (this.active) { this.selectedId = ''; this.armed = true; this.render(); } },
      disarm() { if (this.armed) { this.armed = false; this.render(); } },
      command(name, value) {
        if (!this.active) return false;
        if (name === 'size' && !imageTextSizes.includes(value)) return false;
        if (name === 'color' && !imageTextColors.includes(value)) return false;
        if ((name === 'size' || name === 'color') && !this.selectedId) {
          if (name === 'size' && imageTextSizes.includes(value)) this.defaults.size = value;
          if (name === 'color' && imageTextColors.includes(value)) this.defaults.color = value;
          this.persistDefaults();
          this.render();
          return true;
        }
        if (!this.adapter) return false;
        this.adapter.command(name, value);
        if (name === 'size' && imageTextSizes.includes(value)) this.defaults.size = value;
        if (name === 'color' && imageTextColors.includes(value)) this.defaults.color = value;
        if (name === 'size' || name === 'color') this.persistDefaults();
        return true;
      },
    };
    safeOptions.imageTextController = imageTextController;
    safeOptions.imageTextSizer = imageTextSizer;
    safeOptions.coordinator = coordinator;
    const notePath = () => currentPath;
    const blockField = createBlockField(notePath, safeOptions, coordinator, inputSession);
    const inlinePlugin = createInlinePlugin(blockField, notePath, safeOptions);
    const viewportParsePlugin = createViewportParsePlugin();
    const livePreviewCompartment = new Compartment();
    const editorLabelCompartment = new Compartment();
    const shortcutCompartment = new Compartment();
    const shortcutRegistry = window.RelatumNoteShortcuts || null;
    const fallbackShortcutDefaults = Object.freeze({
      save: ['Mod-s'], bold: ['Mod-b'], italic: ['Mod-i'], strike: [], highlight: [], link: ['Mod-k'],
      'inline-code': ['Mod-`'], 'code-block': ['Mod-Shift-k'],
    });

    function normalizedShortcutBindings(bindings) {
      if (shortcutRegistry) return shortcutRegistry.cloneBindings(bindings || shortcutRegistry.defaultBindings());
      const next = {};
      Object.keys(fallbackShortcutDefaults).forEach((id) => {
        next[id] = Array.isArray(bindings && bindings[id])
          ? bindings[id].filter((key) => typeof key === 'string' && key)
          : fallbackShortcutDefaults[id].slice();
      });
      return next;
    }

    let currentShortcutBindings = normalizedShortcutBindings(options.shortcutBindings);

    function syncImageSelectionClass(view) {
      if (inputSession.pending()) return;
      host.classList.toggle('has-image-selection', !sourceMode && !!exactSelectedImageRange(view.state));
      imageTextController.syncSelection(view);
    }

    function deleteImageObject(view, backward) {
      if (sourceMode || compositionActive(view)) return false;
      if (imageTextController.active && imageTextController.selectedId) {
        imageTextController.command('delete');
        return true;
      }
      const image = adjacentImageRange(view.state, backward);
      if (!image) return false;
      view.dispatch({
        changes: { from: image.from, to: image.to, insert: '' },
        selection: EditorSelection.cursor(image.from),
        scrollIntoView: true,
        userEvent: 'delete.image-object',
      });
      return true;
    }

    function imageTextKeyCommand(name, value) {
      if (sourceMode || compositionActive(view) || !imageTextController.active || !imageTextController.selectedId) return false;
      if (name === 'clear-selection') {
        imageTextController.select('');
        return true;
      }
      return imageTextController.command(name, value);
    }

    function livePreviewExtensions() {
      return sourceMode ? [] : [blockField, viewportParsePlugin, inlinePlugin];
    }

    function editorLabelExtension() {
      return EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': sourceMode ? languageSourceLabel() : languageLabel() });
    }

    const shortcutRuns = {
      save() { safeOptions.onSaveRequest(); return true; },
      bold(view) { return wrapSelection(view, '**', '**', '粗体'); },
      italic(view) { return wrapSelection(view, '*', '*', '斜体'); },
      strike(view) { return wrapSelection(view, '~~', '~~', '删除线'); },
      highlight(view) { return wrapSelection(view, '==', '==', '高光'); },
      'inline-code'(view) { return wrapSelection(view, '`', '`', '代码'); },
      'code-block': wrapCodeBlock,
      link(view) {
        const range = view.state.selection.main;
        const selected = view.state.doc.sliceString(range.from, range.to) || '链接文字';
        const insert = '[' + selected + '](https://)';
        view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: EditorSelection.range(range.from + selected.length + 3, range.from + insert.length - 1) });
        return true;
      },
    };

    function inactiveDefaultShortcutBindings() {
      if (shortcutRegistry && typeof shortcutRegistry.inactiveDefaultBindings === 'function') {
        return shortcutRegistry.inactiveDefaultBindings(currentShortcutBindings);
      }
      const claimed = new Set();
      Object.keys(currentShortcutBindings).forEach((id) => {
        (currentShortcutBindings[id] || []).forEach((key) => claimed.add(key));
      });
      const inactive = [];
      Object.keys(fallbackShortcutDefaults).forEach((id) => {
        fallbackShortcutDefaults[id].forEach((key) => {
          if (!claimed.has(key) && !inactive.includes(key)) inactive.push(key);
        });
      });
      return inactive;
    }

    function customKeyBindings() {
      const keys = [];
      Object.keys(shortcutRuns).forEach((id) => {
        const run = shortcutRuns[id];
        (currentShortcutBindings[id] || []).forEach((key) => {
          keys.push({ key, preventDefault: true, run });
        });
      });
      // Removing one of Relatum's factory bindings is an explicit opt-out.
      // Consume that chord here so it cannot fall through to CodeMirror's
      // lower-priority defaults (notably Shift-Mod-k -> delete.line).
      inactiveDefaultShortcutBindings().forEach((key) => {
        keys.push({ key, preventDefault: true, run() { return true; } });
      });
      return keys;
    }

    function notifyDocChanged(view, includeValue) {
      const main = view.state.selection.main;
      const meta = {
        anchor: main.anchor,
        head: main.head,
        scrollTop: view.scrollDOM.scrollTop,
        length: view.state.doc.length,
      };
      if (includeValue) meta.value = view.state.doc.toString();
      safeOptions.onDocChanged(meta);
    }

    function makeState(value, selection) {
      const extensions = [
        highlightSpecialChars(), history(), drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
        indentOnInput(), bracketMatching(), typeof closeBrackets === 'function' ? closeBrackets() : [],
        rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
        markdown({ base: markdownLanguage, codeLanguages: Array.isArray(relatumCodeLanguages) ? relatumCodeLanguages : [] }),
        relatumCodeHighlighting || [],
        livePreviewCompartment.of(livePreviewExtensions()),
        Prec.highest(keymap.of([
          { key: 'Backspace', run: (view) => deleteImageObject(view, true) },
          { key: 'Delete', run: (view) => deleteImageObject(view, false) },
          { key: 'Enter', run: () => imageTextKeyCommand('edit') },
          { key: 'Escape', run: () => imageTextKeyCommand('clear-selection') },
          { key: 'ArrowLeft', run: () => imageTextKeyCommand('move', { dx: -1, dy: 0 }) },
          { key: 'ArrowRight', run: () => imageTextKeyCommand('move', { dx: 1, dy: 0 }) },
          { key: 'ArrowUp', run: () => imageTextKeyCommand('move', { dx: 0, dy: -1 }) },
          { key: 'ArrowDown', run: () => imageTextKeyCommand('move', { dx: 0, dy: 1 }) },
          { key: 'Shift-ArrowLeft', run: () => imageTextKeyCommand('move', { dx: -10, dy: 0 }) },
          { key: 'Shift-ArrowRight', run: () => imageTextKeyCommand('move', { dx: 10, dy: 0 }) },
          { key: 'Shift-ArrowUp', run: () => imageTextKeyCommand('move', { dx: 0, dy: -10 }) },
          { key: 'Shift-ArrowDown', run: () => imageTextKeyCommand('move', { dx: 0, dy: 10 }) },
        ])),
        Prec.highest(keymap.of([{ key: 'Enter', run: exitEmptyQuoteMarkup }])),
        shortcutCompartment.of(keymap.of(customKeyBindings())),
        keymap.of((Array.isArray(closeBracketsKeymap) ? closeBracketsKeymap : []).concat(
          markdownKeymap, defaultKeymap, historyKeymap, searchKeymap, [indentWithTab])),
        placeholder(languagePlaceholder()), EditorView.lineWrapping,
        EditorView.exceptionSink.of((error) => {
          host.dataset.livePreviewError = String(error && error.message || error);
          console.error('Relatum Live Preview:', error);
        }),
        editorLabelCompartment.of(editorLabelExtension()),
        EditorView.updateListener.of((update) => {
          if (!inputSession.pending()) {
            inputSession.capture(update.view);
            syncImageSelectionClass(update.view);
          }
          if (!update.docChanged || suppressChanges) return;
          if (inputSession.pending()) { inputSession.changed(); return; }
          const includeValue = update.transactions.some((transaction) => (
            transaction.isUserEvent('input.image-text')
            || transaction.isUserEvent('delete.image-object')
            || transaction.isUserEvent('undo')
            || transaction.isUserEvent('redo')
          ));
          notifyDocChanged(update.view, includeValue);
        }),
        EditorView.domEventHandlers({
          focus(event, view) {
            if (!inputSession.pending()) view.dispatch({ effects: focusEffect.of(true) });
            return false;
          },
          blur(event, view) {
            if (inputSession.pending()) inputSession.end(view);
            else view.dispatch({ effects: focusEffect.of(false) });
            return false;
          },
          compositionstart(event, view) {
            inputSession.begin(view);
            return false;
          },
          compositionend(event, view) {
            inputSession.end(view);
            return false;
          },
          mousedown(event, view) {
            if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false;
            const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (position == null) return false;
            const link = linkAt(view.state, position);
            if (!link) return false;
            event.preventDefault();
            if (link.kind === 'url' && isDangerousTarget(link.target)) return true;
            if (link.kind === 'wiki') safeOptions.onOpenWiki(link.target);
            else safeOptions.onOpenExternal(normalizedImageTarget(link.target));
            return true;
          },
          paste(event) {
            const files = Array.from(event.clipboardData && event.clipboardData.items || [])
              .filter((item) => item.kind === 'file' && /^image\//i.test(item.type || ''))
              .map((item) => item.getAsFile()).filter(Boolean);
            if (!files.length) return false;
            event.preventDefault(); safeOptions.onImageFiles(files); return true;
          },
          dragover(event) {
            const files = Array.from(event.dataTransfer && event.dataTransfer.files || []);
            if (!files.some((file) => /^image\//i.test(file.type || '') || /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(file.name || ''))) return false;
            event.preventDefault(); return true;
          },
          drop(event) {
            const files = Array.from(event.dataTransfer && event.dataTransfer.files || [])
              .filter((file) => /^image\//i.test(file.type || '') || /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(file.name || ''));
            if (!files.length) return false;
            event.preventDefault(); safeOptions.onImageFiles(files); return true;
          },
        }),
      ];
      return EditorState.create({
        doc: String(value || ''),
        selection: selection || EditorSelection.cursor(0),
        extensions,
      });
    }

    function languagePlaceholder() {
      return document.documentElement.lang === 'en' ? 'Start writing Markdown…' : '开始书写 Markdown…';
    }
    function languageLabel() {
      return document.documentElement.lang === 'en' ? 'Markdown Live Preview editor' : 'Markdown 实时预览编辑器';
    }
    function languageSourceLabel() {
      return document.documentElement.lang === 'en' ? 'Markdown source editor' : 'Markdown 源码编辑器';
    }

    const view = new EditorView({ state: makeState(options.value || '', EditorSelection.cursor(0)), parent: host });
    view.__relatumInputSession = inputSession;
    inputSession.capture(view);
    host.classList.toggle('is-source-mode', sourceMode);
    syncImageSelectionClass(view);

    function setDocument(documentState) {
      if (inputPending()) {
        pendingDocumentState = Object.assign({}, documentState || {});
        if (!pendingDocumentWait) {
          pendingDocumentWait = true;
          whenInputSettled().then(() => {
            pendingDocumentWait = false;
            const pendingDocument = pendingDocumentState;
            pendingDocumentState = null;
            if (!destroyed && pendingDocument) setDocument(pendingDocument);
          });
        }
        return;
      }
      pendingDocumentState = null;
      const seq = ++documentSetSeq;
      coordinator.epoch += 1;
      imageTextController.setActive(false);
      if (pendingSourceMode !== null) { sourceMode = pendingSourceMode; pendingSourceMode = null; }
      if (pendingShortcutBindings !== null) {
        currentShortcutBindings = normalizedShortcutBindings(pendingShortcutBindings);
        pendingShortcutBindings = null;
      }
      const value = documentState && typeof documentState.value === 'string' ? documentState.value : '';
      currentPath = String(documentState && documentState.notePath || '');
      const end = value.length;
      const anchor = clamp(documentState && documentState.anchor, 0, end);
      const head = clamp(documentState && documentState.head, 0, end);
      suppressChanges = true;
      try { view.setState(makeState(value, EditorSelection.range(anchor, head))); }
      finally { suppressChanges = false; }
      view.__relatumInputSession = inputSession;
      inputSession.reset(view);
      host.classList.toggle('is-source-mode', sourceMode);
      syncImageSelectionClass(view);
      if (view.hasFocus) view.dispatch({ effects: focusEffect.of(true) });
      requestAnimationFrame(() => {
        if (destroyed || seq !== documentSetSeq || !view.dom.isConnected) return;
        view.scrollDOM.scrollTop = Math.max(0, Number(documentState && documentState.scrollTop) || 0);
        view.requestMeasure();
        requestAnimationFrame(() => {
          if (destroyed || seq !== documentSetSeq || !view.dom.isConnected) return;
          view.dispatch({ effects: viewportParseRequestEffect.of(true) });
        });
      });
    }

    function setNotePath(path) {
      const next = String(path || '');
      if (inputPending()) {
        whenInputSettled().then(() => { if (!destroyed) setNotePath(next); });
        return;
      }
      currentPath = next;
      coordinator.epoch += 1;
      view.dispatch({ effects: notePathEffect.of(currentPath) });
    }

    function setSourceMode(active) {
      const next = !!active;
      if (inputPending()) {
        pendingSourceMode = next;
        if (!inputSession.pending()) {
          whenInputSettled().then(() => {
            if (destroyed || pendingSourceMode === null) return;
            const queued = pendingSourceMode;
            pendingSourceMode = null;
            setSourceMode(queued);
          });
        }
        return;
      }
      if (next === sourceMode) return;
      sourceMode = next;
      if (next) imageTextController.setActive(false);
      coordinator.epoch += 1;
      const imageRange = next ? null : imageRangeForLiveMode(view.state);
      view.dispatch({
        selection: imageRange ? EditorSelection.range(imageRange.from, imageRange.to) : undefined,
        effects: [
        livePreviewCompartment.reconfigure(livePreviewExtensions()),
        editorLabelCompartment.reconfigure(editorLabelExtension()),
        ],
      });
      host.classList.toggle('is-source-mode', sourceMode);
      syncImageSelectionClass(view);
      view.requestMeasure();
    }

    function setShortcutBindings(bindings) {
      const next = normalizedShortcutBindings(bindings);
      if (inputPending()) {
        pendingShortcutBindings = next;
        if (!inputSession.pending()) {
          whenInputSettled().then(() => {
            if (destroyed || pendingShortcutBindings === null) return;
            const queued = pendingShortcutBindings;
            pendingShortcutBindings = null;
            setShortcutBindings(queued);
          });
        }
        return;
      }
      currentShortcutBindings = next;
      view.dispatch({ effects: shortcutCompartment.reconfigure(keymap.of(customKeyBindings())) });
    }

    function snapshot() {
      return inputSession.snapshot(view);
    }

    function replaceSelection(text) {
      if (inputPending()) {
        const path = currentPath;
        whenInputSettled().then(() => { if (!destroyed && path === currentPath) replaceSelection(text); });
        return;
      }
      const range = view.state.selection.main;
      const insert = String(text || '');
      view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: EditorSelection.cursor(range.from + insert.length), userEvent: 'input' });
      view.focus();
    }

    function setImageTextMode(active) {
      if (inputPending()) return false;
      return imageTextController.setActive(active, view);
    }

    function imageTextCommand(name, value) {
      if (inputSession.pending()) return false;
      return imageTextController.command(String(name || ''), value);
    }

    function inputPending() {
      return inputSession.pending() || imageTextController.draftActive;
    }

    function whenInputSettled() {
      return Promise.all([inputSession.whenSettled(), imageTextController.whenSettled()]);
    }

    return {
      setDocument, setNotePath, setSourceMode, setShortcutBindings, setImageTextMode, imageTextCommand, snapshot, replaceSelection,
      whenInputSettled,
      get inputPending() { return inputPending(); },
      focus() { view.focus(); },
      destroy() { destroyed = true; imageTextController.setActive(false); imageTextSizer.destroy(); inputSession.destroy(); delete view.__relatumInputSession; host.classList.remove('is-composing', 'has-image-selection', 'is-image-text-mode'); coordinator.epoch += 1; view.destroy(); host.replaceChildren(); },
      get view() { return view; },
    };
  }

  window.RelatumNoteLiveSyntax = {
    scanBlockSpecsFromString(source) {
      const state = EditorState.create({ doc: String(source || ''), extensions: [markdown({ base: markdownLanguage })] });
      return scanBlockSpecs(state, 0, state.doc.length).map((spec) => Object.assign({}, spec));
    },
    parseStandaloneImage,
    parseCalloutSource,
    fenceStart,
    fencedCodeBody,
    isRemoteTarget,
    isDangerousTarget,
    headingMarkerProjectionEnd,
    richBlockEditPosition,
  };
  window.RelatumNoteLiveEditor = { create, renderMarkdown };
})();
