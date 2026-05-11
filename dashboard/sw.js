// CHS Dashboard Service Worker
// Caches the app shell so it loads instantly and works offline
// Live data (KPIs, tasks, calendar) always fetches fresh from APIs

// Bump when shell or inject behavior changes — old caches can hold HTML from
// before Worker env (e.g. DASHBOARD_OAUTH_CLIENT_ID) was set, which breaks OAuth.
const CACHE_NAME = 'chs-dashboard-v4';
const CACHE_URLS = [
  '/',
  '/index.html',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Nunito:wght@400;500;600;700;800&display=swap'
];

// Install — cache app shell
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CACHE_URLS).catch(function() {
        // Fonts may fail on first install — that's OK
        return cache.add('/');
      });
    })
  );
  self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

// Fetch — network-first for documents & APIs; cache-first for other shell assets
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // Never cache Worker API routes — POST /api/sync/now, KPI fetches, etc.
  // must always hit the origin (cache-first below can swallow or mishandle
  // non-GET requests on some browsers).
  if (url.includes('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Always go network-first for Google APIs and Jobber
  if (url.includes('googleapis.com') ||
      url.includes('getjobber.com') ||
      url.includes('workers.dev') ||
      url.includes('open-meteo.com') ||
      url.includes('fonts.gstatic.com')) {
    event.respondWith(
      fetch(event.request).catch(function() {
        return caches.match(event.request);
      })
    );
    return;
  }

  // HTML documents must be network-first: index.html is **injected** at the edge
  // (OAuth client ID, sheet IDs). Cache-first would freeze an old shell with
  // empty `OAUTH_CLIENT_ID` forever until the user clears site data.
  if (event.request.mode === 'navigate' ||
      event.request.destination === 'document' ||
      event.request.destination === 'manifest') {
    event.respondWith(
      fetch(event.request).then(function(fresh) {
        if (fresh && fresh.ok) {
          var clone = fresh.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return fresh;
      }).catch(function() {
        return caches.match(event.request).then(function(c) {
          return (
            c ||
            new Response('Offline', {
              status: 503,
              headers: {'Content-Type': 'text/plain; charset=UTF-8'},
            })
          );
        });
      })
    );
    return;
  }

  // Cache-first for non-document shell (fonts, etc.)
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) {
        // Return cache but update in background
        fetch(event.request).then(function(fresh) {
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, fresh);
          });
        }).catch(function() {});
        return cached;
      }
      return fetch(event.request).then(function(fresh) {
        var clone = fresh.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
        return fresh;
      }).catch(function() {
        // Avoid "FetchEvent resulted in a network error" when offline or request
        // fails (e.g. transient CORS/redirect quirks); fall back to cache if any.
        return caches.match(event.request).then(function(c) {
          return (
            c ||
            new Response('', {
              status: 504,
              statusText: 'Gateway Timeout',
            })
          );
        });
      });
    })
  );
});
