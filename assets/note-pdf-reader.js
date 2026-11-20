import { loadPdfLibrary, openPdfDocument } from './pdf-runtime.js';
import { startEmbedResize } from './note-embed-resize.js';
import { createAnnotationStore } from './note-pdf-annotation-state.js';
import { createAnnotationTools, mountAnnotationPage } from './note-pdf-annotation-layer.js';
import { wrapPdfScroll } from './note-pdf-scrollbar.js';

const PAGE_GAP = 12, THUMB_HEIGHT = 136;
const TEXT_CACHE_BUDGET = 4 * 1024 * 1024;
const TEXT_CACHE_PAGES = 32;
const element = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value) node.textContent = value;
  return node;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const queryFor = ({ path, id }) => new URLSearchParams({ note: path, id });
const cancel = task => task?.cancel();

function pageText(items) {
  let text = '';
  const offsets = [];
  items.forEach((item, index) => {
    if (typeof item.str !== 'string') return;
    let offset = 0;
    for (const char of item.str) {
      const normalized = char.normalize('NFKC').toLowerCase();
      for (let i = 0; i < normalized.length; i++) {
        const value = /\s/.test(normalized[i]) ? ' ' : normalized[i];
        if (value === ' ' && text.endsWith(' ')) continue;
        text += value;
        offsets.push({ index, from: offset, to: offset + char.length });
      }
      offset += char.length;
    }
    if (item.hasEOL && !text.endsWith(' ')) {
      text += ' ';
      offsets.push({ index, from: offset, to: offset });
    }
  });
  return { text, offsets };
}

