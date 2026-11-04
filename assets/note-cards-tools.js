// Optional authoring UI. The source document and its history stay with the host editor.
(function () {
  'use strict';
  let active = null, serial = 0;
  const text = (zh, en) => document.documentElement.lang === 'en' ? en : zh;
  function open(options) {
    active?.close(false);
    const model = RelatumNoteCards.parse(options.source);
    if (!model.valid || !options.isCurrent()) return null;
    const dialog = document.createElement('dialog'); dialog.className = 'note-cards-tools';
    const title = document.createElement('h2'); title.id = 'note-cards-tools-' + (++serial); title.textContent = text('Cards 样式', 'Cards style');
    dialog.setAttribute('aria-labelledby', title.id);
    const form = document.createElement('form'); form.method = 'dialog';
    const fields = document.createElement('div'); fields.className = 'note-cards-tools-fields';
    const footer = document.createElement('div'); footer.className = 'note-cards-tools-actions';
    const status = document.createElement('p'); status.className = 'note-cards-tools-status'; status.setAttribute('role', 'status');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = text('取消', 'Cancel');
    const apply = document.createElement('button'); apply.type = 'submit'; apply.className = 'is-primary'; apply.textContent = text('应用', 'Apply');
    footer.append(cancel, apply); form.append(fields, status, footer); dialog.append(title);
    const portal = document.createElement('div'); portal.className = 'note-cards-tools-portal';
    dialog.append(form, portal); options.host.append(dialog);
    const choices = RelatumReviewControls.createManager(dialog, portal), drafts = new Map(), controls = new Map();
    let target = 'group', disposed = false, composing = false, pendingApply = false, busy = false;
    const targets = [['group', text('整组卡片', 'Entire group')], ...model.cards.map((card, index) => [String(index), (index + 1) + '. ' + card.title.slice(0, 48)])];
    function select(label, key, entries, value, parent, onChange) {
      const row = document.createElement('label'), name = document.createElement('span'), input = document.createElement('select');
      name.textContent = label; input.dataset.cardsField = key; input.setAttribute('aria-label', label);
      entries.forEach(([id, caption]) => input.add(new Option(caption, id))); input.value = value;
      row.append(name, input); parent.append(row); const control = choices.enhance(input);
      input.addEventListener('change', () => onChange?.(input.value));
      return { input, control };
    }
    const targetControl = select(text('作用于', 'Apply to'), 'target', targets, target, dialog, next => { save(); target = next; render(); });
    dialog.insertBefore(targetControl.input.closest('label'), form);
    function draft() {
      if (!drafts.has(target)) {
        const source = target === 'group' ? model.settings : model.cards[Number(target)];
        const keys = target === 'group' ? ['columns', 'style', 'density'] : ['style', 'color', 'icon', 'span', 'subtitle', 'badge', 'value', 'footer'];
        drafts.set(target, Object.fromEntries(keys.map(key => [key, source[key]])));
      }
      return drafts.get(target);
    }
    function save() { if (!disposed) controls.forEach((control, key) => { draft()[key] = control.input.value; }); }
    const styleNames = [text('柔和彩底', 'Soft fill'), text('简洁描边', 'Outline'), text('侧边色条', 'Side stripe'), text('顶部色带', 'Top band')];
    function render() {
      controls.forEach(control => control.control?.dispose()); controls.clear(); fields.replaceChildren();
      const value = draft(), group = target === 'group';
      function choice(label, key, entries) { controls.set(key, select(label, key, entries, value[key], fields)); }
      choice(text('样式', 'Style'), 'style', [...(group ? [] : [['', text('跟随整组', 'Inherit group')]]), ...RelatumNoteCards.styles.map((style, index) => [style, styleNames[index]])]);
      if (group) {
        choice(text('列数', 'Columns'), 'columns', [['auto', text('自动', 'Automatic')], ['1', text('单列', 'One')], ['2', text('最多双列', 'Up to two')], ['3', text('最多三列', 'Up to three')]]);
        choice(text('间距', 'Spacing'), 'density', [['comfortable', text('舒展', 'Comfortable')], ['compact', text('紧凑', 'Compact')]]);
        const hint = document.createElement('small'); hint.textContent = text('点击“应用”后生效。列数表示每行最多排列的卡片数；窄处自动减少，单张卡片自动通栏。', 'Click Apply to save changes. Columns sets the maximum number of cards per row; narrow layouts use fewer columns, and a single card fills the width.'); fields.append(hint);
      } else {
        choice(text('颜色', 'Color'), 'color', [['', text('默认', 'Default')], ...MarkdownMini.noteBlockCatalog.colors.map(color => [color.name, color.name])]);
        choice(text('图标', 'Icon'), 'icon', [['', text('无', 'None')], ...RelatumNoteCards.icons.map(icon => [icon, icon])]);
        choice(text('宽度', 'Width'), 'span', [['', text('正常列宽', 'Normal column')], ['full', text('通栏', 'Full width')]]);
        for (const [key, label] of [['subtitle', text('副标题', 'Subtitle')], ['badge', text('右上角标签', 'Badge')], ['value', text('醒目重点', 'Key value')], ['footer', text('底部说明 / 来源', 'Footer / source')]]) {
          const row = document.createElement('label'), name = document.createElement('span'), input = document.createElement('input');
          name.textContent = label; input.type = 'text'; input.value = value[key]; input.maxLength = 4096; input.dataset.cardsField = key;
          input.setAttribute('aria-label', label); row.append(name, input); fields.append(row); controls.set(key, { input });
        }
      }
    }
    function close(restore = true) {
      if (disposed) return;
      disposed = true; choices.dispose();
      listeners.forEach(([owner, event, handler]) => owner.removeEventListener(event, handler));
      dialog.close(); dialog.remove(); if (active === session) active = null;
      options.onClose?.(); if (restore && options.isCurrent() && options.anchor.isConnected) options.anchor.focus({ preventScroll: true });
    }
    const session = { close, check() { if (!options.isCurrent()) close(false); } };
    const listeners = [];
    function listen(owner, event, handler) { owner.addEventListener(event, handler); listeners.push([owner, event, handler]); }
    function lifecycle(event) {
      if (event.type === 'pagehide' || event.type === 'relatum:languagechange' || document.hidden || document.documentElement.dataset.desktopMinimized === '1'
          || !options.isCurrent()) close(false);
    }
    for (const event of ['visibilitychange', 'relatum:start-workspacechange', 'relatum:languagechange']) listen(document, event, lifecycle);
    for (const event of ['pagehide', 'canvasdesktop:visibility']) listen(window, event, lifecycle);
    cancel.addEventListener('click', () => close());
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!composing) close(); });
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (choices.handleKey(event)) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    let backdrop = false;
    dialog.addEventListener('pointerdown', event => { const rect = dialog.getBoundingClientRect(); backdrop = event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom); });
    dialog.addEventListener('pointerup', event => { if (backdrop && event.target === dialog) close(); backdrop = false; });
    dialog.addEventListener('compositionstart', () => { composing = true; });
    dialog.addEventListener('compositionend', () => { composing = false; if (pendingApply) { pendingApply = false; queueMicrotask(() => form.requestSubmit()); } });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (composing) { pendingApply = true; return; }
      if (busy || disposed) return;
      save(); busy = true; apply.disabled = true;
      try {
        await options.whenSettled();
        if (disposed || !options.isCurrent()) { close(false); return; }
        // All targets use offsets in the captured source, then commit together.
        const changes = [];
        for (const [key, values] of drafts) {
          const patch = RelatumNoteCards.patch(options.source, key === 'group' ? key : Number(key), values);
          if (!patch) throw new Error(text('请检查选项内容。', 'Check the option values.'));
          changes.push(...patch);
        }
        changes.sort((a, b) => a.from - b.from || a.to - b.to);
        const next = changes.slice().reverse().reduce((source, edit) => source.slice(0, edit.from) + edit.insert + source.slice(edit.to), options.source);
        const parsed = RelatumNoteCards.parse(next);
        if (!parsed.valid || parsed.cards.length !== model.cards.length) throw new Error(text('信息字段只支持文字和行内格式，请检查输入内容。', 'Information fields support text and inline formatting. Check your input.'));
        if (!options.onApply(changes)) throw new Error(text('内容已变化，请重新打开样式工具。', 'The document changed. Reopen the style tool.'));
        close(false);
      } catch (error) { if (!disposed) status.textContent = error.message; }
      finally { busy = false; if (!disposed) apply.disabled = false; }
    });
    render(); active = session; dialog.showModal(); targetControl.control.element.querySelector('button').focus(); return session;
  }
  window.RelatumNoteCardsTools = Object.freeze({ open });
})();
