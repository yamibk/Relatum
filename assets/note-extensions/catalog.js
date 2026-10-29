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
  const additions = [
    ['text', '\\text{$1}$0'], ['bf', '\\mathbf{$1}$0'], ['rm', '\\mathrm{$1}$0'],
    ['und', '\\underline{$1}$0', 'start', 'accent'], ['ee', 'e^{$1}$0'],
    ['par', '\\frac{\\partial ${1:y}}{\\partial ${2:x}}$0', 'start', '', true],
    ['dint', '\\int_${1:0}^{${2:1}} $3\\,d${4:x}$0'], ['prod', '\\prod_{$1}^{$2}$0'],
    ...Object.entries({ ooo: 'infty', RR: 'mathbb{R}', CC: 'mathbb{C}', ZZ: 'mathbb{Z}', NN: 'mathbb{N}', QQ: 'mathbb{Q}',
      '+-': 'pm', '-+': 'mp', '...': 'dots', xx: 'times', '**': 'cdot', '!=': 'neq', '<=': 'leq', '>=': 'geq',
      '===': 'equiv', '->': 'to', '<->': 'leftrightarrow', '!>': 'mapsto', '=>': 'implies', '=<': 'impliedby',
      inn: 'in', notin: 'not\\in', 'sub=': 'subseteq', 'sup=': 'supseteq', eset: 'emptyset' })
      .map(([trigger, command]) => [trigger, '\\' + command + '$0', /^[A-Za-z]/.test(trigger) ? 'start' : 'any', 'symbol']),
    ...Object.entries({ pmat: 'pmatrix', bmat: 'bmatrix', Bmat: 'Bmatrix', vmat: 'vmatrix', Vmat: 'Vmatrix',
      matrix: 'matrix', cases: 'cases', align: 'aligned' })
      .map(([trigger, env]) => [trigger, '\\begin{' + env + '}\n$0\n\\end{' + env + '}', 'start', 'environment']),
    ['array', '\\begin{array}{${1:cc}}\n$0\n\\end{array}', 'start', 'environment'],
    ['beg', '\\begin{${1:matrix}}\n$0\n\\end{$1}', 'start', 'environment', true],
  ].map(([trigger, replacement, boundary = 'start', kind, manual]) => Object.freeze({
    id: trigger, trigger, replacement, boundary, added: true, ...(kind ? { kind } : {}), ...(manual ? { manual } : {}),
  }));
  const allSnippets = Object.freeze(snippets.concat(additions));
  const defaults = Object.freeze({ automatic: true, autoFraction: true, tabout: true, matrix: true, subscripts: true,
    visualSnippets: true, autoEnlargeBrackets: true });
  const boundaries = ['start', 'suffix', 'any'];
  // Shared, bounded text-template parser. No regex supplied by users and no evaluation.
  function parseTemplate(template, start = 0) {
    if (typeof template !== 'string' || !template.length || template.length > 4096) return null;
    const parts = [], values = new Map();
    let cursor = 0, exits = 0;
    while (cursor < template.length) {
      const dollar = template.indexOf('$', cursor);
      if (dollar < 0) { parts.push(template.slice(cursor)); break; }
      if (dollar > cursor) parts.push(template.slice(cursor, dollar));
      let number, value, end;
      if (/^[0-9](?![0-9])/.test(template.slice(dollar + 1))) {
        number = Number(template[dollar + 1]); end = dollar + 2;
      } else {
        const opening = /^\$\{([1-9]):/.exec(template.slice(dollar));
        if (!opening) return null;
        number = Number(opening[1]);
        const from = dollar + opening[0].length;
        let depth = 1, at = from;
        for (; at < template.length; at++) {
          if (template[at] === '$') return null;
          if (template[at] === '\\') { at++; continue; }
          if (template[at] === '{') depth++;
          else if (template[at] === '}' && --depth === 0) break;
        }
        if (depth) return null;
        value = template.slice(from, at); end = at + 1;
      }
      if (number === 0 && ++exits > 1) return null;
      if (value !== undefined) {
        if (values.has(number) && values.get(number) !== value) return null;
        values.set(number, value);
      }
      parts.push({ number }); cursor = end;
    }
    let text = '', exit = null, preview = '';
    const stops = [];
    for (const part of parts) {
      if (typeof part === 'string') { text += part; preview += part; continue; }
      const from = start + text.length, value = values.get(part.number) || '';
      text += value;
      if (part.number === 0) exit = from;
      else { stops.push({ number: part.number, from, to: from + value.length, order: stops.length }); preview += value || '…'; }
    }
    stops.sort((a, b) => a.number - b.number || a.from - b.from);
    return { text, stops, exit: exit ?? start + text.length, preview };
  }
  function problem(item) {
    if (!item || typeof item.trigger !== 'string' || !item.trigger.length || item.trigger.length > 64 || /[\s\\$]/.test(item.trigger)) return 'trigger';
    if (typeof item.replacement !== 'string' || !item.replacement.length || item.replacement.length > 4096) return 'replacement';
    if (!boundaries.includes(item.boundary)) return 'boundary';
    if (!parseTemplate(item.replacement)) return 'placeholder';
    return '';
  }
  function normalizeOptions(value) {
    const result = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, typeof value?.[key] === 'boolean' ? value[key] : fallback]));
    result.overrides = []; result.custom = [];
    const used = new Set(), byId = new Map(allSnippets.map(item => [item.id, item]));
    const overrides = new Map();
    if (Array.isArray(value?.overrides)) value.overrides.slice(0, allSnippets.length).forEach(item => {
      if (byId.has(item?.id) && !problem(item)) overrides.set(item.id, item);
    });
    // Invalid stored collisions fall back together; re-check when a fallback frees a trigger.
    for (let pass = 0; pass <= snippets.length; pass++) {
      const counts = new Map();
      snippets.forEach(base => { const trigger = overrides.get(base.id)?.trigger || base.trigger; counts.set(trigger, (counts.get(trigger) || 0) + 1); });
      let removed = false;
      for (const [id, item] of overrides) if (!byId.get(id).added && counts.get(item.trigger) > 1) { overrides.delete(id); removed = true; }
      if (!removed) break;
    }
    allSnippets.forEach(base => {
      const candidate = overrides.get(base.id), item = candidate || base;
      if (!base.added) used.add(item.trigger);
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
    const entries = allSnippets.map(base => ({ ...base, ...overrides.get(base.id), enabled: overrides.get(base.id)?.enabled !== false }));
    const occupied = new Set(entries.filter(item => !item.added).concat(options.custom).map(item => item.trigger));
    // Existing user content wins over newly introduced defaults, even when disabled.
    const added = entries.filter(item => item.added).sort((a, b) => Number(overrides.has(b.id)) - Number(overrides.has(a.id)));
    added.forEach(item => { item.conflict = occupied.has(item.trigger); if (!item.conflict) occupied.add(item.trigger); });
    return entries.concat(options.custom);
  }
  const controls = [
    { id: 'automatic', name: ['输入时自动展开', 'Expand automatically while typing'], description: ['关闭后，用 Tab 确认片段与分式。', 'When off, confirm snippets and fractions with Tab.'] },
    { id: 'autoFraction', name: ['自动分式', 'Automatic fractions'], description: ['输入 x/，快速建立分式并进入分母。', 'Type x/ to create a fraction and enter its denominator.'] },
    { id: 'tabout', name: ['Tab 跳出括号与公式', 'Tab out of brackets and equations'], description: ['完成占位后，继续用 Tab 跳过配对括号和公式末尾。', 'After placeholders, Tab skips paired brackets and equation endings.'] },
    { id: 'matrix', name: ['矩阵与对齐快捷输入', 'Matrix and alignment shortcuts'], description: ['Tab 分列，Enter 换行，Shift+Enter 跳出环境。', 'Tab adds a cell, Enter adds a row, Shift+Enter exits the environment.'] },
    { id: 'subscripts', name: ['变量数字自动下标', 'Automatic numeric subscripts'], description: ['把 x1 展开为 x_{1}，连续数字合并到同一下标。', 'Expand x1 to x_{1}; subsequent digits extend the same subscript.'] },
    { id: 'visualSnippets', name: ['选区快捷包裹', 'Wrap selected math'], description: ['选中公式内容后，用 U/O/B/C/K/S 添加标注、划消或根号。', 'Select math and press U/O/B/C/K/S for annotations, cancellation or a root.'] },
    { id: 'autoEnlargeBrackets', name: ['括号自动放大', 'Enlarge enclosing brackets'], description: ['插入分式、求和或积分时，为外层数学括号补充 \\left 和 \\right。', 'Add \\left and \\right around inserted fractions, sums and integrals.'] },
  ];
  const groups = [ ['all', '全部', 'All'], ['common', '常用', 'Common'], ['greek', '希腊字母', 'Greek letters'],
    ['functions', '函数与重音', 'Functions & accents'], ['symbols', '集合与符号', 'Sets & symbols'],
    ['environments', '矩阵与环境', 'Matrices & environments'], ['custom', '自定义', 'Custom'] ];
  const names = { sq: ['平方根', 'Square root'], '//': ['分式', 'Fraction'], sr: ['平方', 'Square'], cb: ['立方', 'Cube'], invs: ['倒数幂', 'Inverse power'],
    sum: ['求和', 'Summation'], int: ['积分', 'Integral'], rd: ['幂次', 'Power'], _: ['下标', 'Subscript'],
    sin: ['正弦', 'Sine'], cos: ['余弦', 'Cosine'], tan: ['正切', 'Tangent'], ln: ['自然对数', 'Natural logarithm'], log: ['对数', 'Logarithm'],
    exp: ['指数函数', 'Exponential'], lim: ['极限', 'Limit'], hat: ['帽符号', 'Hat accent'], bar: ['横线', 'Bar accent'], dot: ['点', 'Dot accent'],
    ddot: ['双点', 'Double dot'], tilde: ['波浪符号', 'Tilde accent'], vec: ['向量', 'Vector'],
    text: ['公式内文字', 'Text in math'], bf: ['数学粗体', 'Bold math'], rm: ['直立文字', 'Roman text'],
    und: ['下划线', 'Underline'], ee: ['自然指数幂', 'Exponential power'], par: ['偏导数（Tab 确认）', 'Partial derivative (Tab)'],
    dint: ['定积分', 'Definite integral'], prod: ['连乘', 'Product'], beg: ['自定义环境（Tab 确认）', 'Custom environment (Tab)'],
    pmat: ['圆括号矩阵', 'Parenthesized matrix'], bmat: ['方括号矩阵', 'Bracketed matrix'], Bmat: ['花括号矩阵', 'Braced matrix'],
    vmat: ['行列式', 'Determinant'], Vmat: ['双竖线矩阵', 'Double-bar matrix'], matrix: ['无括号矩阵', 'Matrix'],
    cases: ['分段函数', 'Cases'], align: ['多行对齐', 'Aligned equations'], array: ['指定列格式的数组', 'Array'],
    ooo: ['无穷大', 'Infinity'], RR: ['实数集', 'Real numbers'], CC: ['复数集', 'Complex numbers'], ZZ: ['整数集', 'Integers'],
    NN: ['自然数集', 'Natural numbers'], QQ: ['有理数集', 'Rational numbers'], '+-': ['正负号', 'Plus or minus'],
    '-+': ['负正号', 'Minus or plus'], '...': ['省略号', 'Ellipsis'], xx: ['乘号', 'Multiplication'], '**': ['点乘', 'Dot product'],
    '!=': ['不等于', 'Not equal'], '<=': ['小于等于', 'Less than or equal'], '>=': ['大于等于', 'Greater than or equal'],
    '===': ['恒等于', 'Equivalent'], '->': ['趋向', 'Tends to'], '<->': ['双向箭头', 'Bidirectional arrow'],
    '!>': ['映射到', 'Maps to'], '=>': ['推出', 'Implies'], '=<': ['由此推出', 'Implied by'], inn: ['属于', 'Element of'],
    notin: ['不属于', 'Not an element of'], 'sub=': ['包含于或等于', 'Subset or equal'], 'sup=': ['包含或等于', 'Superset or equal'],
    eset: ['空集', 'Empty set'] };
  function snippetInfo(item, language) {
    const base = allSnippets.find(other => other.id === item.id), index = language === 'en' ? 1 : 0;
    if (!base) return { name: index ? 'Custom snippet' : '自定义片段', group: 'custom' };
    const group = base.kind === 'environment' ? 'environments' : base.kind === 'symbol' ? 'symbols' :
      !names[base.id] ? 'greek' : base.kind === 'accent' || ['sin', 'cos', 'tan', 'ln', 'log', 'exp', 'lim'].includes(base.id) ? 'functions' : 'common';
    return { name: names[base.id]?.[index] || base.replacement.replace(/^\\|\$0$/g, ''), group };
  }
  registry.register({ id: 'latex-input', version: '1.2.0', displayVersion: '1.2', name: ['latex辅助输入', 'LaTeX Input Assistant'],
    description: ['用片段、分式与矩阵快捷输入加快公式书写。仅在公式内生效。', 'Write equations faster with snippets, fractions and matrix shortcuts. Active only inside equations.'],
    keywords: '数学 公式 自动展开 分式 矩阵 自定义 占位 latex math snippets fraction matrix custom tab placeholder',
    defaultEnabled: false, defaultOptions: defaults, normalizeOptions, snippets: allSnippets, effectiveSnippets: effective, snippetProblem: problem, parseTemplate,
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
  const fileColorControls = Object.freeze([
    { id: 'backgroundStrength', name: ['背景浓度', 'Background strength'], max: 300,
      description: ['普通状态下行背景的颜色浓度。', 'Color strength of the normal row background.'] },
    { id: 'hoverStrength', name: ['悬停浓度', 'Hover strength'], max: 300,
      description: ['鼠标停留在项目上时的背景浓度。', 'Background strength while the pointer is over an item.'] },
    { id: 'selectedStrength', name: ['选中浓度', 'Selection strength'], max: 300,
      description: ['当前笔记或选中文件夹的背景浓度。', 'Background strength of the current note or selected folder.'] },
    { id: 'iconSaturation', name: ['图标饱和度', 'Icon saturation'], max: 200,
      description: ['调高使图标颜色更鲜明，调低则接近灰色。', 'Increase for more vivid icons, or decrease toward gray.'] },
  ].map(item => Object.freeze({ ...item, min: 0, step: 5, default: 100 })));
  const fileColorPalette = { gray: [147,151,143], blue: [94,136,189], cyan: [85,166,174], green: [120,147,108],
    yellow: [217,185,91], orange: [214,150,98], red: [200,125,120], purple: [157,130,184] };
  function normalizeFileColorOptions(value) {
    return { ...Object.fromEntries(fileColorControls.map(item => [item.id,
      typeof value?.[item.id] === 'number' && Number.isFinite(value[item.id])
        ? Math.round(Math.max(item.min, Math.min(item.max, value[item.id])) / item.step) * item.step : item.default])),
      showContextMenu: typeof value?.showContextMenu === 'boolean' ? value.showContextMenu : true };
  }
  const fileColorProperties = Object.freeze(['background-light', 'background-dark', 'hover-light', 'hover-dark', 'selected-light', 'selected-dark']
    .map(key => '--file-color-' + key).concat(Object.keys(fileColorPalette).map(key => '--file-color-icon-' + key)));
  function applyFileColorAppearance(host, value) {
    const options = normalizeFileColorOptions(value);
    const write = (key, value) => { const text = String(value); if (host.style.getPropertyValue(key) !== text) host.style.setProperty(key, text); };
    for (const [state, key, light, dark, limit] of [['background', 'backgroundStrength', .09, .14, .6],
      ['hover', 'hoverStrength', .15, .22, .65], ['selected', 'selectedStrength', .22, .3, .7]]) {
      write('--file-color-' + state + '-light', Math.min(limit, light * options[key] / 100));
      write('--file-color-' + state + '-dark', Math.min(limit, dark * options[key] / 100));
    }
    for (const [name, rgb] of Object.entries(fileColorPalette)) {
      const gray = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      write('--file-color-icon-' + name, rgb.map(value => Math.round(Math.max(0, Math.min(255,
        gray + (value - gray) * options.iconSaturation / 100)))).join(', '));
    }
  }
  registry.register({ id: 'file-colors', scope: 'workspace', version: '1.1.0', displayVersion: '1.1',
    name: ['文件染色', 'File Colors'], defaultEnabled: false,
    description: ['为左侧文件和文件夹的图标及行背景设置柔和配色。', 'Add soft colors to file and folder icons and row backgrounds in the left tree.'],
    keywords: '文件 文件夹 染色 颜色 配色 右键 浓度 饱和度 file folder color colour palette context menu strength saturation',
    defaultOptions: normalizeFileColorOptions(), normalizeOptions: normalizeFileColorOptions,
    settingsControls: fileColorControls, applyAppearance: applyFileColorAppearance, appearanceProperties: fileColorProperties,
    settingsSearch(value, language) { const index = language === 'en' ? 1 : 0;
      return fileColorControls.map(item => ({ key: 'option:' + item.id, name: item.name[index],
        keywords: item.name.join(' ') + ' ' + item.description.join(' ') })).concat([
          { key: 'clear', name: index ? 'Clear all data' : '清空所有数据', keywords: '清空 删除 全部 文件 配色 clear all delete color data' },
        ]); },
    load: () => registry.loadScript('file-colors', 'note-extensions/file-colors.js'),
    createSettings(context) { return window.RelatumNoteExtensionSettings.createFileColorsPanel(context); },
  });
})();
