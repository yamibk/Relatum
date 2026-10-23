// Note-only chat. No note/editor context is read by this module.
(function () {
  'use strict';
  const ROOT = '/api/note-ai/';
  const uid = () => crypto.randomUUID();
  function create(options) {
    const { host, settingsHost } = options;
    host.dataset.i18nManaged = 'true';
    let config = null, configLoader = null, initialized = false, visible = false, sequence = 0;
    let session = null, presetId = 'none', messages = [], history = [], historyMore = false, moreMessages = false, historyOffset = 0, historySequence = 0;
    let selectionChain = Promise.resolve(), pageHiding = false, renameSequence = 0;
    let running = null, paint = 0, settingsActive = false, settingsBuilt = false, settingsSequence = 0;
    let pending = {}, saveTimer = 0, saveChain = Promise.resolve(), testRequest = null, configRevision = 0, keyRevealSequence = 0;
    let keyDraft = null, keyOriginal = null, keyDirty = false;
    let presetEditing = 'none', presetTimer = 0, clearKeyArmed = false;
    const rows = new Map(); let languageRevision = 0;
    const english = () => options.language() === 'en';
    const tr = (zh, en) => english() ? en : zh;
    const presetName = item => item.id === 'none' ? tr('无预设', 'No preset') : item.id === 'dictionary' ? tr('查词', 'Dictionary') : item.name;
    const textError = code => ({
      'config-required': tr('请先在 AI 设置中填写模型名称和 API Key。', 'Enter a model and API key in AI settings first.'),
      'http-401': tr('API Key 无效或未授权。', 'The API key is invalid or unauthorized.'),
      'http-402': tr('API 账户余额不足。', 'The API account has insufficient credit.'),
      'http-429': tr('服务限流，请稍后重试。', 'Rate limited. Please retry later.'),
      'http-400': tr('请求参数不被模型接受，请检查设置。', 'The model rejected the request parameters. Check settings.'),
      'http-422': tr('模型名称或参数无效，请检查设置。', 'Check the model name and request parameters.'),
      timeout: tr('请求超时，可调整超时或输出上限后重试。', 'Request timed out. Adjust the timeout or output limit and retry.'),
      interrupted: tr('已停止', 'Stopped'), busy: tr('上一请求正在收尾，请稍后重试。', 'The previous request is finishing. Please retry shortly.'),
      duplicate: tr('此请求已处理，请重新打开会话。', 'This request was already processed. Reopen the conversation.'),
      'not-found': tr('会话不存在。', 'Conversation not found.'),
      network: tr('连接失败，请检查网络与接口地址。', 'Connection failed. Check your network and API address.'),
      storage: tr('本机数据暂不可用，请重试。', 'Local storage is unavailable. Please retry.'),
      incomplete: tr('连接结束时没有完整回答，可重试。', 'The connection ended without a complete answer. You can retry.'),
      'context-limit': tr('上下文过长，请新建对话。', 'The context is too large. Start a new conversation.'),
      'response-limit': tr('回复达到本机接收上限，已停止。', 'The reply reached the local response limit.'),
      'preset-missing': tr('预设已不存在，请重新选择。', 'This preset no longer exists. Choose another one.'),
    })[code] || (/^http-5/.test(code || '') ? tr('AI 服务暂时繁忙，请稍后重试。', 'The AI service is busy. Please retry later.') : tr('请求失败，请检查设置后重试。', 'Request failed. Check settings and retry.'));
    async function api(path, body, extra = {}) {
      const serialized = body === undefined ? null : JSON.stringify(body);
      const response = await fetch(ROOT + path, { ...(pageHiding && serialized?.length < 15000 ? { keepalive: true } : {}), ...extra, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: serialized }) });
      const result = await response.json();
      if (!response.ok) { const error = new Error(textError(result.code)); error.code = result.code; throw error; }
      return result;
    }
    function button(label, action, glyph = label) {
      const element = document.createElement('button'); element.type = 'button'; element.textContent = glyph; element.setAttribute('aria-label', label); element.title = label;
      element.addEventListener('click', action); return element;
    }
    function select(label) { const element = document.createElement('select'); element.setAttribute('aria-label', label); return element; }
    function setOptions(element, items, value) {
      const old = Array.from(element.options), next = items.map(item => {
        const node = old.find(option => option.value === item.value) || document.createElement('option');
        node.value = item.value; if (node.textContent !== item.name) node.textContent = item.name; return node;
      });
      if (old.length !== next.length || old.some((item, index) => item !== next[index])) element.replaceChildren(...next);
      element.value = value;
    }
    const top = document.createElement('div'); top.className = 'note-ai-top';
    const presets = select('Preset'), chats = select('Conversation'); presets.dataset.aiPreset = ''; chats.dataset.aiHistory = '';
    const plus = button('', () => {
      newConversation(presetId);
      input.focus({ preventScroll: true }); notice.textContent = tr('已开启新对话', 'New conversation started');
    }); plus.dataset.aiNew = '';
    const gear = button('', event => options.openSettings(event.currentTarget));
    gear.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#note-icon-settings"/></svg>';
    const historyLine = document.createElement('div'); historyLine.className = 'note-ai-history';
    const rename = button('', () => { if (!session?.saved) return; renameBox.hidden = !renameBox.hidden; if (!renameBox.hidden) { renameInput.value = session.title; renameInput.focus(); renameInput.select(); } }, '✎');
    const remove = button('', () => { if (session?.saved) { deleteBox.hidden = !deleteBox.hidden; } }, '×'); remove.dataset.aiDelete = '';
    const historyNext = button('', async () => { try { await refreshHistory(true); } catch (error) { notice.textContent = error.message; } }, '…'); historyNext.hidden = true;
    const renameBox = document.createElement('form'); renameBox.className = 'note-ai-inline'; renameBox.hidden = true;
    const renameInput = document.createElement('input'); renameInput.maxLength = 120; renameInput.required = true; renameInput.dataset.aiRename = '';
    const renameSave = document.createElement('button'); renameSave.type = 'submit';
    renameBox.append(renameInput, renameSave);
    renameBox.addEventListener('submit', async event => { event.preventDefault(); const id = session?.id, title = renameInput.value.trim(), current = ++renameSequence; if (!id || !title) return; try { await api('session', { action: 'rename', id, title }); if (session?.id === id && current === renameSequence) { session.title = title; renameBox.hidden = true; } await refreshHistory(); } catch (error) { if (session?.id === id && current === renameSequence) notice.textContent = error.message; } });
    const deleteBox = document.createElement('div'); deleteBox.className = 'note-ai-inline'; deleteBox.hidden = true;
    const deleteCopy = document.createElement('span'), deleteYes = button('', async () => {
      const id = session?.id, current = sequence; if (!id) return;
      deleteYes.disabled = true;
      stop();
      try { await api('session', { action: 'delete', id }); if (session?.id === id && sequence === current) newConversation(presetId); await refreshHistory(); } catch (error) { if (sequence === current) notice.textContent = error.message; }
      finally { deleteYes.disabled = false; }
    }), deleteNo = button('', () => { deleteBox.hidden = true; });
    deleteYes.dataset.aiConfirmDelete = '';
    deleteBox.append(deleteCopy, deleteNo, deleteYes);
    top.append(presets, gear); historyLine.append(chats, plus, historyNext, rename, remove);
    const timeline = document.createElement('div'); timeline.className = 'note-ai-timeline'; timeline.dataset.aiTimeline = ''; timeline.setAttribute('role', 'log'); timeline.setAttribute('aria-live', 'off');
    const older = button('', loadOlder); older.className = 'note-ai-older'; older.hidden = true;
    const body = document.createElement('div'); body.className = 'note-ai-messages';
    const empty = document.createElement('div'); empty.className = 'note-ai-empty';
    const emptyTitle = document.createElement('h3'), emptyText = document.createElement('p'), setup = button('', event => options.openSettings(event.currentTarget));
    empty.append(emptyTitle, emptyText, setup); timeline.append(older, body, empty);
    const notice = document.createElement('p'); notice.className = 'note-ai-notice'; notice.setAttribute('role', 'status');
    const composer = document.createElement('form'); composer.className = 'note-ai-composer';
    const input = document.createElement('textarea'); input.rows = 3; input.maxLength = 262144; input.dataset.aiInput = '';
    const send = document.createElement('button'); send.type = 'submit'; send.dataset.aiSend = '';
    const hint = document.createElement('small');
    composer.append(input, send, hint); host.append(top, historyLine, renameBox, deleteBox, timeline, notice, composer);
    input.disabled = send.disabled = presets.disabled = chats.disabled = plus.disabled = true;
    host.addEventListener('click', event => {
      event.stopPropagation();
      const link = event.target.closest('a');
      if (link) { const url = link.getAttribute('href') || ''; if (!/^(https?:|mailto:)/i.test(url)) event.preventDefault(); else { link.target = '_blank'; link.rel = 'noopener noreferrer'; } }
    });
    host.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) { renameBox.hidden = true; deleteBox.hidden = true; } });
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; }); input.addEventListener('compositionend', () => { composing = false; });
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !composing) { event.preventDefault(); if (!running) submit(); } });
    composer.addEventListener('submit', event => { event.preventDefault(); if (running) stop(); else if (!composing) submit(); });
    presets.addEventListener('change', () => newConversation(presets.value));
    chats.addEventListener('change', () => { if (!chats.value) newConversation(presetId); else openSession(chats.value); });

    function loadConfig(refresh = false) {
      if (config && !refresh) return Promise.resolve(config);
      if (!configLoader) configLoader = api('config').then(value => { config = value; updateSelectors(); return config; }).finally(() => { configLoader = null; });
      return configLoader;
    }
    function updateSelectors() {
      if (!config) return;
      const items = config.presets.map(item => ({ value: item.id, name: presetName(item) }));
      // A historical session keeps its prompt even if its original preset was removed.
      if (session?.saved && !items.some(item => item.value === presetId)) items.push({ value: presetId, name: session.preset_name });
      setOptions(presets, items, presetId);
      const chatItems = history.slice(); if (session?.saved && !chatItems.some(item => item.id === session.id)) chatItems.push(session);
      setOptions(chats, [{ value: '', name: tr('新对话', 'New conversation') }, ...chatItems.map(item => ({ value: item.id, name: item.title }))], session?.saved ? session.id : '');
      historyNext.hidden = !historyMore; rename.disabled = remove.disabled = !session?.saved;
      setup.hidden = !!(config.hasKey && config.model);
    }
    async function refreshHistory(append = false) {
      const current = ++historySequence;
      const result = await api('sessions?offset=' + (append ? historyOffset : 0));
      if (current !== historySequence) return result;
      if (append) { const seen = new Set(history.map(item => item.id)); history.push(...result.items.filter(item => !seen.has(item.id))); }
      else history = result.items;
      historyOffset = (append ? historyOffset : 0) + result.items.length;
      historyMore = result.more; updateSelectors(); return result;
    }
    function selectSession(id) { selectionChain = selectionChain.catch(() => {}).then(() => api('session', { action: 'select', id })); return selectionChain; }
    function newConversation(id = 'none', persist = true) {
      stop(); sequence++;
      session = { id: uid(), saved: false }; presetId = config?.presets.some(item => item.id === id) ? id : 'none';
      messages = []; moreMessages = false; renameBox.hidden = deleteBox.hidden = true; notice.textContent = ''; input.value = '';
      updateSelectors(); renderMessages();
      if (persist) selectSession(null).catch(error => { if (visible) notice.textContent = error.message; });
    }
    async function openSession(id, persist = true) {
      stop(); const current = ++sequence;
      try {
        const result = await api('messages?id=' + encodeURIComponent(id));
        if (current !== sequence || !visible) return;
        session = { ...result.session, saved: true }; presetId = session.preset_id;
        messages = result.messages; moreMessages = result.more;
        renameBox.hidden = deleteBox.hidden = true; notice.textContent = ''; input.value = '';
        updateSelectors(); renderMessages(); timeline.scrollTop = timeline.scrollHeight;
        if (persist) await selectSession(id);
      } catch (error) { if (current === sequence && visible) { notice.textContent = error.message; if (error.code === 'not-found') newConversation('none', false); } }
    }
    async function loadOlder() {
      if (!session?.saved || !messages[0]?.id) return;
      const id = session.id, current = sequence, height = timeline.scrollHeight, scroll = timeline.scrollTop;
      older.disabled = true;
      try {
        const result = await api('messages?id=' + encodeURIComponent(id) + '&before=' + messages[0].id);
        if (current !== sequence || !visible || session?.id !== id) return;
        messages = [...result.messages, ...messages]; moreMessages = result.more; renderMessages(); timeline.scrollTop = scroll + timeline.scrollHeight - height;
      } catch (error) { if (current === sequence && visible) notice.textContent = error.message; }
      finally { older.disabled = false; }
    }
    function messageRow(message) {
      const row = document.createElement('article'); row.className = 'note-ai-message'; row.dataset.aiRole = message.role;
      const label = document.createElement('strong'), thinking = document.createElement('details'), summary = document.createElement('summary'), reason = document.createElement('pre');
      thinking.className = 'note-ai-thinking'; thinking.append(summary, reason);
      const content = document.createElement('div'); content.className = 'note-ai-answer node-text';
      const foot = document.createElement('div'); foot.className = 'note-ai-message-foot';
      const copy = button('', () => navigator.clipboard.writeText(row._message.content || '').then(() => options.notify(tr('已复制', 'Copied'))).catch(() => options.notify(tr('复制失败', 'Copy failed'), 'error')), '⧉');
      copy.dataset.aiCopy = '';
      const retry = button('', () => submit(row._message), '↻'); retry.dataset.aiRetry = '';
      const status = document.createElement('span'); foot.append(status, copy, retry); row.append(label, thinking, content, foot);
      row._parts = { label, thinking, summary, reason, content, status, copy, retry }; return row;
    }
    function renderMessages() {
      const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 70;
      const keys = new Set();
      messages.forEach((message, index) => {
        const key = message.request_id + ':' + message.role; keys.add(key);
        let row = rows.get(key);
        if (!row) { row = messageRow(message); rows.set(key, row); }
        if (body.children[index] !== row) body.insertBefore(row, body.children[index] || null);
        row._message = message; const part = row._parts;
        const values = [message.content, message.reasoning, message.status, message.error, message.usage, message.elapsed, message.context_count, message.finish_reason, index === messages.length - 1, !!running, languageRevision];
        if (row._values?.every((value, position) => value === values[position])) return;
        row._values = values;
        part.label.textContent = message.role === 'user' ? tr('你', 'You') : 'AI';
        part.summary.textContent = tr('思考过程', 'Reasoning'); part.thinking.hidden = !message.reasoning;
        if (part.reason.textContent !== (message.reasoning || '')) part.reason.textContent = message.reasoning || '';
        const formatted = message.role === 'assistant' && message.status !== 'pending';
        if (row._source !== message.content || row._formatted !== formatted) {
          row._source = message.content; row._formatted = formatted;
          if (formatted && window.MarkdownMini) {
            const template = document.createElement('template');
            template.innerHTML = window.MarkdownMini.render(message.content || '', { mermaid: false, localImages: true });
            // Model output does not initiate resource requests or note operations.
            template.content.querySelectorAll('img').forEach(image => image.replaceWith(document.createTextNode(image.alt || '')));
            part.content.replaceChildren(template.content);
          } else part.content.textContent = message.content || (message.status === 'pending' ? tr('正在生成…', 'Generating…') : '');
          part.content.classList.toggle('is-streaming', !formatted);
        }
        const bits = [];
        if (message.status === 'failed' || message.status === 'interrupted') bits.push(textError(message.error || message.status));
        if (message.finish_reason === 'length') bits.push(tr('已达到输出上限', 'Output limit reached'));
        if (message.role === 'assistant') {
          if (message.context_count != null) bits.push(tr('上下文 ', 'Context: ') + message.context_count + tr(' 轮', ' turns'));
          if (message.usage) bits.push(`${message.usage.prompt_tokens ?? '—'} / ${message.usage.completion_tokens ?? '—'} tokens`);
          if (message.elapsed) bits.push(message.elapsed.toFixed(1) + 's');
        }
        part.status.textContent = bits.join(' · ');
        part.copy.setAttribute('aria-label', tr('复制原文', 'Copy original')); part.copy.title = tr('复制原文', 'Copy original');
        part.copy.hidden = !message.content;
        part.retry.setAttribute('aria-label', tr('重试', 'Retry')); part.retry.title = tr('重试', 'Retry');
        part.retry.hidden = !(index === messages.length - 1 && message.role === 'assistant' && ['failed', 'interrupted'].includes(message.status) && !running);
      });
      rows.forEach((row, key) => { if (!keys.has(key)) { row.remove(); rows.delete(key); } });
      empty.hidden = !!messages.length; older.hidden = !moreMessages;
      send.textContent = running ? '■' : '↑'; send.setAttribute('aria-label', running ? tr('停止', 'Stop') : tr('发送', 'Send'));
      if (atBottom) timeline.scrollTop = timeline.scrollHeight;
    }
    function schedulePaint() { if (visible && !paint) paint = requestAnimationFrame(() => { paint = 0; if (visible) renderMessages(); }); }
    function stop(keepalive = false) {
      const operation = running;
      if (!operation) return;
      operation.stopped = true; operation.controller.abort();
      api('cancel', { requestId: operation.id }, { keepalive }).catch(() => {});
      operation.answer.status = 'interrupted'; operation.answer.error = 'interrupted';
      running = null; if (visible) { renderMessages(); refreshHistory().catch(error => { if (visible) notice.textContent = error.message; }); }
    }
    async function submit(retry = null) {
      if (running || !visible || !options.isVisible()) return;
      const text = retry ? messages.find(item => item.request_id === retry.request_id && item.role === 'user')?.content : input.value.trim();
      if (!text) return;
      const intent = sequence;
      try { await flushSettings(); await selectionChain; await loadConfig(); } catch (error) { notice.textContent = error.message; return; }
      if (running || intent !== sequence || !visible || !options.isVisible()) return;
      if (!config.hasKey || !config.model) { notice.textContent = textError('config-required'); return; }
      if (!session) newConversation(presetId, false);
      const original = messages.slice();
      if (retry) messages = messages.filter(item => item.request_id !== retry.request_id);
      const id = uid(), current = sequence, sessionId = session.id;
      const answer = { request_id: id, role: 'assistant', content: '', reasoning: '', status: 'pending', context_count: null };
      messages.push({ request_id: id, role: 'user', content: text, status: 'complete' }, answer);
      const operation = { id, answer, controller: new AbortController(), stopped: false, meta: false };
      running = operation; notice.textContent = ''; input.value = ''; renderMessages(); timeline.scrollTop = timeline.scrollHeight;
      const isCurrent = () => sequence === current && session?.id === sessionId && running === operation && visible && options.isVisible();
      try {
        const response = await fetch(ROOT + 'chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: operation.controller.signal,
          body: JSON.stringify({ sessionId, requestId: id, text, presetId, newSession: !session.saved, ...(retry ? { retryOf: retry.request_id } : {}) }) });
        if (!response.ok) { const result = await response.json(); const error = new Error(textError(result.code)); error.code = result.code; throw error; }
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', doneEvent = false;
        while (true) {
          const chunk = await reader.read(); buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (!isCurrent()) continue;
            const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const event = JSON.parse(data);
            if (event.type === 'meta') { operation.meta = true; session = { ...event.session, saved: true }; answer.context_count = event.contextCount; answer.model = event.model; updateSelectors(); }
            else if (event.type === 'delta') answer.content += event.text;
            else if (event.type === 'reasoning') answer.reasoning += event.text;
            else if (event.type === 'usage') answer.usage = event.usage;
            else if (event.type === 'error') { answer.error = event.code; answer.status = event.code === 'interrupted' ? 'interrupted' : 'failed'; }
            else if (event.type === 'done') { doneEvent = true; answer.status = event.status; answer.elapsed = event.elapsed; answer.finish_reason = event.finishReason; answer.usage = event.usage || answer.usage; }
            schedulePaint();
          }
          if (chunk.done) break;
        }
        if (isCurrent() && !doneEvent) { answer.status = 'failed'; answer.error = 'incomplete'; }
      } catch (error) {
        if (isCurrent()) {
          if (!operation.meta && error.name !== 'AbortError') { messages = original; input.value = text; notice.textContent = error.message; }
          else { answer.status = error.name === 'AbortError' ? 'interrupted' : 'failed'; answer.error = error.code || (error.name === 'AbortError' ? 'interrupted' : 'network'); }
        }
      } finally {
        if (running === operation) { running = null; if (visible) { renderMessages(); refreshHistory().catch(error => { notice.textContent = error.message; }); } }
      }
    }

    function settingsStatus(text) { const element = settingsHost.querySelector('[data-ai-settings-status]'); if (element) element.textContent = text; }
    function queuePatch(patch) { Object.assign(pending, patch); configRevision++; if (config) Object.entries(patch).forEach(([key, value]) => { if (key === 'presets') config.presets = [...config.presets.filter(item => item.builtin), ...value]; else if (key !== 'apiKey') config[key] = value; }); clearTimeout(saveTimer); saveTimer = setTimeout(() => flushSettings().catch(() => {}), 350); }
    function flushSettings() {
      clearTimeout(saveTimer); const patch = pending, revision = configRevision; pending = {};
      if (!Object.keys(patch).length) return saveChain;
      saveChain = saveChain.catch(() => {}).then(async () => {
        try {
          const saved = await api('config', patch);
          config = revision === configRevision ? saved : { ...saved, ...config, hasKey: saved.hasKey, keyHint: saved.keyHint }; updateSelectors();
          const key = settingsHost.querySelector('[data-ai-field="apiKey"]');
          if (Object.hasOwn(patch, 'apiKey') && !keyDirty && keyDraft?.trim() === patch.apiKey) {
            keyDraft = null;
            if (key) key.value = document.activeElement === key ? patch.apiKey : '';
          }
          settingsStatus(tr('已保存到本机', 'Saved locally')); updateKeyHint();
        } catch (error) { pending = { ...patch, ...pending }; settingsStatus(error.message); throw error; }
      });
      return saveChain;
    }
    function updateKeyHint() {
      const key = settingsHost.querySelector('[data-ai-field="apiKey"]');
      if (key) key.placeholder = config.keyHint || tr('输入 API Key', 'Enter API key');
    }
    function fieldValue(element) {
      const field = element.dataset.aiField, value = element.value;
      if (field === 'stream') return element.checked;
      if (['temperature', 'topP', 'timeout', 'maxTokens'].includes(field)) {
        if (field === 'maxTokens' && !value.trim() && !element.validity.badInput) return null;
        if (!value.trim() || !element.checkValidity()) throw new Error(tr('请输入范围内的有效数值', 'Enter a valid number within the range'));
        const number = Number(value);
        if (!Number.isFinite(number) || (['timeout', 'maxTokens'].includes(field) && !Number.isInteger(number))) throw new Error(tr('请输入有效整数', 'Enter a valid integer'));
        if (field === 'topP' && number <= 0) throw new Error(tr('Top P 必须大于 0', 'Top P must be greater than zero'));
        return number;
      }
      if (field === 'baseUrl') {
        try { const url = new URL(value.trim()); if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error(); }
        catch (_) { throw new Error(tr('请输入有效的 HTTP / HTTPS 基础地址', 'Enter a valid HTTP / HTTPS base URL')); }
      }
      return value.trim();
    }
    function acceptField(element) {
      const field = element.dataset.aiField;
      if (field === 'apiKey' && !keyDirty) return;
      try {
        const value = fieldValue(element); element.removeAttribute('aria-invalid');
        if (field === 'apiKey') { keyDirty = false; if (value === keyOriginal) return; keyOriginal = value; }
        queuePatch({ [field]: value }); settingsStatus(tr('正在保存…', 'Saving…'));
      }
      catch (error) { element.setAttribute('aria-invalid', 'true'); settingsStatus(error.message); }
    }
    function updateThinkingHint() {
      const element = settingsHost.querySelector('[data-ai-thinking-hint]'), mode = settingsHost.querySelector('[data-ai-field="thinking"]')?.value;
      if (element) element.textContent = mode === 'enabled' ? tr('思考模式下温度不生效；Top P 的行为取决于模型。', 'Temperature has no effect in thinking mode; Top P depends on the model.') : tr('跟随模型时不发送思考参数；采样参数是否生效由模型决定。', 'Model default omits thinking parameters. Sampling support depends on the model.');
      const effort = settingsHost.querySelector('[data-ai-field="effort"]'); if (effort) effort.disabled = mode !== 'enabled';
    }
    function presetEditor() {
      if (!config || !settingsBuilt) return;
      const picker = settingsHost.querySelector('[data-ai-preset-editor]');
      if (!config.presets.some(item => item.id === presetEditing)) presetEditing = 'none';
      setOptions(picker, config.presets.map(item => ({ value: item.id, name: presetName(item) })), presetEditing);
      const item = config.presets.find(item => item.id === presetEditing);
      const name = settingsHost.querySelector('[data-ai-preset-name]'), prompt = settingsHost.querySelector('[data-ai-preset-prompt]');
      name.value = presetName(item); prompt.value = item.prompt; name.readOnly = prompt.readOnly = !!item.builtin;
      settingsHost.querySelector('[data-ai-preset-delete]').disabled = !!item.builtin;
    }
    function savePreset() {
      clearTimeout(presetTimer);
      const item = config?.presets.find(item => item.id === presetEditing);
      if (!item || item.builtin) return;
      const name = settingsHost.querySelector('[data-ai-preset-name]').value.trim(), prompt = settingsHost.querySelector('[data-ai-preset-prompt]').value;
      if (!name) { settingsStatus(tr('预设名称不能为空', 'A preset name is required')); return; }
      item.name = name; item.prompt = prompt;
      queuePatch({ presets: config.presets.filter(item => !item.builtin).map(item => ({ ...item })) }); updateSelectors();
      const picker = settingsHost.querySelector('[data-ai-preset-editor]'); const option = Array.from(picker.options).find(option => option.value === item.id); if (option) option.textContent = item.name;
    }
    function buildSettings() {
      keyRevealSequence++;
      settingsBuilt = true;
      const drafts = new Map(Array.from(settingsHost.querySelectorAll('[data-ai-field]')).map(element => [element.dataset.aiField, { value: element.value, checked: element.checked }]));
      const presetDraftName = settingsHost.querySelector('[data-ai-preset-name]')?.value, presetDraftPrompt = settingsHost.querySelector('[data-ai-preset-prompt]')?.value;
      settingsHost.replaceChildren();
      function group(zh, en) { const section = document.createElement('section'), title = document.createElement('h4'); section.className = 'note-ai-settings-group'; title.textContent = tr(zh, en); section.append(title); settingsHost.append(section); return section; }
      function addField(section, field, zh, en, type = 'text', choices = null, attributes = {}) {
        const label = document.createElement('label'); label.className = 'note-ai-field'; label.dataset.settingsKeywords = field;
        const name = document.createElement('span'); name.textContent = tr(zh, en);
        const element = document.createElement(choices ? 'select' : 'input'); element.dataset.aiField = field;
        if (choices) setOptions(element, choices.map(([value, zh, en]) => ({ value, name: tr(zh, en) })), config[field]);
        else { element.type = type; if (type === 'checkbox') element.checked = config[field]; else element.value = config[field] ?? ''; }
        Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
        if (drafts.has(field)) { const draft = drafts.get(field); element.value = draft.value; element.checked = draft.checked; }
        label.append(name, element); section.append(label);
        const eventName = field === 'apiKey' || choices || type === 'checkbox' ? 'change' : 'input';
        element.addEventListener(eventName, event => { if (!event.isComposing) { acceptField(element); if (field === 'thinking') updateThinkingHint(); } });
        element.addEventListener('compositionend', () => { if (field !== 'apiKey') acceptField(element); });
        if (field === 'apiKey') {
          element.addEventListener('input', () => { keyRevealSequence++; keyDraft = element.value; keyDirty = true; });
          element.addEventListener('focus', async () => {
            element.type = 'text';
            if (keyDraft !== null) { element.value = keyDraft; return; }
            if (!config?.hasKey || element.value) return;
            const current = ++keyRevealSequence;
            try {
              const result = await api('reveal-key', {});
              if (current === keyRevealSequence && settingsActive && document.activeElement === element && !element.value) {
                element.value = result.apiKey || ''; keyOriginal = element.value;
              }
            } catch (error) {
              if (current === keyRevealSequence && settingsActive && document.activeElement === element) settingsStatus(error.message);
            }
          });
          element.addEventListener('blur', () => { keyRevealSequence++; acceptField(element); element.type = 'password'; if (!keyDirty) element.value = ''; });
        }
        return element;
      }
      const connection = group('连接', 'Connection');
      addField(connection, 'baseUrl', '接口基础地址', 'API base URL', 'url');
      addField(connection, 'model', '模型名称', 'Model name', 'text', null, { autocomplete: 'off', placeholder: tr('由你填写', 'Enter your model') });
      addField(connection, 'apiKey', 'API Key', 'API key', 'password', null, { autocomplete: 'new-password' });
      const keyTools = document.createElement('div'); keyTools.className = 'note-ai-settings-actions';
      const keyHint = document.createElement('p'); keyHint.textContent = tr('点击 API Key 输入框可查看或修改，离开输入框后自动遮蔽。', 'Focus the API key field to view or edit it. It is masked when you leave the field.'); connection.append(keyHint);
      const clear = button(tr('清除 Key', 'Clear key'), async () => {
        if (!clearKeyArmed) { clearKeyArmed = true; clear.textContent = tr('确认清除 Key', 'Confirm clear key'); return; }
        clearKeyArmed = false; keyRevealSequence++; keyDraft = keyOriginal = ''; keyDirty = false;
        const key = connection.querySelector('[data-ai-field="apiKey"]'); key.value = ''; key.type = 'password';
        queuePatch({ apiKey: '' }); try { await flushSettings(); clear.textContent = tr('清除 Key', 'Clear key'); } catch (_) {}
      }); clear.dataset.aiClearKey = '';
      const test = button(tr('测试连接', 'Test connection'), async () => {
        const current = ++settingsSequence; test.disabled = true;
        try { await flushSettings(); if (current !== settingsSequence || !settingsActive) return; testRequest = { id: uid(), controller: new AbortController() }; settingsStatus(tr('正在测试连接…', 'Testing connection…')); await api('test', { requestId: testRequest.id }, { signal: testRequest.controller.signal }); if (current === settingsSequence && settingsActive) settingsStatus(tr('连接成功', 'Connection successful')); }
        catch (error) { if (current === settingsSequence && settingsActive && error.name !== 'AbortError') settingsStatus(error.message); }
        finally { if (current === settingsSequence) { testRequest = null; test.disabled = false; } }
      }); test.dataset.aiTest = ''; keyTools.append(clear, test); connection.append(keyTools);
      const generation = group('生成参数', 'Generation');
      addField(generation, 'stream', '流式输出', 'Stream replies', 'checkbox');
      addField(generation, 'thinking', '思考模式', 'Thinking mode', '', [['auto', '跟随模型默认', 'Model default'], ['disabled', '关闭', 'Off'], ['enabled', '开启', 'On']]);
      addField(generation, 'effort', '思考强度', 'Thinking effort', '', [['low', '低 · low', 'Low'], ['high', '高 · high', 'High'], ['max', '最高 · max', 'Maximum']]);
      addField(generation, 'temperature', '温度', 'Temperature', 'number', null, { min: '0', max: '2', step: 'any' });
      addField(generation, 'topP', 'Top P', 'Top P', 'number', null, { min: '0', max: '1', step: 'any' });
      addField(generation, 'maxTokens', '最大输出 Token', 'Maximum output tokens', 'number', null, { min: '1', max: '393216', step: '1', placeholder: tr('自动 · 模型默认', 'Auto · model default') });
      addField(generation, 'timeout', '请求总超时（秒）', 'Total timeout (seconds)', 'number', null, { min: '1', max: '3600', step: '1' });
      const thinkingHint = document.createElement('p'); thinkingHint.dataset.aiThinkingHint = ''; generation.append(thinkingHint);
      const presetsGroup = group('系统提示词预设', 'System prompt presets');
      const pickerLabel = document.createElement('label'); pickerLabel.className = 'note-ai-field'; const pickerName = document.createElement('span'); pickerName.textContent = tr('编辑预设', 'Edit preset');
      const picker = select(pickerName.textContent); picker.dataset.aiPresetEditor = ''; pickerLabel.append(pickerName, picker); presetsGroup.append(pickerLabel);
      const nameLabel = document.createElement('label'); nameLabel.className = 'note-ai-field'; const nameTitle = document.createElement('span'); nameTitle.textContent = tr('名称', 'Name'); const name = document.createElement('input'); name.maxLength = 80; name.dataset.aiPresetName = ''; nameLabel.append(nameTitle, name);
      const promptLabel = document.createElement('label'); promptLabel.className = 'note-ai-prompt-field'; const promptTitle = document.createElement('span'); promptTitle.textContent = tr('系统提示词', 'System prompt'); const prompt = document.createElement('textarea'); prompt.rows = 8; prompt.maxLength = 65536; prompt.dataset.aiPresetPrompt = ''; promptLabel.append(promptTitle, prompt);
      presetsGroup.append(nameLabel, promptLabel);
      picker.addEventListener('change', async () => { savePreset(); presetEditing = picker.value; presetEditor(); });
      [name, prompt].forEach(element => { element.addEventListener('input', event => { if (!event.isComposing) { clearTimeout(presetTimer); presetTimer = setTimeout(savePreset, 300); } }); element.addEventListener('compositionend', savePreset); element.addEventListener('blur', savePreset); });
      const tools = document.createElement('div'); tools.className = 'note-ai-settings-actions';
      const addPreset = (copy = false) => {
        if (config.presets.filter(item => !item.builtin).length >= 100) { settingsStatus(tr('最多保留 100 个自定义预设', 'You can keep up to 100 custom presets')); return; }
        savePreset(); const original = config.presets.find(item => item.id === presetEditing);
        const item = { id: uid(), name: copy ? presetName(original) + tr(' 副本', ' copy') : tr('新预设', 'New preset'), prompt: copy ? original.prompt : '', builtin: false };
        config.presets.push(item); presetEditing = item.id; queuePatch({ presets: config.presets.filter(item => !item.builtin).map(item => ({ ...item })) }); presetEditor(); updateSelectors(); name.focus(); name.select();
      };
      const add = button(tr('新建预设', 'New preset'), () => addPreset()); add.dataset.aiPresetAdd = '';
      const duplicate = button(tr('复制为自定义预设', 'Duplicate as custom preset'), () => addPreset(true)); duplicate.dataset.aiPresetDuplicate = '';
      const del = button(tr('删除预设', 'Delete preset'), () => {
        const item = config.presets.find(item => item.id === presetEditing); if (!item || item.builtin) return;
        clearTimeout(presetTimer); config.presets = config.presets.filter(item => item.id !== presetEditing); presetEditing = 'none';
        queuePatch({ presets: config.presets.filter(item => !item.builtin).map(item => ({ ...item })) }); presetEditor(); updateSelectors();
      }); del.dataset.aiPresetDelete = ''; tools.append(add, duplicate, del); presetsGroup.append(tools);
      const detail = document.createElement('p'); detail.textContent = tr('内置预设可复制后修改。切换预设开启新对话；历史会话保留当时的提示词。恢复默认保留模型、Key、自定义预设和聊天历史。', 'Duplicate a built-in preset to edit it. Switching presets starts a new conversation. History retains its original prompt. Reset keeps your model, key, custom presets and chats.'); presetsGroup.append(detail);
      const status = document.createElement('p'); status.setAttribute('role', 'status'); status.dataset.aiSettingsStatus = ''; settingsHost.append(status);
      presetEditor();
      if (presetDraftName !== undefined && !name.readOnly) { name.value = presetDraftName; prompt.value = presetDraftPrompt; }
      updateKeyHint(); updateThinkingHint();
    }
    async function settings() {
      settingsActive = true;
      try { await loadConfig(); if (settingsActive && !settingsBuilt) buildSettings(); }
      catch (error) { settingsHost.textContent = error.message; }
    }
    function closeSettings() {
      if (!settingsActive) return;
      settingsActive = false; settingsSequence++; keyRevealSequence++; clearKeyArmed = false;
      if (testRequest) { testRequest.controller.abort(); api('cancel', { requestId: testRequest.id }).catch(() => {}); testRequest = null; }
      settingsHost.querySelector('[data-ai-test]')?.removeAttribute('disabled');
      const clear = settingsHost.querySelector('[data-ai-clear-key]'); if (clear) clear.textContent = tr('清除 Key', 'Clear key');
      const key = settingsHost.querySelector('[data-ai-field="apiKey"]'); if (key) { acceptField(key); key.type = 'password'; if (!keyDirty) key.value = ''; }
      savePreset(); flushSettings().catch(() => {});
    }
    async function show() {
      if (visible) return;
      visible = true; const current = ++sequence;
      try {
        await loadConfig();
        if (!visible || current !== sequence) return;
        if (!initialized) {
          const result = await refreshHistory(); if (!visible || current !== sequence) return;
          initialized = true;
          if (result.active) await openSession(result.active, false);
          else newConversation('none', false);
        } else renderMessages();
      } catch (error) { if (visible && current === sequence) { notice.textContent = error.message; visible = false; } }
      finally { if (initialized) input.disabled = send.disabled = presets.disabled = chats.disabled = plus.disabled = false; }
    }
    function suspend(keepalive = false) { visible = false; sequence++; stop(keepalive); cancelAnimationFrame(paint); paint = 0; }
    function setLanguage() {
      languageRevision++;
      presets.setAttribute('aria-label', tr('系统预设', 'System preset')); chats.setAttribute('aria-label', tr('会话', 'Conversation'));
      [[plus, '新建对话', 'New conversation'], [gear, 'AI 设置', 'AI settings'], [rename, '重命名会话', 'Rename conversation'], [remove, '删除会话', 'Delete conversation'], [historyNext, '更多会话', 'More conversations']].forEach(([element, zh, en]) => { element.setAttribute('aria-label', tr(zh, en)); element.title = tr(zh, en); });
      plus.textContent = tr('新建对话', 'New conversation');
      renameInput.setAttribute('aria-label', tr('会话名称', 'Conversation name')); renameSave.textContent = tr('确定', 'Done');
      deleteCopy.textContent = tr('删除此会话？', 'Delete this conversation?'); deleteYes.textContent = tr('删除', 'Delete'); deleteNo.textContent = tr('取消', 'Cancel');
      emptyTitle.textContent = tr('从一个问题开始', 'Start with a question'); emptyText.textContent = tr('选择预设，或直接开始对话。', 'Choose a preset, or simply start chatting.'); setup.textContent = tr('填写连接信息', 'Set up connection');
      input.placeholder = tr('输入消息…', 'Message…'); input.setAttribute('aria-label', tr('AI 消息', 'AI message')); hint.textContent = tr('Enter 发送 · Shift+Enter 换行', 'Enter to send · Shift+Enter for a new line');
      older.textContent = tr('较早的消息', 'Earlier messages');
      updateSelectors(); renderMessages(); if (settingsBuilt) buildSettings();
    }
    window.addEventListener('pagehide', () => { pageHiding = true; suspend(true); closeSettings(); });
    window.addEventListener('pageshow', () => { pageHiding = false; });
    setLanguage();
    return { show, suspend, settings, closeSettings, setLanguage,
      async prepareSettings() { await loadConfig(); if (!settingsBuilt) buildSettings(); },
      async resetSettings() { await loadConfig(); savePreset(); await flushSettings(); config = await api('config', { reset: true }); settingsBuilt = false; settingsHost.replaceChildren(); buildSettings(); updateSelectors(); },
    };
  }
  window.RelatumNoteAI = { create };
})();
