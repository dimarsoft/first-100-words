// Офлайн-кэш оболочки приложения. При изменении файлов — увеличить номер версии.
const CACHE = 'first100-v12';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'words.js', 'git-info.json', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'privacy.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Сначала сеть (чтобы обновления приходили), без сети — из кэша.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Запросы к Google (вход, Диск) не трогаем: там токены и личные данные, кэшировать их нельзя.
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    // no-cache: сверяться с сервером, а не брать файл из HTTP-кэша браузера (GitHub Pages разрешает держать его 10 минут).
    fetch(e.request, { cache: 'no-cache' })
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
