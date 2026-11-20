const base = new URL('vendor/pdfjs/', import.meta.url);
let libraryPromise;

export function loadPdfLibrary() {
  if (libraryPromise) return libraryPromise;
  libraryPromise = new Promise((resolve, reject) => {
    function ready() {
      const library = window.pdfjsLib;
      if (!library) { reject(new Error('PDF.js unavailable')); return; }
      library.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', base).href;
      resolve(library);
    }
    if (window.pdfjsLib) { ready(); return; }
    const script = document.createElement('script');
    script.src = new URL('pdf.min.js', base).href;
    script.onload = () => { ready(); script.remove(); };
    script.onerror = () => { script.remove(); reject(new Error('PDF.js unavailable')); };
    document.head.append(script);
  }).catch(error => { libraryPromise = null; throw error; });
  return libraryPromise;
}

export function openPdfDocument(library, url, options) {
  return library.getDocument({
    url,
    cMapUrl: new URL('cmaps/', base).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', base).href,
    ...options,
    isEvalSupported: false,
    enableXfa: false,
  });
}
