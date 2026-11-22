import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.js';

async function until(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out: ' + label);
}

test('PC gateway plays native video, streams large authenticated media and revokes live transfers', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'queue-gateway-'));
  const browser = await chromium.launch({ headless: true });
  const app = await createApplication({ dataDirectory: directory, browser: { headless: true } });
  const large = Buffer.alloc(10 * 1024 * 1024, 87);
  let secret = 'first';
  let rotate = false;
  let redirect = false;
  let unauthorized = false;
  let trapCalls = 0;
  let slowClosed = 0;
  let mediaCalls = 0;
  let video;
  const trap = http.createServer((req, res) => { trapCalls++; res.end('must not reach'); });
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://upstream.test');
    if (unauthorized || !req.headers.cookie?.split('; ').includes('session=' + secret)) { res.writeHead(401); res.end('login required'); return; }
    if (url.pathname === '/display') {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      return res.end('<!doctype html><body data-ready><h1>Gateway</h1><video id="movie" muted autoplay loop src="/movie.webm"></video>');
    }
    if (url.pathname === '/bearer.bin' && req.headers.authorization !== 'Bearer pc-only') { res.writeHead(403); return res.end(); }
    if (url.pathname === '/redirect.bin' && redirect) {
      res.writeHead(302, { Location: `http://127.0.0.1:${trap.address().port}/private` }); return res.end();
    }
    if (rotate && url.pathname === '/large.bin') {
      rotate = false; secret = 'second';
      res.setHeader('Set-Cookie', ['session=second; Path=/; HttpOnly; SameSite=Lax', 'temporary=; Path=/; Max-Age=0', 'foreign=bad; Domain=other.test; Path=/']);
    }
    mediaCalls++;
    res.setHeader('Content-Type', url.pathname === '/movie.webm' ? 'video/webm' : 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (url.pathname === '/slow.bin' && !req.headers.range) {
      res.writeHead(200);
      const timer = setInterval(() => res.write(Buffer.alloc(65536, 1)), 20);
      res.once('close', () => { clearInterval(timer); slowClosed++; });
      return;
    }
    const body = url.pathname === '/movie.webm' ? video : large;
    let start = 0; let end = body.length - 1;
    if (req.headers.range) {
      const match = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416); return res.end(); }
      if (!match[1]) start = Math.max(0, body.length - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }); return res.end(); }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`);
    }
    res.setHeader('Content-Length', end - start + 1);
    res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
  });
  t.after(async () => {
    await browser.close(); await app.close();
    await Promise.all([upstream, trap].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    await rm(directory, { recursive: true, force: true });
  });
  // Generate a real, small movie using Chromium; no external fixtures or codecs.
  const generator = await browser.newPage();
  video = Buffer.from(await generator.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    const context = canvas.getContext('2d'); const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = []; recorder.ondataavailable = e => chunks.push(e.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    let color = 0;
    const timer = setInterval(() => { context.fillStyle = `rgb(${color++ % 2 ? 200 : 10},30,60)`; context.fillRect(0, 0, 64, 64); }, 50);
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 700)); recorder.stop(); await stopped;
    clearInterval(timer); stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  }));
  await generator.close();
  await Promise.all([upstream, trap].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const { port } = await app.listen(0, '127.0.0.1');
  await app.store.updateDevice('1', { mode: 'direct', enabled: true, url: origin + '/display', readySelector: '[data-ready]' });
  await app.manager.ensureBrowser();
  await app.manager.context.addCookies([{ name: 'session', value: secret, url: origin, httpOnly: true }, { name: 'temporary', value: 'remove-me', url: origin }]);
  await app.manager.start('1');
  await until(() => app.direct.ready('1'), 'approved source');
  const source = app.manager.displays.get('1').page;
  const observe = async (pathname, headers = {}) => {
    await source.evaluate(async ({ pathname, headers }) => { await (await fetch(pathname, { headers: { Range: 'bytes=0-15', ...headers } })).arrayBuffer(); }, { pathname, headers });
    await until(() => [...app.direct.entries.get('1').assets.values()].some(asset => asset.url === origin + pathname), 'observed ' + pathname);
  };
  for (const pathname of ['/large.bin', '/slow.bin', '/redirect.bin']) await observe(pathname);
  await observe('/bearer.bin', { Authorization: 'Bearer pc-only' });
  const receiver = await browser.newPage();
  const requests = [];
  receiver.on('request', req => requests.push(req.url()));
  await receiver.goto(`http://127.0.0.1:${port}/tv/1`);
  const movie = receiver.frameLocator('#page').locator('#movie');
  await until(async () => movie.evaluate(el => el.currentTime > 0.1 && el.videoWidth === 64).catch(() => false), 'native video plays');
  assert.equal((await receiver.context().cookies()).length, 0, 'website cookies never reach the TV');
  assert.equal(requests.some(url => /frame\.jpg|video\/offer/.test(url)), false);
  const local = new URL(receiver.url()).origin;

  let result = await fetch(local + '/large.bin', { headers: { Range: 'bytes=1024-2047', Cookie: 'session=attacker', Authorization: 'Bearer attacker' } });
  assert.equal(result.status, 206); assert.equal(result.headers.get('content-range'), `bytes 1024-2047/${large.length}`);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), large.subarray(1024, 2048));
  assert.equal(result.headers.get('set-cookie'), null);
  result = await fetch(local + '/large.bin', { headers: { Range: 'bytes=-16' } });
  assert.equal(result.status, 206); assert.equal((await result.arrayBuffer()).byteLength, 16);
  result = await fetch(local + '/large.bin', { headers: { Range: `bytes=${large.length}-` } });
  assert.equal(result.status, 416); assert.equal(result.headers.get('content-range'), `bytes */${large.length}`);
  const before = mediaCalls;
  assert.equal((await fetch(local + '/large.bin', { headers: { Range: 'bytes=0-1,3-4' } })).status, 416);
  assert.equal((await fetch(local + '/unobserved.bin')).status, 404);
  assert.equal(mediaCalls, before, 'invalid or unobserved requests do not reach upstream');
  result = await fetch(local + '/large.bin', { method: 'HEAD' });
  assert.equal(Number(result.headers.get('content-length')), large.length); assert.equal(await result.text(), '');
  result = await fetch(local + '/large.bin');
  assert.equal((await result.arrayBuffer()).byteLength, large.length, 'files above 8 MiB stream completely');
  assert.ok(app.direct.entries.get('1').bytes < 10000, 'large media is not retained in the response cache');
  result = await fetch(local + '/bearer.bin', { headers: { Range: 'bytes=0-15', Authorization: 'Bearer tv' } });
  assert.equal(result.status, 206); await result.arrayBuffer();

  rotate = true;
  result = await fetch(local + '/large.bin', { headers: { Range: 'bytes=0-15' } });
  assert.equal(result.status, 206); assert.equal(result.headers.get('set-cookie'), null); await result.arrayBuffer();
  const cookies = await app.manager.context.cookies(origin);
  assert.equal(cookies.find(cookie => cookie.name === 'session').value, 'second');
  assert.equal(cookies.find(cookie => cookie.name === 'session').httpOnly, true);
  assert.equal(cookies.some(cookie => cookie.name === 'temporary'), false, 'expired response cookies are removed');
  assert.equal((await app.manager.context.cookies()).some(cookie => cookie.name === 'foreign'), false);
  result = await fetch(local + '/large.bin', { headers: { Range: 'bytes=0-15' } });
  assert.equal(result.status, 206); await result.arrayBuffer();

  result = await fetch(local + '/slow.bin');
  const cancelled = result.body.getReader(); await cancelled.read(); await cancelled.cancel();
  await until(() => slowClosed === 1 && app.direct.snapshot('1').activeTransfers === 0, 'disconnected TV releases upstream');
  result = await fetch(local + '/slow.bin');
  const reader = result.body.getReader(); await reader.read();
  await source.evaluate(() => document.body.removeAttribute('data-ready'));
  await until(() => !app.direct.ready('1'), 'approval revoked');
  await assert.rejects(async () => { while (!(await reader.read()).done) {} });
  await until(() => slowClosed === 2, 'approval loss closes upstream');
  await source.evaluate(() => document.body.setAttribute('data-ready', ''));
  await until(() => app.direct.ready('1'), 'approval restored');

  redirect = true;
  assert.equal((await fetch(local + '/redirect.bin')).status, 503);
  assert.equal(trapCalls, 0, 'redirects never forward the session to an unobserved destination');
  assert.equal(app.direct.ready('1'), false);
  redirect = false;
  await app.manager.refresh('1');
  await until(() => app.direct.ready('1'), 'fresh approved page');
  assert.equal((await fetch(local + '/large.bin')).status, 404, 'navigation clears the old resource allowlist');
  await observe('/large.bin');
  unauthorized = true;
  assert.equal((await fetch(local + '/large.bin')).status, 503);
  assert.equal(app.direct.ready('1'), false, 'expired media session withholds the whole display');
  await receiver.locator('#notice').waitFor({ state: 'visible' });
});
