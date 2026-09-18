import { ResearchModel, newId } from './core/model.js';
import { researchRequest, createSaveQueue } from './core/persistence.js';
import { createCanvas } from './views/canvas.js';
import { bindTextInput } from './core/text-input.js';
import { createSessionCache } from './core/session-cache.js';

export function createResearchWorkspace({ host }) {
  let model = null, saver = null, active = false, disposed = false, loadPromise = null;
  let selected = null, selectedRep = null, unsubscribe = null, releaseWriter = null;
  let selectedRelation = null, connectionSource = null;
  let creationType = 'note';
  let deleting = false;
  let readOnly = false, status = 'saved', errorMessage = '', view = 'canvas';
  let composing = null, settle = null, settled = null, editGroup = null;
  let projects = [], operation = null, pendingCreate = null, switching = false, loading = false;
  const sessions = createSessionCache();
  const lastProjectKey = 'relatum:research:lastProject:v1';
  const controller = new AbortController();
  const events = { signal: controller.signal };
  const $ = selector => host.querySelector(selector);
  const tr = text => window.RelatumI18n?.t(text) || text;
  const alive = () => active && !disposed && document.body.dataset.startWorkspace === 'research';
  host.innerHTML = `
    <header class="research-header"><div class="research-title"><span class="research-kicker">RELATUM · RESEARCH</span><div class="research-title-row"><h1 data-role="project-title">研究</h1><input data-role="project-name" maxlength="500" aria-label="项目名称" data-user-content hidden><button data-action="rename-project" title="重命名项目" hidden>✎</button></div></div>
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
      <div class="research-surface"><div class="research-creation"><span>双击创建</span>
        <button data-create-type="note" aria-pressed="true">记录</button><button data-create-type="variable" aria-pressed="false">变量</button><button data-create-type="formula" aria-pressed="false">公式</button>
        </div><div class="research-canvas" tabindex="0" aria-label="研究画布">
        <div class="research-canvas-empty"><strong>从一个想法开始</strong><p>双击空白记录想法，添加变量与公式。</p></div>
        <div class="research-scene" data-user-content></div></div>
        <div class="research-table-wrap" hidden><table><thead><tr><th>符号</th><th>名称</th><th>单位</th><th>呈现</th><th>操作</th></tr></thead><tbody data-user-content></tbody></table></div>
        <div class="research-surface-footer"><span data-role="gesture-hint">拖动空白平移 · Ctrl + 滚轮缩放</span><button data-action="fit">适应视野</button><button data-action="home">回到原点</button></div></div>
      <aside class="research-inspector"><div class="research-inspector-heading"><p class="research-section-label">当前对象</p><button data-action="delete-object" disabled title="立即永久删除对象及关联数据，不可恢复。">永久删除</button></div>
        <p data-role="selection-empty">选择一个对象以编辑属性。</p>
        <form hidden><label>名称<input name="label" maxlength="2000" autocomplete="off"></label>
          <label>符号<input name="symbol" maxlength="2000" autocomplete="off"></label>
          <label>单位<input name="unit" maxlength="2000" autocomplete="off"></label>
          <label>定义域<select name="domain"><option value="real">实数</option><option value="integer">整数</option><option value="boolean">布尔</option></select></label>
          <label hidden><span data-role="source-label">记录正文（Markdown）</span><textarea name="source" maxlength="100000" rows="12" spellcheck="false" data-user-content></textarea></label>
          <p class="research-draft-hint" hidden>源文自动保存；公式只排版，不执行计算。</p>
          <p class="research-object-id" data-user-content></p>
          <button type="button" data-action="locate">定位到画布</button><button type="button" data-action="reference">添加画布引用</button><button type="button" data-action="remove">从视图移除</button>
          <button type="button" data-action="child">添加子分支 · Tab</button><button type="button" data-action="sibling">添加同级分支 · Enter</button>
          <button type="button" data-action="layout">整理此分支</button><button type="button" data-action="collapse">折叠分支</button><button type="button" data-action="detach">脱离父分支</button>
        </form><p data-role="unknown-type" hidden>此对象类型暂不可编辑，原始内容会保留。</p>
        <div class="research-relation-editor" hidden><label>连线名称<input name="relationLabel" maxlength="2000" autocomplete="off" data-user-content></label>
          <button data-action="delete-relation">删除关系</button></div>
        <p class="research-section-label" data-role="relations-label">普通关系</p><div class="research-relation-list" data-user-content></div></aside>
    </div>
    <div class="research-welcome"><span class="research-welcome-mark">q</span><h2>为思考留一张白纸</h2>
      <p>在自由空间摆放想法、变量与公式。</p><p>所有研究内容保存在本机。</p></div>
    <nav class="research-project-rail" aria-label="研究项目切换"><button data-action="toggle-projects" title="切换研究项目" aria-expanded="false">‹</button><div class="research-project-panel"><div class="research-project-list" data-user-content></div><button data-action="new-project" title="新建研究项目">＋</button></div></nav>
    <footer class="research-status"><span role="status" aria-live="polite" data-i18n-managed></span>
      <button data-action="retry">重试保存</button><button data-action="export">导出当前草稿</button></footer>`;
  const fields = [...Array.from($('form').elements).filter(element => element.name), $('[name="relationLabel"]')];
  const inputs = new Map();
  let forceFields = false;
  const scene = createCanvas($('.research-canvas'), {
    active: () => alive() && !switching && !readOnly && !deleting && !saver?.deleting && !composing,
    visible: alive,
    select: (id, rep) => { selectedRelation = null; selected = id; selectedRep = rep; render(); },
    selectRelation: id => { selected = null; selectedRep = null; selectedRelation = id; render(); },
    connecting: () => !!connectionSource,
    cancelConnect: () => { connectionSource = null; render(); },
    connect: (targetId, draggedSource = null) => {
      const reps = model.snapshot().views.find(item => item.id === 'view-main').representations;
      const source = reps.find(rep => rep.id === (draggedSource || connectionSource)), target = reps.find(rep => rep.id === targetId);
      if (!source || !target || source.objectId === target.objectId) return;
      const sourceId = source.id; connectionSource = null;
      selected = null; selectedRep = null; selectedRelation = newId('relation');
      dispatch({ type: 'createRelation', viewId: 'view-main', relationId: selectedRelation, sourceId, targetId });
      $('[name="relationLabel"]').focus();
    },
    move: (id, x, y) => dispatch({ type: 'moveRepresentation', viewId: 'view-main', representationId: id, x, y }),
    remove: () => selectedRelation ? dispatch({ type: 'removeRelation', relationId: selectedRelation }) : removeRepresentation(),
    create: position => addDraft(creationType, position),
    branch: (kind, checkOnly) => addBranch(kind, checkOnly),
    edit: () => selectedRelation ? $('[name="relationLabel"]').focus()
      : (fields.find(field => !field.closest('label').hidden && field.name === 'source') || $('[name="label"]')).focus(),
  });
  function dirtyDesktop() {
    if (alive()) window.CanvasDesktop?.setDirty(!!saver?.dirty || !!composing || switching || !nameInput.hidden);
  }
  function renderStatus() {
    const messages = { saved: '已保存到本机', saving: '正在保存…', dirty: '未保存', error: '保存失败，草稿仍保留', conflict: '保存冲突，草稿已保留' };
    $('.research-status [role="status"]').textContent = errorMessage || (readOnly ? tr('此窗口只读：研究项目已在另一窗口编辑。')
      : (model ? tr(messages[status]) : tr('尚未创建项目')));
    $('[data-action="retry"]').hidden = !model || status !== 'error';
    $('[data-action="retry"]').textContent = tr(saver?.deleting ? '重试删除' : '重试保存');
    if (saver?.deleting && status === 'error') $('.research-status [role="status"]').textContent = tr('删除尚未确认完成，请重试。');
    $('[data-action="export"]').hidden = !model;
    dirtyDesktop();
  }
  function render() {
    renderProjects();
    if (!model) { renderStatus(); return; }
    const project = model.snapshot();
    const oldFocused = document.activeElement?.dataset.selectObject;
    const obj = project.objects.find(item => item.id === selected);
    $('[data-action="delete-object"]').disabled = !obj || readOnly;
    if (!obj) { selected = null; selectedRep = null; }
    const reps = project.views.find(item => item.id === 'view-main')?.representations || [];
    if (!reps.some(rep => rep.id === selectedRep)) selectedRep = null;
    if (!reps.some(rep => rep.id === connectionSource)) connectionSource = null;
    const relation = project.relations.find(item => item.id === selectedRelation && item.type === 'core.association' && item.typeVersion === 1);
    if (!relation) selectedRelation = null;
    $('[data-role="project-title"]').textContent = project.title;
    $('[data-role="project-title"]').setAttribute('data-user-content', '');
    $('[data-action="rename-project"]').hidden = false;
    $('[data-action="rename-project"]').disabled = readOnly || switching;
    $('.research-body').hidden = false; $('.research-welcome').hidden = true;
    $('[data-action="create"]').hidden = true; $('[data-action="add"]').hidden = false;
    for (const name of ['add', 'note', 'formula']) {
      $(`[data-action="${name}"]`).hidden = false; $(`[data-action="${name}"]`).disabled = readOnly;
    }
    const connectButton = $('[data-action="connect"]'); connectButton.hidden = false;
    connectButton.disabled = readOnly || !selectedRep || reps.every(rep => rep.objectId === selected);
    connectButton.setAttribute('aria-pressed', String(!!connectionSource));
    $('.research-canvas').classList.toggle('is-connecting', !!connectionSource);
    $('[data-role="gesture-hint"]').textContent = tr(connectionSource ? '点击另一个节点连接 · Esc 取消' : 'Alt 拖动节点连线 · 拖动空白平移 · Ctrl + 滚轮缩放');
    for (const button of host.querySelectorAll('[data-create-type]')) {
      button.disabled = readOnly; button.setAttribute('aria-pressed', String(button.dataset.createType === creationType));
    }
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
      const cell = document.createElement('td'), deleteButton = document.createElement('button');
      deleteButton.type = 'button'; deleteButton.textContent = tr('永久删除'); deleteButton.dataset.deleteObject = item.id;
      deleteButton.title = tr('立即永久删除对象及关联数据，不可恢复。');
      deleteButton.disabled = readOnly; deleteButton.setAttribute('aria-label', `${tr('永久删除')} ${item.payload.label || item.id}`);
      cell.append(deleteButton); row.append(cell); rows.append(row);
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
      const rep = reps.find(rep => rep.id === selectedRep), hasChildren = reps.some(item => item.parentId === selectedRep);
      for (const name of ['child', 'sibling', 'layout', 'collapse', 'detach']) {
        $(`[data-action="${name}"]`).disabled = readOnly || !rep || (['sibling', 'detach'].includes(name) && !rep.parentId)
          || (['layout', 'collapse'].includes(name) && !hasChildren);
      }
      $('[data-action="collapse"]').textContent = tr(rep?.collapsed ? '展开分支' : '折叠分支');
    }
    forceFields = false;
    for (const surface of host.querySelectorAll('.research-body, .research-actions')) surface.inert = switching || deleting || !!saver?.deleting;
    renderStatus();
  }
  function dispatch(command, group) {
    if (!alive() || readOnly || deleting || saver?.deleting || !model) return;
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
    const input = bindTextInput(field, { signal: controller.signal, commit: commitField, canEdit: () => alive() && !readOnly && !deleting && !saver?.deleting && !composing });
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
    finishRename();
  }
  const nameInput = $('[data-role="project-name"]');
  function finishRename(cancel = false) {
    if (nameInput.hidden || composing === nameInput) return;
    if (!cancel && nameInput.value.trim()) dispatch({ type: 'renameProject', title: nameInput.value });
    nameInput.hidden = true; $('[data-role="project-title"]').hidden = false;
    dirtyDesktop();
  }
  nameInput.addEventListener('compositionstart', () => {
    composing = nameInput; settled = new Promise(resolve => { settle = resolve; }); dirtyDesktop();
  }, events);
  nameInput.addEventListener('compositionend', () => {
    composing = null;
    if (document.activeElement !== nameInput) finishRename();
    settle?.(); settle = null; settled = null; dirtyDesktop();
  }, events);
  nameInput.addEventListener('blur', () => finishRename(), events);
  nameInput.addEventListener('keydown', event => {
    if (event.isComposing || composing || event.keyCode === 229) return;
    if (['Enter', 'Escape'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); finishRename(event.key === 'Escape');
      $('[data-action="rename-project"]').focus();
    }
  }, events);
  function removeRepresentation() {
    if (selectedRep) dispatch({ type: 'removeRepresentation', viewId: 'view-main', representationId: selectedRep });
  }
  function addDraft(kind, position = scene.center()) {
    if (readOnly || !model) return;
    switchView('canvas');
    selectedRelation = null; selected = newId(kind); selectedRep = null;
    dispatch({ type: 'createObject', objectType: `core.${kind}`, objectId: selected, viewId: 'view-main', ...position,
      payload: kind === 'variable' ? { label: tr('变量'), symbol: `q${model.snapshot().objects.length + 1}` }
        : { label: tr(kind === 'note' ? '自由记录' : '公式草稿') } });
    selectedRep = model.snapshot().views.find(item => item.id === 'view-main').representations.find(rep => rep.objectId === selected)?.id;
    render();
    $(kind === 'variable' ? '[name="symbol"]' : 'textarea[name="source"]').focus();
  }
  function addBranch(kind, checkOnly = false) {
    if (!model || readOnly || !selectedRep || connectionSource) return false;
    const reps = model.snapshot().views.find(item => item.id === 'view-main').representations;
    const current = reps.find(rep => rep.id === selectedRep);
    const parent = kind === 'sibling' ? reps.find(rep => rep.id === current?.parentId) : current;
    if (!parent) return false;
    if (checkOnly) return true;
    const size = scene.sizes()[parent.id] || { width: 280, height: 160 };
    const siblings = reps.filter(rep => rep.parentId === parent.id);
    const y = siblings.reduce((bottom, rep) => Math.max(bottom, rep.y + (scene.sizes()[rep.id]?.height || 160) + 32), parent.y);
    selected = newId('note'); selectedRep = null; selectedRelation = null;
    dispatch({ type: 'createBranch', objectType: 'core.note', objectId: selected, viewId: 'view-main', parentId: parent.id,
      x: parent.x + size.width + 80, y, payload: { label: tr('自由记录') } });
    selectedRep = model.snapshot().views.find(item => item.id === 'view-main').representations.find(rep => rep.objectId === selected)?.id;
    render(); scene.fit(selectedRep); $('[name="label"]').focus(); $('[name="label"]').select();
    return true;
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
  function renderProjects() {
    const current = model;
    if (current) {
      const item = projects.find(item => item.id === current.projectId);
      if (item) item.title = current.title;
    }
    const list = $('.research-project-list');
    const live = new Set(projects.map(item => item.id));
    for (const button of list.children) if (!live.has(button.dataset.projectId)) button.remove();
    projects.forEach((item, index) => {
      let button = Array.from(list.children).find(button => button.dataset.projectId === item.id);
      if (!button) { button = document.createElement('button'); button.dataset.projectId = item.id; list.append(button); }
      const label = item.title || item.error || item.id;
      if (button.textContent !== String(index + 1)) button.textContent = String(index + 1);
      if (button.dataset.projectTitle !== label) { button.title = label; button.dataset.projectTitle = label; }
      button.setAttribute('aria-label', `${index + 1} · ${label}`);
      button.setAttribute('aria-current', String(current?.projectId === item.id));
      button.disabled = loading || switching || deleting || !!saver?.deleting;
      if (list.children[index] !== button) list.insertBefore(button, list.children[index]);
    });
    $('[data-action="new-project"]').disabled = loading || switching || deleting || !!saver?.deleting;
    $('[data-action="create"]').disabled = loading || switching;
  }
  async function refreshProjects() {
    projects = (await researchRequest('projects')).projects;
    renderProjects();
  }
  const rail = $('.research-project-rail'), railToggle = $('[data-action="toggle-projects"]');
  const syncRail = () => railToggle.setAttribute('aria-expanded', String(rail.matches(':hover, :focus-within') || rail.classList.contains('is-open')));
  rail.addEventListener('pointerenter', syncRail, events);
  rail.addEventListener('pointerleave', syncRail, events);
  rail.addEventListener('focusin', syncRail, events);
  rail.addEventListener('focusout', () => queueMicrotask(syncRail), events);
  host.addEventListener('pointerdown', event => {
    if (!rail.contains(event.target)) { rail.classList.remove('is-open'); syncRail(); }
  }, events);
  rail.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      rail.classList.remove('is-open'); document.activeElement?.blur(); syncRail(); return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(rail.querySelectorAll('button:not(:disabled)'));
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    event.preventDefault(); event.stopPropagation(); buttons[next]?.focus();
  }, events);
  async function writerLock(id) {
    if (!navigator.locks) return { readOnly: false, release: null };
    return new Promise((resolve, reject) => {
      navigator.locks.request(`relatum-research:${id}`, { ifAvailable: true }, lock => {
        if (!lock) { resolve({ readOnly: true, release: null }); return; }
        return new Promise(release => resolve({ readOnly: false, release }));
      }).catch(reject);
    });
  }
  function attach(loaded, writer, cached) {
    const reusable = cached?.fingerprint === loaded.fingerprint;
    model = reusable ? cached.model : new ResearchModel(loaded.project);
    readOnly = writer.readOnly; releaseWriter = writer.release;
    selected = null; selectedRep = null; selectedRelation = null; connectionSource = null; editGroup = null;
    for (const input of inputs.values()) input.sync(null, '', true);
    status = 'saved'; errorMessage = ''; forceFields = true;
    saver = createSaveQueue(model, loaded, (next, error) => {
      status = next; errorMessage = error ? (window.RelatumI18n?.language === 'en' ? tr(next === 'conflict' ? '保存冲突，草稿已保留' : '保存失败，草稿仍保留') : error.message) : '';
      renderStatus();
    });
    unsubscribe = model.subscribe(() => { saver.schedule(); if (alive()) render(); });
    scene.setCamera(cached?.camera);
    switchView(cached?.view || 'canvas');
    try { localStorage.setItem(lastProjectKey, loaded.project.projectId); } catch {}
  }
  async function openProject(id) {
    if (model?.projectId === id) return true;
    const writer = await writerLock(id);
    let loaded;
    try {
      loaded = await researchRequest(`project?id=${encodeURIComponent(id)}`);
      // Validate before giving up the current session and its lock.
      new ResearchModel(loaded.project);
    } catch (error) { writer.release?.(); throw error; }
    if (disposed) { writer.release?.(); return false; }
    scene.pause();
    const cached = sessions.take(id);
    if (model) sessions.set(model.projectId, { model, fingerprint: saver.fingerprint, camera: scene.getCamera(), view });
    unsubscribe?.(); saver?.dispose(); releaseWriter?.();
    attach(loaded, writer, cached);
    return true;
  }
  function changeProject(id, create = false) {
    if (operation) return operation;
    switching = true; renderProjects(); scene.cancel();
    operation = (async () => {
      try {
        if (!(await flushCurrent())) return false;
        render();
        if (create) {
          pendingCreate ||= { projectId: newId('project'), title: `${tr('研究项目')} ${projects.length + 1}` };
          const loaded = await researchRequest('create', pendingCreate);
          id = loaded.project.projectId;
          await refreshProjects();
        }
        const result = await openProject(id);
        if (create && result) pendingCreate = null;
        return result;
      } catch (error) { errorMessage = error.message; renderStatus(); return false; }
      finally { switching = false; operation = null; render(); }
    })();
    return operation;
  }
  async function load() {
    if (model) return;
    if (loadPromise) return loadPromise;
    loading = true; renderProjects();
    loadPromise = (async () => {
      await refreshProjects();
      let last; try { last = localStorage.getItem(lastProjectKey); } catch {}
      const target = projects.find(item => item.id === last && !item.error) || projects.find(item => !item.error);
      if (target) await openProject(target.id);
      else if (projects.length) { errorMessage = projects[0].error; renderStatus(); }
    })().finally(() => { loadPromise = null; loading = false; render(); });
    return loadPromise;
  }
  host.addEventListener('click', async event => {
    if (!alive()) return;
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'toggle-projects') {
      const open = $('.research-project-rail').classList.toggle('is-open');
      button.setAttribute('aria-expanded', String(open)); return;
    }
    if (loading || switching || deleting || (saver?.deleting && action !== 'retry')) return;
    if (button.dataset.projectId || action === 'new-project' || action === 'create') {
      await changeProject(button.dataset.projectId, action === 'new-project' || action === 'create'); return;
    }
    const deleteTarget = button.dataset.deleteObject || selected;
    const actionModel = model;
    await finishInput(); if (!alive() || switching || actionModel !== model || button.disabled) return;
    if (button.dataset.deleteObject || action === 'delete-object') {
      if (readOnly || !model?.snapshot().objects.some(obj => obj.id === deleteTarget)) return;
      if (deleting || saver?.deleting) return;
      const id = deleteTarget; scene.cancel(); connectionSource = null;
      deleting = true; render();
      try {
        if (await saver.deleteObject(id)) {
          for (const [field, input] of inputs) input.sync(null, '', true);
          selected = null; selectedRep = null; selectedRelation = null;
        }
      } finally { deleting = false; render(); }
      if (view === 'canvas') $('.research-canvas').focus(); else $('[data-action="table"]').focus();
      return;
    }
    if (button.dataset.createType) { creationType = button.dataset.createType; connectionSource = null; switchView('canvas'); $('.research-canvas').focus(); return; }
    if (button.dataset.selectObject) { connectionSource = null; selectedRelation = null; selected = button.dataset.selectObject; selectedRep = null; render(); return; }
    if (button.dataset.selectRelation) { connectionSource = null; selected = null; selectedRep = null; selectedRelation = button.dataset.selectRelation; render(); return; }
    try {
      if (action === 'rename-project' && !readOnly) {
        nameInput.value = model.snapshot().title; nameInput.hidden = false;
        $('[data-role="project-title"]').hidden = true; nameInput.focus(); nameInput.select();
        dirtyDesktop();
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
        if (!readOnly) dispatch({ type: 'revealRepresentation', viewId: 'view-main', representationId: selectedRep });
        switchView('canvas'); scene.fit(selectedRep);
      }
      else if (action === 'child' || action === 'sibling') addBranch(action);
      else if (['layout', 'collapse', 'detach'].includes(action)) {
        scene.cancel();
        dispatch({ type: ({ layout: 'layoutBranch', collapse: 'toggleBranch', detach: 'setBranchParent' })[action],
          viewId: 'view-main', representationId: selectedRep, sizes: scene.sizes(), parentId: null });
        $('.research-canvas').focus();
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
    if (!alive() || switching || deleting || saver?.deleting || event.isComposing || composing || event.keyCode === 229) return;
    const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
    if (mod && key === 's') { event.preventDefault(); flush(); return; }
    if (event.target.closest('input, textarea, select, [contenteditable]')) return;
    if (mod && !readOnly && (key === 'z' || key === 'y')) {
      event.preventDefault(); scene.cancel();
      history(key === 'y' || event.shiftKey);
    }
  }, events);
  async function flushCurrent() {
    await finishInput();
    if (switching) render();
    const wasDeleting = saver?.deleting;
    const result = saver ? await saver.flush() : true;
    if (wasDeleting && result) { for (const [field, input] of inputs) input.sync(null, '', true); render(); }
    return result;
  }
  async function flush() {
    if (loadPromise) await loadPromise.catch(() => {});
    if (operation && !(await operation)) return false;
    return flushCurrent();
  }
  const onHide = () => { if (alive()) { scene.cancel(); flush(); } };
  window.addEventListener('blur', onHide, events);
  document.addEventListener('visibilitychange', () => { if (document.hidden) onHide(); }, events);
  window.addEventListener('beforeunload', event => {
    if (saver?.dirty || composing || operation || !nameInput.hidden) { event.preventDefault(); event.returnValue = ''; flush(); }
  }, events);
  document.addEventListener('relatum:languagechange', render, events);
  const removeCloseHandler = window.CanvasDesktop?.addBeforeCloseHandler(flush);
  renderStatus();
  return {
    load,
    async activate() {
      active = true;
      try { if (model) await refreshProjects(); else await load(); if (alive()) { render(); window.CanvasDesktop?.setResearchWorkspaceActive(true); } }
      catch (error) { errorMessage = error.message; renderStatus(); throw error; }
    },
    flush,
    suspend() { scene.pause(); connectionSource = null; active = false; window.CanvasDesktop?.setResearchWorkspaceActive(false); },
    async deactivate() { scene.cancel(); if (!(await flush())) return false; this.suspend(); return true; },
    async dispose() {
      if (!(await flush())) return false;
      disposed = true; this.suspend(); unsubscribe?.(); saver?.dispose(); sessions.clear(); scene.dispose(); controller.abort(); releaseWriter?.(); removeCloseHandler?.();
      for (const input of inputs.values()) input.sync(null, '', true);
      inputs.clear(); model = null; saver = null; unsubscribe = null; releaseWriter = null; projects = []; pendingCreate = null;
      host.replaceChildren(); return true;
    },
    get dirty() { return !!saver?.dirty || !!composing || !!operation || !nameInput.hidden; },
  };
}
