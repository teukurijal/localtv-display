import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ConfigStore, InputError, validateDevice } from './config.js';
import { BrowserManager } from './browser-manager.js';
import { VideoManager } from './video-manager.js';
import { DirectManager } from './direct-manager.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const assets = new Map([
  ['/assets/admin.js', ['admin.js', 'text/javascript']],
  ['/assets/style.css', ['style.css', 'text/css']],
  ['/assets/app-icon.svg', ['app-icon.svg', 'image/svg+xml']],
  ['/assets/app-icon-192.png', ['app-icon-192.png', 'image/png']],
  ['/assets/app-icon-512.png', ['app-icon-512.png', 'image/png']],
  ['/assets/video-receiver.js', ['video-receiver.js', 'text/javascript']],
  ['/assets/receiver.js', ['receiver.js', 'text/javascript']],
  ['/assets/receiver.css', ['receiver.css', 'text/css']],
  ['/assets/demo.js', ['demo.js', 'text/javascript']],
]);

export function isLocalAdmin(request) {
  const address = request.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
  try {
    const host = new URL(`http://${request.headers.host}`);
    if (!localHosts.has(host.hostname) || (host.port || '80') !== String(request.socket.localPort)) return false;
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    if (request.headers.origin && request.headers.origin !== host.origin) return false;
    return true;
  } catch { return false; }
}

function requireLocal(request) {
  if (!isLocalAdmin(request)) throw new InputError('Open the admin panel on the PC at http://localhost:PORT/. TV receivers use /tv/1, /tv/2 or /tv/3.', 403);
}

