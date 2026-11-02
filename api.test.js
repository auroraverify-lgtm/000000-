/**
 * Интеграционные тесты: полный путь пользователя от регистрации до real-time синхронизации.
 * Запуск: npm test   (поднимает сервер на отдельной БД во временном каталоге)
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { initializeSecurityStore } from '../server/security-store.js';

const PORT = 3711;
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLIC_ORIGIN = 'https://aurora.test';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-test-'));
const SECURITY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-security-api-test-'));
const SECURITY_SECRET = crypto.randomBytes(32).toString('hex');
const CONSENT = {
  termsVersion: '2026-10-30-v2',
  privacyVersion: '2026-10-30-v2',
  personalDataConsent: true,
  ageGuardianAttestation: true,
};
let child;
let securityChild;
let securityPort;
let yookassaMock;
let yookassaPort;
const mockPayments = new Map();
const mockPaymentIdempotency = new Map();

/** Поднять изолированный экземпляр сервера (своя БД, свой порт). */
async function startServer({ port, dataDir, env = {} }) {
  const securityStoreFile = path.join(dataDir, 'security-events.db');
  initializeSecurityStore(securityStoreFile);
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      SECURITY_STORE_FILE: securityStoreFile,
      HOST: '127.0.0.1',
      PUBLIC_ORIGIN,
      TRUST_PROXY_ADDRESSES: '127.0.0.1/32',
      YOOKASSA_MODE: '',
      YOOKASSA_SHOP_ID: '',
      YOOKASSA_SECRET_KEY: '',
      YOOKASSA_API_URL: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if ((await r.json()).ok) return proc;
    } catch { /* ждём */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Сервер на порту ${port} не поднялся`);
}

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  await new Promise((resolve) => {
    const finish = () => resolve();
    proc.once('exit', finish);
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
      resolve();
    }, 3000).unref();
  });
}

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

async function startSecurityServer(port, dataDir) {
  const proc = spawn(process.execPath, ['security/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SECURITY_HOST: '127.0.0.1',
      SECURITY_PORT: String(port),
      SECURITY_DATA_DIR: dataDir,
      AURORA_SECURITY_SSO_SECRET: SECURITY_SECRET,
      AURORA_ORIGIN: 'https://messenger.example.test',
      AURORA_API_URL: 'https://messenger.example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (data) => process.stderr.write(`[security:${port}] ${data}`));
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if ((await response.json()).ok) return proc;
    } catch { /* wait for startup */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Security service on port ${port} did not start`);
}

async function startYooKassaMock() {
  yookassaMock = http.createServer(async (req, res) => {
    const auth = `Basic ${Buffer.from('100000:test-secret').toString('base64')}`;
    if (req.headers.authorization !== auth) {
      res.writeHead(401).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.method === 'POST' && req.url === '/v3/payments') {
      const key = req.headers['idempotence-key'];
      let payment = mockPaymentIdempotency.get(key);
      if (!payment) {
        const id = crypto.randomUUID();
        payment = {
          id,
          status: 'pending',
          paid: false,
          amount: body.amount,
          payment_method_data: body.payment_method_data,
          requestBody: body,
          confirmation: { type: 'redirect', confirmation_url: `https://yoomoney.ru/checkout/${id}` },
          metadata: body.metadata,
        };
        mockPaymentIdempotency.set(key, payment);
        mockPayments.set(id, payment);
      }
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify(payment));
      return;
    }
    const match = req.method === 'GET' && req.url.match(/^\/v3\/payments\/([\da-f-]{36})$/i);
    if (match) {
      const payment = mockPayments.get(match[1]);
      res.writeHead(payment ? 200 : 404, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(payment || { error: 'not_found' }));
      return;
    }
    res.writeHead(404).end();
  });
  yookassaPort = await availablePort();
  await new Promise((resolve, reject) => {
    yookassaMock.once('error', reject);
    yookassaMock.listen(yookassaPort, '127.0.0.1', resolve);
  });
}

const api = async (method, url, { token, body, raw } = {}) => {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json, headers: res.headers };
};

