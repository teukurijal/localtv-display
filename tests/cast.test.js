import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/config.js';
import { CastManager } from '../src/cast-manager.js';
import { fakeCastDriver, testSinks } from './cast-fixture.js';

async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'queue-cast-test-'));
  const store = new ConfigStore(directory);
  await store.load();
  const driver = fakeCastDriver(options);
  const manager = { frame: () => Buffer.from('approved frame') };
  const caster = new CastManager(store, manager, () => 'http://127.0.0.1:8443', { launch: driver.launch, confirmTimeout: 30, discoveryTimeout: 10, commandTimeout: 50 });
  t.after(async () => { await caster.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, caster, driver, manager };
}

test('three Cast outputs use different Chrome profiles and targets with one authenticated source', async t => {
  const { store, caster, driver } = await setup(t);
  assert.equal((await caster.all('discover')).every(result => result.ok), true);
  for (const id of ['1', '2', '3']) await caster.assign(id, `aqua-${id}`);
  assert.equal((await caster.all('start')).every(result => result.ok), true);
  assert.equal(new Set(driver.launches.map(item => item.profile)).size, 3);
  for (const item of driver.launches) {
    assert.equal(item.page.url, `http://127.0.0.1:8443/tv/${item.id}?cast=1`);
    assert.equal(item.options.channel, 'chrome');
    assert.equal(item.options.ignoreDefaultArgs, true);
    assert.equal(item.options.args.includes('--no-sandbox'), false);
    assert.equal(item.options.args.some(value => value.includes('--remote-debugging-port')), false);
    assert.deepEqual(item.calls.find(call => call.method === 'Cast.startTabMirroring').params, { sinkName: testSinks[Number(item.id) - 1].name });
    assert.equal(caster.snapshot(item.id).state, 'casting');
  }
  await caster.all('discover');
  assert.equal(driver.launches.length, 3, 'retrying discovery keeps the active sender processes');
  for (const item of driver.launches) {
    assert.equal(caster.snapshot(item.id).state, 'casting');
    assert.equal(item.calls.filter(call => call.method === 'Cast.enable').length, 1, 'active casts already observe discovery');
  }
  await caster.stop('1');
  assert.equal(caster.snapshot('1').state, 'idle');
  assert.equal(caster.snapshot('2').state, 'casting');
  assert.equal(caster.snapshot('3').state, 'casting');
  const reloaded = new ConfigStore(store.directory);
  await reloaded.load();
  assert.equal(reloaded.device('1').castSink.id, 'aqua-1');
});

test('duplicate assignments, duplicate names, busy receivers and unapproved frames are rejected', async t => {
  const { caster, manager } = await setup(t);
  await caster.all('discover');
  await caster.assign('1', 'aqua-1');
  await assert.rejects(caster.assign('2', 'aqua-1'), /already assigned/);
  await assert.rejects(caster.assign('2', 'missing'), /not currently discovered/);
  manager.frame = () => null;
  await assert.rejects(caster.start('1'), /approve its preview/);
  manager.frame = () => Buffer.from('approved');
  caster.entries.get('1').sinks[0].session = 'Someone else is casting';
  await assert.rejects(caster.start('1'), /already casting/);
  caster.entries.get('2').sinks = [{ id: 'x', name: 'AQUA' }, { id: 'y', name: 'AQUA' }];
  await assert.rejects(caster.assign('2', 'x'), /same Cast name/);
});

test('a command acknowledgement cannot falsely mark a TV connected', async t => {
  const { caster } = await setup(t, { autoConfirm: false });
  await caster.discover('1');
  await caster.assign('1', 'aqua-1');
  await caster.start('1');
  assert.equal(caster.snapshot('1').state, 'connecting');
  await caster.discover('1');
  assert.equal(caster.snapshot('1').state, 'connecting');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(caster.snapshot('1').state, 'error');
  assert.match(caster.snapshot('1').message, /not confirmed/);
});

