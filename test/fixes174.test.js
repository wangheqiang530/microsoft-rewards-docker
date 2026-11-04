import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-fixes-174-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { default: rewardsApi, RewardsApi } = await import('../src/core/api.js');
const { default: networkClient } = await import('../src/network.js');
const { default: authManager } = await import('../src/core/auth.js');
const { TaskManager } = await import('../src/core/taskManager.js');
const { EpicManager } = await import('../src/core/epic.js');
const { default: browserManager } = await import('../src/core/browser.js');
const { firefoxSlotLock, browserSlotLock } = await import('../src/core/contextLock.js');
const {
  accountNamesLikelyMatch,
  isBalanceMismatch,
  toOptionalFiniteNumber
} = await import('../src/core/accountIdentity.js');
const { createServer } = await import('../src/web/server.js');
const { default: scheduler } = await import('../src/scheduler.js');

test('网页端余额与移动端余额明显不一致时判定为 Token 绑定错误', () => {
  assert.equal(isBalanceMismatch(450, 663), true);
  assert.equal(isBalanceMismatch(450, 470), false, '小幅同步延迟不应误报');
  assert.equal(isBalanceMismatch(0, 663), true, '新账号 0 分但 Token 属于有积分旧账号时必须识别');
  assert.equal(isBalanceMismatch(null, 663), false, '网页余额未读取时不能把 null 当成 0');
  assert.equal(toOptionalFiniteNumber(null), null);
  assert.equal(toOptionalFiniteNumber(undefined), null);
  assert.equal(toOptionalFiniteNumber(''), null);
  assert.equal(toOptionalFiniteNumber('418'), 418);
  assert.equal(accountNamesLikelyMatch('贺强 王', '贺强'), true);
  assert.equal(accountNamesLikelyMatch('贺强 王', '王 贺强'), true);
  assert.equal(accountNamesLikelyMatch('alice@example.com', 'alice@another.com'), true);
  assert.equal(accountNamesLikelyMatch('alice@example.com', '爱丽丝'), null);
  assert.equal(accountNamesLikelyMatch('alice', 'bob'), false);
});

test('网页余额缺失时移动端 Token 不能被误判为串号', async () => {
  const tm = new TaskManager();
  const origRefresh = authManager.refreshToken;
  const origMobile = rewardsApi.getMobileSnapshot;
  authManager.refreshToken = async () => true;
  rewardsApi.getMobileSnapshot = async () => ({ balance: 418, userName: '孝清' });
  try {
    const binding = await tm.checkMobileAccountBinding({
      id: 'acc_174_null_balance',
      name: '缺失余额测试',
      cookie: '_U=WEB; WLS=C=1&N=%E5%AD%9D%E6%B8%85'
    }, null);
    assert.equal(binding.tokenOk, true);
    assert.equal(binding.mismatch, false);
    assert.equal(binding.verified, true);
    assert.equal(binding.message, '');
  } finally {
    authManager.refreshToken = origRefresh;
    rewardsApi.getMobileSnapshot = origMobile;
  }
});

test('getBalance 优先使用网页 Cookie 余额，避免错误 Token 覆盖当前账号余额', async () => {
  const api = new RewardsApi();
  api.getWebBalance = async () => 450;
  api.getMobileBalance = async () => 663;
  assert.equal(await api.getBalance(), 450);
});

test('getAppCheckInStatus 优先使用 dashboard 的权威连签状态', async () => {
  const api = new RewardsApi();
  api.getRewardsInfo = async () => ({
    streaks: { bingapp: { completedDays: 6, currentDay: 6, isCurrentDayCompleted: true } }
  });
  const origRequest = networkClient.request;
  networkClient.request = async () => { throw new Error('不应回退到旧 /earn 解析'); };
  try {
    const status = await api.getAppCheckInStatus();
    assert.equal(status.completedDays, 6);
    assert.equal(status.isCurrentDayCompleted, true);
  } finally {
    networkClient.request = origRequest;
  }
});

test('移动端 Token 绑定校验会拦住错误账号，避免签到算到别人头上', async () => {
  const tm = new TaskManager();
  const origRefresh = authManager.refreshToken;
  const origMobile = rewardsApi.getMobileSnapshot;
  authManager.refreshToken = async () => true;
  rewardsApi.getMobileSnapshot = async () => ({ balance: 663, userName: '' });
  try {
    const binding = await tm.checkMobileAccountBinding({ id: 'acc_174', name: '测试账号' }, 450);
    assert.equal(binding.tokenOk, true);
    assert.equal(binding.mismatch, true);
    assert.match(binding.message, /其他账号/);
  } finally {
    authManager.refreshToken = origRefresh;
    rewardsApi.getMobileSnapshot = origMobile;
  }
});

