import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import configManager from './config.js';
import logger from './logger.js';
import taskManager from './core/taskManager.js';
import epicManager from './core/epic.js';
import notifier from './core/notifier.js';
import {
  DEFAULT_DAILY_SUMMARY_CRON,
  buildDailySummaryReport,
  normalizeReportSettings,
  parseDailyCronTime
} from './core/reportBuilder.js';
import { DATA_DIR, writeFileAtomic } from './fsUtil.js';
import {
  MAX_START_DELAY_MINUTES,
  RUN_HOURS,
  RUN_WINDOW_MINUTES,
  normalizeAccountRunHours,
  selectRunHour
} from './core/scheduleWindow.js';

const PLAN_FILE = path.join(DATA_DIR, 'schedule_plan.json');
// 每日汇总的推送记录：只用来判断「今天这个点过了，但我还没推过」，
// 也就是容器半夜重启 / 白天停机导致错过汇总时，启动后补一条。
const SUMMARY_STATE_FILE = path.join(DATA_DIR, 'daily_summary_state.json');
// 汇总到点正好在跑任务时，隔多久再试一次，以及最多试几次
const SUMMARY_RETRY_DELAY_MS = 5 * 60 * 1000;
const SUMMARY_RETRY_LIMIT = 12;
const PLAN_VERSION = 3;

class Scheduler {
  constructor() {
    this.job = null;
    this.epicJob = null;
    // 每日积分汇总的独立 job：不受 schedule.enabled 影响，
    // 用户关掉自动巡检也应该照常收到当天汇总。
    this.summaryJob = null;
    this.summaryRetryTimer = null;
    this.dailySummaryStopped = false;
    this.lastSummaryDate = 0;
    this.plannedDailyRuns = {};
    this.loadPlans();
    this.loadSummaryState();
  }

  loadSummaryState() {
    try {
      if (!fs.existsSync(SUMMARY_STATE_FILE)) return;
      const parsed = JSON.parse(fs.readFileSync(SUMMARY_STATE_FILE, 'utf-8'));
      const last = Number(parsed?.lastSummaryDate);
      if (Number.isFinite(last)) this.lastSummaryDate = last;
    } catch {}
  }

  saveSummaryState() {
    try {
      writeFileAtomic(SUMMARY_STATE_FILE, JSON.stringify({ lastSummaryDate: this.lastSummaryDate }, null, 2), {
        encoding: 'utf-8',
        mode: 0o600
      });
    } catch {}
  }

  loadPlans() {
    try {
      if (fs.existsSync(PLAN_FILE)) {
        const raw = fs.readFileSync(PLAN_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.plannedDailyRuns = parsed;
        }
      }
    } catch {}
  }

  savePlans() {
    try {
      writeFileAtomic(PLAN_FILE, JSON.stringify(this.plannedDailyRuns, null, 2), {
        encoding: 'utf-8',
        mode: 0o600
      });
    } catch {}
  }

  getTodayNum() {
    const d = new Date();
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }

  /**
   * 当前时刻距离窗口起点的分钟数（支持跨零点窗口，如 22:00 - 02:00）。
   * 返回值 < 0 表示还没进入窗口。
   */
  minutesIntoWindow(startMin, wraps, nowMin) {
    return wraps
      ? (nowMin >= startMin ? nowMin - startMin : 1440 - startMin + nowMin)
      : (nowMin - startMin);
  }

  initTodayPlan() {
    const today = this.getTodayNum();
    this.ensureDayPlans(today, true);

    // 只清理历史日期，保留今天与预排的明天
    const todayKey = String(today);
    for (const key of Object.keys(this.plannedDailyRuns)) {
      if (key < todayKey) delete this.plannedDailyRuns[key];
    }
    this.savePlans();
  }

