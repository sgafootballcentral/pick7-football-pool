// Bump this on every deploy so clients pick up new files instead of a stale cache.
const CACHE_VERSION = "pick7-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/config.js",
  "./js/supabaseClient.js",
  "./js/app.js",
  "./js/auth.js",
  "./js/picks.js",
  "./js/leaderboard.js",
  "./js/chat.js",
  "./js/push.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for everything -- this app is live data (picks, scores,
// chat), so a stale cache is worse than a brief loading state. The cache
// only exists as a fallback for genuinely offline app-shell loads, and for
// Supabase/API calls we deliberately do NOT intercept -- let those fail
// naturally so the app's own "you're offline" handling can kick in.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // don't touch Supabase/ESPN calls
  if (event.request.method !== "GET") return;

  event.respondWith(
    // cache: "no-store" bypasses the browser's own HTTP disk cache, not just
    // our Cache Storage -- otherwise a "network-first" fetch can still come
    // back with a stale cached response instead of actually hitting the
    // network, and app updates (like this one) never reach installed PWAs.
    fetch(event.request, { cache: "no-store" })
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        return resp;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});

// --- Web Push: real OS-level notifications for new chat messages -----------
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: "Pick 7", body: event.data ? event.data.text() : "New activity" };
  }
  const title = data.title || "Pick 7 Chat";
  const options = {
    body: data.body || "New message",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: { url: data.url || "./" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.registration.scope) && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
