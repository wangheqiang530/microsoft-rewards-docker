import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-v11022-'));
process.env.MSR_DATA_DIR = testTmpDir;

const {
  DEFAULT_DAILY_SUMMARY_CRON,
  MAX_REPORT_CONTENT_LENGTH,
  normalizeReportSettings,
  describeTaskProgress,
  buildDailySummaryReport,
  buildAccountRunReport,
  buildAccountFailureReport,
  parseDailyCronTime
} = await import('../src/core/reportBuilder.js');

test.after(() => {
  fs.rmSync(testTmpDir, { recursive: true, force: true });
});

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
}

// ---------------- 推送开关规范化 ----------------

test('推送规则缺省时三个开关全部按开启处理，避免升级后静默', () => {
  const settings = normalizeReportSettings(undefined);
  assert.equal(settings.accountRun, true);
  assert.equal(settings.failure, true);
  assert.equal(settings.dailySummary.enabled, true);
  assert.equal(settings.dailySummary.cron, DEFAULT_DAILY_SUMMARY_CRON);
});

test('推送规则保留显式关闭，并回退空 cron', () => {
  const settings = normalizeReportSettings({
    accountRun: false,
    failure: false,
    dailySummary: { enabled: false, cron: '   ' }
  });
  assert.equal(settings.accountRun, false);
  assert.equal(settings.failure, false);
  assert.equal(settings.dailySummary.enabled, false);
  assert.equal(settings.dailySummary.cron, DEFAULT_DAILY_SUMMARY_CRON);
});

test('推送规则透传用户自定义 cron', () => {
  const settings = normalizeReportSettings({ dailySummary: { enabled: true, cron: '30 21 * * *' } });
  assert.equal(settings.dailySummary.cron, '30 21 * * *');
});

test('cron 用 node-cron 校验，非法表达式必须被拒', async () => {
  const cron = (await import('node-cron')).default;
  assert.equal(cron.validate(normalizeReportSettings({}).dailySummary.cron), true);
  assert.equal(cron.validate('99 99 * * *'), false);
});

// ---------------- 任务进度语义 ----------------

test('任务进度图标区分已完成、进行中与今日无此任务', () => {
  assert.equal(describeTaskProgress({ name: 'A', progress: 3, max: 3, done: true }).icon, '✅');
  assert.equal(describeTaskProgress({ name: 'B', progress: 1, max: 30 }).icon, '⏳');
  const unavailable = describeTaskProgress({ name: 'C', progress: 0, max: 0, available: false });
  assert.equal(unavailable.icon, '⏸');
  assert.equal(unavailable.done, false);
  assert.equal(unavailable.unavailable, true);
});

test('任务进度文本不会把超额进度写出来', () => {
  assert.equal(describeTaskProgress({ name: 'A', progress: 9, max: 5 }).progressText, '5/5');
});

// ---------------- 每日汇总 ----------------

const sampleSummary = {
  totalAccounts: 2,
  activeAccounts: 2,
  totalEarned: 42,
  totalBalance: 12345,
  totalClaimable: 7,
  maxStreak: 12,
  stamps: { progress: 4, max: 12 },
  doneTasksCount: 5,
  totalTasksCount: 8,
  overallPercent: 62,
  accountsList: [
    {
      id: 'a1',
      name: '主账号',
      enabled: true,
      earned: 30,
      balance: 9000,
      streakDays: 12,
      doneTasks: 4,
      totalTasks: 5,
      percent: 80,
      tasks: {
        sign: { name: '移动端签到', progress: 1, max: 1, done: true },
        search: { name: '必应 PC 搜索任务', progress: 20, max: 60 },
        appPromotions: { name: '移动端附加活动', progress: 0, max: 0, available: false }
      }
    },
    {
      id: 'a2',
      name: '小号',
      enabled: false,
      earned: 12,
      balance: 3345,
      streakDays: 3,
      doneTasks: 1,
      totalTasks: 3,
      percent: 33,
      tasks: {
        sign: { name: '移动端签到', progress: 0, max: 1 }
      }
    }
  ]
};

