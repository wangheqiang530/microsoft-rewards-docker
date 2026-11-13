import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import httpProxy from 'http-proxy';
import { fileURLToPath } from 'url';
import configManager, { SECRET_PLACEHOLDER } from '../config.js';
import logger from '../logger.js';
import taskManager from '../core/taskManager.js';
import authManager from '../core/auth.js';
import notifier from '../core/notifier.js';
import scheduler from '../scheduler.js';
import rewardsApi from '../core/api.js';
import networkClient from '../network.js';
import historyManager from '../core/history.js';
import browserManager from '../core/browser.js';
import epicManager, { normalizeAutoClaimTime } from '../core/epic.js';
import { accountContextLock } from '../core/contextLock.js';
import { isDemoMode } from '../core/demoMode.js';
import { normalizeProxyUrl } from '../core/proxy.js';
import microsoftLoginWindow, { isVncAvailable } from '../core/microsoftLoginWindow.js';
import { checkGpuCapability } from '../core/gpuProbe.js';
import { getFontStatus, refreshFontCache } from '../core/fontStatus.js';
import {
  buildDiagnosticReport,
  DIAGNOSTIC_WINDOW_HOURS
} from '../core/diagnostics.js';
import { endJson, startJsonHeartbeat } from './jsonHeartbeat.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CURRENT_VERSION = '1.10.19';

let lastCpuInfo = os.cpus().map(c => c.times);

/**
 * HTTP Basic 鉴权判定。Express 中间件与 noVNC 的 WebSocket 升级握手共用同一套规则，
 * 避免出现「页面要密码、WebSocket 不用」的绕过口子。
 */
export function isBasicAuthSatisfied(req) {
  const password = configManager.get()?.server?.authPassword;
  if (!password) return true;

  const header = req.headers?.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    const sep = decoded.indexOf(':');
    const pass = sep >= 0 ? decoded.slice(sep + 1) : decoded;
    return pass === password;
  } catch {
    return false;
  }
}

// 宿主机整机 CPU 负载率（仅在读不到容器 cgroup 时作为回退值）
function getHostCpuUsage() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (let i = 0; i < cpus.length; i++) {
    const prev = lastCpuInfo[i] || { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const cur = cpus[i].times;
    const prevTotal = Object.values(prev).reduce((a, b) => a + b, 0);
    const curTotal = Object.values(cur).reduce((a, b) => a + b, 0);
    total += (curTotal - prevTotal);
    idle += (cur.idle - prev.idle);
  }
  lastCpuInfo = cpus.map(c => c.times);
  const usage = total > 0 ? Math.max(0, Math.min(100, Math.round(((total - idle) / total) * 100))) : 2;
  return usage;
}

// ===== 容器资源监控 =====
// 说明：os.cpus()/os.totalmem() 读到的是「宿主机整机」数据，不是容器自身占用。
// 在 Docker/NAS 里必须读 cgroup，才能得到用户实际关心的容器 CPU 与内存。
// 不同 NAS 的 cgroup 形态差异很大（v1/v2、容器内私有命名空间、宿主机挂载），
// 因此按 /proc/self/cgroup + /proc/self/mountinfo 动态解析容器自身的 cgroup 目录。
// MSR_CGROUP_DIR 仅用于测试时覆盖解析结果。

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

/** 解析 /proc/self/cgroup：v2 统一层级路径 + v1 各 controller 路径 */
function parseSelfCgroup() {
  const text = readTextFile('/proc/self/cgroup') || '';
  const v2Match = text.match(/^0::(.*)$/m);
  const v1 = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\d+:([^:]*):(.*)$/);
    if (!m) continue;
    for (const c of m[1].split(',')) {
      if (c) v1[c] = m[2];
    }
  }
  return { v2: v2Match ? v2Match[1] : null, v1 };
}

/** 解析 /proc/self/mountinfo 中的 cgroup 挂载点 */
function parseCgroupMounts() {
  const text = readTextFile('/proc/self/mountinfo') || '';
  const mounts = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.split(' ');
    const sep = parts.indexOf('-');
    if (sep === -1) continue;
    mounts.push({
      root: parts[3] || '/',
      mountPoint: parts[4] || '',
      fstype: parts[sep + 1] || '',
      superOptions: parts[sep + 3] || ''
    });
  }
  return mounts;
}

function joinCgroupPath(mountPoint, mountRoot, cgroupPath) {
  let rel = cgroupPath || '/';
  if (mountRoot && mountRoot !== '/' && rel.startsWith(mountRoot)) {
    rel = rel.slice(mountRoot.length);
  }
  const joined = path.join(mountPoint, rel || '/');
  // 去掉末尾多余的 '/'（path.join('/sys/fs/cgroup', '/') 会得到带尾斜杠的结果）
  return joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
}

/**
 * 返回容器自身 cgroup 目录候选（按优先级）。
 * controller 仅用于 cgroup v1（'memory' / 'cpuacct'）。
 */
function resolveCgroupDirs(controller) {
  const override = process.env.MSR_CGROUP_DIR;
  if (override) {
    // 测试用：直接指定目录，v2/v1 文件都尝试
    return [{ dir: override, version: 2 }, { dir: override, version: 1 }];
  }

  const { v2, v1 } = parseSelfCgroup();
  const mounts = parseCgroupMounts();
  const dirs = [];

  if (v2 !== null) {
    const mount = mounts.find(m => m.fstype === 'cgroup2');
    if (mount) dirs.push({ dir: joinCgroupPath(mount.mountPoint, mount.root, v2), version: 2 });
  }
  const cgPath = v1[controller];
  if (cgPath !== undefined) {
    const mount = mounts.find(m => m.fstype === 'cgroup' && m.superOptions.split(',').includes(controller));
    if (mount) dirs.push({ dir: joinCgroupPath(mount.mountPoint, mount.root, cgPath), version: 1 });
  }
  // 兜底：cgroup 命名空间私有时，/sys/fs/cgroup 根目录就是容器自身
  if (v2 === '/') dirs.push({ dir: '/sys/fs/cgroup', version: 2 });
  if (v1[controller] === '/') dirs.push({ dir: '/sys/fs/cgroup', version: 1 });

  return dirs;
}

/** 容器累计 CPU 时间（微秒），读不到返回 null */
function readContainerCpuUsec() {
  for (const { dir, version } of resolveCgroupDirs('cpuacct')) {
    if (version === 2) {
      // cgroup v2: cpu.stat -> usage_usec
      const stat = readTextFile(path.join(dir, 'cpu.stat'));
      const m = stat && stat.match(/^usage_usec\s+(\d+)/m);
      if (m) return Number(m[1]);
      continue;
    }
    // cgroup v1: cpuacct.usage 单位是纳秒
    const raw = readTextFile(path.join(dir, 'cpuacct.usage'));
    if (raw && /^\d+$/.test(raw)) return Math.floor(Number(raw) / 1000);
  }
  return null;
}

let lastContainerCpu = null;
let lastContainerCpuPercent = 0;

/**
 * 容器 CPU 占用百分比（与 docker stats 口径一致：占单核的百分比，
 * 例如 150% 表示约 1.5 个核心）。首次采样没有基线，返回 0。
 */
function getContainerCpuPercent() {
  const usageUsec = readContainerCpuUsec();
  const now = Date.now();
  if (usageUsec === null) return null;

  if (!lastContainerCpu) {
    lastContainerCpu = { usageUsec, at: now };
    return 0;
  }
  const cpuDelta = usageUsec - lastContainerCpu.usageUsec;
  const wallDeltaUsec = (now - lastContainerCpu.at) * 1000;
  // 采样窗口过短（例如用户手动连点刷新）会让百分比剧烈抖动，直接复用上次结果
  if (wallDeltaUsec < 1000 * 1000) return lastContainerCpuPercent;
  lastContainerCpu = { usageUsec, at: now };
  if (cpuDelta < 0) return lastContainerCpuPercent;
  lastContainerCpuPercent = Math.max(0, Math.min(999, Math.round((cpuDelta / wallDeltaUsec) * 100)));
  return lastContainerCpuPercent;
}