  /**
   * 为指定日期生成各账号的当日计划（已存在则跳过）。
   * isToday=true 时，若当前已在窗口内则把偏移推到「现在之后」，避免中途启动立刻开跑。
   */
  ensureDayPlans(dateNum, isToday) {
    const key = String(dateNum);
    if (!this.plannedDailyRuns[key]) {
      this.plannedDailyRuns[key] = {};
    }
    const plans = this.plannedDailyRuns[key];
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const accounts = configManager.getAccounts();
    const eligible = [];
    const claimedHours = new Set();
    for (const acc of accounts) {
      const [runHour] = normalizeAccountRunHours(acc.runHours);
      if (acc.enabled === false || runHour === undefined || claimedHours.has(runHour)) {
        delete plans[acc.id];
        continue;
      }
      claimedHours.add(runHour);
      eligible.push({ acc, runHour });
    }

    // 账号被删除、暂停或改成未排期后，其旧计划不能再残留到今天。
    const eligibleIds = new Set(eligible.map(({ acc }) => acc.id));
    for (const accountId of Object.keys(plans)) {
      if (!eligibleIds.has(accountId)) delete plans[accountId];
    }

    for (const { acc, runHour } of eligible) {
      const existingPlan = plans[acc.id];
      if (existingPlan?.version === PLAN_VERSION && existingPlan.runHour === runHour) continue;
      if (existingPlan?.executed === true) {
        plans[acc.id] = {
          ...existingPlan,
          version: PLAN_VERSION,
          runHour,
          startMin: runHour * 60,
          endMin: runHour * 60 + RUN_WINDOW_MINUTES
        };
        continue;
      }
      if (existingPlan) delete plans[acc.id];

      const selected = selectRunHour([runHour], { isToday, nowMin });
      const startMin = selected.hour * 60;
      const endMin = startMin + RUN_WINDOW_MINUTES;
      const offset = selected.expired
        ? 0
        : Math.floor(Math.random() * (MAX_START_DELAY_MINUTES + 1));

      plans[acc.id] = {
        version: PLAN_VERSION,
        runHour: selected.hour,
        startMin,
        endMin,
        wraps: false,
        windowLength: RUN_WINDOW_MINUTES,
        offset,
        expired: selected.expired,
        executed: false
      };
    }
    this.savePlans();
  }

  /** 日期编号（YYYYMMDD）偏移若干天 */
  shiftDateNum(dateNum, deltaDays) {
    const d = new Date(
      Math.floor(dateNum / 10000),
      Math.floor((dateNum % 10000) / 100) - 1,
      dateNum % 100,
      12, 0, 0, 0
    );
    d.setDate(d.getDate() + deltaDays);
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }

  /** 某天计划的绝对执行时间戳（窗口起点日 + 偏移分钟） */
  planTimestamp(dateNum, plan, baseDayOffset = 0) {
    const base = new Date(
      Math.floor(dateNum / 10000),
      Math.floor((dateNum % 10000) / 100) - 1,
      dateNum % 100
    );
    if (baseDayOffset) base.setDate(base.getDate() + baseDayOffset);
    return base.getTime() + (plan.startMin + plan.offset) * 60000;
  }

