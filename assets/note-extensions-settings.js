// Generic extension cards; extension-specific controls come from metadata factories.
(function () {
  'use strict';
  function createPanel({ language }) {
    const registry = window.RelatumNoteExtensions;
    const panel = document.createElement('section'); panel.className = 'note-extension-settings'; panel.dataset.i18nManaged = 'true';
    const intro = document.createElement('p'); panel.append(intro);
    const rows = registry.list().map(definition => {
      const card = document.createElement('article'); card.className = 'note-extension-card'; card.dataset.extensionId = definition.id;
      const label = document.createElement('label'); label.className = 'note-extension-toggle';
      const text = document.createElement('span'), title = document.createElement('strong'), description = document.createElement('small');
      const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.extensionEnabled = definition.id;
      text.append(title, description); label.append(text, input); card.append(label);
      input.addEventListener('change', () => registry.set(definition.id, { enabled: input.checked }));
      const status = document.createElement('div'); status.className = 'note-extension-status'; status.setAttribute('role', 'status');
      const error = document.createElement('span'), retry = document.createElement('button'); retry.type = 'button'; retry.dataset.extensionRetry = definition.id;
      retry.addEventListener('click', () => registry.retry(definition.id)); status.append(error, retry); card.append(status);
      const details = document.createElement('details'), summary = document.createElement('summary'); details.append(summary);
      const row = { definition, input, title, description, status, error, retry, summary, settings: null };
      row.prepare = () => {
        if (row.settings || !definition.createSettings) return;
        row.settings = definition.createSettings({ language, read: () => registry.read(definition.id).options,
          update: options => registry.set(definition.id, { options }) });
        details.append(row.settings.panel); row.settings.refresh?.();
      };
      details.addEventListener('toggle', () => { if (details.open) row.prepare(); });
      if (definition.createSettings) card.append(details);
      panel.append(card); return row;
    });
    function refresh() {
      const english = language() === 'en', index = english ? 1 : 0;
      intro.textContent = english ? 'Built-in offline extensions. Enable the tools you need; changes apply immediately.' : '随软件附带的离线扩展。按需开启，更改立即生效。';
      rows.forEach(row => {
        row.input.checked = registry.read(row.definition.id).enabled;
        row.title.textContent = row.definition.name[index] + ' · ' + row.definition.version;
        row.description.textContent = row.definition.description[index];
        row.summary.textContent = english ? 'Settings & usage' : '设置与使用说明';
        const error = registry.error(row.definition.id); row.status.hidden = !error;
        row.error.textContent = error === 'storage' ? (english ? 'Could not save the setting.' : '设置保存失败。')
          : error ? (english ? 'Extension could not start. ' : '扩展暂未启动。') + error : '';
        row.retry.textContent = english ? 'Retry' : '重试'; row.retry.hidden = error === 'storage';
        row.settings?.refresh();
      });
    }
    const unsubscribe = registry.subscribe(refresh); refresh();
    return { panel, refresh,
      prepareSearch(query) {
        rows.forEach(row => {
          const definition = row.definition;
          const keywords = [definition.name.join(' '), definition.description.join(' '), definition.keywords || '',
            ...(definition.snippets || []).map(snippet => snippet.trigger)].join(' ').toLocaleLowerCase();
          if (query.split(/\s+/).every(part => keywords.includes(part))) row.prepare();
        });
      },
      destroy() { unsubscribe(); rows.forEach(row => row.settings?.destroy?.()); },
    };
  }
  window.RelatumNoteExtensionSettings = Object.freeze({ createPanel });
})();