function createReader(stage, { copy, button, initial, current, onPage, onError, onName, store, annotationTools, scroll, onAnnotation }) {
  const lifetime = new AbortController(), { signal } = lifetime;
  const stack = element('div', 'note-pdf-pages');
  stage.append(stack);
  scroll.content(stack);
  const metrics = new Map(), pages = new Map(), thumbnails = new Map();
  const textCache = new Map(), textRequests = new Map();
  let textBytes = 0;
  let pdf, library, loadingTask, frame = 0, dirty = true, offsets = [], widths = [], heights = [];
  let first = { width: 595, height: 842 }, scale = initial?.scale ?? 'auto', width = 0, height = 0;
  let target = initial || { page: 1, fraction: 0 }, lastPage = 0, thumbnailStage;
  let lastPosition = target;
  let searchSequence = 0, match, revealMatch = false, thumbnailEvents, onThumbnailJump;
  let annotations;

  const alive = () => !signal.aborted && current();
  const stageResize = new ResizeObserver(() => {
    if (width !== stage.clientWidth || height !== stage.clientHeight) dirty = true;
    schedule();
  });
  stageResize.observe(stage);
  stage.addEventListener('scroll', schedule, { passive: true, signal });

  function schedule() {
    if (pdf && alive() && !frame) frame = requestAnimationFrame(paint);
  }

  function pageAt(y) {
    let low = 1, high = offsets.length - 2;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (offsets[mid] <= y) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  function position() {
    if (target) return { ...target, scale };
    if (!stage.clientHeight || !stage.clientWidth) return { ...lastPosition, scale };
    const page = offsets.length ? pageAt(stage.scrollTop + PAGE_GAP + 1) : 1;
    const fraction = clamp((stage.scrollTop + PAGE_GAP - (offsets[page] || PAGE_GAP)) / (heights[page] || 1), 0, 1);
    return { page, fraction, scale };
  }

  function layout() {
    width = stage.clientWidth;
    height = stage.clientHeight;
    const available = Math.max(1, width - (width < 500 ? 16 : 48));
    let maxWidth = 0;
    // One-based offsets also represent pages whose dimensions have yet to load.
    offsets = [0, PAGE_GAP]; widths = [0]; heights = [0];
    for (let page = 1; page <= pdf.numPages; page++) {
      const size = metrics.get(page) || first;
      const pageWidth = typeof scale === 'number' ? size.width * scale : scale === 'width' ? available : Math.min(available, 1080);
      const pageHeight = pageWidth * size.height / size.width;
      widths.push(pageWidth);
      heights.push(pageHeight);
      offsets.push(offsets[page] + pageHeight + PAGE_GAP);
      maxWidth = Math.max(maxWidth, pageWidth);
    }
    stack.style.width = Math.max(width, maxWidth + 16) + 'px';
    stack.style.height = Math.max(offsets.at(-1), offsets[pdf.numPages] + height - PAGE_GAP) + 'px';
  }

  function moveTo(anchor) {
    const page = clamp(Math.round(Number(anchor.page) || 1), 1, pdf.numPages);
    stage.scrollTop = offsets[page] - PAGE_GAP + heights[page] * (anchor.fraction || 0);
  }

  function paint() {
    frame = 0;
    if (!alive() || !pdf || !stage.clientWidth || !stage.clientHeight) return;
    const anchor = position();
    if (dirty) {
      const center = (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth;
      layout(); dirty = false; moveTo(anchor);
      stage.scrollLeft = stage.scrollWidth * center - stage.clientWidth / 2;
    }
    else if (target) moveTo(target);
    target = null;
    lastPosition = position();
    const top = stage.scrollTop, height = stage.clientHeight;
    const visible = pageAt(top + PAGE_GAP + 1);
    const from = pageAt(top - height / 2), to = pageAt(top + height * 1.5);
    for (const [number, item] of pages) {
      if (number < from || number > to) {
        resetPage(item); item.host.remove(); pages.delete(number);
      }
    }
    for (let number = from; number <= to; number++) {
      let item = pages.get(number);
      if (!item) {
        const host = element('div', 'note-pdf-page');
        host.dataset.page = number;
        host.setAttribute('aria-label', copy('第 ' + number + ' 页', 'Page ' + number));
        const next = Array.from(stack.children).find(node => Number(node.dataset.page) > number);
        stack.insertBefore(host, next || null);
        item = { host }; pages.set(number, item);
      }
      const pageWidth = widths[number], pageHeight = heights[number];
      item.host.style.top = offsets[number] + 'px';
      item.host.style.width = pageWidth + 'px';
      item.host.style.height = pageHeight + 'px';
      if (item.width !== pageWidth || item.height !== pageHeight) {
        resetPage(item);
        item.width = pageWidth; item.height = pageHeight;
        void drawPage(number, item);
      }
    }
    if (lastPage !== visible) {
      lastPage = visible;
      onPage(visible, pdf.numPages);
      if (thumbnailStage?.clientHeight) {
        const top = (visible - 1) * THUMB_HEIGHT;
        if (top < thumbnailStage.scrollTop || top + THUMB_HEIGHT > thumbnailStage.scrollTop + thumbnailStage.clientHeight) {
          thumbnailStage.scrollTop = top - (thumbnailStage.clientHeight - THUMB_HEIGHT) / 2;
        }
      }
    }
    paintThumbnails();
  }

  function resetPage(item) {
    item.generation = (item.generation || 0) + 1;
    item.annotation?.(); item.annotation = null;
    cancel(item.render); cancel(item.textRender);
    item.page?.cleanup();
    item.page = null;
    item.render = item.textRender = item.textDivs = item.marker = null;
    if (item.canvas) item.canvas.width = item.canvas.height = 0;
    item.canvas = null;
    item.host.replaceChildren();
  }

  async function pageContent(number, page) {
    const cached = textCache.get(number);
    if (cached) {
      textCache.delete(number);
      textCache.set(number, cached);
      return cached.content;
    }
    if (textRequests.has(number)) return textRequests.get(number);
    const request = page.getTextContent().then(content => {
      if (!alive()) return content;
      const bytes = content.items.reduce((sum, item) => sum + 144 + (item.str?.length || 0) * 2, 0) + 1024;
      if (bytes > TEXT_CACHE_BUDGET) return content;
      while (textCache.size >= TEXT_CACHE_PAGES || textBytes + bytes > TEXT_CACHE_BUDGET) {
        const oldest = textCache.keys().next().value;
        textBytes -= textCache.get(oldest).bytes;
        textCache.delete(oldest);
      }
      textCache.set(number, { content, bytes });
      textBytes += bytes;
      return content;
    }).finally(() => textRequests.delete(number));
    textRequests.set(number, request);
    return request;
  }

  async function drawPage(number, item) {
    const generation = item.generation;
    const valid = () => alive() && pages.get(number) === item && generation === item.generation;
    try {
      const page = await pdf.getPage(number);
      if (!valid()) return;
      let base = metrics.get(number);
      if (!base) {
        base = page.getViewport({ scale: 1 });
        metrics.set(number, base);
        if (base.width !== first.width || base.height !== first.height) {
          dirty = true;
          schedule();
          // Wait for corrected geometry instead of rendering into the estimated page box.
          const nextWidth = typeof scale === 'number' ? base.width * scale : item.width;
          if (nextWidth !== item.width || nextWidth * base.height / base.width !== item.height) return;
        }
      }
      item.page = page;
      const pageScale = item.width / base.width;
      const viewport = page.getViewport({ scale: pageScale });
      const ratio = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(8_000_000 / (viewport.width * viewport.height)),
        8192 / viewport.width, 8192 / viewport.height);
      const canvas = item.canvas = element('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      item.host.append(canvas);
      item.annotation = mountAnnotationPage(item.host, number, viewport, annotations, annotationTools, copy, button);
      item.render = page.render({ canvasContext: canvas.getContext('2d'), viewport,
        transform: [ratio, 0, 0, ratio, 0, 0] });
      await item.render.promise;
      if (!valid()) return;
      item.render = null;
      const layer = element('div', 'pdf-text-layer note-pdf-text');
      layer.style.setProperty('--scale-factor', String(pageScale));
      const text = await pageContent(number, page);
      if (!valid()) return;
      item.host.insertBefore(layer, item.host.querySelector('.note-pdf-annotations'));
      const textDivs = [];
      item.textRender = library.renderTextLayer({ textContentSource: text, container: layer, viewport, textDivs });
      await item.textRender.promise;
      if (!valid()) return;
      item.textRender = null;
      item.textDivs = textDivs;
      if (match?.page === number) mark(item);
    } catch (error) {
      if (valid() && error?.name !== 'RenderingCancelledException') {
        item.host.append(element('p', 'note-pdf-message', copy('此页无法显示', 'This page could not be displayed')));
      }
    }
  }

  function mark(item) {
    item.marker?.remove(); item.marker = null;
    if (!match || !item.textDivs) return;
    const start = item.textDivs[match.start.index]?.firstChild, end = item.textDivs[match.end.index]?.firstChild;
    if (start?.nodeType !== Node.TEXT_NODE || end?.nodeType !== Node.TEXT_NODE) return;
    const range = document.createRange();
    range.setStart(start, Math.min(start.length, match.start.from));
    range.setEnd(end, Math.min(end.length, match.end.to));
    const bounds = item.host.getBoundingClientRect();
    const marker = item.marker = element('div', 'note-pdf-match');
    const rectangles = range.getClientRects();
    for (const rect of rectangles) {
      const box = element('span');
      box.style.cssText = 'left:' + (rect.left - bounds.left) + 'px;top:' + (rect.top - bounds.top) + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px';
      marker.append(box);
    }
    item.host.append(marker);
    if (revealMatch && rectangles.length) {
      const rect = rectangles[0], visible = stage.getBoundingClientRect();
      if (rect.top < visible.top || rect.bottom > visible.bottom) {
        target = { page: match.page, fraction: clamp((rect.top - bounds.top - 32) / item.height, 0, 1) };
        schedule();
      }
      revealMatch = false;
    }
  }

  function jump(page) {
    target = { page, fraction: 0 };
    schedule();
  }

  function selectMatch(next) {
    const previous = pages.get(match?.page);
    previous?.marker?.remove();
    if (previous) previous.marker = null;
    match = next; revealMatch = !!next;
    if (!match) return;
    const item = pages.get(match.page);
    if (item?.textDivs) mark(item);
    else jump(match.page);
  }

  async function find(value, onFirstMatch) {
    const request = ++searchSequence, document = pdf;
    const query = value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
    const results = [];
    if (!document || !query) return results;
    for (let number = 1; number <= document.numPages; number++) {
      try {
        const page = await document.getPage(number);
        if (!alive() || request !== searchSequence) return null;
        const content = await pageContent(number, page);
        if (!alive() || request !== searchSequence) return null;
        const { text, offsets } = pageText(content.items);
        for (let index = text.indexOf(query); index !== -1; index = text.indexOf(query, index + query.length)) {
          results.push({ page: number, start: offsets[index], end: offsets[index + query.length - 1] });
        }
        if (results.length && onFirstMatch) {
          onFirstMatch(results.slice());
          onFirstMatch = null;
        }
      } catch {
        if (!alive() || request !== searchSequence) return null;
      }
    }
    return results;
  }

  function clearThumbnails() {
    for (const item of thumbnails.values()) {
      cancel(item.render);
      if (item.canvas) item.canvas.width = item.canvas.height = 0;
    }
    thumbnails.clear();
  }

  function paintThumbnails() {
    if (!thumbnailStage?.clientHeight) return;
    const surface = thumbnailStage.firstElementChild;
    const from = Math.max(1, Math.floor(thumbnailStage.scrollTop / THUMB_HEIGHT));
    const to = Math.min(pdf.numPages, from + Math.ceil(thumbnailStage.clientHeight / THUMB_HEIGHT) + 2);
    for (const [number, item] of thumbnails) {
      if (number >= from && number <= to) continue;
      cancel(item.render);
      if (item.canvas) item.canvas.width = item.canvas.height = 0;
      item.host.remove(); thumbnails.delete(number);
    }
    for (let number = from; number <= to; number++) {
      let item = thumbnails.get(number);
      if (!item) {
        const host = button(String(number), () => { jump(number); onThumbnailJump?.(); }, 'note-pdf-thumb');
        host.title = copy('第 ' + number + ' 页', 'Page ' + number);
        host.style.top = (number - 1) * THUMB_HEIGHT + 'px';
        const next = Array.from(surface.children).find(node => Number(node.dataset.page) > number);
        host.dataset.page = number;
        surface.insertBefore(host, next || null);
        item = { host }; thumbnails.set(number, item);
        void drawThumbnail(number, item);
      }
      item.host.setAttribute('aria-current', lastPage === number ? 'page' : 'false');
    }
  }

  async function drawThumbnail(number, item) {
    try {
      const page = await pdf.getPage(number);
      if (!alive() || thumbnails.get(number) !== item) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(180 / base.width, 156 / base.height) });
      const canvas = item.canvas = element('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      item.host.prepend(canvas);
      item.render = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      await item.render.promise;
      item.render = null;
    } catch { /* The page number stays usable if its thumbnail cannot render. */ }
  }

  function attachThumbnails(host, onJump) {
    thumbnailEvents?.abort();
    clearThumbnails();
    thumbnailStage = host;
    onThumbnailJump = onJump;
    if (!host || !pdf) return;
    const surface = element('div', 'note-pdf-thumb-stack');
    surface.style.height = pdf.numPages * THUMB_HEIGHT + 'px';
    host.replaceChildren(surface);
    host.scrollTop = ((lastPage || position().page) - 1) * THUMB_HEIGHT;
    thumbnailEvents = new AbortController();
    host.addEventListener('scroll', schedule, { passive: true, signal: thumbnailEvents.signal });
    schedule();
  }

  async function start(attachment) {
    try {
      const query = queryFor(attachment);
      const response = await fetch('/api/note-pdf?' + query, { signal });
      const metadata = await response.json();
      if (!alive()) return false;
      if (!response.ok) throw Object.assign(new Error(metadata.error), { code: metadata.code });
      onName(metadata.name);
      query.set('assetRevision', metadata.assetRevision);
      library = await loadPdfLibrary();
      if (!alive()) return false;
      loadingTask = openPdfDocument(library, '/api/note-pdf/file?' + query, { disableStream: true, disableAutoFetch: true });
      const document = await loadingTask.promise;
      if (!alive()) return false;
      const page = await document.getPage(1);
      if (!alive()) return false;
      first = page.getViewport({ scale: 1 });
      metrics.set(1, first);
      pdf = document;
      annotations = store.open(attachment.path, attachment.id, metadata.assetRevision);
      annotationTools?.attach(annotations);
      onAnnotation?.(annotations);
      schedule();
      return true;
    } catch (error) {
      if (alive()) onError(error);
      return false;
    }
  }

  return {
    start, jump, position, find, selectMatch, attachThumbnails,
    outline: () => pdf.getOutline(),
    async goToDestination(destination) {
      const value = typeof destination === 'string' ? await pdf.getDestination(destination) : destination;
      if (!alive() || !Array.isArray(value) || !value.length) return false;
      const number = Number.isInteger(value[0]) ? value[0] : await pdf.getPageIndex(value[0]);
      if (!alive()) return false;
      jump(number + 1);
      return true;
    },
    cancelSearch() { searchSequence++; selectMatch(null); },
    zoom(step) {
      if (!pdf) return;
      target = position();
      const number = target.page || 1;
      const currentScale = typeof scale === 'number' ? scale : (widths[number] || stage.clientWidth) / (metrics.get(number) || first).width;
      scale = step ? clamp(currentScale * step, .25, 4) : 'width';
      dirty = true; schedule();
    },
    dispose() {
      lifetime.abort();
      cancelAnimationFrame(frame); stageResize.disconnect();
      thumbnailEvents?.abort(); clearThumbnails();
      for (const item of pages.values()) resetPage(item);
      pages.clear(); stack.remove();
      textCache.clear(); textRequests.clear(); textBytes = 0;
      scroll.content(null);
      if (loadingTask) void loadingTask.destroy().catch(() => {});
    },
  };
}

export function create({ language, isCurrent, icon, onDirty, confirmReload }) {
  const entries = new Map();
  const copy = (zh, en) => language() === 'en' ? en : zh;
  const store = createAnnotationStore(onDirty);
  const button = (label, action, className, glyph) => {
    const node = element('button', className, glyph ? '' : label);
    node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
    if (glyph) node.append(icon(glyph));
    node.onclick = action;
    return node;
  };
  const present = entry => entries.get(entry.host) === entry && entry.visible && entry.host.isConnected
    && !entry.host.closest('[hidden], [inert]') && (entry.isCurrent ? entry.isCurrent() : isCurrent(entry.path, entry.mode));
  const observer = new IntersectionObserver(changes => {
    for (const change of changes) {
      const entry = entries.get(change.target);
      if (!entry) continue;
      entry.visible = change.isIntersecting;
      syncEntry(entry);
    }
  });

  function errorMessage(error) {
    if (error.code === 'not_found') return copy('找不到 PDF 附件', 'PDF attachment not found');
    if (error.name === 'PasswordException') return copy('此 PDF 需要密码', 'This PDF requires a password');
    if (error.name === 'InvalidPDFException' || error.code === 'invalid_pdf') return copy('PDF 文件损坏或格式无效', 'The PDF file is damaged or invalid');
    if (error.status === 409 || error.code === 'pdf_changed') return copy('PDF 文件已变化，请重试。', 'The PDF changed. Please retry.');
    return copy('无法读取 PDF', 'Unable to read the PDF');
  }

  function stop(entry) {
    entry.cancelResize?.();
    const reader = entry.reader;
    if (!reader) return;
    entry.resume = reader.position();
    entry.onPosition?.(entry.resume);
    entry.reader = null;
    entry.ready = false;
    entry.annotationTools?.reset();
    entry.offAnnotation?.(); entry.offAnnotation = null;
    if (entry.openButton) entry.openButton.disabled = true;
    entry.tabTools?.reset();
    reader.dispose();
    entry.stage.replaceChildren();
  }

  function start(entry) {
    if (!present(entry) || entry.reader) return;
    const stage = entry.stage;
    const status = element('div', 'note-pdf-message', copy('正在载入 PDF…', 'Loading PDF…'));
    status.setAttribute('role', 'status');
    stage.replaceChildren(status);
    const current = () => present(entry) && entry.reader === reader;
    const reader = createReader(stage, {
      copy, button, initial: entry.resume, current,
      store, annotationTools: entry.annotationTools, scroll: entry.scroll,
      onAnnotation(session) {
        if (!entry.annotationHint) return;
        const update = () => {
          const error = session.error;
          entry.annotationHint.hidden = !error;
          entry.annotationHint.textContent = error === 'pdf_changed'
            ? copy('PDF 已更换，原批注已保留', 'PDF changed. Previous annotations kept.')
            : error ? copy('请在独立标签查看批注状态', 'Open in a tab to check annotations') : '';
        };
        entry.offAnnotation = session.subscribe(update);
        update();
      },
      onName(name) {
        entry.name = name;
        if (entry.title) entry.title.textContent = entry.title.title = name;
        entry.onName?.(name);
      },
      onPage(page, total) {
        if (entry.pageLabel) entry.pageLabel.textContent = page + ' / ' + total;
        entry.tabTools?.onPage(page, total);
      },
      onError(error) {
        const retry = button(copy('重试', 'Retry'), () => {
          stop(entry);
          start(entry);
        });
        status.replaceChildren(element('span', '', errorMessage(error)), retry);
      },
    });
    entry.reader = reader;
    void reader.start(entry).then(ready => {
      if (!ready || !current()) return;
      status.remove();
      entry.ready = true;
      if (entry.openButton) entry.openButton.disabled = false;
      entry.tabTools?.ready();
    });
  }

  function syncEntry(entry) {
    if (present(entry)) start(entry);
    else stop(entry);
  }

  function mount(host, options) {
    host.setAttribute('data-ui-tooltip-disabled', '');
    const bar = element('div', 'note-html-embed-bar');
    const title = element('span', '', 'PDF');
    const pageLabel = element('span', 'note-pdf-page-label');
    const stage = element('div', 'note-html-embed-stage note-pdf-scroll');
    stage.tabIndex = 0;
    stage.setAttribute('aria-label', copy('PDF 阅读区', 'PDF reader'));
    const scroll = wrapPdfScroll(stage, copy, true);
    const annotationHint = element('span', 'note-pdf-inline-annotation-status');
    annotationHint.hidden = true; annotationHint.setAttribute('role', 'status');
    const entry = { ...options, host, title, pageLabel, stage, scroll, annotationHint, visible: false };
    const openButton = entry.openButton = button(copy('在新标签页打开', 'Open in new tab'), () => {
      if (entry.name && !entry.cancelResize && present(entry)) {
        options.onOpen({ path: entry.path, id: entry.id, name: entry.name, page: entry.reader.position().page });
      }
    }, 'note-html-open', 'external-link');
    openButton.disabled = true;
    bar.append(title, annotationHint, pageLabel, openButton);
    host.replaceChildren(bar, scroll.wrapper);
    if (options.controls) {
      const move = button(copy('移动 PDF 块', 'Move PDF block'), null, 'note-html-move note-table-grip');
      move.replaceChildren(...Array.from({ length: 6 }, () => element('i')));
      move.removeAttribute('title');
      move.onpointerdown = event => options.controls.move(event, () => present(entry) && !entry.cancelResize);
      const remove = button(copy('移除 PDF 块', 'Remove PDF block'), () => {
        if (!entry.cancelResize) options.controls.remove();
      }, 'note-html-remove', 'trash');
      bar.prepend(move); bar.insertBefore(remove, openButton);
      const footer = element('div', 'note-html-embed-footer');
      const resize = element('span', 'note-html-resize');
      resize.setAttribute('aria-hidden', 'true');
      resize.onpointerdown = event => startEmbedResize(event, entry, present);
      footer.append(resize); host.append(footer);
    }
    entries.set(host, entry); observer.observe(host); options.onLayout?.();
    return () => { observer.unobserve(host); entries.delete(host); stop(entry); scroll.dispose(); };
  }

  function mountTab(host, options) {
    const lifetime = new AbortController(), { signal } = lifetime;
    const toolbar = element('div', 'note-pdf-toolbar');
    toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', copy('PDF 阅读工具', 'PDF reading tools'));
    const middle = element('div', 'note-pdf-tool-group');
    const stage = element('div', 'note-pdf-scroll');
    stage.tabIndex = 0; stage.setAttribute('aria-label', copy('PDF 阅读区', 'PDF reader'));
    const scroll = wrapPdfScroll(stage, copy, true);
    const entry = { ...options, host, stage, scroll, visible: true };
    const annotationTools = entry.annotationTools = createAnnotationTools({
      copy, button, confirmReload, signal, current: () => entry.ready && present(entry),
    });
    let navigationOpen = false, outline, outlineIntent = 0, findIntent = 0, matches = [], selected = -1, timer = 0;
    const pageInput = element('input', 'note-pdf-page-input');
    pageInput.type = 'text'; pageInput.inputMode = 'numeric';
    pageInput.setAttribute('aria-label', copy('跳转页码', 'Go to page'));
    const count = element('span', 'note-pdf-page-count', '/ …');
    let currentPage = 1, totalPages = 0;
    const go = () => {
      const value = pageInput.value.trim();
      if (/^\d+$/.test(value) && totalPages) entry.reader.jump(clamp(Number(value), 1, totalPages));
      pageInput.value = String(currentPage);
    };
    pageInput.onchange = go;
    pageInput.onkeydown = event => { if (event.key === 'Enter') { go(); stage.focus(); } };
    const minus = button(copy('缩小', 'Zoom out'), () => entry.reader.zoom(1 / 1.2));
    const plus = button(copy('放大', 'Zoom in'), () => entry.reader.zoom(1.2));
    minus.textContent = '−'; plus.textContent = '+';
    const fit = button(copy('适合宽度', 'Fit width'), () => entry.reader.zoom(0));
    middle.append(pageInput, count, minus, plus, fit);

    const find = element('div', 'note-pdf-find');
    find.hidden = true;
    const searchInput = element('input');
    searchInput.type = 'search'; searchInput.placeholder = copy('在 PDF 中查找', 'Find in PDF');
    searchInput.setAttribute('aria-label', searchInput.placeholder);
    const result = element('span');
    result.setAttribute('role', 'status');
    const previous = button(copy('上一处', 'Previous match'), () => select(selected - 1));
    const next = button(copy('下一处', 'Next match'), () => select(selected + 1));
    previous.textContent = '↑'; next.textContent = '↓';
    const close = button(copy('关闭查找', 'Close find'), () => showFind(false), '', 'x');
    find.append(searchInput, result, previous, next, close);
    const findButton = button(copy('查找', 'Find'), () => showFind(find.hidden), 'note-pdf-find-button');
    findButton.append(icon('search'));
    function showFind(show) {
      find.hidden = !show; findButton.setAttribute('aria-expanded', String(show));
      if (show) { searchInput.focus(); searchInput.select(); }
      else {
        clearTimeout(timer); findIntent++; entry.reader?.cancelSearch();
        searchInput.value = ''; matches = []; selected = -1; result.textContent = '';
        if (entry.ready) findButton.focus();
      }
    }
    function select(index) {
      if (!matches.length) return;
      selected = (index + matches.length) % matches.length;
      result.textContent = (selected + 1) + ' / ' + matches.length;
      entry.reader.selectMatch(matches[selected]);
    }
    function queueFind(event) {
      if (event?.isComposing) return;
      clearTimeout(timer);
      const intent = ++findIntent;
      entry.reader?.cancelSearch();
      matches = []; selected = -1; previous.disabled = next.disabled = true;
      result.textContent = searchInput.value.trim() ? copy('正在查找…', 'Searching…') : '';
      timer = setTimeout(async () => {
        const current = () => intent === findIntent && !find.hidden;
        const found = await entry.reader?.find(searchInput.value, first => {
          if (!current()) return;
          matches = first; previous.disabled = next.disabled = false;
          select(0);
        });
        if (!current() || !found) return;
        matches = found;
        if (found.length) result.textContent = (selected + 1) + ' / ' + found.length;
        else result.textContent = searchInput.value.trim() ? copy('没有匹配', 'No matches') : '';
      }, 150);
    }
    searchInput.oninput = queueFind;
    searchInput.oncompositionend = queueFind;
    searchInput.onkeydown = event => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); select(selected + (event.shiftKey ? -1 : 1)); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); showFind(false); }
    };
    window.addEventListener('keydown', event => {
      if (!entry.ready || !present(entry) || event.altKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return;
      event.preventDefault(); event.stopPropagation(); showFind(true);
    }, { capture: true, signal });

    const navigation = options.navigation;
    const navigationHead = element('header', 'note-pdf-navigation-head');
    const files = button(copy('文件', 'Files'), () => showNavigation(false, false, true), 'note-pdf-files-button', 'file-text');
    files.append(document.createTextNode(copy('文件', 'Files')));
    const tabs = element('div', 'note-pdf-tool-group');
    const thumbnails = button(copy('缩略图', 'Thumbnails'), () => showOutline(false));
    const chapters = button(copy('目录', 'Outline'), () => showOutline(true));
    chapters.hidden = true; tabs.append(thumbnails, chapters); navigationHead.append(files, tabs);
    const thumbList = element('div', 'note-pdf-thumbnails');
    thumbList.setAttribute('aria-label', copy('页面缩略图', 'Page thumbnails'));
    const outlineList = element('nav', 'note-pdf-outline'); outlineList.hidden = true;
    outlineList.setAttribute('aria-label', copy('PDF 目录', 'PDF outline'));
    const thumbScroll = wrapPdfScroll(thumbList, copy), outlineScroll = wrapPdfScroll(outlineList, copy);
    const outlineContent = element('div');
    outlineList.append(outlineContent); outlineScroll.content(outlineContent);
    navigation.replaceChildren(navigationHead, thumbScroll.wrapper, outlineScroll.wrapper);
    const pages = button(copy('页面', 'Pages'), () => showNavigation(!navigationOpen, true));
    pages.setAttribute('aria-controls', navigation.id);
    function afterNavigate() {
      if (matchMedia('(max-width: 760px)').matches) {
        void showNavigation(false);
        stage.focus({ preventScroll: true });
      }
    }
    function showOutline(show) {
      thumbnails.setAttribute('aria-pressed', String(!show));
      chapters.setAttribute('aria-pressed', String(show));
      thumbScroll.wrapper.hidden = show; outlineScroll.wrapper.hidden = !show;
      outlineList.hidden = false;
      entry.reader?.attachThumbnails(show || !navigationOpen ? null : thumbList, afterNavigate);
      thumbScroll.content(!show && navigationOpen ? thumbList.firstElementChild : null);
    }
    function addOutline(items, level) {
      for (const item of items || []) {
        if (item.dest) {
          const row = button(item.title.trim() || copy('章节', 'Section'), () => {
            void entry.reader?.goToDestination(item.dest).then(moved => { if (moved) afterNavigate(); }).catch(() => {});
          });
          row.style.marginInlineStart = Math.min(level, 5) * 10 + 'px';
          outlineContent.append(row);
        }
        if (item.items?.length && level < 24) addOutline(item.items, level + 1);
      }
    }
    async function showNavigation(show, focus = false, showFiles = false) {
      const intent = ++outlineIntent;
      navigationOpen = show;
      pages.setAttribute('aria-expanded', String(show));
      options.onNavigation(show, showFiles);
      if (focus) (show ? files : pages).focus({ preventScroll: true });
      showOutline(false);
      if (!show || !entry.ready) return;
      let data;
      try { data = outline === undefined ? await entry.reader.outline() : outline; } catch { return; }
      if (intent !== outlineIntent || !present(entry)) return;
      if (outline === undefined) {
        outline = data;
        addOutline(outline, 0);
        chapters.hidden = !outlineContent.children.length;
      }
    }
    const setTools = enabled => {
      for (const control of [pages, pageInput, minus, plus, fit, findButton, annotationTools.toggle]) control.disabled = !enabled;
    };
    entry.tabTools = {
      onPage(page, total) {
        currentPage = page; totalPages = total;
        if (document.activeElement !== pageInput) pageInput.value = String(page);
        count.textContent = '/ ' + total;
      },
      ready() { setTools(true); },
      reset() { showFind(false); void showNavigation(false); setTools(false); },
    };
    const actions = element('div', 'note-pdf-tool-group');
    actions.append(annotationTools.toggle, findButton);
    toolbar.append(pages, middle, actions);
    host.replaceChildren(toolbar, annotationTools.bar, annotationTools.status, find, scroll.wrapper);
    pages.setAttribute('aria-expanded', 'false'); findButton.setAttribute('aria-expanded', 'false');
    previous.disabled = next.disabled = true; setTools(false);
    entries.set(host, entry); syncEntry(entry);
    return {
      jump(page) {
        entry.resume = { ...entry.resume, page, fraction: 0 };
        entry.reader?.jump(page);
      },
      closeNavigation() { if (navigationOpen) void showNavigation(false); },
      dispose() {
        entries.delete(host); stop(entry); lifetime.abort();
        scroll.dispose(); thumbScroll.dispose(); outlineScroll.dispose();
        navigation.replaceChildren();
      },
    };
  }

  return {
    mount, mountTab,
    sync() { entries.forEach(syncEntry); },
    suspend() { entries.forEach(stop); },
    dirty: store.dirty,
    flush(options) {
      entries.forEach(entry => {
        if (!options?.path || entry.path === options.path || (!options.id && entry.path.startsWith(options.path + '/'))) {
          if (!options?.id || entry.id === options.id) entry.annotationTools?.settle();
        }
      });
      return store.flush(options);
    },
  };
}
