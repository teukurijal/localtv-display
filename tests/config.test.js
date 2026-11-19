import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, defaults, httpUrl, validateDevice } from '../src/config.js';

test('configuration persists independent URLs, selectors and enabled state', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'queue-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ConfigStore(directory);
  await store.load();
  await store.updateDevice('1', { url: 'https://example.test/poli/1', name: 'Poli A', enabled: true });
  await store.updateDevice('2', { url: 'http://192.168.1.15/queue/2', readySelector: '#queue-board', refreshSeconds: 60 });
  const reloaded = new ConfigStore(directory);
  await reloaded.load();
  assert.equal(reloaded.device('1').enabled, true);
  assert.equal(reloaded.device('1').name, 'Poli A');
  assert.equal(reloaded.device('2').refreshSeconds, 60);
  assert.equal(reloaded.device('3').url, '');
  assert.equal((await readFile(store.file, 'utf8')).includes('password'), false);
});

test('URL and refresh validation rejects unsafe and incomplete configuration', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.com', 'not-a-url']) {
    assert.throws(() => httpUrl(url));
  }
  const device = defaults().devices[0];
  assert.throws(() => validateDevice({ ...device, resolution: 'constructor' }, '1'));
  assert.throws(() => validateDevice({ ...device, refreshSeconds: 5, readySelector: '#queue' }, '1'));
  assert.throws(() => validateDevice({ ...device, refreshSeconds: 60 }, '1'));
  assert.equal(httpUrl('  https://example.test  '), 'https://example.test/');
});

test('corrupt configuration is not silently replaced', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'queue-bad-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ConfigStore(directory);
  await writeFile(store.file, '{broken');
  await assert.rejects(store.load(), /could not be loaded/);
  assert.equal(await readFile(store.file, 'utf8'), '{broken');
});
