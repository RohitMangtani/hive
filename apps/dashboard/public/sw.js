// Bump SW_VERSION when shipping shell/protocol changes: activate drops every
// other cache, and the runtime cache is bounded below so hashed _next/static
// assets from old deploys cannot accumulate forever.
const SW_VERSION = "v2";
const CACHE = `hive-${SW_VERSION}`;
const MAX_RUNTIME_ENTRIES = 64;
const SHELL = ["/", "/manifest.json", "/icon-192.png"];

async function putBounded(request, response) {
  const c = await caches.open(CACHE);
  await c.put(request, response);
  const keys = await c.keys();
  if (keys.length > MAX_RUNTIME_ENTRIES) {
    // cache.keys() preserves insertion order, so this prunes oldest-first
    await Promise.all(keys.slice(0, keys.length - MAX_RUNTIME_ENTRIES).map((k) => c.delete(k)));
  }
}

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only cache same-origin GET requests, never WebSocket or API calls
  if (e.request.method !== "GET" || url.protocol === "ws:" || url.protocol === "wss:") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          putBounded(e.request, clone);
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        if (e.request.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        // Clean network error instead of respondWith(undefined) TypeError
        return Response.error();
      })
  );
});

// Web Push notification handler
self.addEventListener("push", (e) => {
  if (!e.data) return;

  let payload;
  try {
    payload = e.data.json();
  } catch {
    payload = { title: "Hive", body: e.data.text() };
  }

  const options = {
    body: payload.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.tag || "hive-notification",
    data: payload.data || {},
    // Vibrate pattern: short buzz for task completion
    vibrate: [100, 50, 100],
    // Renotify if same tag (new completion for same agent)
    renotify: true,
  };

  e.waitUntil(self.registration.showNotification(payload.title || "Hive", options));
});

// Tap notification → open/focus the dashboard
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus existing dashboard tab if open
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      // Otherwise open a new tab
      return clients.openWindow("/");
    })
  );
});
