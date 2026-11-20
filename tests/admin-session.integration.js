import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.js';
import { fakeCastDriver, testSinks } from './cast-fixture.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}

async function setup(t, castOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'queue-admin-session-'));
  const driver = fakeCastDriver(castOptions);
  const options = { dataDirectory: directory, cast: { launch: driver.launch, discoveryTimeout: 300 } };
  const app = await createApplication(options);
  const address = await app.listen(0, '127.0.0.1');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const cleanup = [];
  const fixture = { app, options, driver, address, browser, page, base: `http://127.0.0.1:${address.port}`, cleanup };
  t.after(async () => {
    cleanup.forEach(action => action());
    await browser.close();
    await fixture.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return fixture;
}

test('Discover TVs waits for the initial admin session instead of sending an empty token', { timeout: 20000 }, async t => {
  const { page, base, driver, cleanup } = await setup(t);
  const sessionGate = deferred();
  cleanup.push(sessionGate.resolve);
  let sessionRequests = 0;
  let discoveryRequests = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/admin/cast/discover')) discoveryRequests += 1;
  });
  await page.route('**/api/admin/session', async route => {
    sessionRequests += 1;
    await sessionGate.promise;
    await route.continue().catch(() => {});
  });
  await page.goto(base);
  await until(() => sessionRequests === 1, 'initial session request');
  await page.locator('#discover-tvs').click();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(discoveryRequests, 0, 'a control must not send a request until its session is ready');
  sessionGate.resolve();
  await until(() => driver.launches.length === 3, 'discovery completes');
  await until(async () => (await page.locator('#toast').textContent()).startsWith('Discovery started.'), 'success notification');
  assert.equal(sessionRequests, 1, 'poll and button share the initial session request');
  assert.equal(discoveryRequests, 1, 'the action runs once');
});

test('Discover TVs refreshes a stale session after a service restart without reloading or losing edits', { timeout: 25000 }, async t => {
  const fixture = await setup(t);
  const { page, base, address, options, driver, cleanup } = fixture;
  const stateGate = deferred();
  cleanup.push(stateGate.resolve);
  let holdState = false;
  let sessionRequests = 0;
  const discoveryStatuses = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/admin/session')) sessionRequests += 1;
  });
  await page.route('**/api/admin/state', async route => {
    if (holdState) await stateGate.promise;
    await route.continue().catch(() => {});
  });
  await page.goto(base);
  await until(async () => (await page.locator('#service-stats').textContent()).startsWith('Service up'), 'initial admin state');
  await page.locator('#login-url').fill('https://unsaved.example.test/login');
  await page.evaluate(() => { window.sessionTestMarker = 'page-kept-open'; });
  holdState = true;
  await fixture.app.close();
  fixture.app = await createApplication(options);
  fixture.app.server.on('request', (request, response) => {
    if (request.method === 'POST' && request.url === '/api/admin/cast/discover') response.on('finish', () => discoveryStatuses.push(response.statusCode));
  });
  await fixture.app.listen(address.port, '127.0.0.1');
  await page.locator('#discover-tvs').click();
  await until(() => driver.launches.length === 3, 'discovery recovers from stale token');
  stateGate.resolve();
  await until(async () => (await page.locator('#toast').textContent()).startsWith('Discovery started.'), 'success notification');
  assert.deepEqual(discoveryStatuses, [401, 200], 'retry only the request rejected before its action ran');
  assert.equal(sessionRequests, 2, 'one initial session and one refresh');
  assert.equal(await page.evaluate(() => window.sessionTestMarker), 'page-kept-open');
  assert.equal(await page.locator('#login-url').inputValue(), 'https://unsaved.example.test/login');
});

test('a failed discovery action is not replayed for non-authentication errors', { timeout: 20000 }, async t => {
  const { page, base } = await setup(t);
  let sessionRequests = 0;
  let discoveryRequests = 0;
  page.on('request', request => { if (request.url().endsWith('/api/admin/session')) sessionRequests += 1; });
  await page.goto(base);
  await until(async () => (await page.locator('#service-stats').textContent()).startsWith('Service up'), 'initial admin state');
  await page.route('**/api/admin/cast/discover', async route => {
    discoveryRequests += 1;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Discovery unavailable.' }) });
  });
  await page.locator('#discover-tvs').click();
  await until(async () => await page.locator('#toast').textContent() === 'Discovery unavailable.', 'failure reported');
  assert.equal(discoveryRequests, 1);
  assert.equal(sessionRequests, 1);
});

test('persistent authentication rejection stops after one session refresh', { timeout: 20000 }, async t => {
  const { page, base, driver } = await setup(t);
  let sessionRequests = 0;
  let discoveryRequests = 0;
  page.on('request', request => { if (request.url().endsWith('/api/admin/session')) sessionRequests += 1; });
  await page.goto(base);
  await until(async () => (await page.locator('#service-stats').textContent()).startsWith('Service up'), 'initial admin state');
  await page.route('**/api/admin/cast/discover', async route => {
    discoveryRequests += 1;
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Admin session rejected.' }) });
  });
  await page.locator('#discover-tvs').click();
  await until(async () => await page.locator('#toast').textContent() === 'Admin session rejected.', 'rejection reported after bounded retry');
  assert.equal(discoveryRequests, 2);
  assert.equal(sessionRequests, 2);
  assert.equal(driver.launches.length, 0);
});

test('empty Cast destinations show recovery guidance and populate when TVs appear later', { timeout: 20000 }, async t => {
  const { page, base, driver, app } = await setup(t, { sinks: [] });
  await page.goto(base);
  const destination = page.locator('[data-id="1"] .cast-destination');
  const message = page.locator('[data-id="1"] .cast-message');
  await until(async () => await destination.textContent() === 'Select Discover TVs first', 'initial destination prompt');
  assert.equal(await destination.isDisabled(), true);
  await page.locator('#discover-tvs').click();
  await until(async () => await destination.textContent() === 'No Google Cast TVs found', 'empty discovery result');
  assert.equal(await destination.isDisabled(), true);
  assert.match(await message.textContent(), /WSL|Cast menu/);
  assert.equal(await page.locator('#connected-count').textContent(), '0 of 3 TVs connected');

  driver.launches.find(item => item.id === '1').session.emit('Cast.sinksUpdated', { sinks: testSinks });
  await until(async () => await destination.locator('option').count() === 4, 'late TV names appear');
  assert.equal(await destination.isDisabled(), false);
  await destination.selectOption('aqua-1');
  await until(() => app.store.device('1').castSink?.id === 'aqua-1', 'late destination can be assigned');
});
