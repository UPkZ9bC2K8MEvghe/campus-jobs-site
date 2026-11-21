/* 校招信息查询站 Service Worker：应用外壳缓存 + 数据网络优先 */
const VERSION = 'v6';
const SHELL = `campus-jobs-shell-${VERSION}`;
const DATA = `campus-jobs-data-${VERSION}`;
const SHELL_FILES = ['./', './index.html', './assets/app.js', './assets/styles.css'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL, './index.html'));
  } else if (url.pathname.includes('/data/')) {
    event.respondWith(networkFirst(req, DATA));
  } else if (url.pathname.includes('/assets/')) {
    event.respondWith(staleWhileRevalidate(req, SHELL));
  }
});

async function networkFirst(req, cacheName, fallback) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    if (fallback) {
      const shell = await caches.match(fallback);
      if (shell) return shell;
    }
    return new Response('离线且暂无缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || new Response('', { status: 504 });
}
