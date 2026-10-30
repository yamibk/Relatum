// Note-only, offline concept cards. Markdown remains the sole stored source.
(function () {
  'use strict';
  const MAX_SOURCE = 256 * 1024, MAX_LINE = 64 * 1024;
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
  function parse(value) {
    const source = String(value || '').replace(/\r\n?/g, '\n');
    const invalid = () => ({ valid: false, cards: [] });
    if (!source.trim() || source.length > MAX_SOURCE) return invalid();
    const sections = source.trim().split(/^ {0,3}---[ \t]*$/m), cards = [];
    for (const section of sections) {
      const lines = section.trim().split('\n');
      if (lines.some(line => line.length > MAX_LINE)) return invalid();
      const header = /^### +(.+)$/.exec(lines.shift() || '');
      if (!header) return invalid();
      let title = header[1].trim(), icon = '';
      const token = /^\[([a-z-]+)\]\s+(.+)$/.exec(title);
      if (token && Object.hasOwn(icons, token[1])) { icon = token[1]; title = token[2].trim(); }
      const bareIcon = /^\[([a-z-]+)\]$/.exec(title);
      if (bareIcon && Object.hasOwn(icons, bareIcon[1])) return invalid();
      if (!title || lines.some(line => /^\s*(?:#{1,6} |`{3,}|~{3,}|\$\$|\\\[|\\begin\{|!\[|>)/.test(line))) return invalid();
      if (/\$\$|\\\[|\\begin\{/.test([title, ...lines].join('\n').replace(/`[^`\n]*`/g, ''))) return invalid();
      cards.push({ title, icon, body: lines.join('\n').trim() });
    }
    return { valid: true, cards };
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
    const html = '<div class="note-cards"><div class="note-cards-grid">' + model.cards.map(card =>
      '<article class="note-card">' + (card.icon ? '<svg class="note-card-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + icons[card.icon] + '</svg>' : '')
      + '<div class="note-card-title">' + inline(card.title) + '</div><div class="note-card-body">' + body(card.body) + '</div></article>').join('') + '</div></div>';
    return { html: html.replace('class="note-cards"', 'class="note-cards" data-note-cards-math="' + (math ? '1' : '0') + '"'), features: { math, mermaid: false } };
  }
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
  window.RelatumNoteCards = Object.freeze({ parse, render, attach, icons: Object.freeze(Object.keys(icons)), MAX_SOURCE, MAX_LINE });
})();
