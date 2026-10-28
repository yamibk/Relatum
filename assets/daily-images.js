// Temporary image workbench. Only blobs and geometry survive a Daily view teardown.
(function () {
  'use strict';
  const C = window.RelatumImageMarkupCore;
  const labels = {
    title: ['图片编辑', 'Image editor'], choose: ['选择图片', 'Choose image'], copy: ['复制图片', 'Copy image'],
    empty: ['拖入图片或按 Ctrl+V', 'Drop an image or press Ctrl+V'], temporary: ['临时标记，复制后即可带走', 'Mark it up, copy it, take it with you'],
    select: ['选择与调整', 'Select and adjust'], rect: ['矩形', 'Rectangle'], ellipse: ['椭圆', 'Ellipse'], arrow: ['箭头', 'Arrow'],
    line: ['直线', 'Line'], pen: ['画笔', 'Pen'], text: ['文字', 'Text'], mosaic: ['马赛克', 'Pixelate'], crop: ['裁剪', 'Crop'],
    undo: ['撤销', 'Undo'], redo: ['重做', 'Redo'], remove: ['删除图片', 'Delete image'], removeMark: ['删除标记', 'Delete annotation'],
    reset: ['恢复原图', 'Reset image'], apply: ['应用裁剪', 'Apply crop'], cancel: ['取消', 'Cancel'], fit: ['适应容器', 'Fit'], actual: ['原始大小', 'Actual size'],
    out: ['缩小', 'Zoom out'], in: ['放大', 'Zoom in'], color: ['颜色', 'Color'], width: ['线宽', 'Line width'], size: ['字号', 'Text size'], block: ['马赛克强度', 'Pixel size'],
    thin: ['细', 'Thin'], medium: ['中', 'Medium'], thick: ['粗', 'Thick'], small: ['小', 'Small'], large: ['大', 'Large'],
    red: ['红色', 'Red'], orange: ['橙色', 'Orange'], yellow: ['黄色', 'Yellow'], green: ['绿色', 'Green'], blue: ['蓝色', 'Blue'], black: ['黑色', 'Black'], white: ['白色', 'White'],
    hint: ['空格拖动画面 · Ctrl+Z 撤销 · 右键复制', 'Space to pan · Ctrl+Z to undo · Right-click to copy'],
    textHint: ['输入文字，Ctrl+Enter 完成', 'Type here, Ctrl+Enter to finish'],
    copied: ['图片已复制', 'Image copied'], failed: ['图片复制失败，请检查剪贴板权限后重试', 'Could not copy image. Check clipboard access and retry.'],
    invalid: ['无法读取此图片，请使用 PNG、JPEG、WebP、BMP 或 GIF', 'Cannot read this image. Use PNG, JPEG, WebP, BMP or GIF.'],
    limit: ['图片过大：文件最多 40 MiB，单边最多 16384 像素，总像素最多 64 Mi', 'Image too large: up to 40 MiB, 16384 pixels per side and 64 Mi pixels.'],
    first: ['一次只处理一张图片，已选择第一张', 'One image at a time; using the first image.'], loading: ['正在读取图片…', 'Loading image…'],
  };
  const paths = {
    select: '<path d="m5 3 14 10-7 1-3 7Z"/>', rect: '<rect x="4" y="5" width="16" height="14" rx="1"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8" ry="7"/>', arrow: '<path d="M5 19 19 5M9 5h10v10"/>', line: '<path d="m5 19 14-14"/>',
    pen: '<path d="m15 4 5 5-11 11H4v-5ZM12 7l5 5"/>', text: '<path d="M4 6V4h16v2M12 4v16M8 20h8"/>',
    mosaic: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M8 4v16M12 4v16M16 4v16M4 8h16M4 12h16M4 16h16"/>',
    crop: '<path d="M7 3v14h14M3 7h14v14"/>', undo: '<path d="m8 5-5 5 5 5M3 10h10a6 6 0 0 1 0 12" transform="translate(0 -2)"/>',
    redo: '<path d="m16 5 5 5-5 5M21 10h-10a6 6 0 0 0 0 12" transform="translate(0 -2)"/>', remove: '<path d="m6 6 12 12M18 6 6 18"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>',
    choose: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
    fit: '<path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5"/>', actual: '<path d="M5 7h2v10M16 7h2v10"/><circle cx="12" cy="9" r=".6"/><circle cx="12" cy="15" r=".6"/>',
    out: '<path d="M5 12h14"/>', in: '<path d="M5 12h14M12 5v14"/>', apply: '<path d="m5 12 4 4L19 6"/>',
  };
  const icon = key => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[key] + '</svg>';
  const tools = ['select', 'rect', 'ellipse', 'arrow', 'line', 'pen', 'text', 'mosaic', 'crop'];
  const colors = [['red', '#ef4444'], ['orange', '#f97316'], ['yellow', '#eab308'], ['green', '#16a34a'], ['blue', '#0284c7'], ['black', '#171717'], ['white', '#ffffff']];
  const inputTarget = target => !!target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]');
  const TAP_DISTANCE = 4;
  window.RelatumDailyImages = function (root, host) {
    const session = host.state.markup || (host.state.markup = C.createSession()), scope = host.createScope();
    const tr = key => labels[key][window.RelatumI18n?.language === 'en' ? 1 : 0];
    let active = false, destroyed = false, epoch = 0, revision = 0, importId = 0, decodeId = 0;
    let resource = null, imageId = '', loading = false, copying = false, paint = 0, foreground = null, observer = null;
    let selected = '', gesture = null, draftScene = null, pendingCrop = null, textDraft = null, composing = false, textBlurPending = false, space = false;
    let menu = null, copyJob = null, metrics = null;
    const mosaicCache = new Map();
    const visible = () => active && !destroyed && host.isActive();
    const uid = () => crypto.randomUUID();
    root.dataset.i18nManaged = 'true';
    root.innerHTML = '<div class="images-workbench">'
      + '<header class="images-head"><h1 data-images-label="title"></h1><div class="images-head-actions"><button type="button" data-images-action="choose">' + icon('choose') + '<span data-images-label="choose"></span></button>'
      + '<button type="button" class="images-copy" data-images-action="copy">' + icon('copy') + '<span data-images-label="copy"></span></button></div></header>'
      + '<div class="images-toolbar" role="toolbar"><div class="images-tools">' + tools.map(key => '<button type="button" data-images-tool="' + key + '">' + icon(key) + '</button>').join('') + '</div>'
      + '<div class="images-options"><div class="images-colors">' + colors.map(([key, value]) => '<button type="button" data-images-color="' + value + '" data-images-color-name="' + key + '" style="--swatch:' + value + '"><span></span></button>').join('') + '</div>'
      + '<label class="images-option"><span data-images-label="width"></span><select data-images-setting="width"></select></label>'
      + '<label class="images-option" hidden><span data-images-label="size"></span><select data-images-setting="size"></select></label>'
      + '<label class="images-option" hidden><span data-images-label="block"></span><select data-images-setting="block"></select></label></div>'
      + '<div class="images-history"><button type="button" data-images-action="undo">' + icon('undo') + '</button><button type="button" data-images-action="redo">' + icon('redo') + '</button></div>'
      + '<div class="images-crop-actions" hidden><button type="button" data-images-action="apply">' + icon('apply') + '<span data-images-label="apply"></span></button><button type="button" data-images-action="cancel" data-images-label="cancel"></button></div></div>'
      + '<div class="images-viewport" tabindex="0"><canvas class="images-canvas"></canvas><div class="images-image-frame" hidden aria-hidden="true"></div><svg class="images-overlay" aria-hidden="true"></svg>'
      + '<div class="images-empty">' + icon('choose') + '<strong data-images-label="empty"></strong><span data-images-label="temporary"></span><button type="button" data-images-action="choose" data-images-label="choose"></button></div>'
      + '<div class="images-loading" role="status" hidden></div><button type="button" class="images-delete" data-images-action="remove">' + icon('remove') + '</button>'
      + '<textarea class="images-text-editor" hidden spellcheck="false"></textarea></div>'
      + '<footer class="images-footer"><span class="images-hint" data-images-label="hint"></span><div class="images-view-actions">'
      + ['fit', 'actual', 'out'].map(key => '<button type="button" data-images-action="' + key + '">' + icon(key) + '</button>').join('')
      + '<output class="images-zoom">100%</output><button type="button" data-images-action="in">' + icon('in') + '</button><span class="images-dimensions"></span></div></footer>'
      + '<input type="file" class="images-file-input" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif" hidden></div>';
    const $ = selector => root.querySelector(selector), viewport = $('.images-viewport'), canvas = $('.images-canvas'), overlay = $('.images-overlay');
    const editor = $('.images-text-editor'), file = $('.images-file-input'), context = canvas.getContext('2d');
    const imageFrame = $('.images-image-frame');
    const controls = [...root.querySelectorAll('button')];
    const choicePortal = document.createElement('div'); choicePortal.className = 'images-choice-popovers'; choicePortal.dataset.i18nManaged = 'true'; document.body.append(choicePortal);
    const choices = window.RelatumReviewControls.createManager($('.images-toolbar'), choicePortal);
    function updateLanguage() {
      choices.close();
      root.querySelectorAll('[data-images-label]').forEach(node => { node.textContent = tr(node.dataset.imagesLabel); });
      controls.forEach(button => {
        const key = button.dataset.imagesTool || button.dataset.imagesColorName || button.dataset.imagesAction;
        button.title = tr(key); button.setAttribute('aria-label', tr(key));
      });
      $('.images-toolbar').setAttribute('aria-label', tr('title'));
      $('.images-colors').setAttribute('aria-label', tr('color'));
      viewport.setAttribute('aria-label', tr('title')); editor.setAttribute('aria-label', tr('text')); editor.placeholder = tr('textHint');
      const definitions = { width: [[2, 'thin'], [4, 'medium'], [8, 'thick']], size: [[18, 'small'], [28, 'medium'], [42, 'large']], block: [[8, 'small'], [16, 'medium'], [28, 'large']] };
      for (const [key, values] of Object.entries(definitions)) {
        const select = $('[data-images-setting="' + key + '"]');
        choices.setOptions(select, values.map(([value, label]) => ({ value, label: tr(label) })), session.settings[key]);
      }
      closeMenu(); sync(); queuePaint();
    }
    function sync() {
      const scene = session.scene, hasImage = !!scene, chosen = scene?.objects.find(object => object.id === selected);
      $('.images-empty').hidden = hasImage;
      $('.images-delete').hidden = !hasImage;
      $('.images-loading').hidden = !loading; $('.images-loading').textContent = tr('loading');
      controls.forEach(button => {
        const action = button.dataset.imagesAction;
        button.disabled = action === 'undo' ? !session.past.length : action === 'redo' ? !session.future.length
          : action === 'choose' ? false : !hasImage || action === 'copy' && (copying || !resource);
        if (button.dataset.imagesTool) button.setAttribute('aria-pressed', String(button.dataset.imagesTool === session.settings.tool));
        if (button.dataset.imagesColor) button.setAttribute('aria-pressed', String(button.dataset.imagesColor === (chosen?.color || session.settings.color)));
      });
      const type = chosen?.type || session.settings.tool;
      for (const key of ['width', 'size', 'block']) {
        const select = $('[data-images-setting="' + key + '"]'); select.disabled = !hasImage;
        select.closest('label').hidden = key === 'size' ? type !== 'text' : key === 'block' ? type !== 'mosaic' : ['text', 'mosaic', 'crop'].includes(type);
        const value = chosen?.[key] === undefined ? session.settings[key] : chosen[key] * (key === 'block' ? 1 : metrics?.scale || 1);
        const nearest = [...select.options].reduce((best, option) => Math.abs(Number(option.value) - value) < Math.abs(Number(best.value) - value) ? option : best, select.options[0]);
        if (nearest) select.value = nearest.value;
      }
      $('.images-crop-actions').hidden = !pendingCrop;
      choices.sync();
      $('.images-dimensions').textContent = scene ? scene.crop.w + ' × ' + scene.crop.h : '';
      viewport.dataset.tool = space ? 'pan' : session.settings.tool;
      $('[data-images-action="copy"]').setAttribute('aria-busy', String(copying));
    }
    function closeResource() { resource?.close(); resource = null; imageId = ''; imageFrame.hidden = true; C.clearCache(mosaicCache); }
    async function decode(blob) {
      if (typeof createImageBitmap === 'function') {
        const image = await createImageBitmap(blob); return { image, close: () => image.close() };
      }
      const image = new Image(), url = URL.createObjectURL(blob);
      try { image.src = url; await image.decode(); return { image, close: () => image.removeAttribute('src') }; }
      finally { URL.revokeObjectURL(url); }
    }
    async function ensureImage() {
      const source = session.scene?.source;
      if (!visible() || !source || imageId === source.id && resource) { queuePaint(); return; }
      const id = ++decodeId, life = epoch;
      try {
        const result = await decode(source.blob);
        if (!visible() || life !== epoch || id !== decodeId || session.scene?.source !== source) { result.close(); return; }
        closeResource(); resource = result; imageId = source.id; sync(); queuePaint();
      } catch (error) { if (visible() && id === decodeId) host.toast(tr('invalid')); }
    }
    function cancelCopy() { copyJob?.abort(); copyJob = null; copying = false; }
    function changed(next, prepared = null) {
      const source = session.scene?.source;
      choices.close(); cancelGesture();
      cancelCopy(); revision++; C.commit(session, next); draftScene = null; pendingCrop = null;
      if (!next || source !== next.source) {
        importId++; decodeId++; loading = false; closeResource(); session.view = null; session.textDraft = null;
        if (prepared) { resource = prepared; imageId = next.source.id; }
      }
      if (!next?.objects.some(object => object.id === selected)) selected = '';
      sync(); if (next && !resource) ensureImage(); else queuePaint();
    }
    async function importFiles(list) {
      const files = [...list]; if (!files.length || !visible() || composing) return;
      finishText(true); cancelGesture(); closeMenu(); choices.close(); cancelCopy();
      const id = ++importId, life = epoch, version = revision, blob = files[0];
      const current = () => visible() && epoch === life && importId === id && revision === version;
      if (files.length > 1) host.toast(tr('first'));
      loading = true; sync(); let prepared = null, committed = false;
      try {
        if (!blob.size || blob.size > C.LIMITS.bytes) throw new RangeError();
        const header = C.imageHeader(await blob.slice(0, 1024 * 1024).arrayBuffer()); if (!current()) return;
        if (!header) throw new Error();
        if (!C.dimensionsValid(header.width, header.height)) throw new RangeError();
        const sourceBlob = blob.slice(0, blob.size, header.media);
        prepared = await decode(sourceBlob); if (!current()) return;
        const image = prepared.image, width = image.width || image.naturalWidth, height = image.height || image.naturalHeight;
        if (!C.dimensionsValid(width, height)) throw new RangeError();
        const source = { id: uid(), blob: sourceBlob, width, height };
        changed(C.initial(source), prepared); prepared = null; committed = true; selected = ''; session.settings.tool = 'rect'; sync();
      } catch (error) { if (current()) host.toast(tr(error instanceof RangeError ? 'limit' : 'invalid')); }
      finally { prepared?.close(); if (committed || id === importId) { loading = false; sync(); } }
    }
    function queuePaint() { if (visible() && !paint) paint = scope.requestAnimationFrame(draw); }
    function measure() {
      const box = viewport.getBoundingClientRect(), rect = { left: box.left + viewport.clientLeft, top: box.top + viewport.clientTop }, scene = draftScene || session.scene;
      const w = viewport.clientWidth, h = viewport.clientHeight, crop = scene?.crop;
      session.view ||= { mode: 'fit', zoom: 1, x: 0, y: 0 };
      const view = session.view, fit = crop ? Math.max(.001, Math.min(1, (w - 64) / crop.w, (h - 64) / crop.h)) : 1;
      const scale = view.mode === 'fit' ? fit : view.zoom;
      metrics = { rect, w, h, scale, x: crop ? (w - crop.w * scale) / 2 + view.x - crop.x * scale : 0,
        y: crop ? (h - crop.h * scale) / 2 + view.y - crop.y * scale : 0 };
      return metrics;
    }
    function screen(point) { return { x: point.x * metrics.scale + metrics.x, y: point.y * metrics.scale + metrics.y }; }
    function point(event, limit = true) {
      const p = { x: (event.clientX - metrics.rect.left - metrics.x) / metrics.scale, y: (event.clientY - metrics.rect.top - metrics.y) / metrics.scale };
      const b = session.scene.crop;
      return limit ? { x: C.clamp(p.x, b.x, b.x + b.w), y: C.clamp(p.y, b.y, b.y + b.h) } : p;
    }
    function svg(tag, attributes) {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); overlay.append(node); return node;
    }
    function handles(object) {
      if (object.type === 'line' || object.type === 'arrow') return [{ key: 'start', x: object.x, y: object.y }, { key: 'end', x: object.x2, y: object.y2 }];
      const b = C.bounds(object);
      return [{ key: 'nw', x: b.x, y: b.y }, { key: 'ne', x: b.x + b.w, y: b.y }, { key: 'se', x: b.x + b.w, y: b.y + b.h }, { key: 'sw', x: b.x, y: b.y + b.h }];
    }
    function draw() {
      paint = 0; if (!visible()) return;
      const m = measure(), dpr = window.devicePixelRatio || 1, scene = draftScene || session.scene;
      const width = Math.round(m.w * dpr), height = Math.round(m.h * dpr);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, m.w, m.h);
      overlay.setAttribute('viewBox', '0 0 ' + m.w + ' ' + m.h); overlay.replaceChildren();
      imageFrame.hidden = !scene || !resource || imageId !== scene.source.id;
      if (!scene || !resource || imageId !== scene.source.id) return;
      const corner = screen(scene.crop);
      for (const [key, value] of Object.entries({ left: corner.x + 'px', top: corner.y + 'px', width: scene.crop.w * m.scale + 'px', height: scene.crop.h * m.scale + 'px' })) {
        if (imageFrame.style[key] !== value) imageFrame.style[key] = value;
      }
      context.fillStyle = getComputedStyle(root).getPropertyValue('--images-paper') || '#fff';
      context.fillRect(corner.x, corner.y, scene.crop.w * m.scale, scene.crop.h * m.scale);
      context.save(); context.translate(m.x, m.y); context.scale(m.scale, m.scale);
      C.render(context, scene, resource.image, { cache: mosaicCache, skipText: textDraft?.object.id }); context.restore();
      const selectedObject = pendingCrop ? { type: 'rect', ...pendingCrop } : scene.objects.find(object => object.id === selected);
      if (selectedObject && !textDraft) {
        const b = C.bounds(selectedObject), p = screen(b);
        if (pendingCrop) {
          const right = p.x + b.w * m.scale, bottom = p.y + b.h * m.scale;
          svg('path', { d: 'M0 0H' + m.w + 'V' + m.h + 'H0Z M' + p.x + ' ' + p.y + 'V' + bottom + 'H' + right + 'V' + p.y + 'Z', 'fill-rule': 'evenodd', class: 'images-crop-shade' });
        }
        svg('rect', { x: p.x, y: p.y, width: Math.max(1, b.w * m.scale), height: Math.max(1, b.h * m.scale), class: 'images-selection' });
        handles(selectedObject).forEach(handle => { const h = screen(handle); svg('rect', { x: h.x - 4, y: h.y - 4, width: 8, height: 8, rx: 2, class: 'images-handle' }); });
      }
      if (textDraft) {
        const object = textDraft.object, p = screen(object);
        Object.assign(editor.style, { left: p.x + 'px', top: p.y + 'px', width: object.w * m.scale + 'px', height: Math.max(38, object.h * m.scale) + 'px', fontSize: object.size * m.scale + 'px', color: object.color });
      }
      $('.images-zoom').value = Math.round(m.scale * 100) + '%';
    }
    function cancelGesture() {
      if (gesture) {
        const id = gesture.id;
        if (gesture.kind === 'draw' || gesture.kind === 'text') selected = gesture.previousSelected;
        if (gesture.kind === 'pan') session.view = gesture.view;
        if (gesture.kind.startsWith('crop')) pendingCrop = gesture.cropBefore;
        gesture = null;
        try { if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id); } catch (_) {}
      }
      draftScene = null; queuePaint();
    }
    function hitHandle(object, p) { return handles(object).find(handle => Math.hypot(handle.x - p.x, handle.y - p.y) <= 9 / metrics.scale); }
    function beginPointer(event) {
      if (!visible() || !session.scene || !resource || event.target.closest('button,textarea') || ![0, 1].includes(event.button) || composing) return;
      if (!finishText(true)) return;
      event.preventDefault(); closeMenu(); choices.close(); viewport.focus({ preventScroll: true }); measure();
      const p = point(event, false), crop = session.scene.crop;
      const base = { id: event.pointerId, start: p, client: { x: event.clientX, y: event.clientY }, distance: 0, previousSelected: selected };
      if (space || event.button === 1) gesture = { ...base, kind: 'pan', view: { ...session.view } };
      else {
        if (p.x < crop.x || p.y < crop.y || p.x > crop.x + crop.w || p.y > crop.y + crop.h) { selected = ''; queuePaint(); return; }
        const tool = session.settings.tool;
        const selectedObject = session.scene.objects.find(object => object.id === selected);
        const selectedHandle = tool !== 'crop' && selectedObject && hitHandle(selectedObject, p);
        if (selectedHandle) {
          gesture = { ...base, kind: 'resize', object: C.cloneObject(selectedObject), handle: selectedHandle.key };
        } else if (tool === 'text') {
          gesture = { ...base, kind: 'text' };
        } else if (tool === 'select') {
          let object = session.scene.objects.find(object => object.id === selected), handle = object && hitHandle(object, p);
          if (!handle) object = C.pick(session.scene.objects, p, 6 / metrics.scale);
          selected = object?.id || ''; sync(); queuePaint(); if (!object) return;
          gesture = { ...base, kind: handle ? 'resize' : 'move', object: C.cloneObject(object), handle: handle?.key };
        } else if (tool === 'crop') {
          const object = pendingCrop && { type: 'rect', ...pendingCrop }, handle = object && hitHandle(object, p);
          const inside = object && C.hit(object, p, 0);
          gesture = { ...base, kind: handle ? 'crop-resize' : inside ? 'crop-move' : 'crop', object, handle: handle?.key, cropBefore: pendingCrop && { ...pendingCrop } };
          if (!inside && !handle) pendingCrop = { x: p.x, y: p.y, w: 0, h: 0 };
          selected = '';
        } else {
          const settings = session.settings, object = { id: uid(), type: tool, color: settings.color, width: settings.width / metrics.scale, x: p.x, y: p.y, w: 0, h: 0, block: settings.block };
          if (tool === 'pen') { object.points = [p]; delete object.x; delete object.y; }
          if (tool === 'arrow' || tool === 'line') { object.x2 = p.x; object.y2 = p.y; }
          gesture = { ...base, kind: 'draw', object };
        }
        draftScene = C.snapshot(session.scene);
      }
      try { viewport.setPointerCapture(event.pointerId); } catch (_) {}
      queuePaint();
    }
    function resizeBox(object, handle, p) {
      const b = C.bounds(object), min = 2 / metrics.scale;
      let left = b.x, right = b.x + b.w, top = b.y, bottom = b.y + b.h;
      if (handle.includes('w')) left = Math.min(p.x, right - min); else right = Math.max(p.x, left + min);
      if (handle.includes('n')) top = Math.min(p.y, bottom - min); else bottom = Math.max(p.y, top + min);
      return { x: left, y: top, w: right - left, h: bottom - top };
    }
    function movePointer(event) {
      const g = gesture; if (!g || g.id !== event.pointerId) return;
      event.preventDefault();
      const coalesced = event.getCoalescedEvents?.() || [], samples = [...coalesced, event];
      for (const sample of samples) g.distance = Math.max(g.distance, Math.hypot(sample.clientX - g.client.x, sample.clientY - g.client.y));
      if (g.kind === 'pan') {
        session.view = { ...g.view, x: g.view.x + event.clientX - g.client.x, y: g.view.y + event.clientY - g.client.y };
      } else {
        const p = point(event), dx = p.x - g.start.x, dy = p.y - g.start.y;
        if (g.kind === 'text') return;
        if (g.kind === 'crop') pendingCrop = C.rectangle(g.start, p);
        else if (g.kind === 'crop-move') {
          const b = session.scene.crop;
          pendingCrop = { ...g.object, x: C.clamp(g.object.x + dx, b.x, b.x + b.w - g.object.w), y: C.clamp(g.object.y + dy, b.y, b.y + b.h - g.object.h) };
        } else if (g.kind === 'crop-resize') pendingCrop = C.intersect(resizeBox(g.object, g.handle, p), session.scene.crop);
        else if (g.kind === 'draw') {
          const object = g.object;
          if (object.type === 'pen') {
            for (const sample of samples) object.points.push(point(sample));
          } else if (object.type === 'line' || object.type === 'arrow') { object.x2 = p.x; object.y2 = p.y; }
          else Object.assign(object, C.rectangle(g.start, p));
          if (g.distance > TAP_DISTANCE && !draftScene.objects.some(item => item.id === object.id)) { draftScene.objects.push(object); selected = object.id; }
        } else {
          if (g.kind === 'move' && g.distance <= TAP_DISTANCE) return;
          let next;
          if (g.kind === 'move') next = C.moved(g.object, dx, dy);
          else if (g.handle === 'start') next = { ...g.object, x: p.x, y: p.y };
          else if (g.handle === 'end') next = { ...g.object, x2: p.x, y2: p.y };
          else next = C.resized(g.object, resizeBox(g.object, g.handle, p));
          draftScene.objects = draftScene.objects.map(object => object.id === g.object.id ? next : object);
        }
      }
      queuePaint();
    }
    function endPointer(event) {
      if (!gesture || gesture.id !== event.pointerId) return;
      movePointer(event); const g = gesture, next = draftScene; gesture = null; draftScene = null;
      try { if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId); } catch (_) {}
      const tap = g.distance <= TAP_DISTANCE, cropGesture = g.kind.startsWith('crop');
      // Resolve taps against committed objects, never the tentative new stroke.
      if (tap && (['draw', 'text', 'move'].includes(g.kind) || g.kind === 'crop' && !g.cropBefore)) {
        const hit = C.pick(session.scene.objects, point(event), 6 / metrics.scale);
        if (hit) { selected = hit.id; if (cropGesture) pendingCrop = g.cropBefore; sync(); queuePaint(); return; }
      }
      if (g.kind === 'text') { if (tap) beginText(null, g.start); else { selected = g.previousSelected; sync(); queuePaint(); } return; }
      if (g.kind.startsWith('crop')) {
        if (tap && g.cropBefore) pendingCrop = g.cropBefore;
        if (!pendingCrop || pendingCrop.w * metrics.scale < 3 || pendingCrop.h * metrics.scale < 3) pendingCrop = null;
        sync(); queuePaint(); return;
      }
      if (g.kind === 'pan') { queuePaint(); return; }
      if (g.kind === 'draw' && !next.objects.some(item => item.id === g.object.id)) {
        if (g.object.type !== 'pen') { selected = ''; sync(); queuePaint(); return; }
        next.objects.push(g.object); selected = g.object.id;
      }
      const object = next.objects.find(object => object.id === selected), b = C.bounds(object);
      if (g.kind === 'draw' && object.type !== 'pen' && (Math.hypot(b.w, b.h) * metrics.scale < 3
          || !['line', 'arrow'].includes(object.type) && Math.min(b.w, b.h) * metrics.scale < 2)) { selected = ''; queuePaint(); return; }
      if (JSON.stringify(next.objects) !== JSON.stringify(session.scene.objects)) changed(next); else queuePaint();
    }
    function beginText(existing, p) {
      if (!visible() || composing) return;
      measure(); const scale = metrics.scale, crop = session.scene.crop;
      const object = existing ? C.cloneObject(existing) : { id: uid(), type: 'text', x: p.x, y: p.y,
        w: Math.max(30 / scale, Math.min(280 / scale, crop.x + crop.w - p.x)), h: session.settings.size * 1.5 / scale,
        text: '', size: session.settings.size / scale, color: session.settings.color, width: 0 };
      textDraft = { object, originalId: existing?.id || '' }; selected = object.id;
      editor.value = object.text; editor.hidden = false; sync(); queuePaint(); editor.focus({ preventScroll: true }); editor.setSelectionRange(editor.value.length, editor.value.length);
    }
    function updateText() {
      const draft = textDraft || session.textDraft;
      if (!draft) return;
      draft.object.text = editor.value;
      draft.object.h = Math.max(draft.object.size * 1.5, C.textLines(context, draft.object).length * draft.object.size * 1.35 + 2);
      queuePaint();
    }
    function finishText(commit) {
      if (!textDraft) return true;
      if (composing) return false;
      updateText(); const draft = textDraft; textDraft = null; editor.hidden = true; textBlurPending = false; session.textDraft = null;
      if (commit && session.scene) {
        const next = C.snapshot(session.scene), index = next.objects.findIndex(object => object.id === draft.originalId);
        if (draft.object.text.trim()) {
          if (index >= 0) next.objects[index] = draft.object; else next.objects.push(draft.object);
        } else if (index >= 0) next.objects.splice(index, 1);
        if (JSON.stringify(next.objects) !== JSON.stringify(session.scene.objects)) changed(next);
      }
      sync(); queuePaint(); return true;
    }
    async function copyImage() {
      if (!visible() || !session.scene || !resource || copying || !finishText(true)) return;
      closeMenu(); choices.close(); cancelGesture();
      if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') { host.toast(tr('failed')); return; }
      const job = copyJob = new AbortController(), life = epoch, version = revision, scene = C.snapshot(session.scene), image = resource.image;
      const check = () => { if (job.signal.aborted || !visible() || epoch !== life || revision !== version) throw new DOMException('Cancelled', 'AbortError'); };
      const png = (async () => {
        let output;
        try {
          if (document.fonts) await document.fonts.ready; check();
          output = document.createElement('canvas'); output.width = scene.crop.w; output.height = scene.crop.h;
          const drawing = output.getContext('2d'); drawing.translate(-scene.crop.x, -scene.crop.y); C.render(drawing, scene, image);
          const blob = await new Promise((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error('PNG unavailable')), 'image/png'));
          check(); return blob;
        } finally { if (output) output.width = output.height = 0; }
      })();
      png.catch(() => {}); copying = true; sync();
      try {
        // Keep write inside the original click/keydown activation, before encoding.
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]); check(); host.toast(tr('copied'));
      } catch (error) { if (!job.signal.aborted && visible() && version === revision) host.toast(tr('failed')); }
      finally { job.abort(); if (copyJob === job) { copyJob = null; copying = false; sync(); } }
    }
    function removeMark() {
      const id = selected;
      cancelGesture(); choices.close(); closeMenu();
      if (!session.scene?.objects.some(object => object.id === id)) { selected = ''; sync(); queuePaint(); return; }
      const next = C.snapshot(session.scene); next.objects = next.objects.filter(object => object.id !== id); changed(next);
    }
    function zoom(action) {
      if (!session.scene || !finishText(true)) return;
      cancelGesture(); measure();
      if (action === 'fit') session.view = { mode: 'fit', zoom: 1, x: 0, y: 0 };
      else session.view = { mode: 'manual', zoom: action === 'actual' ? 1 : C.clamp(metrics.scale * (action === 'in' ? 1.25 : .8), .02, 8), x: 0, y: 0 };
      queuePaint();
    }
    function action(name) {
      if (!visible()) return;
      if (name === 'copy') { copyImage(); return; }
      if (name === 'choose') { file.click(); return; }
      if (!finishText(true)) return;
      closeMenu(); choices.close(); cancelGesture();
      if (name === 'undo' || name === 'redo') {
        const source = session.scene?.source; importId++; loading = false; cancelCopy();
        if (C.travel(session, name === 'redo')) {
          revision++; selected = ''; pendingCrop = null;
          if (source !== session.scene?.source) { decodeId++; closeResource(); session.view = null; ensureImage(); }
          sync(); queuePaint();
        }
      } else if (name === 'remove' && session.scene) { changed(null); selected = ''; }
      else if (name === 'reset' && session.scene) { changed(C.initial(session.scene.source)); session.view = null; }
      else if (name === 'removeMark') removeMark();
      else if (name === 'apply' && pendingCrop) {
        const next = C.snapshot(session.scene); next.crop = C.cropRect(pendingCrop, next.source); changed(next); session.view = null;
      } else if (name === 'cancel') { pendingCrop = null; sync(); queuePaint(); }
      else if (['fit', 'actual', 'in', 'out'].includes(name)) zoom(name);
    }
    function closeMenu() { menu?.remove(); menu = null; }
    function openMenu(event) {
      if (!visible() || !session.scene || composing || inputTarget(event.target)) return;
      event.preventDefault(); if (!finishText(true)) return; cancelGesture(); closeMenu(); choices.close();
      menu = document.createElement('div'); menu.className = 'images-context-menu'; menu.setAttribute('role', 'menu');
      const commands = ['copy', ...(selected ? ['removeMark'] : []), 'reset', 'remove'];
      for (const name of commands) {
        const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = tr(name); button.disabled = name === 'copy' && !resource;
        button.addEventListener('click', () => action(name)); menu.append(button);
      }
      root.append(menu);
      const box = root.getBoundingClientRect();
      menu.style.left = C.clamp(event.clientX - box.left, 8, root.clientWidth - menu.offsetWidth - 8) + 'px';
      menu.style.top = C.clamp(event.clientY - box.top, 8, root.clientHeight - menu.offsetHeight - 8) + 'px';
      menu.firstElementChild.focus({ preventScroll: true });
    }
    function styleSetting(key, value) {
      if (!finishText(true)) return;
      session.settings[key] = value;
      const object = session.scene?.objects.find(object => object.id === selected);
      if (object && (key === 'color' && object.type !== 'mosaic' || key === 'size' && object.type === 'text' || key === 'block' && object.type === 'mosaic' || key === 'width' && !['text', 'mosaic'].includes(object.type))) {
        const next = C.snapshot(session.scene), target = next.objects.find(object => object.id === selected);
        target[key] = ['size', 'width'].includes(key) ? value / (metrics?.scale || 1) : value;
        if (key === 'size') target.h = C.textLines(context, target).length * target.size * 1.35 + 2;
        changed(next);
      }
      sync(); queuePaint();
    }
    scope.listen(root, 'click', event => {
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      if (button.dataset.imagesAction) action(button.dataset.imagesAction);
      else if (button.dataset.imagesTool && finishText(true)) {
        cancelGesture(); closeMenu(); choices.close(); session.settings.tool = button.dataset.imagesTool; selected = ''; pendingCrop = null; sync(); queuePaint();
      } else if (button.dataset.imagesColor) styleSetting('color', button.dataset.imagesColor);
    });
    scope.listen(root, 'change', event => { if (event.target.dataset.imagesSetting) styleSetting(event.target.dataset.imagesSetting, Number(event.target.value)); });
    scope.listen(root, 'pointerdown', event => { if (event.target.closest('.review-choice-trigger')) { finishText(true); cancelGesture(); closeMenu(); } }, true);
    scope.listen(file, 'change', () => { importFiles(file.files); file.value = ''; });
    scope.listen(viewport, 'pointerdown', beginPointer); scope.listen(viewport, 'pointermove', movePointer); scope.listen(viewport, 'pointerup', endPointer);
    scope.listen(viewport, 'pointercancel', cancelGesture); scope.listen(viewport, 'lostpointercapture', () => { if (gesture) cancelGesture(); });
    scope.listen(viewport, 'contextmenu', openMenu);
    scope.listen(viewport, 'dblclick', event => {
      if (!visible() || !session.scene || composing || inputTarget(event.target)) return;
      measure(); const object = C.pick(session.scene.objects, point(event), 5 / metrics.scale);
      if (object?.type === 'text') { event.preventDefault(); beginText(object); }
    });
    scope.listen(editor, 'input', updateText);
    scope.listen(editor, 'compositionstart', () => { composing = true; });
    scope.listen(editor, 'compositionend', () => { composing = false; updateText(); if (textBlurPending) queueMicrotask(() => { if (!composing && textBlurPending) finishText(true); }); });
    scope.listen(editor, 'blur', () => { if (composing) textBlurPending = true; else finishText(true); });
    scope.listen(editor, 'keydown', event => {
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' || event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); finishText(event.key !== 'Escape'); viewport.focus({ preventScroll: true }); }
    });
    scope.listen(root, 'dragover', event => { if (visible() && [...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; viewport.classList.add('is-drag-over'); } });
    scope.listen(root, 'dragleave', event => { if (!root.contains(event.relatedTarget)) viewport.classList.remove('is-drag-over'); });
    scope.listen(root, 'drop', event => {
      if (!visible() || ![...event.dataTransfer.types].includes('Files')) return;
      event.preventDefault(); event.stopPropagation(); viewport.classList.remove('is-drag-over'); importFiles(event.dataTransfer.files);
    });
    function keydown(event) {
      if (!visible() || composing || event.isComposing || event.keyCode === 229
          || document.querySelector('dialog[open]') || event.target.closest('.daily-navigation')) return;
      if (choices.handleKey(event)) { event.stopImmediatePropagation(); return; }
      if (inputTarget(event.target) || event.target.closest('.review-choice, .images-choice-popovers')) return;
      if (menu) {
        const buttons = [...menu.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; buttons[next]?.focus(); return;
        }
      }
      const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (mod && ['c', 'z', 'y'].includes(key) && !event.altKey) {
        event.preventDefault(); event.stopPropagation(); if (!event.repeat) action(key === 'c' ? 'copy' : key === 'y' || event.shiftKey ? 'redo' : 'undo');
      } else if (!mod && !event.altKey && event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeMenu(); cancelGesture(); pendingCrop = null; selected = ''; sync(); queuePaint();
      } else if (!mod && !event.altKey && ['Delete', 'Backspace'].includes(event.key) && !menu) { event.preventDefault(); event.stopPropagation(); removeMark(); }
      else if (!mod && !event.altKey && event.code === 'Space') { event.preventDefault(); space = true; sync(); }
    }
    function activate() {
      if (destroyed || active) return;
      active = true; epoch++; composing = false; textBlurPending = false; foreground = new AbortController();
      const listen = (target, type, callback, options = {}) => target.addEventListener(type, callback, { ...options, signal: foreground.signal });
      listen(document, 'paste', event => {
        if (!visible() || composing || inputTarget(event.target) || document.querySelector('dialog[open]')) return;
        const files = [...event.clipboardData?.items || []].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
        if (files.length) { event.preventDefault(); event.stopPropagation(); importFiles(files); }
      }, { capture: true });
      listen(document, 'keydown', keydown, { capture: true });
      listen(document, 'keyup', event => { if (event.code === 'Space' && space) { space = false; sync(); } });
      listen(document, 'pointerdown', event => { if (menu && !menu.contains(event.target)) closeMenu(); }, { capture: true });
      listen(window, 'blur', () => { cancelGesture(); closeMenu(); choices.close(); space = false; sync(); });
      listen(document, 'relatum:languagechange', updateLanguage);
      observer = new ResizeObserver(() => { cancelGesture(); closeMenu(); choices.close(); queuePaint(); }); observer.observe(viewport);
      if (session.textDraft) {
        textDraft = session.textDraft; editor.value = textDraft.object.text; editor.hidden = false; selected = textDraft.object.id;
      }
      updateLanguage(); ensureImage(); queuePaint();
    }
    function deactivate() {
      if (!active) return;
      if (textDraft) {
        if (!composing) finishText(true);
        else { updateText(); session.textDraft = textDraft; textDraft = null; editor.hidden = true; }
      }
      active = false; epoch++; importId++; decodeId++; loading = false; cancelCopy(); cancelGesture(); pendingCrop = null; space = false;
      scope.cancelAnimationFrame(paint); paint = 0; closeMenu(); choices.close(); foreground?.abort(); foreground = null;
      observer?.disconnect(); observer = null; closeResource(); canvas.width = canvas.height = 0; overlay.replaceChildren(); viewport.classList.remove('is-drag-over');
    }
    updateLanguage();
    return {
      activate, deactivate,
      async beforeLeave() { if (composing) { editor.blur(); await new Promise(resolve => setTimeout(resolve, 0)); } return finishText(true); },
      destroy() { deactivate(); destroyed = true; scope.destroy(); choices.dispose(); choicePortal.remove(); closeMenu(); closeResource(); },
    };
  };
})();
