import http from 'node:http';

export function attachLiveKitProxy(server) {
  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/rtc' && url.pathname !== '/rtc/v1') return;

    const port = Number(process.env.LIVEKIT_PROXY_PORT || 7880);
    const upstream = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    });
    upstream.on('upgrade', (response, livekitSocket, livekitHead) => {
      socket.write(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n`);
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
      }
      socket.write('\r\n');
      if (livekitHead.length) socket.write(livekitHead);
      if (head.length) livekitSocket.write(head);
      livekitSocket.pipe(socket);
      socket.pipe(livekitSocket);
      livekitSocket.on('error', () => socket.destroy());
      socket.on('error', () => livekitSocket.destroy());
      socket.on('close', () => livekitSocket.destroy());
    });
    upstream.on('response', (response) => {
      socket.write(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n`);
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
      }
      socket.write('\r\n');
      response.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    upstream.end(head);
  });
}
