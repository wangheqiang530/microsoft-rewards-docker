import fs from 'fs';
import os from 'os';
import path from 'path';
import { DATA_DIR } from '../fsUtil.js';

export const DIAGNOSTIC_WINDOW_HOURS = 24;
export const DIAGNOSTIC_MAX_BYTES = 2 * 1024 * 1024;

const MAX_LOG_LINE_CHARS = 12000;
const MAX_READ_BYTES_PER_FILE = 6 * 1024 * 1024;
const REDACTED = '[已脱敏]';

function formatLocalDate(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function formatFilenameTimestamp(timestamp) {
  const d = new Date(timestamp);
  const pad = value => String(value).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

export function parseDiagnosticLogTime(line = '') {
  const match = String(line).match(
    /^\[(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})\]/
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const timestamp = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  ).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readTail(filePath, maxBytes = MAX_READ_BYTES_PER_FILE) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8');
    return start > 0 && text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function createAccountAliases(accounts = []) {
  const byId = new Map();
  const literals = [];
  const seenAliases = new Map();

  accounts.forEach((account, index) => {
    const alias = `账号-${index + 1}`;
    if (account?.id) byId.set(String(account.id), alias);
    for (const value of [account?.name, account?.id]) {
      const text = String(value || '').trim();
      if (!text || seenAliases.has(text)) continue;
      seenAliases.set(text, alias);
      literals.push({ text, alias });
    }
  });

  literals.sort((a, b) => b.text.length - a.text.length);
  return { byId, literals };
}

function replaceLabeledValues(text, pattern, replacement = REDACTED) {
  return String(text || '').replace(pattern, (_, prefix) => `${prefix}${replacement}`);
}

/**
 * 诊断日志只面向公开排障，默认对账号、凭据、邮箱、IP、搜索词和本地路径脱敏。
 * 这里必须做服务端文本兜底，不能假设历史日志从未把敏感值拼进错误消息。
 */
export function redactDiagnosticText(input = '', accountAliases = createAccountAliases()) {
  let text = String(input || '');

  for (const { text: value, alias } of accountAliases.literals || []) {
    text = text.split(value).join(`[${alias}]`);
  }

  text = replaceLabeledValues(text, /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi);
  text = replaceLabeledValues(
    text,
    /((?<![A-Za-z0-9_])(?:set-cookie|cookie|authorization|proxy-authorization|x-api-key|refresh[_-]?token|access[_-]?token|authcodeurl|client[_-]?secret|bot[_-]?token|webhook(?:url)?|password)\s*["']?\s*[:=]\s*["']?)([^[\]"'\s,;}\]]+)/gi
  );
  text = replaceLabeledValues(
    text,
    /((?:^|[;\s])(?:_U|_C_Auth|WLS|RPSSecAuth|MUID|SRCHD|SRCHUID|SRCHUSR|_EDGE_S|ANON|NAP|amsc|RpsAuth)=)([^;\s]+)/gi
  );
  text = replaceLabeledValues(
    text,
    /([?&](?:code|access_token|refresh_token|id_token|client_secret|q|query|search)=)([^&#\s]+)/gi
  );
  text = text.replace(/(\/\/)([^/\s@]+)@/g, (_, prefix) => `${prefix}${REDACTED}@`);
  text = replaceLabeledValues(text, /((?:用户|用户名|显示名|Token 用户|网页端用户)\s*[:：]\s*)([^|，,\]\n]+)/gi);
  text = text.replace(
    /((?:Token 用户|网页端用户|用户|用户名|显示名)\s*[（(])([^）)\n]{1,120})([）)])/gi,
    (_, prefix, value, suffix) => `${prefix}${REDACTED}${suffix}`
  );
  text = replaceLabeledValues(
    text,
    /((?:键入关键词|关键词|检索词|搜索词|检索|query)\s*[:：=]\s*["“']?)([^"”'\n]{1,200})/gi
  );

  text = text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[邮箱已脱敏]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[Token已脱敏]')
    .replace(/\bM\.C[A-Za-z0-9._~-]{12,}\b/g, '[授权码已脱敏]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, '[密钥已脱敏]')
    .replace(/\b[a-f0-9]{40,}\b/gi, '[长哈希已脱敏]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, match => (
      match === '127.0.0.1' || match === '0.0.0.0' ? match : '[IP已脱敏]'
    ))
    .replace(/\b(?:[a-f0-9]{1,4}:){3,7}[a-f0-9]{1,4}\b/gi, '[IPv6已脱敏]')
    .replace(/\/Users\/[^/\s]+\//g, '/Users/[用户]/')
    .replace(/[A-Z]:\\Users\\[^\\\s]+\\/gi, 'C:\\Users\\[用户]\\');

  return text;
}

export function collectRecentLogLines({
  dataDir = DATA_DIR,
  hours = DIAGNOSTIC_WINDOW_HOURS,
  now = Date.now(),
  maxBytes = DIAGNOSTIC_MAX_BYTES
} = {}) {
  const windowMs = Math.max(1, Number(hours) || DIAGNOSTIC_WINDOW_HOURS) * 60 * 60 * 1000;
  const cutoff = now - windowMs;
  const files = [path.join(dataDir, 'app.log.1'), path.join(dataDir, 'app.log')];
  const entries = [];
  let sequence = 0;
  let currentEntry = null;

  for (const filePath of files) {
    const text = readTail(filePath);
    for (const rawLine of text.split('\n')) {
      const line = rawLine.length > MAX_LOG_LINE_CHARS
        ? `${rawLine.slice(0, MAX_LOG_LINE_CHARS)} ...[单行日志已截断]`
        : rawLine;
      if (!line.trim()) continue;
      const timestamp = parseDiagnosticLogTime(line);
      if (timestamp !== null) {
        currentEntry = {
          timestamp,
          sequence: sequence++,
          line,
          included: timestamp >= cutoff && timestamp <= now + 5 * 60 * 1000
        };
        if (currentEntry.included) {
          entries.push(currentEntry);
        }
        continue;
      }
      if (currentEntry?.included) {
        currentEntry.line += `\n${line}`;
      }
    }
  }

  entries.sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence);
  let lines = entries.map(entry => entry.line);
  let truncated = false;
  let droppedLines = 0;
  let totalBytes = Buffer.byteLength(lines.join('\n'), 'utf8');
  let firstKeptIndex = 0;
  while (firstKeptIndex < lines.length && totalBytes > maxBytes) {
    totalBytes -= Buffer.byteLength(lines[firstKeptIndex], 'utf8') + 1;
    firstKeptIndex++;
    droppedLines++;
    truncated = true;
  }
  if (firstKeptIndex > 0) lines = lines.slice(firstKeptIndex);

  return {
    lines,
    truncated,
    droppedLines,
    windowHours: windowMs / 60 / 60 / 1000
  };
}

function sanitizeTask(task = {}) {
  return {
    name: String(task.name || ''),
    progress: Number(task.progress || 0),
    max: Number(task.max || 0),
    points: Number(task.points || 0),
    done: task.done === true,
    statusMessage: String(task.statusMessage || ''),
    searchTier: task.searchTier || null
  };
}

function sanitizeDiagnosis(diagnosis = null) {
  if (!diagnosis || typeof diagnosis !== 'object') return null;
  return {
    checkedAt: Number(diagnosis.checkedAt || 0),
    cookieValid: diagnosis.cookieValid === true,
    cookieTransient: diagnosis.cookieTransient === true,
    tokenValid: diagnosis.tokenValid === true,
    overallValid: diagnosis.overallValid === true,
    warning: diagnosis.warning === true,
    balance: Number(diagnosis.balance || 0)
  };
}

function buildAccountSummary(status = {}, accountAliases) {
  const accounts = Array.isArray(status?.summary?.accountsList)
    ? status.summary.accountsList
    : [];

  return accounts.map((account, index) => {
    const alias = accountAliases.byId.get(String(account.id || '')) || `账号-${index + 1}`;
    const tasks = {};
    for (const [key, task] of Object.entries(account.tasks || {})) {
      tasks[key] = sanitizeTask(task);
    }
    return {
      alias,
      enabled: account.enabled !== false,
      schedulePaused: account.schedulePaused === true,
      hasCookie: account.hasCookie === true,
      hasToken: account.hasToken === true,
      balance: Number(account.balance || 0),
      earned: Number(account.earned || 0),
      claimablePoints: Number(account.claimablePoints || 0),
      streakDays: Number(account.streakDays || 0),
      stamps: account.stamps || { progress: 0, max: 12 },
      doneTasks: Number(account.doneTasks || 0),
      totalTasks: Number(account.totalTasks || 0),
      percent: Number(account.percent || 0),
      lastUpdate: Number(account.lastUpdate || 0),
      lastRunAt: Number(account.lastRunAt || 0),
      authDiagnosis: sanitizeDiagnosis(account.authDiagnosis),
      tasks
    };
  });
}

function buildEnvironmentSummary() {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    inDocker: fs.existsSync('/.dockerenv'),
    uptimeSeconds: Math.floor(process.uptime())
  };
}

function buildConfigSummary(config = {}) {
  return {
    tasks: {
      sign: config.tasks?.sign !== false,
      appPromotions: config.tasks?.appPromotions !== false,
      read: config.tasks?.read !== false,
      search: config.tasks?.search !== false,
      promos: config.tasks?.promos !== false,
      desktopApp: config.tasks?.desktopApp !== false,
      dailySet: config.tasks?.dailySet !== false,
      searchEngineMode: config.tasks?.searchEngineMode || '',
      searchIntervalSec: Number(config.tasks?.searchIntervalSec || 0),
      searchJitterSec: Number(config.tasks?.searchJitterSec || 0),
      searchStagnantLimit: Number(config.tasks?.searchStagnantLimit || 0),
      accountGapSec: Number(config.tasks?.accountGapSec || 0)
    },
    browser: {
      useGpu: config.browser?.useGpu === true,
      gpuBackend: config.browser?.gpuBackend || ''
    },
    network: {
      lockRegion: config.network?.lockRegion !== false,
      globalProxyEnabled: config.network?.useProxy === true,
      proxyNodeCount: Array.isArray(config.network?.proxies) ? config.network.proxies.length : 0
    },
    schedule: {
      enabled: config.schedule?.enabled !== false,
      cron: config.schedule?.cron || ''
    }
  };
}

function isWarningOrErrorLine(line = '') {
  return /(?:🔴|🟡|❌|⚠️|失败|异常|错误|超时|未完成|未生效|not found|timeout|error|failed)/i.test(line);
}

export function buildDiagnosticReport({
  version = '',
  accounts = [],
  config = {},
  status = {},
  dataDir = DATA_DIR,
  now = Date.now(),
  hours = DIAGNOSTIC_WINDOW_HOURS,
  maxBytes = DIAGNOSTIC_MAX_BYTES
} = {}) {
  const accountAliases = createAccountAliases(accounts);
  const recent = collectRecentLogLines({
    dataDir,
    hours,
    now,
    maxBytes: Math.max(64 * 1024, maxBytes - 256 * 1024)
  });
  const redactedLines = recent.lines.map(line => redactDiagnosticText(line, accountAliases));
  const accountSummary = buildAccountSummary(status, accountAliases);
  const warningLines = redactedLines.filter(isWarningOrErrorLine).slice(-80);
  const generatedAt = formatLocalDate(now);
  const filename = `msr-diagnostics-${formatFilenameTimestamp(now)}-redacted.txt`;
  const summary = {
    generatedAt,
    windowHours: hours,
    logLines: redactedLines.length,
    logTruncated: recent.truncated,
    droppedLogLines: recent.droppedLines,
    accountCount: accounts.length,
    running: status?.running === true,
    turboMode: status?.turboMode === true,
    tasksDone: Number(status?.summary?.doneTasksCount || 0),
    tasksTotal: Number(status?.summary?.totalTasksCount || 0),
    overallPercent: Number(status?.summary?.overallPercent || 0)
  };

  const sections = [
    'Microsoft Rewards Docker 诊断日志',
    '================================',
    '',
    '本文件由程序自动生成，默认已脱敏，仅包含最近 24 小时数据。',
    '发布到公开 Issue 前，请再次检查“问题描述”与日志内容。',
    '',
    '[导出信息]',
    JSON.stringify({
      version,
      ...summary,
      redactionMode: 'server-side-redacted',
      maxBytes
    }, null, 2),
    '',
    '[运行环境]',
    JSON.stringify(buildEnvironmentSummary(), null, 2),
    '',
    '[任务配置摘要]',
    JSON.stringify(buildConfigSummary(config), null, 2),
    '',
    '[账号与任务状态]',
    JSON.stringify(accountSummary, null, 2),
    '',
    '[最近警告与错误]',
    warningLines.length > 0 ? warningLines.join('\n') : '未发现明显警告或错误日志。',
    '',
    '[最近 24 小时日志]',
    recent.truncated
      ? `日志超过大小上限，已省略最早的 ${recent.droppedLines} 行。`
      : '未发生日志截断。',
    redactedLines.length > 0 ? redactedLines.join('\n') : '最近 24 小时没有运行日志。',
    '',
    '[问题描述（请补充后发布）]',
    '- 出问题的任务：',
    '- 预期结果：',
    '- 实际结果：',
    '- 首次出现时间：',
    '- 是否重新授权后仍复现：',
    ''
  ];

  let content = redactDiagnosticText(sections.join('\n'), accountAliases);
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    const bytes = Buffer.from(content, 'utf8');
    content = bytes.subarray(bytes.length - maxBytes).toString('utf8');
    const firstLineBreak = content.indexOf('\n');
    if (firstLineBreak >= 0) content = content.slice(firstLineBreak + 1);
    content = `[诊断内容超过 ${formatBytes(maxBytes)}，已保留末尾内容]\n\n${content}`;
  }

  return {
    content,
    filename,
    generatedAt,
    windowHours: hours,
    bytes: Buffer.byteLength(content, 'utf8'),
    lineCount: redactedLines.length,
    truncated: recent.truncated || Buffer.byteLength(content, 'utf8') >= maxBytes
  };
}
