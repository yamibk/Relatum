// Note-only chat. No note/editor context is read by this module.
(function () {
  'use strict';
  const ROOT = '/api/note-ai/';
  const uid = () => crypto.randomUUID();
  function create(options) {
    const { host, settingsHost } = options;
    host.dataset.i18nManaged = 'true';
    let config = null, configLoader = null, initialized = false, visible = false, sequence = 0;
    let session = null, presetId = 'none', messages = [], presets = null, choices = null, choicePortal = null;
    let pageHiding = false;
    let running = null, paint = 0, paintTimer = 0, lastPaint = 0, paintInterval = 120, renderEpoch = 0;
    let layoutFrame = 0, followBottom = true, readingAnchor = null;
    let settingsActive = false, settingsBuilt = false, settingsSequence = 0;
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
    const icons = {
      plus: '<path d="M12 5v14M5 12h14"/>', send: '<path d="m6 11 6-6 6 6M12 5v14"/>',
      stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
      copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
      check: '<path d="m5 12 4 4L19 6"/>', chevron: '<path d="m9 5 7 7-7 7"/>',
      down: '<path d="m6 10 6 6 6-6M12 4v12"/>', retry: '<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
    };
    function icon(element, name) {
      if (element.dataset.icon === name) return;
      element.dataset.icon = name;
      element.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" stroke-linecap="round" stroke-linejoin="round">' + icons[name] + '</svg>';
    }
    function select(label) { const element = document.createElement('select'); element.setAttribute('aria-label', label); return element; }
    function setOptions(element, items, value) {
      const old = Array.from(element.options), next = items.map(item => {
        const node = old.find(option => option.value === item.value) || document.createElement('option');
        node.value = item.value; if (node.textContent !== item.name) node.textContent = item.name; return node;
      });
      if (old.length !== next.length || old.some((item, index) => item !== next[index])) element.replaceChildren(...next);
      element.value = value;
      choices?.refresh(element);
    }
    const plus = button('', () => {
      newConversation(presetId);
      input.focus({ preventScroll: true });
    }, ''); plus.dataset.aiNew = ''; icon(plus, 'plus');
    const timeline = document.createElement('div'); timeline.className = 'note-ai-timeline'; timeline.dataset.aiTimeline = ''; timeline.setAttribute('role', 'log'); timeline.setAttribute('aria-live', 'off');
    const body = document.createElement('div'); body.className = 'note-ai-messages';
    timeline.append(body);
    const notice = document.createElement('p'); notice.className = 'note-ai-notice'; notice.setAttribute('role', 'status');
    const composer = document.createElement('form'); composer.className = 'note-ai-composer';
    const input = document.createElement('textarea'); input.rows = 3; input.maxLength = 262144; input.dataset.aiInput = '';
    const send = document.createElement('button'); send.type = 'submit'; send.dataset.aiSend = '';
    const bottom = button('', () => { followBottom = true; restoreReadingPosition(); }, '');
    bottom.className = 'note-ai-bottom'; bottom.dataset.aiBottom = ''; bottom.hidden = true; icon(bottom, 'down');
    composer.append(input, plus, send); host.append(timeline, bottom, notice, composer);
    input.disabled = send.disabled = plus.disabled = true;
    host.addEventListener('click', event => {
      event.stopPropagation();
      const link = event.target.closest('a');
      if (link) { const url = link.getAttribute('href') || ''; if (!/^(https?:|mailto:)/i.test(url)) event.preventDefault(); else { link.target = '_blank'; link.rel = 'noopener noreferrer'; } }
    });
    host.addEventListener('keydown', event => event.stopPropagation());
    let composing = false;
    input.addEventListener('input', resizeInput);
    input.addEventListener('compositionstart', () => { composing = true; }); input.addEventListener('compositionend', () => { composing = false; resizeInput(); });
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !composing) { event.preventDefault(); if (!running) submit(); } });
    composer.addEventListener('submit', event => { event.preventDefault(); if (running) stop(); else if (!composing) submit(); });

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => queueLayout()) : null;
    function captureReadingPosition() {
      if (followBottom) return null;
      const top = timeline.getBoundingClientRect().top;
      const nodes = body.querySelectorAll('[data-ai-role="user"], .note-ai-rich > *');
      for (const node of nodes) {
        if (!node.getClientRects().length || node.closest('[inert]')) continue;
        if (node.getBoundingClientRect().bottom > top + 1) {
          const row = node.closest('.note-ai-message');
          return { node, top: node.getBoundingClientRect().top, row, rowTop: row.getBoundingClientRect().top };
        }
      }
      return null;
    }
    function restoreReadingPosition(anchor = readingAnchor, previous = null, next = null) {
      if (!visible) return;
      if (followBottom) timeline.scrollTop = timeline.scrollHeight;
      else if (anchor) {
        const node = anchor.node === previous ? next : anchor.node;
        if (node?.isConnected && !node.closest('[inert]')) timeline.scrollTop += node.getBoundingClientRect().top - anchor.top;
        else if (anchor.row?.isConnected) timeline.scrollTop += anchor.row.getBoundingClientRect().top - anchor.rowTop;
      }
      bottom.hidden = followBottom || timeline.scrollHeight - timeline.clientHeight < 70;
      readingAnchor = captureReadingPosition();
    }
    function queueLayout() {
      if (!visible || layoutFrame) return;
      layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; restoreReadingPosition(); });
    }
    timeline.addEventListener('scroll', () => {
      if (!visible) return;
      followBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 70;
      bottom.hidden = followBottom; readingAnchor = captureReadingPosition();
    }, { passive: true });
    function resizeInput() {
      if (!visible) return;
      const anchor = captureReadingPosition();
      input.style.height = '0px';
      const max = Math.min(240, innerHeight * .28);
      input.style.height = Math.max(52, Math.min(input.scrollHeight, max)) + 'px';
      input.style.overflowY = input.scrollHeight > max ? 'auto' : 'hidden';
      host.style.setProperty('--ai-composer-height', composer.offsetHeight + 'px');
      restoreReadingPosition(anchor);
    }
    function clearMath(node) { try { window.MathJax?.typesetClear?.([node]); } catch (_) {} }
    function releaseBlock(block) {
      block.released = true; block.job = null; block.stage?.remove(); clearMath(block.node);
    }
    function releaseRich(surface) {
      surface._blocks?.forEach(releaseBlock); surface._blocks = []; surface._source = null;
    }
    function pendingFormula(source) {
      const grammar = window.MarkdownMini?.structure;
      if (!grammar || (!source.includes('\\[') && !source.includes('\\(') && !source.includes('$$'))) return -1;
      const mask = value => value.replace(/[^\n]/g, ' ');
      let fence = null;
      let prose = source.split('\n').map(line => {
        const text = window.MarkdownMini.quoteLine(line).text;
        if (fence) { if (grammar.isFenceClose(text, fence)) fence = null; return mask(line); }
        const opener = grammar.parseFence(text);
        if (opener) { fence = opener; return mask(line); }
        return /^(?: {4}|\t)/.test(text) ? mask(line) : line;
      }).join('\n').replace(/(`+)[^`]*?\1/g, mask).replace(/<!--[\s\S]*?(?:-->|$)|%%[\s\S]*?(?:%%|$)/g, mask);
      const pieces = []; let cursor = 0;
      window.MarkdownMini.mathRanges(prose).forEach(range => {
        pieces.push(prose.slice(cursor, range.from), mask(prose.slice(range.from, range.to))); cursor = range.to;
      });
      pieces.push(prose.slice(cursor)); prose = pieces.join('');
      // A bare dollar already stays literal until closed (including currency).
      // Backslash delimiters need protection from Markdown escape handling.
      for (const match of prose.matchAll(/\\\[|\\\(|\$\$/g)) {
        let backslashes = 0;
        for (let index = match.index - 1; index >= 0 && prose[index] === '\\'; index--) backslashes++;
        if (!(backslashes % 2) && (match[0] !== '\\(' || !prose.includes('\n', match.index))) return match.index;
      }
      return -1;
    }
    function updateRich(surface, source, row) {
      if (surface._source !== source) {
        surface._source = source;
        const unfinished = pendingFormula(source), prefix = unfinished < 0 ? source : source.slice(0, unfinished);
        const result = window.MarkdownMini?.renderResult(prefix, { mermaid: false, localImages: true });
        const template = document.createElement('template');
        if (result) template.innerHTML = result.html; else template.content.append(document.createTextNode(prefix));
        if (unfinished >= 0) {
          const tail = document.createElement('span'); tail.className = 'note-ai-unfinished'; tail.textContent = source.slice(unfinished);
          const paragraph = template.content.lastElementChild;
          if (!prefix.endsWith('\n') && paragraph?.tagName === 'P') paragraph.append(tail); else template.content.append(tail);
        }
        // Never resolve model images, note paths, or embedded canvases.
        template.content.querySelectorAll('img').forEach(image => image.replaceWith(document.createTextNode(image.alt || '')));
        template.content.querySelectorAll('input').forEach(element => { element.disabled = true; });
        const old = surface._blocks || [], blocks = [];
        Array.from(template.content.childNodes).forEach((node, index) => {
          const signature = node.nodeType === 1 ? node.outerHTML : node.textContent;
          let block = old[index];
          if (!block || block.signature !== signature) {
            if (block) releaseBlock(block);
            let math = false;
            if (result?.features.math && node.nodeType === 1 && !node.matches('pre,code')) {
              const prose = node.cloneNode(true); prose.querySelectorAll('pre,code').forEach(code => code.remove());
              math = window.MarkdownMini.structure.scanFeatures(prose.textContent).math;
            }
            block = { signature, node, math, state: 'new', epoch: renderEpoch };
          }
          blocks.push(block);
          if (surface.childNodes[index] !== block.node) {
            const previous = surface.childNodes[index];
            if (previous) previous.replaceWith(block.node); else surface.append(block.node);
          }
        });
        old.slice(blocks.length).forEach(releaseBlock);
        while (surface.childNodes.length > blocks.length) surface.lastChild.remove();
        surface._blocks = blocks;
      }
      if (visible && !surface.closest('[inert]')) surface._blocks?.forEach(block => typesetBlock(block, surface, row));
    }
    function typesetBlock(block, surface, row) {
      if (!block.math || ['done', 'queued', 'failed'].includes(block.state) || !window.RelatumNoteLiveEditor?.typesetMath) return;
      block.state = 'queued'; block.epoch = renderEpoch;
      const epoch = renderEpoch, job = {}; block.job = job;
      const current = () => visible && renderEpoch === epoch && block.job === job && !block.released && row.isConnected
        && surface._blocks?.includes(block) && !surface.closest('[inert]');
      const stage = document.createElement('div'); stage.className = 'note-ai-rich node-text note-ai-math-stage';
      stage.setAttribute('aria-hidden', 'true'); stage.inert = true;
      const style = getComputedStyle(surface);
      stage.style.width = Math.max(1, surface.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) + 'px';
      stage.style.fontSize = style.fontSize; stage.style.lineHeight = style.lineHeight;
      stage.append(block.node.cloneNode(true));
      block.stage = stage; host.append(stage);
      window.RelatumNoteLiveEditor.typesetMath(stage, current).then(ok => {
        if (!ok || !current()) return;
        const next = stage.firstChild;
        if (!next?.querySelector?.('mjx-container') || next.querySelector('mjx-merror,[data-mjx-error],merror')) return;
        const anchor = captureReadingPosition(), previous = block.node;
        clearMath(previous); previous.replaceWith(next); block.node = next; block.state = 'done';
        restoreReadingPosition(anchor, previous, next);
      }).catch(() => {}).finally(() => {
        clearMath(stage); stage.remove(); if (block.stage === stage) block.stage = null;
        if (block.job === job) {
          if (block.state !== 'done') block.state = current() ? 'failed' : 'new';
          block.job = null;
        }
      });
    }
    function finishFold(row) {
      row._foldAnimation?.cancel(); row._foldAnimation = null;
      row._parts.fold.style.height = row._open ? 'auto' : '0px';
    }
    function setFold(row, open, manual = false, instant = false) {
      if (manual) row._manualFold = true;
      if (row._open === open && !instant) return;
      const { toggle, fold, reason } = row._parts;
      const anchor = captureReadingPosition(), from = fold.getBoundingClientRect().height;
      finishFold(row); row._open = open;
      toggle.setAttribute('aria-expanded', String(open)); fold.inert = !open; fold.setAttribute('aria-hidden', String(!open));
      fold.style.height = open ? 'auto' : '0px';
      if (open) updateRich(reason, row._message.reasoning || '', row);
      const to = open ? fold.getBoundingClientRect().height : 0;
      if (!instant && visible && !reducedMotion.matches && fold.animate && Math.abs(from - to) > 1) {
        const animation = fold.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' });
        row._foldAnimation = animation;
        animation.finished.then(() => { if (row._foldAnimation === animation) { row._foldAnimation = null; queueLayout(); } }).catch(() => {});
      }
      restoreReadingPosition(anchor);
    }
    function settleMotion() { rows.forEach(finishFold); queueLayout(); }

    function loadConfig(refresh = false) {
      if (config && !refresh) return Promise.resolve(config);
      if (!configLoader) configLoader = api('config').then(value => { config = value; updateSelectors(); return config; }).finally(() => { configLoader = null; });
      return configLoader;
    }
    function updateSelectors() {
      if (!config || !presets?.isConnected) return;
      const items = config.presets.map(item => ({ value: item.id, name: presetName(item) }));
      // The current conversation keeps its prompt if its preset was removed.
      if (session?.saved && !items.some(item => item.value === presetId)) items.push({ value: presetId, name: session.preset_name });
      if (!items.some(item => item.value === presetId)) presetId = 'none';
      setOptions(presets, items, presetId);
    }
    function discard(previous, operation, keepalive = false) {
      if (!previous?.started) return;
      const remove = () => api('session', { action: 'delete', id: previous.id }, { keepalive }).catch(() => {});
      if (keepalive) remove();
      else (operation?.finished || Promise.resolve()).then(remove);
    }
    function newConversation(id = 'none') {
      const previous = session, operation = running;
      stop(); sequence++;
      session = { id: uid(), saved: false }; presetId = config?.presets.some(item => item.id === id) ? id : 'none';
      renderEpoch++; cancelPaint();
      messages = []; notice.textContent = ''; input.value = ''; followBottom = true; readingAnchor = null;
      resizeInput();
      updateSelectors(); renderMessages();
      discard(previous, operation);
    }
    function messageRow(message) {
      const row = document.createElement('article'); row.className = 'note-ai-message'; row.dataset.aiRole = message.role;
      const thinking = document.createElement('section'), summary = document.createElement('span');
      const toggle = button('', () => setFold(row, !row._open, true), ''); toggle.className = 'note-ai-thinking-toggle';
      toggle.removeAttribute('aria-label'); toggle.removeAttribute('title');
      const arrow = document.createElement('span'); arrow.className = 'note-ai-chevron'; icon(arrow, 'chevron');
      toggle.append(arrow, summary); toggle.setAttribute('aria-expanded', 'false');
      const fold = document.createElement('div'), reason = document.createElement('div');
      fold.className = 'note-ai-thinking-fold'; fold.id = 'ai-reason-' + uid(); toggle.setAttribute('aria-controls', fold.id);
      fold.inert = true; fold.style.height = '0px'; fold.setAttribute('aria-hidden', 'true');
      reason.className = 'note-ai-reason note-ai-rich node-text'; fold.append(reason);
      thinking.className = 'note-ai-thinking'; thinking.append(toggle, fold);
      const content = document.createElement('div'); content.className = 'note-ai-answer note-ai-rich node-text';
      const foot = document.createElement('div'); foot.className = 'note-ai-message-foot';
      const copy = button('', () => {
        const epoch = renderEpoch;
        navigator.clipboard.writeText(row._message.content || '').then(() => {
          if (!visible || renderEpoch !== epoch || !row.isConnected) return;
          clearTimeout(row._copyTimer); icon(copy, 'check'); copy.dataset.copied = 'true';
          copy.setAttribute('aria-label', tr('已复制', 'Copied')); copy.title = tr('已复制', 'Copied');
          row._copyTimer = setTimeout(() => { row._copyTimer = 0; resetCopy(row); }, 1400);
        }).catch(() => options.notify(tr('复制失败', 'Copy failed'), 'error'));
      }, ''); icon(copy, 'copy');
      copy.dataset.aiCopy = '';
      const retry = button('', () => submit(row._message), ''); retry.dataset.aiRetry = ''; icon(retry, 'retry');
      const status = document.createElement('span'); status.className = 'note-ai-status';
      const metadata = document.createElement('span'); metadata.className = 'note-ai-metadata';
      const info = button('', () => {}, ''); info.dataset.aiInfo = ''; icon(info, 'info');
      const detail = document.createElement('span'); detail.className = 'note-ai-detail'; detail.id = 'ai-detail-' + uid(); detail.setAttribute('role', 'tooltip');
      info.setAttribute('aria-describedby', detail.id); metadata.append(info, detail);
      foot.append(status, copy, metadata, retry); row.append(thinking, content, foot);
      row._open = false;
      row._parts = { thinking, toggle, fold, summary, reason, content, status, copy, metadata, info, detail, retry }; return row;
    }
    function resetCopy(row) {
      const copy = row._parts.copy; delete copy.dataset.copied; icon(copy, 'copy');
      copy.setAttribute('aria-label', tr('复制原文', 'Copy original')); copy.title = tr('复制原文', 'Copy original');
    }
    function releaseRow(row) {
      finishFold(row); clearTimeout(row._copyTimer); resetCopy(row);
      releaseRich(row._parts.content); releaseRich(row._parts.reason); row.remove();
    }
    function renderMessages() {
      cancelPaint();
      const started = performance.now(), anchor = captureReadingPosition();
      const keys = new Set();
      messages.forEach((message, index) => {
        const key = message.request_id + ':' + message.role; keys.add(key);
        let row = rows.get(key);
        if (!row) { row = messageRow(message); rows.set(key, row); }
        if (body.children[index] !== row) body.insertBefore(row, body.children[index] || null);
        row._message = message; const part = row._parts;
        const reasoning = !!message.reasoning, thinking = message.status === 'pending' && !message.content;
        part.thinking.hidden = !reasoning;
        part.summary.textContent = thinking ? tr('正在思考…', 'Thinking…') : tr('已思考', 'Thought')
          + (message.thinkingElapsed != null ? tr('（用时约 ', ' (about ') + Math.max(1, Math.round(message.thinkingElapsed / 1000)) + tr(' 秒）', 's)') : '');
        if (reasoning) {
          updateRich(part.reason, message.reasoning, row);
          if (!row._manualFold) setFold(row, !message.content);
        }
        if (message.role === 'assistant') updateRich(part.content, message.content || (thinking && !reasoning ? tr('正在生成…', 'Generating…') : ''), row);
        else if (part.content.textContent !== message.content) part.content.textContent = message.content;
        part.content.classList.toggle('is-waiting', thinking && !reasoning);
        const bits = [];
        const status = [];
        if (message.status === 'failed' || message.status === 'interrupted') status.push(textError(message.error || message.status));
        if (message.finish_reason === 'length') status.push(tr('已达到输出上限', 'Output limit reached'));
        if (message.role === 'assistant') {
          if (message.context_count != null) bits.push(tr('上下文 ', 'Context: ') + message.context_count + tr(' 轮', ' turns'));
          if (message.usage) bits.push(`${message.usage.prompt_tokens ?? '—'} / ${message.usage.completion_tokens ?? '—'} tokens`);
          if (message.elapsed) bits.push(message.elapsed.toFixed(1) + 's');
        }
        part.status.textContent = status.join(' · ');
        part.detail.textContent = bits.join(' · '); part.metadata.hidden = !bits.length;
        part.info.setAttribute('aria-label', tr('回答详情', 'Response details'));
        if (!row._copyTimer) resetCopy(row);
        part.copy.hidden = !message.content;
        part.retry.setAttribute('aria-label', tr('重试', 'Retry')); part.retry.title = tr('重试', 'Retry');
        part.retry.hidden = !(index === messages.length - 1 && message.role === 'assistant' && ['failed', 'interrupted'].includes(message.status) && !running);
      });
      rows.forEach((row, key) => { if (!keys.has(key)) { releaseRow(row); rows.delete(key); } });
      icon(send, running ? 'stop' : 'send'); send.setAttribute('aria-label', running ? tr('停止', 'Stop') : tr('发送', 'Send'));
      restoreReadingPosition(anchor);
      lastPaint = performance.now(); paintInterval = Math.max(120, Math.min(600, (lastPaint - started) * 4));
    }
    function cancelPaint() { clearTimeout(paintTimer); cancelAnimationFrame(paint); paintTimer = paint = 0; }
    function schedulePaint() {
      if (!visible || paint || paintTimer) return;
      paintTimer = setTimeout(() => { paintTimer = 0; paint = requestAnimationFrame(() => { paint = 0; if (visible) renderMessages(); }); }, Math.max(0, paintInterval - (performance.now() - lastPaint)));
    }
    function stop(keepalive = false) {
      const operation = running;
      if (!operation) return;
      operation.stopped = true; operation.controller.abort();
      api('cancel', { requestId: operation.id }, { keepalive }).catch(() => {});
      operation.answer.status = 'interrupted'; operation.answer.error = 'interrupted';
      if (operation.reasoningStarted != null && operation.answer.thinkingElapsed == null) operation.answer.thinkingElapsed = performance.now() - operation.reasoningStarted;
      running = null; if (visible) renderMessages();
    }
    async function submit(retry = null) {
      if (running || !visible || !options.isVisible()) return;
      const text = retry ? messages.find(item => item.request_id === retry.request_id && item.role === 'user')?.content : input.value.trim();
      if (!text) return;
      const intent = sequence;
      try { await flushSettings(); await loadConfig(); } catch (error) { if (intent === sequence && visible) notice.textContent = error.message; return; }
      if (running || intent !== sequence || !visible || !options.isVisible()) return;
      if (!config.hasKey || !config.model) { notice.textContent = textError('config-required'); return; }
      if (!session) newConversation(presetId);
      const original = messages.slice();
      if (retry) messages = messages.filter(item => item.request_id !== retry.request_id);
      const id = uid(), current = sequence, sessionId = session.id;
      const answer = { request_id: id, role: 'assistant', content: '', reasoning: '', status: 'pending', context_count: null };
      messages.push({ request_id: id, role: 'user', content: text, status: 'complete' }, answer);
      let finished;
      const operation = { id, answer, controller: new AbortController(), stopped: false, meta: false, finished: new Promise(resolve => { finished = resolve; }) };
      session.started = true;
      running = operation; notice.textContent = ''; input.value = ''; followBottom = true; resizeInput(); renderMessages();
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
            if (event.type === 'meta') { operation.meta = true; session = { ...event.session, saved: true, started: true }; answer.context_count = event.contextCount; answer.model = event.model; updateSelectors(); }
            else if (event.type === 'delta') {
              if (event.text && operation.reasoningStarted != null && answer.thinkingElapsed == null) answer.thinkingElapsed = performance.now() - operation.reasoningStarted;
              answer.content += event.text;
            }
            else if (event.type === 'reasoning') { if (operation.reasoningStarted == null) operation.reasoningStarted = performance.now(); answer.reasoning += event.text; }
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
          if (!operation.meta && error.name !== 'AbortError') { messages = original; input.value = text; resizeInput(); notice.textContent = error.message; }
          else { answer.status = error.name === 'AbortError' ? 'interrupted' : 'failed'; answer.error = error.code || (error.name === 'AbortError' ? 'interrupted' : 'network'); }
        }
      } finally {
        if (operation.reasoningStarted != null && answer.thinkingElapsed == null) answer.thinkingElapsed = performance.now() - operation.reasoningStarted;
        if (running === operation) { running = null; if (visible) renderMessages(); }
        finished();
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
      choices?.sync(effort);
    }
    function presetEditor() {
      if (!config || !settingsBuilt) return;
      const picker = settingsHost.querySelector('[data-ai-preset-editor]');
      if (!config.presets.some(item => item.id === presetEditing)) presetEditing = 'none';
      setOptions(picker, config.presets.map(item => ({ value: item.id, name: presetName(item) })), presetEditing);
      const item = config.presets.find(item => item.id === presetEditing);
      const name = settingsHost.querySelector('[data-ai-preset-name]'), prompt = settingsHost.querySelector('[data-ai-preset-prompt]');
      name.value = presetName(item); prompt.value = item.prompt; name.readOnly = prompt.readOnly = !!item.builtin;
      name.closest('label').hidden = prompt.closest('label').hidden = item.id === 'none';
      settingsHost.querySelector('[data-ai-preset-delete]').disabled = !!item.builtin;
      settingsHost.querySelector('[data-ai-preset-duplicate]').disabled = item.id === 'none';
      settingsHost.querySelector('[data-ai-preset-hint]').textContent = item.id === 'none'
        ? tr('无预设不发送系统提示词。可以新建预设，或选择内置预设查看。', 'No preset sends no system prompt. Create a preset, or choose a built-in one to inspect it.')
        : item.builtin ? tr('内置预设只读，复制为自定义预设后即可修改。', 'Built-in presets are read-only. Duplicate one to customize it.')
        : tr('修改即时保存。当前对话继续使用开始时的提示词，新对话使用修改后的内容。', 'Changes save automatically. The current conversation keeps its original prompt; new conversations use your changes.');
    }
    function savePreset() {
      clearTimeout(presetTimer);
      const item = config?.presets.find(item => item.id === presetEditing);
      if (!item || item.builtin) return;
      const name = settingsHost.querySelector('[data-ai-preset-name]').value.trim(), prompt = settingsHost.querySelector('[data-ai-preset-prompt]').value;
      if (!name) { settingsStatus(tr('预设名称不能为空', 'A preset name is required')); return; }
      if (item.name === name && item.prompt === prompt) return;
      item.name = name; item.prompt = prompt;
      queuePatch({ presets: config.presets.filter(item => !item.builtin).map(item => ({ ...item })) }); updateSelectors();
      const picker = settingsHost.querySelector('[data-ai-preset-editor]'); const option = Array.from(picker.options).find(option => option.value === item.id); if (option) option.textContent = item.name;
      choices?.refresh(picker);
    }
    function buildSettings() {
      keyRevealSequence++;
      choices?.dispose(); choices = null; choicePortal?.remove();
      settingsBuilt = true;
      const drafts = new Map(Array.from(settingsHost.querySelectorAll('[data-ai-field]')).map(element => [element.dataset.aiField, { value: element.value, checked: element.checked }]));
      const presetDraftName = settingsHost.querySelector('[data-ai-preset-name]')?.value, presetDraftPrompt = settingsHost.querySelector('[data-ai-preset-prompt]')?.value;
      settingsHost.replaceChildren();
      choicePortal = document.createElement('div'); choicePortal.className = 'note-ai-settings-popovers';
      settingsHost.closest('dialog').append(choicePortal);
      choices = window.RelatumReviewControls.createManager(settingsHost, choicePortal);
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
      const conversation = group('当前对话预设', 'Conversation preset');
      const presetLabel = document.createElement('label'); presetLabel.className = 'note-ai-field'; presetLabel.dataset.settingsKeywords = '当前对话预设 conversation preset';
      const presetTitle = document.createElement('span'); presetTitle.textContent = tr('使用预设', 'Use preset');
      presets = select(tr('当前对话预设', 'Conversation preset')); presets.dataset.aiPreset = '';
      presets.addEventListener('change', () => newConversation(presets.value)); presetLabel.append(presetTitle, presets); conversation.append(presetLabel);
      const conversationHint = document.createElement('p'); conversationHint.textContent = tr('切换预设会开启新对话。对话仅在本次运行中保留，退出后不恢复；连接信息与自定义预设仍会保存。', 'Switching presets starts a new conversation. Chats last only for this run; connection settings and custom presets are saved.'); conversation.append(conversationHint);
      updateSelectors();
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
      }); test.dataset.aiTest = ''; test.className = 'is-primary'; keyTools.append(test, clear); connection.append(keyTools);
      const generation = group('生成参数', 'Generation');
      generation.classList.add('note-ai-generation');
      addField(generation, 'stream', '流式输出', 'Stream replies', 'checkbox');
      addField(generation, 'thinking', '思考模式', 'Thinking mode', '', [['auto', '跟随模型默认', 'Model default'], ['disabled', '关闭', 'Off'], ['enabled', '开启', 'On']]);
      addField(generation, 'effort', '思考强度', 'Thinking effort', '', [['low', '低 · low', 'Low'], ['high', '高 · high', 'High'], ['max', '最高 · max', 'Maximum']]);
      addField(generation, 'temperature', '温度', 'Temperature', 'number', null, { min: '0', max: '2', step: 'any' });
      addField(generation, 'topP', 'Top P', 'Top P', 'number', null, { min: '0', max: '1', step: 'any' });
      addField(generation, 'maxTokens', '最大输出 Token', 'Maximum output tokens', 'number', null, { min: '1', max: '393216', step: '1', placeholder: tr('自动 · 模型默认', 'Auto · model default') });
      addField(generation, 'timeout', '请求总超时（秒）', 'Total timeout (seconds)', 'number', null, { min: '1', max: '3600', step: '1' });
      const thinkingHint = document.createElement('p'); thinkingHint.dataset.aiThinkingHint = ''; generation.append(thinkingHint);
      const presetsGroup = group('系统提示词预设', 'System prompt presets');
      presetsGroup.classList.add('note-ai-preset-settings');
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
      const detail = document.createElement('p'); detail.dataset.aiPresetHint = ''; presetsGroup.append(detail);
      const status = document.createElement('p'); status.setAttribute('role', 'status'); status.dataset.aiSettingsStatus = ''; settingsHost.append(status);
      presetEditor();
      if (presetDraftName !== undefined && !name.readOnly) { name.value = presetDraftName; prompt.value = presetDraftPrompt; }
      choices.enhanceAll(); updateKeyHint(); updateThinkingHint();
    }
    async function settings() {
      settingsActive = true;
      try { await loadConfig(); if (settingsActive && !settingsBuilt) buildSettings(); }
      catch (error) { settingsHost.textContent = error.message; }
    }
    function closeSettings() {
      if (!settingsActive) return;
      settingsActive = false; settingsSequence++; keyRevealSequence++; clearKeyArmed = false;
      choices?.close();
      if (testRequest) { testRequest.controller.abort(); api('cancel', { requestId: testRequest.id }).catch(() => {}); testRequest = null; }
      settingsHost.querySelector('[data-ai-test]')?.removeAttribute('disabled');
      const clear = settingsHost.querySelector('[data-ai-clear-key]'); if (clear) clear.textContent = tr('清除 Key', 'Clear key');
      const key = settingsHost.querySelector('[data-ai-field="apiKey"]'); if (key) { acceptField(key); key.type = 'password'; if (!keyDirty) key.value = ''; }
      savePreset(); flushSettings().catch(() => {});
    }
    async function show() {
      if (visible) return;
      visible = true; const current = ++sequence;
      host.classList.remove('is-suspended');
      observer?.observe(body); observer?.observe(timeline);
      window.addEventListener('resize', resizeInput); reducedMotion.addEventListener('change', settleMotion);
      try {
        await loadConfig();
        if (!visible || current !== sequence) return;
        if (!session) newConversation(presetId);
        initialized = true; resizeInput(); renderMessages();
      } catch (error) { if (visible && current === sequence) { notice.textContent = error.message; suspend(); } }
      finally { if (initialized) input.disabled = send.disabled = plus.disabled = false; }
    }
    function suspend(keepalive = false) {
      visible = false; sequence++; renderEpoch++; stop(keepalive); cancelPaint();
      cancelAnimationFrame(layoutFrame); layoutFrame = 0; observer?.disconnect();
      window.removeEventListener('resize', resizeInput); reducedMotion.removeEventListener('change', settleMotion);
      host.classList.add('is-suspended');
      rows.forEach(row => {
        finishFold(row); clearTimeout(row._copyTimer); row._copyTimer = 0; resetCopy(row);
        [row._parts.reason, row._parts.content].forEach(surface => surface._blocks?.forEach(block => {
          if (block.state === 'queued') { block.job = null; block.state = 'new'; }
          if (block.stage) { clearMath(block.stage); block.stage.remove(); block.stage = null; }
        }));
      });
    }
    function setLanguage() {
      languageRevision++;
      plus.setAttribute('aria-label', tr('新建对话', 'New conversation')); plus.title = tr('新建对话', 'New conversation');
      bottom.setAttribute('aria-label', tr('回到底部', 'Jump to latest')); bottom.title = tr('回到底部', 'Jump to latest');
      input.placeholder = tr('输入消息…', 'Message…'); input.setAttribute('aria-label', tr('AI 消息', 'AI message'));
      updateSelectors(); renderMessages(); if (settingsBuilt) buildSettings();
    }
    window.addEventListener('pagehide', () => { pageHiding = true; const previous = session, operation = running; suspend(true); closeSettings(); discard(previous, operation, true); session = null; messages = []; presetId = 'none'; rows.forEach(releaseRow); rows.clear(); body.replaceChildren(); });
    window.addEventListener('pageshow', () => { pageHiding = false; });
    setLanguage();
    return { show, suspend, settings, closeSettings, setLanguage,
      async prepareSettings() { await loadConfig(); if (!settingsBuilt) buildSettings(); },
      async resetSettings() { await loadConfig(); savePreset(); await flushSettings(); config = await api('config', { reset: true }); settingsBuilt = false; settingsHost.replaceChildren(); buildSettings(); updateSelectors(); },
    };
  }
  window.RelatumNoteAI = { create };
})();
