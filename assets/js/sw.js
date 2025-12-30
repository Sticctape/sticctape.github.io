/* Service Worker for The Streeters */

const CACHE_VERSION = 'v1';

// Install event: cache assets
self.addEventListener('install', event => {
  self.skipWaiting(); // Activate immediately
});

// Activate event: clean up old caches
self.addEventListener('activate', event => {
  self.clients.claim(); // Take control of clients immediately
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
