(function () {
  'use strict';

  const root = document.querySelector('[data-role="review-view"]');
  if (!root) return;

  const PRAISE = {
    remembered: ['记得 ✦ 间隔又拉长一点', '记得 ✦ 这一下接得更牢', '记得 ✦ 稳了'],
    vague: ['模糊也没关系，过两天再见', '模糊 ✦ 留个印象就好', '模糊 ✦ 下次会更近一点'],
    forgot: ['不会很正常，下次再接一次', '没接上？再来一遍就好', '忘了也是一次复习，别急'],
  };
  const STATUS_LABELS = {
    active: '复习中',
    suspended: '已暂停',
    archived: '已归档',
  };

  const sessionEl = root.querySelector('[data-role="review-session"]');
  const libraryEl = root.querySelector('[data-role="review-library"]');
  const emptyEl = root.querySelector('[data-role="review-empty"]');
  const contentEl = root.querySelector('[data-role="review-content"]');
  const totalEl = root.querySelector('[data-role="review-total"]');
  const seenEl = root.querySelector('[data-role="review-seen"]');
  const totalLabelEl = root.querySelector('[data-role="review-total-label"]');
  const seenLabelEl = root.querySelector('[data-role="review-seen-label"]');
  const maturityEl = root.querySelector('[data-role="review-maturity"]');
  const countEl = root.querySelector('[data-role="review-count"]');
  const promptEl = root.querySelector('[data-role="review-prompt"]');
  const notesEl = root.querySelector('[data-role="review-notes"]');
  const draftEl = root.querySelector('[data-role="review-draft"]');
  const answerPillEl = root.querySelector('[data-role="review-answer-pill"]');
  const answerRevealEl = root.querySelector('[data-role="review-answer-reveal"]');
  const questionHintEl = root.querySelector('[data-role="review-question-hint"]');
  const nextLabelEl = root.querySelector('[data-role="review-next-label"]');
  const nextShortcutEl = root.querySelector('[data-role="review-next-shortcut"]');
  const cardDeckEl = root.querySelector('[data-role="review-card-deck"]');
  const cardTagsEl = root.querySelector('[data-role="review-card-tags"]');
  const scopeSelectEl = root.querySelector('[data-role="review-scope-select"]');
  const sessionProgressEl = root.querySelector('[data-role="review-session-progress"]');
  const libraryListEl = root.querySelector('[data-role="review-library-list"]');
  const libraryEmptyEl = root.querySelector('[data-role="review-library-empty"]');
  const libraryCountEl = root.querySelector('[data-role="review-library-count"]');
  const searchEl = root.querySelector('[data-role="review-search"]');
  const statusFilterButtons = Array.from(root.querySelectorAll('[data-action="review-status-filter"]'));
  const deckFilterSelectEl = root.querySelector('[data-role="review-deck-filter-select"]');
  const deckEditCurrentEl = root.querySelector('[data-role="review-deck-edit-current"]');
  const batchModeEl = root.querySelector('[data-role="review-batch-mode"]');
  const batchBarEl = root.querySelector('[data-role="review-batch-bar"]');
  const selectAllEl = root.querySelector('[data-role="review-select-all"]');
  const selectVisibleEl = root.querySelector('[data-role="review-select-visible"]');
  const selectedCountEl = root.querySelector('[data-role="review-selected-count"]');
  const batchDeckEl = root.querySelector('[data-role="review-batch-deck"]');
  const batchStatusEl = root.querySelector('[data-role="review-batch-status"]');
  const batchDeleteEl = root.querySelector('[data-role="review-batch-delete"]');
  const dialogEl = root.querySelector('[data-role="review-card-dialog"]');
  const formEl = root.querySelector('[data-role="review-card-form"]');
  const dialogTitleEl = root.querySelector('[data-role="review-dialog-title"]');
  const deleteEl = root.querySelector('[data-role="review-card-delete"]');
  const saveEl = root.querySelector('[data-role="review-card-save"]');
  const cardMoreEl = root.querySelector('[data-role="review-card-more"]');
  const cardDeckPickerEl = root.querySelector('[data-role="review-card-deck-picker"]');
  const cardDeckInputEl = root.querySelector('input[name="deckName"]');
  const cardDeckOptionsEl = root.querySelector('[data-role="review-card-deck-options"]');
  const cardDeckStateEl = root.querySelector('[data-role="review-card-deck-state"]');
  const deckDialogEl = root.querySelector('[data-role="review-deck-dialog"]');
  const deckFormEl = root.querySelector('[data-role="review-deck-form"]');
  const deckDialogTitleEl = root.querySelector('[data-role="review-deck-dialog-title"]');
  const deckDeleteEl = root.querySelector('[data-role="review-deck-delete"]');
  const deckSaveEl = root.querySelector('[data-role="review-deck-save"]');
  const settingsDialogEl = root.querySelector('[data-role="review-settings-dialog"]');
  const settingsFormEl = root.querySelector('[data-role="review-settings-form"]');
  const settingsSaveEl = root.querySelector('[data-role="review-settings-save"]');
  const helpDialogEl = root.querySelector('[data-role="review-help-dialog"]');
  const helpTitleEl = root.querySelector('[data-role="review-help-title"]');
  const scheduledHelpEl = root.querySelector('[data-role="review-help-scheduled"]');
  const freeHelpEl = root.querySelector('[data-role="review-help-free"]');
  const libraryHelpDialogEl = root.querySelector('[data-role="review-library-help-dialog"]');

  const REVIEW_MODE_KEY = 'canvas:reviewMode:v1';
  let pool = [];
  let libraryCards = [];
  let reviewDecks = [];
  let reviewScopes = [];
  let reviewSettings = {
    scopeMode: 'all', scopeDeckId: '', sessionLimit: 20,
    orderMode: 'due', requireReveal: false,
  };
  let uncategorizedCount = 0;
  let activeDeckFilter = 'all';
  let activeStatusFilter = 'all';
  let libraryBatchMode = false;
  const selectedCardIds = new Set();
  let visibleLibraryIds = [];
  let current = null;
  let dueCount = 0;
  let activeCount = 0;
  let reviewedToday = 0;
  let sessionInitialCount = 0;
  let sessionReviewedCount = 0;
  let answerRevealed = false;
  let loaded = false;
  let loadedDay = '';
  let loading = false;
  let preloadHandle = 0;
  let preloadUsesIdle = false;
  let preloadPromise = null;
  let libraryLoaded = false;
  let libraryRenderedDay = '';
  let libraryLoading = false;
  let marking = false;
  let celebratePulse = false;
  let reviewMode = storedReviewMode();
  let freeQueue = [];
  let freeCurrentId = '';
  let freeSeenCount = 0;
  let freeInitialized = false;
  let viewMode = 'session';
  let dialogCloseTimer = 0;
  let deckPickerCloseTimer = 0;
  let deckPickerItems = [];
  let deckPickerIndex = -1;
  let deleteArmTimer = 0;
  let deleteArmed = false;
  let deckDialogCloseTimer = 0;
  let deckDeleteArmTimer = 0;
  let deckDeleteArmed = false;
  let batchDeleteArmTimer = 0;
  let batchDeleteArmed = false;
  let batchBarCloseTimer = 0;
  let panelTransitionTimer = 0;
  let libraryFilterTimer = 0;
  let libraryItemEnterTimer = 0;
  let libraryEmptyEnterTimer = 0;
  let settingsDialogCloseTimer = 0;
  let helpDialogCloseTimer = 0;
  let libraryHelpDialogCloseTimer = 0;
  let mathQueue = Promise.resolve();
  const pendingMathElements = new Set();
  let mathReadyTimer = 0;
  let mathReadyTries = 0;
  let mathLoadHandle = 0;
  let mathLoadUsesIdle = false;

  function tr(source) {
    if (window.RelatumI18n && typeof window.RelatumI18n.t === 'function') {
      return window.RelatumI18n.t(source);
    }
    return source;
  }

  function todayStr() {
    const d = new Date();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + month + '-' + day;
  }

  function storedReviewMode() {
    try {
      return localStorage.getItem(REVIEW_MODE_KEY) === 'free' ? 'free' : 'scheduled';
    } catch (error) {
      return 'scheduled';
    }
  }

  function persistReviewMode() {
    try { localStorage.setItem(REVIEW_MODE_KEY, reviewMode); } catch (error) {}
  }

  function toast(message) {
    const el = document.querySelector('[data-role="study-toast"]') || document.querySelector('[data-role="toast"]');
    if (!el) return;
    el.textContent = tr(message);
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function readJson(url) {
    const resp = await fetch(url);
    const json = await resp.json();
    if (!resp.ok) throw new Error((json && json.error) || '请求失败');
    return json;
  }

  async function post(url, payload) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error((json && json.error) || '请求失败');
    return json;
  }

  function ensureMathJax() {
    if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') return;
    if (document.querySelector('script[data-review-mathjax]') || mathLoadHandle) return;
    if (!window.MathJax || typeof window.MathJax !== 'object') {
      window.MathJax = {
        tex: {
          inlineMath: [['$', '$'], ['\\(', '\\)']],
          displayMath: [['$$', '$$'], ['\\[', '\\]']],
          processEscapes: true,
          tags: 'ams',
        },
        startup: { typeset: false },
      };
    }
    const load = function () {
      mathLoadHandle = 0;
      if (document.querySelector('script[data-review-mathjax]')) return;
      const script = document.createElement('script');
      script.src = 'vendor/mathjax/tex-mml-chtml.js';
      script.async = true;
      script.dataset.reviewMathjax = '1';
      script.addEventListener('error', function () { console.warn('[复习] MathJax 加载失败'); });
      document.head.appendChild(script);
    };
    mathLoadUsesIdle = typeof window.requestIdleCallback === 'function';
    mathLoadHandle = mathLoadUsesIdle
      ? window.requestIdleCallback(load, { timeout: 1200 })
      : window.setTimeout(load, 200);
  }

  function cancelMathLoadSchedule() {
    if (!mathLoadHandle) return;
    if (mathLoadUsesIdle && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(mathLoadHandle);
    } else {
      window.clearTimeout(mathLoadHandle);
    }
    mathLoadHandle = 0;
  }

  function queueWhenMathReady(el) {
    pendingMathElements.add(el);
    if (mathReadyTimer) return;
    const poll = function () {
      mathReadyTimer = 0;
      if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
        const elements = Array.from(pendingMathElements);
        pendingMathElements.clear();
        mathReadyTries = 0;
        elements.forEach(function (pending) {
          if (pending && pending.isConnected) typeset(pending);
        });
        return;
      }
      if (mathReadyTries++ >= 60) {
        pendingMathElements.clear();
        mathReadyTries = 0;
        return;
      }
      mathReadyTimer = window.setTimeout(poll, 150);
    };
    poll();
  }

  function cancelMathReadyWait() {
    if (mathReadyTimer) window.clearTimeout(mathReadyTimer);
    mathReadyTimer = 0;
    mathReadyTries = 0;
    pendingMathElements.clear();
  }

  function typeset(el) {
    if (!el) return;
    const mj = window.MathJax;
    if (!mj || typeof mj.typesetPromise !== 'function') {
      ensureMathJax();
      queueWhenMathReady(el);
      return;
    }
    mathQueue = mathQueue.then(function () {
      try {
        if (typeof mj.typesetClear === 'function') mj.typesetClear([el]);
        if (typeof mj.texReset === 'function') mj.texReset();
      } catch (error) {}
      return mj.typesetPromise([el]);
    }).catch(function () {});
  }

  function hasMathSource(text) {
    const markdown = window.MarkdownMini;
    if (markdown && markdown.structure && typeof markdown.structure.scanFeatures === 'function') {
      return markdown.structure.scanFeatures(text || '').math;
    }
    return /(?:\$|\\\(|\\\[|\\begin\{|\\ref\{|\\eqref\{)/.test(text || '');
  }

  function renderRich(el, source) {
    if (!el) return false;
    const text = String(source == null ? '' : source);
    const mj = window.MathJax;
    if (mj && typeof mj.typesetClear === 'function') {
      try { mj.typesetClear([el]); } catch (error) {}
    }
    if (!text.trim()) {
      el.innerHTML = '';
      return false;
    }
    let rendered = null;
    if (window.MarkdownMini && typeof window.MarkdownMini.render === 'function') {
      rendered = typeof window.MarkdownMini.renderResult === 'function'
        ? window.MarkdownMini.renderResult(text) : null;
      el.innerHTML = rendered ? rendered.html : window.MarkdownMini.render(text);
    } else {
      el.textContent = text;
    }
    if (rendered ? rendered.features.math : hasMathSource(text)) typeset(el);
    if ((!rendered || rendered.features.mermaid) && window.MermaidRenderer) {
      window.MermaidRenderer.renderAll(el);
    }
    return true;
  }

  function replay(el, className) {
    if (!el) return;
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
  }

  function clearTransientMotion() {
    clearTimeout(libraryItemEnterTimer);
    clearTimeout(libraryEmptyEnterTimer);
    libraryItemEnterTimer = 0;
    libraryEmptyEnterTimer = 0;
    if (libraryEmptyEl) libraryEmptyEl.classList.remove('empty-enter');
    if (libraryListEl) {
      libraryListEl.querySelectorAll('.item-enter').forEach((item) => {
        item.classList.remove('item-enter');
      });
    }
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function floatPlusOne() {
    if (!seenEl || !seenEl.parentElement) return;
    const chip = document.createElement('span');
    chip.className = 'review-plus-one';
    chip.textContent = '+1';
    seenEl.parentElement.appendChild(chip);
    setTimeout(() => chip.remove(), 950);
  }

  function praise(rating, wrote) {
    const lines = PRAISE[rating] || ['已记录'];
    let message = lines[Math.floor(Math.random() * lines.length)];
    if (wrote) message = '写下来了 ✦ ' + message;
    toast(message);
  }

  function isDue(card) {
    return !!card && (!card.due || card.due <= todayStr());
  }

  function dueCards() {
    return pool.filter(isDue);
  }

  function freeEligibleCards() {
    return libraryCards.filter((card) => {
      if (card.status !== 'active') return false;
      if (reviewSettings.scopeMode === 'unfiled') return !card.deckId;
      if (reviewSettings.scopeMode === 'deck') return card.deckId === reviewSettings.scopeDeckId;
      return true;
    });
  }

  function updateStats() {
    const free = reviewMode === 'free' && viewMode === 'session';
    if (totalEl) totalEl.textContent = String(free ? freeEligibleCards().length : Math.max(0, dueCount));
    if (seenEl) seenEl.textContent = String(free ? freeSeenCount : Math.max(0, reviewedToday));
    if (totalLabelEl) totalLabelEl.textContent = tr(free ? '范围卡片' : '待复习');
    if (seenLabelEl) seenLabelEl.textContent = tr(free ? '自由浏览' : '今日复习');
  }

  function updateSessionProgress() {
    if (!sessionProgressEl) return;
    if (reviewMode === 'free') {
      sessionProgressEl.textContent = tr('随机 · 无限');
      return;
    }
    if (!sessionInitialCount) {
      sessionProgressEl.textContent = tr('本轮 0 / 0');
      return;
    }
    const position = current
      ? Math.min(sessionInitialCount, sessionReviewedCount + 1)
      : Math.min(sessionInitialCount, sessionReviewedCount);
    sessionProgressEl.textContent = tr('本轮') + ' ' + position + ' / ' + sessionInitialCount;
  }

  function updateRatingGate() {
    const ratingDisabled = marking || !current || reviewMode === 'free';
    root.querySelectorAll('[data-action="review-remembered"], [data-action="review-vague"], [data-action="review-forgot"]')
      .forEach((button) => { button.disabled = ratingDisabled; });
    root.querySelectorAll('[data-action="review-next"]')
      .forEach((button) => { button.disabled = marking || !current; });
  }

  function syncScopeSelect() {
    if (!scopeSelectEl) return;
    scopeSelectEl.innerHTML = '';
    reviewScopes.forEach((scope) => {
      const value = scope.mode === 'deck' ? ('deck:' + scope.deckId) : scope.mode;
      const name = scope.mode === 'deck' ? scope.name : tr(scope.name);
      const count = reviewMode === 'free' ? scope.activeCount : scope.dueCount;
      addDeckOption(scopeSelectEl, value, name + ' · ' + Math.max(0, Number(count) || 0));
    });
    const currentValue = reviewSettings.scopeMode === 'deck'
      ? ('deck:' + reviewSettings.scopeDeckId)
      : reviewSettings.scopeMode;
    scopeSelectEl.value = Array.from(scopeSelectEl.options).some((option) => option.value === currentValue)
      ? currentValue : 'all';
  }

  function resetAnswerReveal(card) {
    answerRevealed = false;
    const hasAnswer = !!(card && String(card.answer || '').trim());
    if (answerPillEl) {
      answerPillEl.hidden = !hasAnswer;
      answerPillEl.textContent = tr('查看答案');
    }
    if (answerRevealEl) {
      answerRevealEl.hidden = true;
      answerRevealEl.innerHTML = '';
    }
    updateRatingGate();
  }

  function toggleAnswer() {
    if (!current || !answerRevealEl || !answerPillEl) return;
    const answer = String(current.answer || '').trim();
    if (!answer) return;
    if (answerRevealEl.hidden) {
      renderRich(answerRevealEl, answer);
      answerRevealEl.hidden = false;
      answerRevealed = true;
      replay(answerRevealEl, 'reveal-in');
      answerPillEl.textContent = tr('收起答案');
    } else {
      answerRevealEl.hidden = true;
      answerRevealed = false;
      answerPillEl.textContent = tr('查看答案');
    }
    updateRatingGate();
  }

  function renderEmpty() {
    if (!emptyEl) return;
    emptyEl.hidden = false;
    if (reviewMode === 'free') {
      emptyEl.classList.remove('celebrate');
      const hasAnyActive = libraryCards.some((card) => card.status === 'active');
      if (hasAnyActive) {
        emptyEl.innerHTML = '<strong>' + tr('这个范围没有可自由复习的卡片') + '</strong>'
          + '<span>' + tr('换一个复习范围，或到卡片库恢复一些卡片。') + '</span>';
      } else {
        emptyEl.innerHTML = '<strong>' + tr('还没有正在复习的卡片') + '</strong>'
          + '<span>' + tr('直接在这里创建卡片，不需要先创建画布。') + '</span>'
          + '<button type="button" class="review-empty-cta" data-action="review-card-new">'
          + tr('创建第一张卡片') + '</button>';
      }
      updateStats();
      updateSessionProgress();
      updateRatingGate();
      return;
    }
    const freeButton = activeCount > 0
      ? '<button type="button" class="review-empty-cta" data-action="review-show-free">'
        + tr('进入自由复习 →') + '</button>'
      : '';
    if (sessionReviewedCount > 0 && dueCount > 0) {
      emptyEl.classList.remove('celebrate');
      const remaining = tr('还有 {count} 张到期卡片，可以休息一下，也可以再开一轮。')
        .replace('{count}', String(dueCount));
      emptyEl.innerHTML = '<strong>' + tr('这一轮完成了') + '</strong>'
        + '<span>' + remaining + '</span>'
        + '<button type="button" class="review-empty-cta" data-action="review-session-again">'
        + tr('再来一轮') + '</button>';
    } else if (reviewedToday > 0 && activeCount > 0) {
      const spark = celebratePulse
        ? '<div class="review-spark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>'
        : '';
      emptyEl.classList.add('celebrate');
      emptyEl.innerHTML = spark
        + '<strong>今天的复习做完了</strong>'
        + '<span>今天复习了 ' + reviewedToday + ' 张 ✦ 想继续练习，可以切到自由复习。</span>'
        + freeButton;
      if (celebratePulse) replay(emptyEl, 'celebrate-in');
    } else if (activeCount > 0) {
      emptyEl.classList.remove('celebrate');
      emptyEl.innerHTML = '<strong>今天没有到期的卡片</strong>'
        + '<span>都按计划复习过了；自由复习仍可随时随机练习。</span>'
        + freeButton;
    } else {
      emptyEl.classList.remove('celebrate');
      emptyEl.innerHTML = '<strong>还没有正在复习的卡片</strong>'
        + '<span>直接在这里创建卡片，不需要先创建画布。</span>'
        + '<button type="button" class="review-empty-cta" data-action="review-card-new">创建第一张卡片</button>';
    }
    updateSessionProgress();
    updateRatingGate();
  }

  function renderCard(card) {
    current = card || null;
    updateStats();
    if (!current) {
      renderEmpty();
      if (contentEl) contentEl.hidden = true;
      if (cardDeckEl) cardDeckEl.hidden = true;
      if (cardTagsEl) cardTagsEl.hidden = true;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (contentEl) {
      contentEl.hidden = false;
      contentEl.scrollTop = 0;
    }
    if (maturityEl) {
      maturityEl.textContent = current.maturity || '生';
      maturityEl.dataset.maturity = current.maturity || '生';
    }
    if (countEl) {
      const count = Number(current.reviewCount || 0);
      countEl.textContent = count > 0 ? ('已复习 ' + count + ' 次') : '尚未复习';
    }
    if (cardDeckEl) {
      cardDeckEl.hidden = !current.deckName;
      cardDeckEl.textContent = current.deckName ? (tr('卡组') + ' · ' + current.deckName) : '';
    }
    if (cardTagsEl) {
      const tags = Array.isArray(current.tags) ? current.tags : [];
      cardTagsEl.hidden = tags.length === 0;
      cardTagsEl.textContent = tags.length ? tags.map((tag) => '#' + tag).join(' · ') : '';
    }
    if (promptEl) promptEl.textContent = current.prompt || '未命名问题';
    if (questionHintEl) {
      questionHintEl.textContent = tr(reviewMode === 'free'
        ? '想好后查看答案核对，或直接换到下一张。'
        : '想好后可以直接评分，也可以查看答案再核对。');
    }
    if (nextLabelEl) nextLabelEl.textContent = tr(reviewMode === 'free' ? '下一张' : '再来一张');
    if (nextShortcutEl) nextShortcutEl.textContent = reviewMode === 'free' ? 'N / D' : 'N';
    if (notesEl) notesEl.hidden = !renderRich(notesEl, current.notes);
    if (draftEl) draftEl.value = '';
    resetAnswerReveal(current);
    updateSessionProgress();
  }

  function nextCard() {
    const due = dueCards();
    if (!due.length) {
      renderCard(null);
      return;
    }
    renderCard(due[0]);
  }

  function resetFreeSession() {
    freeQueue = [];
    freeCurrentId = '';
    freeSeenCount = 0;
    freeInitialized = false;
  }

  function refillFreeQueue(cards) {
    const ids = cards.map((card) => card.id);
    for (let index = ids.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      const value = ids[index];
      ids[index] = ids[swapIndex];
      ids[swapIndex] = value;
    }
    if (ids.length > 1 && ids[0] === freeCurrentId) {
      const value = ids[0];
      ids[0] = ids[1];
      ids[1] = value;
    }
    freeQueue = ids;
  }

  function nextFreeCard() {
    const cards = freeEligibleCards();
    const byId = new Map(cards.map((card) => [card.id, card]));
    freeQueue = freeQueue.filter((id) => byId.has(id));
    if (!cards.length) {
      freeCurrentId = '';
      current = null;
      renderCard(null);
      return;
    }
    if (!freeQueue.length) refillFreeQueue(cards);
    const nextId = freeQueue.shift();
    const next = byId.get(nextId) || cards[0];
    freeCurrentId = next.id;
    freeSeenCount += 1;
    freeInitialized = true;
    renderCard(next);
    if (seenEl && freeSeenCount > 1) replay(seenEl, 'bump');
  }

  async function ensureFreeReview(reset) {
    const concealLoading = !libraryLoaded;
    if (concealLoading) root.classList.add('is-pool-loading');
    try {
      const ok = await loadLibrary(false);
      if (!ok) return false;
      if (viewMode !== 'session' || reviewMode !== 'free') return true;
      if (reset) resetFreeSession();
      const preserved = !reset && freeInitialized
        ? freeEligibleCards().find((card) => card.id === freeCurrentId)
        : null;
      if (preserved) renderCard(preserved);
      else nextFreeCard();
      return true;
    } finally {
      if (concealLoading) root.classList.remove('is-pool-loading');
    }
  }

  function skipCard() {
    if (marking || !current) return;
    if (reviewMode === 'free') {
      nextFreeCard();
      return;
    }
    if (pool.length < 2) return;
    const index = pool.findIndex((card) => card.id === current.id);
    if (index >= 0) pool.push(pool.splice(index, 1)[0]);
    nextCard();
  }

  async function loadPool(force) {
    const currentDay = todayStr();
    if (loaded && !force && loadedDay === currentDay) return true;
    if (loading) return false;
    const concealInitialState = !loaded;
    if (concealInitialState) root.classList.add('is-pool-loading');
    loading = true;
    try {
      const pendingPreload = !force ? takePreload() : null;
      const json = await (pendingPreload || readJson('/api/review-pool'));
      pool = Array.isArray(json.cards) ? json.cards : [];
      reviewSettings = Object.assign({}, reviewSettings, json.settings || {});
      reviewSettings.requireReveal = false;
      reviewScopes = Array.isArray(json.scopes) ? json.scopes : [];
      dueCount = Number.isFinite(json.dueCount) ? json.dueCount : dueCards().length;
      activeCount = Number.isFinite(json.count) ? json.count : pool.length;
      reviewedToday = Number.isFinite(json.reviewedToday) ? json.reviewedToday : 0;
      sessionReviewedCount = 0;
      sessionInitialCount = dueCards().length;
      syncScopeSelect();
      loaded = true;
      loadedDay = String(json.generatedAt || '').slice(0, 10) || todayStr();
      if (viewMode !== 'session') {
        updateStats();
        updateSessionProgress();
      } else if (reviewMode === 'free') {
        updateStats();
        updateSessionProgress();
      } else {
        nextCard();
      }
      return true;
    } catch (error) {
      toast((error && error.message) || '加载复习卡片失败');
      renderCard(null);
      return false;
    } finally {
      loading = false;
      if (concealInitialState) root.classList.remove('is-pool-loading');
    }
  }

  function cancelPreload() {
    if (!preloadHandle) return;
    if (preloadUsesIdle && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(preloadHandle);
    } else {
      window.clearTimeout(preloadHandle);
    }
    preloadHandle = 0;
    preloadUsesIdle = false;
  }

  function takePreload() {
    cancelPreload();
    if (!preloadPromise) return null;
    const pending = preloadPromise;
    preloadPromise = null;
    return pending.then((json) => json || readJson('/api/review-pool'));
  }

  // 空闲时只缓存卡池 JSON；真正进入复习页后再生成卡片并按需加载公式运行时。
  function schedulePreload() {
    if (preloadHandle || preloadPromise || loaded) return;
    const warm = () => {
      preloadHandle = 0;
      preloadUsesIdle = false;
      preloadPromise = readJson('/api/review-pool').catch(() => null);
    };
    preloadUsesIdle = typeof window.requestIdleCallback === 'function';
    preloadHandle = preloadUsesIdle
      ? window.requestIdleCallback(warm, { timeout: 1500 })
      : window.setTimeout(warm, 600);
  }

  async function mark(rating) {
    if (!current || marking || reviewMode === 'free') return;
    const marked = current;
    const wrote = !!(draftEl && draftEl.value.trim());
    marking = true;
    updateRatingGate();
    try {
      const json = await post('/api/review-mark', { cardId: marked.id, rating: rating });
      const updated = json.card || marked;
      reviewedToday += 1;
      sessionReviewedCount += 1;
      if (isDue(marked)) dueCount = Math.max(0, dueCount - 1);
      pool = pool.filter((card) => card.id !== marked.id);
      libraryCards = libraryCards.map((card) => card.id === marked.id ? updated : card);
      if (seenEl) replay(seenEl, 'bump');
      floatPlusOne();
      praise(rating, wrote);
      celebratePulse = true;
      nextCard();
      celebratePulse = false;
      if (libraryLoaded && viewMode === 'library') renderLibrary(false);
    } catch (error) {
      toast((error && error.message) || '标记失败');
    } finally {
      marking = false;
      updateRatingGate();
    }
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] || STATUS_LABELS.active;
  }

  function dueLabel(card) {
    if (!card.due) return '未安排';
    if (isDue(card)) return '今天到期';
    return '下次 ' + card.due;
  }

  function deckById(deckId) {
    return reviewDecks.find((deck) => deck.id === deckId) || null;
  }

  function deckNameKey(value) {
    return String(value || '').trim().toLocaleLowerCase();
  }

  function deckByName(name) {
    const key = deckNameKey(name);
    if (!key) return null;
    return reviewDecks.find((deck) => deckNameKey(deck.name) === key) || null;
  }

  function syncDeckPickerState() {
    if (!cardDeckInputEl || !cardDeckPickerEl || !cardDeckStateEl) return;
    const name = String(cardDeckInputEl.value || '').trim();
    const existing = deckByName(name);
    cardDeckPickerEl.classList.toggle('is-existing', Boolean(name && existing));
    cardDeckPickerEl.classList.toggle('is-new', Boolean(name && !existing));
    cardDeckStateEl.hidden = !name;
    cardDeckStateEl.textContent = name ? tr(existing ? '已有' : '新建') : '';
  }

  function syncDeckPickerActiveOption() {
    if (!cardDeckInputEl || !cardDeckOptionsEl) return;
    const options = Array.from(cardDeckOptionsEl.querySelectorAll('[role="option"]'));
    options.forEach((option, index) => {
      const active = index === deckPickerIndex;
      option.classList.toggle('is-active', active);
      option.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const active = options[deckPickerIndex];
    if (active) cardDeckInputEl.setAttribute('aria-activedescendant', active.id);
    else cardDeckInputEl.removeAttribute('aria-activedescendant');
  }

  function renderDeckPickerOptions() {
    if (!cardDeckInputEl || !cardDeckOptionsEl) return;
    const query = String(cardDeckInputEl.value || '').trim();
    const key = deckNameKey(query);
    const matches = reviewDecks
      .filter((deck) => !key || deckNameKey(deck.name).includes(key))
      .sort((left, right) => {
        const leftKey = deckNameKey(left.name);
        const rightKey = deckNameKey(right.name);
        const leftRank = leftKey === key ? 0 : (leftKey.startsWith(key) ? 1 : 2);
        const rightRank = rightKey === key ? 0 : (rightKey.startsWith(key) ? 1 : 2);
        return leftRank - rightRank;
      })
      .slice(0, 7);
    const exact = deckByName(query);
    deckPickerItems = [];
    if (!query) deckPickerItems.push({ kind: 'unfiled', name: '' });
    matches.forEach((deck) => deckPickerItems.push({ kind: 'deck', name: deck.name }));
    if (query && !exact) deckPickerItems.push({ kind: 'create', name: query });
    if (query) deckPickerItems.push({ kind: 'unfiled', name: '' });

    cardDeckOptionsEl.innerHTML = '';
    deckPickerItems.forEach((item, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.id = 'review-card-deck-option-' + index;
      option.className = 'review-card-deck-option';
      option.setAttribute('role', 'option');
      option.dataset.deckPickerIndex = String(index);

      const label = document.createElement('span');
      const note = document.createElement('small');
      if (item.kind === 'deck') {
        label.textContent = item.name;
        note.textContent = tr('已有卡组');
      } else if (item.kind === 'create') {
        label.textContent = tr('新建卡组') + ' “' + item.name + '”';
        note.textContent = tr('保存卡片时创建');
      } else {
        label.textContent = tr('未分类');
        note.textContent = tr('留空保存');
      }
      option.append(label, note);
      cardDeckOptionsEl.appendChild(option);
    });
    deckPickerIndex = deckPickerItems.length ? 0 : -1;
    syncDeckPickerActiveOption();
  }

  function openDeckPicker() {
    if (!cardDeckInputEl || !cardDeckOptionsEl) return;
    clearTimeout(deckPickerCloseTimer);
    renderDeckPickerOptions();
    cardDeckOptionsEl.hidden = false;
    cardDeckInputEl.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => cardDeckOptionsEl.classList.add('show'));
  }

  function closeDeckPicker() {
    if (!cardDeckInputEl || !cardDeckOptionsEl) return;
    clearTimeout(deckPickerCloseTimer);
    cardDeckOptionsEl.classList.remove('show');
    cardDeckInputEl.setAttribute('aria-expanded', 'false');
    cardDeckInputEl.removeAttribute('aria-activedescendant');
    deckPickerCloseTimer = window.setTimeout(() => {
      if (!cardDeckOptionsEl.classList.contains('show')) cardDeckOptionsEl.hidden = true;
    }, 150);
  }

  function chooseDeckPickerItem(index) {
    const item = deckPickerItems[index];
    if (!item || !cardDeckInputEl) return;
    cardDeckInputEl.value = item.kind === 'unfiled' ? '' : item.name;
    syncDeckPickerState();
    closeDeckPicker();
    cardDeckInputEl.focus();
  }

  function addDeckOption(select, value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }

  function syncLibraryOrganizers() {
    if (activeDeckFilter !== 'all' && activeDeckFilter !== '__none__' && !deckById(activeDeckFilter)) {
      activeDeckFilter = 'all';
    }
    if (deckFilterSelectEl) {
      deckFilterSelectEl.innerHTML = '';
      addDeckOption(deckFilterSelectEl, 'all', tr('全部卡组'));
      addDeckOption(deckFilterSelectEl, '__none__', tr('未分类') + ' · ' + uncategorizedCount);
      reviewDecks.forEach((deck) => {
        addDeckOption(deckFilterSelectEl, deck.id, deck.name + ' · ' + deck.count);
      });
      deckFilterSelectEl.value = activeDeckFilter;
    }
    if (deckEditCurrentEl) deckEditCurrentEl.hidden = !deckById(activeDeckFilter);
    statusFilterButtons.forEach((button) => {
      const active = button.dataset.status === activeStatusFilter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (libraryEl) libraryEl.classList.toggle('is-batch-mode', libraryBatchMode);
    if (selectVisibleEl) selectVisibleEl.hidden = !libraryBatchMode;
    if (batchModeEl) {
      batchModeEl.classList.toggle('is-active', libraryBatchMode);
      batchModeEl.textContent = tr(libraryBatchMode ? '完成整理' : '批量整理');
      batchModeEl.setAttribute('aria-pressed', libraryBatchMode ? 'true' : 'false');
    }
    syncDeckPickerState();
    if (batchDeckEl) {
      batchDeckEl.innerHTML = '';
      addDeckOption(batchDeckEl, '__keep__', tr('移动到卡组…'));
      addDeckOption(batchDeckEl, '', tr('未分类'));
      reviewDecks.forEach((deck) => addDeckOption(batchDeckEl, deck.id, deck.name));
      batchDeckEl.value = '__keep__';
    }
    if (batchStatusEl) batchStatusEl.value = '__keep__';
  }

  function filteredLibraryCards() {
    const query = String((searchEl && searchEl.value) || '').trim().toLocaleLowerCase();
    return libraryCards.filter((card) => {
      if (activeStatusFilter !== 'all' && card.status !== activeStatusFilter) return false;
      if (activeDeckFilter === '__none__' && card.deckId) return false;
      if (activeDeckFilter !== 'all' && activeDeckFilter !== '__none__' && card.deckId !== activeDeckFilter) return false;
      const tags = Array.isArray(card.tags) ? card.tags : [];
      if (!query) return true;
      return [card.prompt, card.answer, card.notes, card.deckName, ...tags]
        .some((value) => String(value || '').toLocaleLowerCase().includes(query));
    });
  }

  function updateBatchBar() {
    const selectedCount = selectedCardIds.size;
    if (batchBarEl) {
      clearTimeout(batchBarCloseTimer);
      if (!libraryBatchMode) {
        batchBarEl.hidden = true;
        batchBarEl.classList.remove('batch-enter', 'is-leaving');
      } else if (selectedCount > 0) {
        const wasHidden = batchBarEl.hidden;
        batchBarEl.hidden = false;
        batchBarEl.classList.remove('is-leaving');
        if (wasHidden && !reducedMotion()) replay(batchBarEl, 'batch-enter');
      } else if (!batchBarEl.hidden && !reducedMotion()) {
        batchBarEl.classList.remove('batch-enter');
        batchBarEl.classList.add('is-leaving');
        batchBarCloseTimer = window.setTimeout(() => {
          if (!selectedCardIds.size) batchBarEl.hidden = true;
          batchBarEl.classList.remove('is-leaving');
        }, 130);
      } else {
        batchBarEl.hidden = true;
      }
    }
    if (selectedCountEl) selectedCountEl.textContent = String(selectedCount);
    if (selectAllEl) {
      const selectedVisible = visibleLibraryIds.filter((id) => selectedCardIds.has(id)).length;
      selectAllEl.checked = visibleLibraryIds.length > 0 && selectedVisible === visibleLibraryIds.length;
      selectAllEl.indeterminate = selectedVisible > 0 && selectedVisible < visibleLibraryIds.length;
      selectAllEl.disabled = !libraryBatchMode || visibleLibraryIds.length === 0;
    }
    if (!selectedCount) {
      batchDeleteArmed = false;
      clearTimeout(batchDeleteArmTimer);
      if (batchDeleteEl) batchDeleteEl.textContent = tr('删除所选');
    }
  }

  function renderLibrary(animateItems) {
    if (!libraryListEl || !libraryEmptyEl) return;
    const existingIds = new Set(libraryCards.map((card) => card.id));
    Array.from(selectedCardIds).forEach((id) => { if (!existingIds.has(id)) selectedCardIds.delete(id); });
    const filtered = filteredLibraryCards();
    visibleLibraryIds = filtered.map((card) => card.id);
    if (libraryCountEl) libraryCountEl.textContent = String(libraryCards.length);
    libraryListEl.innerHTML = '';
    const fragment = document.createDocumentFragment();
    filtered.forEach((card, index) => {
      const item = document.createElement('article');
      item.className = 'review-library-item';
      item.dataset.cardId = card.id;
      item.classList.toggle('is-selected', selectedCardIds.has(card.id));
      if (index < 12) {
        item.classList.add('stagger-slot');
        item.style.setProperty('--review-item-delay', (Math.min(index, 8) * 14) + 'ms');
      }
      if (animateItems && index < 12 && !reducedMotion()) {
        item.classList.add('item-enter');
      }

      const select = document.createElement('input');
      select.type = 'checkbox';
      select.className = 'review-library-select';
      select.dataset.role = 'review-card-select';
      select.dataset.cardId = card.id;
      select.checked = selectedCardIds.has(card.id);
      select.setAttribute('aria-label', tr('选择卡片') + '：' + (card.prompt || tr('未命名问题')));

      const copy = document.createElement('div');
      copy.className = 'review-library-copy';
      const title = document.createElement('strong');
      title.dataset.userContent = '1';
      title.textContent = card.prompt || tr('未命名问题');
      const summary = document.createElement('p');
      summary.dataset.userContent = '1';
      summary.textContent = card.answer || card.notes || tr('还没有填写答案或说明');
      const meta = document.createElement('div');
      meta.className = 'review-library-meta';
      const statusChip = document.createElement('span');
      statusChip.className = card.status === 'active' ? 'is-active' : (card.status === 'suspended' ? 'is-suspended' : '');
      statusChip.textContent = tr(statusLabel(card.status));
      const dueChip = document.createElement('span');
      dueChip.textContent = tr(dueLabel(card));
      meta.append(statusChip, dueChip);
      if (card.deckName) {
        const deckChip = document.createElement('span');
        deckChip.className = 'is-deck';
        deckChip.textContent = card.deckName;
        meta.appendChild(deckChip);
      }
      (Array.isArray(card.tags) ? card.tags : []).slice(0, 2).forEach((tag) => {
        const tagChip = document.createElement('span');
        tagChip.className = 'is-tag';
        tagChip.textContent = '#' + tag;
        meta.appendChild(tagChip);
      });
      copy.append(title, summary, meta);

      const actions = document.createElement('div');
      actions.className = 'review-library-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'review-library-action';
      edit.dataset.action = 'review-card-edit';
      edit.dataset.cardId = card.id;
      edit.textContent = tr('编辑');
      actions.append(edit);
      item.append(select, copy, actions);
      fragment.appendChild(item);
    });
    libraryListEl.appendChild(fragment);
    clearTimeout(libraryItemEnterTimer);
    if (animateItems && !reducedMotion()) {
      libraryItemEnterTimer = window.setTimeout(() => {
        libraryListEl.querySelectorAll('.item-enter').forEach((item) => {
          item.classList.remove('item-enter');
        });
        libraryItemEnterTimer = 0;
      }, 470);
    } else {
      libraryItemEnterTimer = 0;
    }
    libraryRenderedDay = todayStr();
    const wasEmptyHidden = libraryEmptyEl.hidden;
    libraryEmptyEl.hidden = filtered.length > 0;
    clearTimeout(libraryEmptyEnterTimer);
    if (!filtered.length && wasEmptyHidden && !reducedMotion()) {
      replay(libraryEmptyEl, 'empty-enter');
      libraryEmptyEnterTimer = window.setTimeout(() => {
        libraryEmptyEl.classList.remove('empty-enter');
        libraryEmptyEnterTimer = 0;
      }, 240);
    } else {
      libraryEmptyEl.classList.remove('empty-enter');
      libraryEmptyEnterTimer = 0;
    }
    updateBatchBar();
  }

  function syncRenderedSelection() {
    if (!libraryListEl) return;
    libraryListEl.querySelectorAll('[data-role="review-card-select"]').forEach((input) => {
      const selected = selectedCardIds.has(input.dataset.cardId);
      input.checked = selected;
      const item = input.closest('.review-library-item');
      if (item) item.classList.toggle('is-selected', selected);
    });
    updateBatchBar();
  }

  function scheduleLibraryFilterRender() {
    clearTimeout(libraryFilterTimer);
    libraryFilterTimer = window.setTimeout(() => {
      libraryFilterTimer = 0;
      renderLibrary(false);
    }, 80);
  }

  async function loadLibrary(force, animateItems) {
    if (libraryLoading) return false;
    if (libraryLoaded && !force) {
      if (viewMode === 'library' && libraryRenderedDay !== todayStr()) renderLibrary(false);
      return true;
    }
    libraryLoading = true;
    try {
      const json = await readJson('/api/review-cards');
      libraryCards = Array.isArray(json.cards) ? json.cards : [];
      reviewDecks = Array.isArray(json.decks) ? json.decks : [];
      uncategorizedCount = Number(json.uncategorizedCount || 0);
      libraryLoaded = true;
      if (force) resetFreeSession();
      syncLibraryOrganizers();
      if (viewMode === 'library') renderLibrary(animateItems !== false);
      return true;
    } catch (error) {
      toast((error && error.message) || '加载卡片库失败');
      return false;
    } finally {
      libraryLoading = false;
    }
  }

  function transitionModePanels(nextMode) {
    if (!sessionEl || !libraryEl) return;
    const incoming = nextMode === 'library' ? libraryEl : sessionEl;
    const outgoing = nextMode === 'library' ? sessionEl : libraryEl;
    clearTimeout(panelTransitionTimer);
    sessionEl.classList.remove('panel-enter', 'panel-leave');
    libraryEl.classList.remove('panel-enter', 'panel-leave');
    if (nextMode === viewMode || reducedMotion()) {
      sessionEl.hidden = nextMode !== 'session';
      libraryEl.hidden = nextMode !== 'library';
      delete root.dataset.reviewTransition;
      return;
    }
    root.dataset.reviewTransition = nextMode;
    incoming.hidden = false;
    outgoing.hidden = false;
    outgoing.classList.add('panel-leave');
    replay(incoming, 'panel-enter');
    panelTransitionTimer = window.setTimeout(() => {
      outgoing.hidden = true;
      outgoing.classList.remove('panel-leave');
      incoming.classList.remove('panel-enter');
      delete root.dataset.reviewTransition;
      panelTransitionTimer = 0;
    }, 380);
  }

  function syncPrimaryModeControls() {
    const activeMode = viewMode === 'library' ? 'library' : reviewMode;
    const actions = {
      scheduled: 'review-show-scheduled',
      free: 'review-show-free',
      library: 'review-show-library',
    };
    Object.keys(actions).forEach((mode) => {
      root.querySelectorAll('[data-action="' + actions[mode] + '"]').forEach((button) => {
        const active = activeMode === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    });
  }

  function showMode(next) {
    const nextPrimaryMode = next === 'library' ? 'library' : (next === 'free' ? 'free' : 'scheduled');
    const nextViewMode = nextPrimaryMode === 'library' ? 'library' : 'session';
    const previousViewMode = viewMode;
    const previousReviewMode = reviewMode;
    transitionModePanels(nextViewMode);
    viewMode = nextViewMode;
    if (nextPrimaryMode === 'library') {
      syncPrimaryModeControls();
      updateStats();
      loadLibrary(false);
      return;
    }

    reviewMode = nextPrimaryMode;
    root.dataset.reviewMode = reviewMode;
    persistReviewMode();
    syncScopeSelect();
    syncPrimaryModeControls();
    updateStats();
    updateSessionProgress();
    updateRatingGate();
    if (reviewMode === 'free') {
      ensureFreeReview(false);
      return;
    }
    loadPool(false).then((ok) => {
      if (!ok || viewMode !== 'session' || reviewMode !== 'scheduled') return;
      if (previousReviewMode !== 'scheduled' || previousViewMode !== 'session') nextCard();
    });
  }

  async function persistReviewSettings(change, message) {
    const payload = Object.assign({}, reviewSettings, change || {});
    const json = await post('/api/review-settings', payload);
    reviewSettings = Object.assign({}, reviewSettings, json.settings || payload);
    await loadPool(true);
    if (reviewMode === 'free' && viewMode === 'session') {
      resetFreeSession();
      await ensureFreeReview(false);
    }
    if (message) toast(message);
  }

  function settingsFormControl(name) {
    return settingsFormEl && settingsFormEl.elements
      ? settingsFormEl.elements.namedItem(name) : null;
  }

  function openSettingsDialog() {
    if (!settingsDialogEl || !settingsFormEl) return;
    clearTimeout(settingsDialogCloseTimer);
    settingsFormControl('sessionLimit').value = String(reviewSettings.sessionLimit || 20);
    settingsFormControl('orderMode').value = reviewSettings.orderMode || 'due';
    settingsDialogEl.hidden = false;
    requestAnimationFrame(() => settingsDialogEl.classList.add('show'));
  }

  function closeSettingsDialog() {
    if (!settingsDialogEl) return;
    settingsDialogEl.classList.remove('show');
    clearTimeout(settingsDialogCloseTimer);
    settingsDialogCloseTimer = window.setTimeout(() => {
      if (!settingsDialogEl.classList.contains('show')) settingsDialogEl.hidden = true;
    }, 230);
  }

  async function saveSessionSettings() {
    if (!settingsFormEl || !settingsSaveEl) return;
    if (settingsSaveEl.disabled) return;
    settingsSaveEl.disabled = true;
    settingsSaveEl.classList.add('is-saving');
    try {
      await persistReviewSettings({
        sessionLimit: Number(settingsFormControl('sessionLimit').value || 20),
        orderMode: settingsFormControl('orderMode').value,
        requireReveal: false,
      }, '复习设置已保存');
      closeSettingsDialog();
    } catch (error) {
      toast((error && error.message) || '保存复习设置失败');
    } finally {
      settingsSaveEl.disabled = false;
      settingsSaveEl.classList.remove('is-saving');
    }
  }

  function openHelpDialog() {
    if (!helpDialogEl) return;
    clearTimeout(helpDialogCloseTimer);
    const free = reviewMode === 'free';
    if (helpTitleEl) helpTitleEl.textContent = tr(free ? '自由复习' : '怎么复习');
    if (scheduledHelpEl) scheduledHelpEl.hidden = free;
    if (freeHelpEl) freeHelpEl.hidden = !free;
    helpDialogEl.hidden = false;
    requestAnimationFrame(() => helpDialogEl.classList.add('show'));
  }

  function closeHelpDialog() {
    if (!helpDialogEl) return;
    helpDialogEl.classList.remove('show');
    clearTimeout(helpDialogCloseTimer);
    helpDialogCloseTimer = window.setTimeout(() => {
      if (!helpDialogEl.classList.contains('show')) helpDialogEl.hidden = true;
    }, 230);
  }

  function openLibraryHelpDialog() {
    if (!libraryHelpDialogEl) return;
    clearTimeout(libraryHelpDialogCloseTimer);
    libraryHelpDialogEl.hidden = false;
    requestAnimationFrame(() => libraryHelpDialogEl.classList.add('show'));
  }

  function closeLibraryHelpDialog() {
    if (!libraryHelpDialogEl) return;
    libraryHelpDialogEl.classList.remove('show');
    clearTimeout(libraryHelpDialogCloseTimer);
    libraryHelpDialogCloseTimer = window.setTimeout(() => {
      if (!libraryHelpDialogEl.classList.contains('show')) libraryHelpDialogEl.hidden = true;
    }, 230);
  }

  function toggleBatchMode() {
    libraryBatchMode = !libraryBatchMode;
    selectedCardIds.clear();
    syncLibraryOrganizers();
    syncRenderedSelection();
  }

  function formControl(name) {
    return formEl && formEl.elements ? formEl.elements.namedItem(name) : null;
  }

  function openDialog(cardId) {
    if (!dialogEl || !formEl) return;
    if (!libraryLoaded) {
      loadLibrary(false).then((ok) => { if (ok) openDialog(cardId); });
      return;
    }
    clearTimeout(dialogCloseTimer);
    const card = cardId ? libraryCards.find((item) => item.id === cardId) : null;
    formEl.reset();
    formControl('id').value = card ? card.id : '';
    formControl('prompt').value = card ? card.prompt : '';
    formControl('answer').value = card ? card.answer : '';
    formControl('notes').value = card ? card.notes : '';
    syncLibraryOrganizers();
    formControl('deckName').value = card && deckById(card.deckId) ? card.deckName : '';
    syncDeckPickerState();
    closeDeckPicker();
    formControl('tags').value = card && Array.isArray(card.tags) ? card.tags.join(', ') : '';
    formControl('status').value = card ? card.status : 'active';
    if (cardMoreEl) cardMoreEl.open = false;
    if (dialogTitleEl) dialogTitleEl.textContent = tr(card ? '编辑卡片' : '新建卡片');
    clearTimeout(deleteArmTimer);
    deleteArmed = false;
    if (deleteEl) {
      deleteEl.hidden = !card;
      deleteEl.textContent = tr('删除卡片');
    }
    dialogEl.hidden = false;
    requestAnimationFrame(() => dialogEl.classList.add('show'));
    setTimeout(() => {
      const prompt = formControl('prompt');
      if (prompt) prompt.focus();
    }, 80);
  }

  function closeDialog() {
    if (!dialogEl) return;
    clearTimeout(deleteArmTimer);
    deleteArmed = false;
    closeDeckPicker();
    dialogEl.classList.remove('show');
    clearTimeout(dialogCloseTimer);
    dialogCloseTimer = setTimeout(() => {
      if (!dialogEl.classList.contains('show')) dialogEl.hidden = true;
    }, 230);
  }

  async function saveCard() {
    if (!formEl || !saveEl) return;
    if (saveEl.disabled) return;
    const id = String(formControl('id').value || '').trim();
    const payload = {
      id: id,
      prompt: formControl('prompt').value,
      answer: formControl('answer').value,
      notes: formControl('notes').value,
      deckName: formControl('deckName').value,
      tags: formControl('tags').value,
      status: formControl('status').value,
    };
    saveEl.disabled = true;
    saveEl.classList.add('is-saving');
    saveEl.setAttribute('aria-busy', 'true');
    try {
      await post(id ? '/api/review-card-update' : '/api/review-card-create', payload);
      closeDialog();
      await Promise.all([loadPool(true), loadLibrary(true)]);
      if (reviewMode === 'free' && viewMode === 'session') await ensureFreeReview(false);
      toast(id ? '卡片已更新' : '卡片已创建');
    } catch (error) {
      toast((error && error.message) || '保存卡片失败');
    } finally {
      saveEl.disabled = false;
      saveEl.classList.remove('is-saving');
      saveEl.removeAttribute('aria-busy');
    }
  }

  async function deleteCurrentCard() {
    const cardId = String((formControl('id') && formControl('id').value) || '').trim();
    if (!cardId) return;
    if (!deleteArmed) {
      deleteArmed = true;
      if (deleteEl) deleteEl.textContent = tr('再次点击确认删除');
      toast('删除后无法恢复，再点击一次确认');
      clearTimeout(deleteArmTimer);
      deleteArmTimer = setTimeout(() => {
        deleteArmed = false;
        if (deleteEl) deleteEl.textContent = tr('删除卡片');
      }, 3200);
      return;
    }
    try {
      await post('/api/review-card-delete', { id: cardId });
      closeDialog();
      await Promise.all([loadPool(true), loadLibrary(true)]);
      toast('卡片已删除');
    } catch (error) {
      toast((error && error.message) || '删除卡片失败');
    }
  }

  function deckFormControl(name) {
    return deckFormEl && deckFormEl.elements ? deckFormEl.elements.namedItem(name) : null;
  }

  function openDeckDialog(deckId) {
    if (!deckDialogEl || !deckFormEl) return;
    if (!libraryLoaded) {
      loadLibrary(false).then((ok) => { if (ok) openDeckDialog(deckId); });
      return;
    }
    const deck = deckId ? deckById(deckId) : null;
    deckFormEl.reset();
    deckFormControl('id').value = deck ? deck.id : '';
    deckFormControl('name').value = deck ? deck.name : '';
    if (deckDialogTitleEl) deckDialogTitleEl.textContent = tr(deck ? '编辑卡组' : '新建卡组');
    deckDeleteArmed = false;
    clearTimeout(deckDeleteArmTimer);
    if (deckDeleteEl) {
      deckDeleteEl.hidden = !deck;
      deckDeleteEl.textContent = tr('删除卡组');
    }
    clearTimeout(deckDialogCloseTimer);
    deckDialogEl.hidden = false;
    requestAnimationFrame(() => deckDialogEl.classList.add('show'));
    setTimeout(() => deckFormControl('name').focus(), 80);
  }

  function closeDeckDialog() {
    if (!deckDialogEl) return;
    deckDeleteArmed = false;
    clearTimeout(deckDeleteArmTimer);
    deckDialogEl.classList.remove('show');
    clearTimeout(deckDialogCloseTimer);
    deckDialogCloseTimer = setTimeout(() => {
      if (!deckDialogEl.classList.contains('show')) deckDialogEl.hidden = true;
    }, 230);
  }

  async function saveDeck() {
    if (!deckFormEl || !deckSaveEl) return;
    if (deckSaveEl.disabled) return;
    const id = String(deckFormControl('id').value || '').trim();
    deckSaveEl.disabled = true;
    deckSaveEl.classList.add('is-saving');
    deckSaveEl.setAttribute('aria-busy', 'true');
    try {
      await post(id ? '/api/review-deck-update' : '/api/review-deck-create', {
        id: id,
        name: deckFormControl('name').value,
      });
      closeDeckDialog();
      await Promise.all([loadPool(true), loadLibrary(true, false)]);
      toast(id ? '卡组已更新' : '卡组已创建');
    } catch (error) {
      toast((error && error.message) || '保存卡组失败');
    } finally {
      deckSaveEl.disabled = false;
      deckSaveEl.classList.remove('is-saving');
      deckSaveEl.removeAttribute('aria-busy');
    }
  }

  async function deleteCurrentDeck() {
    const deckId = String((deckFormControl('id') && deckFormControl('id').value) || '').trim();
    if (!deckId) return;
    if (!deckDeleteArmed) {
      deckDeleteArmed = true;
      if (deckDeleteEl) deckDeleteEl.textContent = tr('再次点击确认删除');
      toast('删除卡组后，卡片会回到未分类');
      clearTimeout(deckDeleteArmTimer);
      deckDeleteArmTimer = setTimeout(() => {
        deckDeleteArmed = false;
        if (deckDeleteEl) deckDeleteEl.textContent = tr('删除卡组');
      }, 3200);
      return;
    }
    try {
      await post('/api/review-deck-delete', { id: deckId });
      if (activeDeckFilter === deckId) activeDeckFilter = 'all';
      closeDeckDialog();
      await Promise.all([loadPool(true), loadLibrary(true, false)]);
      toast('卡组已删除，卡片已移到未分类');
    } catch (error) {
      toast((error && error.message) || '删除卡组失败');
    }
  }

  async function applyBatchChange(change, message) {
    const ids = Array.from(selectedCardIds);
    if (!ids.length) return;
    if (batchBarEl) batchBarEl.setAttribute('aria-busy', 'true');
    try {
      await post('/api/review-cards-batch', Object.assign({ ids: ids }, change));
      selectedCardIds.clear();
      if (batchDeckEl) batchDeckEl.value = '__keep__';
      if (batchStatusEl) batchStatusEl.value = '__keep__';
      await Promise.all([loadPool(true), loadLibrary(true)]);
      toast(message);
    } catch (error) {
      toast((error && error.message) || '批量更新卡片失败');
    } finally {
      if (batchBarEl) batchBarEl.removeAttribute('aria-busy');
    }
  }

  async function deleteSelectedCards() {
    const ids = Array.from(selectedCardIds);
    if (!ids.length) return;
    if (!batchDeleteArmed) {
      batchDeleteArmed = true;
      if (batchDeleteEl) batchDeleteEl.textContent = tr('再次点击确认删除');
      toast('删除后无法恢复，再点击一次确认');
      clearTimeout(batchDeleteArmTimer);
      batchDeleteArmTimer = setTimeout(() => {
        batchDeleteArmed = false;
        if (batchDeleteEl) batchDeleteEl.textContent = tr('删除所选');
      }, 3200);
      return;
    }
    try {
      await post('/api/review-cards-batch-delete', { ids: ids });
      selectedCardIds.clear();
      batchDeleteArmed = false;
      await Promise.all([loadPool(true), loadLibrary(true)]);
      toast('所选卡片已删除');
    } catch (error) {
      toast((error && error.message) || '批量删除卡片失败');
    }
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    const action = button && button.dataset.action;
    if (!action) return;
    if (action === 'review-show-scheduled') { showMode('scheduled'); return; }
    if (action === 'review-show-free') { showMode('free'); return; }
    if (action === 'review-show-library') { showMode('library'); return; }
    if (action === 'review-card-new') { openDialog(''); return; }
    if (action === 'review-card-edit') { openDialog(button.dataset.cardId); return; }
    if (action === 'review-card-delete') { deleteCurrentCard(); return; }
    if (action === 'review-dialog-close') { closeDialog(); return; }
    if (action === 'review-settings-open') { openSettingsDialog(); return; }
    if (action === 'review-settings-close') { closeSettingsDialog(); return; }
    if (action === 'review-help-open') { openHelpDialog(); return; }
    if (action === 'review-help-close') { closeHelpDialog(); return; }
    if (action === 'review-library-help-open') { openLibraryHelpDialog(); return; }
    if (action === 'review-library-help-close') { closeLibraryHelpDialog(); return; }
    if (action === 'review-session-again') { loadPool(true); return; }
    if (action === 'review-deck-new') { openDeckDialog(''); return; }
    if (action === 'review-deck-edit') { openDeckDialog(button.dataset.deckId); return; }
    if (action === 'review-deck-edit-current') { openDeckDialog(activeDeckFilter); return; }
    if (action === 'review-status-filter') {
      activeStatusFilter = button.dataset.status || 'all';
      syncLibraryOrganizers();
      renderLibrary(true);
      return;
    }
    if (action === 'review-batch-mode') { toggleBatchMode(); return; }
    if (action === 'review-deck-dialog-close') { closeDeckDialog(); return; }
    if (action === 'review-deck-delete') { deleteCurrentDeck(); return; }
    if (action === 'review-batch-delete') { deleteSelectedCards(); return; }
    if (action === 'review-show-answer') { toggleAnswer(); return; }
    if (action === 'review-next') skipCard();
    else if (action === 'review-remembered') mark('remembered');
    else if (action === 'review-vague') mark('vague');
    else if (action === 'review-forgot') mark('forgot');
  });

  if (formEl) formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    saveCard();
  });
  if (cardDeckInputEl) {
    cardDeckInputEl.addEventListener('focus', openDeckPicker);
    cardDeckInputEl.addEventListener('input', () => {
      syncDeckPickerState();
      openDeckPicker();
    });
    cardDeckInputEl.addEventListener('blur', () => {
      clearTimeout(deckPickerCloseTimer);
      deckPickerCloseTimer = window.setTimeout(closeDeckPicker, 100);
    });
    cardDeckInputEl.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      const isOpen = cardDeckOptionsEl && !cardDeckOptionsEl.hidden;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!isOpen) {
          openDeckPicker();
          return;
        }
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const length = deckPickerItems.length;
        if (length) {
          deckPickerIndex = (deckPickerIndex + direction + length) % length;
          syncDeckPickerActiveOption();
        }
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (isOpen && deckPickerIndex >= 0) chooseDeckPickerItem(deckPickerIndex);
        else openDeckPicker();
        return;
      }
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeDeckPicker();
      }
      if (event.key === 'Tab') closeDeckPicker();
    });
  }
  if (cardDeckOptionsEl) {
    cardDeckOptionsEl.addEventListener('pointerdown', (event) => event.preventDefault());
    cardDeckOptionsEl.addEventListener('click', (event) => {
      const option = event.target.closest('[data-deck-picker-index]');
      if (!option) return;
      chooseDeckPickerItem(Number(option.dataset.deckPickerIndex));
    });
  }
  if (deckFormEl) deckFormEl.addEventListener('submit', (event) => {
    event.preventDefault();
    saveDeck();
  });
  if (settingsFormEl) settingsFormEl.addEventListener('submit', (event) => {
    event.preventDefault();
    saveSessionSettings();
  });
  if (searchEl) searchEl.addEventListener('input', scheduleLibraryFilterRender);
  if (deckFilterSelectEl) deckFilterSelectEl.addEventListener('change', () => {
    activeDeckFilter = deckFilterSelectEl.value || 'all';
    syncLibraryOrganizers();
    renderLibrary(true);
  });
  if (libraryListEl) libraryListEl.addEventListener('change', (event) => {
    const input = event.target.closest('[data-role="review-card-select"]');
    if (!input) return;
    if (input.checked) selectedCardIds.add(input.dataset.cardId);
    else selectedCardIds.delete(input.dataset.cardId);
    const item = input.closest('.review-library-item');
    if (item) item.classList.toggle('is-selected', input.checked);
    updateBatchBar();
  });
  if (selectAllEl) selectAllEl.addEventListener('change', () => {
    if (selectAllEl.checked) visibleLibraryIds.forEach((id) => selectedCardIds.add(id));
    else visibleLibraryIds.forEach((id) => selectedCardIds.delete(id));
    syncRenderedSelection();
  });
  if (batchDeckEl) batchDeckEl.addEventListener('change', () => {
    if (batchDeckEl.value === '__keep__') return;
    applyBatchChange({ deckId: batchDeckEl.value }, '卡片已移动到新卡组');
  });
  if (batchStatusEl) batchStatusEl.addEventListener('change', () => {
    if (batchStatusEl.value === '__keep__') return;
    applyBatchChange({ status: batchStatusEl.value }, '卡片状态已批量更新');
  });
  if (scopeSelectEl) scopeSelectEl.addEventListener('change', async () => {
    const value = scopeSelectEl.value || 'all';
    const change = value.startsWith('deck:')
      ? { scopeMode: 'deck', scopeDeckId: value.slice(5) }
      : { scopeMode: value, scopeDeckId: '' };
    scopeSelectEl.disabled = true;
    try {
      await persistReviewSettings(change, '复习范围已切换');
    } catch (error) {
      syncScopeSelect();
      toast((error && error.message) || '切换复习范围失败');
    } finally {
      scopeSelectEl.disabled = false;
    }
  });
  if (window.RelatumI18n && typeof window.RelatumI18n.onChange === 'function') {
    window.RelatumI18n.onChange(() => {
      if (libraryLoaded && viewMode === 'library') {
        syncLibraryOrganizers();
        renderLibrary(false);
      }
      syncPrimaryModeControls();
      syncDeckPickerState();
      if (cardDeckOptionsEl && !cardDeckOptionsEl.hidden) renderDeckPickerOptions();
      if (viewMode === 'session') {
        if (current) renderCard(current);
        else renderEmpty();
      } else {
        updateStats();
      }
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (cardDeckOptionsEl && !cardDeckOptionsEl.hidden) { closeDeckPicker(); return; }
      if (dialogEl && dialogEl.classList.contains('show')) { closeDialog(); return; }
      if (deckDialogEl && deckDialogEl.classList.contains('show')) { closeDeckDialog(); return; }
      if (settingsDialogEl && settingsDialogEl.classList.contains('show')) { closeSettingsDialog(); return; }
      if (helpDialogEl && helpDialogEl.classList.contains('show')) { closeHelpDialog(); return; }
      if (libraryHelpDialogEl && libraryHelpDialogEl.classList.contains('show')) { closeLibraryHelpDialog(); return; }
    }
    if (root.getAttribute('aria-hidden') === 'true') return;
    if ((dialogEl && dialogEl.classList.contains('show'))
        || (deckDialogEl && deckDialogEl.classList.contains('show'))
        || (settingsDialogEl && settingsDialogEl.classList.contains('show'))
        || (helpDialogEl && helpDialogEl.classList.contains('show'))
        || (libraryHelpDialogEl && libraryHelpDialogEl.classList.contains('show'))) return;
    const target = event.target;
    if (target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === '?') {
      event.preventDefault();
      if (viewMode === 'library') openLibraryHelpDialog();
      else openHelpDialog();
      return;
    }
    if (viewMode !== 'session') return;
    if (!current) return;
    if (event.code === 'Space') { event.preventDefault(); toggleAnswer(); return; }
    if (reviewMode === 'free' && event.key === '1') { event.preventDefault(); toggleAnswer(); return; }
    if (reviewMode === 'scheduled' && event.key === '1') { event.preventDefault(); mark('remembered'); return; }
    if (reviewMode === 'scheduled' && event.key === '2') { event.preventDefault(); mark('vague'); return; }
    if (reviewMode === 'scheduled' && event.key === '3') { event.preventDefault(); mark('forgot'); return; }
    const shortcutKey = event.key.toLowerCase();
    if (shortcutKey === 'n' || (reviewMode === 'free' && shortcutKey === 'd')) {
      event.preventDefault();
      skipCard();
    }
  });

  async function activateReview() {
    const ok = await loadPool(false);
    if (!ok) return false;
    if (reviewMode === 'free' && (!freeInitialized || !libraryLoaded || freeCurrentId !== (current && current.id))) {
      return ensureFreeReview(false);
    }
    return true;
  }

  async function reloadReview() {
    const results = await Promise.all([loadPool(true), loadLibrary(true)]);
    if (reviewMode === 'free' && viewMode === 'session' && results[1]) {
      return ensureFreeReview(false);
    }
    return results;
  }

  root.dataset.reviewMode = reviewMode;
  syncPrimaryModeControls();
  updateRatingGate();
  window.CanvasReview = {
    activate: activateReview,
    reload: reloadReview,
  };

  document.addEventListener('start:viewchange', (event) => {
    if (!event.detail || event.detail.current !== 'review') {
      clearTransientMotion();
      cancelMathReadyWait();
      cancelMathLoadSchedule();
    }
  });
  window.addEventListener('pagehide', () => {
    clearTransientMotion();
    cancelMathReadyWait();
    cancelMathLoadSchedule();
  });
  schedulePreload();
})();
