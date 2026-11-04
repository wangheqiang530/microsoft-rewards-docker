import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-proxy-config-'));
fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
  accounts: [{
    id: 'legacy_acc',
    name: '旧账号',
    cookie: '_U=LEGACY',
    enabled: true
  }],
  network: {
    useProxy: true,
    proxyUrl: '127.0.0.1:7890',
    lockRegion: true
  }
}, null, 2));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { default: rewardsApi } = await import('../src/core/api.js');
const { default: authManager } = await import('../src/core/auth.js');
const { default: networkClient } = await import('../src/network.js');
const {
  normalizeNotificationProxyUrl,
  normalizeProxyUrl,
  toBrowserProxy
} = await import('../src/core/proxy.js');
const { createServer: createApp } = await import('../src/web/server.js');
const { resolveLoginProxy } = await import('../src/core/microsoftLoginWindow.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('旧版单代理配置会迁移为默认代理节点', () => {
  const network = configManager.get().network;
  assert.equal(network.proxies.length, 1);
  assert.equal(network.proxies[0].id, 'proxy_legacy');
  assert.equal(network.proxies[0].url, 'http://127.0.0.1:7890');
  assert.equal(network.defaultProxyId, 'proxy_legacy');
  assert.equal(network.proxyUrl, 'http://127.0.0.1:7890');
  assert.equal(configManager.findAccount('legacy_acc').proxyMode, 'direct');
});

test('代理 URL 与浏览器代理参数会规范化', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:1080'), 'http://127.0.0.1:1080');
  assert.equal(normalizeProxyUrl('socks5h://user:pass@127.0.0.1:1080'), 'socks5h://user:pass@127.0.0.1:1080');
  assert.deepEqual(toBrowserProxy('socks5h://user:pass@127.0.0.1:1080'), {
    server: 'socks5://127.0.0.1:1080',
    username: 'user',
    password: 'pass'
  });
  assert.throws(() => normalizeProxyUrl('ftp://127.0.0.1:21'), /仅支持/);
  assert.equal(
    normalizeNotificationProxyUrl('socks5://127.0.0.1:1080'),
    'socks5h://127.0.0.1:1080'
  );
  assert.equal(
    normalizeProxyUrl('socks5://127.0.0.1:1080'),
    'socks5://127.0.0.1:1080'
  );
});

test('账号可独立选择跟随全局、直连或指定代理', () => {
  configManager.setNetworkProxyConfig({
    proxies: [
      { id: 'proxy_sh', name: '上海', url: 'http://127.0.0.1:7890' },
      { id: 'proxy_gz', name: '广州', url: 'socks5://127.0.0.1:1080' }
    ],
    defaultProxyId: 'proxy_sh',
    useProxy: true,
    lockRegion: true
  });
  configManager.update({
    accounts: [
      { id: 'acc_inherit', name: '跟随', proxyMode: 'inherit' },
      { id: 'acc_direct', name: '直连', proxyMode: 'direct' },
      { id: 'acc_proxy', name: '指定', proxyMode: 'proxy', proxyId: 'proxy_gz' }
    ]
  });

  assert.equal(configManager.getEffectiveProxy(configManager.findAccount('acc_inherit')).id, 'proxy_sh');
  assert.equal(configManager.getEffectiveProxy(configManager.findAccount('acc_direct')), null);
  assert.equal(configManager.getEffectiveProxy(configManager.findAccount('acc_proxy')).id, 'proxy_gz');

  rewardsApi.setCurrentAccount(configManager.findAccount('acc_proxy'));
  assert.equal(networkClient.getActiveProxyContext().proxyId, 'proxy_gz');
  rewardsApi.setCurrentAccount(configManager.findAccount('acc_direct'));
  assert.equal(networkClient.getActiveProxyContext().mode, 'direct');
});

test('VNC 登录浏览器会继承账号代理，并允许显式切换直连', () => {
  const proxied = configManager.findAccount('acc_proxy');
  const direct = resolveLoginProxy({}, proxied);
  assert.equal(direct.mode, 'proxy');
  assert.equal(direct.proxyId, 'proxy_gz');
  assert.match(direct.label, /广州/);

  const override = resolveLoginProxy({ mode: 'direct' }, proxied);
  assert.equal(override.mode, 'direct');
  assert.equal(override.proxyUrl, '');
});

test('未显式配置代理策略时默认直连', () => {
  assert.equal(configManager.getAccountProxyMode({ id: 'default_direct' }), 'direct');
});

