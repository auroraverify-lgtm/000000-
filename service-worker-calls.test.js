import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const callId = '123e4567-e89b-42d3-a456-426614174000';

function createWorker({ clients = [], openWindow = async (url) => url } = {}) {
  const listeners = new Map();
  const notifications = [];
  const self = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    skipWaiting: async () => {},
    clients: { matchAll: async () => clients, openWindow },
    registration: {
      showNotification: async (title, options) => notifications.push({
        title,
        options,
        closed: false,
        close() { this.closed = true; },
      }),
      getNotifications: async ({ tag }) => notifications.filter(({ options }) => options.tag === tag),
    },
    location: { origin: 'https://aurora.test' },
  };
  const source = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { self, URL, Date, console });
  return { listeners, notifications };
}

test('incoming call push shows caller details and answer/reject actions', async () => {
  const worker = createWorker();
  const waits = [];
  worker.listeners.get('push')({
    data: {
      json: () => ({
        type: 'incoming-call',
        title: 'Звонок от Артем',
        body: 'Входящий видеозвонок',
        callId,
        chatId: '18',
        url: '/#/chat/18',
      }),
    },
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  assert.equal(worker.notifications.length, 1);
  const { title, options } = worker.notifications[0];
  assert.equal(title, 'Звонок от Артем');
  assert.equal(options.requireInteraction, true);
  assert.deepEqual(Array.from(options.vibrate), [300, 100, 300, 100, 500]);
  assert.deepEqual(Array.from(options.actions, ({ action }) => action), ['answer', 'decline']);
  assert.equal(options.data.callId, callId);
});

test('answer action opens the existing chat with a validated call action', async () => {
  let openedUrl = '';
  const client = {
    url: 'https://aurora.test/',
    navigate: async (url) => { openedUrl = url; },
    focus: async () => {},
  };
  const worker = createWorker({ clients: [client] });
  const waits = [];
  worker.listeners.get('notificationclick')({
    action: 'answer',
    notification: {
      data: { type: 'incoming-call', callId, url: '/#/chat/18' },
      close() {},
    },
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  const url = new URL(openedUrl);
  assert.equal(url.hash, '#/chat/18');
  assert.equal(url.searchParams.get('callAction'), 'answer');
  assert.equal(url.searchParams.get('callId'), callId);
  assert.ok(Number(url.searchParams.get('callActionAt')) > 0);
});

test('invalid call identifiers cannot trigger notification actions', async () => {
  let openedUrl = '';
  const client = {
    url: 'https://aurora.test/',
    navigate: async (url) => { openedUrl = url; },
    focus: async () => {},
  };
  const worker = createWorker({ clients: [client] });
  const waits = [];
  worker.listeners.get('notificationclick')({
    action: 'answer',
    notification: {
      data: { type: 'incoming-call', callId: 'invalid', url: '/#/chat/18' },
      close() {},
    },
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  const url = new URL(openedUrl);
  assert.equal(url.searchParams.has('callAction'), false);
  assert.equal(url.searchParams.has('callId'), false);
});

test('notification action opens a new Aurora window if the existing one cannot navigate', async () => {
  let openedUrl = '';
  const worker = createWorker({
    clients: [{
      url: 'https://aurora.test/',
      navigate: async () => { throw new Error('closed window'); },
      focus: async () => {},
    }],
    openWindow: async (url) => { openedUrl = url; },
  });
  const waits = [];
  worker.listeners.get('notificationclick')({
    action: 'decline',
    notification: {
      data: { type: 'incoming-call', callId, url: '/#/chat/18' },
      close() {},
    },
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  const url = new URL(openedUrl);
  assert.equal(url.searchParams.get('callAction'), 'decline');
  assert.equal(url.searchParams.get('callId'), callId);
});

test('call-ended push closes the incoming call notification', async () => {
  const worker = createWorker();
  const waits = [];
  worker.listeners.get('push')({
    data: {
      json: () => ({
        type: 'incoming-call',
        callId,
        title: 'Входящий звонок',
      }),
    },
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);
  waits.length = 0;

  worker.listeners.get('push')({
    data: { json: () => ({ type: 'call-ended', callId }) },
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  assert.equal(worker.notifications.length, 1);
  assert.equal(worker.notifications[0].closed, true);
});
