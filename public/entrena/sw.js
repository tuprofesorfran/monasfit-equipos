// MonasFIT ENTRENA: funciona sin conexión una vez abierta (página, catálogo y GIF ya vistos)
var C = "mfe-v1";
self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(C).then(function (c) { return c.addAll(["/entrena/", "/entrena/cat.json"]); }).catch(function () {}));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (k) { return Promise.all(k.filter(function (n) { return n !== C; }).map(function (n) { return caches.delete(n); })); }).then(function () { return self.clients.claim(); }));
});
function put(req, res) { try { if (res && (res.ok || res.type === "opaque")) { var c = res.clone(); caches.open(C).then(function (ca) { ca.put(req, c); }); } } catch (e) {} return res; }
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var u = new URL(req.url);
  if (u.origin === location.origin && u.pathname.indexOf("/entrena/") === 0) {
    if (req.mode === "navigate") {
      e.respondWith(fetch(req).then(function (r) { return put("/entrena/", r); }).catch(function () { return caches.match("/entrena/"); }));
    } else {
      e.respondWith(caches.match(req).then(function (m) {
        var net = fetch(req).then(function (r) { return put(req, r); }).catch(function () { return m; });
        return m || net;
      }));
    }
    return;
  }
  if (u.hostname === "monasfit.netlify.app" && u.pathname.indexOf("/gif/") === 0) {
    e.respondWith(caches.match(u.href).then(function (m) {
      if (m) return m;
      return fetch(u.href, { mode: "cors" }).then(function (r) { return put(u.href, r); })
        .catch(function () { return fetch(req).then(function (r) { return put(u.href, r); }); });
    }));
  }
});