test('候选凭据请求可临时覆盖账号代理上下文', () => {
  configManager.setNetworkProxyConfig({
    proxies: [
      { id: 'proxy_candidate', name: '候选节点', url: 'socks5h://127.0.0.1:1080' }
    ],
    defaultProxyId: 'proxy_candidate',
    useProxy: true,
    lockRegion: true
  });
  rewardsApi.setCurrentAccount({ id: 'candidate', name: '候选', cookie: '', proxyMode: 'inherit' });

  networkClient.setActiveProxySelection({ mode: 'direct' });
  assert.equal(networkClient.getEffectiveProxyUrl(), '');
  networkClient.setActiveProxySelection({ mode: 'proxy', proxyId: 'proxy_candidate' });
  assert.equal(networkClient.getEffectiveProxyUrl(), 'socks5h://127.0.0.1:1080');
  networkClient.setActiveProxySelection({ mode: 'proxy', url: 'http://127.0.0.1:18888' });
  assert.equal(networkClient.getEffectiveProxyUrl(), 'http://127.0.0.1:18888');
});

test('代理测试接口只测试候选节点，不修改已保存的默认代理', async (t) => {
  const originalIPDetails = rewardsApi.getIPInfoDetails;
  const originalCheckRegion = rewardsApi.checkRegion;
  rewardsApi.getIPInfoDetails = async (options) => ({
    ip: '198.51.100.77',
    location: '中国 上海 测试代理',
    formatted: `出口 IP: 198.51.100.77 | 归属地: 中国 上海 测试代理 | ${options.proxyUrl}`
  });
  rewardsApi.checkRegion = async () => true;

  const app = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    rewardsApi.getIPInfoDetails = originalIPDetails;
    rewardsApi.checkRegion = originalCheckRegion;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });

  const port = server.address().port;
  const before = JSON.stringify(configManager.get().network);
  const response = await fetch(`http://127.0.0.1:${port}/api/proxy/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proxyUrl: 'http://127.0.0.1:18888',
      useProxy: true
    })
  }).then(res => res.json());

  assert.equal(response.success, true);
  assert.equal(response.ip, '198.51.100.77');
  assert.equal(response.location, '中国 上海 测试代理');
  assert.equal(JSON.stringify(configManager.get().network), before);

  const saveResponse = await fetch(`http://127.0.0.1:${port}/api/network/proxies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proxies: [
        { id: 'proxy_new_1', name: '节点一', url: 'http://127.0.0.1:18888' },
        { id: 'proxy_new_2', name: '节点二', url: 'socks5://127.0.0.1:18889' }
      ],
      defaultProxyId: 'proxy_new_2',
      useProxy: true,
      lockRegion: true
    })
  }).then(res => res.json());

  assert.equal(saveResponse.success, true);
  assert.equal(saveResponse.data.network.proxies.length, 2);
  assert.equal(saveResponse.data.network.defaultProxyId, 'proxy_new_2');
});

test('Cookie 测试、Token 换取和新增账号会先使用选定代理', async (t) => {
  configManager.setNetworkProxyConfig({
    proxies: [
      { id: 'proxy_session', name: '会话节点', url: 'socks5h://127.0.0.1:1080' }
    ],
    defaultProxyId: 'proxy_session',
    useProxy: true,
    lockRegion: true
  });
  const seen = [];
  const originalCheckCookie = authManager.checkCookieStatus;
  const originalExchange = authManager.exchangeCodeForToken;
  authManager.checkCookieStatus = async () => {
    seen.push({ type: 'cookie', context: networkClient.getActiveProxyContext() });
    return { valid: true, message: 'ok' };
  };
  authManager.exchangeCodeForToken = async (urlOrCode, accountId) => {
    seen.push({ type: 'token', accountId, context: networkClient.getActiveProxyContext() });
    return {
      success: true,
      accountId,
      accessToken: 'mock_access',
      refreshToken: 'mock_refresh'
    };
  };

  const app = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    authManager.checkCookieStatus = originalCheckCookie;
    authManager.exchangeCodeForToken = originalExchange;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });
  const port = server.address().port;
  const post = (url, body) => fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(res => res.json());

  const cookieResponse = await post('/api/auth/test-cookie', {
    cookie: '_U=CANDIDATE',
    accountId: 'draft_cookie_account',
    proxy: { mode: 'proxy', proxyId: 'proxy_session' }
  });
  assert.equal(cookieResponse.success, true);

  const tokenResponse = await post('/api/auth/exchange-code', {
    urlOrCode: 'https://login.live.com/oauth20_desktop.srf?code=MOCK',
    accountId: 'draft_token_account',
    draft: true,
    proxy: { mode: 'proxy', proxyId: 'proxy_session' }
  });
  assert.equal(tokenResponse.success, true);

  const accountResponse = await post('/api/accounts', {
    id: 'acc_add_with_proxy',
    name: '新增代理账号',
    cookie: '_U=ADD',
    authCodeUrl: 'https://login.live.com/oauth20_desktop.srf?code=MOCK_ADD',
    proxyMode: 'proxy',
    proxyId: 'proxy_session'
  });
  assert.equal(accountResponse.success, true);
  assert.equal(accountResponse.tokenExchanged, true);

  assert.equal(seen.length, 3);
  assert.ok(seen.every(item => item.context?.proxyUrl === 'socks5h://127.0.0.1:1080'));
  assert.equal(configManager.findAccount('acc_add_with_proxy').proxyId, 'proxy_session');
});
