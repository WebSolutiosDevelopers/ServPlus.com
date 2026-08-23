const CACHE_NAME = 'servplus-pwa-v9';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
  '/icon.svg',
  '/screenshot-mobile.png',
  '/screenshot-wide.png'
];

// Instalação do Service Worker e Precache Resiliente
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[PWA SW] Pre-caching static app shell');
      return Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[PWA SW] Falha não impeditiva ao pré-carregar:', url, err);
          })
        )
      );
    })
  );
});

// Ativação do Service Worker e Limpeza de Caches Antigos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[PWA SW] Removendo cache legado:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Mensagens diretas da aplicação
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Interceptação de Requisições
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Ignora chamadas de autenticação do Firebase e APIs externas
  if (
    url.protocol.startsWith('chrome-extension') ||
    url.origin.includes('firestore.googleapis.com') ||
    url.origin.includes('identitytoolkit.googleapis.com') ||
    url.origin.includes('securetoken.googleapis.com') ||
    url.origin.includes('nominatim.openstreetmap.org') ||
    url.origin.includes('viacep.com.br') ||
    url.origin.includes('api.telegram.org')
  ) {
    return;
  }

  // Navegação HTML (SPA): Network-first com Fallback Offline para Cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put('/', responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match('/').then((cached) => {
            return cached || caches.match('/index.html') || caches.match('/manifest.json');
          });
        })
    );
    return;
  }

  // Ativos Estáticos da Aplicação: Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            (networkResponse.type === 'basic' || networkResponse.type === 'cors')
          ) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return cachedResponse;
        });

      return cachedResponse || fetchPromise;
    })
  );
});
