import fs from 'fs';
import path from 'path';
import configManager from '../config.js';
import logger from '../logger.js';
import rewardsApi from './api.js';
import authManager from './auth.js';
import notifier from './notifier.js';
import historyManager from './history.js';
import browserManager from './browser.js';
import { accountContextLock } from './contextLock.js';
import { SearchStagnationGuard, normalizeStagnantLimit } from './searchStagnation.js';
import {
  accountNamesLikelyMatch,
  isBalanceMismatch,
  searchTierFromMax,
  toOptionalFiniteNumber,
  webIdentityKey
} from './accountIdentity.js';
import {
  SPECIAL_ACTIVITIES,
  buildSpecialActivityTask,
  findSpecialActivity,
  isSpecialActivityAttemptedToday
} from './specialActivities.js';
import {
  getAppCheckInStatusFromPromotions,
  getPendingSapphireAppPromotions,
  isSapphireAppPromotion
} from './promotionSources.js';
import { normalizeAccountRunHours } from './scheduleWindow.js';
import { DATA_DIR, writeFileAtomic } from '../fsUtil.js';

const STATS_FILE = path.join(DATA_DIR, 'stats.json');

export class TaskManager {
  constructor() {
    this.running = false;
    this.runningAccountId = null;
    this.lastUnifiedReportDate = 0;
    this.turboMode = false;
    this.stats = this.loadStats();
  }

  isTurboMode() {
    return !!this.turboMode;
  }

  setTurboMode(enabled) {
    this.turboMode = !!enabled;
    return this.turboMode;
  }

  getTodayNum() {
    const d = new Date();
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }

  createDefaultAccountStats(id = 'acc_1', name = '默认账号') {
    return {
      id,
      name,
      date: this.getTodayNum(),
      balance: 0,
      startBalance: 0,
      earned: 0,
      claimablePoints: 0,
      lastClaimAt: 0,
      lastClaimedPoints: 0,
      streakDays: 0,
      stamps: { progress: 0, max: 12 },
      searchQuotaVerifiedAt: 0,
      searchQuotaMax: 0,
      searchQuotaProgress: 0,
      searchQuotaSource: '',
      searchQuotaErrorAt: 0,
      webIdentityKey: '',
      identityAppliedAt: 0,
      credentialAppliedAt: 0,
      lastUpdate: Date.now(),
      lastRunAt: 0,
      tasks: {
        sign: { name: "移动端签到", progress: 0, max: 1, points: 0, unit: "次", icon: "📱", done: false },
        appPromotions: { name: "移动端每日活动", progress: 0, max: 0, points: 0, unit: "项", icon: "📱", done: false, available: false, statusMessage: "等待移动端活动同步" },
        read: { name: "新闻资讯自动阅读", progress: 0, max: 30, points: 0, unit: "篇", icon: "📖", done: false },
        search: { name: "必应 PC 搜索任务", progress: 0, max: 0, points: 0, unit: "分", icon: "🔍", done: false, searchTier: null, statusMessage: "等待官网同步会员等级配额" },
        dailySet: { name: "每日活动集 (Daily Set)", progress: 0, max: 3, points: 0, unit: "个", icon: "📅", done: false },
        promos: { name: "活动卡片与 Quiz 问答", progress: 0, max: 1, points: 0, unit: "项", icon: "🧩", done: false },
        desktopApp: { name: "桌面应用每周专属任务", progress: 0, max: 8, points: 20, unit: "个任务", icon: "rewards-app", expiresText: "", available: false, done: false, stepLogs: [], isPunchCard: true }
      }
    };
  }

  loadStats() {
    const today = this.getTodayNum();
    const accountsCfg = configManager.getAccounts();
    const defaultAcc = accountsCfg[0] || { id: 'acc_1', name: '主账号' };
    const baseStats = {
      date: today,
      ...this.createDefaultAccountStats(defaultAcc.id, defaultAcc.name),
      accounts: {}
    };

    try {
      if (fs.existsSync(STATS_FILE)) {
        const raw = fs.readFileSync(STATS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.date === today) {
          const merged = { ...baseStats, ...parsed };
          if (!merged.accounts || typeof merged.accounts !== 'object') {
            merged.accounts = {};
          }
          // 将旧版单账号数据迁移进 merged.accounts[defaultAcc.id]
          if (!merged.accounts[defaultAcc.id]) {
            merged.accounts[defaultAcc.id] = {
              id: defaultAcc.id,
              name: defaultAcc.name,
              date: today,
              balance: merged.balance || 0,
              startBalance: merged.startBalance || 0,
              earned: merged.earned || 0,
              streakDays: merged.streakDays || 0,
              stamps: merged.stamps || { progress: 0, max: 12 },
              lastUpdate: merged.lastUpdate || Date.now(),
              tasks: merged.tasks || this.createDefaultAccountStats().tasks
            };
          }
          this.normalizeAllPunchCardTasks(merged);
          return merged;
        } else if (parsed && parsed.accounts && typeof parsed.accounts === 'object') {
          // 跨日换天：日常任务清空，但继承跨天多日打孔卡状态与打孔记录，避免第二天被清零
          for (const [accId, oldAcc] of Object.entries(parsed.accounts)) {
            if (!baseStats.accounts[accId]) {
              baseStats.accounts[accId] = this.createDefaultAccountStats(accId, oldAcc.name || accId);
            }
            // 昨日收盘余额就是今日起始余额。旧实现把 startBalance 清成 0，
            // 等第一次同步再取余额，会把当天在首次同步前产生的积分永久漏掉。
            const previousBalance = Number(oldAcc.balance);
            if (Number.isFinite(previousBalance) && previousBalance > 0) {
              baseStats.accounts[accId].balance = previousBalance;
              baseStats.accounts[accId].startBalance = previousBalance;
              baseStats.accounts[accId].startBalanceDate = today;
            }
            baseStats.accounts[accId].lastRunAt = Number(oldAcc.lastRunAt || 0);
            // 跨日只应清空每日进度，不应把“凭据更新时间”当成“账号身份变化”。
            // 旧实现丢失了这两个时间戳，导致每天 00:00 第一次访问账号时误报
            // “网页身份已变化”，把余额、搜索配额和任务状态再次清空。
            const accCfg = configManager.findAccount(accId);
            baseStats.accounts[accId].webIdentityKey = oldAcc.webIdentityKey
              || webIdentityKey(accCfg?.cookie || '');
            baseStats.accounts[accId].identityAppliedAt = Math.max(
              Number(oldAcc.identityAppliedAt || 0),
              Number(accCfg?.identityChangedAt || 0)
            );
            baseStats.accounts[accId].credentialAppliedAt = Math.max(
              Number(oldAcc.credentialAppliedAt || 0),
              Number(accCfg?.credentialUpdatedAt || 0)
            );
            for (const [k, oldTask] of Object.entries(oldAcc.tasks || {})) {
              if (oldTask && (oldTask.isPunchCard || k === 'desktopApp' || k === 'monthlyQuest' || k.startsWith('quest_'))) {
                baseStats.accounts[accId].tasks[k] = { ...oldTask };
              }
            }
          }
          this.normalizeAllPunchCardTasks(baseStats);
          return baseStats;
        }
      }
    } catch (e) {
      console.error('[TaskManager] 读取统计数据失败:', e.message);
    }

    baseStats.accounts[defaultAcc.id] = this.createDefaultAccountStats(defaultAcc.id, defaultAcc.name);
    this.saveStats(baseStats);
    return baseStats;
  }

  ensureAccountStats(accountId) {
    const today = this.getTodayNum();
    if (this.stats.date !== today) {
      this.stats = this.loadStats();
    }
    if (!this.stats.accounts) {
      this.stats.accounts = {};
    }
    const accCfg = configManager.resolveAccount(accountId);
    const id = accCfg?.id || accountId || 'acc_1';
    const name = accCfg?.name || '账号';
    const currentWebIdentity = webIdentityKey(accCfg?.cookie || '');
    const identityChangedAt = Number(accCfg?.identityChangedAt || 0);
    const credentialUpdatedAt = Number(accCfg?.credentialUpdatedAt || 0);

    if (!this.stats.accounts[id]) {
      this.stats.accounts[id] = this.createDefaultAccountStats(id, name);
      this.stats.accounts[id].webIdentityKey = currentWebIdentity;
      this.stats.accounts[id].identityAppliedAt = identityChangedAt;
      this.stats.accounts[id].credentialAppliedAt = credentialUpdatedAt;
    } else {
      const accStats = this.stats.accounts[id];
      const storedIdentity = String(accStats.webIdentityKey || '');
      const identityChanged = identityChangedAt > Number(accStats.identityAppliedAt || 0)
        || (!!currentWebIdentity && !!storedIdentity && storedIdentity !== currentWebIdentity);
      if (identityChanged) {
        const previousLastRunAt = Number(accStats.lastRunAt || 0);
        // Cookie 对应的网页账号已经变化，旧账号的余额、搜索进度和印章不能继续沿用。
        this.stats.accounts[id] = this.createDefaultAccountStats(id, name);
        this.stats.accounts[id].lastRunAt = previousLastRunAt;
        this.stats.accounts[id].webIdentityKey = currentWebIdentity;
        this.stats.accounts[id].identityAppliedAt = identityChangedAt || Date.now();
        this.stats.accounts[id].credentialAppliedAt = credentialUpdatedAt;
        logger.log('🔄', `检测到账号 [${name}] 的网页身份已变化，旧进度已清空，等待从官网重新同步`);
      } else {
        accStats.name = name;
        if (currentWebIdentity) accStats.webIdentityKey = currentWebIdentity;
        if (identityChangedAt > Number(accStats.identityAppliedAt || 0)) {
          accStats.identityAppliedAt = identityChangedAt;
        }
        if (credentialUpdatedAt > Number(accStats.credentialAppliedAt || 0)) {
          // Cookie/Token 已被用户重新导入，旧凭据产生的阻断结论必须失效。
          delete accStats.executionBlockReason;
          accStats.credentialAppliedAt = credentialUpdatedAt;
        }
      }
      const activeStats = this.stats.accounts[id];
      // 保证所有打孔卡任务的 stepLogs 与基础属性健全
      for (const [k, t] of Object.entries(activeStats.tasks || {})) {
        if (this.isPunchCardTask(k, t)) {
          t.isPunchCard = true;
          if (!Array.isArray(t.stepLogs)) t.stepLogs = [];
          if (!t.unit) t.unit = '个任务';
          this.normalizePunchCardTask(t);
        }
      }
      if (!activeStats.stamps) {
        activeStats.stamps = { progress: 0, max: 12 };
      }
      if (!Number.isFinite(Number(activeStats.lastRunAt))) {
        activeStats.lastRunAt = 0;
      }
    }
    return this.stats.accounts[id];
  }

  saveStats(stats = this.stats) {
    try {
      this.stats = stats;
      // 同步第一个账号到顶层属性保持兼容
      const firstAcc = configManager.getAccounts()[0];
      if (firstAcc && stats.accounts?.[firstAcc.id]) {
        const fa = stats.accounts[firstAcc.id];
        stats.balance = fa.balance;
        stats.earned = fa.earned;
        stats.streakDays = fa.streakDays;
        stats.stamps = fa.stamps;
        stats.tasks = fa.tasks;
        stats.lastUpdate = fa.lastUpdate;
      }
      writeFileAtomic(STATS_FILE, JSON.stringify(stats, null, 2), { encoding: 'utf-8', mode: 0o600 });

      // 同步记录历史账单（包含单账号账单与全局汇总）
      const summary = this.computeSummary();
      const todayStr = historyManager.formatDate(new Date());

      // 1. 记录每个账号的账单
      if (stats.accounts) {
        for (const [accId, aStat] of Object.entries(stats.accounts)) {
          historyManager.recordAccountDay(accId, todayStr, {
            earned: aStat.earned || 0,
            balance: aStat.balance || 0,
            claimablePoints: aStat.claimablePoints || 0,
            streakDays: aStat.streakDays || 0,
            stamps: aStat.stamps || { progress: 0, max: 12 },
            // 真实任务分解：只取确实拿到分的项，不再用硬编码模板编造明细
            breakdown: this.buildTaskBreakdown(aStat)
          });
        }
      }

      // 2. 记录全局汇总账单
      historyManager.recordGlobalDay(todayStr, {
        earned: summary.totalEarned || stats.earned || 0,
        balance: summary.totalBalance || stats.balance || 0,
        breakdown: this.buildSummaryBreakdown(stats)
      });
    } catch (e) {
      console.error('[TaskManager] 保存统计数据失败:', e.message);
    }
  }

  /**
   * 从任务项生成真实的积分分解（只保留真正拿到分的任务）。
   * 旧实现用 history.getDefaultBreakdown() 按固定模板拆分 earned，
   * 属于编造数据——历史图表悬停看到的明细全是假的。
   */
  buildTaskBreakdown(accStats) {
    return Object.values(accStats?.tasks || {})
      .map(t => ({ name: t.name || '', icon: t.icon || '📌', points: Number(t.points || 0) }))
      .filter(t => t.name && t.points > 0);
  }

  /** 全账号汇总的积分分解：把各账号同名任务的积分相加 */
  buildSummaryBreakdown(stats = this.stats) {
    const merged = new Map();
    for (const accStat of Object.values(stats?.accounts || {})) {
      for (const item of this.buildTaskBreakdown(accStat)) {
        const cur = merged.get(item.name) || { name: item.name, icon: item.icon, points: 0 };
        cur.points += item.points;
        merged.set(item.name, cur);
      }
    }
    return Array.from(merged.values()).sort((a, b) => b.points - a.points);
  }

  /**
   * 重算「今日已增积分」。
   *
   * 唯一权威来源是官网 earn 页顶部「今日积分」；取不到时才回退到
   * 「当前余额 − 今日起始余额」。绝不再用「各任务积分求和」——
   * 那会把没做的任务也算进去（实测能虚高几十点）。
   */
  applyEarned(accStats, officialTodayPoints) {
    if (!accStats) return;
    const official = Number(officialTodayPoints);
    const hasOfficial = Number.isFinite(official) && official >= 0;

    let start = Number(accStats.startBalance);
    const now = Number(accStats.balance);
    const todayNum = this.getTodayNum();
    const todayStr = historyManager.formatDate(new Date());

    // 兼容旧版本已经写坏的本日起点：如果昨天收盘余额高于当前记录的起点，
    // 以昨天收盘余额为准，避免把「账号本身已有余额」误算成今日新增。
    if (accStats.startBalanceDate === todayNum) {
      const previousClose = historyManager.getLatestBalanceBefore(accStats.id, todayStr);
      if (previousClose > 0 && (!Number.isFinite(start) || start < previousClose)) {
        start = previousClose;
        accStats.startBalance = previousClose;
      }
    }

    const hasBalanceDelta = accStats.startBalanceDate === todayNum
      && Number.isFinite(start)
      && Number.isFinite(now)
      && start > 0;
    const balanceDelta = hasBalanceDelta ? Math.max(0, now - start) : null;

    let earned = null;
    let source = '';
    if (hasOfficial && official > 0) {
      earned = official;
      source = 'official';
    } else if (balanceDelta !== null && balanceDelta > 0) {
      // 官网卡片偶发显示 0（尤其页面同时存在多份 Flight 数据时），
      // 余额差是可信的兜底，不能再把这个 0 当成权威值覆盖已有正数。
      earned = balanceDelta;
      source = 'balance-delta';
    } else if (hasOfficial) {
      earned = 0;
      source = 'official';
    }

    if (earned === null) return;

    // 同一日内只增不减：后续同步失败、账号上下文短暂串台或官网返回 0，
    // 都不能把已经确认到账的今日积分抹掉。
    const previousEarned = Math.max(0, Number(accStats.earned) || 0);
    if (previousEarned > earned) {
      earned = previousEarned;
      source = accStats.earnedSource || source;
    }
    accStats.earned = earned;
    accStats.earnedSource = source;
  }

  updateTask(key, partial, accountId = null) {
    const accStats = this.ensureAccountStats(accountId);
    if (accStats.tasks && accStats.tasks[key]) {
      Object.assign(accStats.tasks[key], partial);
      // 注意：这里不再用任务积分求和改写 earned。
      // 任务积分只用于展示分解，真实今日增量由 applyEarned() 统一维护。
      accStats.lastUpdate = Date.now();
      this.saveStats();
    }
  }