const register = async (suffix) => {
  const r = await api('POST', '/api/auth/register', {
    body: { email: `user${suffix}@aurora.test`, password: `Passw0rd${suffix}`, name: `Тест ${suffix}`, username: `tester${suffix}`, bio: 'био', ...CONSENT },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.token);
  assert.equal(r.body.user.emailVerified, false);
  assert.equal(r.body.emailVerification.sent, true);
  assert.match(r.body.emailVerification.testCode, /^\d{6}$/);
  const verified = await api('POST', '/api/auth/email-verification/verify', {
    token: r.body.token,
    body: { code: r.body.emailVerification.testCode },
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.user.emailVerified, true);
  return { ...r.body, user: verified.body.user };
};

test('публичные SEO-метаданные, robots.txt и sitemap доступны без авторизации', async () => {
  const home = await api('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.body.raw, /<title>Aurora Messenger — мессенджер для общения, чатов и звонков<\/title>/);
  assert.match(home.body.raw, /rel="canonical" href="https:\/\/snobbishly-bountiful-quail\.cloudpub\.ru\/"/);
  assert.match(home.body.raw, /"@type": "SoftwareApplication"/);
  assert.match(home.body.raw, /Aurora Messenger — мессенджер для общения/);

  const robots = await api('GET', '/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.body.raw, /Sitemap: https:\/\/snobbishly-bountiful-quail\.cloudpub\.ru\/sitemap\.xml/);

  const sitemap = await api('GET', '/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.body.raw, /<loc>https:\/\/snobbishly-bountiful-quail\.cloudpub\.ru\/<\/loc>/);
});

test('истории доступны контактам 24 часа, отмечаются просмотром и лайком, ответы отправляются в DM', async () => {
  const suffix = Date.now().toString(36);
  const author = await register(`sa${suffix}`);
  const contact = await register(`sc${suffix}`);
  const outsider = await register(`so${suffix}`);
  const group = await api('POST', '/api/chats/group', {
    token: author.token,
    body: { title: `Истории ${suffix}`, memberIds: [contact.user.id] },
  });
  assert.equal(group.status, 201, JSON.stringify(group.body));

  const unauthenticated = await api('POST', '/api/stories', { body: { type: 'text', text: 'Привет' } });
  assert.equal(unauthenticated.status, 401);
  const invalid = await api('POST', '/api/stories', {
    token: author.token,
    body: { type: 'text', text: '   ' },
  });
  assert.equal(invalid.status, 400);

  const created = await api('POST', '/api/stories', {
    token: author.token,
    body: { type: 'text', text: 'Привет, контакты!' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const story = created.body.story;
  assert.equal(story.type, 'text');
  assert.equal(story.expiresAt - story.createdAt, 24 * 60 * 60 * 1000);
  assert.equal(story.text, 'Привет, контакты!');

  const decoratedText = '\u2063{"b":3,"f":2,"q":[1.25,0.1,-0.05,90],"y":[["e","⭐",0.5,0.5,1,0,0,0,0]]}\u2063История со стикером';
  const decorated = await api('POST', '/api/stories', {
    token: author.token,
    body: { type: 'text', text: decoratedText },
  });
  assert.equal(decorated.status, 201, JSON.stringify(decorated.body));
  assert.equal(decorated.body.story.text, decoratedText);
  const decoratedFeed = await api('GET', '/api/stories', { token: contact.token });
  assert.equal(
    decoratedFeed.body.stories.find((item) => item.id === decorated.body.story.id)?.text,
    decoratedText,
  );

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  const imageForm = new FormData();
  imageForm.append('file', new Blob([png], { type: 'image/png' }), 'story.png');
  imageForm.append('kind', 'image');
  const imageUpload = await api('POST', '/api/media', { token: author.token, raw: imageForm });
  assert.equal(imageUpload.status, 201, JSON.stringify(imageUpload.body));
  const imageStory = await api('POST', '/api/stories', {
    token: author.token,
    body: { type: 'image', mediaId: imageUpload.body.media.id, text: 'Фото' },
  });
  assert.equal(imageStory.status, 201, JSON.stringify(imageStory.body));
  assert.match(imageStory.body.story.mediaUrl, new RegExp(`/media/${imageUpload.body.media.id}\\?`));
  const stolenMedia = await api('POST', '/api/stories', {
    token: outsider.token,
    body: { type: 'image', mediaId: imageUpload.body.media.id },
  });
  assert.equal(stolenMedia.status, 403);

  const videoBytes = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom', 'ascii')]);
  const videoForm = new FormData();
  videoForm.append('file', new Blob([videoBytes], { type: 'video/mp4' }), 'story.mp4');
  videoForm.append('kind', 'video');
  const videoUpload = await api('POST', '/api/media', { token: author.token, raw: videoForm });
  assert.equal(videoUpload.status, 201, JSON.stringify(videoUpload.body));
  const videoStory = await api('POST', '/api/stories', {
    token: author.token,
    body: { type: 'video', mediaId: videoUpload.body.media.id },
  });
  assert.equal(videoStory.status, 201, JSON.stringify(videoStory.body));

  const contactFeed = await api('GET', '/api/stories', { token: contact.token });
  assert.equal(contactFeed.status, 200);
  assert.ok(contactFeed.body.stories.some((item) => item.id === story.id));
  assert.ok(contactFeed.body.stories.some((item) => item.id === imageStory.body.story.id));
  assert.ok(contactFeed.body.stories.some((item) => item.id === videoStory.body.story.id));
  const outsiderFeed = await api('GET', '/api/stories', { token: outsider.token });
  assert.equal(outsiderFeed.status, 200);
  assert.equal(outsiderFeed.body.stories.some((item) => item.id === story.id), false);
  const outsiderView = await api('POST', `/api/stories/${story.id}/views`, { token: outsider.token });
  assert.equal(outsiderView.status, 404);

  const firstView = await api('POST', `/api/stories/${story.id}/views`, { token: contact.token });
  const repeatedView = await api('POST', `/api/stories/${story.id}/views`, { token: contact.token });
  assert.equal(firstView.status, 200);
  assert.equal(firstView.body.viewCount, 1);
  assert.equal(repeatedView.body.viewCount, 1);

  const liked = await api('POST', `/api/stories/${story.id}/likes`, { token: contact.token });
  const unliked = await api('POST', `/api/stories/${story.id}/likes`, { token: contact.token });
  assert.deepEqual(liked.body, { liked: true, likeCount: 1 });
  assert.deepEqual(unliked.body, { liked: false, likeCount: 0 });

  const dm = await api('POST', '/api/chats/dm', {
    token: contact.token,
    body: { userId: author.user.id },
  });
  assert.equal(dm.status, 200, JSON.stringify(dm.body));
  const replyText = '↩ Ответ на историю «Привет, контакты!»\nКрасиво!';
  const reply = await api('POST', `/api/chats/${dm.body.chat.id}/messages`, {
    token: contact.token,
    body: { text: replyText },
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.equal(reply.body.message.text, replyText);

  const foreignDelete = await api('DELETE', `/api/stories/${story.id}`, { token: contact.token });
  assert.equal(foreignDelete.status, 404);
  const deleted = await api('DELETE', `/api/stories/${story.id}`, { token: author.token });
  assert.equal(deleted.status, 200);
  assert.equal((await api('DELETE', `/api/stories/${decorated.body.story.id}`, { token: author.token })).status, 200);
  assert.equal((await api('DELETE', `/api/stories/${imageStory.body.story.id}`, { token: author.token })).status, 200);
  assert.equal((await api('DELETE', `/api/stories/${videoStory.body.story.id}`, { token: author.token })).status, 200);

  const expiring = await api('POST', '/api/stories', {
    token: author.token,
    body: { type: 'text', text: 'Временная история' },
  });
  assert.equal(expiring.status, 201);
  const testDb = new Database(path.join(DATA_DIR, 'aurora.db'));
  testDb.prepare('UPDATE stories SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expiring.body.story.id);
  testDb.close();
  const afterExpiry = await api('GET', '/api/stories', { token: contact.token });
  assert.equal(afterExpiry.body.stories.some((item) => item.id === expiring.body.story.id), false);
  const expiredView = await api('POST', `/api/stories/${expiring.body.story.id}/views`, { token: contact.token });
  assert.equal(expiredView.status, 404);
  assert.equal((await api('DELETE', `/api/stories/${expiring.body.story.id}`, { token: author.token })).status, 200);
});

test('звонковые API требуют аутентификацию', async () => {
  const incoming = await api('GET', '/api/calls/incoming');
  const history = await api('GET', '/api/calls/history');
  const start = await api('POST', '/api/chats/1/calls', { body: { mediaMode: 'audio' } });
  assert.equal(incoming.status, 401);
  assert.equal(history.status, 401);
  assert.equal(start.status, 401);
});

test('звонок без настроенного SFU явно завершается ошибкой конфигурации', async () => {
  const caller = await register('callcaller');
  const peer = await register('callpeer');
  const outsider = await register('calloutsider');
  const chat = await api('POST', '/api/chats/dm', {
    token: caller.token,
    body: { userId: peer.user.id },
  });
  assert.ok([200, 201].includes(chat.status), JSON.stringify(chat.body));
  const noAccess = await api('GET', `/api/chats/${chat.body.chat.id}/calls/active`, { token: outsider.token });
  assert.equal(noAccess.status, 403);
  const history = await api('GET', '/api/calls/history', { token: caller.token });
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.calls, []);
  const start = await api('POST', `/api/chats/${chat.body.chat.id}/calls`, {
    token: caller.token,
    body: { mediaMode: 'audio' },
  });
  assert.equal(start.status, 503);
  assert.match(start.body.error, /звонки временно не настроены/i);
});

test('замороженная группа не позволяет начать или присоединиться к звонку', async () => {
  const suffix = Date.now().toString(36);
  const owner = await register(`fo${suffix}`);
  const member = await register(`fm${suffix}`);
  const group = await api('POST', '/api/chats/group', {
    token: owner.token,
    body: { title: 'Замороженная группа' },
  });
  assert.equal(group.status, 201, JSON.stringify(group.body));
  const added = await api('POST', `/api/chats/${group.body.chat.id}/members`, {
    token: owner.token,
    body: { userIds: [member.user.id] },
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));

  const db = new Database(path.join(DATA_DIR, 'aurora.db'));
  db.prepare('UPDATE chats SET is_frozen = 1 WHERE id = ?').run(group.body.chat.id);
  const callId = crypto.randomUUID();
  const ts = Date.now();
  db.prepare(`INSERT INTO calls (id, chat_id, room_name, started_by, media_mode, status, started_at)
    VALUES (?, ?, ?, ?, 'audio', 'active', ?)`)
    .run(callId, group.body.chat.id, `test-${callId}`, owner.user.id, ts);
  db.close();

  const start = await api('POST', `/api/chats/${group.body.chat.id}/calls`, {
    token: member.token,
    body: { mediaMode: 'audio' },
  });
  assert.equal(start.status, 403);
  assert.match(start.body.error, /заморожен/i);

  const join = await api('POST', `/api/calls/${callId}/join`, { token: member.token });
  assert.equal(join.status, 403);
  assert.match(join.body.error, /заморожен/i);
});

/** Простейший WS-клиент с ожиданием событий. */
function connect(token, origin = PUBLIC_ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`, {
    headers: { Origin: origin },
  });
  const events = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw.toString());
    events.push(ev);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(ev)) { waiters[i].resolve(ev); waiters.splice(i, 1); }
    }
  });
  return {
    ws,
    events,
    open: () => new Promise((resolve) => ws.on('open', resolve)),
    close: () => ws.close(),
    wait: (type, timeout = 4000) => new Promise((resolve, reject) => {
      const hit = events.find((e) => e.type === type);
      if (hit) return resolve(hit);
      const w = { match: (e) => e.type === type, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`Таймаут ожидания события ${type}. Получено: ${events.map((e) => e.type).join(',')}`)), timeout);
    }),
  };
}

before(async () => {
  // Лимиты в тестах выше: сами лимиты проверяются отдельным экземпляром сервера ниже.
  securityPort = await availablePort();
  securityChild = await startSecurityServer(securityPort, SECURITY_DATA_DIR);
  const securityDb = new Database(path.join(SECURITY_DATA_DIR, 'security.db'));
  securityDb.prepare(`INSERT INTO moderation_rules (name, category, rule_json, enabled, updated_at)
    VALUES (?, 'keyword', ?, 1, ?)`).run(
    'API test forbidden phrase',
    JSON.stringify({ terms: ['aurora-test-forbiddenphrase-9042'] }),
    Date.now(),
  );
  securityDb.prepare(`INSERT INTO phishing_domains (domain, status, source, reason, created_at, updated_at)
    VALUES (?, 'blocked', 'owner', 'API test', ?, ?)`).run(
    'blocked.aurora.test',
    Date.now(),
    Date.now(),
  );
  securityDb.close();
  await startYooKassaMock();
  child = await startServer({
    port: PORT,
    dataDir: DATA_DIR,
    env: {
      RATE_MULT: '40', NODE_ENV: 'test', EMAIL_TEST_MODE: '1', ENABLE_DEMO_WALLET: '0',
      TRUST_PROXY_ADDRESSES: '127.0.0.1/32',
      AURORA_ADMIN_USERNAMES: 'testadmin', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '',
      AURORA_SECURITY_SSO_SECRET: SECURITY_SECRET,
      SECURITY_INTERNAL_URL: `http://127.0.0.1:${securityPort}`,
      YOOKASSA_MODE: 'test',
      YOOKASSA_SHOP_ID: '100000',
      YOOKASSA_SECRET_KEY: 'test-secret',
      YOOKASSA_API_URL: `http://127.0.0.1:${yookassaPort}/v3`,
    },
  });
});

after(async () => {
  await stopServer(child);
  await stopServer(securityChild);
  if (yookassaMock) await new Promise((resolve, reject) => yookassaMock.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(SECURITY_DATA_DIR, { recursive: true, force: true });
});

test('Aurora Security blocks forbidden phrases and domains before DM and group publication', async () => {
  const suffix = Date.now().toString(36);
  const sender = await register(`policy${suffix}`);
  const recipient = await register(`policypeer${suffix}`);
  const dm = await api('POST', '/api/chats/dm', {
    token: sender.token,
    body: { userId: recipient.user.id },
  });
  assert.equal(dm.status, 200);

  const blockedPhrase = await api('POST', `/api/chats/${dm.body.chat.id}/messages`, {
    token: sender.token,
    body: { type: 'text', text: 'aurora-test-forbiddenphrase-9042' },
  });
  assert.equal(blockedPhrase.status, 403);
  assert.match(blockedPhrase.body.error, /запрещённое слово или фразу/i);

  const blockedDomain = await api('POST', `/api/chats/${dm.body.chat.id}/messages`, {
    token: sender.token,
    body: { type: 'text', text: 'Посмотри blocked.aurora.test/path' },
  });
  assert.equal(blockedDomain.status, 403);
  assert.match(blockedDomain.body.error, /заблокированный/i);

  const allowed = await api('POST', `/api/chats/${dm.body.chat.id}/messages`, {
    token: sender.token,
    body: { type: 'text', text: 'Обычное сообщение' },
  });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
  const blockedEdit = await api('PATCH', `/api/messages/${allowed.body.message.id}`, {
    token: sender.token,
    body: { text: 'aurora-test-forbiddenphrase-9042' },
  });
  assert.equal(blockedEdit.status, 403);

  const group = await api('POST', '/api/chats/group', {
    token: sender.token,
    body: { title: 'Проверка правил' },
  });
  assert.equal(group.status, 201);
  const blockedGroupMessage = await api('POST', `/api/chats/${group.body.chat.id}/messages`, {
    token: sender.token,
    body: { type: 'text', text: 'aurora-test-forbiddenphrase-9042' },
  });
  assert.equal(blockedGroupMessage.status, 403);
});

test('signed Security requests can browse group and channel metadata only', async () => {
  const suffix = Date.now().toString(36).slice(-5);
  const owner = await register(`sec${suffix}`);
  const group = await api('POST', '/api/chats/group', {
    token: owner.token,
    body: { title: 'Проверяемая группа', description: 'Групповое описание' },
  });
  const channel = await api('POST', '/api/chats/channel', {
    token: owner.token,
    body: { title: 'Проверяемый канал', username: `seccheck${suffix}`, description: 'Описание канала', isPublic: true },
  });
  const dmPeer = await register(`peer${suffix}`);
  const dm = await api('POST', '/api/chats/dm', {
    token: owner.token,
    body: { userId: dmPeer.user.id },
  });
  assert.equal(group.status, 201);
  assert.equal(channel.status, 201);
  assert.equal(dm.status, 200);

  const route = '/internal/security/chats';
  const payload = JSON.stringify({ type: 'all', cursor: null, limit: 50 });
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(18).toString('hex');
  const signature = crypto.createHmac('sha256', SECURITY_SECRET)
    .update(`POST\n${route}\n${timestamp}\n${nonce}\n${payload}`).digest('hex');
  const headers = {
    'Content-Type': 'application/json',
    'X-Aurora-Timestamp': timestamp,
    'X-Aurora-Nonce': nonce,
    'X-Aurora-Signature': signature,
  };
  const response = await fetch(`${BASE}${route}`, { method: 'POST', headers, body: payload });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.chats.some((chat) => chat.id === group.body.chat.id && chat.type === 'group'));
  assert.ok(result.chats.some((chat) => chat.id === channel.body.chat.id && chat.type === 'channel'));
  assert.equal(result.chats.some((chat) => chat.id === dm.body.chat.id), false);
  assert.deepEqual(Object.keys(result.chats[0]).sort(), [
    'createdAt', 'description', 'id', 'isFrozen', 'isPublic', 'memberCount', 'title', 'type', 'username',
  ]);

  const replay = await fetch(`${BASE}${route}`, { method: 'POST', headers, body: payload });
  assert.equal(replay.status, 401);
  const unsigned = await fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  assert.equal(unsigned.status, 401);
});

describe('Регистрация и сессии', () => {
  let registeredAccount;
  let adminAccount;

  test('регистрация создаёт аккаунт и сессию', async () => {
    const termsPage = await fetch(`${BASE}/terms.html`);
    const privacyPage = await fetch(`${BASE}/privacy.html`);
    assert.equal(termsPage.status, 200);
    assert.match(await termsPage.text(), /Пользовательское соглашение/);
    assert.equal(privacyPage.status, 200);
    assert.match(await privacyPage.text(), /Политика конфиденциальности/);

    const withoutConsent = await api('POST', '/api/auth/register', {
      body: { email: 'no-consent@aurora.test', password: 'Passw0rdNoConsent', name: 'Без согласия', username: 'noconsent', bio: '' },
    });
    assert.equal(withoutConsent.status, 400);
    assert.equal(withoutConsent.body.details.field, 'consent');
    const withoutPersonalDataConsent = await api('POST', '/api/auth/register', {
      body: {
        email: 'no-data-consent@aurora.test',
        password: 'Passw0rdNoDataConsent',
        name: 'Без согласия на данные',
        username: 'nodataconsent',
        bio: '',
        ...CONSENT,
        personalDataConsent: false,
      },
    });
    assert.equal(withoutPersonalDataConsent.status, 400);
    assert.equal(withoutPersonalDataConsent.body.details.field, 'personalDataConsent');
    const withoutAgeAttestation = await api('POST', '/api/auth/register', {
      body: {
        email: 'no-age-attestation@aurora.test',
        password: 'Passw0rdNoAgeAttestation',
        name: 'Без подтверждения возраста',
        username: 'noagecheck',
        bio: '',
        ...CONSENT,
        ageGuardianAttestation: false,
      },
    });
    assert.equal(withoutAgeAttestation.status, 400);
    assert.equal(withoutAgeAttestation.body.details.field, 'ageGuardianAttestation');
    const staleConsent = await api('POST', '/api/auth/register', {
      body: {
        email: 'stale-consent@aurora.test',
        password: 'Passw0rdStaleConsent',
        name: 'Старая редакция',
        username: 'staleconsent',
        bio: '',
        ...CONSENT,
        termsVersion: 'old-version',
      },
    });
    assert.equal(staleConsent.status, 400);
    assert.equal(staleConsent.body.details.field, 'consent');

    const reservedAdminRegistration = await api('POST', '/api/auth/register', {
      body: { email: 'testadmin@aurora.test', password: 'Passw0rdAdmin', name: 'Администратор', username: 'testadmin', bio: '', ...CONSENT },
    });
    assert.equal(reservedAdminRegistration.status, 409);

    const adminRegistration = await api('POST', '/api/auth/register', {
      body: { email: 'operatoradmin@aurora.test', password: 'Passw0rdAdmin', name: 'Администратор', username: 'operatoradmin', bio: '', ...CONSENT },
    });
    assert.equal(adminRegistration.status, 201, JSON.stringify(adminRegistration.body));
    adminAccount = adminRegistration.body;
    const adminDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    adminDb.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(adminAccount.user.id);
    adminDb.close();
    const adminVerified = await api('POST', '/api/auth/email-verification/verify', {
      token: adminAccount.token,
      body: { code: adminAccount.emailVerification.testCode },
    });
    assert.equal(adminVerified.status, 200);

    const registered = await api('POST', '/api/auth/register', {
      body: { email: 'user1@aurora.test', password: 'Passw0rd1', name: 'Тест 1', username: 'tester1', bio: 'био', ...CONSENT },
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    assert.ok(registered.body.token);
    assert.equal(registered.body.user.username, 'tester1');
    const reservedUsernameUpdate = await api('PATCH', '/api/auth/profile', { token: registered.body.token, body: { username: 'testadmin' } });
    assert.equal(reservedUsernameUpdate.status, 409);
    assert.equal(registered.body.user.emailVerified, false);
    assert.ok(registered.body.user.emailVerificationDeadlineAt > Date.now());
    assert.ok(!('password' in registered.body.user));
    const consentDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    const consent = consentDb.prepare(`SELECT terms_version, privacy_version, personal_data_consent, age_guardian_attested
      FROM registration_consents WHERE user_id = ?`).get(registered.body.user.id);
    consentDb.close();
    assert.deepEqual(consent, {
      terms_version: CONSENT.termsVersion,
      privacy_version: CONSENT.privacyVersion,
      personal_data_consent: 1,
      age_guardian_attested: 1,
    });
    const loginBeforeVerification = await api('POST', '/api/auth/login', {
      body: { email: 'user1@aurora.test', password: 'Passw0rd1' },
    });
    assert.equal(loginBeforeVerification.status, 200);
    const requested = await api('POST', '/api/auth/email-verification/request', { token: registered.body.token });
    assert.equal(requested.status, 200);
    assert.equal(requested.body.sent, true);
    assert.ok(requested.body.retryAfter > 0);
    const cooldown = await api('POST', '/api/auth/email-verification/request', { token: registered.body.token });
    assert.equal(cooldown.status, 200);
    assert.equal(cooldown.body.testCode, undefined);
    assert.match(registered.body.emailVerification.testCode, /^\d{6}$/);

    const adminCodes = await api('GET', '/api/admin/email-verifications', { token: adminAccount.token });
    assert.equal(adminCodes.status, 200);
    const pending = adminCodes.body.users.find((user) => user.id === registered.body.user.id);
    assert.equal(pending.code, undefined);
    assert.equal(pending.email, 'user1@aurora.test');

    const db = new Database(path.join(DATA_DIR, 'aurora.db'));
    db.prepare('UPDATE users SET email_verification_deadline_at = ? WHERE id = ?').run(Date.now() - 1, registered.body.user.id);
    db.close();
    const restricted = await api('GET', '/api/chats', { token: registered.body.token });
    assert.equal(restricted.status, 403);
    assert.equal(restricted.body.code, 'email_verification_overdue');

    const verified = await api('POST', '/api/auth/email-verification/verify', {
      token: registered.body.token,
      body: { code: registered.body.emailVerification.testCode },
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.ok(verified.body.user.emailVerified);
    assert.equal((await api('GET', '/api/chats', { token: registered.body.token })).status, 200);
    registeredAccount = { ...registered.body, user: verified.body.user };
    const me = await api('GET', '/api/auth/me', { token: registeredAccount.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, 'tester1');
  });

  test('администратор создаёт подарок с изображением без эмодзи', async () => {
    const admin = await register(`giftadmin${Date.now().toString(36)}`);
    const adminDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    adminDb.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.user.id);
    adminDb.close();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'gift.png');
    form.append('kind', 'image');
    const uploaded = await api('POST', '/api/media', { token: admin.token, raw: form });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.media.kind, 'image');

    const giftId = `admin-test-${Date.now().toString(36)}`;
    const created = await api('POST', '/api/admin/commerce/gifts', {
      token: admin.token,
      body: {
        id: giftId, name: 'Подарок с фото', description: 'Проверка изображения',
        price: 10, rarity: 'обычный', imageMediaId: uploaded.body.media.id,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.gift.name, 'Подарок с фото');
    assert.equal(created.body.gift.emoji, '');
    assert.equal(created.body.gift.image_media_id, uploaded.body.media.id);
    assert.equal(created.body.gift.is_active, 1);
    const catalog = await api('GET', '/api/commerce/catalog', { token: admin.token });
    const gift = catalog.body.gifts.find((item) => item.id === giftId);
    assert.ok(gift?.imageUrl);
    assert.match(gift.imageUrl, /^\/media\/\d+\?/);

    const secondImageForm = new FormData();
    secondImageForm.append('file', new Blob([png], { type: 'image/png' }), 'another-gift.png');
    secondImageForm.append('kind', 'image');
    const secondImage = await api('POST', '/api/media', { token: admin.token, raw: secondImageForm });
    assert.equal(secondImage.status, 201, JSON.stringify(secondImage.body));

    const otherAdmin = await register(`gifteditor${Date.now().toString(36)}`);
    const otherAdminDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    otherAdminDb.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(otherAdmin.user.id);
    otherAdminDb.close();
    const edited = await api('PATCH', `/api/admin/commerce/gifts/${giftId}`, {
      token: otherAdmin.token,
      body: { name: 'Подарок изменён другим администратором' },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.gift.image_media_id, uploaded.body.media.id);
    const foreignImage = await api('PATCH', `/api/admin/commerce/gifts/${giftId}`, {
      token: otherAdmin.token,
      body: { imageMediaId: secondImage.body.media.id },
    });
    assert.equal(foreignImage.status, 400);
    const deleted = await api('DELETE', `/api/admin/commerce/gifts/${giftId}`, { token: admin.token });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  });

  test('код почты истекает, ограничивает перебор и не хранится открытым', async () => {
    const account = await api('POST', '/api/auth/register', {
      body: { email: 'verification-guard@aurora.test', password: 'Passw0rdGuard', name: 'Проверка', username: 'verifguard', bio: '', ...CONSENT },
    });
    assert.equal(account.status, 201);
    assert.match(account.body.emailVerification.testCode, /^\d{6}$/);
    const db = new Database(path.join(DATA_DIR, 'aurora.db'));
    const stored = db.prepare('SELECT code_hash, code_ciphertext, expires_at FROM email_verifications WHERE user_id = ?').get(account.body.user.id);
    assert.match(stored.code_hash, /^[a-f0-9]{64}$/);
    assert.equal(stored.code_ciphertext, '');
    db.prepare('UPDATE email_verifications SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, account.body.user.id);
    db.close();
    const expired = await api('POST', '/api/auth/email-verification/verify', {
      token: account.body.token,
      body: { code: account.body.emailVerification.testCode },
    });
    assert.equal(expired.status, 400);

    const resent = await api('POST', '/api/auth/email-verification/request', { token: account.body.token });
    assert.equal(resent.status, 201);
    assert.match(resent.body.testCode, /^\d{6}$/);
    const wrongCode = resent.body.testCode === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt++) {
      const wrong = await api('POST', '/api/auth/email-verification/verify', {
        token: account.body.token,
        body: { code: wrongCode },
      });
      assert.equal(wrong.status, 400);
    }
    const exhausted = await api('POST', '/api/auth/email-verification/verify', {
      token: account.body.token,
      body: { code: resent.body.testCode },
    });
    assert.equal(exhausted.status, 400);
    const dbAfter = new Database(path.join(DATA_DIR, 'aurora.db'));
    assert.equal(dbAfter.prepare('SELECT 1 FROM email_verifications WHERE user_id = ?').get(account.body.user.id), undefined);
    dbAfter.close();
    const changedEmail = await api('PATCH', '/api/auth/email', {
      token: account.body.token,
      body: { email: 'verification-corrected@aurora.test' },
    });
    assert.equal(changedEmail.status, 200);
    assert.equal(changedEmail.body.user.email, 'verification-corrected@aurora.test');
    assert.equal(changedEmail.body.emailVerification.sent, true);
    const confirmed = await api('POST', '/api/auth/email-verification/verify', {
      token: account.body.token,
      body: { code: changedEmail.body.emailVerification.testCode },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.user.emailVerified, true);
  });

  test('отклоняет слабый пароль, занятый username и e-mail', async () => {
    const weak = await api('POST', '/api/auth/register', { body: { email: 'x@aurora.test', password: '123', name: 'Икс', username: 'weakuser' } });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.details.field, 'password');

    const dup = await api('POST', '/api/auth/register', { body: { email: 'user1@aurora.test', password: 'Passw0rd9', name: 'Дубликат', username: 'someone', ...CONSENT } });
    assert.equal(dup.status, 409);

    const dupName = await api('POST', '/api/auth/register', { body: { email: 'n@aurora.test', password: 'Passw0rd9', name: 'Дубликат', username: 'TESTER1', ...CONSENT } });
    assert.equal(dupName.status, 409);
  });

  test('вход, проверка сессии и неверный пароль', async () => {
    const bad = await api('POST', '/api/auth/login', { body: { email: 'user1@aurora.test', password: 'неверный1' } });
    assert.equal(bad.status, 401);
    const ok = await api('POST', '/api/auth/login', { body: { email: 'USER1@aurora.test', password: 'Passw0rd1' } });
    assert.equal(ok.status, 200);
    const me = await api('GET', '/api/auth/me', { token: ok.body.token });
    assert.equal(me.body.user.username, 'tester1');
    const anon = await api('GET', '/api/auth/me');
    assert.equal(anon.status, 401);
  });

  test('cookie-аутентифицированные изменения отклоняют запросы с чужого Origin', async () => {
    const account = await register('csrfcheck');
    const cookie = `aurora_token=${encodeURIComponent(account.token)}`;
    const rejected = await fetch(`${BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://attacker.example' },
    });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, 'csrf_rejected');

    const allowed = await fetch(`${BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: BASE },
    });
    assert.equal(allowed.status, 200);
  });

  test('смена подтверждённой почты требует повторный ввод текущего пароля', async () => {
    const account = await register('emailreauth');
    const denied = await api('PATCH', '/api/auth/email', {
      token: account.token,
      body: { email: 'emailreauth-new@aurora.test' },
    });
    assert.equal(denied.status, 403);

    const changed = await api('PATCH', '/api/auth/email', {
      token: account.token,
      body: {
        email: 'emailreauth-new@aurora.test',
        currentPassword: 'Passw0rdemailreauth',
      },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.user.email, 'emailreauth-new@aurora.test');
    assert.equal(changed.body.user.emailVerified, false);
  });

  test('публичная проверка формата почты не раскрывает занятость адреса', async () => {
    const check = await api('GET', '/api/auth/check?email=user1%40aurora.test');
    assert.equal(check.status, 200);
    assert.equal(check.body.email.valid, true);
    assert.equal('taken' in check.body.email, false);
  });

  test('защитный пароль обязателен для существующего аккаунта при следующем входе', async () => {
    const account = await register('protect');
    const db = new Database(path.join(DATA_DIR, 'aurora.db'));
    db.prepare('UPDATE users SET protective_password_required = 1 WHERE id = ?').run(account.user.id);
    db.close();

    const setup = await api('POST', '/api/auth/login', { body: { email: account.user.email, password: 'Passw0rdprotect' } });
    assert.equal(setup.status, 200);
    assert.equal(setup.body.stepRequired, 'protective_password_setup');

    const tooShort = await api('POST', '/api/auth/protective-password/setup-after-login', {
      body: { setupToken: setup.body.setupToken, protectivePassword: '12345' },
    });
    assert.equal(tooShort.status, 400);

    const configured = await api('POST', '/api/auth/protective-password/setup-after-login', {
      body: { setupToken: setup.body.setupToken, protectivePassword: 'secure6' },
    });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.ok(configured.body.token);
    assert.equal('protectivePasswordHash' in configured.body.user, false);
    assert.equal('protectivePasswordRequired' in configured.body.user, false);
    const status = await api('GET', '/api/auth/protective-password/status', { token: configured.body.token });
    assert.equal(status.body.enabled, true);

    const wrong = await api('POST', '/api/auth/login', {
      body: { email: account.user.email, password: 'Passw0rdprotect', protectivePassword: 'wrong6' },
    });
    assert.equal(wrong.body.stepRequired, 'protective_password');
    assert.equal(wrong.body.invalid, true);

    const correct = await api('POST', '/api/auth/login', {
      body: { email: account.user.email, password: 'Passw0rdprotect', protectivePassword: 'secure6' },
    });
    assert.equal(correct.status, 200);
    assert.ok(correct.body.token);
  });

  test('push-подписка доступна только текущему сеансу и проверяет endpoint', async () => {
    const account = await register('push');
    const nativeToken = `native-push-token-${'x'.repeat(32)}`;
    const nativeStatus = await api('GET', '/api/push/native/status', { token: account.token });
    assert.equal(nativeStatus.status, 200);
    assert.equal(nativeStatus.body.enabled, false);
    const savedNativeToken = await api('POST', '/api/push/native/token', {
      token: account.token,
      body: { token: nativeToken },
    });
    assert.equal(savedNativeToken.status, 200, JSON.stringify(savedNativeToken.body));
    assert.equal(savedNativeToken.body.configured, false);
    assert.equal((await api('GET', '/api/push/native/status', { token: account.token })).body.enabled, true);
    assert.equal((await api('POST', '/api/push/native/test', { token: account.token })).status, 503);
    assert.equal((await api('POST', '/api/push/native/token', {
      token: account.token,
      body: { token: 'too-short' },
    })).status, 400);
    const tokenOwner = await register('pushtokenowner');
    assert.equal((await api('POST', '/api/push/native/token', {
      token: tokenOwner.token,
      body: { token: nativeToken },
    })).status, 409);

    const key = await api('GET', '/api/push/vapid-public-key', { token: account.token });
    assert.equal(key.status, 200);
    assert.match(key.body.publicKey, /^[A-Za-z0-9_-]+$/);
    const otherSession = await api('POST', '/api/auth/login', {
      body: { email: account.user.email, password: 'Passw0rdpush' },
    });
    assert.equal(otherSession.status, 200);
    const testWithoutSubscription = await api('POST', '/api/push/test', { token: account.token });
    assert.equal(testWithoutSubscription.status, 400);
    assert.match(testWithoutSubscription.body.error, /Сначала включите фоновые уведомления/);

    const unsupported = await api('POST', '/api/push/subscription', {
      token: account.token,
      body: { subscription: { endpoint: 'https://example.com/push', keys: { p256dh: 'x'.repeat(44), auth: 'y'.repeat(24) } } },
    });
    assert.equal(unsupported.status, 400);

    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/aurora-test-endpoint',
      keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
    };
    const saved = await api('POST', '/api/push/subscription', { token: account.token, body: { subscription } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await api('GET', '/api/push/subscription', { token: account.token })).body.enabled, true);
    assert.equal((await api('GET', '/api/push/subscription', { token: otherSession.body.token })).body.enabled, false);
    assert.equal((await api('POST', '/api/auth/logout', { token: otherSession.body.token })).status, 200);
    assert.equal((await api('GET', '/api/push/subscription', { token: account.token })).body.enabled, true);

    const removed = await api('DELETE', '/api/push/subscription', { token: account.token, body: subscription });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.enabled, false);
    await api('POST', '/api/push/subscription', { token: account.token, body: { subscription } });
    assert.equal((await api('POST', '/api/auth/logout', { token: account.token })).status, 200);
    const freshSession = await api('POST', '/api/auth/login', {
      body: { email: account.user.email, password: 'Passw0rdpush' },
    });
    assert.equal(freshSession.status, 200);
    assert.equal((await api('GET', '/api/push/native/status', { token: freshSession.body.token })).body.enabled, false);
    assert.equal((await api('GET', '/api/push/subscription', { token: freshSession.body.token })).body.enabled, false);

    const serviceWorker = await fetch(`${BASE}/sw.js`);
    assert.equal(serviceWorker.status, 200);
    const serviceWorkerSource = await serviceWorker.text();
    assert.match(serviceWorkerSource, /notificationclick/);
    assert.match(serviceWorkerSource, /payload\.test/);
    const assetLinks = await fetch(`${BASE}/.well-known/assetlinks.json`);
    assert.equal(assetLinks.status, 200);
    const assetLinksBody = await assetLinks.json();
    assert.equal(assetLinksBody[0].target.package_name, 'ru.aurora.messenger');
    assert.match(assetLinksBody[0].target.sha256_cert_fingerprints[0], /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/);
    const manifestResponse = await fetch(`${BASE}/manifest.webmanifest`);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.name, 'Aurora Messenger — мессенджер для общения');
    for (const icon of manifest.icons.filter((item) => item.type === 'image/png')) {
      const response = await fetch(new URL(icon.src, BASE));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /image\/png/);
    }
  });

  test('восстановление доступа: токен сбрасывает пароль', async () => {
    const socket = connect(registeredAccount.token);
    await socket.open();
    const socketClosed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket remained open after password reset')), 2000);
      socket.ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    const forgot = await api('POST', '/api/auth/forgot', { body: { email: 'user1@aurora.test' } });
    assert.equal(forgot.status, 202);
    assert.match(forgot.body.devResetToken, /^[A-Za-z0-9_-]{40,}$/);
    const unknown = await api('POST', '/api/auth/forgot', { body: { email: 'missing@aurora.test' } });
    assert.equal(unknown.status, forgot.status);
    assert.equal(unknown.body.message, forgot.body.message);
    assert.equal(unknown.body.devResetToken, undefined);
    const forbiddenList = await api('GET', '/api/admin/password-reset-requests', { token: registeredAccount.token });
    assert.equal(forbiddenList.status, 403);
    const requests = await api('GET', '/api/admin/password-reset-requests', { token: adminAccount.token });
    assert.equal(requests.status, 200);
    assert.equal(requests.body.requests.some((item) => item.email === 'user1@aurora.test'), false);

    const db = new Database(path.join(DATA_DIR, 'aurora.db'));
    db.prepare('UPDATE password_resets SET created_at = 0 WHERE user_id = ?').run(registeredAccount.user.id);
    db.close();
    const replacement = await api('POST', '/api/auth/forgot', { body: { email: 'user1@aurora.test' } });
    const resetToken = replacement.body.devResetToken;
    assert.ok(resetToken);
    const previous = await api('POST', '/api/auth/reset', { body: { token: forgot.body.devResetToken, password: 'OldResetPassw0rd1' } });
    assert.equal(previous.status, 400);

    const expiryDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    expiryDb.prepare('UPDATE password_resets SET expires_at = ? WHERE user_id = ? AND used = 0').run(Date.now() - 1, registeredAccount.user.id);
    expiryDb.close();
    const expired = await api('POST', '/api/auth/reset', { body: { token: resetToken, password: 'ExpiredPassw0rd1' } });
    assert.equal(expired.status, 400);

    const nextDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    nextDb.prepare('UPDATE password_resets SET created_at = 0 WHERE user_id = ?').run(registeredAccount.user.id);
    nextDb.close();
    const latest = await api('POST', '/api/auth/forgot', { body: { email: 'user1@aurora.test' } });
    const latestToken = latest.body.devResetToken;
    assert.ok(latestToken);
    const reset = await api('POST', '/api/auth/reset', { body: { token: latestToken, password: 'NewPassw0rd1' } });
    assert.equal(reset.status, 200);
    assert.equal(await socketClosed, 4001);
    socket.close();
    const reused = await api('POST', '/api/auth/reset', { body: { token: latestToken, password: 'NewPassw0rd2' } });
    assert.equal(reused.status, 400);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'user1@aurora.test', password: 'Passw0rd1' } })).status, 401);
    const newLogin = await api('POST', '/api/auth/login', { body: { email: 'user1@aurora.test', password: 'NewPassw0rd1' } });
    assert.equal(newLogin.status, 200);
    assert.equal(newLogin.body.stepRequired, 'protective_password_setup');
  });

  test('смена пароля закрывает активные WebSocket-сеансы', async () => {
    const account = await register(`password${Date.now().toString(36)}`);
    const socket = connect(account.token);
    await socket.open();
    const socketClosed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket remained open after password change')), 2000);
      socket.ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    const changed = await api('POST', '/api/auth/change-password', {
      token: account.token,
      body: { currentPassword: `Passw0rd${account.user.username.slice(6)}`, password: 'ChangedPassw0rd1' },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(await socketClosed, 4001);
    socket.close();
  });

  test('блокировка пользователя закрывает его активные WebSocket-сеансы', async () => {
    const target = await register(`blk${Date.now().toString(36)}`);
    const admin = await register(`adm${Date.now().toString(36)}`);
    const adminDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    adminDb.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.user.id);
    adminDb.close();
    const socket = connect(target.token);
    await socket.open();
    const socketClosed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket remained open after account block')), 2000);
      socket.ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });

    const blocked = await api('PATCH', `/api/admin/users/${target.user.id}`, {
      token: admin.token,
      body: { blocked: true },
    });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    assert.equal(await socketClosed, 4001);

    const revoked = await api('GET', '/api/auth/me', { token: target.token });
    assert.equal(revoked.status, 401);
    socket.close();
  });

  test('галочку профиля может выдавать и снимать только администратор', async () => {
    const target = await register(`ver${Date.now().toString(36)}`);
    const admin = await register(`adm${Date.now().toString(36)}`);
    const adminDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    adminDb.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.user.id);
    adminDb.close();

    const initialUsers = await api('GET', '/api/admin/users', { token: admin.token });
    assert.equal(initialUsers.status, 200, JSON.stringify(initialUsers.body));
    assert.equal(initialUsers.body.users.find((user) => user.id === target.user.id).is_verified, 0);

    const denied = await api('PATCH', `/api/admin/users/${target.user.id}`, {
      token: target.token,
      body: { verified: true },
    });
    assert.equal(denied.status, 403);

    const invalid = await api('PATCH', `/api/admin/users/${target.user.id}`, {
      token: admin.token,
      body: { verified: 'true' },
    });
    assert.equal(invalid.status, 400);

    const granted = await api('PATCH', `/api/admin/users/${target.user.id}`, {
      token: admin.token,
      body: { verified: true },
    });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(granted.body.verified, true);

    const profile = await api('GET', `/api/users/${target.user.id}`, { token: admin.token });
    assert.equal(profile.status, 200, JSON.stringify(profile.body));
    assert.equal(profile.body.user.verified, true);
    assert.ok(profile.body.user.badges.includes('verified'));

    const revoked = await api('PATCH', `/api/admin/users/${target.user.id}`, {
      token: admin.token,
      body: { verified: false },
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.verified, false);

    const updatedProfile = await api('GET', `/api/users/${target.user.id}`, { token: admin.token });
    assert.equal(updatedProfile.status, 200, JSON.stringify(updatedProfile.body));
    assert.equal(updatedProfile.body.user.verified, false);
    assert.ok(!updatedProfile.body.user.badges.includes('verified'));
  });

  test('заблокированные и замороженные аккаунты не могут войти или подключиться к WebSocket', async () => {
    const admin = await register(`adm${Date.now().toString(36)}`);
    const adminDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    adminDb.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.user.id);
    adminDb.close();

    for (const [restriction, expectedMessage] of [
      ['blocked', /заблокирован/i],
      ['frozen', /заморожен/i],
    ]) {
      const suffix = Date.now().toString(36);
      const userSuffix = `rl${suffix}`;
      const target = await register(userSuffix);
      const db = new Database(path.join(DATA_DIR, 'aurora.db'));
      db.prepare('UPDATE users SET protective_password_required = 1, protective_password_hash = NULL WHERE id = ?')
        .run(target.user.id);
      db.close();

      const challenge = await api('POST', '/api/auth/login', {
        body: { email: `user${userSuffix}@aurora.test`, password: `Passw0rd${userSuffix}` },
      });
      assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
      assert.equal(challenge.body.stepRequired, 'protective_password_setup');

      const socket = connect(target.token);
      await socket.open();
      const socketClosed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`WebSocket remained open after account ${restriction}`)), 2000);
        socket.ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
      });
      const updated = await api('PATCH', `/api/admin/users/${target.user.id}`, {
        token: admin.token,
        body: { [restriction]: true },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal(await socketClosed, 4001);

      const login = await api('POST', '/api/auth/login', {
        body: { email: `user${userSuffix}@aurora.test`, password: `Passw0rd${userSuffix}` },
      });
      assert.equal(login.status, 403);
      assert.match(login.body.error, expectedMessage);

      const staleChallenge = await api('POST', '/api/auth/protective-password/setup-after-login', {
        body: { setupToken: challenge.body.setupToken, protectivePassword: 'ProtectivePass1' },
      });
      assert.equal(staleChallenge.status, 403);
      assert.match(staleChallenge.body.error, expectedMessage);

      const currentDb = new Database(path.join(DATA_DIR, 'aurora.db'));
      currentDb.prepare('UPDATE users SET token_version = token_version - 1 WHERE id = ?').run(target.user.id);
      currentDb.close();
      const wsStatus = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(target.token)}`, {
          headers: { Origin: PUBLIC_ORIGIN },
        });
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error(`WebSocket handshake did not finish for ${restriction} account`));
        }, 2000);
        ws.once('unexpected-response', (_request, response) => {
          clearTimeout(timer);
          response.resume();
          resolve(response.statusCode);
        });
        ws.once('open', () => {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`Restricted account connected to WebSocket while ${restriction}`));
        });
        ws.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      assert.equal(wsStatus, 401);
      socket.close();
    }
  });
});

describe('Личные сообщения и real-time', () => {
  let alice; let bob; let bobWs;
  test('WebSocket разрешает только PUBLIC_ORIGIN и сохраняет аутентификацию', async () => {
    const account = await register(`wsorigin${Date.now().toString(36)}`);
    const cookie = `aurora_token=${encodeURIComponent(account.token)}`;
    const handshakeStatus = (headers, token = '') => new Promise((resolve, reject) => {
      const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${tokenQuery}`, { headers });
      let settled = false;
      const timer = setTimeout(() => {
        ws.terminate();
        finish(new Error('WebSocket handshake did not finish'));
      }, 3000);
      const finish = (error, status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(status);
      };
      ws.once('open', () => {
        ws.close();
        finish(null, 101);
      });
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        finish(null, response.statusCode);
      });
      ws.once('error', (error) => finish(error));
    });

    assert.equal(await handshakeStatus({ Cookie: cookie, Origin: PUBLIC_ORIGIN }), 101);
    assert.equal(await handshakeStatus({ Cookie: cookie, Origin: 'https://attacker.aurora.test' }), 403);
    assert.equal(await handshakeStatus({ Cookie: cookie, Origin: 'https://aurora.test:444' }), 403);
    assert.equal(await handshakeStatus({ Cookie: cookie, Origin: 'http://aurora.test' }), 403);
    assert.equal(await handshakeStatus({ Cookie: cookie }), 403);
    assert.equal(await handshakeStatus({ Cookie: cookie, Origin: 'not-an-origin' }), 403);
    assert.equal(await handshakeStatus({
      Cookie: cookie,
      Origin: 'http://aurora.test',
      'X-Forwarded-Proto': 'https',
    }), 403);
    assert.equal(await handshakeStatus({
      Cookie: cookie,
      Origin: PUBLIC_ORIGIN,
      'X-Forwarded-Proto': 'http',
    }), 101);
    assert.equal(await handshakeStatus({ Origin: PUBLIC_ORIGIN }), 401);
    assert.equal(await handshakeStatus({ Origin: PUBLIC_ORIGIN }, account.token), 101);
  });

  test('создание диалога и отправка сообщения', async () => {
    alice = await register('2');
    bob = await register('3');
    bobWs = connect(bob.token);
    await bobWs.open();

    const dm = await api('POST', '/api/chats/dm', { token: alice.token, body: { userId: bob.user.id } });
    assert.equal(dm.status, 200);
    assert.equal(dm.body.chat.type, 'dm');
    // идемпотентность: второй вызов возвращает тот же чат
    const dm2 = await api('POST', '/api/chats/dm', { token: alice.token, body: { userId: bob.user.id } });
    assert.equal(dm2.body.chat.id, dm.body.chat.id);

    const sent = await api('POST', `/api/chats/${dm.body.chat.id}/messages`, { token: alice.token, body: { type: 'text', text: 'Привет, Боб!' } });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.message.status, 'sent');

    const ev = await bobWs.wait('message.new');
    assert.equal(ev.payload.message.text, 'Привет, Боб!');
    assert.equal(ev.chatId, dm.body.chat.id);
  });

  test('история сохраняется и доступна после «перезагрузки»', async () => {
    const chats = await api('GET', '/api/chats', { token: bob.token });
    const dm = chats.body.chats.find((c) => c.type === 'dm');
    assert.equal(dm.unread, 1);
    const page = await api('GET', `/api/chats/${dm.id}/messages`, { token: bob.token });
    assert.equal(page.body.messages.length, 1);
    assert.equal(page.body.messages[0].text, 'Привет, Боб!');
  });

  test('скрытые у себя сообщения не возвращаются при синхронизации', async () => {
    const chatId = (await api('GET', '/api/chats', { token: alice.token })).body.chats[0].id;
    const sent = await api('POST', `/api/chats/${chatId}/messages`, {
      token: alice.token, body: { type: 'text', text: 'Только у Алисы' },
    });
    assert.equal(sent.status, 201);

    const hidden = await api('DELETE', `/api/messages/${sent.body.message.id}`, { token: bob.token });
    assert.equal(hidden.status, 200);

    const bobAfter = await api('GET', `/api/chats/${chatId}/messages/after?seq=0`, { token: bob.token });
    assert.ok(!bobAfter.body.messages.some((message) => message.id === sent.body.message.id));
    const aliceAfter = await api('GET', `/api/chats/${chatId}/messages/after?seq=0`, { token: alice.token });
    assert.ok(aliceAfter.body.messages.some((message) => message.id === sent.body.message.id));
  });

  test('доставка и прочтение меняют статус у отправителя', async () => {
    const aliceChats = await api('GET', '/api/chats', { token: alice.token });
    const chatId = aliceChats.body.chats[0].id;
    await api('POST', `/api/chats/${chatId}/delivered`, { token: bob.token, body: { seq: 1 } });
    await api('POST', `/api/chats/${chatId}/read`, { token: bob.token, body: { seq: 1 } });

    const info = await api('GET', `/api/messages/${(await api('GET', `/api/chats/${chatId}/messages`, { token: alice.token })).body.messages[0].id}`, { token: alice.token });
    assert.equal(info.body.message.status, 'read');
    assert.ok(info.body.readers.find((r) => r.id === bob.user.id).read);
  });

  test('правка и удаление видны собеседнику через WS', async () => {
    const chatId = (await api('GET', '/api/chats', { token: alice.token })).body.chats[0].id;
    const msg = (await api('GET', `/api/chats/${chatId}/messages`, { token: alice.token })).body.messages[0];

    const edited = await api('PATCH', `/api/messages/${msg.id}`, { token: alice.token, body: { text: 'Привет, Боб! (исправлено)' } });
    assert.equal(edited.status, 200);
    const editEv = await bobWs.wait('message.edit');
    assert.match(editEv.payload.message.text, /исправлено/);

    const del = await api('DELETE', `/api/messages/${msg.id}?forAll=1`, { token: alice.token });
    assert.equal(del.status, 200);
    await bobWs.wait('message.delete');
    const after = await api('GET', `/api/chats/${chatId}/messages`, { token: bob.token });
    assert.equal(after.body.messages.length, 0);
  });

  test('удаление для всех отзывает вложения сообщения', async () => {
    const chatId = (await api('GET', '/api/chats', { token: alice.token })).body.chats[0].id;
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'deleted-message.png');
    const uploaded = await api('POST', '/api/media', { token: alice.token, raw: form });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));

    const sent = await api('POST', `/api/chats/${chatId}/messages`, {
      token: alice.token, body: { type: 'photo', mediaId: uploaded.body.media.id },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const mediaUrl = sent.body.message.media.url;
    const shared = await api('POST', `/api/chats/${chatId}/messages`, {
      token: alice.token, body: { type: 'photo', mediaId: uploaded.body.media.id },
    });
    assert.equal(shared.status, 201, JSON.stringify(shared.body));

    const deleted = await api('DELETE', `/api/messages/${sent.body.message.id}?forAll=1`, { token: alice.token });
    assert.equal(deleted.status, 200);
    const details = await api('GET', `/api/messages/${sent.body.message.id}`, { token: bob.token });
    assert.equal(details.status, 200);
    assert.equal(details.body.message.media, null);
    assert.deepEqual(details.body.message.mediaItems, []);
    assert.equal((await api('GET', `/api/media/${uploaded.body.media.id}`, { token: alice.token })).status, 200);
    const eventDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    assert.equal(eventDb.prepare(`SELECT COUNT(*) AS count FROM events
      WHERE scope = ? AND json_extract(payload, '$.payload.message.id') = ?`)
      .get(`chat:${chatId}`, sent.body.message.id).count, 0);
    eventDb.close();

    const deleteShared = await api('DELETE', `/api/messages/${shared.body.message.id}?forAll=1`, { token: alice.token });
    assert.equal(deleteShared.status, 200);
    assert.equal((await api('GET', `/api/media/${uploaded.body.media.id}`, { token: alice.token })).status, 404);
    assert.equal((await fetch(`${BASE}${mediaUrl}`)).status, 404);
  });

  test('третья сторона не имеет доступа к чужому чату', async () => {
    const eve = await register('4');
    const aliceChats = await api('GET', '/api/chats', { token: alice.token });
    const foreign = await api('GET', `/api/chats/${aliceChats.body.chats[0].id}/messages`, { token: eve.token });
    assert.equal(foreign.status, 403);
    const send = await api('POST', `/api/chats/${aliceChats.body.chats[0].id}/messages`, { token: eve.token, body: { type: 'text', text: 'вторжение' } });
    assert.equal(send.status, 403);
  });

  test('реакции ставятся и снимаются', async () => {
    const chatId = (await api('GET', '/api/chats', { token: alice.token })).body.chats[0].id;
    const sent = await api('POST', `/api/chats/${chatId}/messages`, { token: alice.token, body: { type: 'text', text: 'Сообщение с реакцией' } });
    const id = sent.body.message.id;
    const add = await api('POST', `/api/messages/${id}/reactions`, { token: bob.token, body: { emoji: '🔥' } });
    assert.equal(add.body.action, 'added');
    assert.equal(add.body.reactions[0].count, 1);
    const addAnother = await api('POST', `/api/messages/${id}/reactions`, { token: bob.token, body: { emoji: '❤️' } });
    assert.equal(addAnother.body.action, 'added');
    assert.equal(addAnother.body.reactions.length, 2);
    assert.ok(addAnother.body.reactions.every((reaction) => reaction.mine));
    const remove = await api('POST', `/api/messages/${id}/reactions`, { token: bob.token, body: { emoji: '🔥' } });
    assert.equal(remove.body.action, 'removed');
    assert.deepEqual(remove.body.reactions.map((reaction) => reaction.emoji), ['❤️']);
    const invalid = await api('POST', `/api/messages/${id}/reactions`, { token: bob.token, body: { emoji: 'x' } });
    assert.equal(invalid.status, 400);
  });

  test('отправляет фирменный стикер и отклоняет неизвестные наборы', async () => {
    const chatId = (await api('GET', '/api/chats', { token: alice.token })).body.chats[0].id;
    const sticker = await api('POST', `/api/chats/${chatId}/messages`, {
      token: alice.token, body: { type: 'sticker', sticker: 'aurora-news' },
    });
    assert.equal(sticker.status, 201, JSON.stringify(sticker.body));
    assert.equal(sticker.body.message.sticker, 'aurora-news');
    const unknown = await api('POST', `/api/chats/${chatId}/messages`, {
      token: alice.token, body: { type: 'sticker', sticker: '../secret' },
    });
    assert.equal(unknown.status, 400);
  });

  test('ответ на сообщение и пересылка', async () => {
    const chats = await api('GET', '/api/chats', { token: alice.token });
    const chatId = chats.body.chats[0].id;
    const first = (await api('GET', `/api/chats/${chatId}/messages`, { token: alice.token })).body.messages[0];
    const reply = await api('POST', `/api/chats/${chatId}/messages`, { token: bob.token, body: { type: 'text', text: 'Это ответ', replyToId: first.id } });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.reply.id, first.id);

    const chat2 = await api('POST', '/api/chats/group', { token: alice.token, body: { title: 'Тестовая группа', memberIds: [bob.user.id] } });
    const fwd = await api('POST', '/api/messages/forward', { token: bob.token, body: { messageIds: [first.id], chatIds: [chat2.body.chat.id] } });
    assert.equal(fwd.body.total, 1);
    const groupMsg = (await api('GET', `/api/chats/${chat2.body.chat.id}/messages`, { token: alice.token })).body.messages[0];
    assert.equal(groupMsg.forward.chatId, chatId);
  });

  test('запись о прочтении не задним числом: мои непрочитанные считаются', async () => {
    const chats = await api('GET', '/api/chats', { token: bob.token });
    const dm = chats.body.chats.find((c) => c.type === 'dm');
    assert.ok(dm.unread >= 1, `unread=${dm.unread}`);
    await api('POST', `/api/chats/${dm.id}/read`, { token: bob.token, body: { seq: dm.lastSeq } });
    const after = (await api('GET', '/api/chats', { token: bob.token })).body.chats.find((c) => c.id === dm.id);
    assert.equal(after.unread, 0);
  });

  test('закрытие WS переводит пользователя в offline', async () => {
    bobWs.close();
    const aliceWs = connect(alice.token);
    await aliceWs.open();
    await aliceWs.wait('hello');
    const list = await api('GET', '/api/chats', { token: alice.token });
    const dm = list.body.chats.find((c) => c.type === 'dm');
    assert.ok(dm);
    aliceWs.close();
  });
});

