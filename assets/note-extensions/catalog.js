// Add a reviewed built-in extension here; its runtime remains lazy.
(function () {
  'use strict';
  const registry = window.RelatumNoteExtensions;
  // Familiar trigger mappings adapted from LaTeX Suite's README; see the adjacent license.
  const snippets = Object.freeze([
    ['sq', '\\sqrt{$1}$0', 'start'], ['//', '\\frac{$1}{$2}$0', 'any'],
    ['invs', '^{-1}$0', 'suffix'], ['sr', '^{2}$0', 'suffix'], ['cb', '^{3}$0', 'suffix'],
    ['sum', '\\sum_{$1}^{$2}$0', 'start'], ['int', '\\int_{$1}^{$2}$0', 'start'],
    ...Object.entries({ a: 'alpha', b: 'beta', g: 'gamma', d: 'delta', t: 'theta', l: 'lambda', p: 'pi', s: 'sigma', o: 'omega' })
      .map(([key, name]) => ['@' + key, '\\' + name + '$0', 'any']),
  ].map(([trigger, replacement, boundary]) => Object.freeze({ trigger, replacement, boundary })));
  registry.register({ id: 'latex-input', version: '1.0.0', name: ['公式输入助手', 'Math input assistant'],
    description: ['用常用片段与占位跳转加快公式输入。仅在公式内生效。', 'Write math faster with snippets and tabstops. Active only inside equations.'],
    keywords: '数学 公式 自动展开 自动 展开 占位 latex math automatic expansion snippets tab shift placeholder',
    defaultEnabled: false, defaultOptions: Object.freeze({ automatic: true }), snippets,
    load: () => registry.loadScript('latex-input', 'note-extensions/latex-input.js'),
    createSettings({ language, read, update }) {
      const panel = document.createElement('div');
      const label = document.createElement('label'); label.className = 'note-extension-option';
      const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.extensionOption = 'automatic';
      const name = document.createElement('span'); label.append(input, name);
      input.addEventListener('change', () => update({ automatic: input.checked }));
      const help = document.createElement('p'), table = document.createElement('table'), body = document.createElement('tbody');
      table.append(body);
      snippets.forEach(snippet => {
        const row = document.createElement('tr'), trigger = document.createElement('td'), result = document.createElement('td');
        const key = document.createElement('code'), value = document.createElement('code');
        key.textContent = snippet.trigger; value.textContent = snippet.replacement.replace(/\$[1-9]/g, '…').replace(/\$0/g, '');
        trigger.append(key); result.append(value); row.append(trigger, result); body.append(row);
      });
      panel.append(label, help, table);
      return { panel, refresh() {
        const english = language() === 'en'; input.checked = read().automatic;
        name.textContent = english ? 'Expand automatically while typing' : '输入时自动展开';
        help.textContent = english
          ? 'When disabled, type a trigger and press Tab. Tab / Shift+Tab move between placeholders; Escape exits. Example: xsr → x^{2}. Paste, IME composition and multiple cursors do not expand automatically.'
          : '关闭后，输入触发词并按 Tab 展开。Tab / Shift+Tab 切换占位，Escape 退出。例如 xsr → x^{2}。粘贴、输入法候选与多光标不自动展开。';
      } };
    },
  });
})();