  isSameLocalDay(timestamp) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    const date = new Date(ts);
    const now = new Date();
    return date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
  }

  recordSearchQuotaVerification(accStats, pc, source = 'official') {
    if (!accStats || !pc) return false;
    const max = Number(pc.max);
    const tier = searchTierFromMax(max);
    if (!Number.isFinite(max) || max <= 0 || !tier || tier.code === 'unknown') return false;
    accStats.searchQuotaVerifiedAt = Date.now();
    accStats.searchQuotaMax = max;
    accStats.searchQuotaProgress = Math.max(0, Number(pc.progress) || 0);
    accStats.searchQuotaSource = source;
    accStats.searchQuotaErrorAt = 0;
    return true;
  }

  getCachedSearchQuota(accStats, options = {}) {
    if (!accStats || !this.isSameLocalDay(accStats.searchQuotaVerifiedAt)) return null;
    const verifiedAt = Number(accStats.searchQuotaVerifiedAt);
    const maxAgeMs = Number(options.maxAgeMs) > 0
      ? Number(options.maxAgeMs)
      : 12 * 60 * 60 * 1000;
    if (Date.now() - verifiedAt > maxAgeMs) return null;
    const max = Number(accStats.searchQuotaMax || accStats.tasks?.search?.max);
    const tier = searchTierFromMax(max);
    if (!Number.isFinite(max) || max <= 0 || !tier || tier.code === 'unknown') return null;
    return {
      ok: true,
      pc: {
        progress: Math.max(0, Number(accStats.searchQuotaProgress || accStats.tasks?.search?.progress) || 0),
        max
      },
      progress: Math.max(0, Number(accStats.searchQuotaProgress || accStats.tasks?.search?.progress) || 0),
      max,
      tier,
      source: 'cache',
      cached: true,
      verifiedAt
    };
  }

  /**
   * 搜索配额解析的最终入口：
   * 1. 首轮官网数据有效时直接使用；
   * 2. 首轮为空时独立重试，不受其他任务解析失败影响；
   * 3. 仍为空时只允许使用“当天且同网页身份”已确认的官方配额；
   * 4. 跨日、身份不明或从未确认过时仍然拒绝搜索，绝不默认 60 分。
   */
  async resolveSearchQuota(accCfg, info, options = {}) {
    const accStats = this.ensureAccountStats(accCfg?.id);
    const evaluate = (pc, source, cached = false) => {
      if (!pc) return null;
      const max = Number(pc.max);
      if (!Number.isFinite(max) || max <= 0) return null;
      const tier = searchTierFromMax(max);
      if (!tier || tier.code === 'unknown') {
        return {
          ok: false,
          reason: `官网返回未知搜索配额 ${max}，已暂停搜索以避免按错误上限执行`
        };
      }
      const progress = Math.max(0, Number(pc.progress) || 0);
      if (!cached) {
        this.recordSearchQuotaVerification(accStats, { progress, max }, source);
      }
      return {
        ok: true,
        pc: { progress, max },
        progress,
        max,
        tier,
        source,
        cached
      };
    };

    const official = evaluate(info?.pc, info?.searchQuotaSource || 'official');
    if (official?.ok) {
      if (options.persist !== false) this.saveStats();
      return official;
    }

    if (options.probeMissing !== false) {
      let retriedQuota = null;
      try {
        retriedQuota = await rewardsApi.getSearchQuota({
          attempts: options.attempts || 4,
          retryDelaysMs: options.retryDelaysMs,
          onRetry: options.onRetry,
          shouldStop: options.shouldStop
        });
      } catch {}
      if (retriedQuota?.aborted) {
        return {
          ok: false,
          stopped: true,
          reason: '任务已停止，已取消搜索配额重试'
        };
      }
      const retried = evaluate(retriedQuota, 'retry');
      if (retried) {
        if (retried.ok && options.persist !== false) this.saveStats();
        return retried;
      }
    }

    // 官网明确返回未知配额时，可以重试一次尝试恢复为标准等级；
    // 但重试后仍未知时必须拒绝，不能用当天缓存或固定 60 分覆盖它。
    if (official && !official.ok) return official;

    const cached = options.useCache === false ? null : this.getCachedSearchQuota(accStats, options);
    if (cached) return cached;

    return {
      ok: false,
      reason: options.probeMissing === false
        ? '官网未返回当日搜索等级配额'
        : '官网多次重试后仍未返回当日搜索等级配额'
    };
  }

  /**
   * 同一统计日内的任务进度只增不减。
   * 官网局部返回 0、空配额或短暂骨架页时，保留上一次已确认的状态。
   */
  mergeMonotonicTask(previous, incoming) {
    if (!previous || typeof previous !== 'object') return { ...incoming };
    const prevMax = Math.max(0, Number(previous.max) || 0);
    const incomingMax = Math.max(0, Number(incoming?.max) || 0);
    const max = incomingMax > 0 ? incomingMax : prevMax;
    const sameScale = prevMax === 0 || incomingMax === 0 || prevMax === incomingMax;
    const progress = sameScale
      ? Math.max(Number(previous.progress) || 0, Number(incoming?.progress) || 0)
      : Math.max(0, Number(incoming?.progress) || 0);
    const points = Math.max(Number(previous.points) || 0, Number(incoming?.points) || 0);
    const done = incoming?.done === true
      || (previous.done === true && (max <= 0 || progress >= max))
      || (max > 0 && progress >= max);
    return {
      ...previous,
      ...(incoming || {}),
      max,
      progress,
      points,
      done,
      searchTier: incoming?.searchTier || previous.searchTier || null,
      statusMessage: incoming?.statusMessage ?? previous.statusMessage ?? ''
    };
  }

  isPunchCardTask(key, task) {
    return !!task && (
      task.isPunchCard
      || key === 'desktopApp'
      || key === 'monthlyQuest'
      || String(key).startsWith('quest_')
    );
  }

  /**
   * 打孔卡只允许保存当前周期、当前进度以内的确认记录。
   * 历史上跨周遗留的 stepLogs 会让悬浮明细显示成 7/8，而官网真实进度仍是 3/8。
   */
  normalizePunchCardTask(task) {
    if (!task || typeof task !== 'object') return { task, changed: false };
    const max = Math.max(1, Math.floor(Number(task.max) || 1));
    const progress = Math.max(0, Math.min(max, Math.floor(Number(task.progress) || 0)));
    const byStep = new Map();
    for (const log of Array.isArray(task.stepLogs) ? task.stepLogs : []) {
      const step = Math.floor(Number(log?.step));
      if (!Number.isInteger(step) || step <= 0 || step > progress || step > max) continue;
      const previous = byStep.get(step);
      if (!previous || Number(log?.at || 0) >= Number(previous?.at || 0)) {
        byStep.set(step, log);
      }
    }
    const stepLogs = [...byStep.values()].sort((a, b) => Number(a.step) - Number(b.step));
    const done = max > 0 && progress >= max;
    const changed = Number(task.max) !== max
      || Number(task.progress) !== progress
      || task.done !== done
      || JSON.stringify(task.stepLogs || []) !== JSON.stringify(stepLogs);
    task.max = max;
    task.progress = progress;
    task.done = done;
    task.stepLogs = stepLogs;
    return { task, changed };
  }

  normalizeAllPunchCardTasks(stats = this.stats) {
    let changed = false;
    for (const account of Object.values(stats?.accounts || {})) {
      for (const [key, task] of Object.entries(account?.tasks || {})) {
        if (!this.isPunchCardTask(key, task)) continue;
        if (!task.isPunchCard) {
          task.isPunchCard = true;
          changed = true;
        }
        if (!task.unit) {
          task.unit = '个任务';
          changed = true;
        }
        if (this.normalizePunchCardTask(task).changed) changed = true;
      }
    }
    return changed;
  }

  /**
   * 打孔卡跨周期时必须清空旧日志和进度；同一周期内继续使用只增不减的防回退策略。
   */
  mergePunchCardTask(previous, incoming) {
    const previousTask = previous && typeof previous === 'object' ? { ...previous } : null;
    if (previousTask) this.normalizePunchCardTask(previousTask);
    const incomingTask = { ...(incoming || {}) };
    const previousCycle = String(previousTask?.cycleKey || '');
    const incomingCycle = String(incomingTask.cycleKey || '');
    const cycleChanged = !!incomingCycle && previousCycle !== incomingCycle;

    if (!previousTask || cycleChanged) {
      this.normalizePunchCardTask(incomingTask);
      return incomingTask;
    }

    const merged = this.mergeMonotonicTask(previousTask, incomingTask);
    const logByStep = new Map();
    for (const log of [
      ...(Array.isArray(previousTask.stepLogs) ? previousTask.stepLogs : []),
      ...(Array.isArray(incomingTask.stepLogs) ? incomingTask.stepLogs : [])
    ]) {
      const step = Number(log?.step);
      if (!Number.isInteger(step) || step <= 0) continue;
      const current = logByStep.get(step);
      if (!current || Number(log?.at || 0) >= Number(current?.at || 0)) logByStep.set(step, log);
    }
    merged.stepLogs = [...logByStep.values()].sort((a, b) => Number(a.step) - Number(b.step));
    merged.cycleKey = incomingCycle || previousCycle || undefined;
    this.normalizePunchCardTask(merged);
    return merged;
  }

  /**
   * 删除账号时清理它的统计与账单，避免留下孤儿数据
   */
  removeAccountStats(accountId) {
    if (!accountId) return false;
    if (this.stats?.accounts?.[accountId]) {
      delete this.stats.accounts[accountId];
      this.saveStats();
      return true;
    }
    return false;
  }

  /**
   * 特殊活动只对官网实际返回该卡片的账号建档。
   * 没有 offerId 的账号不会创建任务，也不会启动浏览器。
   */
  syncSpecialActivities(accStats, activities) {
    if (!accStats?.tasks || !Array.isArray(activities)) return false;
    const activity = findSpecialActivity(activities, SPECIAL_ACTIVITIES.browserExtension.key);
    if (!activity) {
      delete accStats.tasks.browserExtension;
      return false;
    }
    accStats.tasks.browserExtension = buildSpecialActivityTask(
      activity,
      accStats.tasks.browserExtension || {}
    );
    return true;
  }

  /**
   * 核心自愈机制：直接从微软官方同步账号的真实完成状态 (搜索/阅读/桌面任务/连签/印章)
   */
  async syncAccountOfficialStatus(accCfg, options = {}) {
    if (!accCfg?.cookie && !accCfg?.refreshToken) return null;
    if (accCfg.enabled === false && options.allowPaused !== true) {
      // 自动同步/自动任务遇到暂停账号必须直接返回；手动刷新和手动体检
      // 会显式传 allowPaused=true，这是用户明确允许的两个例外。
      return null;
    }
    // owned=true 表示调用方（任务执行）已经持有账号上下文锁，可以安全切换上下文。
    // 否则如果此刻有任务在跑，直接跳过 —— 抢走全局 Cookie/Token 上下文会把
    // 正在执行的任务算到别的账号头上。
    const owned = options.owned === true;
    // 非任务流程（WebUI 同步）也要自己持锁，否则两个并发的同步请求会互相
    // 抢全局上下文，同样可能把 A 的请求算到 B 头上。
    const lockOwner = `web-sync:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (!owned && !accountContextLock.tryAcquire(lockOwner)) return null;
    const accountId = accCfg.id;
    // 注意：加锁之后的所有逻辑都必须包在 try 里，否则中途抛异常会导致锁泄漏，
    // 后续定时任务与同步会一直拿不到锁。
    let accStats = null;
    let prevContext = null;

    try {
      accStats = this.ensureAccountStats(accountId);
      // 同步期间的日志统一归属到该账号（结束后整体还原，避免串台）
      prevContext = rewardsApi.snapshotAccountContext();
      logger.setAccountContext(accCfg.name || accountId);
      rewardsApi.setCurrentAccount(accCfg);
      const [info, streakInfo] = await Promise.all([
        rewardsApi.getRewardsInfo(2),
        rewardsApi.checkStreak()
      ]);

      if (info) {
        this.syncSpecialActivities(accStats, info.specialActivities);
        // 余额只在解析到有效正值时才覆盖：
        // 官网页面偶发取不到余额时 info.balance 会是 0，旧写法会把已有余额直接冲成 0，
        // 界面上就会短暂出现「总积分 0」。
        const parsedBalance = Number(info.balance);
        if (Number.isFinite(parsedBalance) && parsedBalance > 0) {
          accStats.balance = parsedBalance;
        }
        const parsedWebBalance = toOptionalFiniteNumber(info.webBalance);
        if (parsedWebBalance !== null && parsedWebBalance >= 0) {
          accStats.webBalance = parsedWebBalance;
        }

        // 1. 同步 PC 搜索真实配额
        if (info.pc) {
          const pcCur = Number(info.pc.progress || 0);
          const pcMax = Number(info.pc.max);
          const tier = searchTierFromMax(pcMax);
          const previousSearch = accStats.tasks.search;
          let nextSearch;
          if (Number.isFinite(pcMax) && pcMax > 0 && tier && tier.code !== 'unknown') {
            this.recordSearchQuotaVerification(accStats, { progress: pcCur, max: pcMax }, info.searchQuotaSource || 'sync');
            const isPcDone = pcCur >= pcMax;
            nextSearch = {
              name: "必应 PC 搜索任务",
              progress: pcCur,
              max: pcMax,
              points: pcCur,
              unit: "分",
              icon: "🔍",
              done: isPcDone,
              searchTier: tier,
              statusMessage: ''
            };
          } else {
            const currentSearch = accStats.tasks.search || {};
            const searchAlreadyDone = currentSearch.done === true
              || (Number(currentSearch.max || 0) > 0
                && Number(currentSearch.progress || 0) >= Number(currentSearch.max || 0));
            nextSearch = {
              ...currentSearch,
              name: "必应 PC 搜索任务",
              unit: "分",
              icon: "🔍",
              statusMessage: searchAlreadyDone
                ? ''
                : `官网返回未知搜索配额 ${pcMax}，已暂停搜索`
            };
          }
          accStats.tasks.search = this.mergeMonotonicTask(previousSearch, nextSearch);
        } else {
          const currentSearch = accStats.tasks.search || {};
          const searchAlreadyDone = currentSearch.done === true
            || (Number(currentSearch.max || 0) > 0
              && Number(currentSearch.progress || 0) >= Number(currentSearch.max || 0));
          accStats.tasks.search = this.mergeMonotonicTask(currentSearch, {
            ...currentSearch,
            name: "必应 PC 搜索任务",
            unit: "分",
            icon: "🔍",
            statusMessage: searchAlreadyDone ? '' : '官网未返回搜索等级配额，已暂停搜索'
          });
        }

        // 2. 同步新闻阅读真实配额。
        //    阅读进度来自移动端 DAPI，Token 绑定错误时这份数据属于另一个账号，
        //    绝不能拿它覆盖当前网页 Cookie 账号的阅读状态。
        let mobileTrusted = true;
        if (accCfg.refreshToken) {
          const effectiveWebBalance = toOptionalFiniteNumber(info.webBalance);
          const binding = await this.checkMobileAccountBinding(accCfg, effectiveWebBalance, {
            allowPaused: options.allowPaused === true
          }).catch(() => null);
          mobileTrusted = !!binding?.tokenOk && !binding?.mismatch && binding?.verified !== false;
          if (!mobileTrusted && binding?.mismatch) {
            logger.log('🔴', `${binding.message}，本次不采用移动端阅读进度`, accCfg.name || accountId);
            accStats.mobileBlockReason = binding.message;
            this.recordAccountCredentialBlock(accCfg, binding, info.balance);
          } else if (binding && !binding.tokenOk) {
            logger.log('🔴', `移动端 Token 异常，本次跳过签到与阅读：${binding.message}`, accCfg.name || accountId);
            accStats.mobileBlockReason = binding.message;
            this.recordAccountCredentialBlock(accCfg, binding, info.balance);
          } else if (binding && binding.tokenOk && !mobileTrusted) {
            logger.log('🟡', '官网未返回可用于账号配对校验的网页余额，本次不采用移动端阅读进度', accCfg.name || accountId);
            accStats.mobileBlockReason = binding.message;
          } else if (mobileTrusted) {
            // 重新授权或体检恢复后必须解除历史运行阻断。
            // 旧实现依赖 authDiagnosis.warningMessage 仍包含「移动端 Token」，
            // 但成功体检会把 warningMessage 清空，导致旧阻断标记永久残留。
            delete accStats.executionBlockReason;
            delete accStats.mobileBlockReason;
            configManager.recordAuthDiagnosis(accCfg.id, {
              cookieValid: true,
              tokenValid: true,
              overallValid: true,
              warning: false,
              warningMessage: '',
              balance: info.balance,
              cookieMessage: '',
              tokenMessage: ''
            });
          }
        }
        if (info.readMax > 0 && mobileTrusted) {
          const readCur = Number(info.readProgress || 0);
          const readMax = Number(info.readMax || 30);
          const isReadDone = readCur >= readMax;
          accStats.tasks.read = this.mergeMonotonicTask(accStats.tasks.read, {
            name: "新闻资讯自动阅读",
            progress: readCur,
            max: readMax,
            points: readCur,
            unit: "篇",
            icon: "📖",
            done: isReadDone
          });
        }

        // 2.1 同步移动端 DAPI 的 sapphire 每日活动与连签状态。
        // 新版 App 的这三张任务不保证出现在 Web /earn 或 Dashboard streak 中。
        if (accCfg.refreshToken && mobileTrusted) {
          const appPromotions = await rewardsApi.getAppPromotions().catch(() => null);
          if (Array.isArray(appPromotions)) {
            const dapiCheckIn = getAppCheckInStatusFromPromotions(appPromotions);
            const currentAppStreak = info.streaks?.bingapp;
            if (dapiCheckIn && (dapiCheckIn.isCurrentDayCompleted || !currentAppStreak?.isCurrentDayCompleted)) {
              info.streaks = {
                ...(info.streaks || {}),
                bingapp: dapiCheckIn
              };
            }

            const sapphirePromotions = appPromotions.filter(isSapphireAppPromotion);
            const pendingAppPromotions = getPendingSapphireAppPromotions(sapphirePromotions);
            const currentAppTask = accStats.tasks.appPromotions || {};
            if (sapphirePromotions.length > 0) {
              const completedPromotions = sapphirePromotions.filter(item => item.complete === true);
              const completedPoints = completedPromotions.reduce(
                (sum, item) => sum + Math.max(0, Number(item.max || 0)),
                0
              );
              const allDone = pendingAppPromotions.length === 0;
              accStats.tasks.appPromotions = this.mergeMonotonicTask(currentAppTask, {
                ...currentAppTask,
                name: '移动端每日活动',
                progress: completedPromotions.length,
                max: sapphirePromotions.length,
                points: completedPoints,
                unit: '项',
                icon: '📱',
                available: true,
                done: allDone,
                statusMessage: allDone
                  ? '移动端每日活动已全部完成'
                  : `待完成 ${pendingAppPromotions.length} 项`
              });
            } else if (Number(currentAppTask.max || 0) === 0) {
              accStats.tasks.appPromotions = {
                ...currentAppTask,
                name: '移动端每日活动',
                unit: '项',
                icon: '📱',
                available: false,
                done: false,
                statusMessage: '移动端未返回每日活动'
              };
            }
          }
        }

        // 3. 动态同步官方「任务」区全部打孔卡（自适应 1 个、2 个或多个）
        const hasOfficialQuests = Array.isArray(info.quests) && info.quests.length > 0;
        const questList = hasOfficialQuests
          ? info.quests
          : [info.desktopApp, info.monthlyQuest].filter(Boolean);

        if (questList.length > 0) {
          const currentQuestKeys = new Set();
          questList.forEach((q, idx) => {
            const title = q.title || q.name || '';
            const isDesktop = title.includes('桌面') || title.includes('RewardsApp');
            const isHalloween = title.includes('Halloween') || title.includes('万圣节');
            const isMonthly = title.includes('亮点') || title.includes('FY27') || title.includes('Monthly');
            
            let questKey = isDesktop ? 'desktopApp' : (isHalloween ? 'quest_halloween' : (isMonthly ? 'monthlyQuest' : `quest_${idx}`));
            currentQuestKeys.add(questKey);

            const prevTaskRaw = accStats.tasks[questKey] || {};
            const prevTask = { ...prevTaskRaw };
            this.normalizePunchCardTask(prevTask);
            const cycleChanged = !!q.questId && String(prevTask.cycleKey || '') !== String(q.questId);
            const prevLogs = !cycleChanged && Array.isArray(prevTask.stepLogs) ? prevTask.stepLogs : [];
            const updatedLogs = [];
            const seenSteps = new Set();
            for (const log of prevLogs) {
              const step = Number(log?.step);
              if (!Number.isFinite(step) || seenSteps.has(step)) continue;
              seenSteps.add(step);
              updatedLogs.push(log);
            }
            const qProgress = Number(q.progress ?? 0);
            const qMax = Number(q.max ?? (isDesktop ? 8 : (isHalloween ? 6 : 5))) || 1;

            for (let s = 1; s <= qProgress; s++) {
              if (!updatedLogs.some(l => l.step === s)) {
                updatedLogs.push({
                  step: s,
                  at: Date.now() - (qProgress - s) * 86400000,
                  name: `第 ${s} 项`
                });
              }
            }
            updatedLogs.sort((a, b) => a.step - b.step);

            let icon = q.icon;
            if (!icon) {
              if (isHalloween) icon = '🎃';
              else if (isDesktop) icon = '🖥️';
              else if (isMonthly) icon = '🍁';
              else icon = '🎯';
            }

            const nextQuestTask = {
              name: title || (isDesktop ? '桌面应用每周专属任务' : '活动打孔卡'),
              cycleKey: q.questId || prevTask.cycleKey || '',
              progress: qProgress,
              max: qMax,
              points: qProgress >= qMax ? (q.points || (isDesktop ? 20 : 50)) : 0,
              unit: "个任务",
              icon,
              expiresText: q.expiresText || "",
              available: q.available !== false,
              done: qProgress >= qMax,
              stepLogs: updatedLogs,
              isPunchCard: true,
              // 子任务冷却/尝试记录必须跨官网同步保留，否则每次刷新都会忘掉
              // “今天已经搜索过，等待明日”。
              subtaskState: prevTask.subtaskState && typeof prevTask.subtaskState === 'object'
                ? prevTask.subtaskState
                : {}
            };
            accStats.tasks[questKey] = prevTask.name === nextQuestTask.name
              ? this.mergePunchCardTask(prevTask, nextQuestTask)
              : nextQuestTask;
            this.normalizePunchCardTask(accStats.tasks[questKey]);
          });

          // 仅在明确获取到了官方确切的任务列表时，才移除下线活动；若未拿到列表则完整保留已有卡片
          if (hasOfficialQuests) {
            for (const key of Object.keys(accStats.tasks)) {
              if (key !== 'sign' && key !== 'appPromotions' && key !== 'read' && key !== 'search' && key !== 'dailySet'
                && key !== 'promos' && key !== 'browserExtension') {
                if (!currentQuestKeys.has(key)) {
                  delete accStats.tasks[key];
                }
              }
            }
          }
        }

        // 4. 同步印章与连签
        if (info.stamps) {
          accStats.stamps = info.stamps;
        }

        // 同步官网待领取额外积分
        if (info.claimablePoints !== undefined) {
          const incomingClaimable = Number(info.claimablePoints || 0);
          const lastClaimAt = Number(accStats.lastClaimAt || 0);
          const claimedRecently = lastClaimAt > 0
            && new Date(lastClaimAt).toDateString() === new Date().toDateString()
            && Date.now() - lastClaimAt < 10 * 60 * 1000;
          if (!claimedRecently || incomingClaimable === 0) {
            accStats.claimablePoints = incomingClaimable;
          }
        }

        // 同步连签任务（必应搜索 / 每日活动 / 必应应用）真实状态。
        // 「必应应用连续打卡」是官网独立展示的一项，脚本 UI 之前完全没有体现，
        // 导致明明没签成功也看不出来，这里如实记录并在未完成时给出提示。
        if (info.streaks) {
          accStats.streaks = info.streaks;
          const appStreak = info.streaks.bingapp;
          if (appStreak && appStreak.isCurrentDayCompleted === false) {
            logger.log('📱', `必应应用连续打卡今日未完成 (已完成 ${appStreak.completedDays || 0}/7 天)，执行任务时会自动补签`);
          } else if (appStreak && appStreak.isCurrentDayCompleted === true) {
            logger.log('📱', `必应应用连续打卡今日已完成 (连签第 ${appStreak.completedDays || 1} 天)`);
          }
        }

        if (streakInfo?.streakDays) {
          accStats.streakDays = streakInfo.streakDays;
        }

        // 5. 移动端签到 / 每日活动集：只认官网连签任务的真实状态
        //
        //    这里以前是「搜索和阅读都打满就推断签到与活动也完成了」，属于猜测。
        //    那正是「脚本显示签到已完成、官网必应应用连续打卡却还是 0/1」的根因。
        //    现在改为以官网 streak 模型为准，并且能双向校正：
        //    官网说完成就标完成，官网明确说没完成就把误标的完成状态纠正回来。
        const appStreak = info.streaks?.bingapp;
        const signTask = accStats.tasks.sign;
        if (appStreak && signTask) {
          if (appStreak.isCurrentDayCompleted === true) {
            accStats.tasks.sign = this.mergeMonotonicTask(signTask, {
              ...signTask,
              progress: 1,
              max: 1,
              points: signTask.points || 10,
              done: true
            });
          } else if (appStreak.isCurrentDayCompleted === false) {
            accStats.tasks.sign = this.mergeMonotonicTask(signTask, {
              ...signTask,
              progress: 0,
              max: 1,
              done: false
            });
          }
        }

        const dsStreak = info.streaks?.dailyset;
        const dsTask = accStats.tasks.dailySet;
        if (dsStreak && dsTask && Number(dsStreak.activitiesTotal || 0) > 0) {
          const dsTotal = Number(dsStreak.activitiesTotal);
          const dsDone = Math.min(Number(dsStreak.activitiesCompleted || 0), dsTotal);
          const dsFinished = dsDone >= dsTotal;
          accStats.tasks.dailySet = this.mergeMonotonicTask(dsTask, {
            ...dsTask,
            max: dsTotal,
            progress: dsFinished ? dsTotal : dsDone,
            points: dsFinished ? (dsTask.points || 30) : 0,
            done: dsFinished
          });
        }

        // 今日已增积分：以官网「今日积分」为准，取不到才回退到余额差
        this.applyEarned(accStats, info.todayPoints);
        // 每天第一次拿到余额时记录「今日起始余额」，供回退口径使用
        if (accStats.startBalanceDate !== this.getTodayNum() && Number(accStats.balance) > 0) {
          accStats.startBalance = Number(accStats.balance);
          accStats.startBalanceDate = this.getTodayNum();
          this.applyEarned(accStats, info.todayPoints);
        }
        accStats.lastUpdate = Date.now();
        this.saveStats();
        return accStats;
      }
    } catch (e) {
      console.error(`[TaskManager] 同步账号 [${accCfg.name}] 官方状态失败:`, e.message);
    } finally {
      if (prevContext) rewardsApi.restoreAccountContext(prevContext);
      if (!owned) accountContextLock.release(lockOwner);
    }
    return null;
  }

  async syncAllOfficialStatus(options = {}) {
    // 任务执行期间不做同步，避免与执行流程争抢账号上下文
    const lockOwner = `web-sync-all:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (!accountContextLock.tryAcquire(lockOwner)) return this.computeSummary();
    try {
      const accounts = configManager.getAccounts().filter(a => (
        options.allowPaused === true || a.enabled !== false
      ) && (a.cookie || a.refreshToken));
      const globalCfg = configManager.get();
      const baseGap = Math.max(15, Math.min(60, Number(globalCfg.tasks?.accountGapSec ?? 30) || 30));
      for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        // 外层已持有 web-sync 锁，这里用 owned 明确告知，不再重复加/解锁
        await this.syncAccountOfficialStatus(acc, {
          owned: true,
          allowPaused: options.allowPaused === true
        });
        // 多账号全量同步安全隔离延时：避免同一 IP 短时间内连续探测多个账号
        if (i < accounts.length - 1) {
          const jitter = Math.floor(baseGap * 0.25);
          const gapSec = rewardsApi.randomRange(baseGap, baseGap + jitter);
          logger.log('⏳', `多账号同步安全隔离：等待 ${gapSec} 秒后同步下一个账号 [${accounts[i + 1].name || accounts[i + 1].id}]...`);
          for (let s = gapSec; s > 0 && !this.running; s--) {
            await rewardsApi.delay(1000);
          }
        }
      }
      return this.computeSummary();
    } finally {
      accountContextLock.release(lockOwner);
    }
  }

  computeSummary() {
    const accountsCfg = configManager.getAccounts();
    let totalEarned = 0;
    let totalBalance = 0;
    let totalClaimable = 0;
    let maxStreak = 0;
    let totalTasksCount = 0;
    let doneTasksCount = 0;
    let stampsProgress = 0;
    let stampsMax = 12;
    let pausedAccounts = 0;

    const accountsList = accountsCfg.map(cfgAcc => {
      const st = this.ensureAccountStats(cfgAcc.id);
      const runHours = normalizeAccountRunHours(cfgAcc.runHours);
      const schedulePaused = runHours.length === 0;
      if (cfgAcc.enabled === false || schedulePaused) pausedAccounts++;
      totalEarned += Number(st.earned || 0);
      totalBalance += Number(st.balance || 0);
      totalClaimable += Number(st.claimablePoints || 0);
      if ((st.streakDays || 0) > maxStreak) maxStreak = st.streakDays;
      if ((st.stamps?.progress || 0) > stampsProgress) {
        stampsProgress = st.stamps.progress;
        stampsMax = st.stamps.max || 12;
      }

      const tEntries = Object.values(st.tasks || {});
      const tTotal = tEntries.length;
      const tDone = tEntries.filter(t => t.done || (t.max > 0 && t.progress >= t.max)).length;
      totalTasksCount += tTotal;
      doneTasksCount += tDone;

      return {
        id: cfgAcc.id,
        name: cfgAcc.name,
        enabled: cfgAcc.enabled !== false,
        runHours,
        schedulePaused,
        hasCookie: !!cfgAcc.cookie,
        hasToken: !!cfgAcc.refreshToken,
        authDiagnosis: cfgAcc.authDiagnosis || null,
        balance: st.balance || 0,
        earned: st.earned || 0,
        claimablePoints: Number(st.claimablePoints || 0),
        streakDays: st.streakDays || 0,
        stamps: st.stamps || { progress: 0, max: 12 },
        doneTasks: tDone,
        totalTasks: tTotal,
        percent: tTotal > 0 ? Math.round((tDone / tTotal) * 100) : 0,
        lastUpdate: st.lastUpdate,
        lastRunAt: Number(st.lastRunAt || 0),
        tasks: st.tasks
      };
    });

    const overallPercent = totalTasksCount > 0 ? Math.round((doneTasksCount / totalTasksCount) * 100) : 0;

    return {
      totalAccounts: accountsList.length,
      pausedAccounts,
      activeAccounts: Math.max(0, accountsList.length - pausedAccounts),
      totalEarned,
      totalBalance,
      totalClaimable,
      maxStreak,
      stamps: { progress: stampsProgress || 0, max: stampsMax || 12 },
      doneTasksCount,
      totalTasksCount,
      overallPercent,
      accountsList
    };
  }

  getStatus(accountId = 'all') {
    const today = this.getTodayNum();
    if (this.stats.date !== today) {
      this.stats = this.loadStats();
    }

    const summary = this.computeSummary();
    let activeStats = this.stats;

    if (accountId && accountId !== 'all') {
      activeStats = this.ensureAccountStats(accountId);
    } else if (summary.accountsList.length > 0) {
      // 汇总模式：构造汇总的 Hero 与第一个账号的详细或合并数据
      const first = this.ensureAccountStats(summary.accountsList[0].id);
      activeStats = {
        ...first,
        earned: summary.totalEarned,
        balance: summary.totalBalance,
        streakDays: summary.maxStreak,
        stamps: summary.stamps
      };
    }

    // 打卡明细按账号过滤：单账号视图只保留该账号的记录，汇总视图返回全部
    const allTimeline = logger.getTimeline();
    let timeline = allTimeline;
    if (accountId && accountId !== 'all') {
      const targetName = (configManager.getAccounts().find(a => a.id === accountId) || {}).name;
      if (targetName) {
        timeline = allTimeline.filter(t => (t.accountName || t.tag) === targetName);
      }
    }

    return {
      running: this.running,
      runningAccountId: this.runningAccountId,
      selectedAccountId: accountId || 'all',
      turboMode: this.isTurboMode(),
      summary,
      stats: activeStats,
      timeline
    };
  }

  stop() {
    if (this.running) {
      logger.log('🛑', '正在中断当前任务执行流程...');
      this.running = false;
      this.runningAccountId = null;
    }
    browserManager.stop();
  }

  isAccountPaused(accountId) {
    if (!accountId) return false;
    return configManager.findAccount(accountId)?.enabled === false;
  }

  /**
   * 运行中暂停账号：停止当前浏览器动作，剩余阶段由 runSingleAccount 的检查点跳过。
   * 其他账号的批次执行不受影响。
   */
  pauseAccount(accountId) {
    if (!accountId) return false;
    if (this.runningAccountId === accountId) {
      logger.log('⏸️', `账号 [${configManager.findAccount(accountId)?.name || accountId}] 已暂停，正在停止当前任务`, '', configManager.findAccount(accountId)?.name || accountId);
      browserManager.stop();
      return true;
    }
    return false;
  }

  /**
   * 领取 Dashboard 待领取额外积分
   */
  async claimPendingPoints(targetAccountId = 'all') {
    if (!accountContextLock.tryAcquire('web-action')) {
      throw new Error('已有任务正在执行，请稍后再领取额外积分');
    }
    const accounts = configManager.getAccounts().filter(a => a.enabled !== false && a.cookie);
    const targets = targetAccountId === 'all' ? accounts : accounts.filter(a => a.id === targetAccountId);
    let totalClaimed = 0;
    try {
      for (const acc of targets) {
        try {
          const blockReason = this.getAccountBlockReason(acc);
          if (blockReason) {
            logger.log('🛡️', `账号凭据异常，已跳过额外积分领取：${blockReason}`, acc.name);
            continue;
          }
          rewardsApi.setCurrentAccount(acc);
          const pts = await browserManager.claimDashboardPoints(acc);
          if (pts > 0) {
            totalClaimed += pts;
            const st = this.ensureAccountStats(acc.id);
            st.balance = (st.balance || 0) + pts;
            st.claimablePoints = 0;
            this.saveStats();
          }
        } catch {}
      }
      return totalClaimed;
    } finally {
      accountContextLock.release('web-action');
    }
  }

  /**
   * 单次安全测试搜索 (仅搜 1 次，检验按键输入流与积分变化)
   */
  async runSingleTestSearch(accountId = null) {
    // 必须用 resolveAccount：getAccount() 在 id 不存在时会回退到第一个账号，
    // 那样「测试副账号」可能实际跑在主账号上。
    const acc = configManager.resolveAccount(accountId);
    if (!acc) throw new Error('未找到对应账号');
    if (acc.enabled === false) throw new Error('账号已暂停，请先启用后再执行测搜');
    // 注意持有者标识必须与任务执行（'task-run'）不同：
    // 同一个标识会被当成「重入」而放行，那样任务跑着的时候照样能抢上下文。
    if (!accountContextLock.tryAcquire('web-action')) {
      throw new Error('已有任务正在执行，请稍后再试（避免账号上下文串台）');
    }
    try {
      rewardsApi.setCurrentAccount(acc);
      const storedBlockReason = this.getHardAccountBlockReason(acc);
      if (storedBlockReason) {
        throw new Error(`账号凭据异常，已拒绝执行：${storedBlockReason}`);
      }
      const readiness = await this.getSearchReadiness(acc);
      if (!readiness.ok) {
        throw new Error(`账号搜索条件未就绪，已拒绝执行：${readiness.reason}`);
      }
      const beforeInfo = readiness.info;
      const result = await browserManager.singleTestSearch(acc);
      // 搜索完成后同步一次最新官网数据（同一持有者，可重入）
      await this.syncAccountOfficialStatus(acc, { owned: true });
      const afterInfo = await rewardsApi.getRewardsInfo(1).catch(() => null);
      const beforeProgress = Number(beforeInfo?.pc?.progress);
      const afterProgress = Number(afterInfo?.pc?.progress);
      const credited = Number.isFinite(beforeProgress) && Number.isFinite(afterProgress)
        ? afterProgress > beforeProgress
        : null;
      return {
        ...result,
        before: Number.isFinite(beforeProgress) ? { progress: beforeProgress, max: Number(beforeInfo?.pc?.max || 0) } : null,
        after: Number.isFinite(afterProgress) ? { progress: afterProgress, max: Number(afterInfo?.pc?.max || 0) } : null,
        credited,
        message: credited === false
          ? '搜索已提交，但官网进度没有增加；该账号可能处于搜索观察期、搜索限流或市场不匹配'
          : (credited === true ? '搜索已提交，官网进度已增加' : result.message)
      };
    } finally {
      accountContextLock.release('web-action');
    }
  }

  /**
   * PC 搜索只依赖网页 Cookie 和官网返回的等级配额。
   * 缺少 _U、官网配额未知或未读取成功时必须拒绝，不能沿用旧进度或默认 60 分。
   */
  async getSearchReadiness(acc, options = {}) {
    if (!acc?.cookie) {
      return { ok: false, reason: '未配置网页端 Cookie' };
    }
    if (!webIdentityKey(acc.cookie)) {
      return { ok: false, reason: 'Cookie 缺少 _U 登录标识，搜索无法可靠关联到当前账号' };
    }

    const info = await rewardsApi.getRewardsInfo(1).catch(() => null);
    const quota = await this.resolveSearchQuota(acc, info, {
      ...options,
      probeMissing: options.probeMissing !== false,
      useCache: options.useCache === true
    });
    if (!quota.ok) return quota;
    return {
      ...quota,
      info: {
        ...(info || {}),
        pc: quota.pc,
        searchTier: quota.tier
      },
      reason: ''
    };
  }

  /**
   * 在执行任何移动端任务前校验 Token 归属。
   * 网页端余额与 DAPI 余额明显不一致时，Token 很可能属于另一个微软账号，
   * 必须直接拦住，不能把签到/阅读算到别人头上。
   */
  async checkMobileAccountBinding(acc, webBalance = null, options = {}) {
    const tokenOk = await authManager.refreshToken(false, acc.id, {
      allowPaused: options.allowPaused === true
    }).catch(() => false);
    if (!tokenOk) {
      return { tokenOk: false, mobileBalance: null, mismatch: false, message: '移动端 Token 未就绪或刷新失败' };
    }
    const mobileSnapshot = await rewardsApi.getMobileSnapshot().catch(() => null);
    const mobileBalance = toOptionalFiniteNumber(mobileSnapshot?.balance);
    const webUserName = configManager.extractUserNameFromCookie(acc.cookie || '');
    const mobileUserName = mobileSnapshot?.userName || '';
    const nameMatch = accountNamesLikelyMatch(webUserName, mobileUserName);
    const nameMismatch = nameMatch === false;
    const balanceMismatch = isBalanceMismatch(webBalance, mobileBalance);
    const mismatch = nameMismatch || balanceMismatch;
    const normalizedWebBalance = toOptionalFiniteNumber(webBalance);
    const hasWebBalance = normalizedWebBalance !== null && normalizedWebBalance >= 0;
    const balanceEvidence = hasWebBalance && Number.isFinite(Number(mobileBalance));
    const verified = tokenOk && !mismatch && (nameMatch === true || balanceEvidence);
    return {
      tokenOk: true,
      mobileBalance,
      mobileUserName,
      mismatch,
      verified,
      message: nameMismatch
        ? `移动端 Token 实际绑定到其他账号（Token 用户 ${mobileUserName || '未知'}，网页端 ${webUserName || '未知'}）`
        : (balanceMismatch
          ? `移动端 Token 实际绑定到其他账号（Token 余额 ${mobileBalance}，网页端余额 ${webBalance}）`
          : (!verified ? '无法确认移动端 Token 与当前 Cookie 属于同一账号' : ''))
    };
  }

  /** 已持久化的账号异常原因：定时任务和手动操作都应优先检查它。 */
  isAuthDiagnosisFresh(acc) {
    const diagnosis = acc?.authDiagnosis;
    return !diagnosis
      || !diagnosis.credentialUpdatedAt
      || !acc?.credentialUpdatedAt
      || Number(diagnosis.credentialUpdatedAt) === Number(acc.credentialUpdatedAt);
  }

  /** 只包含会阻止所有任务的网页凭据硬错误。 */
  getHardAccountBlockReason(acc) {
    if (acc?.enabled === false) return '账号已暂停';
    if (!acc?.cookie && !acc?.refreshToken) return '未配置 Cookie 或移动端 Token';
    const diagnosis = acc?.authDiagnosis;
    if (!this.isAuthDiagnosisFresh(acc)) return '';
    if (acc?.cookie && diagnosis?.cookieValid === false) {
      if (diagnosis.cookieTransient === true) return '';
      return diagnosis.cookieMessage || diagnosis.warningMessage || '网页端 Cookie 已失效';
    }
    return '';
  }

  /** 综合状态，用于界面与移动端操作；Token 异常不一定阻断 PC 搜索。 */
  getAccountBlockReason(acc) {
    const hardReason = this.getHardAccountBlockReason(acc);
    if (hardReason) return hardReason;
    const diagnosis = acc?.authDiagnosis;
    if (!this.isAuthDiagnosisFresh(acc)) return '';
    if (diagnosis?.cookieTransient === true) return '';
    if (diagnosis?.warning && diagnosis.warningMessage) return diagnosis.warningMessage;
    if (diagnosis?.overallValid === false) return diagnosis.warningMessage || 'Cookie 或 Token 状态异常';
    return '';
  }

  recordAccountCredentialBlock(acc, binding, balance = 0) {
    if (!acc?.id || !binding?.message) return;
    configManager.recordAuthDiagnosis(acc.id, {
      cookieValid: !!acc.cookie,
      tokenValid: false,
      overallValid: false,
      warning: true,
      warningMessage: binding.message,
      balance,
      cookieMessage: '',
      tokenMessage: binding.message
    });
  }

  /**
   * 手动执行前的实时校验：只要 Cookie/Token 任一异常，直接拒绝，
   * 不再盲目打开浏览器或提交任何任务。
   */
  async getLiveAccountBlockReason(acc) {
    if (acc?.enabled === false) return '账号已暂停';
    const stored = this.getAccountBlockReason(acc);
    if (stored) return stored;
    if (!acc?.cookie || !acc?.refreshToken) return '';

    const info = await rewardsApi.getRewardsInfo(1).catch(() => null);
    if (!info) return '无法读取微软官网状态，Cookie 可能已失效或网络异常';

    const binding = await this.checkMobileAccountBinding(acc, info.webBalance).catch(() => null);
    if (!binding?.tokenOk) return binding?.message || '移动端 Token 未就绪或刷新失败';
    if (binding.mismatch) {
      this.recordAccountCredentialBlock(acc, binding, info.balance);
      return binding.message;
    }
    if (binding.verified === false) return binding.message;
    return '';
  }

  /**
   * 只对官网确实返回“浏览器中的奖励”卡片的账号执行。
   * 每个账号每天最多尝试一次，完成状态必须由官网回读确认。
   */
  async runBrowserExtensionActivity(accCfg, options = {}) {
    const accStats = this.ensureAccountStats(accCfg.id);
    const definition = SPECIAL_ACTIVITIES.browserExtension;
    const task = accStats.tasks?.[definition.key];
    if (!task) {
      return {
        attempted: false,
        completed: false,
        alreadyDone: false,
        reason: 'not-present',
        message: '当前账号没有“浏览器中的奖励”任务'
      };
    }
    if (task.done) {
      return {
        attempted: false,
        completed: true,
        alreadyDone: true,
        reason: 'already-completed',
        message: '“浏览器中的奖励”任务已完成'
      };
    }
    if (options.ignoreCooldown !== true && isSpecialActivityAttemptedToday(task)) {
      return {
        attempted: false,
        completed: false,
        alreadyDone: false,
        reason: 'cooldown',
        message: '今天已经尝试过“浏览器中的奖励”，为避免重复上报已跳过'
      };
    }

    const activities = await rewardsApi.getSpecialActivities();
    if (!Array.isArray(activities)) {
      throw new Error('无法读取“浏览器中的奖励”任务状态');
    }
    const activity = findSpecialActivity(activities, definition.key);
    if (!activity) {
      delete accStats.tasks[definition.key];
      this.saveStats();
      return {
        attempted: false,
        completed: false,
        alreadyDone: false,
        reason: 'not-present',
        message: '官网当前没有“浏览器中的奖励”任务'
      };
    }
    if (activity.isCompleted === true) {
      this.syncSpecialActivities(accStats, activities);
      this.saveStats();
      return {
        attempted: false,
        completed: true,
        alreadyDone: true,
        reason: 'already-completed',
        message: '“浏览器中的奖励”任务已在官网完成'
      };
    }
    if (!browserManager.getExecutablePath()) {
      throw new Error('未检测到 Chromium 或 Edge 浏览器内核');
    }

    // 先落一次尝试标记。即使点击后浏览器异常退出，也不会在同一天再次重复上报。
    const attemptStartedAt = Date.now();
    this.updateTask(definition.key, {
      lastAttemptAt: attemptStartedAt,
      lastResult: 'attempting',
      statusMessage: '正在执行扩展任务上报'
    }, accCfg.id);

    const result = await browserManager.claimBrowserExtensionActivity(accCfg, activity);
    const now = Date.now();
    const attempted = result.attempted === true;
    let completed = result.completed === true || result.alreadyDone === true;
    if (!completed && attempted) {
      // 有些完成态只在重新请求官网时出现，卡片 DOM 可能已经被移除。
      const verifiedActivities = await rewardsApi.getSpecialActivities().catch(() => null);
      const verifiedActivity = findSpecialActivity(verifiedActivities, definition.key);
      if (verifiedActivity?.isCompleted === true) {
        completed = true;
        result.completed = true;
        result.afterCompleted = true;
      }
    }
    const patch = {
      lastAttemptAt: attempted ? attemptStartedAt : 0,
      lastReportStatus: result.reportStatus ?? null,
      lastVerifiedAt: completed ? now : Number(task.lastVerifiedAt || 0)
    };

    if (completed) {
      Object.assign(patch, {
        progress: 1,
        max: 1,
        points: definition.awardPoints,
        awardPoints: definition.awardPoints,
        done: true,
        lastResult: 'completed',
        cooldownUntil: 0,
        statusMessage: '官网已完成，30 分可能延迟入账'
      });
    } else if (result.notFound) {
      Object.assign(patch, {
        lastResult: 'not-found',
        statusMessage: '官网未找到可点击的扩展任务入口'
      });
    } else if (result.locked) {
      Object.assign(patch, {
        lastResult: 'locked',
        statusMessage: '扩展任务当前未解锁'
      });
    } else if (attempted) {
      Object.assign(patch, {
        lastResult: 'no-change',
        cooldownUntil: now + 24 * 60 * 60 * 1000,
        statusMessage: result.reportStatus === 200
          ? '官网已接收上报，等待完成状态同步'
          : '任务点击未确认完成，今天不再重复尝试'
      });
    } else {
      Object.assign(patch, {
        lastResult: 'not-attempted',
        statusMessage: '本次未执行扩展任务'
      });
    }

    this.updateTask(definition.key, patch, accCfg.id);
    await this.syncAccountOfficialStatus(accCfg, { owned: true });

    if (completed) {
      logger.log('✅', '“浏览器中的奖励”官网已确认完成，30 分可能延迟入账', '', accCfg.name);
      logger.addTimeline(accCfg.name, '浏览器扩展奖励任务已完成');
    } else if (attempted) {
      logger.log('🟡', '已点击“浏览器中的奖励”，官网尚未确认完成，今天不再重复尝试', '', accCfg.name);
    }

    return {
      attempted,
      completed,
      alreadyDone: result.alreadyDone === true,
      reportStatus: result.reportStatus ?? null,
      notFound: result.notFound === true,
      locked: result.locked === true,
      message: completed
        ? '“浏览器中的奖励”已在官网标记完成，30 分可能延迟入账'
        : (attempted
            ? '已执行一次扩展任务上报，官网暂未确认完成'
            : (result.notFound ? '官网未找到扩展任务入口' : '本次未执行扩展任务'))
    };
  }

  /**
   * 执行移动端 DAPI 返回的 sapphire 每日活动。
   * 这些任务通常不出现在 Web /earn 的 activityCards 中。
   */
  async runPendingAppPromotions(accCfg, options = {}) {
    const maxItems = Math.max(1, Number(options.maxItems || 20));
    const promotions = await rewardsApi.getAppPromotions();
    const sapphirePromotions = promotions.filter(isSapphireAppPromotion);
    const pending = getPendingSapphireAppPromotions(sapphirePromotions).slice(0, maxItems);
    const details = [];
    let completed = 0;
    let points = 0;

    if (pending.length === 0) {
      const allDone = sapphirePromotions.length > 0
        && sapphirePromotions.every(item => item.complete === true);
      const currentTask = this.ensureAccountStats(accCfg.id).tasks?.appPromotions || {};
      this.ensureAccountStats(accCfg.id).tasks.appPromotions = this.mergeMonotonicTask(currentTask, {
        name: '移动端每日活动',
        progress: sapphirePromotions.filter(item => item.complete === true).length,
        max: sapphirePromotions.length,
        points: sapphirePromotions
          .filter(item => item.complete === true)
          .reduce((sum, item) => sum + Math.max(0, Number(item.max || 0)), 0),
        unit: '项',
        icon: '📱',
        available: sapphirePromotions.length > 0,
        done: allDone,
        statusMessage: allDone ? '移动端每日活动已全部完成' : '移动端暂无待执行活动'
      });
      this.saveStats();
      return {
        attempted: 0,
        completed: 0,
        alreadyDone: allDone,
        total: sapphirePromotions.length,
        details
      };
    }

    logger.log('📱', `移动端每日活动发现 ${pending.length} 项待完成`, '', accCfg.name);
    for (const promotion of pending) {
      const result = await rewardsApi.claimAppPromotion(promotion);
      const ok = result?.success === true || result?.verified === true;
      if (ok) {
        completed++;
        points += Math.max(0, Number(result.points || promotion.max || 0));
        details.push(`${promotion.name || promotion.offerId} 已完成${result.points ? ` +${result.points} 积分` : ''}`);
        logger.log('✅', `移动端每日活动已完成: ${promotion.name || promotion.offerId}`, '', accCfg.name);
      } else {
        details.push(`${promotion.name || promotion.offerId} 未确认完成${result?.error ? `：${result.error}` : ''}`);
        logger.log('🟡', `移动端每日活动未确认: ${promotion.name || promotion.offerId}${result?.error ? ` (${result.error})` : ''}`, '', accCfg.name);
      }
      await rewardsApi.randomDelay(1200, 2400);
    }

    const afterPromotions = await rewardsApi.getAppPromotions().catch(() => promotions);
    const afterSapphire = afterPromotions.filter(isSapphireAppPromotion);
    const afterPending = getPendingSapphireAppPromotions(afterSapphire);
    const doneItems = afterSapphire.filter(item => item.complete === true);
    const allDone = afterSapphire.length > 0 && afterPending.length === 0;
    const currentTask = this.ensureAccountStats(accCfg.id).tasks?.appPromotions || {};
    this.ensureAccountStats(accCfg.id).tasks.appPromotions = this.mergeMonotonicTask(currentTask, {
      name: '移动端每日活动',
      progress: doneItems.length,
      max: afterSapphire.length,
      points: doneItems.reduce((sum, item) => sum + Math.max(0, Number(item.max || 0)), 0),
      unit: '项',
      icon: '📱',
      available: afterSapphire.length > 0,
      done: allDone,
      statusMessage: allDone
        ? '移动端每日活动已全部完成'
        : `待完成 ${afterPending.length} 项`
    });
    this.saveStats();

    return {
      attempted: pending.length,
      completed,
      points,
      total: afterSapphire.length,
      remaining: afterPending.length,
      alreadyDone: allDone,
      details
    };
  }

  /**
   * WebUI 任务卡片点击执行：每次只执行该卡片对应的一次动作。
   * 支持 sign / read / search / 打孔卡类任务。
   */
  async runTaskAction(accountId, taskKey) {
    const acc = configManager.resolveAccount(accountId);
    if (!acc) throw new Error('未找到对应账号');
    if (acc.enabled === false) throw new Error('账号已暂停，请先启用后再执行任务');
    if (!taskKey) throw new Error('缺少任务标识');
    if (!accountContextLock.tryAcquire('web-action')) {
      throw new Error('已有任务正在执行，请稍后再试（避免账号上下文串台）');
    }

    try {
      rewardsApi.setCurrentAccount(acc);
      const storedBlockReason = this.getHardAccountBlockReason(acc);
      if (storedBlockReason) {
        throw new Error(`账号凭据异常，已拒绝执行：${storedBlockReason}`);
      }
      if (taskKey === SPECIAL_ACTIVITIES.browserExtension.key) {
        if (!acc.cookie) throw new Error('当前账号未配置网页 Cookie，无法执行扩展奖励任务');
        const info = await rewardsApi.getRewardsInfo(1).catch(() => null);
        if (!info) throw new Error('无法读取微软官网状态，Cookie 可能失效或网络异常');
        const activity = findSpecialActivity(
          info.specialActivities,
          SPECIAL_ACTIVITIES.browserExtension.key
        );
        if (!activity) throw new Error('当前账号没有“浏览器中的奖励”任务');
        this.syncSpecialActivities(this.ensureAccountStats(acc.id), info.specialActivities);
        this.saveStats();
      } else if (taskKey === 'search') {
        const readiness = await this.getSearchReadiness(acc);
        if (!readiness.ok) {
          throw new Error(`账号搜索条件未就绪，已拒绝执行：${readiness.reason}`);
        }
      } else {
        const blockReason = await this.getLiveAccountBlockReason(acc);
        if (blockReason) {
          throw new Error(`账号凭据异常，已拒绝执行：${blockReason}`);
        }
      }
      const before = this.getStatus(acc.id).stats || {};
      const result = {
        taskKey,
        accountId: acc.id,
        accountName: acc.name,
        message: '',
        alreadyDone: false,
        hadFailure: false,
        details: [],
        before: {
          progress: Number(before?.tasks?.[taskKey]?.progress || 0),
          max: Number(before?.tasks?.[taskKey]?.max || 0),
          points: Number(before?.tasks?.[taskKey]?.points || 0)
        }
      };

      if (taskKey === 'sign') {
        const info = await rewardsApi.getRewardsInfo(1).catch(() => null);
        const webAppStatus = info?.streaks?.bingapp;
        const dapiAppStatus = webAppStatus?.isCurrentDayCompleted
          ? null
          : await rewardsApi.getAppCheckInStatus({ allowWebFallback: false }).catch(() => null);
        const appStatus = webAppStatus?.isCurrentDayCompleted
          ? webAppStatus
          : (dapiAppStatus || webAppStatus);
        if (appStatus?.isCurrentDayCompleted) {
          result.alreadyDone = true;
          result.message = `今日已签到（官网 App 连签 ${appStatus.completedDays || 0}/7 天）`;
        } else {
          let points = 0;
          const webBalance = toOptionalFiniteNumber(info?.webBalance);
          const binding = await this.checkMobileAccountBinding(acc, webBalance);
          if (binding.mismatch) {
            result.hadFailure = true;
            result.details.push(binding.message);
            result.details.push('已跳过 App 签到，避免把签到算到其他微软账号');
          } else if (!binding.tokenOk) {
            result.hadFailure = true;
            result.details.push(binding.message);
          } else if (binding.verified === false) {
            result.hadFailure = true;
            result.details.push(binding.message);
          } else {
            const appRes = await rewardsApi.signApp().catch(e => ({ error: e.message }));
            if (appRes && isBalanceMismatch(webBalance, appRes.balance)) {
              result.hadFailure = true;
              result.details.push(`App 端返回的账号余额 ${appRes.balance} 与网页端 ${webBalance} 不一致，已拒绝把本次签到计给当前账号`);
            } else if (appRes && Number(appRes.points || 0) > 0) {
              points += Number(appRes.points);
              result.details.push(`App 端签到成功 +${appRes.points} 积分`);
            } else if (appRes?.isDuplicate) {
              result.details.push('App 端今日已签到');
            } else {
              result.hadFailure = true;
              result.details.push(`App 端签到未生效${appRes?.error ? `：${appRes.error}` : ''}`);
            }
          }

          await this.syncAccountOfficialStatus(acc, { owned: true });
          const finalInfo = await rewardsApi.getRewardsInfo(1).catch(() => null);
          const finalApp = finalInfo?.streaks?.bingapp
            || await rewardsApi.getAppCheckInStatus({ allowWebFallback: false }).catch(() => null);
          if (finalApp?.isCurrentDayCompleted) {
            result.hadFailure = false;
            result.details.push(`官网 App 连签已确认：${finalApp.completedDays || 0}/7 天`);
          } else if (finalApp && !binding.mismatch && binding.tokenOk) {
            result.hadFailure = true;
            result.details.push('官网 App 连签仍未完成，请检查移动端授权');
          }
          result.message = result.hadFailure
            ? '签到部分完成，请查看明细'
            : (points > 0 ? `签到完成，本次获得 +${points} 积分` : '签到请求已完成');
        }
      } else if (taskKey === 'appPromotions') {
        const info = await rewardsApi.getRewardsInfo(1).catch(() => null);
        const webBalance = toOptionalFiniteNumber(info?.webBalance);
        const binding = await this.checkMobileAccountBinding(acc, webBalance);
        if (binding.mismatch) throw new Error(binding.message);
        if (!binding.tokenOk) throw new Error(binding.message);
        if (binding.verified === false) throw new Error(binding.message);

        const appResult = await this.runPendingAppPromotions(acc);
        result.details.push(...appResult.details);
        result.alreadyDone = appResult.alreadyDone === true;
        result.hadFailure = appResult.attempted > 0 && appResult.completed < appResult.attempted;
        if (appResult.attempted === 0) {
          result.message = appResult.alreadyDone
            ? '移动端每日活动已全部完成'
            : '当前没有可执行的移动端每日活动';
        } else if (appResult.completed > 0) {
          result.message = `移动端每日活动已推进 ${appResult.completed}/${appResult.attempted} 项`;
        } else {
          result.message = '移动端每日活动已提交，但 DAPI 尚未确认进度';
        }
        await this.syncAccountOfficialStatus(acc, { owned: true });
      } else if (taskKey === 'read') {
        const info = await rewardsApi.getRewardsInfo(1).catch(() => null);
        const webBalance = toOptionalFiniteNumber(info?.webBalance);
        const binding = await this.checkMobileAccountBinding(acc, webBalance);
        if (binding.mismatch) throw new Error(binding.message);
        if (!binding.tokenOk) throw new Error(binding.message);
        if (binding.verified === false) throw new Error(binding.message);
        const beforeRead = await rewardsApi.getReadProgress();
        const cur = Number(beforeRead?.progress || 0);
        const max = Number(beforeRead?.max || 30);
        if (cur >= max) {
          result.alreadyDone = true;
          result.message = `新闻阅读配额已打满（${cur}/${max}）`;
        } else {
          const readRes = await rewardsApi.doReadArticle();
          if (!readRes) throw new Error('新闻阅读上报失败');
          if (readRes.isDuplicate) {
            result.hadFailure = true;
            result.message = '今日新闻阅读已上报过，未重复计分';
            result.details.push('接口返回重复阅读，未计入进度');
          } else {
            await rewardsApi.randomDelay(2000, 4000);
            const afterRead = await rewardsApi.getReadProgress();
            const after = Number(afterRead?.progress || Math.min(max, cur + 3));
            this.updateTask('read', {
              progress: after,
              max,
              points: after,
              done: after >= max
            }, acc.id);
            result.message = `阅读完成，进度 ${cur}/${max} → ${after}/${max}`;
            result.details.push(`单篇阅读 +${readRes.points || 3} 积分`);
          }
        }
      } else if (taskKey === 'search') {
        const searchResult = await browserManager.singleTestSearch(acc);
        await this.syncAccountOfficialStatus(acc, { owned: true });
        result.message = searchResult?.message || '单次搜索完成';
        result.details.push('已完成一次拟人键盘搜索与官网进度同步');
      } else if (taskKey === SPECIAL_ACTIVITIES.browserExtension.key) {
        const extensionResult = await this.runBrowserExtensionActivity(acc);
        result.alreadyDone = extensionResult.alreadyDone === true;
        result.hadFailure = extensionResult.attempted === true && extensionResult.completed !== true;
        result.message = extensionResult.message;
        if (extensionResult.reportStatus) {
          result.details.push(`官网活动上报状态: HTTP ${extensionResult.reportStatus}`);
        }
      } else if (taskKey === 'dailySet' || taskKey === 'promos') {
        const category = taskKey === 'dailySet' ? 'dailyset' : 'promo';
        const allCards = await rewardsApi.discoverCards({
          retryEmpty: true,
          attempts: 3,
          onRetry: async ({ attempt, attempts, delayMs }) => {
            const delayText = delayMs > 0 ? `${Math.max(1, Math.round(delayMs / 1000))} 秒后` : '立即';
            logger.log('🟡', `活动卡片暂未读取到，${delayText}重试 (${attempt}/${attempts})`, acc.name);
          }
        });
        const cards = allCards.filter(c => c.category === category);

        if (cards.length === 0) {
          if (taskKey === 'dailySet') {
            const info = await rewardsApi.getRewardsInfo(1).catch(() => null);
            const streak = info?.streaks?.dailyset;
            if (streak?.isCurrentDayCompleted) {
              result.alreadyDone = true;
              result.message = `每日活动集已完成（${streak.activitiesCompleted || 0}/${streak.activitiesTotal || 3}）`;
            } else {
              result.message = '当前暂无可执行的 Daily Set 活动（可能尚未解锁或已完成）';
            }
          } else {
            const cardStatus = await rewardsApi.getActivityCardStatus().catch(() => null);
            if (cardStatus && cardStatus.total > 0 && cardStatus.completed >= cardStatus.total) {
              result.alreadyDone = true;
              result.message = `活动卡片已全部完成（${cardStatus.completed}/${cardStatus.total}）`;
            } else {
              result.message = '当前暂无可执行的活动卡片（可能尚未解锁或已完成）';
            }
          }
        } else {
          let okCount = 0;
          let claimedPoints = 0;
          for (const card of cards) {
            const claimed = await rewardsApi.claimCard(card);
            if (!claimed) {
              result.hadFailure = true;
              result.details.push(`未完成：${card.title || card.offerId}`);
              continue;
            }
            okCount++;
            claimedPoints += Number(card.points || 0);
            result.details.push(`${card.title || card.offerId} +${Number(card.points || 0)} 积分`);
            await rewardsApi.randomDelay(1800, 3500);
          }

          if (taskKey === 'promos') {
            const currentPromo = before?.tasks?.promos || {};
            const promoMax = Math.max(Number(currentPromo.max || 0), cards.length);
            const nextProgress = Math.min(promoMax, Number(currentPromo.progress || 0) + okCount);
            this.updateTask('promos', {
              progress: nextProgress,
              max: promoMax,
              points: Number(currentPromo.points || 0) + claimedPoints,
              done: nextProgress >= promoMax
            }, acc.id);
          }

          const synced = await this.syncAccountOfficialStatus(acc, { owned: true });
          if (taskKey === 'dailySet' && !synced) {
            const nextProgress = Math.min(Number(before?.tasks?.dailySet?.max || 3) || 3, Number(before?.tasks?.dailySet?.progress || 0) + okCount);
            this.updateTask('dailySet', {
              progress: nextProgress,
              max: Number(before?.tasks?.dailySet?.max || 3) || 3,
              points: nextProgress >= (Number(before?.tasks?.dailySet?.max || 3) || 3) ? 30 : 0,
              done: nextProgress >= (Number(before?.tasks?.dailySet?.max || 3) || 3)
            }, acc.id);
          }
          result.message = okCount > 0
            ? `已推进 ${okCount} 个可完成活动`
            : '已刷新状态，当前没有可点击完成的活动';
        }
      } else if (taskKey === 'desktopApp') {
        const beforeInfo = await rewardsApi.getRewardsInfo(1).catch(() => null);
        const beforeProgress = Number(beforeInfo?.desktopApp?.progress || before?.tasks?.desktopApp?.progress || 0);
        const desktopCards = (await rewardsApi.discoverCards({
          retryEmpty: true,
          attempts: 3,
          onRetry: async ({ attempt, attempts, delayMs }) => {
            const delayText = delayMs > 0 ? `${Math.max(1, Math.round(delayMs / 1000))} 秒后` : '立即';
            logger.log('🟡', `桌面任务暂未读取到，${delayText}重试 (${attempt}/${attempts})`, acc.name);
          }
        }))
          .filter(card => card.category === 'desktop');

        if (desktopCards.length === 0) {
          const current = await rewardsApi.getRewardsInfo(1).catch(() => null);
          const progress = Number(current?.desktopApp?.progress || beforeProgress);
          const max = Number(current?.desktopApp?.max || before?.tasks?.desktopApp?.max || 8) || 8;
          result.message = progress >= max
            ? `桌面奖励应用每周专属任务已完成（${progress}/${max}）`
            : `桌面奖励应用每周专属任务当前 ${progress}/${max}，其余任务尚未解锁或今天已经完成`;
          result.details.push('任务按天解锁，解锁后自动巡检会继续提交并回读官网进度');
        } else {
          let advanced = 0;
          for (const card of desktopCards) {
            const claimed = await rewardsApi.claimCard(card);
            if (!claimed) continue;
            await rewardsApi.randomDelay(1200, 2200);
            const current = await rewardsApi.getRewardsInfo(1).catch(() => null);
            const progress = Number(current?.desktopApp?.progress);
            if (!Number.isFinite(progress) || progress <= beforeProgress + advanced) {
              result.details.push(`提交已确认但官网进度未增加：${card.title || card.offerId}`);
              continue;
            }
            advanced++;
            result.details.push(`官网进度 ${progress}/${Number(current?.desktopApp?.max || 8) || 8}`);
          }
          result.message = advanced > 0
            ? `桌面奖励应用每周专属任务已推进 ${advanced} 项`
            : '桌面任务已提交，但官网尚未确认进度';
          result.hadFailure = advanced === 0;
        }
        await this.syncAccountOfficialStatus(acc, { owned: true });
      } else {
        const quests = await rewardsApi.getQuestPunchCards();
        const isDesktop = taskKey === 'desktopApp';
        const isHalloween = taskKey === 'quest_halloween';
        const isMonthly = taskKey === 'monthlyQuest';
        const configuredName = String(before?.tasks?.[taskKey]?.name || '');
        let quest = configuredName
          ? quests.find(q => {
              const title = String(q.title || '');
              return title === configuredName || title.includes(configuredName) || configuredName.includes(title);
            })
          : null;
        quest = quest || quests.find(q => {
          const title = String(q.title || '');
          if (isDesktop) return /桌面|RewardsApp/i.test(title) || /RewardsApp/i.test(q.questId || '');
          if (isHalloween) return /Halloween|万圣节/i.test(title) || /Halloween/i.test(q.questId || '');
          if (isMonthly) return /亮点|FY27|Monthly/i.test(title);
          return !q.done;
        }) || quests.find(q => !q.done);

        if (!quest || quest.done) {
          result.alreadyDone = true;
          result.message = '当前暂无可完成的任务（按钮可能尚未解锁或已完成）';
        } else {
          const taskState = before?.tasks?.[taskKey] || {};
          const questRes = await browserManager.runQuestPunchCards(acc, [{
            ...quest,
            runtimeState: taskState.subtaskState && typeof taskState.subtaskState === 'object'
              ? taskState.subtaskState
              : {}
          }]);
          if (questRes?.subtaskUpdates && Object.keys(questRes.subtaskUpdates).length > 0) {
            const task = this.ensureAccountStats(acc.id).tasks?.[taskKey];
            if (task) {
              task.subtaskState = {
                ...(task.subtaskState && typeof task.subtaskState === 'object' ? task.subtaskState : {}),
                ...questRes.subtaskUpdates
              };
            }
          }
          if (questRes?.details?.length) {
            this.recordPunchCardSteps(acc.id, questRes.details);
            result.details.push(...questRes.details.map(d => d.stepName || '完成一个子任务'));
          }
          await this.syncAccountOfficialStatus(acc, { owned: true });
          result.message = questRes?.completed > 0
            ? `已推进 ${questRes.completed} 个可完成子任务`
            : (questRes?.attempted > 0
                ? `已尝试 ${questRes.attempted} 个子任务，官网未确认进度，已进入冷却`
                : '已刷新任务状态，当前没有可点击完成的按钮');
        }
      }

      const after = this.getStatus(acc.id).stats || {};
      result.after = {
        progress: Number(after?.tasks?.[taskKey]?.progress || 0),
        max: Number(after?.tasks?.[taskKey]?.max || 0),
        points: Number(after?.tasks?.[taskKey]?.points || 0)
      };
      return result;
    } finally {
      accountContextLock.release('web-action');
    }
  }

  /**
   * 记录打孔卡完成步数历史 (精确记录时间戳与任务名)
   */
  recordPunchCardSteps(accountId, details = []) {
    const accStats = this.ensureAccountStats(accountId);
    if (!accStats.tasks) return;
    for (const d of details) {
      let targetTask = null;
      for (const [key, t] of Object.entries(accStats.tasks)) {
        if (t && (t.isPunchCard || key === 'desktopApp' || key === 'monthlyQuest' || key.startsWith('quest_'))) {
          if (t.name === d.title || (d.title && t.name.includes(d.title)) || (d.title && d.title.includes(t.name))) {
            targetTask = t;
            break;
          }
        }
      }
      if (!targetTask) {
        const isDesktop = (d.title || '').includes('桌面') || (d.questId || '').includes('RewardsApp');
        const isHalloween = (d.title || '').includes('Halloween') || (d.questId || '').includes('Halloween');
        const key = isDesktop ? 'desktopApp' : (isHalloween ? 'quest_halloween' : 'monthlyQuest');
        if (!accStats.tasks[key]) {
          accStats.tasks[key] = {
            name: d.title || (isDesktop ? '桌面应用每周专属任务' : '活动打孔卡'),
            progress: 0,
            max: isDesktop ? 8 : (isHalloween ? 6 : 5),
            points: isDesktop ? 20 : 50,
            unit: '个任务',
            icon: isHalloween ? '🎃' : (isDesktop ? '🖥️' : '🎯'),
            expiresText: '',
            available: true,
            done: false,
            stepLogs: [],
            isPunchCard: true
          };
        }
        targetTask = accStats.tasks[key];
      }
      const task = targetTask;
      if (task) {
        this.normalizePunchCardTask(task);
        if (!Array.isArray(task.stepLogs)) task.stepLogs = [];
        if (d.verified !== true) continue;
        const max = Number(task.max || 1) || 1;
        const step = Number(d.progressAfter);
        if (!Number.isFinite(step) || step <= 0 || step > max) continue;
        if (task.stepLogs.some(log => Number(log?.step) === step)) continue;
        task.stepLogs.push({
          step,
          at: d.at || Date.now(),
          name: d.stepName || `第 ${step} 步`
        });
        task.stepLogs.sort((a, b) => Number(a.step) - Number(b.step));
        // progressAfter 来自回读后的官网页面；这里只吸收官网确认过的进度，
        // 不再按“点击一次 +1”伪造完成。
        task.progress = Math.max(Number(task.progress || 0), Math.min(max, step));
        task.done = task.progress >= max;
        this.normalizePunchCardTask(task);
      }
    }
    this.saveStats();
  }

  /**
   * 为单个账号执行全套打卡任务
   */
  async runSingleAccount(accCfg, globalCfg, options = {}) {
    const accountId = accCfg.id;
    const accountName = accCfg.name || accountId;
    const isTurbo = options.turbo === true;
    if (this.isAccountPaused(accountId)) {
      logger.log('⏸️', `账号 [${accountName}] 已暂停，跳过自动执行`, '', accountName);
      return;
    }
    this.runningAccountId = accountId;
    const accStats = this.ensureAccountStats(accountId);

    // 切换当前 API 执行上下文到该账号
    rewardsApi.setCurrentAccount(accCfg);
    // 切换日志账号上下文：该账号下未显式传账号名的日志也会自动带上账号名
    logger.setAccountContext(accountName);

    logger.log('👤', `>>> 开始执行账号 [${accountName}] 的自动化打卡任务 <<<`, accountName);

    // 1. 运行前先从官方同步一次真实进度（确保增量起点100%准确）
    const initialSync = await this.syncAccountOfficialStatus(accCfg, { owned: true });
    const initialBlockReason = this.getHardAccountBlockReason(accCfg);
    if (initialBlockReason) {
      logger.log('🛡️', `账号凭据异常，已跳过本次自动化任务：${initialBlockReason}`, accountName);
      return;
    }
    if (!initialSync) {
      logger.log('🛡️', '无法读取微软官网状态，已跳过本次自动化任务，避免盲目重试', accountName);
      return;
    }

    // 2. 检查是否所有任务今日均已达标完成
    const taskValues = Object.values(accStats.tasks || {});
    const isAllDone = taskValues.length > 0 && taskValues.every(t => (
      t.available === false || t.done || (t.max > 0 && t.progress >= t.max)
    ));
    if (isAllDone && !globalCfg.tasks?.keepRunning) {
      logger.log('💤', `账号 [${accountName}] 今日所有打卡任务已全部满额达成，无需重复执行，直接结束！`, '', accountName);
      return;
    }

    // syncAccountOfficialStatus 已优先从网页端拿到真实余额；只有它没拿到时才回退 DAPI。
    const startBalance = Number(accStats.balance) > 0 ? Number(accStats.balance) : await rewardsApi.getBalance();
    const runStartBalance = Number.isFinite(Number(startBalance)) ? Number(startBalance) : null;
    // 每天只记录一次「今日起始余额」，用日期字段判断，
    // 不再用 `startBalance === 0` 判断（余额恰好为 0 的账号会被反复覆盖）
    if (startBalance !== null) {
      if (accStats.startBalanceDate !== this.getTodayNum()) {
        accStats.startBalance = startBalance;
        accStats.startBalanceDate = this.getTodayNum();
      }
      accStats.balance = startBalance;
    }
    this.saveStats();
    logger.log('📊', `当前积分: ${accStats.balance}`, accountName);

    // 检查或刷新 Token，并确认它确实属于当前网页 Cookie 账号
    const pairingWebBalance = toOptionalFiniteNumber(accStats.webBalance);
    const binding = await this.checkMobileAccountBinding(accCfg, pairingWebBalance);
    const tokenOk = binding.tokenOk && !binding.mismatch && binding.verified !== false;
    if (binding.mismatch) {
      logger.log('🔴', `${binding.message}；将跳过 App 签到与移动端阅读`, accountName);
    } else if (!tokenOk) {
      logger.log('🟡', `${binding.message || '移动端 OAuth Token 未就绪'}，将跳过 App 签到与阅读任务`, accountName);
    }

    // 1. 移动端签到 (若官网已确认则直接跳过)
    if (globalCfg.tasks?.sign && this.running) {
      if (accStats.tasks.sign?.done) {
        logger.log('✅', '移动端签到已完成，跳过', accountName);
      } else {
        let signPoints = 0;
        let signSuccess = false;

        if (tokenOk) {
          const appRes = await rewardsApi.signApp();
          if (appRes && isBalanceMismatch(startBalance, appRes.balance)) {
            logger.log('🔴', `App 端返回的账号余额 ${appRes.balance} 与网页端 ${startBalance} 不一致，已拒绝本次签到`, accountName);
          } else if (appRes && Number(appRes.points || 0) > 0) {
            signSuccess = true;
            signPoints += Number(appRes.points);
            logger.log('📱', `App 端静默签到成功 +${appRes.points} 积分`, accountName);
          } else if (appRes && appRes.isDuplicate) {
            signSuccess = true;
            logger.log('📱', 'App 端今日已签到过，跳过', accountName);
          } else if (appRes) {
            // 接口既没返积分也没报重复：无法区分「今天已经签过」还是「根本没签成」，
            // 直接读官网「必应应用连续打卡」的真实状态来判定，不凭猜测标已完成。
            await rewardsApi.randomDelay(isTurbo ? 300 : 1500, isTurbo ? 600 : 3000);
            const appStatus = await rewardsApi.getAppCheckInStatus();
            if (appStatus?.isCurrentDayCompleted) {
              signSuccess = true;
              logger.log('📱', `App 端签到已生效（官网连签第 ${appStatus.currentDay || 1} 天）`, accountName);
            } else {
              const progressText = appStatus ? `${appStatus.completedDays || 0}/7 天` : '状态未知';
              logger.log('🟡', `App 端签到未生效：官网「必应应用连续打卡」仍为 ${progressText}${appRes.error ? `（${appRes.error}）` : ''}`, accountName);
            }
          } else {
            logger.log('🟡', 'App 端签到未成功（Token 或接口异常），下次巡检会自动重试', accountName);
          }
        }

        if (signSuccess) {
          this.updateTask('sign', {
            progress: 1,
            max: 1,
            points: signPoints || accStats.tasks.sign?.points || 10,
            done: true
          }, accountId);
          logger.addTimeline(accountName, `移动端签到完成 (+${signPoints || 10} 积分)`);
        }
      }

      // 移动端签到必须以官网「必应应用连续打卡」为准。
      await this.syncAccountOfficialStatus(accCfg, { owned: true });
    }

    if (!this.running || this.isAccountPaused(accountId)) return;

    // 2. 新闻资讯自动阅读 (严格增量模式：缺几篇读几篇)
    if (globalCfg.tasks?.read && tokenOk && this.running) {
      const readInfo = await rewardsApi.getReadProgress();
      const cur = readInfo?.progress || accStats.tasks.read?.progress || 0;
      const max = readInfo?.max || accStats.tasks.read?.max || 30;

      if (cur >= max) {
        logger.log('✅', `新闻阅读配额今日已打满 (${cur}/${max})，跳过`, accountName);
        this.updateTask('read', { progress: max, max, points: max, done: true }, accountId);
      } else {
        const remaining = Math.min(max - cur, 10);
        logger.log('📖', `今日还需阅读 ${remaining} 篇新闻资讯 (当前进度 ${cur}/${max})`, accountName);
        let okCount = 0;
        for (let i = 0; i < remaining && this.running && !this.isAccountPaused(accountId); i++) {
          const res = await rewardsApi.doReadArticle();
          if (res && !res.isDuplicate) {
            okCount++;
            logger.log('📖', `阅读完成第 ${i + 1}/${remaining} 篇 (+${res.points || 3} 积分)`, accountName);
            // 实时写入进度：否则整个阅读过程（约 1 分钟）界面会一直停在 0/30
            const liveProg = Math.min(max, cur + okCount * 3);
            this.updateTask('read', {
              progress: liveProg,
              max,
              points: liveProg,
              done: liveProg >= max
            }, accountId);
          } else if (res?.isDuplicate) {
            logger.log('🟡', `第 ${i + 1}/${remaining} 篇阅读被接口判为重复，未计入进度`, accountName);
            break;
          }
          await rewardsApi.randomDelay(isTurbo ? 300 : 3000, isTurbo ? 600 : 6000);
        }
        const finalRead = await rewardsApi.getReadProgress();
        const finalProg = finalRead?.progress || (cur + okCount * 3);
        this.updateTask('read', { progress: finalProg, max, points: finalProg, done: finalProg >= max }, accountId);
        logger.addTimeline(accountName, `新闻阅读完成 ${finalProg}/${max}`);
      }
    }

    if (!this.running || this.isAccountPaused(accountId)) return;

    // 2.5 移动端 DAPI 每日活动（新版 App 的三张 +10 卡片）。
    const wantAppPromotions = globalCfg.tasks?.appPromotions !== false;
    if (wantAppPromotions && tokenOk && this.running) {
      try {
        const appResult = await this.runPendingAppPromotions(accCfg);
        if (appResult.attempted > 0) {
          logger.addTimeline(accountName, `移动端每日活动推进 ${appResult.completed}/${appResult.attempted} 项`);
        }
      } catch (e) {
        logger.log('🟡', `移动端每日活动执行异常: ${e.message}`, '', accountName);
      }
    }

    if (!this.running || this.isAccountPaused(accountId)) return;

    // 3. 活动卡片 / 每日活动集 / 桌面端打孔卡（三个真正独立的开关）
    const wantDailySet = globalCfg.tasks?.dailySet !== false;
    const wantDesktop = globalCfg.tasks?.desktopApp !== false;
    const wantPromos = globalCfg.tasks?.promos !== false;
    if ((wantPromos || wantDailySet || wantDesktop) && this.running) {
      logger.log('🧩', '正在扫描活动卡片与日常活动...', accountName);
      const allCards = await rewardsApi.discoverCards({
        retryEmpty: true,
        attempts: 3,
        onRetry: async ({ attempt, attempts, delayMs }) => {
          const delayText = delayMs > 0 ? `${Math.max(1, Math.round(delayMs / 1000))} 秒后` : '立即';
          logger.log('🟡', `活动卡片暂未读取到，${delayText}重试 (${attempt}/${attempts})`, accountName);
        }
      });
      // 按分类过滤：dailyset=每日活动集，desktop=桌面端打孔卡，其余归 promos
      const cards = allCards.filter(c => {
        if (c.category === 'dailyset') return wantDailySet;
        if (c.category === 'desktop') return wantDesktop;
        return wantPromos;
      });

      if (cards.length > 0) {
        logger.log('🧩', `发现 ${cards.length} 个待处理活动卡片`, accountName);
        let cardOk = 0;
        let claimedPoints = 0;
        let desktopOk = 0;
        let promoOk = 0;
        let promoTotal = 0;
        for (const card of cards) {
          if (card.category === 'promo') promoTotal++;
        }

        for (const card of cards) {
          if (!this.running || this.isAccountPaused(accountId)) break;
          logger.log('🧩', `执行卡片打卡: [${card.kind}] ${card.title} (+${card.points}分)`, accountName);
          await rewardsApi.randomDelay(isTurbo ? 400 : 2500, isTurbo ? 800 : 5000);
          const desktopBefore = card.category === 'desktop'
            ? Number(this.ensureAccountStats(accountId).tasks?.desktopApp?.progress || 0)
            : 0;
          const claimed = await rewardsApi.claimCard(card);
          if (!claimed) continue;

          if (card.category === 'desktop') {
            await rewardsApi.randomDelay(isTurbo ? 300 : 1200, isTurbo ? 600 : 2200);
            const official = await rewardsApi.getRewardsInfo(1).catch(() => null);
            const desktopAfter = Number(official?.desktopApp?.progress);
            if (!Number.isFinite(desktopAfter) || desktopAfter <= desktopBefore) {
              logger.log(
                '🟡',
                `桌面任务已提交但官网进度未变化（${desktopBefore}/${Number(official?.desktopApp?.max || 8) || 8}），本次不计入`,
                '',
                accountName
              );
              continue;
            }
            cardOk++;
            claimedPoints += Number(card.points || 0);
            desktopOk++;
            const currentTask = this.ensureAccountStats(accountId).tasks?.desktopApp || {};
            this.ensureAccountStats(accountId).tasks.desktopApp = this.mergePunchCardTask(currentTask, {
              ...currentTask,
              ...official.desktopApp,
              progress: desktopAfter,
              max: Number(official.desktopApp.max || 8) || 8,
              cycleKey: official.desktopApp.questId || currentTask.cycleKey || card.parentQuestId || '',
              points: desktopAfter >= Number(official.desktopApp.max || 8) ? 20 : 0,
              isPunchCard: true,
              unit: '个任务'
            });
            this.saveStats();
          } else if (card.category === 'promo') {
            cardOk++;
            claimedPoints += Number(card.points || 0);
            promoOk++;
            // 实时更新卡片进度，避免整个扫描过程界面停在 0/x
            this.updateTask('promos', {
              progress: promoOk,
              max: promoTotal,
              points: claimedPoints,
              done: promoTotal > 0 && promoOk >= promoTotal
            }, accountId);
          } else {
            cardOk++;
            claimedPoints += Number(card.points || 0);
          }
        }

        if (promoTotal > 0) {
          // 只有全部卡片都成功打卡才算完成，且积分只记「确实领到的那些」
          this.updateTask('promos', {
            progress: promoOk,
            max: promoTotal,
            points: claimedPoints,
            done: promoOk >= promoTotal
          }, accountId);
        }
        // 注意：这里不再无条件给 dailySet 记 3/3 +30 分。
        // 每日活动集的真实状态由 syncAccountOfficialStatus() 按官网数据写入。
        logger.addTimeline(accountName, `完成活动卡片 ${cardOk}/${cards.length} 项`);
      } else {
        // 一张都没扫到：用官网 activityCards 的真实完成情况判断，
        // 不再无脑标成「已完成 +10 分」（那正是虚高分数的来源之一）。
        const cardStatus = await rewardsApi.getActivityCardStatus();
        const currentPromos = this.ensureAccountStats(accountId).tasks?.promos || {};
        if (cardStatus && cardStatus.completed >= cardStatus.total) {
          logger.log('✅', `今日活动卡片已全部完成 (${cardStatus.completed}/${cardStatus.total})`, accountName);
          this.ensureAccountStats(accountId).tasks.promos = this.mergeMonotonicTask(currentPromos, {
            ...currentPromos,
            progress: cardStatus.completed,
            max: cardStatus.total,
            points: Number(currentPromos.points || 0),
            done: true,
            statusMessage: ''
          });
          this.saveStats();
        } else {
          const detail = cardStatus ? `（官网显示 ${cardStatus.completed}/${cardStatus.total}）` : '（未能读取官网状态）';
          logger.log('ℹ️', `今日未发现可执行的活动卡片${detail}，保持未完成状态，不记分`, accountName);
          if (cardStatus) {
            this.ensureAccountStats(accountId).tasks.promos = this.mergeMonotonicTask(currentPromos, {
              ...currentPromos,
              progress: Number(cardStatus.completed || 0),
              max: Number(cardStatus.total || 0),
              points: Number(currentPromos.points || 0),
              done: false,
              statusMessage: `官网活动进度 ${cardStatus.completed}/${cardStatus.total}`
            });
            this.saveStats();
          } else {
            // 页面瞬时读取失败不能把已确认进度清零。
            this.updateTask('promos', {
              statusMessage: '官网活动状态暂不可读，保留上次已确认进度'
            }, accountId);
          }
        }
      }

      // 活动卡片流程结束后主动同步一次官网，避免 Daily Set/桌面任务仍显示旧缓存。
      if ((wantDailySet || wantDesktop) && this.running && !this.isAccountPaused(accountId)) {
        const synced = await this.syncAccountOfficialStatus(accCfg, { owned: true });
        if (!synced) {
          logger.log('🟡', '活动卡片完成后官网状态同步失败，保留上次已确认进度', accountName);
        }
      }
    }

    if (!this.running || this.isAccountPaused(accountId)) return;

    // 3.5 特殊活动：只处理官网实际返回该卡片的账号。
    //     当前支持“浏览器中的奖励”，没有该 offerId 的账号不会启动浏览器。
    const extensionTask = this.ensureAccountStats(accountId).tasks?.browserExtension;
    if (wantPromos && extensionTask && !extensionTask.done && this.running) {
      try {
        await this.runBrowserExtensionActivity(accCfg);
      } catch (e) {
        logger.log('🟡', `“浏览器中的奖励”处理异常: ${e.message}`, '', accountName);
      }
    }

    if (!this.running || this.isAccountPaused(accountId)) return;

    // 4. 必应 PC 搜索任务与仪表盘同步
    const info = await rewardsApi.getRewardsInfo();
    if (info) {
      if (info.desktopApp) {
        const dProgress = Number(info.desktopApp.progress ?? 0);
        const dMax = Number(info.desktopApp.max ?? 8) || 8;
        const previousDesktop = this.ensureAccountStats(accountId).tasks?.desktopApp || {};
        this.ensureAccountStats(accountId).tasks.desktopApp = this.mergePunchCardTask(previousDesktop, {
          ...previousDesktop,
          name: info.desktopApp.title || previousDesktop.name || '桌面应用每周专属任务',
          cycleKey: info.desktopApp.questId || previousDesktop.cycleKey || '',
          progress: dProgress,
          max: dMax,
          expiresText: info.desktopApp.expiresText || '',
          points: dProgress >= dMax ? 20 : 0,
          available: info.desktopApp.available !== false,
          done: dProgress >= dMax,
          isPunchCard: true,
          unit: '个任务'
        });
        this.saveStats();
      }
      if (info.stamps) {
        accStats.stamps = info.stamps;
      }
    }

    if (globalCfg.tasks?.search && this.running) {
      const quota = await this.resolveSearchQuota(accCfg, info, {
        attempts: 4,
        shouldStop: () => !this.running || this.isAccountPaused(accountId),
        onRetry: async ({ attempt, attempts, delayMs }) => {
          const delayText = delayMs > 0 ? `${Math.max(1, Math.round(delayMs / 1000))} 秒后` : '立即';
          logger.log('🟡', `搜索配额暂未返回，${delayText}重试 (${attempt}/${attempts})`, accountName);
        }
      });
      if (!quota.ok) {
        if (quota.stopped) {
          logger.log('🛑', '已停止搜索配额重试，不再等待剩余退避时间', accountName);
          return;
        }
        logger.log('🛡️', `${quota.reason}，本轮跳过 PC 搜索，不沿用旧进度或默认 60 分`, accountName);
        this.updateTask('search', {
          statusMessage: `${quota.reason}，已暂停搜索`,
          searchQuotaErrorAt: Date.now()
        }, accountId);
      } else {
        const curSearch = Number(quota.progress || 0);
        const maxSearch = Number(quota.max);
        const searchTier = quota.tier;
        if (quota.cached) {
          const verifiedTime = new Date(quota.verifiedAt).toLocaleTimeString('zh-CN', { hour12: false });
          logger.log('🟡', `官网暂未返回配额，使用今日 ${verifiedTime} 已确认的官方配额 ${curSearch}/${maxSearch} 继续搜索，过程中仍会核验官网进度`, accountName);
        }
        let lastOfficialSearch = Number(curSearch) || 0;
        let searchAttempted = 0;
        // 进度只接受官网读数。读不到时保持原值，绝不按“每次 +3”估算。
        const applySearchProgress = (completed, total, meta = {}) => {
          searchAttempted = Math.max(searchAttempted, Number(completed) || 0);
          const official = Number(meta.officialProgress);
          if (!Number.isFinite(official)) return;
          lastOfficialSearch = official;
          this.recordSearchQuotaVerification(accStats, { progress: official, max: maxSearch }, 'search-progress');
          this.updateTask('search', {
            progress: official,
            max: maxSearch,
            points: official,
            done: official >= maxSearch,
            searchTier,
            statusMessage: official >= maxSearch ? '' : `官网进度 ${official}/${maxSearch}，等待计分确认`
          }, accountId);
        };
        logger.log('🔍', `当前 PC 搜索配额: ${curSearch}/${maxSearch} (${searchTier.label})`, accountName);

        if (curSearch >= maxSearch) {
          logger.log('✅', 'PC 搜索配额已打满', accountName);
          this.updateTask('search', { progress: maxSearch, max: maxSearch, points: maxSearch, done: true, searchTier }, accountId);
        } else {
          const neededPoints = maxSearch - curSearch;
          const searchMode = globalCfg.tasks?.searchEngineMode || 'browser';
          const hasBrowser = !!browserManager.getExecutablePath();

          // 停滞保护：每搜完一次读一次官网真实进度，连续 5 次不涨就主动停手。
          // 搜索额度到顶（或账号被限流）时，继续搜只会白白增加风控暴露面。
          const probeSearchProgress = async () => {
            const probe = await rewardsApi.getRewardsInfo();
            const p = Number(probe?.pc?.progress);
            if (Number.isFinite(p)) {
              this.recordSearchQuotaVerification(accStats, { progress: p, max: maxSearch }, 'search-probe');
            }
            return Number.isFinite(p) ? p : null;
          };
          const stagnantLimit = normalizeStagnantLimit(globalCfg.tasks?.searchStagnantLimit);
          let searchRun = null;

          if (searchMode === 'browser' && hasBrowser) {
            try {
              searchRun = await browserManager.runPacedSearch(accCfg, neededPoints, {
                onProgress: applySearchProgress,
                probeProgress: probeSearchProgress,
                stagnantLimit,
                initialProgress: curSearch,
                turbo: isTurbo
              });
            } catch (e) {
              logger.log('🟡', `无头浏览器运行异常: ${e.message}，正在切换为轻量协议兜底`, '', accountName);
              searchRun = await this.fallbackHttpSearch(accCfg, neededPoints, curSearch, maxSearch, globalCfg, applySearchProgress, {
                probeProgress: probeSearchProgress,
                stagnantLimit,
                turbo: isTurbo
              });
            }
          } else {
            searchRun = await this.fallbackHttpSearch(accCfg, neededPoints, curSearch, maxSearch, globalCfg, applySearchProgress, {
              probeProgress: probeSearchProgress,
              stagnantLimit,
              turbo: isTurbo
            });
          }

          const afterInfo = await rewardsApi.getRewardsInfo();
          const officialValue = Number(afterInfo?.pc?.progress);
          const finalSearch = Number.isFinite(officialValue) ? officialValue : Math.max(curSearch, lastOfficialSearch);
          const noCredit = finalSearch <= curSearch && (searchRun?.completed || searchAttempted) > 0;
          this.updateTask('search', {
            progress: finalSearch,
            max: maxSearch,
            points: finalSearch,
            done: finalSearch >= maxSearch,
            searchTier,
            statusMessage: finalSearch >= maxSearch
              ? ''
              : (noCredit
                  ? '搜索请求已执行，但官网连续未计分；本轮已停止，建议 24 小时后再试'
                  : `官网进度 ${finalSearch}/${maxSearch}，等待计分确认`)
          }, accountId);
          if (noCredit) {
            logger.log('🟡', `PC 搜索请求已执行，但官网进度仍为 ${finalSearch}/${maxSearch}，本轮不再空跑`, '', accountName);
            logger.addTimeline(accountName, `PC 搜索未计分，官网仍为 ${finalSearch}/${maxSearch}`);
          } else {
            logger.addTimeline(accountName, `PC 搜索结束，官网配额 ${finalSearch}/${maxSearch}`);
          }
        }
      }
    }

    if (!this.running || this.isAccountPaused(accountId)) return;

    // 4.5 任务区打孔卡 (如「十月必看五大亮点」这类每天解锁一个的任务)
    //     旧版本完全没处理这类任务，导致官网上长期停在 0/5。
    if (globalCfg.tasks?.promos && this.running && browserManager.getExecutablePath()) {
      const cur = this.ensureAccountStats(accountId);
      const isManual = options.manual === true;
      const punchCards = Object.values(cur.tasks || {}).filter(t => t && t.isPunchCard);
      const isAllQuestsFinished = punchCards.length > 0 && punchCards.every(t => t.done);

      // 若全部打孔卡已经满额完成，自动巡检时不重复启动浏览器
      if (isAllQuestsFinished && !isManual) {
        // 全部已达成，静默跳过
      } else {
        // 冷却判定：手动触发时无视冷却立刻检查；自动巡检时若 2 小时内刚检查过且无新解锁则等待
        const lastCheck = cur.lastQuestCheckTime || 0;
        const cooldownMs = 2 * 60 * 60 * 1000;
        const inCooldown = !isManual && (Date.now() - lastCheck < cooldownMs);

        if (!inCooldown) {
          cur.lastQuestCheckTime = Date.now();
          try {
            const quests = await rewardsApi.getQuestPunchCards();
            const findTaskForQuest = (quest) => {
              const title = String(quest?.title || '');
              return Object.values(cur.tasks || {}).find(t => {
                if (!t || !(t.isPunchCard || t.name === title)) return false;
                const name = String(t.name || '');
                return name === title || name.includes(title) || title.includes(name);
              }) || null;
            };
            const pendingQuests = quests.filter(q => (
              !q.done && !/RewardsApp/i.test(String(q.questId || ''))
            )).map(q => {
              const task = findTaskForQuest(q);
              return {
                ...q,
                runtimeState: task?.subtaskState && typeof task.subtaskState === 'object'
                  ? task.subtaskState
                  : {}
              };
            });
            if (pendingQuests.length > 0) {
              const questRes = await browserManager.runQuestPunchCards(accCfg, pendingQuests);
              // 持久化“今日已尝试/冷却到明日”的子任务状态，避免同一天反复点击。
              for (const quest of pendingQuests) {
                const task = findTaskForQuest(quest);
                if (!task) continue;
                const updates = questRes.subtaskUpdates && typeof questRes.subtaskUpdates === 'object'
                  ? questRes.subtaskUpdates
                  : {};
                task.subtaskState = {
                  ...(task.subtaskState && typeof task.subtaskState === 'object' ? task.subtaskState : {}),
                  ...updates
                };
              }
              if (questRes.completed > 0) {
                logger.addTimeline(accountName, `任务打孔卡推进 ${questRes.completed} 项`);
                if (questRes.details && questRes.details.length > 0) {
                  this.recordPunchCardSteps(accountId, questRes.details);
                }
              } else if (questRes.attempted > 0) {
                logger.log('🟡', `任务打孔卡已尝试 ${questRes.attempted} 项，官网未确认进度，已进入冷却`, '', accountName);
              }
              // 无论是否推进，都同步一次官网真实状态。
              await this.syncAccountOfficialStatus(accCfg, { owned: true });
            }
            this.saveStats();
          } catch (e) {
            logger.log('🟡', `任务打孔卡处理异常: ${e.message}`, '', accountName);
          }
        }
      }
    }

    if (!this.running || this.isAccountPaused(accountId)) return;

    // 5. 连签检测与额外积分领取
    //    视觉搜索补签只在任务执行期尝试（每账号每天一次），读取进度的同步流程不再触发
    const streakInfo = await rewardsApi.checkStreak({ allowVisualSearchCheckIn: true });
    if (streakInfo?.streakDays) {
      accStats.streakDays = streakInfo.streakDays;
      logger.log('🔥', `连续打卡记录: ${accStats.streakDays} 天`, accountName);
    }
    const extraClaim = await this.claimExtraPointsAfterTasks(accCfg, accStats);

    // 6. 结算单账号总积分
    // 余额与「今日已增」都以官网为准：这里再取一次，把本轮新做的部分算进去
    const finalInfo = await rewardsApi.getRewardsInfo(1);
    if (finalInfo?.pc) {
      this.recordSearchQuotaVerification(accStats, finalInfo.pc, finalInfo.searchQuotaSource || 'final-sync');
    }
    const finalBalance = Number(finalInfo?.balance);
    if (Number.isFinite(finalBalance) && finalBalance > 0) {
      accStats.balance = finalBalance;
    } else {
      const endBalance = await rewardsApi.getBalance();
      if (endBalance !== null) accStats.balance = endBalance;
    }
    if (finalInfo?.claimablePoints !== undefined && !(extraClaim.claimed > 0)) {
      accStats.claimablePoints = Number(finalInfo.claimablePoints || 0);
    }
    this.applyEarned(accStats, finalInfo?.todayPoints);
    accStats.lastUpdate = Date.now();
    this.saveStats();

    const runEndBalance = toOptionalFiniteNumber(accStats.balance);
    const runEarned = runStartBalance !== null && runEndBalance !== null
      ? Math.max(0, runEndBalance - runStartBalance)
      : null;
    const runEarnedText = runEarned === null ? '--' : `+${runEarned}`;
    logger.log(
      '✅',
      `账号 [${accountName}] 任务完成！本轮新增: ${runEarnedText} | 今日累计: +${accStats.earned} | 当前余额: ${accStats.balance}`,
      accountName
    );
    return {
      accountId,
      accountName,
      startBalance: runStartBalance,
      endBalance: runEndBalance,
      runEarned,
      todayEarned: Number(accStats.earned || 0)
    };
  }

  /**
   * 单个账号完成全部任务后，立即检查并领取 Dashboard 额外积分。
   * 此方法运行在 task-run 上下文锁内，不能调用会重复抢锁的 Web API 方法。
   */
  async claimExtraPointsAfterTasks(acc, accStats) {
    if (!acc?.id || !accStats) return { pending: 0, claimed: 0 };
    const accountName = acc.name || acc.id;
    const currentPending = Math.max(0, Number(accStats.claimablePoints || 0));
    logger.log('🎁', '任务执行完毕，正在检查额外积分...', '', accountName);

    const latest = await rewardsApi.checkClaimablePoints({ logFound: false });
    const latestNumber = latest === null || latest === undefined || latest === '' ? NaN : Number(latest);
    const pending = Number.isFinite(latestNumber) ? Math.max(0, latestNumber) : currentPending;
    accStats.claimablePoints = pending;
    if (pending <= 0) {
      logger.log('✅', '当前没有待领取的额外积分', '', accountName);
      this.saveStats();
      return { pending: 0, claimed: 0 };
    }

    logger.log('🎁', `发现 ${pending} 点额外积分，正在自动领取...`, '', accountName);
    let claimed = 0;
    try {
      claimed = Number(await browserManager.claimDashboardPoints(acc) || 0);
    } catch (e) {
      logger.log('🟡', `额外积分自动领取异常: ${e.message}`, '', accountName);
    }

    if (claimed > 0) {
      accStats.claimablePoints = Math.max(0, pending - claimed);
      accStats.lastClaimAt = Date.now();
      accStats.lastClaimedPoints = claimed;
      logger.log('🎉', `额外积分领取成功 +${claimed} 分`, '', accountName);
      logger.addTimeline(accountName, `领取额外积分 +${claimed}`);
    } else {
      accStats.claimablePoints = pending;
      logger.log('🟡', `额外积分自动领取未确认，保留 ${pending} 点待领取状态`, '', accountName);
    }
    this.saveStats();
    return { pending, claimed };
  }

  async fallbackHttpSearch(accCfg, neededPoints, curSearch, maxSearch, globalCfg, onProgress = null, options = {}) {
    const accountName = accCfg.name || accCfg.id;
    const { probeProgress = null, stagnantLimit = 5, probeDelayMs = 12000 } = options;
    const isTurbo = options.turbo === true;
    // 与拟人模式共用同一套停滞保护
    const stagnation = new SearchStagnationGuard(stagnantLimit);
    stagnation.observe(Number(curSearch) || 0);
    // 每次搜索最多 +3 分，上限 20 次可覆盖单账号 60 分上限；
    // 旧实现写死最多 7 次（21 分），轻量模式下永远打不满搜索任务。
    const searchCount = Math.max(1, Math.min(Math.ceil(neededPoints / 3), 20));
    // 与拟人模式共用全局搜索节奏，并同样受 40 分钟搜索预算约束
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const wantedIntervalSec = isTurbo ? 2 : clamp(Number(globalCfg.tasks?.searchIntervalSec ?? 60) || 60, 60, 120);
    const jitterSec = isTurbo ? 1 : clamp(Number(globalCfg.tasks?.searchJitterSec ?? 60) || 60, 30, 60);
    const perSearchBudget = Math.floor((40 * 60) / searchCount);
    const intervalSec = isTurbo ? 2 : Math.max(60, Math.min(wantedIntervalSec, perSearchBudget - jitterSec));
    if (isTurbo) {
      logger.log('⚡', `[极速轻量模式] 计划执行 ${searchCount} 次搜索请求，间隔 2~3 秒`, '', accountName);
    } else {
      logger.log('🔍', `[轻量模式] 计划执行 ${searchCount} 次搜索请求，间隔 ${intervalSec} 秒 + 0~${jitterSec} 秒浮动`, '', accountName);
    }

    let completed = 0;
    let lastOfficial = Number(curSearch) || 0;
    let stoppedByStagnation = false;
    const usedQueries = new Set();
    for (let i = 0; i < searchCount && this.running && !this.isAccountPaused(accCfg.id); i++) {
      const word = await rewardsApi.getHotSearchWord({ exclude: usedQueries });
      usedQueries.add(word);
      logger.log('🔍', `[搜索 ${i + 1}/${searchCount}] 关键词: "${word}"`, '', accountName);
      await rewardsApi.doSearchOnce(word);
      completed++;

      const probeDelay = isTurbo ? 1500 : Math.max(5000, Number(probeDelayMs) || 12000);
      await rewardsApi.delay(probeDelay);
      let official = null;
      if (typeof probeProgress === 'function') {
        try {
          official = await probeProgress();
        } catch {}
      }
      if (Number.isFinite(Number(official))) lastOfficial = Number(official);

      // 轻量模式同样只回调官网进度，不做本地 +3 估算。
      if (typeof onProgress === 'function') {
        try {
          onProgress(i + 1, searchCount, {
            officialProgress: Number.isFinite(Number(official)) ? Number(official) : null,
            delta: Number.isFinite(Number(official)) ? Number(official) - Number(curSearch || 0) : 0
          });
        } catch {}
      }

      // 停滞保护：连续 N 次搜索官网进度不涨就停手
      if (typeof probeProgress === 'function') {
        const result = stagnation.observe(official);
        if (result.stagnant) {
          stoppedByStagnation = true;
          logger.log('🛑', `连续 ${result.stagnantCount} 次搜索官网进度没有增加（停留在 ${result.bestProgress} 分），主动停止本轮搜索`, '', accountName);
          break;
        }
      }

      if (i === searchCount - 1) break;
      const waitSec = intervalSec + rewardsApi.randomRange(0, jitterSec);
      if (isTurbo) {
        logger.log('⚡', `[极速轻量模式] 等待 ${waitSec} 秒...`, '', accountName);
      } else {
        logger.log('⏳', `等待 ${waitSec} 秒...`, '', accountName);
      }
      // 按 1 秒切片等待，让「停止」按钮能立即生效。
      // 旧实现是一次性 await 整个间隔，最长要等 900+300 秒才停得下来。
      for (let s = waitSec; s > 0 && this.running && !this.isAccountPaused(accCfg.id); s--) {
        await rewardsApi.delay(1000);
      }
    }
    return {
      completed,
      officialProgress: lastOfficial,
      stoppedByStagnation
    };
  }

  /**
   * 轮询执行全部账号或指定账号
   */
  async runAll(manual = false, targetAccountId = null) {
    if (this.running) {
      logger.log('🟡', '任务当前正在运行中，请勿重复触发！');
      return false;
    }

    // 抢占账号上下文锁：执行期间 WebUI 的同步 / 体检 / 测搜都会自动跳过，
    // 避免它们把全局 Cookie/Token 上下文切到别的账号，导致任务算错账号。
    const locked = await accountContextLock.acquire('task-run', 60000);
    if (!locked) {
      logger.log('🟡', '账号上下文正被其它操作占用，请稍后重试');
      return false;
    }

    this.running = true;
    logger.setAccountContext('');
    const startTime = Date.now();
    const activeTurbo = this.turboMode;
    if (this.turboMode) {
      this.turboMode = false;
      logger.log('⚡', '本次任务已启用【极速模式】（仅对本次任务生效，已自动重置为关闭状态）');
    }

    try {
      const globalCfg = configManager.get();
      // 没有 Cookie 也没有 Token 的账号直接跳过：
      // 否则它会在没有凭据的情况下执行，可能误用到别的账号的会话
      const allAccounts = configManager.getAccounts()
        .filter(a => a.enabled !== false && (a.cookie || a.refreshToken));
      const blockedAccounts = allAccounts
        .map(acc => ({ acc, reason: this.getHardAccountBlockReason(acc) }))
        .filter(item => item.reason);
      for (const { acc, reason } of blockedAccounts) {
        logger.log('🛡️', `账号凭据异常，定时任务已跳过 [${acc.name || acc.id}]：${reason}`, '', acc.name || acc.id);
      }
      const runnableAccounts = allAccounts.filter(acc => !this.getHardAccountBlockReason(acc));
      const targetList = (targetAccountId && targetAccountId !== 'all')
        ? runnableAccounts.filter(a => a.id === targetAccountId)
        : runnableAccounts;

      if (targetList.length === 0) {
        logger.log('🟡', blockedAccounts.length > 0 ? '所有账号均因凭据异常被跳过，未执行任何任务' : '没有可执行的已启用账号');
        return false;
      }

      logger.log('🚀', `===== 启动全自动化任务 (${manual ? '手动触发' : '定时巡检'} | 共 ${targetList.length} 个账号) =====`);

      // 检测地区
      const regionOk = await rewardsApi.checkRegion();
      if (!regionOk) {
        logger.log('🔴', '地区检测未通过（当前非中国大陆 IP 且锁区开启），终止执行以防封号！');
        await notifier.send('任务停止警告', '检测到非中国大陆出口 IP，为防止被微软风控已自动停止打卡。');
        return false;
      }

      // 逐账号执行：单个账号抛异常不能拖垮后面所有账号（旧实现会直接跳出整个循环，
      // 导致第 1 个账号失败后第 2、3 个账号当天完全不执行）
      const failures = [];
      const runResults = [];
      for (let i = 0; i < targetList.length && this.running; i++) {
        const acc = targetList[i];
        const runStartedAt = Date.now();
        if (configManager.findAccount(acc.id)?.enabled === false) {
          logger.log('⏸️', `账号 [${acc.name || acc.id}] 已暂停，跳过本批次剩余任务`, '', acc.name || acc.id);
          continue;
        }
        try {
          const result = await this.runSingleAccount(acc, globalCfg, { manual, turbo: activeTurbo });
          if (result) runResults.push(result);
        } catch (e) {
          failures.push({ name: acc.name || acc.id, error: e.message });
          logger.log('🔴', `账号 [${acc.name || acc.id}] 执行异常，已跳过并继续下一个账号: ${e.message}`, '', acc.name || acc.id);
          // 失败立刻推送
          try {
            await notifier.send(
              `微软积分打卡异常 [${acc.name || acc.id}]`,
              `账号 [${acc.name || acc.id}] 自动化打卡任务执行异常：\n❌ ${e.message}\n时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`
            );
          } catch {}
        } finally {
          const runStats = this.ensureAccountStats(acc.id);
          runStats.lastRunAt = runStartedAt;
          this.saveStats();
        }
        this.runningAccountId = null;

        // 多账号之间安全随机延时隔离防风控
        if (i < targetList.length - 1 && this.running) {
          if (activeTurbo) {
            logger.log('⚡', '极速模式：跳过多账号防风控长等待，快速进入下一个账号...');
            await rewardsApi.delay(1000);
          } else {
          const baseGap = Math.max(15, Number(globalCfg.tasks?.accountGapSec ?? 180) || 180);
          const jitter = Math.floor(baseGap * 0.25);
          const gapSec = rewardsApi.randomRange(baseGap, baseGap + jitter);
          const gapMin = (gapSec / 60).toFixed(1);
          logger.log('⏳', `多账号安全防风控隔离：等待 ${gapMin} 分钟 (${gapSec} 秒) 后切换下一个账号...`);
          for (let s = gapSec; s > 0 && this.running; s--) {
            await rewardsApi.delay(1000);
          }
          }
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const summary = this.computeSummary();
      const runResultById = new Map(runResults.map(item => [item.accountId, item]));
      const totalRunEarned = runResults.reduce((sum, item) => (
        sum + (Number.isFinite(item.runEarned) ? item.runEarned : 0)
      ), 0);
      const reportLines = summary.accountsList.map(a => {
        const run = runResultById.get(a.id);
        const runValue = run
          ? (Number.isFinite(run.runEarned) ? `+${run.runEarned}` : '--')
          : null;
        const runText = run ? `本轮 ${runValue} | ` : '';
        return `• ${a.name}: ${runText}今日 +${a.earned} | 余额 ${a.balance} | 连签 ${a.streakDays}天`;
      });
      const failLines = failures.map(f => `• ${f.name}: ❌ ${f.error}`);
      const isSingleRun = !!targetAccountId && targetAccountId !== 'all';
      const summaryTitle = isSingleRun ? `账号 [${targetList[0]?.name || targetAccountId}] 任务执行完毕` : '全部任务执行完毕';
      const summaryMsg = `🎉 ${summaryTitle}！用时 ${elapsed} 秒\n本轮新增: +${totalRunEarned} 积分\n今日累计: +${summary.totalEarned} 积分\n总积分余额: ${summary.totalBalance}\n\n${reportLines.join('\n')}`
        + (failLines.length > 0 ? `\n\n异常账号 (${failLines.length}):\n${failLines.join('\n')}` : '');
      logger.setAccountContext('');
      logger.log('🎉', summaryMsg);

      // 推送规则：失败立刻推送（上面 catch 已发）；成功统一推送（全部账号满额后统一推一次总览，或手动全跑时推）
      const todayKey = this.getTodayNum();
      const allFinishedToday = allAccounts.length > 0 && allAccounts.every(acc => {
        const st = this.ensureAccountStats(acc.id);
        const tVals = Object.values(st.tasks || {});
        return tVals.length > 0 && tVals.every(t => t.done || (t.max > 0 && t.progress >= t.max));
      });

      const shouldSendUnifiedReport = (!isSingleRun && manual) || (allFinishedToday && this.lastUnifiedReportDate !== todayKey);
      if (shouldSendUnifiedReport) {
        this.lastUnifiedReportDate = todayKey;
        await notifier.send('微软积分每日打卡总览报告', summaryMsg);
      }
      return true;
    } catch (e) {
      logger.log('🔴', `任务执行过程发生异常: ${e.message}`);
      return false;
    } finally {
      this.running = false;
      this.runningAccountId = null;
      logger.setAccountContext('');
      accountContextLock.release('task-run');
    }
  }
}

export const taskManager = new TaskManager();
export default taskManager;
