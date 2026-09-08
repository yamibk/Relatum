// 回收站管理页 — 起步页 2.0 第 3 点
// - 左栏：分组（最近 + 各组，带数字徽标）作为"恢复目标"
// - 右栏：回收站（canvases/回收站/）里的画布
// - ↑↓ 选中；← 恢复到「最近」（连续）；数字 1-9 恢复到第 N 组；拖到左栏组也可恢复
// - 复用 styles.css 的 .leaving 飞出动画（向左滑淡出 + 下方补位），即时处理 + 动画并行

(function () {
  'use strict';

  const main = document.querySelector('.start-main');
  const rail = document.querySelector('[data-role="group-rail"]');
  const fileList = document.querySelector('[data-role="file-list"]');
  const ctxMenu = document.querySelector('[data-role="context-menu"]');
  const toastEl = document.querySelector('[data-role="toast"]');
  const emptyTrashBtn = document.querySelector('[data-action="empty-trash"]');
  const emptyTrashConfirm = document.querySelector('[data-role="trash-confirm"]');
  const emptyTrashConfirmBtn = document.querySelector('[data-action="empty-confirm"]');
  const emptyTrashCancelBtn = document.querySelector('[data-action="empty-cancel"]');

  if (!main || !rail || !fileList) return;

  let lastGroups = [];
  let lastFiles = [];        // recent 文件（仅用于左栏分组计数）
  let trashFiles = [];       // 回收站文件（右栏）
  let trashEntryCount = 0;   // 固定回收站目录内的全部内容数量
  let selectedIndex = -1;
  let draggingPath = null;
  let isEmptyingTrash = false;

  function T(message) {
    return window.RelatumI18n ? window.RelatumI18n.t(String(message || '')) : String(message || '');
  }
  document.title = T('回收站 — 画布');

  // ── 顶栏按钮 ───────────────────────────────────
  const backBtn = document.querySelector('[data-action="back"]');
  if (backBtn) backBtn.addEventListener('click', () => { window.location.href = 'index.html'; });

  function gotoEditor(path) {
    window.location.href = 'editor.html?file=' + encodeURIComponent(path);
  }

  // ── 相对时间 ──────────────────────────────────
  function formatRelTime(iso) {
    if (!iso) return '';
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return '';
    const now = new Date();
    const diffMs = now - then;
    const min = 60 * 1000, hour = 60 * min, day = 24 * hour;
    if (diffMs < min) return T('刚刚');
    if (diffMs < hour) return T(Math.floor(diffMs / min) + ' 分钟前');
    if (diffMs < day) return T(Math.floor(diffMs / hour) + ' 小时前');
    if (diffMs < 7 * day) return T(Math.floor(diffMs / day) + ' 天前');
    return then.getFullYear() + '-'
      + String(then.getMonth() + 1).padStart(2, '0') + '-'
      + String(then.getDate()).padStart(2, '0');
  }

  function groupName(gid) {
    if (gid === '') return '未分组';
    const g = lastGroups.find((x) => x.id === gid);
    return g ? g.name : '未分组';
  }
  function groupFileCount(gid) {
    const validIds = new Set(lastGroups.map((g) => g.id));
    return lastFiles.filter((f) => {
      const g = f.groupId || '';
      const inValid = g && validIds.has(g);
      return gid === '' ? !inValid : g === gid;
    }).length;
  }

  // ── 渲染 ──────────────────────────────────────
  function render() {
    renderRail();
    renderPanel();
  }

  function renderRail() {
    rail.innerHTML = '';
    const items = [{ id: '', name: '未分组', special: true }].concat(lastGroups);
    items.forEach((g, i) => {
      const item = document.createElement('div');
      item.className = 'rail-item';
      item.dataset.groupId = g.id;
      item.tabIndex = 0;

      const badge = document.createElement('span');
      badge.className = 'rail-badge';
      badge.textContent = i <= 9 ? String(i) : '';

      const name = document.createElement('span');
      name.className = 'rail-name';
      name.textContent = g.special ? T(g.name) : g.name;
      if (!g.special) name.setAttribute('data-user-content', '');

      const left = document.createElement('span');
      left.className = 'rail-left';
      left.append(badge, name);

      const count = document.createElement('span');
      count.className = 'rail-count';
      count.textContent = String(groupFileCount(g.id));

      item.append(left, count);
      // 点击 = 把当前选中的回收站文件恢复到这个组
      item.addEventListener('click', () => {
        if (selectedIndex < 0 || !trashFiles[selectedIndex]) { showToast(T('先用 ↑↓ 选中一个画布')); return; }
        doRestore(selectedIndex, g.id, '已恢复到「' + g.name + '」');
      });
      // 拖拽放置目标
      item.addEventListener('dragover', (e) => {
        if (!draggingPath) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const path = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || draggingPath;
        draggingPath = null;
        if (!path) return;
        const idx = trashFiles.findIndex((x) => x.path === path);
        if (idx >= 0) doRestore(idx, g.id, '已恢复到「' + g.name + '」');
      });
      rail.appendChild(item);
    });
  }

  function renderPanel() {
    fileList.innerHTML = '';
    if (emptyTrashBtn) emptyTrashBtn.disabled = trashEntryCount === 0 || isEmptyingTrash;
    if (trashFiles.length === 0) {
      selectedIndex = -1;
      const empty = document.createElement('li');
      empty.className = 'group-empty';
      empty.textContent = trashEntryCount === 0
        ? T('回收站是空的')
        : T('回收站中有其他内容，可使用一键清空永久删除');
      fileList.appendChild(empty);
      return;
    }
    if (selectedIndex >= trashFiles.length) selectedIndex = trashFiles.length - 1;
    trashFiles.forEach((f, i) => {
      const li = buildFileItem(f);
      if (i === selectedIndex) li.classList.add('file-selected');
      fileList.appendChild(li);
    });
  }

  function buildFileItem(f) {
    const li = document.createElement('li');
    li.className = 'recent-item';
    li.dataset.path = f.path;
    li.tabIndex = 0;

    const title = document.createElement('div');
    title.className = 'recent-item-title';
    title.textContent = f.title || T('(未命名)');
    if (f.title) title.setAttribute('data-user-content', '');

    const meta = document.createElement('div');
    meta.className = 'recent-item-meta';
    const when = document.createElement('span');
    when.className = 'recent-item-when';
    when.textContent = f.trashedAt ? T('删除于') + ' ' + formatRelTime(f.trashedAt) : '';
    const where = document.createElement('span');
    where.className = 'recent-item-where';
    where.textContent = f.path;
    where.title = f.path;
    where.setAttribute('data-user-content', '');
    meta.append(when, where);
    li.append(title, meta);

    li.addEventListener('click', () => gotoEditor(f.path));    // 点击=打开查看
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openFileMenu(e.clientX, e.clientY, f);
    });

    li.draggable = true;
    li.addEventListener('dragstart', (e) => {
      draggingPath = f.path;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', f.path); } catch (err) {}
      li.classList.add('dragging');
      closeContextMenu();
    });
    li.addEventListener('dragend', () => {
      draggingPath = null;
      li.classList.remove('dragging');
      rail.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    });
    return li;
  }

  // ── 选中 + 动画 ───────────────────────────────
  function activeItems() { return fileList.querySelectorAll('.recent-item:not(.leaving)'); }
  function refreshSelectionHighlight() {
    const items = activeItems();
    items.forEach((li, i) => li.classList.toggle('file-selected', i === selectedIndex));
    if (selectedIndex >= 0 && items[selectedIndex]) items[selectedIndex].scrollIntoView({ block: 'nearest' });
  }
  function setSelected(i) {
    const items = activeItems();
    if (items.length === 0) { selectedIndex = -1; return; }
    selectedIndex = Math.max(0, Math.min(i, items.length - 1));
    refreshSelectionHighlight();
  }
  function animateOut(li) {
    if (!li) return;
    li.style.height = li.offsetHeight + 'px';
    li.classList.remove('file-selected');
    li.classList.add('leaving');
    void li.offsetHeight;
    li.style.height = '0px';
    let done = false;
    const fin = () => { if (done) return; done = true; li.remove(); };
    li.addEventListener('transitionend', (e) => { if (e.propertyName === 'height') fin(); });
    setTimeout(fin, 420);
  }

  let toastTimer = null;
  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = T(msg);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1200);
  }

  function openEmptyTrashConfirm() {
    if (!emptyTrashConfirm || trashEntryCount === 0 || isEmptyingTrash) return;
    emptyTrashConfirm.hidden = false;
  }

  function closeEmptyTrashConfirm() {
    if (isEmptyingTrash) return;
    if (emptyTrashConfirm) emptyTrashConfirm.hidden = true;
  }

  async function emptyTrashPermanently() {
    if (isEmptyingTrash) return;
    isEmptyingTrash = true;
    if (emptyTrashConfirmBtn) emptyTrashConfirmBtn.disabled = true;
    if (emptyTrashBtn) emptyTrashBtn.disabled = true;
    try {
      const response = await fetch('/api/trash-empty', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || T('清空失败'));
      trashFiles = [];
      trashEntryCount = 0;
      selectedIndex = -1;
      if (emptyTrashConfirm) emptyTrashConfirm.hidden = true;
      renderPanel();
      showToast(result.deleted > 0 ? T('回收站已清空') : T('回收站已经是空的'));
    } catch (err) {
      window.alert(T('清空回收站失败：') + err.message);
      await refresh();
    } finally {
      isEmptyingTrash = false;
      if (emptyTrashConfirmBtn) emptyTrashConfirmBtn.disabled = false;
      renderPanel();
    }
  }

  // 恢复：即时移除 + 飞出动画 + 静默接口；高亮落到下一个 → 连续恢复
  function doRestore(idx, gid, msg) {
    const f = trashFiles[idx];
    if (!f) return;
    const li = activeItems()[idx];
    trashFiles.splice(idx, 1);
    trashEntryCount = Math.max(0, trashEntryCount - (Number(f.entryCount) || 1));
    // 乐观更新左栏计数：恢复的文件进入目标组（gid 空=未分组），与主界面一致实时刷新
    const entry = { path: f.path, title: f.title };
    entry.groupId = gid || '';
    lastFiles.push(entry);
    renderRail();
    animateOut(li);
    showToast(msg);
    fetch('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: f.path, group: gid }),
    }).then((r) => { if (!r.ok) refresh(); }).catch(() => refresh());
    selectedIndex = Math.min(idx, trashFiles.length - 1);
    refreshSelectionHighlight();
    if (trashFiles.length === 0) {
      setTimeout(() => { if (trashFiles.length === 0) renderPanel(); }, 280);
    }
  }

  function restoreSelectedToIndex(n) {
    const f = trashFiles[selectedIndex];
    if (!f) { showToast(T('先用 ↑↓ 选中一个画布')); return; }
    if (n > lastGroups.length) { showToast(T('没有第 ' + n + ' 个分组')); return; }
    doRestore(selectedIndex, lastGroups[n - 1].id, '已恢复到「' + lastGroups[n - 1].name + '」');
  }

  // ── 右键菜单 ───────────────────────────────────
  function clearMenu() { ctxMenu.innerHTML = ''; }
  function addMenuItem(label, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); closeContextMenu(); fn(); });
    ctxMenu.appendChild(b);
  }
  function addMenuLabel(text) {
    const d = document.createElement('div');
    d.className = 'ctx-label';
    d.textContent = text;
    ctxMenu.appendChild(d);
  }
  function addMenuSep() {
    const d = document.createElement('div');
    d.className = 'ctx-sep';
    ctxMenu.appendChild(d);
  }
  function showMenuAt(x, y) {
    ctxMenu.hidden = false;
    ctxMenu.style.left = '0px';
    ctxMenu.style.top = '0px';
    const rect = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    ctxMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
  }
  function closeContextMenu() { if (ctxMenu) { ctxMenu.hidden = true; clearMenu(); } }

  function openFileMenu(x, y, f) {
    if (!ctxMenu) return;
    clearMenu();
    addMenuItem(T('打开查看'), () => gotoEditor(f.path));
    addMenuSep();
    addMenuLabel(T('恢复到'));
    const idx = () => trashFiles.findIndex((t) => t.path === f.path);
    addMenuItem(T('最近'), () => { const i = idx(); if (i >= 0) doRestore(i, '', '已恢复到「最近」'); });
    lastGroups.forEach((g) => {
      addMenuItem(g.name, () => { const i = idx(); if (i >= 0) doRestore(i, g.id, '已恢复到「' + g.name + '」'); });
    });
    showMenuAt(x, y);
  }

  if (ctxMenu) {
    document.addEventListener('click', closeContextMenu);
    window.addEventListener('blur', closeContextMenu);
    ctxMenu.addEventListener('click', (e) => e.stopPropagation());
  }

  if (emptyTrashBtn) emptyTrashBtn.addEventListener('click', openEmptyTrashConfirm);
  if (emptyTrashCancelBtn) emptyTrashCancelBtn.addEventListener('click', closeEmptyTrashConfirm);
  if (emptyTrashConfirmBtn) emptyTrashConfirmBtn.addEventListener('click', emptyTrashPermanently);
  if (emptyTrashConfirm) {
    emptyTrashConfirm.addEventListener('mousedown', (e) => {
      if (e.target === emptyTrashConfirm) closeEmptyTrashConfirm();
    });
  }

  // ── 键盘 ──────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (emptyTrashConfirm && !emptyTrashConfirm.hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeEmptyTrashConfirm();
      }
      return;
    }
    if (ctxMenu && !ctxMenu.hidden) { if (e.key === 'Escape') closeContextMenu(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(selectedIndex < 0 ? 0 : selectedIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(selectedIndex < 0 ? 0 : selectedIndex - 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (selectedIndex >= 0 && trashFiles[selectedIndex]) doRestore(selectedIndex, '', '已恢复到「最近」');
      else showToast(T('先用 ↑↓ 选中一个画布'));
    } else if (e.key === 'Enter') {
      const f = trashFiles[selectedIndex];
      if (f) { e.preventDefault(); gotoEditor(f.path); }
    } else if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      restoreSelectedToIndex(parseInt(e.key, 10));
    }
  });

  // ── 拉取数据 ───────────────────────────────────
  async function refresh() {
    try {
      const [recentResp, trashResp] = await Promise.all([
        fetch('/api/recent'),
        fetch('/api/trash-list', { method: 'POST' }),
      ]);
      const recentJson = await recentResp.json();
      const trashJson = await trashResp.json();
      lastGroups = (recentJson && recentJson.groups) || [];
      lastFiles = (recentJson && recentJson.files) || [];
      trashFiles = (trashJson && trashJson.files) || [];
      trashEntryCount = Number.isInteger(trashJson && trashJson.entryCount)
        ? trashJson.entryCount
        : (Number.isInteger(trashJson && trashJson.itemCount)
          ? trashJson.itemCount
          : trashFiles.length);
      render();
    } catch (err) {
      console.warn('[画布] 加载回收站失败', err);
    }
  }

  refresh();
})();
