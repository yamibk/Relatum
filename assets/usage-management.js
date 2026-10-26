// Loaded only when Usage statistics is opened. No polling or background scans.
export function createUsageManagement(host, { notesEnabled }) {
  const tr = (zh, en) => (window.RelatumI18n?.language || document.documentElement.lang) === 'en' ? en : zh;
  const el = (tag, name, value) => { const node = document.createElement(tag); if (name) node.className = name; if (value) node.textContent = value; return node; };
  const button = (value, action) => { const node = el('button', '', value); node.type = 'button'; node.addEventListener('click', action); return node; };
  const duration = seconds => seconds >= 3600 ? `${(seconds/3600).toFixed(1)} ${tr('小时','h')}` : seconds >= 60 ? `${(seconds/60).toFixed(1)} ${tr('分钟','min')}` : `${Math.round(seconds*1000)/1000} ${tr('秒','s')}`;
  const root = el('section', 'usage-management'); root.dataset.usageManagement = ''; root.dataset.i18nManaged = 'true';
  const heading = el('h4'), description = el('p'), overview = el('p'), toolbar = el('div', 'usage-management-actions');
  const status = el('p', 'usage-management-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const exportButton = button('', exportBackup), previewButton = button('', loadPreview), refreshButton = button('', refresh);
  previewButton.hidden = !notesEnabled;
  toolbar.append(exportButton, previewButton, refreshButton);
  const previewHost = el('section', 'usage-archive-preview'), confirmHost = el('section', 'usage-archive-confirm');
  confirmHost.setAttribute('role', 'group'); confirmHost.setAttribute('aria-labelledby', 'usage-archive-confirm-title');
  previewHost.hidden = confirmHost.hidden = true;
  root.append(heading, description, overview, toolbar, status, previewHost, confirmHost); host.append(root);
  let active = false, epoch = 0, controller = null, busy = false, preview = null, summary = null, confirming = false;
  let selection = new Set(), pages = { deleted: 0, missing: 0 }, committing = false;
  const disabledStates = new WeakMap();
  let notice = null;
  function say(zh, en) { notice = [zh, en]; status.textContent = tr(zh, en); }
  const messages = {
    'preview-expired': ['预览已过期，请重新预览。', 'Preview expired. Load a fresh preview.'],
    'candidates-changed': ['候选文件已变化，请重新预览；本次没有归档。', 'Candidates changed. Nothing was archived; load a fresh preview.'],
    'invalid-selection': ['选择无效，请重新预览。', 'Invalid selection. Load a fresh preview.'],
    'backup-failed': ['备份导出失败，请重试。', 'Backup export failed. Please retry.'],
    'usage-unavailable': ['统计服务暂不可用，请重试。', 'Usage service unavailable. Please retry.'],
    'feature-disabled': ['本次启动未启用笔记。', 'Notes are disabled for this launch.']
  };
  function errorLabels(error) { return messages[error.code] || ['操作未能完成，请重试。', 'Could not complete the operation. Please retry.']; }
  async function request(url, body, signal) {
    const response = await fetch(url, { cache: 'no-store', signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { code: value.code });
    return value;
  }
  function setBusy(value) {
    busy = value; root.setAttribute('aria-busy', String(value));
    for (const control of root.querySelectorAll('button,input')) {
      if (value) { disabledStates.set(control, control.disabled); control.disabled = true; }
      else if (disabledStates.has(control)) { control.disabled = disabledStates.get(control); disabledStates.delete(control); }
    }
  }
  function translate() {
    if (notice) status.textContent = tr(...notice);
    heading.textContent = tr('数据管理', 'Data management');
    description.textContent = tr('归档保留累计统计，移除旧笔记的名称和逐篇明细。不会改动笔记或附件。', 'Archiving preserves accumulated statistics and removes old note names and individual history. Note files and attachments are unchanged.');
    exportButton.textContent = tr('导出统计备份', 'Export usage backup');
    previewButton.textContent = tr('归档已删除笔记的统计', 'Archive deleted note statistics');
    refreshButton.textContent = tr('刷新', 'Refresh');
    overview.textContent = summary ? tr(`保留逐篇明细 ${summary.notes} 篇 · 累计已归档 ${summary.archived} 篇`, `${summary.notes} notes with individual history · ${summary.archived} archived in total`) : '';
    if (preview && !busy) renderPreview();
    if (confirming && !busy) renderConfirmation();
  }
  async function refresh() {
    if (!active || busy) return;
    controller?.abort(); controller = new AbortController(); const own = ++epoch;
    try { const value = await request('/api/usage/management', undefined, controller.signal); if (active && own === epoch) { summary = value; translate(); } }
    catch (error) { if (active && own === epoch && error.name !== 'AbortError') say(...errorLabels(error)); }
  }
  async function loadPreview() {
    if (busy) return;
    controller?.abort(); controller = new AbortController(); const own = ++epoch;
    setBusy(true); say('正在核对候选…', 'Checking candidates…');
    try {
      await window.RelatumUsage?.flush();
      if (!active || own !== epoch) return;
      const value = await request('/api/usage/archive-preview', {}, controller.signal);
      if (!active || own !== epoch) return;
      preview = value; confirming = false; selection = new Set(value.candidates.filter(row => row.kind === 'deleted').map(row => row.id)); pages = { deleted: 0, missing: 0 };
      say('', ''); renderPreview();
    } catch (error) { if (active && own === epoch && error.name !== 'AbortError') say(...errorLabels(error)); }
    finally { setBusy(false); }
  }
  function selectedSummary() {
    const rows = preview.candidates.filter(row => selection.has(row.id));
    const first = rows.map(row => row.firstDay).filter(Boolean).sort()[0], last = rows.map(row => row.lastDay).filter(Boolean).sort().at(-1);
    return tr(`已选择 ${rows.length} 篇 · 逐篇时长合计 ${duration(rows.reduce((sum,row) => sum+row.seconds,0))}`, `${rows.length} selected · sum of individual times ${duration(rows.reduce((sum,row) => sum+row.seconds,0))}`) + (first ? ` · ${first} — ${last}` : '');
  }
  function renderPreview() {
    previewHost.replaceChildren(); previewHost.hidden = false; confirmHost.hidden = true;
    previewHost.append(el('h4', '', tr('归档预览', 'Archive preview')),
      el('p', '', tr('归档后无法直接恢复逐篇记录，可先导出备份。重叠时段仍只计一次，合计不等同于总使用时长。', 'Individual history cannot be restored directly after archiving; you can export a backup first. Overlapping intervals still count once, so individual sums may differ from total usage.')));
    if (!preview.candidates.length) { previewHost.append(el('p', '', tr('没有可归档的笔记。仍存在或无法安全核验的路径不会列入候选。', 'No notes are eligible. Existing paths and paths that cannot be safely checked are excluded.'))); return; }
    for (const kind of ['deleted', 'missing']) {
      const rows = preview.candidates.filter(row => row.kind === kind);
      if (!rows.length) continue;
      const group = el('section', 'usage-archive-group'); group.dataset.archiveGroup = kind;
      group.append(el('h5', '', (kind === 'deleted' ? tr('明确已删除', 'Confirmed deleted') : tr('旧路径缺失，待核对（默认不选）', 'Old path missing — review required (unchecked by default)')) + ` · ${rows.length}`));
      if (kind === 'missing') group.append(el('p', '', tr('文件可能在软件外被改名或移走。请确认不再需要逐篇历史后再勾选。', 'The file may have been renamed or moved outside Relatum. Select only after checking that its individual history is no longer needed.')));
      const page = pages[kind], list = el('div', 'usage-archive-list');
      rows.slice(page*40, page*40+40).forEach(row => {
        const label = el('label', 'usage-archive-row'), input = el('input'), name = el('span'), meta = el('small');
        input.type = 'checkbox'; input.checked = selection.has(row.id); input.dataset.archiveId = row.id;
        name.textContent = row.name; name.title = row.name;
        meta.textContent = duration(row.seconds) + (row.firstDay ? ` · ${row.firstDay} — ${row.lastDay}` : tr(' · 无使用时段', ' · no usage intervals'));
        input.addEventListener('change', () => { if (input.checked) selection.add(row.id); else selection.delete(row.id); updateSelection(); });
        const copy = el('span'); copy.append(name, meta); label.append(input, copy); list.append(label);
      });
      group.append(list);
      if (rows.length > 40) {
        const nav = el('div', 'usage-management-actions');
        const change = direction => {
          pages[kind] += direction; renderPreview();
          const group = previewHost.querySelector(`[data-archive-group="${kind}"]`);
          const preferred = group?.querySelector(`[data-archive-page="${direction > 0 ? 'next' : 'previous'}"]`);
          (preferred && !preferred.disabled ? preferred : group?.querySelector('[data-archive-page]:not(:disabled)'))?.focus({ preventScroll: true });
        };
        const prev = button(tr('上一页','Previous'), () => change(-1)), next = button(tr('下一页','Next'), () => change(1));
        prev.dataset.archivePage = 'previous'; next.dataset.archivePage = 'next';
        prev.disabled = !page; next.disabled = (page+1)*40 >= rows.length;
        nav.append(prev, el('span', '', `${page+1} / ${Math.ceil(rows.length/40)}`), next); group.append(nav);
      }
      previewHost.append(group);
    }
    const totals = el('p', 'usage-archive-selection'); totals.dataset.archiveSelection = '';
    const proceed = button(tr('归档所选笔记…', 'Archive selected notes…'), () => { confirming = true; renderConfirmation(); }); proceed.dataset.archiveReview = '';
    const cancel = button(tr('取消', 'Cancel'), () => { preview = null; previewHost.hidden = true; previewHost.replaceChildren(); previewButton.focus(); });
    const actions = el('div', 'usage-management-actions'); actions.append(cancel, proceed); previewHost.append(totals, actions); updateSelection();
  }
  function updateSelection() {
    const totals = previewHost.querySelector('[data-archive-selection]'), proceed = previewHost.querySelector('[data-archive-review]');
    if (totals) totals.textContent = selectedSummary();
    if (proceed) proceed.disabled = !selection.size;
  }
  function renderConfirmation() {
    previewHost.hidden = true; confirmHost.hidden = false; confirmHost.replaceChildren();
    const title = el('h4', '', tr('确认归档这些笔记的统计？', 'Archive statistics for these notes?'));
    title.tabIndex = -1; title.id = 'usage-archive-confirm-title';
    confirmHost.append(title, el('p', '', selectedSummary()), el('p', '', tr('这会永久移除所选笔记的名称与逐篇明细，保留累计统计。不会自动备份；如需恢复余地，请先导出统计备份。', 'This permanently removes the selected note names and individual history, preserving accumulated statistics. No automatic backup is made; export a backup first if you may need to restore.')));
    const actions = el('div', 'usage-management-actions');
    const cancel = button(tr('返回预览', 'Back to preview'), () => { confirming = false; renderPreview(); previewHost.querySelector('[data-archive-review]')?.focus(); });
    const accept = button(tr('确认归档', 'Confirm archive'), commit); accept.dataset.archiveConfirm = '';
    actions.append(cancel, accept); confirmHost.append(actions); title.focus({ preventScroll: true });
  }
  function announceArchive(value) {
    document.dispatchEvent(new CustomEvent('relatum:usage-archived', { detail: value }));
    try { localStorage.setItem('canvas:usageArchiveRevision:v1', String(value.archiveRevision)); } catch (_) {}
  }
  async function commit() {
    if (busy || !preview || !selection.size) return;
    const payload = { token: preview.token, ids: [...selection] };
    committing = true; setBusy(true); say('正在归档…', 'Archiving…');
    try {
      await window.RelatumUsage?.flush();
      const result = await request('/api/usage/archive-notes', payload);
      announceArchive(result); preview = null; selection.clear(); confirming = false;
      previewHost.replaceChildren(); confirmHost.replaceChildren(); previewHost.hidden = confirmHost.hidden = true;
      say(`已归档 ${result.count} 篇笔记的统计。` + (result.job ? ' 生涯报告正在更新；如生成失败，可在生涯中重试。' : result.reportPending ? ' 生涯报告待重新生成，请在生涯中重试。' : ''), `Archived statistics for ${result.count} notes.` + (result.job ? ' The career report is being refreshed; retry from Career if generation fails.' : result.reportPending ? ' Regenerate the report from Career.' : ''));
    } catch (error) { if (active) { const labels = errorLabels(error); say(labels[0] + ' 若结果不确定，可再次点击确认；重复提交不会重复归档。', labels[1] + ' If the result is uncertain, confirm again; retries do not archive twice.'); } }
    finally { committing = false; setBusy(false); if (active) { await refresh(); if (!preview) previewButton.focus({ preventScroll: true }); } }
  }
  async function exportBackup() {
    if (busy) return;
    setBusy(true); say('正在导出统计备份…', 'Exporting usage backup…');
    try {
      await window.RelatumUsage?.flush();
      if (document.documentElement.classList.contains('desktop-host')) {
        const value = await request('/api/usage/backup', {});
        if (active) { if (value.cancelled) say('已取消导出。', 'Export cancelled.'); else say('统计备份已导出。', 'Usage backup exported.'); }
      } else {
        const response = await fetch('/api/usage/backup', { cache: 'no-store' });
        if (!response.ok) throw Object.assign(new Error(), { code: 'backup-failed' });
        const url = URL.createObjectURL(await response.blob()), link = el('a');
        link.href = url; link.download = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || 'Relatum-usage-backup.zip';
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        if (active) say('统计备份已交给浏览器下载。', 'Usage backup sent to browser downloads.');
      }
    } catch (error) { if (active) say(...errorLabels(error)); }
    finally { setBusy(false); }
  }
  document.addEventListener('relatum:languagechange', translate);
  translate();
  return {
    activate() { active = true; refresh(); },
    suspend() { active = false; epoch++; controller?.abort(); if (!committing) { preview = null; selection.clear(); confirming = false; previewHost.hidden = confirmHost.hidden = true; previewHost.replaceChildren(); confirmHost.replaceChildren(); } },
    onKeyDown(event) { if (event.key === 'Escape' && confirming && !busy) { event.preventDefault(); confirming = false; renderPreview(); previewHost.querySelector('[data-archive-review]')?.focus(); return true; } return false; }
  };
}
