import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.js';

async function until(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out: ' + label);
}

test('native display relays authenticated documents and live data without exposing sessions or replaying POSTs', { timeout: 100000 }, async t => {
  let sourceOrigin;
  const calls = { data: 0, arbitrary: 0 };
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/login') { res.setHeader('Content-Type', 'text/html'); return res.end('<input type="password">'); }
    if (req.headers.cookie !== 'secret=pc-only') { res.writeHead(302, { Location: '/login' }); return res.end(); }
    res.setHeader('Set-Cookie', 'secret=pc-only; HttpOnly; Path=/');
    res.setHeader('X-Frame-Options', ['SAMEORIGIN', 'sameorigin']);
    res.setHeader('Content-Security-Policy', ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'", "frame-ancestors 'self'"]);
    const url = new URL(req.url, sourceOrigin);
    if (url.pathname.startsWith('/display/')) {
      const id = url.pathname.split('/')[2];
      res.setHeader('Content-Type', 'text/html');
      return res.end(`<!doctype html><html><head><link rel="stylesheet" href="${sourceOrigin}/assets/main.css"></head><body data-ready><h1>Display ${id}</h1><div id="data">waiting</div><div id="animation"></div><script>window.baseUrl=${JSON.stringify(sourceOrigin)};window.displayId=${JSON.stringify(id)};</script><script src="${sourceOrigin}/assets/app.js"></script></body></html>`);
    }
    if (url.pathname === '/assets/main.css') { res.setHeader('Content-Type', 'text/css'); return res.end('@keyframes slide{from{transform:translateX(0)}to{transform:translateX(300px)}}#animation{width:50px;height:50px;background:green;animation:slide 1s infinite alternate linear}'); }
    if (url.pathname === '/assets/app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(`function poll(){var x=new XMLHttpRequest();x.open('POST',window.baseUrl+'/data?_='+Date.now());x.setRequestHeader('Content-Type','application/x-www-form-urlencoded');x.onload=function(){if(x.status===200)document.getElementById('data').textContent=x.responseText;setTimeout(poll,300)};x.send('display='+window.displayId)}poll();`); }
    if (url.pathname === '/data') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      calls.data++;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ display: Buffer.concat(chunks).toString(), updated: calls.data }));
    }
    calls.arbitrary++;
    res.end('private data');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  sourceOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'queue-direct-'));
  const app = await createApplication({ dataDirectory: directory, browser: { headless: true } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); });
  const { port } = await app.listen(0, '0.0.0.0');
  const base = `http://127.0.0.1:${port}`;
  await app.store.save({ ...app.store.value, devices: app.store.value.devices.map(d => ({ ...d, mode: 'direct', enabled: d.id !== '3', url: `${sourceOrigin}/display/${d.id}`, readySelector: '[data-ready]' })) });
  await app.manager.ensureBrowser();
  await app.manager.context.addCookies([{ name: 'secret', value: 'pc-only', url: sourceOrigin }]);
  await app.manager.restore();
  await until(() => app.manager.frame('1') && app.manager.frame('2'), 'approval');
  const receivers = [];
  const errors = [];
  const requests = [];
  for (const id of ['1', '2']) {
    const receiver = await browser.newPage();
    receiver.on('request', request => requests.push(request.url()));
    receiver.on('pageerror', e => errors.push(e.message));
    await receiver.goto(`${base}/tv/${id}`);
    await receiver.frameLocator('#page').locator('h1').waitFor();
    assert.equal(await receiver.frameLocator('#page').locator('h1').textContent(), 'Display ' + id);
    await until(async () => (await receiver.frameLocator('#page').locator('#data').textContent()).includes('display=' + id), 'live data ' + id);
    const old = await receiver.frameLocator('#page').locator('#data').textContent();
    await until(async () => (await receiver.frameLocator('#page').locator('#data').textContent()) !== old, 'live updates ' + id);
    const animation = receiver.frameLocator('#page').locator('#animation');
    const a = await animation.evaluate(el => getComputedStyle(el).transform);
    await new Promise(resolve => setTimeout(resolve, 100));
    const b = await animation.evaluate(el => getComputedStyle(el).transform);
    assert.notEqual(a, b, 'animation runs natively, independently of JPEG capture');
    assert.equal((await receiver.context().cookies()).length, 0);
    receivers.push(receiver);
  }
  const directOrigin = new URL(receivers[0].url()).origin;
  const post = (body, route = '/data') => fetch(directOrigin + route, { method: 'POST', headers: { Origin: directOrigin, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  assert.equal((await fetch(directOrigin + '/api/admin/session')).status, 404);
  assert.equal((await fetch(directOrigin + '/admin/delete')).status, 404);
  assert.equal((await post('display=2')).status, 404, 'other display request is not available');
  assert.equal((await post('display=1&delete=true')).status, 404, 'modified body cannot expand access');
  assert.equal((await fetch(directOrigin + '/assets/app.js', { method: 'DELETE' })).status, 405);
  const document = await fetch(directOrigin + '/display/1');
  assert.equal(document.headers.get('set-cookie'), null);
  const html = await document.text();
  assert.ok(html.includes(directOrigin));
  assert.ok(!html.includes('pc-only'));
  assert.equal(calls.arbitrary, 0, 'unobserved requests never reach upstream');

  // Stop source polling briefly to prove TV requests only consume relayed data.
  await app.manager.displays.get('1').page.evaluate(() => { window.poll = function () {}; });
  await app.manager.displays.get('2').page.evaluate(() => { window.poll = function () {}; });
  await new Promise(resolve => setTimeout(resolve, 500));
  const before = calls.data;
  for (let i = 0; i < 5; i++) assert.equal((await post('display=1')).status, 200);
  assert.equal(calls.data, before, 'POSTs are never replayed to the authenticated site');

  await app.manager.displays.get('1').page.evaluate(() => document.body.removeAttribute('data-ready'));
  await until(() => !app.manager.frame('1'), 'approval revoked');
  assert.equal((await post('display=1')).status, 503);
  await receivers[0].locator('#notice').waitFor({ state: 'visible' });
  assert.equal(await receivers[0].locator('#page').isVisible(), false);
  assert.equal(await receivers[1].locator('#page').isVisible(), true, 'other TV remains independent');
  await app.manager.displays.get('1').page.evaluate(() => document.body.setAttribute('data-ready', ''));
  await receivers[0].frameLocator('#page').locator('h1').waitFor();
  await app.manager.stop('1');
  await receivers[0].locator('#notice').waitFor({ state: 'visible' });
  assert.equal((await fetch(directOrigin + '/assets/app.js')).status, 503);
  await receivers[1].context().setOffline(true);
  await receivers[1].locator('#notice').waitFor({ state: 'visible' });
  await receivers[1].context().setOffline(false);
  await receivers[1].frameLocator('#page').locator('h1').waitFor();
  // Expired AJAX authentication is detected even if the old board marker remains.
  await app.manager.context.clearCookies();
  await app.manager.displays.get('2').page.evaluate(() => fetch('/data'));
  await until(() => !app.direct.ready('2'), 'expired AJAX session is withheld');
  await receivers[1].locator('#notice').waitFor({ state: 'visible' });
  await app.manager.context.addCookies([{ name: 'secret', value: 'pc-only', url: sourceOrigin }]);
  await app.manager.refresh('2');
  await receivers[1].frameLocator('#page').locator('h1').waitFor();
  assert.equal(requests.some(url => /frame\.jpg|video\/offer/.test(url)), false, 'direct receivers never request JPEG or video streams');
  assert.deepEqual(errors, []);
});
