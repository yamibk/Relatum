// Notes-only worker. Models and Pele's private WeakMap stay in this realm.
'use strict';
(function () {
  const MAX_ITEMS = 32, MAX_BYTES = 8 * 1024 * 1024;
  const cache = new Map(), fontLoads = new Map();
  let bytes = 0, canvasSupported;
  const faces = [
    ['Relatum Open Sans', 'open-sans-regular.woff2', '400', 'normal'],
    ['Relatum Open Sans', 'open-sans-bold.woff2', '700', 'normal'],
    ['Relatum Open Sans', 'open-sans-italic.woff2', '400', 'italic'],
    ['Relatum Open Sans', 'open-sans-bolditalic.woff2', '700', 'italic'],
    ['Noto Sans SC', 'noto-sans-sc.woff2', '100 900', 'normal'],
  ];
  function remember(source, entry) {
    const previous = cache.get(source);
    if (previous) { bytes -= previous.bytes; cache.delete(source); }
    entry.bytes = 2 * (source.length + (entry.result?.svg.length || 0));
    if (entry.bytes > MAX_BYTES) return;
    cache.set(source, entry); bytes += entry.bytes;
    while (cache.size > MAX_ITEMS || bytes > MAX_BYTES) {
      const first = cache.keys().next().value; bytes -= cache.get(first).bytes; cache.delete(first);
    }
  }
  async function prepareFonts(options) {
    canvasSupported ??= typeof OffscreenCanvas === 'function' && !!new OffscreenCanvas(1, 1).getContext('2d');
    if (!canvasSupported) {
      throw Object.assign(new Error('Worker text measurement unavailable'), { code: 'worker-unavailable' });
    }
    const family = options.fontFamily + ',' + options.fontFamilyMono;
    await Promise.all(faces.filter(face => family.includes(face[0])).map(face => {
      const key = face.join('|');
      if (!fontLoads.has(key)) fontLoads.set(key, (async () => {
        if (typeof FontFace !== 'function' || !self.fonts) throw new Error('Worker fonts unavailable');
        const font = new FontFace(face[0], 'url(' + new URL('fonts/' + face[1], self.location.href).href + ')',
          { weight: face[2], style: face[3] });
        self.fonts.add(await font.load()); pele.forgetTextWidths();
      })().catch(error => { fontLoads.delete(key); error.code = 'worker-unavailable'; throw error; }));
      return fontLoads.get(key);
    }));
  }
  try {
    importScripts('vendor/pele/pele.global.js');
    self.onmessage = async event => {
      const { id, source, options, layoutKey, fontRevision, documentId, blockId, version } = event.data;
      if (event.data.kind === 'fonts') {
        try { await prepareFonts(options); } catch (error) { self.postMessage({ unavailable: String(error.message || error) }); }
        return;
      }
      const identity = { id, documentId, blockId, version };
      try {
        await prepareFonts(options);
        let entry = cache.get(source);
        if (!entry) entry = { model: pele.parse(source, { limit: 65536, maxEdges: 5000 }), fontRevision };
        if (entry.fontRevision !== fontRevision) {
          pele.forgetTextWidths(); entry.layoutKey = ''; entry.fontRevision = fontRevision;
        }
        if (entry.layoutKey !== layoutKey || !entry.result) {
          entry.result = pele.render(entry.model, { ...options, limit: 65536, maxEdges: 5000, outputLimit: 4000000,
            autoDirection: false, responsive: true, links: false, images: false, idPrefix: 'relatum-note-pele-template' });
          entry.layoutKey = layoutKey;
        }
        remember(source, entry);
        self.postMessage({ ...identity, result: { svg: entry.result.svg, width: entry.result.width,
          height: entry.result.height, type: entry.result.type } });
      } catch (error) {
        self.postMessage({ ...identity, error: { message: String(error.message || error), code: error.code || 'render' } });
      }
    };
    self.postMessage({ ready: true });
  } catch (error) { self.postMessage({ unavailable: String(error.message || error) }); }
})();
