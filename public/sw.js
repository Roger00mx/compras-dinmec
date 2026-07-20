// Service Worker — Compras SGC Digital
// Hace que la app cargue rápido e instalada. NO guarda datos ni archivos (esos siempre van a la red).
const CACHE = "cd-cache-v2";
const SHELL = [
  "/", "/index.html", "/compra.html", "/proveedores.html", "/proveedor.html",
  "/cxp.html", "/login.html", "/usuarios.html",
  "/estilos.css", "/comun.js", "/logo.png", "/icono-192.png", "/icono-512.png", "/manifest.webmanifest"
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.pathname.startsWith("/api/") || u.pathname.startsWith("/archivo/")) return;
  if (e.request.mode === "navigate" || u.pathname.endsWith(".html") || u.pathname === "/") {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html"))));
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((resp) => {
    const cp = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return resp;
  })));
});
