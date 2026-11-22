import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CookieJar } from 'tough-cookie';

const MAX_TEXT = 8 * 1024 * 1024;
const TEXT = /(?:text\/|javascript|json|xml|svg|mpegurl)/i;
const REQUEST_HEADERS = ['accept', 'accept-language', 'authorization', 'origin', 'referer', 'user-agent'];
const RESPONSE_HEADERS = ['content-type', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
const POLICY_HEADERS = ['content-security-policy', 'x-frame-options', 'cross-origin-resource-policy'];

// These values originate in the PC browser, never in a TV request.
export function sessionHeaders(headers) {
  return Object.fromEntries(REQUEST_HEADERS.filter(name => headers[name]).map(name => [name, headers[name]]));
}

export function validRange(value) {
  return typeof value === 'string' && value.length < 100 && /^bytes=(?:\d+-\d*|-\d+)$/.test(value);
}

async function updateCookies(context, url, lines) {
  const jar = new CookieJar(undefined, { prefixSecurity: 'strict' });
  const cookies = [];
  for (const line of lines) {
    // A partitioned cookie cannot be safely converted into an ordinary cookie.
    if (/;\s*partitioned(?:;|$)/i.test(line)) continue;
    const cookie = await jar.setCookie(line, url, { ignoreError: true });
    if (!cookie) continue;
    const expiry = cookie.expiryTime();
    cookies.push({ name: cookie.key, value: cookie.value,
      domain: cookie.hostOnly ? cookie.domain : '.' + cookie.domain, path: cookie.path,
      expires: expiry === Infinity ? -1 : Math.max(1, Math.floor(expiry / 1000)),
      httpOnly: Boolean(cookie.httpOnly), secure: Boolean(cookie.secure),
      ...(cookie.sameSite ? { sameSite: cookie.sameSite[0].toUpperCase() + cookie.sameSite.slice(1) } : {}),
    });
  }
  if (cookies.length) await context.addCookies(cookies);
}

// Stream an already observed, same-origin asset using the PC's current session.
// The caller owns URL authorization and approval. Redirects never carry credentials
// to another URL; the PC must observe and approve the new destination first.
export async function proxyResource({ request, response, resource, context, controller, active, rewrite, failAuth }) {
  let idleTimer;
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(), 30000); idleTimer.unref(); };
  const abort = () => controller.abort();
  response.once('close', abort);
  const guard = setInterval(() => { if (!active()) abort(); }, 500);
  guard.unref();
  touch();
  try {
    const cookies = await context.cookies(resource.url);
    if (!active() || controller.signal.aborted) throw new Error('Display changed');
    const headers = { ...resource.requestHeaders, 'accept-encoding': 'identity' };
    if (cookies.length) headers.cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    if (request.headers.range) headers.range = request.headers.range;
    if (request.headers['if-range']?.length < 256) headers['if-range'] = request.headers['if-range'];
    const upstream = await fetch(resource.url, { method: request.method, headers, redirect: 'manual', signal: controller.signal });
    touch();
    if (!active()) throw new Error('Display changed');
    if ([401, 403].includes(upstream.status) || (upstream.status >= 300 && upstream.status < 400)) {
      failAuth();
      throw new Error('Session or destination changed');
    }
    await updateCookies(context, resource.url, upstream.headers.getSetCookie());
    if (!active() || controller.signal.aborted) throw new Error('Display changed');
    if (upstream.status === 416) {
      if (upstream.headers.has('content-range')) response.setHeader('Content-Range', upstream.headers.get('content-range'));
      response.writeHead(416); response.end(); return;
    }
    if (!upstream.ok) throw new Error('Upstream asset unavailable');
    const type = upstream.headers.get('content-type') || '';
    // A login page must not be streamed as if it were an image or a video.
    if (/text\/html|application\/xhtml\+xml/i.test(type)) {
      failAuth();
      throw new Error('Asset redirected to HTML');
    }
    for (const name of RESPONSE_HEADERS) if (upstream.headers.has(name)) response.setHeader(name, upstream.headers.get(name));
    for (const name of POLICY_HEADERS) if (upstream.headers.has(name)) response.setHeader(name, rewrite(upstream.headers.get(name)));
    if (TEXT.test(type)) {
      if (upstream.status === 206) throw new Error('Partial text cannot be rewritten');
      const chunks = [];
      let length = 0;
      if (upstream.body) for await (const chunk of upstream.body) {
        touch();
        if (!active()) throw new Error('Display changed');
        length += chunk.length;
        if (length > MAX_TEXT) throw new Error('Text asset is too large');
        chunks.push(chunk);
      }
      const body = Buffer.from(rewrite(Buffer.concat(chunks).toString('utf8')));
      // Rewriting changes byte offsets and validators.
      for (const name of ['etag', 'last-modified', 'accept-ranges']) response.removeHeader(name);
      if (request.method !== 'HEAD') response.setHeader('Content-Length', body.length);
      response.writeHead(upstream.status);
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    // fetch decompresses response bodies, so an encoded length is not reusable.
    if (!upstream.headers.has('content-encoding') && upstream.headers.has('content-length')) {
      response.setHeader('Content-Length', upstream.headers.get('content-length'));
    }
    response.writeHead(upstream.status);
    if (!upstream.body || request.method === 'HEAD') { response.end(); return; }
    await pipeline(Readable.fromWeb(upstream.body), new Transform({
      transform(chunk, encoding, callback) {
        touch();
        callback(active() ? null : new Error('Display changed'), chunk);
      },
    }), response, { signal: controller.signal });
  } finally {
    clearTimeout(idleTimer);
    clearInterval(guard);
    response.removeListener('close', abort);
    controller.abort();
  }
}
