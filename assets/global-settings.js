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
  let adapter = null, orderList = null, dialog = null;
  const definitions = [
    ['appearance', ['外观', 'Appearance'], '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M3 21h18"/>', 'theme background 主题 背景'],
    ['workspaces', ['工作区', 'Workspaces'], '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', 'workspace visibility reorder 显示 隐藏 顺序 拖动'],
    ['navigation', ['画布与导航', 'Canvas & navigation'], '<path d="M4 4h16v16H4zM9 4v16"/>', 'canvas navigation search calendar speed 搜索 日历 翻页 滑块'],
    ['daily', ['日常', 'Daily'], '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>', 'daily calendar focus tasks ledger 日常 日历 专注 任务 记账 倒数日'],
    ['learning', ['学习与树状', 'Learning & trees'], '<path d="M12 3v7M5 10h14M5 10v6m14-6v6"/><rect x="2" y="16" width="6" height="5" rx="1"/><rect x="16" y="16" width="6" height="5" rx="1"/>', 'study tree unlock title color 学习 树状 解锁 标题 彩色'],
    ['starmap', ['星图', 'Star map'], '<circle cx="5" cy="5" r="2"/><circle cx="19" cy="7" r="2"/><circle cx="12" cy="19" r="2"/><path d="m7 5 10 2M6 7l5 10m7-8-5 8"/>', 'graph animation physics fit 动画 生长 阻尼 取景'],
    ['career', ['生涯', 'Career'], '<path d="M4 3v17h17M8 15l4-5 4 2 5-7"/>', 'career scroll inertia reveal 生涯 滚动 惯性 揭示'],
    ['usage', ['使用统计', 'Usage statistics'], '<path d="M5 21V11m7 10V3m7 18V7"/>', 'usage statistics tracking time 统计 记录 时间'],
  ];
  definitions.forEach(([id, label, iconMarkup, keywords]) => {
    const panel = document.createElement('section'); panels.set(id, panel);
    categories.push({ id, label, iconMarkup, keywords, panel, reset: () => resetCategory(id) });
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
  const canvas = features.workspaceEnabled('canvas');
  takeToggle('library-search-toggle', 'navigation', features.enabled('canvas.library'));
  takeToggle('hide-special-toggle', 'navigation', canvas && ['canvas.review', 'canvas.activity', 'canvas.quicknotes', 'canvas.tree', 'canvas.study'].some(features.enabled));
  takeToggle('calendar-countdown-toggle', 'daily', features.enabled('daily.calendar'));
  takeRange('start-speed-range', 'navigation', canvas); takeRange('spine-speed-range', 'navigation', canvas);
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
  source.remove();
  const hint = document.createElement('p'), rows = document.createElement('div');
  hint.dataset.i18nManaged = 'true'; rows.dataset.role = 'workspace-layout-list';
  panels.get('workspaces').append(hint, rows);
  const visibleCategories = categories.filter(category => category.panel.childElementCount);
  // Keep original controls queryable by page bindings; defer the modal chrome/list.
  content.hidden = true; visibleCategories.forEach(category => content.append(category.panel)); document.body.append(content);
  function ensureDialog() {
    if (dialog) return dialog;
    dialog = window.RelatumSettingsDialog.create({ id: 'global-settings-dialog', content, categories: visibleCategories, language, motion,
      labels: { title: ['全局设置', 'Settings'], 'reset-all': ['恢复全部设置', 'Reset all settings'], confirmAll: ['恢复全部全局设置？', 'Reset all global settings?'],
        confirmDescription: ['恢复工作区顺序、显示选择及本面板其他偏好。保留主题、语言、笔记设置、客户端窗口设置及所有内容。', 'Restore workspace order, visibility and other preferences in this panel. Keep theme, language, note settings, window settings and all content.'] },
      async resetAll() {
        await resetCategory('workspaces');
        for (const category of visibleCategories) if (category.id !== 'workspaces') await resetCategory(category.id);
      },
      onCategoryChange(id) { if (id !== 'workspaces') orderList?.suspend(); },
      onOpen() { trigger.setAttribute('aria-expanded', 'true'); orderList?.sync(); },
      onClose() { trigger.setAttribute('aria-expanded', 'false'); orderList?.suspend(); },
    });
    dialog.dialog.classList.add('global-settings-dialog'); ensureOrderList(); translate();
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
  async function resetCategory(id) {
    if (id === 'workspaces') {
      if (!await window.RelatumStartWorkspace.applyLayout(null, { reset: true })) throw new Error('Workspace handoff failed');
      orderList?.sync();
    } else if (id === 'daily') {
      localStorage.removeItem('daily:calendarCountdownEnabled');
      localStorage.removeItem('daily:calendarCountdownProgressMode');
      window.RelatumDailyLoader.applyCountdown(true);
      document.dispatchEvent(new Event('daily:settings-reset'));
    } else if (id === 'usage') window.RelatumUsage?.resetSettings();
    else await adapter?.reset(id);
  }
  function translate() {
    trigger.title = text('全局设置', 'Settings');
    trigger.setAttribute('aria-label', text('全局设置', 'Settings'));
    themeLabel.textContent = text('主题', 'Theme');
    hint.textContent = text('勾选要显示的工作区，拖动手柄或使用箭头调整顺序。全部取消后主区域留白，仍可从顶栏设置重新开启。', 'Choose which workspaces to show. Drag handles or use arrows to reorder. With all unchecked, the main area stays blank; reopen them here from the top bar.');
    dialog?.setLanguage(); orderList?.refresh();
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
