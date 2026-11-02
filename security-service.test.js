import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function signedHeaders(secret, body, requestPath) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(18).toString('hex');
  const signature = crypto.createHmac('sha256', secret)
    .update(`POST\n${requestPath}\n${timestamp}\n${nonce}\n${body}`).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Aurora-Timestamp': timestamp,
    'X-Aurora-Nonce': nonce,
    'X-Aurora-Signature': signature,
  };
}

test('Security internal APIs enforce signatures and keep a metadata-only review queue', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aurora-security-test-'));
  const port = await availablePort();
  const messengerPort = await availablePort();
  const secret = crypto.randomBytes(32).toString('hex');
  const baseUrl = `http://127.0.0.1:${port}`;
  let messengerRequest = null;
  const signedMessengerRequests = [];
  const messenger = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const timestamp = req.headers['x-aurora-timestamp'];
      const nonce = req.headers['x-aurora-nonce'];
      const signature = req.headers['x-aurora-signature'];
      const expected = crypto.createHmac('sha256', secret)
        .update(`${req.method}\n${req.url}\n${timestamp}\n${nonce}\n${body}`).digest('hex');
      const routes = [
        '/internal/security/chats',
        '/internal/security/admin-status',
        '/internal/security/dashboard',
        '/internal/security/reauth',
        '/internal/security/response',
      ];
      if (!routes.includes(req.url) || signature !== expected) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid signature' }));
        return;
      }
      if (req.url === '/internal/security/admin-status') {
        signedMessengerRequests.push({ route: req.url, body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ isAdmin: true }));
        return;
      }
      if (req.url === '/internal/security/dashboard') {
        signedMessengerRequests.push({ route: req.url, body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: { level: 0 }, counts: {}, events: [], incidents: [], restrictions: [], sessions: [], audit: [], notifications: [] }));
        return;
      }
      if (req.url === '/internal/security/reauth') {
        signedMessengerRequests.push({ route: req.url, body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ proof: 'short-lived-test-proof', expiresAt: Date.now() + 300000 }));
        return;
      }
      if (req.url === '/internal/security/response') {
        signedMessengerRequests.push({ route: req.url, body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: { level: 1 } }));
        return;
      }
      messengerRequest = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        chats: [{
          id: 17,
          type: messengerRequest.type === 'channel' ? 'channel' : 'group',
          title: 'Test group',
          username: null,
          description: 'Metadata only',
          isPublic: false,
          isFrozen: false,
          memberCount: 3,
          createdAt: 123,
        }],
        nextCursor: null,
      }));
    });
  });
  await new Promise((resolve) => messenger.listen(messengerPort, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['security/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SECURITY_HOST: '127.0.0.1',
      SECURITY_PORT: String(port),
      SECURITY_DATA_DIR: dataDir,
      AURORA_SECURITY_SSO_SECRET: secret,
      AURORA_ORIGIN: 'https://messenger.example.test',
      AURORA_API_URL: `http://127.0.0.1:${messengerPort}`,
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
    await new Promise((resolve) => messenger.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      healthy = response.ok;
      if (healthy) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, `Security service did not start: ${output}`);
  assert.equal((await fetch(`${baseUrl}/api/overview`)).status, 401);
  const ssoOriginCheck = await fetch(`${baseUrl}/auth/sso`, {
    method: 'POST',
    headers: {
      Origin: 'https://messenger.example.test:443',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'code=invalid-probe-code',
  });
  assert.equal(ssoOriginCheck.status, 401);
  assert.match(await ssoOriginCheck.text(), /Вход не выполнен/);
  const opaqueSsoOriginCheck = await fetch(`${baseUrl}/auth/sso`, {
    method: 'POST',
    headers: {
      Origin: 'null',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'code=invalid-probe-code',
  });
  assert.equal(opaqueSsoOriginCheck.status, 401);
  assert.match(await opaqueSsoOriginCheck.text(), /Вход не выполнен/);
  const rejectedOrigin = await fetch(`${baseUrl}/auth/sso`, {
    method: 'POST',
    headers: {
      Origin: 'https://unexpected.example.test',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'code=invalid-probe-code',
  });
  assert.equal(rejectedOrigin.status, 401);
  assert.match(await rejectedOrigin.text(), /Вход не выполнен/);

  const postInternal = async (route, payload) => {
    const body = JSON.stringify(payload);
    return fetch(`${baseUrl}${route}`, { method: 'POST', headers: signedHeaders(secret, body, route), body });
  };
  const crossRouteBody = JSON.stringify({ context: 'dm', domains: ['example.com'] });
  const crossRouteResponse = await fetch(`${baseUrl}/internal/moderation/message`, {
    method: 'POST',
    headers: signedHeaders(secret, crossRouteBody, '/internal/check-domains'),
    body: crossRouteBody,
  });
  assert.equal(crossRouteResponse.status, 401);
  const domainResponse = await postInternal('/internal/check-domains', {
    context: 'dm',
    domains: ['example.com', '127.0.0.1'],
  });
  assert.equal(domainResponse.status, 200);
  const domainResult = await domainResponse.json();
  assert.equal(domainResult.results[0].status, 'unknown');
  assert.equal(domainResult.results[1].status, 'suspicious');

  const seedDatabase = new Database(path.join(dataDir, 'security.db'));
  seedDatabase.prepare(`INSERT INTO moderation_rules (name, category, rule_json, enabled, updated_at)
    VALUES (?, 'keyword', ?, 1, ?)`).run('Test blocked phrase', JSON.stringify({ terms: ['forbidden test phrase'] }), Date.now());
  seedDatabase.prepare(`INSERT INTO phishing_domains (domain, status, source, reason, created_at, updated_at)
    VALUES (?, 'blocked', 'owner', 'test', ?, ?)`).run('blocked.example.test', Date.now(), Date.now());
  seedDatabase.close();
  const outgoingResponse = await postInternal('/internal/content/check', {
    chatId: 7,
    userId: 19,
    context: 'dm',
    text: 'FORBIDDEN test phrase https://blocked.example.test/private?token=do-not-store',
  });
  assert.equal(outgoingResponse.status, 200);
  const outgoing = await outgoingResponse.json();
  assert.equal(outgoing.blocked, true);
  assert.deepEqual(outgoing.blockedDomains, ['blocked.example.test']);
  assert.equal(outgoing.blockedRules.length, 1);
  assert.equal(outgoing.message, 'Ссылка содержит домен, заблокированный в Aurora Security');
  const allowedOutgoing = await postInternal('/internal/content/check', {
    chatId: 7, userId: 19, context: 'group', text: 'Обычное сообщение без запрещённых правил',
  });
  assert.equal((await allowedOutgoing.json()).blocked, false);

  const moderationResponse = await postInternal('/internal/moderation/message', {
    chatId: 7,
    messageId: 42,
    userId: 19,
    context: 'group',
    text: 'https://spam.example/a https://spam.example/b https://spam.example/c https://spam.example/d',
  });
  assert.equal(moderationResponse.status, 200);
  assert.equal((await moderationResponse.json()).flagged, true);

  await postInternal('/internal/moderation/message', {
    chatId: 7,
    messageId: 43,
    userId: 19,
    context: 'group',
    text: 'https://spam.example/a https://spam.example/b https://spam.example/c https://spam.example/d',
  });
  const editedSafe = await postInternal('/internal/moderation/message', {
    chatId: 7,
    messageId: 43,
    userId: 19,
    context: 'group',
    text: 'Исправленное сообщение без ссылок',
  });
  assert.equal((await editedSafe.json()).flagged, false);

  const verificationResponse = await postInternal('/internal/verification/request', { userId: 19, kind: 'phone' });
  assert.equal(verificationResponse.status, 201);
  const phoneRequest = await verificationResponse.json();
  const officialResponse = await postInternal('/internal/verification/request', { userId: 19, kind: 'official' });
  assert.equal(officialResponse.status, 201);
  const officialRequest = await officialResponse.json();
  const pendingVerification = await postInternal('/internal/verification/status', { userId: 19 });
  const pendingState = await pendingVerification.json();
  assert.equal(pendingState.verifications.pending.length, 2);

  const database = new Database(path.join(dataDir, 'security.db'), { readonly: true });
  try {
    const originMismatch = database.prepare(`SELECT details_json FROM security_audit_log
      WHERE event_type = 'sso_origin_mismatch' ORDER BY id DESC LIMIT 1`).get();
    assert.deepEqual(JSON.parse(originMismatch.details_json), {
      receivedOrigin: 'https://unexpected.example.test',
      expectedOrigin: 'https://messenger.example.test',
    });
    const review = database.prepare('SELECT * FROM moderation_cases WHERE source_id = ?').get('42');
    assert.ok(review);
    assert.equal(JSON.stringify(review).includes('spam.example'), false);
    assert.equal(database.prepare('SELECT status FROM moderation_cases WHERE source_id = ?').get('43').status, 'approved');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM url_scan_results WHERE context = 'dm'").get().count, 0);
    const blockedAudit = database.prepare("SELECT details_json FROM security_audit_log WHERE event_type = 'outgoing_content_blocked'").get();
    assert.ok(blockedAudit);
    assert.equal(blockedAudit.details_json.includes('forbidden test phrase'), false);
    assert.equal(blockedAudit.details_json.includes('private?token'), false);
    assert.equal(database.prepare('SELECT details_json FROM verification_requests WHERE user_id = ?').get(19).details_json, '{}');
  } finally {
    database.close();
  }

  const ownerToken = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const ownerDatabase = new Database(path.join(dataDir, 'security.db'));
  try {
    ownerDatabase.prepare(`INSERT INTO security_sessions
      (token_hash, user_id, email, name, csrf_token, created_at, last_seen, expires_at)
      VALUES (?, 1, 'owner@example.test', 'Owner', ?, ?, ?, ?)`)
      .run(crypto.createHash('sha256').update(ownerToken).digest('hex'), csrfToken, Date.now(), Date.now(), Date.now() + 60000);
  } finally {
    ownerDatabase.close();
  }

  const ownerHeaders = {
    Cookie: `aurora_security=${encodeURIComponent(ownerToken)}`,
    Origin: baseUrl,
    'Content-Type': 'application/json',
  };
  const dashboard = await fetch(`${baseUrl}/api/security/dashboard`, { headers: ownerHeaders });
  assert.equal(dashboard.status, 200);
  assert.equal((await dashboard.json()).state.level, 0);
  const reauth = await fetch(`${baseUrl}/api/security/reauth`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ password: 'not-logged', code: '123456', command: 'security:level:1', csrfToken }),
  });
  assert.equal(reauth.status, 200);
  const proof = await reauth.json();
  const response = await fetch(`${baseUrl}/api/security/response`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      command: 'security:level:1',
      proof: proof.proof,
      reason: 'incident_containment',
      idempotencyKey: crypto.randomUUID(),
      csrfToken,
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(signedMessengerRequests.map((item) => item.route), [
    '/internal/security/admin-status',
    '/internal/security/dashboard',
    '/internal/security/admin-status',
    '/internal/security/reauth',
    '/internal/security/admin-status',
    '/internal/security/response',
  ]);
  assert.equal(signedMessengerRequests.some((item) => item.body.password === 'not-logged'), true);
  const ownerChatList = await fetch(`${baseUrl}/api/chats?type=group&cursor=21&limit=10`, {
    headers: ownerHeaders,
  });
  assert.equal(ownerChatList.status, 200);
  assert.deepEqual(await ownerChatList.json(), {
    chats: [{
      id: 17,
      type: 'group',
      title: 'Test group',
      username: null,
      description: 'Metadata only',
      isPublic: false,
      isFrozen: false,
      memberCount: 3,
      createdAt: 123,
    }],
    nextCursor: null,
  });
  assert.deepEqual(messengerRequest, { type: 'group', cursor: 21, limit: 10 });

  const missingCsrf = await fetch(`${baseUrl}/api/phishing/domains`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ domain: 'blocked.example', status: 'blocked', reason: 'Missing CSRF' }),
  });
  assert.equal(missingCsrf.status, 403);

  const domainBody = JSON.stringify({ domain: 'blocked.example', status: 'blocked', reason: 'Test block', csrfToken });
  const savedDomain = await fetch(`${baseUrl}/api/phishing/domains`, {
    method: 'POST',
    headers: ownerHeaders,
    body: domainBody,
  });
  assert.equal(savedDomain.status, 200);

  const reviewPhone = await fetch(`${baseUrl}/api/verification/requests/${phoneRequest.request.id}/review`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ action: 'approve', csrfToken }),
  });
  assert.equal(reviewPhone.status, 200);
  const phoneApproved = await postInternal('/internal/verification/status', { userId: 19 });
  const phoneState = await phoneApproved.json();
  assert.equal(phoneState.verifications.phone, true);
  assert.equal(phoneState.verifications.official, false);
  assert.equal(phoneState.verifications.pending[0].kind, 'official');

  const reviewOfficial = await fetch(`${baseUrl}/api/verification/requests/${officialRequest.request.id}/review`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ action: 'approve', csrfToken }),
  });
  assert.equal(reviewOfficial.status, 200);
  const bothApproved = await postInternal('/internal/verification/status', { userId: 19 });
  const bothState = await bothApproved.json();
  assert.equal(bothState.verifications.phone, true);
  assert.equal(bothState.verifications.official, true);

  const blocked = await postInternal('/internal/check-domains', {
    context: 'dm',
    domains: ['sub.blocked.example'],
  });
  assert.equal((await blocked.json()).results[0].status, 'blocked');

  const cases = await fetch(`${baseUrl}/api/moderation/cases?status=review_required`, {
    headers: { Cookie: `aurora_security=${encodeURIComponent(ownerToken)}` },
  });
  assert.equal(cases.status, 200);
  assert.equal((await cases.json()).cases.length, 1);
});
