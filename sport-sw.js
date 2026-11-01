/* Sport app-shell fallback. Does not proxy or intercept the external player. */
const CACHE = 'sport-shell-v1';
const SHELL = [
  './', './index.html', './style.css', './config.js',
  './auth.js', './browser-identity.js', './site.js',
  './version.json', './admin.html', './admin.js'
];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map(async file => {
      const url = new URL(file, self.registration.scope);
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (response.ok) await cache.put(url, response.clone());
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('sport-shell-') &&
      name !== CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin ||
      !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (!response.ok && response.status >= 500) throw Error('TEMPORARY_UNAVAILABLE');
      if (response.ok) event.waitUntil(cache.put(request, response.clone()));
      return response;
    } catch {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const fallback = await cache.match(new URL('index.html', self.registration.scope));
        if (fallback) return fallback;
      }
      return new Response('', { status: 503, statusText: 'Service Unavailable' });
    }
  })());
});
