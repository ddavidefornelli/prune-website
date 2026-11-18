// prune's service worker: browser notifications only. It has no fetch
// handler and caches nothing, so the site behaves exactly as without it.
// Payloads are encrypted by the server for this browser (RFC 8291) and hold
// { title, body, url, tag }.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const SITE = self.location.origin;

/** Only links back into prune itself are opened. */
function safeUrl(value) {
  try {
    const url = new URL(value, SITE);
    return url.origin === SITE ? url.href : `${SITE}/`;
  } catch {
    return `${SITE}/`;
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 120) : "prune";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body.slice(0, 240) : "",
      icon: "/prune-icon.png",
      badge: "/prune-icon.png",
      tag: typeof data.tag === "string" ? data.tag : "prune",
      renotify: true,
      data: { url: safeUrl(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === SITE);
      if (open) {
        await open.focus();
        // Starting a task needs the page's own sign-in, so reload it at the link.
        if (target !== `${SITE}/` && "navigate" in open) await open.navigate(target);
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
