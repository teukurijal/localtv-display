import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.js';

async function until(predicate, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

test('real WebRTC delivers independent animated displays, revokes approval, and falls back to JPEG', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'queue-video-'));
  const app = await createApplication({ dataDirectory: directory, browser: { headless: true } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const { port } = await app.listen(0, '0.0.0.0');
  const base = `http://127.0.0.1:${port}`;
  const lan = Object.values(os.networkInterfaces()).flat().find(item => item.family === 'IPv4' && !item.internal);
  const lanBase = lan ? `http://${lan.address}:${port}` : base;
  if (lan) assert.equal((await fetch(`${lanBase}/internal/video`)).status, 403);
  const post = (route, body, origin = base) => fetch(base + route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/tv/1/video/offer', { type: 'offer', sdp: 'test' })).status, 409);
  assert.equal((await post('/api/tv/1/video/offer', {}, 'http://other.test')).status, 403);
  await app.store.save({ ...app.store.value, devices: app.store.value.devices.map(device => ({ ...device, enabled: true, resolution: '720p', url: `${base}/demo/queue/${device.id}`, readySelector: '[data-queue-ready]' })) });
  await app.manager.ensureBrowser();
  await app.manager.context.addCookies([{ name: 'queue-demo', value: 'authenticated', url: base + '/demo' }]);
  await app.manager.restore();
  const errors = [];
  const receivers = [];
  for (const id of ['1', '2', '3']) {
    const source = app.manager.displays.get(id).page;
    await source.evaluate(index => {
      document.body.innerHTML = '';
      document.body.style.cssText = 'margin:0;background:' + ['rgb(230,20,20)', 'rgb(20,230,20)', 'rgb(20,20,230)'][index];
      const dot = document.createElement('div');
      dot.style.cssText = 'position:absolute;top:10px;width:50px;height:50px;background:white';
      document.body.append(dot);
      function animate(time) { dot.style.left = (time / 5 % 1100) + 'px'; requestAnimationFrame(animate); }
      requestAnimationFrame(animate);
    }, Number(id) - 1);
    await until(() => app.manager.frame(id), 'approved source ' + id);
    const receiver = await browser.newPage();
    receiver.on('pageerror', error => errors.push(error.message));
    receiver.on('console', message => { if (message.type() === 'error' && /Content Security Policy/.test(message.text())) errors.push(message.text()); });
    await receiver.goto(`${id === '3' ? lanBase : base}/tv/${id}`);
    receivers.push(receiver);
    try {
      await receiver.locator('#video').waitFor({ state: 'visible', timeout: 25000 });
    } catch (error) {
      console.log('video diagnostics', id, await receiver.locator('#stream-status').textContent(), [...app.video.entries.keys()], [...app.video.sessions.values()]);
      throw error;
    }
    const sample = () => receiver.locator('#video').evaluate(video => {
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
      const ctx = canvas.getContext('2d'); ctx.drawImage(video, 500, 300, 1, 1, 0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    });
    await until(async () => (await sample())[Number(id) - 1] > 180, 'correct display color ' + id);
    const pixel = await sample();
    assert.ok(pixel[Number(id) - 1] > 180, 'correct display color: ' + pixel);
    assert.ok(pixel.filter((_, i) => i < 3 && i !== Number(id) - 1).every(value => value < 60), 'other displays do not leak');
    assert.equal((await receiver.context().cookies()).length, 0, 'receiver has no website session');
  }
  const decoded = page => page.locator('#video').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames);
  const before = await decoded(receivers[0]);
  await new Promise(resolve => setTimeout(resolve, 2200));
  const count = await decoded(receivers[0]) - before;
  console.log(`Decoded ${count} video frames over 2.2 seconds with three active displays.`);
  assert.ok(count > 10, 'video is faster than the 1–3 fps JPEG path');

  // A lost marker must tear down its encoder/peers, while other displays continue.
  await app.manager.displays.get('1').page.evaluate(() => document.body.removeAttribute('data-queue-ready'));
  await until(() => !app.video.entries.has('1'), 'marker loss closes video');
  assert.equal((await fetch(`${base}/api/tv/1/frame.jpg`)).status, 503);
  await receivers[0].locator('#offline').waitFor({ state: 'visible' });
  assert.equal(await receivers[1].locator('#video').isVisible(), true);
  await app.manager.displays.get('1').page.evaluate(() => document.body.setAttribute('data-queue-ready', ''));
  await receivers[0].locator('#video').waitFor({ state: 'visible', timeout: 25000 });

  // Navigation invalidates even manually approved streams.
  await app.manager.displays.get('1').page.goto(`${base}/demo/login`);
  assert.equal(app.video.entries.has('1'), false);
  assert.equal((await fetch(`${base}/api/tv/1/frame.jpg`)).status, 503);
  await receivers[0].locator('#offline').waitFor({ state: 'visible' });
  await app.manager.stop('2');
  await receivers[1].locator('#offline').waitFor({ state: 'visible' });
  assert.equal(app.video.entries.has('2'), false);
  assert.equal(await receivers[2].locator('#video').isVisible(), true);

  const oldTV = await browser.newPage();
  await oldTV.addInitScript(() => { window.RTCPeerConnection = undefined; });
  await oldTV.goto(`${base}/tv/3`);
  await oldTV.locator('#display').waitFor({ state: 'visible' });
  assert.equal(await oldTV.locator('#video').isVisible(), false);
  const blocked = await browser.newPage();
  await blocked.route('**/video/offer', route => route.fulfill({ status: 503, body: '{}' }));
  await blocked.goto(`${base}/tv/3`);
  await blocked.locator('#display').waitFor({ state: 'visible' });
  await until(async () => (await blocked.locator('#stream-status').textContent()) === 'Compatibility mode', 'failed signaling falls back');

  // User-selected fallback, retry, and a network interruption recover without a reload.
  await receivers[2].mouse.move(20, 20);
  await receivers[2].locator('#stream-mode').click();
  await receivers[2].locator('#display').waitFor({ state: 'visible' });
  await until(() => !app.video.entries.has('3'), 'manual fallback releases video');
  await receivers[2].locator('#stream-mode').click();
  await receivers[2].locator('#video').waitFor({ state: 'visible', timeout: 25000 });
  await receivers[2].context().setOffline(true);
  await receivers[2].locator('#offline').waitFor({ state: 'visible' });
  await receivers[2].context().setOffline(false);
  await receivers[2].locator('#video').waitFor({ state: 'visible', timeout: 25000 });

  // Removing the receiver releases the encoder, without affecting JPEG clients.
  await receivers[2].close();
  await until(() => !app.video.entries.has('3'), 'receiver cleanup', 20000);
  assert.equal((await fetch(`${base}/api/tv/3/frame.jpg`)).status, 200);
  assert.deepEqual(errors, []);
});
