import { ResearchModel, newId } from './core/model.js';
import { researchRequest, createSaveQueue } from './core/persistence.js';
import { createCanvas } from './views/canvas.js';
import { bindTextInput } from './core/text-input.js';

export function createResearchWorkspace({ host }) {
  let model = null, saver = null, active = false, disposed = false, loadPromise = null;
  let selected = null, selectedRep = null, unsubscribe = null, releaseWriter = null;
  let selectedRelation = null, connectionSource = null;
  let readOnly = false, status = 'saved', errorMessage = '', view = 'canvas';
  let composing = null, settle = null, settled = null, editGroup = null;
  const controller = new AbortController();
  const events = { signal: controller.signal };
  const $ = selector => host.querySelector(selector);
  const tr = text => window.RelatumI18n?.t(text) || text;
  const alive = () => active && !disposed && document.body.dataset.startWorkspace === 'research';
  host.innerHTML = `
    <header class="research-header"><div><span class="research-kicker">RELATUM · RESEARCH</span><h1 data-role="project-title">研究</h1></div>
      <span class="research-badge">试用阶段</span><div class="research-actions">
      <button data-action="create">新建研究项目</button><button data-action="add" hidden>＋ 变量</button>
      <button data-action="note" hidden>＋ 记录</button><button data-action="formula" hidden>＋ 公式</button>
      <button data-action="connect" hidden aria-pressed="false" title="先在画布选中一个节点，再连接另一个节点。">连接节点</button>
      <button data-action="undo" disabled>撤销</button><button data-action="redo" disabled>重做</button></div></header>
    <div class="research-body" hidden>
      <aside class="research-directory"><p class="research-section-label">视图</p>
        <button data-action="canvas" aria-pressed="true">自由画布</button><button data-action="table" aria-pressed="false">对象表</button>
        <p class="research-section-label">项目对象</p><div class="research-object-list" data-user-content></div>
        <p class="research-directory-note">同一对象可以在多处呈现。</p></aside>
      <div class="research-surface"><div class="research-canvas" tabindex="0" aria-label="研究画布">
        <div class="research-canvas-empty"><strong>从一个想法开始</strong><p>双击空白记录想法，添加变量与公式。</p></div>
        <div class="research-scene" data-user-content></div></div>
        <div class="research-table-wrap" hidden><table><thead><tr><th>符号</th><th>名称</th><th>单位</th><th>呈现</th></tr></thead><tbody data-user-content></tbody></table></div>
        <div class="research-surface-footer"><span data-role="gesture-hint">拖动空白平移 · Ctrl + 滚轮缩放</span><button data-action="fit">适应视野</button><button data-action="home">回到原点</button></div></div>
      <aside class="research-inspector"><p class="research-section-label">当前对象</p><p data-role="selection-empty">选择一个对象以编辑属性。</p>
        <form hidden><label>名称<input name="label" maxlength="2000" autocomplete="off"></label>
          <label>符号<input name="symbol" maxlength="2000" autocomplete="off"></label>
          <label>单位<input name="unit" maxlength="2000" autocomplete="off"></label>
          <label>定义域<select name="domain"><option value="real">实数</option><option value="integer">整数</option><option value="boolean">布尔</option></select></label>
          <label hidden><span data-role="source-label">记录正文（Markdown）</span><textarea name="source" maxlength="100000" rows="12" spellcheck="false" data-user-content></textarea></label>
          <p class="research-draft-hint" hidden>源文自动保存；公式只排版，不执行计算。</p>
          <p class="research-object-id" data-user-content></p>
          <button type="button" data-action="locate">定位到画布</button><button type="button" data-action="reference">添加画布引用</button><button type="button" data-action="remove">从视图移除</button>
        </form><p data-role="unknown-type" hidden>此对象类型暂不可编辑，原始内容会保留。</p>
        <div class="research-relation-editor" hidden><label>连线名称<input name="relationLabel" maxlength="2000" autocomplete="off" data-user-content></label>
          <button data-action="delete-relation">删除关系</button></div>
        <p class="research-section-label" data-role="relations-label">普通关系</p><div class="research-relation-list" data-user-content></div></aside>
    </div>
    <div class="research-welcome"><span class="research-welcome-mark">q</span><h2>为思考留一张白纸</h2>
      <p>在自由空间摆放想法、变量与公式。</p><p>所有研究内容保存在本机。</p></div>
    <footer class="research-status"><span role="status" aria-live="polite" data-i18n-managed></span>
      <button data-action="retry">重试保存</button><button data-action="export">导出当前草稿</button></footer>`;
  const fields = [...Array.from($('form').elements).filter(element => element.name), $('[name="relationLabel"]')];
  const inputs = new Map();
  let forceFields = false;
  const scene = createCanvas($('.research-canvas'), {
    active: () => alive() && !readOnly && !composing,
    visible: alive,
    select: (id, rep) => { selectedRelation = null; selected = id; selectedRep = rep; render(); },
    selectRelation: id => { selected = null; selectedRep = null; selectedRelation = id; render(); },
    connecting: () => !!connectionSource,
    cancelConnect: () => { connectionSource = null; render(); },
    connect: targetId => {
      const reps = model.snapshot().views.find(item => item.id === 'view-main').representations;
      const source = reps.find(rep => rep.id === connectionSource), target = reps.find(rep => rep.id === targetId);
      if (!source || !target || source.objectId === target.objectId) return;
      const sourceId = connectionSource; connectionSource = null;
      selected = null; selectedRep = null; selectedRelation = newId('relation');
      dispatch({ type: 'createRelation', viewId: 'view-main', relationId: selectedRelation, sourceId, targetId });
      $('[name="relationLabel"]').focus();
    },
    move: (id, x, y) => dispatch({ type: 'moveRepresentation', viewId: 'view-main', representationId: id, x, y }),
    remove: () => selectedRelation ? dispatch({ type: 'removeRelation', relationId: selectedRelation }) : removeRepresentation(),
    create: position => addDraft('note', position),
    edit: () => selectedRelation ? $('[name="relationLabel"]').focus() : fields.find(field => !field.closest('label').hidden && field.name === 'source')?.focus(),
  });
  function dirtyDesktop() {
    if (alive()) window.CanvasDesktop?.setDirty(!!saver?.dirty || !!composing);
  }
  function renderStatus() {
    const messages = { saved: '已保存到本机', saving: '正在保存…', dirty: '未保存', error: '保存失败，草稿仍保留', conflict: '保存冲突，草稿已保留' };
    $('.research-status [role="status"]').textContent = readOnly ? tr('此窗口只读：研究项目已在另一窗口编辑。')
      : errorMessage || (model ? tr(messages[status]) : tr('尚未创建项目'));
    $('[data-action="retry"]').hidden = !model || status !== 'error';
    $('[data-action="export"]').hidden = !model;
    dirtyDesktop();
  }
  function render() {
    if (!model) { renderStatus(); return; }
    const project = model.snapshot();
    const oldFocused = document.activeElement?.dataset.selectObject;
    const obj = project.objects.find(item => item.id === selected);
    if (!obj) { selected = null; selectedRep = null; }
    const reps = project.views.find(item => item.id === 'view-main')?.representations || [];
    if (!reps.some(rep => rep.id === selectedRep)) selectedRep = null;
    if (!reps.some(rep => rep.id === connectionSource)) connectionSource = null;
    const relation = project.relations.find(item => item.id === selectedRelation && item.type === 'core.association' && item.typeVersion === 1);
    if (!relation) selectedRelation = null;
    $('[data-role="project-title"]').textContent = project.title;
    $('[data-role="project-title"]').setAttribute('data-user-content', '');
    $('.research-body').hidden = false; $('.research-welcome').hidden = true;
    $('[data-action="create"]').hidden = true; $('[data-action="add"]').hidden = false;
    for (const name of ['add', 'note', 'formula']) {
      $(`[data-action="${name}"]`).hidden = false; $(`[data-action="${name}"]`).disabled = readOnly;
    }
    const connectButton = $('[data-action="connect"]'); connectButton.hidden = false;
    connectButton.disabled = readOnly || !selectedRep || reps.every(rep => rep.objectId === selected);
    connectButton.setAttribute('aria-pressed', String(!!connectionSource));
    $('.research-canvas').classList.toggle('is-connecting', !!connectionSource);
    $('[data-role="gesture-hint"]').textContent = tr(connectionSource ? '点击另一个节点连接 · Esc 取消' : '拖动空白平移 · Ctrl + 滚轮缩放');
    $('[data-action="undo"]').disabled = readOnly || !model.canUndo;
    $('[data-action="redo"]').disabled = readOnly || !model.canRedo;
    const list = $('.research-object-list');
    const rows = $('tbody');
    // Small M0 catalog; the canvas uses keyed, persistent DOM.
    list.replaceChildren(); rows.replaceChildren();
    for (const item of project.objects) {
      const makeButton = () => {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = `${item.payload.symbol || '—'}  ${item.payload.label || item.id}`;
        button.dataset.selectObject = item.id; button.classList.toggle('is-selected', selected === item.id);
        return button;
      };
      list.append(makeButton());
      const row = document.createElement('tr'); row.classList.toggle('is-selected', selected === item.id);
      for (const value of [item.payload.symbol || '—', null, item.payload.unit || '—', String(reps.filter(rep => rep.objectId === item.id).length)]) {
        const cell = document.createElement('td');
        if (value === null) cell.append(makeButton()); else cell.textContent = value;
        row.append(cell);
      }
      rows.append(row);
    }
    if (oldFocused && alive()) {
      const surface = view === 'table' ? rows : list;
      Array.from(surface.querySelectorAll('button')).find(button => button.dataset.selectObject === oldFocused)?.focus({ preventScroll: true });
    }
    scene.render(project, selected, selectedRep, selectedRelation);
    $('[data-role="selection-empty"]').hidden = !!obj || !!relation;
    $('.research-relation-editor').hidden = !relation;
    const relationField = $('[name="relationLabel"]');
    if (relation) inputs.get(relationField)?.sync(relation.id, relation.label, forceFields);
    relationField.disabled = readOnly;
    $('[data-action="delete-relation"]').disabled = readOnly;
    const relationList = $('.research-relation-list'); relationList.replaceChildren();
    for (const item of project.relations.filter(item => item.type === 'core.association' && item.typeVersion === 1)) {
      if (obj && !item.ends.some(end => end.objectId === obj.id)) continue;
      const button = document.createElement('button'); button.dataset.selectRelation = item.id;
      button.textContent = item.label || item.ends.map(end => project.objects.find(object => object.id === end.objectId)?.payload.label || end.objectId).join(' — ');
      button.classList.toggle('is-selected', selectedRelation === item.id); relationList.append(button);
    }
    $('[data-role="relations-label"]').hidden = !relationList.children.length;
    const editable = ['core.variable', 'core.note', 'core.formula'].includes(obj?.type) && obj.typeVersion === 1;
    $('form').hidden = !editable;
    $('[data-role="unknown-type"]').hidden = !obj || editable;
    if (editable) {
      for (const field of fields) {
        if (field.name === 'relationLabel') continue;
        field.closest('label').hidden = field.name !== 'label' && (obj.type === 'core.variable' ? field.name === 'source' : field.name !== 'source');
        inputs.get(field)?.sync(obj.id, obj.payload[field.name] || '', forceFields);
        field.disabled = readOnly;
      }
      $('[data-role="source-label"]').textContent = tr(obj.type === 'core.formula' ? '公式源文（LaTeX）' : '记录正文（Markdown）');
      $('.research-draft-hint').hidden = obj.type === 'core.variable';
      $('.research-object-id').textContent = obj.id;
      $('[data-action="reference"]').disabled = readOnly;
      $('[data-action="remove"]').disabled = readOnly || !selectedRep;
      $('[data-action="locate"]').disabled = !reps.some(rep => rep.objectId === selected);
    }
    forceFields = false;
    renderStatus();
  }
  function dispatch(command, group) {
    if (!alive() || readOnly || !model) return;
    try { model.dispatch(command, group); }
    catch (error) { errorMessage = error.message; renderStatus(); }
  }
  function commitField(field) {
    if (composing || !field?.name || field.closest('label').hidden) return;
    if (field.name === 'relationLabel') {
      if (selectedRelation) dispatch({ type: 'renameRelation', relationId: selectedRelation, label: field.value }, editGroup);
      return;
    }
    if (!selected) return;
    dispatch({ type: 'updateObject', objectId: selected, changes: { [field.name]: field.value } }, editGroup);
  }
  for (const field of fields) {
    const input = bindTextInput(field, { signal: controller.signal, commit: commitField, canEdit: () => alive() && !readOnly && !composing });
    inputs.set(field, input);
    field.addEventListener('focus', () => { editGroup = newId('edit'); }, events);
    field.addEventListener('input', event => { if (!event.isComposing) input.record(); }, events);
    field.addEventListener('change', () => input.record(), events);
    field.addEventListener('compositionstart', () => {
      composing = field; settled = new Promise(resolve => { settle = resolve; }); dirtyDesktop();
    }, events);
    field.addEventListener('compositionend', () => {
      composing = null; input.record(); settle?.(); settle = null; settled = null; dirtyDesktop();
    }, events);
  }
  $('form').addEventListener('submit', event => event.preventDefault(), events);
  async function finishInput() {
    if (composing) { composing.blur(); if (settled) await settled; }
    if (fields.includes(document.activeElement)) commitField(document.activeElement);
  }
  function removeRepresentation() {
    if (selectedRep) dispatch({ type: 'removeRepresentation', viewId: 'view-main', representationId: selectedRep });
  }
  function addDraft(kind, position = scene.center()) {
    if (readOnly || !model) return;
    switchView('canvas');
    selectedRelation = null; selected = newId(kind); selectedRep = null;
    dispatch({ type: 'createObject', objectType: `core.${kind}`, objectId: selected, viewId: 'view-main', ...position,
      payload: { label: tr(kind === 'note' ? '自由记录' : '公式草稿') } });
    $('textarea[name="source"]').focus();
  }
  function history(redo) {
    scene.cancel(); connectionSource = null; editGroup = null; forceFields = true;
    if (redo) model?.redo(); else model?.undo();
    render();
  }
  function switchView(next) {
    scene.pause(); connectionSource = null; view = next;
    $('.research-canvas').hidden = next !== 'canvas'; $('.research-table-wrap').hidden = next !== 'table';
    for (const name of ['canvas', 'table']) $(`[data-action="${name}"]`).setAttribute('aria-pressed', String(name === next));
    $('.research-surface-footer').hidden = next !== 'canvas';
    if (model) render();
  }
  async function attach(loaded) {
    if (disposed) return;
    model = new ResearchModel(loaded.project);
    // The lock belongs to this document, even while its workspace is hidden.
    if (navigator.locks) {
      await new Promise((resolve, reject) => {
        navigator.locks.request(`relatum-research:${loaded.project.projectId}`, { ifAvailable: true }, lock => {
          readOnly = !lock; resolve();
          if (lock) return new Promise(release => { releaseWriter = release; });
        }).catch(reject);
      });
    }
    if (disposed) { releaseWriter?.(); return; }
    saver = createSaveQueue(model, loaded, (next, error) => {
      status = next; errorMessage = error ? (window.RelatumI18n?.language === 'en' ? tr(next === 'conflict' ? '保存冲突，草稿已保留' : '保存失败，草稿仍保留') : error.message) : '';
      renderStatus();
    });
    unsubscribe = model.subscribe(() => { saver.schedule(); if (alive()) render(); });
    render();
  }
  async function load() {
    if (model) return;
    if (!loadPromise) loadPromise = (async () => {
      try { await attach(await researchRequest('project?id=project-main')); }
      catch (error) { if (error.code !== 'not_found') throw error; }
    })().catch(error => { loadPromise = null; throw error; });
    return loadPromise;
  }
  host.addEventListener('click', async event => {
    if (!alive()) return;
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    const action = button.dataset.action;
    await finishInput(); if (!alive()) return;
    if (button.dataset.selectObject) { connectionSource = null; selectedRelation = null; selected = button.dataset.selectObject; selectedRep = null; render(); return; }
    if (button.dataset.selectRelation) { connectionSource = null; selected = null; selectedRep = null; selectedRelation = button.dataset.selectRelation; render(); return; }
    try {
      if (action === 'create') {
        button.disabled = true;
        try { await attach(await researchRequest('create', {})); } finally { button.disabled = false; }
      } else if (action === 'add') {
        selectedRelation = null; selected = newId('var'); selectedRep = null;
        const position = view === 'canvas' ? scene.center() : { x: 0, y: 0 };
        dispatch({ type: 'createObject', objectType: 'core.variable', objectId: selected, viewId: 'view-main', ...position,
          payload: { label: tr('变量'), symbol: `q${model.snapshot().objects.length + 1}` } });
      } else if (action === 'note' || action === 'formula') addDraft(action);
      else if (action === 'reference') {
        switchView('canvas'); dispatch({ type: 'addRepresentation', objectId: selected, viewId: 'view-main', ...scene.center() });
      } else if (action === 'remove') removeRepresentation();
      else if (action === 'delete-relation') dispatch({ type: 'removeRelation', relationId: selectedRelation });
      else if (action === 'connect') {
        const sourceId = selectedRep;
        if (connectionSource) connectionSource = null;
        else { switchView('canvas'); connectionSource = sourceId; }
        render(); $('.research-canvas').focus();
      }
      else if (action === 'locate') {
        const reps = model.snapshot().views.find(item => item.id === 'view-main').representations;
        selectedRep = (reps.find(rep => rep.id === selectedRep) || reps.find(rep => rep.objectId === selected))?.id;
        switchView('canvas'); scene.fit(selectedRep);
      }
      else if (action === 'fit') scene.fit();
      else if (action === 'undo' && !readOnly) history(false);
      else if (action === 'redo' && !readOnly) history(true);
      else if (action === 'canvas' || action === 'table') switchView(action);
      else if (action === 'home') scene.home();
      else if (action === 'retry') await flush();
      else if (action === 'export') {
        const url = URL.createObjectURL(new Blob([JSON.stringify(model.snapshot(), null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'research-draft.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) { errorMessage = error.message; renderStatus(); }
  }, events);
  host.addEventListener('keydown', event => {
    if (!alive() || event.isComposing || composing || event.keyCode === 229) return;
    const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
    if (mod && key === 's') { event.preventDefault(); flush(); return; }
    if (event.target.closest('input, textarea, select, [contenteditable]')) return;
    if (mod && !readOnly && (key === 'z' || key === 'y')) {
      event.preventDefault(); scene.cancel();
      history(key === 'y' || event.shiftKey);
    }
  }, events);
  async function flush() { await finishInput(); return saver ? saver.flush() : true; }
  const onHide = () => { if (alive()) { scene.cancel(); flush(); } };
  window.addEventListener('blur', onHide, events);
  document.addEventListener('visibilitychange', () => { if (document.hidden) onHide(); }, events);
  window.addEventListener('beforeunload', event => {
    if (saver?.dirty || composing) { event.preventDefault(); event.returnValue = ''; flush(); }
  }, events);
  document.addEventListener('relatum:languagechange', render, events);
  const removeCloseHandler = window.CanvasDesktop?.addBeforeCloseHandler(flush);
  renderStatus();
  return {
    load,
    async activate() {
      active = true;
      try { await load(); if (alive()) { render(); window.CanvasDesktop?.setResearchWorkspaceActive(true); } }
      catch (error) { errorMessage = error.message; renderStatus(); throw error; }
    },
    flush,
    suspend() { scene.pause(); connectionSource = null; active = false; window.CanvasDesktop?.setResearchWorkspaceActive(false); },
    async deactivate() { scene.cancel(); if (!(await flush())) return false; this.suspend(); return true; },
    async dispose() {
      if (!(await flush())) return false;
      disposed = true; this.suspend(); unsubscribe?.(); saver?.dispose(); scene.dispose(); controller.abort(); releaseWriter?.(); removeCloseHandler?.(); return true;
    },
    get dirty() { return !!saver?.dirty || !!composing; },
  };
}
