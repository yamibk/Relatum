// Reviewed metadata only. Settings DOM and editor runtimes remain lazy.
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
      const candidate = overrides.get(base.id), item = candidate || base;
      used.add(item.trigger);
      if (candidate) result.overrides.push({ id: base.id, trigger: item.trigger, replacement: item.replacement, boundary: item.boundary, enabled: item.enabled !== false });
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
  const controls = [
    { id: 'automatic', name: ['输入时自动展开', 'Expand automatically while typing'], description: ['关闭后，用 Tab 确认片段与分式。', 'When off, confirm snippets and fractions with Tab.'] },
    { id: 'autoFraction', name: ['自动分式', 'Automatic fractions'], description: ['输入 x/，快速建立分式并进入分母。', 'Type x/ to create a fraction and enter its denominator.'] },
    { id: 'tabout', name: ['Tab 跳出括号与公式', 'Tab out of brackets and equations'], description: ['完成占位后，继续用 Tab 跳过配对括号和公式末尾。', 'After placeholders, Tab skips paired brackets and equation endings.'] },
    { id: 'matrix', name: ['矩阵与对齐快捷输入', 'Matrix and alignment shortcuts'], description: ['Tab 分列，Enter 换行，Shift+Enter 跳出环境。', 'Tab adds a cell, Enter adds a row, Shift+Enter exits the environment.'] },
    { id: 'subscripts', name: ['变量数字自动下标', 'Automatic numeric subscripts'], description: ['把 x1 展开为 x_{1}，连续数字合并到同一下标。', 'Expand x1 to x_{1}; subsequent digits extend the same subscript.'] },
  ];
  const groups = [ ['all', '全部', 'All'], ['common', '常用', 'Common'], ['greek', '希腊字母', 'Greek letters'],
    ['functions', '函数与重音', 'Functions & accents'], ['custom', '自定义', 'Custom'] ];
  const names = { sq: ['平方根', 'Square root'], '//': ['分式', 'Fraction'], sr: ['平方', 'Square'], cb: ['立方', 'Cube'], invs: ['倒数幂', 'Inverse power'],
    sum: ['求和', 'Summation'], int: ['积分', 'Integral'], rd: ['幂次', 'Power'], _: ['下标', 'Subscript'],
    sin: ['正弦', 'Sine'], cos: ['余弦', 'Cosine'], tan: ['正切', 'Tangent'], ln: ['自然对数', 'Natural logarithm'], log: ['对数', 'Logarithm'],
    exp: ['指数函数', 'Exponential'], lim: ['极限', 'Limit'], hat: ['帽符号', 'Hat accent'], bar: ['横线', 'Bar accent'], dot: ['点', 'Dot accent'],
    ddot: ['双点', 'Double dot'], tilde: ['波浪符号', 'Tilde accent'], vec: ['向量', 'Vector'] };
  function snippetInfo(item, language) {
    const base = snippets.find(other => other.id === item.id), index = language === 'en' ? 1 : 0;
    if (!base) return { name: index ? 'Custom snippet' : '自定义片段', group: 'custom' };
    const group = !names[base.id] ? 'greek' : base.kind === 'accent' || ['sin', 'cos', 'tan', 'ln', 'log', 'exp', 'lim'].includes(base.id) ? 'functions' : 'common';
    return { name: names[base.id]?.[index] || base.replacement.replace(/^\\|\$0$/g, ''), group };
  }
  registry.register({ id: 'latex-input', version: '1.1.0', displayVersion: '1.1', name: ['latex辅助输入', 'LaTeX Input Assistant'],
    description: ['用片段、分式与矩阵快捷输入加快公式书写。仅在公式内生效。', 'Write equations faster with snippets, fractions and matrix shortcuts. Active only inside equations.'],
    keywords: '数学 公式 自动展开 分式 矩阵 自定义 占位 latex math snippets fraction matrix custom tab placeholder',
    defaultEnabled: false, defaultOptions: defaults, normalizeOptions, snippets, effectiveSnippets: effective, snippetProblem: problem,
    settingsControls: controls, settingsGroups: groups, snippetInfo,
    settingsSearch(value, language) {
      const index = language === 'en' ? 1 : 0;
      return controls.map(item => ({ key: 'option:' + item.id, name: item.name[index], keywords: item.name.join(' ') + ' ' + item.description.join(' ') })).concat([
        { key: 'snippets', name: index ? 'Snippet management' : '片段管理', keywords: '自定义 添加 编辑 触发词 替换 模板 custom add edit trigger replacement template snippets' },
        { key: 'guide', name: index ? 'Usage guide' : '使用说明', keywords: '用法 帮助 快捷键 占位 usage help shortcuts placeholders' },
      ], effective(value).map(item => ({ key: 'snippet:' + item.id, name: snippetInfo(item, language).name + ' · ' + item.trigger,
        keywords: [item.trigger, item.replacement, snippetInfo(item, 'zh').name, snippetInfo(item, 'en').name].join(' ') })));
    },
    load: () => registry.loadScript('latex-input', 'note-extensions/latex-input.js'),
    createSettings(context) { return window.RelatumNoteExtensionSettings.createLatexPanel(context); },
  });
  registry.register({ id: 'file-colors', scope: 'workspace', version: '1.0.0', displayVersion: '1.0',
    name: ['文件染色', 'File Colors'], defaultEnabled: false,
    description: ['为左侧文件和文件夹的图标及行背景设置柔和配色。', 'Add soft colors to file and folder icons and row backgrounds in the left tree.'],
    keywords: '文件 文件夹 染色 颜色 配色 右键 file folder color colour palette context menu',
    load: () => registry.loadScript('file-colors', 'note-extensions/file-colors.js'),
    createSettings(context) { return window.RelatumNoteExtensionSettings.createFileColorsPanel(context); },
  });
})();