test('每日汇总标题带日期，正文含总览与逐账号明细表', () => {
  const report = buildDailySummaryReport({ summary: sampleSummary, dateText: '2026-11-16' });
  assert.equal(report.title, '微软积分每日汇总 2026-11-16');
  assert.match(report.content, /今日合计 \+42/);
  assert.match(report.content, /总余额 12345/);
  assert.match(report.content, /任务 5\/8/);
  assert.match(report.content, /▍主账号/);
  assert.match(report.content, /▍小号/);
  assert.match(report.content, /移动端签到 1\/1 ✅/);
  assert.match(report.content, /必应 PC 搜索任务 20\/60 ⏳/);
  assert.match(report.content, /移动端附加活动 0 ⏸/);
});

test('每日汇总标注已停用账号，且不写 Markdown 表格语法（Telegram 是纯文本）', () => {
  const report = buildDailySummaryReport({ summary: sampleSummary, dateText: '2026-11-16' });
  assert.match(report.content, /▍小号（已停用）/);
  assert.ok(!report.content.includes('|---'), '不能出现 Markdown 表格分隔行');
  assert.ok(!report.content.includes('**'), '不能出现 Markdown 加粗语法');
});

test('每日汇总无账号时给出明确提示而不是空正文', () => {
  const report = buildDailySummaryReport({ summary: { accountsList: [] } });
  assert.match(report.content, /当前没有配置任何账号/);
});

test('账号多到超出渠道上限时，先退化成摘要行、再按数量裁剪，绝不硬切半行', () => {
  const buildAccounts = (count, taskCount) => Array.from({ length: count }, (_, i) => ({
    id: `acc${i}`,
    name: `账号-${i}-名称过长占位`,
    earned: i,
    balance: 1000 + i,
    streakDays: i,
    doneTasks: 1,
    totalTasks: 3,
    percent: 33,
    tasks: Object.fromEntries(Array.from({ length: taskCount }, (_, t) => [
      `task${t}`,
      { name: `任务-${t}-名称占位`, progress: 1, max: 3 }
    ]))
  }));

  // 场景一：完整的「每账号 + 每任务一行」放不下，但摘要行放得下 → 保留全部账号
  const medium = buildDailySummaryReport({
    summary: { ...sampleSummary, accountsList: buildAccounts(30, 6) }
  });
  assert.ok(medium.content.length <= MAX_REPORT_CONTENT_LENGTH, `正文长度 ${medium.content.length} 超出上限`);
  assert.match(medium.content, /仅显示每个账号的汇总行/);
  assert.match(medium.content, /▍账号-29-名称过长占位/, '最后一个账号不能因为截断而消失');
  assert.ok(!medium.content.includes('内容过长，已截断'), '退化排版够用时不该硬切');

  // 场景二：连摘要行都放不下 → 按数量裁剪，并说明还有几个没展示
  const huge = buildDailySummaryReport({
    summary: { ...sampleSummary, accountsList: buildAccounts(400, 6) }
  });
  assert.ok(huge.content.length <= MAX_REPORT_CONTENT_LENGTH, `正文长度 ${huge.content.length} 超出上限`);
  assert.ok(huge.content.includes('（共 400 个账号，仅显示前 '), '应给出「共 N 个账号」的数量说明');
  // 被裁掉的只能是整段账号，不能出现只剩半个账号名或半个数值的残行
  const hugeLines = huge.content.trimEnd().split('\n').filter(line => line.trim() !== '');
  assert.match(hugeLines[hugeLines.length - 1], /^（共 400 个账号，仅显示前 \d+ 个，另有 \d+ 个未展示）$/, '末行应是完整的数量说明');
  // 最后一段内容必须是完整的账号摘要行，而不是被切断的残行
  assert.match(hugeLines[hugeLines.length - 2], /^　今日 \+\d+｜余额 \d+｜连签 \d+ 天｜任务 1\/3$/, '裁断处必须落在完整行之间');
});

