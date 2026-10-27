// Reviewed metadata and settings only. No editor or math runtime is loaded here.
(function () {
  'use strict';
  const registry = window.RelatumNoteExtensions;
  // Mappings adapted from the pinned LaTeX Suite source; see LICENSE-latex-suite.txt.
  const greek = { a: 'alpha', b: 'beta', g: 'gamma', G: 'Gamma', d: 'delta', D: 'Delta', e: 'epsilon',
    z: 'zeta', t: 'theta', T: 'Theta', i: 'iota', k: 'kappa', l: 'lambda', L: 'Lambda',
    s: 'sigma', S: 'Sigma', u: 'upsilon', U: 'Upsilon', o: 'omega', O: 'Omega', p: 'pi', x: 'xi', X: 'Xi' };
  const snippets = Object.freeze([
    ['sq', '\\sqrt{$1}$0', 'start'], ['//', '\\frac{$1}{$2}$0', 'any'],
    ['invs', '^{-1}$0', 'suffix'], ['sr', '^{2}$0', 'suffix'], ['cb', '^{3}$0', 'suffix'],
    ['sum', '\\sum_{$1}^{$2}$0', 'start'], ['int', '\\int_{$1}^{$2}$0', 'start'],
    ...Object.entries(greek).map(([key, name]) => ['@' + key, '\\' + name + '$0', 'any']),
    [':e', '\\varepsilon$0', 'any'], [':t', '\\vartheta$0', 'any'],
    ['ome', '\\omega$0', 'start'], ['Ome', '\\Omega$0', 'start'],
    ...['eta', 'mu', 'nu', 'pi', 'Pi', 'rho', 'tau', 'phi', 'Phi', 'chi', 'psi', 'Psi'].map(name => [name, '\\' + name + '$0', 'start']),
    ['rd', '^{$1}$0', 'suffix'], ['_', '_{$1}$0', 'suffix'],
    ...['sin', 'cos', 'tan', 'ln', 'log', 'exp', 'lim'].map(name => [name, '\\' + name + '$0', 'start']),
    ...['hat', 'bar', 'dot', 'ddot', 'tilde', 'vec'].map(name => [name, '\\' + name + '{$1}$0', 'start', 'accent']),
  ].map(([trigger, replacement, boundary, kind]) => Object.freeze({ id: trigger, trigger, replacement, boundary, ...(kind ? { kind } : {}) })));
  const defaults = Object.freeze({ automatic: true, autoFraction: true, tabout: true, matrix: true, subscripts: true });
  const boundaries = ['start', 'suffix', 'any'];
  function problem(item) {
    if (!item || typeof item.trigger !== 'string' || !item.trigger.length || item.trigger.length > 64 || /[\s\\$]/.test(item.trigger)) return 'trigger';
    if (typeof item.replacement !== 'string' || !item.replacement.length || item.replacement.length > 4096) return 'replacement';
    if (!boundaries.includes(item.boundary)) return 'boundary';
    const used = new Set();
    for (const match of item.replacement.matchAll(/\$(\d+)|\$/g)) {
      if (!match[1] || !/^[0-9]$/.test(match[1]) || used.has(match[1])) return 'placeholder';
      used.add(match[1]);
    }
    return '';
  }
  function normalizeOptions(value) {
    const result = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, typeof value?.[key] === 'boolean' ? value[key] : fallback]));
    result.overrides = []; result.custom = [];
    const used = new Set(), byId = new Map(snippets.map(item => [item.id, item]));
    const overrides = new Map();
    if (Array.isArray(value?.overrides)) value.overrides.slice(0, snippets.length).forEach(item => {
      if (byId.has(item?.id) && !problem(item)) overrides.set(item.id, item);
    });
    // Invalid stored collisions fall back together; re-check when a fallback frees a trigger.
    for (let pass = 0; pass <= snippets.length; pass++) {
      const counts = new Map();
      snippets.forEach(base => { const trigger = overrides.get(base.id)?.trigger || base.trigger; counts.set(trigger, (counts.get(trigger) || 0) + 1); });
      let removed = false;
      for (const [id, item] of overrides) if (counts.get(item.trigger) > 1) { overrides.delete(id); removed = true; }
      if (!removed) break;
    }
    snippets.forEach(base => {
      const candidate = overrides.get(base.id);
      const item = candidate || base;
      used.add(item.trigger);
      if (candidate) result.overrides.push({ id: base.id,
        trigger: item.trigger, replacement: item.replacement, boundary: item.boundary, enabled: item.enabled !== false });
    });
    const ids = new Set();
    if (Array.isArray(value?.custom)) value.custom.slice(0, 128).forEach(item => {
      if (problem(item) || typeof item.id !== 'string' || !/^custom-[a-z0-9-]{1,80}$/.test(item.id) || ids.has(item.id) || used.has(item.trigger)) return;
      ids.add(item.id); used.add(item.trigger);
      result.custom.push({ id: item.id, trigger: item.trigger, replacement: item.replacement, boundary: item.boundary, enabled: item.enabled !== false });
    });
    return result;
  }
  function effective(value) {
    const options = normalizeOptions(value), overrides = new Map(options.overrides.map(item => [item.id, item]));
    return snippets.map(base => ({ ...base, ...overrides.get(base.id), enabled: overrides.get(base.id)?.enabled !== false })).concat(options.custom);
  }
  registry.register({ id: 'latex-input', version: '1.1.0', displayVersion: '1.1', name: ['latex辅助输入', 'LaTeX Input Assistant'],
    description: ['用片段、分式与矩阵快捷输入加快公式书写。仅在公式内生效。', 'Write equations faster with snippets, fractions and matrix shortcuts. Active only inside equations.'],
    keywords: '数学 公式 自动展开 分式 矩阵 自定义 占位 latex math snippets fraction matrix custom tab placeholder',
    defaultEnabled: false, defaultOptions: defaults, normalizeOptions, snippets, effectiveSnippets: effective, snippetProblem: problem,
    load: () => registry.loadScript('latex-input', 'note-extensions/latex-input.js'),
    createSettings({ language, read, update }) {
      const panel = document.createElement('div'); panel.className = 'note-latex-settings';
      const en = () => language() === 'en', tr = (cn, english) => en() ? english : cn;
      const node = (tag, text, parent) => { const element = document.createElement(tag); if (text) element.textContent = text; parent?.append(element); return element; };
      const controls = [];
      for (const [key, cn, english] of [['automatic', '输入时自动展开', 'Expand automatically while typing'],
        ['autoFraction', '自动分式', 'Automatic fractions'], ['tabout', 'Tab 跳出括号与公式', 'Tab out of brackets and equations'],
        ['matrix', '矩阵与对齐快捷输入', 'Matrix and alignment shortcuts'], ['subscripts', '变量数字自动下标', 'Automatic numeric subscripts']]) {
        const label = node('label', '', panel); label.className = 'note-extension-option';
        const input = node('input', '', label); input.type = 'checkbox'; input.dataset.extensionOption = key;
        const text = node('span', '', label); controls.push({ input, text, key, cn, english });
        input.addEventListener('change', () => update({ [key]: input.checked }));
      }
      const help = node('p', '', panel), builtinTitle = node('h4', '', panel), builtin = node('div', '', panel);
      const customTitle = node('h4', '', panel), custom = node('div', '', panel), add = node('button', '', panel); add.type = 'button'; add.dataset.latexAction = 'add';
      builtin.className = custom.className = 'note-latex-list';
      const form = node('form', '', panel); form.hidden = true; form.className = 'note-latex-form';
      const fields = {};
      for (const key of ['trigger', 'replacement', 'boundary']) {
        const label = node('label', '', form), text = node('span', '', label);
        const input = node(key === 'replacement' ? 'textarea' : key === 'boundary' ? 'select' : 'input', '', label);
        input.dataset.latexField = key;
        if (key === 'boundary') boundaries.forEach(value => { const option = node('option', '', input); option.value = value; });
        else input.maxLength = key === 'trigger' ? 64 : 4096;
        fields[key] = { text, input };
      }
      const error = node('p', '', form); error.setAttribute('role', 'alert');
      const actions = node('div', '', form), save = node('button', '', actions), cancel = node('button', '', actions);
      save.type = 'submit'; cancel.type = 'button'; save.dataset.latexAction = 'save'; cancel.dataset.latexAction = 'cancel';
      let editing = null, signature = '', renderedLanguage = '';
      const message = key => ({ trigger: tr('触发词须为 1–64 个非空白字符，不能包含反斜杠或 $。', 'Use 1–64 non-whitespace characters without backslashes or $.'),
        replacement: tr('替换内容须为 1–4096 个字符。', 'Use 1–4096 characters for the replacement.'),
        placeholder: tr('占位只支持 $1–$9 和 $0，每个编号只能出现一次。', 'Use $1–$9 and $0, each at most once.'),
        boundary: tr('请选择匹配方式。', 'Choose a match boundary.'), duplicate: tr('该触发词已被其他片段使用。', 'Another snippet already uses this trigger.'),
        limit: tr('最多添加 128 条自定义片段。', 'Up to 128 custom snippets are supported.'),
        storage: tr('保存失败，请重试。', 'Could not save. Please retry.') })[key] || '';
      function persist(item, remove) {
        const options = read(), key = snippets.some(base => base.id === item.id) ? 'overrides' : 'custom';
        const items = options[key].filter(other => other.id !== item.id);
        if (!remove) items.push(item);
        return update({ [key]: items });
      }
      function edit(item) {
        editing = item || { id: 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10), enabled: true };
        fields.trigger.input.value = item?.trigger || ''; fields.replacement.input.value = item?.replacement || ''; fields.boundary.input.value = item?.boundary || 'start';
        error.textContent = ''; form.hidden = false; fields.trigger.input.focus();
      }
      add.addEventListener('click', () => { edit(null); if (read().custom.length >= 128) error.textContent = message('limit'); });
      cancel.addEventListener('click', () => { editing = null; form.hidden = true; add.focus(); });
      form.addEventListener('submit', event => {
        event.preventDefault();
        const item = { id: editing.id, enabled: editing.enabled !== false, trigger: fields.trigger.input.value,
          replacement: fields.replacement.input.value, boundary: fields.boundary.input.value };
        const others = effective(read()).filter(other => other.id !== item.id);
        const issue = problem(item) || (others.some(other => other.trigger === item.trigger) ? 'duplicate' : '')
          || (!snippets.some(base => base.id === item.id) && !read().custom.some(other => other.id === item.id) && read().custom.length >= 128 ? 'limit' : '');
        if (issue) { error.textContent = message(issue); return; }
        if (persist(item)) { editing = null; form.hidden = true; add.focus(); } else error.textContent = message('storage');
      });
      function renderRows() {
        const active = document.activeElement, focusedRow = active?.closest('[data-latex-snippet]');
        const focus = focusedRow && panel.contains(focusedRow) ? { id: focusedRow.dataset.latexSnippet, action: active.dataset.latexAction } : null;
        const scroll = [builtin.scrollTop, custom.scrollTop];
        builtin.replaceChildren(); custom.replaceChildren();
        for (const item of effective(read())) {
          const builtIn = snippets.some(base => base.id === item.id), table = builtIn ? builtin : custom;
          const row = node('div', '', table); row.className = 'note-latex-row'; row.dataset.latexSnippet = item.id;
          const toggle = node('input', '', row); toggle.type = 'checkbox'; toggle.checked = item.enabled; toggle.setAttribute('aria-label', tr('启用 ', 'Enable ') + item.trigger);
          toggle.addEventListener('change', () => { if (!persist({ ...item, enabled: toggle.checked })) toggle.checked = item.enabled; });
          node('code', item.trigger, row); node('code', item.replacement, row);
          const editButton = node('button', tr('编辑', 'Edit'), row); editButton.type = 'button'; editButton.dataset.latexAction = 'edit'; editButton.addEventListener('click', () => edit(item));
          const resetButton = node('button', builtIn ? tr('恢复', 'Restore') : tr('删除', 'Delete'), row); resetButton.type = 'button'; resetButton.dataset.latexAction = builtIn ? 'restore' : 'delete';
          resetButton.addEventListener('click', () => {
            const base = snippets.find(other => other.id === item.id);
            if (base && effective(read()).some(other => other.id !== item.id && other.trigger === base.trigger)) { edit(item); error.textContent = message('duplicate'); return; }
            persist(item, true); if (editing?.id === item.id) { editing = null; form.hidden = true; }
          });
        }
        if (focus) {
          const row = Array.from(panel.querySelectorAll('[data-latex-snippet]')).find(element => element.dataset.latexSnippet === focus.id);
          const target = focus.action ? row?.querySelector('[data-latex-action="' + focus.action + '"]') : row?.querySelector('input');
          target?.focus({ preventScroll: true });
        }
        builtin.scrollTop = scroll[0]; custom.scrollTop = scroll[1];
      }
      return { panel, refresh() {
        const options = read();
        controls.forEach(control => { control.input.checked = options[control.key]; control.text.textContent = tr(control.cn, control.english); });
        help.textContent = tr('关闭自动展开后，片段与分式按 Tab 确认。Tab 优先展开，再跳占位、矩阵单元和公式边界；Shift+Tab 返回占位，Escape 结束占位。粘贴、候选输入与多光标不自动展开。',
          'With automatic expansion off, confirm snippets and fractions with Tab. Tab expands first, then navigates placeholders, matrix cells and equations. Shift+Tab goes back; Escape ends placeholders. Paste, IME and multiple cursors do not expand automatically.');
        builtinTitle.textContent = tr('内置片段', 'Built-in snippets'); customTitle.textContent = tr('自定义片段', 'Custom snippets'); add.textContent = tr('添加片段', 'Add snippet');
        fields.trigger.text.textContent = tr('触发词', 'Trigger'); fields.replacement.text.textContent = tr('替换模板（$1–$9 占位，$0 退出）', 'Replacement ($1–$9 placeholders, $0 exit)'); fields.boundary.text.textContent = tr('匹配方式', 'Match boundary');
        Array.from(fields.boundary.input.options).forEach((option, index) => { option.textContent = tr(['词首', '后缀', '任意位置'][index], ['Start', 'Suffix', 'Anywhere'][index]); });
        save.textContent = tr('保存片段', 'Save snippet'); cancel.textContent = tr('取消', 'Cancel');
        const next = JSON.stringify([options.overrides, options.custom]);
        if (next !== signature || language() !== renderedLanguage) { signature = next; renderedLanguage = language(); renderRows(); }
      } };
    },
  });
})();
