// Мінімальний service worker: дозволяє встановити сайт на телефон. Дані завжди беруться з мережі.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