async function jsonBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new InputError('Use application/json.', 415);
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 16384) throw new InputError('Request is too large.', 413);
  }
  try {
    const value = JSON.parse(text || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new InputError('Invalid JSON body.'); }
}

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type });
  response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function demoPage(id) {
  const names = ['Poli Umum', 'Poli Anak', 'Poli Gigi'];
  names[Number(id) - 1] ||= `Queue ${id}`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${names[Number(id) - 1]} · Demo</title><link rel="stylesheet" href="/assets/style.css"></head><body class="demo-board" data-queue-ready data-demo-id="${id}"><header><span>QUEUE TV / DEMO</span><span id="clock"></span></header><main><p>SELAMAT DATANG</p><h1>${names[Number(id) - 1]}</h1><div class="queue-number" id="queue-number">${['A', 'B', 'C'][Number(id) - 1] || 'Q'}-00${id}</div><h2>Silakan menuju ruang pemeriksaan</h2><p>This is a demo display. No patient information.</p></main><footer>TV ${id} · Live demo clock · One shared browser session</footer><script src="/assets/demo.js"></script></body></html>`;
}

export async function createApplication(options = {}) {
  const directory = options.dataDirectory || process.env.QUEUE_DATA_DIR || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'QueueTVManager')
    : path.join(os.homedir(), '.local', 'share', 'queue-tv-manager'));
  const store = options.store || new ConfigStore(directory);
  await store.load();
  const manager = options.manager || new BrowserManager(store, options.browser);
  const video = new VideoManager(manager, () => `http://127.0.0.1:${server.address().port}`, options.browser);
  const token = randomBytes(32).toString('hex');
  const receivers = new Map(store.value.devices.map(device => [device.id, { lastSeen: null, revision: 0 }]));
  const direct = new DirectManager(manager, store, id => { const receiver = receivers.get(id); receiver.lastSeen = Date.now(); return receiver; });
  manager.options.onUnavailable = id => { video.invalidate(id); direct.abort(id); };
  manager.options.onPage = (id, page) => direct.attach(id, page);
  let queue = Promise.resolve();
  function mutate(action) {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next;
  }
  function authenticate(request) {
    requireLocal(request);
    const supplied = request.headers['x-admin-token'];
    if (typeof supplied !== 'string' || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      throw new InputError('Admin session expired. Reload this page.', 401);
    }
    if (request.method !== 'GET' && request.headers.origin !== `http://${request.headers.host}`) throw new InputError('Invalid request origin.', 403);
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'");
    try {
      const url = new URL(request.url, 'http://localhost');
      const pathname = url.pathname;
      const method = request.method;
      if (method === 'GET' && pathname === '/health') return send(response, 200, { ok: true });
      if (method === 'GET' && pathname === '/manifest.webmanifest') {
        requireLocal(request);
        return send(response, 200, await readFile(path.join(root, 'public', 'manifest.webmanifest')), 'application/manifest+json; charset=utf-8');
      }
      if (method === 'GET' && pathname === '/sw.js') {
        requireLocal(request);
        return send(response, 200, await readFile(path.join(root, 'public', 'sw.js')), 'text/javascript; charset=utf-8');
      }
      if (method === 'GET' && assets.has(pathname)) {
        if (pathname === '/assets/admin.js' || pathname === '/assets/demo.js' || pathname.startsWith('/assets/app-icon')) requireLocal(request);
        const [file, type] = assets.get(pathname);
        return send(response, 200, await readFile(path.join(root, 'public', file)), type.startsWith('image/png') ? type : `${type}; charset=utf-8`);
      }
      if (method === 'GET' && /^\/tv\/\d+\/?$/.test(pathname)) {
        const id = pathname.split('/')[2];
        store.device(id);
        if (store.device(id).mode === 'direct' && url.searchParams.get('mode') !== 'stream') {
          const port = await direct.start(id);
          const location = new URL(`http://${request.headers.host}`);
          location.port = String(port);
          location.pathname = '/__queue/view';
          response.writeHead(302, { Location: location.href });
          return response.end();
        }
        return send(response, 200, await readFile(path.join(root, 'public', 'receiver.html')), 'text/html; charset=utf-8');
      }
      if (method === 'GET' && pathname === '/internal/video') {
        requireLocal(request);
        return send(response, 200, '<!doctype html><html><head><title>Video encoder</title></head><body></body></html>', 'text/html; charset=utf-8');
      }
      const videoRoute = pathname.match(/^\/api\/tv\/(\d+)\/video\/(offer|close)$/);
      if (method === 'POST' && videoRoute) {
        if (request.headers.origin !== `http://${request.headers.host}`) throw new InputError('Invalid request origin.', 403);
        const body = await jsonBody(request);
        const [, id, action] = videoRoute;
        store.device(id);
        if (action === 'offer') return send(response, 200, await video.offer(id, body));
        video.release(id, body.session);
        return send(response, 200, { ok: true });
      }
      const tvRoute = pathname.match(/^\/api\/tv\/(\d+)\/(status|frame\.jpg)$/);
      if (method === 'GET' && tvRoute) {
        const [, id, action] = tvRoute;
        store.device(id);
        if (action === 'status') {
          const receiver = receivers.get(id);
          receiver.lastSeen = Date.now();
          const state = manager.snapshot(id);
          return send(response, 200, { mode: store.device(id).mode, name: store.device(id).name, state: state.state, available: state.frameAvailable, revision: receiver.revision, video: url.searchParams.has('video') ? video.touch(id, url.searchParams.get('video')) : true, interval: Math.round(1000 / store.value.fps) });
        }
        const frame = manager.frame(id);
        return frame ? send(response, 200, frame, 'image/jpeg') : send(response, 503, { error: 'Display is not available.' });
      }
      if (pathname.startsWith('/demo/')) {
        requireLocal(request);
        // Preserve the same-origin form Origin; no-referrer turns it into "null".
        response.setHeader('Referrer-Policy', 'same-origin');
        if (pathname === '/demo/login' && method === 'GET') {
          return send(response, 200, '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Queue TV demo login</title><link rel="stylesheet" href="/assets/style.css"></head><body class="login-page"><main class="panel"><p class="eyebrow">LOCAL DEMO</p><h1>One login. Three displays.</h1><p>This simulates a shared queue-site session. No credentials are required.</p><form method="post" action="/demo/login"><button type="submit">Sign in to demo</button></form></main></body></html>', 'text/html; charset=utf-8');
        }
        if (pathname === '/demo/login' && method === 'POST') {
          if (request.headers.origin !== `http://${request.headers.host}`) throw new InputError('Invalid request origin.', 403);
          response.writeHead(303, { 'Set-Cookie': 'queue-demo=authenticated; Path=/demo; HttpOnly; SameSite=Strict; Max-Age=2592000', Location: '/demo/queue/1' });
          return response.end();
        }
        const match = pathname.match(/^\/demo\/queue\/(\d+)$/);
        if (match && method === 'GET') {
          if (!request.headers.cookie?.split(';').some(item => item.trim() === 'queue-demo=authenticated')) {
            response.writeHead(302, { Location: '/demo/login' });
            return response.end();
          }
          return send(response, 200, demoPage(match[1]), 'text/html; charset=utf-8');
        }
      }
      if (pathname === '/' && method === 'GET') {
        requireLocal(request);
        return send(response, 200, await readFile(path.join(root, 'public', 'index.html')), 'text/html; charset=utf-8');
      }
      if (pathname === '/api/admin/session' && method === 'GET') {
        requireLocal(request);
        return send(response, 200, { token });
      }
      if (pathname.startsWith('/api/admin/')) {
        authenticate(request);
        if (pathname === '/api/admin/state' && method === 'GET') {
          const port = server.address().port;
          const addresses = Object.values(os.networkInterfaces()).flat().filter(address => address.family === 'IPv4' && !address.internal).map(address => `http://${address.address}:${port}`);
          return send(response, 200, {
            config: store.value, browser: { running: Boolean(manager.context), error: manager.lastError }, addresses,
            stats: { uptimeSeconds: Math.floor(process.uptime()), serverMemoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024) },
            devices: store.value.devices.map(device => ({ id: device.id, ...manager.snapshot(device.id), direct: direct.snapshot(device.id), ...receivers.get(device.id), connected: Date.now() - (receivers.get(device.id).lastSeen || 0) < 12000 })),
          });
        }
        const preview = pathname.match(/^\/api\/admin\/devices\/(\d+)\/preview\.jpg$/);
        if (preview && method === 'GET') {
          const frame = manager.frame(preview[1], true);
          return frame ? send(response, 200, frame, 'image/jpeg') : send(response, 404, { error: 'No preview yet.' });
        }
        if (method !== 'POST') throw new InputError('Route not found.', 404);
        const body = await jsonBody(request);
        await mutate(async () => {
          if (pathname === '/api/admin/settings') {
            await store.save({ ...store.value, ...store.settings(body) });
          } else if (pathname === '/api/admin/browser/login') {
            await manager.openLogin();
          } else if (pathname === '/api/admin/demo') {
            if (store.value.devices.some(device => device.url)) throw new InputError('Demo setup is available only while all three display URLs are empty.', 409);
            const origin = `http://127.0.0.1:${server.address().port}`;
            await store.save({ ...store.value, loginUrl: `${origin}/demo/login`, devices: store.value.devices.map(device => ({ ...device, url: `${origin}/demo/queue/${device.id}`, readySelector: '[data-queue-ready]' })) });
          } else if (pathname === '/api/admin/devices') {
            if (store.value.devices.length >= 100) throw new InputError('Maximum 100 displays.');
            const id = String(Math.max(0, ...store.value.devices.map(device => Number(device.id))) + 1);
            const device = validateDevice({ name: body.name || `TV ${id}`, url: '', mode: 'stream', readySelector: '', resolution: '1080p', refreshSeconds: 0 }, id);
            await store.save({ ...store.value, devices: [...store.value.devices, device] });
            manager.addDevice(id);
            receivers.set(id, { lastSeen: null, revision: 0 });
          } else {
            const deviceRoute = pathname.match(/^\/api\/admin\/devices\/(\d+)\/(configure|start|stop|refresh|approve|reconnect)$/);
            if (!deviceRoute) throw new InputError('Route not found.', 404);
            const [, id, action] = deviceRoute;
            if (action === 'configure') {
              const current = store.device(id);
              const next = validateDevice(body, id, current.enabled);
              if (current.enabled && !next.url) throw new InputError('Stop the display before clearing its URL.');
              if (next.mode === 'direct') await direct.start(id);
              const sourceChanged = ['url', 'readySelector', 'resolution', 'refreshSeconds'].some(key => current[key] !== next[key]);
              if (sourceChanged) await manager.stop(id);
              await store.updateDevice(id, next);
              if (sourceChanged && current.enabled) await manager.start(id);
              if (next.mode === 'direct') video.invalidate(id);
              else direct.abort(id);
            } else if (action === 'start') {
              if (!store.device(id).url) throw new InputError('Save a display URL first.');
              await store.updateDevice(id, { enabled: true });
              await manager.start(id);
            } else if (action === 'stop') {
              await store.updateDevice(id, { enabled: false });
              await manager.stop(id);
            } else if (action === 'refresh') {
              await manager.refresh(id);
            } else if (action === 'approve') {
              await manager.approve(id);
            } else if (action === 'reconnect') {
              receivers.get(id).revision += 1;
            }
          }
        });
        return send(response, 200, { ok: true });
      }
      throw new InputError('Route not found.', 404);
    } catch (error) {
      if (!response.headersSent) send(response, error instanceof InputError ? error.status : 500, { error: error instanceof InputError ? error.message : 'The operation failed. Check the service and try again.' });
      else response.end();
    }
  });
  server.requestTimeout = 45000;
  server.headersTimeout = 10000;
  return {
    server, store, manager, video, direct,
    async listen(port = 8443, host = '0.0.0.0') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      direct.adminPort = server.address().port;
      direct.basePort = port === 0 ? 0 : server.address().port;
      direct.host = host;
      return server.address();
    },
    async close() {
      server.closeIdleConnections();
      const closed = new Promise(resolve => server.close(resolve));
      await queue;
      await direct.close();
      await video.close();
      await manager.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let app;
  try {
    const { values } = parseArgs({ options: { port: { type: 'string' } } });
    const portValue = values.port ?? process.env.PORT ?? '8443';
    const port = Number(portValue);
    if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535.');
    app = await createApplication();
    await app.listen(port, process.env.HOST || '0.0.0.0');
    console.log(`Queue TV Manager\nAdmin on this PC: http://localhost:${port}\nTV receivers: http://<PC-LAN-IP>:${port}/tv/1 (also /tv/2 and /tv/3)`);
    app.manager.restore().catch(() => app.manager.scheduleRecovery());
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? 'Port is already in use. Close the other service or choose a different PORT.' : error.message);
    await app?.close();
    process.exitCode = 1;
  }
}
