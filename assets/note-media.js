// One Markdown document/history; the body view only owns selection and preedit.
(function () {
  'use strict';
  const CM = window.RelatumCodeMirror, md = window.MarkdownMini;
  if (!CM || !md) return;
  const scriptURL = document.currentScript?.src || document.baseURI;
  function ensureStyle() {
    if (document.querySelector('link[data-note-media-style]')) return;
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.dataset.noteMediaStyle = 'true';
    link.href = new URL('note-media.css', scriptURL).href; document.head.append(link);
  }
  const label = () => document.documentElement.lang === 'en' ? 'Image description' : '图片说明';
  function bodyOffsets(model) {
    if (!model.bodyOffsets) {
      model.bodyOffsets = [0];
      for (let at = model.body.indexOf('\n'); at >= 0; at = model.body.indexOf('\n', at + 1)) model.bodyOffsets.push(at + 1);
    }
    return model.bodyOffsets;
  }
  function bodyPosition(model, position) {
    const offsets = bodyOffsets(model); position = Math.max(0, Math.min(model.body.length, position));
    let low = 0, high = offsets.length;
    while (low + 1 < high) { const mid = (low + high) >> 1; if (offsets[mid] <= position) low = mid; else high = mid; }
    return (model.container.offsets[model.bodyLine + low] ?? model.source.length) + position - offsets[low];
  }
  function bodyOffset(model, position) {
    const offsets = bodyOffsets(model), source = model.container.offsets;
    let low = 0, high = offsets.length;
    while (low + 1 < high) { const mid = (low + high) >> 1; if ((source[model.bodyLine + mid] ?? model.source.length) <= position) low = mid; else high = mid; }
    return Math.max(0, Math.min(model.body.length, offsets[low] + Math.max(0, position - (source[model.bodyLine + low] ?? model.source.length))));
  }
  function serializeBody(model, value) {
    const raw = model.source.split('\n'), old = model.body.split('\n'), rows = value.split('\n');
    let prefix = 0, suffix = 0;
    while (prefix < old.length && prefix < rows.length && old[prefix] === rows[prefix]) prefix++;
    while (suffix < old.length - prefix && suffix < rows.length - prefix && old[old.length - 1 - suffix] === rows[rows.length - 1 - suffix]) suffix++;
    const head = raw.slice(0, model.bodyLine);
    if (model.bodyLine === 2) head.push(model.container.prefix.trimEnd());
    return head.concat(rows.map((row, index) => {
      const previous = index < prefix ? index : index >= rows.length - suffix ? old.length - rows.length + index : -1;
      return previous >= 0 && raw[model.bodyLine + previous] !== undefined ? raw[model.bodyLine + previous] : model.container.prefix + row;
    })).join('\n');
  }
  function difference(before, after, base = 0) {
    let from = 0, tail = 0;
    while (from < before.length && from < after.length && before[from] === after[from]) from++;
    while (tail < before.length - from && tail < after.length - from && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    return { from: base + from, to: base + before.length - tail, insert: after.slice(from, after.length - tail) };
  }
  function createController(options) {
    const surfaces = new Set(); let active = null, disposed = false, revealRequest = null, revealQueued = false;
    const controller = {
      pending: () => Array.from(surfaces).some(surface => surface.pending()),
      whenSettled: () => Promise.all(Array.from(surfaces, surface => surface.whenSettled())),
      close() { revealRequest = null; for (const surface of surfaces) surface.close(); },
      destroy() { disposed = true; revealRequest = null; for (const surface of Array.from(surfaces)) surface.destroy(); },
      sync() { for (const surface of surfaces) surface.sync(); this.revealMounted(); },
      queueReveal(position, end, view) { revealRequest = { position, end, view, doc: view.state.doc, selection: view.state.selection }; this.revealMounted(); },
      revealMounted() {
        if (!revealRequest || revealQueued) return;
        revealQueued = true;
        Promise.resolve().then(() => {
          revealQueued = false; const request = revealRequest;
          if (!request || disposed) return;
          if (request.doc !== request.view.state.doc || !request.selection.eq(request.view.state.selection)) { revealRequest = null; return; }
          if (this.reveal(request.position, request.end)) revealRequest = null;
        });
      },
      active: () => active?.input ? active : null,
      context() { return active?.input ? { id: active.widget.spec.id, epoch: active.widget.epoch, doc: active.input.state.doc, selection: active.input.state.selection } : null; },
      valid(context) { return !!active?.input && !active.pending() && context?.id === active.widget.spec.id && context.epoch === active.widget.epoch && context.doc === active.input.state.doc && context.selection.eq(active.input.state.selection); },
      command(name, context, text) {
        if (!this.valid(context)) return false;
        const input = active.input;
        if (name === 'copy') return true;
        if (name === 'select-all') { input.dispatch({ selection: CM.EditorSelection.range(0, input.state.doc.length) }); input.focus(); return true; }
        if (/^(?:cut|paste|paste-plain)$/.test(name)) {
          const selection = input.state.selection.main, insert = name === 'cut' ? '' : String(text || '').replace(/\r\n?/g, '\n');
          input.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: CM.EditorSelection.cursor(selection.from + insert.length), userEvent: 'input.paste' });
          input.focus(); return true;
        }
        return options.mediaCommand(input, name);
      },
      reveal(position, end) {
        const surface = Array.from(surfaces).find(surface => { const current = surface.current(); return current && position >= current.from + surface.model.bodyFrom && position <= current.to; });
        if (!surface) return false;
        const current = surface.current(), from = current.from;
        const local = at => bodyOffset(surface.model, at - from);
        surface.open(); surface.input?.dispatch({ selection: CM.EditorSelection.range(local(position), local(end ?? position)), scrollIntoView: true }); surface.input?.focus(); return true;
      },
      widget(spec, notePath, coordinator) { return new MediaWidget(spec, notePath, coordinator); },
    };
    class MediaWidget extends CM.WidgetType {
      constructor(spec, notePath, coordinator) { super(); Object.assign(this, { spec, notePath, coordinator, epoch: coordinator.epoch }); }
      eq(other) { return this.spec.id === other.spec.id && this.spec.source === other.spec.source && this.spec.from === other.spec.from && this.epoch === other.epoch && this.notePath === other.notePath; }
      get estimatedHeight() { return 180; }
      toDOM(view) { const surface = new Surface(this, view); return surface.root; }
      updateDOM(root) { const surface = root.__noteMedia; if (!surface || surface.widget.epoch !== this.epoch || surface.widget.spec.id !== this.spec.id) return false; surface.widget = this; surface.sync(); return true; }
      destroy(root) { root.__noteMedia?.destroy(); }
      ignoreEvent(event) { return event.type !== 'contextmenu'; }
    }
    class Surface {
      constructor(widget, view) {
        ensureStyle();
        Object.assign(this, { widget, view, input: null, phase: 'idle', waiters: [], sequence: 0, syncing: false });
        this.root = document.createElement('div'); this.root.className = 'note-live-rich-block note-media'; this.root.dataset.noteMedia = ''; this.root.__noteMedia = this;
        this.imageHost = document.createElement('div'); this.imageHost.className = 'note-media-image';
        this.body = document.createElement('div'); this.body.className = 'note-media-body'; this.body.tabIndex = 0; this.body.setAttribute('aria-label', label());
        this.root.append(this.imageHost, this.body); surfaces.add(this); this.sync(); controller.revealMounted();
        this.root.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          if (event.target === this.root) { event.preventDefault(); const current = this.current(); if (!current || this.pending()) return; this.close(); view.dispatch({ selection: CM.EditorSelection.range(current.from, current.to) }); view.focus(); }
        });
        this.body.addEventListener('pointerdown', event => {
          if (event.button !== 0 || this.input || event.target.closest('a')) return;
          event.preventDefault(); event.stopPropagation(); const point = { x: event.clientX, y: event.clientY };
          this.route(() => this.open(point));
        });
        this.body.addEventListener('keydown', event => { if (!this.input && event.key === 'Enter') { event.preventDefault(); this.route(() => this.open()); } });
        this.body.addEventListener('click', event => {
          const link = event.target.closest('a'); if (!link || this.input) return;
          event.preventDefault(); event.stopPropagation();
          if (link.dataset.wikilink) options.onWikiLink(link.dataset.wikilink);
          else if (link.getAttribute('href')) options.onOpenExternal(link.getAttribute('href'));
        });
        this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (this.current()) this.measure(); }) : null;
        this.observer?.observe(this.root);
      }
      current() { if (disposed || this.widget.epoch !== this.widget.coordinator.epoch) return null; return this.widget.coordinator.spec(this.view, this.widget.spec.id); }
      pending() { return this.phase !== 'idle' || !!(this.input?.composing || this.input?.compositionStarted); }
      whenSettled() { return this.pending() ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve(true); }
      route(run) {
        const epoch = this.widget.epoch;
        Promise.resolve(options.whenMediaInputSettled()).then(() => { if (this.current() && epoch === this.widget.epoch && this.root.isConnected) run(); });
      }
      measure() { if (this.current() && this.root.isConnected) { this.view.requestMeasure(); options.mediaLayout(this.widget.spec.id); } }
      sync() {
        const current = this.current(); if (!current) return;
        const model = current.mediaModel || (this.model?.source === current.source ? this.model : md.parseMediaBlock(current.source)); if (!model) return;
        const changed = this.model !== model;
        this.model = model;
        const decorationKey = (current.calloutContext || '') + ':' + current.from + ':' + current.to;
        if (this.decorationKey !== decorationKey) {
          options.decorateBlock?.(this.root, this.view, current, this.widget.coordinator); this.decorationKey = decorationKey;
        }
        const image = this.view.state.doc.sliceString(current.from + model.imageFrom, current.from + model.imageTo);
        const selection = this.view.state.selection.main;
        const selected = selection.from === current.from + model.imageFrom && selection.to === current.from + model.imageTo;
        const key = image + ':' + selected;
        if (!this.imageWidth || this.imageSource !== image) {
          this.imageWidth = model.image.width || 240; this.imageHost.style.width = this.imageWidth + 'px'; this.imageSource = image;
        }
        if (this.imageKey !== key) {
          this.imageOwner?.imageCleanup?.(); this.imageHost.replaceChildren(); this.imageOwner = {};
          const frame = options.createMediaImage(this.imageOwner, this.view, this.widget.notePath, () => {
            const latest = this.current(), parsed = latest && (latest.mediaModel || (this.model?.source === latest.source ? this.model : md.parseMediaBlock(latest.source)));
            return parsed ? options.mediaImageRange(this.view, latest.from + parsed.imageFrom, latest.from + parsed.imageTo) : null;
          }, () => this.root.clientWidth - 24, width => { this.imageHost.style.width = width + 'px'; this.measure(); });
          if (frame) { this.imageHost.append(frame); frame.addEventListener('load', event => { if (!this.model.image.width && event.target.naturalWidth) this.imageHost.style.width = Math.min(240, event.target.naturalWidth) + 'px'; this.measure(); }, true); }
          this.imageKey = key;
        }
        this.root.classList.toggle('is-selected', selection.from === current.from && selection.to === current.to);
        if (this.input) {
          if (changed && !this.syncing && !this.pending() && this.input.state.doc.toString() !== model.body) {
            this.syncing = true;
            try { this.input.dispatch({ changes: difference(this.input.state.doc.toString(), model.body), annotations: CM.Transaction.addToHistory.of(false) }); }
            finally { this.syncing = false; }
          }
        } else this.preview();
      }
      preview() {
        if (this.previewSource === this.model.body) return;
        this.previewSource = this.model.body;
        options.releaseMediaBody(this.body);
        const result = md.renderMediaBody(this.model.body); this.body.innerHTML = result.html;
        const source = this.model.body, epoch = this.widget.epoch, version = this.previewVersion = (this.previewVersion || 0) + 1;
        const current = () => !!this.current() && this.widget.epoch === epoch && this.previewVersion === version && !this.input && this.model.body === source;
        if (result.features.math) options.typesetMedia(this.body, () => current() && options.mediaForeground()).then(complete => {
          if (!current()) return;
          if (complete) this.measure(); else this.previewSource = null;
        }).catch(() => { if (current()) this.previewSource = null; });
      }
      open(point) {
        if (this.input || this.pending() || !this.current()) return;
        if (active && active !== this) { if (active.pending()) { active.whenSettled().then(() => this.open(point)); return; } active.close(); }
        active = this; this.previewSource = null; options.mediaEditing(true); options.releaseMediaBody(this.body); this.body.replaceChildren(); this.body.classList.add('is-editing');
        const surface = this;
        this.input = new CM.EditorView({ parent: this.body, state: CM.EditorState.create({ doc: this.model.body, extensions: [
          CM.EditorView.editorAttributes.of({ class: 'note-media-input' }), CM.EditorView.contentAttributes.of({ 'aria-label': label(), spellcheck: 'false' }),
          CM.markdown({ base: CM.markdownLanguage }), CM.EditorView.lineWrapping,
          options.mediaBodyExtensions(this),
          CM.Prec.highest(CM.EditorView.domEventHandlers({
            keydown(event, input) {
              event.stopPropagation(); if (surface.pending() || event.isComposing || event.keyCode === 229) return false;
              const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
              if (mod && key === 's') { event.preventDefault(); options.onSaveRequest(); return true; }
              if (mod && (key === 'z' || key === 'y')) { event.preventDefault(); surface.history(key === 'y' || event.shiftKey); return true; }
              if (mod && event.key === 'Enter') { event.preventDefault(); surface.commit(); options.mediaBodyBoundary(surface.widget.spec.id, event.shiftKey ? 'before' : 'after'); return true; }
              if (event.key === 'Escape') { event.preventDefault(); surface.close(); const current = surface.current(); if (current) { surface.view.dispatch({ selection: CM.EditorSelection.range(current.from, current.to) }); surface.view.focus(); } return true; }
              const range = input.state.selection.main;
              if ((event.key === 'Backspace' && range.empty && range.head === 0) || (event.key === 'Delete' && range.empty && range.head === input.state.doc.length)) { event.preventDefault(); return true; }
              return options.onMediaShortcut(event, input);
            },
            beforeinput(event) {
              if (!/^history(?:Undo|Redo)$/.test(event.inputType) || surface.pending()) return false;
              event.preventDefault(); surface.history(event.inputType === 'historyRedo'); return true;
            },
            paste(event, input) {
              const text = event.clipboardData?.getData('text/plain'); if (text == null || surface.pending()) return false;
              event.preventDefault(); event.stopPropagation(); const range = input.state.selection.main, insert = text.replace(/\r\n?/g, '\n');
              input.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: CM.EditorSelection.cursor(range.from + insert.length), userEvent: 'input.paste' }); return true;
            },
            contextmenu(event) { event.preventDefault(); event.stopPropagation(); if (!surface.pending()) options.onContextMenu({ x: event.clientX, y: event.clientY, context: options.mediaCommandContext(), keyboard: event.clientX === 0 && event.clientY === 0 }); return true; },
            mousedown(event, input) { event.stopPropagation(); return options.onMediaLink(event, input); },
          })),
          CM.keymap.of(CM.markdownKeymap.concat(CM.defaultKeymap)),
          CM.EditorView.updateListener.of(update => {
            if (surface.input !== update.view || surface.syncing) return;
            if (update.docChanged && !surface.pending()) surface.commit(update.transactions.some(transaction => transaction.isUserEvent('input.paste')) ? 'input.paste.media' : 'input.type.media');
            else if (update.selectionSet && !surface.pending()) {
              const current = surface.current(), range = update.state.selection.main;
              if (current) surface.view.dispatch({ selection: CM.EditorSelection.range(current.from + bodyPosition(surface.model, range.anchor), current.from + bodyPosition(surface.model, range.head)), userEvent: 'select.media' });
            }
            if (update.docChanged || update.geometryChanged) surface.measure();
          }),
        ] }) });
        this.input.__relatumInputSession = { pending: () => this.pending(), whenSettled: () => this.whenSettled() };
        this.input.contentDOM.addEventListener('compositionstart', () => { this.phase = 'composing'; }, true);
        this.input.contentDOM.addEventListener('compositionend', () => this.endComposition(), true);
        this.input.contentDOM.addEventListener('blur', () => { this.blurQueued = true; if (!this.pending()) Promise.resolve().then(() => {
          if (this.blurQueued && !this.body.contains(document.activeElement) && !document.activeElement?.closest('.note-context-menu')) this.close();
        }); });
        this.input.focus();
        const at = point ? this.input.posAtCoords(point, false) ?? this.input.state.doc.length : this.input.state.doc.length;
        this.input.dispatch({ selection: CM.EditorSelection.cursor(at) }); this.measure();
      }
      endComposition() {
        this.phase = 'settling'; const seq = ++this.sequence;
        const finish = () => {
          if (seq !== this.sequence || !this.input) return;
          if (this.input.composing || this.input.compositionStarted) { this.timer = setTimeout(finish, 20); return; }
          this.phase = 'idle'; this.compositionCommit = true;
          try { this.commit(); } finally { this.compositionCommit = false; }
          if (!this.input) return;
          this.input.dispatch({ effects: options.mediaReconcile() });
          const waiters = this.waiters.splice(0); waiters.forEach(resolve => resolve(true));
          if (this.blurQueued && !this.body.contains(document.activeElement)) this.close();
        };
        this.timer = setTimeout(finish, 0);
      }
      commit(userEvent = 'input.type.media') {
        const current = this.current(); if (!current || !this.input || this.pending() || this.syncing) return;
        const value = this.input.state.doc.toString(), model = current.mediaModel || (this.model?.source === current.source ? this.model : md.parseMediaBlock(current.source));
        if (!model || model.body === value) return;
        const source = serializeBody(model, value), next = md.parseMediaBlock(source) || { source, body: value, bodyLine: model.bodyLine === 2 ? 3 : model.bodyLine, container: md.noteContainerSource(source) };
        const range = this.input.state.selection.main;
        this.syncing = true;
        try { this.view.dispatch({ changes: difference(current.source, source, current.from),
          selection: CM.EditorSelection.range(current.from + bodyPosition(next, range.anchor), current.from + bodyPosition(next, range.head)),
          ...(this.compositionCommit ? { annotations: CM.isolateHistory.of('full') } : {}), userEvent }); }
        finally { this.syncing = false; }
      }
      history(redo) {
        if (this.pending()) return; this.commit(); (redo ? CM.redo : CM.undo)(this.view); this.sync();
        const current = this.current();
        if (this.input && current) {
          const map = at => bodyOffset(this.model, at - current.from);
          const range = this.view.state.selection.main;
          this.input.dispatch({ selection: CM.EditorSelection.range(map(range.anchor), map(range.head)) }); this.input.focus();
        }
      }
      close() {
        if (!this.input || this.pending()) return;
        this.commit(); const input = this.input; if (!input) return; this.input = null; input.destroy();
        this.body.classList.remove('is-editing'); this.body.replaceChildren(); this.blurQueued = false;
        this.previewSource = null;
        if (active === this) { active = null; options.mediaEditing(false); } if (this.current()) this.preview(); this.measure();
      }
      destroy() {
        this.sequence++; clearTimeout(this.timer); this.observer?.disconnect();
        this.imageOwner?.imageCleanup?.(); options.releaseMediaBody(this.body);
        if (this.input) { const input = this.input; this.input = null; input.destroy(); }
        this.waiters.splice(0).forEach(resolve => resolve(false)); surfaces.delete(this); if (active === this) { active = null; options.mediaEditing(false); }
        delete this.root.__noteMedia;
      }
    }
    return controller;
  }
  window.RelatumNoteMedia = Object.freeze({ createController, bodyPosition, bodyOffset, serializeBody, ensureStyle });
})();
