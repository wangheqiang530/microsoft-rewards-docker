import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-notify-proxy-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { default: networkClient } = await import('../src/network.js');
const { default: notifier } = await import('../src/core/notifier.js');
const { Notifier } = await import('../src/core/notifier.js');
const { createServer } = await import('../src/web/server.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('消息推送代理独立保存，并且禁用时不会回退到账号或全局代理', () => {
  configManager.setNetworkProxyConfig({
    proxies: [{ id: 'proxy_rewards', name: '积分代理', url: 'http://127.0.0.1:18080' }],
    defaultProxyId: 'proxy_rewards',
    useProxy: true,
    lockRegion: true
  });
  configManager.update({
    notify: {
      proxy: {
        url: 'socks5h://notify-user:notify-pass@127.0.0.1:1080',
        channels: { telegram: true, bark: false }
      }
    }
  });
  networkClient.setActiveProxyContext({
    mode: 'proxy',
    proxyId: 'proxy_rewards',
    proxyName: '积分代理',
    proxyUrl: 'http://127.0.0.1:18080',
    missing: false
  });

  const notifier = new Notifier();
  const telegramProxy = notifier.getNotificationProxyOptions('telegram');
  const barkProxy = notifier.getNotificationProxyOptions('bark');

  assert.deepEqual(telegramProxy, {
    useProxy: true,
    proxyUrl: 'socks5h://notify-user:notify-pass@127.0.0.1:1080',
    ignoreAccountProxy: true
  });
  assert.deepEqual(barkProxy, {
    useProxy: false,
    proxyUrl: '',
    ignoreAccountProxy: true
  });
  assert.equal(networkClient.getEffectiveProxyUrl(telegramProxy), telegramProxy.proxyUrl);
  assert.equal(networkClient.getEffectiveProxyUrl(barkProxy), '');
});

test('消息推送中的 socks5 地址会自动改为远端 DNS 的 socks5h', () => {
  configManager.update({
    notify: {
      proxy: {
        url: 'socks5://127.0.0.1:1080',
        channels: { telegram: true }
      }
    }
  });
  assert.equal(
    configManager.get().notify.proxy.url,
    'socks5h://127.0.0.1:1080'
  );
  assert.equal(
    new Notifier().getNotificationProxyOptions('telegram').proxyUrl,
    'socks5h://127.0.0.1:1080'
  );
});

test('已勾选推送代理但地址为空时拒绝保存配置', () => {
  assert.throws(
    () => configManager.update({
      notify: {
        proxy: {
          url: '',
          channels: { qqbot: true }
        }
      }
    }),
    /已启用消息推送代理，请先填写专用代理地址/
  );
});

test('全部通知渠道测试都会显式使用当前勾选的专用代理', async () => {
  const notifier = new Notifier();
  const originalRequest = networkClient.request;
  const requests = [];
  networkClient.request = async options => {
    requests.push(options);
    if (options.url === 'https://bots.qq.com/app/getAppAccessToken') {
      return { access_token: 'notify-token', expires_in: 7200 };
    }
    return {};
  };

  const proxy = {
    url: 'http://127.0.0.1:18888',
    channels: {
      wework: true,
      dingding: true,
      feishu: true,
      bark: true,
      pushme: true,
      telegram: true,
      qqbot: true
    }
  };
  try {
    await notifier.testChannel('wework', 'wework-key', proxy);
    await notifier.testChannel('dingding', 'dingding-token', proxy);
    await notifier.testChannel('feishu', 'feishu-key', proxy);
    await notifier.testChannel('bark', 'bark-key', proxy);
    await notifier.testChannel('pushme', 'pushme-key', proxy);
    await notifier.testChannel('telegram', JSON.stringify({
      botToken: '123:abc',
      chatId: '456'
    }), proxy);
    await notifier.testChannel('qqbot', JSON.stringify({
      appId: 'app-id',
      clientSecret: 'app-secret',
      openId: 'user-open-id'
    }), proxy);

    assert.equal(requests.length, 8);
    assert.ok(requests.every(item => item.useProxy === true));
    assert.ok(requests.every(item => item.proxyUrl === 'http://127.0.0.1:18888'));
    assert.ok(requests.every(item => item.ignoreAccountProxy === true));
  } finally {
    networkClient.request = originalRequest;
  }
});

