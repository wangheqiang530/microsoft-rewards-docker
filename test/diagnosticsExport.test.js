import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-diagnostics-export-'));
fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
  accounts: [{
    id: 'acc_private',
    name: 'Private Account',
    cookie: '_U=PRIVATE_COOKIE',
    refreshToken: 'PRIVATE_REFRESH_TOKEN',
    enabled: true
  }],
  tasks: {
    sign: true,
    read: true,
    search: true,
    dailySet: true
  },
  network: {
    useProxy: false,
    proxies: []
  }
}, null, 2));

const now = new Date();
const pad = value => String(value).padStart(2, '0');
const logTime = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
fs.writeFileSync(path.join(tmpDir, 'app.log'), [
  `[${logTime}] 🔴 [Private Account] Cookie: _U=PRIVATE_COOKIE`,
  `[${logTime}] 🟡 [Private Account] 用户 private@example.com 请求失败，IP=203.0.113.99`,
  `[${logTime}] 🔍 [Private Account] 关键词: "Private search phrase"`
].join('\n'));

process.env.MSR_DATA_DIR = tmpDir;

const { createServer } = await import('../src/web/server.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('诊断日志接口返回 24 小时脱敏预览并禁止缓存', async (t) => {
  const app = createServer();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/logs/diagnostics`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /no-store/);

  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.data.windowHours, 24);
  assert.match(payload.data.content, /账号-1/);
  assert.match(payload.data.content, /最近 24 小时日志/);
  assert.doesNotMatch(payload.data.content, /Private Account|private@example\.com/);
  assert.doesNotMatch(payload.data.content, /PRIVATE_COOKIE|PRIVATE_REFRESH_TOKEN|203\.0\.113\.99|Private search phrase/);
});
