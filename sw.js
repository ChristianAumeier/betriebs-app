// Service-Worker: speichert die App-Dateien auf dem Gerät, damit sie ohne Netz startet.
// Bei jeder neuen Version VERSION hochzählen, damit die Handys die neuen Dateien holen.
const VERSION = 'v6';
const CACHE = 'betriebs-app-' + VERSION;
const DATEIEN = [
  './',
  'index.html',
  'manifest.webmanifest',
  'lib/supabase-2.117.2.js',
  'anmeldung.css',
  'anmeldung.js',
  'energie-zuhause.css',
  'energie-zuhause.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(DATEIEN)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(namen.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Zuerst aus dem Netz holen (immer aktuell), ohne Netz aus dem Speicher.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((antwort) => {
        if (antwort.ok && new URL(event.request.url).origin === self.location.origin) {
          const kopie = antwort.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, kopie));
        }
        return antwort;
      })
      .catch(() =>
        caches.match(event.request, { ignoreSearch: true })
          .then((treffer) => treffer || (event.request.mode === 'navigate' ? caches.match('index.html') : undefined))
          .then((treffer) => treffer || Response.error())
      )
  );
});
