// sw.js — Offline-First Service Worker for GPS Speedometer PWA

const CACHE_NAME = 'gps-speedometer-m3-v1';
const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/m3-tokens.css',
  './css/styles.css',
  './js/app.js',
  './js/telemetry-engine.js',
  './js/alerts.js',
  './js/charts.js',
  './js/wake-lock.js',
  './js/simulator.js',
  './assets/icon-192.svg',
  './assets/icon-512.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return null;
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Cache-first strategy for same-origin app shell assets, with network fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const cloned = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
            }
            return networkResponse;
          })
          .catch(() => caches.match('./index.html'));
      })
    );
  }
});
