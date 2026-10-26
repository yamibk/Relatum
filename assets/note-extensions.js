// Built-in, offline note extensions. Metadata and preferences never load an editor runtime.
(function () {
  'use strict';
  const KEY = 'canvas:noteExtensions:v1';
  const definitions = new Map(), runtimes = new Map(), loads = new Map();
  const listeners = new Set(), hosts = new Set(), errors = new Map();
  let saved = {}, pageActive = true;
  try {
    const value = JSON.parse(localStorage.getItem(KEY));
    if (value?.version === 1 && value.extensions && typeof value.extensions === 'object' && !Array.isArray(value.extensions)) saved = value.extensions;
  } catch (_) {}
  function publish() { listeners.forEach(listener => listener()); hosts.forEach(host => host.refresh()); }
  function optionsFor(definition, value) {
    const options = {};
    Object.entries(definition.defaultOptions || {}).forEach(([key, fallback]) => {
      options[key] = typeof value?.[key] === typeof fallback ? value[key] : fallback;
    });
    return options;
  }
  function read(id) {
    const definition = definitions.get(id);
    if (!definition) return null;
    return { enabled: typeof saved[id]?.enabled === 'boolean' ? saved[id].enabled : definition.defaultEnabled === true,
      options: optionsFor(definition, saved[id]?.options) };
  }
  function set(id, patch) {
    const definition = definitions.get(id), previous = read(id);
    if (!definition) return false;
    const value = { enabled: typeof patch.enabled === 'boolean' ? patch.enabled : previous.enabled,
      options: optionsFor(definition, { ...previous.options, ...patch.options }) };
    const next = { ...saved, [id]: value };
    try { localStorage.setItem(KEY, JSON.stringify({ version: 1, extensions: next })); }
    catch (_) { errors.set(id, 'storage'); publish(); return false; }
    saved = next; errors.delete(id); publish(); return true;
  }
  function reset() {
    try { localStorage.removeItem(KEY); } catch (_) { return false; }
    saved = {}; errors.clear(); publish(); return true;
  }
  function register(definition) {
    if (!/^[a-z][a-z0-9-]*$/.test(definition.id) || definitions.has(definition.id)) throw new Error('Invalid or duplicate note extension');
    definitions.set(definition.id, Object.freeze(definition));
  }
  function loadScript(id, src) {
    if (runtimes.has(id)) return Promise.resolve(runtimes.get(id));
    if (loads.has(id)) return loads.get(id);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = src; script.async = true;
      const fail = () => { script.remove(); loads.delete(id); reject(new Error('Extension load failed: ' + id)); };
      script.onerror = fail;
      script.onload = () => { if (runtimes.has(id)) resolve(runtimes.get(id)); else fail(); };
      document.head.append(script);
    });
    loads.set(id, promise); return promise;
  }
  function retry(id) { errors.delete(id); publish(); }
  function watch(add) {
    const method = add ? 'addEventListener' : 'removeEventListener';
    document[method]('visibilitychange', refreshHosts);
    window[method]('canvasdesktop:visibility', refreshHosts);
    window[method]('pagehide', hide); window[method]('pageshow', show);
  }
  function refreshHosts() { hosts.forEach(host => host.refresh()); }
  function hide() { pageActive = false; refreshHosts(); }
  function show() { pageActive = true; refreshHosts(); }
  function attachEditor(context) {
    const { CM, view } = context;
    let active = context.active !== false, disposed = false, revision = 0, waiting = false;
    const slots = Array.from(definitions.values(), definition => ({ definition, compartment: new CM.Compartment(), instance: null, signature: '' }));
    const foreground = () => !disposed && active && pageActive && !document.hidden
      && document.documentElement.dataset.desktopMinimized !== '1' && context.isCurrent()
      && view.dom.isConnected && !view.dom.closest('[hidden]');
    function detach(slot) {
      if (!slot.instance) return;
      view.dispatch({ effects: slot.compartment.reconfigure([]) });
      try { slot.instance.destroy?.(); } finally { slot.instance = null; slot.signature = ''; }
    }
    async function install(slot, token, value) {
      const id = slot.definition.id;
      try {
        const factory = await slot.definition.load();
        if (token !== revision || !foreground() || !read(id).enabled) return;
        if (context.inputPending()) { refresh(); return; }
        const signature = JSON.stringify(value.options);
        if (slot.instance && slot.signature === signature) return;
        detach(slot);
        const instance = factory({ ...context, isActive: foreground }, value.options);
        try { view.dispatch({ effects: slot.compartment.reconfigure(instance.extension || []) }); }
        catch (error) { instance.destroy?.(); throw error; }
        slot.instance = instance; slot.signature = signature; errors.delete(id);
        listeners.forEach(listener => listener());
      } catch (error) {
        if (token !== revision || !foreground()) return;
        detach(slot); errors.set(id, String(error.message || error)); listeners.forEach(listener => listener());
      }
    }
    function refresh() {
      if (disposed) return;
      const token = ++revision;
      // Stop queued snippet work immediately, even if IME still owns the DOM.
      slots.forEach(slot => slot.instance?.suspend?.());
      if (context.inputPending()) {
        if (!waiting) {
          waiting = true;
          Promise.resolve(context.whenSettled()).then(() => { waiting = false; if (!disposed) refresh(); });
        }
        return;
      }
      slots.forEach(slot => {
        const value = read(slot.definition.id);
        if (!foreground() || !value.enabled) detach(slot);
        else if (!errors.has(slot.definition.id)) {
          if (slot.instance && slot.signature === JSON.stringify(value.options)) slot.instance.resume?.();
          else install(slot, token, value);
        }
      });
    }
    const host = {
      configuration: () => slots.map(slot => slot.compartment.of(slot.instance?.extension || [])),
      refresh,
      setActive(value) { const next = value === true; if (next !== active) { active = next; refresh(); } },
      documentChanged() { revision++; slots.forEach(slot => slot.instance?.suspend?.()); refresh(); },
      destroy() {
        if (disposed) return;
        disposed = true; revision++;
        slots.forEach(slot => { slot.instance?.destroy?.(); slot.instance = null; });
        hosts.delete(host); if (!hosts.size) watch(false);
      },
    };
    context.configure(host.configuration());
    if (!hosts.size) watch(true);
    hosts.add(host); refresh(); return host;
  }
  window.RelatumNoteExtensions = Object.freeze({ register, read, set, reset, retry, loadScript, attachEditor,
    list: () => Array.from(definitions.values()),
    error: id => errors.get(id) || '',
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    registerRuntime(id, factory) { if (!definitions.has(id) || runtimes.has(id) || typeof factory !== 'function') throw new Error('Invalid extension runtime'); runtimes.set(id, factory); },
  });
})();
