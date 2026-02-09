// Claw'd PWA Service Worker
// Phase 1: Basic notifications when tab is backgrounded
// Phase 2: Offline caching (future)

const CACHE_NAME = "clawd-v1";

// Install event - precache app shell
self.addEventListener("install", (event) => {
  console.log("[SW] Installing service worker");
  // Skip waiting to activate immediately
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating service worker");
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
      })
      .then(() => {
        // Take control of all open tabs immediately
        return self.clients.claim();
      }),
  );
});

// Fetch event - network-first strategy (no offline caching in Phase 1)
self.addEventListener("fetch", (event) => {
  // Pass through all requests to network (Phase 1 - no caching)
  // In Phase 2, we'll add app shell caching for offline support
});

// Handle notification click - focus or open the app
self.addEventListener("notificationclick", (event) => {
  console.log("[SW] Notification clicked");
  event.notification.close();

  // Get the URL to open (stored in notification data)
  const urlToOpen = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // If there's already a window open, focus it
      for (const client of clientList) {
        if (client.url.includes(urlToOpen) && "focus" in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(urlToOpen);
      }
    }),
  );
});

// Handle messages from the main thread
self.addEventListener("message", (event) => {
  if (event.data?.type === "SHOW_NOTIFICATION") {
    const { title, body, icon, badge, channel } = event.data;
    self.registration.showNotification(title, {
      body,
      icon: icon || "/clawd-192.png",
      badge: badge || "/clawd-192.png",
      tag: `clawd-${channel}`, // Group notifications by channel
      renotify: true, // Vibrate/sound even if replacing existing notification
      data: { url: `/${channel}` },
    });
  }
});
