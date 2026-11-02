import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { attachLiveKitProxy } from '../server/livekit-proxy.js';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function expectUnauthorized(port, path) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket handshake did not finish'));
    }, 3000);
    socket.once('unexpected-response', (request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('LiveKit proxy forwards current and versioned signaling paths', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-livekit-proxy-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  const [{ attachRealtime }, { db }] = await Promise.all([
    import('../server/realtime.js'),
    import('../server/db.js'),
  ]);
  const forwardedPaths = [];
  const upstream = http.createServer();
  upstream.on('upgrade', (request, socket) => {
    forwardedPaths.push(request.url);
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  const upstreamPort = await listen(upstream);
  const previousPort = process.env.LIVEKIT_PROXY_PORT;
  process.env.LIVEKIT_PROXY_PORT = String(upstreamPort);

  const proxy = http.createServer();
  attachLiveKitProxy(proxy);
  const realtime = attachRealtime(proxy);
  const proxyPort = await listen(proxy);

  t.after(async () => {
    if (previousPort === undefined) delete process.env.LIVEKIT_PROXY_PORT;
    else process.env.LIVEKIT_PROXY_PORT = previousPort;
    realtime.close();
    await close(proxy);
    await close(upstream);
    db.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  assert.equal(await expectUnauthorized(proxyPort, '/rtc?access_token=test'), 401);
  assert.equal(await expectUnauthorized(proxyPort, '/rtc/v1?access_token=test'), 401);
  assert.deepEqual(forwardedPaths, ['/rtc?access_token=test', '/rtc/v1?access_token=test']);
});
