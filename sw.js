const CACHE = 'wordtrail-static-v016-phrases';
const CORE = [
  './', './index.html', './interface.css',
  './workbench.js', './app.js', './static-service.js', './wrongbook-store.js', './wrongbook.js', './wrongbook-ai.js', './wrongbook-prompt.js', './manifest.webmanifest', './icon.svg',
  './vendor/WordtrailSansSC-Common.ttf',
  './vendor/NotoSans-Regular.ttf', './dictionary/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('wordtrail-static-') && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const url = new URL(event.request.url);
    const assetFirst = url.pathname.includes('/dictionary/') || url.pathname.includes('/vendor/');
    const cached = await caches.match(event.request);
    if (assetFirst && cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok) (await caches.open(CACHE)).put(event.request, response.clone());
      return response;
    } catch (error) {
      if (cached) return cached;
      if (event.request.mode === 'navigate') return caches.match('./index.html');
      throw error;
    }
  })());
});
