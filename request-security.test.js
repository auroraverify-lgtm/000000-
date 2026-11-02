import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedPublicOrigin,
  parsePublicOrigin,
  parseTrustedProxyAddresses,
} from '../server/request-security.js';

test('proxy trust defaults to and only accepts the configured loopback /32', () => {
  assert.deepEqual(parseTrustedProxyAddresses(undefined), ['127.0.0.1/32']);
  assert.deepEqual(parseTrustedProxyAddresses('127.0.0.1/32'), ['127.0.0.1/32']);

  for (const value of ['', 'true', '*', 'loopback', '127.0.0.0/8', '0.0.0.0/0', '127.0.0.1/32,::1/128']) {
    assert.throws(() => parseTrustedProxyAddresses(value), /TRUST_PROXY_ADDRESSES/);
  }
});

test('PUBLIC_ORIGIN must be a canonical HTTPS origin', () => {
  assert.equal(parsePublicOrigin('https://aurora.test'), 'https://aurora.test');

  for (const value of [undefined, '', 'http://aurora.test', 'https://aurora.test/', 'https://aurora.test/path', 'https://user@aurora.test']) {
    assert.throws(() => parsePublicOrigin(value), /PUBLIC_ORIGIN/);
  }
});

test('WebSocket Origin comparison is exact and rejects missing or malformed values', () => {
  const expected = 'https://aurora.test';

  assert.equal(isAllowedPublicOrigin(expected, expected), true);
  assert.equal(isAllowedPublicOrigin(undefined, expected), false);
  assert.equal(isAllowedPublicOrigin('not-an-origin', expected), false);
  assert.equal(isAllowedPublicOrigin('https://attacker.aurora.test', expected), false);
  assert.equal(isAllowedPublicOrigin('https://aurora.test:444', expected), false);
  assert.equal(isAllowedPublicOrigin('http://aurora.test', expected), false);
  assert.equal(isAllowedPublicOrigin('https://aurora.test/', expected), false);
});
