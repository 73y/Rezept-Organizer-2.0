/* service-worker.js */
importScripts("./js/appMeta.js");

const META = self.APP_META || {};
const CACHE_NAME = META.cacheName || `einkauf-rezepte-pwa-${META.version || "v0.0.0"}-${META.buildId || "dev"}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./offline.html",
  "./service-worker.js",
  "./js/appMeta.js",
  "./js/storage.js",
  "./js/models.js",
  "./js/utils.js",
  "./js/ui.js",
  "./js/audit.js",
  "./js/actions.js",
  "./js/ingredients.js",
  "./js/recipes/recipesLogic.js",
  "./js/recipes/recipesModals.js",
  "./js/recipes/recipesView.js",
  "./js/shopping.js",
  "./js/dashboard.js",
  "./js/stats.js",
  "./js/inventory.js",
  "./js/settings.js",
  "./js/purchaselog.js",
  "./js/cookhistory.js",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-192.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-64.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Provide SW meta to the page (Settings "Über diese App")
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  const type = msg.type || msg.action || "";

  if (type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (type === "GET_SW_META" || type === "GET_META" || type === "SW_META_REQUEST") {
    const payload = {
      type: "SW_META",
      meta: {
        version: META.version || null,
        buildId: META.buildId || null,
        cacheName: CACHE_NAME,
      }
    };

    // Reply via MessageChannel port if provided, else fallback to source
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage(payload);
    } else if (event.source && event.source.postMessage) {
      event.source.postMessage(payload);
    }
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // SPA navigation: network-first, fallback to cached index/offline
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put("./index.html", fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (
          (await cache.match(req, { ignoreSearch: true })) ||
          (await cache.match("./index.html")) ||
          (await cache.match("./offline.html"))
        );
      }
    })());
    return;
  }

  const path = url.pathname;

  const isCodeAsset = path.includes("/js/") || path.endsWith(".js") || path.endsWith(".css");
  const isIconAsset = path.includes("/icons/") || path.endsWith(".png") || path.endsWith(".webmanifest");

  // For JS/CSS: network-first to prevent "new HTML + old JS" situations
  if (isCodeAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const fresh = await fetch(req);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return (await cache.match(req, { ignoreSearch: true })) || fetch(req);
      }
    })());
    return;
  }

  // For icons/static: cache-first
  if (isIconAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      const fresh = await fetch(req);
      cache.put(req, fresh.clone());
      return fresh;
    })());
    return;
  }

  // Default: stale-while-revalidate
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });
    const fetchPromise = fetch(req).then((fresh) => {
      cache.put(req, fresh.clone());
      return fresh;
    }).catch(() => null);

    return cached || (await fetchPromise) || fetch(req);
  })());
});
