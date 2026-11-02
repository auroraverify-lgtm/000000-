import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { getRequestIpAssessment, recordLoginFailure, recordSecurityEvent } from '../server/security-events.js';
import { initializeSecurityStore, openSecurityStore } from '../server/security-store.js';

test('security events are minimized, thresholded, deduplicated and stored separately', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-security-monitoring-'));
  const file = path.join(directory, 'security-events.db');
  let store;
  t.after(() => {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.deepEqual(initializeSecurityStore(file), { initialized: true, version: 3 });
  assert.deepEqual(initializeSecurityStore(file), { initialized: false, version: 3 });
  store = openSecurityStore(file);
  const timestamp = Date.now();
  const proofHash = crypto.createHash('sha256').update('one-time-proof').digest('hex');
  store.createReauth({ proofHash, actorId: 7, action: 'security:level:1', createdAt: timestamp, expiresAt: timestamp + 60_000 });
  assert.equal(store.consumeReauth({ proofHash, actorId: 7, action: 'security:level:1', timestamp }), true);
  assert.equal(store.consumeReauth({ proofHash, actorId: 7, action: 'security:level:1', timestamp }), false);
  assert.equal(store.consumeReauthAttempt(7, timestamp, 60_000, 2).ok, true);
  assert.equal(store.consumeReauthAttempt(7, timestamp + 1, 60_000, 2).ok, true);
  assert.equal(store.consumeReauthAttempt(7, timestamp + 2, 60_000, 2).ok, false);
  const request = {
    method: 'POST',
    path: '/api/auth/login',
    socket: { remoteAddress: '203.0.113.15' },
    headers: { 'x-forwarded-for': '198.51.100.27', 'x-forwarded-proto': 'https' },
  };
  assert.deepEqual(getRequestIpAssessment(request), {
    ipAddress: '203.0.113.15',
    ipConfidence: 'tcp_peer',
  });
  assert.deepEqual(getRequestIpAssessment({ socket: { remoteAddress: '127.0.0.1' } }), {
    ipAddress: null,
    ipConfidence: 'unknown_proxy_peer',
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    recordLoginFailure(request, 'private-user@example.test');
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    recordSecurityEvent({ type: 'ws.protocol_anomaly', req: request, actorId: 55, subject: 'user:55' });
  }
  recordSecurityEvent({
    type: 'access.denied',
    req: request,
    subject: 'chat:private',
    details: {
      reason: 'a password=never-store token=never-store',
      body: 'private message text',
      content: 'personal conversation',
      authorization: 'Bearer never-store',
      route: '/api/chats/42/messages',
      method: 'POST',
      status: 403,
    },
  });

  const events = store.listEvents({ limit: 20 });
  const failures = events.filter((event) => event.event_type === 'auth.login_failed');
  assert.equal(failures.length, 2);
  assert.equal(failures.some((event) => event.severity === 'high'), true);
  assert.equal(store.countEvents('auth.login_failed', 0), 2);
  assert.equal(store.countThresholdEvents('auth.login_failed', 0, 10 * 60 * 1000), 6);
  assert.equal(events.every((event) => !JSON.stringify(event).includes('private-user@example.test')), true);
  assert.equal(events.every((event) => !JSON.stringify(event).includes('never-store')), true);
  assert.equal(events.every((event) => !JSON.stringify(event).includes('private message text')), true);
  assert.equal(events.every((event) => !JSON.stringify(event).includes('personal conversation')), true);
  assert.equal(store.listIncidents({ limit: 20 }).some((incident) => incident.event_type === 'auth.login_failed'), true);
  assert.equal(store.listNotifications(20).some((item) => item.title.includes('auth.login_failed')), true);
  assert.equal(events.some((event) => event.event_type === 'ws.protocol_anomaly' && event.severity === 'high'), true);

  const rows = store.db.prepare('SELECT * FROM security_events ORDER BY id').all();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const previousHash = index ? rows[index - 1].entry_hash : '';
    assert.equal(row.previous_hash, previousHash);
    const entry = {
      created_at: row.created_at,
      event_type: row.event_type,
      severity: row.severity,
      actor_id: row.actor_id,
      session_id: row.session_id,
      ip_address: row.ip_address,
      ip_confidence: row.ip_confidence,
      subject_hash: row.subject_hash,
      details_json: row.details_json,
      event_key: row.event_key,
      previous_hash: row.previous_hash,
    };
    const hash = crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');
    assert.equal(row.entry_hash, hash);
  }
  assert.deepEqual(store.verifyChains(), { events: true, adminAudit: true });
  assert.throws(() => store.db.prepare('UPDATE security_events SET severity = ? WHERE id = ?').run('info', rows[0].id));
  assert.throws(() => store.db.prepare('DELETE FROM security_events WHERE id = ?').run(rows[0].id));

  const primary = new Database(path.join(directory, 'aurora.db'));
  primary.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  const userTables = primary.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name);
  assert.equal(userTables.some((name) => name.startsWith('security_')), false);
  primary.close();
  assert.notEqual(path.resolve(store.db.name), path.resolve(path.join(directory, 'aurora.db')));
});
