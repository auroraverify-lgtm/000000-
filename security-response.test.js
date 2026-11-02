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
import WebSocket from 'ws';
import { initializeSecurityStore, openSecurityStore } from '../server/security-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of value.replace(/=+$/, '')) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function totp(secret) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

async function jsonRequest(base, route, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, headers: response.headers, data };
}

function signedHeaders(secret, route, body) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(18).toString('hex');
  const serialized = JSON.stringify(body);
  const signature = crypto.createHmac('sha256', secret)
    .update(`POST\n${route}\n${timestamp}\n${nonce}\n${serialized}`).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Aurora-Timestamp': timestamp,
    'X-Aurora-Nonce': nonce,
    'X-Aurora-Signature': signature,
  };
}

async function internalRequest(base, secret, route, body, headers = signedHeaders(secret, route, body)) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

test('security response is role-checked, MFA-gated, persistent and restores progressively', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aurora-security-response-'));
  const storeFile = path.join(dataDir, 'security-events.db');
  initializeSecurityStore(storeFile);
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const secret = crypto.randomBytes(32).toString('hex');
  const environment = {
    ...process.env,
    NODE_ENV: 'test',
    EMAIL_TEST_MODE: '1',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    SECURITY_STORE_FILE: storeFile,
    PUBLIC_ORIGIN: 'https://aurora.test',
    TRUST_PROXY_ADDRESSES: '127.0.0.1/32',
    AURORA_SECURITY_SSO_SECRET: secret,
  };
  let server;
  let capturedOutput = '';

  async function start() {
    server = spawn(process.execPath, ['server/index.js'], {
      cwd: root,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (data) => { capturedOutput += data.toString(); });
    server.stderr.on('data', (data) => { capturedOutput += data.toString(); });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (server.exitCode !== null) break;
      try {
        const response = await fetch(`${base}/api/health`);
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Messenger did not start: ${capturedOutput}`);
  }

  async function stop() {
    if (!server || server.exitCode !== null) return;
    await new Promise((resolve) => {
      server.once('exit', resolve);
      server.kill('SIGTERM');
    });
  }

  t.after(async () => {
    await stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  await start();

  async function register(email, username, password) {
    const result = await jsonRequest(base, '/api/auth/register', {
      method: 'POST',
      body: { email, username, name: username, password, bio: '', ...consent },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  }

  const adminEmail = 'security-admin@aurora.test';
  const adminPassword = 'AuroraSecurityPass123!';
  const userEmail = 'security-user@aurora.test';
  const admin = await register(adminEmail, 'securityadmin', adminPassword);
  const secondAdmin = await register('security-admin-two@aurora.test', 'securityadmin2', 'AuroraSecondPass123!');
  const regular = await register(userEmail, 'securityuser', 'AuroraUserPass123!');
  const sessionUser = await register('security-session@aurora.test', 'securitysession', 'AuroraSessionPass123!');
  const totpSecret = 'JBSWY3DPEHPK3PXP';
  const database = new Database(path.join(dataDir, 'aurora.db'));
  database.prepare('UPDATE users SET is_admin = 1, email_verified = 1 WHERE id = ?').run(admin.user.id);
  database.prepare('UPDATE users SET is_admin = 1, email_verified = 1 WHERE id = ?').run(secondAdmin.user.id);
  database.prepare(`INSERT INTO user_two_factor
    (user_id, secret, enabled, recovery_codes, created_at, updated_at)
    VALUES (?, ?, 1, '[]', ?, ?)`).run(admin.user.id, totpSecret, Date.now(), Date.now());
  database.close();

  const dashboardPath = '/internal/security/dashboard';
  const denied = await internalRequest(base, secret, dashboardPath, { actorId: regular.user.id });
  assert.equal(denied.status, 403);
  const dashboardBody = { actorId: admin.user.id };
  const replayHeaders = signedHeaders(secret, dashboardPath, dashboardBody);
  assert.equal((await internalRequest(base, secret, dashboardPath, dashboardBody, replayHeaders)).status, 200);
  assert.equal((await internalRequest(base, secret, dashboardPath, dashboardBody, replayHeaders)).status, 401);

  async function reauthenticate(command, password = adminPassword) {
    return internalRequest(base, secret, '/internal/security/reauth', {
      actorId: admin.user.id,
      password,
      code: totp(totpSecret),
      command,
    });
  }
  const badPassword = await reauthenticate('security:level:1', 'incorrect-password');
  assert.equal(badPassword.status, 401);
  const noMfa = await internalRequest(base, secret, '/internal/security/reauth', {
    actorId: secondAdmin.user.id,
    password: 'AuroraSecondPass123!',
    code: totp(totpSecret),
    command: 'security:level:1',
  });
  assert.equal(noMfa.status, 403);

  async function command(commandName, extra = {}, idempotencyKey = crypto.randomUUID()) {
    const challenge = await reauthenticate(commandName);
    assert.equal(challenge.status, 200, JSON.stringify(challenge.data));
    return internalRequest(base, secret, '/internal/security/response', {
      actorId: admin.user.id,
      command: commandName,
      proof: challenge.data.proof,
      reason: 'incident_containment',
      idempotencyKey,
      ...extra,
    });
  }

  const sessionId = JSON.parse(Buffer.from(sessionUser.token.split('.')[1], 'base64url').toString('utf8')).jti;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(sessionUser.token)}`, {
    headers: { Origin: 'https://aurora.test' },
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const socketClosed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
  assert.equal((await command('security:restriction:add', {
    kind: 'session', target: sessionId, durationMs: 60 * 60 * 1000,
  })).status, 200);
  assert.equal(await socketClosed, 4001);

  const restrictionKey = crypto.randomUUID();
  assert.equal((await command('security:restriction:add', {
    kind: 'account', target: String(regular.user.id), durationMs: 60 * 60 * 1000,
  }, restrictionKey)).status, 200);
  assert.equal((await command('security:restriction:add', {
    kind: 'account', target: String(regular.user.id), durationMs: 60 * 60 * 1000,
  }, restrictionKey)).status, 409);
  assert.equal((await command('security:restriction:add', {
    kind: 'account', target: String(admin.user.id), durationMs: 60 * 60 * 1000,
  })).status, 403);
  assert.equal((await command('security:restriction:add', {
    kind: 'ip', target: '203.0.113.10', durationMs: 60 * 60 * 1000,
  })).status, 503);
  let dashboard = await internalRequest(base, secret, dashboardPath, dashboardBody);
  assert.equal(dashboard.data.restrictions.filter((item) => item.kind === 'account' && item.target === String(regular.user.id)).length, 1);

  assert.equal((await command('security:level:1')).status, 200);
  await stop();
  await start();
  dashboard = await internalRequest(base, secret, dashboardPath, dashboardBody);
  assert.equal(dashboard.data.state.level, 1);
  assert.equal((await command('security:level:2')).status, 200);
  await stop();
  await start();
  dashboard = await internalRequest(base, secret, dashboardPath, dashboardBody);
  assert.equal(dashboard.data.state.level, 2);
  assert.equal((await command('security:level:3', { consequencesConfirmed: true })).status, 200);
  await stop();
  await start();
  dashboard = await internalRequest(base, secret, dashboardPath, dashboardBody);
  assert.equal(dashboard.data.state.level, 3);

  assert.equal((await jsonRequest(base, '/api/auth/login', {
    method: 'POST',
    body: { email: userEmail, password: 'AuroraUserPass123!' },
  })).status, 503);
  assert.equal((await jsonRequest(base, '/api/auth/login', {
    method: 'POST',
    body: { email: adminEmail, password: adminPassword, code: totp(totpSecret) },
  })).status, 200);
  assert.equal((await jsonRequest(base, '/api/messages', {
    method: 'POST',
    token: regular.token,
    body: { text: 'blocked by emergency mode' },
  })).status, 503);
  assert.equal((await jsonRequest(base, '/api/media/', {
    method: 'POST',
    token: regular.token,
    body: {},
  })).status, 503);
  assert.equal((await jsonRequest(base, '/api/admin/overview', {
    method: 'GET',
    token: admin.token,
  })).status, 503);
  assert.equal((await jsonRequest(base, '/api/calls/incoming', { token: admin.token })).status, 200);
  assert.equal((await internalRequest(base, secret, dashboardPath, dashboardBody)).status, 200);

  assert.equal((await command('security:level:2', { reason: 'recovery', recoveryConfirmed: true })).status, 200);
  assert.equal((await command('security:level:1', { reason: 'recovery', recoveryConfirmed: true })).status, 200);
  assert.equal((await command('security:level:0', { reason: 'recovery', recoveryConfirmed: true })).status, 200);
  dashboard = await internalRequest(base, secret, dashboardPath, dashboardBody);
  assert.equal(dashboard.data.state.level, 0);

  const mainDb = new Database(path.join(dataDir, 'aurora.db'), { readonly: true });
  const primaryTables = mainDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name);
  assert.equal(primaryTables.some((name) => name.startsWith('security_') && name !== 'security_sso_codes'), false);
  mainDb.close();
  const securityDb = new Database(storeFile);
  const verifier = openSecurityStore(storeFile);
  assert.deepEqual(verifier.verifyChains(), {
    events: true,
    adminAudit: true,
  });
  const auditCount = securityDb.prepare('SELECT COUNT(*) AS count FROM security_admin_audit').get().count;
  assert.ok(auditCount >= 7);
  const firstAudit = securityDb.prepare('SELECT id FROM security_admin_audit ORDER BY id LIMIT 1').get();
  assert.throws(() => securityDb.prepare('UPDATE security_admin_audit SET reason = ? WHERE id = ?').run('tampered', firstAudit.id));
  assert.throws(() => securityDb.prepare('DELETE FROM security_admin_audit WHERE id = ?').run(firstAudit.id));
  securityDb.close();
  verifier.close();
});