// ---------------- 单账号运行结果 ----------------

test('单账号运行成功时推送本轮与今日增量', () => {
  const report = buildAccountRunReport({
    account: { id: 'a1', name: '主账号' },
    result: { accountId: 'a1', accountName: '主账号', status: 'ok', runEarned: 12, todayEarned: 30, endBalance: 9000 },
    summary: sampleSummary,
    elapsedSec: 88.4
  });
  assert.equal(report.title, '账号运行结果 [主账号]');
  assert.match(report.content, /用时 88\.4 秒/);
  assert.match(report.content, /本轮 \+12/);
  assert.match(report.content, /今日 \+30/);
  assert.match(report.content, /余额 9000/);
  assert.match(report.content, /未完成：必应 PC 搜索任务 20\/60/);
});

test('单账号被跳过时推送明确原因，与成功文案区分', () => {
  const report = buildAccountRunReport({
    account: { id: 'a1', name: '主账号' },
    result: { accountId: 'a1', status: 'skipped', reason: '无法读取微软官网状态' },
    summary: sampleSummary
  });
  assert.equal(report.title, '账号跳过 [主账号]');
  assert.match(report.content, /本次未执行/);
  assert.match(report.content, /原因：无法读取微软官网状态/);
});

test('单账号被中断时推送中断原因', () => {
  const report = buildAccountRunReport({
    account: { id: 'a2', name: '小号' },
    result: { accountId: 'a2', status: 'stopped', reason: '任务被手动停止' },
    summary: sampleSummary
  });
  assert.equal(report.title, '账号中断 [小号]');
  assert.match(report.content, /运行被中断/);
  assert.match(report.content, /任务被手动停止/);
});

test('单账号运行结果缺少 summary 时也不会抛异常', () => {
  const report = buildAccountRunReport({
    account: { id: 'x', name: 'X' },
    result: { accountId: 'x', status: 'ok', runEarned: null, todayEarned: null, endBalance: null }
  });
  assert.match(report.content, /本轮 --/);
});

// ---------------- 失败告警 ----------------

test('失败推送必须写明失败原因与时间', () => {
  const report = buildAccountFailureReport({
    accountName: '主账号',
    error: new Error('Cookie 已失效'),
    at: new Date('2026-11-16T10:20:30')
  });
  assert.equal(report.title, '微软积分打卡异常 [主账号]');
  assert.match(report.content, /失败原因：Cookie 已失效/);
  assert.match(report.content, /发生时间：2026-11-16 10:20:30/);
});

test('失败推送兼容字符串错误与空错误', () => {
  assert.match(buildAccountFailureReport({ accountName: 'A', error: '超时' }).content, /失败原因：超时/);
  assert.match(buildAccountFailureReport({ accountName: 'A' }).content, /失败原因：未知错误/);
});

// ---------------- 配置与源码守卫 ----------------

test('配置默认值包含推送规则，且默认全开', async () => {
  const configManager = (await import('../src/config.js')).default;
  const notify = configManager.get().notify;
  assert.equal(notify.reports.accountRun, true);
  assert.equal(notify.reports.failure, true);
  assert.equal(notify.reports.dailySummary.enabled, true);
  assert.equal(notify.reports.dailySummary.cron, DEFAULT_DAILY_SUMMARY_CRON);
});

test('保存配置会规范化推送规则：缺字段补开启、空 cron 回退默认', async () => {
  const configManager = (await import('../src/config.js')).default;
  configManager.update({ notify: { reports: { failure: false, dailySummary: { cron: '' } } } });
  const reports = configManager.get().notify.reports;
  assert.equal(reports.failure, false);
  assert.equal(reports.accountRun, true);
  assert.equal(reports.dailySummary.enabled, true);
  assert.equal(reports.dailySummary.cron, DEFAULT_DAILY_SUMMARY_CRON);
});

