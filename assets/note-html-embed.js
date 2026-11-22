(() => {
  'use strict';

  function nativeApi() {
    const api = window.pywebview?.api;
    return typeof api?.note_html === 'function' ? api : null;
  }

  function frame(url, title, interactive) {
    const element = document.createElement('iframe');
    element.title = title;
    element.sandbox = interactive ? 'allow-scripts' : '';
    if (!interactive) {
      element.tabIndex = -1;
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    element.referrerPolicy = 'no-referrer';
    element.src = url;
    return element;
  }

  let support;
  function checkSupport() {
    const api = nativeApi();
    if (!api) return Promise.resolve(false);
    if (!support) support = verify(api).catch(() => false);
    return support;
  }

  async function verify(api) {
    const run = async (name, blocked) => {
      const result = await api.note_html(name);
      if (result.status === 'ready') return true;
      if (result.status !== 'ok') return false;
      const element = frame(result.url, '', true);
      element.hidden = true;
      element.setAttribute('aria-hidden', 'true');
      return new Promise(resolve => {
        const finish = (ok) => {
          clearTimeout(timer);
          window.removeEventListener('message', receive);
          element.remove();
          resolve(ok);
        };
        const receive = event => {
          if (event.source === element.contentWindow && event.origin === 'null') finish(event.data?.noteHtmlProbe === blocked);
        };
        const timer = setTimeout(() => finish(false), 3500);
        window.addEventListener('message', receive);
        document.body.append(element);
      });
    };
    return await run('probe-control', false) && await run('probe', true)
      && (await api.note_html('confirm')).status === 'ready';
  }

  function create({ language, isCurrent, whenSettled, startEmbedResize }) {
    const entries = new Map();
    const text = (zh, en) => language() === 'en' ? en : zh;
    const label = () => text('HTML 文件', 'HTML file');
    let observing, active = null;

    function present(entry) {
      return entries.get(entry.host) === entry && entry.visible && entry.host.isConnected
        && !entry.host.closest('[inert], [hidden]')
        && (entry.isCurrent ? entry.isCurrent() : isCurrent(entry.path, entry.mode));
    }

    function clear(entry) {
      entry.cancelResize?.();
      entry.generation++;
      entry.frame?.remove();
      entry.frame = null;
      if (entry.pendingUrl) {
        void nativeApi()?.note_html('revoke', entry.pendingUrl).catch(() => {});
        entry.pendingUrl = null;
      }
      entry.pending = false;
      entry.stage.removeAttribute('aria-busy');
      if (active === entry) active = null;
      if (entry.button) {
        entry.button.disabled = false;
        entry.button.setAttribute('aria-pressed', 'false');
        entry.button.textContent = text('互动', 'Interact');
      }
    }

    async function load(entry, interactive) {
      const api = nativeApi();
      if (!api || !present(entry) || entry.failed || entry.pending) return;
      const requested = entry.generation;
      if (interactive && entry.button && !await whenSettled()) return;
      if (!present(entry) || entry.generation !== requested || entry.pending || entry.failed) return;
      if (interactive && active && active !== entry) stop(active);
      clear(entry);
      const sequence = entry.generation;
      const current = () => present(entry) && entry.generation === sequence;
      if (interactive) active = entry;
      entry.pending = true;
      entry.stage.setAttribute('aria-busy', 'true');
      if (entry.button) {
        entry.button.disabled = !interactive;
        entry.button.textContent = interactive ? text('退出互动', 'Exit interaction') : text('互动', 'Interact');
        entry.button.setAttribute('aria-pressed', String(interactive));
      }
      try {
        if (!await checkSupport()) {
          if (current()) fail(entry, text('需要支持离线隔离的 WebView2', 'Requires WebView2 with offline isolation'));
          return;
        }
        if (!current()) return;
        const result = await api.note_html('open', entry.path, entry.id, interactive);
        if (!current()) {
          if (result.url) await api.note_html('revoke', result.url);
          return;
        }
        if (result.status !== 'ok') {
          fail(entry, result.code === 'not_found' ? text('HTML 文件缺失', 'HTML file is missing')
            : text('无法加载 HTML 文件', 'Unable to load the HTML file'));
          return;
        }
        entry.pendingUrl = result.url;
        entry.name = result.name;
        if (entry.title) entry.title.textContent = entry.title.title = result.name;
        if (entry.openButton) entry.openButton.disabled = false;
        entry.onName?.(result.name);
        const element = entry.frame = frame(result.url, result.name, interactive);
        element.addEventListener('load', () => {
          if (!current() || entry.frame !== element) return;
          entry.pendingUrl = null;
          if (interactive && document.activeElement === (entry.button || entry.host)) element.focus({ preventScroll: true });
        }, { once: true });
        entry.stage.append(element);
      } catch (_error) {
        if (current()) fail(entry, text('无法加载 HTML 文件', 'Unable to load the HTML file'));
      } finally {
        if (current()) {
          entry.pending = false;
          if (entry.button) entry.button.disabled = false;
          entry.stage.removeAttribute('aria-busy');
        }
      }
    }

    function fail(entry, message) {
      clear(entry);
      entry.failed = true;
      entry.stage.hidden = true;
      if (entry.footer) entry.footer.hidden = true;
      if (entry.button) entry.button.hidden = true;
      if (entry.openButton) entry.openButton.hidden = true;
      entry.status.textContent = message;
      entry.status.hidden = false;
      entry.onLayout?.();
    }

    function stop(entry, focus = false) {
      clear(entry);
      if (focus) entry.button?.focus({ preventScroll: true });
      if (present(entry)) void load(entry, false);
    }

    function update(entry) {
      if (!present(entry)) {
        if (entry.frame || entry.pending || entry.cancelResize) clear(entry);
      } else if (!entry.frame && !entry.pending && !entry.failed) void load(entry, entry.interactive === true);
    }

    function enable(entry) {
      if (entry.enabled || !nativeApi()) return;
      entry.enabled = true;
      entry.stage.hidden = false;
      if (entry.footer) entry.footer.hidden = false;
      if (entry.button) entry.button.hidden = false;
      if (entry.openButton) entry.openButton.hidden = false;
      entry.status.textContent = '';
      if (entry.mode === 'tab') entry.status.hidden = true;
      entry.onLayout?.();
      observing ||= new IntersectionObserver(changes => {
        for (const change of changes) {
          const item = entries.get(change.target);
          if (!item) continue;
          item.visible = change.isIntersecting;
          update(item);
        }
      });
      observing.observe(entry.host);
    }

    const nativeReady = () => entries.forEach(enable);

    const clamp = (value, min, max) => Math.round(Math.min(max, Math.max(min, value)));
    const startResize = (event, entry, zooming) => startEmbedResize(event, entry, present, zooming);

    function setZoom(entry, zoom) {
      if (!present(entry) || entry.cancelResize) return;
      const { controls } = entry;
      controls.resize()?.({ ...controls.getSize(), zoom }, true);
    }

    function zoomHandle(entry) {
      const handle = document.createElement('span');
      const { controls } = entry, { minZoom, maxZoom } = controls.limits;
      handle.className = 'note-html-zoom';
      handle.tabIndex = 0;
      handle.setAttribute('role', 'slider');
      handle.setAttribute('aria-label', text('网页缩放', 'Page zoom'));
      handle.setAttribute('aria-valuemin', String(minZoom));
      handle.setAttribute('aria-valuemax', String(maxZoom));
      handle.setAttribute('aria-valuenow', String(controls.getSize().zoom));
      handle.onpointerdown = event => startResize(event, entry, true);
      handle.ondblclick = event => {
        event.preventDefault(); event.stopPropagation(); setZoom(entry, maxZoom);
      };
      handle.onkeydown = event => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const current = controls.getSize().zoom;
        let zoom;
        switch (event.key) {
          case 'ArrowLeft': case 'ArrowDown': zoom = current - 5; break;
          case 'ArrowRight': case 'ArrowUp': zoom = current + 5; break;
          case 'Home': zoom = minZoom; break;
          case 'End': zoom = maxZoom; break;
          default: return;
        }
        event.preventDefault(); event.stopPropagation();
        setZoom(entry, clamp(zoom, minZoom, maxZoom));
      };
      return handle;
    }

    function track(entry) {
      if (!entries.size) window.addEventListener('pywebviewready', nativeReady);
      entries.set(entry.host, entry);
      enable(entry);
      return () => {
        clear(entry);
        entries.delete(entry.host);
        observing?.unobserve(entry.host);
        if (!entries.size) {
          window.removeEventListener('pywebviewready', nativeReady);
          observing?.disconnect(); observing = null;
        }
      };
    }

    function mount(host, { path, id, mode, onLayout, controls, onOpen }) {
      host.setAttribute('data-ui-tooltip-disabled', '');
      const bar = document.createElement('div'), title = document.createElement('span');
      const status = document.createElement('span'), button = document.createElement('button');
      const stage = document.createElement('div');
      const native = !!nativeApi();
      bar.className = 'note-html-embed-bar';
      title.textContent = label();
      status.className = 'note-html-embed-status';
      if (!native) status.textContent = text('在 Windows 桌面版查看', 'View in the Windows desktop app');
      button.type = 'button';
      button.className = 'note-html-interact';
      button.hidden = !native;
      button.setAttribute('aria-pressed', 'false');
      button.textContent = text('互动', 'Interact');
      stage.className = 'note-html-embed-stage';
      stage.hidden = !native;
      bar.append(title, status, button);
      host.replaceChildren(bar, stage);

      const entry = { host, path, id, mode, title, status, stage, button, onLayout, controls, generation: 0, visible: false };
      if (controls) {
        const move = document.createElement('button'), remove = document.createElement('button');
        move.type = remove.type = 'button';
        move.className = 'note-html-move note-table-grip';
        move.setAttribute('aria-label', text('移动 HTML 块', 'Move HTML block'));
        for (let i = 0; i < 6; i++) move.append(document.createElement('i'));
        move.onpointerdown = event => controls.move(event, () => entries.get(host) === entry && host.isConnected && !entry.cancelResize);
        remove.className = 'note-html-remove';
        remove.setAttribute('aria-label', text('移除 HTML 块', 'Remove HTML block'));
        remove.innerHTML = '<svg class="note-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#note-icon-trash"/></svg>';
        remove.onclick = () => { if (!entry.cancelResize) controls.remove(); };
        bar.prepend(move);
        bar.append(remove);

        const footer = entry.footer = document.createElement('div');
        footer.className = 'note-html-embed-footer';
        footer.hidden = !native;
        const resize = document.createElement('span');
        resize.className = 'note-html-resize';
        resize.setAttribute('aria-hidden', 'true');
        resize.onpointerdown = event => startResize(event, entry);
        footer.append(zoomHandle(entry), resize);
        host.append(footer);
      }
      if (onOpen) {
        const openButton = entry.openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.className = 'note-html-open';
        openButton.hidden = !native;
        openButton.disabled = true;
        const caption = text('在新标签页打开', 'Open in new tab');
        openButton.title = caption;
        openButton.setAttribute('aria-label', caption);
        openButton.innerHTML = '<svg class="note-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#note-icon-external-link"/></svg>';
        openButton.onclick = () => {
          if (entry.name && !entry.cancelResize && present(entry)) onOpen({ path, id, name: entry.name });
        };
        bar.append(openButton);
      }
      onLayout?.();
      button.onclick = () => {
        if (entry.cancelResize) return;
        if (active === entry) stop(entry, true);
        else void load(entry, true);
      };
      return track(entry);
    }

    function mountTab(host, { path, id, interactive, isCurrent: isTabCurrent, onName }) {
      const status = document.createElement('div'), stage = document.createElement('div');
      stage.className = 'note-html-tab-stage';
      stage.hidden = true;
      status.className = 'note-html-tab-status';
      status.setAttribute('role', 'status');
      status.textContent = text('在 Windows 桌面版查看', 'View in the Windows desktop app');
      host.replaceChildren(stage, status);
      return track({ host, path, id, mode: 'tab', interactive, isCurrent: isTabCurrent, onName,
        status, stage, generation: 0, visible: false });
    }

    return {
      mount,
      mountTab,
      sync() { entries.forEach(update); },
      suspend() { entries.forEach(clear); },
    };
  }

  window.RelatumNoteHtmlEmbed = { create, checkSupport };
})();