describe('Группы, каналы, поиск, медиа, настройки', () => {
  let owner; let member;
  test('группа: права администратора, добавление и удаление участников', async () => {
    owner = await register('5');
    member = await register('6');
    const third = await register('7');
    const group = await api('POST', '/api/chats/group', { token: owner.token, body: { title: 'Команда', description: 'работа', memberIds: [member.user.id] } });
    const id = group.body.chat.id;
    const info = await api('GET', `/api/chats/${id}`, { token: owner.token });
    assert.equal(info.body.role, 'owner');
    assert.equal(info.body.members.length, 2);

    // обычный участник не может менять инфо группы
    const denied = await api('PATCH', `/api/chats/${id}`, { token: member.token, body: { title: 'Хак' } });
    assert.equal(denied.status, 403);

    const add = await api('POST', `/api/chats/${id}/members`, { token: owner.token, body: { userIds: [third.user.id] } });
    assert.deepEqual(add.body.added, [third.user.id]);

    const promote = await api('PATCH', `/api/chats/${id}/members/${member.user.id}/role`, { token: owner.token, body: { role: 'admin' } });
    assert.equal(promote.body.role, 'admin');
    const nowAllowed = await api('PATCH', `/api/chats/${id}`, { token: member.token, body: { title: 'Команда 2.0' } });
    assert.equal(nowAllowed.status, 200);

    const kick = await api('DELETE', `/api/chats/${id}/members/${third.user.id}`, { token: member.token });
    assert.equal(kick.status, 200);
    const kicked = await api('GET', `/api/chats/${id}`, { token: third.token });
    assert.equal(kicked.status, 403);
  });

  test('темы группы изолируют историю и проверяют права на создание и запись', async () => {
    const suffix = Date.now().toString(36);
    const topicOwner = await register(`to${suffix}`);
    const topicMember = await register(`tm${suffix}`);
    const outsider = await register(`out${suffix}`);
    const group = await api('POST', '/api/chats/group', {
      token: topicOwner.token,
      body: { title: 'Группа с темами', memberIds: [topicMember.user.id] },
    });
    assert.equal(group.status, 201, JSON.stringify(group.body));
    const chatId = group.body.chat.id;
    const listed = await api('GET', `/api/chats/${chatId}/topics`, { token: topicMember.token });
    assert.equal(listed.status, 200);
    const general = listed.body.topics.find((topic) => topic.isDefault);
    assert.ok(general);

    const created = await api('POST', `/api/chats/${chatId}/topics`, {
      token: topicOwner.token, body: { title: 'Объявления' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const topicId = created.body.topic.id;
    const deniedCreate = await api('POST', `/api/chats/${chatId}/topics`, {
      token: topicMember.token, body: { title: 'Не разрешено' },
    });
    assert.equal(deniedCreate.status, 403);
    const deniedList = await api('GET', `/api/chats/${chatId}/topics`, { token: outsider.token });
    assert.equal(deniedList.status, 403);

    const generalMessage = await api('POST', `/api/chats/${chatId}/messages`, {
      token: topicMember.token, body: { type: 'text', text: 'В общей теме' },
    });
    assert.equal(generalMessage.status, 201, JSON.stringify(generalMessage.body));
    assert.equal(generalMessage.body.message.topicId, general.id);
    const topicMessage = await api('POST', `/api/chats/${chatId}/messages`, {
      token: topicMember.token, body: { type: 'text', text: 'В отдельной теме', topicId },
    });
    assert.equal(topicMessage.status, 201, JSON.stringify(topicMessage.body));
    assert.equal(topicMessage.body.message.topicId, topicId);

    const generalHistory = await api('GET', `/api/chats/${chatId}/messages?topicId=${general.id}`, { token: topicMember.token });
    assert.deepEqual(generalHistory.body.messages.map((message) => message.id), [generalMessage.body.message.id]);
    const topicHistory = await api('GET', `/api/chats/${chatId}/messages?topicId=${topicId}`, { token: topicMember.token });
    assert.deepEqual(topicHistory.body.messages.map((message) => message.id), [topicMessage.body.message.id]);

    const closed = await api('PATCH', `/api/chats/${chatId}/topics/${topicId}`, {
      token: topicOwner.token, body: { isClosed: true },
    });
    assert.equal(closed.status, 200);
    const deniedPost = await api('POST', `/api/chats/${chatId}/messages`, {
      token: topicMember.token, body: { type: 'text', text: 'Нельзя писать', topicId },
    });
    assert.equal(deniedPost.status, 403);
    const reopened = await api('PATCH', `/api/chats/${chatId}/topics/${topicId}`, {
      token: topicOwner.token, body: { isClosed: false },
    });
    assert.equal(reopened.status, 200);
    const allowedPost = await api('POST', `/api/chats/${chatId}/messages`, {
      token: topicMember.token, body: { type: 'text', text: 'Можно снова', topicId },
    });
    assert.equal(allowedPost.status, 201, JSON.stringify(allowedPost.body));
  });

  test('права администратора канала ограничивают каждую операцию на сервере', async () => {
    const channel = await api('POST', '/api/chats/channel', {
      token: owner.token,
      body: { title: 'Права канала', username: 'permissionchannel', isPublic: true },
    });
    assert.equal(channel.status, 201, JSON.stringify(channel.body));
    const chatId = channel.body.chat.id;
    const joined = await api('POST', '/api/chats/join', { token: member.token, body: { username: 'permissionchannel' } });
    assert.equal(joined.status, 200);
    const promoted = await api('PATCH', `/api/chats/${chatId}/members/${member.user.id}/role`, {
      token: owner.token, body: { role: 'admin', permissions: ['publish'] },
    });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    assert.deepEqual(promoted.body.permissions, ['publish']);
    const adminInfo = await api('GET', `/api/chats/${chatId}`, { token: member.token });
    assert.equal(adminInfo.body.permissions.canPost, true);
    assert.equal(adminInfo.body.permissions.canEditInfo, false);
    assert.equal(adminInfo.body.permissions.canManageInvites, false);

    const post = await api('POST', `/api/chats/${chatId}/messages`, {
      token: member.token, body: { type: 'text', text: 'Администратор может публиковать' },
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    const editInfoDenied = await api('PATCH', `/api/chats/${chatId}`, {
      token: member.token, body: { title: 'Нельзя менять настройки' },
    });
    assert.equal(editInfoDenied.status, 403);
    const inviteDenied = await api('POST', `/api/chats/${chatId}/invites`, { token: member.token, body: {} });
    assert.equal(inviteDenied.status, 403);
    const statsDenied = await api('GET', `/api/chats/${chatId}/stats`, { token: member.token });
    assert.equal(statsDenied.status, 403);
  });

  test('ссылки-приглашения дают ограниченный доступ к приватной группе и отзываются', async () => {
    const invitee = await register(`invite${Date.now().toString(36)}`);
    const privateGroup = await api('POST', '/api/chats/group', {
      token: owner.token, body: { title: 'Закрытая группа', memberIds: [] },
    });
    const chatId = privateGroup.body.chat.id;
    const deniedList = await api('GET', `/api/chats/${chatId}/invites`, { token: member.token });
    assert.equal(deniedList.status, 403);

    const created = await api('POST', `/api/chats/${chatId}/invites`, {
      token: owner.token, body: { maxUses: 1, expiresInHours: 2 },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.invite.token, /^aur_[A-Za-z0-9_-]{32}$/);
    assert.equal(created.body.invite.max_uses, 1);
    assert.ok(created.body.invite.expires_at > Date.now());
    const firstJoin = await api('POST', '/api/chats/join-invite', {
      token: invitee.token, body: { token: created.body.invite.token },
    });
    assert.equal(firstJoin.status, 200, JSON.stringify(firstJoin.body));
    assert.equal(firstJoin.body.chat.id, chatId);
    const secondJoin = await api('POST', '/api/chats/join-invite', {
      token: member.token, body: { token: created.body.invite.token },
    });
    assert.equal(secondJoin.status, 404);

    const revokeMe = await api('POST', `/api/chats/${chatId}/invites`, { token: owner.token, body: {} });
    assert.equal(revokeMe.status, 201);
    const revoked = await api('DELETE', `/api/chats/${chatId}/invites/${revokeMe.body.invite.id}`, { token: owner.token });
    assert.equal(revoked.status, 200);
    const revokedJoin = await api('POST', '/api/chats/join-invite', {
      token: member.token, body: { token: revokeMe.body.invite.token },
    });
    assert.equal(revokedJoin.status, 404);
  });

  test('канал: публикация только админами, просмотры, подписка по username', async () => {
    const channel = await api('POST', '/api/chats/channel', { token: owner.token, body: { title: 'Aurora News', username: 'auroranews', description: 'новости', isPublic: true } });
    assert.equal(channel.status, 201);
    const id = channel.body.chat.id;
    const join = await api('POST', '/api/chats/join', { token: member.token, body: { username: 'auroranews' } });
    assert.equal(join.status, 200);
    const post = await api('POST', `/api/chats/${id}/messages`, { token: owner.token, body: { type: 'text', text: 'Первая публикация' } });
    assert.equal(post.status, 201);
    const forbiddenPost = await api('POST', `/api/chats/${id}/messages`, { token: member.token, body: { type: 'text', text: 'спам' } });
    assert.equal(forbiddenPost.status, 403);
    const view = await api('POST', `/api/messages/${post.body.message.id}/view`, { token: member.token });
    assert.equal(view.body.views, 1);

    const linkedRequest = await api('POST', '/api/support/requests', {
      token: member.token, body: { chatId: id, category: 'channel' },
    });
    assert.equal(linkedRequest.status, 403);
    const db = new Database(path.join(DATA_DIR, 'aurora.db'));
    const legacyRequest = db.prepare(`INSERT INTO support_requests
      (user_id, chat_id, category, subject, status, created_at, updated_at)
      VALUES (?, ?, 'channel', '', 'open', ?, ?)`).run(member.user.id, id, Date.now(), Date.now());
    db.close();
    const supportPost = await api('POST', `/api/support/requests/${legacyRequest.lastInsertRowid}/message`, {
      token: member.token, body: { text: 'Обход прав публикации' },
    });
    assert.equal(supportPost.status, 403);
    const history = await api('GET', `/api/chats/${id}/messages`, { token: owner.token });
    assert.equal(history.body.messages.length, 1);
  });

  test('комментарии канала сохраняются, считаются и приходят через real-time', async () => {
    const channel = await api('POST', '/api/chats/channel', {
      token: owner.token,
      body: { title: 'Комментарии Aurora', username: 'commentsaurora', isPublic: true },
    });
    assert.equal(channel.status, 201, JSON.stringify(channel.body));
    const chatId = channel.body.chat.id;
    const joined = await api('POST', '/api/chats/join', { token: member.token, body: { username: 'commentsaurora' } });
    assert.equal(joined.status, 200);

    const ownerWs = connect(owner.token);
    await ownerWs.open();
    const post = await api('POST', `/api/chats/${chatId}/messages`, {
      token: owner.token, body: { type: 'text', text: 'Пост для комментариев' },
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    const messageId = post.body.message.id;
    assert.equal(post.body.message.commentsCount, 0);

    const reaction = await api('POST', `/api/messages/${messageId}/reactions`, {
      token: member.token, body: { emoji: '🔥' },
    });
    assert.equal(reaction.status, 200, JSON.stringify(reaction.body));
    assert.equal(reaction.body.action, 'added');
    assert.equal(reaction.body.reactions[0].count, 1);
    const reactionEvent = await ownerWs.wait('reaction.update');
    assert.equal(reactionEvent.payload.messageId, messageId);
    assert.equal(reactionEvent.payload.reactions[0].count, 1);

    const empty = await api('GET', `/api/messages/${messageId}/comments`, { token: member.token });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.comments, []);

    const blank = await api('POST', `/api/messages/${messageId}/comments`, {
      token: member.token, body: { text: '   ' },
    });
    assert.equal(blank.status, 400);
    const tooLong = await api('POST', `/api/messages/${messageId}/comments`, {
      token: member.token, body: { text: 'x'.repeat(1001) },
    });
    assert.equal(tooLong.status, 400);

    const posted = await api('POST', `/api/messages/${messageId}/comments`, {
      token: member.token, body: { text: 'Хорошая публикация!' },
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.equal(posted.body.commentsCount, 1);
    assert.equal(posted.body.comment.text, 'Хорошая публикация!');
    assert.equal(posted.body.comment.author.name, member.user.name);
    assert.ok(Object.hasOwn(posted.body.comment.author, 'avatarUrl'));
    assert.ok(Object.hasOwn(posted.body.comment.author, 'avatarColor'));

    const realtime = await ownerWs.wait('comment.new');
    assert.equal(realtime.chatId, chatId);
    assert.equal(realtime.payload.messageId, messageId);
    assert.equal(realtime.payload.commentsCount, 1);
    assert.equal(realtime.payload.comment.id, posted.body.comment.id);
    const updates = await api('GET', `/api/updates?since=${realtime.eventId - 1}`, { token: owner.token });
    assert.ok(updates.body.events.some((event) => event.type === 'comment.new' && event.payload.comment.id === posted.body.comment.id));

    const page = await api('GET', `/api/chats/${chatId}/messages`, { token: owner.token });
    assert.equal(page.body.messages.find((message) => message.id === messageId).commentsCount, 1);
    assert.equal(page.body.messages.find((message) => message.id === messageId).reactions[0].count, 1);
    const listed = await api('GET', `/api/messages/${messageId}/comments`, { token: owner.token });
    assert.deepEqual(listed.body.comments.map((comment) => comment.id), [posted.body.comment.id]);

    const outsider = await register('18');
    const denied = await api('GET', `/api/messages/${messageId}/comments`, { token: outsider.token });
    assert.equal(denied.status, 403);

    const group = await api('POST', '/api/chats/group', {
      token: owner.token, body: { title: 'Без комментариев', memberIds: [member.user.id] },
    });
    const groupPost = await api('POST', `/api/chats/${group.body.chat.id}/messages`, {
      token: owner.token, body: { type: 'text', text: 'Не канал' },
    });
    const unsupported = await api('GET', `/api/messages/${groupPost.body.message.id}/comments`, { token: member.token });
    assert.equal(unsupported.status, 400);
    ownerWs.close();
  });

  test('комментарии можно редактировать, удалять, лайкать и обсуждать ответами одного уровня', async () => {
    const channel = await api('POST', '/api/chats/channel', {
      token: owner.token,
      body: { title: 'Управление обсуждением', username: 'discussionfeatures', isPublic: true },
    });
    assert.equal(channel.status, 201, JSON.stringify(channel.body));
    const chatId = channel.body.chat.id;
    const joined = await api('POST', '/api/chats/join', {
      token: member.token,
      body: { username: 'discussionfeatures' },
    });
    assert.equal(joined.status, 200);
    const post = await api('POST', `/api/chats/${chatId}/messages`, {
      token: owner.token,
      body: { type: 'text', text: 'Обсуждение публикации' },
    });
    const messageId = post.body.message.id;
    const root = await api('POST', `/api/messages/${messageId}/comments`, {
      token: member.token,
      body: { text: 'Основной комментарий' },
    });
    assert.equal(root.status, 201, JSON.stringify(root.body));

    const reply = await api('POST', `/api/messages/${messageId}/comments`, {
      token: owner.token,
      body: { text: 'Ответ на комментарий', parentId: root.body.comment.id },
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.comment.parentId, root.body.comment.id);
    assert.equal(reply.body.commentsCount, 2);

    const nestedReply = await api('POST', `/api/messages/${messageId}/comments`, {
      token: member.token,
      body: { text: 'Вложенный ответ не разрешён', parentId: reply.body.comment.id },
    });
    assert.equal(nestedReply.status, 400);
    const crossPostReply = await api('POST', `/api/messages/${messageId}/comments`, {
      token: member.token,
      body: { text: 'Ответ в другой публикации', parentId: Number.MAX_SAFE_INTEGER },
    });
    assert.equal(crossPostReply.status, 400);

    const liked = await api('POST', `/api/messages/${messageId}/comments/${root.body.comment.id}/likes`, { token: owner.token });
    assert.deepEqual(liked.body, { likedByMe: true, likesCount: 1 });
    const unliked = await api('POST', `/api/messages/${messageId}/comments/${root.body.comment.id}/likes`, { token: owner.token });
    assert.deepEqual(unliked.body, { likedByMe: false, likesCount: 0 });

    const edited = await api('PATCH', `/api/messages/${messageId}/comments/${root.body.comment.id}`, {
      token: member.token,
      body: { text: 'Исправленный комментарий' },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.comment.text, 'Исправленный комментарий');
    assert.ok(edited.body.comment.editedAt);
    const forbiddenEdit = await api('PATCH', `/api/messages/${messageId}/comments/${root.body.comment.id}`, {
      token: owner.token,
      body: { text: 'Не автор' },
    });
    assert.equal(forbiddenEdit.status, 403);

    const removedByModerator = await api('DELETE', `/api/messages/${messageId}/comments/${root.body.comment.id}`, {
      token: owner.token,
    });
    assert.equal(removedByModerator.status, 200);
    assert.equal(removedByModerator.body.commentsCount, 1);
    const afterRemoval = await api('GET', `/api/messages/${messageId}/comments`, { token: member.token });
    assert.equal(afterRemoval.body.comments[0].deleted, true);
    assert.equal(afterRemoval.body.comments[0].text, '');
    assert.equal(afterRemoval.body.comments[1].parentId, root.body.comment.id);
    assert.equal(afterRemoval.body.commentsCount, 1);

    const removedReply = await api('DELETE', `/api/messages/${messageId}/comments/${reply.body.comment.id}`, {
      token: owner.token,
    });
    assert.equal(removedReply.status, 200);
    assert.equal(removedReply.body.commentsCount, 0);
    const finalList = await api('GET', `/api/messages/${messageId}/comments`, { token: owner.token });
    assert.equal(finalList.body.comments[1].deleted, true);
    assert.equal(finalList.body.commentsCount, 0);
    const updatedPost = await api('GET', `/api/chats/${chatId}/messages`, { token: owner.token });
    assert.equal(updatedPost.body.messages.find((item) => item.id === messageId).commentsCount, 0);
  });

  test('настройки канала ограничивают комментарии и реакции на сервере', async () => {
    const channel = await api('POST', '/api/chats/channel', {
      token: owner.token,
      body: { title: 'Управление контентом', username: 'contentcontrols', isPublic: true },
    });
    assert.equal(channel.status, 201, JSON.stringify(channel.body));
    const chatId = channel.body.chat.id;
    const joined = await api('POST', '/api/chats/join', { token: member.token, body: { username: 'contentcontrols' } });
    assert.equal(joined.status, 200);

    const post = await api('POST', `/api/chats/${chatId}/messages`, {
      token: owner.token, body: { type: 'text', text: 'Проверка настроек канала' },
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    const messageId = post.body.message.id;
    const memberWs = connect(member.token);
    await memberWs.open();

    const unauthorized = await api('PATCH', `/api/chats/${chatId}`, {
      token: member.token, body: { commentsEnabled: false },
    });
    assert.equal(unauthorized.status, 403);

    const disabled = await api('PATCH', `/api/chats/${chatId}`, {
      token: owner.token, body: { commentsEnabled: false, reactionsEnabled: false },
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    assert.equal(disabled.body.chat.commentsEnabled, false);
    assert.equal(disabled.body.chat.reactionsEnabled, false);
    const settingsEvent = await memberWs.wait('chat.update');
    assert.equal(settingsEvent.payload.chat.commentsEnabled, false);
    assert.equal(settingsEvent.payload.chat.reactionsEnabled, false);
    const deniedComment = await api('POST', `/api/messages/${messageId}/comments`, {
      token: member.token, body: { text: 'Комментарий должен быть запрещён' },
    });
    assert.equal(deniedComment.status, 403);
    const deniedReaction = await api('POST', `/api/messages/${messageId}/reactions`, {
      token: member.token, body: { emoji: '🔥' },
    });
    assert.equal(deniedReaction.status, 403);

    const restricted = await api('PATCH', `/api/chats/${chatId}`, {
      token: owner.token, body: { commentsEnabled: true, reactionsEnabled: true, allowedReactions: ['❤️'] },
    });
    assert.equal(restricted.status, 200, JSON.stringify(restricted.body));
    assert.deepEqual(restricted.body.chat.allowedReactions, ['❤️']);
    const deniedEmoji = await api('POST', `/api/messages/${messageId}/reactions`, {
      token: member.token, body: { emoji: '🔥' },
    });
    assert.equal(deniedEmoji.status, 403);
    const allowedEmoji = await api('POST', `/api/messages/${messageId}/reactions`, {
      token: member.token, body: { emoji: '❤️' },
    });
    assert.equal(allowedEmoji.status, 200, JSON.stringify(allowedEmoji.body));

    const noneAllowed = await api('PATCH', `/api/chats/${chatId}`, {
      token: owner.token, body: { allowedReactions: [] },
    });
    assert.equal(noneAllowed.status, 200, JSON.stringify(noneAllowed.body));
    const removedExisting = await api('POST', `/api/messages/${messageId}/reactions`, {
      token: member.token, body: { emoji: '❤️' },
    });
    assert.equal(removedExisting.status, 200);
    assert.equal(removedExisting.body.action, 'removed');
    const deniedAfterRemoval = await api('POST', `/api/messages/${messageId}/reactions`, {
      token: member.token, body: { emoji: '❤️' },
    });
    assert.equal(deniedAfterRemoval.status, 403);

    const reset = await api('PATCH', `/api/chats/${chatId}`, {
      token: owner.token, body: { allowedReactions: null },
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.chat.allowedReactions, null);
    const stats = await api('GET', `/api/chats/${chatId}/stats`, { token: owner.token });
    assert.equal(stats.status, 200, JSON.stringify(stats.body));
    assert.equal(stats.body.summary.posts, 1);
    assert.equal(stats.body.summary.reactions, 0);
    const statsDenied = await api('GET', `/api/chats/${chatId}/stats`, { token: member.token });
    assert.equal(statsDenied.status, 403);
    memberWs.close();
  });

  test('заявки на вступление требуют одобрения и не расходуют приглашение заранее', async () => {
    const channel = await api('POST', '/api/chats/channel', {
      token: owner.token,
      body: { title: 'Закрытый доступ', username: 'approvalchannel', isPublic: true },
    });
    assert.equal(channel.status, 201, JSON.stringify(channel.body));
    const chatId = channel.body.chat.id;
    const configured = await api('PATCH', `/api/chats/${chatId}`, {
      token: owner.token, body: { joinApprovalRequired: true },
    });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal(configured.body.chat.joinApprovalRequired, true);

    const ownerWs = connect(owner.token);
    await ownerWs.open();
    const pendingMember = await register('approval1');
    const directRequest = await api('POST', '/api/chats/join', {
      token: pendingMember.token, body: { username: 'approvalchannel' },
    });
    assert.equal(directRequest.status, 202, JSON.stringify(directRequest.body));
    assert.equal(directRequest.body.requestPending, true);
    const requestEvent = await ownerWs.wait('chat.join_request');
    assert.equal(requestEvent.payload.chatId, chatId);
    const deniedHistory = await api('GET', `/api/chats/${chatId}/messages`, { token: pendingMember.token });
    assert.equal(deniedHistory.status, 403);
    const memberListDenied = await api('GET', `/api/chats/${chatId}/join-requests`, { token: pendingMember.token });
    assert.equal(memberListDenied.status, 403);
    const requests = await api('GET', `/api/chats/${chatId}/join-requests`, { token: owner.token });
    assert.equal(requests.status, 200);
    assert.equal(requests.body.requests.length, 1);
    const approved = await api('POST', `/api/chats/${chatId}/join-requests/${requests.body.requests[0].id}`, {
      token: owner.token, body: { action: 'approve' },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const admittedHistory = await api('GET', `/api/chats/${chatId}/messages`, { token: pendingMember.token });
    assert.equal(admittedHistory.status, 200);

    const invite = await api('POST', `/api/chats/${chatId}/invites`, {
      token: owner.token, body: { maxUses: 1 },
    });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    const inviteMember = await register('approval2');
    const inviteRequest = await api('POST', '/api/chats/join-invite', {
      token: inviteMember.token, body: { token: invite.body.invite.token },
    });
    assert.equal(inviteRequest.status, 202, JSON.stringify(inviteRequest.body));
    let inviteList = await api('GET', `/api/chats/${chatId}/invites`, { token: owner.token });
    assert.equal(inviteList.body.invites[0].use_count, 0);
    const requestForInvite = (await api('GET', `/api/chats/${chatId}/join-requests`, { token: owner.token }))
      .body.requests.find((request) => request.userId === inviteMember.user.id);
    assert.ok(requestForInvite);
    const inviteApproved = await api('POST', `/api/chats/${chatId}/join-requests/${requestForInvite.id}`, {
      token: owner.token, body: { action: 'approve' },
    });
    assert.equal(inviteApproved.status, 200, JSON.stringify(inviteApproved.body));
    inviteList = await api('GET', `/api/chats/${chatId}/invites`, { token: owner.token });
    assert.equal(inviteList.body.invites[0].use_count, 1);
    ownerWs.close();
  });

  test('жалобы на посты видны администраторам и позволяют безопасно удалить публикацию', async () => {
    const channel = await api('POST', '/api/chats/channel', {
      token: owner.token,
      body: { title: 'Модерация Aurora', username: 'moderationaurora', isPublic: true },
    });
    assert.equal(channel.status, 201, JSON.stringify(channel.body));
    const chatId = channel.body.chat.id;
    const joined = await api('POST', '/api/chats/join', { token: member.token, body: { username: 'moderationaurora' } });
    assert.equal(joined.status, 200);
    const post = await api('POST', `/api/chats/${chatId}/messages`, {
      token: owner.token, body: { type: 'text', text: 'Публикация для проверки модерации' },
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));

    const report = await api('POST', `/api/messages/${post.body.message.id}/report`, {
      token: member.token, body: { reason: 'spam', details: 'Нежелательная публикация' },
    });
    assert.equal(report.status, 201, JSON.stringify(report.body));
    const duplicate = await api('POST', `/api/messages/${post.body.message.id}/report`, {
      token: member.token, body: { reason: 'other' },
    });
    assert.equal(duplicate.status, 409);

    const outsider = await register('moderationoutsider');
    const forbiddenList = await api('GET', `/api/chats/${chatId}/reports`, { token: outsider.token });
    assert.equal(forbiddenList.status, 403);
    const reports = await api('GET', `/api/chats/${chatId}/reports`, { token: owner.token });
    assert.equal(reports.status, 200);
    assert.equal(reports.body.reports[0].reporterId, member.user.id);
    assert.equal(reports.body.reports[0].details, 'Нежелательная публикация');
    const resolved = await api('POST', `/api/chats/${chatId}/reports/${report.body.reportId}`, {
      token: owner.token, body: { action: 'removeMessage' },
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const history = await api('GET', `/api/chats/${chatId}/messages`, { token: member.token });
    assert.equal(history.body.messages.some((message) => message.id === post.body.message.id), false);
    const emptyQueue = await api('GET', `/api/chats/${chatId}/reports`, { token: owner.token });
    assert.deepEqual(emptyQueue.body.reports, []);
  });

  test('отложенные посты доступны только администраторам и сохраняются до отмены', async () => {
    const channel = await api('POST', '/api/chats/channel', {
      token: owner.token,
      body: { title: 'План публикаций', username: 'scheduledaurora', isPublic: true },
    });
    assert.equal(channel.status, 201, JSON.stringify(channel.body));
    const chatId = channel.body.chat.id;
    const joined = await api('POST', '/api/chats/join', { token: member.token, body: { username: 'scheduledaurora' } });
    assert.equal(joined.status, 200);
    const scheduledAt = Date.now() + 2 * 60 * 1000;
    const create = await api('POST', `/api/chats/${chatId}/scheduled-posts`, {
      token: owner.token, body: { text: 'Публикация выйдет позже', scheduledAt },
    });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    assert.equal(create.body.post.status, 'scheduled');
    assert.equal(create.body.post.scheduledAt, scheduledAt);
    const denied = await api('GET', `/api/chats/${chatId}/scheduled-posts`, { token: member.token });
    assert.equal(denied.status, 403);
    const tooSoon = await api('POST', `/api/chats/${chatId}/scheduled-posts`, {
      token: owner.token, body: { text: 'Рано', scheduledAt: Date.now() + 1000 },
    });
    assert.equal(tooSoon.status, 400);
    const list = await api('GET', `/api/chats/${chatId}/scheduled-posts`, { token: owner.token });
    assert.deepEqual(list.body.posts.map((post) => post.id), [create.body.post.id]);
    const database = new Database(path.join(DATA_DIR, 'aurora.db'));
    database.prepare('UPDATE scheduled_posts SET scheduled_at = ? WHERE id = ?')
      .run(Date.now() - 1000, create.body.post.id);
    database.close();
    let published;
    for (let attempt = 0; attempt < 70; attempt++) {
      const current = await api('GET', `/api/chats/${chatId}/scheduled-posts`, { token: owner.token });
      published = current.body.posts.find((post) => post.id === create.body.post.id);
      if (!published) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(published, undefined, 'успешная публикация должна покинуть очередь');
    const history = await api('GET', `/api/chats/${chatId}/messages`, { token: owner.token });
    assert.equal(history.body.messages.filter((message) => message.text === 'Публикация выйдет позже').length, 1);

    const secondPost = await api('POST', `/api/chats/${chatId}/scheduled-posts`, {
      token: owner.token, body: { text: 'Публикация для отмены', scheduledAt: Date.now() + 2 * 60 * 1000 },
    });
    assert.equal(secondPost.status, 201, JSON.stringify(secondPost.body));
    const cancelled = await api('DELETE', `/api/chats/${chatId}/scheduled-posts/${secondPost.body.post.id}`, { token: owner.token });
    assert.equal(cancelled.status, 200);
    const empty = await api('GET', `/api/chats/${chatId}/scheduled-posts`, { token: owner.token });
    assert.deepEqual(empty.body.posts, []);
  });

  test('поиск находит пользователей, каналы и сообщения', async () => {
    const users = await api('GET', '/api/search?q=tester6', { token: owner.token });
    assert.ok(users.body.users.some((u) => u.username === 'tester6'));
    const chats = await api('GET', '/api/search?q=auroranews', { token: owner.token });
    assert.ok(chats.body.chats.some((c) => c.username === 'auroranews'));
    const msgs = await api('GET', '/api/search?q=публикация', { token: owner.token });
    assert.ok(msgs.body.messages.length >= 1);
  });

  test('оплата Аврор проверяет идемпотентность и начисляет только подтверждённый YooKassa webhook', async () => {
    const catalog = await api('GET', '/api/commerce/catalog', { token: owner.token });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.paymentsEnabled, true);
    assert.deepEqual(catalog.body.balancePackages.map(({ id, auroras, price }) => [id, auroras, price]), [
      ['aurora-100', 100, 10],
      ['aurora-500', 500, 279],
      ['aurora-1000', 1000, 589],
      ['aurora-2500', 2500, 1399],
    ]);
    assert.deepEqual(catalog.body.premiumPlans.map(({ id, months, price }) => [id, months, price]), [
      ['premium-1m', 1, 99],
      ['premium-3m', 3, 289],
      ['premium-6m', 6, 589],
      ['premium-12m', 12, 1099],
    ]);
    const before = await api('GET', '/api/commerce/wallet', { token: owner.token });
    const idempotencyKey = crypto.randomUUID();
    const missingEmail = await api('POST', '/api/commerce/wallet/purchase', {
      token: owner.token,
      body: { packageId: 'aurora-100', idempotencyKey: crypto.randomUUID() },
    });
    assert.equal(missingEmail.status, 400);
    const invalidEmail = await api('POST', '/api/commerce/wallet/purchase', {
      token: owner.token,
      body: { packageId: 'aurora-100', receiptEmail: 'not-an-email', idempotencyKey: crypto.randomUUID() },
    });
    assert.equal(invalidEmail.status, 400);
    const purchase = await api('POST', '/api/commerce/wallet/purchase', {
      token: owner.token,
      body: { packageId: 'aurora-100', receiptEmail: ' Receipts@Aurora.Test ', idempotencyKey },
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
    assert.equal(purchase.body.status, 'pending');
    assert.match(purchase.body.confirmationUrl, /^https:\/\/yoomoney\.ru\//);
    const duplicate = await api('POST', '/api/commerce/wallet/purchase', {
      token: owner.token,
      body: { packageId: 'aurora-100', receiptEmail: 'receipts@aurora.test', idempotencyKey },
    });
    assert.equal(duplicate.body.orderId, purchase.body.orderId);
    assert.equal(mockPayments.size, 1);
    const conflicting = await api('POST', '/api/commerce/wallet/purchase', {
      token: owner.token,
      body: { packageId: 'aurora-500', receiptEmail: 'receipts@aurora.test', idempotencyKey },
    });
    assert.equal(conflicting.status, 409);
    const conflictingEmail = await api('POST', '/api/commerce/wallet/purchase', {
      token: owner.token,
      body: { packageId: 'aurora-100', receiptEmail: 'different@aurora.test', idempotencyKey },
    });
    assert.equal(conflictingEmail.status, 409);

    const after = await api('GET', '/api/commerce/wallet', { token: owner.token });
    assert.equal(after.body.balance, before.body.balance);
    const payment = [...mockPayments.values()].find((item) => item.metadata.order_id === purchase.body.orderId);
    assert.equal(payment.amount.value, '10.00');
    assert.deepEqual(payment.payment_method_data, { type: 'sbp' });
    assert.equal(Object.hasOwn(payment.requestBody, 'receipt'), false);
    assert.equal(Object.hasOwn(payment.requestBody, 'receiptEmail'), false);
    payment.status = 'succeeded';
    payment.paid = true;
    const notification = {
      event: 'payment.succeeded',
      object: { id: payment.id, metadata: payment.metadata },
    };
    const webhook = await api('POST', '/api/commerce/yookassa/webhook', { body: notification });
    assert.equal(webhook.status, 200, JSON.stringify(webhook.body));
    const repeatedWebhook = await api('POST', '/api/commerce/yookassa/webhook', { body: notification });
    assert.equal(repeatedWebhook.status, 200);
    const paid = await api('GET', '/api/commerce/wallet', { token: owner.token });
    assert.equal(paid.body.balance, before.body.balance + 100);
    assert.equal(paid.body.purchases.filter((item) => item.provider === 'yookassa').length, 1);
    const order = await api('GET', `/api/commerce/payments/${purchase.body.orderId}`, { token: owner.token });
    assert.equal(order.body.status, 'succeeded');
    assert.equal(order.body.kind, 'auroras');
    const admin = await register(`pa${Date.now().toString(36)}`);
    const adminDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    adminDb.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.user.id);
    adminDb.close();
    const adminCommerce = await api('GET', '/api/admin/commerce', { token: admin.token });
    assert.equal(adminCommerce.status, 200);
    assert.ok(adminCommerce.body.paymentOrders.some((paidOrder) => paidOrder.id === purchase.body.orderId
      && paidOrder.receipt_email === 'receipts@aurora.test'
      && paidOrder.amount_minor === 1000
      && paidOrder.units === 100));
    const forbiddenCommerce = await api('GET', '/api/admin/commerce', { token: owner.token });
    assert.equal(forbiddenCommerce.status, 403);

    const tamperedCheckout = await api('POST', '/api/commerce/wallet/purchase', {
      token: owner.token,
      body: { packageId: 'aurora-500', receiptEmail: 'owner@aurora.test', idempotencyKey: crypto.randomUUID() },
    });
    const tamperedPayment = [...mockPayments.values()].find((item) => item.metadata.order_id === tamperedCheckout.body.orderId);
    tamperedPayment.amount = { value: '2.79', currency: 'RUB' };
    tamperedPayment.status = 'succeeded';
    tamperedPayment.paid = true;
    const rejectedWebhook = await api('POST', '/api/commerce/yookassa/webhook', {
      body: { event: 'payment.succeeded', object: { id: tamperedPayment.id, metadata: tamperedPayment.metadata } },
    });
    assert.equal(rejectedWebhook.status, 400);
    const unchanged = await api('GET', '/api/commerce/wallet', { token: owner.token });
    assert.equal(unchanged.body.balance, paid.body.balance);
  });

  test('оплаченный Premium активируется только после проверки статуса YooKassa', async () => {
    const user = await register(`pay${Date.now().toString(36)}`);
    const checkout = await api('POST', '/api/commerce/premium/subscribe', {
      token: user.token,
      body: { planId: 'premium-6m', receiptEmail: 'premium-receipt@aurora.test', idempotencyKey: crypto.randomUUID() },
    });
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    const payment = [...mockPayments.values()].find((item) => item.metadata.order_id === checkout.body.orderId);
    assert.equal(payment.amount.value, '589.00');
    assert.deepEqual(payment.payment_method_data, { type: 'sbp' });
    const before = await api('GET', '/api/commerce/catalog', { token: user.token });
    assert.equal(before.body.premium, null);
    payment.status = 'succeeded';
    payment.paid = true;
    const status = await api('GET', `/api/commerce/payments/${checkout.body.orderId}?refresh=1`, { token: user.token });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'succeeded');
    const after = await api('GET', '/api/commerce/catalog', { token: user.token });
    assert.equal(after.body.premium.planId, 'premium-6m');
    assert.equal(after.body.premium.expiresAt - Date.now() > 179 * 24 * 60 * 60 * 1000, true);
    const admin = await register(`pr${Date.now().toString(36)}`);
    const adminDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    adminDb.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.user.id);
    adminDb.close();
    const adminCommerce = await api('GET', '/api/admin/commerce', { token: admin.token });
    assert.ok(adminCommerce.body.paymentOrders.some((paidOrder) => paidOrder.id === checkout.body.orderId
      && paidOrder.kind === 'premium'
      && paidOrder.receipt_email === 'premium-receipt@aurora.test'
      && paidOrder.amount_minor === 58900
      && paidOrder.units === 6));
  });

  test('загрузка медиа: проверка типа, лимит и подписанная ссылка', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    const thumbPng = Buffer.concat([png, Buffer.from('thumb-fixture')]);
    const thumbForm = new FormData();
    thumbForm.append('file', new Blob([png], { type: 'image/png' }), 'with-thumb.png');
    thumbForm.append('thumb', new Blob([thumbPng], { type: 'image/png' }), 'thumb.png');
    const thumbUpload = await api('POST', '/api/media', { token: owner.token, raw: thumbForm });
    assert.equal(thumbUpload.status, 201, JSON.stringify(thumbUpload.body));
    const thumbResponse = await fetch(`${BASE}${thumbUpload.body.media.thumbUrl}`);
    assert.equal(thumbResponse.status, 200);
    assert.equal((await thumbResponse.arrayBuffer()).byteLength, thumbPng.length);

    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
    form.append('kind', 'image');
    const up = await api('POST', '/api/media', { token: owner.token, raw: form });
    assert.equal(up.status, 201);
    assert.equal(up.body.media.kind, 'image');
    assert.match(up.body.media.url, /^\/media\/\d+\?e=/);
    assert.equal((await api('GET', `/api/media/${up.body.media.id}`, { token: owner.token })).status, 200);
    assert.equal((await api('GET', `/api/media/${up.body.media.id}`, { token: member.token })).status, 404);
    const mediaLimits = await api('GET', '/api/media/limits', { token: owner.token });
    assert.equal(mediaLimits.status, 200, JSON.stringify(mediaLimits.body));
    assert.ok(mediaLimits.body.accepted.voice.includes('audio/aac'));
    assert.equal(mediaLimits.body.limits.image, 100 * 1024 * 1024);
    assert.equal(mediaLimits.body.limits.video, 500 * 1024 * 1024);
    assert.equal(mediaLimits.body.limits.file, 500 * 1024 * 1024);
    assert.equal(mediaLimits.body.blockedExtensions.includes('apk'), false);

    const apkForm = new FormData();
    apkForm.append('file', new Blob([Buffer.from('504b0304', 'hex')], { type: 'application/vnd.android.package-archive' }), 'aurora-test.apk');
    const apkUpload = await api('POST', '/api/media', { token: owner.token, raw: apkForm });
    assert.equal(apkUpload.status, 201, JSON.stringify(apkUpload.body));
    assert.equal(apkUpload.body.media.kind, 'file');
    assert.equal(apkUpload.body.media.mime, 'application/vnd.android.package-archive');
    assert.equal(apkUpload.body.media.filename, 'aurora-test.apk');
    assert.equal(fs.readdirSync(path.join(DATA_DIR, '.upload-tmp')).length, 0);

    const profileUpdate = await api('PATCH', '/api/auth/profile', {
      token: owner.token,
      body: { avatarMediaId: up.body.media.id, profileBgMediaId: up.body.media.id },
    });
    assert.equal(profileUpdate.status, 200, JSON.stringify(profileUpdate.body));
    assert.match(profileUpdate.body.user.avatarUrl, /^\/media\/\d+\?e=/);
    assert.match(profileUpdate.body.user.profileBg, /^\/media\/\d+\?e=/);

    // чужая подпись/без подписи — 403
    const unsigned = await fetch(`${BASE}/media/${up.body.media.id}`);
    assert.equal(unsigned.status, 403);
    const signed = await fetch(`${BASE}${up.body.media.url}`);
    assert.equal(signed.status, 200);
    assert.match(signed.headers.get('content-disposition'), /^inline;/);
    const downloaded = await fetch(`${BASE}${up.body.media.url}&download=1`);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('content-disposition'), /^attachment;/);

    // подделка расширения: .exe внутрь png → блокируем по расширению
    const form2 = new FormData();
    form2.append('file', new Blob([png], { type: 'image/png' }), 'virus.exe');
    const bad = await api('POST', '/api/media', { token: owner.token, raw: form2 });
    assert.equal(bad.status, 415);

    // отправка картинки сообщением
    const chatId = (await api('GET', '/api/chats', { token: owner.token })).body.chats[0].id;
    const msg = await api('POST', `/api/chats/${chatId}/messages`, { token: owner.token, body: { type: 'photo', mediaId: up.body.media.id, text: 'смотри' } });
    assert.equal(msg.status, 201);
    assert.equal(msg.body.message.type, 'photo');

    for (const fixture of [
      { filename: 'voice.webm', mime: 'audio/webm', bytes: Buffer.from('1a45dfa3', 'hex') },
      { filename: 'voice.m4a', mime: 'audio/mp4', bytes: Buffer.from('00000018667479706d7034320000000069736f6d', 'hex') },
      { filename: 'voice.aac', mime: 'audio/aac', bytes: Buffer.from('fff15080001ffc', 'hex') },
    ]) {
      const voiceForm = new FormData();
      voiceForm.append('file', new Blob([fixture.bytes], { type: fixture.mime }), fixture.filename);
      voiceForm.append('kind', 'voice');
      const voiceUpload = await api('POST', '/api/media', { token: owner.token, raw: voiceForm });
      assert.equal(voiceUpload.status, 201);
      assert.equal(voiceUpload.body.media.kind, 'voice');
      assert.equal(voiceUpload.body.media.mime, fixture.mime);
      const voiceMessage = await api('POST', `/api/chats/${chatId}/messages`, {
        token: owner.token,
        body: { type: 'voice', mediaId: voiceUpload.body.media.id },
      });
      assert.equal(voiceMessage.status, 201);
      assert.equal(voiceMessage.body.message.type, 'voice');
    }
    const mediaGallery = await api('GET', `/api/chats/${chatId}/media`, { token: owner.token });
    assert.equal(mediaGallery.body.total, mediaGallery.body.items.length);
    assert.ok(mediaGallery.body.items.every((item) => ['image', 'video'].includes(item.kind)));

    const videoForm = new FormData();
    videoForm.append('file', new Blob([Buffer.from('00000018667479706d7034320000000069736f6d', 'hex')], { type: 'video/mp4' }), 'clip.mp4');
    videoForm.append('kind', 'video');
    const videoUpload = await api('POST', '/api/media', { token: owner.token, raw: videoForm });
    assert.equal(videoUpload.status, 201);
    assert.equal(videoUpload.body.media.kind, 'video');
    const videoMessage = await api('POST', `/api/chats/${chatId}/messages`, {
      token: owner.token, body: { type: 'video', mediaId: videoUpload.body.media.id },
    });
    assert.equal(videoMessage.status, 201, JSON.stringify(videoMessage.body));
    assert.equal(videoMessage.body.message.type, 'video');

    // нельзя приложить чужую загрузку
    const foreignMsg = await api('POST', `/api/chats/${chatId}/messages`, { token: member.token, body: { type: 'photo', mediaId: up.body.media.id } });
    assert.equal(foreignMsg.status, 403);
  });

  test('подписанная ссылка не раскрывает медиа защищённого канала постороннему', async () => {
    const outsider = await register('protectedmedia');
    const channel = await api('POST', '/api/chats/channel', {
      token: owner.token,
      body: { title: 'Защищённые вложения', isPublic: false },
    });
    assert.equal(channel.status, 201, JSON.stringify(channel.body));
    const protectedChannel = await api('PATCH', `/api/chats/${channel.body.chat.id}`, {
      token: owner.token,
      body: { protectedContent: true },
    });
    assert.equal(protectedChannel.status, 200, JSON.stringify(protectedChannel.body));

    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'protected.png');
    form.append('thumb', new Blob([png], { type: 'image/png' }), 'protected-thumb.png');
    const uploaded = await api('POST', '/api/media', { token: owner.token, raw: form });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const posted = await api('POST', `/api/chats/${channel.body.chat.id}/messages`, {
      token: owner.token,
      body: { type: 'photo', mediaId: uploaded.body.media.id },
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));

    for (const url of [posted.body.message.media.url, uploaded.body.media.thumbUrl]) {
      const ownerResponse = await api('GET', url, { token: owner.token });
      assert.equal(ownerResponse.status, 200);
      assert.equal(ownerResponse.headers.get('cache-control'), 'private, no-store');
      const outsiderResponse = await api('GET', url, { token: outsider.token });
      assert.equal(outsiderResponse.status, 403);
      const anonymousResponse = await fetch(`${BASE}${url}`);
      assert.equal(anonymousResponse.status, 403);
    }
  });

  test('Premium проверяется сервером: лимиты, значок, видео, обои и реакции', async () => {
    const account = await register(`premium${Date.now().toString(36)}`);
    const createGroup = (title) => api('POST', '/api/chats/group', {
      token: account.token,
      body: { title },
    });

    const firstGroup = await createGroup('Premium test 1');
    assert.equal(firstGroup.status, 201, JSON.stringify(firstGroup.body));
    const groupId = firstGroup.body.chat.id;
    for (let i = 2; i <= 10; i++) {
      const group = await createGroup(`Premium test ${i}`);
      assert.equal(group.status, 201, JSON.stringify(group.body));
    }
    assert.equal((await createGroup('Free limit exceeded')).status, 403);
    const createChannel = (title) => api('POST', '/api/chats/channel', {
      token: account.token,
      body: { title, isPublic: false },
    });
    for (let i = 1; i <= 10; i++) {
      const channel = await createChannel(`Premium channel ${i}`);
      assert.equal(channel.status, 201, JSON.stringify(channel.body));
    }
    assert.equal((await createChannel('Channel free limit exceeded')).status, 403);
    assert.equal((await api('PATCH', '/api/settings', {
      token: account.token, body: { wallpaper: 'p-nebula' },
    })).status, 403);
    assert.equal((await api('PATCH', '/api/auth/profile', {
      token: account.token, body: { premiumBadge: 'diamond' },
    })).status, 403);
    assert.equal((await api('PATCH', '/api/auth/profile', {
      token: account.token, body: { premiumEmoji: 'yabloko-golub' },
    })).status, 403);

    const message = await api('POST', `/api/chats/${groupId}/messages`, {
      token: account.token, body: { type: 'text', text: 'Free :yabloko-golub: :aurora-nova: :premium-news-star: :unknown-code:' },
    });
    assert.equal(message.status, 201);
    assert.ok(!message.body.message.text.includes(':yabloko-golub:'));
    assert.ok(!message.body.message.text.includes(':aurora-nova:'));
    assert.ok(!message.body.message.text.includes(':premium-news-star:'));
    assert.ok(message.body.message.text.includes(':unknown-code:'));
    const freeEdit = await api('PATCH', `/api/messages/${message.body.message.id}`, {
      token: account.token, body: { text: 'Edited :yabloko-logo:' },
    });
    assert.equal(freeEdit.status, 200);
    assert.equal(freeEdit.body.message.text, 'Edited ');
    assert.equal((await api('POST', `/api/messages/${message.body.message.id}/reactions`, {
      token: account.token, body: { emoji: '💎' },
    })).status, 403);
    assert.equal((await api('POST', `/api/messages/${message.body.message.id}/reactions`, {
      token: account.token, body: { emoji: 'aurora-emoji-nova' },
    })).status, 403);
    assert.equal((await api('POST', `/api/messages/${message.body.message.id}/reactions`, {
      token: account.token, body: { emoji: 'yabloko-golub' },
    })).status, 403);
    assert.equal((await api('POST', `/api/messages/${message.body.message.id}/reactions`, {
      token: account.token, body: { emoji: 'premium-news-star' },
    })).status, 403);

    const db = new Database(path.join(DATA_DIR, 'aurora.db'));
    const startsAt = Date.now();
    db.prepare(`INSERT INTO premium_subscriptions
      (user_id, plan_id, starts_at, expires_at, status, provider, created_at)
      VALUES (?, 'premium-test', ?, ?, 'active', 'test', ?)`)
      .run(account.user.id, startsAt, startsAt + 30 * 24 * 60 * 60 * 1000, startsAt);
    db.close();

    const badge = await api('PATCH', '/api/auth/profile', {
      token: account.token, body: { premiumBadge: 'diamond' },
    });
    assert.equal(badge.status, 200, JSON.stringify(badge.body));
    assert.equal(badge.body.user.premiumBadge, 'diamond');
    const nameEmoji = await api('PATCH', '/api/auth/profile', {
      token: account.token, body: { premiumEmoji: 'yabloko-bolt' },
    });
    assert.equal(nameEmoji.status, 200, JSON.stringify(nameEmoji.body));
    assert.equal(nameEmoji.body.user.premiumEmoji, 'yabloko-bolt');
    assert.equal((await api('PATCH', '/api/auth/profile', {
      token: account.token, body: { premiumEmoji: 'not-an-emoji' },
    })).status, 400);
    const clearedNameEmoji = await api('PATCH', '/api/auth/profile', {
      token: account.token, body: { premiumEmoji: null },
    });
    assert.equal(clearedNameEmoji.status, 200);
    assert.equal(clearedNameEmoji.body.user.premiumEmoji, null);
    const restoredNameEmoji = await api('PATCH', '/api/auth/profile', {
      token: account.token, body: { premiumEmoji: 'yabloko-bolt' },
    });
    assert.equal(restoredNameEmoji.status, 200);
    assert.equal((await api('GET', `/api/users/${account.user.id}`, { token: account.token })).body.user.premiumEmoji, 'yabloko-bolt');
    const viewer = await register(`ev${Date.now().toString(36)}`);
    const directChat = await api('POST', '/api/chats/dm', {
      token: viewer.token, body: { userId: account.user.id },
    });
    assert.equal(directChat.status, 200);
    assert.equal(directChat.body.chat.peer.premiumEmoji, 'yabloko-bolt');
    const groupDetails = await api('GET', `/api/chats/${groupId}`, { token: account.token });
    assert.equal(groupDetails.body.members.find((member) => member.id === account.user.id).premiumEmoji, 'yabloko-bolt');

    const wallpaper = await api('PATCH', '/api/settings', {
      token: account.token, body: { wallpaper: 'p-nebula' },
    });
    assert.equal(wallpaper.status, 200, JSON.stringify(wallpaper.body));
    assert.equal(wallpaper.body.settings.wallpaper, 'p-nebula');

    const videoForm = new FormData();
    videoForm.append('file', new Blob([
      Buffer.from('00000018667479706d7034320000000069736f6d', 'hex'),
    ], { type: 'video/mp4' }), 'premium-banner.mp4');
    videoForm.append('kind', 'video');
    const uploaded = await api('POST', '/api/media', { token: account.token, raw: videoForm });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const banner = await api('PATCH', '/api/auth/profile', {
      token: account.token, body: { profileBannerVideoMediaId: uploaded.body.media.id },
    });
    assert.equal(banner.status, 200, JSON.stringify(banner.body));
    assert.match(banner.body.user.profileBannerVideo, /^\/media\/\d+\?e=/);
    const mediaDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    const actualSize = mediaDb.prepare('SELECT size FROM media WHERE id = ?').get(uploaded.body.media.id).size;
    mediaDb.prepare('UPDATE media SET size = ? WHERE id = ?')
      .run(50 * 1024 * 1024 + 1, uploaded.body.media.id);
    const oversizedBanner = await api('PATCH', '/api/auth/profile', {
      token: account.token, body: { profileBannerVideoMediaId: uploaded.body.media.id },
    });
    assert.equal(oversizedBanner.status, 400);
    mediaDb.prepare('UPDATE media SET size = ? WHERE id = ?').run(actualSize, uploaded.body.media.id);
    mediaDb.close();

    const premiumReaction = await api('POST', `/api/messages/${message.body.message.id}/reactions`, {
      token: account.token, body: { emoji: '💎' },
    });
    assert.equal(premiumReaction.status, 200, JSON.stringify(premiumReaction.body));
    const premiumMessage = await api('POST', `/api/chats/${groupId}/messages`, {
      token: account.token, body: { type: 'text', text: ':yabloko-golub: :aurora-nova: :premium-news-star:' },
    });
    assert.equal(premiumMessage.status, 201);
    assert.equal(premiumMessage.body.message.text, ':yabloko-golub: :aurora-nova: :premium-news-star:');
    const yablokoReaction = await api('POST', `/api/messages/${premiumMessage.body.message.id}/reactions`, {
      token: account.token, body: { emoji: 'yabloko-golub' },
    });
    assert.equal(yablokoReaction.status, 200, JSON.stringify(yablokoReaction.body));
    const customPremiumReaction = await api('POST', `/api/messages/${message.body.message.id}/reactions`, {
      token: account.token, body: { emoji: 'aurora-emoji-nova' },
    });
    assert.equal(customPremiumReaction.status, 200, JSON.stringify(customPremiumReaction.body));
    const newsPremiumReaction = await api('POST', `/api/messages/${premiumMessage.body.message.id}/reactions`, {
      token: account.token, body: { emoji: 'premium-news-star' },
    });
    assert.equal(newsPremiumReaction.status, 200, JSON.stringify(newsPremiumReaction.body));

    const extraGroup = await createGroup('Premium limit extended');
    assert.equal(extraGroup.status, 201, JSON.stringify(extraGroup.body));
    const extraChannel = await createChannel('Premium channel extended');
    assert.equal(extraChannel.status, 201, JSON.stringify(extraChannel.body));
    const channelId = extraChannel.body.chat.id;
    const channelReactions = await api('PATCH', `/api/chats/${channelId}`, {
      token: account.token, body: { allowedReactions: ['yabloko-golub'] },
    });
    assert.equal(channelReactions.status, 200, JSON.stringify(channelReactions.body));
    const channelPost = await api('POST', `/api/chats/${channelId}/messages`, {
      token: account.token, body: { type: 'text', text: 'Channel reaction test' },
    });
    assert.equal(channelPost.status, 201);
    const channelReaction = await api('POST', `/api/messages/${channelPost.body.message.id}/reactions`, {
      token: account.token, body: { emoji: 'yabloko-golub' },
    });
    assert.equal(channelReaction.status, 200, JSON.stringify(channelReaction.body));
    assert.equal((await api('GET', '/api/auth/me', { token: account.token })).body.user.isPremium, true);

    const expireDb = new Database(path.join(DATA_DIR, 'aurora.db'));
    expireDb.prepare('UPDATE premium_subscriptions SET expires_at = ? WHERE user_id = ?')
      .run(Date.now() - 1, account.user.id);
    expireDb.close();
    const expired = await api('GET', '/api/auth/me', { token: account.token });
    assert.equal(expired.body.user.isPremium, false);
    assert.equal(expired.body.user.premiumBadge, null);
    assert.equal(expired.body.user.premiumEmoji, null);
    assert.equal(expired.body.user.profileBannerVideo, null);
    assert.equal(expired.body.settings.wallpaper, 'aurora');
  });

  test('подарки учитывают приватность и блокировку получателя', async () => {
    const suffix = `gift${Date.now().toString(36)}`;
    const sender = await register(`${suffix}s`);
    const recipient = await register(`${suffix}r`);
    const catalog = await api('GET', '/api/commerce/catalog', { token: sender.token });
    assert.ok(catalog.body.gifts.length);
    const gift = catalog.body.gifts[0];
    assert.match(gift.imageUrl, /^\/assets\/gifts\/[a-z]+\.svg$/);
    const firstPage = await api('GET', '/api/commerce/catalog?giftLimit=1&giftOffset=0', { token: sender.token });
    const nextPage = await api('GET', '/api/commerce/catalog?giftLimit=1&giftOffset=1', { token: sender.token });
    assert.equal(firstPage.body.gifts.length, 1);
    assert.equal(firstPage.body.giftsHasMore, true);
    assert.notEqual(firstPage.body.gifts[0].id, nextPage.body.gifts[0].id);
    const invalidPage = await api('GET', '/api/commerce/catalog?giftLimit=1000', { token: sender.token });
    assert.equal(invalidPage.status, 400);
    const db = new Database(path.join(DATA_DIR, 'aurora.db'));
    db.prepare('INSERT OR REPLACE INTO aurora_wallets (user_id, balance, updated_at) VALUES (?, ?, ?)')
      .run(sender.user.id, 500, Date.now());
    db.close();

    const dm = await api('POST', '/api/chats/dm', {
      token: sender.token, body: { userId: recipient.user.id },
    });
    assert.equal(dm.status, 200, JSON.stringify(dm.body));
    const privateSettings = await api('PATCH', '/api/settings', {
      token: recipient.token, body: { privacy: { messages: 'nobody' } },
    });
    assert.equal(privateSettings.status, 200);

    const privateGift = await api('POST', '/api/commerce/gifts/send', {
      token: sender.token, body: { recipientId: recipient.user.id, giftId: gift.id },
    });
    assert.equal(privateGift.status, 403);

    await api('PATCH', '/api/settings', {
      token: recipient.token, body: { privacy: { messages: 'everyone' } },
    });
    const blocked = await api('POST', `/api/users/${sender.user.id}/block`, {
      token: recipient.token, body: { blocked: true },
    });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    const blockedGift = await api('POST', '/api/commerce/gifts/send', {
      token: sender.token, body: { recipientId: recipient.user.id, giftId: gift.id },
    });
    assert.equal(blockedGift.status, 403);

    const after = await api('GET', '/api/commerce/wallet', { token: sender.token });
    assert.equal(after.body.balance, 500);
    assert.equal(after.body.sentGifts.length, 0);
  });

  test('отправка подарка идемпотентна, учитывает лимит и продаётся ровно один раз', async () => {
    const suffix = `giftflow${Date.now().toString(36)}`;
    const sender = await register(`${suffix}s`);
    const recipient = await register(`${suffix}r`);
    const giftId = `test-${suffix}`;
    const db = new Database(path.join(DATA_DIR, 'aurora.db'));
    db.prepare(`INSERT INTO gifts
      (id, emoji, name, description, price, animation, is_active, rarity, stock_total, stock_remaining, sellback_percent, created_at, updated_at)
      VALUES (?, '', 'Тестовый подарок', 'Проверка отправки', 200, 'aurora', 1, 'редкий', 1, 1, 50, ?, ?)`)
      .run(giftId, Date.now(), Date.now());
    db.prepare('INSERT OR REPLACE INTO aurora_wallets (user_id, balance, updated_at) VALUES (?, 500, ?)')
      .run(sender.user.id, Date.now());
    db.close();

    const key = `send-${suffix}`;
    const sent = await api('POST', '/api/commerce/gifts/send', {
      token: sender.token,
      body: { recipientId: recipient.user.id, giftId, note: 'С праздником!', idempotencyKey: key },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.message.type, 'gift');
    assert.equal(sent.body.message.gift.name, 'Тестовый подарок');

    const replay = await api('POST', '/api/commerce/gifts/send', {
      token: sender.token,
      body: { recipientId: recipient.user.id, giftId, note: 'С праздником!', idempotencyKey: key },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.instanceId, sent.body.instanceId);

    const conflictingReplay = await api('POST', '/api/commerce/gifts/send', {
      token: sender.token,
      body: { recipientId: recipient.user.id, giftId, note: 'Другое сообщение', idempotencyKey: key },
    });
    assert.equal(conflictingReplay.status, 409);

    const soldOut = await api('POST', '/api/commerce/gifts/send', {
      token: sender.token,
      body: { recipientId: recipient.user.id, giftId, idempotencyKey: `send-again-${suffix}` },
    });
    assert.equal(soldOut.status, 409);

    const senderWallet = await api('GET', '/api/commerce/wallet', { token: sender.token });
    assert.equal(senderWallet.body.balance, 300);
    const collection = await api('GET', '/api/commerce/gifts/collection', { token: recipient.token });
    assert.equal(collection.body.gifts.length, 1);
    assert.equal(collection.body.gifts[0].instanceId, sent.body.instanceId);
    assert.equal(collection.body.gifts[0].imageUrl, null);

    const hidden = await api('PATCH', `/api/commerce/gifts/collection/${sent.body.instanceId}`, {
      token: recipient.token, body: { hidden: true, pinned: true },
    });
    assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
    const profileWhileHidden = await api('GET', `/api/users/${recipient.user.id}`, { token: sender.token });
    assert.equal(profileWhileHidden.body.gifts.length, 0);

    const history = await api('GET', '/api/commerce/gifts/history', { token: recipient.token });
    assert.ok(history.body.history.some((entry) => entry.operation === 'received'));
    assert.ok(history.body.history.some((entry) => entry.operation === 'added'));
    assert.ok(history.body.history.some((entry) => entry.operation === 'hidden'));

    const saleKey = `sell-${suffix}`;
    const sold = await api('POST', `/api/commerce/gifts/collection/${sent.body.instanceId}/sell`, {
      token: recipient.token, body: { idempotencyKey: saleKey },
    });
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
    assert.equal(sold.body.refund, 100);
    const saleReplay = await api('POST', `/api/commerce/gifts/collection/${sent.body.instanceId}/sell`, {
      token: recipient.token, body: { idempotencyKey: saleKey },
    });
    assert.equal(saleReplay.status, 200);
    assert.equal(saleReplay.body.balance, sold.body.balance);
    const secondSale = await api('POST', `/api/commerce/gifts/collection/${sent.body.instanceId}/sell`, {
      token: recipient.token, body: { idempotencyKey: `sell-again-${suffix}` },
    });
    assert.equal(secondSale.status, 409);
    const recipientWallet = await api('GET', '/api/commerce/wallet', { token: recipient.token });
    assert.equal(recipientWallet.body.balance, 100);
    assert.equal(recipientWallet.body.receivedGifts.length, 0);
  });

  test('revoking a session closes only its WebSocket', async () => {
    const suffix = `r${Date.now().toString(36)}`;
    const credentials = { email: `user${suffix}@aurora.test`, password: `Passw0rd${suffix}` };
    const first = await register(suffix);
    const secondResponse = await api('POST', '/api/auth/login', { body: credentials });
    assert.equal(secondResponse.status, 200);
    const second = secondResponse.body;

    const connect = async (token) => {
      const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`, {
        headers: { Origin: PUBLIC_ORIGIN },
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket connection timed out')), 2000);
        socket.once('open', () => { clearTimeout(timer); resolve(); });
        socket.once('error', (err) => { clearTimeout(timer); reject(err); });
      });
      return socket;
    };

    let firstSocket;
    let secondSocket;
    try {
      firstSocket = await connect(first.token);
      secondSocket = await connect(second.token);
      const sessionsResponse = await api('GET', '/api/auth/sessions', { token: first.token });
      const currentSession = sessionsResponse.body.sessions.find((session) => session.current);
      assert.ok(currentSession);
      const remoteSession = sessionsResponse.body.sessions.find((session) => !session.current);
      assert.ok(remoteSession);
      assert.ok(remoteSession.deviceName);
      assert.ok(remoteSession.created_at);

      const secondClosed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Revoked WebSocket did not close')), 2000);
        secondSocket.once('close', (code) => { clearTimeout(timer); resolve(code); });
      });
      const revoke = await api('DELETE', `/api/auth/sessions/${remoteSession.id}`, { token: first.token });
      assert.equal(revoke.status, 200);
      assert.equal(await secondClosed, 4001);
      assert.equal(firstSocket.readyState, WebSocket.OPEN);
      assert.equal((await api('GET', '/api/auth/me', { token: second.token })).status, 401);

      const stranger = await register(`se${Date.now().toString(36).slice(-6)}`);
      const strangerSessions = await api('GET', '/api/auth/sessions', { token: stranger.token });
      const strangerSession = strangerSessions.body.sessions.find((session) => session.current);
      const forbiddenRevoke = await api('DELETE', `/api/auth/sessions/${strangerSession.id}`, { token: first.token });
      assert.equal(forbiddenRevoke.status, 404);
      assert.equal((await api('GET', '/api/auth/me', { token: stranger.token })).status, 200);
    } finally {
      firstSocket?.close();
      secondSocket?.close();
    }
  });

  test('настройки сохраняются и влияют на приватность', async () => {
    const stranger = await register('8');
    const existingDm = await api('POST', '/api/chats/dm', { token: member.token, body: { userId: stranger.user.id } });
    assert.equal(existingDm.status, 200);
    const patch = await api('PATCH', '/api/settings', { token: member.token, body: { theme: 'light', notify: { sounds: false }, privacy: { messages: 'contacts' } } });
    assert.equal(patch.body.settings.theme, 'light');
    assert.equal(patch.body.settings.notify.sounds, false);
    const again = await api('GET', '/api/settings', { token: member.token });
    assert.equal(again.body.settings.theme, 'light');

    const blockedNewDm = await api('POST', '/api/chats/dm', { token: stranger.token, body: { userId: member.user.id } });
    assert.equal(blockedNewDm.status, 403);
    const blockedBeforeContact = await api('POST', `/api/chats/${existingDm.body.chat.id}/messages`, {
      token: stranger.token,
      body: { text: 'Не должно доставиться' },
    });
    assert.equal(blockedBeforeContact.status, 403);
    const commonGroup = await api('POST', '/api/chats/group', {
      token: member.token,
      body: { title: 'Общий контакт', memberIds: [stranger.user.id] },
    });
    assert.equal(commonGroup.status, 201);
    const allowedMessage = await api('POST', `/api/chats/${existingDm.body.chat.id}/messages`, {
      token: stranger.token,
      body: { text: 'Теперь мы общие контакты' },
    });
    assert.equal(allowedMessage.status, 201);

    await api('PATCH', '/api/settings', { token: member.token, body: { privacy: { messages: 'nobody' } } });
    const blockedAfterNobody = await api('POST', '/api/chats/dm', { token: stranger.token, body: { userId: member.user.id } });
    assert.equal(blockedAfterNobody.status, 403);
    const blockedMessage = await api('POST', `/api/chats/${existingDm.body.chat.id}/messages`, {
      token: stranger.token,
      body: { text: 'Не должно доставиться' },
    });
    assert.equal(blockedMessage.status, 403);

    const invalid = await api('PATCH', '/api/settings', { token: member.token, body: { theme: 'neon' } });
    assert.equal(invalid.status, 400);
  });

  test('приватность профиля и статуса применяется в API, поиске и real-time', async () => {
    const owner = await register('privacyowner');
    const stranger = await register('privacystranger');
    await api('PATCH', '/api/auth/profile', {
      token: owner.token,
      body: { bio: 'Закрытая информация', statusText: 'Скрытый статус' },
    });
    await api('PATCH', '/api/settings', {
      token: owner.token,
      body: { privacy: { profile: 'contacts', status: 'contacts' } },
    });

    const hiddenProfile = await api('GET', `/api/users/${owner.user.id}`, { token: stranger.token });
    assert.equal(hiddenProfile.status, 403);
    const hiddenSearch = await api('GET', `/api/search?q=${encodeURIComponent(owner.user.username)}&type=users`, { token: stranger.token });
    assert.equal(hiddenSearch.body.users.some((user) => user.id === owner.user.id), false);

    const shared = await api('POST', '/api/chats/group', {
      token: owner.token,
      body: { title: 'Общий контакт', memberIds: [stranger.user.id] },
    });
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    const sharedProfile = await api('GET', `/api/users/${owner.user.id}`, { token: stranger.token });
    assert.equal(sharedProfile.body.user.statusText, 'Скрытый статус');

    const ownerSocket = connect(owner.token);
    const strangerSocket = connect(stranger.token);
    try {
      await Promise.all([ownerSocket.open(), strangerSocket.open()]);
      strangerSocket.events.length = 0;
      const restricted = await api('PATCH', '/api/settings', {
        token: owner.token,
        body: { privacy: { status: 'nobody' } },
      });
      assert.equal(restricted.status, 200);
      const hiddenPresence = await strangerSocket.wait('presence');
      assert.equal(hiddenPresence.hidden, true);
      assert.equal(hiddenPresence.presence, null);
      assert.equal(hiddenPresence.lastSeen, null);

      const profile = await api('GET', `/api/users/${owner.user.id}`, { token: stranger.token });
      assert.equal(profile.status, 200);
      assert.equal(profile.body.user.bio, 'Закрытая информация');
      assert.equal(profile.body.user.statusText, '');
      assert.equal(profile.body.user.presence, null);
      assert.equal(profile.body.user.lastSeen, null);
      assert.equal(profile.body.user.online, null);

      const visibleSearch = await api('GET', `/api/search?q=${encodeURIComponent(owner.user.username)}&type=users`, { token: stranger.token });
      const result = visibleSearch.body.users.find((user) => user.id === owner.user.id);
      assert.ok(result);
      assert.equal(result.presence, null);
      assert.equal(result.online, null);
    } finally {
      ownerSocket.close();
      strangerSocket.close();
    }
  });

  test('настройка добавления в группы учитывается при приглашении и создании группы', async () => {
    const inviter = await register('groupinviter');
    const target = await register('grouptarget');
    const outsider = await register('groupoutsider');

    const shared = await api('POST', '/api/chats/group', {
      token: inviter.token,
      body: { title: 'Общий чат', memberIds: [target.user.id] },
    });
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    await api('PATCH', '/api/settings', {
      token: target.token,
      body: { privacy: { groups: 'contacts' } },
    });

    const forbiddenCreate = await api('POST', '/api/chats/group', {
      token: outsider.token,
      body: { title: 'Без общих контактов', memberIds: [target.user.id] },
    });
    assert.equal(forbiddenCreate.status, 403);

    const outsiderGroup = await api('POST', '/api/chats/group', {
      token: outsider.token,
      body: { title: 'Попытка приглашения' },
    });
    assert.equal(outsiderGroup.status, 201);
    const forbiddenAdd = await api('POST', `/api/chats/${outsiderGroup.body.chat.id}/members`, {
      token: outsider.token,
      body: { userIds: [target.user.id] },
    });
    assert.equal(forbiddenAdd.status, 400);

    const allowedGroup = await api('POST', '/api/chats/group', {
      token: inviter.token,
      body: { title: 'Приглашение контакта' },
    });
    assert.equal(allowedGroup.status, 201);
    const allowedAdd = await api('POST', `/api/chats/${allowedGroup.body.chat.id}/members`, {
      token: inviter.token,
      body: { userIds: [target.user.id] },
    });
    assert.equal(allowedAdd.status, 200, JSON.stringify(allowedAdd.body));
    assert.deepEqual(allowedAdd.body.added, [target.user.id]);
  });

  test('редактирование профиля и проверка занятости username', async () => {
    const patch = await api('PATCH', '/api/auth/profile', { token: owner.token, body: { name: 'Новое имя', bio: 'новое био', statusText: 'на связи' } });
    assert.equal(patch.body.user.name, 'Новое имя');
    const clash = await api('PATCH', '/api/auth/profile', { token: owner.token, body: { username: 'tester6' } });
    assert.equal(clash.status, 409);
    const check = await api('GET', '/api/auth/check?username=tester6', { token: owner.token });
    assert.equal(check.body.username.valid, true);
    assert.equal('taken' in check.body.username, false);
  });

  test('оформление профиля сохраняется на сервере и доступно согласно приватности профиля', async () => {
    const profileOwner = await register('themeowner');
    const viewer = await register('themeviewer');
    const effects = { theme: 'newyear', ring: 'rainbow', nameFx: 'gradient', dim: 4 };
    const saved = await api('PATCH', '/api/auth/profile', { token: profileOwner.token, body: { profileEffects: effects } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.user.profileEffects, effects);

    const visible = await api('GET', `/api/users/${profileOwner.user.id}`, { token: viewer.token });
    assert.equal(visible.status, 200);
    assert.deepEqual(visible.body.user.profileEffects, effects);

    const invalid = await api('PATCH', '/api/auth/profile', {
      token: profileOwner.token,
      body: { profileEffects: { ...effects, dim: 7 } },
    });
    assert.equal(invalid.status, 400);

    await api('PATCH', '/api/settings', {
      token: profileOwner.token,
      body: { privacy: { profile: 'nobody' } },
    });
    const hidden = await api('GET', `/api/users/${profileOwner.user.id}`, { token: viewer.token });
    assert.equal(hidden.status, 403);
  });

  test('баннер профиля сохраняется, возвращается публичному профилю и открывается по подписанной ссылке', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'profile-banner.png');
    form.append('kind', 'image');
    const uploaded = await api('POST', '/api/media', { token: owner.token, raw: form });
    assert.equal(uploaded.status, 201);

    const saved = await api('PATCH', '/api/auth/profile', {
      token: owner.token,
      body: { profileBannerMediaId: uploaded.body.media.id },
    });
    assert.equal(saved.status, 200);
    assert.match(saved.body.user.profileBanner, new RegExp(`/media/${uploaded.body.media.id}\\?`));

    const profile = await api('GET', `/api/users/${owner.user.id}`, { token: member.token });
    assert.equal(profile.status, 200);
    assert.match(profile.body.user.profileBanner, new RegExp(`/media/${uploaded.body.media.id}\\?`));
    const imageResponse = await fetch(new URL(profile.body.user.profileBanner, BASE));
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get('content-type'), /image\/png/);

    const cleared = await api('PATCH', '/api/auth/profile', {
      token: owner.token, body: { profileBannerMediaId: null },
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.user.profileBanner, null);
  });

  test('все данные сохраняются между «перезапусками» (проверка персистентности)', async () => {
    const before = await api('GET', '/api/chats', { token: owner.token });
    const again = await api('GET', '/api/chats', { token: owner.token });
    assert.deepEqual(before.body.chats.map((c) => c.id), again.body.chats.map((c) => c.id));
  });

});

describe('Синхронизация через /api/updates (fallback без WebSocket)', () => {
  test('журнал событий отдаёт изменения пользователю и его чатам', async () => {
    const a = await register('9');
    const b = await register('10');
    const dm = await api('POST', '/api/chats/dm', { token: a.token, body: { userId: b.user.id } });
    const since = (await api('GET', '/api/updates?since=0', { token: b.token })).body.lastId;
    await api('POST', `/api/chats/${dm.body.chat.id}/messages`, { token: a.token, body: { type: 'text', text: 'через журнал' } });
    const upd = await api('GET', `/api/updates?since=${since}`, { token: b.token });
    assert.ok(upd.body.events.some((e) => e.type === 'message.new' && e.payload.message.text === 'через журнал'));
  });
});

describe('Ошибки SMTP не имитируют отправку писем', () => {
  let proc; let dir; let port;
  before(async () => {
    port = 3713;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-mail-'));
    proc = await startServer({
      port,
      dataDir: dir,
      env: {
        NODE_ENV: 'production',
        EMAIL_TEST_MODE: '',
        EMAIL_SMTP_HOST: '',
        EMAIL_SMTP_USER: '',
        EMAIL_SMTP_PASS: '',
        EMAIL_FROM: '',
      },
    });
  });
  after(async () => {
    await stopServer(proc);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('сообщает об ошибке почты и не раскрывает коды или ссылки', async () => {
    const request = async (url, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const credentials = {
      email: 'smtp-failure@aurora.test',
      password: 'Passw0rdMail',
      name: 'Почта',
      username: 'smtpuser',
      bio: '',
      ...CONSENT,
    };
    const registration = await request('/api/auth/register', credentials);
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    assert.ok(registration.body.token);
    assert.equal(registration.body.user.emailVerified, false);
    assert.equal(registration.body.emailVerification.sent, false);
    assert.equal(registration.body.emailVerification.testCode, undefined);
    const login = await request('/api/auth/login', credentials);
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    const codeRequest = await fetch(`http://127.0.0.1:${port}/api/auth/email-verification/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${registration.body.token}` },
    });
    assert.equal(codeRequest.status, 503);
    const codeFailure = await codeRequest.json();
    assert.equal(codeFailure.error, 'Не удалось отправить письмо. Попробуйте ещё раз позже');
    assert.equal(codeFailure.testCode, undefined);
    const resetRequest = await request('/api/auth/forgot', { email: credentials.email });
    const unknownResetRequest = await request('/api/auth/forgot', { email: 'not-registered@aurora.test' });
    assert.equal(resetRequest.status, 202);
    assert.equal(resetRequest.body.message, unknownResetRequest.body.message);
    assert.equal(resetRequest.body.devResetToken, undefined);
    const resetDb = new Database(path.join(dir, 'aurora.db'));
    assert.equal(resetDb.prepare('SELECT COUNT(*) AS count FROM password_resets WHERE used = 0').get().count, 0);
    resetDb.close();
    const authorized = await fetch(`http://127.0.0.1:${port}/api/chats`, {
      headers: { Authorization: `Bearer ${login.body.token}` },
    });
    assert.equal(authorized.status, 200);

    await stopServer(proc);
    const database = new Database(path.join(dir, 'aurora.db'));
    database.exec('ALTER TABLE users DROP COLUMN email_verification_deadline_at');
    database.close();
    proc = await startServer({
      port,
      dataDir: dir,
      env: {
        NODE_ENV: 'production',
        EMAIL_SMTP_HOST: '',
        EMAIL_SMTP_USER: '',
        EMAIL_SMTP_PASS: '',
        EMAIL_FROM: '',
      },
    });
    const legacyLogin = await request('/api/auth/login', credentials);
    assert.equal(legacyLogin.status, 200, JSON.stringify(legacyLogin.body));
    assert.equal(legacyLogin.body.user.emailVerified, true);
  });
});

describe('Отказ тестового SMTP-мока', () => {
  let proc; let dir; let port;
  before(async () => {
    port = 3714;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-smtp-mock-'));
    proc = await startServer({
      port,
      dataDir: dir,
      env: { NODE_ENV: 'test', EMAIL_TEST_MODE: '1', EMAIL_TEST_FAIL: '1' },
    });
  });
  after(async () => {
    await stopServer(proc);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('ошибка отправки не возвращает код или одноразовую ссылку', async () => {
    const request = async (url, body, token = null) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const registration = await request('/api/auth/register', {
      email: 'mock-failure@aurora.test',
      password: 'Passw0rdMock',
      name: 'Почтовый тест',
      username: 'mockfailure',
      bio: '',
      ...CONSENT,
    });
    assert.equal(registration.status, 201);
    assert.equal(registration.body.emailVerification.sent, false);
    assert.equal(registration.body.emailVerification.testCode, undefined);

    const codeRequest = await request('/api/auth/email-verification/request', {}, registration.body.token);
    assert.equal(codeRequest.status, 503);
    assert.equal(codeRequest.body.error, 'Не удалось отправить письмо. Попробуйте ещё раз позже');
    assert.equal(codeRequest.body.testCode, undefined);

    const resetRequest = await request('/api/auth/forgot', { email: 'mock-failure@aurora.test' });
    assert.equal(resetRequest.status, 202);
    assert.equal(resetRequest.body.devResetToken, undefined);
    const db = new Database(path.join(dir, 'aurora.db'));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM password_resets WHERE used = 0').get().count, 0);
    db.close();
  });
});

describe('Защита от перебора (отдельный сервер с продовыми лимитами)', () => {
  let proc; let dir; let port;
  before(async () => {
    port = 3712;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-rate-'));
    proc = await startServer({ port, dataDir: dir });
  });
  after(async () => {
    await stopServer(proc);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('вход блокируется после серии неудачных попыток', async () => {
    let limited = false;
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@aurora.test', password: 'Passw0rd1' }),
      });
      if (res.status === 429) { limited = true; assert.ok(res.headers.get('retry-after')); break; }
    }
    assert.ok(limited, 'ожидался ответ 429 при переборе пароля');
    const resetGuess = await fetch(`http://127.0.0.1:${port}/api/auth/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'invalid-reset-token', password: 'SomeStrongPassw0rd' }),
    });
    assert.equal(resetGuess.status, 429, 'сброс пароля также ограничивает перебор токенов');
  });
});

describe('Безопасные production defaults', () => {
  let proc; let dir;
  const port = 3713;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-production-defaults-'));
    const setupServer = await startServer({
      port,
      dataDir: dir,
      env: { NODE_ENV: 'test', EMAIL_TEST_MODE: '1' },
    });
    const registration = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'production-cookie@aurora.test',
        password: 'Passw0rdProduction',
        name: 'Production',
        username: 'productioncookie',
        ...CONSENT,
      }),
    });
    assert.equal(registration.status, 201);
    await stopServer(setupServer);
    proc = await startServer({
      port,
      dataDir: dir,
      env: {
        NODE_ENV: 'production',
        ENABLE_DEMO_WALLET: '1',
        TRUST_PROXY_ADDRESSES: '127.0.0.1/32',
      },
    });
  });

  after(async () => {
    await stopServer(proc);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('production принудительно включает Secure для cookie и не включает YooKassa без реквизитов', async () => {
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'production-cookie@aurora.test', password: 'Passw0rdProduction' }),
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie') || '', /;\s*secure(?:;|$)/i);
    const session = await login.json();
    const catalog = await fetch(`http://127.0.0.1:${port}/api/commerce/catalog`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    const catalogBody = await catalog.json();
    assert.equal(catalogBody.demoWalletEnabled, undefined);
    assert.equal(catalogBody.paymentsEnabled, false);
    const purchase = await fetch(`http://127.0.0.1:${port}/api/commerce/wallet/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ packageId: 'aurora-100' }),
    });
    assert.equal(purchase.status, 503);
  });
});

test('migration обновляет стандартный платёжный каталог и сохраняет пользовательские товары', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-payment-catalog-'));
  const port = await availablePort();
  const database = new Database(path.join(dir, 'aurora.db'));
  database.exec('CREATE TABLE commerce_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  database.exec(`CREATE TABLE payment_orders (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    product_id TEXT NOT NULL,
    units INTEGER NOT NULL,
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'yookassa',
    provider_payment_id TEXT UNIQUE,
    confirmation_url TEXT,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'creating',
    provider_status TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    paid_at INTEGER,
    UNIQUE (user_id, idempotency_key)
  )`);
  database.prepare('INSERT INTO commerce_config (key, value) VALUES (?, ?)').run('balancePackages', JSON.stringify([
    { id: 'aurora-100', auroras: 100, price: 59, currency: 'RUB' },
    { id: 'aurora-500', auroras: 500, price: 399, currency: 'RUB' },
    { id: 'aurora-1000', auroras: 1000, price: 699, currency: 'RUB' },
    { id: 'aurora-2500', auroras: 2500, price: 1499, currency: 'RUB' },
    { id: 'aurora-5000', auroras: 5000, price: 2499, currency: 'RUB' },
    { id: 'aurora-10000', auroras: 10000, price: 4499, currency: 'RUB' },
    { id: 'aurora-custom', auroras: 77, price: 777, currency: 'RUB' },
  ]));
  database.prepare('INSERT INTO commerce_config (key, value) VALUES (?, ?)').run('premiumPlans', JSON.stringify([
    { id: 'premium-1m', months: 1, price: 299, currency: 'RUB' },
    { id: 'premium-3m', months: 3, price: 799, currency: 'RUB' },
    { id: 'premium-12m', months: 12, price: 2499, currency: 'RUB' },
  ]));
  database.close();

  let proc;
  try {
    proc = await startServer({ port, dataDir: dir, env: { NODE_ENV: 'test' } });
    const migrated = new Database(path.join(dir, 'aurora.db'));
    const packages = JSON.parse(migrated.prepare('SELECT value FROM commerce_config WHERE key = ?').get('balancePackages').value);
    const plans = JSON.parse(migrated.prepare('SELECT value FROM commerce_config WHERE key = ?').get('premiumPlans').value);
    const paymentOrderColumns = migrated.prepare('PRAGMA table_info(payment_orders)').all();
    const providerMode = paymentOrderColumns.find((column) => column.name === 'provider_mode');
    const receiptEmail = paymentOrderColumns.find((column) => column.name === 'receipt_email');
    migrated.close();
    assert.equal(providerMode?.dflt_value, "'test'");
    assert.equal(receiptEmail?.dflt_value, "''");
    assert.deepEqual(packages.map(({ id, price }) => [id, price]), [
      ['aurora-100', 10],
      ['aurora-500', 279],
      ['aurora-1000', 589],
      ['aurora-2500', 1399],
      ['aurora-custom', 777],
    ]);
    assert.deepEqual(plans.map(({ id, months, price }) => [id, months, price]), [
      ['premium-1m', 1, 99],
      ['premium-3m', 3, 289],
      ['premium-6m', 6, 589],
      ['premium-12m', 12, 1099],
    ]);
  } finally {
    await stopServer(proc);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
