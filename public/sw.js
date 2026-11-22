// The controller always uses live server state. No admin pages, API responses,
// previews, tokens, or TV resources are cached by this service worker.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || new URL(event.request.url).pathname !== '/') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#087f72"><title>Queue TV Manager</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6f9;color:#182b3a;font:16px Segoe UI,sans-serif"><main style="padding:32px;text-align:center"><h1>PC service is offline</h1><p>Start Queue TV Manager on this PC, then reload this window.</p><button onclick="location.reload()" style="padding:10px 18px">Retry</button></main></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  )));
});
