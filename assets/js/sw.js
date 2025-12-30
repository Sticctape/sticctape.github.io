/* Service Worker for The Streeters */

const CACHE_VERSION = 'v1';
const ROUTES = ['about', 'contact', 'cocktails', 'inventory', 'staff-orders'];

// Install event: cache assets
self.addEventListener('install', event => {
  self.skipWaiting(); // Activate immediately
});

// Activate event: clean up old caches
self.addEventListener('activate', event => {
  self.clients.claim(); // Take control of clients immediately
});

// Handle navigation requests: rewrite extensionless paths to .html for prod
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle top-level navigations
  if (request.mode === 'navigate') {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+|\/+$/g, '');

    // Root -> serve index.html as-is
    if (!path || path === 'index.html' || path === 'index') return;

    // If already ends with .html, just let it continue
    if (path.endsWith('.html')) return;

    // If the path matches one of our site routes, rewrite to the .html file
    if (ROUTES.includes(path)) {
      const rewritten = new URL(url.href);
      rewritten.pathname = `/${path}.html`;
      event.respondWith(fetch(rewritten.href));
    }
  }
});

// Handle notification clicks
self.addEventListener('notificationclick', event => {
  event.notification.close();
  
  // Open/focus the app window
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      // Check if there's already a window open
      for (let client of clientList) {
        if ((client.url === '/' || client.url.endsWith('/')) && 'focus' in client) {
          return client.focus();
        }
      }
      // If not, open a new window
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

// Handle notification close
self.addEventListener('notificationclose', event => {
  // Optional: track when users dismiss notifications
});
