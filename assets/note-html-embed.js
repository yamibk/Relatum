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

  function create({ language, isCurrent, whenSettled }) {
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
        entry.name = result.name;
        if (entry.title) entry.title.textContent = entry.title.title = result.name;
        if (entry.openButton) entry.openButton.disabled = false;
        entry.onName?.(result.name);
        const element = entry.frame = frame(result.url, result.name, interactive);
        if (interactive) element.addEventListener('load', () => {
          if (current() && entry.frame === element && document.activeElement === (entry.button || entry.host)) element.focus({ preventScroll: true });
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

    function boxSizeOnDrag(event, entry, initial) {
      const { host, stage, controls } = entry;
      const startWidth = host.offsetWidth, startHeight = stage.offsetHeight;
      const { minWidth, maxWidth, minHeight, maxHeight } = controls.limits;
      const column = host.parentElement, style = getComputedStyle(column);
      const available = Math.floor(column.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      const widthLimit = Math.min(maxWidth, available);
      return position => {
        const dx = position.clientX - event.clientX, dy = position.clientY - event.clientY;
        const width = clamp(startWidth + dx, minWidth, widthLimit);
        return {
          ...initial,
          width: widthLimit >= minWidth && Math.abs(dx) >= 3 && width !== startWidth ? width : initial.width,
          height: Math.abs(dy) >= 3 ? clamp(startHeight + dy, minHeight, maxHeight) : initial.height,
        };
      };
    }

    function startResize(event, entry, zooming = false) {
      if (event.button !== 0 || !event.isPrimary || !present(entry) || entry.cancelResize) return;
      const { host, controls } = entry;
      const commit = controls.resize();
      if (!commit) return;
      const grip = event.currentTarget;
      event.preventDefault();
      event.stopPropagation();
      if (zooming) grip.focus({ preventScroll: true });
      const initial = controls.getSize();
      const { minZoom, maxZoom } = controls.limits;
      const dragClass = zooming ? 'is-zooming' : 'is-resizing';
      const sizeAt = zooming
        ? position => ({ ...initial, zoom: clamp(initial.zoom + (position.clientX - event.clientX) / 3, minZoom, maxZoom) })
        : boxSizeOnDrag(event, entry, initial);
      const pointer = event.pointerId;
      const listeners = new AbortController(), { signal } = listeners;
      let size = initial, frameId = 0;

      const paint = value => {
        if (zooming) {
          host.style.setProperty('--note-html-scale', String(value.zoom / 100));
          grip.setAttribute('aria-valuenow', String(value.zoom));
          return;
        }
        host.style.setProperty('--note-html-width', value.width === null ? '100%' : value.width + 'px');
        host.style.setProperty('--note-html-height', value.height + 'px');
        entry.onLayout?.();
      };
      const finish = accept => {
        if (!entry.cancelResize) return;
        entry.cancelResize = null;
        listeners.abort();
        if (frameId) cancelAnimationFrame(frameId);
        if (grip.hasPointerCapture(pointer)) grip.releasePointerCapture(pointer);
        host.classList.remove(dragClass);
        if (accept && present(entry) && commit(size)) paint(size);
        else paint(controls.getSize());
      };
      entry.cancelResize = () => finish(false);
      host.classList.add(dragClass);
      grip.addEventListener('pointermove', position => {
        if (position.pointerId !== pointer) return;
        size = sizeAt(position);
        if (!frameId) frameId = requestAnimationFrame(() => { frameId = 0; paint(size); });
      }, { signal });
      grip.addEventListener('pointerup', position => {
        if (position.pointerId !== pointer) return;
        size = sizeAt(position);
        finish(true);
      }, { signal });
      for (const type of ['pointercancel', 'lostpointercapture']) {
        grip.addEventListener(type, position => { if (position.pointerId === pointer) finish(false); }, { signal });
      }
      for (const type of ['blur', 'resize']) window.addEventListener(type, entry.cancelResize, { signal });
      if (zooming) grip.addEventListener('blur', entry.cancelResize, { signal });
      window.addEventListener('keydown', key => {
        if (key.key !== 'Escape') return;
        key.preventDefault(); key.stopPropagation(); finish(false);
      }, { signal, capture: true });
      try { grip.setPointerCapture(pointer); } catch (_error) { finish(false); }
    }

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
