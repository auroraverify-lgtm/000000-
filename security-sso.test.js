import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initializeSecurityStore } from '../server/security-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminEmail = 'security-admin@aurora.test';
const consent = {
  termsVersion: '2026-10-30-v2',
  privacyVersion: '2026-10-30-v2',
  personalDataConsent: true,
  ageGuardianAttestation: true,
};

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function request(baseUrl, method, route, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, headers: response.headers, data };
}

test('Security SSO launch works with the Messenger localStorage bearer token', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aurora-security-sso-test-'));
  initializeSecurityStore(path.join(dataDir, 'security-events.db'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      SECURITY_STORE_FILE: path.join(dataDir, 'security-events.db'),
      PUBLIC_ORIGIN: 'https://aurora.test',
      TRUST_PROXY_ADDRESSES: '127.0.0.1/32',
      EMAIL_TEST_MODE: '1',
      SECURITY_PUBLIC_URL: 'https://security.example.test',
      AURORA_SECURITY_SSO_SECRET: crypto.randomBytes(32).toString('hex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  let healthy = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      healthy = response.ok;
      if (healthy) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, `Messenger did not start: ${output}`);

  const bootstrap = await request(baseUrl, 'GET', '/api/auth/security-sso/launch');
  assert.equal(bootstrap.status, 200);
  assert.match(bootstrap.data, /localStorage\.getItem\('aurora\.token'\)/);
  assert.match(bootstrap.data, /fetch\('\/api\/auth\/security-sso\/launch'/);
  assert.equal(bootstrap.headers.get('cache-control'), 'no-store');

  const registration = await request(baseUrl, 'POST', '/api/auth/register', {
    body: {
      email: adminEmail,
      password: 'Passw0rdSecuritySso',
      name: 'Security Owner',
      username: 'securityowner',
      bio: '',
      ...consent,
    },
  });
  assert.equal(registration.status, 201, JSON.stringify(registration.data));
  const messengerDatabase = new Database(path.join(dataDir, 'aurora.db'));
  messengerDatabase.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(registration.data.user.id);
  messengerDatabase.close();
  const verification = await request(baseUrl, 'POST', '/api/auth/email-verification/verify', {
    token: registration.data.token,
    body: { code: registration.data.emailVerification.testCode },
  });
  assert.equal(verification.status, 200, JSON.stringify(verification.data));

  const launch = await request(baseUrl, 'POST', '/api/auth/security-sso/launch', {
    token: registration.data.token,
  });
  assert.equal(launch.status, 200, JSON.stringify(launch.data));
  assert.equal(launch.data.destination, 'https://security.example.test/auth/sso');
  assert.match(launch.data.code, /^[A-Za-z0-9_-]{40,64}$/);

  const unauthenticated = await request(baseUrl, 'POST', '/api/auth/security-sso/launch');
  assert.equal(unauthenticated.status, 401);
});