test('one failed Cast target does not stop the other two', async t => {
  const { caster, driver } = await setup(t, { failStart: '2' });
  await caster.all('discover');
  for (const id of ['1', '2', '3']) await caster.assign(id, `aqua-${id}`);
  const results = await caster.all('start');
  assert.deepEqual(results.map(item => item.ok), [true, false, true]);
  assert.equal(caster.snapshot('1').state, 'casting');
  assert.equal(caster.snapshot('2').state, 'error');
  assert.equal(caster.snapshot('3').state, 'casting');
  await driver.launches.find(item => item.id === '1').context.close();
  assert.equal(caster.snapshot('1').state, 'error');
  assert.equal(caster.snapshot('3').state, 'casting');
});

test('an unresponsive receiver times out without blocking the other outputs or later controls', async t => {
  const { caster } = await setup(t, { hangStart: '1' });
  await caster.all('discover');
  for (const id of ['1', '2', '3']) await caster.assign(id, `aqua-${id}`);
  const results = await caster.all('start');
  assert.deepEqual(results.map(item => item.ok), [false, true, true]);
  assert.equal(caster.entries.get('1').context, null);
  assert.equal(caster.snapshot('1').state, 'error');
  await caster.stop('1');
  assert.equal(caster.snapshot('1').state, 'idle');
  assert.equal(caster.snapshot('2').state, 'casting');
});

test('empty discovery stays searching, reports no TVs, and accepts TVs found later', async t => {
  const { caster, driver } = await setup(t, { sinks: [] });
  const initial = await caster.discover('1');
  assert.equal(initial.state, 'discovering');
  assert.deepEqual(initial.sinks, []);
  assert.doesNotMatch(initial.message, /Choose a TV/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(caster.snapshot('1').state, 'no-devices');
  assert.match(caster.snapshot('1').message, /No Google Cast TVs found/);
  assert.match(caster.snapshot('1').message, /WSL|Cast menu/);

  const { session } = driver.launches[0];
  session.emit('Cast.sinksUpdated', { sinks: testSinks });
  assert.equal(caster.snapshot('1').state, 'ready');
  assert.equal(caster.snapshot('1').sinks.length, 3);
  await caster.assign('1', 'aqua-1');
  session.emit('Cast.sinksUpdated', { sinks: [] });
  assert.equal(caster.snapshot('1').state, 'no-devices');
  assert.equal((await caster.discover('1')).state, 'discovering');
  assert.equal(driver.launches.length, 1, 'retry reuses the existing sender');
});

test('stopping or closing a sender cancels discovery and ignores its stale results', async t => {
  const { caster, driver } = await setup(t, { sinks: [] });
  await caster.discover('1');
  const previous = driver.launches[0];
  await caster.stop('1');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(caster.snapshot('1').state, 'idle');
  await caster.discover('1');
  previous.session.emit('Cast.sinksUpdated', { sinks: testSinks });
  assert.deepEqual(caster.snapshot('1').sinks, []);
  await driver.launches[1].context.close();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(caster.snapshot('1').state, 'error');
  assert.match(caster.snapshot('1').message, /browser closed/);
});

test('Chrome launch failures and Cast protocol failures explain different recovery steps', async t => {
  const { caster } = await setup(t, { failLaunch: '1', failDiscovery: '2' });
  await assert.rejects(caster.discover('1'), /Chrome.*(?:WSL|not found)/);
  await assert.rejects(caster.discover('2'), /Chrome opened, but Cast discovery failed/);
  assert.equal(caster.entries.get('2').context, null);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(caster.snapshot('2').state, 'error', 'a discovery timeout must not replace the error');
});

test('Chrome issues remain visible even when discovery delivers late results', async t => {
  const { caster, driver } = await setup(t, { sinks: [] });
  await caster.discover('1');
  driver.launches[0].session.emit('Cast.issueUpdated', { issueMessage: 'Local network permission denied.' });
  driver.launches[0].session.emit('Cast.sinksUpdated', { sinks: testSinks });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(caster.snapshot('1').state, 'error');
  assert.equal(caster.snapshot('1').message, 'Local network permission denied.');
});