/**
 * 容器内存占用（字节）。与 docker stats 一样扣除 inactive file cache，
 * 否则会把页面缓存也算成占用。读不到 cgroup 时返回 null。
 */
function readContainerMemory() {
  for (const { dir, version } of resolveCgroupDirs('memory')) {
    if (version === 2) {
      const current = readTextFile(path.join(dir, 'memory.current'));
      if (current === null) continue;
      const stat = readTextFile(path.join(dir, 'memory.stat'));
      const limitRaw = readTextFile(path.join(dir, 'memory.max'));
      const inactiveFile = stat ? Number((stat.match(/^inactive_file\s+(\d+)/m) || [])[1] || 0) : 0;
      const limit = limitRaw && limitRaw !== 'max' ? Number(limitRaw) : null;
      return {
        usage: Math.max(0, Number(current) - inactiveFile),
        limit: limit && Number.isFinite(limit) ? limit : null,
        source: 'cgroup v2'
      };
    }
    const current = readTextFile(path.join(dir, 'memory.usage_in_bytes'));
    if (current === null) continue;
    const stat = readTextFile(path.join(dir, 'memory.stat'));
    const limitRaw = readTextFile(path.join(dir, 'memory.limit_in_bytes'));
    const inactiveFile = stat ? Number((stat.match(/^total_inactive_file\s+(\d+)/m) || [])[1] || 0) : 0;
    const limitNum = limitRaw ? Number(limitRaw) : null;
    return {
      usage: Math.max(0, Number(current) - inactiveFile),
      // v1 的“无限制”是一个极大的数字（约 2^63），需要过滤掉
      limit: limitNum && limitNum < 1e15 ? limitNum : null,
      source: 'cgroup v1'
    };
  }
  return null;
}

/**
 * 兜底方案：累计容器内所有进程的 RSS。
 * 容器 PID 命名空间下 /proc 只包含本容器进程，这样即使读不到 cgroup，
 * 也能得到 node + Chromium 等全部进程的合计占用，而不是只有 Node 一个进程。
 */
function sumContainerProcessRss() {
  const selfCgroup = readTextFile('/proc/self/cgroup') || '';
  let totalBytes = 0;
  let counted = 0;
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    // 只统计与本进程同 cgroup 的进程，避免 --pid=host 时把宿主机进程也算进来
    if (readTextFile(`/proc/${name}/cgroup`) !== selfCgroup) continue;
    const status = readTextFile(`/proc/${name}/status`);
    const m = status && status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (m) {
      totalBytes += Number(m[1]) * 1024;
      counted++;
    }
  }
  if (counted === 0) return null;
  return { usage: totalBytes, limit: null, source: `进程合计 (${counted} 个进程)` };
}

let lastPingMs = 28;
let lastPingTime = 0;

/**
 * 语义化版本号比较（返回 >0 表示 a 比 b 新）。
 * 不能用字符串直接比较：字符串比较下 "1.4.9" 会大于 "1.4.10"，从而误报有新版本。
 */
