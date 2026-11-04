import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');
const appJs = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf-8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const serverJs = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf-8');
const styleCss = fs.readFileSync(new URL('../src/web/public/style.css', import.meta.url), 'utf-8');
const webglJs = fs.readFileSync(new URL('../src/web/public/webgl-bg.js', import.meta.url), 'utf-8');
const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf-8');
const composeFile = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf-8');

test('v1.7.7 删除顶部重复编辑按钮，只保留任务清单编辑入口', () => {
  assert.equal(indexHtml.includes('id="btn-edit-active-account"'), false);
  assert.equal(appJs.includes("getElementById('btn-edit-active-account')"), false);
  assert.equal(indexHtml.includes('id="btn-edit-current-account-header"'), true);
});

test('Cookie 配置向导统一使用 rewards.bing.com/dashboard', () => {
  assert.equal(indexHtml.includes('https://rewards.bing.com/dashboard'), true);
  assert.equal(indexHtml.includes('登录 <a href="https://cn.bing.com"'), false);
  assert.equal(indexHtml.includes('浏览器 cn.bing.com 的完整 Cookie'), false);
});

test('v1.10.1 暴露核显、字体和微软 VNC 登录入口', () => {
  assert.match(indexHtml, /id="tab-browser"/);
  assert.match(indexHtml, /id="cfg-browser-gpu"/);
  assert.match(indexHtml, /id="btn-check-gpu"/);
  assert.match(indexHtml, /id="btn-refresh-fonts"/);
  assert.match(indexHtml, /id="guide-btn-vnc-login"/);
  assert.match(indexHtml, /id="btn-quick-vnc-login"/);
  assert.match(indexHtml, /id="btn-cfg-vnc-login"/);
  assert.doesNotMatch(indexHtml, /id="cfg-vnc-password"/);
  assert.match(appJs, /startMicrosoftVncLogin/);
  assert.match(appJs, /captureMicrosoftLoginWindow/);
  assert.match(dockerfile, /WINDOWS_FONT_DIR=\/usr\/share\/fonts\/truetype\/windows/);
  assert.doesNotMatch(dockerfile, /ENV LIBGL_ALWAYS_SOFTWARE=1/);
  assert.match(composeFile, /\.\/data\/fonts\/windows:\/usr\/share\/fonts\/truetype\/windows:ro/);
});

test('微软 VNC 登录窗口固定使用软件渲染，避免 Xvfb 下 Vulkan 白屏', () => {
  const loginSource = fs.readFileSync(new URL('../src/core/microsoftLoginWindow.js', import.meta.url), 'utf-8');
  assert.match(loginSource, /this\.useGpu = false/);
  assert.match(loginSource, /useGpu: false/);
  assert.match(loginSource, /buildChromiumEnv\(\{ useGpu: false \}\)/);
});

