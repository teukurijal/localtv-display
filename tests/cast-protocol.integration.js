import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApplication } from '../src/server.js';

test('real Chrome Cast protocol discovers independently in three receiver-only profiles', { timeout: 60000 }, async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'queue-cast-protocol-'));
  // Use bundled full Chrome for Testing; this validates the actual CDP transport,
  // not wireless streaming or physical AQUA compatibility.
  const app = await createApplication({ dataDirectory, cast: { executablePath: chromium.executablePath(), headless: true, discoveryTimeout: 300 } });
  t.after(async () => { await app.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  const address = await app.listen(0, '127.0.0.1');
  const results = await app.caster.all('discover');
  assert.equal(results.every(result => result.ok), true, JSON.stringify(results));
  assert.equal(new Set([...app.caster.entries.values()].map(item => item.context)).size, 3);
  await new Promise(resolve => setTimeout(resolve, 350));
  for (const id of ['1', '2', '3']) {
    const item = app.caster.entries.get(id);
    assert.equal(item.page.url(), `http://127.0.0.1:${address.port}/tv/${id}?cast=1`);
    assert.equal(item.state, item.sinks.length ? 'ready' : 'no-devices');
    assert.equal(await item.page.locator('#fullscreen').isVisible(), false);
    assert.equal((await item.context.cookies()).length, 0);
  }
  const base = `http://127.0.0.1:${address.port}`;
  const session = await (await fetch(`${base}/api/admin/session`)).json();
  const state = await (await fetch(`${base}/api/admin/state`, { headers: { 'X-Admin-Token': session.token } })).json();
  assert.equal(state.devices.some(device => device.connected), false, 'sender-only discovery does not fake connected TVs');
  await app.caster.stop('1');
  assert.equal(app.caster.snapshot('1').state, 'idle');
  for (const id of ['2', '3']) {
    const snapshot = app.caster.snapshot(id);
    assert.equal(snapshot.state, snapshot.sinks.length ? 'ready' : 'no-devices');
  }
});

