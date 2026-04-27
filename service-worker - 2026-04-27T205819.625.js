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

const CACHE_VERSION = 'v174';
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
//
// IMPORTANT: We validate that HTML responses for navigation requests actually
// contain our app shell BEFORE caching them. This guards against GitHub Pages
// briefly serving the README.md or another fallback page during a deploy
// rebuild — without this check, that bad page would get cached and shown to
// users instead of the real app.
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) {
    // We have a cached copy. Use it immediately, but kick off a background
    // refresh so the cache stays current with new deploys.
    _backgroundRefresh(request, cacheName);
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      // For navigation requests (the main page), verify we got the actual app
      // and not some intermediate GitHub Pages response (README, build placeholder).
      if (_isNavigationOrIndexRequest(request)) {
        const isValid = await _validateAppShellResponse(response.clone());
        if (!isValid) {
          // The response doesn't look like our app — don't cache it!
          // Fall back to whatever we have, or to a minimal "rebuilding" page.
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
          // No cache at all (first visit during a bad moment). Return what we got
          // but DON'T cache it.
          return response;
        }
      }
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

// Returns true when this request is for the main HTML document or its index.
function _isNavigationOrIndexRequest(request) {
  if (request.mode === 'navigate') return true;
  const url = new URL(request.url);
  // Same-origin requests for / or /index.html
  if (url.pathname === '/' || url.pathname.endsWith('/index.html') ||
      url.pathname.endsWith('/limud-yomi/') || url.pathname.endsWith('/limud-yomi')) {
    return true;
  }
  return false;
}

// Verify the response body looks like our app shell (contains a known marker).
// Returns false for things like GitHub's README rendering or empty pages.
async function _validateAppShellResponse(response) {
  try {
    const text = await response.text();
    // Our app's index.html always contains these markers — they identify it
    // unambiguously vs. README.md or other fallback pages.
    const looksLikeOurApp =
      text.includes('הלימוד היומי') &&
      (text.includes('service-worker.js') || text.includes('CACHE_VERSION') || text.includes('manifest.json')) &&
      // Not a GitHub README — those are wrapped in github.com markup
      !text.includes('limud-yomi - הוראות העלאה') &&
      !text.includes('githubusercontent.com');
    return looksLikeOurApp;
  } catch (e) {
    // If we can't read the response (already consumed, etc.), assume it's fine
    // and let the rest of the system deal with it.
    return true;
  }
}

// Refresh the cached copy of a resource in the background, but only if the
// new fetch returns a valid app shell. Silent failure on errors.
async function _backgroundRefresh(request, cacheName) {
  try {
    const response = await fetch(request);
    if (!response || !response.ok || response.type !== 'basic') return;
    if (_isNavigationOrIndexRequest(request)) {
      const isValid = await _validateAppShellResponse(response.clone());
      if (!isValid) return;  // Don't poison the cache with a bad response
    }
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
  } catch (e) {
    // Network failed — that's fine, we have the cached copy
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
