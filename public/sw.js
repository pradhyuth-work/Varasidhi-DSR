// Minimal service worker whose only job is to make the site installable.
// It intentionally never caches or intercepts anything — every request
// (HTML, /api/*, auth, cross-origin Supabase calls, everything) passes
// straight through to the network untouched. No offline fallback, no
// stale responses, ever.
const CACHE_VERSION = "v1";
const CACHE_NAME = `varasidhi-dsr-${CACHE_VERSION}`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// A fetch handler is required for Chrome's installability check, but it
// deliberately does nothing — no respondWith, no caching. Every request
// falls through to the browser's normal network handling.
self.addEventListener("fetch", () => {});