test('VNC 从 Bing 开始、登录后自动打开 Rewards，并支持调整窗口大小', () => {
  const loginSource = fs.readFileSync(new URL('../src/core/microsoftLoginWindow.js', import.meta.url), 'utf-8');
  assert.match(loginSource, /https:\/\/cn\.bing\.com\//);
  assert.match(loginSource, /navigateToRewardsAfterLogin/);
  assert.match(loginSource, /target\.on\('request'/);
  assert.match(loginSource, /target\.on\('response'/);
  assert.match(indexHtml, /id="btn-maximize-novnc"/);
  assert.match(styleCss, /\.novnc-modal-box[\s\S]*resize: both/);
});

test('发布版本号在 package 与 Web 服务端保持一致', () => {
  const escaped = packageJson.version.replace(/\./g, '\\.');
  assert.match(serverJs, new RegExp(`const CURRENT_VERSION = '${escaped}';`));
  assert.match(indexHtml, new RegExp(`id="version-label">v${escaped}<`));
  assert.match(appJs, new RegExp(`currentVersion \\|\\| '${escaped}'`));
});

test('日志弹窗与实时日志区都能预览并导出脱敏诊断日志', () => {
  assert.match(indexHtml, /id="btn-logs-export-diagnostics"[^>]*>📥 导出诊断日志/);
  assert.match(indexHtml, /id="btn-terminal-export-diagnostics"[^>]*>📥 导出诊断日志/);
  assert.match(indexHtml, /id="diagnostics-modal"/);
  assert.match(indexHtml, /id="diagnostics-preview"[^>]*readonly/);
  assert.match(indexHtml, /id="btn-copy-diagnostics"/);
  assert.match(indexHtml, /id="btn-download-diagnostics"[^>]*>确认下载/);
  assert.match(appJs, /async function openDiagnosticsExport/);
  assert.match(appJs, /\/api\/logs\/diagnostics/);
  assert.match(appJs, /async function copyDiagnosticsExport/);
  assert.match(appJs, /function downloadDiagnosticsExport/);
  assert.match(serverJs, /app\.get\('\/api\/logs\/diagnostics'/);
  assert.match(serverJs, /buildDiagnosticReport\(\{/);
  assert.match(styleCss, /\.diagnostics-preview[\s\S]*font-family:\s*ui-monospace/);
});

test('任务区使用移动端签到与三组 7 日连续进度', () => {
  assert.equal(indexHtml.includes('每日双端签入'), false);
  assert.equal(indexHtml.includes('移动端签到 (双端签入)'), false);
  assert.equal(indexHtml.includes('移动端签到</label>'), true);
  assert.equal(appJs.includes('dual-endpoint-item'), false);
  assert.match(appJs, /必应搜索连续打卡/);
  assert.match(appJs, /每日连续打卡活动/);
  assert.match(appJs, /移动端连续打卡/);
  assert.match(appJs, /TASK_PRIORITY[\s\S]*search: 10[\s\S]*dailySet: 20[\s\S]*appPromotions: 25[\s\S]*sign: 30/);
  assert.match(indexHtml, /id="cfg-task-app-promotions"[^>]*> 移动端附加活动/);
  assert.match(appJs, /tasks\?\.appPromotions !== false/);
  assert.match(appJs, /appPromotions: document\.getElementById\('cfg-task-app-promotions'\)\.checked/);
});

test('液态玻璃视觉包含 WebGL2 背景、统一卡片材质与配置项', () => {
  assert.match(indexHtml, /id="bg-webgl-canvas"/);
  assert.match(indexHtml, /id="tab-appearance"/);
  assert.match(styleCss, /\.glass-surface\.glass-surface/);
  assert.match(styleCss, /--glass-opacity/);
  assert.match(webglJs, /#version 300 es/);
  assert.match(webglJs, /renderSilk/);
  assert.match(webglJs, /renderGrainient/);
  assert.match(webglJs, /renderVeil/);
  assert.match(webglJs, /renderSoftAurora/);
  assert.match(webglJs, /renderPrism/);
});

test('界面固定夜间模式并修复下拉菜单深色可读性', () => {
  assert.equal(indexHtml.includes('data-theme-val="light"'), false);
  assert.equal(indexHtml.includes('id="cfg-ui-theme" value="dark"'), true);
  assert.equal(styleCss.includes('[data-theme="light"]'), false);
  assert.match(styleCss, /\.form-select option[\s\S]*background: #111827/);
  assert.match(styleCss, /\.stamp-grid-item\.collected[\s\S]*#FFD84D/);
});

test('鼠标只驱动边框高光角度，不再生成跟随光斑', () => {
  assert.match(appJs, /--pointer-angle/);
  assert.match(appJs, /Math\.atan2\(normY, normX\) \* 180 \/ Math\.PI \+ 90/);
  assert.equal(appJs.includes('--mouse-x'), false);
  assert.equal(styleCss.includes('--mouse-x'), false);
  assert.match(styleCss, /conic-gradient\([\s\S]*--pointer-angle/);
});

test('账号汇总使用可交互表格并包含总计与趋势入口', () => {
  assert.match(indexHtml, /id="account-summary-tbody"/);
  assert.match(indexHtml, /id="account-summary-colgroup"/);
  assert.match(indexHtml, /id="btn-summary-claim-all"/);
  assert.match(indexHtml, /id="account-trend-tooltip"/);
  assert.match(indexHtml, /class="column-resize-handle"/);
  assert.match(appJs, /function renderAccountSummaryTable/);
  assert.match(appJs, /account-summary-total-row/);
  assert.match(appJs, /data-trend-account/);
  assert.match(appJs, /data-trend-metric/);
  assert.match(appJs, /function showAccountTrendTooltip/);
  assert.match(appJs, /openAccountDetailFromSummary/);
  assert.match(styleCss, /\.task-card-featured[\s\S]*min-height: 0/);
  assert.match(styleCss, /\.acc-stat-box[\s\S]*border-radius: 10px/);
});

test('首页汇总表格覆盖积分、签到、印章与 7/30 日趋势', () => {
  assert.match(indexHtml, /当前积分[\s\S]*今日获取[\s\S]*待领取[\s\S]*连续签到[\s\S]*印章[\s\S]*近 7 日日均[\s\S]*近 30 日日均/);
  assert.match(appJs, /getAccountEarnedAverage\(acc\.id, 7\)/);
  assert.match(appJs, /getAccountEarnedAverage\(acc\.id, 30\)/);
  assert.match(appJs, /getAccountTrendRows\(accountId, metric, 14\)/);
  const historyIndex = indexHtml.indexOf('id="history-card-section"');
  const monitorIndex = indexHtml.indexOf('id="browser-monitor-card"');
  assert.ok(historyIndex > 0 && historyIndex < monitorIndex);
  assert.match(appJs, /historyCard\.style\.display = isAllMode \? 'flex' : 'none'/);
});

test('汇总表支持列宽持久化、指标级趋势与单账号领取', () => {
  assert.match(appJs, /msr\.accountSummaryColumnWidths\.v1/);
  assert.match(appJs, /function initAccountSummaryColumnResize/);
  assert.match(appJs, /function handleAccountTrendPointerMove/);
  assert.match(appJs, /account-trend-crosshair-v/);
  assert.match(appJs, /ACCOUNT_TREND_METRICS/);
  assert.match(appJs, /metric === 'claimable'[\s\S]*claimablePoints[\s\S]*metric === 'streak'[\s\S]*streakDays/);
  assert.match(appJs, /row\.value !== null[\s\S]*Number\.isFinite/);
  assert.match(appJs, /claimSummaryPendingPoints/);
  assert.match(appJs, /showWebConfirm/);
  assert.match(appJs, /data-claim-points/);
  assert.match(appJs, /colspan="4" class="account-summary-total-empty"/);
  assert.match(styleCss, /\.column-resize-handle[\s\S]*cursor:\s*col-resize/);
  assert.match(styleCss, /\.account-trend-crosshair/);
  assert.match(styleCss, /\.account-summary-total-empty/);
});

test('账号汇总表与账号概览避免轮询时重复重建', () => {
  assert.match(appJs, /accountSummaryRenderSignature/);
  assert.match(appJs, /signature === accountSummaryRenderSignature/);
  assert.match(styleCss, /\.account-summary-table[\s\S]*border-collapse/);
  assert.match(styleCss, /\.account-trend-tooltip[\s\S]*position:\s*fixed/);
  assert.match(appJs, /accountsOverviewRenderSignature/);
  assert.match(appJs, /signature === accountsOverviewRenderSignature/);
});

test('顶部页签、账号切换和工具栏操作统一使用胶囊圆角', () => {
  assert.match(styleCss, /\.app-tabs[\s\S]*border-radius: 999px/);
  assert.match(styleCss, /\.app-tab[\s\S]*border-radius: 999px/);
  assert.match(styleCss, /\.header-actions \.btn[\s\S]*border-radius: 999px/);
  assert.match(styleCss, /\.account-chip[\s\S]*border-radius: 999px/);
  assert.match(styleCss, /\.chip-add[\s\S]*border-radius: 999px/);
  assert.match(styleCss, /\.ms-toolbar-actions \.btn[\s\S]*border-radius: 999px/);
});

test('网络配置支持多代理卡片、逐项测试与账号独立出口', () => {
  assert.match(indexHtml, /id="proxy-list"/);
  assert.match(indexHtml, /id="btn-add-proxy"/);
  assert.match(indexHtml, /id="cfg-account-proxy-mode"/);
  assert.match(indexHtml, /id="cfg-account-proxy-id"/);
  assert.match(appJs, /data-proxy-action="test"/);
  assert.match(appJs, /data-proxy-action="save"/);
  assert.match(appJs, /data-proxy-action="delete"/);
  assert.match(appJs, /当前访问 IP/);
  assert.match(styleCss, /\.proxy-card-fields[\s\S]*grid-template-columns/);
});

test('配置向导与新增账号会先确认代理再发起凭据会话', () => {
  assert.match(indexHtml, /1\. 网络出口[\s\S]*2\. 移动端授权[\s\S]*3\. 网页端 Cookie/);
  assert.match(indexHtml, /id="guide-btn-save-network"/);
  assert.match(indexHtml, /id="guide-account-proxy-mode"/);
  assert.match(indexHtml, /id="quick-add-proxy-mode"/);
  assert.match(indexHtml, /id="quick-add-proxy-id"/);
  assert.match(appJs, /async function saveGuideNetworkSettings/);
  assert.match(appJs, /guideNetworkConfirmed/);
  assert.match(appJs, /readProxySelection\('guide-account-proxy-mode', 'guide-account-proxy-id'\)/);
  assert.match(appJs, /proxy: proxySelection/);
  assert.match(appJs, /proxyMode: proxySelection\.mode/);
});

test('账号运行时间使用 00:00-23:00 的 24 个勾选档位', () => {
  assert.match(indexHtml, /id="cfg-run-hours"/);
  assert.match(indexHtml, /id="guide-run-hours"/);
  assert.match(indexHtml, /id="quick-add-run-hours"/);
  assert.match(appJs, /const RUN_HOURS = Array\.from\(\{ length: 24 \}/);
  assert.match(appJs, /function renderRunHourGrid/);
  assert.match(appJs, /randomDelayMin: 10/);
  assert.match(styleCss, /\.run-hour-grid[\s\S]*grid-template-columns/);
  assert.match(indexHtml, /id="cfg-search-interval"[^>]*value="60"/);
  assert.match(indexHtml, /id="cfg-search-jitter"[^>]*value="60"/);
});

test('配置保存保持窗口打开，时间档位展示其他账号占用', () => {
  assert.match(indexHtml, /id="settings-save-status"/);
  const saveStart = appJs.indexOf('async function saveSettingsFromModal');
  const saveEnd = appJs.indexOf('async function saveGuideNetworkSettings', saveStart);
  const saveFunction = appJs.slice(saveStart, saveEnd);
  assert.ok(saveStart > 0 && saveEnd > saveStart);
  assert.equal(saveFunction.includes("closeModal('settings-modal')"), false);
  assert.match(appJs, /function buildRunHourOccupancy/);
  assert.match(appJs, /已被以下账号占用/);
  assert.match(styleCss, /\.run-hour-option\.is-occupied/);
});

test('账号代理策略默认选择直连', () => {
  assert.match(indexHtml, /id="guide-account-proxy-mode"[\s\S]*?<option value="direct" selected>/);
  assert.match(indexHtml, /id="cfg-account-proxy-mode"[\s\S]*?<option value="direct" selected>/);
  assert.match(indexHtml, /id="quick-add-proxy-mode"[\s\S]*?<option value="direct" selected>/);
  assert.match(appJs, /proxyMode: 'direct'/);
});

test('全局网络支持直连与默认代理二选一，向导测试使用选中节点', () => {
  assert.match(indexHtml, /id="cfg-global-direct"[^>]*value="direct"[^>]*checked/);
  assert.match(indexHtml, /type="radio"[^>]*id="cfg-use-proxy"[^>]*value="proxy"/);
  assert.match(appJs, /function isGlobalProxyEnabled/);
  assert.match(appJs, /function setGlobalProxyEnabled/);
  assert.match(appJs, /function resolveGuideProxyTestTarget/);
  assert.match(appJs, /proxyUrl: proxy\.url/);
  assert.match(appJs, /proxyUrl: target\.proxyUrl/);
});
