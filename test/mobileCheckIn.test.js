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

test('DAPI 签到活动只有今日 last_updated 但未完成时，卡片动作仍会执行签到', async () => {
  const accountId = 'acc_mobile_stale_timestamp';
  configManager.upsertAccount({
    id: accountId,
    name: '移动端时间戳误判测试',
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
  tm.syncAccountOfficialStatus = async () => tm.ensureAccountStats(accountId);

  const originals = {
    getRewardsInfo: rewardsApi.getRewardsInfo,
    getAppPromotions: rewardsApi.getAppPromotions,
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
  rewardsApi.getAppPromotions = async () => [{
    name: 'Daily Check-In',
    offerId: 'Gamification_Sapphire_DailyCheckIn',
    type: 'checkin',
    complete: false,
    progress: 8,
    lastUpdated: new Date().toISOString()
  }];
  rewardsApi.signApp = async () => {
    signCalls++;
    return { points: 5, balance: 100, confirmed: true };
  };

  try {
    const result = await tm.runTaskAction(accountId, 'sign');
    assert.equal(signCalls, 1);
    assert.equal(result.hadFailure, false);
    assert.match(result.message, /签到完成/);
  } finally {
    rewardsApi.getRewardsInfo = originals.getRewardsInfo;
    rewardsApi.getAppPromotions = originals.getAppPromotions;
    rewardsApi.signApp = originals.signApp;
  }
});

test('本机已确认今日签到且官网状态暂不可读时，不再重复提交签到', async () => {
  const accountId = 'acc_mobile_local_confirmed';
  configManager.upsertAccount({
    id: accountId,
    name: '移动端本机确认测试',
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
  tm.syncAccountOfficialStatus = async () => tm.ensureAccountStats(accountId);
  tm.updateTask('sign', {
    progress: 1,
    max: 1,
    done: true,
    lastConfirmedAt: Date.now()
  }, accountId);

  const originals = {
    getRewardsInfo: rewardsApi.getRewardsInfo,
    getAppPromotions: rewardsApi.getAppPromotions,
    signApp: rewardsApi.signApp
  };
  let signCalls = 0;
  rewardsApi.getRewardsInfo = async () => ({ streaks: {} });
  rewardsApi.getAppPromotions = async () => [{
    name: 'Daily Check-In',
    offerId: 'Gamification_Sapphire_DailyCheckIn',
    type: 'checkin',
    complete: false,
    progress: 8,
    lastUpdated: new Date().toISOString()
  }];
  rewardsApi.signApp = async () => {
    signCalls++;
    return { points: 0, balance: 100, confirmed: true };
  };

  try {
    const result = await tm.runTaskAction(accountId, 'sign');
    assert.equal(signCalls, 0);
    assert.equal(result.alreadyDone, true);
    assert.match(result.message, /本机已确认/);
  } finally {
    rewardsApi.getRewardsInfo = originals.getRewardsInfo;
    rewardsApi.getAppPromotions = originals.getAppPromotions;
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

test('完整账号流程签到成功后不会被 signSuccess 作用域异常中断', async () => {
  const accountId = 'acc_full_run_sign_scope';
  configManager.upsertAccount({
    id: accountId,
    name: '完整签到流程测试',
    cookie: 'MOCK_COOKIE;_U=mock_user',
    refreshToken: 'MOCK_REFRESH',
    enabled: true
  });
  const account = configManager.findAccount(accountId);
  const tm = new TaskManager();
  tm.running = true;
  tm.ensureAccountStats(accountId).tasks.sign.done = false;
  tm.syncAccountOfficialStatus = async () => tm.ensureAccountStats(accountId);
  tm.checkMobileAccountBinding = async () => ({
    mismatch: false,
    tokenOk: true,
    verified: true,
    message: ''
  });
  tm.claimExtraPointsAfterTasks = async () => ({ claimed: 0 });

  const originals = {
    signApp: rewardsApi.signApp,
    getRewardsInfo: rewardsApi.getRewardsInfo,
    getBalance: rewardsApi.getBalance,
    checkStreak: rewardsApi.checkStreak
  };
  rewardsApi.signApp = async () => ({ points: 5, balance: 100, confirmed: true });
  rewardsApi.getRewardsInfo = async () => ({
    balance: 100,
    todayPoints: 5,
    claimablePoints: 0
  });
  rewardsApi.getBalance = async () => 100;
  rewardsApi.checkStreak = async () => ({});

  try {
    const result = await tm.runSingleAccount(account, {
      tasks: {
        sign: true,
        read: false,
        appPromotions: false,
        dailySet: false,
        desktopApp: false,
        promos: false,
        search: false
      }
    });
    const signTask = tm.ensureAccountStats(accountId).tasks.sign;
    assert.equal(signTask.done, true);
    assert.equal(signTask.points, 5);
    assert.ok(Number(signTask.lastConfirmedAt) > 0);
    assert.equal(result.accountId, accountId);
  } finally {
    tm.running = false;
    rewardsApi.signApp = originals.signApp;
    rewardsApi.getRewardsInfo = originals.getRewardsInfo;
    rewardsApi.getBalance = originals.getBalance;
    rewardsApi.checkStreak = originals.checkStreak;
  }
});