test('正式消息发送使用保存后的逐渠道代理设置', async () => {
  configManager.update({
    notify: {
      proxy: {
        url: 'http://127.0.0.1:18889',
        channels: { telegram: true }
      },
      telegram: {
        botToken: 'saved-token',
        chatId: 'saved-chat'
      }
    }
  });
  const notifier = new Notifier();
  const originalRequest = networkClient.request;
  let seenOptions = null;
  networkClient.request = async options => {
    seenOptions = options;
    return {};
  };
  try {
    await notifier.send('任务完成', '今日积分已完成');
    assert.equal(seenOptions?.url, 'https://api.telegram.org/botsaved-token/sendMessage');
    assert.equal(seenOptions?.useProxy, true);
    assert.equal(seenOptions?.proxyUrl, 'http://127.0.0.1:18889');
    assert.equal(seenOptions?.ignoreAccountProxy, true);
    assert.equal(seenOptions?.data?.parse_mode, undefined);
    assert.match(seenOptions?.data?.text || '', /任务完成[\s\S]*今日积分已完成/);
  } finally {
    networkClient.request = originalRequest;
  }
});

test('通知测试接口会透传当前表单中的推送代理设置', async t => {
  const originalTestChannel = notifier.testChannel;
  let seen = null;
  notifier.testChannel = async (channel, value, proxy) => {
    seen = { channel, value, proxy };
    return true;
  };
  const app = createServer();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    notifier.testChannel = originalTestChannel;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });

  const proxy = {
    url: 'socks5h://127.0.0.1:1080',
    channels: { bark: true }
  };
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/notify/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'bark', value: 'device-key', proxy })
  }).then(res => res.json());

  assert.equal(response.success, true);
  assert.deepEqual(seen, {
    channel: 'bark',
    value: 'device-key',
    proxy
  });
});

test('Telegram 错误会保留 API 返回的具体 description', async () => {
  const notifier = new Notifier();
  const originalRequest = networkClient.request;
  const error = new Error('HTTP 400');
  error.response = {
    status: 400,
    data: JSON.stringify({ description: 'Bad Request: chat not found' })
  };
  networkClient.request = async () => { throw error; };
  try {
    await assert.rejects(
      notifier.sendTelegram('123:abc', '456', '标题', '正文'),
      /Bad Request: chat not found \(HTTP 400\)/
    );
  } finally {
    networkClient.request = originalRequest;
  }
});

test('Telegram 只读检测在 Token 无效时也会返回具体 description', async () => {
  const notifier = new Notifier();
  const originalRequest = networkClient.request;
  const error = new Error('HTTP 401');
  error.response = {
    status: 401,
    data: JSON.stringify({ description: 'Unauthorized' })
  };
  networkClient.request = async () => { throw error; };
  try {
    await assert.rejects(
      notifier.checkTelegram('123:invalid', '456', {
        url: '',
        channels: { telegram: false }
      }),
      /Unauthorized \(HTTP 401\)/
    );
  } finally {
    networkClient.request = originalRequest;
  }
});

test('Telegram 连接检测为只读请求并校验 Chat ID', async () => {
  configManager.update({
    notify: {
      proxy: {
        url: 'socks5://127.0.0.1:1080',
        channels: { telegram: true }
      }
    }
  });
  const notifier = new Notifier();
  const originalRequest = networkClient.request;
  const calls = [];
  networkClient.request = async options => {
    calls.push(options);
    if (options.url.endsWith('/getMe')) {
      return { ok: true, result: { username: 'test_bot', first_name: 'Test' } };
    }
    if (options.url.includes('/getChat?')) {
      return { ok: true, result: { type: 'private' } };
    }
    throw new Error('unexpected');
  };
  try {
    const result = await notifier.checkTelegram('123:abc', '456', {
      url: 'socks5://127.0.0.1:1080',
      channels: { telegram: true }
    });
    assert.equal(result.botUsername, 'test_bot');
    assert.equal(result.chatValid, true);
    assert.equal(result.chatType, 'private');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.proxyUrl === 'socks5h://127.0.0.1:1080'));
    assert.ok(calls.every(call => call.ignoreAccountProxy === true));
  } finally {
    networkClient.request = originalRequest;
  }
});