  /**
   * 供 WebUI 展示：每个账号距下次自动执行的倒计时。
   * 返回 { [accountId]: { status, minutesUntil, nextRunAt, windowStart, windowEnd } }
   * status: scheduled(已排定) / imminent(即将启动)
   *         / no-credential(未配凭据) / disabled(账号停用) / schedule-off(定时关闭)
   */
  getNextRunInfo() {
    const cfg = configManager.get();
    const scheduleEnabled = cfg.schedule?.enabled !== false;
    const today = this.getTodayNum();
    const tomorrow = this.shiftDateNum(today, 1);

    if (scheduleEnabled) {
      this.initTodayPlan();
      // 预排明天：这样「今日已完成」的账号也能给出确切的下次执行倒计时
      this.ensureDayPlans(tomorrow, false);
    }

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const todayPlans = this.plannedDailyRuns[String(today)] || {};
    const tomorrowPlans = this.plannedDailyRuns[String(tomorrow)] || {};
    const fmt = (m) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
    const result = {};

    configManager.getAccounts().forEach(acc => {
      const runHours = normalizeAccountRunHours(acc.runHours);
      const firstRunHour = runHours[0];
      const info = {
        status: 'unknown',
        minutesUntil: null,
        nextRunAt: null,
        windowStart: firstRunHour === undefined ? '--:--' : fmt(firstRunHour * 60),
        windowEnd: firstRunHour === undefined ? '--:--' : fmt((firstRunHour + 1) * 60)
      };

      if (acc.enabled === false) {
        info.status = 'disabled';
      } else if (firstRunHour === undefined) {
        info.status = 'no-schedule';
      } else if (!acc.cookie && !acc.refreshToken) {
        info.status = 'no-credential';
      } else if (!scheduleEnabled) {
        info.status = 'schedule-off';
      } else {
        const todayPlan = todayPlans[acc.id];
        const tomorrowPlan = tomorrowPlans[acc.id];
        let nextAt = null;

        if (todayPlan && !todayPlan.executed && !todayPlan.expired) {
          const plannedAt = this.planTimestamp(today, todayPlan, 0);
          if (plannedAt > now.getTime()) {
            nextAt = plannedAt;
          } else {
            const nowOffset = this.minutesIntoWindow(todayPlan.startMin, todayPlan.wraps, nowMin);
            const inWindow = nowOffset >= 0 && nowOffset < todayPlan.windowLength;
            if (inWindow) nextAt = now.getTime(); // 窗口内，调度器下一分钟启动
          }
        }
        if (nextAt === null && tomorrowPlan) {
          nextAt = this.planTimestamp(tomorrow, tomorrowPlan, 0);
        }

        const displayPlan = (todayPlan && !todayPlan.expired) ? todayPlan : tomorrowPlan;
        if (displayPlan) {
          info.windowStart = fmt(displayPlan.startMin);
          info.windowEnd = fmt(displayPlan.endMin);
        }

        if (nextAt !== null) {
          info.nextRunAt = nextAt;
          info.minutesUntil = Math.max(0, Math.round((nextAt - now.getTime()) / 60000));
          info.status = info.minutesUntil <= 0 ? 'imminent' : 'scheduled';
        }
      }
      result[acc.id] = info;
    });

    return result;
  }

  start() {
    this.stop();
    // stop() 会把汇总标记为「已停止」（避免退出后还在重试），
    // restart() 走的是 start()，这里必须复位，否则改一次配置就再也收不到汇总。
    this.dailySummaryStopped = false;
    const cfg = configManager.get();
    // 每日汇总独立于自动巡检开关，必须在下面的早退之前注册
    this.startSummaryJob();
    if (!cfg.schedule?.enabled) {
      logger.log('⏸️', '后台自动定时巡检当前已禁用');
      // Epic 自动领取独立于微软定时开关
      this.startEpicJob();
      return;
    }

    // 每分钟检查一次拟人化时段调度
    this.job = cron.schedule('* * * * *', async () => {
      if (taskManager.running) return;

      const today = this.getTodayNum();
      this.initTodayPlan();

      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const todayPlans = this.plannedDailyRuns[today] || {};

      const accounts = configManager.getAccounts().filter(a => (
        a.enabled !== false && normalizeAccountRunHours(a.runHours).length > 0
      ));
      for (const acc of accounts) {
        if (!acc.cookie && !acc.refreshToken) continue;

        const plan = todayPlans[acc.id];
        if (!plan || plan.executed || plan.expired) continue;

        // 距离窗口起点的分钟数（跨零点窗口也能正确计算）
        const nowOffset = this.minutesIntoWindow(plan.startMin, plan.wraps, nowMin);

        const inWindow = nowOffset >= 0 && nowOffset < plan.windowLength;
        if (inWindow && nowOffset >= plan.offset) {
          plan.executed = true;
          this.savePlans();
          const fmt = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          logger.log('⏰', `到达账号 [${acc.name}] 小时窗口 (${fmt(plan.startMin)} - ${fmt(plan.endMin)}，今日随机命中 ${fmt(plan.startMin + plan.offset)})，启动打卡...`, '', acc.name);
          try {
            await taskManager.runAll(false, acc.id);
          } catch (e) {
            logger.log('🔴', `定时任务执行异常: ${e.message}`, '', acc.name);
          }
          break; // 一次只启动一个账号，保持单队列
        }
      }
    });

    logger.log('🟢', `后台小时窗口调度引擎已就绪 (00:00-24:00，共 ${RUN_HOURS.length} 个一小时档位，每档 0-${MAX_START_DELAY_MINUTES} 分钟随机启动)`);
    this.startEpicJob();
  }

