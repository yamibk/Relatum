(function () {
  'use strict';
  const model = window.RelatumReviewImportModel;
  const ui = (zh, en) => window.RelatumI18n?.language === 'en' ? en : zh;
  const PAGE = 50;
  function node(tag, attributes, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes || {})) {
      if (key === 'class') element.className = value;
      else if (key === 'text') element.textContent = value;
      else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
      else if (key in element && !key.startsWith('aria') && key !== 'list') element[key] = value;
      else element.setAttribute(key, value);
    }
    children.flat().forEach(child => { if (child != null) element.append(child); });
    return element;
  }
  const button = (text, action, primary) => node('button', { type: 'button', text, class: 'study-action' + (primary ? ' primary' : ''), onclick: action });
  function select(options, value, change, label) {
    return node('select', { 'aria-label': label, onchange: event => change(event.target.value) },
      options.map(([key, title]) => node('option', { value: String(key), text: title, selected: String(key) === String(value) })));
  }
  function field(title, input, hint) {
    return node('label', { class: 'review-import-field' }, node('span', { text: title }), input,
      hint ? node('small', { text: hint }) : null);
  }
  function issue(error) {
    const code = error?.code || error?.message;
    const messages = {
      'input-limit': ['输入超过 20 MiB，请复制较小的区域或分批导入。', 'Input exceeds 20 MiB. Copy a smaller range or import in batches.'],
      'body-limit': ['转换后的数据超过 32 MiB，请分批导入。', 'Converted data exceeds 32 MiB. Import in smaller batches.'],
      'row-limit': ['每次最多导入 10,000 行，请调整数据起始行或复制较小的区域。', 'Import up to 10,000 rows at a time. Adjust the start row or copy a smaller range.'],
      'column-limit': ['每次最多读取 256 列，请复制需要的表格区域。', 'Read up to 256 columns at a time. Copy the required range.'],
      'empty-input': ['没有可导入的数据，请检查输入与数据起始行。', 'No data to import. Check the input and first data row.'],
      'malformed-text': ['引号后的内容不符合表格格式，请检查分隔符和引号。', 'Unexpected text after a closing quote. Check the separator and quoting.'],
      'unclosed-quote': ['存在未闭合的引号，请修正后重新导入。', 'An opening quote has no closing quote. Correct the input and try again.'],
      'parse-failed': ['无法读取文件。请检查文件是否损坏或加密，也可以从表格复制需要的区域。', 'Unable to read the file. Check for corruption or encryption, or copy the required cells.'],
      'unsupported': ['请选择 XLSX、CSV 或 TSV 文件。旧版 XLS 可以另存为 XLSX，或复制表格区域。', 'Choose an XLSX, CSV, or TSV file. Save older XLS files as XLSX, or copy the cells.'],
      'encoding-failed': ['文件编码不匹配，请调整编码，或从表格复制需要的区域。', 'The file encoding does not match. Change the encoding, or copy the required cells.'],
      'worker-unavailable': ['无法启动解析，请重新打开导入窗口后重试。', 'Unable to start the parser. Reopen the import dialog and try again.'],
      'parse-paused': ['读取已暂停，请重试。', 'Reading was paused. Please retry.'],
      'invalid-rows': ['请修正错误行，或明确选择仅导入有效行。', 'Correct the invalid rows, or explicitly import only valid rows.'],
      'batch-conflict': ['批次内容已改变，请返回并重新预览。', 'The batch has changed. Go back and preview it again.'],
      'import-unavailable': ['导入暂未完成。可以重试，同一批次不会重复创建。', 'Import is not complete. Retry safely using the same batch.'],
      'unconfirmed': ['暂时无法确认导入结果。请重试，同一批次不会重复创建。', 'The import result could not be confirmed. Retry safely using the same batch.'],
    };
    return messages[code] ? ui(...messages[code]) + (error.detail ? ' (' + error.detail + ')' : '')
      : String(error?.message || ui('请求失败，请重试。', 'Request failed. Please retry.'));
  }
  function rowIssue(message) {
    if (window.RelatumI18n?.language !== 'en') return message;
    const exact = { '问题不能为空': 'Question is required', '每张卡片最多 12 个标签': 'At most 12 tags per card',
      '公式缺少缓存结果，请先在表格软件中重新计算并保存': 'Formula has no saved result. Recalculate and save the workbook first.',
      '单元格包含表格错误，请先修正': 'The cell contains a spreadsheet error. Correct it first.' };
    if (exact[message]) return exact[message];
    const match = /^(问题|答案|补充说明|卡组名称|卡组|标签)过长（最多 (\d+) 个字符）$/.exec(message);
    if (match) return ({ 问题: 'Question', 答案: 'Answer', 补充说明: 'Notes', 卡组名称: 'Deck', 卡组: 'Deck', 标签: 'Tag' })[match[1]] + ': at most ' + match[2] + ' characters';
    return message;
  }
  function create(options) {
    let state = null, session = 0;
    function live(current) { return state === current && current?.shell.isConnected; }
    function stopParser(current) {
      current.parseId++;
      current.worker?.terminate(); current.worker = null; current.parsing = false;
      const reject = current.rejectWorker; current.rejectWorker = null;
      reject?.({ code: 'parse-paused' });
    }
    function close(force) {
      const current = state;
      if (!current || (current.committing && !force)) return;
      state = null; session++;
      stopParser(current); current.request?.abort();
      clearTimeout(current.previewTimer);
      window.removeEventListener('keydown', current.keydown, true);
      document.removeEventListener('focusin', current.focusin, true);
      current.unsubscribe?.();
      current.shell.inert = true; current.shell.remove();
      if (!force && current.returnFocus?.isConnected) current.returnFocus.focus({ preventScroll: true });
    }
    function setError(current, message) {
      if (!live(current)) return;
      current.error.textContent = message || ''; current.error.hidden = !message;
    }
    function focusFirst(current) {
      const target = current.body.querySelector('textarea,input,select,button') || current.card;
      target.focus({ preventScroll: true });
    }
    function clearCheck(current) {
      current.checked = null; current.rows = null; current.page = 0;
      setError(current, '');
    }
    function go(current, step) {
      if (!live(current) || current.committing) return;
      current.step = step; current.page = 0; setError(current, '');
      render(current); focusFirst(current);
    }
    function formats(current) {
      const settings = node('details', { class: 'review-import-formats' }, node('summary', { text: ui('分隔符与编码', 'Separator and encoding') }));
      settings.append(node('div', { class: 'review-import-format-grid' },
        field(ui('分隔符', 'Separator'), select([['auto', ui('自动识别', 'Automatic')], ['\t', ui('制表符（表格复制）', 'Tab (copied cells)')], [',', ui('逗号', 'Comma')], [';', ui('分号', 'Semicolon')]], current.separator, value => { current.separator = value; }, ui('分隔符', 'Separator'))),
        field(ui('文件编码', 'File encoding'), select([['auto', ui('自动识别', 'Automatic')], ['utf-8', 'UTF-8'], ['gb18030', 'GB18030 / GBK'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE']], current.encoding, value => { current.encoding = value; }, ui('文件编码', 'File encoding')))));
      return settings;
    }
    async function parse(current, file, chosenSheet) {
      if (!live(current)) return;
      stopParser(current);
      current.file = file;
      if (current.sourceLabel) current.sourceLabel.textContent = file ? ui('已选择：', 'Selected: ') + file.name : '';
      const id = current.parseId;
      current.parsing = true; setError(current, '');
      renderFooter(current);
      current.status.textContent = ui('正在本机读取表格…', 'Reading the table locally…');
      try {
        if (file && !/\.(xlsx|csv|tsv)$/i.test(file.name)) throw { code: 'unsupported' };
        if (file && file.size > model.MAX_BYTES) throw { code: 'input-limit' };
        const bytes = file ? await file.arrayBuffer() : null;
        if (!live(current) || id !== current.parseId) return;
        const worker = new Worker('review-import-worker.js'); current.worker = worker;
        const fail = error => {
          if (!live(current) || id !== current.parseId) return;
          stopParser(current); current.status.textContent = ''; setError(current, issue(error)); renderFooter(current);
        };
        worker.onerror = () => fail({ code: 'worker-unavailable' });
        worker.onmessage = event => {
          if (!live(current) || id !== current.parseId || event.data.id !== id) return;
          if (event.data.error) { fail(event.data.error); return; }
          let config;
          try { config = model.defaults(event.data.table); }
          catch (error) { fail(error); return; }
          stopParser(current);
          current.file = file; current.table = event.data.table;
          current.config = config;
          current.config.deckName = options.defaultDeck();
          clearCheck(current); current.status.textContent = ''; go(current, 2);
        };
        worker.postMessage({ id, text: current.text, bytes, name: file?.name || '', sheet: chosenSheet || '', encoding: current.encoding, separator: current.separator }, bytes ? [bytes] : []);
      } catch (error) {
        if (!live(current) || id !== current.parseId) return;
        stopParser(current); current.status.textContent = ''; setError(current, issue(error)); renderFooter(current);
      }
    }
    function sourceView(current) {
      const textarea = node('textarea', { class: 'review-import-paste', value: current.text, spellcheck: false,
        'aria-label': ui('粘贴表格内容', 'Paste table data'), placeholder: ui('在 Excel、WPS 等表格中选中需要的区域，复制后粘贴到这里。\n\n单词\t释义\nserendipity\t意外发现美好事物的机缘', 'Select and copy cells from a spreadsheet, then paste them here.\n\nword\tmeaning\nserendipity\tan unexpected happy discovery'),
        oninput: event => { current.text = event.target.value; current.file = null; if (current.sourceLabel) current.sourceLabel.textContent = ''; } });
      const input = node('input', { type: 'file', accept: '.xlsx,.csv,.tsv', hidden: true,
        onchange: event => { const file = event.target.files[0]; event.target.value = ''; if (file) parse(current, file); } });
      current.sourceLabel = node('p', { class: 'review-import-hint', 'data-user-content': '', text: current.file ? ui('已选择：', 'Selected: ') + current.file.name : '' });
      const drop = node('div', { class: 'review-import-drop', ondragover: event => { event.preventDefault(); event.stopPropagation(); },
        ondrop: event => { event.preventDefault(); event.stopPropagation(); const files = event.dataTransfer.files;
          if (files.length > 1) setError(current, ui('请每次导入一个文件。', 'Import one file at a time.'));
          else if (files[0]) parse(current, files[0]); } }, textarea);
      current.body.append(node('p', { class: 'review-import-intro', text: ui('一行一张卡片。两列词表可以直接导入，多列内容可在下一步自由组合。', 'One row becomes one card. Import a two-column list directly, or combine more columns in the next step.') }), drop, current.sourceLabel,
        node('div', { class: 'review-import-source-actions' }, button(ui('选择文件', 'Choose file'), () => input.click()),
          button(ui('填入示例', 'Try an example'), () => { current.file = null; current.sourceLabel.textContent = ''; current.text = ui('单词\t释义\nserendipity\t意外发现美好事物的机缘\nresilient\t有韧性的；能迅速恢复的', 'word\tmeaning\nserendipity\tan unexpected happy discovery\nresilient\table to recover quickly'); textarea.value = current.text; textarea.focus(); }),
          node('small', { text: ui('也可拖入 XLSX / CSV / TSV · 最多 20 MiB', 'Or drop XLSX / CSV / TSV · up to 20 MiB') }), input), formats(current),
        node('p', { class: 'review-import-hint', text: ui('文件只在本机处理。每次最多 10,000 行、256 列；卡组和标签也可以来自表格列。', 'Files are processed locally. Up to 10,000 rows and 256 columns; decks and tags can also come from columns.') }));
    }
    function mappingField(current, key, title) {
      const setting = current.config[key], names = model.headings(current.table, current.config);
      const group = node('fieldset', { class: 'review-import-mapping', 'data-import-field': key }, node('legend', { text: title }));
      const update = () => { clearCheck(current); renderMappings(current); updateTable(current); };
      const chips = node('div', { class: 'review-import-columns' });
      setting.columns.forEach((column, index) => {
        const chip = node('span', { class: 'review-import-column', 'data-user-content': '' }, node('span', { text: model.columnName(column) + ' · ' + names[column] }));
        const move = offset => { const destination = index + offset; if (destination < 0 || destination >= setting.columns.length) return;
          [setting.columns[index], setting.columns[destination]] = [setting.columns[destination], setting.columns[index]]; update(); };
        if (index > 0) chip.append(node('button', { type: 'button', text: '←', 'aria-label': ui('向前移动', 'Move earlier'), onclick: () => move(-1) }));
        if (index < setting.columns.length - 1) chip.append(node('button', { type: 'button', text: '→', 'aria-label': ui('向后移动', 'Move later'), onclick: () => move(1) }));
        chip.append(node('button', { type: 'button', text: '×', 'aria-label': ui('移除此列', 'Remove column'), onclick: () => { setting.columns.splice(index, 1); update(); } }));
        chips.append(chip);
      });
      const available = names.map((name, index) => [index, model.columnName(index) + ' · ' + name]).filter(([index]) => !setting.columns.includes(index));
      chips.append(select([['', ui('＋ 选择列', '+ Choose column')], ...available], '', value => { if (value !== '') { setting.columns.push(Number(value)); update(); } }, title + ui('：添加列', ': add column')));
      const controls = node('div', { class: 'review-import-inline' },
        select([['\n', ui('换行分隔', 'Line breaks')], [' ', ui('空格分隔', 'Spaces')]], setting.separator, value => { setting.separator = value; clearCheck(current); updateTable(current); }, title + ui('：分隔方式', ': separator')),
        node('label', { class: 'review-import-check' }, node('input', { type: 'checkbox', checked: setting.labels, onchange: event => { setting.labels = event.target.checked; clearCheck(current); updateTable(current); } }), ui('显示列名', 'Show column names')));
      group.append(chips, controls); return group;
    }
    function renderMappings(current) {
      current.mappings.replaceChildren(mappingField(current, 'prompt', ui('问题（必填）', 'Question (required)')),
        mappingField(current, 'answer', ui('答案', 'Answer')), mappingField(current, 'notes', ui('补充说明', 'Notes')));
    }
    function mapInWorker(current) {
      stopParser(current);
      const id = current.parseId;
      return new Promise((resolve, reject) => {
        current.rejectWorker = reject;
        const worker = new Worker('review-import-worker.js'); current.worker = worker;
        const finish = (result, error) => {
          if (!live(current) || id !== current.parseId) return;
          current.rejectWorker = null; stopParser(current);
          if (error) reject(error); else resolve(result);
        };
        worker.onerror = () => finish(null, { code: 'worker-unavailable' });
        worker.onmessage = event => { if (event.data.id === id) finish(event.data.rows, event.data.error); };
        worker.postMessage({ id, action: 'map', table: current.table, config: current.config });
      });
    }
    function mappingView(current) {
      const config = current.config;
      const update = () => { clearCheck(current); renderMappings(current); updateTable(current); };
      const rowInput = (key, min, label) => node('input', { type: 'number', min, max: 10000000, value: config[key], 'aria-label': label,
        onchange: event => { const value = Number(event.target.value); if (!Number.isInteger(value) || value < min) { event.target.value = config[key]; return; }
          config[key] = value; if (key === 'headerRow' && value > 0) config.startRow = value + 1;
          if (key === 'headerRow') { clearCheck(current); render(current); } else update(); } });
      const top = node('div', { class: 'review-import-format-grid' },
        field(ui('表头所在行（0 表示无表头）', 'Header row (0 for none)'), rowInput('headerRow', 0, ui('表头所在行', 'Header row'))),
        field(ui('数据起始行', 'First data row'), rowInput('startRow', 1, ui('数据起始行', 'First data row'))));
      if (current.table.sheets.length > 1) top.prepend(field(ui('工作表', 'Worksheet'),
        select(current.table.sheets.map(sheet => [sheet.name, sheet.name + (sheet.hidden ? ui('（隐藏）', ' (hidden)') : '')]), current.table.sheet, value => parse(current, current.file, value), ui('工作表', 'Worksheet'))));
      current.mappings = node('div', { class: 'review-import-mappings' });
      const names = model.headings(current.table, config), columnOptions = [[-1, ui('不使用表格列', 'No column')], ...names.map((name, index) => [index, model.columnName(index) + ' · ' + name])];
      const organize = node('details', { class: 'review-import-organize' }, node('summary', { text: ui('卡组、标签与重复内容', 'Decks, tags, and duplicates') }));
      const commonChange = (key, value) => { config[key] = value; clearCheck(current); updateTable(current); };
      const deckInput = node('input', { type: 'text', value: config.deckName, maxLength: 80, list: 'review-import-decks', 'aria-label': ui('统一卡组', 'Default deck'),
        placeholder: ui('未分类 / 输入新卡组', 'Unfiled / enter a new deck'), oninput: event => { config.deckName = event.target.value; clearCheck(current); }, onchange: () => updateTable(current) });
      organize.append(node('div', { class: 'review-import-format-grid' },
        field(ui('统一卡组', 'Default deck'), deckInput), field(ui('卡组列', 'Deck column'), select(columnOptions, config.deckColumn, value => commonChange('deckColumn', Number(value)), ui('卡组列', 'Deck column'))),
        field(ui('公共标签（逗号分隔）', 'Common tags (comma-separated)'), node('input', { type: 'text', value: config.tags, 'aria-label': ui('公共标签', 'Common tags'),
          oninput: event => { config.tags = event.target.value; clearCheck(current); }, onchange: () => updateTable(current) })),
        field(ui('标签列', 'Tags column'), select(columnOptions, config.tagColumn, value => commonChange('tagColumn', Number(value)), ui('标签列', 'Tags column')))),
        field(ui('重复内容', 'Duplicate content'), select([['skip', ui('跳过完全相同内容（默认）', 'Skip identical content (default)')], ['keep', ui('允许重复，全部新建', 'Allow duplicates; create all')]], config.duplicateMode,
          value => commonChange('duplicateMode', value), ui('重复内容', 'Duplicate content'))),
        node('p', { class: 'review-import-hint', text: ui('非空卡组列优先，空值使用统一卡组；表格标签与公共标签合并。只有同卡组的问题、答案、说明与标签都相同才跳过，不同释义会保留。', 'Nonempty deck cells override the default. Row tags and common tags are combined. Only identical questions, answers, notes, and tags within the same deck are skipped; different meanings are kept.') }),
        node('datalist', { id: 'review-import-decks' }, options.decks().map(deck => node('option', { value: deck.name }))));
      current.body.append(top, current.mappings, organize); renderMappings(current); previewView(current); updateTable(current);
    }
    function previewView(current) {
      current.tableHost = node('div', { class: 'review-import-table-wrap', tabIndex: 0, 'aria-label': ui('数据预览', 'Data preview') });
      current.pager = node('div', { class: 'review-import-pager' });
      current.sample = node('article', { class: 'review-import-sample', 'data-user-content': '', 'aria-label': ui('最终卡片预览', 'Final card preview') });
      current.body.append(node('div', { class: 'review-import-preview-head' }, node('h3', { text: ui('数据预览', 'Data preview') }), current.pager),
        node('div', { class: 'review-import-previews' }, current.tableHost, current.sample));
    }
    function sample(current, row, index) {
      current.selected = index;
      current.sample.replaceChildren(node('small', { text: ui('最终卡片 · 源行 ', 'Final card · source row ') + row.sourceRow }), node('h4', { text: row.prompt || ui('问题为空', 'Question is empty') }));
      for (const [key, title] of [['answer', ui('答案', 'Answer')], ['notes', ui('补充说明', 'Notes')]]) {
        const content = node('div', { class: 'review-import-rich' });
        if (row[key]) options.renderRich(content, row[key]);
        else content.textContent = '—';
        current.sample.append(node('h5', { text: title }), content);
      }
      current.sample.append(node('p', { class: 'review-import-hint', text: [row.deckName || ui('未分类', 'Unfiled'), row.tags.join(', ')].filter(Boolean).join(' · ') }));
    }
    function updateTable(current) {
      if (!live(current) || !current.tableHost) return;
      let rows, total;
      try {
        total = current.rows ? current.rows.length : current.table.rows.filter(row => row.sourceRow >= Number(current.config.startRow) && row.sourceRow !== Number(current.config.headerRow)).length;
        current.page = Math.min(current.page, Math.max(0, Math.ceil(total / PAGE) - 1));
        rows = current.rows ? current.rows.slice(current.page * PAGE, (current.page + 1) * PAGE)
          : model.mapRows(current.table, current.config, { offset: current.page * PAGE, limit: PAGE });
        setError(current, '');
      }
      catch (error) { setError(current, issue(error)); current.tableHost.replaceChildren(); current.sample.replaceChildren(); return; }
      const pages = Math.max(1, Math.ceil(total / PAGE));
      current.pager.replaceChildren(button('←', () => { if (current.page > 0) { current.page--; updateTable(current); } }),
        node('span', { text: (current.page + 1) + ' / ' + pages + ' · ' + total + ui(' 行', ' rows') }),
        button('→', () => { if (current.page + 1 < pages) { current.page++; updateTable(current); } }));
      current.pager.firstChild.disabled = current.page === 0; current.pager.lastChild.disabled = current.page + 1 >= pages;
      current.pager.firstChild.setAttribute('aria-label', ui('上一页', 'Previous page')); current.pager.lastChild.setAttribute('aria-label', ui('下一页', 'Next page'));
      const table = node('table', { class: 'review-import-table', 'data-user-content': '' });
      table.append(node('thead', {}, node('tr', {}, [ui('源行', 'Row'), ui('问题', 'Question'), ui('答案', 'Answer'), ui('说明', 'Notes'), ui('检查', 'Check')].map(text => node('th', { text, scope: 'col' })))));
      const body = node('tbody');
      const statusNames = { new: ui('可导入', 'Ready'), duplicate: ui('重复', 'Duplicate'), invalid: ui('有错误', 'Invalid'), blank: ui('空行', 'Blank') };
      rows.forEach((row, offset) => {
        const index = current.page * PAGE + offset, checked = current.checked?.rows[index];
        const error = checked?.error ? rowIssue(checked.error) : row.sourceError ? ui('表格公式或单元格错误', 'Formula or cell error') : '';
        const tr = node('tr', { class: checked?.status === 'invalid' ? 'is-invalid' : '' });
        tr.append(node('td', {}, node('button', { type: 'button', text: String(row.sourceRow), 'aria-label': ui('预览源行 ', 'Preview source row ') + row.sourceRow, onclick: () => sample(current, row, index) })));
        for (const key of ['prompt', 'answer', 'notes']) tr.append(node('td', {}, node('span', { text: row[key].length > 200 ? row[key].slice(0, 200) + '…' : row[key], title: row[key].length > 500 ? row[key].slice(0, 500) + '…' : row[key] })));
        tr.append(node('td', { text: error || (checked ? statusNames[checked.status] : row.blank ? statusNames.blank : '—') })); body.append(tr);
      });
      table.append(body); current.tableHost.replaceChildren(table);
      const selected = current.selected >= current.page * PAGE && current.selected < (current.page + 1) * PAGE ? current.selected : current.page * PAGE;
      if (rows[selected - current.page * PAGE]) sample(current, rows[selected - current.page * PAGE], selected);
    }
    async function request(current, path, payload, committing) {
      const controller = new AbortController();
      if (!committing) current.request?.abort();
      if (!committing) current.request = controller;
      const timeout = setTimeout(() => controller.abort(), 45000);
      try {
        const body = JSON.stringify(payload);
        if (new TextEncoder().encode(body).length > 32 * 1024 * 1024) throw { code: 'body-limit' };
        const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(result.error), { code: result.code, rejected: response.status < 500 });
        return result;
      } finally { clearTimeout(timeout); if (current.request === controller) current.request = null; }
    }
    async function check(current) {
      if (current.checking || current.parsing) return;
      current.checking = true; setError(current, ''); renderFooter(current);
      current.status.textContent = ui('正在检查卡片与重复内容…', 'Checking cards and duplicates…');
      try {
        const rows = await mapInWorker(current);
        if (!live(current)) return;
        const result = await request(current, '/api/review-import-preview', { rows, duplicateMode: current.config.duplicateMode }, false);
        if (!live(current)) return;
        current.checked = result; current.rows = rows; go(current, 3);
      } catch (error) { if (live(current)) setError(current, issue(error)); }
      finally { current.checking = false; if (live(current)) { current.status.textContent = ''; renderFooter(current); } }
    }
    async function commit(current) {
      if (!current.checked || current.committing) return;
      current.committing = true; current.closeButton.disabled = true; setError(current, ''); renderFooter(current);
      current.status.textContent = ui('正在保存卡片，请稍候…', 'Saving cards. Please wait…');
      try {
        if (!current.commitPayload) current.commitPayload = { batchId: crypto.randomUUID?.() || 'ri_' + Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''), rows: current.rows,
          duplicateMode: current.config.duplicateMode, skipInvalid: current.checked.counts.invalid > 0 };
        const result = await request(current, '/api/review-import', current.commitPayload, true);
        current.result = result;
        try { current.hiddenNew = await options.afterImport(result); }
        catch (_) { current.refreshFailed = true; }
        if (!live(current)) return;
        current.step = 4; render(current); focusFirst(current);
      } catch (error) {
        if (error.rejected) current.commitPayload = null;
        if (live(current)) setError(current, issue(error.code ? error : { code: 'unconfirmed' }));
      } finally {
        current.committing = false;
        if (live(current)) { current.closeButton.disabled = false; current.status.textContent = ''; renderFooter(current); }
      }
    }
    function confirmView(current) {
      const counts = current.checked.counts;
      const totals = [[counts.new, ui('将新增', 'New')], [counts.duplicate, ui('重复跳过', 'Duplicates')], [counts.invalid, ui('错误行', 'Invalid')], [counts.blank, ui('空行跳过', 'Blank')]];
      current.body.append(node('div', { class: 'review-import-counts' }, totals.map(([count, title]) => node('div', {}, node('strong', { text: String(count) }), node('span', { text: title })))),
        node('p', { class: 'review-import-intro', text: counts.invalid ? ui('错误行不会导入。请查看下表中的行号和原因，可返回修改，或明确选择只导入有效卡片。', 'Invalid rows will be excluded. Review their row numbers and reasons below, then go back to correct them or explicitly import valid cards only.') : ui('确认后，这些卡片将作为新卡片保存，并从今天开始进入复习。', 'These cards will be saved as new cards and become due today.') }));
      previewView(current); updateTable(current);
    }
    function completeView(current) {
      const result = current.result;
      current.body.append(node('div', { class: 'review-import-complete' }, node('span', { class: 'review-import-complete-mark', text: '✓', 'aria-hidden': 'true' }),
        node('h3', { text: ui('已导入 ', 'Imported ') + result.created + ui(' 张卡片', ' cards') }),
        node('p', { text: ui('重复跳过 ', 'Duplicates skipped: ') + result.duplicates + ' · ' + ui('错误行 ', 'Invalid rows: ') + result.invalid + ' · ' + ui('空行 ', 'Blank rows: ') + result.blank }),
        current.hiddenNew ? node('p', { text: ui('部分新卡片被当前搜索或筛选隐藏，可以清除筛选后查看。', 'Some new cards are hidden by the current search or filters. Clear them to see the cards.') }) : null,
        current.refreshFailed ? node('p', { text: ui('卡片已保存，列表刷新失败；重新进入卡片库即可查看。', 'Cards were saved. Reopen the library to refresh the list.') }) : null));
    }
    function renderFooter(current) {
      if (!live(current)) return;
      current.footer.replaceChildren();
      const busy = current.parsing || current.checking || current.committing;
      current.body.inert = busy;
      if (current.step > 1 && current.step < 4) {
        const back = button(ui('上一步', 'Back'), () => go(current, current.step - 1));
        back.disabled = busy || !!current.commitPayload; current.footer.append(back);
      }
      current.footer.append(node('span', { class: 'study-action-spacer' }));
      if (current.step === 4) {
        if (current.hiddenNew) current.footer.append(button(ui('清除筛选并查看', 'Clear filters and view'), () => { options.clearFilters(); close(); }));
        current.footer.append(button(ui('返回卡片库', 'Back to library'), () => close(), true));
      } else {
        const text = current.step === 1 ? ui('下一步', 'Next') : current.step === 2 ? ui('检查并继续', 'Check and continue')
          : current.commitPayload ? ui('重试本次导入', 'Retry this batch') : current.checked.counts.invalid ? ui('仅导入有效的 ', 'Import only valid cards: ') + current.checked.counts.new + ui(' 张', '')
          : ui('确认导入 ', 'Import ') + current.checked.counts.new + ui(' 张', ' cards');
        const next = button(text, () => current.step === 1 ? parse(current, current.file) : current.step === 2 ? check(current) : commit(current), true);
        next.dataset.importNext = ''; next.disabled = busy || (current.step === 3 && !current.checked.counts.new);
        current.footer.append(next);
      }
      current.card.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    function render(current) {
      if (!live(current)) return;
      current.title.textContent = ui('批量导入复习卡片', 'Import review cards');
      current.steps.replaceChildren(...[ui('放入数据', 'Add data'), ui('设置与预览', 'Map and preview'), ui('确认导入', 'Confirm import')].map((text, index) =>
        node('span', { class: (current.step === index + 1 || (current.step === 4 && index === 2)) ? 'is-current' : '', text: (index + 1) + '  ' + text })));
      current.body.replaceChildren(); current.tableHost = null; current.sample = null; current.pager = null;
      if (current.step === 1) sourceView(current);
      else if (current.step === 2) mappingView(current);
      else if (current.step === 3) confirmView(current);
      else completeView(current);
      renderFooter(current);
    }
    function open(returnFocus) {
      if (state) { state.card.focus(); return; }
      const current = { step: 1, page: 0, selected: 0, text: '', file: null, table: null, checked: null, rows: null,
        parseId: 0, worker: null, separator: 'auto', encoding: 'auto', returnFocus: returnFocus || document.activeElement, token: ++session };
      current.shell = node('div', { class: 'study-dialog review-import-dialog show', 'data-i18n-managed': '' });
      current.card = node('section', { class: 'study-dialog-card review-import-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'review-import-title', tabIndex: -1 });
      current.title = node('h2', { id: 'review-import-title' });
      current.closeButton = node('button', { class: 'study-icon-button', type: 'button', text: '×', 'aria-label': ui('关闭', 'Close'), onclick: () => close() });
      current.steps = node('div', { class: 'review-import-steps', 'aria-label': ui('导入步骤', 'Import steps') });
      current.body = node('div', { class: 'review-import-body' });
      current.error = node('p', { class: 'review-import-error', role: 'alert', hidden: true });
      current.status = node('p', { class: 'review-import-status', role: 'status', 'aria-live': 'polite' });
      current.footer = node('footer', { class: 'study-dialog-actions' });
      current.card.append(node('header', { class: 'study-dialog-head' }, node('div', {}, node('p', { class: 'study-eyebrow', text: 'IMPORT CARDS' }), current.title), current.closeButton),
        current.steps, current.body, current.error, current.status, current.footer);
      current.shell.append(node('div', { class: 'study-dialog-backdrop', onclick: () => close() }), current.card);
      state = current; document.body.append(current.shell);
      current.keydown = event => {
        if (!live(current)) return;
        event.stopImmediatePropagation();
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); close(); return; }
        if (event.key === 'Tab') {
          const controls = Array.from(current.card.querySelectorAll('button,input,textarea,select,[tabindex="0"]')).filter(element => !element.disabled && !element.hidden && element.getClientRects().length);
          const first = controls[0], last = controls[controls.length - 1];
          if (!first) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === current.card)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === current.card)) { event.preventDefault(); first.focus(); }
        }
      };
      current.focusin = event => { if (live(current) && !current.card.contains(event.target)) current.card.focus({ preventScroll: true }); };
      window.addEventListener('keydown', current.keydown, true);
      document.addEventListener('focusin', current.focusin, true);
      current.unsubscribe = window.RelatumI18n?.onChange(() => { if (live(current)) render(current); });
      render(current); focusFirst(current);
    }
    const leave = () => { if (state) close(true); };
    document.addEventListener('start:viewchange', event => { if (event.detail?.current !== 'review') leave(); });
    window.addEventListener('pagehide', leave);
    const visibility = () => {
      if (state && (document.hidden || document.documentElement.dataset.desktopMinimized === '1')) {
        const current = state;
        if (current.parsing || current.worker) { stopParser(current); current.status.textContent = ''; setError(current, ui('读取已暂停，请重试。', 'Reading was paused. Please retry.')); renderFooter(current); }
        if (current.checking) current.request?.abort();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('canvasdesktop:visibility', visibility);
    return { open, close: () => close(true), get isOpen() { return !!state; } };
  }
  window.RelatumReviewImport = { create };
})();
