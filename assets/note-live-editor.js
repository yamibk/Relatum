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
  const imageContextResolvers = new WeakMap();
  // @lezer/markdown's public leaf-parser extension API. A long paragraph with
  // no inline syntax needs the same Paragraph node but no expensive inline pass.
  // Setext/table/reference parsers still get their normal precedence.
  // https://github.com/lezer-parser/markdown#user-content-blockparser
  const plainParagraphExtension = { parseBlock: [{ name: 'RelatumPlainParagraph',
    leaf(cx, leaf) {
      const plain = (text) => !/[\\`*_~\[\]<>!&$|]/.test(text) && !/ {2,}$/.test(text);
      let simple = plain(leaf.content);
      return {
        nextLine(context, line) { simple = simple && plain(line.text); return false; },
        finish(context, block) {
          if (!simple || block.content.length < MAX_RICH_LINE) return false;
          context.addLeafElement(block, context.elt('Paragraph', block.start, block.start + block.content.length));
          return true;
        },
      };
    },
  }] };

  // Only the live grid uses this leaf override. Its cell content has its own
  // renderer/parser, so an additional inline tree for every hidden cell is
  // wasted work. The source editor and notebook heading parser keep full GFM.
  const projectedTableExtension = { parseBlock: [{ name: 'RelatumProjectedTable', before: 'Table',
    leaf(cx, leaf) {
      const table = window.MarkdownTable;
      if (!table || cx.parentType().name !== 'Document' || leaf.content.length > MAX_RICH_LINE || !table.rowHasDelimiter(leaf.content)) return null;
      return {
        nextLine(context, line, block) {
          const separator = line.text.slice(line.pos);
          if (!table.isSeparatorLine(separator) || !table.parseLines([block.content, separator], 0, { ensureBodyRow: false }).ok) return false;
          let end = context.lineStart + line.text.length;
          let next = context.nextLine();
          while (next && line.text.trim() && table.rowHasDelimiter(line.text)) {
            end = context.lineStart + line.text.length;
            next = context.nextLine();
          }
          context.addLeafElement(block, context.elt('Table', block.start, end));
          return true;
        },
        finish() { return false; },
      };
    },
  }] };
  const MERMAID_LANGS = new Set([
    'mermaid', 'flowchart', 'graph', 'flow', 'sequence', 'sequencediagram',
    'timeline', 'gantt', 'class', 'classdiagram', 'state', 'statediagram',
    'er', 'erdiagram', 'mindmap',
  ]);

  const {
    EditorState, EditorSelection, StateEffect, StateField, Transaction, EditorView, Decoration, WidgetType, Prec, Compartment,
    ViewPlugin, keymap, drawSelection, dropCursor, highlightSpecialChars,
    rectangularSelection, crosshairCursor, placeholder, highlightActiveLine,
    syntaxTree, forceParsing, indentOnInput, HighlightStyle, syntaxHighlighting,
    bracketMatching, markdown, markdownLanguage, markdownKeymap, history,
    historyKeymap, defaultKeymap, indentWithTab, searchKeymap,
    highlightSelectionMatches, closeBrackets, closeBracketsKeymap,
    relatumCodeLanguages, relatumCodeStyle,
  } = CM;
  // The public language scope also recognizes configured Markdown parsers.
  // Keep program syntax colors inside embedded code languages, not Markdown.
  const markdownHighlightScope = HighlightStyle.define([], { scope: markdownLanguage }).scope;
  const codeHighlighting = relatumCodeStyle ? syntaxHighlighting({
    scope: (nodeType) => !markdownHighlightScope(nodeType),
    style: relatumCodeStyle.style,
  }) : [];
  const focusEffect = StateEffect.define();
  const calloutFoldEffect = StateEffect.define();
  const imageTextProjectionEffect = StateEffect.define();
  const inputReconcileEffect = StateEffect.define();
  const notePathEffect = StateEffect.define();
  const viewportScanEffect = StateEffect.define();
  const viewportParseRequestEffect = StateEffect.define();
  let nextBlockSpecId = 1;
  let nextTableCellVersion = 1;
  const noteSyntaxContexts = new WeakMap();
  const emptyNoteSyntax = { definitions: [], references: new Map(), footnotes: new Map(), headings: [], uses: [], tocs: [], semanticSignature: '[[],[]]' };

  function noteSyntaxContext(state) {
    return noteSyntaxContexts.get(state.doc) || emptyNoteSyntax;
  }

  function scanNoteSyntaxContext(state) {
    const source = state.doc.sliceString(0, state.doc.length);
    if (!source.includes('[') || !/^ {0,3}(?:\[[^\]\n]+\]:|\[toc\])/im.test(source)) {
      noteSyntaxContexts.set(state.doc, emptyNoteSyntax); return emptyNoteSyntax;
    }
    const context = window.MarkdownMini.noteSyntax.scan(source, { index: true });
    context.index.headingBlocks = [];
    context.headings = context.tocs.length ? noteHeadingsFromString(source, { blocks: context.index.headingBlocks }) : [];
    return rememberNoteSyntaxContext(state.doc, context);
  }

  function rememberNoteSyntaxContext(doc, context) {
    context.references = new Map(); context.footnotes = new Map();
    for (const item of context.definitions) {
      const entries = item.kind === 'reference' ? context.references : context.footnotes;
      if (!entries.has(item.key)) entries.set(item.key, item);
    }
    const numbers = new Map(); context.uses = [];
    for (const use of context.index.uses) {
      const definition = context.footnotes.get(use.key);
      if (!definition) continue;
      if (!numbers.has(use.key)) numbers.set(use.key, numbers.size + 1);
      context.uses.push(Object.assign({}, use, { number: numbers.get(use.key), targetFrom: definition.from }));
    }
    context.semanticSignature = JSON.stringify([Array.from(context.references, ([key, item]) => [key, item.target, item.title]),
      Array.from(new Map(context.uses.map(use => [use.key, use.number])))]);
    noteSyntaxContexts.set(doc, context);
    return context;
  }

  // Start/end at paragraph boundaries, then include any containing lexical
  // block or multiline definition. No document string or per-line cache is
  // retained. A changed open block grows the scan geometrically until it meets
  // an unchanged neutral boundary (or EOF).
  function noteSyntaxBounds(doc, from, to, blocks) {
    let first = doc.lineAt(from).number, last = doc.lineAt(to).number;
    first = Math.max(1, first - 1); last = Math.min(doc.lines, last + 1);
    while (first > 1 && doc.line(first).text.trim()) first--;
    while (last < doc.lines && doc.line(last).text.trim()) last++;
    let start = doc.line(first).from, end = doc.line(last).to, changed = true;
    while (changed) {
      changed = false;
      for (const block of blocks) {
        if (block.from > end || block.to < start) continue;
        const left = doc.lineAt(block.from).from, right = doc.lineAt(block.to).to;
        if (left < start) { start = left; changed = true; }
        if (right > end) { end = right; changed = true; }
      }
    }
    // A footnote can continue across an empty line followed by indentation.
    last = doc.lineAt(end).number;
    while (last < doc.lines) {
      const next = doc.line(last + 1).text;
      if (/^(?: {4}|\t)/.test(next)) last++;
      else if (!next.trim() && last + 2 <= doc.lines && /^(?: {4}|\t)/.test(doc.line(last + 2).text)) last += 2;
      else break;
    }
    return { from: start, to: doc.line(last).to };
  }

  function updateNoteSyntaxContext(previous, transaction) {
    if (!transaction.docChanged) return previous;
    let from = transaction.startState.doc.length, to = 0, crossMath = false, maskChanged = false, headerChanged = false;
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      from = Math.min(from, fromA); to = Math.max(to, toA);
      const before = transaction.startState.doc.sliceString(transaction.startState.doc.lineAt(fromA).from, transaction.startState.doc.lineAt(toA).to);
      const after = transaction.state.doc.sliceString(transaction.state.doc.lineAt(fromB).from, transaction.state.doc.lineAt(toB).to);
      // These paired formulas can start/end in another paragraph without a
      // line-scanner state. Rebuild their boundaries when the pairing changes.
      const paired = text => (text.match(/\$\$|\\[\[\]]/g) || []).join('|');
      if (paired(before) !== paired(after)) crossMath = true;
      const masks = text => (text.match(/`+|~{3,}|<!--|-->|%%|\n/g) || []).join('|');
      if (masks(before) !== masks(after)) maskChanged = true;
      if (fromA < 65536 && /^(?:\uFEFF?---|\.\.\.)[ \t]*$/m.test(before + '\n' + after)) headerChanged = true;
    });
    if (crossMath || maskChanged && previous.index?.crossMath || headerChanged && (/^\uFEFF?---\n/.test(transaction.startState.doc.sliceString(0, 5))
        || /^\uFEFF?---\n/.test(transaction.state.doc.sliceString(0, 5)))) return scanNoteSyntaxContext(transaction.state);
    if (!previous.index) {
      const first = transaction.state.doc.lineAt(transaction.changes.mapPos(from, -1));
      const last = transaction.state.doc.lineAt(transaction.changes.mapPos(to, 1));
      const source = transaction.state.doc.sliceString(first.from, last.to);
      if (/^ {0,3}(?:\[[^\]\n]+\]:|\[toc\])/im.test(source)) return scanNoteSyntaxContext(transaction.state);
      noteSyntaxContexts.set(transaction.state.doc, previous); return previous;
    }
    const map = item => Object.assign({}, item, { from: transaction.changes.mapPos(item.from, 1), to: transaction.changes.mapPos(item.to, -1) },
      item.contentFrom == null ? {} : { contentFrom: transaction.changes.mapPos(item.contentFrom, 1) },
      item.targetFrom == null ? {} : { targetFrom: transaction.changes.mapPos(item.targetFrom, 1) });
    const blocks = [...previous.index.blocks, ...previous.index.headingBlocks, ...previous.definitions, ...previous.headings];
    const oldBounds = noteSyntaxBounds(transaction.startState.doc, from, to, blocks);
    const doc = transaction.state.doc, mappedBlocks = blocks.map(map);
    let bounds = noteSyntaxBounds(doc, transaction.changes.mapPos(oldBounds.from, -1), transaction.changes.mapPos(oldBounds.to, 1), mappedBlocks);
    let local, source;
    for (;;) {
      source = doc.sliceString(bounds.from, bounds.to);
      local = window.MarkdownMini.noteSyntax.scan(source, { index: true, fragment: bounds.from > 0 });
      if (!local.index.open || bounds.to === doc.length) break;
      const end = Math.min(doc.length, bounds.to + Math.max(4096, bounds.to - bounds.from));
      bounds = noteSyntaxBounds(doc, bounds.from, end, mappedBlocks);
    }
    // Expansion may have consumed unchanged blocks beyond the first region.
    const oldFrom = Math.min(oldBounds.from, transaction.changes.invertedDesc.mapPos(bounds.from, -1));
    const oldTo = Math.max(oldBounds.to, transaction.changes.invertedDesc.mapPos(bounds.to, 1));
    const shift = item => Object.assign({}, item, { from: item.from + bounds.from, to: item.to + bounds.from },
      item.contentFrom == null ? {} : { contentFrom: item.contentFrom + bounds.from });
    const splice = (old, fresh) => old.filter(item => item.to < oldFrom || item.from > oldTo).map(map).concat(fresh.map(shift)).sort((a, b) => a.from - b.from || b.to - a.to);
    const context = { definitions: splice(previous.definitions, local.definitions), tocs: splice(previous.tocs, local.tocs),
      headings: [], index: { blocks: splice(previous.index.blocks, local.index.blocks), uses: splice(previous.index.uses, local.index.uses), headingBlocks: [],
        open: bounds.to === doc.length ? local.index.open : previous.index.open, crossMath: previous.index.crossMath || local.index.crossMath } };
    if (context.tocs.length) {
      if (!previous.tocs.length) {
        context.headings = noteHeadingsFromString(doc.sliceString(0, doc.length), { blocks: context.index.headingBlocks });
      } else {
        const headingBlocks = [];
        const headings = noteHeadingsFromString(source, { fragment: bounds.from > 0, blocks: headingBlocks });
        context.headings = splice(previous.headings, headings);
        context.index.headingBlocks = splice(previous.index.headingBlocks, headingBlocks);
      }
    }
    return rememberNoteSyntaxContext(doc, context);
  }

  function jumpNotePosition(view, position) {
    if (compositionActive(view)) return;
    const at = clamp(position, 0, view.state.doc.length);
    view.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: 'center' }) });
    view.focus();
  }

  class NoteFootnoteWidget extends WidgetType {
    constructor(key, number, definition) { super(); this.key = key; this.number = number; this.definition = !!definition; }
    eq(other) { return this.key === other.key && this.number === other.number && this.definition === other.definition; }
    toDOM(view) {
      const span = document.createElement(this.definition ? 'span' : 'sup');
      span.className = this.definition ? 'note-live-footnote-number' : 'note-footnote-ref';
      const link = document.createElement('button'); link.type = 'button'; link.textContent = this.number + (this.definition ? '.' : '');
      link.setAttribute('aria-label', (this.definition ? 'Back to reference: ' : 'Footnote: ') + this.key);
      link.addEventListener('mousedown', event => event.preventDefault());
      link.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        const context = noteSyntaxContext(view.state);
        const target = this.definition ? context.uses.find(use => use.key === this.key) : context.footnotes.get(this.key);
        if (target) jumpNotePosition(view, this.definition ? target.from : target.contentFrom);
      });
      span.appendChild(link); return span;
    }
    ignoreEvent() { return true; }
  }

  class NoteTocWidget extends WidgetType {
    constructor(headings, from) { super(); this.headings = headings; this.from = from; }
    eq(other) { return this.from === other.from && this.headings.length === other.headings.length && this.headings.every((item, index) => {
      const next = other.headings[index]; return item.from === next.from && item.level === next.level && item.label === next.label;
    }); }
    toDOM(view) {
      const wrap = document.createElement('div'); wrap.className = 'note-live-toc';
      wrap.tabIndex = 0; wrap.setAttribute('aria-label', 'Table of contents; double click to edit Markdown');
      wrap.innerHTML = window.MarkdownMini.noteSyntax.tocHtml(this.headings);
      wrap.addEventListener('dblclick', event => { if (!event.target.closest('[data-note-jump]')) { event.preventDefault(); jumpNotePosition(view, this.from); } });
      wrap.addEventListener('mousedown', event => { if (event.target.closest('[data-note-jump]')) event.preventDefault(); });
      const activate = event => {
        const link = event.target.closest('[data-note-jump]'); if (!link) return;
        if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault(); event.stopPropagation(); jumpNotePosition(view, Number(link.dataset.noteJump));
      };
      wrap.addEventListener('click', activate); wrap.addEventListener('keydown', activate); return wrap;
    }
    ignoreEvent() { return true; }
  }

  class NoteBreakWidget extends WidgetType {
    eq() { return true; }
    get lineBreaks() { return 1; }
    toDOM() { return document.createElement('br'); }
  }

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

  function absoluteImageTarget(target) {
    let value = String(target || '').trim();
    try { value = decodeURIComponent(value); } catch (_) {}
    return /^(?:[a-z]:|file:|[\\/])/i.test(value);
  }

  function previewableImage(target) {
    return !isRemoteTarget(target) || absoluteImageTarget(target);
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

  const canvasEnabled = () => !window.RelatumFeatureRuntime || window.RelatumFeatureRuntime.enabled('notes.canvas');
  const mermaidEnabled = () => !window.RelatumFeatureRuntime || window.RelatumFeatureRuntime.enabled('notes.mermaid');
  let noteMermaidPromise = null;
  function loadNoteMermaid() {
    if (!mermaidEnabled()) return Promise.reject(new Error('Mermaid disabled'));
    if (window.RelatumNoteMermaid) return Promise.resolve(window.RelatumNoteMermaid);
    if (!noteMermaidPromise) noteMermaidPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const own = document.querySelector('script[src*="note-live-editor.js"]')?.src || new URL('note-live-editor.js', document.baseURI).href;
      let timeout;
      const finish = error => {
        clearTimeout(timeout); script.onload = script.onerror = null;
        if (error) { script.remove(); reject(error); } else resolve(window.RelatumNoteMermaid);
      };
      script.src = new URL('note-mermaid.js', own).href;
      script.onload = () => finish(window.RelatumNoteMermaid ? null : new Error('Diagram module did not initialize'));
      script.onerror = () => finish(new Error('Offline diagram module could not be loaded'));
      timeout = setTimeout(() => finish(new Error('Offline diagram module timed out')), 10000);
      document.head.append(script);
    }).catch(error => { noteMermaidPromise = null; throw error; });
    return noteMermaidPromise;
  }

  // Widgets are still detached during toDOM(). Observe first, then validate after
  // insertion. No adapter or engine is requested for a hidden/preloaded editor.
  function attachNoteMermaid(root, options) {
    let disposed = false, paused = false, pageActive = true, loading = false, failed = false, adapter = null;
    let observer = null, mutation = null, errorBox = null;
    const current = () => !disposed && !paused && pageActive && mermaidEnabled() && root.isConnected && !root.closest('[hidden]')
      && !document.hidden && document.documentElement.dataset.desktopMinimized !== '1'
      && (!root.closest('.note-workspace') || document.body.dataset.startWorkspace === 'notes') && options.isCurrent();
    const visible = () => Array.from(root.querySelectorAll('.mermaid-diagram')).some(el => {
      const source = el.querySelector('.mermaid-source');
      const box = el.getBoundingClientRect(); return (source?.content?.textContent || source?.textContent || '').trim()
        && box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight;
    });
    const events = [[document, 'visibilitychange'], [window, 'canvasdesktop:visibility'],
      [document, 'relatum:start-workspacechange']];
    const pagehide = () => { pageActive = false; };
    const pageshow = () => { pageActive = true; start(); };
    const inputSettled = () => Promise.resolve(options.whenSettled?.()).then(start);
    const unwatch = () => {
      observer?.disconnect(); mutation?.disconnect(); observer = mutation = null;
      events.forEach(([target, name]) => target.removeEventListener(name, start));
      window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', pageshow);
      document.removeEventListener('compositionend', inputSettled);
    };
    function start() {
      if (loading || failed || adapter || !current() || !visible()) return;
      loading = true;
      Promise.resolve().then(() => options.whenSettled?.()).then(() => {
        if (!current() || !visible()) return;
        return loadNoteMermaid().then(runtime => {
          if (!current()) return;
          errorBox?.remove(); unwatch(); adapter = runtime.attach(root, options);
        });
      }).catch(error => {
        if (!current()) return;
        failed = true;
        const english = window.RelatumI18n?.language === 'en';
        errorBox = document.createElement('div'); errorBox.className = 'note-mermaid-error';
        const message = document.createElement('p'); message.textContent = (english ? 'Diagram unavailable: ' : '图表暂未显示：') + String(error.message || error);
        const button = document.createElement('button'); button.type = 'button'; button.dataset.noteMermaidControl = 'retry'; button.textContent = english ? 'Retry' : '重试';
        button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); failed = false; errorBox.remove(); start(); });
        errorBox.append(message, button); root.querySelector('.mermaid-diagram')?.prepend(errorBox); options.onLayout?.();
      }).finally(() => { loading = false; });
    }
    Promise.resolve().then(() => {
      if (disposed) return;
      observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(start) : null;
      root.querySelectorAll('.mermaid-diagram').forEach(el => observer?.observe(el));
      mutation = new MutationObserver(start);
      for (let parent = root.parentElement; parent; parent = parent.parentElement) mutation.observe(parent, { attributes: true, attributeFilter: ['hidden', 'data-start-workspace'] });
      events.forEach(([target, name]) => target.addEventListener(name, start));
      window.addEventListener('pagehide', pagehide); window.addEventListener('pageshow', pageshow); start();
      document.addEventListener('compositionend', inputSettled);
    });
    return { update(source, language) {
      const diagram = root.querySelector('.mermaid-diagram'), carrier = diagram?.querySelector('.mermaid-source');
      if (carrier?.content && carrier.content.textContent !== source) carrier.content.textContent = source;
      else if (carrier && !carrier.content && carrier.textContent !== source) carrier.textContent = source;
      if (diagram && diagram.dataset.mermaidLang !== (language || 'mermaid')) diagram.dataset.mermaidLang = language || 'mermaid';
      adapter?.update(source, language);
    }, suspend() { paused = true; adapter?.suspend(); }, resume() { paused = false; if (adapter) adapter.resume(); else start(); },
      destroy() { if (disposed) return; disposed = true; unwatch(); adapter?.destroy(); errorBox?.remove(); } };
  }
  const canvasImage = parsed => !!window.MarkdownMini?.isCanvasImage(parsed);
  let canvasRuntimePromise = null;
  function loadCanvasRuntime() {
    if (!canvasEnabled()) return Promise.reject(new Error('Canvas disabled'));
    if (window.RelatumNoteCanvas) return Promise.resolve(window.RelatumNoteCanvas);
    if (!canvasRuntimePromise) canvasRuntimePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const own = document.querySelector('script[src*="note-live-editor.js"]')?.src || new URL('note-live-editor.js', document.baseURI).href;
      script.src = new URL('note-canvas/runtime.js', own).href;
      script.onload = () => resolve(window.RelatumNoteCanvas); script.onerror = () => { script.remove(); canvasRuntimePromise = null; reject(new Error('画布模块加载失败')); };
      document.head.appendChild(script);
    });
    return canvasRuntimePromise;
  }

  class CanvasBlockWidget extends WidgetType {
    constructor(spec, path, options, coordinator, selected) {
      super(); Object.assign(this, { spec, path, options, coordinator, selected });
    }
    eq(other) { return this.spec.id === other.spec.id && this.spec.from === other.spec.from && this.spec.source === other.spec.source && this.path === other.path && this.selected === other.selected; }
    configuration(view, frame) {
      const resolve = () => {
        const current = this.coordinator.spec(view, this.spec.id);
        return current && canvasImage(parseStandaloneImage(current.source)) ? current : null;
      };
      const parsed = parseStandaloneImage(this.spec.source);
      const target = window.MarkdownMini.canvasTarget(this.path, parsed.target);
      const ordinal = window.MarkdownMini.canvasReferences(view.state.doc.sliceString(0, this.spec.from))
        .filter(ref => window.MarkdownMini.canvasTarget(this.path, ref.parsed.target).toLowerCase() === target.toLowerCase()).length;
      return { note: this.path, parsed, ordinal, source: this.spec.source, selected: this.selected, readOnly: false, resolve,
        select: () => { const range = resolve(); if (range && !compositionActive(view)) view.dispatch({ selection: EditorSelection.range(range.from, range.to) }); },
        maxWidth: () => view.contentDOM.getBoundingClientRect().right - frame.getBoundingClientRect().left,
        measure: () => { if (view.dom.isConnected && !compositionActive(view)) view.requestMeasure(); },
        resize: (width, height) => {
          const current = resolve(); if (!current || compositionActive(view)) return;
          const replacement = window.MarkdownMini.serializeImage(parseStandaloneImage(current.source), { width, height });
          view.dispatch({ changes: { from: current.from, to: current.to, insert: replacement },
            selection: EditorSelection.range(current.from, current.from + replacement.length), userEvent: 'input.note-canvas-size' });
        },
        remove: () => { const current = resolve(); if (current && !compositionActive(view)) view.dispatch({ changes: { from: current.from, to: current.to, insert: '' }, selection: EditorSelection.cursor(current.from), userEvent: 'delete' }); },
        onContextMenu: payload => this.options.onCanvasContextMenu?.(payload),
      };
    }
    toDOM(view) {
      const wrap = document.createElement('div'); wrap.className = 'note-live-rich-block is-canvas';
      const frame = document.createElement('div'); frame.className = 'note-live-image-frame is-block has-explicit-size'; wrap.appendChild(frame);
      const parsed = parseStandaloneImage(this.spec.source), width = parsed.width || 640, height = parsed.height || width * 9 / 16;
      frame.style.cssText = `display:block;width:${width}px;max-width:100%;aspect-ratio:${width}/${height};border-radius:7px`;
      frame.classList.toggle('is-selected', !!this.selected);
      const holder = { widget: this, destroyed: false, observer: null }; wrap.__canvasWidget = holder;
      holder.observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting) || holder.destroyed) return;
        holder.observer.disconnect();
        loadCanvasRuntime().then(runtime => {
          if (!holder.destroyed && wrap.isConnected) { holder.adapter = runtime.mount(frame, holder.widget.configuration(view, frame)); }
        }).catch(error => { if (!holder.destroyed) { frame.textContent = error.message; view.requestMeasure(); } });
      }); holder.observer.observe(wrap);
      return wrap;
    }
    updateDOM(wrap, view) {
      const holder = wrap.__canvasWidget;
      if (!holder || holder.widget.path !== this.path || holder.widget.spec.id !== this.spec.id) return false;
      const previous = parseStandaloneImage(holder.widget.spec.source), next = parseStandaloneImage(this.spec.source);
      if (!previous || !next || window.MarkdownMini.canvasTarget(this.path, previous.target).toLowerCase() !== window.MarkdownMini.canvasTarget(this.path, next.target).toLowerCase()) return false;
      holder.widget = this; holder.adapter?.update(this.configuration(view, wrap.firstChild));
      wrap.firstChild.classList.toggle('is-selected', !!this.selected); return true;
    }
    destroy(wrap) { const holder = wrap?.__canvasWidget; if (holder) { holder.destroyed = true; holder.observer.disconnect(); holder.adapter?.destroy(); } }
    ignoreEvent() { return true; }
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
    if (source.startsWith('\\[')) {
      const range = window.MarkdownMini.mathRanges(source)[0];
      return range && range.display && range.from === 0 && range.to === source.length && range.body.trim() ? { source, body: range.body } : null;
    }
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

  const frontmatterCache = new WeakMap();
  function documentFrontmatter(doc) {
    if (frontmatterCache.has(doc)) return frontmatterCache.get(doc);
    const prefix = doc.sliceString(0, Math.min(doc.length, 6));
    const value = /^\uFEFF?---\r?\n/.test(prefix)
      ? window.MarkdownMini.frontmatter(doc.sliceString(0, Math.min(doc.length, 65536))) : null;
    frontmatterCache.set(doc, value);
    return value;
  }

  let noteHeadingParser = null;
  function* parseHeadingTree(source) {
    if (!noteHeadingParser) noteHeadingParser = markdownLanguage.parser.configure(plainParagraphExtension);
    const parsing = noteHeadingParser.startParse(source);
    let tree;
    while (!(tree = parsing.advance())) yield;
    return tree;
  }

  // The same source index serves the lazy outline and the reading surface.
  // Keep this generator DOM-free and yield between parser/scan steps so a long
  // note does not force full-document parsing into CodeMirror's input listener.
  function* scanNoteHeadings(value, options) {
    const source = window.MarkdownMini.structure.normalizeSource(value);
    let tree = yield* parseHeadingTree(source);
    const protectedRanges = [], inlineCode = [], customRanges = [];
    const protectedName = /^(?:FencedCode|CodeBlock|IndentedCode|HTMLBlock|CommentBlock|Blockquote|BulletList|OrderedList|Table)$/;
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
      if (protectedName.test(node.name)) protectedRanges.push({ from: node.from, to: node.to, kind: node.name });
      else {
        const cursor = node.cursor();
        do {
          if (cursor.name === 'InlineCode') inlineCode.push({ from: cursor.from, to: cursor.to });
          yield;
        // A node cursor can leave its starting subtree. Stop before the next
        // block, otherwise every paragraph visits the rest of the document.
        } while (cursor.next() && cursor.from < node.to);
      }
      yield;
    }
    const metadata = options?.fragment ? null : window.MarkdownMini.frontmatter(source);
    if (metadata) customRanges.push(metadata);
    const guards = [...protectedRanges, ...inlineCode, ...(metadata ? [metadata] : [])].sort((a, b) => a.from - b.from);
    let guardIndex = 0, offset = 0, comment = null, math = null;
    const guarded = (position) => {
      while (guardIndex < guards.length && guards[guardIndex].to <= position) guardIndex++;
      return guardIndex < guards.length && guards[guardIndex].from <= position;
    };
    const lines = source.split('\n');
    for (let number = 0; number < lines.length; number++) {
      const line = lines[number];
      const end = offset + line.length;
      if (math) {
        if (line.trim() === math.close) { customRanges.push({ from: math.from, to: end }); math = null; }
      } else if (!guarded(offset) || guards[guardIndex]?.kind === 'Table') {
        const trimmed = line.trim();
        const table = window.MarkdownTable;
        // Relatum accepts literal pipes in code/math and heading-looking table
        // cells that Lezer may end the table before. Match the shared grid scan.
        if (!comment && table && line.length <= MAX_RICH_LINE && number + 1 < lines.length
            && table.rowHasDelimiter(line) && table.isSeparatorLine(lines[number + 1])) {
          let close = number + 2, length = line.length + lines[number + 1].length + 1;
          while (close < lines.length && length <= RICH_BLOCK_LIMIT && lines[close].length <= MAX_RICH_LINE
              && lines[close].trim() && table.rowHasDelimiter(lines[close])) {
            length += lines[close].length + 1; close++; yield;
          }
          if (length <= RICH_BLOCK_LIMIT) {
            customRanges.push({ from: offset, to: offset + length }); offset += length + 1; number = close - 1; yield; continue;
          }
        }
        if (!comment && (trimmed === '$$' || trimmed === '\\[')) math = { from: offset, close: trimmed === '$$' ? '$$' : '\\]' };
        else if (!comment && (/^\$\$.+\$\$$/.test(trimmed) || /^\\\[.+\\\]$/.test(trimmed))) customRanges.push({ from: offset, to: end });
        else {
          const markers = /<!--|-->|%%/g;
          const inlineMath = /<!--|%%/.test(line) ? window.MarkdownMini.mathRanges(line).filter(range =>
            !inlineCode.some(code => code.from < offset + range.to && code.to > offset + range.from)) : [];
          let marker;
          while ((marker = markers.exec(line))) {
            const position = offset + marker.index;
            if (guarded(position)) continue;
            if (!comment && inlineMath.some(range => range.from <= marker.index && range.to >= marker.index + marker[0].length)) continue;
            if (comment) {
              if (marker[0] === comment.close) { customRanges.push({ from: comment.from, to: position + marker[0].length }); comment = null; }
            } else if (marker[0] !== '-->') comment = { from: position, close: marker[0] === '<!--' ? '-->' : '%%' };
          }
        }
      }
      offset = end + 1;
      yield;
    }
    if (comment) customRanges.push({ from: comment.from, to: source.length });
    if (math) customRanges.push({ from: math.from, to: source.length });
    if (options?.blocks) {
      for (const range of protectedRanges) options.blocks.push(range);
      for (const range of customRanges) options.blocks.push(range);
    }
    let visibleSource = source;
    if (customRanges.length) {
      const ranges = [...protectedRanges, ...customRanges].sort((a, b) => a.from - b.from), merged = [];
      for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
        else merged.push({ from: range.from, to: range.to });
      }
      const pieces = []; let position = 0;
      for (const range of merged) {
        pieces.push(source.slice(position, range.from));
        for (let start = range.from; start < range.to; start += 16384) {
          pieces.push(source.slice(start, Math.min(range.to, start + 16384)).replace(/[^\n]/g, ' '));
          yield;
        }
        position = range.to;
      }
      pieces.push(source.slice(position)); visibleSource = pieces.join('');
      tree = yield* parseHeadingTree(visibleSource);
    }
    const headings = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
      const heading = /^(?:ATXHeading([1-6])|SetextHeading([12]))$/.exec(node.name);
      if (!heading) { yield; continue; }
      const cursor = node.cursor(); let omitted = [];
      const labelCode = [];
      let textFrom = node.from, textTo = node.to;
      do {
        if (cursor.name === 'HeaderMark') {
          if (heading[1] && cursor.from === node.from) textFrom = cursor.to;
          else textTo = Math.min(textTo, cursor.from);
        } else if (/^(?:EmphasisMark|CodeMark|StrikethroughMark|LinkMark|LinkTitle)$/.test(cursor.name)
            || cursor.name === 'URL' && cursor.node.parent?.name !== 'Autolink') omitted.push({ from: cursor.from, to: cursor.to });
        if (cursor.name === 'InlineCode') labelCode.push({ from: cursor.from, to: cursor.to });
        yield;
      } while (cursor.next() && cursor.from < node.to);
      const text = visibleSource.slice(textFrom, textTo).trim().replace(/\n/g, ' ');
      const rawText = visibleSource.slice(textFrom, textTo);
      const literals = labelCode.map(range => {
        const value = visibleSource.slice(range.from, range.to), marks = /^`+/.exec(value)[0].length;
        return { from: range.from, to: range.to, text: value.slice(marks, -marks).replace(/\n/g, ' '), literal: true };
      });
      window.MarkdownMini.mathRanges(rawText).forEach(range => {
        const from = textFrom + range.from, to = textFrom + range.to;
        if (!literals.some(code => code.from < to && code.to > from)) literals.push({ from, to, text: rawText.slice(range.from, range.to), literal: true });
      });
      const wikis = [];
      for (const match of rawText.matchAll(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g)) {
        const from = textFrom + match.index;
        if (!literals.some(range => range.from < from + match[0].length && range.to > from)) wikis.push({ from, to: from + match[0].length, text: match[2] || match[1] });
      }
      const replacements = [...literals, ...wikis];
      omitted = omitted.filter(range => !replacements.some(item => item.from < range.to && item.to > range.from)).concat(replacements).sort((a, b) => a.from - b.from);
      const unescape = value => value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1');
      let label = '', position = textFrom;
      for (const range of omitted) {
        if (range.to <= textFrom || range.from >= textTo) continue;
        label += unescape(visibleSource.slice(position, range.from)) + (range.literal ? range.text : unescape(range.text || '')); position = range.to;
      }
      label += unescape(visibleSource.slice(position, textTo));
      label = label.replace(/\s+/g, ' ').trim();
      if (label) headings.push({ from: node.from, to: node.to, level: Number(heading[1] || heading[2]), text, label });
      yield;
    }
    return headings;
  }

  function noteHeadingsFromString(source, options) {
    const scan = scanNoteHeadings(source, options);
    let step;
    do { step = scan.next(); } while (!step.done);
    return step.value;
  }

  function calloutPresentationType(type) {
    return window.MarkdownMini.noteBlock(type).type;
  }

  function completeSpec(spec, prior) {
    const source = String(spec.source || '');
    return Object.assign({}, spec, {
      id: prior && prior.id || 'note-block-' + nextBlockSpecId++,
      source,
      fingerprint: spec.kind === 'table' && prior?.source === source ? prior.fingerprint : sourceFingerprint(source),
      ...(spec.kind === 'table' && window.MarkdownTable ? { tableModel: spec.tableModel
        || (prior?.source === source ? prior.tableModel : null)
        || window.MarkdownTable.parse(source, { ensureBodyRow: false }).model } : {}),
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

  function scanSourceComments(doc, start, end, protectedBlocks) {
    const commentFrom = Math.max(0, start - BLOCK_MATH_LIMIT);
    const commentTo = Math.min(doc.length, end + BLOCK_MATH_LIMIT);
    const ranges = [];
    let cursor = commentFrom, open = null;
    const scan = (from, to) => {
      while (from < to) {
        let finish = Math.min(to, from + RICH_BLOCK_LIMIT);
        if (finish < to && doc.lineAt(finish).from > from) finish = doc.lineAt(finish).from;
        const source = doc.sliceString(from, finish), markers = /<!--|-->|%%/g;
        let marker;
        while ((marker = markers.exec(source))) {
          if (open) {
            if (marker[0] === open.close) { ranges.push({ from: open.from, to: from + marker.index + marker[0].length }); open = null; }
          } else if (marker[0] !== '-->') open = { from: from + marker.index, close: marker[0] === '<!--' ? '-->' : '%%' };
        }
        from = finish;
      }
    };
    protectedBlocks.slice().sort((a, b) => a.from - b.from).forEach(range => {
      if (range.to <= cursor || range.from >= commentTo) return;
      scan(cursor, Math.min(range.from, commentTo)); cursor = Math.max(cursor, range.to);
    });
    scan(cursor, commentTo);
    if (open) ranges.push({ from: open.from, to: commentTo });
    return ranges;
  }

  function scanBlockSpecs(state, from, to, reusable, completeTree, mathProtected) {
    const doc = state.doc;
    const specs = [];
    if (!doc.length) return specs;
    const start = clamp(from, 0, doc.length);
    const end = clamp(typeof to === 'number' ? to : doc.length, start, doc.length);
    const raw = [];
    const seen = new Set();
    const protectedBlocks = [];
    const metadata = documentFrontmatter(doc);
    if (metadata) protectedBlocks.push(metadata);
    const push = (spec) => {
      if (spec.kind === 'table') {
        const sameStart = raw.find((item) => item.kind === 'table' && item.from === spec.from);
        if (sameStart) { Object.assign(sameStart, spec); return; }
      }
      const key = spec.kind + ':' + spec.from + ':' + spec.to;
      if (seen.has(key)) return;
      seen.add(key); raw.push(spec);
    };

    const tree = completeTree || syntaxTree(state);
    tree.iterate({
      from: start, to: end,
      enter(node) {
        if (node.name === 'Table') {
          if (node.to - node.from > RICH_BLOCK_LIMIT) return false;
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
          const firstLine = doc.lineAt(node.from), lastLine = doc.lineAt(Math.max(node.from, node.to - 1));
          const quote = window.MarkdownMini.quoteLine(firstLine.text);
          const opener = fenceStart(quote.text);
          if (!opener) return false;
          const kind = opener.language === 'derive' ? 'derive' : mermaidEnabled() && MERMAID_LANGS.has(opener.language) ? 'mermaid' : '';
          const limit = kind === 'mermaid' ? MERMAID_LIMIT : RICH_BLOCK_LIMIT;
          if (!kind || node.to - firstLine.from > limit || !isFenceEnd(window.MarkdownMini.stripQuote(lastLine.text, quote.depth), opener)) return false;
          if (!rangeHasLongLine(doc, node.from, node.to)) {
            const from = quote.depth ? firstLine.from : node.from;
            const source = doc.sliceString(from, node.to);
            push({ from, to: node.to, kind, source, language: opener.language,
              renderSource: quote.depth ? source.split('\n').map(line => window.MarkdownMini.stripQuote(line, quote.depth)).join('\n') : source });
          }
          return false;
        }
        if (/^(?:CodeBlock|IndentedCode|HTMLBlock|InlineCode)$/.test(node.name)) {
          protectedBlocks.push({ from: node.from, to: node.to });
          return false;
        }
        if (node.name === 'Blockquote') {
          if (node.to - node.from > RICH_BLOCK_LIMIT) return false;
          const source = doc.sliceString(node.from, node.to);
          const callout = parseCalloutSource(source);
          if (callout && source.length <= RICH_BLOCK_LIMIT && !rangeHasLongLine(doc, node.from, node.to)) push(Object.assign({ from: node.from, to: node.to, kind: 'callout', source }, callout));
          return undefined;
        }
        if (node.name === 'Image') {
          const line = doc.lineAt(node.from);
          if (node.to <= line.to && !doc.sliceString(line.from, node.from).trim() && !doc.sliceString(node.to, line.to).trim()) {
            const image = parseStandaloneImage(line.text);
            if (image && image.target && previewableImage(image.target) && line.length <= MAX_RICH_LINE && (!canvasImage(image) || canvasEnabled())) {
              push({
                from: line.from, to: line.to, kind: canvasImage(image) ? 'canvas' : 'image', source: line.text,
                target: image.target, alt: image.alt, width: image.width, height: image.height,
              });
            }
          }
          return false;
        }
        return undefined;
      },
    });

    // Skip known code/HTML without reading it; comments are scanned only in
    // bounded gaps and can continue across a protected block.
    protectedBlocks.push(...scanSourceComments(doc, start, end, protectedBlocks));
    if (mathProtected) mathProtected.push(...protectedBlocks);

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
      // Lezer's GFM grammar and our shared grammar differ on literal pipes in
      // code/math. Use the same bounded table parser as the renderer/writer,
      // outside code, HTML and quoted blocks, so cell edits cannot lose their grid.
      const tableSyntax = window.MarkdownTable;
      if (tableSyntax && line.from <= end && number < doc.lines && !/^\s*(?:>|[-+*]\s|\d+[.)]\s)/.test(line.text)
          && tableSyntax.rowHasDelimiter(line.text) && tableSyntax.isSeparatorLine(doc.line(number + 1).text)) {
        const lines = [line.text, doc.line(number + 1).text];
        let next = number + 2, length = lines[0].length + lines[1].length + 1;
        while (next <= doc.lines && length <= RICH_BLOCK_LIMIT) {
          const candidate = doc.line(next);
          if (candidate.length > MAX_RICH_LINE || !candidate.text.trim() || !tableSyntax.rowHasDelimiter(candidate.text)) break;
          length += candidate.length + 1; lines.push(candidate.text); next++;
        }
        if (length <= RICH_BLOCK_LIMIT) {
          const parsed = tableSyntax.parseLines(lines, 0, { ensureBodyRow: false });
          if (parsed.ok && parsed.endLine === lines.length) {
            const tableTo = doc.line(number + lines.length - 1).to;
            if (tableTo >= start) push({ from: line.from, to: tableTo, kind: 'table', source: doc.sliceString(line.from, tableTo) });
            number += lines.length; continue;
          }
        }
      }
      const standaloneImage = parseStandaloneImage(line.text);
      if (standaloneImage && standaloneImage.target && previewableImage(standaloneImage.target) && line.to >= start && line.from <= end) {
        if (canvasImage(standaloneImage) && !canvasEnabled()) { number += 1; continue; }
        push({
          from: line.from, to: line.to, kind: canvasImage(standaloneImage) ? 'canvas' : 'image', source: line.text,
          target: standaloneImage.target, alt: standaloneImage.alt,
          width: standaloneImage.width, height: standaloneImage.height,
        });
        number += 1;
        continue;
      }
      const quote = window.MarkdownMini.quoteLine(line.text);
      const singleLine = sameLineBlockMath(quote.text) || (/^\\\[.+\\\]$/.test(quote.text.trim()) ? { source: quote.text } : null);
      if (singleLine) {
        const protectedSource = protectedBlocks.some((range) => range.from < line.to && range.to > line.from);
        if (!protectedSource && line.length <= BLOCK_MATH_LIMIT && line.to >= start && line.from <= end) {
          push({ from: line.from, to: line.to, kind: 'math', source: line.text, renderSource: quote.text });
        }
        number += 1;
        continue;
      }
      const opener = quote.text.trim();
      if (opener !== '$$' && opener !== '\\[') { number += 1; continue; }
      const closer = opener === '$$' ? '$$' : '\\]';
      let close = number + 1;
      while (close <= doc.lines && doc.line(close).from - line.from <= BLOCK_MATH_LIMIT && window.MarkdownMini.quoteLine(doc.line(close).text).depth >= quote.depth && window.MarkdownMini.stripQuote(doc.line(close).text, quote.depth).trim() !== closer) close += 1;
      if (close <= doc.lines && window.MarkdownMini.quoteLine(doc.line(close).text).depth === quote.depth && window.MarkdownMini.stripQuote(doc.line(close).text, quote.depth).trim() === closer) {
        const closeLine = doc.line(close);
        const source = doc.sliceString(line.from, closeLine.to);
        const protectedSource = protectedBlocks.some((range) => range.from < closeLine.to && range.to > line.from);
        if (!protectedSource && source.length <= BLOCK_MATH_LIMIT && closeLine.to >= start && line.from <= end) push({ from: line.from, to: closeLine.to, kind: 'math', source, renderSource: source.split('\n').map((value) => window.MarkdownMini.stripQuote(value, quote.depth)).join('\n') });
        number = close + 1;
      } else number += 1;
    }

    raw.sort((a, b) => a.from - b.from || b.to - a.to);
    if (metadata) {
      for (let index = raw.length - 1; index >= 0; index--) if (raw[index].from < metadata.to) raw.splice(index, 1);
    }
    const pool = Array.isArray(reusable) ? reusable.slice() : [];
    return raw.map((spec) => {
      if (spec.kind === 'math') {
        const parent = raw.filter(item => item.kind === 'callout' && item.from < spec.from && item.to >= spec.to).sort((a, b) => b.from - a.from)[0];
        if (parent) {
          const descriptor = window.MarkdownMini.noteBlock(parent.type, parent.title, parent.suffix);
          spec.calloutType = parent.type; spec.calloutLast = parent.to === spec.to;
          spec.colorFirst = descriptor.color && !descriptor.title && doc.lineAt(parent.from).to + 1 === spec.from;
        }
      }
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
      if (node && node.name !== 'Document' && node.to - node.from <= RICH_BLOCK_LIMIT) {
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
    // Large pastes are projected lazily, like initial document loads. Their
    // distant blocks are discovered by the viewport plugin when scrolled into view.
    const expanded = expandScanRange(transaction.state, scanFrom, Math.min(scanTo, scanFrom + RICH_BLOCK_LIMIT));
    mapped.forEach((spec) => {
      if (spec.from <= expanded.to && spec.to >= expanded.from) reusable.push(spec);
    });
    const rescanned = scanBlockSpecs(transaction.state, expanded.from, expanded.to, reusable);
    const actualTo = rescanned.reduce((value, spec) => Math.max(value, spec.to), expanded.to);
    const kept = mapped.filter((spec) => spec.to < expanded.from || spec.from > actualTo);
    return kept.concat(rescanned).sort((a, b) => a.from - b.from || a.to - b.to);
  }

  function localTableCellUpdate(previous, transaction, coordinator) {
    const type = window.RelatumNoteTableEditor?.cellUpdateEffect;
    const effects = type ? transaction.effects.filter(effect => effect.is(type)) : [];
    if (!transaction.docChanged || effects.length !== 1) return null;
    const edit = effects[0].value;
    if (!edit || typeof edit !== 'object') return null;
    const old = previous.find(spec => spec.id === edit.id && spec.kind === 'table');
    if (!old?.tableModel || edit.epoch !== coordinator.epoch || old.tableModel !== edit.baseModel
        || old.from !== edit.from || old.to !== edit.to || old.source !== edit.source) return null;
    const width = old.tableModel.header.length;
    if (edit.kind === 'alignment') {
      const line = transaction.startState.doc.line(transaction.startState.doc.lineAt(old.from).number + 1);
      if (line.from !== edit.lineFrom || line.to !== edit.lineTo || line.to > old.to
          || !['left', 'center', 'right'].includes(edit.align) || !Array.isArray(edit.columns)
          || !edit.columns.length || new Set(edit.columns).size !== edit.columns.length
          || edit.columns.some(col => !Number.isInteger(col) || col < 0 || col >= width)
          || typeof edit.insert !== 'string' || edit.insert.replace(/:/g, '') !== line.text.replace(/:/g, '')
          || !window.MarkdownTable.isSeparatorLine(edit.insert)
          || !transaction.newSelection.eq(transaction.startState.selection.map(transaction.changes))) return null;
      const tokens = window.MarkdownTable.splitRow(edit.insert);
      const align = tokens.map(token => token.startsWith(':') ? token.endsWith(':') ? 'center' : 'left' : token.endsWith(':') ? 'right' : '');
      if (align.length !== width || align.some((value, col) => value !== (edit.columns.includes(col) ? edit.align : old.tableModel.align[col]))) return null;
      let count = 0, valid = true;
      transaction.changes.iterChanges((from, to, fromB, toB, inserted) => {
        count++; if (from !== line.from || to !== line.to || inserted.sliceString(0) !== edit.insert) valid = false;
      });
      if (!valid || count !== 1) return null;
      const from = transaction.changes.mapPos(old.from, -1), to = transaction.changes.mapPos(old.to, 1);
      const tableModel = { header: old.tableModel.header, rows: old.tableModel.rows, align };
      const next = Object.assign({}, old, { from, to, source: transaction.state.doc.sliceString(from, to), tableModel,
        fingerprint: 'table-align:' + nextTableCellVersion++, cellDelta: null,
        alignmentDelta: { previous: old.tableModel, columns: edit.columns } });
      return { edit, specs: previous.map(spec => spec === old ? next : Object.assign({}, spec, {
        from: transaction.changes.mapPos(spec.from, -1), to: transaction.changes.mapPos(spec.to, 1) })) };
    }
    if (!Number.isInteger(edit.row) || edit.row < 0 || edit.row > old.tableModel.rows.length
        || !Number.isInteger(edit.col) || edit.col < 0 || edit.col >= width || !Array.isArray(edit.cells) || edit.cells.length !== width) return null;
    const baseCells = edit.row ? old.tableModel.rows[edit.row - 1] : old.tableModel.header;
    if (edit.cells.some((value, col) => typeof value !== 'string' || col !== edit.col && value !== baseCells[col])
        || transaction.startState.doc.sliceString(old.from, old.to) !== old.source) return null;
    if (!transaction.newSelection.eq(transaction.startState.selection.map(transaction.changes))) return null;
    const first = transaction.startState.doc.lineAt(old.from);
    const line = transaction.startState.doc.line(first.number + (edit.row ? edit.row + 1 : 0));
    if (line.from !== edit.lineFrom || line.to !== edit.lineTo || line.to > old.to
        || window.MarkdownTable.serializeRow(edit.cells, width) !== edit.insert) return null;
    let count = 0, valid = true;
    transaction.changes.iterChanges((from, to, fromB, toB, inserted) => {
      count++; if (from !== line.from || to !== line.to || inserted.sliceString(0) !== edit.insert) valid = false;
    });
    if (!valid || count !== 1) return null;
    const from = transaction.changes.mapPos(old.from, -1), to = transaction.changes.mapPos(old.to, 1);
    if (to - from > RICH_BLOCK_LIMIT || edit.insert.length > MAX_RICH_LINE) return null;
    const rows = old.tableModel.rows.slice(), cells = window.MarkdownTable.splitRow(edit.insert, width);
    if (edit.row) rows[edit.row - 1] = cells;
    const tableModel = { header: edit.row ? old.tableModel.header : cells, rows, align: old.tableModel.align };
    const source = transaction.state.doc.sliceString(from, to);
    // Table equality also compares source/model identity. A local version avoids
    // hashing the entire known table for every character and survives rescans.
    const next = Object.assign({}, old, { from, to, source, tableModel, fingerprint: 'table-cell:' + nextTableCellVersion++,
      cellDelta: { previous: old.tableModel, row: edit.row, col: edit.col } });
    return { edit, specs: previous.map(spec => spec === old ? next : Object.assign({}, spec, {
      from: transaction.changes.mapPos(spec.from, -1), to: transaction.changes.mapPos(spec.to, 1) })) };
  }

  function validatedLocalCellViewUpdate(update, field) {
    const type = window.RelatumNoteTableEditor?.cellUpdateEffect;
    return !!type && update.docChanged && update.transactions.every(transaction => !transaction.docChanged || transaction.effects.some(effect =>
      effect.is(type) && transaction.state.field(field, false)?.localCellEdit === effect.value));
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
  let mathEditQueue = Promise.resolve();
  // Share the preview slot with note AI without importing note-reading behavior.
  async function typesetMath(host, isCurrent) {
    const previous = mathEditQueue;
    let release;
    mathEditQueue = new Promise(resolve => { release = resolve; });
    try {
      await previous;
      if (!isCurrent()) return false;
      const math = await ensureMathJax();
      await math.startup?.promise;
      if (!isCurrent()) return false;
      await math.typesetPromise([host]);
      if (!isCurrent()) { math.typesetClear?.([host]); return false; }
      return true;
    } finally { release(); }
  }
  function ensureMathJax() {
    if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') return Promise.resolve(window.MathJax);
    if (mathLoadPromise) return mathLoadPromise;
    if (!window.MathJax || typeof window.MathJax !== 'object') {
      window.MathJax = {
        tex: { inlineMath: [['$', '$'], ['\\(', '\\)']], displayMath: [['$$', '$$'], ['\\[', '\\]']], processEscapes: true },
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

  function editableMathSource(spec) {
    const source = (spec.renderSource || spec.source).trim();
    return source.slice(2, -2).trim() ? source : '';
  }

  // This widget adds height after the closing delimiter without replacing any
  // editable source or taking part in atomic cursor navigation.
  class MathEditPreviewWidget extends WidgetType {
    constructor(spec, coordinator) { super(); this.spec = spec; this.coordinator = coordinator; this.epoch = coordinator.epoch; }
    eq(other) {
      return other.epoch === this.epoch && other.spec.id === this.spec.id && other.spec.fingerprint === this.spec.fingerprint
        && other.spec.calloutType === this.spec.calloutType && other.spec.calloutLast === this.spec.calloutLast;
    }
    toDOM(view) {
      const dom = document.createElement('div');
      dom.contentEditable = 'false';
      dom.addEventListener('mousedown', event => { if (!event.button) event.preventDefault(); });
      this.updateDOM(dom, view);
      return dom;
    }
    updateDOM(dom, view) {
      const owner = view.plugin(this.coordinator.mathPreviewPlugin);
      if (!owner || dom.__relatumMathPreview && dom.__relatumMathPreview.epoch !== this.epoch) return false;
      owner.attach(dom, this.spec);
      return true;
    }
    destroy(dom) { dom.__relatumMathPreview?.owner.detach(dom); }
    ignoreEvent() { return true; }
  }

  function measureMermaid(view, dom, coordinator, id) {
    view.requestMeasure({ key: dom, read() { return dom.isConnected ? dom.getBoundingClientRect().height : 0; },
      write(height) {
        if (!height) return;
        const heights = coordinator.mermaidHeights ||= new Map();
        heights.delete(id); heights.set(id, height);
        while (heights.size > 32) heights.delete(heights.keys().next().value);
      },
    });
  }

  class MermaidEditPreviewWidget extends WidgetType {
    constructor(spec, coordinator) { super(); this.spec = spec; this.coordinator = coordinator; this.epoch = coordinator.epoch; }
    eq(other) {
      return other.epoch === this.epoch && other.spec.id === this.spec.id && other.spec.fingerprint === this.spec.fingerprint
        && other.spec.calloutType === this.spec.calloutType && other.spec.calloutLast === this.spec.calloutLast;
    }
    get estimatedHeight() { return this.coordinator.mermaidHeights?.get(this.spec.id) || 70; }
    toDOM(view) {
      const dom = document.createElement('div'); dom.contentEditable = 'false';
      dom.addEventListener('mousedown', event => { if (!event.button) event.preventDefault(); });
      this.updateDOM(dom, view); return dom;
    }
    updateDOM(dom, view) {
      const owner = view.plugin(this.coordinator.mermaidPreviewPlugin);
      if (!owner || dom.__relatumMermaidPreview && dom.__relatumMermaidPreview.epoch !== this.epoch) return false;
      owner.attach(dom, this.spec); return true;
    }
    destroy(dom) { dom.__relatumMermaidPreview?.owner.detach(dom); }
    ignoreEvent() { return true; }
  }

  function createMermaidEditPreviewPlugin(coordinator) {
    const plugin = ViewPlugin.fromClass(class {
      constructor(view) { this.view = view; this.entries = new Map(); this.disposed = false; }
      attach(dom, spec) {
        let entry = this.entries.get(dom);
        if (!entry) {
          entry = { owner: this, dom, spec, epoch: coordinator.epoch, control: null };
          this.entries.set(dom, entry); dom.__relatumMermaidPreview = entry;
          dom.innerHTML = safeIsolatedResult(spec.renderSource || spec.source).html;
          entry.control = attachNoteMermaid(dom, { mode: 'live', editing: true, historyKey: entry.epoch + ':' + spec.id,
            isCurrent: () => {
              if (this.disposed || entry.epoch !== coordinator.epoch || this.entries.get(dom) !== entry || compositionActive(this.view)) return false;
              const value = this.view.state.field(coordinator.field, false), current = value?.byId.get(entry.spec.id);
              return !!current && value.activeIds.has(current.id) && current.source === entry.spec.source;
            },
            whenSettled: () => runWhenInputSettled(this.view, () => true),
            onLayout: () => runWhenInputSettled(this.view, () => {
              if (!this.disposed && entry.epoch === coordinator.epoch && dom.isConnected) {
                dom.style.removeProperty('min-height'); measureMermaid(this.view, dom, coordinator, entry.spec.id);
              }
            }),
          });
        }
        entry.spec = spec;
        dom.className = 'note-live-rich-block is-mermaid note-live-mermaid-preview';
        dom.setAttribute('aria-label', document.documentElement.lang === 'en' ? 'Diagram preview' : '图表预览');
        if (spec.calloutType) {
          const descriptor = window.MarkdownMini.noteBlock(spec.calloutType);
          dom.classList.add('note-block-math'); dom.classList.toggle('note-color-block', !!descriptor.color);
          dom.classList.toggle('note-live-callout-last', !!spec.calloutLast); dom.style.cssText = descriptor.style;
        } else dom.removeAttribute('style');
        const height = coordinator.mermaidHeights?.get(spec.id);
        if (height && !dom.querySelector('.note-mermaid-stage > svg')) dom.style.minHeight = height + 'px';
        entry.control.update(fencedCodeBody(spec.renderSource || spec.source), spec.language);
      }
      detach(dom) {
        const entry = this.entries.get(dom); if (!entry) return;
        this.entries.delete(dom); delete dom.__relatumMermaidPreview; entry.control.destroy();
      }
      destroy() { this.disposed = true; Array.from(this.entries.keys()).forEach(dom => this.detach(dom)); }
    });
    coordinator.mermaidPreviewPlugin = plugin; return plugin;
  }

  function createMathEditPreviewPlugin(coordinator) {
    const plugin = ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view; this.entries = new Map(); this.timer = 0; this.running = false; this.disposed = false;
        this.workspaceActive = true; this.pageActive = true;
        this.visibility = () => this.syncVisibility();
        this.workspace = event => { this.workspaceActive = event.detail.workspace === 'notes'; this.syncVisibility(); };
        this.pagehide = () => { this.pageActive = false; this.pause(); };
        this.pageshow = () => { this.pageActive = true; this.syncVisibility(); };
      }
      foreground() {
        return this.pageActive && this.workspaceActive && !document.hidden && document.documentElement.dataset.desktopMinimized !== '1'
          && this.view.dom.isConnected && !this.view.dom.closest('[hidden]');
      }
      current(entry, version) {
        if (this.disposed || this.entries.get(entry.dom) !== entry || entry.version !== version
            || coordinator.epoch !== entry.epoch || !entry.dom.isConnected || !this.foreground() || compositionActive(this.view)) return false;
        const value = this.view.state.field(coordinator.field, false), spec = value?.byId.get(entry.spec.id);
        return !!spec && value.activeIds.has(spec.id) && spec.source === entry.spec.source;
      }
      watch() {
        document.addEventListener('visibilitychange', this.visibility);
        document.addEventListener('relatum:start-workspacechange', this.workspace);
        window.addEventListener('canvasdesktop:visibility', this.visibility);
        window.addEventListener('pagehide', this.pagehide);
        window.addEventListener('pageshow', this.pageshow);
        this.observer = new MutationObserver(this.visibility);
        const host = this.view.dom.closest('.note-live-editor-host');
        if (host) this.observer.observe(host, { attributes: true, attributeFilter: ['hidden'] });
        const workspace = this.view.dom.closest('.note-workspace');
        if (workspace) this.observer.observe(workspace, { attributes: true, attributeFilter: ['hidden'] });
      }
      unwatch() {
        document.removeEventListener('visibilitychange', this.visibility);
        document.removeEventListener('relatum:start-workspacechange', this.workspace);
        window.removeEventListener('canvasdesktop:visibility', this.visibility);
        window.removeEventListener('pagehide', this.pagehide);
        window.removeEventListener('pageshow', this.pageshow);
        this.observer?.disconnect(); this.observer = null;
      }
      clear(node) {
        if (!node) return;
        try { window.MathJax?.typesetClear?.([node]); } catch (error) {}
        node.remove();
      }
      attach(dom, spec) {
        let entry = this.entries.get(dom);
        if (!entry) {
          if (!this.entries.size) this.watch();
          const status = document.createElement('div');
          status.className = 'note-live-math-status'; status.hidden = true;
          dom.appendChild(status);
          entry = { owner: this, dom, status, spec, epoch: coordinator.epoch, version: 0, pending: true, due: performance.now() };
          this.entries.set(dom, entry); dom.__relatumMathPreview = entry;
        } else if (editableMathSource(entry.spec) !== editableMathSource(spec)) {
          entry.version++; entry.pending = true; entry.due = performance.now() + 120;
        }
        entry.spec = spec;
        dom.className = 'note-live-rich-block is-math md-math-block note-live-math-preview';
        dom.setAttribute('aria-label', document.documentElement.lang === 'en' ? 'Formula preview' : '公式预览');
        if (spec.calloutType) {
          const descriptor = window.MarkdownMini.noteBlock(spec.calloutType);
          dom.classList.add('note-block-math');
          dom.classList.toggle('note-color-block', !!descriptor.color);
          dom.classList.toggle('note-live-callout-last', !!spec.calloutLast);
          dom.style.cssText = descriptor.style;
        } else dom.removeAttribute('style');
        this.schedule();
      }
      detach(dom) {
        const entry = this.entries.get(dom);
        if (!entry) return;
        entry.version++; this.entries.delete(dom); delete dom.__relatumMathPreview;
        this.clear(entry.content); this.clear(entry.stage);
        if (!this.entries.size) { clearTimeout(this.timer); this.timer = 0; this.unwatch(); }
      }
      pause() {
        clearTimeout(this.timer); this.timer = 0;
        this.entries.forEach(entry => {
          entry.version++; entry.pending = true; entry.due = performance.now();
          this.clear(entry.content); this.clear(entry.stage);
          entry.content = entry.stage = null; entry.status.hidden = true;
        });
      }
      syncVisibility() { if (!this.foreground()) this.pause(); else this.schedule(); }
      schedule() {
        clearTimeout(this.timer); this.timer = 0;
        if (this.disposed || this.running || !this.entries.size || !this.foreground() || compositionActive(this.view)) return;
        let next = null;
        this.entries.forEach(entry => { if (entry.pending && (!next || entry.due < next.due)) next = entry; });
        if (next) this.timer = setTimeout(() => { this.timer = 0; this.render(next); }, Math.max(0, next.due - performance.now()));
      }
      incomplete(entry, unavailable) {
        entry.status.textContent = document.documentElement.lang === 'en'
          ? (unavailable ? 'Formula preview unavailable' : 'Formula is incomplete')
          : (unavailable ? '公式预览暂不可用' : '公式尚未完成');
        entry.status.hidden = false;
        this.view.requestMeasure();
      }
      async render(entry) {
        if (!this.current(entry, entry.version)) return;
        this.running = true; entry.pending = false;
        const version = entry.version;
        const previous = mathEditQueue;
        let release;
        mathEditQueue = new Promise(resolve => { release = resolve; });
        let stage = null, processed = false;
        try {
          // A replaced editor/plugin can still have a typeset in flight. Share
          // the slot across those lifetimes and discard stale work before it runs.
          await previous;
          if (!this.current(entry, version)) return;
          const math = await ensureMathJax();
          await math.startup?.promise;
          if (!this.current(entry, version)) return;
          stage = document.createElement('div');
          stage.className = 'note-live-math-stage'; stage.setAttribute('aria-hidden', 'true');
          stage.textContent = editableMathSource(entry.spec);
          entry.stage = stage; entry.dom.appendChild(stage);
          await math.typesetPromise([stage]);
          if (!this.current(entry, version)) return;
          processed = true;
          // The bundled noundefined extension emits a red literal command
          // instead of merror while, for example, \frac is only half typed.
          const undefinedControl = Array.from(stage.querySelectorAll('mjx-assistive-mml mtext[mathcolor="red"]')).some(node =>
            /^\\[a-z]+$/i.test(node.textContent) && node.getAttribute('mathvariant') !== 'monospace'
            && editableMathSource(entry.spec).includes(node.textContent));
          if (!stage.querySelector('mjx-container') || stage.querySelector('mjx-merror, [data-mjx-error], merror') || undefinedControl) {
            this.incomplete(entry, false);
          } else {
            this.clear(entry.content);
            stage.className = 'note-live-math-preview-content'; stage.removeAttribute('aria-hidden');
            entry.content = stage; entry.stage = null; stage = null;
            entry.status.hidden = true;
            this.view.requestMeasure();
          }
        } catch (error) {
          if (this.current(entry, version)) { processed = true; this.incomplete(entry, true); }
        } finally {
          this.clear(stage);
          if (entry.stage === stage) entry.stage = null;
          if (!processed && this.entries.get(entry.dom) === entry && entry.version === version) entry.pending = true;
          release();
          this.running = false; this.schedule();
        }
      }
      update() { if (this.entries.size) this.schedule(); }
      destroy() { this.disposed = true; Array.from(this.entries.keys()).forEach(dom => this.detach(dom)); }
    });
    coordinator.mathPreviewPlugin = plugin;
    return plugin;
  }

  class TaskWidget extends WidgetType {
    constructor(checked, from, options) { super(); this.checked = checked; this.from = from; this.options = options; }
    eq(other) { return other.checked === this.checked && other.from === this.from; }
    toDOM(view) {
      const wrap = document.createElement('span');
      wrap.className = 'note-live-task-widget';
      const box = document.createElement('input');
      box.type = 'checkbox'; box.checked = this.checked; box.className = 'note-live-task';
      const english = document.documentElement.lang === 'en';
      box.setAttribute('aria-label', english ? (this.checked ? 'Mark incomplete' : 'Mark complete') : (this.checked ? '标记为未完成' : '标记为完成'));
      box.addEventListener('mousedown', (event) => event.preventDefault());
      box.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        if (compositionActive(view) || view.state.readOnly || !/^\[[ xX]\]$/.test(view.state.doc.sliceString(this.from, this.from + 3))) return;
        view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: this.checked ? ' ' : 'x' },
          userEvent: 'input.note-task', annotations: CM.isolateHistory ? CM.isolateHistory.of('full') : [] });
        view.focus();
      });
      const anchor = document.createElement('span');
      anchor.className = 'note-live-task-anchor';
      anchor.setAttribute('aria-hidden', 'true');
      // A view-only glyph measures the normal text baseline after the checkbox
      // margin, even when there is no editable text on the line yet.
      anchor.textContent = '\u200b';
      wrap.append(box, anchor);
      return wrap;
    }
    coordsAt(dom, position) {
      if (!position) return null;
      const rect = dom.lastElementChild.getBoundingClientRect();
      return { left: rect.left, right: rect.left, top: rect.top, bottom: rect.bottom };
    }
    ignoreEvent() { return false; }
  }

  class BulletWidget extends WidgetType {
    constructor(ordered, label) { super(); this.ordered = ordered; this.label = label; }
    eq(other) { return other.ordered === this.ordered && other.label === this.label; }
    toDOM() {
      const span = document.createElement('span');
      span.className = 'note-live-list-marker' + (this.ordered ? '' : ' is-unordered');
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
      const delimiterLength = this.source.startsWith('\\(') ? 2 : 1;
      const inside = Math.max(this.from + delimiterLength, this.to - delimiterLength);
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
        }).finally(() => {
          if ((this.token !== token || !span.isConnected || this.coordinator.epoch !== this.epoch) && typeof math.typesetClear === 'function') math.typesetClear([span]);
        });
      }).catch(() => { span.classList.add('is-failed'); });
      return span;
    }
    destroy(dom) { this.token = null; if (dom && typeof window.MathJax?.typesetClear === 'function') window.MathJax.typesetClear([dom]); }
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
    return parsed && !canvasImage(parsed) ? { from: from, to: to, parsed: parsed } : null;
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
    const onWheel = (event) => {
      if (event.ctrlKey || event.metaKey) return;
      const labels = Array.from(event.currentTarget.querySelectorAll('.note-image-text-box:not(.note-image-text-measurer), .note-image-text-editor')).reverse();
      for (const label of labels) {
        if (label.hidden) continue;
        const rect = label.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) continue;
        const before = label.scrollTop;
        const unit = event.deltaMode === 1 ? parseFloat(getComputedStyle(label).lineHeight) || 16 : event.deltaMode === 2 ? label.clientHeight : 1;
        label.scrollTop += event.deltaY * unit;
        if (before !== label.scrollTop) { event.preventDefault(); event.stopPropagation(); }
        break;
      }
    };
    const update = (frame) => {
      if (!frame || !frame.isConnected) return;
      const width = frame.getBoundingClientRect().width;
      const unit = (width / 100) + 'px';
      if (width > 0 && frame.style.getPropertyValue('--note-image-text-unit') !== unit) frame.style.setProperty('--note-image-text-unit', unit);
      frame.dispatchEvent(new Event('image-text-measure'));
      const sizes = Array.from(frame.querySelectorAll('.note-image-text-box:not(.note-image-text-measurer)')).filter(label => !label.hidden).map(label => {
        const rect = label.getBoundingClientRect();
        return { label, width: (rect.width / 2) + 'px', height: (rect.height / 2) + 'px' };
      });
      sizes.forEach(({ label, width, height }) => {
        if (label.style.getPropertyValue('--image-text-half-width') !== width) label.style.setProperty('--image-text-half-width', width);
        if (label.style.getPropertyValue('--image-text-half-height') !== height) label.style.setProperty('--image-text-half-height', height);
      });
    };
    const refresh = () => frames.forEach(update);
    window.addEventListener('relatum:image-text-scale', refresh);
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => entries.forEach((entry) => update(entry.target))) : null;
    return {
      observe(frame) {
        if (!frame || frames.has(frame)) return;
        frames.add(frame); update(frame);
        frame.addEventListener('wheel', onWheel, { passive: false });
        if (observer) observer.observe(frame);
      },
      unobserve(frame) {
        frames.delete(frame);
        frame.removeEventListener('wheel', onWheel);
        if (observer) observer.unobserve(frame);
      },
      update,
      destroy() {
        window.removeEventListener('relatum:image-text-scale', refresh);
        if (observer) observer.disconnect();
        frames.forEach((frame) => frame.removeEventListener('wheel', onWheel));
        frames.clear();
      },
    };
  }

  function imageTextItemId() {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'image-text-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function imageFailureLabel(code) {
    const labels = {
      unsafe_path: ['仅支持笔记库内相对路径，请将图片放入笔记库后使用相对路径', 'Only relative paths inside the note library are supported'],
      not_found: ['图片不存在，请检查相对路径或图片是否已移动', 'Image not found; check its relative path or whether it was moved'],
      unsupported_type: ['不支持这种图片格式，请使用 PNG、JPEG、WebP、GIF 或 BMP', 'Unsupported image format; use PNG, JPEG, WebP, GIF or BMP'],
      too_large: ['图片超过文件大小或像素尺寸限制', 'Image exceeds the file size or pixel dimension limit'],
      ambiguous_image: ['图片文件名不唯一，请使用库内完整路径', 'Image name is ambiguous; use a full vault path'],
    };
    return (labels[code] || ['图片无法加载', 'Image could not be loaded'])[document.documentElement.lang === 'en' ? 1 : 0];
  }

  function prepareLocalImage(image, frame, url, target, isCurrent) {
    image.__noteImageCleanup?.();
    let disposed = false, requested = false, cancelProbe = null;
    const current = () => !disposed && image.__noteImageCleanup === cleanup && image.isConnected && frame.isConnected && (!isCurrent || isCurrent());
    const foreground = () => !document.hidden && document.documentElement.dataset.desktopMinimized !== '1'
      && !frame.closest('[hidden]') && (!frame.closest('.note-workspace') || document.body.dataset.startWorkspace === 'notes');
    const show = code => {
      const label = imageFailureLabel(code);
      frame.classList.add('is-failed'); frame.dataset.errorLabel = label;
      const fallback = frame.querySelector('.md-local-image-fallback');
      if (fallback) fallback.textContent = label;
    };
    const failed = () => {
      if (!current()) return;
      const failedUrl = image.src;
      show(''); image.removeAttribute('src');
      if (requested || !foreground()) return;
      requested = true;
      const endpoint = new URL(failedUrl, document.baseURI);
      if (endpoint.origin !== location.origin || endpoint.pathname !== '/api/note-asset') return;
      const controller = new AbortController();
      const events = [[document, 'visibilitychange'], [window, 'canvasdesktop:visibility'],
        [document, 'relatum:start-workspacechange'], [window, 'pagehide']];
      const cancel = () => { controller.abort(); finish(); };
      const lifecycle = event => { if (event.type === 'pagehide' || !current() || !foreground()) cancel(); };
      const timer = setTimeout(cancel, 5000);
      const finish = () => {
        clearTimeout(timer);
        events.forEach(([host, name]) => host.removeEventListener(name, lifecycle));
        if (cancelProbe === cancel) cancelProbe = null;
      };
      cancelProbe = cancel;
      events.forEach(([host, name]) => host.addEventListener(name, lifecycle));
      fetch(failedUrl, { signal: controller.signal }).then(response => {
        if (response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
        return response.json();
      }).then(error => {
        if (!controller.signal.aborted && current() && foreground() && !image.hasAttribute('src') && error?.code) show(error.code);
      }).catch(() => {}).finally(finish);
    };
    function cleanup() {
      disposed = true; cancelProbe?.(); image.removeEventListener('error', failed);
      if (image.__noteImageCleanup === cleanup) delete image.__noteImageCleanup;
    }
    image.__noteImageCleanup = cleanup;
    image.addEventListener('error', failed, { once: true });
    if (absoluteImageTarget(target)) { show('unsafe_path'); image.removeAttribute('src'); }
    else image.src = url;
    return cleanup;
  }

  function releaseImageFailures(root) {
    root?.querySelectorAll('img').forEach(image => image.__noteImageCleanup?.());
  }

  function createInteractiveImage(owner, view, parsed, notePath, options, resolveRange, block) {
    const initial = resolveRange();
    const frame = document.createElement('span');
    frame.className = 'note-live-image-frame ' + (block ? 'is-block' : 'is-inline');
    frame.setAttribute('role', 'img');
    frame.setAttribute('aria-label', parsed.alt || parsed.target.split('/').pop() || '图片');
    imageContextResolvers.set(frame, resolveRange);
    applyImageDimensions(frame, parsed);
    if (initial && imageSelectionMatches(view, initial.from, initial.to)) frame.classList.add('is-selected');

    const image = document.createElement('img');
    image.alt = parsed.alt || parsed.target.split('/').pop() || '';
    image.loading = 'lazy'; image.decoding = 'async';
      image.addEventListener('load', () => {
        if (!frame.isConnected) return;
        if (options.imageTextSizer) options.imageTextSizer.update(frame);
        runWhenInputSettled(view, () => { if (frame.isConnected) view.requestMeasure(); });
      }, { once: true });
    frame.appendChild(image);
    const cleanupImage = prepareLocalImage(image, frame, options.imageUrl(notePath, parsed.target, parsed.syntax), parsed.target,
      () => { const range = resolveRange(); return absoluteImageTarget(parsed.target) || !!range && range.parsed.target === parsed.target; });

    const imageTextItems = block && !absoluteImageTarget(parsed.target) && Array.isArray(parsed.imageTextItems) ? parsed.imageTextItems : [];
    const imageTextController = block && !absoluteImageTarget(parsed.target) && parsed.imageTextEditable !== false ? options.imageTextController : null;
    let imageTextLayer = null;
    let imageTextDraftCleanup = null;
    let imageTextDraftCommit = false;
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
      element.style.left = 'clamp(var(--image-text-half-width, 0px), ' + (item.x * 100) + '%, calc(100% - var(--image-text-half-width, 0px)))';
      element.style.top = 'clamp(var(--image-text-half-height, 0px), ' + (item.y * 100) + '%, calc(100% - var(--image-text-half-height, 0px)))';
      element.dataset.imageTextSize = item.size;
      element.dataset.imageTextColor = item.color;
    }

    function clampImageTextPosition(item, element) {
      const imageRect = image.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      if (!imageRect.width || !imageRect.height) return item;
      const halfX = Math.min(.5, elementRect.width / imageRect.width / 2);
      const halfY = Math.min(.5, elementRect.height / imageRect.height / 2);
      return Object.assign({}, item, {
        x: clamp(item.x, halfX, 1 - halfX),
        y: clamp(item.y, halfY, 1 - halfY),
      });
    }

    function cancelDraft(dispose) {
      // A draft whose page-side pointer already scheduled a commit must land
      // that commit instead of dropping the visible text when another box or
      // the mode itself takes over.
      if (imageTextDraftCleanup) imageTextDraftCleanup(dispose ? false : imageTextDraftCommit, !!dispose);
    }

    function beginTextEdit(item, point) {
      if (!imageTextLayer || !imageTextController || !imageTextController.active) return;
      if (imageTextController.draftActive) return;
      cancelDraft();
      imageTextDraftCommit = false;
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
      frame.classList.add('is-image-text-editing');
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
      frame.addEventListener('image-text-measure', fit);
      let finished = false;
      let textComposing = false;
      let pendingCommit = false;
      let finishFrame = 0;
      let pagePointerPreeditText = null;
      let dismissAfterFinish = false;
      let switchAfterFinish = '';
      let switchGesture = null;
      const restoreSwitchPreview = () => {
        if (switchGesture && switchGesture.item && switchGesture.label.isConnected) {
          positionStyle(switchGesture.label, switchGesture.item);
          switchGesture.label.classList.remove('is-dragging');
        }
      };
      const clearSwitchGesture = () => {
        document.removeEventListener('pointermove', onSwitchMove, true);
        document.removeEventListener('pointerup', onSwitchUp, true);
        document.removeEventListener('pointercancel', onSwitchCancel, true);
      };
      const finish = (commit, dispose) => {
        if (finished) return;
        if (textComposing && !dispose) { pendingCommit = pendingCommit || commit; return; }
        finished = true;
        frame.classList.remove('is-image-text-editing');
        restoreSwitchPreview();
        imageTextDraftCommit = false;
        if (finishFrame) cancelAnimationFrame(finishFrame);
        editor.removeEventListener('blur', onBlur);
        editor.removeEventListener('keydown', onKeyDown);
        editor.removeEventListener('contextmenu', onContextMenu);
        editor.removeEventListener('input', fit);
        frame.removeEventListener('image-text-measure', fit);
        editor.removeEventListener('compositionstart', onCompositionStart);
        editor.removeEventListener('compositionend', onCompositionEnd);
        document.removeEventListener('pointerdown', onPagePointerDown, true);
        clearSwitchGesture();
        editor.remove();
        measurer.remove();
        if (prior) {
          prior.hidden = false;
          if (!commit || dispose) {
            prior.textContent = item.text;
            positionStyle(prior, item);
          }
        }
        if (options.imageTextSizer) options.imageTextSizer.update(frame);
        imageTextDraftCleanup = null;
        const text = editor.value.replace(/\r\n?/g, '\n').slice(0, 1000);
        const switchedTo = dispose ? '' : switchAfterFinish;
        switchAfterFinish = '';
        if (!commit || (isNew && !text.trim())) {
          imageTextController.select(isNew ? '' : draft.id);
          imageTextController.endDraft();
          if (switchedTo) imageTextController.switchTo(switchedTo, switchGesture);
          if (dismissAfterFinish) imageTextController.setActive(false);
          return;
        }
        const items = currentItems();
        const next = Object.assign({}, draft, { text: text });
        const index = items.findIndex((candidate) => candidate.id === draft.id);
        if (!text.trim()) {
          if (index >= 0) items.splice(index, 1);
        } else if (index >= 0) items[index] = next; else items.push(next);
        try {
          commitImageTextItems(items, text.trim() ? draft.id : '');
        } finally {
          imageTextController.endDraft();
        }
        // Committing re-pins this box; the box the user clicked wins instead.
        if (switchedTo) imageTextController.switchTo(switchedTo, switchGesture);
        if (dismissAfterFinish) imageTextController.setActive(false);
      };
      const finishCommittedText = () => {
        if (finished) return;
        imageTextDraftCommit = true;
        if (textComposing || (switchGesture && !switchGesture.released)) { pendingCommit = true; return; }
        if (finishFrame) cancelAnimationFrame(finishFrame);
        let quietFrames = 0;
        const settle = () => {
          finishFrame = 0;
          if (finished) return;
          if (textComposing || (switchGesture && !switchGesture.released)) { pendingCommit = true; return; }
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
      const onContextMenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Right-click is an explicit commit, like leaving the text field.
        // Preserve visible preedit while the native IME host loses focus;
        // do not remove that host before its compositionend arrives.
        if (textComposing) pagePointerPreeditText = editor.value;
        finishCommittedText();
        view.focus();
      };
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
      const onSwitchMove = (event) => {
        if (!switchGesture || event.pointerId !== switchGesture.pointerId) return;
        switchGesture.dx = event.clientX - switchGesture.x;
        switchGesture.dy = event.clientY - switchGesture.y;
        switchGesture.moved = switchGesture.moved || Math.abs(switchGesture.dx) > 3 || Math.abs(switchGesture.dy) > 3;
        if (switchGesture.moved && switchGesture.item) {
          const rect = image.getBoundingClientRect();
          const preview = Object.assign({}, switchGesture.item, {
            x: switchGesture.item.x + switchGesture.dx / Math.max(1, rect.width),
            y: switchGesture.item.y + switchGesture.dy / Math.max(1, rect.height),
          });
          positionStyle(switchGesture.label, clampImageTextPosition(preview, switchGesture.label));
          switchGesture.label.classList.add('is-dragging');
        }
      };
      const onSwitchUp = (event) => {
        if (!switchGesture || event.pointerId !== switchGesture.pointerId) return;
        onSwitchMove(event);
        switchGesture.released = true;
        clearSwitchGesture();
        finishCommittedText();
      };
      const onSwitchCancel = (event) => {
        if (!switchGesture || event.pointerId !== switchGesture.pointerId) return;
        switchGesture.released = true;
        switchAfterFinish = '';
        clearSwitchGesture();
        finishCommittedText();
      };
      const onPagePointerDown = (event) => {
        if (finished || editor.contains(event.target)) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target && frame.contains(target) && target.closest('.note-live-image-resize-handle')) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        const keepsToolsOpen = target && target.closest(
          '[data-role="note-image-text-tools"], [data-role="note-image-text-toggle"]'
        );
        if (keepsToolsOpen) {
          if (textComposing) {
            pagePointerPreeditText = editor.value;
            pendingCommit = true;
          }
          return;
        }
        // Own the complete gesture: committing can replace the clicked DOM.
        // Resolve its id through the current adapter only after the old draft
        // settles, and distinguish a click from a drag before opening an editor.
        const nextBox = event.button === 0 && target
          ? target.closest('.note-image-text-box[data-image-text-id]') : null;
        if (nextBox && frame.contains(nextBox)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          restoreSwitchPreview();
          switchAfterFinish = nextBox.dataset.imageTextId || '';
          switchGesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
            dx: 0, dy: 0, moved: false, released: false, label: nextBox,
            item: currentItems().find((item) => item.id === switchAfterFinish) };
          document.addEventListener('pointermove', onSwitchMove, true);
          document.addEventListener('pointerup', onSwitchUp, true);
          document.addEventListener('pointercancel', onSwitchCancel, true);
          imageTextDraftCommit = true;
          if (textComposing) pagePointerPreeditText = editor.value;
          pendingCommit = true;
          // Bridge the settling frames with the visible draft, not the stale
          // persisted label. Keep the native IME host alive but hide its UI.
          // Reuse the label so pointer hit testing and measured geometry stay
          // unchanged while the source transaction is still pending.
          if (prior) {
            prior.textContent = editor.value;
            positionStyle(prior, draft);
            prior.hidden = false;
            prior.classList.remove('is-selected');
          }
          editor.style.visibility = 'hidden';
          editor.setAttribute('aria-hidden', 'true');
          editor.blur();
          return;
        }
        switchAfterFinish = '';
        restoreSwitchPreview();
        clearSwitchGesture();
        switchGesture = null;
        if (textComposing) {
          pagePointerPreeditText = editor.value;
          pendingCommit = true;
        }
        if (view.dom.contains(event.target)) {
          // Keep CodeMirror from replacing the selected image range while the
          // hidden native textarea completes its composition lifecycle.
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        // Close the visible UI synchronously, but keep the native textarea in
        // the DOM until compositionend. Removing an active IME host here can
        // discard the raw preedit value on WebView2.
        dismissAfterFinish = true;
        editor.style.visibility = 'hidden';
        editor.setAttribute('aria-hidden', 'true');
        imageTextController.suppressDraftUi();
        editor.blur();
        if (!textComposing) finishCommittedText();
      };
      editor.addEventListener('blur', onBlur);
      editor.addEventListener('keydown', onKeyDown);
      editor.addEventListener('contextmenu', onContextMenu);
      editor.addEventListener('input', fit);
      editor.addEventListener('compositionstart', onCompositionStart);
      editor.addEventListener('compositionend', onCompositionEnd);
      document.addEventListener('pointerdown', onPagePointerDown, true);
      ['pointerdown', 'mousedown', 'click', 'dblclick'].forEach((name) => {
        editor.addEventListener(name, (event) => event.stopPropagation());
      });
      imageTextDraftCleanup = finish;
      // Focus synchronously so the very first native input/IME event belongs
      // to the textarea, never the selected Markdown image source.
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
      requestAnimationFrame(() => {
        if (!finished && !pendingCommit && !imageTextDraftCommit && !dismissAfterFinish && !switchGesture && editor.isConnected
            && document.activeElement !== editor && !textComposing) editor.focus();
      });
      return editor;
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
        const continueEditing = !!imageTextController.switchFrame;
        if (continueEditing) {
          cancelAnimationFrame(imageTextController.switchFrame);
          imageTextController.switchFrame = 0;
        }
        view.focus();
        imageTextController.select(item.id);
        const imageRect = image.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        const halfX = Math.min(.5, labelRect.width / Math.max(1, imageRect.width) / 2);
        const halfY = Math.min(.5, labelRect.height / Math.max(1, imageRect.height) / 2);
        const startX = (labelRect.left + labelRect.width / 2 - imageRect.left) / Math.max(1, imageRect.width);
        const startY = (labelRect.top + labelRect.height / 2 - imageRect.top) / Math.max(1, imageRect.height);
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
          if (!commit || !moved) {
            positionStyle(label, item);
            if (commit && continueEditing) imageTextController.switchTo(item.id);
            else if (continueEditing) imageTextController.endDraft();
            return;
          }
          const items = currentItems();
          const index = items.findIndex((candidate) => candidate.id === item.id);
          if (index >= 0) {
            items[index] = Object.assign({}, items[index], { x: nextX, y: nextY });
            commitImageTextItems(items, item.id);
          }
          if (continueEditing) imageTextController.endDraft();
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
        image,
        setMode(active, armed, selectedId) {
          frame.classList.toggle('is-image-text-mode', !!active);
          frame.classList.toggle('is-image-text-armed', !!(active && armed));
          frame.querySelectorAll('.note-image-text-box').forEach((label) => {
            label.classList.toggle('is-selected', !!active && label.dataset.imageTextId === selectedId);
          });
        },
        command(name, value) {
          if (name === 'add') { imageTextController.toggleArm(); return; }
          const id = imageTextController.selectedId;
          if (!id) return;
          if (name === 'edit') {
            const item = currentItems().find((candidate) => candidate.id === id);
            return item ? beginTextEdit(item) : null;
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
            if (label) {
              const labelRect = label.getBoundingClientRect();
              items[index].x = (labelRect.left + labelRect.width / 2 - rect.left) / Math.max(1, rect.width);
              items[index].y = (labelRect.top + labelRect.height / 2 - rect.top) / Math.max(1, rect.height);
            }
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
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault(); event.stopPropagation();
        if (!absoluteImageTarget(parsed.target)) options.onOpenLocalFile(parsed.target, parsed.syntax);
        return;
      }
      select(event);
    });

    const cleanupResize = !absoluteImageTarget(parsed.target) && window.RelatumNoteMediaFrame ? window.RelatumNoteMediaFrame.resize(frame, {
      selected: frame.classList.contains('is-selected'), label: '等比例调整图片大小', resolve: resolveRange,
      blocked: () => !!(imageTextController && (imageTextController.draftActive || imageTextController.switchFrame)),
      maxWidth: () => (frame.closest('.cm-line') || view.contentDOM).getBoundingClientRect().right - frame.getBoundingClientRect().left,
      preview(width) {
        frame.classList.remove('has-explicit-box'); frame.classList.add('has-explicit-size');
        frame.style.aspectRatio = ''; frame.style.width = width + 'px'; frame.style.maxWidth = '100%'; view.requestMeasure();
      },
      restore(current) { frame.style.width = ''; frame.style.maxWidth = ''; frame.style.aspectRatio = ''; applyImageDimensions(frame, current.parsed); view.requestMeasure(); },
      commit(width) {
        const current = resolveRange(), markdownMini = window.MarkdownMini; if (!current) return;
        const resized = markdownMini.serializeImage(current.parsed.image || current.parsed, { width });
        const replacement = current.parsed.imageTextItems ? markdownMini.serializeImageBlock(current.parsed, current.parsed.imageTextItems, resized) : resized;
        if (!replacement || replacement === current.parsed.source) { applyImageDimensions(frame, current.parsed); view.requestMeasure(); return; }
        view.dispatch({ changes: { from: current.from, to: current.to, insert: replacement },
          selection: EditorSelection.range(current.from, current.from + replacement.length), scrollIntoView: true, userEvent: 'input.image-text' });
        view.focus();
      },
    }) : null;
    owner.imageCleanup = () => {
      cleanupImage();
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

  function safeIsolatedResult(source, options) {
    const markdownMini = window.MarkdownMini;
    if (!markdownMini || typeof markdownMini.renderResult !== 'function') {
      return { html: '', features: { math: false, mermaid: false }, error: true };
    }
    return markdownMini.renderResult(source, Object.assign({ localImages: true, noteTags: true, noteBlocks: true, noteSyntax: true, mermaid: mermaidEnabled() }, options));
  }

  function releaseReadingDocument(host) {
    if (!host) return;
    releaseImageFailures(host);
    host.__relatumReadingMermaid?.destroy();
    delete host.__relatumReadingMermaid;
    if (host.__relatumReadingCode) host.__relatumReadingCode.destroy();
    delete host.__relatumReadingCode;
    host.querySelectorAll('[data-canvas-source]').forEach(frame => frame.__noteCanvas?.destroy());
    host.querySelectorAll('.note-live-image-frame').forEach(frame => frame.__canvasObserver?.disconnect());
    host.dataset.noteReadingEpoch = String((Number(host.dataset.noteReadingEpoch) || 0) + 1);
    if (window.MathJax && typeof window.MathJax.typesetClear === 'function') {
      try { window.MathJax.typesetClear([host]); } catch (error) {}
    }
    if (host.__relatumImageTextSizer) host.__relatumImageTextSizer.destroy();
    delete host.__relatumImageTextSizer;
    host.replaceChildren();
  }

  function renderMarkdown(host, source, notePath, options) {
    if (!host) throw new Error('Markdown reading host is required');
    const safeOptions = Object.assign({
      imageUrl(path, target, syntax) {
        return '/api/note-asset?note=' + encodeURIComponent(path || '') + '&src=' + encodeURIComponent(target || '') + '&syntax=' + encodeURIComponent(syntax || 'markdown');
      },
    }, options || {});
    releaseReadingDocument(host);
    const epoch = host.dataset.noteReadingEpoch;
    const imageTextSizer = createImageTextSizer();
    host.__relatumImageTextSizer = imageTextSizer;
    const original = window.MarkdownMini.structure.normalizeSource(source);
    const canvasRefs = canvasEnabled() ? window.MarkdownMini.canvasReferences(original) : [];
    let renderedSource = original;
    canvasRefs.slice().reverse().forEach((ref, index) => {
      const ordinal = canvasRefs.length - index - 1;
      renderedSource = renderedSource.slice(0, ref.from) + '![](relatum-canvas-placeholder-' + ordinal + ')' + renderedSource.slice(ref.to);
    });
    let canvasShift = 0, canvasIndex = 0;
    const noteHeadings = noteHeadingsFromString(original).map(heading => {
      while (canvasIndex < canvasRefs.length && canvasRefs[canvasIndex].to <= heading.from) {
        const ref = canvasRefs[canvasIndex];
        canvasShift += ('![](relatum-canvas-placeholder-' + canvasIndex + ')').length - (ref.to - ref.from);
        canvasIndex++;
      }
      return Object.assign({}, heading, { from: heading.from + canvasShift, to: heading.to + canvasShift, sourceFrom: heading.from });
    });
    const noteSourcePosition = position => {
      let shift = 0;
      for (let index = 0; index < canvasRefs.length; index++) {
        const ref = canvasRefs[index], length = ('![](relatum-canvas-placeholder-' + index + ')').length;
        const start = ref.from + shift;
        if (position < start) break;
        if (position < start + length) return ref.from;
        shift += length - (ref.to - ref.from);
      }
      return position - shift;
    };
    const readingSyntax = window.MarkdownMini.noteSyntax.scan(renderedSource);
    const result = safeIsolatedResult(renderedSource, { noteHeadings, noteSourcePosition, noteContext: readingSyntax });
    const content = document.createElement('article');
    content.className = 'note-reading-content node-text';
    content.innerHTML = result.html;
    const jumpReading = event => {
      const link = event.target.closest('[data-note-jump]'); if (!link) return;
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); event.stopPropagation();
      const position = Number(link.dataset.noteJump);
      let target = content.querySelector('[data-note-heading-from="' + position + '"], [data-note-definition-from="' + position + '"], [data-note-source-from="' + position + '"]');
      if (!target) {
        const use = readingSyntax.uses.find(item => noteSourcePosition(item.from) === position);
        if (use) target = content.querySelector('[data-note-footnote-ref^="' + use.number + '-"]');
      }
      if (target) { target.scrollIntoView({ block: 'center' }); target.tabIndex = -1; target.focus({ preventScroll: true }); }
    };
    content.addEventListener('click', jumpReading); content.addEventListener('keydown', jumpReading);
    const sourceLines = original.split('\n');
    let sourceOffset = 0;
    const sourceLineOffsets = sourceLines.map(line => { const from = sourceOffset; sourceOffset += line.length + 1; return from; });
    const metadata = window.MarkdownMini.frontmatter(original);
    const lineOffset = metadata ? original.slice(0, metadata.to).split('\n').length - 1 : 0;
    content.querySelectorAll('.note-block[data-fold]').forEach((block) => {
      if (!block.dataset.fold) return;
      const button = block.querySelector('.note-callout-fold');
      const body = block.querySelector('.md-callout-body');
      if (!button) return;
      const line = Number(block.dataset.ln) + lineOffset;
      const position = sourceLineOffsets[line] || 0;
      const session = safeOptions.calloutSession;
      let collapsed = session ? session.get(position, block.dataset.fold === '-') : block.dataset.fold === '-';
      const refresh = () => { if (body) body.hidden = collapsed; button.setAttribute('aria-expanded', String(!collapsed)); button.setAttribute('aria-label', collapsed ? 'Expand callout' : 'Collapse callout'); };
      refresh();
      button.addEventListener('click', () => { collapsed = !collapsed; if (session) session.set(position, collapsed); refresh(); });
    });
    // Notes present every table row as data, including the first Markdown row.
    content.querySelectorAll('table th').forEach((header) => {
      const cell = document.createElement('td');
      Array.from(header.attributes).forEach((attribute) => cell.setAttribute(attribute.name, attribute.value));
      cell.append(...header.childNodes); header.replaceWith(cell);
    });
    content.querySelectorAll('[data-note-image]').forEach((image) => {
      const placeholder = /^relatum-canvas-placeholder-(\d+)$/.exec(image.dataset.noteImage || '');
      if (placeholder) {
        const ref = canvasRefs[Number(placeholder[1])]; if (!ref) return;
        const prior = image.closest('.md-local-image');
        const frame = document.createElement('div'); frame.className = 'note-live-image-frame is-block has-explicit-size';
        const width = ref.parsed.width || 640, height = ref.parsed.height || width * 9 / 16;
        frame.style.cssText = `display:block;width:${width}px;max-width:100%;aspect-ratio:${width}/${height};border-radius:7px`;
        prior.replaceWith(frame);
        const target = window.MarkdownMini.canvasTarget(notePath, ref.parsed.target);
        const ordinal = canvasRefs.slice(0, Number(placeholder[1])).filter(item => window.MarkdownMini.canvasTarget(notePath, item.parsed.target).toLowerCase() === target.toLowerCase()).length;
        const observer = new IntersectionObserver(entries => {
          if (!entries.some(entry => entry.isIntersecting)) return;
          observer.disconnect();
          loadCanvasRuntime().then(runtime => {
            if (host.dataset.noteReadingEpoch === epoch && frame.isConnected) runtime.mount(frame, { note: notePath, parsed: ref.parsed, ordinal, readOnly: true, source: original.slice(ref.from, ref.to) });
          }).catch(() => {});
        }); observer.observe(frame); frame.__canvasObserver = observer;
        return;
      }
      const frame = image.closest('.md-local-image');
      prepareLocalImage(image, frame, safeOptions.imageUrl(String(notePath || ''), image.dataset.noteImage || '', image.dataset.noteImageSyntax),
        image.dataset.noteImage, () => host.dataset.noteReadingEpoch === epoch && content.isConnected);
      if (frame && frame.classList.contains('has-image-text')) {
        imageTextSizer.observe(frame);
        image.addEventListener('load', () => imageTextSizer.update(frame), { once: true });
      }
    });
    content.querySelectorAll('input.md-task-box').forEach((box) => { box.disabled = true; });
    host.replaceChildren(content);
    host.classList.toggle('is-failed', !!result.error);
    const current = () => host.dataset.noteReadingEpoch === epoch && content.isConnected;
    host.__relatumReadingCode = prepareReadingCode(content, current);
    if (result.features && result.features.mermaid && mermaidEnabled()) {
      window.RelatumNoteMermaid?.reserve?.(content, { mode: 'reading' });
      host.__relatumReadingMermaid = attachNoteMermaid(content, { mode: 'reading', isCurrent: current });
    }
    if (result.features && result.features.math) {
      ensureMathJax().then((math) => {
        if (!current()) return;
        return math.typesetPromise([content]).finally(() => {
          if (!current() && typeof math.typesetClear === 'function') math.typesetClear([content]);
        });
      }).catch(() => { if (current()) host.classList.add('is-failed'); });
    }
    return result;
  }

  function richBlockEditPosition(spec) {
    const source = String(spec && spec.source || '');
    const from = Number(spec && spec.from) || 0;
    if (spec && spec.kind === 'math') {
      const bracket = (spec.renderSource || source).trim().startsWith('\\[');
      const opener = source.indexOf(bracket ? '\\[' : '$$');
      const closer = source.lastIndexOf(bracket ? '\\]' : '$$');
      if (opener >= 0 && closer > opener) {
        let offset = opener + 2;
        if (source[offset] === '\r' && source[offset + 1] === '\n') offset += 2;
        else if (source[offset] === '\n') offset += 1;
        if (spec.renderSource && spec.renderSource !== source) offset += window.MarkdownMini.quoteLine(source.slice(offset).split('\n', 1)[0]).prefix.length;
        while (offset < closer && /[\t ]/.test(source[offset])) offset += 1;
        return from + Math.min(offset, closer);
      }
    }
    if (spec && (spec.kind === 'mermaid' || spec.kind === 'derive')) {
      const newline = source.indexOf('\n');
      if (newline >= 0) return from + newline + 1 + window.MarkdownMini.quoteLine(source.slice(newline + 1).split('\n', 1)[0]).prefix.length;
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
        && other.notePath === this.notePath && other.epoch === this.epoch && other.selected === this.selected
        && other.spec.calloutType === this.spec.calloutType && other.spec.calloutLast === this.spec.calloutLast && other.spec.colorFirst === this.spec.colorFirst;
    }
    get estimatedHeight() { return this.spec.kind === 'mermaid' ? this.coordinator.mermaidHeights?.get(this.spec.id) || 70 : -1; }
    isCurrent(view, wrap, token) {
      if (this.token !== token || !wrap.isConnected || this.coordinator.epoch !== this.epoch) return false;
      const current = this.coordinator.spec(view, this.spec.id);
      return !!current && current.fingerprint === this.spec.fingerprint && current.source === this.spec.source;
    }
    reveal(view, event) {
      if (event?.target.closest?.('[data-note-mermaid-control]')) return;
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
      if (this.spec.kind === 'mermaid' && this.coordinator.mermaidHeights?.has(this.spec.id)) {
        wrap.style.minHeight = this.coordinator.mermaidHeights.get(this.spec.id) + 'px';
      }
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
        wrap.textContent = this.spec.renderSource || this.spec.source;
        const parent = view.state.field(this.coordinator.field, false)?.specs.filter((spec) => spec.kind === 'callout' && spec.from <= this.spec.from && spec.to >= this.spec.to).sort((a, b) => b.from - a.from)[0];
        if (parent) {
          const descriptor = window.MarkdownMini.noteBlock(parent.type, parent.title, parent.suffix);
          wrap.classList.add('note-block-math');
          wrap.style.cssText = descriptor.style;
          if (descriptor.color) wrap.classList.add('note-color-block');
          if (parent.to === this.spec.to) wrap.classList.add('note-live-callout-last');
          if (this.spec.colorFirst) wrap.classList.add('note-live-callout-first');
        }
        ensureMathJax().then((math) => {
          if (!this.isCurrent(view, wrap, token)) return;
          return runWhenInputSettled(view, () => (
            this.isCurrent(view, wrap, token) ? math.typesetPromise([wrap]) : undefined
          )).then(() => {
            if (!this.isCurrent(view, wrap, token)) return;
            return runWhenInputSettled(view, () => {
              if (this.isCurrent(view, wrap, token)) view.requestMeasure();
            });
          }).finally(() => { if (!this.isCurrent(view, wrap, token) && typeof math.typesetClear === 'function') math.typesetClear([wrap]); });
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
        const result = safeIsolatedResult(this.spec.renderSource || this.spec.source);
        wrap.innerHTML = result.html;
        wrap.querySelectorAll('[data-note-image]').forEach((image) => {
          prepareLocalImage(image, image.closest('.md-local-image'), this.options.imageUrl(this.notePath, image.dataset.noteImage || '', image.dataset.noteImageSyntax),
            image.dataset.noteImage, () => this.isCurrent(view, wrap, token));
        });
        if (this.spec.kind === 'callout' && this.spec.collapsed) {
          wrap.classList.add('is-collapsed');
          wrap.querySelectorAll('.md-callout-body').forEach((body) => { body.hidden = true; });
        }
        const hasMermaid = this.spec.kind === 'mermaid' || !!(result.features && result.features.mermaid);
        const hasMath = this.spec.kind === 'derive' || !!(result.features && result.features.math);
        if (hasMermaid && mermaidEnabled()) {
          this.mermaidControl = attachNoteMermaid(wrap, { mode: 'live',
            historyKey: this.epoch + ':' + this.spec.id,
            isCurrent: () => this.isCurrent(view, wrap, token) && !compositionActive(view),
            whenSettled: () => runWhenInputSettled(view, () => true),
            onLayout: () => runWhenInputSettled(view, () => {
              if (this.isCurrent(view, wrap, token)) {
                wrap.style.removeProperty('min-height'); measureMermaid(view, wrap, this.coordinator, this.spec.id);
              }
            }),
          });
        }
        if (hasMath) {
          wrap.dataset.noteMath = '1';
          ensureMathJax().then((math) => {
            if (!this.isCurrent(view, wrap, token)) return;
            return runWhenInputSettled(view, () => (
              this.isCurrent(view, wrap, token) ? math.typesetPromise([wrap]) : undefined
            )).then(() => {
              if (!this.isCurrent(view, wrap, token)) return;
              return runWhenInputSettled(view, () => {
                if (this.isCurrent(view, wrap, token)) view.requestMeasure();
              });
            }).finally(() => { if (!this.isCurrent(view, wrap, token) && typeof math.typesetClear === 'function') math.typesetClear([wrap]); });
          }).catch(() => wrap.classList.add('is-failed'));
        }
      }
      return wrap;
    }
    destroy(dom) { this.token = null; releaseImageFailures(dom); this.mermaidControl?.destroy(); this.mermaidControl = null; if (this.imageCleanup) this.imageCleanup(); this.imageCleanup = null; if (dom && (this.spec.kind === 'math' || dom.dataset.noteMath) && typeof window.MathJax?.typesetClear === 'function') window.MathJax.typesetClear([dom]); }
    ignoreEvent() { return false; }
  }

  class CalloutTitleWidget extends WidgetType {
    constructor(spec, sourceOffset, coordinator) {
      super();
      this.spec = spec;
      this.sourceOffset = sourceOffset;
      this.coordinator = coordinator;
      this.collapsed = calloutCollapsed(spec, coordinator);
    }
    eq(other) {
      return other.spec.id === this.spec.id
        && other.spec.fingerprint === this.spec.fingerprint
        && other.sourceOffset === this.sourceOffset && other.collapsed === this.collapsed;
    }
    updateDOM(wrap) {
      if (wrap.dataset.blockId !== this.spec.id || wrap.dataset.fingerprint !== this.spec.fingerprint) return false;
      const button = wrap.querySelector('.note-callout-fold');
      if (button) { button.setAttribute('aria-expanded', String(!this.collapsed)); button.setAttribute('aria-label', this.collapsed ? 'Expand callout' : 'Collapse callout'); }
      return true;
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
      wrap.dataset.blockId = this.spec.id; wrap.dataset.fingerprint = this.spec.fingerprint;
      wrap.dataset.callout = calloutPresentationType(this.spec.type);
      const descriptor = window.MarkdownMini.noteBlock(this.spec.type, this.spec.title, this.spec.suffix);
      wrap.classList.toggle('note-color-block', descriptor.color);
      wrap.tabIndex = 0;
      wrap.setAttribute('aria-label', '点击编辑 Callout 源码');
      const rendered = document.createElement('span');
      // Render only the header. The body remains native CodeMirror text, and
      // must not be parsed again just to draw its title or while it is edited.
      rendered.innerHTML = safeIsolatedResult(this.spec.source.split('\n', 1)[0], { noteContext: noteSyntaxContext(view.state), noteFootnoteBody: true }).html;
      const title = rendered.querySelector('.md-callout-title');
      if (title) {
        Array.from(title.childNodes).forEach((node) => wrap.appendChild(node.cloneNode(true)));
      } else {
        wrap.textContent = descriptor.color ? '' : this.spec.title || this.spec.type || 'Note';
      }
      const button = wrap.querySelector('.note-callout-fold');
      if (button) bindLiveFold(button, view, this.spec, this.coordinator);
      wrap.addEventListener('mousedown', (event) => { if (!event.target.closest('.note-callout-fold')) this.reveal(view, event); });
      wrap.addEventListener('keydown', (event) => {
        if (!event.target.closest('.note-callout-fold') && (event.key === 'Enter' || event.key === ' ')) this.reveal(view, event);
      });
      return wrap;
    }
    ignoreEvent() { return true; }
  }

  function calloutCollapsed(spec, coordinator) {
    const descriptor = window.MarkdownMini.noteBlock(spec.type, spec.title, spec.suffix);
    return descriptor.foldable && (coordinator.folds.has(spec.id) ? coordinator.folds.get(spec.id) : coordinator.foldPositions?.has(spec.from) ? coordinator.foldPositions.get(spec.from) : spec.collapsed);
  }
  function bindLiveFold(button, view, spec, coordinator) {
    button.setAttribute('aria-expanded', String(!calloutCollapsed(spec, coordinator)));
    button.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
    button.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      runWhenInputSettled(view, () => {
        const current = coordinator.spec(view, spec.id);
        if (!current) return;
        const collapsed = !calloutCollapsed(current, coordinator);
        const header = view.state.doc.lineAt(current.from);
        const selection = collapsed && selectionTouches(view.state.selection, header.to + 1, current.to) ? EditorSelection.cursor(header.to) : undefined;
        view.dispatch({ effects: calloutFoldEffect.of({ id: current.id, collapsed }), ...(selection ? { selection } : {}) });
      });
    });
  }
  class CalloutFoldWidget extends WidgetType {
    constructor(spec, coordinator) { super(); this.spec = spec; this.coordinator = coordinator; this.collapsed = calloutCollapsed(spec, coordinator); }
    eq(other) { return other.spec.id === this.spec.id && other.collapsed === this.collapsed; }
    updateDOM(wrap) { if (wrap.dataset.blockId !== this.spec.id) return false; wrap.firstChild.setAttribute('aria-expanded', String(!this.collapsed)); wrap.firstChild.setAttribute('aria-label', this.collapsed ? 'Expand callout' : 'Collapse callout'); return true; }
    toDOM(view) { const wrap = document.createElement('span'); wrap.dataset.blockId = this.spec.id; wrap.innerHTML = window.MarkdownMini.foldButton(this.collapsed); bindLiveFold(wrap.firstChild, view, this.spec, this.coordinator); return wrap; }
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
      super(); this.label = String(label || ''); this.doc = doc; this.from = from; this.to = to;
    }
    // Keep the immutable document reference. Scrolling/selection must not copy a
    // potentially huge fence just to compare or display its tiny language badge.
    get code() { return fencedCodeBody(this.doc.sliceString(this.from, this.to)); }
    eq(other) { return other.label === this.label && other.doc === this.doc && other.from === this.from && other.to === this.to; }
    toDOM() {
      this.copyControl = codeCopyControl(this.label, () => this.code);
      return this.copyControl.button;
    }
    destroy() { if (this.copyControl) this.copyControl.destroy(); }
    ignoreEvent() { return true; }
  }

  function codeCopyControl(label, getCode, copyOnly = false) {
    const english = document.documentElement.lang === 'en';
    const button = document.createElement('button');
    const normalText = copyOnly || !label ? (english ? 'Copy' : '复制') : label;
    const copyLabel = english ? 'Copy' + (label ? ' ' + label : '') + ' code' : '复制' + (label ? ' ' + label : '') + '代码';
    let timer = 0, disposed = false;
    button.type = 'button'; button.className = 'note-live-code-language'; button.textContent = normalText;
    button.title = copyLabel; button.setAttribute('aria-label', copyLabel);
    button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
    button.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      const copied = await copyPlainText(getCode());
      if (disposed || !button.isConnected) return;
      clearTimeout(timer);
      const feedback = copied ? (english ? 'Copied' : '已复制') : (english ? 'Copy failed' : '复制失败');
      button.classList.toggle('is-copied', copied); button.classList.toggle('is-copy-failed', !copied);
      // Feedback lives inside the button; an overflowing pseudo-tooltip was
      // clipped by the badge's own ellipsis box.
      button.textContent = feedback; button.dataset.copyState = feedback; button.setAttribute('aria-label', feedback);
      timer = setTimeout(() => {
        button.classList.remove('is-copied', 'is-copy-failed'); delete button.dataset.copyState;
        button.textContent = normalText; button.setAttribute('aria-label', copyLabel); timer = 0;
      }, 1200);
    });
    return { button, destroy() { disposed = true; clearTimeout(timer); timer = 0; } };
  }

  function prepareReadingCode(content, current) {
    const jobs = new Set(), visible = new Set(), copies = [];
    let handle = 0, idle = false, destroyed = false;
    const foreground = () => !destroyed && current() && !document.hidden && document.documentElement.dataset.desktopMinimized !== '1';
    const cancel = () => {
      if (handle) { if (idle) window.cancelIdleCallback(handle); else clearTimeout(handle); }
      handle = 0;
    };
    const schedule = () => {
      if (handle || !foreground() || !visible.size) return;
      idle = typeof window.requestIdleCallback === 'function';
      handle = idle ? window.requestIdleCallback(run) : setTimeout(run, 0);
    };
    const finish = job => {
      visible.delete(job); jobs.delete(job); observer?.unobserve(job.pre); byElement.delete(job.pre);
      job.parse = null; job.pre.dataset.noteCodeReady = '1';
    };
    const run = () => {
      handle = 0;
      if (!foreground()) return;
      const until = performance.now() + 4;
      for (const job of visible) {
        try {
          job.parse ||= job.parser.startParse(job.source);
          let tree;
          do { tree = job.parse.advance(); } while (!tree && performance.now() < until);
          if (tree) {
            const spans = [];
            CM.highlightTree(tree, CM.relatumCodeStyle, (from, to, className) => { if (spans.length <= 4096) spans.push({ from, to, className }); });
            if (spans.length <= 4096 && foreground()) {
              const fragment = document.createDocumentFragment(); let offset = 0;
              spans.forEach(span => {
                if (span.from > offset) fragment.append(document.createTextNode(job.source.slice(offset, span.from)));
                const token = document.createElement('span'); token.className = span.className;
                token.textContent = job.source.slice(span.from, span.to); fragment.append(token); offset = span.to;
              });
              fragment.append(document.createTextNode(job.source.slice(offset))); job.code.replaceChildren(fragment);
            }
            finish(job);
          }
        } catch (error) { finish(job); } // Source remains safely readable on a lexer failure.
        if (performance.now() >= until) break;
      }
      schedule();
    };
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        const job = byElement.get(entry.target);
        if (!job || !jobs.has(job)) continue;
        if (entry.isIntersecting) visible.add(job); else visible.delete(job);
      }
      if (!visible.size) cancel(); else schedule();
    }, { root: content.closest('.note-reading-view'), rootMargin: '100px' }) : null;
    const byElement = new WeakMap();
    content.querySelectorAll('pre.md-code').forEach(pre => {
      const code = pre.querySelector('code'); if (!code) return;
      const source = code.textContent, label = pre.dataset.lang || '';
      const toolbar = document.createElement('span'); toolbar.className = 'note-code-toolbar'; toolbar.contentEditable = 'false';
      const caption = document.createElement('span'); caption.className = 'note-code-label'; caption.textContent = label;
      const control = codeCopyControl(label, () => source, true); copies.push(control);
      toolbar.append(caption, control.button); pre.prepend(toolbar); pre.classList.add('has-note-code-toolbar');
      const parser = CM.relatumCodeParser?.(label);
      if (!parser || !CM.highlightTree || !CM.relatumCodeStyle) return;
      // Replace the general renderer's approximate coloring, never its text.
      code.textContent = source;
      if (source.length > MAX_RICH_LINE) { pre.dataset.noteCodeReady = 'plain'; return; }
      const job = { pre, code, source, parser, parse: null }; jobs.add(job); byElement.set(pre, job);
      if (observer) observer.observe(pre); else visible.add(job);
    });
    if (!copies.length) { observer?.disconnect(); return { destroy() {} }; }
    const visibility = () => { if (!foreground()) cancel(); else schedule(); };
    const destroy = () => {
      if (destroyed) return; destroyed = true; cancel(); observer?.disconnect();
      jobs.clear(); visible.clear(); copies.forEach(copy => copy.destroy());
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('canvasdesktop:visibility', visibility); window.removeEventListener('pagehide', destroy);
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('canvasdesktop:visibility', visibility); window.addEventListener('pagehide', destroy);
    schedule(); return { destroy };
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
      if ((spec.kind === 'image' || spec.kind === 'canvas') && imageSelectionMatches(state, spec.from, spec.to)) selected.add(spec.id);
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
    return usesBlockReplacement(spec) && (spec.kind === 'image' || spec.kind === 'canvas' || spec.kind === 'table' || !activeIds.has(spec.id));
  }

  function blockWidget(spec, path, options, coordinator, selected) {
    if (spec.kind === 'canvas') return new CanvasBlockWidget(spec, path, options, coordinator, selected);
    return spec.kind === 'table' && options.tableController && spec.tableModel
      ? options.tableController.widget(spec, path, coordinator)
      : new RichBlockWidget(spec, path, options, coordinator, selected);
  }

  function compactBlockProjection(spec, state, options) {
    // With no text paragraph at all, Chromium needs an editable boundary line
    // to deliver native input without a keydown to the selected image text box.
    const imageTextInput = spec.kind === 'image' && spec.from === 0 && spec.to === state.doc.length
      && options.imageTextController?.active;
    return !imageTextInput && (spec.kind === 'math' || spec.kind === 'image' || spec.kind === 'canvas' || spec.kind === 'rule');
  }

  function blockAtomicRange(spec, state) {
    const media = spec.kind === 'image' || spec.kind === 'canvas';
    // Media stay projected when selected. Their adjacent newline positions
    // have no visible caret line, so keyboard navigation skips to the actual
    // preceding/following paragraph. Formula boundaries still reveal source.
    const from = media && spec.from > 0 ? spec.from - 1 : spec.from;
    const to = media && spec.to < state.doc.length ? spec.to + 1 : spec.to;
    return Decoration.replace({ block: true, inclusive: false, blockId: spec.id }).range(from, to);
  }

  function mergeBlockAtomicRanges(ranges) {
    let end = -1, overlapping = false;
    for (const cursor = ranges.iter(); cursor.value; cursor.next()) {
      if (cursor.from < end) { overlapping = true; break; }
      end = cursor.to;
    }
    if (!overlapping) return ranges;
    // Adjacent media cover the same newline. RangeSet.between() may visit
    // incrementally updated ranges out of source order, so overlapping ranges
    // can bounce CodeMirror's pointer cursor skipping between their endpoints.
    // Keep per-block identities for updates, but expose their disjoint union.
    const merged = [], atomic = Decoration.replace({ block: true, inclusive: false });
    let from = -1, to = -1;
    for (const cursor = ranges.iter(); cursor.value; cursor.next()) {
      if (cursor.from < to) to = Math.max(to, cursor.to);
      else {
        if (from >= 0) merged.push(atomic.range(from, to));
        from = cursor.from; to = cursor.to;
      }
    }
    if (from >= 0) merged.push(atomic.range(from, to));
    return Decoration.set(merged);
  }

  function mapBlockProjections(decorations, changes) {
    const mapped = decorations.map(changes);
    const repairs = new Map();
    // Inclusive block boundaries remove CodeMirror's empty boundary lines,
    // but adjacent input must still stay outside the hidden source. Repair only
    // touched boundaries, retaining the decoration and its existing widget.
    changes.iterChanges((start, end) => {
      decorations.between(start, end, (from, to, decoration) => {
        if (!decoration.spec.inclusive || !decoration.spec.blockId) return;
        if (start <= from && end >= to) {
          repairs.set(decoration.spec.blockId, null);
          return;
        }
        if ((start <= from && end === from) || (start === to && end >= to)) {
          const nextFrom = changes.mapPos(from, 1), nextTo = changes.mapPos(to, -1);
          repairs.set(decoration.spec.blockId, nextFrom < nextTo ? decoration.range(nextFrom, nextTo) : null);
        }
      });
    });
    if (!repairs.size) return mapped;
    return mapped.update({
      filter(from, to, decoration) { return !repairs.has(decoration.spec.blockId); },
      add: Array.from(repairs.values()).filter(Boolean), sort: true,
    });
  }

  function createBlockField(notePath, options, coordinator, inputSession) {
    coordinator.folds = coordinator.folds || new Map(); coordinator.records = coordinator.records || [];
    const atomicUnions = new WeakMap();
    // Specs and their parent subsets are source-ordered. Keep the furthest
    // containing endpoint instead of comparing every block with every parent.
    const descendants = (specs, parents) => {
      const ids = new Set();
      let index = 0, end = -1;
      specs.forEach(spec => {
        while (index < parents.length && parents[index].from < spec.from) end = Math.max(end, parents[index++].to);
        if (spec.to <= end) ids.add(spec.id);
      });
      return ids;
    };
    const projectionState = (specs) => {
      const callouts = specs.filter(spec => spec.kind === 'callout');
      const collapsed = callouts.filter(spec => calloutCollapsed(spec, coordinator));
      return { callouts, collapsed: new Set(collapsed.map(spec => spec.id)), hidden: descendants(specs, collapsed) };
    };
    const projectedSpecs = (specs, activeIds, projection) => specs.filter(spec => blockIsProjected(spec, activeIds) && !projection.hidden.has(spec.id));
    const mathPreviews = (specs, activeIds, projection) => specs.filter(spec => spec.kind === 'math'
      && activeIds.has(spec.id) && !projection.hidden.has(spec.id) && editableMathSource(spec)).map(spec => Decoration.widget({
      widget: new MathEditPreviewWidget(spec, coordinator), block: true, side: 1, blockId: spec.id, mathPreview: true,
    }).range(spec.to));
    const mermaidPreviews = (specs, activeIds, projection) => specs.filter(spec => spec.kind === 'mermaid'
      && activeIds.has(spec.id) && !projection.hidden.has(spec.id) && fencedCodeBody(spec.renderSource || spec.source).trim()).map(spec => Decoration.widget({
      widget: new MermaidEditPreviewWidget(spec, coordinator), block: true, side: 1, blockId: spec.id, mermaidPreview: true,
    }).range(spec.to));
    const calloutProjections = (projection, state, focused) => {
      const ranges = [];
      projection.callouts.forEach(spec => {
        if (projection.hidden.has(spec.id)) return;
        const header = state.doc.lineAt(spec.from);
        const descriptor = window.MarkdownMini.noteBlock(spec.type, spec.title, spec.suffix);
        if (projection.collapsed.has(spec.id) && header.to < spec.to) ranges.push(Decoration.replace({ block: true, inclusive: false, blockId: spec.id }).range(header.to, spec.to));
        if (descriptor.color && !descriptor.title && header.to < spec.to && !(focused && selectionTouches(state.selection, header.from, header.to))) ranges.push(Decoration.replace({ block: true, inclusiveStart: true, inclusiveEnd: false, blockId: spec.id, colorHeader: true }).range(header.from, header.to + 1));
      });
      return ranges;
    };
    const field = StateField.define({
      create(state) {
        const tree = syntaxTree(state);
        const parsedTo = Math.min(RICH_BLOCK_LIMIT, typeof tree.length === 'number' ? Math.min(state.doc.length, tree.length) : state.doc.length);
        const specs = scanBlockSpecs(state, 0, parsedTo, coordinator.records);
        const byId = new Map(specs.map((spec) => [spec.id, spec]));
        const selectedImageIds = selectedBlockImageIds(specs, state);
        const projection = projectionState(specs);
        const projected = projectedSpecs(specs, new Set(), projection);
        const hidden = calloutProjections(projection, state, false);
        const decorations = Decoration.set(projected.map((spec) => Decoration.replace({
          widget: blockWidget(spec, notePath(), options, coordinator,
            selectedImageIds.has(spec.id)),
          block: true, inclusive: compactBlockProjection(spec, state, options), blockId: spec.id,
        }).range(spec.from, spec.to)).concat(hidden), true);
        const atomic = Decoration.set(projected.map(spec => blockAtomicRange(spec, state)).concat(hidden.filter(range => !range.value.spec.colorHeader)), true);
        return { specs, byId, activeIds: new Set(), selectedImageIds, focused: false, decorations, atomic };
      },
      update(value, transaction) {
        let focused = value.focused;
        transaction.effects.forEach((effect) => { if (effect.is(focusEffect)) focused = !!effect.value; });
        const foldChanged = transaction.effects.some(effect => effect.is(calloutFoldEffect));
        transaction.effects.forEach(effect => { if (effect.is(calloutFoldEffect)) coordinator.folds.set(effect.value.id, effect.value.collapsed); });
        if (inputSession.pending()) {
          // The browser owns the preedit text until compositionend. Preserve
          // all projections and only map their positions through native edits;
          // reparsing/replacing neighbouring blocks can move the IME caret.
          const specs = transaction.docChanged ? value.specs.map((spec) => Object.assign({}, spec, {
            // Source ranges remain non-inclusive even when their visual block
            // boundaries are covered. Adjacent input stays outside the object.
            from: transaction.changes.mapPos(spec.from, 1),
            to: transaction.changes.mapPos(spec.to, -1),
          })) : value.specs;
          return Object.assign({}, value, {
            specs, byId: transaction.docChanged ? new Map(specs.map((spec) => [spec.id, spec])) : value.byId,
            selectedImageIds: value.selectedImageIds,
            focused,
            decorations: transaction.docChanged ? mapBlockProjections(value.decorations, transaction.changes) : value.decorations,
            atomic: transaction.docChanged ? value.atomic.map(transaction.changes) : value.atomic,
          });
        }
        const localCell = localTableCellUpdate(value.specs, transaction, coordinator);
        let specs = localCell ? localCell.specs : updateBlockSpecs(value.specs, transaction);
        let viewportRefreshed = false;
        let inputReconcileRanges;
        transaction.effects.forEach((effect) => {
          if (!effect.is(viewportScanEffect) && !effect.is(inputReconcileEffect)) return;
          specs = refreshVisibleBlockSpecs(specs, transaction.state, effect.value);
          if (effect.is(inputReconcileEffect)) inputReconcileRanges = effect.value;
          viewportRefreshed = true;
        });
        const notePathChanged = transaction.effects.some((effect) => effect.is(notePathEffect));
        const imageTextModeChanged = transaction.effects.some((effect) => effect.is(imageTextProjectionEffect));
        const inputReconciled = inputReconcileRanges !== undefined;
        const selectionChanged = !!transaction.selection;
        if (!transaction.docChanged && !selectionChanged && focused === value.focused && !notePathChanged && !imageTextModeChanged && !viewportRefreshed && !foldChanged) return value;

        const byId = specs === value.specs ? value.byId : new Map(specs.map((spec) => [spec.id, spec]));
        const activeIds = activeBlockIds(specs, transaction.state, focused, false);
        const selectedImageIds = selectedBlockImageIds(specs, transaction.state);
        const refresh = new Set();
        if (foldChanged) specs.forEach(spec => refresh.add(spec.id));
        if (selectionChanged || focused !== value.focused) {
          // Only entering/leaving a header can change its block projection.
          // Body caret movement keeps unrelated Callouts and their media intact.
          const candidates = new Set([...value.activeIds, ...activeIds]);
          candidates.forEach(id => {
            const old = value.byId.get(id), current = byId.get(id);
            if (!old || !current || current.kind !== 'callout') return;
            const before = transaction.startState.doc.lineAt(old.from);
            const after = transaction.state.doc.lineAt(current.from);
            if ((value.focused && selectionTouches(transaction.startState.selection, before.from, before.to))
                !== (focused && selectionTouches(transaction.state.selection, after.from, after.to))) refresh.add(id);
          });
        }
        if (byId !== value.byId) {
          value.byId.forEach((old, id) => {
            const current = byId.get(id);
            if (!current || old.from !== current.from || old.to !== current.to || old.fingerprint !== current.fingerprint
                || current.kind === 'table' && old.tableModel !== current.tableModel) refresh.add(id);
          });
          byId.forEach((current, id) => { if (!value.byId.has(id)) refresh.add(id); });
        }
        const refreshedCallouts = specs.filter(spec => spec.kind === 'callout' && refresh.has(spec.id));
        if (refreshedCallouts.length) descendants(specs, refreshedCallouts).forEach(id => refresh.add(id));
        value.activeIds.forEach((id) => { if (!activeIds.has(id)) refresh.add(id); });
        activeIds.forEach((id) => { if (!value.activeIds.has(id)) refresh.add(id); });
        value.selectedImageIds.forEach((id) => { if (!selectedImageIds.has(id)) refresh.add(id); });
        selectedImageIds.forEach((id) => { if (!value.selectedImageIds.has(id)) refresh.add(id); });
        if (imageTextModeChanged) specs.forEach(spec => {
          if (spec.kind === 'image' && spec.from === 0 && spec.to === transaction.state.doc.length) refresh.add(spec.id);
        });
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

        let decorations = transaction.docChanged ? mapBlockProjections(value.decorations, transaction.changes) : value.decorations;
        let atomic = transaction.docChanged ? value.atomic.map(transaction.changes) : value.atomic;
        if (refresh.size) {
          const projection = projectionState(specs);
          const projected = projectedSpecs(specs, activeIds, projection).filter(spec => refresh.has(spec.id));
          const hidden = calloutProjections(projection, transaction.state, focused).filter(range => refresh.has(range.value.spec.blockId));
          decorations = decorations.update({
            filter(from, to, decoration) { return !refresh.has(decoration.spec.blockId); },
            add: projected.map((spec) => Decoration.replace({
              widget: blockWidget(spec, notePath(), options, coordinator,
                selectedImageIds.has(spec.id)),
              block: true, inclusive: compactBlockProjection(spec, transaction.state, options), blockId: spec.id,
            }).range(spec.from, spec.to)).concat(hidden,
              mathPreviews(specs, activeIds, projection).filter(range => refresh.has(range.value.spec.blockId)),
              mermaidPreviews(specs, activeIds, projection).filter(range => refresh.has(range.value.spec.blockId))),
            sort: true,
          });
          atomic = atomic.update({
            filter(from, to, decoration) { return !refresh.has(decoration.spec.blockId); },
            add: projected.map(spec => blockAtomicRange(spec, transaction.state)).concat(hidden.filter(range => !range.value.spec.colorHeader)), sort: true,
          });
        }
        return { specs, byId, activeIds, selectedImageIds, focused, decorations, atomic, localCellEdit: localCell?.edit };
      },
      provide: (field) => [
        EditorView.decorations.from(field, (value) => value.decorations),
        EditorView.atomicRanges.of((view) => {
          const value = view.state.field(field, false);
          if (!value) return Decoration.none;
          if (!atomicUnions.has(value.atomic)) atomicUnions.set(value.atomic, mergeBlockAtomicRanges(value.atomic));
          return atomicUnions.get(value.atomic);
        }),
      ],
    });
    coordinator.field = field;
    coordinator.spec = (view, id) => {
      const value = view.state.field(field, false);
      return value && value.byId.get(id) || coordinator.records.find(spec => spec.id === id) || null;
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

  // Lexical colors only: never evaluate TeX or change the editable source.
  // Offsets stay relative to the original UTF-16 source, including quote prefixes.
  function scanMathSourceTokens(source, block) {
    const tokens = [], stack = [];
    const add = (from, to, kind) => tokens.push({ from, to, className: 'note-live-math-' + kind });
    const rawLines = source.split('\n');
    const depth = block ? window.MarkdownMini.quoteLine(rawLines[0]).depth : 0;
    let offset = 0;
    const lines = rawLines.map(raw => {
      const text = depth ? window.MarkdownMini.stripQuote(raw, depth) : raw;
      const line = { text, from: offset + raw.length - text.length };
      offset += raw.length + 1;
      return line;
    });
    const first = lines[0], last = lines[lines.length - 1];
    const firstText = first.text.trimStart(), open = /^(?:\$\$|\\\[|\\\(|\$)/.exec(firstText)?.[0];
    if (!open) return tokens;
    const close = open === '\\[' ? '\\]' : open === '\\(' ? '\\)' : open;
    const start = first.from + first.text.length - firstText.length;
    const end = last.from + last.text.trimEnd().length;
    if (end - start < open.length + close.length) return tokens;
    add(start, start + open.length, 'delimiter');
    for (const line of lines) {
      let index = Math.max(0, start + open.length - line.from);
      const limit = Math.min(line.text.length, end - close.length - line.from);
      while (index < limit) {
        const begin = index, char = line.text[index++];
        if (char === '%') { add(line.from + begin, line.from + limit, 'comment'); break; }
        if (char === '\\') {
          if (/[A-Za-z]/.test(line.text[index] || '')) {
            while (index < limit && /[A-Za-z]/.test(line.text[index])) index++;
          } else if (index < limit) index++;
          add(line.from + begin, line.from + index, 'command');
        } else if ('{[('.includes(char)) {
          const level = stack.length % 3;
          stack.push({ close: { '{': '}', '[': ']', '(': ')' }[char], level });
          add(line.from + begin, line.from + index, 'bracket-' + level);
        } else if ('}])'.includes(char)) {
          const top = stack[stack.length - 1];
          const level = top?.close === char ? stack.pop().level : stack.length % 3;
          add(line.from + begin, line.from + index, 'bracket-' + level);
        } else if (char === '^' || char === '_') add(line.from + begin, line.from + index, 'script');
        else if (/[0-9]/.test(char) || char === '.' && /[0-9]/.test(line.text[index] || '')) {
          while (index < limit && /[0-9]/.test(line.text[index])) index++;
          if (char !== '.' && line.text[index] === '.' && index + 1 < limit && /[0-9]/.test(line.text[index + 1])) {
            index++;
            while (index < limit && /[0-9]/.test(line.text[index])) index++;
          }
          add(line.from + begin, line.from + index, 'number');
        } else if (/[+\-=<>*/|&!:,;~]/.test(char)) add(line.from + begin, line.from + index, 'operator');
      }
    }
    add(end - close.length, end, 'delimiter');
    return tokens;
  }

  function createMathHighlightCache() {
    const entries = new Map();
    let size = 0;
    return {
      tokens(source, block) {
        const key = (block ? 'b' : 'i') + source;
        const prior = entries.get(key);
        if (prior) { entries.delete(key); entries.set(key, prior); return prior; }
        const tokens = scanMathSourceTokens(source, block);
        entries.set(key, tokens); size += key.length;
        // Bound retained source and token objects to a few block-sized inputs.
        while (size > 4 * BLOCK_MATH_LIMIT || entries.size > 128) {
          const oldest = entries.keys().next().value;
          size -= oldest.length; entries.delete(oldest);
        }
        return tokens;
      },
      clear() { entries.clear(); size = 0; },
    };
  }

  function markMathSource(mark, source, from, block, cache, visibleFrom, visibleTo, inlineMarkers = false) {
    for (const token of cache.tokens(source, block)) {
      const start = Math.max(visibleFrom, from + token.from), end = Math.min(visibleTo, from + token.to);
      if (end > start) mark(start, end, token.className
        + (inlineMarkers && token.className === 'note-live-math-delimiter' ? ' note-live-source-mark is-math' : ''));
    }
  }

  function createInlineDecorations(view, blockField, notePath, options, mathCache = createMathHighlightCache()) {
    const ranges = [];
    const seen = new Set();
    const blockValue = view.state.field(blockField);
    const blockSpecs = blockValue.specs;
    const editableMath = blockSpecs.filter(spec => spec.kind === 'math' && blockValue.activeIds.has(spec.id));
    const noteContext = noteSyntaxContext(view.state);
    const add = (from, to, decoration) => {
      if (from < 0 || to < from || to > view.state.doc.length) return;
      const key = from + ':' + to + ':' + String(decoration.spec && (decoration.spec.class || decoration.spec.widget && decoration.spec.widget.constructor.name || 'replace'));
      if (seen.has(key)) return;
      seen.add(key); ranges.push(decoration.range(from, to));
    };
    const replace = (from, to) => { if (to > from) add(from, to, Decoration.replace({ inclusive: false })); };
    const mark = (from, to, name) => { if (to > from) add(from, to, Decoration.mark({ class: name })); };
    const lineClass = (position, name, style) => add(position, position, Decoration.line({ class: name, ...(style ? { attributes: { style } } : {}) }));
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
      const coloredMath = new Set();
      const protectedRanges = lineProtectedRanges(view.state, first.from, last.to).filter(range =>
        range.kind !== 'HTMLTag' || !/^<\/?(?:u|ins|del|s|sup|sub|kbd|mark|strong|em|b|i|br)\s*\/?>$/i.test(view.state.doc.sliceString(range.from, range.to)));
      const metadata = documentFrontmatter(view.state.doc);
      if (metadata) protectedRanges.push(Object.assign({ kind: 'Frontmatter' }, metadata));
      let mathComments = null;
      const insideMathComment = (from, to) => {
        if (!mathComments) {
          const guards = lineProtectedRanges(view.state, Math.max(0, first.from - BLOCK_MATH_LIMIT), Math.min(view.state.doc.length, last.to + BLOCK_MATH_LIMIT));
          if (metadata) guards.push(metadata);
          mathComments = scanSourceComments(view.state.doc, first.from, last.to, guards);
        }
        return insideRange(mathComments, from, to);
      };
      const inlineMathByLine = new Map();
      const inlineMathForLine = line => {
        if (inlineMathByLine.has(line.from)) return inlineMathByLine.get(line.from);
        const found = line.length <= MAX_RICH_LINE && /\$|\\\(/.test(line.text)
          ? window.MarkdownMini.mathRanges(line.text).filter(math => !math.display && math.to - math.from <= INLINE_MATH_LIMIT
            && !insideRange(protectedRanges, line.from + math.from, line.from + math.to)
            && !insideMathComment(line.from + math.from, line.from + math.to)) : [];
        inlineMathByLine.set(line.from, found);
        return found;
      };
      const visibleTags = [];
      const scanTags = (from, to) => {
        if (to <= from || to - from > RICH_BLOCK_LIMIT) return;
        const source = view.state.doc.sliceString(from, to);
        if (!/#[^\s#]/u.test(source)) return;
        // A comment may open above the visible lines. Keep its bounded context
        // while projecting only this gap; ordinary code never enters this path.
        const start = Math.max(0, from - (RICH_BLOCK_LIMIT - source.length));
        const context = start === from ? source : view.state.doc.sliceString(start, from) + source;
        window.MarkdownMini.tagRanges(context).forEach((tag) => {
          const tagFrom = tag.from + start, tagTo = tag.to + start;
          if (tagFrom >= from && tagTo <= to) visibleTags.push(Object.assign({}, tag, { from: tagFrom, to: tagTo }));
        });
      };
      let tagCursor = first.from;
      protectedRanges.slice().sort((a, b) => a.from - b.from).forEach((range) => {
        if (range.to <= tagCursor || range.from >= last.to) return;
        scanTags(tagCursor, Math.min(range.from, last.to)); tagCursor = Math.max(tagCursor, range.to);
      });
      scanTags(tagCursor, last.to);
      const tree = syntaxTree(view.state);
      const quotedCodeLines = new Set();
      const inactiveCalloutHeaders = [];
      blockSpecs.forEach((spec) => {
        if (spec.kind !== 'callout' || spec.to < first.from || spec.from > last.to) return;
        const startLine = view.state.doc.lineAt(spec.from);
        const endLine = view.state.doc.lineAt(Math.max(spec.from, spec.to - 1));
        // A caret in the body should not dismantle the title. Both title and
        // body stay in CodeMirror-owned line boxes, including wrapped lines.
        const headerActive = constructActive(view, startLine.from, startLine.to);
        const descriptor = window.MarkdownMini.noteBlock(spec.type, spec.title, spec.suffix);
        const type = descriptor.type;
        const collapsed = calloutCollapsed(spec, options.coordinator);
        const hiddenHeader = descriptor.color && !descriptor.title && !headerActive && startLine.to < spec.to;
        for (let number = Math.max(first.number, startLine.number); number <= Math.min(last.number, endLine.number); number += 1) {
          if (collapsed && number > startLine.number || hiddenHeader && number === startLine.number) continue;
          let className = 'note-live-callout-line is-callout-' + type + (descriptor.color ? ' note-color-block' : '');
          if (number === startLine.number || hiddenHeader && number === startLine.number + 1) className += ' note-live-callout-first';
          if (number === endLine.number || collapsed) className += ' note-live-callout-last';
          if (number !== startLine.number) className += ' note-live-callout-body-line';
          if (number === startLine.number + 1) className += ' note-live-callout-body-first';
          lineClass(view.state.doc.line(number).from, className, descriptor.style);
        }
        if (headerActive && descriptor.foldable) add(startLine.to, startLine.to, Decoration.widget({ widget: new CalloutFoldWidget(spec, options.coordinator), side: 1 }));
        if (!hiddenHeader && !headerActive && startLine.number >= first.number && startLine.number <= last.number) {
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
          // A projected diagram already owns the entire fence. Decorating its
          // hidden first line leaves an empty code-colored stripe above it.
          if (blockSpecs.some(spec => spec.kind === 'mermaid' && blockIsProjected(spec, blockValue.activeIds)
              && spec.from <= range.from && spec.to >= range.to)) return;
          const blockFirst = view.state.doc.lineAt(range.from).number;
          const blockLast = view.state.doc.lineAt(Math.max(range.from, range.to - 1)).number;
          const visibleFirst = Math.max(first.number, blockFirst);
          const visibleLast = Math.min(last.number, blockLast);
          for (let number = visibleFirst; number <= visibleLast; number += 1) {
            let className = 'note-live-code-line';
            if (number === blockFirst) className += ' note-live-code-first';
            if (number === blockLast) className += ' note-live-code-last';
            const codeLine = view.state.doc.line(number), quote = window.MarkdownMini.quoteLine(codeLine.text);
            const callout = quote.depth && blockSpecs.some(spec => spec.kind === 'callout' && spec.from <= codeLine.from && spec.to >= codeLine.to);
            if (quote.depth && !callout) {
              className += ' note-live-quote-code'; quotedCodeLines.add(codeLine.from);
              lineClass(codeLine.from, className, '--note-quote-depth:' + quote.depth);
              sourceMark(codeLine.from, codeLine.from + quote.prefix.length, codeLine.from, codeLine.from + quote.prefix.length, 'quote');
            } else lineClass(codeLine.from, className);
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
            if (!constructActive(view, range.from, range.to) && opener && openingLine.from >= first.from && openingLine.to <= last.to) {
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
          if (metadata && nodeRef.from < metadata.to && nodeRef.name !== 'Document') return false;
          const node = syntaxNodeForRef(tree, nodeRef);
          if (/^(?:Link|Autolink)$/.test(nodeRef.name)) {
            const line = view.state.doc.lineAt(nodeRef.from);
            if (window.MarkdownMini.noteSyntax.inline(line.text, noteContext, line.from).some(token =>
              (token.kind === 'link' || token.kind === 'autolink') && token.from + line.from === nodeRef.from)) return false;
          }
          const key = nodeRef.name + ':' + nodeRef.from + ':' + nodeRef.to;
          // Rich block replacements split visibleRanges. An ancestor already seen
          // in an earlier segment can still contain unseen nodes in this segment.
          if (decoratedSyntax.has(key)) return undefined;
          decoratedSyntax.add(key);
          if (nodeRef.name !== 'Document' && view.state.doc.lineAt(nodeRef.from).length > MAX_RICH_LINE) return false;
          if (inactiveBlockContains(nodeRef.from, nodeRef.to)) return false;
          if (inactiveCalloutHeaders.some((range) => range.from <= nodeRef.from && range.to >= nodeRef.to)) return false;
          // TeX source is literal, including row-ending backslashes and text
          // that resembles Markdown. Keep only structural quote handling.
          if (!/^(?:Document|Blockquote|BulletList|OrderedList|ListItem|Paragraph|QuoteMark)$/.test(nodeRef.name)
              && (editableMath.some(spec => spec.from <= nodeRef.from && spec.to >= nodeRef.to)
                || inlineMathForLine(view.state.doc.lineAt(nodeRef.from)).some(math => {
                  const start = view.state.doc.lineAt(nodeRef.from).from;
                  return start + math.from <= nodeRef.from && start + math.to >= nodeRef.to;
                }))) return false;

          const heading = /^ATXHeading([1-6])$/.exec(nodeRef.name) || /^SetextHeading([12])$/.exec(nodeRef.name);
          if (heading) {
            const line = view.state.doc.lineAt(nodeRef.from);
            lineClass(line.from, 'note-live-heading note-live-h' + heading[1]
              + (line.number > 1 && !view.state.doc.line(line.number - 1).text.trim() ? ' follows-gap' : ''));
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
            if (canvasImage(parsed)) return false;
            if (parsed && parsed.target && previewableImage(parsed.target) && raw.length <= RICH_BLOCK_LIMIT) {
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
              if (constructActive(view, nodeRef.from, headingMarkerProjectionEnd(view.state.doc, nodeRef.from, nodeRef.to))) {
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
            const task = taskItemParts(view.state, unit);
            if (task && !task.ordered) return undefined; // TaskMarker owns the complete unordered prefix.
            if (!task && constructActive(view, nodeRef.from, nodeRef.to)) mark(nodeRef.from, nodeRef.to, 'note-live-source-mark is-list');
            else add(nodeRef.from, nodeRef.to, Decoration.replace({
              widget: new BulletWidget(/^\d/.test(view.state.doc.sliceString(nodeRef.from, nodeRef.to)), view.state.doc.sliceString(nodeRef.from, nodeRef.to)),
              inclusive: false, relatumAtomic: !!task,
            }));
          } else if (nodeRef.name === 'TaskMarker') {
            const unit = ancestorOf(node, /^ListItem$/) || node;
            const task = taskItemParts(view.state, unit);
            if (task) {
              const marker = view.state.doc.sliceString(nodeRef.from, nodeRef.to);
              add(task.ordered ? nodeRef.from : task.mark.from, task.contentFrom, Decoration.replace({
                widget: new TaskWidget(/x/i.test(marker), nodeRef.from, options), inclusive: false, relatumAtomic: true,
              }));
            }
          } else if (nodeRef.name === 'QuoteMark') {
            const line = view.state.doc.lineAt(nodeRef.from);
            if (quotedCodeLines.has(line.from)) return false;
            const spec = blockSpecs.find((item) => item.kind === 'callout' && item.from <= nodeRef.from && item.to >= nodeRef.to);
            if (!spec) {
              const quote = window.MarkdownMini.quoteLine(line.text);
              lineClass(line.from, 'note-live-quote-line'
                + (constructActive(view, line.from, line.to) ? ' note-live-quote-source' : '')
                + (!quote.text.trim() ? ' note-live-quote-gap' : ''), '--note-quote-depth:' + quote.depth);
            }
            if (spec) sourceMark(nodeRef.from, nodeRef.to + (/^[ \t]/.test(view.state.doc.sliceString(nodeRef.to, line.to)) ? 1 : 0), line.from, line.to, 'callout');
            else sourceMark(nodeRef.from, nodeRef.to, line.from, line.to, 'quote');
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
        const blockMath = blockSpecs.find((spec) => spec.kind === 'math' && spec.from <= line.to && spec.to >= line.from);
        if (blockMath) {
          lineClass(line.from, 'note-live-math-source');
          // The cached tokens carry nesting from off-screen lines. Emit once
          // per visible segment rather than walking all tokens for each line.
          if (!coloredMath.has(blockMath.id)) {
            coloredMath.add(blockMath.id);
            markMathSource(mark, blockMath.source, blockMath.from, true, mathCache, first.from, last.to);
          }
          if (line.to === blockMath.to) {
            if (editableMathSource(blockMath)) lineClass(line.from, 'note-live-math-with-preview');
          }
          continue;
        }
        const text = line.text;
        const lineIsCode = protectedRanges.some((range) => /^(?:FencedCode|CodeBlock|IndentedCode)$/.test(range.kind) && range.from <= line.from && range.to >= line.to);
        const lineIsHtml = protectedRanges.some((range) => /^HTML/.test(range.kind) && range.from <= line.from && range.to >= line.to);
        if (lineIsCode) continue;
        const noteTokens = window.MarkdownMini.noteSyntax.inline(text, noteContext, line.from);
        const semanticHtml = noteTokens.some(token => token.kind === 'html' || token.kind === 'html-break');
        if ((lineIsHtml || /^\s*<\/?[A-Za-z][^>]*>/.test(text)) && !semanticHtml) {
          lineClass(line.from, 'note-live-raw-html-line');
          continue;
        }

        const localProtected = [];
        if (metadata && line.from < metadata.to) { lineClass(line.from, 'note-live-frontmatter'); continue; }
        if (!text.trim()) lineClass(line.from, 'note-live-paragraph-gap' + (number > 1 && !view.state.doc.line(number - 1).text.trim() ? ' is-extra-gap' : ''));
        const definition = noteContext.definitions.find(item => item.from <= line.from && item.to >= line.to);
        if (definition) {
          lineClass(line.from, 'note-live-' + definition.kind + '-definition');
          if (definition.kind === 'footnote' && definition.from === line.from) {
            const use = noteContext.uses.find(item => item.key === definition.key);
            if (use && !constructActive(view, line.from, definition.contentFrom)) add(line.from, definition.contentFrom, Decoration.replace({
              widget: new NoteFootnoteWidget(definition.key, use.number, true), inclusive: false,
            }));
          }
        }
        for (const token of noteTokens) {
          const from = line.from + token.from, to = line.from + token.to;
          if (protectedRanges.some(range => /^(?:InlineCode|CommentBlock|Frontmatter)$/.test(range.kind) && range.from < to && range.to > from)) continue;
          if (definition && from < definition.contentFrom) continue;
          if (token.kind === 'html') {
            mark(line.from + token.contentFrom, line.from + token.contentTo, 'note-live-html-' + token.name);
            sourceMark(from, line.from + token.contentFrom, from, line.from + token.contentFrom, 'html');
            sourceMark(line.from + token.contentTo, to, line.from + token.contentTo, to, 'html');
          } else if (token.kind === 'html-break') {
            if (!constructActive(view, from, to)) add(from, to, Decoration.replace({ widget: new NoteBreakWidget(), inclusive: false }));
          } else if (token.kind === 'footnote-use') {
            if (!constructActive(view, from, to)) add(from, to, Decoration.replace({
              widget: new NoteFootnoteWidget(token.key, token.number, false), inclusive: false,
            }));
            else mark(from, to, 'note-live-link');
          } else if (token.kind === 'link' || token.kind === 'autolink') {
            mark(from, to, 'note-live-link');
            if (!constructActive(view, from, to)) {
              replace(from, line.from + token.contentFrom); replace(line.from + token.contentTo, to);
            }
          }
        }
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
          if (parsed && parsed.target && previewableImage(parsed.target) && !canvasImage(parsed)) {
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

        inlineMathForLine(line).forEach((mathRange) => {
          const from = line.from + mathRange.from, to = line.from + mathRange.to;
          if (isProtected(from, to)) return;
          protect(from, to);
          if (!constructActive(view, from, to)) add(from, to, Decoration.replace({
            widget: new InlineMathWidget(text.slice(mathRange.from, mathRange.to), from, to, options.coordinator), relatumAtomic: true,
          }));
          else {
            mark(from, to, 'note-live-math-source');
            markMathSource(mark, text.slice(mathRange.from, mathRange.to), from, false, mathCache, from, to, true);
          }
        });

        visibleTags.forEach((tag) => {
          const from = tag.from, to = tag.to;
          if (from < line.from || to > line.to) return;
          if (!isProtected(from, to)) add(from, to, Decoration.mark({ class: 'note-tag', attributes: { 'data-note-tag': tag.tag } }));
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
        this.mathColors = createMathHighlightCache();
        this.decorations = createInlineDecorations(view, blockField, notePath, options, this.mathColors);
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
        const lifecycleChanged = update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(inputReconcileEffect) || effect.is(focusEffect) || effect.is(notePathEffect) || effect.is(viewportScanEffect) || effect.is(viewportParseRequestEffect) || effect.is(calloutFoldEffect)));
        if (validatedLocalCellViewUpdate(update, blockField) && !this.compositionPending && !update.viewportMoved && !update.focusChanged && !lifecycleChanged) {
          // The validated cell update keeps the table's shape and source block
          // boundaries. Inline decorations outside it only need position maps.
          this.decorations = this.decorations.map(update.changes);
          this.atomic = this.atomic.map(update.changes);
          return;
        }
        const syntaxChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
        if (this.compositionPending || update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || lifecycleChanged || syntaxChanged) {
          this.compositionPending = false;
          this.decorations = createInlineDecorations(update.view, blockField, notePath, options, this.mathColors);
          this.atomic = atomicDecorationSubset(this.decorations, update.state.doc.length);
        }
      }
      destroy() { this.mathColors.clear(); }
    }, {
      decorations: (value) => value.decorations,
      provide: (extension) => EditorView.atomicRanges.of((view) => {
        const value = view.plugin(extension);
        return value ? value.atomic : Decoration.none;
      }),
    });
    return plugin;
  }

  function createViewportParsePlugin(blockField) {
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
        const localEdit = blockField && validatedLocalCellViewUpdate(update, blockField);
        if (update.docChanged && !localEdit || (localEdit ? update.viewportMoved : update.viewportChanged) || explicitlyRequested) this.schedule();
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

  const INLINE_FORMATS = Object.freeze({
    bold: { node: 'StrongEmphasis', mark: '**' },
    italic: { node: 'Emphasis', mark: '*' },
    strike: { node: 'Strikethrough', mark: '~~' },
    highlight: { node: '', mark: '==' },
    'inline-code': { node: 'InlineCode', mark: '`' },
  });
  const formatInputOwners = new WeakMap();

  function inlineFormatSpans(state, from, to) {
    const spans = [];
    syntaxTree(state).iterate({ from: Math.max(0, from - 1), to: Math.min(state.doc.length, to + 1), enter(ref) {
      const kind = Object.keys(INLINE_FORMATS).find(key => INLINE_FORMATS[key].node === ref.name);
      const node = ref.node, first = node.firstChild, last = node.lastChild;
      if (ref.name === 'Link') {
        const marks = node.getChildren('LinkMark');
        if (marks.length >= 2) spans.push({ kind: 'link', from: node.from, to: node.to, bodyFrom: marks[0].to, bodyTo: marks[1].from,
          prefix: state.doc.sliceString(node.from, marks[0].to), suffix: state.doc.sliceString(marks[1].from, node.to) });
      }
      if (!kind) return;
      if (!first || !last || first === last) return;
      const rawBody = state.doc.sliceString(first.to, last.from);
      const codePad = kind === 'inline-code' && /^ .* $/s.test(rawBody) && rawBody.trim() ? 1 : 0;
      spans.push({ kind, from: node.from, to: node.to, bodyFrom: first.to + codePad, bodyTo: last.from - codePad,
        mark: state.doc.sliceString(first.from, first.to) });
      if (kind === 'inline-code') return false;
    } });
    const first = state.doc.lineAt(from), last = state.doc.lineAt(to);
    for (let number = first.number; number <= last.number; number++) {
      const line = state.doc.line(number), pattern = /==([^=\n]+)==/g; let match;
      while ((match = pattern.exec(line.text))) {
        const start = line.from + match.index, end = start + match[0].length;
        if (escapedAt(line.text, match.index) || insideRange(lineProtectedRanges(state, start, end), start, end)) continue;
        spans.push({ kind: 'highlight', from: start, to: end, bodyFrom: start + 2, bodyTo: end - 2, mark: '==' });
      }
    }
    return spans.sort((a, b) => a.from - b.from || b.to - a.to);
  }

  function formatFragment(state, from, to, spans, omit) {
    if (to <= from) return '';
    let result = '', position = from;
    for (let index = 0; index < spans.length; index++) {
      const span = spans[index];
      if (span.to <= position || span.from >= to) continue;
      result += state.doc.sliceString(position, Math.min(to, Math.max(position, span.from)));
      const children = [];
      while (index + 1 < spans.length && spans[index + 1].from >= span.from && spans[index + 1].to <= span.to) children.push(spans[++index]);
      const body = formatFragment(state, Math.max(from, span.bodyFrom), Math.min(to, span.bodyTo), children, omit);
      result += !body || span.kind === omit ? body : span.kind === 'link' ? span.prefix + body + span.suffix
        : wrapFormatFragment(body, span.kind === 'inline-code' ? span.mark : INLINE_FORMATS[span.kind].mark, span.kind === 'inline-code');
      position = Math.min(to, span.to);
    }
    return result + state.doc.sliceString(position, to);
  }

  function wrapFormatFragment(value, mark, code) {
    if (!value) return '';
    if (code) {
      const runs = value.match(/`+/g) || [];
      mark = '`'.repeat(Math.max(mark.length, ...runs.map(run => run.length + 1)));
      const pad = /^`|`$/.test(value) || /^ .* $/.test(value) && value.trim() ? ' ' : '';
      return mark + pad + value + pad + mark;
    }
    const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
    return parts[1] + (parts[2] ? mark + parts[2] + mark : '') + parts[3];
  }

  function insertedFormatSelection(value, kind) {
    if (kind === 'highlight') return [value.indexOf('==') + 2, value.lastIndexOf('==')];
    let result;
    markdownLanguage.parser.parse(value).iterate({ enter(ref) {
      if (result || ref.name !== INLINE_FORMATS[kind].node) return;
      const node = ref.node;
      const body = value.slice(node.firstChild.to, node.lastChild.from);
      const pad = kind === 'inline-code' && /^ .* $/s.test(body) && body.trim() ? 1 : 0;
      result = [node.firstChild.to + pad, node.lastChild.from - pad];
      return false;
    } });
    // Unfinished Markdown and multi-paragraph selections still retain source
    // editing; only a successfully parsed wrapper can redefine the selection.
    if (result) return result;
    const mark = INLINE_FORMATS[kind].mark, from = value.indexOf(mark) + mark.length;
    return [from, Math.max(from, value.lastIndexOf(mark))];
  }

  // Shared by CodeMirror and the native table textarea. All positions are source
  // positions; formatting only changes the selected text's requested layer.
  function inlineFormatEdit(state, range, kind, ownedEmpty = false) {
    const format = INLINE_FORMATS[kind];
    if (!format || !ownedEmpty && !inlineFormatAllowed(state, range, kind)) return null;
    const from = range.from, to = range.to, mark = format.mark;
    const spans = inlineFormatSpans(state, from, to);
    const container = spans.filter(span => span.kind === kind && (span.bodyFrom <= from && span.bodyTo >= to
      || span.from === from && span.to === to)).sort((a, b) => a.to - a.from - (b.to - b.from))[0];
    if (range.empty) {
      if (state.doc.sliceString(Math.max(0, from - mark.length), from) === mark && state.doc.sliceString(from, from + mark.length) === mark) {
        return { changes: { from: from - mark.length, to: from + mark.length, insert: '' }, anchor: from - mark.length, head: from - mark.length };
      }
      if (container) return { changes: [], anchor: container.to, head: container.to };
      return { changes: { from, insert: mark + mark }, anchor: from + mark.length, head: from + mark.length };
    }
    let start = from, end = to;
    const affected = spans.filter(span => span.kind === kind && span.from < to && span.to > from);
    affected.forEach(span => { start = Math.min(start, span.from); end = Math.max(end, span.to); });
    const scoped = spans.filter(span => span.from >= start && span.to <= end);
    const selectedFrom = container ? Math.max(from, container.bodyFrom) : from;
    const selectedTo = container ? Math.min(to, container.bodyTo) : to;
    const left = formatFragment(state, start, selectedFrom, scoped);
    const body = formatFragment(state, selectedFrom, selectedTo, scoped, kind);
    const right = formatFragment(state, selectedTo, end, scoped);
    const middle = container ? body : wrapFormatFragment(body, mark, kind === 'inline-code');
    const offsets = container ? [0, body.length] : insertedFormatSelection(middle, kind);
    const a = start + left.length + offsets[0], b = start + left.length + offsets[1];
    return { changes: { from: start, to: end, insert: left + middle + right }, anchor: range.anchor <= range.head ? a : b, head: range.anchor <= range.head ? b : a };
  }

  function inlineFormatAllowed(state, range, kind) {
    const metadata = documentFrontmatter(state.doc);
    if (metadata && range.from < metadata.to && range.to >= metadata.from) return false;
    let allowed = true;
    syntaxTree(state).iterate({ from: range.from, to: range.to, enter(node) {
      if (/^(?:FencedCode|CodeBlock|IndentedCode|HTMLBlock|CommentBlock|Table)$/.test(node.name)
          || node.name === 'InlineCode' && kind !== 'inline-code' && !(range.from <= node.from && range.to >= node.to)
          || node.name === 'URL' && node.node.parent?.name === 'Link' && node.from <= range.from && node.to >= range.to) { allowed = false; return false; }
    } });
    return allowed;
  }

  function multipleInlineFormatEdits(state, kind) {
    const plans = state.selection.ranges.map((range, index) => ({ range, index, edit: inlineFormatEdit(state, range, kind) }));
    if (plans.some(plan => !plan.edit)) return null;
    const groups = [], selections = new Array(plans.length), changes = [];
    for (const plan of plans.filter(plan => !Array.isArray(plan.edit.changes)).sort((a, b) => a.edit.changes.from - b.edit.changes.from)) {
      const change = plan.edit.changes, end = change.to ?? change.from, previous = groups.at(-1);
      if (previous && change.from < previous.to) { previous.to = Math.max(previous.to, end); previous.plans.push(plan); }
      else groups.push({ from: change.from, to: end, plans: [plan] });
    }
    let offset = 0;
    for (const group of groups) {
      let insert;
      if (group.plans.length === 1) {
        const plan = group.plans[0]; insert = plan.edit.changes.insert;
        selections[plan.index] = EditorSelection.range(plan.edit.anchor + offset, plan.edit.head + offset);
      } else {
        if (group.plans.some(plan => plan.range.empty)) return null;
        const spans = inlineFormatSpans(state, group.from, group.to).filter(span => span.from >= group.from && span.to <= group.to);
        insert = ''; let position = group.from;
        for (const plan of group.plans.sort((a, b) => a.range.from - b.range.from)) {
          const range = plan.range, container = spans.find(span => span.kind === kind && span.bodyFrom <= range.from && span.bodyTo >= range.to);
          const from = container ? Math.max(range.from, container.bodyFrom) : range.from;
          const to = container ? Math.min(range.to, container.bodyTo) : range.to;
          insert += formatFragment(state, position, from, spans);
          const body = formatFragment(state, from, to, spans, kind);
          const middle = container ? body : wrapFormatFragment(body, INLINE_FORMATS[kind].mark, kind === 'inline-code');
          const offsets = container ? [0, body.length] : insertedFormatSelection(middle, kind);
          const a = group.from + offset + insert.length + offsets[0], b = group.from + offset + insert.length + offsets[1];
          selections[plan.index] = EditorSelection.range(range.anchor <= range.head ? a : b, range.anchor <= range.head ? b : a);
          insert += middle; position = to;
        }
        insert += formatFragment(state, position, group.to, spans);
      }
      changes.push({ from: group.from, to: group.to, insert }); offset += insert.length - (group.to - group.from);
    }
    const set = state.changes(changes);
    plans.forEach(plan => { if (!selections[plan.index]) selections[plan.index] = EditorSelection.range(set.mapPos(plan.edit.anchor), set.mapPos(plan.edit.head)); });
    return { changes: set, selection: EditorSelection.create(selections, state.selection.mainIndex) };
  }

  function toggleInlineFormat(view, kind) {
    if (compositionActive(view) || view.state.readOnly) return true;
    const owner = formatInputOwners.get(view), main = view.state.selection.main;
    const ownedEmpty = owner?.doc === view.state.doc && owner.kind === kind && main.empty && main.head === owner.position;
    if (!ownedEmpty && view.state.selection.ranges.some(range => !inlineFormatAllowed(view.state, range, kind))) return true;
    if (view.state.selection.ranges.length > 1) {
      const transaction = multipleInlineFormatEdits(view.state, kind);
      if (transaction) view.dispatch(Object.assign({}, transaction, { userEvent: 'input.note-format', scrollIntoView: true }));
      return true;
    }
    const transaction = view.state.changeByRange(range => {
      const edit = inlineFormatEdit(view.state, range, kind, ownedEmpty);
      return { changes: edit.changes, range: EditorSelection.range(edit.anchor, edit.head) };
    });
    view.dispatch(Object.assign({}, transaction, { userEvent: 'input.note-format', scrollIntoView: true }));
    if (main.empty && !ownedEmpty && !transaction.changes.empty && view.state.doc.sliceString(main.head, main.head + INLINE_FORMATS[kind].mark.length * 2) === INLINE_FORMATS[kind].mark.repeat(2)) {
      formatInputOwners.set(view, { doc: view.state.doc, kind, position: view.state.selection.main.head });
    }
    return true;
  }

  function quotePrefix(line) { return /^(?:[ \t]{0,3}>[ \t]?)+/.exec(line)?.[0] || ''; }
  function whitespaceColumns(text) { let column = 0; for (const char of text) column += char === '\t' ? 4 - column % 4 : 1; return column; }
  function listItemAt(state, position) {
    for (const side of [-1, 1]) {
      let node = syntaxTree(state).resolveInner(position, side);
      while (node && node.name !== 'ListItem') node = node.parent;
      if (node) return node;
    }
    return null;
  }
  function taskItemParts(state, item) {
    const mark = item?.getChild('ListMark'), marker = item?.getChild('Task')?.getChild('TaskMarker');
    if (!mark || !marker) return null;
    const line = state.doc.lineAt(marker.from);
    if (state.doc.lineAt(mark.from).number !== line.number) return null;
    const gap = /^[\t ]*/.exec(state.doc.sliceString(marker.to, line.to))[0];
    return { mark, marker, contentFrom: marker.to + gap.length, ordered: /^\d/.test(state.doc.sliceString(mark.from, mark.to)) };
  }
  function taskAtCaret(state, position) {
    const task = taskItemParts(state, listItemAt(state, position));
    return task && state.doc.lineAt(task.mark.from).number === state.doc.lineAt(position).number ? task : null;
  }
  function moveBeforeTask(view) {
    if (compositionActive(view) || view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return false;
    const head = view.state.selection.main.head, task = taskAtCaret(view.state, head);
    if (!task || head !== task.contentFrom) return false;
    const line = view.state.doc.lineAt(head);
    if (line.number > 1) view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(line.number - 1).to), userEvent: 'select.keyboard', scrollIntoView: true });
    return true;
  }
  function deleteListPrefix(view) {
    if (compositionActive(view) || view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
    const range = view.state.selection.main; if (!range.empty) return false;
    const item = listItemAt(view.state, range.head), mark = item?.getChild('ListMark'); if (!mark) return false;
    const line = view.state.doc.lineAt(range.head);
    if (view.state.doc.lineAt(mark.from).number !== line.number) return false;
    const task = taskItemParts(view.state, item);
    if (!task) return false; // Ordinary lists retain CodeMirror's existing deletion rules.
    const contentFrom = task.contentFrom;
    if (range.head !== contentFrom) return false;
    const from = task.marker.from;
    view.dispatch({ changes: { from, to: contentFrom, insert: '' }, selection: EditorSelection.cursor(from),
      userEvent: 'delete.note-list', annotations: CM.isolateHistory ? CM.isolateHistory.of('full') : [], scrollIntoView: true });
    return true;
  }
  function listMarkColumn(state, item, content) {
    const mark = item?.getChild('ListMark'); if (!mark) return 0;
    const line = state.doc.lineAt(mark.from), prefix = quotePrefix(line.text);
    const gap = content ? /^[ \t]+/.exec(state.doc.sliceString(mark.to, line.to))?.[0] || ' ' : '';
    return whitespaceColumns(state.doc.sliceString(line.from + prefix.length, content ? mark.to : mark.from) + gap);
  }
  function shiftListLines(view, item, delta) {
    const doc = view.state.doc, changes = [];
    const first = doc.lineAt(item.from).number, last = doc.lineAt(Math.max(item.from, item.to - 1)).number;
    for (let number = first; number <= last; number++) {
      const line = doc.line(number), prefix = quotePrefix(line.text), indent = /^[ \t]*/.exec(line.text.slice(prefix.length))[0];
      if (!line.text.slice(prefix.length).trim()) continue;
      changes.push({ from: line.from + prefix.length, to: line.from + prefix.length + indent.length,
        insert: ' '.repeat(Math.max(0, whitespaceColumns(indent) + delta)) });
    }
    const set = view.state.changes(changes);
    view.dispatch({ changes: set, selection: view.state.selection.map(set), userEvent: 'input.note-list', scrollIntoView: true });
    return true;
  }
  function structuralInputAt(state, position) {
    let node = syntaxTree(state).resolveInner(position, -1);
    while (node) { if (/^(?:FencedCode|CodeBlock|IndentedCode|HTMLBlock|Table)$/.test(node.name)) return true; node = node.parent; }
    const metadata = documentFrontmatter(state.doc);
    if (metadata && position >= metadata.from && position <= metadata.to) return true;
    const line = state.doc.lineAt(position);
    return scanBlockSpecs(state, line.from, line.to, []).some(spec => spec.from <= position && spec.to >= position && /^(?:math|mermaid|derive|canvas|image|table)$/.test(spec.kind));
  }
  function noteTab(view, backward) {
    if (compositionActive(view) || view.state.readOnly) return true;
    if (view.state.selection.ranges.some(range => !range.empty)) return (backward ? indentWithTab.shift : indentWithTab.run)(view);
    const range = view.state.selection.main;
    if (view.state.selection.ranges.length === 1) {
      if (structuralInputAt(view.state, range.head)) return (backward ? indentWithTab.shift : indentWithTab.run)(view);
      const item = listItemAt(view.state, range.head);
      if (item) {
        if (backward) {
          const parent = item.parent?.parent;
          return parent?.name === 'ListItem' ? shiftListLines(view, item, listMarkColumn(view.state, parent, false) - listMarkColumn(view.state, item, false)) : true;
        }
        let previous = item.prevSibling; while (previous && previous.name !== 'ListItem') previous = previous.prevSibling;
        return previous ? shiftListLines(view, item, listMarkColumn(view.state, previous, true) - listMarkColumn(view.state, item, false)) : true;
      }
    }
    if (backward && view.state.selection.ranges.some(range => view.state.doc.sliceString(Math.max(0, range.head - 1), range.head) !== '\t')) return indentWithTab.shift(view);
    const transaction = view.state.changeByRange(range => ({ changes: { from: range.head - (backward ? 1 : 0), to: range.head, insert: backward ? '' : '\t' },
      range: EditorSelection.cursor(range.head + (backward ? -1 : 1)) }));
    view.dispatch(Object.assign({}, transaction, { userEvent: 'input.note-tab', scrollIntoView: true }));
    return true;
  }

  function exitEmptyListMarkup(view) {
    if (compositionActive(view) || view.state.selection.ranges.length !== 1) return false;
    const range = view.state.selection.main; if (!range.empty) return false;
    const doc = view.state.doc, line = doc.lineAt(range.head), prefix = quotePrefix(line.text);
    if (!/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]*)?$/.test(line.text.slice(prefix.length)) || structuralInputAt(view.state, range.head)) return false;
    const item = listItemAt(view.state, range.head), parent = item?.parent?.parent;
    const listMark = item?.getChild('ListMark');
    if (!listMark || doc.lineAt(listMark.from).number !== line.number) return false;
    if (parent?.name === 'ListItem') return shiftListLines(view, item, listMarkColumn(view.state, parent, false) - listMarkColumn(view.state, item, false));
    const previous = line.number > 1 ? doc.line(line.number - 1).text : '';
    const needsGap = previous.slice(quotePrefix(previous).length).trim();
    const insert = needsGap ? prefix + '\n' + prefix : prefix;
    view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: EditorSelection.cursor(line.from + insert.length), userEvent: 'input.note-list', scrollIntoView: true });
    return true;
  }

  function wrapCodeBlock(view) {
    return insertBlockCommand(view, 'code-block', false);
  }

  // Menu operations work on source ranges, never on the projected Markdown DOM.
  function paragraphLines(state) {
    const numbers = new Set();
    state.selection.ranges.forEach((range) => {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to > range.from ? range.to - 1 : range.to).number;
      for (let number = first; number <= last; number += 1) numbers.add(number);
    });
    return Array.from(numbers).sort((a, b) => a - b).map((number) => state.doc.line(number));
  }

  function protectedParagraph(state, lines) {
    let protectedRange = false;
    const from = lines[0].from, to = lines[lines.length - 1].to;
    const tree = syntaxTree(state);
    if (typeof tree.length === 'number' && tree.length < to) return true;
    tree.iterate({ from, to, enter(node) {
      if (/^(FencedCode|CodeBlock|IndentedCode|Table|Image|HTMLBlock|HorizontalRule)$/.test(node.name)
          && node.from <= to && node.to >= from) { protectedRange = true; return false; }
    } });
    return protectedRange || lines.some((line) => /<!--relatum:image-text:|^\s*(?:!\[|!\[\[|`{3,}|~{3,}|\|)/.test(line.text));
  }

  function paragraphParts(text) {
    const indent = /^\s*/.exec(text)[0];
    let body = text.slice(indent.length);
    const quote = /^(?:>\s*)+/.exec(body);
    if (quote) body = body.slice(quote[0].length);
    const marker = /^(?:#{1,6}\s+|(?:[-+*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?)/.exec(body);
    return { indent, quote: quote ? quote[0] : '', body: marker ? body.slice(marker[0].length) : body,
      checked: marker && marker[1], marker: marker ? marker[0] : '', quotedBody: body };
  }

  function paragraphCommand(view, kind) {
    const lines = paragraphLines(view.state);
    if (protectedParagraph(view.state, lines)) return false;
    let ordinal = 0;
    const changes = [];
    lines.forEach((line) => {
      if (!line.text.trim() && !view.state.selection.main.empty) return;
      const parts = paragraphParts(line.text);
      let text;
      if (kind === 'quote') text = parts.indent + (parts.quote || '> ') + parts.quotedBody;
      else {
        const prefix = kind === 'bullet' ? '- ' : kind === 'ordered' ? (++ordinal) + '. '
          : kind === 'task' ? '- [' + (parts.checked && parts.checked.toLowerCase() === 'x' ? 'x' : ' ') + '] '
            : /^heading-[1-6]$/.test(kind) ? '#'.repeat(Number(kind.slice(-1))) + ' ' : '';
        text = parts.indent + (kind === 'body' ? '' : parts.quote) + prefix + parts.body;
      }
      if (text !== line.text) changes.push({ from: line.from, to: line.to, insert: text });
    });
    if (!changes.length) return true;
    const changeSet = view.state.changes(changes);
    view.dispatch({ changes: changeSet, selection: view.state.selection.map(changeSet),
      userEvent: 'input.note-command', scrollIntoView: true });
    return true;
  }

  function insertBlockCommand(view, kind, english, canvasSource) {
    const transaction = view.state.changeByRange((range) => {
      const doc = view.state.doc;
      const selected = doc.sliceString(range.from, range.to);
      const independent = kind === 'table' || kind === 'rule' || kind === 'canvas';
      const from = independent ? doc.lineAt(range.to > range.from ? range.to - 1 : range.to).to : range.from;
      const to = independent ? from : range.to;
      const leading = from > 0 ? (doc.sliceString(Math.max(0, from - 2), from).endsWith('\n\n') ? ''
        : doc.sliceString(from - 1, from) === '\n' ? '\n' : '\n\n') : '';
      const trailing = to < doc.length ? (doc.sliceString(to, to + 2).startsWith('\n\n') ? ''
        : doc.sliceString(to, to + 1) === '\n' ? '\n' : '\n\n') : '';
      let block, offset;
      if (kind === 'canvas') { block = canvasSource; offset = block.length; }
      else if (kind === 'table') {
        block = '|  |  |\n| --- | --- |\n|  |  |\n|  |  |'; offset = 2;
      } else if (kind === 'rule') { block = '---'; offset = block.length; }
      else if (kind === 'callout') {
        block = '> [!note]\n> ' + selected.replace(/\n/g, '\n> '); offset = 12;
      } else if (kind === 'math') { block = '$$\n' + selected + (selected.endsWith('\n') ? '' : '\n') + '$$'; offset = 3; }
      else {
        const matches = selected.match(/`+/g) || [];
        const fence = '`'.repeat(matches.reduce((length, match) => Math.max(length, match.length + 1), 3));
        block = fence + '\n' + selected + (selected.endsWith('\n') ? '' : '\n') + fence; offset = fence.length + 1;
      }
      const contentFrom = from + leading.length + offset;
      return { changes: { from, to, insert: leading + block + ((kind === 'table' || kind === 'canvas') && to === doc.length ? '\n\n' : trailing) },
        range: kind === 'code-block' && selected ? EditorSelection.range(contentFrom, contentFrom + selected.length) : EditorSelection.cursor(contentFrom) };
    });
    view.dispatch(Object.assign({}, transaction, { userEvent: 'input.note-command', scrollIntoView: true }));
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
    const tokens = window.MarkdownMini.noteSyntax.inline(line.text, noteSyntaxContext(state), line.from);
    const token = tokens.find(item => (item.kind === 'link' || item.kind === 'autolink') && line.from + item.from <= position && line.from + item.to >= position);
    if (token) return { kind: 'url', target: token.target, from: line.from + token.from, to: line.from + token.to };
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
    let canvasHistoryPresent = /\.canvas/i.test(options.value || '');
    let suppressChanges = false;
    let documentSetSeq = 0;
    const imageInsertions = new Set();
    let scrollRestoreSeq = 0;
    let destroyed = false;
    let pendingSourceMode = null;
    let pendingShortcutBindings = null;
    let pendingSelectionMatchHighlight = null;
    let selectionMatchHighlightWait = false;
    let pendingDocumentState = null;
    let pendingDocumentWait = false;
    let sourceMode = !!options.sourceMode;
    let selectionMatchHighlight = options.selectionMatchHighlight === true;
    let documentNoteSyntax = emptyNoteSyntax;
    let noteSyntaxRevision = 0, tableSyntaxRevision = 0;
    let pastePlain = false;
    let serializedDoc = null, serializedValue = '';
    function serializedDocument(doc) {
      if (serializedDoc !== doc) { serializedDoc = doc; serializedValue = doc.toString(); }
      return serializedValue;
    }
    const coordinator = { epoch: 1, field: null, folds: new Map(), foldPositions: new Map(), records: [], spec() { return null; } };
    const imageTextSizer = createImageTextSizer();
    const safeOptions = Object.assign({
      imageUrl(notePath, target, syntax) {
        return '/api/note-asset?note=' + encodeURIComponent(notePath || '') + '&src=' + encodeURIComponent(target || '') + '&syntax=' + encodeURIComponent(syntax || 'markdown');
      },
      onDocChanged() {}, onSaveRequest() {}, onOpenWiki() {}, onOpenExternal() {}, onOpenLocalFile() {}, onOpenTag() {}, onImageFiles() {},
      onImageSelectionChange() {}, onImageTextDefaultsChange() {}, onContextMenu() {}, onCommandContextChanged() {},
      clipboardText(text) { return text; },
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
          value: serializedDocument(doc),
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
    const imageTextSizes = ['sm', 'md', 'lg', 'xl', 'xxl', 'xxxl'];
    const imageTextColors = ['black', 'white', 'yellow', 'orange', 'red', 'purple', 'blue', 'cyan', 'green', 'gray'];
    const imageTextController = {
      active: false,
      armed: false,
      armedFrom: '',
      available: false,
      selectedId: '',
      activeRange: null,
      pendingRange: null,
      adapter: null,
      draftActive: false,
      draftWaiters: [],
      switchFrame: 0,
      selectionRestoreFrame: 0,
      uiSuppressed: false,
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
        // A committed draft may immediately hand off to another box. Saving
        // waits for that new session as well, not the gap between the two.
        queueMicrotask(() => {
          if (this.draftActive || this.switchFrame) return;
          const waiters = this.draftWaiters.splice(0);
          waiters.forEach((resolve) => resolve(true));
        });
      },
      whenSettled() {
        return this.draftActive || this.switchFrame ? new Promise((resolve) => this.draftWaiters.push(resolve)) : Promise.resolve(true);
      },
      openEditor(text) {
        if (!this.active || !this.selectedId || !this.adapter || this.draftActive) return null;
        if (this.switchFrame) cancelAnimationFrame(this.switchFrame);
        this.switchFrame = 0;
        const editor = this.adapter.command('edit');
        if (editor && typeof text === 'string') {
          editor.setRangeText(text.slice(0, Math.max(0, 1000 - editor.value.length)), editor.value.length, editor.value.length, 'end');
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return editor;
      },
      switchTo(id, gesture) {
        const from = this.activeRange && this.activeRange.from;
        this.select(id);
        const apply = () => {
          this.switchFrame = 0;
          if (!this.active || !this.activeRange || this.activeRange.from !== from || !this.adapter) {
            this.endDraft();
            return;
          }
          this.select(id);
          if (gesture && gesture.moved) {
            this.command('move', { dx: gesture.dx, dy: gesture.dy });
            view.focus();
          } else this.openEditor();
          if (!this.draftActive) this.endDraft();
        };
        if (this.switchFrame) cancelAnimationFrame(this.switchFrame);
        // Native composition and CodeMirror may restore focus after the old
        // textarea is removed. Open the next host after those callbacks finish.
        this.switchFrame = requestAnimationFrame(apply);
      },
      notify() {
        const visibleActive = this.active && !this.uiSuppressed;
        const selected = this.adapter && this.selectedId
          ? Array.from(this.adapter.frame.querySelectorAll('[data-image-text-id]'))
            .find((candidate) => candidate.dataset.imageTextId === this.selectedId) : null;
        const notification = {
          available: !!this.available,
          active: !!visibleActive,
          armed: !!this.armed,
          selectedId: this.selectedId,
          size: selected ? selected.dataset.imageTextSize : this.defaults.size,
          color: selected ? selected.dataset.imageTextColor : this.defaults.color,
          canDelete: !!selected,
          hasText: !!(this.adapter && this.adapter.frame.querySelector('[data-image-text-id]')),
        };
        if (this.lastNotification && Object.keys(notification).every(key => notification[key] === this.lastNotification[key])) return;
        this.lastNotification = notification;
        safeOptions.onImageSelectionChange(notification);
      },
      render() {
        const visibleActive = this.active && !this.uiSuppressed;
        host.classList.toggle('is-image-text-mode', visibleActive);
        if (this.adapter) this.adapter.setMode(visibleActive, this.armed, this.selectedId);
        this.notify();
      },
      suppressDraftUi() {
        if (!this.active || this.uiSuppressed) return;
        this.uiSuppressed = true;
        this.render();
      },
      register(adapter) {
        this.adapter = adapter;
        adapter.setMode(this.active && !this.uiSuppressed, this.armed, this.selectedId);
        this.notify();
        return () => { if (this.adapter === adapter) this.adapter = null; };
      },
      prepareRange(from, to, selectedId) {
        this.pendingRange = { from, to };
        this.activeRange = { from, to };
        this.selectedId = selectedId || '';
      },
      cancelSelectionRestore() {
        if (this.selectionRestoreFrame) cancelAnimationFrame(this.selectionRestoreFrame);
        this.selectionRestoreFrame = 0;
      },
      validActiveRange(view) {
        if (!this.activeRange || this.activeRange.from < 0 || this.activeRange.to > view.state.doc.length) return null;
        const line = view.state.doc.lineAt(this.activeRange.from);
        if (line.from !== this.activeRange.from || line.to !== this.activeRange.to) return null;
        const parsed = parseStandaloneImage(line.text);
        return parsed && !isRemoteTarget(parsed.target) && parsed.imageTextEditable !== false
          ? { from: line.from, to: line.to } : null;
      },
      restoreActiveSelection(view) {
        if (this.selectionRestoreFrame || !this.active) return;
        this.selectionRestoreFrame = requestAnimationFrame(() => {
          this.selectionRestoreFrame = 0;
          if (!this.active) return;
          const pinned = this.validActiveRange(view);
          if (!pinned) { this.setActive(false); return; }
          const current = exactSelectedImageRange(view.state);
          if (current && current.from === pinned.from && current.to === pinned.to) return;
          view.dispatch({ selection: EditorSelection.range(pinned.from, pinned.to) });
        });
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
          const pinned = this.validActiveRange(view);
          if (!pinned) { this.setActive(false); return; }
          // Opening the image tools pins their image. Focus changes and rich
          // block redraws may transiently collapse the CodeMirror selection;
          // those internal updates must not masquerade as an outside click.
          this.available = true;
          this.restoreActiveSelection(view);
          this.notify();
          return;
        }
        if (!available && this.active) { this.setActive(false); return; }
        this.notify();
      },
      setActive(value, targetView) {
        const next = !!value && this.available;
        const modeChanged = next !== this.active;
        this.uiSuppressed = false;
        if (next && targetView) {
          const range = exactSelectedImageRange(targetView.state);
          this.activeRange = range ? { from: range.from, to: range.to } : null;
        }
        if (!next) {
          if (this.switchFrame) cancelAnimationFrame(this.switchFrame);
          this.switchFrame = 0;
          this.cancelSelectionRestore();
          if (this.adapter) this.adapter.cancelDraft();
          this.armed = false; this.armedFrom = ''; this.selectedId = ''; this.activeRange = null; this.pendingRange = null;
          if (!this.draftActive) this.endDraft();
        }
        this.active = next;
        this.render();
        // A mode change may occur inside an editor update listener. Refresh the
        // projection after that update, without altering the document/history.
        if (modeChanged) requestAnimationFrame(() => {
          if (!destroyed && !sourceMode && view.dom.isConnected) {
            runWhenInputSettled(view, () => {
              if (!destroyed && !sourceMode) view.dispatch({ effects: imageTextProjectionEffect.of(null) });
            });
          }
        });
        return this.active;
      },
      select(id) {
        this.selectedId = id || '';
        this.armed = false;
        this.render();
      },
      arm() {
        if (!this.active) return;
        this.armedFrom = this.selectedId;
        this.selectedId = '';
        this.armed = true;
        this.render();
      },
      disarm(restore) {
        if (!this.armed) return;
        this.armed = false;
        if (restore && this.armedFrom) this.selectedId = this.armedFrom;
        this.armedFrom = '';
        this.render();
      },
      // The add-text entry is a toggle: a second click cancels the pending
      // placement and brings back the box that was selected before arming.
      toggleArm() {
        if (!this.active) return false;
        if (this.armed) this.disarm(true); else this.arm();
        return true;
      },
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
    safeOptions.renderTableCell = (value) => safeIsolatedResult(window.MarkdownTable.serialize({ header: [value], rows: [], align: [''] }),
      { noteContext: documentNoteSyntax, noteFootnoteBody: true });
    safeOptions.releaseTableCell = releaseImageFailures;
    safeOptions.prepareTableCell = (surface, content, result, source) => {
      const jump = event => {
        const link = event.target.closest('[data-note-jump]'); if (!link) return;
        if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault(); event.stopPropagation();
        if (event.type !== 'mousedown' && event.type !== 'pointerdown' && surface.current()) {
          const definition = documentNoteSyntax.footnotes.get(link.dataset.noteFootnoteKey);
          jumpNotePosition(surface.view, definition ? definition.contentFrom : Number(link.dataset.noteJump));
        }
      };
      content.addEventListener('pointerdown', jump); content.addEventListener('mousedown', jump); content.addEventListener('click', jump); content.addEventListener('keydown', jump);
      content.querySelectorAll('[data-note-image]').forEach((image) => {
        prepareLocalImage(image, image.closest('.md-local-image'), safeOptions.imageUrl(currentPath, image.dataset.noteImage || '', image.dataset.noteImageSyntax),
          image.dataset.noteImage, () => surface.current() && content.isConnected && content.dataset.source === source);
      });
      if (!result.features || !result.features.math) return;
      const current = () => surface.current() && content.isConnected && content.dataset.source === source;
      ensureMathJax().then(async (math) => {
        await whenInputSettled();
        if (!current()) return;
        await math.typesetPromise([content]);
        if (!current()) { math.typesetClear([content]); return; }
        await whenInputSettled();
        if (current()) surface.view.requestMeasure();
      }).catch(() => { if (current()) content.classList.add('is-failed'); });
    };
    const tableController = window.RelatumNoteTableEditor
      ? window.RelatumNoteTableEditor.createController(safeOptions) : null;
    safeOptions.tableController = tableController;
    // A block replacement has a visual cursor at its end even when that source
    // position is still on its last Markdown row. Body input needs a real line.
    safeOptions.onTableBodyRequest = (id, side) => {
      const run = () => {
        if (destroyed || sourceMode) return;
        const spec = tableController && tableController.spec(id);
        if (!spec) return;
        const doc = view.state.doc;
        let position, changes;
        if (side === 'after') {
          const tail = doc.sliceString(spec.to);
          if (/^\n?$/.test(tail)) {
            const insert = tail ? '\n' : '\n\n';
            changes = { from: doc.length, insert }; position = doc.length + insert.length;
          } else position = spec.to + (tail.startsWith('\n\n') ? 2 : 1);
        } else {
          if (spec.from === 0) { changes = { from: 0, insert: '\n\n' }; position = 0; }
          else position = doc.lineAt(Math.max(0, spec.from - 1)).from;
        }
        view.dispatch({ ...(changes ? { changes, userEvent: 'input.table-boundary' } : {}),
          selection: EditorSelection.cursor(position), scrollIntoView: true });
        view.focus();
      };
      tableController.routeBody(run);
    };
    const notePath = () => currentPath;
    const blockField = createBlockField(notePath, safeOptions, coordinator, inputSession);
    const mathPreviewPlugin = createMathEditPreviewPlugin(coordinator);
    const mermaidPreviewPlugin = createMermaidEditPreviewPlugin(coordinator);
    const inlinePlugin = createInlinePlugin(blockField, notePath, safeOptions);
    const sourceFoldPlugin = ViewPlugin.fromClass(class {
      constructor(view) {
        this.mathColors = createMathHighlightCache();
        this.compositionPending = false;
        this.decorations = this.build(view);
      }
      build(view) {
        const ranges = [];
        const seen = new Set();
        const mark = (from, to, className) => ranges.push(Decoration.mark({ class: className }).range(from, to));
        view.visibleRanges.forEach(range => {
          const first = view.state.doc.lineAt(range.from), last = view.state.doc.lineAt(range.to);
          const mathProtected = [];
          const allSpecs = scanBlockSpecs(view.state, first.from, last.to, coordinator.records, null, mathProtected);
          const specs = allSpecs.filter(spec => spec.kind === 'callout');
          coordinator.records = coordinator.records.filter(item => item.to < range.from || item.from > range.to || specs.some(spec => spec.id === item.id));
          specs.forEach(spec => {
            if (seen.has(spec.id)) return; seen.add(spec.id);
            const prior = coordinator.records.findIndex(item => item.id === spec.id);
            if (prior >= 0) coordinator.records[prior] = spec; else coordinator.records.push(spec);
            if (window.MarkdownMini.noteBlock(spec.type, spec.title, spec.suffix).foldable) ranges.push(Decoration.widget({ widget: new CalloutFoldWidget(spec, coordinator), side: 1 }).range(view.state.doc.lineAt(spec.from).to));
          });
          const blocks = allSpecs.filter(spec => spec.kind === 'math');
          for (const spec of blocks) markMathSource(mark, spec.source, spec.from, true, this.mathColors, first.from, last.to);
          const guards = mathProtected.concat(lineProtectedRanges(view.state, first.from, last.to));
          for (let number = first.number; number <= last.number; number++) {
            const line = view.state.doc.line(number);
            if (line.length > MAX_RICH_LINE || blocks.some(spec => spec.from <= line.to && spec.to >= line.from)) continue;
            for (const math of window.MarkdownMini.mathRanges(line.text)) {
              const from = line.from + math.from, to = line.from + math.to;
              if (math.display || to - from > INLINE_MATH_LIMIT || insideRange(guards, from, to)) continue;
              markMathSource(mark, line.text.slice(math.from, math.to), from, false, this.mathColors, first.from, last.to);
            }
          }
        });
        return Decoration.set(ranges, true);
      }
      update(update) {
        if (update.docChanged) coordinator.records = coordinator.records.map(spec => Object.assign({}, spec, { from: update.changes.mapPos(spec.from, 1), to: update.changes.mapPos(spec.to, -1) }));
        if (compositionActive(update.view)) {
          this.decorations = this.decorations.map(update.changes);
          this.compositionPending = true;
          return;
        }
        update.transactions.forEach(transaction => transaction.effects.forEach(effect => { if (effect.is(calloutFoldEffect)) coordinator.folds.set(effect.value.id, effect.value.collapsed); }));
        if (this.compositionPending || update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)
            || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(calloutFoldEffect) || effect.is(inputReconcileEffect) || effect.is(viewportParseRequestEffect)))) {
          this.compositionPending = false;
          this.decorations = this.build(update.view);
        }
      }
      destroy() { this.mathColors.clear(); }
    }, { decorations: value => value.decorations });
    const viewportParsePlugin = createViewportParsePlugin(blockField);
    const livePreviewCompartment = new Compartment();
    const markdownCompartment = new Compartment();
    const editorLabelCompartment = new Compartment();
    const shortcutCompartment = new Compartment();
    const selectionMatchHighlightCompartment = new Compartment();
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

    function moveSelectedMediaCaret(view, backward) {
      if (sourceMode || compositionActive(view) || view.state.selection.ranges.length !== 1) return false;
      const range = exactSelectedImageRange(view.state);
      if (!range) return false;
      const line = view.state.doc.lineAt(range.from);
      if (range.from !== line.from || range.to !== line.to) return false;
      const at = backward ? Math.max(0, range.from - 1) : Math.min(view.state.doc.length, range.to + 1);
      // Default arrows collapse a selected object at its hidden source edge,
      // before atomic cursor skipping runs. Move to the real paragraph instead.
      view.dispatch({ selection: EditorSelection.cursor(at), scrollIntoView: true });
      return true;
    }

    function ownsImageTextInput(event) {
      return !sourceMode && imageTextController.active && !!imageTextController.selectedId
        && !(event && event.target instanceof Element && event.target.closest('textarea'));
    }

    const imageTextInputHandlers = EditorView.domEventHandlers({
      keydown(event) {
        if (!ownsImageTextInput(event)) return false;
        if (imageTextController.draftActive) { event.preventDefault(); return true; }
        if (event.keyCode === 229 || event.key === 'Process' || event.isComposing) {
          imageTextController.openEditor();
          return false;
        }
        if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
          event.preventDefault();
          imageTextController.openEditor(event.key);
          return true;
        }
        return false;
      },
      beforeinput(event) {
        if (!ownsImageTextInput(event)) return false;
        event.preventDefault();
        if (!imageTextController.draftActive && event.inputType.startsWith('insert')) {
          imageTextController.openEditor(event.data || '');
        }
        return true;
      },
      compositionstart(event) {
        if (!ownsImageTextInput(event)) return false;
        imageTextController.openEditor();
        return true;
      },
      paste(event) {
        if (!ownsImageTextInput(event)) return false;
        event.preventDefault();
        imageTextController.openEditor(event.clipboardData ? event.clipboardData.getData('text/plain') : '');
        return true;
      },
      cut(event) {
        if (!ownsImageTextInput(event)) return false;
        event.preventDefault();
        return true;
      },
    });

    function livePreviewExtensions() {
      return sourceMode ? [sourceFoldPlugin] : [blockField, viewportParsePlugin, inlinePlugin, mathPreviewPlugin, mermaidPreviewPlugin];
    }

    function editorLabelExtension() {
      return EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': sourceMode ? languageSourceLabel() : languageLabel() });
    }

    const shortcutRuns = {
      save() { safeOptions.onSaveRequest(); return true; },
      bold(view) { return toggleInlineFormat(view, 'bold'); },
      italic(view) { return toggleInlineFormat(view, 'italic'); },
      strike(view) { return toggleInlineFormat(view, 'strike'); },
      highlight(view) { return toggleInlineFormat(view, 'highlight'); },
      'inline-code'(view) { return toggleInlineFormat(view, 'inline-code'); },
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

    safeOptions.onTableShortcut = (event, surface) => {
      const binding = shortcutRegistry ? shortcutRegistry.bindingFromEvent(event) :
        [(event.ctrlKey || event.metaKey) && 'Mod', event.altKey && 'Alt', event.shiftKey && 'Shift', event.key.length === 1 ? event.key.toLowerCase() : event.key].filter(Boolean).join('-');
      const kind = Object.keys(INLINE_FORMATS).find(name => (currentShortcutBindings[name] || []).includes(binding));
      if (!kind) return inactiveDefaultShortcutBindings().includes(binding);
      surface.format(kind, (value, anchor, head, ownedEmpty) => {
        const state = EditorState.create({ doc: value, extensions: [markdown({ base: markdownLanguage })] });
        return inlineFormatEdit(state, EditorSelection.range(anchor, head), kind, ownedEmpty);
      });
      return true;
    };

    function notifyDocChanged(view, includeValue) {
      const main = view.state.selection.main;
      const meta = {
        anchor: main.anchor,
        head: main.head,
        scrollTop: view.scrollDOM.scrollTop,
        length: view.state.doc.length,
      };
      if (includeValue) meta.value = serializedDocument(view.state.doc);
      safeOptions.onDocChanged(meta);
    }

    const noteSyntaxField = StateField.define({
      create(state) {
        const context = scanNoteSyntaxContext(state);
        documentNoteSyntax = context;
        const decorations = sourceMode ? Decoration.none : Decoration.set(context.tocs.map(toc =>
          Decoration.replace({ widget: new NoteTocWidget(context.headings, toc.from), block: true, inclusive: false }).range(toc.from, toc.to)), true);
        return { context, focused: false, decorations };
      },
      update(value, transaction) {
        const context = updateNoteSyntaxContext(value.context, transaction);
        if (context.semanticSignature !== value.context.semanticSignature) noteSyntaxRevision++;
        documentNoteSyntax = context;
        let focused = value.focused;
        for (const effect of transaction.effects) if (effect.is(focusEffect)) focused = !!effect.value;
        if (!transaction.docChanged && !transaction.selection && !transaction.reconfigured && focused === value.focused
            && !transaction.effects.some(effect => effect.is(inputReconcileEffect))) return value;
        const decorations = [];
        if (inputSession.pending()) return { context, focused, decorations: value.decorations.map(transaction.changes) };
        if (!sourceMode) {
          for (const toc of context.tocs) {
            if (focused && selectionTouches(transaction.state.selection, toc.from, toc.to)) continue;
            decorations.push(Decoration.replace({ widget: new NoteTocWidget(context.headings, toc.from), block: true, inclusive: false }).range(toc.from, toc.to));
          }
        }
        return { context, focused, decorations: Decoration.set(decorations, true) };
      },
      provide: field => EditorView.decorations.from(field, value => value.decorations),
    });

    function makeState(value, selection) {
      const extensions = [
        highlightSpecialChars(), history(), drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
        indentOnInput(), bracketMatching(), typeof closeBrackets === 'function' ? closeBrackets() : [],
        rectangularSelection(), crosshairCursor(), highlightActiveLine(),
        selectionMatchHighlightCompartment.of(selectionMatchHighlight ? highlightSelectionMatches() : []),
        markdownCompartment.of(markdownExtensions()),
        noteSyntaxField,
        codeHighlighting,
        livePreviewCompartment.of(livePreviewExtensions()),
        Prec.highest(imageTextInputHandlers),
        EditorState.transactionFilter.of((transaction) => {
          if (!transaction.docChanged || sourceMode || !imageTextController.active || !imageTextController.selectedId
              || transaction.isUserEvent('input.image-text')
              || transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) return transaction;
          // Formatting, cut and unhandled native input must never replace the
          // Markdown range that merely represents the selected image object.
          return [];
        }),
        EditorState.transactionFilter.of(transaction => {
          if (transaction.docChanged || sourceMode || inputPending() || transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) return transaction;
          if (!transaction.selection && !transaction.reconfigured && !transaction.effects.some(effect => effect.is(focusEffect))) return transaction;
          const ranges = transaction.newSelection.ranges;
          if (ranges.length !== 1 || !ranges[0].empty) return transaction;
          const head = ranges[0].head, task = taskAtCaret(transaction.startState, head);
          if (!task || head < task.mark.from || head >= task.contentFrom) return transaction;
          // Home, vertical movement and pointer hit testing land on visible text,
          // never in the source prefix. Nonempty selections retain exact source.
          return [transaction, { selection: EditorSelection.cursor(task.contentFrom), sequential: true }];
        }),
        Prec.highest(keymap.of([
          { key: 'Backspace', run: (view) => deleteImageObject(view, true) || !sourceMode && deleteListPrefix(view) },
          { key: 'Delete', run: (view) => deleteImageObject(view, false) },
          { key: 'Enter', run: () => imageTextKeyCommand('edit') },
          { key: 'Escape', run: () => imageTextKeyCommand('clear-selection') },
          { key: 'ArrowLeft', run: (view) => imageTextKeyCommand('move', { dx: -1, dy: 0 }) || moveSelectedMediaCaret(view, true) || !sourceMode && moveBeforeTask(view) },
          { key: 'ArrowRight', run: (view) => imageTextKeyCommand('move', { dx: 1, dy: 0 }) || moveSelectedMediaCaret(view, false) },
          { key: 'ArrowUp', run: () => imageTextKeyCommand('move', { dx: 0, dy: -1 }) },
          { key: 'ArrowDown', run: () => imageTextKeyCommand('move', { dx: 0, dy: 1 }) },
          { key: 'Shift-ArrowLeft', run: () => imageTextKeyCommand('move', { dx: -10, dy: 0 }) },
          { key: 'Shift-ArrowRight', run: () => imageTextKeyCommand('move', { dx: 10, dy: 0 }) },
          { key: 'Shift-ArrowUp', run: () => imageTextKeyCommand('move', { dx: 0, dy: -10 }) },
          { key: 'Shift-ArrowDown', run: () => imageTextKeyCommand('move', { dx: 0, dy: 10 }) },
        ])),
        Prec.highest(keymap.of([
          { key: 'Tab', run: view => noteTab(view, false), shift: view => noteTab(view, true) },
          { key: 'Enter', run: view => exitEmptyListMarkup(view) || exitEmptyQuoteMarkup(view) },
        ])),
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
          if (update.docChanged && imageInsertions.size) {
            for (const target of imageInsertions) {
              const empty = target.from === target.to;
              update.changes.iterChangedRanges((from, to) => {
                if (from < target.to && to > target.from) target.valid = false;
              });
              target.from = update.changes.mapPos(target.from, 1);
              target.to = update.changes.mapPos(target.to, empty ? 1 : -1);
            }
          }
          if (tableSyntaxRevision !== noteSyntaxRevision && !inputPending()) {
            tableSyntaxRevision = noteSyntaxRevision; tableController?.refreshNoteSyntax();
          }
          if (update.docChanged || update.selectionSet && update.state.selection.main.head !== formatInputOwners.get(update.view)?.position) formatInputOwners.delete(update.view);
          if (update.docChanged && coordinator.foldPositions.size) coordinator.foldPositions = new Map(Array.from(coordinator.foldPositions, ([position, collapsed]) => [update.changes.mapPos(position, 1), collapsed]));
          const blocks = update.state.field(blockField, false);
          if (blocks) coordinator.records = blocks.specs.filter(spec => spec.kind === 'callout');
          if (update.docChanged || update.selectionSet) safeOptions.onCommandContextChanged();
          if (imageTextController.active && update.docChanged
              && update.transactions.some((transaction) => transaction.isUserEvent('undo') || transaction.isUserEvent('redo'))) {
            const range = exactSelectedImageRange(update.state);
            if (range) {
              imageTextController.activeRange = { from: range.from, to: range.to };
              imageTextController.pendingRange = null;
              const parsed = parseStandaloneImage(update.state.doc.sliceString(range.from, range.to));
              if (!parsed || !parsed.imageTextItems.some((item) => item.id === imageTextController.selectedId)) {
                imageTextController.selectedId = '';
              }
              imageTextController.render();
            }
          }
          if (!inputSession.pending()) {
            inputSession.capture(update.view);
            syncImageSelectionClass(update.view);
          }
          if (!update.docChanged || suppressChanges) return;
          update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => { if (/\.canvas/i.test(inserted.toString())) canvasHistoryPresent = true; });
          if (inputSession.pending()) { inputSession.changed(); return; }
          const includeValue = update.transactions.some((transaction) => (
            transaction.isUserEvent('input.image-text')
            || transaction.isUserEvent('delete.image-object')
            || transaction.isUserEvent('undo')
            || transaction.isUserEvent('redo')
          ));
          notifyDocChanged(update.view, includeValue);
        }),
        // Resolve rich-block body boundaries before default arrows/IME keys
        // consume the event while the caret still points at hidden source.
        Prec.highest(EditorView.domEventHandlers({
          beforeinput(event, view) {
            if (!sourceMode && tableController && !inputPending() && event.inputType.startsWith('insert')) {
              const boundary = tableController.boundary(view);
              if (boundary) safeOptions.onTableBodyRequest(boundary.id, boundary.side);
            }
            return false;
          },
          contextmenu(event, view) {
            if (imageTextController.active) return false;
            event.preventDefault();
            if (inputPending()) return true;
            const keyboard = event.clientX === 0 && event.clientY === 0;
            const frame = event.target.closest('.note-live-image-frame');
            const selection = view.state.selection.main;
            const image = !sourceMode && (keyboard ? currentImageRange(view, selection.from, selection.to)
              : imageContextResolvers.get(frame)?.());
            const position = image ? image.from : keyboard ? selection.head : view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
            if (position == null) return true;
            if (image) {
              view.dispatch({ selection: EditorSelection.range(image.from, image.to) });
            } else if (!keyboard && !view.state.selection.ranges.some((range) => !range.empty && position >= range.from && position <= range.to)) {
              view.dispatch({ selection: EditorSelection.cursor(position) });
            }
            const rect = view.coordsAtPos(view.state.selection.main.head);
            safeOptions.onContextMenu({ x: keyboard && rect ? rect.left : event.clientX,
              y: keyboard && rect ? rect.bottom : event.clientY, context: commandContext(), keyboard,
              image: image && !isRemoteTarget(image.parsed.target) ? { target: image.parsed.target, syntax: image.parsed.syntax } : null });
            return true;
          },
          keydown(event, view) {
            pastePlain = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v';
            if (!sourceMode && tableController && !inputPending() && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey) {
              const boundary = tableController.boundary(view);
              if (boundary && (event.key.length === 1 || event.key === 'Enter' || event.key === 'Process' || event.keyCode === 229 || /^Arrow(?:Down|Right|Up|Left)$/.test(event.key))) {
                if (/^Arrow/.test(event.key)) boundary.side = /Up|Left/.test(event.key) ? 'before' : 'after';
                safeOptions.onTableBodyRequest(boundary.id, boundary.side);
                if (/^Arrow/.test(event.key)) { event.preventDefault(); return true; }
              }
            }
            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return false;
            if (imageTextController.active) return false;
            event.preventDefault();
            if (inputPending()) return true;
            const rect = view.coordsAtPos(view.state.selection.main.head);
            const selection = view.state.selection.main;
            const image = !sourceMode && currentImageRange(view, selection.from, selection.to);
            safeOptions.onContextMenu({ x: rect ? rect.left : 8, y: rect ? rect.bottom : 8, context: commandContext(), keyboard: true,
              image: image && !isRemoteTarget(image.parsed.target) ? { target: image.parsed.target, syntax: image.parsed.syntax } : null });
            return true;
          },
          keyup() { pastePlain = false; return false; },
          focus(event, view) {
            if (!inputSession.pending()) view.dispatch({ effects: focusEffect.of(true) });
            return false;
          },
          blur(event, view) {
            pastePlain = false;
            if (inputSession.pending()) inputSession.end(view);
            else view.dispatch({ effects: focusEffect.of(false) });
            return false;
          },
          compositionstart(event, view) {
            if (!sourceMode && tableController && !inputPending()) {
              const boundary = tableController.boundary(view);
              if (boundary) safeOptions.onTableBodyRequest(boundary.id, boundary.side);
            }
            inputSession.begin(view);
            return false;
          },
          compositionend(event, view) {
            inputSession.end(view);
            return false;
          },
          mousedown(event, view) {
            const tag = event.target.closest('[data-note-tag]');
            if (tag && (event.ctrlKey || event.metaKey) && !inputPending()) {
              event.preventDefault(); safeOptions.onOpenTag(tag.dataset.noteTag); return true;
            }
            if (event.button === 2 && !imageTextController.active) {
              event.preventDefault();
              return true;
            }
            if (!sourceMode && tableController && event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
              const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
              const hit = tableController.bodyHit(event, position);
              if (hit) { event.preventDefault(); safeOptions.onTableBodyRequest(hit.id, hit.side); return true; }
              if (tableController.pending() && position != null) {
                event.preventDefault();
                const path = currentPath, epoch = coordinator.epoch;
                tableController.routeBody((target) => {
                  if (destroyed || path !== currentPath || epoch !== coordinator.epoch || target == null) return;
                  view.dispatch({ selection: EditorSelection.cursor(target) }); view.focus();
                }, view, position);
                return true;
              }
              tableController.routeBody(() => {});
            }
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
          paste(event, view) {
            if (!sourceMode && tableController && !inputPending()) {
              const boundary = tableController.boundary(view);
              if (boundary) safeOptions.onTableBodyRequest(boundary.id, boundary.side);
            }
            const plain = pastePlain;
            pastePlain = false;
            const files = Array.from(event.clipboardData && event.clipboardData.items || [])
              .filter((item) => item.kind === 'file' && /^image\//i.test(item.type || ''))
              .map((item) => item.getAsFile()).filter(Boolean);
            if (files.length) {
              event.preventDefault();
              if (!view.state.readOnly && !imageTextController.active) safeOptions.onImageFiles(files);
              return true;
            }
            if (plain || !event.clipboardData || view.state.readOnly || inputPending() || imageTextController.active) return false;
            const text = event.clipboardData.getData('text/plain');
            const markdown = safeOptions.clipboardText(text, event.clipboardData.getData('text/html'));
            if (markdown === text) return false;
            event.preventDefault();
            view.dispatch(Object.assign({}, view.state.replaceSelection(markdown), { userEvent: 'input.paste', scrollIntoView: true }));
            return true;
          },
          dragover(event) {
            const files = Array.from(event.dataTransfer && event.dataTransfer.files || []);
            if (!files.some((file) => /^image\//i.test(file.type || '') || /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(file.name || ''))) return false;
            event.preventDefault(); return true;
          },
          drop(event, view) {
            const files = Array.from(event.dataTransfer && event.dataTransfer.files || [])
              .filter((file) => /^image\//i.test(file.type || '') || /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(file.name || ''));
            if (!files.length) return false;
            event.preventDefault();
            if (!view.state.readOnly && !imageTextController.active) safeOptions.onImageFiles(files);
            return true;
          },
        })),
      ];
      return EditorState.create({
        doc: String(value || ''),
        selection: selection || EditorSelection.cursor(0),
        extensions,
      });
    }

    function markdownExtensions() {
      return markdown({ base: markdownLanguage, codeLanguages: CM.relatumCodeLanguage || (Array.isArray(relatumCodeLanguages) ? relatumCodeLanguages : []),
        extensions: sourceMode || !tableController ? [plainParagraphExtension] : [plainParagraphExtension, projectedTableExtension] });
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
      for (const target of imageInsertions) target.valid = false;
      imageInsertions.clear();
      formatInputOwners.delete(view);
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
      const scrollSeq = ++scrollRestoreSeq;
      if (tableController) tableController.close();
      coordinator.epoch += 1;
      coordinator.folds.clear(); coordinator.foldPositions.clear(); coordinator.records = [];
      coordinator.mermaidHeights?.clear();
      imageTextController.setActive(false);
      if (pendingSourceMode !== null) { sourceMode = pendingSourceMode; pendingSourceMode = null; }
      if (pendingShortcutBindings !== null) {
        currentShortcutBindings = normalizedShortcutBindings(pendingShortcutBindings);
        pendingShortcutBindings = null;
      }
      if (pendingSelectionMatchHighlight !== null) {
        selectionMatchHighlight = pendingSelectionMatchHighlight;
        pendingSelectionMatchHighlight = null;
      }
      const value = documentState && typeof documentState.value === 'string' ? documentState.value : '';
      canvasHistoryPresent = /\.canvas/i.test(value);
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
        if (scrollSeq === scrollRestoreSeq) view.scrollDOM.scrollTop = Math.max(0, Number(documentState && documentState.scrollTop) || 0);
        view.requestMeasure();
        requestAnimationFrame(() => {
          if (destroyed || seq !== documentSetSeq || !view.dom.isConnected) return;
          view.dispatch({ effects: viewportParseRequestEffect.of(true) });
        });
      });
    }

    function pathRewriteChanges(value) {
      const before = serializedDocument(view.state.doc);
      if (before === value) return [];
      const oldLines = before.split('\n'), newLines = value.split('\n');
      const changes = [];
      const difference = (oldText, newText, offset) => {
        if (oldText === newText) return;
        let start = 0, end = 0;
        while (start < Math.min(oldText.length, newText.length) && oldText[start] === newText[start]) start++;
        while (end < Math.min(oldText.length, newText.length) - start
            && oldText[oldText.length - end - 1] === newText[newText.length - end - 1]) end++;
        changes.push({ from: offset + start, to: offset + oldText.length - end,
          insert: newText.slice(start, newText.length - end) });
      };
      // Path rewrites leave line breaks intact. Keep unrelated lines and their history.
      if (oldLines.length === newLines.length) {
        let offset = 0;
        oldLines.forEach((line, index) => { difference(line, newLines[index], offset); offset += line.length + 1; });
      } else difference(before, value, 0);
      return changes;
    }

    async function rewriteCanvasHistory(renamed, path, value) {
      if (inputPending()) await whenInputSettled();
      const oldPath = currentPath, original = view.state, scroll = view.scrollDOM.scrollTop;
      const move = (state, command) => {
        let next = state;
        const success = command({ state, dispatch(transaction) { next = transaction.state; } });
        return { success, state: next };
      };
      const past = [original], future = [];
      let state = original, result, count = 0;
      while ((result = move(state, CM.undo)).success) {
        state = result.state; past.push(state);
        if (++count % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      state = original;
      while ((result = move(state, CM.redo)).success) {
        state = result.state; future.push(state);
        if (++count % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      past.reverse(); currentPath = path || oldPath;
      const project = snapshot => {
        const before = snapshot.doc.toString();
        const after = window.MarkdownMini.rewriteCanvasReferences(before, oldPath, renamed || {}, currentPath);
        const changes = minimalChanges(before, after), mapping = snapshot.changes(changes);
        return { value: after, selection: EditorSelection.create(snapshot.selection.ranges.map(range => EditorSelection.range(mapping.mapPos(range.anchor), mapping.mapPos(range.head))), snapshot.selection.mainIndex) };
      };
      const first = project(past[0]); let rebuilt = makeState(first.value, first.selection), time = Date.now();
      const replay = snapshot => {
        const projected = project(snapshot), changes = minimalChanges(rebuilt.doc.toString(), projected.value);
        rebuilt = rebuilt.update({ changes, selection: projected.selection,
          annotations: Transaction.time.of(time += 1000), userEvent: 'input.canvas-reference-history' }).state;
      };
      past.slice(1).forEach(replay);
      let replayedFuture = 0;
      future.forEach(snapshot => { const before = rebuilt.doc; replay(snapshot); if (rebuilt.doc !== before) replayedFuture++; });
      for (let i = 0; i < replayedFuture; i++) rebuilt = move(rebuilt, CM.undo).state;
      if (typeof value === 'string' && rebuilt.doc.toString() !== value) {
        rebuilt = rebuilt.update({ changes: minimalChanges(rebuilt.doc.toString(), value), annotations: Transaction.addToHistory.of(false) }).state;
      }
      coordinator.epoch++; suppressChanges = true;
      try { view.setState(rebuilt); } finally { suppressChanges = false; }
      inputSession.reset(view); view.__relatumInputSession = inputSession;
      view.scrollDOM.scrollTop = scroll; view.requestMeasure();
    }

    function minimalChanges(before, value) {
      if (before === value) return [];
      let from = 0, end = 0;
      while (from < Math.min(before.length, value.length) && before[from] === value[from]) from++;
      while (end < Math.min(before.length, value.length) - from && before[before.length - end - 1] === value[value.length - end - 1]) end++;
      return [{ from, to: before.length - end, insert: value.slice(from, value.length - end) }];
    }

    async function setNotePath(path, value) {
      if (destroyed) return;
      const next = String(path || '');
      if (inputPending()) {
        const sequence = documentSetSeq, previousPath = currentPath;
        return whenInputSettled().then(() => {
          if (!destroyed && sequence === documentSetSeq && currentPath === previousPath) return setNotePath(next, value);
        });
      }
      if (next !== currentPath && canvasHistoryPresent) {
        await rewriteCanvasHistory({}, next, value); return;
      }
      const changes = typeof value === 'string' ? pathRewriteChanges(value) : [];
      const scroll = view.scrollDOM.scrollTop;
      currentPath = next;
      coordinator.epoch += 1;
      suppressChanges = true;
      try {
        view.dispatch({ changes, effects: notePathEffect.of(currentPath),
          annotations: Transaction.addToHistory.of(false) });
      } finally { suppressChanges = false; }
      view.scrollDOM.scrollTop = scroll;
      view.requestMeasure();
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
      if (tableController) tableController.close();
      if (next) imageTextController.setActive(false);
      coordinator.epoch += 1;
      const imageRange = next ? null : imageRangeForLiveMode(view.state);
      view.dispatch({
        selection: imageRange ? EditorSelection.range(imageRange.from, imageRange.to) : undefined,
        effects: [
        livePreviewCompartment.reconfigure(livePreviewExtensions()),
        markdownCompartment.reconfigure(markdownExtensions()),
        editorLabelCompartment.reconfigure(editorLabelExtension()),
        ],
      });
      host.classList.toggle('is-source-mode', sourceMode);
      syncImageSelectionClass(view);
      // Reconfiguring the live field does not produce a native focus event
      // when the source editor already owns focus. Reveal the active formula
      // in the newly created field as well.
      if (!sourceMode && view.hasFocus) view.dispatch({ effects: focusEffect.of(true) });
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

    function setSelectionMatchHighlight(enabled) {
      if (destroyed) return;
      const next = enabled === true;
      pendingSelectionMatchHighlight = next;
      if (inputPending()) {
        if (!selectionMatchHighlightWait) {
          selectionMatchHighlightWait = true;
          whenInputSettled().then(() => {
            selectionMatchHighlightWait = false;
            if (!destroyed && pendingSelectionMatchHighlight !== null) {
              setSelectionMatchHighlight(pendingSelectionMatchHighlight);
            }
          });
        }
        return;
      }
      pendingSelectionMatchHighlight = null;
      if (next === selectionMatchHighlight) return;
      selectionMatchHighlight = next;
      view.dispatch({ effects: selectionMatchHighlightCompartment.reconfigure(next ? highlightSelectionMatches() : []) });
    }

    function snapshot() {
      return inputSession.snapshot(view);
    }

    function commandContext() {
      return { doc: view.state.doc, selection: view.state.selection, path: currentPath };
    }
    function validCommandContext(context) {
      return !destroyed && !inputPending() && !imageTextController.active && (!context
        || (context.doc === view.state.doc && context.path === currentPath && context.selection.eq(view.state.selection)));
    }
    function queryCommand(name, context) {
      if (!validCommandContext(context)) return { enabled: false, checked: false };
      if (INLINE_FORMATS[name]) {
        const owner = formatInputOwners.get(view), main = view.state.selection.main;
        return { enabled: owner?.doc === view.state.doc && owner.kind === name && main.empty && main.head === owner.position
          || view.state.selection.ranges.every(range => inlineFormatAllowed(view.state, range, name)), checked: view.state.selection.ranges.every(range =>
          inlineFormatSpans(view.state, range.from, range.to).some(span => span.kind === name && (span.bodyFrom <= range.from && span.bodyTo >= range.to
            || span.from === range.from && span.to === range.to))) };
      }
      if (name === 'copy' || name === 'cut') return { enabled: view.state.selection.ranges.some((range) => !range.empty), checked: false };
      if (name === 'insert:canvas' && !canvasEnabled()) return { enabled: false, checked: false };
      if (name === 'insert:table' || name === 'insert:rule' || name === 'insert:canvas') {
        const ends = view.state.selection.ranges.map((range) => view.state.doc.lineAt(range.to > range.from ? range.to - 1 : range.to).to);
        return { enabled: new Set(ends).size === ends.length, checked: false };
      }
      if (name.startsWith('paragraph:')) {
        const kind = name.slice(10), lines = paragraphLines(view.state);
        const meaningful = lines.filter((line) => line.text.trim());
        const matches = (line) => {
          const p = paragraphParts(line.text);
          if (kind === 'quote') return !!p.quote;
          if (kind === 'body') return !p.quote && !p.marker;
          if (kind === 'task') return p.checked != null;
          if (kind === 'bullet') return /^[-+*]\s/.test(p.marker) && p.checked == null;
          if (kind === 'ordered') return /^\d+[.)]\s/.test(p.marker);
          return p.marker.startsWith('#'.repeat(Number(kind.slice(-1))) + ' ');
        };
        return { enabled: !protectedParagraph(view.state, lines), checked: meaningful.length > 0 && meaningful.every(matches) };
      }
      return { enabled: true, checked: false };
    }
    function executeCommand(name, context, text) {
      if (!queryCommand(name, context).enabled) return false;
      let done;
      if (name.startsWith('paragraph:')) done = paragraphCommand(view, name.slice(10));
      else if (name.startsWith('insert:')) done = insertBlockCommand(view, name.slice(7), document.documentElement.lang === 'en', text);
      else if (name === 'cut' || name === 'paste' || name === 'paste-plain') {
        const transaction = view.state.changeByRange((range) => ({ changes: { from: range.from, to: range.to, insert: text || '' },
          range: EditorSelection.cursor(range.from + (text || '').length) }));
        view.dispatch(Object.assign({}, transaction, { userEvent: 'input.note-command', scrollIntoView: true })); done = true;
      } else if (name === 'select-all') { view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) }); done = true; }
      else if (shortcutRuns[name]) done = shortcutRuns[name](view);
      if (done) {
        view.focus();
        if (name === 'insert:table' && !sourceMode && tableController) tableController.editAtSelection(view);
      }
      return !!done;
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

    function createImageInsertion() {
      if (destroyed || inputPending() || imageTextController.active || view.state.readOnly) return null;
      const range = view.state.selection.main;
      const target = { from: range.from, to: range.to, valid: true, sequence: documentSetSeq, path: currentPath };
      imageInsertions.add(target);
      const valid = () => target.valid && !destroyed && target.sequence === documentSetSeq && target.path === currentPath;
      return {
        valid,
        dispose() { target.valid = false; imageInsertions.delete(target); },
        insert(text) {
          if (!valid() || inputPending() || imageTextController.active || view.state.readOnly) return false;
          const range = view.state.selection.main, insert = String(text || '');
          const follow = range.from === target.from && range.to === target.to && view.hasFocus;
          imageInsertions.delete(target); target.valid = false;
          view.dispatch({ changes: { from: target.from, to: target.to, insert },
            ...(follow ? { selection: EditorSelection.cursor(target.from + insert.length), scrollIntoView: true } : {}), userEvent: 'input.paste' });
          return true;
        },
      };
    }

    function revealPosition(position, options) {
      scrollRestoreSeq++;
      const target = clamp(position, 0, view.state.doc.length);
      const effects = [];
      if (options?.unfold) for (const spec of coordinator.records) {
        if (spec.kind === 'callout' && spec.from <= target && spec.to >= target) {
          coordinator.foldPositions.set(spec.from, false); effects.push(calloutFoldEffect.of({ id: spec.id, collapsed: false }));
        }
      }
      if (options?.align === 'start') effects.push(EditorView.scrollIntoView(target, { y: 'start', yMargin: 12 }));
      view.dispatch({ selection: options?.end != null ? EditorSelection.range(target, clamp(options.end, target, view.state.doc.length)) : EditorSelection.cursor(target), effects,
        scrollIntoView: options?.align !== 'start' });
      view.focus();
    }

    function setImageTextMode(active) {
      if (inputPending()) return false;
      return imageTextController.setActive(active, view);
    }

    function imageTextTarget() {
      const range = imageTextController.validActiveRange(view);
      if (!range) return null;
      const line = view.state.doc.lineAt(range.from);
      return { line: line.number, source: line.text };
    }

    function imageTextRenderedLines() {
      forceParsing(view, view.state.doc.length, 3000);
      const tree = syntaxTree(view.state);
      if (!tree || tree.length < view.state.doc.length) throw new Error('笔记语法尚未解析完成，请重试');
      const specs = scanBlockSpecs(view.state, 0, view.state.doc.length, [], tree);
      return specs.filter((spec) => spec.kind === 'image'
        && !specs.some((outer) => outer.kind !== 'image' && outer.from <= spec.from && outer.to >= spec.to))
        .map((spec) => view.state.doc.lineAt(spec.from).number);
    }

    async function exportImageTextPng() {
      const adapter = imageTextController.adapter;
      if (!adapter || !imageTextTarget()) throw new Error('请先选中图片');
      const { frame, image } = adapter;
      await image.decode();
      if (document.fonts) await document.fonts.ready;
      const width = image.naturalWidth, height = image.naturalHeight;
      if (!width || !height || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) {
        throw new Error('图片尺寸过大或无法读取');
      }
      const rect = image.getBoundingClientRect();
      if (!rect.width || !rect.height) throw new Error('图片尚未显示');
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      try {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建图片');
        // Freeze animated images before asynchronous SVG decoding.
        context.drawImage(image, 0, 0, width, height);
        const root = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
        root.style.cssText = `position:relative;width:${rect.width}px;height:${rect.height}px;transform-origin:0 0;transform:scale(${width / rect.width},${height / rect.height});`;
        frame.querySelectorAll('.note-image-text-box').forEach((label) => {
          if (label.hidden || label.classList.contains('note-image-text-measurer')) return;
          const box = document.createElementNS('http://www.w3.org/1999/xhtml', 'span');
          const style = getComputedStyle(label);
          // Only text presentation is exported; selection chrome never enters the PNG.
          ['position', 'box-sizing', 'width', 'height', 'min-width', 'max-width', 'padding',
            'left', 'top', 'transform', 'color', 'font-family', 'font-size', 'font-weight',
            'font-style', 'line-height', 'text-align', 'white-space', 'overflow-wrap',
            'word-break', 'letter-spacing', 'text-shadow', 'max-height', 'overflow'].forEach((key) => {
            box.style.setProperty(key, style.getPropertyValue(key));
          });
          // Freeze resolved geometry; the exported tree has no editor CSS variables.
          const labelRect = label.getBoundingClientRect();
          box.style.left = (labelRect.left - rect.left) + 'px';
          box.style.top = (labelRect.top - rect.top) + 'px';
          box.style.transform = 'none';
          box.style.overflow = 'hidden';
          const text = document.createElement('span');
          text.style.display = 'block';
          text.style.transform = `translate(${-label.scrollLeft}px, ${-label.scrollTop}px)`;
          text.textContent = label.textContent;
          box.appendChild(text);
          root.appendChild(box);
        });
        if (!root.childNodes.length) throw new Error('图片没有可合并的文字框');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="${width}" height="${height}">${new XMLSerializer().serializeToString(root)}</foreignObject></svg>`;
        const overlay = new Image();
        overlay.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await overlay.decode();
        context.drawImage(overlay, 0, 0);
        return await new Promise((resolve, reject) => canvas.toBlob((blob) => {
          if (blob) resolve(blob); else reject(new Error('PNG 生成失败'));
        }, 'image/png'));
      } finally { canvas.width = 0; canvas.height = 0; }
    }

    function imageTextCommand(name, value) {
      if (inputSession.pending()) return false;
      return imageTextController.command(String(name || ''), value);
    }

    function inputPending() {
      return inputSession.pending() || imageTextController.draftActive || !!imageTextController.switchFrame
        || !!(tableController && tableController.pending());
    }

    function whenInputSettled() {
      return Promise.all([inputSession.whenSettled(), imageTextController.whenSettled(),
        tableController ? tableController.whenSettled() : Promise.resolve(true)]);
    }

    return {
      setDocument, setNotePath, setSourceMode, setShortcutBindings, setSelectionMatchHighlight, setImageTextMode, imageTextCommand, snapshot, replaceSelection, revealPosition,
      calloutSession: {
        get(position, fallback) { const spec = coordinator.records.find(item => view.state.doc.lineAt(item.from).from === position); return spec ? calloutCollapsed(spec, coordinator) : coordinator.foldPositions.has(position) ? coordinator.foldPositions.get(position) : fallback; },
        set(position, collapsed) { const spec = coordinator.records.find(item => view.state.doc.lineAt(item.from).from === position); coordinator.foldPositions.set(spec ? spec.from : position, collapsed); if (spec) view.dispatch({ effects: calloutFoldEffect.of({ id: spec.id, collapsed }) }); },
      },
      rewriteCanvasHistory,
      whenInputSettled, createImageInsertion, imageTextTarget, imageTextRenderedLines, exportImageTextPng,
      commandContext, queryCommand, executeCommand,
      get inputPending() { return inputPending(); },
      focus() { view.focus(); },
      destroy() {
        destroyed = true;
        imageInsertions.clear();
        pendingSelectionMatchHighlight = null;
        serializedDoc = null; serializedValue = '';
        if (imageTextController.adapter) imageTextController.adapter.cancelDraft(true);
        imageTextController.setActive(false);
        imageTextSizer.destroy();
        if (tableController) tableController.destroy();
        inputSession.destroy();
        delete view.__relatumInputSession;
        host.classList.remove('is-composing', 'has-image-selection', 'is-image-text-mode');
        coordinator.epoch += 1;
        view.destroy();
        host.replaceChildren();
      },
      get view() { return view; },
    };
  }

  window.RelatumNoteLiveSyntax = {
    scanNoteHeadings,
    noteHeadingsFromString,
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
  window.RelatumNoteLiveEditor = { create, renderMarkdown, typesetMath };
  window.RelatumNoteLiveEditor.releaseReadingDocument = releaseReadingDocument;
})();
