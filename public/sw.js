/**
 * Service worker: app-shell caching and installability.
 *
 * This is what makes a repeat launch paint instantly instead of waiting on
 * the network, and it is the requirement that lets the app be installed to a
 * home screen and run without browser chrome.
 *
 * Deliberately narrow in scope. A call is realtime by nature -- there is no
 * useful offline mode for it -- so this caches the shell and nothing else.
 * Signalling, room state and TURN credentials must never be served stale.
 */

// Bump on every deploy that changes a shell asset.
const VERSION = "v1";
const CACHE = `talkspace-shell-${VERSION}`;

/**
 * The wasm module is precached alongside the JS: fetching it late would mean
 * the first seconds of a call fall back to the JS detector.
 */
const SHELL = [
  "/",
  "/room",
  "/css/app.css",
  "/js/util.js",
  "/js/signal.js",
  "/js/media.js",
  "/js/mesh.js",
  "/js/sheet.js",
  "/js/e2ee.js",
  "/js/vad.js",
  "/js/vad-worklet.js",
  "/js/lobby.js",
  "/js/room.js",
  "/wasm/dsp.wasm",
  "/icon.svg",
  "/icon-192.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individually, so one 404 during development cannot fail the install.
      await Promise.allSettled(SHELL.map((url) => cache.add(url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never interpose on live endpoints. /api/ice in particular returns
  // short-lived TURN credentials that must not be replayed from a cache.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;

  // Navigations: serve the right shell document immediately, revalidate after.
  if (request.mode === "navigate") {
    const shellPath = url.pathname.startsWith("/r/") ? "/room" : "/";
    event.respondWith(staleWhileRevalidate(request, shellPath));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, url.pathname));
});

/**
 * Serve from cache for an instant paint, then refresh in the background so
 * the next load has the new build. Combined with skipWaiting/claim above,
 * a deploy reaches users on their second launch at the latest.
 */
async function staleWhileRevalidate(request, cacheKey) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(cacheKey);

  const network = fetch(request)
    .then((response) => {
      if (response.ok && response.type === "basic") {
        cache.put(cacheKey, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) return cached;

  const fresh = await network;
  if (fresh) return fresh;

  return new Response("Offline", {
    status: 503,
    headers: { "Content-Type": "text/plain" },
  });
}
