import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApplication, isLocalAdmin } from '../src/server.js';

test('admin access requires a loopback socket, loopback Host and same origin', () => {
  const request = (address, host, more = {}) => ({ socket: { remoteAddress: address, localPort: 8443 }, headers: { host, ...more } });
  assert.equal(isLocalAdmin(request('127.0.0.1', 'localhost:8443')), true);
  assert.equal(isLocalAdmin(request('::1', '[::1]:8443')), true);
  assert.equal(isLocalAdmin(request('192.168.1.9', 'localhost:8443', { 'x-forwarded-for': '127.0.0.1' })), false);
  assert.equal(isLocalAdmin(request('127.0.0.1', 'evil.example:8443')), false);
  assert.equal(isLocalAdmin(request('127.0.0.1', 'localhost:9999')), false);
  assert.equal(isLocalAdmin(request('127.0.0.1', 'localhost:8443', { origin: 'http://evil.example' })), false);
  assert.equal(isLocalAdmin(request('127.0.0.1', 'localhost:8443', { 'sec-fetch-site': 'cross-site' })), false);
});

test('HTTP endpoints isolate receiver data and reject unauthorized controls', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'queue-http-'));
  const app = await createApplication({ dataDirectory: directory, browser: { headless: true } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const request = (route, options) => fetch(base + route, options);
  const session = await (await request('/api/admin/session')).json();
  const post = (route, body, headers = {}) => request(route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Admin-Token': session.token, ...headers }, body: JSON.stringify(body) });
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/api/admin/state')).status, 401);
  const reboundStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/api/admin/session`, { headers: { Host: `attacker.test:${port}` } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await post('/api/admin/demo', {}, { Origin: 'http://attacker.test' })).status, 403);
  assert.equal((await post('/api/admin/demo', {}, { 'X-Admin-Token': 'wrong' })).status, 401);
  assert.equal((await request('/api/admin/devices/1/preview.jpg')).status, 401);
  assert.equal((await request('/api/tv/1/frame.jpg')).status, 503);
  assert.equal((await request('/tv/4')).status, 404);
  assert.equal((await post('/api/admin/devices/1/start', {})).status, 400);
  assert.equal((await post('/api/admin/demo', {})).status, 200);
  assert.equal((await post('/api/admin/demo', {})).status, 409);
  const receiver = await (await request('/api/tv/1/status')).json();
  assert.deepEqual(Object.keys(receiver).sort(), ['available', 'interval', 'mode', 'name', 'revision', 'state', 'video']);
  assert.equal((await post('/api/admin/devices/1/reconnect', {})).status, 200);
  assert.equal((await (await request('/api/tv/1/status')).json()).revision, 1);
  const admin = await (await request('/api/admin/state', { headers: { 'X-Admin-Token': session.token } })).json();
  assert.equal(admin.devices[0].connected, true);
  assert.equal(admin.devices[1].connected, false);
  assert.equal((await post('/api/admin/settings', { loginUrl: 'https://user:secret@example.test', fps: 1, quality: 80 })).status, 400);
  const staticResponse = await request('/assets/receiver.js');
  assert.equal(staticResponse.headers.get('cache-control'), 'no-store, max-age=0');
  assert.match(await staticResponse.text(), /XMLHttpRequest/);
  assert.equal((await request('/config.json')).status, 404);
  assert.equal((await request('/chromium-profile/Default/Cookies')).status, 404);
});
