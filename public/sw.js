// MonasFIT Salud: recibe los avisos del móvil (notificaciones push)
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : "" }; }
  var o = { body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png", data: { url: d.url || "/#mi-equipo" } };
  if (d.tag) { o.tag = d.tag; o.renotify = true; }
  e.waitUntil(self.registration.showNotification(d.title || "MonasFIT Salud", o));
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var u = (e.notification.data && e.notification.data.url) || "/#mi-equipo";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (l) {
    for (var i = 0; i < l.length; i++) {
      if ("focus" in l[i]) { if (l[i].navigate) { try { l[i].navigate(u); } catch (x) {} } return l[i].focus(); }
    }
    return self.clients.openWindow(u);
  }));
});
