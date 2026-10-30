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
  const ui = (zh, en) => document.documentElement.lang === 'en' ? en : zh;
  const closeAll = () => controllers.forEach(controller => controller.dismiss());
  function update(value, reset = false) {
    const next = normalize(value);
    try { if (reset) localStorage.removeItem(KEY); else localStorage.setItem(KEY, JSON.stringify(next)); }
    catch (_) { return false; }
    preferences = next; closeAll(); return true;
  }
  function targetAt(state) {
    const ranges = state.selection.ranges, main = state.selection.main;
    if (ranges.length !== 1 || !main.empty) return null;
    const line = state.doc.lineAt(main.head);
    if (line.length > 65536) return null;
    const head = main.head - line.from, start = Math.max(0, head - 514);
    const before = line.text.slice(start, head), local = before.lastIndexOf('[[');
    if (local < 0) return null;
    const open = start + local;
    if (line.text[open - 1] === '!' || line.text[open - 1] === '[') return null;
    let escapes = 0;
    for (let at = open - 1; at >= 0 && line.text[at] === '\\'; at--) escapes++;
    if (escapes % 2) return null;
    const query = line.text.slice(open + 2, head);
    if (/[\[\]#^|\r\n]/.test(query)) return null;
    const close = line.text.indexOf(']]', head);
    if (close - open > 4096) return null;
    const tail = close >= 0 ? close : head;
    const inner = line.text.slice(open + 2, tail), delimiter = inner.search(/[#^|]/);
    const suffix = delimiter < 0 ? '' : inner.slice(delimiter);
    return { from: line.from + open, to: line.from + tail + (tail === close ? 2 : line.text[tail] === ']' ? 1 : 0),
      head: main.head, query, suffix };
  }
  function syntaxAllowed(CM, view, target) {
    const { state } = view;
    let node = CM.syntaxTree(state).resolveInner(target.from, 1);
    while (node) {
      if (/^(?:FencedCode|CodeBlock|IndentedCode|InlineCode|HTMLBlock|HTMLTag|CommentBlock)$/.test(node.name)) return false;
      node = node.parent;
    }
    const line = state.doc.lineAt(target.from);
    const math = window.MarkdownMini?.mathRanges(line.text) || [];
    return !math.some(range => line.from + range.from <= target.from && line.from + range.to >= target.head);
  }
  function createExtension(options) {
    const CM = window.RelatumCodeMirror;
    if (!CM?.autocompletion) return [];
    const statusEffect = CM.StateEffect.define();
    const statusField = CM.StateField.define({
      create: () => null,
      update(value, transaction) {
        if (transaction.docChanged || transaction.selection) value = null;
        for (const effect of transaction.effects) if (effect.is(statusEffect)) value = effect.value;
        return value;
      },
      provide: field => CM.showTooltip.from(field),
    });
    let owner = null;
    class Controller {
      constructor(view) {
        this.view = view; this.version = 0; this.timer = 0; this.abort = null; this.dead = false; this.result = null; this.session = false; this.imeTicket = 0;
        owner = this; controllers.set(view, this);
        this.dismiss = () => { this.session = false; this.resumeAfterIme = false; this.imeTicket++; this.cancel(true); };
        this.events = [[window, 'blur'], [window, 'pagehide'], [document, 'visibilitychange'],
          [window, 'canvasdesktop:visibility'], [document, 'relatum:start-workspacechange'],
          [document, 'relatum:languagechange'], [document, 'relatum:note-theme-beforechange']];
        this.events.forEach(([host, name]) => host.addEventListener(name, this.dismiss));
      }
      ready() {
        const view = this.view;
        return !this.dead && view.hasFocus && !view.composing && !view.compositionStarted && !options.pending?.()
          && options.active?.() !== false && !document.hidden && document.documentElement.dataset.desktopMinimized !== '1'
          && view.dom.isConnected && !view.dom.closest('[hidden],[inert]');
      }
      target() {
        if (!this.ready()) return null;
        const target = targetAt(this.view.state);
        return target && syntaxAllowed(CM, this.view, target) && options.allowed?.(this.view, target.from, target.head) !== false ? target : null;
      }
      cancel(close) {
        const version = ++this.version;
        clearTimeout(this.timer); this.timer = 0; this.abort?.abort(); this.abort = null; this.result = null;
        if (close) queueMicrotask(() => {
          if (this.dead || version !== this.version) return;
          CM.closeCompletion(this.view);
          if (this.view.state.field(statusField)) this.view.dispatch({ effects: statusEffect.of(null) });
        });
      }
      status(message, retry = false) {
        if (!this.ready()) return;
        const controller = this, target = this.target();
        if (!target) return;
        const tooltip = message ? { pos: target.head, above: false, strictSide: false,
          create() {
            const dom = document.createElement('div'); dom.className = 'note-link-completion-status'; dom.setAttribute('role', 'status');
            const text = document.createElement('span'); text.textContent = message; dom.append(text);
            if (retry) {
              const button = document.createElement('button'); button.type = 'button'; button.textContent = ui('重试', 'Retry');
              button.addEventListener('pointerdown', event => event.preventDefault());
              button.addEventListener('click', () => controller.kick()); dom.append(button);
            }
            return { dom };
          } } : null;
        this.view.dispatch({ effects: statusEffect.of(tooltip) });
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
        this.cancel(false);
        if (!this.target()) return false;
        this.session = true;
        CM.closeCompletion(this.view);
        CM.startCompletion(this.view); return true;
      }
      async load() {
        const target = this.target();
        if (!target) return null;
        const view = this.view, version = this.version, doc = view.state.doc, selection = view.state.selection, path = options.notePath();
        const valid = () => this.ready() && version === this.version && doc === view.state.doc && selection.eq(view.state.selection) && path === options.notePath();
        const abort = this.abort = new AbortController();
        this.status(ui('正在查找笔记…', 'Finding notes…'));
        try {
          const result = await options.query(this.requestBody(target), { signal: abort.signal });
          if (!valid()) return null;
          this.result = result;
          if (!result.items.length) {
            this.status(result.index?.incomplete || result.index?.phase !== 'ready'
              ? ui('暂无匹配，索引仍在准备；可以保留待创建链接', 'No matches yet; indexing is in progress. You can keep this unresolved link.')
              : ui('没有匹配的笔记，可保留此链接并在之后点击创建', 'No matching notes. Keep the link and click it later to create the note.'));
            return null;
          }
          this.status(null);
          return { from: target.from + 2, to: target.head, filter: false, getMatch: completion => completion.item.titleHighlights,
            options: result.items.map(item => ({ label: item.title,
              detail: /^CustomNotebook\//i.test(item.location) ? item.location.replace(/^CustomNotebook\//i, '')
                : ui('默认笔记本', 'Default notebook') + (item.location ? ' / ' + item.location : ''),
              type: 'text', item, apply: () => { if (valid()) this.choose(item, target); } })) };
        } catch (error) {
          if (!abort.signal.aborted && valid()) this.status(ui('笔记查询失败，输入仍可继续', 'Could not find notes. You can keep typing.'), true);
          return null;
        }
      }
      async choose(item, target) {
        if (!this.target()) return;
        this.cancel(false);
        const view = this.view, doc = view.state.doc, selection = view.state.selection, version = this.version, path = options.notePath();
        const abort = this.abort = new AbortController();
        const valid = () => this.ready() && version === this.version && doc === view.state.doc && selection.eq(view.state.selection) && path === options.notePath();
        try {
          const result = await options.query(this.requestBody(target, item.path), { signal: abort.signal });
          if (!valid()) return;
          const current = result.items.find(candidate => candidate.path === item.path);
          if (!current) { this.kick(); return; }
          const insert = '[[' + current.insertTarget + target.suffix + ']]';
          view.dispatch({ changes: { from: target.from, to: target.to, insert },
            selection: CM.EditorSelection.cursor(target.from + insert.length), annotations: CM.isolateHistory.of('full'), userEvent: 'input.note-link-completion' });
          CM.closeCompletion(view); view.focus();
        } catch (error) {
          if (!abort.signal.aborted && valid()) this.status(ui('无法确认目标笔记，请重试', 'Could not verify the target note. Please retry.'), true);
        }
      }
      update(update) {
        if (!(update.docChanged || update.selectionSet || update.focusChanged)) return;
        const continuing = this.session;
        this.cancel(true);
        if (!update.docChanged || update.transactions.some(tr => tr.isUserEvent('undo') || tr.isUserEvent('redo') || tr.isUserEvent('input.note-link-completion'))
          || !this.target()) { this.session = false; return; }
        if (!preferences.automatic && !continuing) return;
        const target = this.target(), version = this.version;
        this.timer = setTimeout(() => { if (version === this.version && this.target()) this.kick(); }, target.query ? 150 : 0);
      }
      beginComposition() {
        this.resumeAfterIme = this.session; this.imeTicket++; this.cancel(true);
      }
      afterComposition() {
        const ticket = ++this.imeTicket, path = options.notePath(), resume = this.resumeAfterIme;
        this.resumeAfterIme = false;
        Promise.resolve(options.whenSettled?.()).then(() => {
          if (!this.dead && ticket === this.imeTicket && path === options.notePath() && (preferences.automatic || resume) && this.target()) this.kick();
        });
      }
      keydown(event) {
        if (event.isComposing || event.keyCode === 229 || this.view.composing || this.view.compositionStarted || options.pending?.()) { this.cancel(true); return false; }
        if (!this.ready()) { this.dismiss(); return false; }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === 'Space') return this.kick();
        if (event.key === 'Escape' && (CM.completionStatus(this.view.state) || this.view.state.field(statusField))) { this.dismiss(); return true; }
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !CM.selectedCompletion(this.view.state)) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') return CM.moveCompletionSelection(event.key === 'ArrowDown')(this.view);
        if (event.key === 'Tab' || event.key === 'Enter') return CM.acceptCompletion(this.view);
        return false;
      }
      destroy() {
        this.cancel(false); this.dead = true; controllers.delete(this.view);
        this.events.forEach(([host, name]) => host.removeEventListener(name, this.dismiss));
      }
    }
    return [statusField, CM.tooltips({ parent: document.body, position: 'fixed' }),
      CM.ViewPlugin.fromClass(Controller),
      CM.autocompletion({ activateOnTyping: false, defaultKeymap: false, maxRenderedOptions: 50, icons: false, interactionDelay: 0,
        override: [() => owner?.load() || null],
        tooltipClass: () => 'note-link-completion' + (owner?.result?.hasMore ? ' note-link-completion-more' : '')
          + (owner?.result?.index && (owner.result.index.incomplete || owner.result.index.phase !== 'ready') ? ' note-link-completion-incomplete' : ''),
        addToOptions: [{ position: 90, render(completion) {
          if (completion.item?.match !== 'body') return null;
          const span = document.createElement('span'); span.className = 'note-link-completion-excerpt';
          span.textContent = ui('正文匹配：', 'Content: ') + completion.item.excerpt; return span;
        } }],
      }),
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
