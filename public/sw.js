/*
 * Wallaby service worker.
 *
 * Deliberately conservative about what it keeps: the build's static assets and
 * a small offline shell, never article HTML or API responses. A read-later
 * library is private, and the Cache API is unencrypted on-disk storage that
 * outlives sign-out, so user content is left to the network.
 */

const VERSION = "wallaby-v2";
const ASSETS = `${VERSION}-assets`;
const SHELL = `${VERSION}-shell`;
const OFFLINE_URL = "/offline";

const SHELL_URLS = [OFFLINE_URL, "/icon-192.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Immutable build output and app icons are the only things worth keeping. */
function isCacheableAsset(url) {
  return url.pathname.startsWith("/_next/static/")
    || url.pathname === "/manifest.webmanifest"
    || /^\/(apple-)?icon[-.]/.test(url.pathname);
}

/** Anything that can carry library content or credentials must stay uncached. */
function isPrivate(url) {
  return url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/auth/")
    || url.pathname.startsWith("/oauth/")
    || url.pathname.startsWith("/media/")
    || url.pathname.startsWith("/feed/")
    || url.pathname.startsWith("/export/");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isPrivate(url)) return;

  if (request.mode === "navigate") {
    // Network-first: the library is always live when there is a connection,
    // and the offline shell only stands in when there is not.
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then((cached) => cached ?? Response.error())),
    );
    return;
  }

  if (!isCacheableAsset(url)) return;

  event.respondWith(
    caches.open(ASSETS).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      // Stale-while-revalidate: hashed assets never change under a given URL,
      // so serving the cached copy first costs nothing in correctness.
      return cached ?? network;
    }),
  );
});
