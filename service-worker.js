/* Service Worker for "הלימוד היומי"
 *
 * Caching strategy:
 *  - App shell (HTML/CSS/JS/icons): Cache-First. The app works offline from the cache.
 *  - Fonts (Google Fonts): Stale-While-Revalidate. Fast loads, refresh in background.
 *  - Sefaria API: Network-First with cache fallback. Always try fresh, but work offline.
 *  - Other external requests: Network-only (no caching).
 *
 * To force all users to get a new version, bump CACHE_VERSION below.
 */

const CACHE_VERSION = 'v95';
const SHELL_CACHE   = `limud-yomi-shell-${CACHE_VERSION}`;
const FONTS_CACHE   = `limud-yomi-fonts-${CACHE_VERSION}`;
const RUNTIME_CACHE = `limud-yomi-runtime-${CACHE_VERSION}`;

// Files that make up the app shell - pre-cached on install so the app works offline
// from the very first visit.
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './favicon.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png'
];

/* ========== INSTALL ========== */
// Pre-cache the app shell. We don't fail the install if a single file 404s - we
// just skip it, because a missing icon shouldn't break the entire service worker.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async cache => {
      await Promise.all(
        SHELL_FILES.map(url =>
          cache.add(url).catch(err => {
            console.warn('[SW] Failed to pre-cache', url, err);
          })
        )
      );
    })
  );
  // Activate the new SW as soon as it finishes installing, without waiting
  // for old tabs to close.
  self.skipWaiting();
});

/* ========== ACTIVATE ========== */
// Delete caches from previous versions so we don't leak storage across releases.
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(n => !n.endsWith(CACHE_VERSION))
          .map(n => caches.delete(n))
      );
      // Take control of open pages immediately so they get the new SW without
      // requiring a refresh.
      await self.clients.claim();
    })()
  );
});

/* ========== FETCH ROUTING ========== */
// Pick the right strategy based on what's being requested.
self.addEventListener('fetch', event => {
  const req = event.request;

  // Only handle GET - never cache POST, PUT, etc.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Google Fonts: stale-while-revalidate (fast but refreshed in background)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, FONTS_CACHE));
    return;
  }

  // Sefaria API: network-first with cache fallback (always try fresh, offline fallback)
  if (url.hostname === 'www.sefaria.org' && url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req, RUNTIME_CACHE));
    return;
  }

  // Firebase realtime traffic: always bypass the SW (live data must never be cached)
  if (url.hostname.endsWith('firebaseio.com') ||
      url.hostname.endsWith('firebasedatabase.app') ||
      url.hostname.endsWith('gstatic.com') && url.pathname.includes('firebase')) {
    return;
  }

  // Same-origin: cache-first (the app shell)
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // Everything else: just pass through to the network
});

/* ========== STRATEGIES ========== */

// Cache-first: return cached response if available, else fetch and cache.
// Used for the app shell - the fastest option for known-static files.
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // Only cache successful, basic responses (not opaque cross-origin ones)
    if (response && response.ok && response.type === 'basic') {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // If we're offline AND the request isn't cached, return a minimal offline response
    // for the main page. Otherwise let the error bubble up.
    if (request.mode === 'navigate') {
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}

// Network-first: try the network, fall back to cache if we're offline.
// Used for Sefaria API - fresh data when online, cached data when offline.
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

// Stale-while-revalidate: return cached immediately, then refresh in background.
// Used for fonts - we want speed but also eventual consistency.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request).then(response => {
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => cached); // If offline, keep the cached copy

  return cached || networkFetch;
}

/* ========== MESSAGES FROM THE APP ========== */
// Lets the app manually trigger a SW update check (e.g. from a "check for updates" button)
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
