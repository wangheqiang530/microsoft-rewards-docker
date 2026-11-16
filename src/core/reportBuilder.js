/**
 * 推送文案构建器
 *
 * 这里所有函数都是纯函数：只吃数据、只返回 { title, content }，不读配置也不发请求。
 * 目的是让「推送文案长什么样」能脱离浏览器和推送渠道直接单测。
 *
 * 重要约束：Telegram 渠道是纯文本发送（src/core/notifier.js 的 sendTelegram 不带
 * parse_mode），所以这里绝不能写 Markdown / HTML 表格语法，
 * 排版只能靠短行、分隔符与全角空格。
 */

/** 每日汇总的默认推送时刻：每天 22:00 */
export const DEFAULT_DAILY_SUMMARY_CRON = '0 22 * * *';

/** 单条正文最大长度。Telegram 单条上限 4096 字符，留出标题与渠道封装余量。 */
export const MAX_REPORT_CONTENT_LENGTH = 3500;

/** 每段明细前的缩进（全角空格，中文环境下比半角空格更稳） */
const INDENT = '　';

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 带正负号的积分文本。null/undefined 表示「没测到」，必须显示 --，不能伪装成 +0 */
export function signedPoints(value) {
  if (value === null || value === undefined || value === '') return '--';
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return n >= 0 ? `+${n}` : String(n);
}

