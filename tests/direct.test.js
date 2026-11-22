import test from 'node:test';
import assert from 'node:assert/strict';
import { requestKey, rewriteText } from '../src/direct-manager.js';

test('relay keys allow cache-busting while separating origins, parameters, methods and bodies', () => {
  const key = requestKey('POST', 'https://queue.test/data?display=1&_=100', Buffer.from('queue=1'));
  assert.equal(key, requestKey('POST', 'https://queue.test/data?_=200&display=1&_dc=300', Buffer.from('queue=1')));
  assert.notEqual(key, requestKey('POST', 'https://queue.test/data?display=2', Buffer.from('queue=1')));
  assert.notEqual(key, requestKey('POST', 'https://queue.test/data?display=1', Buffer.from('queue=2')));
  assert.notEqual(key, requestKey('POST', 'https://other.test/data?display=1', Buffer.from('queue=1')));
  assert.notEqual(key, requestKey('DELETE', 'https://queue.test/data?display=1', Buffer.from('queue=1')));
  const script = 'var base="https:\\/\\/queue.test"; var css="//queue.test/style.css";';
  assert.equal(rewriteText(script, 'https://queue.test', 'http://192.168.1.10:3003'), 'var base="http:\\/\\/192.168.1.10:3003"; var css="//192.168.1.10:3003/style.css";');
});