function compareVersions(a, b) {
  const parse = v => String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function getNetworkPing() {
  if (Date.now() - lastPingTime < 30000) return lastPingMs;
  const start = Date.now();
  try {
    await fetch('https://cn.bing.com/favicon.ico', { method: 'HEAD', signal: AbortSignal.timeout(2500) });
    lastPingMs = Math.max(5, Date.now() - start);
    lastPingTime = Date.now();
  } catch {
    lastPingMs = Math.max(5, Date.now() - start);
  }
  return lastPingMs;
}

export function createServer() {
  const app = express();
  app.disable('x-powered-by');

  // 健康检查（免认证）：Docker HEALTHCHECK 用它，否则开启密码后会因 401 被判为不健康
  app.get('/api/health', (req, res) => {
    res.json({ success: true, status: 'ok', uptime: Math.floor(process.uptime()) });
  });

  // 访问控制：当配置了 server.authPassword 时启用 HTTP Basic 认证。
  // 注意：/api/config 会返回全部账号的 Cookie 与 Token，未设密码时任何能访问该端口的人
  // 都能拿到账号凭据，强烈建议设置密码（尤其是把端口暴露到内网之外时）。
  app.use((req, res, next) => {
    if (isBasicAuthSatisfied(req)) return next();

    res.set('WWW-Authenticate', 'Basic realm="Microsoft Rewards", charset="UTF-8"');
    res.status(401).send('需要认证：请在配置中设置 server.authPassword 后使用该密码访问');
  });

  // noVNC 通过现有 5308 端口反向代理，避免依赖宿主机额外映射 6080。
  // 必须注册在认证中间件之后：noVNC 能直接操作已登录 Epic 会话的浏览器，
  // 一旦绕过密码就等于把账号交出去。
  const novncProxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${process.env.NOVNC_PORT || 6080}`,
    ws: true,
    changeOrigin: true
  });
  novncProxy.on('error', (err, req, res) => {
    if (res?.writeHead && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`noVNC 代理不可用: ${err.message}`);
    }
  });
  app.locals.novncProxy = novncProxy;
  // 供 src/index.js 在 WebSocket 升级阶段复用同一套鉴权规则。
  app.locals.isBasicAuthSatisfied = isBasicAuthSatisfied;
  // noVNC 静态资源从容器内 /usr/share/novnc 提供（Debian novnc 包默认路径）。
  app.use('/novnc', express.static(process.env.NOVNC_STATIC_DIR || '/usr/share/novnc'));
  // 不使用 app.use('/websockify', ...)：express 会剥掉挂载前缀，这里保留原始 URL 再转发。
  app.use((req, res, next) => {
    const requestUrl = String(req.url || '');
    const isNovncPath = requestUrl.startsWith('/novnc/websockify');
    if (!requestUrl.startsWith('/websockify') && !isNovncPath) return next();
    if (isNovncPath) {
      req.url = req.url.replace(/^\/novnc/, '');
    }
    novncProxy.web(req, res);
  });

  // 配置里可能包含多个账号的完整 Cookie，默认 100KB 很容易在保存时触发 413。
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // 0. 系统硬件与网络实时监控指标
  app.get('/api/system/metrics', async (req, res) => {
    try {
      const containerCpu = getContainerCpuPercent();
      const hostCpuPercent = getHostCpuUsage();
      const ping = await getNetworkPing();

      // 宿主机整机内存（仅作参考，NAS 上通常远大于容器占用）
      const totalMemBytes = os.totalmem();
      const freeMemBytes = os.freemem();
      const usedMemBytes = totalMemBytes - freeMemBytes;
      const hostMemPercent = Math.round((usedMemBytes / totalMemBytes) * 100);

      // 容器自身内存（含 Chromium 等子进程），这才是用户想看的数字。
      // 读不到 cgroup 时退而求其次，累计容器内所有进程的 RSS。
      const containerMem = readContainerMemory() || sumContainerProcessRss();
      const memUsage = process.memoryUsage();
      const procMemMB = Math.round(memUsage.rss / (1024 * 1024));
      const heapUsedMB = Math.round(memUsage.heapUsed / (1024 * 1024));
      const heapTotalMB = Math.round(memUsage.heapTotal / (1024 * 1024));
      const totalMemGB = (totalMemBytes / (1024 * 1024 * 1024)).toFixed(1);
      const usedMemGB = (usedMemBytes / (1024 * 1024 * 1024)).toFixed(1);

      const containerMemMB = containerMem ? Math.round(containerMem.usage / (1024 * 1024)) : procMemMB;
      const containerLimitMB = containerMem?.limit ? Math.round(containerMem.limit / (1024 * 1024)) : null;
      const containerMemPercent = containerLimitMB
        ? Math.max(0, Math.min(100, Math.round((containerMemMB / containerLimitMB) * 100)))
        : null;

      // 顶部胶囊优先展示容器指标；读不到 cgroup（例如本机直接跑）时回退到整机/进程指标
      const displayCpuPercent = containerCpu === null ? hostCpuPercent : containerCpu;
      const displayMemMB = containerMem ? containerMemMB : procMemMB;
      const displayMemPercent = containerMemPercent === null ? hostMemPercent : containerMemPercent;

      const uptimeSec = Math.floor(process.uptime());
      const uptimeStr = uptimeSec > 3600
        ? `${Math.floor(uptimeSec / 3600)}小时 ${Math.floor((uptimeSec % 3600) / 60)}分`
        : `${Math.floor(uptimeSec / 60)}分 ${uptimeSec % 60}秒`;

      res.json({
        success: true,
        data: {
          cpu: `${displayCpuPercent}%`,
          cpuIsContainer: containerCpu !== null,
          procMem: `${displayMemMB} MB`,
          memIsContainer: !!containerMem,
          sysMem: `${usedMemGB}G/${totalMemGB}G`,
          memPercent: displayMemPercent,
          ping: `${ping} ms`,
          containerDetails: {
            processRss: `${procMemMB} MB`,
            heap: `${heapUsedMB} MB / ${heapTotalMB} MB`,
            containerMemory: containerMem ? `${containerMemMB} MB` : null,
            containerMemoryLimit: containerLimitMB ? `${containerLimitMB} MB` : '无限制',
            containerMemoryPercent: containerMemPercent,
            containerMemorySource: containerMem?.source || null,
            hostMemory: `${usedMemGB} GB / ${totalMemGB} GB (${hostMemPercent}%)`,
            hostCpu: `${hostCpuPercent}%`,
            uptime: uptimeStr,
            platform: `${os.type()} ${os.arch()}`,
            nodeVersion: process.version
          }
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 0.5 检查版本更新
  // 注意：发布流程只推 git tag，不建 GitHub Release，所以不能用 releases/latest。
  // 它返回的是「最近一次发布的 Release」，历史上只到 v1.6.2；于是 v1.6.3~v1.7.2
  // 之间的用户比较出来是「无需更新」，永远收不到升级提示。
  // 这里改为直接读 tags 列表取语义化版本最大值，Release 仅用于补充更新说明。
  let cachedLatest = null;
  let cachedLatestTime = 0;

  const GITHUB_REPO = 'wangheqiang530/microsoft-rewards-docker';

  async function fetchLatestVersionInfo() {
    const tagRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=100`, {
      headers: { 'User-Agent': 'microsoft-rewards-docker', 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000)
    });
    if (!tagRes.ok) throw new Error(`GitHub tags 接口返回 ${tagRes.status}`);
    const tags = await tagRes.json();
    if (!Array.isArray(tags)) throw new Error('GitHub tags 返回格式异常');

    let latest = null;
    for (const t of tags) {
      const name = String(t?.name || '').trim();
      // 只认 vX.Y.Z 形式的版本标签，过滤掉临时标签
      if (!/^v\d+\.\d+\.\d+$/.test(name)) continue;
      if (!latest || compareVersions(name.replace(/^v/, ''), latest) > 0) {
        latest = name.replace(/^v/, '');
      }
    }
    if (!latest) throw new Error('未在 tags 中找到 vX.Y.Z 形式的版本标签');

    // 更新说明是锦上添花，拿不到不影响版本比较
    let release = null;
    try {
      const relRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${latest}`, {
        headers: { 'User-Agent': 'microsoft-rewards-docker', 'Accept': 'application/vnd.github+json' },
        signal: AbortSignal.timeout(4000)
      });
      if (relRes.ok) release = await relRes.json();
    } catch {}

    return { latestVersion: latest, release };
  }

  app.get('/api/system/check-update', async (req, res) => {
    const currentVersion = CURRENT_VERSION;
    try {
      if (!cachedLatest || Date.now() - cachedLatestTime > 10 * 60 * 1000) {
        cachedLatest = await fetchLatestVersionInfo();
        cachedLatestTime = Date.now();
      }

      const latestVersion = cachedLatest.latestVersion;
      const release = cachedLatest.release;
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

      res.json({
        success: true,
        data: {
          currentVersion,
          latestVersion,
          hasUpdate,
          checkFailed: false,
          releaseUrl: release?.html_url || `https://github.com/${GITHUB_REPO}/releases/tag/v${latestVersion}`,
          releaseTitle: release?.name || `v${latestVersion}`,
          releaseNotes: release?.body || ''
        }
      });
    } catch (e) {
      // 检查失败必须如实上报。以前这里静默回退成「已是最新」，
      // 让「GitHub 被墙 / 限流」和「确实是最新版」两种情况长得一模一样。
      res.json({
        success: true,
        data: {
          currentVersion,
          latestVersion: currentVersion,
          hasUpdate: false,
          checkFailed: true,
          checkError: e.message,
          releaseUrl: `https://github.com/${GITHUB_REPO}/releases`
        }
      });
    }
  });

  // 1. 获取当前状态（支持按账号过滤）
  app.get('/api/status', (req, res) => {
    const accountId = req.query.accountId || 'all';
    const data = taskManager.getStatus(accountId);
    // 附带各账号的下次计划启动时间，供卡片展示
    data.schedule = scheduler.getNextRunInfo();
    res.json({
      success: true,
      data
    });
  });

  // 1.2 主动从微软官网同步真实完成进度
  let lastSyncAllTime = 0;
  app.post('/api/status/sync', async (req, res) => {
    try {
      const accountId = req.body?.accountId || null;
      const force = req.body?.force === true;
      // 有任务正在执行时不允许同步：同步会切换全局账号上下文，
      // 把正在跑的任务算到别的账号头上。此时直接返回当前缓存状态。
      const busy = accountContextLock.isBusy();
      let skipped = false;
      let skipReason = '';
      if (accountId && accountId !== 'all') {
        const accCfg = configManager.resolveAccount(accountId);
        if (!accCfg) {
          return res.status(404).json({ success: false, message: '账号未找到' });
        }
        skipped = busy;
        // 手动刷新进度是暂停账号明确允许的例外，可刷新 Token 以读取最新官网数据。
        if (!busy) await taskManager.syncAccountOfficialStatus(accCfg, { allowPaused: true });
      } else {
        const now = Date.now();
        const COOLDOWN_MS = 3 * 60 * 1000; // 3分钟全量同步冷却
        if (!force && (now - lastSyncAllTime < COOLDOWN_MS)) {
          skipped = true;
          skipReason = `全量同步冷却中（剩余 ${Math.ceil((COOLDOWN_MS - (now - lastSyncAllTime)) / 1000)} 秒），直接返回本地缓存以保护账号安全`;
        } else {
          skipped = busy;
          if (!busy) {
            lastSyncAllTime = now;
            // 手动全量刷新也允许包含暂停账号；自动任务不会调用这里。
            await taskManager.syncAllOfficialStatus({ allowPaused: true });
          }
        }
      }
      res.json({
        success: true,
        skipped,
        message: skipReason || (skipped ? '任务正在执行中，已跳过同步以避免账号上下文串台' : ''),
        data: taskManager.getStatus(accountId || 'all')
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 1.5 多账号管理接口 (包含 order 排序)
  app.get('/api/accounts', (req, res) => {
    const accounts = configManager.getAccounts().map(a => ({
      id: a.id,
      name: a.name,
      order: a.order !== undefined ? Number(a.order) : 999,
      enabled: a.enabled !== false,
      pausedAt: a.pausedAt || 0,
      hasCookie: !!a.cookie,
      hasToken: !!a.refreshToken,
      hasAuthCodeUrl: !!a.authCodeUrl,
      tokenTime: a.tokenTime || 0,
      authDiagnosis: a.authDiagnosis || null,
      proxyMode: configManager.getAccountProxyMode(a),
      proxyId: configManager.getAccountProxyMode(a) === 'proxy' ? (a.proxyId || '') : '',
      runHours: a.runHours || [a.timeSlot?.startHour || 9],
      timeSlot: a.timeSlot
    }));
    res.json({ success: true, data: accounts });
  });

  app.post('/api/accounts', async (req, res) => {
    const needsTokenExchange = !!(
      req.body?.authCodeUrl
      && String(req.body.authCodeUrl).includes('code=')
      && req.body?.tokenAlreadyExchanged !== true
    );
    const lockOwner = needsTokenExchange
      ? `web-account-add:${Date.now()}:${Math.random().toString(36).slice(2)}`
      : null;
    try {
      if (req.body?.id && accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '任务正在执行中，暂不能修改该账号凭据' });
      }
      if (lockOwner && !accountContextLock.tryAcquire(lockOwner)) {
        return res.status(409).json({ success: false, message: '任务正在执行中，暂不能换取该账号 Token' });
      }
      const accountPayload = { ...(req.body || {}) };
      delete accountPayload.tokenAlreadyExchanged;
      delete accountPayload.proxy;
      if (accountPayload.proxyMode === 'proxy' && !configManager.findProxy(accountPayload.proxyId)) {
        throw new Error('该账号选择了指定代理，但代理节点不存在');
      }
      let saved = configManager.upsertAccount(accountPayload);
      const scheduleConflict = saved.scheduleConflict || null;
      taskManager.ensureAccountStats(saved.id);
      let tokenExchanged = false;
      if (needsTokenExchange) {
        const prevContext = rewardsApi.snapshotAccountContext();
        try {
          rewardsApi.setCurrentAccount(saved);
          networkClient.setActiveProxySelection(req.body?.proxy);
          await authManager.exchangeCodeForToken(req.body.authCodeUrl, saved.id, {
            name: saved.name,
            order: saved.order
          });
          saved = configManager.getAccount(saved.id) || saved;
          tokenExchanged = true;
        } catch (eToken) {
          logger.log('🟡', `新建账号 [${saved.name}] 自动换取 Token 提示: ${eToken.message}`);
        } finally {
          rewardsApi.restoreAccountContext(prevContext);
        }
      }
      res.json({
        success: true,
        data: {
          id: saved.id,
          name: saved.name,
          runHours: saved.runHours || [],
          scheduleConflict
        },
        scheduleCleared: !!scheduleConflict,
        tokenExchanged
      });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    } finally {
      if (lockOwner) accountContextLock.release(lockOwner);
    }
  });

  // 一键切换账号启用/停用 (继续/暂停)
  app.post('/api/accounts/:id/toggle', (req, res) => {
    try {
      // 必须精确匹配：getAccount() 在 id 不存在时会回退到第一个账号，
      // 那样「暂停某个不存在的账号」会误操作到主账号上
      const acc = configManager.resolveAccount(req.params.id);
      if (!acc) return res.status(404).json({ success: false, message: '账号未找到' });
      const newEnabled = acc.enabled === false;
      const updated = configManager.setAccountEnabled(acc.id, newEnabled);
      if (!newEnabled) taskManager.pauseAccount(acc.id);
      logger.log(
        newEnabled ? '🟢' : '⏸️',
        newEnabled
          ? `账号 [${updated.name || updated.id}] 已启用，数据与凭据保持不变`
          : `账号 [${updated.name || updated.id}] 已暂停：停止自动任务与自动 Token 刷新，数据保留`,
        '',
        updated.name || updated.id
      );
      res.json({
        success: true,
        enabled: newEnabled,
        paused: !newEnabled,
        pausedAt: updated.pausedAt || 0,
        message: newEnabled ? '账号已启用' : '账号已暂停'
      });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.delete('/api/accounts/:id', (req, res) => {
    try {
      if (taskManager.running || accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '任务正在执行中，请先停止任务再删除账号' });
      }
      const deleted = configManager.deleteAccount(req.params.id);
      if (!deleted) {
        return res.status(404).json({ success: false, message: '账号不存在' });
      }
      // 同步清理该账号的统计与账单，避免留下孤儿数据
      taskManager.removeAccountStats(req.params.id);
      res.json({ success: true, message: '账号已删除' });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  // 测试词库来源获取明细
  app.post('/api/tasks/test-search-api', async (req, res) => {
    try {
      const mode = req.body?.searchApi || 'offline';
      const result = await rewardsApi.fetchSearchWordList(mode);
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 获取无头浏览器实时状态监控数据
  app.get('/api/browser/status', (req, res) => {
    res.json({
      success: true,
      data: browserManager.getStatus()
    });
  });

  app.get('/api/browser/runtime', async (req, res) => {
    try {
      const [fonts, loginWindow] = await Promise.all([
        getFontStatus(),
        microsoftLoginWindow.status()
      ]);
      res.json({
        success: true,
        data: {
          gpu: {
            enabled: configManager.get().browser?.useGpu === true,
            backend: configManager.get().browser?.gpuBackend || 'gl'
          },
          vnc: {
            enabled: isVncAvailable(),
            loginWindow
          },
          fonts
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.post('/api/browser/gpu/check', async (req, res) => {
    try {
      const result = await checkGpuCapability();
      if (result.success && result.recommendedBackend) {
        const current = configManager.get().browser || {};
        if (current.gpuBackend !== result.recommendedBackend) {
          configManager.update({
            browser: {
              gpuBackend: result.recommendedBackend
            }
          });
          logger.log('🖥️', `已记录可用 GPU 后端: ${result.recommendedBackend}`);
        }
      }
      res.status(result.busy ? 409 : 200).json({ success: result.success, data: result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.post('/api/browser/fonts/refresh', async (req, res) => {
    try {
      const fonts = await refreshFontCache();
      res.json({ success: true, data: fonts });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 单独安全测试搜索一次（验证按键与加分，完全避免冷却限制）
  app.post('/api/tasks/single-search', async (req, res) => {
    try {
      if (accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '已有任务正在执行，请稍后再试' });
      }
      const accountId = req.body?.accountId || null;
      const targetAcc = accountId ? configManager.resolveAccount(accountId) : null;
      if (targetAcc?.enabled === false) {
        return res.status(409).json({ success: false, message: '账号已暂停，请先启用后再执行测搜' });
      }
      const result = await taskManager.runSingleTestSearch(accountId);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 任务卡片点击执行：签到、阅读、搜索或打孔卡推进一次
  app.post('/api/tasks/card-action', async (req, res) => {
    let stopHeartbeat = () => {};
    try {
      if (accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '已有任务正在执行，请稍后再试' });
      }
      const { accountId, taskKey } = req.body || {};
      const targetAcc = accountId ? configManager.resolveAccount(accountId) : null;
      if (targetAcc?.enabled === false) {
        return res.status(409).json({ success: false, message: '账号已暂停，请先启用后再执行任务' });
      }
      // 打孔卡动作通常要等待浏览器回读，可能超过反向代理的 30 秒空闲超时。
      // 先发 JSON 合法空白作为心跳，避免代理用 HTML 504/502 页面截断真实响应。
      stopHeartbeat = startJsonHeartbeat(res);
      const result = await taskManager.runTaskAction(accountId, taskKey);
      stopHeartbeat();
      endJson(res, { success: true, data: result });
    } catch (e) {
      stopHeartbeat();
      if (res.headersSent) {
        endJson(res, { success: false, message: e.message });
      } else {
        res.status(500).json({ success: false, message: e.message });
      }
    }
  });

  // 领取 Dashboard 额外待领积分 (点击卡片触发)
  app.post('/api/tasks/claim-points', async (req, res) => {
    try {
      const accountId = req.body?.accountId || 'all';
      if (accountId !== 'all' && configManager.resolveAccount(accountId)?.enabled === false) {
        return res.status(409).json({ success: false, message: '账号已暂停，请先启用后再领取积分' });
      }
      if (accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '任务正在执行中，请稍后再领取额外积分' });
      }
      if (isDemoMode()) {
        let totalClaimed = 0;
        const accounts = configManager.getAccounts().filter(a => a.enabled !== false);
        const targets = accountId === 'all' ? accounts : accounts.filter(a => a.id === accountId);
        for (const a of targets) {
          const st = taskManager.ensureAccountStats(a.id);
          const pts = Number(st.claimablePoints || 0);
          if (pts > 0) {
            totalClaimed += pts;
            st.balance = (st.balance || 0) + pts;
            st.earned = (st.earned || 0) + pts;
            st.claimablePoints = 0;
            logger.log('🎁', `成功领取账号 [${a.name}] 待领积分 +${pts} 分！`, '', a.name);
            logger.addTimeline(a.name, `领取额外待领积分 +${pts} 分`);
          }
        }
        taskManager.saveStats();
        return res.json({
          success: true,
          claimed: totalClaimed,
          message: totalClaimed > 0 ? `成功领取 ${totalClaimed} 点额外积分！` : '当前没有待领取的额外积分'
        });
      }

      const claimed = await taskManager.claimPendingPoints(accountId);
      res.json({
        success: true,
        claimed,
        message: claimed > 0 ? `成功领取 ${claimed} 点额外积分！` : '当前没有待领取的额外积分'
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 2. 获取配置
  app.get('/api/config', (req, res) => {
    res.json({
      success: true,
      data: configManager.getPublicConfig()
    });
  });

  // 3. 更新配置
  app.post('/api/config', (req, res) => {
    try {
      if (Array.isArray(req.body?.accounts) && accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '任务正在执行中，暂不能保存账号配置' });
      }
      const updated = configManager.update(req.body);
      scheduler.restart();
      logger.log('⚙️', '配置已更新并已生效');
      res.json({ success: true, data: configManager.getPublicConfig() });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 4. 手动立即执行（支持指定单账号或全部账号）
  app.post('/api/tasks/run', async (req, res) => {
    if (taskManager.running) {
      return res.json({ success: false, message: '任务正在运行中' });
    }
    if (accountContextLock.isBusy()) {
      return res.status(409).json({ success: false, message: '已有同步或账号操作正在执行，请稍后再启动任务' });
    }
    const targetAccountId = req.body?.accountId || null;
    if (targetAccountId) {
      const targetAcc = configManager.resolveAccount(targetAccountId);
      if (!targetAcc) return res.status(404).json({ success: false, message: '账号不存在' });
      if (targetAcc.enabled === false) {
        return res.status(409).json({ success: false, message: '该账号已停用，请先恢复自动巡检' });
      }
      const blockReason = taskManager.getHardAccountBlockReason(targetAcc);
      if (blockReason) {
        return res.status(409).json({ success: false, message: `账号凭据异常，已拒绝执行：${blockReason}` });
      }
    }
    taskManager.runAll(true, targetAccountId);
    res.json({
      success: true,
      message: targetAccountId ? `已启动账号 [${targetAccountId}] 的任务` : '全账号自动化任务已启动'
    });
  });

  // 5. 中断停止
  app.post('/api/tasks/stop', (req, res) => {
    taskManager.stop();
    res.json({ success: true, message: '已发出停止指令' });
  });

  // 5.2 切换极速模式（单次有效）
  app.post('/api/tasks/turbo', (req, res) => {
    const enabled = req.body?.enabled !== undefined ? !!req.body.enabled : !taskManager.isTurboMode();
    const result = taskManager.setTurboMode(enabled);
    res.json({ success: true, turboMode: result });
  });

  // 5.5 历史日志（读取 data/app.log 末尾，供「全部日志」弹窗）
  app.get('/api/logs/history', (req, res) => {
    const limit = Math.min(1000, Math.max(50, parseInt(req.query.limit, 10) || 300));
    res.json({ success: true, data: logger.getRecentFromFile(limit) });
  });

  // 5.6 生成最近 24 小时脱敏诊断日志。预览与下载使用同一份内容。
  app.get('/api/logs/diagnostics', (req, res) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    try {
      const data = buildDiagnosticReport({
        version: CURRENT_VERSION,
        accounts: configManager.getAccounts(),
        config: configManager.get(),
        status: taskManager.getStatus('all'),
        hours: DIAGNOSTIC_WINDOW_HOURS
      });
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, message: `诊断日志生成失败: ${e.message}` });
    }
  });

  // 6. 实时日志流 (SSE)
  app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // 先发送最近日志历史
    const initialLogs = logger.getLogs();
    res.write(`data: ${JSON.stringify({ type: 'history', logs: initialLogs })}\n\n`);

    const logListener = (entry) => {
      res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
    };

    const timelineListener = (item) => {
      res.write(`data: ${JSON.stringify({ type: 'timeline', item })}\n\n`);
    };

    logger.on('log', logListener);
    logger.on('timeline', timelineListener);

    req.on('close', () => {
      logger.off('log', logListener);
      logger.off('timeline', timelineListener);
    });
  });

  // 7. 小白一键换取 Token
  app.post('/api/auth/exchange-code', async (req, res) => {
    const { urlOrCode, accountId, name, order, draft, proxy } = req.body;
    if (!urlOrCode) {
      return res.status(400).json({ success: false, message: '请提供跳转链接或授权码' });
    }
    const lockOwner = `web-token-exchange:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (!accountContextLock.tryAcquire(lockOwner)) {
      return res.status(409).json({ success: false, message: '任务正在执行中，暂不能更新该账号的移动端凭据' });
    }
    const prevContext = rewardsApi.snapshotAccountContext();
    try {
      const savedAccount = accountId ? configManager.findAccount(accountId) : null;
      const candidateAccount = savedAccount || {
        id: accountId || `draft_${Date.now()}`,
        name: name || '候选账号',
        cookie: '',
        proxyMode: 'direct',
        proxyId: ''
      };
      rewardsApi.setCurrentAccount(candidateAccount);
      networkClient.setActiveProxySelection(proxy);
      // name/order 用于「配置向导」新建账号时带上名称与序号
      const result = await authManager.exchangeCodeForToken(urlOrCode, accountId, { name, order, persist: draft !== true });
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    } finally {
      rewardsApi.restoreAccountContext(prevContext);
      accountContextLock.release(lockOwner);
    }
  });

  app.post('/api/auth/login-window/open', async (req, res) => {
    try {
      const result = await microsoftLoginWindow.open(req.body || {});
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.get('/api/auth/login-window/status', async (req, res) => {
    try {
      const data = await microsoftLoginWindow.status();
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.post('/api/auth/login-window/capture', async (req, res) => {
    try {
      const result = await microsoftLoginWindow.capture(req.body || {});
      res.set('Cache-Control', 'no-store');
      res.json({ success: !!result.success, partial: !!result.partial, data: result });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.post('/api/auth/login-window/close', async (req, res) => {
    try {
      const result = await microsoftLoginWindow.close(req.body?.reason || '用户关闭登录窗口');
      res.json({ success: true, data: result?.lastResult?.data || result?.lastResult || result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 7.5 单独测试候选 Cookie（不保存、不写统计）
  app.post('/api/auth/test-cookie', async (req, res) => {
    const { cookie, accountId, proxy } = req.body;
    if (!cookie) {
      return res.status(400).json({ success: false, message: '请提供 Cookie' });
    }
    const lockOwner = `web-cookie-test:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (!accountContextLock.tryAcquire(lockOwner)) {
      return res.status(409).json({ success: false, message: '任务正在执行中，请稍后再测试 Cookie' });
    }
    const targetAcc = accountId
      ? configManager.findAccount(accountId)
      : (configManager.getAccounts()[0] || null);
    const prevContext = rewardsApi.snapshotAccountContext();
    try {
      let cookieToTest = cookie;
      if (cookie === SECRET_PLACEHOLDER) {
        const acc = configManager.resolveAccount(accountId);
        if (!acc?.cookie) {
          return res.status(400).json({ success: false, message: '该账号尚未保存 Cookie' });
        }
        cookieToTest = acc.cookie;
      }
      const candidateAccount = targetAcc || {
        id: accountId || `cookie_${Date.now()}`,
        name: '候选账号',
        cookie: cookieToTest,
        proxyMode: 'direct',
        proxyId: ''
      };
      rewardsApi.setCurrentAccount(candidateAccount);
      networkClient.setActiveProxySelection(proxy);
      // 只做校验，不落库：以前这里会 upsertAccount，导致「测试 Cookie」按钮
      // 凭空创建出一个名为「账号 (xxx)」的账号。真正的保存由向导最后一步统一提交。
      const status = await authManager.checkCookieStatus(cookieToTest, accountId);
      if (cookie === SECRET_PLACEHOLDER && targetAcc?.authDiagnosis) {
        const previous = targetAcc.authDiagnosis;
        configManager.recordAuthDiagnosis(targetAcc.id, {
          cookieValid: status.valid,
          tokenValid: previous.tokenValid,
          overallValid: !!status.valid && previous.tokenValid === true,
          warning: previous.warning || !status.valid,
          warningMessage: !status.valid ? status.message : previous.warningMessage,
          balance: previous.balance,
          cookieMessage: status.message,
          tokenMessage: previous.tokenMessage
        });
      }
      // 测试的是尚未保存的候选 Cookie，不能把它的余额/印章写进当前账号统计，
      // 否则 A 账号点一次“测试 B 的 Cookie”就会把 B 的数据串到 A 的面板。
      res.json({ success: true, data: status });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    } finally {
      rewardsApi.restoreAccountContext(prevContext);
      accountContextLock.release(lockOwner);
    }
  });

  // 7.6 单独测试移动端 Token（可使用当前账号代理，也可临时换取候选授权码）
  app.post('/api/auth/test-token', async (req, res) => {
    const { accountId, proxy, urlOrCode, name } = req.body || {};
    const savedAccount = accountId ? configManager.findAccount(accountId) : null;
    if (!savedAccount && !urlOrCode) {
      return res.status(400).json({ success: false, message: '请先提供授权码，或选择已配置 Token 的账号' });
    }

    const lockOwner = `web-token-test:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (!accountContextLock.tryAcquire(lockOwner)) {
      return res.status(409).json({ success: false, message: '任务正在执行中，请稍后再测试 Token' });
    }
    const prevContext = rewardsApi.snapshotAccountContext();
    try {
      const candidateAccount = savedAccount || {
        id: accountId || `draft_token_${Date.now()}`,
        name: name || '候选账号',
        cookie: '',
        proxyMode: 'direct',
        proxyId: ''
      };
      rewardsApi.setCurrentAccount(candidateAccount);
      networkClient.setActiveProxySelection(proxy);

      let exchanged = null;
      if (urlOrCode) {
        exchanged = await authManager.exchangeCodeForToken(urlOrCode, accountId, {
          name: candidateAccount.name,
          persist: false
        });
      }
      const status = await authManager.checkTokenStatus(accountId, {
        accountOverride: candidateAccount,
        accessToken: exchanged?.accessToken
      });
      if (savedAccount?.authDiagnosis && !urlOrCode) {
        const previous = savedAccount.authDiagnosis;
        configManager.recordAuthDiagnosis(savedAccount.id, {
          cookieValid: previous.cookieValid,
          tokenValid: status.valid,
          overallValid: previous.cookieValid === true && !!status.valid,
          warning: previous.warning || !status.valid,
          warningMessage: !status.valid ? status.message : previous.warningMessage,
          balance: previous.balance,
          cookieMessage: previous.cookieMessage,
          tokenMessage: status.message
        });
      }
      res.json({
        success: true,
        data: {
          ...status,
          tokens: exchanged
            ? {
                authCodeUrl: urlOrCode,
                accessToken: exchanged.accessToken,
                refreshToken: exchanged.refreshToken,
                tokenTime: Date.now()
              }
            : null
        }
      });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    } finally {
      rewardsApi.restoreAccountContext(prevContext);
      accountContextLock.release(lockOwner);
    }
  });

  // 8. 全面测试账户状态并在 Docker 中完成体检（结果落盘，供账号卡片展示）
  async function runAccountDiagnosis(accountId, options = {}) {
    let targetAccountId = accountId || null;
    const acc = configManager.resolveAccount(targetAccountId);
    if (!acc) throw new Error('账号未找到');
    targetAccountId = acc.id;
    const prevContext = rewardsApi.snapshotAccountContext();
    rewardsApi.setCurrentAccount(acc);
    networkClient.setActiveProxySelection(options.proxy);

    let result;
    try {
      // 手动体检是暂停账号明确允许的例外，需要允许刷新 Token 才能得到真实结果。
      result = await authManager.testAccount(targetAccountId, {
        allowPaused: options.allowPaused === true
      });
      // 账号体检必须读取该账号实际使用的出口，而不是全局默认网络。
      const [ipDetails, regionPass] = await Promise.all([
        rewardsApi.getIPInfoDetails(),
        rewardsApi.checkRegion(0, { force: true, maxRetries: 1, silent: true })
      ]);
      const activeProxy = networkClient.getActiveProxyContext();
      const effectiveProxyUrl = networkClient.getEffectiveProxyUrl();
      const defaultProxy = configManager.getDefaultProxy();
      const effectiveProxy = effectiveProxyUrl
        ? {
            id: activeProxy?.proxyId || defaultProxy?.id || 'candidate_proxy',
            name: activeProxy?.proxyName || defaultProxy?.name || '候选代理',
            url: effectiveProxyUrl
          }
        : null;
      result.network = {
        region: rewardsApi.region,
        regionPass,
        ip: ipDetails?.ip || '',
        location: ipDetails?.location || '',
        ipInfo: ipDetails?.formatted || '未能获取当前访问 IP',
        proxyMode: activeProxy?.mode || configManager.getAccountProxyMode(acc),
        proxyUsed: !!effectiveProxy,
        proxy: effectiveProxy
          ? { id: effectiveProxy.id, name: effectiveProxy.name, url: effectiveProxy.url }
          : null
      };
    } finally {
      rewardsApi.restoreAccountContext(prevContext);
    }

    const diagnosis = configManager.recordAuthDiagnosis(result.accountId, {
      cookieValid: result.cookie?.valid,
      cookieTransient: result.cookie?.transient === true,
      tokenValid: result.token?.valid,
      overallValid: result.overallValid,
      warning: result.warning,
      warningMessage: result.warningMessage,
      balance: result.balance,
      cookieMessage: result.cookie?.message,
      tokenMessage: result.token?.message
    });
    result.diagnosis = diagnosis;

    // 体检结果落盘后同步更新统计；成功体检还会解除历史运行阻断。
    const accStats = taskManager.ensureAccountStats(result.accountId || 'acc_1');
    if (result.allValid) {
      // 完整体检已确认双端有效，旧运行时阻断标记必须立即失效。
      delete accStats.executionBlockReason;
    }
    if (result.balance > 0) {
      accStats.balance = result.balance;
    }
    taskManager.saveStats();
    return result;
  }

  let lastTestAllTime = 0;
  const accountTestTimes = new Map();

  app.post('/api/auth/test', async (req, res) => {
    const lockOwner = `web-diagnosis:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (!accountContextLock.tryAcquire(lockOwner)) {
      return res.status(409).json({ success: false, message: '任务正在执行中，请稍后再体检（避免账号上下文串台）' });
    }
    try {
      const targetAccountId = req.body?.accountId || null;
      const force = req.body?.force === true;
      const now = Date.now();
      const lastTime = accountTestTimes.get(targetAccountId || 'default') || 0;
      if (!force && now - lastTime < 15000) {
        const remaining = Math.ceil((15000 - (now - lastTime)) / 1000);
        return res.json({
          success: true,
          cached: true,
          message: `账号体检刚完成，请等待 ${remaining} 秒后再次检测以防风控`,
          data: configManager.resolveAccount(targetAccountId)?.authDiagnosis || {}
        });
      }
      accountTestTimes.set(targetAccountId || 'default', now);
      const result = await runAccountDiagnosis(targetAccountId, {
        allowPaused: true,
        proxy: req.body?.proxy
      });
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    } finally {
      accountContextLock.release(lockOwner);
    }
  });

  // 8.5 一键体检全部账号（逐个串行，避免并发触发微软风控）
  app.post('/api/auth/test-all', async (req, res) => {
    const lockOwner = `web-diagnosis-all:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (!accountContextLock.tryAcquire(lockOwner)) {
      return res.status(409).json({ success: false, message: '任务正在执行中，请稍后再体检（避免账号上下文串台）' });
    }
    try {
      const accounts = configManager.getAccounts();
      const force = req.body?.force === true;
      const now = Date.now();
      const COOLDOWN_MS = 5 * 60 * 1000;
      if (!force && (now - lastTestAllTime < COOLDOWN_MS)) {
        const remainingSec = Math.ceil((COOLDOWN_MS - (now - lastTestAllTime)) / 1000);
        const cachedResults = accounts.map(a => {
          const d = a.authDiagnosis || {};
          return {
            accountId: a.id,
            accountName: a.name || a.id,
            cookie: { valid: d.cookieValid !== false, message: d.cookieMessage || '' },
            token: { valid: d.tokenValid !== false, message: d.tokenMessage || '' },
            overallValid: d.overallValid !== false,
            allValid: d.cookieValid && d.tokenValid && !d.warning,
            warning: d.warning,
            warningMessage: d.warningMessage,
            balance: d.balance || 0,
            cached: true
          };
        });
        return res.json({
          success: true,
          cached: true,
          message: `全量体检冷却中（剩余 ${remainingSec} 秒），已返回最近体检记录以保护账号安全。如需单独复查，请切换为单账号体检。`,
          data: {
            results: cachedResults,
            total: cachedResults.length,
            validCount: cachedResults.filter(r => r.allValid).length
          }
        });
      }

      lastTestAllTime = now;
      const results = [];
      const globalCfg = configManager.get();
      const baseGap = Math.max(15, Math.min(60, Number(globalCfg.tasks?.accountGapSec ?? 30) || 30));
      for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        try {
          results.push(await runAccountDiagnosis(acc.id, { allowPaused: true }));
        } catch (e) {
          results.push({
            accountId: acc.id,
            accountName: acc.name || acc.id,
            cookie: { valid: false, message: e.message },
            token: { valid: false, message: e.message },
            overallValid: false,
            allValid: false,
            balance: 0,
            error: e.message
          });
        }
        if (i < accounts.length - 1) {
          const jitter = Math.floor(baseGap * 0.2);
          const gapSec = rewardsApi.randomRange(baseGap, baseGap + jitter);
          logger.log('⏳', `多账号体检安全防风控隔离：等待 ${gapSec} 秒后检测下一个账号 [${accounts[i + 1].name || accounts[i + 1].id}]...`);
          for (let s = gapSec; s > 0; s--) {
            await rewardsApi.delay(1000);
          }
        }
      }
      const validCount = results.filter(r => r.allValid).length;
      res.json({
        success: true,
        data: {
          results,
          total: results.length,
          validCount
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    } finally {
      accountContextLock.release(lockOwner);
    }
  });

  // 9. 测试代理连通性及地区
  app.post('/api/proxy/test', async (req, res) => {
    const useProxy = req.body?.useProxy === true;
    let proxyUrl = '';
    try {
      if (useProxy) {
        proxyUrl = normalizeProxyUrl(req.body?.proxyUrl);
        if (!proxyUrl) {
          return res.status(400).json({ success: false, message: '请填写要测试的代理地址' });
        }
      }
      const startedAt = Date.now();
      const testOptions = {
        proxyUrl: useProxy ? proxyUrl : '',
        useProxy,
        force: true,
        maxRetries: 0,
        silent: true
      };
      const [ipDetails, regionPass] = await Promise.all([
        rewardsApi.getIPInfoDetails(testOptions),
        rewardsApi.checkRegion(0, testOptions)
      ]);
      const latencyMs = Date.now() - startedAt;
      const reachable = !!ipDetails || regionPass === true;
      if (!reachable) {
        return res.status(502).json({
          success: false,
          message: useProxy ? '代理无法连接或目标站点不可达' : '网络请求失败',
          proxyUrl,
          latencyMs
        });
      }
      res.json({
        success: true,
        proxyUrl,
        ip: ipDetails?.ip || '',
        location: ipDetails?.location || '',
        latencyMs,
        region: rewardsApi.region,
        regionPass,
        ipInfo: ipDetails?.formatted || '代理已连通，但未能读取出口 IP'
      });
    } catch (e) {
      res.status(502).json({ success: false, message: e.message, proxyUrl });
    }
  });

  // 9.1 多套代理配置保存与删除
  app.post('/api/network/proxies', (req, res) => {
    try {
      if (accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '任务正在执行中，暂不能修改代理配置' });
      }
      const result = configManager.setNetworkProxyConfig(req.body || {});
      res.json({
        success: true,
        data: {
          network: result.network,
          accounts: (result.accounts || []).map(acc => ({
            id: acc.id,
            proxyMode: configManager.getAccountProxyMode(acc),
            proxyId: acc.proxyMode === 'proxy' ? (acc.proxyId || '') : ''
          }))
        }
      });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.delete('/api/network/proxies/:id', (req, res) => {
    try {
      if (accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '任务正在执行中，暂不能删除代理配置' });
      }
      const network = configManager.get().network || {};
      const proxies = (network.proxies || []).filter(item => item.id !== req.params.id);
      const result = configManager.setNetworkProxyConfig({
        proxies,
        defaultProxyId: network.defaultProxyId === req.params.id ? '' : network.defaultProxyId,
        useProxy: network.useProxy,
        lockRegion: network.lockRegion
      });
      res.json({
        success: true,
        data: {
          network: result.network,
          accounts: (result.accounts || []).map(acc => ({
            id: acc.id,
            proxyMode: configManager.getAccountProxyMode(acc),
            proxyId: acc.proxyMode === 'proxy' ? (acc.proxyId || '') : ''
          }))
        }
      });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  // 10. 测试通知
  app.post('/api/notify/test', async (req, res) => {
    const { channel, value, proxy } = req.body;
    if (!channel || !value) {
      return res.status(400).json({ success: false, message: '参数缺失' });
    }
    try {
      await notifier.testChannel(channel, value, proxy);
      res.json({ success: true, message: '测试消息发送成功' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.post('/api/notify/telegram/check', async (req, res) => {
    const value = req.body?.value && typeof req.body.value === 'object'
      ? req.body.value
      : {
          botToken: req.body?.botToken,
          chatId: req.body?.chatId
        };
    try {
      const data = await notifier.checkTelegram(value.botToken, value.chatId, req.body?.proxy);
      res.json({ success: true, data });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  // 11. 获取历史积分趋势与明细 (支持单账号与全局汇总)
  app.get('/api/history', (req, res) => {
    const days = parseInt(req.query.days, 10) || 7;
    const accountId = req.query.accountId || 'all';
    const history = historyManager.getHistory(days, accountId, taskManager.stats);
    res.json({ success: true, data: history });
  });

  // ===== Epic 免费游戏领取 =====

  app.get('/api/epic/accounts', (req, res) => {
    const accounts = configManager.getEpicAccounts().map(a => {
      const summary = epicManager.summarizeSession(a.storageState);
      return {
        id: a.id,
        name: a.name,
        order: a.order,
        enabled: a.enabled !== false,
        hasSession: summary.cookieCount > 0,
        cookieCount: summary.cookieCount,
        hasEpicSession: summary.hasEpicSession,
        sessionValid: a.sessionValid ?? null,
        handledGameIds: Object.keys(a.handledGames || {}),
        handledGames: a.handledGames || {},
        lastVerifyAt: a.lastVerifyAt || 0,
        lastVerifyMessage: a.lastVerifyMessage || '',
        lastClaimAt: a.lastClaimAt || 0,
        lastClaimMessage: a.lastClaimMessage || ''
      };
    });
    res.json({ success: true, data: accounts });
  });

  app.post('/api/epic/accounts', (req, res) => {
    try {
      const saved = configManager.upsertEpicAccount(req.body || {});
      res.json({ success: true, data: { id: saved.id } });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.delete('/api/epic/accounts/:id', async (req, res) => {
    try {
      const accountId = req.params.id;
      if (epicManager.running || epicManager.checking || epicManager.verifying) {
        return res.status(409).json({ success: false, message: 'Epic 任务正在运行中，请先停止任务再删除账号' });
      }
      await epicManager.closeLoginWindowForAccount(accountId);
      const ok = configManager.deleteEpicAccount(accountId);
      res.json({ success: ok, message: ok ? '账号已删除' : '账号不存在' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 导入会话（Cookie-Editor JSON / storageState / 原始 Cookie 串）
  app.post('/api/epic/accounts/:id/session', (req, res) => {
    try {
      if (epicManager.running || epicManager.verifying || epicManager.checking) {
        return res.status(409).json({ success: false, message: 'Epic 任务正在运行中，请先点击停止按钮，再更新会话' });
      }
      if (epicManager.isLoginWindowOpen()) {
        return res.status(409).json({ success: false, message: 'Epic 登录窗口已打开，请先保存或关闭登录窗口再导入会话' });
      }
      const acc = configManager.findEpicAccount(req.params.id);
      if (!acc) return res.status(404).json({ success: false, message: '账号不存在' });
      const storageState = epicManager.parseSessionInput(req.body?.session);
      const summary = epicManager.summarizeSession(storageState);
      configManager.updateEpicAccount(acc.id, {
        storageState,
        sessionValid: null,
        lastVerifyAt: 0,
        lastVerifyMessage: '',
        lastSessionImportAt: Date.now()
      });
      logger.log('🎮', `Epic 账号 [${acc.name}] 会话已导入（${summary.cookieCount} 个 Cookie${summary.hasEpicSession ? '，包含 Epic 登录凭据' : '，⚠️ 未检测到 EPIC 登录 Cookie'}）`, '', acc.name);
      res.json({ success: true, data: summary });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.post('/api/epic/accounts/:id/login-window', async (req, res) => {
    try {
      const result = await epicManager.openLoginWindow(req.params.id);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.post('/api/epic/accounts/:id/login-window/save', async (req, res) => {
    try {
      const result = await epicManager.saveLoginWindow(req.params.id);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.post('/api/epic/accounts/:id/login-window/close', async (req, res) => {
    try {
      const result = await epicManager.closeLoginWindowForAccount(req.params.id);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  // 指纹自检：用与领取任务相同的启动参数开一次临时浏览器，回报风控最常看的信号。
  // Epic 的安全检查是服务端黑盒判定，先把「浏览器本身是否露馅」变成可观测的。
  app.get('/api/epic/fingerprint', async (req, res) => {
    try {
      const data = await epicManager.selfCheckFingerprint();
      res.json({ success: true, data });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.post('/api/epic/accounts/:id/verify', async (req, res) => {
    try {
      const result = await epicManager.verifySession(req.params.id);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get('/api/epic/free-games', async (req, res) => {
    try {
      const games = await epicManager.fetchFreeGames();
      res.json({ success: true, data: games });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.post('/api/epic/claim', async (req, res) => {
    try {
      if (epicManager.running || epicManager.checking || epicManager.verifying) {
        return res.status(409).json({ success: false, message: 'Epic 任务正在运行中，请稍后再试' });
      }
      if (epicManager.isLoginWindowOpen()) {
        return res.status(409).json({ success: false, message: 'Epic 登录窗口已打开，请先保存或关闭登录窗口' });
      }
      const accountId = req.body?.accountId || null;
      const data = accountId ? await epicManager.claimOne(accountId) : await epicManager.claimAll();
      res.json({ success: true, data });
    } catch (e) {
      if (e?.code === 'EPIC_STOPPED') {
        return res.json({ success: true, stopped: true, message: e.message, data: { results: [] } });
      }
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.post('/api/epic/stop', async (req, res) => {
    try {
      const result = await epicManager.stop();
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get('/api/epic/status', (req, res) => {
    res.json({
      success: true,
      data: {
        ...epicManager.getState(),
        settings: epicManager.getSettings(),
        demo: isDemoMode(),
        records: configManager.getEpicClaimRecords(20)
      }
    });
  });

  // Epic 全局领取设置
  app.get('/api/epic/settings', (req, res) => {
    res.json({ success: true, data: epicManager.getSettings() });
  });

  app.post('/api/epic/settings', (req, res) => {
    try {
      const b = req.body || {};
      const current = epicManager.getSettings();
      const num = (v, min, max, dft) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return dft;
        return Math.max(min, Math.min(max, n));
      };
      configManager.update({
        epic: {
          enabled: b.enabled === undefined ? current.enabled : b.enabled !== false,
          autoClaimTime: normalizeAutoClaimTime(b.autoClaimTime === undefined ? current.autoClaimTime : b.autoClaimTime),
          checkIntervalMin: num(b.checkIntervalMin, 5, 10080, current.checkIntervalMin),
          retryCount: num(b.retryCount, 0, 5, current.retryCount),
          retryIntervalSec: num(b.retryIntervalSec, 10, 600, current.retryIntervalSec),
          accountGapSec: num(b.accountGapSec, 0, 600, current.accountGapSec)
        }
      });
      scheduler.restart(); // 让新的检查间隔立即生效
      logger.log('🎮', 'Epic 领取设置已更新');
      res.json({ success: true, data: epicManager.getSettings() });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number(err?.status || err?.statusCode) || 500;
    res.status(status).json({ success: false, message: err?.message || '服务器内部错误' });
  });

  return app;
}

export default createServer;
