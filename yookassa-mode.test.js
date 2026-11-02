import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { getYooKassaMode, isYooKassaConfigured } from '../server/yookassa.js';

const keys = [
  'NODE_ENV',
  'YOOKASSA_MODE',
  'YOOKASSA_LIVE_ENABLED',
  'YOOKASSA_SHOP_ID',
  'YOOKASSA_SECRET_KEY',
  'YOOKASSA_LIVE_SHOP_ID',
  'YOOKASSA_LIVE_SECRET_KEY',
  'YOOKASSA_API_URL',
  'PUBLIC_ORIGIN',
];
const original = new Map(keys.map((key) => [key, process.env[key]]));

function configure(values) {
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
}

after(() => {
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('test credentials cannot activate live mode', () => {
  configure({
    NODE_ENV: 'production',
    YOOKASSA_MODE: 'live',
    YOOKASSA_LIVE_ENABLED: '1',
    YOOKASSA_SHOP_ID: '100000',
    YOOKASSA_SECRET_KEY: 'test-secret',
    PUBLIC_ORIGIN: 'https://aurora.test',
  });
  assert.equal(isYooKassaConfigured(), false);
  assert.equal(getYooKassaMode(), null);
});

test('live mode needs production, explicit enable flag, and separate live credentials', () => {
  const liveEnvironment = {
    NODE_ENV: 'production',
    YOOKASSA_MODE: 'live',
    YOOKASSA_LIVE_ENABLED: '1',
    YOOKASSA_LIVE_SHOP_ID: '123456',
    YOOKASSA_LIVE_SECRET_KEY: 'live-secret',
    PUBLIC_ORIGIN: 'https://aurora.example',
  };
  configure({ ...liveEnvironment, YOOKASSA_LIVE_ENABLED: '0' });
  assert.equal(isYooKassaConfigured(), false);

  configure({ ...liveEnvironment, NODE_ENV: 'test' });
  assert.equal(isYooKassaConfigured(), false);

  configure(liveEnvironment);
  assert.equal(isYooKassaConfigured(), true);
  assert.equal(getYooKassaMode(), 'live');
});

test('live mode refuses a non-official YooKassa API endpoint', () => {
  configure({
    NODE_ENV: 'production',
    YOOKASSA_MODE: 'live',
    YOOKASSA_LIVE_ENABLED: '1',
    YOOKASSA_LIVE_SHOP_ID: '123456',
    YOOKASSA_LIVE_SECRET_KEY: 'live-secret',
    YOOKASSA_API_URL: 'https://payments.example/v3',
    PUBLIC_ORIGIN: 'https://aurora.example',
  });
  assert.equal(isYooKassaConfigured(), false);
});

test('test mode remains separately configurable with test-store credentials', () => {
  configure({
    NODE_ENV: 'test',
    YOOKASSA_MODE: 'test',
    YOOKASSA_SHOP_ID: '100000',
    YOOKASSA_SECRET_KEY: 'test-secret',
    YOOKASSA_API_URL: 'http://127.0.0.1:12345/v3',
    PUBLIC_ORIGIN: 'https://aurora.test',
  });
  assert.equal(isYooKassaConfigured(), true);
  assert.equal(getYooKassaMode(), 'test');
});
