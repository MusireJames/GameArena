const C = 'gamearena-v1';
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(['/offline.html', '/icon-192.png'])).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => { if (e.request.mode === 'navigate') e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html'))); });
