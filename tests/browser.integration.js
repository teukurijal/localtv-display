import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.js';
import { fakeCastDriver } from './cast-fixture.js';

async function until(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${description}`);
}

test('one persistent login drives three isolated receivers and recovers safely', { timeout: 180000 }, async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'queue-browser-'));
  const castDriver = fakeCastDriver();
  let app = await createApplication({ dataDirectory, browser: { headless: true }, cast: { launch: castDriver.launch } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  const address = await app.listen(0, '0.0.0.0');
  const base = `http://127.0.0.1:${address.port}`;
  const ui = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const pageErrors = [];
  ui.on('pageerror', error => pageErrors.push(error.message));
  ui.on('console', message => { if (message.type() === 'error' && /Content Security Policy/.test(message.text())) pageErrors.push(message.text()); });
  await ui.goto(base);
  await ui.locator('#demo-button').click();
  await until(() => app.store.device('1').url.endsWith('/demo/queue/1'), 'demo configuration');
  await ui.locator('[data-id="1"] [data-action="start"]').click();
  await until(() => app.manager.snapshot('1').state === 'awaiting-approval', 'unauthenticated page is held');
  assert.equal((await fetch(`${base}/api/tv/1/frame.jpg`)).status, 503);
  const session = await (await fetch(`${base}/api/admin/session`)).json();
  let token = session.token;
  const api = async (route, body = {}) => {
    const response = await fetch(`${base}/api/admin/${route}`, { method: 'POST', headers: { 'X-Admin-Token': token, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  };
  await ui.locator('#login-button').click();
  await until(() => app.manager.loginPage?.url().endsWith('/demo/login'), 'login page opens');
  const loginResponse = app.manager.loginPage.waitForResponse(response => response.url().endsWith('/demo/login') && response.request().method() === 'POST');
  await app.manager.loginPage.getByRole('button', { name: 'Sign in to demo' }).click();
  const signedIn = await loginResponse;
  const loginHeaders = await signedIn.request().allHeaders();
  assert.equal(signedIn.status(), 303, JSON.stringify({ error: await signedIn.text().catch(() => 'redirect'), origin: loginHeaders.origin, site: loginHeaders['sec-fetch-site'], host: loginHeaders.host }));
  await app.manager.loginPage.waitForURL('**/demo/queue/1');
  await api('devices/1/refresh');
  await api('devices/2/start');
  await api('devices/3/start');
  try {
    await until(() => ['1', '2', '3'].every(id => app.manager.snapshot(id).frameAvailable), 'all three streams are live');
  } catch (error) {
    for (const id of ['1', '2', '3']) {
      const page = app.manager.displays.get(id).page;
      console.log('Demo display diagnostics', id, app.manager.snapshot(id), page?.url(), page ? await page.locator('body').innerText() : 'no page');
      if (page) await page.screenshot({ type: 'jpeg', quality: 80, timeout: 5000, caret: 'hide' });
    }
    throw error;
  }
  for (const id of ['1', '2', '3']) {
    const page = app.manager.displays.get(id).page;
    assert.match(await page.locator('h1').textContent(), new RegExp(['Umum', 'Anak', 'Gigi'][Number(id) - 1]));
    const response = await fetch(`${base}/api/tv/${id}/frame.jpg`);
    const image = Buffer.from(await response.arrayBuffer());
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(image.readUInt16BE(0), 0xffd8);
  }
  // Exercise PC Cast controls with simulated receivers. Actual TV hardware is a separate test.
  await ui.locator('#discover-tvs').click();
  await until(() => castDriver.launches.length === 3, 'three separate Cast senders');
  for (const id of ['1', '2', '3']) {
    await until(async () => await ui.locator(`[data-id="${id}"] .cast-destination option`).count() === 4, 'discovered TV choices');
    await ui.locator(`[data-id="${id}"] .cast-destination`).selectOption(`aqua-${id}`);
    await until(() => app.store.device(id).castSink?.id === `aqua-${id}`, 'TV assignment saved');
  }
  await ui.locator('#cast-all').click();
  await until(() => ['1', '2', '3'].every(id => app.caster.snapshot(id).state === 'casting'), 'three simulated casts active');
  await ui.locator('[data-id="1"] [data-action="cast-stop"]').click();
  await until(() => app.caster.snapshot('1').state === 'idle', 'individual Cast stop');
  assert.equal(app.caster.snapshot('2').state, 'casting');
  assert.equal(app.caster.snapshot('3').state, 'casting');
  await ui.locator('#stop-casts').click();
  await until(() => ['1', '2', '3'].every(id => app.caster.snapshot(id).state === 'idle'), 'all casts stopped');
  const receiverContext = await browser.newContext();
  const receivers = await Promise.all(['1', '2', '3'].map(async id => {
    const receiver = await receiverContext.newPage();
    await receiver.goto(`${base}/tv/${id}`);
    await receiver.locator('#display').waitFor({ state: 'visible' });
    return receiver;
  }));
  assert.equal((await receiverContext.cookies()).length, 0, 'TV browsers need no website cookies');
  const lan = Object.values(os.networkInterfaces()).flat().find(item => item.family === 'IPv4' && !item.internal);
  if (lan) {
    assert.equal((await fetch(`http://${lan.address}:${address.port}/api/admin/session`)).status, 403);
    assert.equal((await fetch(`http://${lan.address}:${address.port}/tv/1`)).status, 200);
    assert.equal((await fetch(`http://${lan.address}:${address.port}/api/tv/1/frame.jpg`)).status, 200);
  }
  await mkdir('test-results', { recursive: true });
  await until(async () => (await ui.locator('#connected-count').textContent()) === '3 of 3 TVs connected', 'connection status reaches admin');
  await ui.screenshot({ path: 'test-results/dashboard.png', fullPage: true });
  await receivers[0].screenshot({ path: 'test-results/tv-1.png' });
  await ui.setViewportSize({ width: 390, height: 844 });
  assert.equal(await ui.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile layout has no horizontal overflow');
  await ui.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  await ui.setViewportSize({ width: 1440, height: 1100 });

  const secondPage = app.manager.displays.get('2').page;
  await api('devices/1/refresh');
  assert.equal(app.manager.displays.get('2').page, secondPage);
  assert.equal(app.manager.snapshot('2').frameAvailable, true);
  await api('devices/1/stop');
  await until(async () => await receivers[0].locator('#status-heading').textContent() === 'Display is paused', 'stopped TV blanks stale frame');
  assert.equal(app.manager.snapshot('2').frameAvailable, true);
  await api('devices/1/start');
  await receivers[0].locator('#display').waitFor({ state: 'visible' });

  // Without a site-specific selector, operator approval is required after every navigation.
  await api('devices/1/configure', { ...app.store.device('1'), readySelector: '' });
  await until(() => app.manager.snapshot('1').previewAvailable, 'manual preview');
  assert.equal((await fetch(`${base}/api/tv/1/frame.jpg`)).status, 503);
  await api('devices/1/approve');
  await until(() => app.manager.snapshot('1').frameAvailable, 'manual approval publishes');
  await app.manager.displays.get('1').page.goto(`${base}/demo/login`);
  assert.equal(app.manager.frame('1'), null, 'navigation invalidates approval immediately');
  await until(() => app.manager.snapshot('1').state === 'awaiting-approval', 'login screen remains private');
  await api('devices/1/configure', { ...app.store.device('1'), readySelector: '[data-queue-ready]' });
  await until(() => app.manager.snapshot('1').frameAvailable, 'selector restores protected page');

  // A disappearing protected-page marker immediately holds subsequent frames.
  await secondPage.evaluate(() => document.body.removeAttribute('data-queue-ready'));
  await until(() => !app.manager.snapshot('2').frameAvailable, 'selector loss stops broadcast');
  await api('devices/2/refresh');
  await until(() => app.manager.snapshot('2').frameAvailable, 'selector recovery');

  // Offline receiver must hide the stale page and reconnect without a reload.
  await receiverContext.setOffline(true);
  await until(async () => await receivers[0].locator('#offline').isVisible(), 'Wi-Fi interruption shows offline screen');
  await receiverContext.setOffline(false);
  await receivers[0].locator('#display').waitFor({ state: 'visible' });
  const reloaded = receivers[0].waitForEvent('load');
  await api('devices/1/reconnect');
  await reloaded;
  await receivers[0].locator('#display').waitFor({ state: 'visible' });

  // Stop/restart the entire service on the same port, keeping only its persisted profile/config.
  await app.close();
  await until(async () => await receivers[0].locator('#offline').isVisible(), 'service outage clears TV');
  app = await createApplication({ dataDirectory, browser: { headless: true } });
  await app.listen(address.port, '0.0.0.0');
  token = (await (await fetch(`${base}/api/admin/session`)).json()).token;
  await app.manager.restore();
  await until(() => ['1', '2', '3'].every(id => app.manager.snapshot(id).frameAvailable), 'persistent login restores all queues');
  await receivers[0].locator('#display').waitFor({ state: 'visible' });
  assert.equal(app.manager.loginPage, null, 'restore did not need another login');

  // Unexpected browser closure also recovers the persisted session.
  await app.manager.context.close();
  await until(() => ['1', '2', '3'].every(id => app.manager.snapshot(id).frameAvailable), 'browser crash recovery', 30000);
  assert.deepEqual(pageErrors, []);
});
