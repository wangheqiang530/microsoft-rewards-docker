import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { endJson, startJsonHeartbeat } from '../src/web/jsonHeartbeat.js';

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

test('长任务心跳返回合法 JSON 空白，最终响应仍可正常解析', async () => {
  const chunks = [];
  const { server, url } = await startServer((req, res) => {
    const stop = startJsonHeartbeat(res, { initialDelayMs: 20, intervalMs: 20 });
    setTimeout(() => {
      stop();
      endJson(res, { success: true, data: { message: 'done' } });
    }, 90);
  });

  try {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    const body = Buffer.concat(chunks).toString('utf8');
    // 前导空白只有在最终 JSON 之前已真正刷出时才会出现在响应体中。
    assert.ok(body.startsWith(' '));
    assert.deepEqual(JSON.parse(body), {
      success: true,
      data: { message: 'done' }
    });
  } finally {
    await closeServer(server);
  }
});

test('任务应先发送心跳，再写最终 JSON', async () => {
  let stop = null;
  const { server, url } = await startServer((req, res) => {
    stop = startJsonHeartbeat(res, { initialDelayMs: 10, intervalMs: 10 });
    setTimeout(() => {
      stop();
      endJson(res, { success: false, message: 'failed after start' });
    }, 40);
  });

  try {
    const response = await fetch(url);
    const payload = JSON.parse(await response.text());
    assert.equal(payload.success, false);
    assert.equal(payload.message, 'failed after start');
  } finally {
    stop?.();
    await closeServer(server);
  }
});
