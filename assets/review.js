(function () {
  'use strict';

  const root = document.querySelector('[data-role="review-view"]');
  if (!root) return;
  const controls = window.RelatumReviewControls.createManager(root);
  let cardDeckControl = null;

  const PRAISE = {
    remembered: '记得 √',
    vague: '模糊 ~',
    forgot: '不会 ×',
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
  const relearnEl = root.querySelector('[data-role="review-relearning"]');
  const retryEl = root.querySelector('[data-role="review-save-retry"]');
  const retryButton = root.querySelector('[data-action="review-mark-retry"]');
  const promptEl = root.querySelector('[data-role="review-prompt"]');
  const notesEl = root.querySelector('[data-role="review-notes"]');
  const draftEl = root.querySelector('[data-role="review-draft"]');
  const answerPillEl = root.querySelector('[data-role="review-answer-pill"]');
  const answerRevealEl = root.querySelector('[data-role="review-answer-reveal"]');
  const questionHintEl = root.querySelector('[data-role="review-question-hint"]');
  const nextLabelEl = root.querySelector('[data-role="review-next-label"]');
  const nextShortcutEl = root.querySelector('[data-role="review-next-shortcut"]');
  const continueHintEl = root.querySelector('[data-role="review-continue-hint"]');
  const ratingButtons = Array.from(root.querySelectorAll('[data-action="review-remembered"], [data-action="review-vague"], [data-action="review-forgot"]'));
  const nextButtons = Array.from(root.querySelectorAll('[data-action="review-next"]'));
  const actionsEl = root.querySelector('.review-actions');
  const cardDeckEl = root.querySelector('[data-role="review-card-deck"]');
  const cardTagsEl = root.querySelector('[data-role="review-card-tags"]');
  const scopeSelectEl = root.querySelector('[data-role="review-scope-select"]');
  const sessionProgressEl = root.querySelector('[data-role="review-session-progress"]');
  const libraryListEl = root.querySelector('[data-role="review-library-list"]');
  let windowedLibrary = null;
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
  let completedToday = 0;
  let sessionInitialCount = 0;
  let sessionReviewedCount = 0;
  let answerRevealed = false;
  let loaded = false;
  let loadedDay = '';
  let loading = false;
  let poolPromise = null;
  let poolLoadSequence = 0;
  let sessionGeneration = 0;
  let statsSequence = 0;
  let pendingRating = null;
  let feedback = null;
  const heldReviewKeys = new Set();
  const continueKeys = new Set(['1', '2', '3', 'n', 'd', ' ', 'enter']);
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
  let importLoader = null;
  let importController = null;
  let importOpenSequence = 0;
  let mathQueue = Promise.resolve();
  const pendingMathElements = new Set();
  let mathReadyTimer = 0;
  let mathReadyTries = 0;
  let mathLoadHandle = 0;
  let mathLoadUsesIdle = false;
  let seenAnimation = null;
  const plusOneTimers = new Map();

  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function setAttribute(node, name, value) {
    if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

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
    if (!resp.ok) {
      const error = new Error((json && json.error) || '请求失败');
      error.status = resp.status;
      error.code = json && json.code;
      throw error;
    }
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
    clearStatMotion();
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

  function statMotionVisible() {
    return !document.hidden && document.documentElement.dataset.desktopMinimized !== '1'
      && root.getAttribute('aria-hidden') !== 'true' && !reducedMotion();
  }

  function clearStatMotion() {
    seenAnimation?.cancel();
    seenAnimation = null;
    plusOneTimers.forEach((timer, chip) => { clearTimeout(timer); chip.remove(); });
    plusOneTimers.clear();
  }

  function bumpSeen() {
    seenAnimation?.cancel();
    seenAnimation = null;
    if (!seenEl?.animate || !statMotionVisible()) return;
    const animation = seenEl.animate([
      { transform: 'none' },
      { transform: 'translateY(-3px) scale(1.16)', offset: .32 },
      { transform: 'none' },
    ], { duration: 440, easing: 'cubic-bezier(.22,1,.36,1)' });
    seenAnimation = animation;
    const finish = () => { if (seenAnimation === animation) seenAnimation = null; animation.cancel(); };
    animation.onfinish = finish;
  }

  function floatPlusOne() {
    if (!seenEl?.parentElement || !statMotionVisible()) return;
    const chip = document.createElement('span');
    chip.className = 'review-plus-one';
    chip.textContent = '+1';
    seenEl.parentElement.appendChild(chip);
    plusOneTimers.set(chip, setTimeout(() => { chip.remove(); plusOneTimers.delete(chip); }, 950));
  }

  function praise(rating) {
    toast(PRAISE[rating] || '已记录');
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
    setText(totalEl, String(free ? freeEligibleCards().length : Math.max(0, dueCount)));
    setText(seenEl, String(free ? freeSeenCount : Math.max(0, completedToday)));
    setText(totalLabelEl, tr(free ? '范围卡片' : '待复习'));
    setText(seenLabelEl, tr(free ? '自由浏览' : '今日完成'));
  }

  function updateSessionProgress() {
    if (!sessionProgressEl) return;
    if (reviewMode === 'free') {
      setText(sessionProgressEl, tr('随机 · 无限'));
      return;
    }
    if (!sessionInitialCount) {
      setText(sessionProgressEl, tr('本轮完成') + ' 0 / 0');
      return;
    }
    const position = Math.min(sessionInitialCount, sessionReviewedCount);
    setText(sessionProgressEl, tr('本轮完成') + ' ' + position + ' / ' + sessionInitialCount);
  }

  function updateRatingGate() {
    const locked = marking || (reviewMode === 'scheduled' && (loading || !!pendingRating));
    const update = (button, unavailable, actionLocked) => {
      if (button.disabled !== unavailable) button.disabled = unavailable;
      setAttribute(button, 'aria-disabled', String(unavailable || actionLocked));
    };
    ratingButtons.forEach(button => update(button, !current || reviewMode === 'free', locked || !!feedback));
    nextButtons.forEach(button => update(button, !current, locked || (!!feedback && !feedback.ready)));
    setAttribute(actionsEl, 'aria-busy', String(marking));
    if (actionsEl && actionsEl.classList.contains('is-checking') !== !!feedback) actionsEl.classList.toggle('is-checking', !!feedback);
    setAttribute(root, 'data-review-phase', feedback ? (marking ? 'saving' : feedback.ready ? 'feedback' : 'retry') : 'question');
    setText(nextLabelEl, tr(feedback ? '继续' : reviewMode === 'free' ? '下一张' : '再来一张'));
    setText(nextShortcutEl, feedback ? 'Enter' : reviewMode === 'free' ? 'N / D' : 'N');
    if (continueHintEl) {
      continueHintEl.hidden = !feedback?.ready;
      setText(continueHintEl, tr('按任意键继续'));
      const keys = tr('可按 1、2、3、N、D、空格或 Enter 继续');
      setAttribute(continueHintEl, 'title', keys);
      setAttribute(continueHintEl, 'aria-label', keys);
    }
    if (retryEl) retryEl.hidden = !(pendingRating?.uncertain && reviewMode === 'scheduled' && viewMode === 'session');
    setAttribute(retryButton, 'aria-disabled', String(marking));
  }

  function syncScopeSelect() {
    if (!scopeSelectEl) return;
    const options = reviewScopes.map((scope) => {
      const value = scope.mode === 'deck' ? ('deck:' + scope.deckId) : scope.mode;
      const name = scope.mode === 'deck' ? scope.name : tr(scope.name);
      const count = reviewMode === 'free' ? scope.activeCount : scope.dueCount;
      return { value, label: name + ' · ' + Math.max(0, Number(count) || 0) };
    });
    const currentValue = reviewSettings.scopeMode === 'deck'
      ? ('deck:' + reviewSettings.scopeDeckId)
      : reviewSettings.scopeMode;
    controls.setOptions(scopeSelectEl, options, currentValue);
  }

  function resetAnswerReveal(card) {
    answerRevealed = false;
    const hasAnswer = !!(card && String(card.answer || '').trim());
    if (answerPillEl) {
      answerPillEl.hidden = !hasAnswer;
      setText(answerPillEl, tr('查看答案'));
    }
    if (answerRevealEl) {
      answerRevealEl.hidden = true;
      answerRevealEl.innerHTML = '';
    }
    updateRatingGate();
  }

  function revealAnswer(allowEmpty) {
    if (!current || !answerRevealEl || !answerPillEl) return;
    const answer = String(current.answer || '').trim();
    if ((!answer && !allowEmpty) || !answerRevealEl.hidden) return;
    if (answer) renderRich(answerRevealEl, answer);
    else setText(answerRevealEl, tr('未填写答案'));
    answerRevealEl.hidden = false;
    answerRevealed = true;
    replay(answerRevealEl, 'reveal-in');
    setText(answerPillEl, tr('收起答案'));
  }

  function toggleAnswer() {
    if (!current || !answerRevealEl || !answerPillEl) return;
    if (answerRevealEl.hidden) {
      revealAnswer(!!feedback);
    } else {
      answerRevealEl.hidden = true;
      answerRevealed = false;
      setText(answerPillEl, tr('查看答案'));
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
    } else if (completedToday > 0 && activeCount > 0) {
      const spark = celebratePulse
        ? '<div class="review-spark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>'
        : '';
      emptyEl.classList.add('celebrate');
      emptyEl.innerHTML = spark
        + '<strong>' + tr('今天的复习做完了') + '</strong>'
        + '<span>' + tr('今天完成了 {count} 张卡片。想继续练习，可以切到自由复习。').replace('{count}', String(completedToday)) + '</span>'
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
    feedback = null;
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
    updateCardMetadata();
    setText(promptEl, current.prompt || '未命名问题');
    if (questionHintEl) {
      setText(questionHintEl, tr(reviewMode === 'free'
        ? '点击“下一张”核对答案，再继续。'
        : '想好后选择记忆程度，核对答案后再继续。'));
    }
    if (notesEl) notesEl.hidden = !renderRich(notesEl, current.notes);
    if (draftEl) draftEl.value = '';
    resetAnswerReveal(current);
    updateSessionProgress();
  }

  function updateCardMetadata() {
    if (!current) return;
    if (maturityEl) {
      setText(maturityEl, current.maturity || '生');
      setAttribute(maturityEl, 'data-maturity', current.maturity || '生');
    }
    if (countEl) {
      const count = Number(current.reviewCount || 0);
      setText(countEl, count > 0 ? ('已复习 ' + count + ' 次') : '尚未复习');
    }
    if (relearnEl) {
      const daily = current.dailyReview;
      relearnEl.hidden = reviewMode !== 'scheduled' || !daily?.needsRelearning;
      setText(relearnEl, tr('补练 · 连续记得 {count}/2').replace('{count}', String(daily?.streak || 0)));
    }
    if (cardDeckEl) {
      cardDeckEl.hidden = !current.deckName;
      setText(cardDeckEl, current.deckName ? (tr('卡组') + ' · ' + current.deckName) : '');
    }
    if (cardTagsEl) {
      const tags = Array.isArray(current.tags) ? current.tags : [];
      cardTagsEl.hidden = tags.length === 0;
      setText(cardTagsEl, tags.length ? tags.map((tag) => '#' + tag).join(' · ') : '');
    }
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
    if (freeSeenCount > 1) bumpSeen();
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
      if (preserved && feedback && feedback.day === todayStr() && feedback.cardId === preserved.id) {
        current = preserved;
        updateCardMetadata(); updateStats(); updateRatingGate();
      } else if (preserved) renderCard(preserved);
      else nextFreeCard();
      return true;
    } finally {
      if (concealLoading) root.classList.remove('is-pool-loading');
    }
  }

  async function skipCard() {
    if (marking || !current) return;
    if (feedback) { await continueCard(); return; }
    if (pendingRating || loading) return;
    if (reviewMode === 'scheduled' && (!loaded || loadedDay !== todayStr())) { await loadPool(true); toast('复习数据已刷新，请继续作答'); return; }
    beginFeedback('skip', true);
  }

  function beginFeedback(kind, ready) {
    feedback = { kind, ready, cardId: current.id, mode: reviewMode, scope: scopeKey(), day: todayStr(), celebrate: false };
    revealAnswer(true);
    updateRatingGate();
  }

  async function continueCard() {
    if (!feedback?.ready || marking || pendingRating || loading || !current) return;
    const previous = feedback;
    if (previous.day !== todayStr() || previous.mode !== reviewMode || previous.scope !== scopeKey() || previous.cardId !== current.id
        || (reviewMode === 'scheduled' && (!loaded || loadedDay !== todayStr()))) {
      feedback = null;
      if (reviewMode === 'free') await ensureFreeReview(false);
      else await loadPool(true);
      return;
    }
    feedback = null;
    if (reviewMode === 'free') {
      nextFreeCard();
      if (current) toast('下一张 √');
    } else {
      if (previous.kind === 'skip') {
        const index = pool.findIndex(card => card.id === current.id);
        if (index >= 0) pool.push(pool.splice(index, 1)[0]);
      }
      celebratePulse = previous.celebrate;
      nextCard(); celebratePulse = false;
    }
  }

  function scopeKey() {
    return reviewSettings.scopeMode + ':' + (reviewSettings.scopeDeckId || '');
  }

  function scheduledVisible() {
    return viewMode === 'session' && reviewMode === 'scheduled' && root.getAttribute('aria-hidden') !== 'true';
  }

  function applyStatistics(json) {
    if (json.scopeKey && json.scopeKey !== scopeKey()) return false;
    if (String(json.generatedAt || '').slice(0, 10) !== todayStr()) return false;
    if (Number.isFinite(json.dueCount)) dueCount = json.dueCount;
    if (Number.isFinite(json.count)) activeCount = json.count;
    if (Number.isFinite(json.completedToday)) completedToday = json.completedToday;
    if (Array.isArray(json.scopes)) reviewScopes = json.scopes;
    statsSequence++;
    syncScopeSelect(); updateStats();
    return true;
  }

  async function refreshRatingStatistics() {
    const identity = sessionGeneration, sequence = statsSequence;
    try {
      const json = await readJson('/api/review-pool');
      if (identity === sessionGeneration && sequence === statsSequence) applyStatistics(json);
    } catch (_) { loaded = false; }
  }

  async function loadPool(force) {
    const currentDay = todayStr();
    if (loaded && !force && loadedDay === currentDay) return true;
    if (loading && !force) { await poolPromise; return loadPool(false); }
    const sequence = ++poolLoadSequence, identity = ++sessionGeneration, requestedScope = scopeKey();
    const concealInitialState = !loaded;
    if (concealInitialState) root.classList.add('is-pool-loading');
    loading = true;
    updateRatingGate();
    poolPromise = (async () => {
      try {
        const pendingPreload = !force ? takePreload() : null;
        const json = await (pendingPreload || readJson('/api/review-pool'));
        if (sequence !== poolLoadSequence || identity !== sessionGeneration || requestedScope !== scopeKey()) return false;
        if (String(json.generatedAt || '').slice(0, 10) !== todayStr()) { loaded = false; return false; }
        pool = Array.isArray(json.cards) ? json.cards : [];
        reviewSettings = Object.assign({}, reviewSettings, json.settings || {});
        reviewSettings.requireReveal = false;
        applyStatistics(json);
        sessionReviewedCount = 0;
        sessionInitialCount = dueCards().length;
        loaded = true;
        loadedDay = String(json.generatedAt).slice(0, 10);
        if (viewMode !== 'session' || reviewMode === 'free') {
          updateSessionProgress();
        } else nextCard();
        return true;
      } catch (error) {
        if (sequence === poolLoadSequence && identity === sessionGeneration) {
          loaded = false;
          toast((error && error.message) || '加载复习卡片失败');
          if (scheduledVisible()) renderCard(null);
        }
        return false;
      } finally {
        if (sequence === poolLoadSequence) {
          loading = false;
          root.classList.remove('is-pool-loading');
          updateRatingGate();
        }
      }
    })();
    return poolPromise;
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
    if (window.RelatumFeatureRuntime?.preloadEnabled === false) return;
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
    if (!current || feedback || marking || pendingRating || loading || reviewMode === 'free') return;
    if (!loaded || loadedDay !== todayStr()) { await loadPool(true); toast('复习数据已刷新，请继续作答'); return; }
    pendingRating = {
      session: sessionGeneration, uncertain: false,
      payload: { cardId: current.id, rating, requestId: window.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2),
        expectedReviewCount: Number(current.reviewCount || 0), reviewDay: loadedDay },
    };
    beginFeedback('rating', false);
    await submitRating(pendingRating);
  }

  async function submitRating(submission) {
    if (marking || pendingRating !== submission) return;
    marking = true;
    statsSequence++;
    updateRatingGate();
    try {
      const json = await post('/api/review-mark', submission.payload);
      const updated = json.card;
      if (!updated?.dailyReview) throw new Error(tr('评分结果尚未确认，请重试保存'));
      pendingRating = null;
      libraryCards = libraryCards.map(card => card.id === updated.id && Number(card.reviewCount || 0) <= updated.reviewCount ? updated : card);
      const sameSession = submission.session === sessionGeneration && scheduledVisible()
        && submission.payload.reviewDay === todayStr() && json.scopeKey === scopeKey()
        && feedback?.kind === 'rating' && feedback.cardId === submission.payload.cardId;
      if (sameSession) {
        const previousCompleted = completedToday;
        applyStatistics(json);
        pool = pool.filter(card => card.id !== updated.id);
        if (updated.dailyReview.completed) sessionReviewedCount++;
        else if (updated.status === 'active' && isDue(updated)) pool.splice(Math.min(3, pool.length), 0, updated);
        if (completedToday > previousCompleted) { bumpSeen(); floatPlusOne(); }
        praise(submission.payload.rating);
        current = updated;
        updateCardMetadata(); updateSessionProgress();
        feedback.ready = true;
        feedback.celebrate = updated.dailyReview.completed;
        if (json.idempotent) await refreshRatingStatistics();
      } else {
        if (feedback?.cardId === submission.payload.cardId && feedback.kind === 'rating') feedback = null;
        loaded = false;
        if (scheduledVisible()) await loadPool(true);
        else if (viewMode === 'library' && root.getAttribute('aria-hidden') !== 'true') await refreshRatingStatistics();
      }
      if (viewMode === 'library') { updateStats(); if (libraryLoaded) renderLibrary(false); }
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        pendingRating = null;
        if (feedback?.cardId === submission.payload.cardId && feedback.kind === 'rating') feedback = null;
        if (error.status === 409 || error.status === 404) {
          loaded = false;
          if (scheduledVisible()) {
            const previousId = current?.id, draft = draftEl?.value;
            await loadPool(true);
            if (current?.id === previousId && draftEl && scheduledVisible()) draftEl.value = draft || '';
          }
        }
        toast(error.message || '标记失败');
      } else {
        submission.uncertain = true;
        toast('评分结果尚未确认，请重试保存');
      }
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

  function closeDeckPicker() {
    cardDeckControl?.close();
  }

  function syncLibraryOrganizers() {
    if (activeDeckFilter !== 'all' && activeDeckFilter !== '__none__' && !deckById(activeDeckFilter)) {
      activeDeckFilter = 'all';
    }
    if (deckFilterSelectEl) {
      controls.setOptions(deckFilterSelectEl, [
        { value: 'all', label: tr('全部卡组') },
        { value: '__none__', label: tr('未分类') + ' · ' + uncategorizedCount },
        ...reviewDecks.map(deck => ({ value: deck.id, label: deck.name + ' · ' + deck.count })),
      ], activeDeckFilter);
    }
    if (deckEditCurrentEl) deckEditCurrentEl.hidden = !deckById(activeDeckFilter);
    statusFilterButtons.forEach((button) => {
      const active = button.dataset.status === activeStatusFilter;
      button.classList.toggle('is-active', active);
      setAttribute(button, 'aria-pressed', active ? 'true' : 'false');
    });
    if (libraryEl) libraryEl.classList.toggle('is-batch-mode', libraryBatchMode);
    if (selectVisibleEl) selectVisibleEl.hidden = !libraryBatchMode;
    if (batchModeEl) {
      batchModeEl.classList.toggle('is-active', libraryBatchMode);
      setText(batchModeEl, tr(libraryBatchMode ? '完成整理' : '批量整理'));
      setAttribute(batchModeEl, 'aria-pressed', libraryBatchMode ? 'true' : 'false');
    }
    syncDeckPickerState();
    if (batchDeckEl) {
      controls.setOptions(batchDeckEl, [
        { value: '__keep__', label: tr('移动到卡组…') },
        { value: '', label: tr('未分类') },
        ...reviewDecks.map(deck => ({ value: deck.id, label: deck.name })),
      ], '__keep__');
    }
    if (batchStatusEl) batchStatusEl.value = '__keep__';
    controls.sync(batchStatusEl);
    cardDeckControl?.refresh();
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
    const rowSignature = card => JSON.stringify([card.prompt, card.answer, card.notes, card.status,
      card.deckName, card.tags, tr(statusLabel(card.status)), tr(dueLabel(card)), tr('编辑'), tr('未命名问题'), tr('还没有填写答案或说明')]);
    const buildItem = (card, index) => {
      const item = document.createElement('article');
      item.className = 'review-library-item';
      item.dataset.cardId = card.id;
      item.__librarySignature = rowSignature(card);
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
      return item;
    };
    if (filtered.length > 200 && window.RelatumWindowedList) {
      if (!windowedLibrary) windowedLibrary = RelatumWindowedList.create({ host: libraryListEl, gap: 10, estimate: 122,
        key: card => card.id, render: (card, index) => buildItem(card, index),
        update: (item, card, index) => {
          const signature = rowSignature(card);
          if (item.__librarySignature !== signature) {
            const fresh = buildItem(card, index);
            item.querySelector('.review-library-copy').replaceWith(fresh.querySelector('.review-library-copy'));
            item.querySelector('[data-role="review-card-select"]').setAttribute('aria-label', fresh.querySelector('[data-role="review-card-select"]').getAttribute('aria-label'));
            item.querySelector('[data-action="review-card-edit"]').textContent = tr('编辑');
            item.__librarySignature = signature;
          }
          const selected = selectedCardIds.has(card.id);
          item.classList.toggle('is-selected', selected);
          item.querySelector('[data-role="review-card-select"]').checked = selected;
        },
      });
      windowedLibrary.setItems(filtered, buildItem);
    } else {
      if (windowedLibrary) { windowedLibrary.dispose(); windowedLibrary = null; }
      libraryListEl.innerHTML = '';
      const fragment = document.createDocumentFragment();
      filtered.forEach((card, index) => fragment.appendChild(buildItem(card, index)));
      libraryListEl.appendChild(fragment);
    }
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
    controls.close();
    const nextPrimaryMode = next === 'library' ? 'library' : (next === 'free' ? 'free' : 'scheduled');
    const nextViewMode = nextPrimaryMode === 'library' ? 'library' : 'session';
    const previousViewMode = viewMode;
    const previousReviewMode = reviewMode;
    if (nextViewMode !== previousViewMode || (nextPrimaryMode !== 'library' && nextPrimaryMode !== previousReviewMode)) {
      sessionGeneration++; statsSequence++;
      feedback = null;
    }
    transitionModePanels(nextViewMode);
    viewMode = nextViewMode;
    if (nextPrimaryMode === 'library') {
      syncPrimaryModeControls();
      updateStats();
      updateRatingGate();
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
    feedback = null;
    updateRatingGate();
    sessionGeneration++; statsSequence++; loaded = false;
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
    controls.sync([settingsFormControl('sessionLimit'), settingsFormControl('orderMode')]);
    requestAnimationFrame(() => settingsDialogEl.classList.add('show'));
  }

  function closeSettingsDialog() {
    if (!settingsDialogEl) return;
    controls.close();
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
    const more = libraryHelpDialogEl.querySelector('details');
    if (more) more.open = false;
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

  function loadImportResource(src, style) {
    return new Promise((resolve, reject) => {
      const element = document.createElement(style ? 'link' : 'script');
      if (style) { element.rel = 'stylesheet'; element.href = src; }
      else element.src = src;
      element.onload = () => resolve();
      element.onerror = () => { element.remove(); reject(new Error(tr('导入组件加载失败，请重试'))); };
      document.head.appendChild(element);
    });
  }

  async function openImportDialog(trigger) {
    const sequence = ++importOpenSequence;
    if (trigger) trigger.disabled = true;
    try {
      if (!importLoader) {
        importLoader = Promise.all([loadImportResource('review-import.css', true), loadImportResource('review-import-model.js', false)])
          .then(() => loadImportResource('review-import.js', false))
          .catch(error => { importLoader = null; throw error; });
      }
      await importLoader;
      if (sequence !== importOpenSequence || root.getAttribute('aria-hidden') === 'true') return;
      if (!libraryLoaded && !await loadLibrary(false)) return;
      if (sequence !== importOpenSequence || root.getAttribute('aria-hidden') === 'true') return;
      if (!importController) importController = window.RelatumReviewImport.create({
        root,
        decks: () => reviewDecks,
        renderRich,
        afterImport: async () => {
          const previous = new Set(libraryCards.map(card => card.id));
          while (loading || libraryLoading) await new Promise(resolve => setTimeout(resolve, 80));
          const results = await Promise.all([loadPool(true), loadLibrary(true, false)]);
          if (!results.every(Boolean)) {
            libraryLoaded = false; loaded = false;
            throw new Error('refresh-failed');
          }
          const visible = new Set(filteredLibraryCards().map(card => card.id));
          return libraryCards.some(card => !previous.has(card.id) && !visible.has(card.id));
        },
        clearFilters: () => {
          activeDeckFilter = 'all'; activeStatusFilter = 'all';
          if (searchEl) searchEl.value = '';
          syncLibraryOrganizers(); renderLibrary(false);
        },
      });
      closeDialog(); closeDeckDialog(); closeSettingsDialog(); closeHelpDialog(); closeLibraryHelpDialog();
      importController.open(trigger);
    } catch (error) { toast(error.message || '导入组件加载失败，请重试'); }
    finally { if (trigger) trigger.disabled = false; }
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
    controls.sync(formControl('status'));
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
      if (prompt && dialogEl.classList.contains('show') && !dialogEl.contains(document.activeElement) && !controls.contains(document.activeElement)) prompt.focus({ preventScroll: true });
    }, 80);
  }

  function closeDialog() {
    if (!dialogEl) return;
    controls.close();
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
      controls.sync([batchDeckEl, batchStatusEl]);
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
    if ((event.ctrlKey || event.metaKey || event.altKey) && (ratingButtons.includes(button) || nextButtons.includes(button))) {
      event.preventDefault(); return;
    }
    if (action === 'review-mark-retry') { if (pendingRating) submitRating(pendingRating); return; }
    if (action === 'review-show-scheduled') { showMode('scheduled'); return; }
    if (action === 'review-show-free') { showMode('free'); return; }
    if (action === 'review-show-library') { showMode('library'); return; }
    if (action === 'review-import-open') { openImportDialog(button); return; }
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
    if (event.detail > 1 && (ratingButtons.includes(button) || nextButtons.includes(button))) return;
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
    cardDeckControl = controls.bindInput(cardDeckInputEl, {
      label: () => tr('卡组（可选）'), allowCreate: true,
      createHint: () => tr('保存卡片时创建'), value: () => cardDeckInputEl.value,
      choices: () => [{ value: '', label: tr('未分类') }, ...reviewDecks.map(deck => ({ value: deck.name, label: deck.name }))],
      choose(value) { cardDeckInputEl.value = value; syncDeckPickerState(); },
      onInput: syncDeckPickerState,
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
    controls.sync(scopeSelectEl);
    try {
      await persistReviewSettings(change, '复习范围已切换');
    } catch (error) {
      syncScopeSelect();
      toast((error && error.message) || '切换复习范围失败');
    } finally {
      scopeSelectEl.disabled = false;
      controls.sync(scopeSelectEl);
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
      controls.close();
      controls.refresh();
      if (viewMode === 'session') {
        if (current && feedback) {
          updateCardMetadata(); updateStats(); updateSessionProgress(); updateRatingGate();
          if (!String(current.answer || '').trim()) setText(answerRevealEl, tr('未填写答案'));
        } else if (current) renderCard(current);
        else renderEmpty();
      } else {
        updateStats();
      }
    });
  }
  function reviewKey(event) {
    return event.code === 'Space' || event.key === ' ' ? ' ' : String(event.key || '').toLowerCase();
  }
  document.addEventListener('keyup', event => heldReviewKeys.delete(reviewKey(event)), true);
  window.addEventListener('blur', () => heldReviewKeys.clear());
  document.addEventListener('keydown', (event) => {
    if (importController?.isOpen) return;
    if (event.isComposing || event.keyCode === 229 || event.defaultPrevented || controls.contains(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey || document.hidden || document.documentElement.dataset.desktopMinimized === '1') return;
    if (event.key === 'Escape') {
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
    if (target && target.closest && target.closest('input, textarea, select, [role="combobox"], [contenteditable="true"]')) return;
    if (event.key === '?') {
      event.preventDefault();
      if (viewMode === 'library') openLibraryHelpDialog();
      else openHelpDialog();
      return;
    }
    if (viewMode !== 'session') return;
    if (!current) return;
    const key = reviewKey(event), continuedKey = continueKeys.has(key);
    const held = heldReviewKeys.has(key);
    if (continuedKey) heldReviewKeys.add(key);
    if (continuedKey && (event.repeat || held)) { event.preventDefault(); return; }
    const focusedButton = target && target.closest && target.closest('button');
    if ((key === ' ' || key === 'enter') && focusedButton
        && !ratingButtons.includes(focusedButton) && !nextButtons.includes(focusedButton)) return;
    if (feedback) {
      if (continuedKey) { event.preventDefault(); continueCard(); }
      return;
    }
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

  controls.enhanceAll();
  root.dataset.reviewMode = reviewMode;
  syncPrimaryModeControls();
  updateRatingGate();
  window.CanvasReview = {
    activate: activateReview,
    reload: reloadReview,
  };

  document.addEventListener('start:viewchange', (event) => {
    if (!event.detail || event.detail.current !== 'review') {
      sessionGeneration++; statsSequence++;
      importOpenSequence++;
      importController?.close();
      controls.close();
      clearTransientMotion();
      cancelMathReadyWait();
      cancelMathLoadSchedule();
    }
  });
  window.addEventListener('pagehide', () => {
    sessionGeneration++; statsSequence++;
    importOpenSequence++;
    importController?.close();
    controls.close();
    clearTransientMotion();
    cancelMathReadyWait();
    cancelMathLoadSchedule();
  });
  const motionVisibility = () => {
    if (!statMotionVisible()) { clearStatMotion(); heldReviewKeys.clear(); }
  };
  document.addEventListener('visibilitychange', motionVisibility);
  window.addEventListener('canvasdesktop:visibility', motionVisibility);
  window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener('change', motionVisibility);
  schedulePreload();
})();