/** YYYY-MM-DD */
export function formatReportDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '--';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** YYYY-MM-DD HH:mm:ss */
export function formatReportTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '--';
  return `${formatReportDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 把 config 里的 notify.reports 规整成完整结构。
 * 缺省一律按「开启」处理，避免老配置文件升级后新功能默认静默。
 */
export function normalizeReportSettings(raw) {
  const reports = raw && typeof raw === 'object' ? raw : {};
  const daily = reports.dailySummary && typeof reports.dailySummary === 'object'
    ? reports.dailySummary
    : {};
  const cronText = String(daily.cron ?? '').trim();
  return {
    accountRun: reports.accountRun !== false,
    failure: reports.failure !== false,
    dailySummary: {
      enabled: daily.enabled !== false,
      cron: cronText || DEFAULT_DAILY_SUMMARY_CRON
    }
  };
}

/**
 * 从 5 段 cron 里解析「每天固定时刻」形式的触发时间。
 *
 * 只认 `分 时 * * *`（例如 `0 22 * * *`）——这正是每日汇总的常见写法，
 * 也是唯一能安全回答「今天这个点是不是已经过了」的形状。
 * 其余表达式（含星期/月份限定、步长、列表）一律返回 null，
 * 调用方据此放弃「重启补推」，只依赖 cron 本身的触发。
 */
export function parseDailyCronTime(expression) {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minuteText, hourText, dom, month, dow] = parts;
  if (dom !== '*' || month !== '*' || dow !== '*') return null;
  if (!/^\d{1,2}$/.test(minuteText) || !/^\d{1,2}$/.test(hourText)) return null;
  const minute = Number(minuteText);
  const hour = Number(hourText);
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  return { hour, minute };
}

function truncate(content) {
  const text = String(content || '');
  if (text.length <= MAX_REPORT_CONTENT_LENGTH) return text;
  return `${text.slice(0, MAX_REPORT_CONTENT_LENGTH)}\n…（内容过长，已截断）`;
}

/**
 * 单项任务的状态图标与进度文本。
 * available === false 且 max <= 0 视为「今日无此任务」，用暂停符号表示，不参与完成率的心智负担。
 */
export function describeTaskProgress(task) {
  const max = toNumber(task?.max, 0);
  const progress = toNumber(task?.progress, 0);
  const unavailable = task?.available === false && max <= 0;
  const done = !unavailable && (task?.done === true || (max > 0 && progress >= max));
  const icon = unavailable ? '⏸' : (done ? '✅' : '⏳');
  const progressText = max > 0
    ? `${Math.min(Math.max(progress, 0), max)}/${max}`
    : String(Math.max(progress, 0));
  return {
    done,
    unavailable,
    icon,
    progressText,
    text: `${task?.name || '未知任务'} ${progressText}`
  };
}

function findAccountStat(summary, accountId) {
  const list = Array.isArray(summary?.accountsList) ? summary.accountsList : [];
  if (!accountId) return null;
  return list.find(item => item.id === accountId) || null;
}

/** 单账号明细：一行摘要 + 每个任务一行（withTasks=false 时只留摘要行） */
function buildAccountDetailLines(account, { withTasks = true } = {}) {
  const lines = [];
  const suffix = account?.enabled === false ? '（已停用）' : '';
  lines.push(`▍${account?.name || account?.id || '账号'}${suffix}`);
  lines.push(
    `${INDENT}今日 ${signedPoints(account?.earned)}｜余额 ${toNumber(account?.balance)}｜`
    + `连签 ${toNumber(account?.streakDays)} 天｜任务 ${toNumber(account?.doneTasks)}/${toNumber(account?.totalTasks)}`
  );
  if (!withTasks) return lines;
  const tasks = account?.tasks && typeof account.tasks === 'object' ? Object.values(account.tasks) : [];
  if (tasks.length === 0) {
    lines.push(`${INDENT}· 暂无任务进度`);
    return lines;
  }
  for (const task of tasks) {
    const info = describeTaskProgress(task);
    lines.push(`${INDENT}· ${info.text} ${info.icon}`);
  }
  return lines;
}

/**
 * 每日总积分汇总（含逐账号明细表）
 */
export function buildDailySummaryReport({ summary, dateText, generatedAt } = {}) {
  const s = summary || {};
  const accounts = Array.isArray(s.accountsList) ? s.accountsList : [];
  const lines = [];

  lines.push(
    `💰 今日合计 ${signedPoints(s.totalEarned)}｜总余额 ${toNumber(s.totalBalance)}｜待领取 ${toNumber(s.totalClaimable)}`
  );
  lines.push(
    `✅ 任务 ${toNumber(s.doneTasksCount)}/${toNumber(s.totalTasksCount)}（${toNumber(s.overallPercent)}%）`
    + `｜最长连签 ${toNumber(s.maxStreak)} 天`
  );
  lines.push(
    `🃏 印章 ${toNumber(s.stamps?.progress)}/${toNumber(s.stamps?.max, 12)}`
    + `｜启用 ${toNumber(s.activeAccounts)}/${toNumber(s.totalAccounts)} 个账号`
  );

  const day = dateText || formatReportDate(generatedAt || new Date());
  const title = `微软积分每日汇总 ${day}`;

  if (accounts.length === 0) {
    lines.push('');
    lines.push('（当前没有配置任何账号）');
    return { title, content: truncate(lines.join('\n')) };
  }

  // 先按「每账号 + 每个任务一行」生成完整明细表。
  // 账号一多就会顶到 3500 字符上限，被截断的尾部恰恰是后面的账号——
  // 所以超长时退化成「只保留每账号摘要行」，宁可少任务行也要让每个账号都露脸。
  const buildWith = withTasks => {
    const out = lines.slice();
    for (const account of accounts) {
      out.push('');
      out.push(...buildAccountDetailLines(account, { withTasks }));
    }
    return out.join('\n');
  };

  const fullText = buildWith(true);
  if (fullText.length <= MAX_REPORT_CONTENT_LENGTH) {
    return { title, content: fullText };
  }
  const compactSuffix = '（账号较多，仅显示每个账号的汇总行）';
  const compactText = `${buildWith(false)}\n\n${compactSuffix}`;
  if (compactText.length <= MAX_REPORT_CONTENT_LENGTH) {
    return { title, content: compactText };
  }
  // 连摘要行都放不下（几十上百个账号）：按账号数量递减，把剩下的用一行说明兜底，
  // 不要用 truncate 硬切——那会把后半截账号的名字切成半行。
  for (let count = accounts.length - 1; count > 0; count--) {
    const out = lines.slice();
    for (const account of accounts.slice(0, count)) {
      out.push('');
      out.push(...buildAccountDetailLines(account, { withTasks: false }));
    }
    out.push('');
    out.push(`（共 ${accounts.length} 个账号，仅显示前 ${count} 个，另有 ${accounts.length - count} 个未展示）`);
    const text = out.join('\n');
    if (text.length <= MAX_REPORT_CONTENT_LENGTH) return { title, content: text };
  }
  return { title, content: truncate(compactText) };
}

/**
 * 单账号运行结束推送。
 * result.status：ok 正常跑完 / skipped 主动跳过（带原因）/ stopped 被中断
 */
export function buildAccountRunReport({ account, result, summary, elapsedSec } = {}) {
  const status = result?.status || 'ok';
  const name = result?.accountName || account?.name || result?.accountId || account?.id || '账号';
  const stat = findAccountStat(summary, result?.accountId || account?.id);
  const lines = [];

  if (status === 'skipped') {
    lines.push('⏸ 本次未执行');
    lines.push(`原因：${result?.reason || '账号被跳过'}`);
    if (stat) {
      lines.push(
        `今日 ${signedPoints(stat.earned)}｜余额 ${toNumber(stat.balance)}｜`
        + `任务 ${toNumber(stat.doneTasks)}/${toNumber(stat.totalTasks)}`
      );
    }
    return { title: `账号跳过 [${name}]`, content: truncate(lines.join('\n')) };
  }

  if (status === 'stopped') {
    lines.push('⏹ 运行被中断');
    lines.push(`原因：${result?.reason || '任务在运行过程中被停止'}`);
    if (stat) {
      lines.push(`已累计 今日 ${signedPoints(stat.earned)}｜余额 ${toNumber(stat.balance)}`);
    }
    return { title: `账号中断 [${name}]`, content: truncate(lines.join('\n')) };
  }

  const elapsed = toNumber(elapsedSec, 0);
  if (elapsed > 0) lines.push(`⏱ 用时 ${elapsed.toFixed(1)} 秒`);
  lines.push(
    `💰 本轮 ${signedPoints(result?.runEarned)}｜今日 ${signedPoints(Number.isFinite(Number(result?.todayEarned)) ? result.todayEarned : stat?.earned)}`
    + `｜余额 ${toNumber(result?.endBalance ?? stat?.balance)}`
  );
  if (stat) {
    lines.push(
      `✅ 任务 ${toNumber(stat.doneTasks)}/${toNumber(stat.totalTasks)}（${toNumber(stat.percent)}%）`
      + `｜连签 ${toNumber(stat.streakDays)} 天`
    );
    const pending = Object.values(stat.tasks || {})
      .filter(task => {
        const info = describeTaskProgress(task);
        return !info.done && !info.unavailable;
      })
      .map(task => describeTaskProgress(task).text);
    if (pending.length > 0) {
      lines.push(`⏳ 未完成：${pending.join('、')}`);
    }
  }
  return { title: `账号运行结果 [${name}]`, content: truncate(lines.join('\n')) };
}

/**
 * 失败告警：正文必须写明原因
 */
export function buildAccountFailureReport({ accountName, error, at } = {}) {
  const name = accountName || '账号';
  const reason = String(error?.message || error || '未知错误').trim() || '未知错误';
  const lines = [];
  lines.push(`❌ 失败原因：${reason}`);
  lines.push(`⏰ 发生时间：${formatReportTime(at || new Date())}`);
  return { title: `微软积分打卡异常 [${name}]`, content: truncate(lines.join('\n')) };
}
