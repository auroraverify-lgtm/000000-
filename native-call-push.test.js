import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('native call push recipients are active invited sessions only', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-native-call-push-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  const { db, nativePushTokens } = await import('../server/db.js');
  const timestamp = Date.now();

  t.after(() => {
    db.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const insertUser = db.prepare(`INSERT INTO users (id, email, username, name, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'test-hash', ?, ?)`);
  insertUser.run(1, 'caller@example.test', 'caller', 'Caller', timestamp, timestamp);
  insertUser.run(2, 'callee@example.test', 'callee', 'Callee', timestamp, timestamp);
  insertUser.run(3, 'revoked@example.test', 'revoked', 'Revoked', timestamp, timestamp);
  db.prepare('INSERT INTO settings (user_id, updated_at) VALUES (2, ?)').run(timestamp);
  db.prepare(`INSERT INTO chats (id, type, title, created_at) VALUES (10, 'dm', 'Call', ?)`).run(timestamp);
  db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (10, 1, ?), (10, 2, ?), (10, 3, ?)')
    .run(timestamp, timestamp, timestamp);
  db.prepare(`INSERT INTO sessions (id, user_id, created_at, last_seen, expires_at)
    VALUES ('active-session', 2, ?, ?, ?), ('revoked-session', 3, ?, ?, ?)`)
    .run(timestamp, timestamp, timestamp + 60_000, timestamp, timestamp, timestamp + 60_000);
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = 'revoked-session'`).run(timestamp);
  db.prepare(`INSERT INTO native_push_tokens (token, user_id, session_id, created_at, updated_at)
    VALUES ('active-device-token', 2, 'active-session', ?, ?), ('revoked-device-token', 3, 'revoked-session', ?, ?)`)
    .run(timestamp, timestamp, timestamp, timestamp);
  db.prepare(`INSERT INTO calls (id, chat_id, room_name, started_by, media_mode, started_at)
    VALUES ('123e4567-e89b-42d3-a456-426614174000', 10, 'room', 1, 'audio', ?)`).run(timestamp);
  db.prepare(`INSERT INTO call_participants (call_id, user_id, identity, status, invited_at)
    VALUES ('123e4567-e89b-42d3-a456-426614174000', 1, 'caller-1', 'joined', ?),
      ('123e4567-e89b-42d3-a456-426614174000', 2, 'callee-2', 'invited', ?),
      ('123e4567-e89b-42d3-a456-426614174000', 3, 'revoked-3', 'invited', ?)`)
    .run(timestamp, timestamp, timestamp);

  const recipients = nativePushTokens.forCall.all(
    '123e4567-e89b-42d3-a456-426614174000',
    timestamp,
    1,
  );
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].token, 'active-device-token');
  assert.equal(recipients[0].user_id, 2);

  db.prepare("UPDATE call_participants SET status = 'joined' WHERE user_id = 2").run();
  assert.deepEqual(nativePushTokens.forCall.all(
    '123e4567-e89b-42d3-a456-426614174000',
    timestamp,
    1,
  ), []);
});
