import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-mobile-checkin-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { default: rewardsApi } = await import('../src/core/api.js');
const { TaskManager } = await import('../src/core/taskManager.js');

test('移动端未完成时只执行 App 签到，不再调用电脑端签到', async () => {
  const accountId = 'acc_mobile_checkin';
  configManager.upsertAccount({
    id: accountId,
    name: '移动端签到测试',
    cookie: 'MOCK_COOKIE;_U=mock_user'
  });

  const tm = new TaskManager();
  tm.getLiveAccountBlockReason = async () => '';
  tm.checkMobileAccountBinding = async () => ({ mismatch: false, tokenOk: true, message: '' });
  tm.syncAccountOfficialStatus = async () => tm.ensureAccountStats(accountId);

  const originals = {
    getRewardsInfo: rewardsApi.getRewardsInfo,
    signApp: rewardsApi.signApp,
    signPC: rewardsApi.signPC
  };
  let appCalls = 0;
  let pcCalls = 0;
  let infoCalls = 0;

  rewardsApi.getRewardsInfo = async () => {
    infoCalls++;
    return {
      balance: 100,
      streaks: {
        bingapp: {
          completedDays: infoCalls > 1 ? 4 : 3,
          isCurrentDayCompleted: infoCalls > 1
        }
      }
    };
  };
  rewardsApi.signApp = async () => {
    appCalls++;
    return { points: 10, balance: 100 };
  };
  rewardsApi.signPC = async () => {
    pcCalls++;
    return 10;
  };

  try {
    const result = await tm.runTaskAction(accountId, 'sign');
    assert.equal(appCalls, 1);
    assert.equal(pcCalls, 0, '移动端签到任务不应再触碰电脑端签到');
    assert.equal(result.hadFailure, false);
    assert.ok(result.details.some(line => line.includes('App 端签到成功')));
  } finally {
    rewardsApi.getRewardsInfo = originals.getRewardsInfo;
    rewardsApi.signApp = originals.signApp;
    rewardsApi.signPC = originals.signPC;
  }
});

test('官网确认移动端今日已完成时直接返回 alreadyDone', async () => {
  const accountId = 'acc_mobile_done';
  configManager.upsertAccount({
    id: accountId,
    name: '移动端已完成测试',
    cookie: 'MOCK_COOKIE;_U=mock_user'
  });

  const tm = new TaskManager();
  tm.getLiveAccountBlockReason = async () => '';
  tm.syncAccountOfficialStatus = async () => tm.ensureAccountStats(accountId);
  tm.updateTask('sign', { progress: 1, max: 1, done: true }, accountId);

  const originals = {
    getRewardsInfo: rewardsApi.getRewardsInfo,
    signApp: rewardsApi.signApp,
    signPC: rewardsApi.signPC
  };
  let calls = 0;
  rewardsApi.getRewardsInfo = async () => ({
    streaks: {
      bingapp: {
        completedDays: 4,
        isCurrentDayCompleted: true
      }
    }
  });
  rewardsApi.signApp = async () => { calls++; return {}; };
  rewardsApi.signPC = async () => { calls++; return 10; };

  try {
    const result = await tm.runTaskAction(accountId, 'sign');
    assert.equal(result.alreadyDone, true);
    assert.equal(calls, 0);
    assert.match(result.message, /今日已签到/);
  } finally {
    rewardsApi.getRewardsInfo = originals.getRewardsInfo;
    rewardsApi.signApp = originals.signApp;
    rewardsApi.signPC = originals.signPC;
  }
});

test('DAPI 已确认今日签到时，卡片动作直接返回 alreadyDone 并同步本地状态', async () => {
  const accountId = 'acc_mobile_dapi_done';
  configManager.upsertAccount({
    id: accountId,
    name: '移动端 DAPI 已完成测试',
    cookie: 'MOCK_COOKIE;_U=mock_user',
    refreshToken: 'MOCK_REFRESH'
  });

  const tm = new TaskManager();
  tm.getLiveAccountBlockReason = async () => '';
  tm.checkMobileAccountBinding = async () => ({
    mismatch: false,
    tokenOk: true,
    verified: true,
    message: ''
  });
  let syncCalls = 0;
  tm.syncAccountOfficialStatus = async () => {
    syncCalls++;
    return tm.ensureAccountStats(accountId);
  };

  const originals = {
    getRewardsInfo: rewardsApi.getRewardsInfo,
    getAppCheckInStatus: rewardsApi.getAppCheckInStatus,
    signApp: rewardsApi.signApp
  };
  let signCalls = 0;
  rewardsApi.getRewardsInfo = async () => ({
    streaks: {
      bingapp: {
        completedDays: 0,
        isCurrentDayCompleted: false
      }
    }
  });
  rewardsApi.getAppCheckInStatus = async () => ({
    completedDays: 8,
    currentDay: 8,
    isCurrentDayCompleted: true,
    source: 'dapi'
  });
  rewardsApi.signApp = async () => {
    signCalls++;
    return {};
  };

  try {
    const result = await tm.runTaskAction(accountId, 'sign');
    assert.equal(result.alreadyDone, true);
    assert.equal(result.hadFailure, false);
    assert.equal(signCalls, 0);
    assert.equal(syncCalls, 1);
    assert.match(result.message, /今日已签到/);
  } finally {
    rewardsApi.getRewardsInfo = originals.getRewardsInfo;
    rewardsApi.getAppCheckInStatus = originals.getAppCheckInStatus;
    rewardsApi.signApp = originals.signApp;
  }
});

test('DAPI 返回积分但官网回读短暂未刷新时，不把成功签到覆盖回 0/1', async () => {
  const accountId = 'acc_mobile_stale_web';
  configManager.upsertAccount({
    id: accountId,
    name: '移动端官网延迟测试',
    cookie: 'MOCK_COOKIE;_U=mock_user',
    refreshToken: 'MOCK_REFRESH'
  });
  const account = configManager.findAccount(accountId);

  const tm = new TaskManager();
  tm.getLiveAccountBlockReason = async () => '';
  tm.checkMobileAccountBinding = async () => ({
    mismatch: false,
    tokenOk: true,
    verified: true,
    message: ''
  });

  const originals = {
    getRewardsInfo: rewardsApi.getRewardsInfo,
    signApp: rewardsApi.signApp,
    checkStreak: rewardsApi.checkStreak,
    getAppPromotions: rewardsApi.getAppPromotions
  };
  rewardsApi.getRewardsInfo = async () => ({
    balance: 100,
    webBalance: 100,
    streaks: {
      bingapp: {
        completedDays: 0,
        currentDay: 0,
        activitiesCompleted: 0,
        activitiesTotal: 1,
        isCurrentDayCompleted: false
      }
    }
  });
  rewardsApi.signApp = async () => ({ points: 10, balance: 100 });
  rewardsApi.checkStreak = async () => ({});
  rewardsApi.getAppPromotions = async () => [];

  try {
    await tm.syncAccountOfficialStatus(account, { owned: true });
    const result = await tm.runTaskAction(accountId, 'sign');
    const task = tm.ensureAccountStats(accountId).tasks.sign;

    assert.equal(result.hadFailure, false);
    assert.equal(result.after.progress, 1);
    assert.equal(task.done, true);
    assert.equal(task.progress, 1);
    assert.match(task.statusMessage, /等待官网/);
  } finally {
    rewardsApi.getRewardsInfo = originals.getRewardsInfo;
    rewardsApi.signApp = originals.signApp;
    rewardsApi.checkStreak = originals.checkStreak;
    rewardsApi.getAppPromotions = originals.getAppPromotions;
  }
});
