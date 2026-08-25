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
    EditorState, EditorSelection, StateEffect, StateField, EditorView, Decoration, WidgetType, Prec,
    ViewPlugin, keymap, drawSelection, dropCursor, highlightSpecialChars,
    rectangularSelection, crosshairCursor, placeholder, highlightActiveLine,
    syntaxTree, forceParsing, indentOnInput,
    bracketMatching, markdown, markdownLanguage, markdownKeymap, history,
    historyKeymap, defaultKeymap, indentWithTab, searchKeymap,
    highlightSelectionMatches, closeBrackets, closeBracketsKeymap,
    relatumCodeLanguages, relatumCodeHighlighting,
  } = CM;
  const focusEffect = StateEffect.define();
  const compositionEffect = StateEffect.define();
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

  function closingBracket(text, start, open, close) {
    let depth = 0;
    for (let index = start; index < text.length; index += 1) {
      if (text[index] === '\\') { index += 1; continue; }
      if (text[index] === open) depth += 1;
      else if (text[index] === close) {
        depth -= 1;
        if (!depth) return index;
      }
    }
    return -1;
  }

  function parseMarkdownImage(text) {
    const source = String(text || '');
    const leading = /^\s*/.exec(source)[0].length;
    if (source.slice(leading, leading + 2) !== '![') return null;
    const labelEnd = closingBracket(source, leading + 1, '[', ']');
    if (labelEnd < 0 || source[labelEnd + 1] !== '(') return null;
    const targetEnd = closingBracket(source, labelEnd + 1, '(', ')');
    if (targetEnd < 0 || source.slice(targetEnd + 1).trim()) return null;
    const rawTarget = source.slice(labelEnd + 2, targetEnd).trim();
    return {
      alt: source.slice(leading + 2, labelEnd).replace(/\\([\\\[\]])/g, '$1').trim(),
      target: normalizedImageTarget(rawTarget),
    };
  }

  function parseStandaloneImage(text) {
    const markdown = parseMarkdownImage(text);
    if (markdown) return markdown;
    const match = /^\s*!\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]\s*$/.exec(text);
    if (match) return { alt: (match[2] || '').trim(), target: match[1].trim() };
    return null;
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
          const source = doc.sliceString(node.from, node.to);
          const opener = fenceStart(doc.lineAt(node.from).text);
          if (!opener || !isFenceEnd(doc.lineAt(Math.max(node.from, node.to - 1)).text, opener)) return false;
          const kind = opener.language === 'derive' ? 'derive' : MERMAID_LANGS.has(opener.language) ? 'mermaid' : '';
          const limit = kind === 'mermaid' ? MERMAID_LIMIT : RICH_BLOCK_LIMIT;
          if (kind && source.length <= limit && !rangeHasLongLine(doc, node.from, node.to)) push({ from: node.from, to: node.to, kind, source, language: opener.language });
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
              push({ from: line.from, to: line.to, kind: 'image', source: line.text, target: image.target, alt: image.alt });
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
      if (line.length > MAX_RICH_LINE) { number += 1; continue; }
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
    constructor(source, coordinator) { super(); this.source = source; this.coordinator = coordinator; this.epoch = coordinator.epoch; }
    eq(other) { return other.source === this.source && other.epoch === this.epoch; }
    toDOM(view) {
      const span = document.createElement('span');
      span.className = 'note-live-inline-math';
      span.textContent = this.source;
      const token = {};
      this.token = token;
      ensureMathJax().then((math) => {
        if (this.token !== token || !span.isConnected || this.coordinator.epoch !== this.epoch) return;
        return math.typesetPromise([span]).then(() => {
          if (this.token === token && span.isConnected && this.coordinator.epoch === this.epoch) view.requestMeasure();
        });
      }).catch(() => { span.classList.add('is-failed'); });
      return span;
    }
    destroy() { this.token = null; }
  }

  class InlineImageWidget extends WidgetType {
    constructor(target, alt, notePath, options) { super(); this.target = target; this.alt = alt; this.notePath = notePath; this.options = options; }
    eq(other) { return other.target === this.target && other.notePath === this.notePath && other.alt === this.alt; }
    toDOM(view) {
      const wrap = document.createElement('span');
      wrap.className = 'note-live-inline-image';
      const image = document.createElement('img');
      image.alt = this.alt || this.target.split('/').pop() || '';
      image.loading = 'lazy'; image.decoding = 'async';
      image.src = this.options.imageUrl(this.notePath, this.target);
      image.addEventListener('load', () => { if (wrap.isConnected) view.requestMeasure(); }, { once: true });
      image.addEventListener('error', () => { if (wrap.isConnected) { wrap.classList.add('is-failed'); wrap.title = '图片无法加载'; } }, { once: true });
      wrap.appendChild(image);
      return wrap;
    }
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
    const result = safeIsolatedResult(String(source || ''));
    const content = document.createElement('article');
    content.className = 'note-reading-content node-text';
    content.innerHTML = result.html;
    content.querySelectorAll('[data-note-image]').forEach((image) => {
      image.src = safeOptions.imageUrl(String(notePath || ''), image.dataset.noteImage || '');
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

  class RichBlockWidget extends WidgetType {
    constructor(spec, notePath, options, coordinator) {
      super(); this.spec = spec; this.notePath = notePath; this.options = options; this.coordinator = coordinator;
      this.epoch = coordinator.epoch; this.token = null;
    }
    eq(other) {
      return other.spec.id === this.spec.id && other.spec.fingerprint === this.spec.fingerprint
        && other.notePath === this.notePath && other.epoch === this.epoch;
    }
    isCurrent(view, wrap, token) {
      if (this.token !== token || !wrap.isConnected || this.coordinator.epoch !== this.epoch) return false;
      const current = this.coordinator.spec(view, this.spec.id);
      return !!current && current.fingerprint === this.spec.fingerprint && current.source === this.spec.source;
    }
    reveal(view, event) {
      if (event) { event.preventDefault(); event.stopPropagation(); }
      const current = this.coordinator.spec(view, this.spec.id);
      if (!current) return;
      const at = Math.min(current.to, current.from + (current.kind === 'table' ? 1 : 3));
      view.dispatch({ selection: EditorSelection.cursor(at), scrollIntoView: true });
      view.focus();
    }
    toDOM(view) {
      const wrap = document.createElement('div');
      wrap.className = 'note-live-rich-block is-' + this.spec.kind;
      wrap.tabIndex = 0;
      wrap.setAttribute('aria-label', '点击编辑 ' + this.spec.kind + ' 源码');
      wrap.addEventListener('click', (event) => this.reveal(view, event));
      wrap.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') this.reveal(view, event); });
      const token = {};
      this.token = token;

      if (this.spec.kind === 'image') {
        const image = document.createElement('img');
        image.alt = this.spec.alt || this.spec.target.split('/').pop() || '';
        image.loading = 'lazy'; image.decoding = 'async';
        image.src = this.options.imageUrl(this.notePath, this.spec.target);
        image.addEventListener('load', () => { if (this.isCurrent(view, wrap, token)) view.requestMeasure(); }, { once: true });
        image.addEventListener('error', () => { wrap.classList.add('is-failed'); wrap.textContent = '图片无法加载 · ' + image.alt; }, { once: true });
        wrap.appendChild(image);
      } else if (this.spec.kind === 'math') {
        wrap.classList.add('md-math-block');
        wrap.textContent = this.spec.source;
        ensureMathJax().then((math) => {
          if (!this.isCurrent(view, wrap, token)) return;
          return math.typesetPromise([wrap]).then(() => { if (this.isCurrent(view, wrap, token)) view.requestMeasure(); });
        }).catch(() => wrap.classList.add('is-failed'));
      } else if (this.spec.kind === 'rule') {
        wrap.appendChild(document.createElement('hr')).className = 'md-hr';
      } else {
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
          window.MermaidRenderer.renderAll(wrap).then(() => {
            if (this.isCurrent(view, wrap, token)) view.requestMeasure();
          }).catch(() => wrap.classList.add('is-failed'));
        }
        if (hasMath) {
          ensureMathJax().then((math) => {
            if (!this.isCurrent(view, wrap, token)) return;
            return math.typesetPromise([wrap]).then(() => { if (this.isCurrent(view, wrap, token)) view.requestMeasure(); });
          }).catch(() => wrap.classList.add('is-failed'));
        }
      }
      return wrap;
    }
    destroy() { this.token = null; }
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
    return lines.length >= 2 ? lines.slice(1, -1).join('\n') : '';
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
    constructor(label, code) {
      super(); this.label = String(label || ''); this.code = String(code || ''); this.timer = 0;
    }
    eq(other) { return other.label === this.label && other.code === this.code; }
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

  function usesBlockReplacement(spec) {
    // Callouts deliberately remain CodeMirror-owned lines. Replacing the whole
    // block makes the source range collapse into a widget boundary, so clicks on
    // the neighbouring visual lines can resolve inside the Callout instead.
    return spec && spec.kind !== 'callout';
  }

  function createBlockField(notePath, options, coordinator) {
    const field = StateField.define({
      create(state) {
        const tree = syntaxTree(state);
        const parsedTo = typeof tree.length === 'number' ? Math.min(state.doc.length, tree.length) : state.doc.length;
        const specs = scanBlockSpecs(state, 0, parsedTo);
        const byId = new Map(specs.map((spec) => [spec.id, spec]));
        const decorations = Decoration.set(specs.filter(usesBlockReplacement).map((spec) => Decoration.replace({
          widget: new RichBlockWidget(spec, notePath(), options, coordinator), block: true, inclusive: false, blockId: spec.id,
        }).range(spec.from, spec.to)), true);
        return { specs, byId, activeIds: new Set(), focused: false, composing: false, decorations };
      },
      update(value, transaction) {
        let specs = updateBlockSpecs(value.specs, transaction);
        let viewportRefreshed = false;
        transaction.effects.forEach((effect) => {
          if (!effect.is(viewportScanEffect)) return;
          specs = refreshVisibleBlockSpecs(specs, transaction.state, effect.value);
          viewportRefreshed = true;
        });
        let focused = value.focused;
        let composing = value.composing;
        transaction.effects.forEach((effect) => { if (effect.is(focusEffect)) focused = !!effect.value; });
        transaction.effects.forEach((effect) => { if (effect.is(compositionEffect)) composing = !!effect.value; });
        const notePathChanged = transaction.effects.some((effect) => effect.is(notePathEffect));
        const selectionChanged = !!transaction.selection;
        if (!transaction.docChanged && !selectionChanged && focused === value.focused && composing === value.composing && !notePathChanged && !viewportRefreshed) return value;

        const byId = new Map(specs.map((spec) => [spec.id, spec]));
        const activeIds = activeBlockIds(specs, transaction.state, focused, composing);
        const refresh = new Set();
        value.byId.forEach((old, id) => {
          const current = byId.get(id);
          if (!current || old.from !== current.from || old.to !== current.to || old.fingerprint !== current.fingerprint) refresh.add(id);
        });
        byId.forEach((current, id) => { if (!value.byId.has(id)) refresh.add(id); });
        value.activeIds.forEach((id) => { if (!activeIds.has(id)) refresh.add(id); });
        activeIds.forEach((id) => { if (!value.activeIds.has(id)) refresh.add(id); });
        if (notePathChanged) specs.forEach((spec) => refresh.add(spec.id));

        let decorations = transaction.docChanged ? value.decorations.map(transaction.changes) : value.decorations;
        if (refresh.size) {
          decorations = decorations.update({
            filter(from, to, decoration) { return !refresh.has(decoration.spec.blockId); },
            add: specs.filter((spec) => usesBlockReplacement(spec) && refresh.has(spec.id) && !activeIds.has(spec.id)).map((spec) => Decoration.replace({
              widget: new RichBlockWidget(spec, notePath(), options, coordinator), block: true, inclusive: false, blockId: spec.id,
            }).range(spec.from, spec.to)),
            sort: true,
          });
        }
        return { specs, byId, activeIds, focused, composing, decorations };
      },
      provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
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

  function constructActive(view, from, to) {
    return view.composing || view.__relatumCompositionActive || (view.hasFocus && selectionTouches(view.state.selection, from, to));
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
    const inactiveBlockAt = (from, to) => blockSpecs.some((spec) => usesBlockReplacement(spec) && !blockValue.activeIds.has(spec.id) && spec.from < to && spec.to > from);
    const inactiveBlockContains = (from, to) => blockSpecs.some((spec) => usesBlockReplacement(spec) && !blockValue.activeIds.has(spec.id) && spec.from <= from && spec.to >= to);
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
          if (range.kind === 'FencedCode' && !constructActive(view, range.from, range.to)) {
            const openingLine = view.state.doc.line(blockFirst);
            const opener = fenceStart(openingLine.text);
            if (opener && opener.label && openingLine.from >= first.from && openingLine.to <= last.to) {
              add(openingLine.to, openingLine.to, Decoration.widget({
                widget: new CodeLanguageWidget(opener.label, fencedCodeBody(view.state.doc.sliceString(range.from, range.to))),
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
              if (!constructActive(view, nodeRef.from, nodeRef.to)) {
                add(nodeRef.from, nodeRef.to, Decoration.replace({
                  widget: new InlineImageWidget(parsed.target, parsed.alt, notePath(), options), inclusive: false,
                }));
                return false;
              }
              mark(nodeRef.from, nodeRef.to, 'note-live-image-source');
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
            else add(nodeRef.from, nodeRef.to, Decoration.replace({
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
          } else if (/^(?:FencedCode|CodeBlock|IndentedCode)$/.test(nodeRef.name)) {
            const startLine = view.state.doc.lineAt(nodeRef.from).number;
            const endLine = view.state.doc.lineAt(Math.max(nodeRef.from, nodeRef.to - 1)).number;
            for (let number = startLine; number <= endLine; number += 1) {
              let className = 'note-live-code-line';
              if (number === startLine) className += ' note-live-code-first';
              if (number === endLine) className += ' note-live-code-last';
              lineClass(view.state.doc.line(number).from, className);
            }
          } else if (/^(?:HTMLBlock|HTMLTag)$/.test(nodeRef.name)) {
            const startLine = view.state.doc.lineAt(nodeRef.from).number;
            const endLine = view.state.doc.lineAt(Math.max(nodeRef.from, nodeRef.to - 1)).number;
            for (let number = startLine; number <= endLine; number += 1) lineClass(view.state.doc.line(number).from, 'note-live-raw-html-line');
            return false;
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

        matches(/!\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g, (match, from, to) => {
          const target = match[1].trim(); protect(from, to);
          if (!constructActive(view, from, to) && target && !isRemoteTarget(target)) {
            add(from, to, Decoration.replace({ widget: new InlineImageWidget(target, (match[2] || '').trim(), notePath(), options) }));
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
          if (!constructActive(view, from, to)) add(from, to, Decoration.replace({ widget: new InlineMathWidget(match[0], options.coordinator) }));
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

  function createInlinePlugin(blockField, notePath, options) {
    return ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = createInlineDecorations(view, blockField, notePath, options); }
      update(update) {
        const lifecycleChanged = update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(compositionEffect) || effect.is(focusEffect) || effect.is(notePathEffect) || effect.is(viewportScanEffect) || effect.is(viewportParseRequestEffect)));
        const syntaxChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || update.view.composing || lifecycleChanged || syntaxChanged) {
          this.decorations = createInlineDecorations(update.view, blockField, notePath, options);
        }
      }
    }, { decorations: (value) => value.decorations });
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
    let compositionDirty = false;
    let sourceMode = !!options.sourceMode;
    const coordinator = { epoch: 1, field: null, spec() { return null; } };
    const safeOptions = Object.assign({
      imageUrl(notePath, target) {
        return '/api/note-asset?note=' + encodeURIComponent(notePath || '') + '&src=' + encodeURIComponent(target || '');
      },
      onDocChanged() {}, onSaveRequest() {}, onOpenWiki() {}, onOpenExternal() {}, onImageFiles() {},
    }, options);
    safeOptions.coordinator = coordinator;
    const notePath = () => currentPath;
    const blockField = createBlockField(notePath, safeOptions, coordinator);
    const inlinePlugin = createInlinePlugin(blockField, notePath, safeOptions);
    const viewportParsePlugin = createViewportParsePlugin();

    const customKeys = [
      { key: 'Mod-s', preventDefault: true, run() { safeOptions.onSaveRequest(); return true; } },
      { key: 'Mod-b', preventDefault: true, run(view) { return wrapSelection(view, '**', '**', '粗体'); } },
      { key: 'Mod-i', preventDefault: true, run(view) { return wrapSelection(view, '*', '*', '斜体'); } },
      { key: 'Mod-`', preventDefault: true, run(view) { return wrapSelection(view, '`', '`', '代码'); } },
      { key: 'Mod-Shift-k', preventDefault: true, run: wrapCodeBlock },
      { key: 'Mod-k', preventDefault: true, run(view) {
        const range = view.state.selection.main;
        const selected = view.state.doc.sliceString(range.from, range.to) || '链接文字';
        const insert = '[' + selected + '](https://)';
        view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: EditorSelection.range(range.from + selected.length + 3, range.from + insert.length - 1) });
        return true;
      } },
    ];

    function notifyDocChanged(view) {
      const main = view.state.selection.main;
      safeOptions.onDocChanged({
        anchor: main.anchor,
        head: main.head,
        scrollTop: view.scrollDOM.scrollTop,
        length: view.state.doc.length,
      });
    }

    function makeState(value, selection) {
      const extensions = [
        highlightSpecialChars(), history(), drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
        indentOnInput(), bracketMatching(), typeof closeBrackets === 'function' ? closeBrackets() : [],
        rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
        markdown({ base: markdownLanguage, codeLanguages: Array.isArray(relatumCodeLanguages) ? relatumCodeLanguages : [] }),
        relatumCodeHighlighting || [],
        sourceMode ? [] : [blockField, viewportParsePlugin, inlinePlugin],
        Prec.highest(keymap.of([{ key: 'Enter', run: exitEmptyQuoteMarkup }])),
        keymap.of(customKeys.concat(
          Array.isArray(closeBracketsKeymap) ? closeBracketsKeymap : [],
          markdownKeymap, defaultKeymap, historyKeymap, searchKeymap, [indentWithTab])),
        placeholder(languagePlaceholder()), EditorView.lineWrapping,
        EditorView.exceptionSink.of((error) => {
          host.dataset.livePreviewError = String(error && error.message || error);
          console.error('Relatum Live Preview:', error);
        }),
        EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': sourceMode ? languageSourceLabel() : languageLabel() }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || suppressChanges) return;
          if (update.view.composing || update.view.__relatumCompositionActive) { compositionDirty = true; return; }
          notifyDocChanged(update.view);
        }),
        EditorView.domEventHandlers({
          focus(event, view) { view.dispatch({ effects: focusEffect.of(true) }); return false; },
          blur(event, view) { view.dispatch({ effects: focusEffect.of(false) }); return false; },
          compositionstart(event, view) {
            view.__relatumCompositionActive = true;
            view.dispatch({ effects: compositionEffect.of(true) });
            return false;
          },
          compositionend(event, view) {
            requestAnimationFrame(() => {
              if (destroyed || !view.dom.isConnected) return;
              view.__relatumCompositionActive = false;
              view.dispatch({ effects: compositionEffect.of(false) });
              if (compositionDirty) { compositionDirty = false; notifyDocChanged(view); }
            });
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
    host.classList.toggle('is-source-mode', sourceMode);

    function setDocument(documentState) {
      const seq = ++documentSetSeq;
      coordinator.epoch += 1;
      compositionDirty = false;
      const value = documentState && typeof documentState.value === 'string' ? documentState.value : '';
      currentPath = String(documentState && documentState.notePath || '');
      const end = value.length;
      const anchor = clamp(documentState && documentState.anchor, 0, end);
      const head = clamp(documentState && documentState.head, 0, end);
      suppressChanges = true;
      try { view.setState(makeState(value, EditorSelection.range(anchor, head))); }
      finally { suppressChanges = false; }
      host.classList.toggle('is-source-mode', sourceMode);
      if (view.hasFocus) view.dispatch({ effects: focusEffect.of(true) });
      requestAnimationFrame(() => {
        if (seq !== documentSetSeq) return;
        view.scrollDOM.scrollTop = Math.max(0, Number(documentState && documentState.scrollTop) || 0);
        view.requestMeasure();
        requestAnimationFrame(() => {
          if (destroyed || seq !== documentSetSeq || !view.dom.isConnected) return;
          view.dispatch({ effects: viewportParseRequestEffect.of(true) });
        });
      });
    }

    function setNotePath(path) {
      currentPath = String(path || '');
      coordinator.epoch += 1;
      view.dispatch({ effects: notePathEffect.of(currentPath) });
    }

    function setSourceMode(active) {
      const next = !!active;
      if (next === sourceMode) return;
      const current = snapshot();
      sourceMode = next;
      setDocument(Object.assign({ notePath: currentPath }, current));
    }

    function snapshot() {
      const main = view.state.selection.main;
      return { value: view.state.doc.toString(), anchor: main.anchor, head: main.head, scrollTop: view.scrollDOM.scrollTop };
    }

    function replaceSelection(text) {
      const range = view.state.selection.main;
      const insert = String(text || '');
      view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: EditorSelection.cursor(range.from + insert.length), userEvent: 'input' });
      view.focus();
    }

    return {
      setDocument, setNotePath, setSourceMode, snapshot, replaceSelection,
      focus() { view.focus(); },
      destroy() { destroyed = true; coordinator.epoch += 1; view.destroy(); host.replaceChildren(); },
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
  };
  window.RelatumNoteLiveEditor = { create, renderMarkdown };
})();
