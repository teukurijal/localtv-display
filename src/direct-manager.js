import http from 'node:http';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { InputError } from './config.js';
import { proxyResource, sessionHeaders, validRange } from './session-gateway.js';

const MAX_RESOURCE = 8 * 1024 * 1024;
const MAX_CACHE = 64 * 1024 * 1024;
const TYPES = new Set(['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'fetch', 'media']);
const TEXT = /(?:text\/|javascript|json|xml|svg)/i;
const ASSETS = new Set(['script', 'stylesheet', 'image', 'font', 'media']);
const digest = body => createHash('sha256').update(body || '').digest('hex');

// Only numeric jQuery/ExtJS cache-busters are ignored. Other parameters and POST bodies
// must match requests actually made by this display's authenticated PC page.
export function requestKey(method, input, body = Buffer.alloc(0)) {
  const url = new URL(input);
  for (const key of ['_', '_dc']) if (/^\d+$/.test(url.searchParams.get(key) || '')) url.searchParams.delete(key);
  url.searchParams.sort();
  return `${method === 'HEAD' ? 'GET' : method} ${url.origin}${url.pathname}${url.search} ${digest(body)}`;
}

export function rewriteText(text, upstream, local) {
  return text.split(upstream).join(local)
    .split(upstream.replaceAll('/', '\\/')).join(local.replaceAll('/', '\\/'))
    .split('//' + new URL(upstream).host).join('//' + new URL(local).host);
}

function freshEntry(page, url) {
  return { page, url, resources: new Map(), assets: new Map(), requests: new WeakMap(), transfers: new Set(),
    generation: 0, documentReady: false, bytes: 0, blocked: new Set(), pending: new Set(), sequence: 0, authFailed: 0, error: '' };
}

export class DirectManager {
  constructor(manager, store, seen) {
    this.manager = manager;
    this.store = store;
    this.seen = seen;
    this.entries = new Map();
    this.servers = new Map();
    this.starting = new Map();
    this.basePort = 0;
    this.adminPort = 0;
    this.host = '0.0.0.0';
    this.closing = false;
  }

  attach(id, page) {
    this.abort(id);
    const entry = freshEntry(page, this.store.device(id).url);
    this.entries.set(id, entry);
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        this.abort(id);
        entry.generation++;
        entry.documentReady = false;
        entry.resources.clear();
        entry.assets.clear();
        entry.blocked.clear();
        entry.bytes = 0;
      }
      entry.requests.set(request, entry.generation);
    });
    // Documents/data are shared from the approved PC page. GET assets/media are
    // proxied with its session; TV polling never replays queue-consumption POSTs.
    page.on('response', response => {
      if (entry.pending.size >= 64 || this.entries.get(id) !== entry) return;
      const operation = this.observe(id, entry, response).catch(() => {}).finally(() => entry.pending.delete(operation));
      entry.pending.add(operation);
    });
    page.on('websocket', () => { entry.error = 'This page uses WebSockets. Direct mode cannot relay WebSocket messages; use streaming if live data is missing.'; });
  }

  async observe(id, entry, response) {
    const request = response.request();
    const generation = entry.requests.get(request);
    const current = () => this.entries.get(id) === entry && generation === entry.generation && !this.closing;
    if (!current()) return;
    if (!['GET', 'POST'].includes(request.method()) || !TYPES.has(request.resourceType())) return;
    const url = new URL(response.url());
    const target = new URL(entry.url);
    // External public assets remain direct browser requests. No authenticated
    // third-party responses are exposed by this local origin.
    if (url.origin !== target.origin) return;
    if ([401, 403].includes(response.status()) && ['document', 'xhr', 'fetch', 'media'].includes(request.resourceType())) { this.failAuth(id, entry); return; }
    if (response.status() < 200 || response.status() >= 300) return;
    if (request.isNavigationRequest() && url.href !== target.href) return;
    const headers = response.headers();
    if (request.method() === 'GET' && (ASSETS.has(request.resourceType()) || /^(?:audio|video)\//i.test(headers['content-type'] || ''))) {
      if (/text\/html|application\/xhtml\+xml/i.test(headers['content-type'] || '')) return;
      const requestHeaders = sessionHeaders(await request.allHeaders());
      if (!current()) return;
      const resource = { url: url.href, requestHeaders, resourceType: request.resourceType() };
      // Preserve aliases from an observed same-origin redirect chain, while
      // fetching only its known, successful final destination.
      for (let source = request; source; source = source.redirectedFrom()) {
        if (source.method() !== 'GET' || new URL(source.url()).origin !== target.origin) break;
        const key = requestKey('GET', source.url());
        if (entry.assets.size >= 1500 && !entry.assets.has(key)) break;
        entry.assets.set(key, resource);
      }
      return; // Never buffer a complete movie in the browser response cache.
    }
    if (Number(headers['content-length'] || 0) > MAX_RESOURCE) return;
    const payload = request.postDataBuffer() || Buffer.alloc(0);
    if (payload.length > 65536) return;
    const key = requestKey(request.method(), url, payload);
    const sequence = ++entry.sequence;
    const body = await response.body();
    if (response.status() === 206) {
      const range = headers['content-range']?.match(/^bytes 0-(\d+)\/(\d+)$/);
      if (!range || Number(range[2]) !== body.length || Number(range[1]) + 1 !== body.length) return;
    }
    if (body.length > MAX_RESOURCE || !current()) return;
    if (/text\/html/i.test(headers['content-type'] || '') && /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(body.toString('utf8'))) { this.failAuth(id, entry); return; }
    if (request.isNavigationRequest() && sequence > entry.authFailed) {
      if (entry.authFailed) entry.error = '';
      entry.authFailed = 0;
    }
    if ((entry.resources.get(key)?.sequence || 0) > sequence) return;
    const previous = entry.resources.get(key);
    const bytes = entry.bytes - (previous?.body.length || 0) + body.length;
    if (bytes > MAX_CACHE || (!previous && entry.resources.size >= 1500)) {
      entry.error = 'The direct display resource limit was reached. Use streaming for this page.';
      return;
    }
    entry.bytes = bytes;
    entry.resources.set(key, { sequence, body, headers, status: response.status(), resourceType: request.resourceType(), url: url.href });
    if (request.isNavigationRequest()) entry.documentReady = true;
  }

  abort(id) {
    for (const controller of this.entries.get(id)?.transfers || []) controller.abort();
  }

  failAuth(id, entry) {
    if (this.entries.get(id) !== entry) return;
    entry.authFailed = ++entry.sequence;
    entry.error = 'The website session needs attention. Sign in on the PC and refresh this display.';
    const item = this.manager.displays.get(id);
    if (item?.page === entry.page) {
      this.manager.withhold(item);
      item.state = 'awaiting-approval';
      item.message = entry.error;
    }
  }

  ready(id) {
    const entry = this.entries.get(id);
    const item = this.manager.displays.get(id);
    const device = this.store.device(id);
    return !this.closing && device.mode === 'direct' && device.enabled && entry?.documentReady && !entry.authFailed && item?.page === entry.page && entry.page.url() === device.url && Boolean(this.manager.frame(id));
  }

  snapshot(id) {
    const entry = this.entries.get(id);
    return { port: this.servers.get(id)?.address()?.port || null, resources: (entry?.resources.size || 0) + (entry?.assets.size || 0),
      gatewayResources: entry?.assets.size || 0, activeTransfers: entry?.transfers.size || 0,
      error: entry?.error || '', blocked: [...(entry?.blocked || [])].slice(-5) };
  }

  async start(id) {
    this.store.device(id);
    if (this.closing) throw new InputError('Service is stopping.', 503);
    if (this.servers.has(id)) return this.servers.get(id).address().port;
    if (this.starting.has(id)) return this.starting.get(id);
    const operation = (async () => {
      const server = http.createServer((request, response) => this.handle(id, request, response));
      server.requestTimeout = 15000;
      const port = this.basePort ? this.basePort + Number(id) : 0;
      if (port > 65535) throw new InputError('Direct mode needs three ports above the admin port. Choose an admin port below 65533.');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, this.host, resolve); });
      if (this.closing) { server.close(); throw new InputError('Service is stopping.', 503); }
      this.servers.set(id, server);
      return server.address().port;
    })().catch(error => {
      if (error instanceof InputError) throw error;
      throw new InputError('Could not open the direct display port. Free the port above the admin port assigned to this TV, then retry.', 503);
    }).finally(() => this.starting.delete(id));
    this.starting.set(id, operation);
    return operation;
  }

  validHost(request) {
    try {
      const url = new URL('http://' + request.headers.host);
      const hosts = new Set(['localhost', '127.0.0.1', '[::1]', ...Object.values(os.networkInterfaces()).flat().filter(a => !a.internal).map(a => a.address)]);
      return hosts.has(url.hostname) && Number(url.port) === request.socket.localPort;
    } catch { return false; }
  }

  async handle(id, request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, body, type = 'text/plain; charset=utf-8') => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
    try {
      if (!this.validHost(request)) return send(403, 'Invalid display address.');
      const local = 'http://' + request.headers.host;
      if (request.headers.origin && request.headers.origin !== local) return send(403, 'Invalid request origin.');
      const url = new URL(request.url, local);
      if (url.origin !== local || request.headers['sec-fetch-site'] === 'cross-site') return send(403, 'Invalid request origin.');
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) return send(405, 'Method not allowed.');
      if (url.pathname.startsWith('/__queue/')) {
        if (request.method !== 'GET') return send(405, 'Method not allowed.');
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        if (url.pathname === '/__queue/status') {
          const receiver = this.seen(id);
          const target = this.store.device(id).url;
          const path = target ? new URL(target) : null;
          return send(200, JSON.stringify({ ready: Boolean(this.ready(id)), path: path ? path.pathname + path.search : '', revision: `${this.manager.displays.get(id)?.epoch || 0}:${receiver?.revision || 0}`, mode: this.store.device(id).mode, returnUrl: `http://${new URL(local).hostname}:${this.adminPort}/tv/${id}?mode=stream` }), 'application/json');
        }
        const files = { '/__queue/view': ['direct.html', 'text/html'], '/__queue/client.js': ['direct.js', 'text/javascript'], '/__queue/style.css': ['direct.css', 'text/css'] };
        if (!files[url.pathname]) return send(404, 'Not found.');
        const [file, type] = files[url.pathname];
        return send(200, await readFile(new URL('../public/' + file, import.meta.url)), type + '; charset=utf-8');
      }
      if (!this.ready(id)) return send(503, 'Display is unavailable. Check the login and approval on the PC.');
      const entry = this.entries.get(id);
      const epoch = this.manager.displays.get(id).epoch;
      const target = new URL(entry.url);
      // Retain upstream paths, but never accept a client-selected upstream host.
      const upstream = new URL(target.origin);
      upstream.pathname = url.pathname;
      upstream.search = url.search;
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 65536) return send(413, 'Request too large.');
        chunks.push(chunk);
      }
      const key = requestKey(request.method, upstream, Buffer.concat(chunks));
      let resource = entry.resources.get(key);
      let asset = entry.assets.get(key);
      // A newly discovered asset may still be downloading in the PC browser.
      if (!resource && !asset && entry.pending.size) {
        let timer;
        await Promise.race([Promise.allSettled([...entry.pending]), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
        clearTimeout(timer);
        resource = entry.resources.get(key);
        asset = entry.assets.get(key);
      }
      if (!this.ready(id) || this.entries.get(id) !== entry || this.manager.displays.get(id).epoch !== epoch) return send(503, 'Display changed.');
      if (asset) {
        if (request.headers.range && !validRange(request.headers.range)) return send(416, 'Unsupported byte range.');
        if (entry.transfers.size >= 16) return send(503, 'The gateway is busy. Retry shortly.');
        const controller = new AbortController();
        const generation = entry.generation;
        entry.transfers.add(controller);
        entry.blocked.delete(request.method + ' ' + url.pathname);
        try {
          await proxyResource({ request, response, resource: asset, controller, context: entry.page.context(),
            active: () => this.ready(id) && this.entries.get(id) === entry && entry.generation === generation && this.manager.displays.get(id).epoch === epoch,
            rewrite: text => rewriteText(text, target.origin, local), failAuth: () => this.failAuth(id, entry),
          });
        } finally { entry.transfers.delete(controller); }
        return;
      }
      if (!resource) {
        // Only paths are reported: request payloads and query tokens stay private.
        if (entry.blocked.size >= 20) entry.blocked.delete(entry.blocked.values().next().value);
        entry.blocked.add(request.method + ' ' + url.pathname);
        return send(404, 'This resource has not been observed on the approved PC display.');
      }
      entry.blocked.delete(request.method + ' ' + url.pathname);
      const type = resource.headers['content-type'] || 'application/octet-stream';
      let body = resource.body;
      if (TEXT.test(type)) body = Buffer.from(rewriteText(body.toString('utf8'), target.origin, local));
      // Never copy Set-Cookie, authentication headers, redirects or permissive
      // CORS headers. This origin cannot issue arbitrary authenticated requests.
      for (const name of ['content-security-policy', 'x-frame-options', 'cross-origin-resource-policy']) {
        if (resource.headers[name]) response.setHeader(name, resource.headers[name].split(/\r?\n/).filter(Boolean).map(value => rewriteText(value, target.origin, local)));
      }
      if (request.headers.range && !TEXT.test(type)) {
        const match = request.headers.range.match(/^bytes=(\d+)-(\d*)$/);
        if (!match) return send(416, 'Unsupported byte range.');
        const start = Number(match[1]);
        const end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
        if (start > end || start >= body.length) return send(416, 'Invalid byte range.');
        response.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`);
        response.setHeader('Accept-Ranges', 'bytes');
        body = body.subarray(start, end + 1);
        response.setHeader('Content-Length', body.length);
        return send(206, request.method === 'HEAD' ? undefined : body, type);
      }
      response.setHeader('Content-Length', body.length);
      return send(resource.status === 204 ? 204 : 200, request.method === 'HEAD' ? undefined : body, type);
    } catch {
      if (!response.destroyed && !response.headersSent) {
        for (const name of response.getHeaderNames()) if (!['cache-control', 'x-content-type-options', 'referrer-policy'].includes(name)) response.removeHeader(name);
        send(this.ready(id) ? 502 : 503, 'PC gateway unavailable. Check the PC display.');
      } else if (!response.writableEnded) response.destroy();
    }
  }

  async close() {
    this.closing = true;
    for (const id of this.entries.keys()) this.abort(id);
    await Promise.allSettled([...this.starting.values()]);
    await Promise.all([...this.servers.values()].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    this.entries.clear();
  }
}
