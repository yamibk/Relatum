// Note-only, offline concept cards. Markdown remains the sole stored source.
(function () {
  'use strict';
  const MAX_SOURCE = 256 * 1024, MAX_LINE = 64 * 1024;
  const colors = new Map(window.MarkdownMini.noteBlockCatalog.colors.map(color => [color.name, color]));
  // Static Lucide paths; the existing vendor/lucide/LICENSE.txt applies.
  const icons = Object.freeze({
    zap: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
    shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>',
    chart: '<path d="M3 3v18h18M7 16v-3M12 16V9M17 16V5M6 9l5-5 4 2 6-4"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>',
    book: '<path d="M12 7v14M3 3c4-1 7 0 9 3 2-3 5-4 9-3v15c-4-1-7 0-9 3-2-3-5-4-9-3Z"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    bulb: '<path d="M9 18h6M9 22h6M9 15a6 6 0 1 1 6 0v3H9Z"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/>',
  });
  const styles = Object.freeze(['soft', 'outline', 'stripe', 'band']);
  const defaults = Object.freeze({ columns: 'auto', style: 'soft', density: 'comfortable' });
  const groupValues = { columns: ['auto', '1', '2', '3'], style: styles, density: ['comfortable', 'compact'] };
  const cardValues = { style: styles, span: ['full'], subtitle: null, badge: null, value: null, footer: null };
  const heading = text => /^[ \t]{0,3}#{1,6}(?!#)[ \t]*(.*)$/.exec(text);
  const divider = text => /^[ \t]{0,3}---[ \t]*$/.test(text);
  function directive(text) {
    const match = /^[ \t]*@([a-z][\w-]*)(?:[ \t]*[:：][ \t]*|[ \t]+)(.*)$/i.exec(text);
    return match ? { key: match[1].toLowerCase(), value: match[2].trim() } : /^\s*@\S/.test(text) ? { key: '', value: '' } : null;
  }
  function parse(value) {
    const source = String(value || '').replace(/\r\n?/g, '\n');
    const model = { valid: false, cards: [], settings: { ...defaults }, metadata: {}, segments: [], diagnostics: [], preludeEnd: 0 };
    if (!source.trim() || source.length > MAX_SOURCE) return model;
    let offset = 0;
    const rows = source.split('\n').map(text => { const row = { text, from: offset, to: offset + text.length }; offset += text.length + 1; return row; });
    if (rows.some(row => row.text.length > MAX_LINE)) return model;
    const plainTitles = rows.some(row => divider(row.text));
    function notice(row, code) {
      const item = { from: row.from, to: row.to, source: row.text, code };
      model.diagnostics.push(item); return item;
    }
    function metadata(row, entry, allowed, values, ranges, notices) {
      if (!Object.hasOwn(allowed, entry.key)) { notices.push(notice(row, 'unknown-option')); return; }
      const value = allowed[entry.key] ? entry.value.toLowerCase() : entry.value;
      if (Object.hasOwn(ranges, entry.key) || value && allowed[entry.key] && !allowed[entry.key].includes(value)) {
        notices.push(notice(row, 'invalid-option')); return;
      }
      values[entry.key] = value || (allowed === groupValues ? defaults[entry.key] : ''); ranges[entry.key] = { from: row.from, to: row.to };
    }
    const groupNotices = [];
    let first = 0;
    for (; first < rows.length; first++) {
      const row = rows[first], entry = directive(row.text);
      if (entry) metadata(row, entry, groupValues, model.settings, model.metadata, groupNotices);
      else if (row.text.trim()) break;
    }
    model.preludeEnd = rows[first]?.from ?? source.length;
    for (const item of groupNotices) model.segments.push({ kind: 'raw', ...item });
    function emit(start, end) {
      while (start < end && !rows[start].text.trim()) start++;
      while (end > start && !rows[end - 1].text.trim()) end--;
      if (start === end) return;
      const row = rows[start], match = heading(row.text), from = row.from, to = rows[end - 1].to;
      const raw = code => { const item = { kind: 'raw', from, to, source: source.slice(from, to), code }; model.segments.push(item); model.diagnostics.push(item); };
      if (!match && !plainTitles) { raw('missing-title'); return; }
      const content = match ? match[1] : row.text.trimStart();
      let title = content.trim(), consumed = content.length - content.trimStart().length;
      const card = { title: '', icon: '', color: '', body: '', style: '', span: '', subtitle: '', badge: '', value: '', footer: '',
        range: { from, to }, header: { from: row.from, to: row.to, contentFrom: row.to - content.length }, markers: {}, metadata: {}, diagnostics: [] };
      for (;;) {
        const token = /^\[[ \t]*(![ \t]*)?([a-z-]+)[ \t]*\][ \t]*/i.exec(title);
        if (!token) break;
        const name = token[2].toLowerCase(), key = token[1] ? 'color' : 'icon';
        if (card[key] || (key === 'color' ? !colors.has(name) : !Object.hasOwn(icons, name))) break;
        card[key] = name;
        card.markers[key] = { from: card.header.contentFrom + consumed, to: card.header.contentFrom + consumed + token[0].trimEnd().length };
        consumed += token[0].length; title = title.slice(token[0].length);
      }
      card.title = title.trim();
      card.header.titleFrom = card.header.contentFrom + consumed;
      if (!card.title) { raw('missing-title'); return; }
      let bodyStart = start + 1;
      for (; bodyStart < end; bodyStart++) {
        const next = rows[bodyStart], entry = directive(next.text);
        if (entry) metadata(next, entry, cardValues, card, card.metadata, card.diagnostics);
        else if (next.text.trim()) break;
      }
      const lines = rows.slice(bodyStart, end).map(item => item.text);
      const displayed = [card.title, card.subtitle, card.badge, card.value, card.footer, ...lines].join('\n').replace(/`[^`\n]*`/g, '');
      if (lines.some(line => /^\s*(?:`{3,}|~{3,}|!\[|>)/.test(line)) || /\$\$|\\begin\{/.test(displayed) || displayed.includes('\\[') && displayed.includes('\\]')) { raw('unsupported-content'); return; }
      card.body = lines.join('\n').trim();
      model.segments.push({ kind: 'card', index: model.cards.length, from, to }); model.cards.push(card);
    }
    let start = first;
    for (let index = first; index < rows.length; index++) {
      if (divider(rows[index].text)) { emit(start, index); start = index + 1; }
      else if (heading(rows[index].text) && index > start) { emit(start, index); start = index; }
    }
    emit(start, rows.length); model.valid = model.cards.length > 0; return model;
  }
  // Return narrow source edits; untouched text (including unknown options) is never serialized.
  function patch(value, target, fields) {
    const original = String(value), source = original.replace(/\r\n?/g, '\n'), model = parse(source);
    const group = target === 'group', owner = group ? model : model.cards[target];
    if (!model.valid || !owner) return null;
    const allowed = group ? groupValues : { ...cardValues, icon: Object.keys(icons), color: [...colors.keys()] };
    const edits = [], additions = []; let markers = '';
    for (const [key, input] of Object.entries(fields)) {
      if (!Object.hasOwn(allowed, key)) return null;
      const next = String(input ?? '').trim();
      if (/[\r\n]/.test(next) || next.length > MAX_LINE || next && allowed[key] && !allowed[key].includes(next)) return null;
      const current = group ? model.settings[key] : owner[key];
      if (next === current || group && !next && current === defaults[key]) continue;
      const marker = !group && /^(icon|color)$/.test(key), range = marker ? owner.markers[key] : owner.metadata[key];
      if (marker) {
        const text = next ? '[' + (key === 'color' ? '!' : '') + next + ']' : '';
        if (range) edits.push({ ...range, insert: text }); else if (text) markers += text + ' ';
      } else if (range) edits.push({ ...range, insert: '@' + key + ': ' + next });
      else if (next) additions.push('@' + key + ': ' + next);
    }
    if (!group) {
      const literal = /^\[[ \t]*(![ \t]*)?([a-z-]+)[ \t]*\]/i.exec(owner.title);
      if (literal) {
        const key = literal[1] ? 'color' : 'icon', name = literal[2].toLowerCase(), next = Object.hasOwn(fields, key) ? String(fields[key] ?? '').trim() : owner[key];
        if (!next && (key === 'color' ? colors.has(name) : Object.hasOwn(icons, name))) edits.push({ from: owner.header.titleFrom, to: owner.header.titleFrom, insert: '\\' });
      }
    }
    if (markers) edits.push({ from: owner.header.contentFrom, to: owner.header.contentFrom, insert: markers });
    if (additions.length) {
      const at = group ? model.preludeEnd : owner.header.to;
      edits.push({ from: at, to: at, insert: group ? additions.join('\n') + '\n' : '\n' + additions.join('\n') });
    }
    // Map normalized parser offsets back to callers using CRLF or bare CR.
    if (original !== source) {
      const positions = []; let normalized = 0;
      for (let raw = 0; raw < original.length; raw++) { positions[normalized++] = raw; if (original[raw] === '\r' && original[raw + 1] === '\n') raw++; }
      positions[normalized] = original.length;
      const newline = original.match(/\r\n|\r|\n/)?.[0] || '\n';
      edits.forEach(edit => { edit.from = positions[edit.from]; edit.to = positions[edit.to]; edit.insert = edit.insert.replace(/\n/g, newline); });
    }
    return edits.sort((a, b) => a.from - b.from || a.to - b.to);
  }
  const scriptURL = typeof document !== 'undefined' ? document.currentScript?.src : '';
  function ensureStyle() {
    if (typeof document === 'undefined' || document.querySelector('link[data-note-cards-style]')) return;
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.dataset.noteCardsStyle = 'true';
    link.href = new URL('note-cards.css', scriptURL || document.baseURI).href; document.head.append(link);
  }
  function render(source) {
    const model = parse(source);
    if (!model.valid) return null;
    ensureStyle();
    let math = false;
    const inline = text => {
      const result = window.MarkdownMini.renderLabelResult(text, { links: true });
      math ||= result.features.math; return result.html;
    };
    function body(text) {
      const blocks = []; let paragraph = [], list = [], ordered = false, start = 1;
      const flushParagraph = () => { if (paragraph.length) blocks.push('<p>' + inline(paragraph.join('\n')) + '</p>'); paragraph = []; };
      const flushList = () => { if (list.length) blocks.push((ordered ? '<ol start="' + start + '">' : '<ul>') + list.map(item => '<li>' + inline(item) + '</li>').join('') + (ordered ? '</ol>' : '</ul>')); list = []; };
      for (const line of text.split('\n')) {
        const item = /^\s*(?:([-+*]) |(\d{1,9})[.)] )(.+)$/.exec(line);
        if (item) {
          flushParagraph(); const nextOrdered = !!item[2];
          if (list.length && nextOrdered !== ordered) flushList();
          if (!list.length) { ordered = nextOrdered; start = nextOrdered ? Number(item[2]) : 1; }
          list.push(item[3]);
        } else { flushList(); if (!line.trim()) flushParagraph(); else paragraph.push(line); }
      }
      flushParagraph(); flushList(); return blocks.join('');
    }
    const escape = window.MarkdownMini.escapeHtml;
    const problem = item => {
      const messages = { 'unknown-option': ['未知选项，已保留原文', 'Unknown option; source preserved'], 'invalid-option': ['选项值无效或重复，已保留原文', 'Invalid or repeated option; source preserved'],
        'missing-title': ['卡片缺少标题', 'This card needs a title'], 'unsupported-content': ['这张卡片暂不支持此内容格式', 'This card contains an unsupported block format'] };
      return '<aside class="note-card-notice"><small>' + messages[item.code][documentLanguage() === 'en' ? 1 : 0] + '</small><pre>' + escape(item.source) + '</pre></aside>';
    };
    const html = '<div class="note-cards" data-columns="' + model.settings.columns + '" data-density="' + model.settings.density + '" data-single="' + (model.cards.length === 1 ? '1' : '0') + '"><div class="note-cards-grid">' + model.segments.map(segment => {
      if (segment.kind === 'raw') return problem(segment);
      const card = model.cards[segment.index];
      const color = colors.get(card.color);
      const tint = color ? ' data-note-card-color="' + color.name + '" style="--note-card-bg-light:' + color.light + ';--note-card-bg-dark:' + color.dark + ';--note-card-accent:' + color.base + ';"' : '';
      return '<article class="note-card" data-card-index="' + segment.index + '" data-style="' + (card.style || model.settings.style) + '" data-span="' + card.span + '"' + tint + '>'
        + (card.icon ? '<svg class="note-card-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + icons[card.icon] + '</svg>' : '')
        + '<div class="note-card-heading"><div class="note-card-title">' + inline(card.title) + '</div>' + (card.badge ? '<span class="note-card-badge">' + inline(card.badge) + '</span>' : '') + '</div>'
        + (card.subtitle ? '<div class="note-card-subtitle">' + inline(card.subtitle) + '</div>' : '')
        + (card.value ? '<div class="note-card-value">' + inline(card.value) + '</div>' : '')
        + '<div class="note-card-body">' + body(card.body) + '</div>'
        + (card.footer ? '<div class="note-card-footer">' + inline(card.footer) + '</div>' : '') + card.diagnostics.map(problem).join('') + '</article>';
    }).join('') + '</div></div>';
    return { html: html.replace('class="note-cards"', 'class="note-cards" data-note-cards-math="' + (math ? '1' : '0') + '"'), features: { math, mermaid: false } };
  }
  const documentLanguage = () => typeof document !== 'undefined' ? document.documentElement.lang : 'zh';
  const retries = new Set();
  let pageActive = true;
  const events = ['visibilitychange', 'relatum:start-workspacechange', 'compositionend'];
  const windowEvents = ['canvasdesktop:visibility'];
  const resume = () => retries.forEach(retry => retry());
  const pageHide = () => { pageActive = false; };
  const pageShow = () => { pageActive = true; resume(); };
  function watch(add) {
    const method = add ? 'addEventListener' : 'removeEventListener';
    events.forEach(event => document[method](event, resume)); windowEvents.forEach(event => window[method](event, resume));
    window[method]('pagehide', pageHide); window[method]('pageshow', pageShow);
  }
  function attach(root, options = {}) {
    let disposed = false, source = options.source, version = 0, completed = -1, running = -1;
    const clear = () => window.MathJax?.typesetClear?.([root]);
    function openLink(event) {
      const link = event.target.closest('a[href]');
      if (!link || !options.onLink) return;
      event.preventDefault(); event.stopPropagation(); const target = link.getAttribute('href');
      Promise.resolve(options.whenSettled?.()).then(() => {
        if (!disposed && root.isConnected && (!options.isCurrent || options.isCurrent())) options.onLink(target);
      });
    }
    root.addEventListener('click', openLink);
    function typeset() {
      const ticket = version;
      const current = () => !disposed && pageActive && ticket === version && root.isConnected && !root.closest('[hidden]')
        && !document.hidden && document.documentElement.dataset.desktopMinimized !== '1'
        && (!root.closest('.note-workspace') || document.body.dataset.startWorkspace === 'notes') && (!options.isCurrent || options.isCurrent());
      options.onLayout?.();
      if (completed === ticket || running === ticket || !(root.matches('[data-note-cards-math="1"]') || root.querySelector('[data-note-cards-math="1"]')) || !options.typeset) return;
      running = ticket;
      Promise.resolve(options.whenSettled?.()).then(async () => {
        if (!current()) return;
        await options.typeset(root, current);
        if (current()) { completed = ticket; options.onLayout?.(); }
      }).catch(() => { if (current()) root.classList.add('is-failed'); })
        .finally(() => { if (running === ticket) running = -1; });
    }
    if (!retries.size) watch(true); retries.add(typeset);
    typeset();
    return {
      resume: typeset,
      update(next) {
        if (disposed || source === next) return;
        source = next; version++; clear();
        const result = render(next);
        if (result) root.innerHTML = result.html;
        else { const pre = document.createElement('pre'); pre.className = 'md-code'; pre.textContent = '```cards\n' + next + '\n```'; root.replaceChildren(pre); }
        typeset();
      },
      destroy() { if (disposed) return; disposed = true; version++; clear(); root.removeEventListener('click', openLink); retries.delete(typeset); if (!retries.size) watch(false); },
    };
  }
  window.RelatumNoteCards = Object.freeze({ parse, render, attach, patch, styles, defaults, icons: Object.freeze(Object.keys(icons)), MAX_SOURCE, MAX_LINE });
})();
