const CACHE_NAME = 'typh-xchain-v1';
const urlsToCache = [
    '/',
    '/index.html',
    '/css/style.css',
    '/js/config.js',
    '/js/auth.js',
    '/js/functions.js',
    '/js/app.js',
    '/manifest.json'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request).then(response => response || fetch(event.request))
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.map(key => {
                if(key !== CACHE_NAME) return caches.delete(key);
            })
        ))
    );
});