  /**
   * 每日积分汇总推送。
   *
   * 与自动巡检完全解耦：即使 schedule.enabled=false（用户只想手动跑），
   * 到点也该收到当天的积分汇总。cron 表达式由 notify.reports.dailySummary.cron 决定。
   */
  startSummaryJob() {
    if (this.summaryJob) {
      this.summaryJob.stop();
      this.summaryJob = null;
    }
    const settings = normalizeReportSettings(configManager.get().notify?.reports);
    if (!settings.dailySummary.enabled) {
      logger.log('⏸️', '每日积分汇总推送已禁用');
      return;
    }
    let expression = settings.dailySummary.cron || DEFAULT_DAILY_SUMMARY_CRON;
    if (!cron.validate(expression)) {
      logger.log('🟡', `每日汇总 cron 表达式无效（${expression}），已回退到默认 ${DEFAULT_DAILY_SUMMARY_CRON}`);
      expression = DEFAULT_DAILY_SUMMARY_CRON;
    }
    this.summaryJob = cron.schedule(expression, () => {
      this.runDailySummary(expression);
    });
    logger.log('📮', `每日积分汇总推送已就绪（cron: ${expression}）`);
    // 容器停机可能整段跨过汇总时刻（cron 不会补发），启动时补一次
    this.catchUpDailySummary(expression);
  }

