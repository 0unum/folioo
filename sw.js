// Folio's service worker: keeps every file on the phone so the app opens and
// reads with no connection at all. Bump VERSION whenever you change a file.
const VERSION = 'folio-v1';

// The app itself — small, cached first so it always opens.
const SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './js/app.js',
  './js/store.js',
  './js/reader.js',
  './js/export.js',
  './js/words.js',
  './js/edition.js',
  './js/searchable.js',
  './js/epub.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/pdfjs/pdf.min.js',
  './vendor/pdfjs/pdf.worker.min.js',
  './vendor/tesseract/tesseract.min.js',
  './vendor/tesseract/worker.min.js',
];

// The heavy parts — OCR engine, language models, PDF writer, Arabic font.
// Fetched in the background on first open; if one fails it is cached on first use instead.
const HEAVY = [
  './vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract/core/tesseract-core-lstm.wasm.js',
  './vendor/lang/ara.traineddata.gz',
  './vendor/lang/deu.traineddata.gz',
  './vendor/lang/eng.traineddata.gz',
  './vendor/pdf-lib/pdf-lib.min.js',
  './vendor/pdf-lib/fontkit.umd.min.js',
  './vendor/fonts/NotoNaskhArabic_400Regular.ttf',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    await Promise.allSettled(HEAVY.map(u => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      // Offline and not cached: any page request gets the app.
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      throw err;
    }
  })());
});

// Lets the page ask how much is ready for offline use.
self.addEventListener('message', async event => {
  if (event.data === 'offline-status') {
    const cache = await caches.open(VERSION);
    const have = await Promise.all([...SHELL, ...HEAVY].map(u => cache.match(u).then(Boolean)));
    event.source?.postMessage({ type: 'offline-status', ready: have.filter(Boolean).length, total: have.length });
  }
});
