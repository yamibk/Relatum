// Common settings composition. Existing page modules still own their preferences.
(function () {
  'use strict';
  const features = window.RelatumFeatureRuntime;
  const source = document.querySelector('[data-role="global-settings-source"]');
  const trigger = document.querySelector('[data-action="start-speed-toggle"]');
  if (!source || !trigger) return;
  const content = document.createElement('div'), motion = matchMedia('(prefers-reduced-motion: reduce)');
  const language = () => window.RelatumI18n?.language || 'zh-CN';
  const text = (zh, en) => language() === 'en' ? en : zh;
  const panels = new Map(), categories = [];
  let adapter = null, orderList = null, dialog = null, usageManager = null, usageLoading = null, usageActive = false;
  function usageVisibility(active) {
    usageActive = active;
    if (!active) { usageManager?.suspend(); return; }
    if (usageManager) { usageManager.activate(); return; }
    if (!usageLoading) usageLoading = import('./usage-management.js').then(module => {
      usageManager = module.createUsageManagement(usage, { notesEnabled: features.enabled('notes') });
      if (usageActive) usageManager.activate();
    }).catch(() => { usageLoading = null; if (usageActive) dialog?.setStatus(text('统计管理未能加载，请重新打开后重试。', 'Could not load usage management. Reopen to retry.')); });
  }
  const pageLists = new Map(), pageSections = new Map(), pageAvailability = new Map();
  const definitions = [
    ['appearance', ['外观', 'Appearance'], '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M3 21h18"/>', 'theme background language 主题 背景 语言 中文 英文'],
    ['workspaces', ['工作区', 'Workspaces'], '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', 'workspace visibility reorder 显示 隐藏 顺序 拖动'],
    ['navigation', ['导航', 'Navigation'], '<path d="M4 4h16v16H4zM9 4v16"/>', 'canvas daily navigation visibility hide search calendar speed reorder 画布 日常 显示 隐藏 搜索 日历 翻页 滑块 顺序 拖动'],
    ['daily', ['日常', 'Daily'], '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>', 'daily calendar focus tasks ledger 日常 日历 专注 任务 记账 倒数日'],
    ['learning', ['学习与树状', 'Learning & trees'], '<path d="M12 3v7M5 10h14M5 10v6m14-6v6"/><rect x="2" y="16" width="6" height="5" rx="1"/><rect x="16" y="16" width="6" height="5" rx="1"/>', 'study tree unlock title color 学习 树状 解锁 标题 彩色'],
    ['starmap', ['星图', 'Star map'], '<circle cx="5" cy="5" r="2"/><circle cx="19" cy="7" r="2"/><circle cx="12" cy="19" r="2"/><path d="m7 5 10 2M6 7l5 10m7-8-5 8"/>', 'graph animation physics fit 动画 生长 阻尼 取景'],
    ['career', ['生涯', 'Career'], '<path d="M4 3v17h17M8 15l4-5 4 2 5-7"/>', 'career scroll inertia reveal 生涯 滚动 惯性 揭示'],
    ['usage', ['使用统计', 'Usage statistics'], '<path d="M5 21V11m7 10V3m7 18V7"/>', 'usage statistics tracking time archive backup data 统计 记录 时间 归档 备份 数据管理'],
    ['system', ['系统', 'System'], '<path d="M4 4h16v12H4zM8 20h8m-4-4v4"/>', 'system desktop launcher startup preload daily retention memory 系统 启动器 启动 弹窗 预加载 日常 保留 内存'],
  ];
  definitions.forEach(([id, label, iconMarkup, keywords]) => {
    const panel = document.createElement('section'); panels.set(id, panel);
    categories.push({ id, label, iconMarkup, keywords, panel, searchMode: id === 'usage' ? 'category' : undefined, reset: () => resetCategory(id) });
  });
  function take(selector, category, enabled = true) {
    source.querySelectorAll(selector).forEach(element => {
      if (enabled) panels.get(category).append(element); else element.remove();
    });
  }
  function toggle(role, category, enabled) { take('[data-role="' + role + '"]', category, enabled); }
  // Move complete labels, retaining their original controls for business bindings.
  function takeToggle(role, category, enabled) {
    const element = source.querySelector('[data-role="' + role + '"]')?.closest('label');
    if (element) { if (enabled) panels.get(category).append(element); else element.remove(); }
  }
  function takeRange(role, category, enabled) {
    const input = source.querySelector('[data-role="' + role + '"]');
    if (!input) return;
    const wrap = input.parentElement, head = wrap.previousElementSibling, scale = wrap.nextElementSibling;
    if (!enabled) { wrap.remove(); head?.remove(); scale?.remove(); return; }
    const label = document.createElement('label'); label.className = 'global-settings-range';
    label.setAttribute('aria-label', input.getAttribute('aria-label'));
    label.append(head, wrap, scale); panels.get(category).append(label);
  }
  take('.start-panel-theme, .start-priority-background', 'appearance');
  const themeLabel = document.createElement('strong'); themeLabel.dataset.i18nManaged = 'true';
  panels.get('appearance').querySelector('.start-panel-theme')?.prepend(themeLabel);
  const languageSetting = document.createElement('div');
  languageSetting.className = 'start-priority-background'; languageSetting.dataset.i18nManaged = 'true';
  languageSetting.dataset.settingsKeywords = '界面语言 切换语言 中文 英文 language Chinese English';
  languageSetting.innerHTML = '<div class="start-speed-head"><span></span></div><div class="start-background-switch" data-role="global-language-switch" role="group"><button type="button" data-language="zh-CN"></button><button type="button" data-language="en"></button></div>';
  const languageSwitch = languageSetting.querySelector('[data-role="global-language-switch"]');
  languageSwitch.querySelectorAll('button').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.language !== language()) window.RelatumI18n.setLanguage(button.dataset.language);
    });
  });
  panels.get('appearance').append(languageSetting);
  const canvas = features.workspaceEnabled('canvas');
  takeToggle('library-search-toggle', 'navigation', features.enabled('canvas.library'));
  takeToggle('calendar-countdown-toggle', 'daily', features.enabled('daily.calendar'));
  const hasPageNavigation = canvas || features.workspaceEnabled('daily');
  takeRange('start-speed-range', 'navigation', hasPageNavigation); takeRange('spine-speed-range', 'navigation', hasPageNavigation);
  const learning = features.enabled('canvas.study') || features.enabled('canvas.tree');
  takeToggle('goal-tree-simple-toggle', 'learning', learning);
  takeToggle('goal-tree-unlock-toggle', 'learning', learning);
  takeToggle('tree-page-root-title-toggle', 'learning', features.enabled('canvas.tree'));
  const titleSize = source.querySelector('.start-root-title-size-setting');
  if (titleSize) { if (features.enabled('canvas.tree')) panels.get('learning').append(titleSize); else titleSize.remove(); }
  source.querySelectorAll('.start-dark-card-settings section').forEach(section => {
    const page = section.querySelector('[data-page]')?.dataset.page;
    if (!features.enabled('canvas.' + page)) section.remove();
  });
  take('.start-dark-card-settings', 'learning', learning);
  takeToggle('starmap-motion-toggle', 'starmap', features.enabled('canvas.activity'));
  toggle('starmap-motion-settings', 'starmap', features.enabled('canvas.activity'));
  toggle('career-scroll-feel-settings', 'career', features.enabled('career'));
  const usage = document.querySelector('[data-usage-panel]');
  const usageFeatures = ['notes', 'canvas.editor', 'canvas.library', 'notes.canvas', 'research', 'canvas.study', 'canvas.tree', 'canvas.quicknotes', 'canvas.review', 'daily.tasks'];
  if (usage && usageFeatures.some(features.enabled)) panels.get('usage').append(usage); else usage?.remove();
  const launcherSetting = document.querySelector('[data-role="launcher-setting"]');
  const systemEntry = window.CanvasDesktop && launcherSetting ? launcherSetting.cloneNode(true) : null;
  if (systemEntry) {
    systemEntry.className = 'start-setting-toggle';
    systemEntry.querySelector('input').dataset.role = 'global-launcher-skip-selection';
    panels.get('system').append(systemEntry);
  }
  const systemPolicy = window.RelatumGlobalSystem;
  const systemIntro = document.createElement('p'); systemIntro.dataset.i18nManaged = 'true';
  const preloadSetting = document.createElement('label'); preloadSetting.className = 'start-setting-toggle'; preloadSetting.dataset.i18nManaged = 'true';
  preloadSetting.dataset.settingsKeywords = '后台 预加载 启动 preload background startup';
  preloadSetting.innerHTML = '<span><strong></strong><small></small><small data-global-preload-status></small></span><input type="checkbox" data-role="global-system-preload">';
  const preloadInput = preloadSetting.querySelector('input');
  preloadInput.addEventListener('change', () => saveSystem({ preload: preloadInput.checked }));
  const retentionSetting = document.createElement('fieldset'); retentionSetting.className = 'global-system-retention'; retentionSetting.dataset.i18nManaged = 'true';
  retentionSetting.dataset.settingsKeywords = '日常 页面 保留 时长 内存 返回 daily retention memory return';
  retentionSetting.innerHTML = '<legend></legend><p id="global-retention-hint"></p><div class="global-system-choices"></div>';
  const retentionLabels = {
    immediate: ['立即释放', 'Release immediately'], '30s': ['30 秒', '30 seconds'],
    '5m': ['5 分钟', '5 minutes'], session: ['直到关闭窗口', 'Until window closes'],
  };
  for (const value of Object.keys(retentionLabels)) {
    const label = document.createElement('label'), radio = document.createElement('input'), caption = document.createElement('span');
    radio.type = 'radio'; radio.name = 'global-daily-retention'; radio.value = value; radio.dataset.role = 'global-daily-retention';
    radio.setAttribute('aria-describedby', 'global-retention-hint');
    radio.addEventListener('change', () => { if (radio.checked) saveSystem({ dailyRetention: value }); });
    label.append(radio, caption); retentionSetting.querySelector('div').append(label);
  }
  panels.get('system').append(systemIntro, preloadSetting);
  if (features.workspaceEnabled('daily')) panels.get('system').append(retentionSetting);
  function saveSystem(patch) {
    if (!systemPolicy.update(patch)) dialog?.setStatus(text('未能保存系统设置，选择已恢复。', 'Could not save system settings. Your selection was restored.'));
    refreshSystem();
  }
  function refreshSystem() {
    const value = systemPolicy.read();
    systemIntro.textContent = text('按需调整首次打开速度与返回速度。更快的切换可能占用更多内存。', 'Adjust first-open and return speed. Faster switching may use more memory.');
    preloadSetting.querySelector('strong').textContent = text('后台预加载', 'Background preloading');
    preloadSetting.querySelector('small').textContent = text('下次启动生效。空闲时提前准备已有功能，提高首次打开速度；会增加后台读取与资源占用。', 'Applies at next launch. Prepare existing features while idle for faster first opening, using additional background reads and resources.');
    preloadInput.checked = value.preload; preloadInput.disabled = !features.enabled('runtime.preload');
    preloadSetting.querySelector('[data-global-preload-status]').textContent = !features.enabled('runtime.preload')
      ? text('本次启动器已关闭后台预加载；需在启动器启用后才可使用。', 'Preloading is disabled by the launcher for this session. Enable it in the launcher to use it.')
      : features.preloadEnabled ? text('本次启动：已启用', 'This launch: enabled') : text('本次启动：未启用', 'This launch: disabled');
    retentionSetting.querySelector('legend').textContent = text('日常页面保留时长', 'Daily page retention');
    retentionSetting.querySelector('p').textContent = text('即时生效。离开日常工作区后保留已打开的页面，减少返回时的重复创建，但仍占用内存。刷新、打开独立编辑器或关闭窗口时释放；图片解码与绘图缓存仍会释放。', 'Applies immediately. Keep opened Daily pages after leaving for faster returns, using more memory. Refreshing, opening a separate editor or closing the window releases them; decoded images and drawing caches are still released.');
    retentionSetting.querySelectorAll('input').forEach(radio => {
      radio.checked = radio.value === value.dailyRetention;
      radio.nextElementSibling.textContent = text(...retentionLabels[radio.value]);
    });
  }
  window.addEventListener('relatum:global-system', refreshSystem);
  source.remove();
  const hint = document.createElement('p'), rows = document.createElement('div');
  hint.dataset.i18nManaged = 'true'; rows.dataset.role = 'workspace-layout-list';
  panels.get('workspaces').append(hint, rows);
  for (const workspace of ['canvas', 'daily']) {
    if (!features.workspaceEnabled(workspace)) continue;
    const section = document.createElement('section'), title = document.createElement('h3'), description = document.createElement('p'), list = document.createElement('div');
    section.className = 'global-page-order'; section.dataset.pageOrderWorkspace = workspace;
    title.dataset.i18nManaged = description.dataset.i18nManaged = 'true';
    list.dataset.role = workspace + '-page-order-list'; section.append(title, description, list);
    panels.get('navigation').append(section); pageSections.set(workspace, { title, description, list });
  }
  const visibleCategories = categories.filter(category => category.panel.childElementCount);
  // Keep original controls queryable by page bindings; defer the modal chrome/list.
  content.hidden = true; visibleCategories.forEach(category => content.append(category.panel)); document.body.append(content);
  function ensureDialog() {
    if (dialog) return dialog;
    const activeCategories = visibleCategories;
    dialog = window.RelatumSettingsDialog.create({ id: 'global-settings-dialog', content, categories: activeCategories, language, motion,
      labels: { title: ['全局设置', 'Settings'], 'reset-all': ['恢复全部设置', 'Reset all settings'], confirmAll: ['恢复全部全局设置？', 'Reset all global settings?'],
        confirmDescription: ['恢复工作区顺序、显示选择及本面板其他偏好。保留主题、语言、笔记设置、客户端窗口设置及所有内容。', 'Restore workspace order, visibility and other preferences in this panel. Keep theme, language, note settings, window settings and all content.'] },
      async resetAll() {
        await resetCategory('workspaces');
        for (const category of activeCategories) if (category.id !== 'workspaces') await resetCategory(category.id);
      },
      onCategoryChange(id) { usageVisibility(id === 'usage'); if (id !== 'workspaces') orderList?.suspend(); if (id !== 'navigation') pageLists.forEach(list => list.suspend()); },
      onKeyDown(event) { return usageActive && usageManager?.onKeyDown(event); },
      onOpen() { trigger.setAttribute('aria-expanded', 'true'); orderList?.sync(); pageLists.forEach(list => list.sync()); },
      onClose() { usageVisibility(false); trigger.setAttribute('aria-expanded', 'false'); orderList?.suspend(); pageLists.forEach(list => list.suspend()); },
    });
    dialog.dialog.classList.add('global-settings-dialog'); ensureOrderList(); ensurePageLists(); translate();
    return dialog;
  }
  function ensureOrderList() {
    if (orderList || !window.RelatumStartWorkspace) return;
    orderList = window.RelatumSettingsOrderList.create({ ids: features.workspaces.map(item => item.id), names: Object.fromEntries(features.workspaces.map(item => [item.id, item.label])),
      language, motion, available: features.workspaceEnabled, read: () => window.RelatumStartWorkspace.layout,
      commit: value => window.RelatumStartWorkspace.applyLayout(value),
      onError() { dialog.setStatus(text('未能离开当前工作区，显示选择已恢复。请检查保存后重试。', 'Could not leave the current workspace. Visibility was restored. Check saving and retry.')); },
    });
    orderList.initPanel(rows);
  }
  function pageListData(workspace) {
    const model = window.RelatumPageLayout, items = model.items(workspace, { includeHidden: true });
    return { ids: model.layout(workspace).order, names: Object.fromEntries(items.map(item => [item.id, item.label])), available: new Set(items.map(item => item.id)) };
  }
  function ensurePageLists() {
    pageSections.forEach(({ list: host }, workspace) => {
      if (pageLists.has(workspace)) return;
      const data = pageListData(workspace); pageAvailability.set(workspace, data.available);
      const list = window.RelatumSettingsOrderList.create({ ids: data.ids, names: data.names,
        language, motion, available: id => pageAvailability.get(workspace).has(id),
        read: () => window.RelatumPageLayout.layout(workspace), commit: value => window.RelatumPageLayout.apply(workspace, value),
        onError() { dialog.setStatus(text('未能保存页面显示设置，选择已恢复。请检查保存后重试。', 'Could not change page visibility. Your selection was restored. Check saving and retry.')); },
      });
      list.initPanel(host); pageLists.set(workspace, list);
    });
  }
  document.addEventListener('relatum:page-layout', event => {
    const workspace = event.detail.workspace, list = pageLists.get(workspace);
    if (list) { const data = pageListData(workspace); pageAvailability.set(workspace, data.available); list.setItems(data.ids, data.names); }
  });
  async function resetCategory(id) {
    if (id === 'workspaces') {
      if (!await window.RelatumStartWorkspace.applyLayout(null, { reset: true })) throw new Error('Workspace handoff failed');
      orderList?.sync();
    } else if (id === 'navigation') {
      for (const workspace of ['canvas', 'daily']) if (!await window.RelatumPageLayout.apply(workspace, null, { reset: true })) throw new Error('Page layout reset failed');
      await adapter?.reset(id);
    } else if (id === 'daily') {
      localStorage.removeItem('daily:calendarCountdownEnabled');
      localStorage.removeItem('daily:calendarCountdownProgressMode');
      window.RelatumDailyLoader.applyCountdown(true);
      document.dispatchEvent(new Event('daily:settings-reset'));
    } else if (id === 'system') {
      if (!systemPolicy.reset()) throw new Error(text('未能恢复系统设置，请重试。', 'Could not reset system settings. Please retry.'));
    } else if (id === 'usage') window.RelatumUsage?.resetSettings();
    else await adapter?.reset(id);
  }
  function translate() {
    refreshSystem();
    trigger.title = text('全局设置', 'Settings');
    trigger.setAttribute('aria-label', text('全局设置', 'Settings'));
    themeLabel.textContent = text('主题', 'Theme');
    languageSetting.querySelector('.start-speed-head span').textContent = text('界面语言', 'Interface language');
    languageSwitch.setAttribute('aria-label', text('界面语言', 'Interface language'));
    languageSwitch.querySelectorAll('button').forEach(button => {
      const active = button.dataset.language === language();
      button.textContent = button.dataset.language === 'en' ? text('英文', 'English') : text('中文', 'Chinese');
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    hint.textContent = text('勾选要显示的工作区，拖动手柄或使用箭头调整顺序。全部取消后主区域留白，仍可从顶栏设置重新开启。', 'Choose which workspaces to show. Drag handles or use arrows to reorder. With all unchecked, the main area stays blank; reopen them here from the top bar.');
    pageSections.forEach(({ title, description }, workspace) => {
      title.textContent = workspace === 'canvas' ? text('画布页面', 'Canvas pages') : text('日常页面', 'Daily pages');
      description.textContent = text('勾选要显示的页面，拖动手柄或使用箭头调整顺序。隐藏当前页后进入首个可见页，全部取消则留白；排序保持当前页。', 'Choose pages to show. Drag handles or use arrows to reorder. Hiding the current page opens the first visible page; uncheck all for a blank workspace. Reordering keeps the current page.');
    });
    dialog?.setLanguage(); orderList?.refresh(); pageLists.forEach(list => list.refresh());
  }
  trigger.addEventListener('click', () => { const settings = ensureDialog(); if (settings.isOpen) settings.close(); else settings.open({ trigger }); });
  document.addEventListener('relatum:languagechange', translate);
  document.addEventListener('visibilitychange', () => { if (document.hidden) dialog?.close({ instant: true, restoreFocus: false, reason: 'hidden' }); });
  window.addEventListener('canvasdesktop:visibility', () => { if (document.documentElement.dataset.desktopMinimized === '1') dialog?.close({ instant: true, restoreFocus: false, reason: 'minimized' }); });
  window.addEventListener('pagehide', () => dialog?.close({ instant: true, restoreFocus: false, reason: 'pagehide' }));
  window.RelatumGlobalSettings = Object.freeze({ configure(value) { adapter = value; },
    open(options) { ensureDialog().open({ trigger, ...options }); }, close(options) { dialog?.close(options); }, get dialog() { return ensureDialog().dialog; },
  });
  translate();
})();