test('Token 用户与 Cookie 用户不一致时，即使双方余额都是 0 也拒绝配对', async () => {
  const tm = new TaskManager();
  const origRefresh = authManager.refreshToken;
  const origMobile = rewardsApi.getMobileSnapshot;
  authManager.refreshToken = async () => true;
  rewardsApi.getMobileSnapshot = async () => ({ balance: 0, userName: 'Other User' });
  try {
    const binding = await tm.checkMobileAccountBinding({
      id: 'acc_174_name',
      name: '名称校验',
      cookie: '_U=WEB; WLS=C=1&N=Current%20User'
    }, 0);
    assert.equal(binding.tokenOk, true);
    assert.equal(binding.mismatch, true);
    assert.equal(binding.verified, false);
    assert.match(binding.message, /Token 用户/);
  } finally {
    authManager.refreshToken = origRefresh;
    rewardsApi.getMobileSnapshot = origMobile;
  }
});

test('配置向导换取 Token 使用草稿模式，不在取消前创建半成品账号', async () => {
  const origRequest = networkClient.request;
  networkClient.request = async () => ({
    access_token: 'DRAFT_ACCESS_TOKEN',
    refresh_token: 'DRAFT_REFRESH_TOKEN'
  });
  try {
    await authManager.exchangeCodeForToken('https://login.live.com/oauth20_desktop.srf?code=draft-174', 'acc_draft_174', {
      name: '草稿账号',
      order: 99,
      persist: false
    });
    assert.equal(configManager.findAccount('acc_draft_174'), null, '草稿阶段不能写入配置');
  } finally {
    networkClient.request = origRequest;
  }
});

test('Daily Set 卡片动作只执行 dailyset 卡片，不再误跑打孔卡', async () => {
  const accountId = 'acc_daily_set_174';
  configManager.upsertAccount({ id: accountId, name: 'DailySet 测试', cookie: 'MOCK_COOKIE' });
  const tm = new TaskManager();
  const origDiscover = rewardsApi.discoverCards;
  const origClaim = rewardsApi.claimCard;
  const origQuest = rewardsApi.getQuestPunchCards;
  const origDelay = rewardsApi.randomDelay;
  const origSync = tm.syncAccountOfficialStatus;
  const claimed = [];
  rewardsApi.discoverCards = async () => ([
    { offerId: 'Gamification_DailySet_1', hash: 'h1', points: 10, category: 'dailyset', title: 'Daily 1' },
    { offerId: 'Promo_1', hash: 'h2', points: 5, category: 'promo', title: 'Promo 1' }
  ]);
  rewardsApi.claimCard = async (card) => { claimed.push(card.offerId); return true; };
  rewardsApi.getQuestPunchCards = async () => { throw new Error('Daily Set 不应触碰打孔卡'); };
  rewardsApi.randomDelay = async () => {};
  tm.syncAccountOfficialStatus = async () => tm.ensureAccountStats(accountId);
  try {
    const result = await tm.runTaskAction(accountId, 'dailySet');
    assert.deepEqual(claimed, ['Gamification_DailySet_1']);
    assert.equal(result.hadFailure, false);
    assert.ok(result.details.some(x => x.includes('Daily 1')));
  } finally {
    rewardsApi.discoverCards = origDiscover;
    rewardsApi.claimCard = origClaim;
    rewardsApi.getQuestPunchCards = origQuest;
    rewardsApi.randomDelay = origDelay;
    tm.syncAccountOfficialStatus = origSync;
  }
});

test('DAPI Daily Set 三张 Child 领取成功后本地进度补到 3/3', async () => {
  const accountId = 'acc_daily_set_dapi_174';
  configManager.upsertAccount({ id: accountId, name: 'DAPI DailySet 测试', cookie: 'MOCK_COOKIE' });
  const tm = new TaskManager();
  const originals = {
    discoverCards: rewardsApi.discoverCards,
    claimCard: rewardsApi.claimCard,
    randomDelay: rewardsApi.randomDelay,
    sync: tm.syncAccountOfficialStatus
  };
  rewardsApi.discoverCards = async () => ([1, 2, 3].map(index => ({
    offerId: `Gamification_DailySet_ZHCN_20261104_Child${index}`,
    points: 10,
    kind: 'dapi_reward',
    category: 'dailyset',
    source: 'dapi-dailyset-fallback',
    title: `Daily ${index}`
  })));
  rewardsApi.claimCard = async () => {
    rewardsApi.lastCardReport = { dapi: true, points: 10, verified: true };
    return true;
  };
  rewardsApi.randomDelay = async () => {};
  tm.syncAccountOfficialStatus = async () => tm.ensureAccountStats(accountId);
  try {
    const result = await tm.runTaskAction(accountId, 'dailySet');
    const task = tm.ensureAccountStats(accountId).tasks.dailySet;
    assert.equal(result.hadFailure, false);
    assert.equal(task.progress, 3);
    assert.equal(task.max, 3);
    assert.equal(task.points, 30);
    assert.equal(task.done, true);
  } finally {
    rewardsApi.discoverCards = originals.discoverCards;
    rewardsApi.claimCard = originals.claimCard;
    rewardsApi.randomDelay = originals.randomDelay;
    tm.syncAccountOfficialStatus = originals.sync;
  }
});