test('每日汇总由 scheduler 独立 cron 驱动，不再有旧的总览兜底推送', () => {
  const schedulerSrc = readSource('src/scheduler.js');
  assert.match(schedulerSrc, /startSummaryJob\(\)/);
  const startIdx = schedulerSrc.indexOf('start() {');
  const summaryIdx = schedulerSrc.indexOf('this.startSummaryJob();');
  const earlyReturnIdx = schedulerSrc.indexOf('if (!cfg.schedule?.enabled)');
  assert.ok(summaryIdx > startIdx && summaryIdx < earlyReturnIdx, '每日汇总必须在自动巡检开关早退之前注册');
  assert.match(schedulerSrc, /this\.summaryJob\.stop\(\);/);

  const taskSrc = readSource('src/core/taskManager.js');
  assert.ok(!taskSrc.includes('lastUnifiedReportDate'), '旧的隐式总览去重字段应已删除');
  assert.ok(!taskSrc.includes("notifier.send('微软积分每日打卡总览报告'"), '旧的总览推送调用应已删除');
  assert.match(taskSrc, /reportSettings\.accountRun/);
  assert.match(taskSrc, /reportSettings\.failure/);
});

test('Web 端会校验每日汇总 cron 表达式，避免存进无效值', () => {
  const serverSrc = readSource('src/web/server.js');
  assert.match(serverSrc, /import cron from 'node-cron';/);
  assert.match(serverSrc, /cron\.validate\(summaryCron\.trim\(\)\)/);
  assert.match(serverSrc, /\/api\/notify\/report\/preview/);
});

