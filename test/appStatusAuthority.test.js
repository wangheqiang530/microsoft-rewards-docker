import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-app-status-authority-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { default: rewardsApi } = await import('../src/core/api.js');
const { TaskManager } = await import('../src/core/taskManager.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('DAPI 已确认今日签到但网页端仍为 0/7 时，保留已完成状态', async () => {
  const accountId = 'acc_app_status_authority';
  configManager.upsertAccount({
    id: accountId,
    name: 'App 状态权威测试',
    cookie: 'MOCK_COOKIE;_U=mock_user',
    refreshToken: 'MOCK_REFRESH'
  });
  const account = configManager.findAccount(accountId);
  const manager = new TaskManager();
  const stats = manager.ensureAccountStats(accountId);
  stats.tasks.sign = {
    ...stats.tasks.sign,
    progress: 1,
    max: 1,
    points: 15,
    done: true
  };
  manager.saveStats();

  const originals = {
    getRewardsInfo: rewardsApi.getRewardsInfo,
    checkStreak: rewardsApi.checkStreak,
    getAppPromotions: rewardsApi.getAppPromotions,
    checkMobileAccountBinding: manager.checkMobileAccountBinding
  };
  rewardsApi.getRewardsInfo = async () => ({
    balance: 58209,
    webBalance: 58209,
    todayPoints: 150,
    quests: [],
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
  rewardsApi.checkStreak = async () => ({});
  rewardsApi.getAppPromotions = async () => [{
    name: 'Daily Check-In',
    offerId: 'Gamification_Sapphire_DailyCheckIn',
    type: 'checkin',
    complete: true,
    progress: 5,
    lastUpdated: new Date().toISOString()
  }];
  manager.checkMobileAccountBinding = async () => ({
    tokenOk: true,
    mobileBalance: 58209,
    mismatch: false,
    verified: true,
    message: ''
  });

  try {
    await manager.syncAccountOfficialStatus(account, { owned: true });
    const updated = manager.ensureAccountStats(accountId).tasks.sign;
    assert.equal(updated.done, true);
    assert.equal(updated.progress, 1);
    assert.equal(updated.points, 15);
    assert.match(updated.statusMessage, /DAPI 已确认今日签到/);
  } finally {
    rewardsApi.getRewardsInfo = originals.getRewardsInfo;
    rewardsApi.checkStreak = originals.checkStreak;
    rewardsApi.getAppPromotions = originals.getAppPromotions;
    manager.checkMobileAccountBinding = originals.checkMobileAccountBinding;
  }
});

test('DAPI 与网页端都明确未完成时，本机任务必须回退为 0/1', async () => {
  const accountId = 'acc_app_status_not_done';
  configManager.upsertAccount({
    id: accountId,
    name: 'App 未完成测试',
    cookie: 'MOCK_COOKIE;_U=mock_user',
    refreshToken: 'MOCK_REFRESH'
  });
  const account = configManager.findAccount(accountId);
  const manager = new TaskManager();
  const stats = manager.ensureAccountStats(accountId);
  stats.tasks.sign = {
    ...stats.tasks.sign,
    progress: 1,
    max: 1,
    points: 15,
    done: true
  };
  manager.saveStats();

  const originals = {
    getRewardsInfo: rewardsApi.getRewardsInfo,
    checkStreak: rewardsApi.checkStreak,
    getAppPromotions: rewardsApi.getAppPromotions,
    checkMobileAccountBinding: manager.checkMobileAccountBinding
  };
  rewardsApi.getRewardsInfo = async () => ({
    balance: 100,
    webBalance: 100,
    todayPoints: 0,
    quests: [],
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
  rewardsApi.checkStreak = async () => ({});
  rewardsApi.getAppPromotions = async () => [{
    name: 'Daily Check-In',
    offerId: 'Gamification_Sapphire_DailyCheckIn',
    type: 'checkin',
    complete: false,
    progress: 4,
    lastUpdated: '2026-11-11T00:00:00.000Z'
  }];
  manager.checkMobileAccountBinding = async () => ({
    tokenOk: true,
    mobileBalance: 100,
    mismatch: false,
    verified: true,
    message: ''
  });

  try {
    await manager.syncAccountOfficialStatus(account, { owned: true });
    const updated = manager.ensureAccountStats(accountId).tasks.sign;
    assert.equal(updated.done, false);
    assert.equal(updated.progress, 0);
    assert.equal(updated.points, 0);
  } finally {
    rewardsApi.getRewardsInfo = originals.getRewardsInfo;
    rewardsApi.checkStreak = originals.checkStreak;
    rewardsApi.getAppPromotions = originals.getAppPromotions;
    manager.checkMobileAccountBinding = originals.checkMobileAccountBinding;
  }
});
