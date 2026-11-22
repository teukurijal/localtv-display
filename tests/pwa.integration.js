import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.js';

test('PC controller installs as a live-only PWA and has a useful offline window', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'queue-pwa-'));
  const app = await createApplication({ dataDirectory: directory, browser: { headless: true } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://localhost:${port}`;
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  await page.goto(base);
  const manifest = await (await fetch(base + '/manifest.webmanifest')).json();
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512']);
  for (const icon of manifest.icons) {
    const response = await fetch(base + icon.src);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const data = Buffer.from(await response.arrayBuffer());
    assert.equal(data.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(data.readUInt32BE(16), Number(icon.sizes.split('x')[0]));
  }
  const cdp = await context.newCDPSession(page);
  const appManifest = await cdp.send('Page.getAppManifest');
  assert.equal(appManifest.errors.length, 0, JSON.stringify(appManifest.errors));
  assert.ok(appManifest.data);
  const installability = await cdp.send('Page.getInstallabilityErrors');
  assert.deepEqual(installability.installabilityErrors, []);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
  assert.deepEqual(await page.evaluate(() => caches.keys()), [], 'service worker never caches admin data');
  assert.equal((await fetch(base + '/api/admin/session')).status, 200);
  await context.setOffline(true);
  await page.reload();
  assert.match(await page.locator('h1').textContent(), /PC service is offline/);
  assert.equal(await page.locator('#display-grid').count(), 0, 'offline window does not show a stale controller');
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Retry' }).click();
  await page.locator('#display-grid .display-card').first().waitFor();
  assert.deepEqual(await page.evaluate(() => caches.keys()), []);
});