test('消息推送选项卡提供三个推送开关与汇总 cron 输入框', () => {
  const indexHtml = readSource('src/web/public/index.html');
  assert.match(indexHtml, /id="cfg-notify-report-account-run"/);
  assert.match(indexHtml, /id="cfg-notify-report-failure"/);
  assert.match(indexHtml, /id="cfg-notify-report-daily-enabled"/);
  assert.match(indexHtml, /id="cfg-notify-report-daily-cron"/);
  assert.match(indexHtml, /id="btn-test-notify-report"/);

  const appJs = readSource('src/web/public/app.js');
  assert.match(appJs, /window\.testNotifyReport = async function/);
  assert.match(appJs, /\/api\/notify\/report\/preview/);
  assert.match(appJs, /reports: {/);
});

// ---------------- 每日汇总的补推与去重 ----------------

test('parseDailyCronTime 只接受「每天固定时刻」的 5 段表达式', () => {
  assert.deepEqual(parseDailyCronTime('0 22 * * *'), { hour: 22, minute: 0 });
  assert.deepEqual(parseDailyCronTime(' 5 8 * * * '), { hour: 8, minute: 5 });
  assert.equal(parseDailyCronTime('*/30 * * * *'), null, '步长表达式无法判断今天漏没漏，不补推');
  assert.equal(parseDailyCronTime('0 22 * * MON'), null, '限定星期的不补推');
  assert.equal(parseDailyCronTime('0 0 22 * * *'), null, '带秒的 6 段表达式不补推');
  assert.equal(parseDailyCronTime('0 24 * * *'), null, '小时越界应拒绝');
  assert.equal(parseDailyCronTime('60 10 * * *'), null, '分钟越界应拒绝');
  assert.equal(parseDailyCronTime(''), null);
});

test('启动补推只在「今天已过点且还没推过」时触发', async () => {
  const { default: scheduler } = await import('../src/scheduler.js');
  const pushed = [];
  const original = scheduler.runDailySummary;
  scheduler.runDailySummary = expression => { pushed.push(expression); };
  try {
    scheduler.lastSummaryDate = 0;
    scheduler.catchUpDailySummary('0 22 * * *', new Date(2026, 0, 1, 23, 0));
    assert.equal(pushed.length, 1, '23:00 已过 22:00，应补推一次');

    pushed.length = 0;
    scheduler.lastSummaryDate = scheduler.getTodayNum();
    scheduler.catchUpDailySummary('0 22 * * *', new Date(2026, 0, 1, 23, 0));
    assert.equal(pushed.length, 0, '今天已经推过就不再补');

    pushed.length = 0;
    scheduler.lastSummaryDate = 0;
    scheduler.catchUpDailySummary('0 22 * * *', new Date(2026, 0, 1, 8, 0));
    assert.equal(pushed.length, 0, '还没到点不该补推');

    pushed.length = 0;
    scheduler.catchUpDailySummary('*/30 * * * *', new Date(2026, 0, 1, 23, 0));
    assert.equal(pushed.length, 0, '步长表达式不补推');
  } finally {
    scheduler.runDailySummary = original;
  }
});

test('汇总真正送达后才把「今天已推」落盘，重启不会重复补推', async () => {
  const { default: scheduler } = await import('../src/scheduler.js');
  const { default: notifier } = await import('../src/core/notifier.js');
  const stateFile = path.join(testTmpDir, 'daily_summary_state.json');
  const originalSend = notifier.send;
  try {
    scheduler.lastSummaryDate = 0;
    notifier.send = async () => [{ status: 'fulfilled' }];
    await scheduler.runDailySummary('0 22 * * *');
    assert.equal(scheduler.lastSummaryDate, scheduler.getTodayNum());
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    assert.equal(saved.lastSummaryDate, scheduler.getTodayNum());

    scheduler.lastSummaryDate = 0;
    scheduler.loadSummaryState();
    assert.equal(scheduler.lastSummaryDate, scheduler.getTodayNum(), '重启后应从磁盘读回今天的推送记录');
  } finally {
    notifier.send = originalSend;
  }
});

test('渠道没配或全部失败时不记「今天已推」，用户配好渠道当天还能收到补推', async () => {
  const { default: scheduler } = await import('../src/scheduler.js');
  const { default: notifier } = await import('../src/core/notifier.js');
  const stateFile = path.join(testTmpDir, 'daily_summary_state.json');
  const originalSend = notifier.send;
  fs.rmSync(stateFile, { force: true }); // 上一个用例可能写过，这里要的是「从零开始」
  try {
    // 没有任何渠道：notifier.send 返回 undefined
    scheduler.lastSummaryDate = 0;
    notifier.send = async () => undefined;
    await scheduler.runDailySummary('0 22 * * *');
    assert.equal(scheduler.lastSummaryDate, 0, '没配渠道不能算作「推过」，否则配好渠道也不会补推');

    // 渠道全部失败
    notifier.send = async () => [{ status: 'rejected', reason: new Error('boom') }];
    await scheduler.runDailySummary('0 22 * * *');
    assert.equal(scheduler.lastSummaryDate, 0, '全渠道失败同样不记，留着下次补推');
    assert.ok(!fs.existsSync(stateFile), '一次都没成功过就不该写出状态文件');
  } finally {
    notifier.send = originalSend;
  }
});

test('restart 走 start 时复位汇总停止标记，否则改一次配置就再也收不到汇总', () => {
  const schedulerSrc = readSource('src/scheduler.js');
  const startIdx = schedulerSrc.indexOf('start() {');
  const resetIdx = schedulerSrc.indexOf('this.dailySummaryStopped = false;', startIdx);
  const earlyReturnIdx = schedulerSrc.indexOf('if (!cfg.schedule?.enabled)', startIdx);
  assert.ok(resetIdx > startIdx && resetIdx < earlyReturnIdx, '复位必须发生在任何早退之前');
  assert.match(schedulerSrc, /clearTimeout\(this\.summaryRetryTimer\)/);
  assert.match(schedulerSrc, /SUMMARY_RETRY_LIMIT/);
});