  /**
   * 补推：如果「今天该推的时点已经过了」，但今天还没推过，就立刻补一条。
   *
   * 只处理 `分 时 * * *` 这种每天固定时刻的表达式——其它形状（步长、星期限定）
   * 没法可靠判断「今天是否漏了」，硬补反而可能打扰，就交给 cron 自己触发。
   */
  catchUpDailySummary(expression = DEFAULT_DAILY_SUMMARY_CRON, now = new Date()) {
    const time = parseDailyCronTime(expression);
    if (!time) return;
    const today = this.getTodayNum();
    if (this.lastSummaryDate === today) return;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin < time.hour * 60 + time.minute) return;
    logger.log('📮', `检测到今天(${today})的 ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')} 汇总时刻已过但尚未推送，立即补推一次`);
    this.runDailySummary(expression);
  }

  /**
   * 真正执行一次汇总推送。
   *
   * 到点时如果正好在跑打卡，绝不能直接放弃——cron 是按天触发的，错过这一天
   * 用户就彻底收不到汇总了（这正是老版本「从来没收到过汇总」的痛点）。
   * 所以这里排队重试，直到任务跑完再推。
   */
  async runDailySummary(expression = DEFAULT_DAILY_SUMMARY_CRON, attempt = 0) {
    if (this.dailySummaryStopped) return;
    if (taskManager.running) {
      if (attempt >= SUMMARY_RETRY_LIMIT) {
        logger.log('🟡', `每日汇总已重试 ${SUMMARY_RETRY_LIMIT} 次仍与任务执行冲突，本次汇总放弃`);
        return;
      }
      const delayMin = Math.round(SUMMARY_RETRY_DELAY_MS / 60000);
      logger.log('🟡', `每日汇总到点时任务仍在运行，${delayMin} 分钟后重试（第 ${attempt + 1}/${SUMMARY_RETRY_LIMIT} 次）`);
      this.summaryRetryTimer = setTimeout(() => {
        this.summaryRetryTimer = null;
        this.runDailySummary(expression, attempt + 1);
      }, SUMMARY_RETRY_DELAY_MS);
      // 不因为这个重试把进程钉在内存里
      this.summaryRetryTimer.unref?.();
      return;
    }
    try {
      const summary = taskManager.computeSummary();
      const { title, content } = buildDailySummaryReport({ summary });
      const results = await notifier.send(title, content);
      const fulfilled = Array.isArray(results) ? results.filter(r => r.status === 'fulfilled').length : 0;
      if (Array.isArray(results) && results.length > 0) {
        const failed = results.length - fulfilled;
        logger.log('📮', `每日积分汇总已推送（${fulfilled}/${results.length} 个渠道成功，cron: ${expression}）`);
      } else {
        logger.log('🟡', '每日积分汇总已生成，但没有配置任何推送渠道，未发送');
      }
      // 只有真正送出去才记「今天推过」：
      //   - 没配渠道 / 全部渠道失败时不记，否则用户当天配好渠道也收不到补推；
      //   - 记了之后重启不再重复补推，避免变成骚扰。
      if (fulfilled > 0) {
        this.lastSummaryDate = this.getTodayNum();
        this.saveSummaryState();
      }
    } catch (e) {
      logger.log('🔴', `每日积分汇总推送异常: ${e.message}`);
    }
  }

  /** 指定时刻是否已到达当天的 Epic 自动领取启动时间（HH:MM） */
  hasReachedEpicStartTime(timeStr, now = Date.now()) {
    const [h, m] = String(timeStr || '10:00').split(':').map(Number);
    const startMin = (Number.isFinite(h) ? h : 10) * 60 + (Number.isFinite(m) ? m : 0);
    const d = new Date(now);
    return d.getHours() * 60 + d.getMinutes() >= startMin;
  }

  /**
   * 这一次 tick 是否该真正执行 Epic 检查。
   *
   * 同时承载两条规则，抽出来是为了能单测：
   *   1. 到点前一律暂停 —— 容器重启后默认什么都不做，等设定的启动时间再开始；
   *   2. 首次检查的下限取「上次检查」与「进程启动时刻」中较晚的一个。
   *      旧逻辑只看 lastCheckAt，而它是内存值、重启即归零，于是重启就立刻跑一轮。
   */
  shouldRunEpicCheck(settings, now = Date.now()) {
    if (!settings?.enabled) return false;
    if (!this.hasReachedEpicStartTime(settings.autoClaimTime, now)) return false;
    const since = Math.max(epicManager.lastCheckAt || 0, epicManager.bootedAt || 0);
    const intervalMin = Number(settings.checkIntervalMin);
    if (!Number.isFinite(intervalMin) || intervalMin <= 0) return true;
    return (now - since) / 60000 >= intervalMin;
  }

  /** Epic 免费游戏：按设置的检查间隔轮询，发现未领取的才真正触发领取 */
  startEpicJob() {
    if (this.epicJob) {
      this.epicJob.stop();
      this.epicJob = null;
    }
    const settings = epicManager.getSettings();
    if (!settings.enabled) {
      logger.log('⏸️', 'Epic 免费游戏自动领取已禁用');
      return;
    }

    // 每分钟判断一次是否到达「检查间隔」
    this.epicJob = cron.schedule('* * * * *', async () => {
      if (epicManager.running) return;
      const s = epicManager.getSettings();
      if (!this.shouldRunEpicCheck(s)) return;

      const accounts = configManager.getEpicAccounts().filter(a => a.enabled !== false && a.storageState?.cookies?.length);
      if (accounts.length === 0) return;

      try {
        await epicManager.checkAndClaimIfNeeded();
      } catch (e) {
        logger.log('🔴', `Epic 定时检查异常: ${e.message}`);
      }
    });

    logger.log('🎮', `Epic 免费游戏自动领取已就绪（每天 ${settings.autoClaimTime} 之后每 ${settings.checkIntervalMin} 分钟检查一次，失败重试 ${settings.retryCount} 次）`);
  }

  stop() {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    this.dailySummaryStopped = true;
    if (this.summaryRetryTimer) {
      clearTimeout(this.summaryRetryTimer);
      this.summaryRetryTimer = null;
    }
    if (this.summaryJob) {
      this.summaryJob.stop();
      this.summaryJob = null;
    }
    if (this.epicJob) {
      this.epicJob.stop();
      this.epicJob = null;
    }
  }

  restart() {
    this.start();
  }
}

export const scheduler = new Scheduler();
export default scheduler;
