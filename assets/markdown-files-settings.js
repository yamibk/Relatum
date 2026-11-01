// Shared by Note Settings and the independent Markdown editor. Native actions
// are explicit; opening this panel never registers an application with Windows.
(function () {
  'use strict';
  function createPanel(options = {}) {
    const panel = document.createElement('section'); panel.className = 'markdown-files-settings'; panel.dataset.i18nManaged = 'true';
    if (!document.querySelector('link[href="markdown-files-settings.css"]')) {
      const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = 'markdown-files-settings.css'; document.head.append(style);
    }
    const language = options.language || (() => document.documentElement.lang);
    const text = (zh, en) => language() === 'en' ? en : zh;
    let state = null, active = false, sequence = 0, busy = false, message = '', messageAction = '';
    let refs = null, renderedLanguage = '', recentSignature = '', pendingOption = null;
    const controls = new Set();
    const api = () => window.pywebview?.api;
    function element(tag, value, className) {
      const item = document.createElement(tag); if (value) item.textContent = value; if (className) item.className = className; return item;
    }
    function button(zh, en, action, value, parent, disabled = false) {
      const item = element('button', text(zh, en)); item.type = 'button';
      item.markdownDisabled = typeof disabled === 'function' ? disabled : () => disabled;
      item.dataset.markdownAction = action;
      item.addEventListener('click', () => execute(action, value, item)); controls.add(item); parent.append(item); return item;
    }
    function card(zh, en, hintZh, hintEn) {
      const item = element('div', '', 'markdown-files-card'); item.append(element('h3', text(zh, en)), element('p', text(hintZh, hintEn))); panel.append(item); return item;
    }
    function render() {
      if (refs && renderedLanguage === language()) { sync(); return; }
      const focused = panel.contains(document.activeElement) ? document.activeElement.dataset.markdownAction : '';
      const maintenanceOpen = refs?.maintenance.open || false;
      renderedLanguage = language(); controls.clear(); recentSignature = '';
      panel.replaceChildren();
      const start = card('开始使用', 'Get started', '直接编辑磁盘上的 Markdown，保存到原位置，不会自动加入笔记库。', 'Edit Markdown where it lives. Files are saved in place and are not added to your notebook library.');
      const actions = element('div', '', 'markdown-files-actions'); start.append(actions);
      button('打开文件…', 'Open files…', 'open', null, actions); button('新建文档', 'New document', 'new', null, actions);
      const nativeHint = element('small', text('这些操作需要使用 Windows 桌面版 Relatum。', 'These actions are available in the Windows desktop app.')); start.append(nativeHint);
      const windows = card('双击 Markdown 文件时打开 Relatum', 'Open Markdown with a double-click',
        '只需完成下面两步。你也可以保留当前默认程序，偶尔通过“打开方式”选择 Relatum。',
        'Follow these two steps, or keep your current default and choose Relatum from “Open with” when needed.');
      const status = element('p', '', 'markdown-files-status'); windows.append(status);
      const steps = element('div', '', 'markdown-files-steps'); windows.append(steps);
      const first = element('div'); first.append(element('strong', text('1 · 让 Windows 识别 Relatum', '1 · Make Relatum available to Windows')),
        element('small', text('登记此程序的位置，让它出现在“打开方式”中。', 'Register this app location so it can appear in “Open with”.')));
      const register = button('注册 / 修复', 'Register / repair', 'register', null, first, () => !state?.association?.supported); steps.append(first);
      const second = element('div'); second.append(element('strong', text('2 · 在 Windows 中选择默认程序', '2 · Choose your default in Windows')),
        element('small', text('进入系统设置后搜索 .md，再选择 Relatum。是否替换 Typora 等程序，由你决定。', 'In Windows Settings, search for .md and choose Relatum. You decide whether to replace your current default.')));
      button('打开默认应用设置', 'Open default app settings', 'defaults', null, second, () => !state?.association?.supported); steps.append(second);
      const maintenance = document.createElement('details'); maintenance.append(element('summary', text('移动程序或取消注册', 'Moving the app or removing registration')));
      maintenance.append(element('p', text('移动便携版后，点击“注册 / 修复”更新位置。换电脑需要重新设置；删除程序前可取消注册。取消注册不会替你指定其他默认程序。',
        'After moving the portable app, register it again to update its location. Set it up separately on each PC. Remove registration before deleting the app; this does not choose another default for you.')));
      maintenance.open = maintenanceOpen;
      button('取消此位置的注册', 'Remove this registration', 'unregister', null, maintenance, () => !state?.association?.registered); windows.append(maintenance);
      const associationMessage = element('p', '', 'markdown-files-message'); associationMessage.setAttribute('role', 'status'); windows.append(associationMessage);
      const preferences = card('简洁窗口', 'Simple editor', '以正文为主，工具使用图标按钮；唯一的侧栏是可以收起的大纲。', 'Focus on writing, with icon buttons and a collapsible outline as the only sidebar.');
      for (const [key, zh, en, helpZh, helpEn] of [
        ['autoSave', '自动保存', 'Save automatically', '停止输入后保存到原文件。关闭后仍可按 Ctrl+S 保存。', 'Save to the original file after typing pauses. When off, use Ctrl+S.'],
        ['outline', '打开窗口时显示大纲', 'Show outline when opening a window', '适合经常跳转章节的长文；窗口中的大纲按钮也能随时切换。', 'Useful for longer documents. You can also toggle the outline from the toolbar.'],
      ]) {
        const row = element('label', '', 'markdown-files-option'), body = element('span');
        body.append(element('strong', text(zh, en)), element('small', text(helpZh, helpEn)));
        const input = document.createElement('input'); input.type = 'checkbox'; input.markdownDisabled = () => false; controls.add(input);
        input.dataset.markdownAction = key; input.addEventListener('change', () => execute(key, input.checked, input)); row.append(body, input); preferences.append(row);
      }
      const recent = card('最近打开', 'Recent files', '只记录文件位置。移除记录或清空列表都不会删除磁盘文件。', 'Only file locations are recorded. Removing an entry or clearing this list does not delete files.');
      const recentList = element('div'); recent.append(recentList);
      const output = element('p', '', 'markdown-files-message'); output.setAttribute('role', 'status'); panel.append(output);
      refs = { nativeHint, status, register, maintenance, associationMessage, recentList, output };
      sync();
      if (focused) panel.querySelector('[data-markdown-action="' + focused + '"]')?.focus({ preventScroll: true });
    }
    function sync() {
      const registered = state?.association?.registered;
      const status = registered && !state.association.iconCurrent ? text('已注册，可更新为独立的 Markdown 文档图标。', 'Registered. Update to the dedicated Markdown document icon.')
        : state?.association?.default && registered ? text('当前已设为 .md 默认程序', 'Relatum is the default for .md')
        : state?.association?.default ? text('Windows 仍选择 Relatum；请重新注册，或到默认应用中选择其他程序。', 'Windows still selects Relatum. Register it again, or choose another default app.')
        : registered ? text('Windows 已识别此位置的 Relatum', 'Windows recognizes this copy of Relatum')
        : state?.association?.otherLocation ? text('检测到其他位置的注册，可更新到当前位置', 'Registration points to another location; update it here')
        : text('尚未注册，默认程序保持原样', 'Not registered; your current default is unchanged');
      const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
      setText(refs.status, status);
      setText(refs.register, registered ? (state.association.iconCurrent ? text('更新注册', 'Update registration') : text('更新文件图标', 'Update file icon')) : text('注册 / 修复', 'Register / repair'));
      refs.nativeHint.hidden = !!api()?.markdown_files;
      const associationAction = ['register', 'unregister', 'defaults'].includes(messageAction);
      setText(refs.associationMessage, associationAction ? message : ''); refs.associationMessage.hidden = !associationAction || !message;
      setText(refs.output, associationAction ? '' : message); refs.output.hidden = associationAction || !message;
      const signature = JSON.stringify(state?.recent || []);
      if (signature !== recentSignature) { recentSignature = signature; renderRecent(); }
      panel.setAttribute('aria-busy', String(busy));
      for (const item of controls) {
        if (!panel.contains(item)) { controls.delete(item); continue; }
        item.disabled = !api()?.markdown_files || item.markdownDisabled();
        item.setAttribute('aria-disabled', String(item.disabled || busy));
        if (item.type === 'checkbox') {
          const key = item.dataset.markdownAction;
          item.checked = pendingOption?.key === key ? pendingOption.value : state ? state[key] : key === 'autoSave';
        }
      }
    }
    function renderRecent() {
      const recent = refs.recentList; recent.replaceChildren();
      if (!state?.recent?.length) recent.append(element('p', text('打开已有文件或保存新文档后，会在这里显示。', 'Opened files and newly saved documents will appear here.')));
      for (const file of state?.recent || []) {
        const row = element('div', '', 'markdown-files-recent'), body = element('div');
        body.append(element('strong', file.name), element('small', file.path));
        if (!file.exists) body.append(element('small', text('文件已移动或不可用，请重新选择。', 'File moved or unavailable; select it again.')));
        const tools = element('div', '', 'markdown-files-actions'); row.append(body, tools);
        button('打开', 'Open', 'recent', file.path, tools, !file.exists); button('定位', 'Show in folder', 'reveal', file.path, tools, !file.exists); button('移除记录', 'Remove entry', 'remove', file.path, tools); recent.append(row);
      }
      if (state?.recent?.length) button('清空最近列表', 'Clear recent list', 'clear', null, recent);
    }
    async function execute(action, value, trigger) {
      if (busy || !api()?.markdown_files) return false;
      const token = ++sequence; busy = true; message = ''; messageAction = action;
      pendingOption = ['autoSave', 'outline'].includes(action) ? { key: action, value } : null; render();
      try {
        if (action === 'unregister') {
          if (!options.confirmAction) throw new Error(text('确认窗口不可用，请重新打开设置。', 'Confirmation unavailable. Please reopen settings.'));
          const accepted = await options.confirmAction({ id: 'markdown-unregister', trigger,
            title: ['取消此位置的注册？', 'Remove this registration?'],
            description: ['将移除此位置的 Relatum 注册，磁盘文件保持原样。若它仍是默认程序，请到 Windows 设置选择其他程序。',
              'Remove this copy’s registration and keep your files. If Relatum is still the default, choose another app in Windows Settings.'],
            acceptLabel: ['取消注册', 'Remove registration'] });
          if (!accepted || !active || token !== sequence) return false;
        }
        const result = await api().markdown_files(action, value);
        if (!result?.ok) throw new Error(result?.error || text('操作未完成，请重试。', 'Could not complete the action. Please retry.'));
        if (token !== sequence) return true;
        state = result; options.onChange?.(state);
        message = action === 'register' ? text('注册已更新。下一步可打开默认应用设置，选择 .md。', 'Registration updated. Open default app settings to choose Relatum for .md.')
          : action === 'unregister' ? (state.association?.default
            ? text('已取消此位置的注册。Windows 仍选择 Relatum，请到默认应用设置选择其他程序。', 'Registration removed. Windows still selects Relatum; choose another default app in Windows Settings.')
            : text('已取消此位置的注册。', 'Registration removed.')) : '';
        return true;
      } catch (error) { if (token === sequence) message = error.message; return false; }
      finally {
        busy = false; pendingOption = null;
        if (active) {
          const focused = trigger && document.activeElement === trigger;
          render();
          if (focused && trigger.disabled && !refs.register.disabled) refs.register.focus({ preventScroll: true });
          if (token !== sequence) execute('status');
        }
      }
    }
    for (const type of ['click', 'keydown']) panel.addEventListener(type, event => {
      if (!busy || !event.target.closest('[data-markdown-action]') || type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    render();
    window.addEventListener('pywebviewready', () => { if (active) execute('status'); }, { once: true });
    return { panel, setActive(value) { if (active === !!value) { if (active) render(); return; } active = !!value; if (active) { render(); execute('status'); } else sequence++; },
      refresh: render, reset: () => execute('reset') };
  }
  window.RelatumMarkdownFilesSettings = { createPanel };
})();
