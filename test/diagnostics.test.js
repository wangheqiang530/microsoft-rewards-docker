import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDiagnosticReport,
  collectRecentLogLines,
  redactDiagnosticText
} from '../src/core/diagnostics.js';

function formatLogTime(timestamp) {
  const d = new Date(timestamp);
  const pad = value => String(value).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

test('诊断日志只收集最近 24 小时并保留续行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-diagnostics-lines-'));
  const now = new Date(2026, 10, 3, 12, 0, 0).getTime();
  const recentTime = formatLogTime(now - 60 * 60 * 1000);
  const oldTime = formatLogTime(now - 25 * 60 * 60 * 1000);
  fs.writeFileSync(path.join(dir, 'app.log.1'), [
    `[${oldTime}] 🔴 旧日志不应出现`,
    `[${recentTime}] 🟡 最近错误`,
    '  错误堆栈续行'
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'app.log'), `[${formatLogTime(now - 1000)}] ✅ 最新日志\n`);

  const result = collectRecentLogLines({ dataDir: dir, now, hours: 24 });
  assert.equal(result.truncated, false);
  assert.match(result.lines.join('\n'), /最近错误[\s\S]*错误堆栈续行/);
  assert.match(result.lines.join('\n'), /最新日志/);
  assert.doesNotMatch(result.lines.join('\n'), /旧日志不应出现/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('脱敏覆盖账号、凭据、邮箱、IP、代理与搜索词', () => {
  const input = [
    '账号 Alice 执行失败',
    'Cookie: _U=COOKIE_SECRET; _C_Auth=AUTH_SECRET',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'URL: https://login.live.com/oauth20_desktop.srf?code=M.C508_SECRET_CODE',
    '邮箱 alice@example.com',
    'IP 203.0.113.42',
    '代理 socks5h://proxy-user:proxy-pass@127.0.0.1:1080',
    '关键词: "Upcoming live music events"',
    '拟人键盘打字检索: "Private search phrase"',
    'GitHub Token gho_abcdefghijklmnopqrstuvwxyz'
  ].join('\n');
  const redacted = redactDiagnosticText(input, {
    byId: new Map(),
    literals: [{ text: 'Alice', alias: '账号-1' }]
  });

  assert.match(redacted, /\[账号-1\]/);
  assert.doesNotMatch(redacted, /COOKIE_SECRET|AUTH_SECRET|abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(redacted, /M\.C508_SECRET_CODE/);
  assert.doesNotMatch(redacted, /alice@example\.com/);
  assert.doesNotMatch(redacted, /203\.0\.113\.42/);
  assert.doesNotMatch(redacted, /proxy-user|proxy-pass/);
  assert.doesNotMatch(redacted, /Upcoming live music events|Private search phrase/);
  assert.doesNotMatch(redacted, /gho_abcdefghijklmnopqrstuvwxyz/);
});

test('诊断报告包含环境、任务状态和脱敏日志，不泄漏原始账号信息', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-diagnostics-report-'));
  const now = new Date(2026, 10, 3, 21, 30, 0).getTime();
  const logTime = formatLogTime(now - 5 * 60 * 1000);
  fs.writeFileSync(path.join(dir, 'app.log'), [
    `[${logTime}] 🔴 [Alice Example] Cookie: _U=COOKIE_SECRET; Authorization: Bearer abcdefghijklmnopqrstuvwxyz`,
    `[${logTime}] 🟡 [Alice Example] 用户 alice@example.com 搜索失败 IP=203.0.113.42`,
    `[${logTime}] ℹ️ [Alice Example] 关键词: "New York City Fall Big Apple"`
  ].join('\n'));

  const report = buildDiagnosticReport({
    version: '1.10.13',
    now,
    dataDir: dir,
    accounts: [{
      id: 'acc_alice',
      name: 'Alice Example',
      cookie: 'COOKIE_SECRET',
      refreshToken: 'REFRESH_SECRET'
    }],
    config: {
      tasks: { sign: true, read: true, search: true, dailySet: true },
      network: { useProxy: true, proxies: [{ url: 'socks5://user:pass@host' }] }
    },
    status: {
      running: false,
      summary: {
        doneTasksCount: 2,
        totalTasksCount: 5,
        overallPercent: 40,
        accountsList: [{
          id: 'acc_alice',
          name: 'Alice Example',
          enabled: true,
          hasCookie: true,
          hasToken: true,
          balance: 100,
          tasks: {
            dailySet: {
              name: '每日活动集 (Daily Set)',
              progress: 0,
              max: 3,
              done: false,
              statusMessage: '当前暂无可执行活动'
            }
          }
        }]
      }
    }
  });

  assert.match(report.content, /Microsoft Rewards Docker 诊断日志/);
  assert.match(report.content, /"version": "1\.10\.13"/);
  assert.match(report.content, /账号-1/);
  assert.match(report.content, /每日活动集 \(Daily Set\)/);
  assert.match(report.content, /最近 24 小时日志/);
  assert.doesNotMatch(report.content, /Alice Example|alice@example\.com/);
  assert.doesNotMatch(report.content, /COOKIE_SECRET|REFRESH_SECRET|abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(report.content, /203\.0\.113\.42|New York City Fall Big Apple/);
  assert.match(report.filename, /^msr-diagnostics-\d{8}-\d{6}-redacted\.txt$/);
  assert.equal(report.windowHours, 24);
  assert.ok(report.bytes > 0);

  fs.rmSync(dir, { recursive: true, force: true });
});