test('DAPI Daily Set 返回成功但未加分时标记为部分完成', async () => {
  const accountId = 'acc_daily_set_unverified_174';
  configManager.upsertAccount({ id: accountId, name: 'DAPI DailySet 未确认测试', cookie: 'MOCK_COOKIE' });
  const tm = new TaskManager();
  const originals = {
    discoverCards: rewardsApi.discoverCards,
    claimCard: rewardsApi.claimCard,
    randomDelay: rewardsApi.randomDelay,
    sync: tm.syncAccountOfficialStatus
  };
  rewardsApi.discoverCards = async () => [{
    offerId: 'Gamification_DailySet_ZHCN_20261104_Child1',
    points: 10,
    kind: 'dapi_reward',
    category: 'dailyset',
    source: 'dapi-dailyset-fallback',
    title: 'Daily 1'
  }];
  rewardsApi.claimCard = async () => {
    rewardsApi.lastCardReport = { dapi: true, points: 0, verified: false };
    return true;
  };
  rewardsApi.randomDelay = async () => {};
  tm.syncAccountOfficialStatus = async () => tm.ensureAccountStats(accountId);
  try {
    const result = await tm.runTaskAction(accountId, 'dailySet');
    const task = tm.ensureAccountStats(accountId).tasks.dailySet;
    assert.equal(result.hadFailure, true);
    assert.match(result.message, /尚未确认积分/);
    assert.ok(result.details.some(x => x.includes('未确认')));
    assert.equal(task.progress, 0);
  } finally {
    rewardsApi.discoverCards = originals.discoverCards;
    rewardsApi.claimCard = originals.claimCard;
    rewardsApi.randomDelay = originals.randomDelay;
    tm.syncAccountOfficialStatus = originals.sync;
  }
});

test('Epic 登录窗口 close 卡死时仍会返回并释放 Firefox 锁', async () => {
  const em = new EpicManager();
  em.closeTimeoutMs = 30;
  const owner = `epic-test-close-${Date.now()}`;
  assert.equal(firefoxSlotLock.tryAcquire(owner), true);
  em.loginContext = { close: () => new Promise(() => {}) };
  em.loginAccountId = 'acc_close_timeout';
  em.loginSlotOwner = owner;

  const started = Date.now();
  await em.closeLoginWindow();
  assert.ok(Date.now() - started < 1000, 'close 卡死不能把停止请求一起拖死');
  assert.equal(em.loginContext, null);
  assert.equal(em.loginAccountId, null);
  assert.equal(firefoxSlotLock.isBusy(), false, '超时后必须释放 Firefox 资源锁');
});

test('Epic 会话导入兼容换行与 Tab 分隔的 Cookie', () => {
  const em = new EpicManager();
  const state = em.parseSessionInput('EPIC_BEARER\tabc123\nEPIC_SESSION\tdef456');
  assert.equal(state.cookies.length, 2);
  assert.equal(state.cookies[0].name, 'EPIC_BEARER');
  assert.equal(state.cookies[0].value, 'abc123');
});

test('Chromium 浏览器 close 卡死时仍会释放资源锁', async () => {
  browserManager.closeTimeoutMs = 30;
  const owner = `chromium-test-close-${Date.now()}`;
  assert.equal(browserSlotLock.tryAcquire(owner), true);
  browserManager.slotHeld = true;
  browserManager.slotOwner = owner;
  browserManager.context = { close: () => new Promise(() => {}) };
  browserManager.browser = { close: () => new Promise(() => {}) };

  const started = Date.now();
  await browserManager.closeBrowser();
  assert.ok(Date.now() - started < 1000, '浏览器 close 卡死不能永久占住资源锁');
  assert.equal(browserManager.slotHeld, false);
  assert.equal(browserSlotLock.isBusy(), false);
  assert.equal(browserManager.getStatus().status, 'idle');
});

test('Epic 周期预设只更新间隔，不会重置其他设置', async () => {
  configManager.update({
    epic: {
      enabled: true,
      autoClaimTime: '18:30',
      checkIntervalMin: 720,
      retryCount: 4,
      retryIntervalSec: 123,
      accountGapSec: 77
    }
  });
  const app = createServer();
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/epic/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkIntervalMin: 60 })
    }).then(r => r.json());
    assert.equal(res.success, true);
    assert.equal(res.data.checkIntervalMin, 60);
    assert.equal(res.data.autoClaimTime, '18:30');
    assert.equal(res.data.retryCount, 4);
    assert.equal(res.data.retryIntervalSec, 123);
    assert.equal(res.data.accountGapSec, 77);
  } finally {
    scheduler.stop();
    await new Promise(resolve => server.close(resolve));
  }
});

test('noVNC 内嵌页使用 /novnc/websockify 时也能正确转发', async () => {
  let proxiedPath = '';
  const dummy = http.createServer((req, res) => {
    proxiedPath = req.url;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise(resolve => dummy.listen(0, '127.0.0.1', resolve));
  const prevNovncPort = process.env.NOVNC_PORT;
  process.env.NOVNC_PORT = String(dummy.address().port);
  const app = createServer();
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/novnc/websockify?token=1`);
    assert.equal(res.status, 200);
    assert.equal(proxiedPath, '/websockify?token=1');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dummy.close(resolve));
    if (prevNovncPort === undefined) delete process.env.NOVNC_PORT;
    else process.env.NOVNC_PORT = prevNovncPort;
  }
});
