import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-app-promotions-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { default: rewardsApi } = await import('../src/core/api.js');
const { TaskManager } = await import('../src/core/taskManager.js');
const { default: networkClient } = await import('../src/network.js');
const { default: authManager } = await import('../src/core/auth.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('移动端三张 sapphire 每日活动会逐项上报并回读完成状态', async () => {
  const accountId = 'acc_app_promotions';
  configManager.upsertAccount({
    id: accountId,
    name: 'App 活动测试',
    cookie: 'MOCK_COOKIE;_U=mock_user',
    refreshToken: 'MOCK_REFRESH'
  });
  const account = configManager.findAccount(accountId);
  const tm = new TaskManager();

  const pending = [
    { name: 'Upcoming live music events', offerId: 'Sapphire_1', type: 'sapphire', complete: false, progress: 0, max: 10 },
    { name: 'New York City Fall Big Apple', offerId: 'Sapphire_2', type: 'sapphire', complete: false, progress: 0, max: 10 },
    { name: 'Dwarf planets explained', offerId: 'Sapphire_3', type: 'sapphire', complete: false, progress: 0, max: 10 }
  ];
  const completed = pending.map(item => ({ ...item, complete: true, progress: 10 }));
  const originals = {
    getAppPromotions: rewardsApi.getAppPromotions,
    claimAppPromotion: rewardsApi.claimAppPromotion,
    randomDelay: rewardsApi.randomDelay
  };
  let readCount = 0;
  const claimed = [];
  rewardsApi.getAppPromotions = async () => (readCount++ === 0 ? pending : completed);
  rewardsApi.claimAppPromotion = async promotion => {
    claimed.push(promotion.offerId);
    return { success: true, verified: true, points: 10 };
  };
  rewardsApi.randomDelay = async () => {};

  try {
    const result = await tm.runPendingAppPromotions(account);
    assert.equal(result.attempted, 3);
    assert.equal(result.completed, 3);
    assert.equal(result.remaining, 0);
    assert.deepEqual(claimed, ['Sapphire_1', 'Sapphire_2', 'Sapphire_3']);

    const task = tm.ensureAccountStats(accountId).tasks.appPromotions;
    assert.equal(task.progress, 3);
    assert.equal(task.max, 3);
    assert.equal(task.points, 30);
    assert.equal(task.done, true);
  } finally {
    rewardsApi.getAppPromotions = originals.getAppPromotions;
    rewardsApi.claimAppPromotion = originals.claimAppPromotion;
    rewardsApi.randomDelay = originals.randomDelay;
  }
});

test('App 每日活动通过 DAPI type 101 上报并回读确认', async () => {
  const originals = {
    request: networkClient.request,
    getAccessToken: authManager.getAccessToken,
    delay: rewardsApi.delay
  };
  let dashboardReads = 0;
  let posted = null;
  authManager.getAccessToken = () => 'MOCK_TOKEN';
  rewardsApi.currentAccountId = 'acc_app_promotions';
  rewardsApi.delay = async () => {};
  networkClient.request = async options => {
    if (options.method === 'POST') {
      posted = JSON.parse(options.data);
      return {
        response: {
          balance: 120,
          activity: { p: 10 }
        }
      };
    }
    dashboardReads++;
    return {
      response: {
        balance: 110,
        promotions: [{
          name: 'Upcoming live music events',
          attributes: {
            offerid: 'Sapphire_1',
            type: 'sapphire',
            pointprogress: dashboardReads > 1 ? '10' : '0',
            pointmax: '10',
            complete: dashboardReads > 1 ? 'true' : 'false'
          }
        }]
      }
    };
  };

  try {
    const result = await rewardsApi.claimAppPromotion({
      name: 'Upcoming live music events',
      offerId: 'Sapphire_1',
      type: 'sapphire',
      progress: 0,
      max: 10,
      complete: false
    });
    assert.equal(posted.type, 101);
    assert.equal(posted.channel, 'SAAndroid');
    assert.equal(posted.attributes.offerid, 'Sapphire_1');
    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.equal(result.points, 10);
    assert.equal(dashboardReads, 1);
  } finally {
    networkClient.request = originals.request;
    authManager.getAccessToken = originals.getAccessToken;
    rewardsApi.delay = originals.delay;
  }
});

test('Web 缺少连签模型时使用 DAPI 签到状态兜底', async () => {
  const original = rewardsApi.getAppPromotions;
  rewardsApi.getAppPromotions = async () => [{
    name: 'Daily Check-In',
    offerId: 'Gamification_Sapphire_DailyCheckIn',
    type: 'checkin',
    complete: false,
    progress: 2,
    lastUpdated: new Date().toISOString()
  }];
  try {
    const status = await rewardsApi.getAppCheckInStatus({ allowWebFallback: false });
    assert.equal(status.isCurrentDayCompleted, true);
    assert.equal(status.source, 'dapi');
  } finally {
    rewardsApi.getAppPromotions = original;
  }
});

test('Web 连签状态为 false 时仍允许 DAPI 的已完成状态纠正', async () => {
  const originals = {
    getRewardsInfo: rewardsApi.getRewardsInfo,
    getAppPromotions: rewardsApi.getAppPromotions,
    request: networkClient.request
  };
  rewardsApi.getRewardsInfo = async () => ({
    streaks: {
      bingapp: {
        isCurrentDayCompleted: false,
        completedDays: 0,
        currentDay: 0
      }
    }
  });
  rewardsApi.getAppPromotions = async () => [{
    name: 'Daily Check-In',
    offerId: 'Gamification_Sapphire_DailyCheckIn',
    type: 'checkin',
    complete: true,
    progress: 3,
    lastUpdated: new Date().toISOString()
  }];
  networkClient.request = async () => '';
  try {
    const status = await rewardsApi.getAppCheckInStatus();
    assert.equal(status.isCurrentDayCompleted, true);
    assert.equal(status.source, 'dapi');
  } finally {
    rewardsApi.getRewardsInfo = originals.getRewardsInfo;
    rewardsApi.getAppPromotions = originals.getAppPromotions;
    networkClient.request = originals.request;
  }
});
