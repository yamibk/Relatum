// Shared file-link assistance for the main Markdown editor and table cells.
// Queries are bounded SQLite snapshots; only the active link is kept locally.
(function () {
  'use strict';
  const KEY = 'canvas:noteLinkCompletion:v1';
  const defaults = Object.freeze({ automatic: true, scope: 'all', sort: 'smart', includeBody: false });
  const normalize = value => ({
    automatic: typeof value?.automatic === 'boolean' ? value.automatic : true,
    scope: ['all', 'notebook', 'folder'].includes(value?.scope) ? value.scope : 'all',
    sort: ['smart', 'recent', 'modified', 'name'].includes(value?.sort) ? value.sort : 'smart',
    includeBody: value?.includeBody === true,
  });
  let preferences = { ...defaults };
  try { preferences = normalize(JSON.parse(localStorage.getItem(KEY))); } catch (_) {}
  const controllers = new Map();
  let nextListId = 0;
  const ui = (zh, en) => document.documentElement.lang === 'en' ? en : zh;
  const closeAll = () => controllers.forEach(controller => controller.dismiss());
  function update(value, reset = false) {
    const next = normalize(value);
    try { if (reset) localStorage.removeItem(KEY); else localStorage.setItem(KEY, JSON.stringify(next)); }
    catch (_) { return false; }
    preferences = next; closeAll(); return true;
  }
  function targetAt(state, sectionEmbeds) {
    const ranges = state.selection.ranges, main = state.selection.main;
    if (ranges.length !== 1 || !main.empty) return null;
    const line = state.doc.lineAt(main.head);
    if (line.length > 65536) return null;
    const head = main.head - line.from, start = Math.max(0, head - 514);
    const before = line.text.slice(start, head), local = before.lastIndexOf('[[');
    if (local < 0) return null;
    const open = start + local;
    const embed = line.text[open - 1] === '!';
    const tokenStart = open - Number(embed);
    if (line.text[open - 1] === '[' || embed && (!sectionEmbeds || !/^ {0,3}$/.test(line.text.slice(0, tokenStart)))) return null;
    let escapes = 0;
    for (let at = tokenStart - 1; at >= 0 && line.text[at] === '\\'; at--) escapes++;
    if (escapes % 2) return null;
    let query = line.text.slice(open + 2, head), note = '', contentFrom = line.from + open + 2;
    const hash = embed ? query.indexOf('#') : -1;
    if (hash >= 0) {
      note = query.slice(0, hash).trim();
      if (!note || /[\[\]^|]/.test(note)) return null;
      query = query.slice(hash + 1);
      contentFrom += hash + 1;
    }
    if (/[\[\]^|\r\n]/.test(query) || !note && query.includes('#')) return null;
    const close = line.text.indexOf(']]', head);
    if (close - open > 4096) return null;
    const tail = close >= 0 ? close : head;
    const end = tail + (tail === close ? 2 : line.text[tail] === ']' ? 1 : 0);
    const inner = line.text.slice(open + 2, tail), delimiter = inner.search(/[#^|]/);
    const suffix = delimiter < 0 ? '' : inner.slice(delimiter);
    if (embed && (line.text.slice(end).trim() || !note && window.MarkdownMini?.wikiAttachmentType(inner.split('|', 1)[0].trim()))) return null;
    return { from: line.from + tokenStart, to: line.from + end, contentFrom, head: main.head, query, suffix, embed, note };
  }
  function syntaxAllowed(CM, view, target) {
    const { state } = view;
    let node = CM.syntaxTree(state).resolveInner(target.from, 1);
    while (node) {
      if (/^(?:FencedCode|CodeBlock|IndentedCode|InlineCode|HTMLBlock|HTMLTag|CommentBlock)$/.test(node.name)) return false;
      if (target.embed && /^(?:Blockquote|ListItem|Table)$/.test(node.name)) return false;
      node = node.parent;
    }
    const line = state.doc.lineAt(target.from);
    const math = window.MarkdownMini?.mathRanges(line.text) || [];
    return !math.some(range => line.from + range.from <= target.from && line.from + range.to >= target.head);
  }
  function createExtension(options) {
    const CM = window.RelatumCodeMirror;
    if (!CM?.showTooltip) return [];
    const tooltipEffect = CM.StateEffect.define();
    const tooltipField = CM.StateField.define({
      create: () => null,
      update(value, transaction) {
        if (value && transaction.docChanged) {
          const pos = transaction.changes.mapPos(value.pos, -1);
          if (pos !== value.pos) value = { ...value, pos };
        }
        for (const effect of transaction.effects) if (effect.is(tooltipEffect)) value = effect.value;
        return value;
      },
      provide: field => CM.showTooltip.from(field),
    });

    function sameLink(session, target, path, changes) {
      if (!session || session.path !== path || session.target.embed !== target.embed) return false;
      const from = changes ? changes.mapPos(session.target.from, -1) : session.target.from;
      return from === target.from;
    }

    function appendTitle(label, item) {
      const text = item.title, length = text.length;
      const ranges = (item.titleHighlights || []).filter(([from, to]) => from >= 0 && to > from && to <= length)
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let position = 0;
      for (let index = 0; index < ranges.length; index++) {
        const [from, end] = ranges[index];
        let to = end;
        while (index + 1 < ranges.length && ranges[index + 1][0] <= to) to = Math.max(to, ranges[++index][1]);
        label.append(text.slice(position, from));
        const match = document.createElement('span');
        match.className = 'cm-completionMatchedText'; match.textContent = text.slice(from, to);
        label.append(match); position = to;
      }
      if (position < length) label.append(text.slice(position));
    }

    class Controller {
      constructor(view) {
        this.view = view; this.version = 0; this.timer = 0; this.abort = null; this.session = null;
        this.listId = 'note-link-options-' + ++nextListId;
        this.createTooltip = () => this.mount();
        this.dismiss = () => {
          if (!this.session && !this.ime) return;
          this.invalidate(true); this.session = this.ime = this.result = null;
          this.pending = false; this.message = null; this.retry = false; this.picked = null;
          this.publish();
        };
        controllers.set(view, this);
        this.events = [[window, 'blur'], [window, 'pagehide'], [document, 'visibilitychange'],
          [window, 'canvasdesktop:visibility'], [document, 'relatum:start-workspacechange'],
          [document, 'relatum:languagechange'], [document, 'relatum:note-theme-beforechange']];
        this.events.forEach(([host, name]) => host.addEventListener(name, this.dismiss));
      }
      ready() {
        const view = this.view;
        return !this.dead && !this.ime && !view.state.readOnly && view.hasFocus && !view.composing && !view.compositionStarted && !options.pending?.()
          && options.active?.() !== false && !document.hidden && document.documentElement.dataset.desktopMinimized !== '1'
          && view.dom.isConnected && !view.dom.closest('[hidden],[inert]');
      }
      target() {
        if (!this.ready()) return null;
        const target = targetAt(this.view.state, !!options.sectionHeadings);
        return target && syntaxAllowed(CM, this.view, target) && options.allowed?.(this.view, target.from, target.head) !== false ? target : null;
      }
      invalidate(abort) {
        this.version++; clearTimeout(this.timer); this.timer = 0;
        if (abort) { this.abort?.abort(); this.abort = null; }
      }
      publish() {
        if (this.dead) return;
        this.render();
        if (this.queued) return;
        this.queued = true;
        queueMicrotask(() => {
          this.queued = false;
          if (this.dead) return;
          const previous = this.view.state.field(tooltipField, false);
          const pos = this.session?.target.contentFrom;
          if (pos == null ? !previous : previous?.pos === pos) return;
          this.view.dispatch({ effects: tooltipEffect.of(pos == null ? null : {
            pos, above: false, strictSide: false, create: this.createTooltip,
          }), annotations: CM.Transaction.addToHistory.of(false) });
        });
      }
      mount() {
        const dom = document.createElement('div'), list = document.createElement('ul');
        const status = document.createElement('div'), text = document.createElement('span'), retry = document.createElement('button');
        dom.className = 'note-link-completion';
        list.id = this.listId; list.setAttribute('role', 'listbox');
        list.setAttribute('aria-label', ui('链接候选', 'Link suggestions'));
        status.className = 'note-link-completion-status'; status.setAttribute('role', 'status');
        retry.type = 'button'; retry.textContent = ui('重试', 'Retry');
        status.append(text, retry); dom.append(list, status);
        list.addEventListener('pointermove', event => {
          if (this.pending || event.pointerType === 'touch') return;
          const row = event.target.closest('li');
          if (row?.parentNode === list) this.select(Number(row.dataset.index), false);
        });
        let pressed = null;
        dom.addEventListener('pointerdown', event => {
          const row = event.target.closest('li, button');
          if (event.button || !row) return;
          event.preventDefault();
          pressed = this.pending ? null : row;
        });
        dom.addEventListener('click', event => {
          const row = event.target.closest('li, button'), down = pressed;
          pressed = null;
          if (event.detail && row !== down) return;
          if (row === retry) { if (this.retry) this.kick(); return; }
          if (row?.parentNode === list) this.choose(Number(row.dataset.index));
        });
        this.panel = { dom, list, status, text, retry };
        this.render();
        return { dom, destroy: () => {
          if (this.panel?.dom !== dom) return;
          this.panel = null; this.syncAria();
        } };
      }
      syncAria() {
        const input = this.view.contentDOM, list = this.panel?.list;
        if (this.session && !this.ime && list && !list.hidden) {
          input.setAttribute('aria-controls', this.listId);
          input.setAttribute('aria-expanded', 'true');
          const row = !this.pending && list.children[this.index];
          if (row) { input.setAttribute('aria-activedescendant', row.id); return; }
        } else if (input.getAttribute('aria-controls') === this.listId) {
          input.removeAttribute('aria-controls'); input.removeAttribute('aria-expanded');
        }
        if (input.getAttribute('aria-activedescendant')?.startsWith(this.listId + '-')) input.removeAttribute('aria-activedescendant');
      }
      render() {
        const panel = this.panel;
        if (!panel) return;
        const { dom, list, status, text, retry } = panel;
        const result = this.result, target = this.session?.target, items = result?.items || [];
        const hidden = !target || !!this.ime, message = items.length ? null : this.message;
        if (panel.result === result && panel.hidden === hidden && panel.message === message
            && panel.pending === this.pending && panel.retryEnabled === this.retry) return;
        const updateLayout = panel.result !== result || panel.hidden !== hidden || panel.message !== message;
        if (panel.result !== result) {
          const scroll = list.scrollTop, rows = document.createDocumentFragment();
          items.forEach((item, index) => {
            const row = document.createElement('li'), label = document.createElement('span'), detail = document.createElement('span');
            row.id = this.listId + '-' + index; row.dataset.index = index; row.setAttribute('role', 'option');
            label.className = 'cm-completionLabel'; appendTitle(label, item);
            detail.className = 'cm-completionDetail';
            detail.textContent = result.heading ? 'H' + item.level : /^CustomNotebook\//i.test(item.location)
              ? item.location.replace(/^CustomNotebook\//i, '')
              : ui('默认笔记本', 'Default notebook') + (item.location ? ' / ' + item.location : '');
            row.append(label, detail);
            if (item.match === 'body') {
              const excerpt = document.createElement('span'); excerpt.className = 'note-link-completion-excerpt';
              excerpt.textContent = ui('正文匹配：', 'Content: ') + item.excerpt; row.append(excerpt);
            }
            rows.append(row);
          });
          list.replaceChildren(rows); list.hidden = !items.length;
          list.scrollTop = this.picked == null ? 0 : scroll;
          this.highlight(-1);
        }
        dom.classList.toggle('is-composing', hidden);
        list.setAttribute('aria-busy', String(this.pending));
        list.setAttribute('aria-disabled', String(this.pending));
        status.hidden = !message;
        if (panel.message !== message) text.textContent = message || '';
        retry.hidden = !this.retry;
        Object.assign(panel, { result, hidden, message, pending: this.pending, retryEnabled: this.retry });
        this.syncAria();
        if (updateLayout && dom.isConnected) this.view.requestMeasure();
      }
      select(index, reveal) {
        const item = this.result?.items[index];
        if (this.pending || !item) return;
        this.picked = item.path || item.insertTarget;
        if (index === this.index) return;
        const previous = this.index;
        this.index = index;
        this.highlight(previous, reveal); this.syncAria();
      }
      highlight(previous, reveal = true) {
        const list = this.panel?.list, row = list?.children[this.index];
        list?.children[previous]?.removeAttribute('aria-selected');
        if (!row) return;
        row.setAttribute('aria-selected', 'true');
        if (!reveal || !list.isConnected) return;
        const bounds = list.getBoundingClientRect(), item = row.getBoundingClientRect();
        if (item.top < bounds.top) list.scrollTop += item.top - bounds.top;
        else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
      }
      requestBody(target, selectedPath) {
        const sourcePath = options.notePath(), parts = sourcePath.split('/'); parts.pop();
        const notebook = /^CustomNotebook\/[^/]+\//i.exec(sourcePath)?.[0].slice(0, -1) || '';
        const pref = preferences;
        return { mode: 'link-completion', q: target.query, sourcePath, sort: pref.sort, includeBody: pref.includeBody,
          scope: pref.scope === 'all' ? { kind: 'all' } : { kind: pref.scope, path: pref.scope === 'notebook' ? notebook : parts.join('/') },
          recent: options.recent(), ...(selectedPath ? { selectedPath } : {}) };
      }
      kick() {
        const target = this.target();
        if (!target) return false;
        this.refresh(target, 0, sameLink(this.session, target, options.notePath()));
        return true;
      }
      refresh(target, delay, same) {
        this.invalidate(false);
        if (!same) {
          this.result = null; this.picked = null; this.index = 0;
        } else if (this.session.target.note !== target.note) this.picked = null;
        const { doc, selection } = this.view.state;
        const session = this.session = { target, doc, selection, path: options.notePath(), version: this.version };
        this.pending = true; this.retry = false;
        this.message = target.note ? ui('正在查找标题…', 'Finding headings…') : ui('正在查找笔记…', 'Finding notes…');
        this.publish();
        const run = () => { if (this.current(session)) { this.timer = 0; this.load(session); } };
        if (delay) this.timer = setTimeout(run, delay); else queueMicrotask(run);
      }
      current(session) {
        return this.session === session && this.version === session.version && this.ready()
          && this.view.state.doc === session.doc && this.view.state.selection.eq(session.selection) && options.notePath() === session.path;
      }
      startRequest() {
        this.abort?.abort();
        return this.abort = new AbortController();
      }
      async load(session) {
        const { target, path } = session, abort = this.startRequest();
        try {
          const result = target.note
            ? { items: await options.sectionHeadings(target.note, target.query, { signal: abort.signal }) }
            : await options.query(this.requestBody(target), { signal: abort.signal });
          if (!this.current(session)) return;
          const items = target.embed && !target.note ? result.items.filter(item => item.path !== path) : result.items;
          this.pending = false; this.result = { items, heading: !!target.note };
          const preserved = this.picked == null ? -1 : items.findIndex(item => (item.path || item.insertTarget) === this.picked);
          if (preserved < 0) this.picked = null;
          this.index = Math.max(0, preserved);
          this.message = items.length ? null
            : target.embed ? (target.note ? ui('暂无匹配的章节', 'No matching sections') : ui('暂无匹配的笔记', 'No matching notes'))
              : result.index?.incomplete || result.index?.phase !== 'ready'
              ? ui('暂无匹配，索引仍在准备；可以保留待创建链接', 'No matches yet; indexing is in progress. You can keep this unresolved link.')
              : ui('没有匹配的笔记，可保留此链接并在之后点击创建', 'No matching notes. Keep the link and click it later to create the note.');
          this.publish();
        } catch (_) {
          if (!abort.signal.aborted && this.current(session)) this.fail(target.note
            ? ui('标题查询失败，输入仍可继续', 'Could not find headings. You can keep typing.')
            : ui('笔记查询失败，输入仍可继续', 'Could not find notes. You can keep typing.'));
        } finally {
          if (this.abort === abort) this.abort = null;
        }
      }
      fail(message) {
        this.pending = false; this.result = null; this.picked = null;
        this.message = message; this.retry = true; this.publish();
      }
      async choose(index) {
        const session = this.session, item = this.result?.items[index];
        if (!item || this.pending || !session || !this.current(session) || !this.target()) return;
        const { target } = session, view = this.view;
        const insertLink = (inner, continueToHeading = false) => {
          const insert = (target.embed ? '![[' : '[[') + inner + ']]';
          this.inserting = true;
          try {
            view.dispatch({ changes: { from: target.from, to: target.to, insert },
              selection: CM.EditorSelection.cursor(target.from + insert.length - (continueToHeading ? 2 : 0)),
              annotations: CM.isolateHistory.of('full'), userEvent: 'input.note-link-completion' });
          } finally { this.inserting = false; }
          view.focus();
          if (!continueToHeading || !this.kick()) this.dismiss();
        };
        if (target.note) { insertLink(target.note + '#' + item.insertTarget); return; }
        this.pending = true; this.publish();
        const abort = this.startRequest();
        try {
          const result = await options.query(this.requestBody(target, item.path), { signal: abort.signal });
          if (!this.current(session)) return;
          const current = result.items.find(candidate => candidate.path === item.path);
          if (!current) { this.kick(); return; }
          insertLink(current.insertTarget + (target.embed ? '#' : target.suffix), target.embed);
        } catch (_) {
          if (!abort.signal.aborted && this.current(session)) this.fail(ui('无法确认目标笔记，请重试', 'Could not verify the target note. Please retry.'));
        } finally {
          if (this.abort === abort) this.abort = null;
        }
      }
      update(update) {
        if (this.inserting || !(update.docChanged || update.selectionSet || update.focusChanged)) return;
        if (update.focusChanged && !this.view.hasFocus) { this.dismiss(); return; }
        if (this.ime) return;
        if (update.transactions.some(tr => tr.isUserEvent('undo') || tr.isUserEvent('redo'))) { this.dismiss(); return; }
        const target = this.target(), previous = this.session;
        const same = target && sameLink(previous, target, options.notePath(), update.changes);
        if (!target || !same && (!update.docChanged || !preferences.automatic)) { this.dismiss(); return; }
        if (same && update.view.state.doc === previous.doc && update.view.state.selection.eq(previous.selection)) return;
        this.refresh(target, same && previous.target.note === target.note ? 50 : 0, same);
      }
      beginComposition() {
        if (this.ime) return;
        this.ime = { session: this.session, pending: this.pending, path: options.notePath() };
        this.invalidate(true); this.publish();
      }
      afterComposition() {
        const ime = this.ime;
        if (!ime) return;
        Promise.resolve(options.whenSettled?.()).then(() => {
          if (this.dead || this.ime !== ime) return;
          this.ime = null;
          const target = this.target(), path = options.notePath();
          if (!target || path !== ime.path || !preferences.automatic && !ime.session) { this.dismiss(); return; }
          const same = sameLink(ime.session, target, path);
          if (same && !ime.pending && ime.session.target.note === target.note && ime.session.target.query === target.query) {
            const { doc, selection } = this.view.state;
            this.session = { target, doc, selection, path, version: this.version }; this.publish();
          } else this.refresh(target, 0, same);
        }, () => {
          if (this.ime === ime) this.dismiss();
        });
      }
      keydown(event) {
        if (event.isComposing || event.keyCode === 229 || this.ime || this.view.composing || this.view.compositionStarted || options.pending?.()) return false;
        if (!this.ready()) { this.dismiss(); return false; }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === 'Space') return this.kick();
        if (event.key === 'Escape' && this.session) { this.dismiss(); return true; }
        const items = this.result?.items;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !items?.length) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          this.select((this.index + step + items.length) % items.length, true);
          return true;
        }
        if (event.key === 'Tab' || event.key === 'Enter') { this.choose(this.index); return true; }
        return false;
      }
      destroy() {
        this.invalidate(true); this.dead = true; this.session = null; this.syncAria(); controllers.delete(this.view);
        this.events.forEach(([host, name]) => host.removeEventListener(name, this.dismiss));
      }
    }
    return [tooltipField, CM.tooltips({ parent: document.body, position: 'fixed' }),
      CM.ViewPlugin.fromClass(Controller),
      CM.Prec.highest(CM.EditorView.domEventHandlers({
        keydown(event, view) {
          if (!controllers.get(view)?.keydown(event)) return false;
          event.preventDefault(); event.stopPropagation(); return true;
        },
        compositionstart(event, view) { controllers.get(view)?.beginComposition(); return false; },
        compositionend(event, view) { controllers.get(view)?.afterComposition(); return false; },
      })),
    ];
  }
  function createSettings(host, { portal, onOpen, onError }) {
    const panel = document.createElement('div'); panel.className = 'note-link-completion-settings'; panel.dataset.i18nManaged = 'true';
    panel.innerHTML = '<h4></h4><label class="note-settings-toggle"><input type="checkbox" data-link-setting="automatic"><strong></strong></label>'
      + '<p class="note-settings-hint"></p><label class="note-link-completion-setting"><strong></strong><select data-link-setting="scope"></select></label>'
      + '<label class="note-link-completion-setting"><strong></strong><select data-link-setting="sort"></select></label>'
      + '<label class="note-settings-toggle"><input type="checkbox" data-link-setting="includeBody"><strong></strong></label>';
    host.append(panel);
    const choices = window.RelatumReviewControls.createManager(panel, portal);
    const fields = Object.fromEntries(Array.from(panel.querySelectorAll('[data-link-setting]'), node => [node.dataset.linkSetting, node]));
    const titles = [() => ui('自动显示候选', 'Show suggestions automatically'), () => ui('候选范围', 'Suggestion scope'),
      () => ui('排序方式', 'Sort suggestions'), () => ui('同时搜索正文', 'Also search note content')];
    function refresh() {
      choices.close(); panel.querySelector('h4').textContent = ui('双向链接补全', 'Internal link completion');
      panel.querySelector('.note-settings-hint').textContent = ui('输入 [[ 查找笔记；关闭自动显示后，可在链接内按 Ctrl/Cmd+Space 调出候选。', 'Type [[ to find notes. With automatic suggestions off, use Ctrl/Cmd+Space inside a link.');
      Array.from(panel.querySelectorAll('label > strong')).forEach((node, index) => { node.textContent = titles[index](); });
      fields.automatic.checked = preferences.automatic; fields.includeBody.checked = preferences.includeBody;
      choices.setOptions(fields.scope, [['all', ui('全部笔记本', 'All notebooks')], ['notebook', ui('当前笔记本', 'Current notebook')],
        ['folder', ui('当前目录及子目录', 'Current folder and subfolders')]].map(([value, label]) => ({ value, label })), preferences.scope);
      choices.setOptions(fields.sort, [['smart', ui('智能推荐', 'Smart suggestions')], ['recent', ui('最近打开', 'Recently opened')],
        ['modified', ui('最近修改', 'Recently modified')], ['name', ui('名称', 'Name')]].map(([value, label]) => ({ value, label })), preferences.sort);
    }
    panel.addEventListener('change', event => {
      const key = event.target.dataset.linkSetting;
      if (!key) return;
      if (!update({ ...preferences, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value })) onError();
      refresh();
    });
    const beforeOpen = event => {
      if (event.type === 'keydown' && (event.isComposing || !['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key))) return;
      if (event.target.closest('.review-choice-trigger')) onOpen();
    };
    panel.addEventListener('click', beforeOpen, true); panel.addEventListener('keydown', beforeOpen, true);
    refresh();
    return { refresh, close: () => choices.close(), panel };
  }
  window.RelatumNoteLinkCompletion = { read: () => ({ ...preferences }), update,
    reset: () => update(defaults, true), closeAll, createExtension, createSettings, targetAt };
})();
