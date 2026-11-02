// CareerCrumbs offline support: the whole app is a handful of static files, cached on install.
// VERSION changes with every build, so a new build installs alongside and the page offers to reload.
const VERSION = "/*VERSION*/";
const CACHE = "careercrumbs-" + VERSION;
const FILES = /*FILES*/;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("careercrumbs-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});
// Cache first; the app shell is versioned, so anything cached is the current build's.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: req.mode === "navigate" }).then((hit) => hit || fetch(req).catch(() => (req.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});
