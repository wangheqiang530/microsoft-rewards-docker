// 全局状态
let currentStatus = null;
let currentConfig = null;

function extractHtmlErrorDetail(text) {
  const source = String(text || '');
  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    || source.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)?.[1]
    || source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    || '';
  return title
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * 统一读取 JSON 接口响应。
 *
 * 反向代理超时或服务重启时，接口可能返回 502/504 的 HTML 页面；
 * 直接调用 response.json() 只会得到晦涩的 “Unexpected token '<'”。
 */
async function readJsonResponse(response) {
  const raw = await response.text();
  const text = raw.trim();
  const contentType = String(response.headers.get('content-type') || '');
  const status = Number(response.status) || 0;

  if (text) {
    try {
      return JSON.parse(text);
    } catch {}
  }

  const detail = extractHtmlErrorDetail(text);
  const looksHtml = /<!doctype\s+html|<html[\s>]|<body[\s>]|<pre[\s>]/i.test(text)
    || /text\/html/i.test(contentType);

  if (looksHtml) {
    if (status === 504 || /gateway time-?out|timed out|超时/i.test(detail)) {
      throw new Error('请求超过反向代理等待时间（HTTP 504），后台动作可能仍在执行，请稍后刷新任务进度确认');
    }
    if (status === 502) {
      throw new Error('反向代理无法连接后台服务（HTTP 502），请检查容器是否重启或仍在启动');
    }
    const suffix = detail ? `：${detail}` : '';
    throw new Error(`服务器返回了 HTML 页面而不是 JSON（HTTP ${status || '未知'}），通常是反向代理超时、服务重启或接口不存在${suffix}`);
  }

  throw new Error(`接口返回内容不是合法 JSON（HTTP ${status || '未知'}）${text ? `：${text.slice(0, 160)}` : ''}`);
}

let eventSource = null;
let currentHistoryDays = 7;
let currentTheme = 'dark';
let selectedAccountId = 'all'; // 'all' 或具体账号 id (如 'acc_1')
let editingAccountIdInModal = null;
let editingAccountIdInQuickModal = null;
let proxyDrafts = [];
let webConfirmResolver = null;
let epicActionPollTimer = null;
let microsoftActionPollTimer = null;
let actionProgressTimer = null;
let lastEpicActionLog = '';
let celebrationAnimationId = null;
let celebrationResizeHandler = null;
let celebrationTimers = [];
// 前端日志视图的起始时间：点击「清空」后只显示此后的新日志（后端日志不受影响）
let logViewSince = 0;
// 最近一次系统指标（容器 CPU/内存），供浏览器监控卡片复用
let lastSystemMetrics = null;
let diagMode = 'single';
let diagAccountId = null;
let accountsOverviewRenderSignature = '';
let statusFetchSeq = 0;
let scheduleConflictSignature = '';
let accountSummaryHistory = [];
let accountSummaryHistoryAt = 0;
let accountSummaryHistoryPromise = null;
let accountSummaryRenderSignature = '';
let accountSelectorRenderSignature = '';
let taskGridRenderSignature = '';
let timelineRenderSignature = '';
let accountTrendRows = [];
let accountTrendMetric = 'earned';
let accountTrendGeometry = null;
let accountTrendHideTimer = null;
let accountSummaryColumnState = null;

const ACCOUNT_SUMMARY_COLUMN_WIDTH_KEY = 'msr.accountSummaryColumnWidths.v1';
const ACCOUNT_SUMMARY_COLUMN_KEYS = ['account', 'balance', 'earned', 'claimable', 'streak', 'stamps', 'avg7', 'avg30'];

function setHtmlIfChanged(element, html) {
  if (!element) return false;
  const next = String(html ?? '');
  if (element.innerHTML === next) return false;
  element.innerHTML = next;
  return true;
}

function setTextIfChanged(element, text) {
  if (!element) return false;
  const next = String(text ?? '');
  if (element.textContent === next) return false;
  element.textContent = next;
  return true;
}

const ACCOUNT_TREND_METRICS = {
  balance: { label: '当前积分', kind: 'balance' },
  earned: { label: '今日获取', kind: 'earned' },
  claimable: { label: '待领取积分', kind: 'claimable' },
  streak: { label: '连续签到', kind: 'streak' },
  stamps: { label: '印章进度', kind: 'stamps' },
  avg7: { label: '近 7 日日均', kind: 'average', windowDays: 7 },
  avg30: { label: '近 30 日日均', kind: 'average', windowDays: 30 }
};

// 后端下发的凭据占位符：表示「已配置，内容保持隐藏」
const SECRET_PLACEHOLDER = '__MSR_SECRET_KEEP__';
const SECRET_CLEAR = '__MSR_SECRET_CLEAR__';
const VNC_AUTO_CLOSE_KEY = 'msr.vncAutoClose.v1';
let latestMicrosoftVncData = null;
let guideNetworkConfirmed = false;
let cfgDraftTokens = null;
let novncMode = 'epic';
let microsoftVncSuccessHandler = null;
let microsoftVncStatusTimer = null;
let microsoftVncPollingActive = false;
let microsoftVncCaptureInFlight = false;
let microsoftVncAutoCaptureTriggered = false;
let guideDraftAccount = {
  id: '',
  name: '新账号',
  order: 2,
  cookie: '',
  authCodeUrl: '',
  refreshToken: '',
  accessToken: '',
  tokenTime: 0,
  proxyMode: 'direct',
  proxyId: ''
};

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initUIEvents();
  initInstantTooltips();
  initLiquidVisuals();
  initLiquidMouseFollower();
  startCountdownTimer();
  fetchStatus();
  fetchSystemMetrics();
  fetchBrowserStatus();
  fetchBrowserRuntimeStatus();
  fetchConfig();
  fetchHistory(7);
  initLogStream();
  checkVersionUpdate();
  setInterval(fetchStatus, 4000); // 4秒轮询一次任务状态
  setInterval(fetchSystemMetrics, 4000); // 4秒轮询硬件与网络延时
  setInterval(fetchBrowserStatus, 2500); // 2.5秒轮询无头浏览器状态
});

// =========================================================================
// 🎨 iOS 液态玻璃风格与 WebGL2 动态背景引擎联动
// =========================================================================

const DEFAULT_VISUAL_CONFIG = {
  bgEnabled: true,
  bgStyle: 'grainient',
  colorTheme: 'aurora',
  bgSpeed: 1.0,
  bgNoise: 25,
  mouseTurbulence: 100,
  cardOpacity: 65,
  cardBlur: 20,
  borderGlow: 100,
  liquidSheen: 100,
  mouseFollow: true,
  rimSpread: 34,
  cardTilt: true
};

const THEME_ACCENT_COLORS = {
  aurora: { rgb: '250, 17, 79', secRgb: '0, 245, 212' },
  sunset: { rgb: '244, 63, 94', secRgb: '245, 158, 11' },
  ocean: { rgb: '2, 132, 199', secRgb: '6, 182, 212' },
  emerald: { rgb: '16, 185, 129', secRgb: '161, 255, 0' },
  monochrome: { rgb: '148, 163, 184', secRgb: '203, 213, 225' }
};

let currentVisualConfig = { ...DEFAULT_VISUAL_CONFIG };

function normalizeColorTheme(theme) {
  const aliases = {
    purple: 'sunset',
    amber: 'sunset',
    titanium: 'monochrome'
  };
  const normalized = aliases[theme] || theme;
  return THEME_ACCENT_COLORS[normalized] ? normalized : 'aurora';
}

function normalizeBgStyle(style) {
  const aliases = {
    fluid: 'silk',
    geometry: 'prism',
    nebula: 'veil',
    cyber: 'prism'
  };
  const normalized = aliases[style] || style;
  return ['silk', 'grainient', 'veil', 'aurora', 'prism'].includes(normalized) ? normalized : 'silk';
}

function getRewardsAppOfficialIconHtml() {
  return `<span class="rewards-app-icon-wrap" aria-hidden="true">
    <span class="rewards-app-icon-fallback">🎁</span>
    <img class="rewards-app-official-icon"
      src="https://bing.com/th?id=OMR.icon-96.png&amp;pid=Rewards"
      alt=""
      loading="lazy"
      referrerpolicy="no-referrer"
      onerror="this.style.display='none'">
  </span>`;
}

function render7DayStreakTrack(streak, fallbackDays, fallbackDone, streakTitle) {
  let completedDays = 0;
  if (streak && typeof streak.completedDays === 'number') {
    completedDays = Number(streak.completedDays || 0);
  } else if (fallbackDays) {
    completedDays = (fallbackDays % 7) || (fallbackDone ? 7 : 0);
  } else if (fallbackDone) {
    completedDays = 1;
  }
  completedDays = Math.min(7, Math.max(0, completedDays));

  const fillPercent = completedDays <= 0 ? 0 : Math.min(100, Math.round(((completedDays - 0.5) / 6.5) * 100));

  let nodesHtml = '';
  for (let d = 1; d <= 6; d++) {
    if (d < completedDays) {
      nodesHtml += `<div class="streak-step-node done-circle" data-tip="第 ${d} 天：已打卡"><span class="step-check">✓</span></div>`;
    } else if (d === completedDays) {
      nodesHtml += `<div class="streak-step-node active-pill" data-tip="第 ${d} 天：已打卡达成"><span class="step-check">✓</span><span class="step-num">${d}</span></div>`;
    } else {
      nodesHtml += `<div class="streak-step-node pending-circle" data-tip="第 ${d} 天：待打卡"></div>`;
    }
  }

  if (completedDays >= 7) {
    nodesHtml += `<div class="streak-step-node goal-pill done" data-tip="第 7 天：连续达成 100 积分大奖！"><span class="step-star">✦</span><span class="step-pts">100</span></div>`;
  } else {
    nodesHtml += `<div class="streak-step-node goal-pill pending" data-tip="第 7 天：达成额外奖励 100 积分"><span class="step-star">✦</span><span class="step-pts">100</span></div>`;
  }

  return `
    <div class="streak-7day-wrap">
      <div class="streak-7day-header">
        <span class="streak-7day-title">${escapeHtml(streakTitle)}</span>
        <span class="streak-7day-badge">已连签 ${completedDays} / 7 天</span>
      </div>
      <div class="streak-7day-rail">
        <div class="streak-7day-line"></div>
        <div class="streak-7day-line-fill" style="width: ${fillPercent}%;"></div>
        ${nodesHtml}
      </div>
    </div>
  `;
}

function renderStampsGrid(stamps) {
  const container = document.getElementById('stamps-grid-track');
  if (!container) return;
  const progress = Number(stamps?.progress || 0);
  const max = Number(stamps?.max || 12) || 12;

  const starPath = 'M12 2 L13.8 7.8 L19.5 8.5 L15.2 12.3 L16.5 18 L12 15 L7.5 18 L8.8 12.3 L4.5 8.5 L10.2 7.8 Z';

  let html = '';
  for (let i = 1; i <= max; i++) {
    const isCollected = i <= progress;
    const isGoal = i === max;
    const tip = isCollected
      ? `第 ${i} 个印章：已集齐`
      : (isGoal ? `第 ${i} 个印章：集满赢取 1,000 积分大奖！` : `第 ${i} 个印章：待集齐`);

    html += `
      <div class="stamp-grid-item ${isCollected ? 'collected' : 'uncollected'}${isGoal ? ' is-goal' : ''}" data-tip="${tip}" aria-label="${tip}">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="${starPath}" />
        </svg>
      </div>
    `;
  }
  container.innerHTML = html;
}

function renderAccountStampsList(accounts) {
  const container = document.getElementById('stamps-account-list');
  if (!container) return;
  const starPath = 'M12 2 L13.8 7.8 L19.5 8.5 L15.2 12.3 L16.5 18 L12 15 L7.5 18 L8.8 12.3 L4.5 8.5 L10.2 7.8 Z';

  container.innerHTML = (accounts || []).map(acc => {
    const stamps = acc.stamps || { progress: 0, max: 12 };
    const max = Math.max(1, Number(stamps.max || 12));
    const progress = Math.max(0, Math.min(max, Number(stamps.progress || 0)));
    const dots = Array.from({ length: max }, (_, index) => {
      const day = index + 1;
      return `<span class="mini-stamp ${day <= progress ? 'collected' : 'uncollected'}${day === max ? ' is-goal' : ''}" title="${escapeHtml(acc.name || '账号')}：第 ${day} 个印章${day <= progress ? '已集齐' : '待集齐'}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${starPath}"/></svg>
      </span>`;
    }).join('');

    return `
      <div class="stamp-account-row">
        <div class="stamp-account-head">
          <span class="stamp-account-name" title="${escapeHtml(acc.name || '账号')}">${escapeHtml(acc.name || '账号')}</span>
          <span class="stamp-account-count">${progress} / ${max}</span>
        </div>
        <div class="stamp-account-dots">${dots}</div>
      </div>
    `;
  }).join('') || '<div class="stamp-account-empty">暂无账号印章数据</div>';
}

function renderHeroAccountBreakdown(containerId, accounts, valueKey, formatter) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = (accounts || []).map(acc => {
    const value = Number(acc[valueKey] || 0);
    return `
      <div class="hero-account-row">
        <span class="hero-account-name" title="${escapeHtml(acc.name || '账号')}">${escapeHtml(acc.name || '账号')}</span>
        <span class="hero-account-value">${escapeHtml(formatter(value))}</span>
      </div>
    `;
  }).join('') || '<div class="hero-account-empty">暂无账号数据</div>';
}

function applyVisualConfig(cfg = {}) {
  currentVisualConfig = { ...DEFAULT_VISUAL_CONFIG, ...cfg };
  const v = currentVisualConfig;
  v.colorTheme = normalizeColorTheme(v.colorTheme);
  v.bgStyle = normalizeBgStyle(v.bgStyle);

  // 兼容小数格式归一化为百分比整数
  if (typeof v.cardOpacity === 'number' && v.cardOpacity > 0 && v.cardOpacity <= 1) v.cardOpacity = Math.round(v.cardOpacity * 100);
  if (typeof v.borderGlow === 'number' && v.borderGlow > 0 && v.borderGlow <= 2) v.borderGlow = Math.round(v.borderGlow * 100);
  if (typeof v.liquidSheen === 'number' && v.liquidSheen > 0 && v.liquidSheen <= 2) v.liquidSheen = Math.round(v.liquidSheen * 100);
  if (typeof v.bgNoise === 'number' && v.bgNoise > 0 && v.bgNoise <= 1) v.bgNoise = Math.round(v.bgNoise * 100);
  if (typeof v.mouseTurbulence === 'number' && v.mouseTurbulence > 0 && v.mouseTurbulence <= 2) v.mouseTurbulence = Math.round(v.mouseTurbulence * 100);

  const root = document.documentElement;
  root.style.setProperty('--glass-opacity', (v.cardOpacity / 100).toFixed(2));
  root.style.setProperty('--glass-blur', `${v.cardBlur}px`);
  root.style.setProperty('--border-glow-intensity', (v.borderGlow / 100).toFixed(2));
  root.style.setProperty('--liquid-sheen-intensity', (v.liquidSheen / 100).toFixed(2));
  root.style.setProperty('--rim-half', `${v.rimSpread}deg`);
  root.style.setProperty('--rim-q', `${(v.rimSpread * 0.35).toFixed(1)}deg`);
  root.style.setProperty('--rim-mid', `${(v.rimSpread * 0.72).toFixed(1)}deg`);
  root.style.setProperty('--rim-end', `${(v.rimSpread * 1.9).toFixed(1)}deg`);

  const palette = THEME_ACCENT_COLORS[v.colorTheme] || THEME_ACCENT_COLORS.aurora;
  root.style.setProperty('--accent-glow-rgb', palette.rgb);
  root.style.setProperty('--accent-glow-sec-rgb', palette.secRgb);

  document.body.classList.add('liquid-glass-enabled');
  document.body.classList.toggle('webgl-bg-active', !!v.bgEnabled);
  document.body.classList.toggle('mouse-follow-enabled', !!v.mouseFollow);
  document.body.classList.toggle('card-tilt-enabled', !!v.cardTilt);
  document.body.dataset.visualTheme = v.colorTheme || 'aurora';

  localStorage.setItem('msr_visual_config', JSON.stringify(v));
  enhanceGlassSurfaces();

  if (window.LiquidBg) {
    window.LiquidBg.setEnabled(!!v.bgEnabled);
    window.LiquidBg.setStyle(v.bgStyle);
    window.LiquidBg.setTheme(v.colorTheme || 'aurora');
    window.LiquidBg.setSpeed(Number(v.bgSpeed) || 1.0);
    window.LiquidBg.setNoise((Number(v.bgNoise) || 25) / 100);
    window.LiquidBg.setTurbulence((Number(v.mouseTurbulence) || 100) / 100);
  }

  syncVisualInputs(v);
}

function syncVisualInputs(v) {
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
  const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.innerText = txt; };

  setVal('cfg-card-opacity', v.cardOpacity);
  setText('val-card-opacity', `${v.cardOpacity}%`);

  setVal('cfg-card-blur', v.cardBlur);
  setText('val-card-blur', `${v.cardBlur}px`);

  setVal('cfg-border-glow', v.borderGlow);
  setText('val-border-glow', `${v.borderGlow}%`);

  setVal('cfg-liquid-sheen', v.liquidSheen);
  setText('val-liquid-sheen', `${v.liquidSheen}%`);

  setVal('cfg-rim-spread', v.rimSpread);
  setText('val-rim-spread', `${v.rimSpread}°`);

  setChecked('cfg-mouse-follow', v.mouseFollow);
  setChecked('cfg-card-tilt', v.cardTilt);

  setChecked('cfg-bg-enabled', v.bgEnabled);
  setVal('cfg-bg-style', v.bgStyle);
  setVal('cfg-color-theme', v.colorTheme);

  setVal('cfg-bg-speed', v.bgSpeed);
  setText('val-bg-speed', `${Number(v.bgSpeed).toFixed(1)}x`);

  setVal('cfg-bg-noise', v.bgNoise);
  setText('val-bg-noise', `${v.bgNoise}%`);

  setVal('cfg-mouse-turb', v.mouseTurbulence);
  setText('val-mouse-turb', `${v.mouseTurbulence}%`);
}

function readVisualInputs() {
  const readNumber = (id, fallback) => {
    const value = Number(document.getElementById(id)?.value);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    cardOpacity: readNumber('cfg-card-opacity', 65),
    cardBlur: readNumber('cfg-card-blur', 20),
    borderGlow: readNumber('cfg-border-glow', 100),
    liquidSheen: readNumber('cfg-liquid-sheen', 100),
    rimSpread: readNumber('cfg-rim-spread', 34),
    mouseFollow: document.getElementById('cfg-mouse-follow')?.checked ?? true,
    cardTilt: document.getElementById('cfg-card-tilt')?.checked ?? true,
    bgEnabled: document.getElementById('cfg-bg-enabled')?.checked ?? true,
    bgStyle: normalizeBgStyle(document.getElementById('cfg-bg-style')?.value || 'silk'),
    colorTheme: normalizeColorTheme(document.getElementById('cfg-color-theme')?.value || 'aurora'),
    bgSpeed: readNumber('cfg-bg-speed', 1.0),
    bgNoise: readNumber('cfg-bg-noise', 25),
    mouseTurbulence: readNumber('cfg-mouse-turb', 100)
  };
}

function initLiquidVisuals() {
  const saved = localStorage.getItem('msr_visual_config');
  if (saved) {
    try {
      applyVisualConfig(JSON.parse(saved));
    } catch (e) {
      applyVisualConfig(DEFAULT_VISUAL_CONFIG);
    }
  } else {
    applyVisualConfig(DEFAULT_VISUAL_CONFIG);
  }

  const bindRange = (id, valId, unit, key, scale = 1) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = el.value;
      const valEl = document.getElementById(valId);
      if (valEl) valEl.innerText = `${v}${unit}`;
      const patch = {};
      patch[key] = scale === 1 ? Number(v) : parseFloat(v);
      applyVisualConfig(patch);
    });
  };

  bindRange('cfg-card-opacity', 'val-card-opacity', '%', 'cardOpacity');
  bindRange('cfg-card-blur', 'val-card-blur', 'px', 'cardBlur');
  bindRange('cfg-border-glow', 'val-border-glow', '%', 'borderGlow');
  bindRange('cfg-liquid-sheen', 'val-liquid-sheen', '%', 'liquidSheen');
  bindRange('cfg-rim-spread', 'val-rim-spread', '°', 'rimSpread');
  bindRange('cfg-bg-speed', 'val-bg-speed', 'x', 'bgSpeed', 0.1);
  bindRange('cfg-bg-noise', 'val-bg-noise', '%', 'bgNoise');
  bindRange('cfg-mouse-turb', 'val-mouse-turb', '%', 'mouseTurbulence');

  const bindCheckbox = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      const patch = {};
      patch[key] = el.checked;
      applyVisualConfig(patch);
    });
  };

  bindCheckbox('cfg-mouse-follow', 'mouseFollow');
  bindCheckbox('cfg-card-tilt', 'cardTilt');
  bindCheckbox('cfg-bg-enabled', 'bgEnabled');

  const bindSelect = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      const patch = {};
      patch[key] = el.value;
      applyVisualConfig(patch);
    });
  };

  bindSelect('cfg-bg-style', 'bgStyle');
  bindSelect('cfg-color-theme', 'colorTheme');

  document.getElementById('btn-preset-ios')?.addEventListener('click', () => applyVisualPreset('ios-glass'));
  document.getElementById('btn-preset-aurora')?.addEventListener('click', () => applyVisualPreset('aurora-night'));
  document.getElementById('btn-preset-ocean')?.addEventListener('click', () => applyVisualPreset('deep-ocean'));
  document.getElementById('btn-preset-titanium')?.addEventListener('click', () => applyVisualPreset('matte-titanium'));
  document.getElementById('btn-reset-visual')?.addEventListener('click', () => resetVisualDefaults());
}

function applyVisualPreset(presetName) {
  let patch = {};
  if (presetName === 'ios-glass') {
    patch = {
      cardOpacity: 55,
      cardBlur: 24,
      borderGlow: 120,
      liquidSheen: 120,
      mouseFollow: true,
      rimSpread: 30,
      cardTilt: true,
      bgEnabled: true,
      bgStyle: 'silk',
      colorTheme: 'ocean',
      bgSpeed: 0.8,
      bgNoise: 20,
      mouseTurbulence: 90
    };
  } else if (presetName === 'aurora-night') {
    patch = {
      cardOpacity: 65,
      cardBlur: 20,
      borderGlow: 110,
      liquidSheen: 100,
      mouseFollow: true,
      rimSpread: 34,
      cardTilt: true,
      bgEnabled: true,
      bgStyle: 'veil',
      colorTheme: 'aurora',
      bgSpeed: 1.0,
      bgNoise: 25,
      mouseTurbulence: 100
    };
  } else if (presetName === 'deep-ocean') {
    patch = {
      cardOpacity: 60,
      cardBlur: 22,
      borderGlow: 100,
      liquidSheen: 110,
      mouseFollow: true,
      rimSpread: 42,
      cardTilt: true,
      bgEnabled: true,
      bgStyle: 'grainient',
      colorTheme: 'ocean',
      bgSpeed: 1.2,
      bgNoise: 20,
      mouseTurbulence: 130
    };
  } else if (presetName === 'matte-titanium') {
    patch = {
      cardOpacity: 75,
      cardBlur: 16,
      borderGlow: 80,
      liquidSheen: 60,
      mouseFollow: true,
      rimSpread: 26,
      cardTilt: false,
      bgEnabled: true,
      bgStyle: 'grainient',
      colorTheme: 'monochrome',
      bgSpeed: 0.5,
      bgNoise: 40,
      mouseTurbulence: 50
    };
  }
  applyVisualConfig(patch);
}

function resetVisualDefaults() {
  applyVisualConfig(DEFAULT_VISUAL_CONFIG);
}

const GLASS_SURFACE_SELECTOR = [
  '.header',
  '.account-selector-section',
  '.ms-toolbar',
  '.hero-card',
  '.section-card',
  '.task-card',
  '.account-overview-card',
  '.modal-box',
  '.epic-stat-card',
  '.epic-game-card',
  '.epic-side-card',
  '.epic-account-card',
  '.epic-record-row',
  '.diag-item-card',
  '.diag-banner',
  '.diag-summary-box',
  '.history-card',
  '.step-action-box'
].join(',');

function enhanceGlassSurfaces(root = document) {
  if (root?.matches?.(GLASS_SURFACE_SELECTOR)) root.classList.add('glass-surface');
  root?.querySelectorAll?.(GLASS_SURFACE_SELECTOR).forEach(el => el.classList.add('glass-surface'));
}

function initLiquidMouseFollower() {
  enhanceGlassSurfaces();
  let cards = [];
  const updateCardsList = () => {
    cards = Array.from(document.querySelectorAll(GLASS_SURFACE_SELECTOR));
  };

  let observerRaf = 0;
  const scheduleCardsListUpdate = () => {
    if (observerRaf) return;
    observerRaf = requestAnimationFrame(() => {
      observerRaf = 0;
      updateCardsList();
    });
  };
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) enhanceGlassSurfaces(node);
      }
    }
    scheduleCardsListUpdate();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  updateCardsList();

  let rafPending = false;
  let mouseEvent = null;

  window.addEventListener('mousemove', (e) => {
    mouseEvent = e;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (!mouseEvent) return;
        const mx = mouseEvent.clientX;
        const my = mouseEvent.clientY;
        const isTiltEnabled = document.body.classList.contains('card-tilt-enabled');

        for (let i = 0; i < cards.length; i++) {
          const card = cards[i];
          const rect = card.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const isInside = mx >= rect.left && mx <= rect.right && my >= rect.top && my <= rect.bottom;
          if (
            mx >= rect.left - 350 &&
            mx <= rect.right + 350 &&
            my >= rect.top - 350 &&
            my <= rect.bottom + 350
          ) {
            const relX = mx - rect.left;
            const relY = my - rect.top;
            const normX = (relX / rect.width) * 2 - 1;
            const normY = (relY / rect.height) * 2 - 1;
            const pointerAngle = Math.atan2(normY, normX) * 180 / Math.PI + 90;
            const normalizedAngle = ((pointerAngle % 360) + 360) % 360;
            card.style.setProperty('--pointer-angle', `${normalizedAngle.toFixed(2)}deg`);

            if (isTiltEnabled && isInside) {
              const normX = (relX / rect.width) - 0.5;
              const normY = (relY / rect.height) - 0.5;
              const isLargeSurface = card.matches('.header, .section-card, .modal-box, .account-selector-section, .ms-toolbar');
              const strength = isLargeSurface ? 0.9 : 2.4;
              const lift = isLargeSurface ? 0 : -2;
              const tiltX = -normY * strength;
              const tiltY = normX * strength;
              card.style.transform = `perspective(1100px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg) translateY(${lift}px)`;
            } else if (card.style.transform) {
              card.style.transform = '';
            }
          } else if (card.style.transform) {
            card.style.transform = '';
          }
        }
      });
    }
  }, { passive: true });

  const resetCardTilt = () => {
    for (let i = 0; i < cards.length; i++) {
      cards[i].style.transform = '';
    }
  };
  document.documentElement.addEventListener('mouseleave', resetCardTilt);
  window.addEventListener('blur', resetCardTilt);
}

// 全时段固定夜间模式
function initTheme() {
  applyTheme('dark');
}

function setTheme(_theme, syncServer = false) {
  currentTheme = 'dark';
  localStorage.setItem('ms_rewards_theme', 'dark');
  applyTheme('dark');
  const selectElem = document.getElementById('cfg-ui-theme');
  if (selectElem) selectElem.value = 'dark';
  if (syncServer) {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ui: { theme: 'dark' } })
    }).catch(() => {});
  }
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', 'dark');
}

// 微软积分商城每天 00:00 刷新，倒计时到下一个自然日零点。
function startCountdownTimer() {
  function updateTimer() {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    const diff = Math.max(0, target.getTime() - now.getTime());
    const hours = String(Math.floor(diff / 3600000)).padStart(2, '0');
    const minutes = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
    const seconds = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
    const timerElem = document.getElementById('countdown-timer');
    if (timerElem) {
      timerElem.innerText = `${hours}:${minutes}:${seconds}`;
    }
  }
  updateTimer();
  setInterval(updateTimer, 1000);
}

// ===== 即时悬停提示：替代浏览器原生 title（原生有约 1 秒延迟） =====
let instantTooltipEl = null;
let instantTooltipTarget = null;

function ensureInstantTooltipEl() {
  if (!instantTooltipEl) {
    instantTooltipEl = document.createElement('div');
    instantTooltipEl.className = 'instant-tooltip';
    document.body.appendChild(instantTooltipEl);
  }
  return instantTooltipEl;
}

function showInstantTooltip(target) {
  let text = target.getAttribute('data-tip');
  if (!text && target.hasAttribute('title')) {
    text = target.getAttribute('title');
    target.setAttribute('data-tip', text);
  }
  // 无论走哪条分支都摘掉原生 title，否则约 1 秒后浏览器还会弹出第二套提示
  if (target.hasAttribute('title')) target.removeAttribute('title');
  if (!text) return;

  const el = ensureInstantTooltipEl();
  el.textContent = text;
  el.classList.add('visible');

  const rect = target.getBoundingClientRect();
  const tipRect = el.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.left + rect.width / 2 - tipRect.width / 2, window.innerWidth - tipRect.width - 12));
  let top = rect.bottom + 8;
  if (top + tipRect.height > window.innerHeight - 8) {
    top = rect.top - tipRect.height - 8;
  }
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(8, top)}px`;
  instantTooltipTarget = target;
}

function hideInstantTooltip() {
  if (instantTooltipEl) instantTooltipEl.classList.remove('visible');
  instantTooltipTarget = null;
}

function initInstantTooltips() {
  document.addEventListener('mouseover', (e) => {
    const target = e.target?.closest?.('[title], [data-tip]');
    if (!target || target === instantTooltipTarget) return;
    showInstantTooltip(target);
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target?.closest?.('[title], [data-tip]');
    if (!target) return;
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;
    hideInstantTooltip();
  });

  window.addEventListener('scroll', hideInstantTooltip, true);
  window.addEventListener('resize', hideInstantTooltip);
}

function initUIEvents() {
  // 立即运行 & 停止 (支持全局与单账号)
  document.getElementById('btn-run')?.addEventListener('click', runTasks);
  document.getElementById('btn-stop')?.addEventListener('click', stopTasks);
  document.getElementById('btn-run-single-header')?.addEventListener('click', runTasks);
  document.getElementById('btn-toggle-account-header')?.addEventListener('click', toggleSelectedAccount);
  document.getElementById('btn-stop-single-header')?.addEventListener('click', stopTasks);

  // 版本与状态复合胶囊点击检测更新
  document.getElementById('version-status-pill')?.addEventListener('click', handleVersionCheckClick);

  // 历史记录天数切换
  document.getElementById('btn-history-7')?.addEventListener('click', () => switchHistoryDays(7));
  document.getElementById('btn-history-30')?.addEventListener('click', () => switchHistoryDays(30));

  // 顶部快捷测试账号登录
  document.getElementById('btn-check-account').addEventListener('click', () => {
    diagMode = 'single';
    diagAccountId = selectedAccountId !== 'all'
      ? selectedAccountId
      : (currentConfig?.accounts?.[0]?.id || 'acc_1');
    openModal('diag-modal');
    runAccountDiagnosis();
  });
  document.getElementById('btn-close-diag').addEventListener('click', () => closeModal('diag-modal'));
  document.getElementById('btn-confirm-diag').addEventListener('click', () => closeModal('diag-modal'));
  document.getElementById('btn-retest-diag').addEventListener('click', runAccountDiagnosis);

  // 硬件监控指标点击立即刷新
  document.getElementById('sys-metrics-pill')?.addEventListener('click', async () => {
    const pill = document.getElementById('sys-metrics-pill');
    pill?.classList.add('refreshing');
    await fetchSystemMetrics();
    setTimeout(() => pill?.classList.remove('refreshing'), 600);
  });

  document.getElementById('btn-turbo-mode')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/tasks/turbo', { method: 'POST' }).then(r => r.json());
      if (res.success) {
        const isTurbo = !!res.turboMode;
        const turboBtn = document.getElementById('btn-turbo-mode');
        const turboText = document.getElementById('btn-turbo-text');
        if (turboBtn && turboText) {
          turboBtn.className = `btn ${isTurbo ? 'btn-warning active' : 'btn-secondary'} btn-sm`;
          setTextIfChanged(turboText, isTurbo ? '极速模式: 下次生效' : '极速模式: 关');
        }
        await fetchStatus();
      }
    } catch {}
  });

  // 顶部一键同步微软官网真实状态
  document.getElementById('btn-sync-status')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-sync-status');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> 同步中...';
    openEpicActionModal('官网同步', '正在从微软官网同步真实任务完成度...', ['锁定账号上下文', '请求官网数据', '解析真实进度', '刷新看板'], 0);
    startActionProgressTicker(12, 88, 8, '正在从微软官网同步真实任务完成度...');
    try {
      const res = await fetch('/api/status/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId !== 'all' ? selectedAccountId : null, force: true })
      }).then(r => r.json());
      stopActionProgressTicker();
      if (res.success && res.data) {
        currentStatus = res.data;
        renderDashboard(res.data);
        if (res.skipped) {
          updateEpicActionModal({
            progress: 100,
            badge: { text: '已跳过', cls: 'warn' },
            message: res.message || '任务正在执行中，已跳过同步',
            result: '为避免多账号上下文串台，本次同步已安全跳过。'
          });
        } else {
          updateEpicActionModal({
            activeIndex: 4,
            progress: 100,
            badge: { text: '同步完成', cls: 'ok' },
            message: '微软官网真实状态已同步',
            result: buildMicrosoftStatusDetails(res.data)
          });
        }
      }
    } catch (e) {
      stopActionProgressTicker();
      updateEpicActionModal({
        progress: 100,
        badge: { text: '同步异常', cls: 'err' },
        message: e.message,
        result: `同步异常：${e.message}`
      });
    } finally {
      btn.innerHTML = origHtml;
    }
  });

  // 单次安全测试搜索按钮 (真实按键输入，不触发冷冻)
  document.getElementById('btn-trigger-single-search')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-trigger-single-search');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> 搜索验证中...';
    const targetId = selectedAccountId !== 'all' ? selectedAccountId : (currentConfig?.accounts?.[0]?.id || 'acc_1');
    const targetName = currentConfig?.accounts?.find(a => a.id === targetId)?.name || targetId;
    openEpicActionModal(
      `单次安全测搜 · ${targetName}`,
      '正在准备浏览器并执行一次拟人搜索...',
      ['准备浏览器环境', '校验账号登录态', '执行拟人键盘搜索', '同步积分与配额', '输出测试明细'],
      0
    );
    startMicrosoftActionPolling();
    try {
      const res = await fetch('/api/tasks/single-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: targetId })
      }).then(r => r.json());
      stopMicrosoftActionPolling();
      if (res.success) {
        updateEpicActionModal({
          activeIndex: 5,
          progress: 100,
          badge: { text: '测试成功', cls: 'ok' },
          message: '单次测试搜索已完成',
          result: `账号：${targetName}\n${res.data.message || '已完成拟人按键输入与积分同步'}\n\n提示：该测试用于验证浏览器登录态与搜索通道，不会替代每日完整搜索配额。`
        });
        fetchStatus();
      } else {
        updateEpicActionModal({
          progress: 100,
          badge: { text: '测试失败', cls: 'err' },
          message: res.message || '搜索测试失败',
          result: `失败原因：${res.message || '未知错误'}`
        });
      }
    } catch (e) {
      stopMicrosoftActionPolling();
      updateEpicActionModal({
        progress: 100,
        badge: { text: '请求异常', cls: 'err' },
        message: e.message,
        result: `请求异常：${e.message}`
      });
    } finally {
      btn.innerHTML = origHtml;
    }
  });

  // 测试词库来源按钮
  document.getElementById('btn-test-search-api')?.addEventListener('click', handleTestSearchApi);
  document.getElementById('btn-close-words-modal')?.addEventListener('click', () => closeModal('search-words-modal'));
  document.getElementById('btn-close-words-modal-btn')?.addEventListener('click', () => closeModal('search-words-modal'));

  // 新建账号弹窗相关
  document.getElementById('btn-add-account-card')?.addEventListener('click', () => openQuickAddAccountModal());
  document.getElementById('btn-close-quick-add')?.addEventListener('click', () => closeModal('account-quick-add-modal'));
  document.getElementById('btn-cancel-quick-add')?.addEventListener('click', () => closeModal('account-quick-add-modal'));
  document.getElementById('btn-save-quick-add')?.addEventListener('click', handleQuickAddAccount);
  document.getElementById('quick-add-proxy-mode')?.addEventListener('change', () => {
    updateQuickAddProxyControls(document.getElementById('quick-add-proxy-id')?.value || '');
  });
  document.getElementById('quick-add-proxy-id')?.addEventListener('change', (e) => {
    updateQuickAddProxyControls(e.target.value);
  });
  document.getElementById('btn-quick-test-cookie')?.addEventListener('click', async () => {
    const targetId = editingAccountIdInQuickModal;
    const input = document.getElementById('quick-add-cookie')?.value.trim() || '';
    const result = document.getElementById('quick-add-cookie-result');
    if (quickAddCookieCleared || input.startsWith('（已标记清空')) {
      if (result) result.innerHTML = '<span style="color:#F59E0B;">Cookie 已标记清空，请先重新粘贴后再测试。</span>';
      return;
    }
    if (!input && !targetId) {
      if (result) result.innerHTML = '<span style="color:#EF4444;">请先粘贴 Cookie 再测试。</span>';
      return;
    }
    if (result) result.innerHTML = '<span style="color:#38BDF8;">⏳ 正在使用当前账号代理测试 Cookie...</span>';
    try {
      const testRes = await fetch('/api/auth/test-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cookie: input || SECRET_PLACEHOLDER,
          accountId: targetId,
          proxy: readProxySelection('quick-add-proxy-mode', 'quick-add-proxy-id')
        })
      }).then(r => r.json());
      if (testRes.success && testRes.data?.valid) {
        if (result) result.innerHTML = `<span style="color:#34D399;">✅ ${escapeHtml(testRes.data.message)}</span>`;
      } else {
        if (result) result.innerHTML = `<span style="color:#EF4444;">❌ ${escapeHtml(testRes.data?.message || testRes.message || 'Cookie 检测无效')}</span>`;
      }
    } catch (e) {
      if (result) result.innerHTML = `<span style="color:#EF4444;">❌ 检测异常: ${escapeHtml(e.message)}</span>`;
    }
  });
  document.getElementById('btn-quick-test-token')?.addEventListener('click', async () => {
    const targetId = editingAccountIdInQuickModal;
    const input = document.getElementById('quick-add-authcode')?.value.trim() || '';
    const result = document.getElementById('quick-add-auth-result');
    if (!input && !targetId) {
      if (result) result.innerHTML = '<span style="color:#EF4444;">请先粘贴授权码；新账号也可先保存后再测试 Token。</span>';
      return;
    }
    if (result) result.innerHTML = input
      ? '<span style="color:#38BDF8;">⏳ 正在临时换取并测试 Token...</span>'
      : '<span style="color:#38BDF8;">⏳ 正在使用当前账号代理测试已保存 Token...</span>';
    try {
      const testRes = await fetch('/api/auth/test-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: targetId,
          name: document.getElementById('quick-add-name')?.value.trim() || '',
          urlOrCode: input || undefined,
          proxy: readProxySelection('quick-add-proxy-mode', 'quick-add-proxy-id')
        })
      }).then(r => r.json());
      if (testRes.success && testRes.data?.valid) {
        if (testRes.data.tokens) {
          quickAddDraftTokens = testRes.data.tokens;
        }
        if (result) result.innerHTML = `<span style="color:#34D399;">✅ ${escapeHtml(testRes.data.message)}${testRes.data.tokens ? '<br>新 Token 已临时验证，点击「保存修改」后写入账号。' : ''}</span>`;
      } else {
        if (result) result.innerHTML = `<span style="color:#EF4444;">❌ ${escapeHtml(testRes.data?.message || testRes.message || 'Token 检测无效')}</span>`;
      }
    } catch (e) {
      if (result) result.innerHTML = `<span style="color:#EF4444;">❌ 检测异常: ${escapeHtml(e.message)}</span>`;
    }
  });
  document.getElementById('quick-add-authcode')?.addEventListener('input', () => {
    quickAddDraftTokens = null;
    const result = document.getElementById('quick-add-auth-result');
    if (result) result.innerHTML = '';
  });

  // 通用网页确认框
  document.getElementById('btn-web-confirm-ok')?.addEventListener('click', () => resolveWebConfirm(true));
  document.getElementById('btn-web-confirm-cancel')?.addEventListener('click', () => resolveWebConfirm(false));
  document.getElementById('btn-web-confirm-close')?.addEventListener('click', () => resolveWebConfirm(false));

  // Epic 操作进度弹窗
  document.getElementById('btn-epic-action-close')?.addEventListener('click', closeEpicActionModal);
  document.getElementById('btn-close-epic-action')?.addEventListener('click', closeEpicActionModal);
  document.getElementById('btn-epic-action-background')?.addEventListener('click', () => {
    stopEpicActionPolling();
    stopMicrosoftActionPolling();
    stopActionProgressTicker();
    closeModal('epic-action-modal');
  });
  document.getElementById('btn-epic-action-stop')?.addEventListener('click', stopEpicTask);

  // 向导 Modal (默认创建全新账号，绝不覆盖已有账号)
  document.getElementById('btn-guide').addEventListener('click', openGuideModal);
  document.getElementById('btn-close-guide').addEventListener('click', () => closeModal('guide-modal'));
  document.getElementById('btn-finish-guide').addEventListener('click', () => closeModal('guide-modal'));
  document.getElementById('guide-account-proxy-mode')?.addEventListener('change', () => {
    updateGuideProxyControls(document.getElementById('guide-account-proxy-id')?.value || '');
  });
  document.getElementById('guide-account-proxy-id')?.addEventListener('change', (e) => {
    updateGuideProxyControls(e.target.value);
  });
  document.getElementById('guide-use-proxy')?.addEventListener('change', () => {
    updateGuideProxyControls(document.getElementById('guide-account-proxy-id')?.value || '');
  });
  ['guide-use-proxy', 'guide-proxy-url', 'guide-lock-region', 'guide-account-proxy-mode', 'guide-account-proxy-id'].forEach(id => {
    const el = document.getElementById(id);
    el?.addEventListener('input', () => { guideNetworkConfirmed = false; });
    el?.addEventListener('change', () => { guideNetworkConfirmed = false; });
  });
  document.getElementById('guide-btn-save-network')?.addEventListener('click', saveGuideNetworkSettings);
  document.getElementById('guide-btn-vnc-login')?.addEventListener('click', openGuideMicrosoftVnc);
  document.querySelectorAll('input[name="guide-credential-mode"]').forEach(input => {
    input.addEventListener('change', updateGuideCredentialMode);
  });
  document.getElementById('btn-quick-vnc-login')?.addEventListener('click', openQuickAddMicrosoftVnc);
  document.getElementById('btn-cfg-vnc-login')?.addEventListener('click', openSettingsMicrosoftVnc);
  document.getElementById('btn-check-gpu')?.addEventListener('click', handleGpuCheck);
  document.getElementById('btn-refresh-fonts')?.addEventListener('click', handleFontRefresh);
  document.getElementById('quick-add-cookie')?.addEventListener('input', () => {
    if (quickAddDraftTokens) {
      quickAddDraftTokens = null;
      const result = document.getElementById('quick-add-vnc-result');
      if (result) result.innerHTML = '<span style="color:#F59E0B;">Cookie 已手动修改，之前暂存的 Token 已清空，请重新获取或手动填写 Token。</span>';
    }
  });
  document.getElementById('cfg-cookie')?.addEventListener('input', () => {
    if (cfgDraftTokens) {
      cfgDraftTokens = null;
      const result = document.getElementById('cfg-vnc-result');
      if (result) result.innerHTML = '<span style="color:#F59E0B;">Cookie 已手动修改，之前暂存的 Token 已清空，请重新获取或手动填写 Token。</span>';
    }
  });
  document.getElementById('cfg-authcode')?.addEventListener('input', () => {
    cfgDraftTokens = null;
  });
  document.getElementById('guide-cookie-input')?.addEventListener('input', () => {
    if (guideDraftAccount.refreshToken || guideDraftAccount.accessToken) {
      guideDraftAccount.refreshToken = '';
      guideDraftAccount.accessToken = '';
      guideDraftAccount.tokenTime = 0;
      const result = document.getElementById('guide-vnc-result');
      if (result) result.innerHTML = '<span style="color:#F59E0B;">Cookie 已手动修改，自动获取的 Token 已清空，请重新登录或手动填写授权码。</span>';
    }
  });
  document.getElementById('guide-code-input')?.addEventListener('input', () => {
    if (guideDraftAccount.refreshToken || guideDraftAccount.accessToken) {
      guideDraftAccount.refreshToken = '';
      guideDraftAccount.accessToken = '';
      guideDraftAccount.tokenTime = 0;
    }
  });

  // 任务清单栏的快捷编辑当前账号按钮
  document.getElementById('btn-edit-current-account-header')?.addEventListener('click', () => {
    const targetId = selectedAccountId !== 'all' ? selectedAccountId : (currentConfig?.accounts?.[0]?.id || null);
    if (targetId) openQuickAddAccountModal(targetId);
  });
  document.getElementById('btn-quick-clear-cookie')?.addEventListener('click', async () => {
    const ok = await showWebConfirm('确定要清空该账号保存的 Cookie 吗？保存后生效。', '清空 Cookie 确认');
    if (!ok) return;
    quickAddCookieCleared = true;
    const cookieInput = document.getElementById('quick-add-cookie');
    if (cookieInput) {
      cookieInput.value = '（已标记清空，保存后生效）';
      cookieInput.disabled = true;
    }
    const clearBtn = document.getElementById('btn-quick-clear-cookie');
    if (clearBtn) clearBtn.style.display = 'none';
  });

  // 任务列表标题旁的刷新当前账号进度按钮
  document.getElementById('btn-sync-current-account')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-sync-current-account');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> 同步中...';
    const targetId = selectedAccountId !== 'all' ? selectedAccountId : null;
    const targetName = targetId
      ? (currentConfig?.accounts?.find(a => a.id === targetId)?.name || targetId)
      : '全部账号汇总';
    openEpicActionModal(
      `刷新账号进度 · ${targetName}`,
      '正在从微软官网拉取真实任务进度...',
      ['锁定账号上下文', '请求微软官网数据', '解析任务与积分', '刷新控制台看板'],
      0
    );
    startActionProgressTicker(12, 88, 8, '正在从微软官网拉取真实任务进度...');
    try {
      const res = await fetch('/api/status/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: targetId, force: true })
      }).then(r => r.json());
      stopActionProgressTicker();
      if (res.success) {
        currentStatus = res.data;
        renderDashboard(res.data);
        if (res.skipped) {
          updateEpicActionModal({
            progress: 100,
            badge: { text: '已跳过', cls: 'warn' },
            message: res.message || '任务正在执行中，已跳过同步',
            result: '为避免多账号上下文串台，本次同步已安全跳过。可等待当前任务结束后再刷新。'
          });
        } else {
          updateEpicActionModal({
            activeIndex: 4,
            progress: 100,
            badge: { text: '同步完成', cls: 'ok' },
            message: '微软官网真实进度已同步',
            result: buildMicrosoftStatusDetails(res.data)
          });
        }
      } else {
        updateEpicActionModal({
          progress: 100,
          badge: { text: '同步失败', cls: 'err' },
          message: res.message || '同步失败',
          result: `失败原因：${res.message || '未知错误'}`
        });
      }
    } catch (e) {
      stopActionProgressTicker();
      updateEpicActionModal({
        progress: 100,
        badge: { text: '同步异常', cls: 'err' },
        message: e.message,
        result: `同步异常：${e.message}`
      });
    } finally {
      btn.innerHTML = origHtml;
    }
  });

  // 配置中心 Modal
  document.getElementById('btn-settings').addEventListener('click', () => {
    const saveStatus = document.getElementById('settings-save-status');
    if (saveStatus) {
      saveStatus.className = 'settings-save-status';
      saveStatus.textContent = '';
    }
    populateSettingsForm();
    fetchBrowserRuntimeStatus();
    openModal('settings-modal');
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('btn-cancel-settings').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('btn-save-settings').addEventListener('click', saveSettingsFromModal);
  document.getElementById('btn-test-notify-proxy')?.addEventListener('click', () => {
    window.testNotifyProxy();
  });
  document.getElementById('btn-check-telegram')?.addEventListener('click', () => {
    window.checkTelegramConnection();
  });

  // 配置中心：切换账号编辑
  document.getElementById('cfg-account-select')?.addEventListener('change', (e) => {
    editingAccountIdInModal = e.target.value;
    loadAccountIntoForm(editingAccountIdInModal);
  });
  document.getElementById('btn-modal-add-acc')?.addEventListener('click', () => {
    closeModal('settings-modal');
    openQuickAddAccountModal();
  });
  document.getElementById('btn-modal-del-acc')?.addEventListener('click', handleDeleteCurrentAccountInModal);
  document.getElementById('cfg-account-proxy-mode')?.addEventListener('change', () => {
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
  });
  document.getElementById('cfg-account-proxy-id')?.addEventListener('change', (e) => {
    updateAccountProxyControls(e.target.value);
  });
  document.getElementById('cfg-use-proxy')?.addEventListener('change', () => {
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
  });
  document.getElementById('cfg-global-direct')?.addEventListener('change', () => {
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
  });
  document.getElementById('cfg-default-proxy')?.addEventListener('change', (e) => {
    const selectedId = e.target.value;
    document.querySelectorAll('#proxy-list .proxy-card').forEach(card => {
      const isDefault = card.getAttribute('data-proxy-id') === selectedId;
      card.classList.toggle('is-default', isDefault);
      const badge = card.querySelector('.proxy-default-badge');
      if (isDefault && !badge) {
        const span = document.createElement('span');
        span.className = 'proxy-default-badge';
        span.textContent = '全局默认';
        card.querySelector('.proxy-card-head')?.appendChild(span);
      } else if (!isDefault && badge) {
        badge.remove();
      }
    });
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
  });
  document.getElementById('btn-add-proxy')?.addEventListener('click', () => {
    collectProxyDraftsFromDom();
    const id = `draft_proxy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    proxyDrafts.push({
      id,
      name: `代理 ${proxyDrafts.length + 1}`,
      url: ''
    });
    const defaultId = getDefaultProxyId() || id;
    renderProxyCards(defaultId);
    renderDefaultProxyOptions(defaultId);
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
    const newCard = document.querySelector(`#proxy-list .proxy-card[data-proxy-id="${id}"]`);
    newCard?.querySelector('[data-proxy-field="url"]')?.focus();
  });
  document.getElementById('proxy-list')?.addEventListener('input', (e) => {
    const card = e.target.closest?.('.proxy-card');
    if (!card) return;
    const id = card.getAttribute('data-proxy-id');
    const draft = proxyDrafts.find(item => item.id === id);
    if (!draft) return;
    const field = e.target.getAttribute('data-proxy-field');
    if (field === 'name' || field === 'url') draft[field] = e.target.value;
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
  });
  document.getElementById('proxy-list')?.addEventListener('click', async (e) => {
    const button = e.target.closest?.('[data-proxy-action]');
    if (!button) return;
    const card = button.closest('.proxy-card');
    const proxyId = card?.getAttribute('data-proxy-id');
    if (!proxyId) return;
    const action = button.getAttribute('data-proxy-action');
    if (action === 'test') await testProxyCard(proxyId);
    if (action === 'save') await saveProxySettingsFromCards();
    if (action === 'delete') await deleteProxyCard(proxyId);
  });

  // 向导换取 Token
  document.getElementById('guide-btn-exchange').addEventListener('click', async () => {
    const input = document.getElementById('guide-code-input').value.trim();
    const resultDiv = document.getElementById('guide-token-result');
    const proxySelection = readProxySelection('guide-account-proxy-mode', 'guide-account-proxy-id');
    if (!guideNetworkConfirmed) {
      resultDiv.innerHTML = '<span style="color:#EF4444;">请先返回第一步保存网络出口。</span>';
      return;
    }
    if (!input) {
      resultDiv.innerHTML = '<span style="color:#EF4444;">请先填入地址栏跳转后的完整 URL</span>';
      return;
    }
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在换取并验证 Token...</span>';
    try {
      guideDraftAccount.authCodeUrl = input;
      // 同步第一步填写的名称与序号，新建账号时一并写入
      guideDraftAccount.name = document.getElementById('guide-account-name')?.value.trim() || guideDraftAccount.name;
      guideDraftAccount.order = parseInt(document.getElementById('guide-account-order')?.value, 10) || guideDraftAccount.order;
      const res = await fetch('/api/auth/exchange-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urlOrCode: input,
          accountId: guideDraftAccount.id,
          name: guideDraftAccount.name,
          order: guideDraftAccount.order,
          draft: true,
          proxy: proxySelection
        })
      }).then(r => r.json());
      if (res.success) {
        guideDraftAccount.accessToken = res.data.accessToken;
        guideDraftAccount.refreshToken = res.data.refreshToken;
        guideDraftAccount.tokenTime = Date.now();
        resultDiv.innerHTML = '<span style="color:#34D399;">✅ Token 换取成功！已绑定至新账号草稿</span>';
      } else {
        resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 换取失败: ${escapeHtml(res.message)}</span>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 请求异常: ${escapeHtml(e.message)}</span>`;
    }
  });

  // 向导测试 Cookie
  document.getElementById('guide-btn-test-cookie').addEventListener('click', async () => {
    const cookie = document.getElementById('guide-cookie-input').value.trim();
    const resultDiv = document.getElementById('guide-cookie-result');
    const proxySelection = readProxySelection('guide-account-proxy-mode', 'guide-account-proxy-id');
    if (!guideNetworkConfirmed) {
      resultDiv.innerHTML = '<span style="color:#EF4444;">请先返回第一步保存网络出口。</span>';
      return;
    }
    if (!cookie) {
      resultDiv.innerHTML = '<span style="color:#EF4444;">请先粘贴 Cookie</span>';
      return;
    }
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在请求微软官网验证 Cookie...</span>';
    try {
      guideDraftAccount.cookie = cookie;
      const testRes = await fetch('/api/auth/test-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie, accountId: guideDraftAccount.id, proxy: proxySelection })
      }).then(r => r.json());
      if (testRes.success && testRes.data?.valid) {
        resultDiv.innerHTML = `<span style="color:#34D399;">✅ ${escapeHtml(testRes.data.message)}</span>`;
      } else {
        resultDiv.innerHTML = `<span style="color:#EF4444;">❌ ${escapeHtml(testRes.data?.message || testRes.message || 'Cookie 检测无效')}</span>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 检测请求出错: ${escapeHtml(e.message)}</span>`;
    }
  });

  // 向导测试代理与 IP
  document.getElementById('guide-btn-test-proxy').addEventListener('click', async () => {
    const target = resolveGuideProxyTestTarget();
    const resultDiv = document.getElementById('guide-proxy-result');
    if (target.error) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">${escapeHtml(target.error)}</span>`;
      return;
    }
    resultDiv.innerHTML = `<span style="color:#38BDF8;">⏳ 正在检测 ${escapeHtml(target.label)} 的出口 IP 与归属地...</span>`;
    try {
      const res = await fetch('/api/proxy/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useProxy: target.useProxy, proxyUrl: target.proxyUrl })
      }).then(r => r.json());
      if (res.success) {
        if (res.regionPass) {
          resultDiv.innerHTML = `<span style="color:#34D399;">✅ ${escapeHtml(target.label)} 检测通过，当前出口位于中国大陆 (${escapeHtml(res.region)})<br>${escapeHtml(res.ipInfo)}</span>`;
        } else {
          resultDiv.innerHTML = `<span style="color:#F59E0B;">⚠️ ${escapeHtml(target.label)} 当前出口为非大陆地区 (${escapeHtml(res.region)})！若开启国区保护任务将被自动暂停。<br>${escapeHtml(res.ipInfo)}</span>`;
        }
      } else {
        resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 测试失败: ${escapeHtml(res.message)}</span>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 测试异常: ${escapeHtml(e.message)}</span>`;
    }
  });

  // 清空日志：只清空当前页面显示（设置本地时间戳过滤），
  // 后端内存日志与 data/app.log 文件均保留，新日志照常继续显示。
  document.getElementById('btn-clear-logs').addEventListener('click', () => {
    logViewSince = Date.now();
    renderLogs();
  });

  // 配置中心：一键换取/刷新 Token
  document.getElementById('btn-exchange-token')?.addEventListener('click', async () => {
    const input = document.getElementById('cfg-authcode').value.trim();
    const resDiv = document.getElementById('cfg-auth-test-result');
    if (input === SECRET_CLEAR) {
      if (resDiv) resDiv.innerHTML = '<span style="color:#F59E0B;">凭据已标记清空，请先保存配置或重新粘贴授权码后再换取 Token。</span>';
      return;
    }
    if (!input) {
      if (resDiv) resDiv.innerHTML = '<span style="color:#EF4444;">请先在输入框中粘贴包含 code= 的跳转链接</span>';
      openEpicActionModal('缺少授权码', '请先填入包含 code 的链接或授权码。', ['填写授权码', '重新换取 Token'], 0);
      updateEpicActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
      return;
    }
    if (resDiv) resDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在向微软官方请求兑换 OAuth Token...</span>';
    const targetId = editingAccountIdInModal || 'acc_1';
    const res = await fetch('/api/auth/exchange-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urlOrCode: input,
        accountId: targetId,
        proxy: readProxySelection('cfg-account-proxy-mode', 'cfg-account-proxy-id')
      })
    }).then(r => r.json());
    if (res.success) {
      if (resDiv) resDiv.innerHTML = '<span style="color:#34D399;">✅ Token 换取并自动保存成功！</span>';
      const refreshEl = document.getElementById('cfg-refresh-token');
      if (refreshEl) {
        refreshEl.value = '********';
        delete refreshEl.dataset.clear;
      }
      document.getElementById('cfg-authcode').placeholder = '已配置授权码（内容已隐藏）';
      document.getElementById('cfg-authcode').value = '';
      fetchConfig();
      fetchStatus();
    } else {
      if (resDiv) resDiv.innerHTML = `<span style="color:#EF4444;">❌ 换取失败: ${escapeHtml(res.message)}</span>`;
    }
  });

  // 配置中心：单独测试已输入或已配置的 Cookie
  document.getElementById('btn-test-modal-cookie')?.addEventListener('click', async () => {
    const input = document.getElementById('cfg-cookie').value.trim();
    const resDiv = document.getElementById('cfg-cookie-test-result');
    const targetId = editingAccountIdInModal || 'acc_1';
    if (input === SECRET_CLEAR) {
      if (resDiv) resDiv.innerHTML = '<span style="color:#F59E0B;">Cookie 已标记清空，请先保存配置或重新粘贴后再测试。</span>';
      return;
    }
    if (resDiv) resDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在请求微软官网验证 Cookie 有效性...</span>';
    try {
      const testRes = await fetch('/api/auth/test-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cookie: input || SECRET_PLACEHOLDER,
          accountId: targetId,
          proxy: readProxySelection('cfg-account-proxy-mode', 'cfg-account-proxy-id')
        })
      }).then(r => r.json());
      if (testRes.success && testRes.data?.valid) {
        if (resDiv) resDiv.innerHTML = `<span style="color:#34D399;">✅ ${escapeHtml(testRes.data.message)}</span>`;
      } else {
        if (resDiv) resDiv.innerHTML = `<span style="color:#EF4444;">❌ ${escapeHtml(testRes.data?.message || testRes.message || 'Cookie 检测无效')}</span>`;
      }
    } catch (e) {
      if (resDiv) resDiv.innerHTML = `<span style="color:#EF4444;">❌ 检测异常: ${escapeHtml(e.message)}</span>`;
    }
  });

  // 配置中心：使用当前账号代理测试 Token；若填入了新授权码则先换取再测试
  document.getElementById('btn-test-modal-token')?.addEventListener('click', async () => {
    const targetId = editingAccountIdInModal || 'acc_1';
    const input = document.getElementById('cfg-authcode')?.value.trim() || '';
    const result = document.getElementById('cfg-auth-test-result');
    const proxy = readProxySelection('cfg-account-proxy-mode', 'cfg-account-proxy-id');
    if (input === SECRET_CLEAR) {
      if (result) result.innerHTML = '<span style="color:#F59E0B;">凭据已标记清空，请先重新粘贴授权码后再测试。</span>';
      return;
    }
    try {
      if (input) {
        if (result) result.innerHTML = '<span style="color:#38BDF8;">⏳ 正在使用当前账号代理换取 Token...</span>';
        const exchangeRes = await fetch('/api/auth/exchange-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urlOrCode: input, accountId: targetId, proxy })
        }).then(r => r.json());
        if (!exchangeRes.success) {
          if (result) result.innerHTML = `<span style="color:#EF4444;">❌ Token 换取失败: ${escapeHtml(exchangeRes.message)}</span>`;
          return;
        }
        const authInput = document.getElementById('cfg-authcode');
        if (authInput) {
          authInput.value = '';
          authInput.placeholder = '已配置授权码（内容已隐藏）';
        }
        const refreshEl = document.getElementById('cfg-refresh-token');
        if (refreshEl) {
          refreshEl.value = '********';
          delete refreshEl.dataset.clear;
        }
      }
      if (result) result.innerHTML = '<span style="color:#38BDF8;">⏳ 正在使用当前账号代理测试 Token...</span>';
      const testRes = await fetch('/api/auth/test-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: targetId, proxy })
      }).then(r => r.json());
      if (testRes.success && testRes.data?.valid) {
        if (result) result.innerHTML = `<span style="color:#34D399;">✅ ${escapeHtml(testRes.data.message)}</span>`;
      } else {
        if (result) result.innerHTML = `<span style="color:#EF4444;">❌ ${escapeHtml(testRes.data?.message || testRes.message || 'Token 检测无效')}</span>`;
      }
      if (input) {
        fetchConfig();
        fetchStatus();
      }
    } catch (e) {
      if (result) result.innerHTML = `<span style="color:#EF4444;">❌ 检测异常: ${escapeHtml(e.message)}</span>`;
    }
  });

  // 配置中心：清空该账号保存的 Cookie
  document.getElementById('btn-clear-modal-cookie')?.addEventListener('click', async () => {
    const ok = await showWebConfirm('确定要清空该账号保存的 Cookie 吗？保存配置后生效。', '清空 Cookie');
    if (!ok) return;
    const input = document.getElementById('cfg-cookie');
    input.value = SECRET_CLEAR;
    input.placeholder = '已标记清空（点击下方保存配置后生效）';
    const resDiv = document.getElementById('cfg-cookie-test-result');
    if (resDiv) resDiv.innerHTML = '<span style="color:#F59E0B;">⚠️ 已标记清空，请点击弹窗底部「保存配置」使变更落盘</span>';
  });

  // 配置中心：清空该账号保存的授权码与 Token
  document.getElementById('btn-clear-modal-auth')?.addEventListener('click', async () => {
    const ok = await showWebConfirm('确定要清空该账号保存的移动端授权码与 Token 吗？保存配置后生效。', '清空移动端凭据');
    if (!ok) return;
    const input = document.getElementById('cfg-authcode');
    input.value = SECRET_CLEAR;
    input.placeholder = '已标记清空（点击下方保存配置后生效）';
    const refreshEl = document.getElementById('cfg-refresh-token');
    if (refreshEl) {
      refreshEl.value = '';
      refreshEl.dataset.clear = '1';
    }
    const resDiv = document.getElementById('cfg-auth-test-result');
    if (resDiv) resDiv.innerHTML = '<span style="color:#F59E0B;">⚠️ 已标记清空，请点击弹窗底部「保存配置」使变更落盘</span>';
  });

  // 全局点击关闭卡片操作菜单
  document.addEventListener('click', () => {
    document.querySelectorAll('.acc-more-dropdown.show').forEach(m => m.classList.remove('show'));
  });

  // 汇总表一键领取全部账号的待领积分
  document.getElementById('btn-summary-claim-all')?.addEventListener('click', (event) => {
    claimSummaryPendingPoints({
      accountId: 'all',
      accountName: '全部账号',
      trigger: event.currentTarget
    });
  });

  const summaryTbody = document.getElementById('account-summary-tbody');
  summaryTbody?.addEventListener('click', (event) => {
    const claimTarget = event.target.closest('[data-claim-points]');
    if (claimTarget) {
      event.preventDefault();
      event.stopPropagation();
      claimSummaryPendingPoints({
        accountId: claimTarget.dataset.claimPoints,
        accountName: claimTarget.dataset.claimName || claimTarget.dataset.claimPoints,
        claimable: Number(claimTarget.dataset.claimValue || 0),
        trigger: claimTarget,
        confirm: true
      });
      return;
    }
    const row = event.target.closest('tr[data-account-id]');
    if (!row) return;
    openAccountDetailFromSummary(row.getAttribute('data-account-id'));
  });
  summaryTbody?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const claimTarget = event.target.closest('[data-claim-points]');
    if (claimTarget) {
      event.preventDefault();
      event.stopPropagation();
      claimSummaryPendingPoints({
        accountId: claimTarget.dataset.claimPoints,
        accountName: claimTarget.dataset.claimName || claimTarget.dataset.claimPoints,
        claimable: Number(claimTarget.dataset.claimValue || 0),
        trigger: claimTarget,
        confirm: true
      });
      return;
    }
    const row = event.target.closest('tr[data-account-id]');
    if (!row) return;
    event.preventDefault();
    openAccountDetailFromSummary(row.getAttribute('data-account-id'));
  });
  summaryTbody?.addEventListener('mouseover', (event) => {
    const cell = event.target.closest('[data-trend-account]');
    if (!cell || cell.contains(event.relatedTarget)) return;
    cancelAccountTrendHide();
    showAccountTrendTooltip(cell);
  });
  summaryTbody?.addEventListener('mouseout', (event) => {
    const cell = event.target.closest('[data-trend-account]');
    if (!cell || cell.contains(event.relatedTarget)) return;
    const tooltip = document.getElementById('account-trend-tooltip');
    if (tooltip?.contains(event.relatedTarget)) return;
    scheduleAccountTrendHide();
  });
  const trendTooltip = document.getElementById('account-trend-tooltip');
  trendTooltip?.addEventListener('mouseenter', cancelAccountTrendHide);
  trendTooltip?.addEventListener('mouseleave', () => hideAccountTrendTooltip());
  const trendChart = document.getElementById('account-trend-chart');
  trendChart?.addEventListener('mousemove', handleAccountTrendPointerMove);
  trendChart?.addEventListener('mouseleave', resetAccountTrendCrosshair);
  trendTooltip?.addEventListener('focusout', (event) => {
    if (!trendTooltip.contains(event.relatedTarget)) scheduleAccountTrendHide();
  });
  window.addEventListener('scroll', () => hideAccountTrendTooltip(), { passive: true });
  window.addEventListener('resize', () => hideAccountTrendTooltip());
  initAccountSummaryColumnResize();

  // 配置中心：测试当前账号 (详细展示 Cookie、Code、Token 是否可用)
  document.getElementById('btn-test-account')?.addEventListener('click', async () => {
    const resultDiv = document.getElementById('test-account-result');
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在全面测试当前账号凭据可用性...</span>';
    const targetId = editingAccountIdInModal || 'acc_1';
    const res = await fetch('/api/auth/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: targetId,
        force: true,
        proxy: readProxySelection('cfg-account-proxy-mode', 'cfg-account-proxy-id')
      })
    }).then(r => r.json());
    if (res.success) {
      const c = res.data.cookie;
      const code = res.data.code;
      const t = res.data.token;
      const net = res.data.network;
      const proxyLabel = net?.proxyUsed
        ? `代理：${escapeHtml(net?.proxy?.name || '指定代理')}`
        : '直连（未使用代理）';
      resultDiv.innerHTML = `
        <div style="background:var(--card-inner); padding:10px 14px; border-radius:10px; border:1px solid var(--border-color); display:flex; flex-direction:column; gap:8px; margin-top:8px;">
          <div><strong>1. 必应网页端 Cookie:</strong> ${c?.valid ? '<span style="color:#34D399; font-weight:700;">✅ 可用</span>' : '<span style="color:#F87171; font-weight:700;">❌ 不可用或失效</span>'} <small style="color:var(--text-sub);">(${escapeHtml(c?.message || '')})</small></div>
          <div><strong>2. 授权码链接 Code:</strong> ${code?.valid ? '<span style="color:#34D399; font-weight:700;">✅ 可用</span>' : '<span style="color:#F59E0B; font-weight:700;">⚠️ 待配置</span>'} <small style="color:var(--text-sub);">(${escapeHtml(code?.message || '')})</small></div>
          <div><strong>3. 移动端 OAuth Token:</strong> ${t?.valid ? '<span style="color:#34D399; font-weight:700;">✅ 可用</span>' : '<span style="color:#F87171; font-weight:700;">❌ 不可用或失效</span>'} <small style="color:var(--text-sub);">(${escapeHtml(t?.message || '')})</small></div>
          <div><strong>4. 当前访问 IP:</strong> <span style="color:#38BDF8; font-weight:700; font-family:ui-monospace,monospace;">${escapeHtml(net?.ip || '未知')}</span> <small style="color:var(--text-sub);">${escapeHtml(net?.location || '归属地未知')}</small></div>
          <div><strong>5. 网络出口:</strong> ${net?.regionPass ? '<span style="color:#34D399; font-weight:700;">✅ 中国大陆 (安全通过)</span>' : '<span style="color:#F59E0B; font-weight:700;">⚠️ 非大陆或地区未知</span>'} <small style="color:var(--text-sub);">${proxyLabel}</small></div>
        </div>
      `;
      fetchStatus();
    } else {
      resultDiv.innerHTML = `<span style="color:#F87171;">测试出错: ${escapeHtml(res.message || '')}</span>`;
    }
  });

  // 配置中心：测试全局默认出口（账号专用代理在各自卡片中测试）
  document.getElementById('btn-test-default-network')?.addEventListener('click', async () => {
    const drafts = collectProxyDraftsFromDom();
    const proxyId = getDefaultProxyId();
    const proxy = drafts.find(item => item.id === proxyId);
    const useProxy = isGlobalProxyEnabled();
    const resultDiv = document.getElementById('test-default-proxy-result');
    if (useProxy && !proxy?.url) {
      resultDiv.innerHTML = '<span style="color:#F59E0B;">请先添加并选择一个全局默认代理。</span>';
      return;
    }
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在测试全局默认出口...</span>';
    const res = await fetch('/api/proxy/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useProxy, proxyUrl: proxy?.url || '' })
    }).then(r => r.json());
    if (res.success) {
      resultDiv.innerHTML = `<div>${escapeHtml(res.ipInfo)}</div><div>地区检测: ${res.regionPass ? '✅ 通过 (' + escapeHtml(res.region) + ')' : '⚠️ 非国区 (' + escapeHtml(res.region || '未知') + ')'} · ${Number(res.latencyMs || 0)} ms</div>`;
    } else {
      resultDiv.innerHTML = `<div style="color:#EF4444;">测试失败: ${escapeHtml(res.message)}</div>`;
    }
  });

  // 配置中心 Tabs 切换
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      document.getElementById(targetId)?.classList.add('active');
    });
  });

  // 向导 Steps 切换
  document.querySelectorAll('.step-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const step = item.getAttribute('data-step');
      switchStep(step);
    });
  });

  // 凭据输入框的显示 / 隐藏切换
  initSecretToggles();
  document.getElementById('cfg-cookie')?.addEventListener('input', updateCookieHint);

  // 账号体检范围（单个 / 全部）
  document.querySelectorAll('#diag-scope-group .diag-scope-btn').forEach(btn => {
    btn.addEventListener('click', () => setDiagMode(btn.getAttribute('data-mode')));
  });
  document.getElementById('diag-account-select')?.addEventListener('change', (e) => {
    diagAccountId = e.target.value;
  });

  // 搜索节奏：输入时实时刷新预估执行时间与 40 分钟搜索预算校验
  document.getElementById('cfg-search-interval')?.addEventListener('input', updateSearchRhythmHint);
  document.getElementById('cfg-search-jitter')?.addEventListener('input', updateSearchRhythmHint);

  // 顶层功能选项卡切换（微软积分 / Epic 游戏 / 施工中）
  document.querySelectorAll('#app-tabs .app-tab').forEach(btn => {
    btn.addEventListener('click', () => switchAppTab(btn.getAttribute('data-tab')));
  });
  initEpicUI();
  initLogsModal();
  switchAppTab(localStorage.getItem('ms_rewards_app_tab') || 'ms', false);
}

// 切换顶层选项卡：同一时刻只显示一个面板
function switchAppTab(tab, persist = true) {
  const target = ['ms', 'epic', 'wip'].includes(tab) ? tab : 'ms';
  document.querySelectorAll('#app-tabs .app-tab').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === target);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-panel-${target}`);
  });
  if (persist) localStorage.setItem('ms_rewards_app_tab', target);
  hideInstantTooltip();
  // 切到 Epic 时按需加载数据
  if (target === 'epic') refreshEpicTab();
}

function initSecretToggles() {
  document.querySelectorAll('.secret-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.getAttribute('data-target'));
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
      btn.title = show ? '隐藏内容' : '显示内容';
    });
  });
}

// Cookie 提示文案：只暴露「是否已配置」，不暴露内容与长度
function updateCookieHint(hasStoredSecret = null) {
  const hint = document.getElementById('cfg-cookie-hint');
  const input = document.getElementById('cfg-cookie');
  if (!hint || !input) return;
  const hasValue = !!input.value.trim();
  const stored = hasStoredSecret === null
    ? !!currentConfig?.accounts?.find(a => a.id === editingAccountIdInModal)?.hasCookie
    : hasStoredSecret;
  if (hasValue) {
    hint.textContent = '⚠️ Cookie 已修改但尚未保存，保存后生效';
    hint.style.color = '#F59E0B';
  } else if (stored) {
    hint.textContent = '✅ 已配置 Cookie（内容已隐藏，点击右侧眼睛按钮可查看或重新粘贴）';
    hint.style.color = '#34D399';
  } else {
    hint.textContent = 'PC 搜索、每日活动集与桌面任务必备；内容默认隐藏，不会明文展示';
    hint.style.color = '';
  }
}

function switchStep(stepNum, options = {}) {
  const targetStep = Number(stepNum);
  const guideVisible = document.getElementById('guide-modal')?.classList.contains('show');
  if (guideVisible && targetStep >= 2 && !guideNetworkConfirmed && options.force !== true) {
    const result = document.getElementById('guide-proxy-result');
    if (result) {
      result.innerHTML = '<span style="color:#F59E0B;">请先保存网络出口，再继续绑定 Cookie 或 Token，避免真实会话提前从错误 IP 发出。</span>';
    }
    return false;
  }
  document.querySelectorAll('.step-nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.step-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`.step-nav-item[data-step="${stepNum}"]`)?.classList.add('active');
  document.getElementById(`step-${stepNum}`)?.classList.add('active');
  return true;
}

function openModal(id) {
  document.getElementById(id)?.classList.add('show');
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove('show');
}

function setNovncStatus(text = '', tone = '') {
  const el = document.getElementById('novnc-status-text');
  if (!el) return;
  el.className = `hint-msg${tone ? ` ${tone}` : ''}`;
  el.textContent = text;
}

function isVncAutoCloseEnabled() {
  return localStorage.getItem(VNC_AUTO_CLOSE_KEY) === 'true';
}

function setVncAutoCloseEnabled(val) {
  localStorage.setItem(VNC_AUTO_CLOSE_KEY, val ? 'true' : 'false');
}

function openNovncModal(title = 'Epic 可见浏览器', { showSave = false, mode = 'epic', onSuccess = null } = {}) {
  novncMode = mode;
  microsoftVncSuccessHandler = onSuccess;
  const titleEl = document.getElementById('novnc-modal-title');
  if (titleEl) titleEl.innerText = title;
  const saveBtn = document.getElementById('btn-novnc-save-login');
  if (saveBtn) {
    saveBtn.style.display = showSave ? 'inline-flex' : 'none';
    saveBtn.innerText = mode === 'microsoft' ? '✅ 检测并保存 Cookie + Token' : '✅ 我已登录，保存凭据';
  }
  const cancelBtn = document.getElementById('btn-cancel-novnc-session');
  if (cancelBtn) cancelBtn.style.display = mode === 'microsoft' ? 'inline-flex' : 'none';
  const autoCloseLbl = document.getElementById('lbl-novnc-auto-close');
  const autoCloseChk = document.getElementById('chk-novnc-auto-close');
  if (autoCloseLbl && autoCloseChk) {
    if (mode === 'microsoft') {
      autoCloseLbl.style.display = 'inline-flex';
      autoCloseChk.checked = isVncAutoCloseEnabled();
    } else {
      autoCloseLbl.style.display = 'none';
    }
  }
  const frame = document.getElementById('novnc-frame');
  if (frame) {
    const base = `${location.origin}/novnc/vnc.html`;
    frame.src = `${base}?autoconnect=1&resize=scale&path=websockify&reconnect=1&reconnect_delay=1000&t=${Date.now()}`;
  }
  openModal('novnc-modal');
}

function refreshNovncModal() {
  const frame = document.getElementById('novnc-frame');
  if (!frame) return;
  const current = frame.src || `${location.origin}/novnc/vnc.html`;
  const base = current.split('?')[0];
  frame.src = `${base}?autoconnect=1&resize=scale&path=websockify&reconnect=1&reconnect_delay=1000&t=${Date.now()}`;
}

function toggleNovncMaximize() {
  const box = document.querySelector('#novnc-modal .novnc-modal-box');
  if (!box) return;
  box.classList.toggle('novnc-maximized');
  const button = document.getElementById('btn-maximize-novnc');
  if (button) button.innerText = box.classList.contains('novnc-maximized') ? '⛶ 还原' : '⛶ 放大';
}

function closeNovncModal() {
  stopMicrosoftVncPolling();
  const frame = document.getElementById('novnc-frame');
  if (frame) frame.src = 'about:blank';
  const saveBtn = document.getElementById('btn-novnc-save-login');
  if (saveBtn) saveBtn.style.display = 'none';
  const cancelBtn = document.getElementById('btn-cancel-novnc-session');
  if (cancelBtn) cancelBtn.style.display = 'none';
  const autoCloseLbl = document.getElementById('lbl-novnc-auto-close');
  if (autoCloseLbl) autoCloseLbl.style.display = 'none';
  setNovncStatus('');
  closeModal('novnc-modal');
  novncMode = 'epic';
  microsoftVncSuccessHandler = null;
  microsoftVncCaptureInFlight = false;
  microsoftVncAutoCaptureTriggered = false;
  latestMicrosoftVncData = null;
}

function stopMicrosoftVncPolling() {
  microsoftVncPollingActive = false;
  if (microsoftVncStatusTimer) {
    clearTimeout(microsoftVncStatusTimer);
    microsoftVncStatusTimer = null;
  }
}

async function closeMicrosoftVncSession() {
  stopMicrosoftVncPolling();
  try {
    const res = await fetch('/api/auth/login-window/close', { method: 'POST' }).then(r => r.json()).catch(() => ({}));
    const savedData = res.data?.data || res.data?.lastResult || res.data || latestMicrosoftVncData;
    if (savedData && (savedData.cookie || savedData.refreshToken)) {
      if (microsoftVncSuccessHandler) await microsoftVncSuccessHandler(savedData);
    }
  } catch {}
  closeNovncModal();
}

async function pollMicrosoftLoginStatus() {
  if (novncMode !== 'microsoft') return;
  microsoftVncPollingActive = true;
  try {
    const res = await fetch('/api/auth/login-window/status').then(r => r.json());
    const data = res.data || {};
    if (!data.open) {
      if (data.phase === 'closed' && data.message) setNovncStatus(data.message);
      stopMicrosoftVncPolling();
      return;
    }
    const statusText = data.message || (data.phase === 'waiting_login'
      ? '请在 VNC 中完成微软登录'
      : data.phase === 'navigating_rewards'
        ? '已登录，正在打开 Bing Rewards...'
      : data.phase === 'capturing'
        ? '正在自动抓取 Cookie 与 Token...'
        : '登录窗口已就绪');
    setNovncStatus(statusText, data.phase === 'logged_in' ? 'ok' : '');
    if (data.phase === 'logged_in' && !microsoftVncAutoCaptureTriggered) {
      microsoftVncAutoCaptureTriggered = true;
      captureMicrosoftLoginWindow().catch(() => {});
    } else if (data.phase === 'ready' && latestMicrosoftVncData) {
      setNovncStatus(`🎉 Cookie 与 Token 已成功获取（用户：${latestMicrosoftVncData.detectedName || data.detectedName || '已登录'}）！已自动保存。您可以继续在此浏览器中浏览或操作设置，完成后点击「保存并关闭」或关闭小窗生效。`, 'ok');
      const saveBtn = document.getElementById('btn-novnc-save-login');
      if (saveBtn) {
        saveBtn.style.display = 'inline-flex';
        saveBtn.innerText = '💾 保存并关闭小窗';
        saveBtn.className = 'btn btn-primary';
      }
    }
  } catch (e) {
    setNovncStatus(`状态检测失败：${e.message}`);
  } finally {
    if (novncMode === 'microsoft' && microsoftVncPollingActive) {
      microsoftVncStatusTimer = setTimeout(pollMicrosoftLoginStatus, 2000);
    }
  }
}

async function captureMicrosoftLoginWindow() {
  if (microsoftVncCaptureInFlight || novncMode !== 'microsoft') return;
  microsoftVncCaptureInFlight = true;
  const autoClose = isVncAutoCloseEnabled();
  setNovncStatus('正在确认登录、抓取 Cookie 并换取 Token，请稍候...');
  try {
    const res = await fetch('/api/auth/login-window/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoClose })
    }).then(r => r.json());
    if (res.success && res.data?.success) {
      const data = res.data;
      latestMicrosoftVncData = data;
      if (microsoftVncSuccessHandler) await microsoftVncSuccessHandler(data);
      if (autoClose) {
        setNovncStatus('Cookie 与 Token 已获取，正在保存并关闭窗口...', 'ok');
        await closeMicrosoftVncSession();
        return;
      }
      setNovncStatus(`🎉 微软 Cookie 与 Token 已成功获取（用户：${data.detectedName || '已登录'}）！已自动保存。您可以继续在此浏览器中浏览或操作设置，完成后点击「保存并关闭」或关闭小窗即可生效。`, 'ok');
      const saveBtn = document.getElementById('btn-novnc-save-login');
      if (saveBtn) {
        saveBtn.style.display = 'inline-flex';
        saveBtn.innerText = '💾 保存并关闭小窗';
        saveBtn.className = 'btn btn-primary';
      }
      return;
    }
    if (res.partial || res.data?.partial) {
      const data = res.data?.data || res.data || {};
      latestMicrosoftVncData = data;
      if (microsoftVncSuccessHandler && data.cookie) {
        await microsoftVncSuccessHandler({
          partial: true,
          cookie: data.cookie,
          cookieStatus: data.cookieStatus,
          detectedName: data.detectedName,
          message: res.message || data.message
        });
      }
      if (autoClose) {
        setNovncStatus(res.message || data.message || 'Cookie 已获取，但 Token 自动获取失败', 'warn');
        await closeMicrosoftVncSession();
        return;
      }
      setNovncStatus(`⚠️ 微软 Cookie 已获取，但 Token 自动换取受阻。您可以继续在窗口中操作，完成后点击「保存并关闭」。`, 'warn');
      const saveBtn = document.getElementById('btn-novnc-save-login');
      if (saveBtn) {
        saveBtn.style.display = 'inline-flex';
        saveBtn.innerText = '💾 保存并关闭小窗';
      }
      return;
    }
    if (res.data?.waitingLogin) {
      microsoftVncAutoCaptureTriggered = false;
      setNovncStatus(res.message || '尚未检测到登录，请继续在 VNC 中完成登录', 'warn');
      return;
    }
    setNovncStatus(res.message || '自动抓取失败，请继续在 VNC 中完成登录或手动填写', 'warn');
  } catch (e) {
    setNovncStatus(`自动抓取异常：${e.message}`, 'err');
  } finally {
    microsoftVncCaptureInFlight = false;
  }
}

async function startMicrosoftVncLogin({ accountId = '', draftId = '', name = '', order = 0, proxy = null, title = '微软积分登录窗口', onSuccess = null } = {}) {
  stopMicrosoftVncPolling();
  microsoftVncCaptureInFlight = false;
  microsoftVncAutoCaptureTriggered = false;
  const res = await fetch('/api/auth/login-window/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, draftId, name, order, proxy })
  }).then(r => r.json());
  if (!res.success) throw new Error(res.message || '打开微软登录窗口失败');
  openNovncModal(title, {
    showSave: true,
    mode: 'microsoft',
    onSuccess
  });
  setNovncStatus(`登录窗口已打开，出口：${res.data?.proxy?.label || '未知'}。请在 VNC 中完成微软登录。`);
  pollMicrosoftLoginStatus();
  return res.data;
}

function getGuideCredentialMode() {
  return document.querySelector('input[name="guide-credential-mode"]:checked')?.value === 'manual'
    ? 'manual'
    : 'vnc';
}

function updateGuideCredentialMode() {
  const mode = getGuideCredentialMode();
  const vncBox = document.getElementById('guide-vnc-credential-box');
  const manualBox = document.getElementById('guide-manual-credential-box');
  const manualCookieBox = document.getElementById('guide-manual-cookie-box');
  const vncCookieBox = document.getElementById('guide-vnc-cookie-summary');
  if (vncBox) vncBox.style.display = mode === 'vnc' ? '' : 'none';
  if (manualBox) manualBox.style.display = mode === 'manual' ? '' : 'none';
  if (manualCookieBox) manualCookieBox.style.display = mode === 'manual' ? '' : 'none';
  if (vncCookieBox) vncCookieBox.style.display = mode === 'vnc' ? '' : 'none';
  const status = document.getElementById('guide-vnc-cookie-status');
  if (status && mode === 'vnc') {
    status.innerHTML = guideDraftAccount.cookie
      ? '✅ 已获取网页 Cookie。'
      : '<span style="color:var(--text-sub);">尚未获取 Cookie，请返回第二步打开内置浏览器登录。</span>';
  }
}

async function openGuideMicrosoftVnc() {
  const result = document.getElementById('guide-vnc-result');
  if (!guideNetworkConfirmed) {
    if (result) result.innerHTML = '<span style="color:#EF4444;">请先返回第一步保存网络出口。</span>';
    return;
  }
  const proxy = readProxySelection('guide-account-proxy-mode', 'guide-account-proxy-id');
  const name = document.getElementById('guide-account-name')?.value.trim() || guideDraftAccount.name;
  const order = parseInt(document.getElementById('guide-account-order')?.value, 10) || guideDraftAccount.order;
  if (result) result.innerHTML = '<span style="color:#38BDF8;">正在启动内置浏览器...</span>';
  try {
    await startMicrosoftVncLogin({
      draftId: guideDraftAccount.id,
      name,
      order,
      proxy,
      title: '微软积分登录向导',
      onSuccess: async data => {
        guideDraftAccount.cookie = data.cookie || guideDraftAccount.cookie;
        if (data.refreshToken && data.accessToken) {
          guideDraftAccount.refreshToken = data.refreshToken;
          guideDraftAccount.accessToken = data.accessToken;
          guideDraftAccount.tokenTime = data.tokenTime || Date.now();
          guideDraftAccount.authCodeUrl = '';
        } else if (data.partial) {
          guideDraftAccount.refreshToken = '';
          guideDraftAccount.accessToken = '';
          guideDraftAccount.tokenTime = 0;
        }
        const cookieInput = document.getElementById('guide-cookie-input');
        if (cookieInput && data.cookie) cookieInput.value = data.cookie;
        if (result) {
          result.innerHTML = data.partial
            ? `<span style="color:#F59E0B;">⚠️ ${escapeHtml(data.message || 'Cookie 已获取，Token 需手动授权')}</span>`
            : '<span style="color:#34D399;">✅ Cookie 与 Token 已自动获取，点击下一步保存账号。</span>';
        }
        updateGuideCredentialMode();
      }
    });
  } catch (e) {
    if (result) result.innerHTML = `<span style="color:#EF4444;">❌ ${escapeHtml(e.message)}</span>`;
  }
}

async function openQuickAddMicrosoftVnc() {
  const result = document.getElementById('quick-add-vnc-result');
  const name = document.getElementById('quick-add-name')?.value.trim() || '候选账号';
  const order = parseInt(document.getElementById('quick-add-order')?.value, 10) || 1;
  const proxy = readProxySelection('quick-add-proxy-mode', 'quick-add-proxy-id');
  const accountId = editingAccountIdInQuickModal || '';
  const draftId = accountId || `draft_${Date.now()}`;
  if (result) result.innerHTML = '<span style="color:#38BDF8;">正在启动内置浏览器...</span>';
  try {
    await startMicrosoftVncLogin({
      accountId,
      draftId,
      name,
      order,
      proxy,
      title: accountId ? '更新微软账号登录' : '添加微软账号登录',
      onSuccess: async data => {
        if (data.cookie) {
          const cookieInput = document.getElementById('quick-add-cookie');
          if (cookieInput) {
            cookieInput.value = data.cookie;
            cookieInput.disabled = false;
          }
          quickAddCookieCleared = false;
        }
        if (data.refreshToken && data.accessToken) {
          quickAddDraftTokens = {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            tokenTime: data.tokenTime || Date.now(),
            authCodeUrl: ''
          };
        } else {
          quickAddDraftTokens = null;
        }
        if (result) {
          result.innerHTML = data.partial
            ? `<span style="color:#F59E0B;">⚠️ ${escapeHtml(data.message || 'Cookie 已获取，Token 需手动授权')}</span>`
            : '<span style="color:#34D399;">✅ Cookie 与 Token 已自动获取，点击保存修改后生效。</span>';
        }
      }
    });
  } catch (e) {
    if (result) result.innerHTML = `<span style="color:#EF4444;">❌ ${escapeHtml(e.message)}</span>`;
  }
}

async function openSettingsMicrosoftVnc() {
  const result = document.getElementById('cfg-vnc-result');
  const accountId = editingAccountIdInModal || 'acc_1';
  const name = document.getElementById('cfg-account-name')?.value.trim() || accountId;
  const order = parseInt(document.getElementById('cfg-account-order')?.value, 10) || 1;
  const proxy = readProxySelection('cfg-account-proxy-mode', 'cfg-account-proxy-id');
  if (result) result.innerHTML = '<span style="color:#38BDF8;">正在启动内置浏览器...</span>';
  try {
    await startMicrosoftVncLogin({
      accountId,
      draftId: accountId,
      name,
      order,
      proxy,
      title: '更新微软账号凭据',
      onSuccess: async data => {
        if (data.cookie) {
          const cookieInput = document.getElementById('cfg-cookie');
          if (cookieInput) {
            cookieInput.value = data.cookie;
            cookieInput.type = 'password';
          }
          updateCookieHint(true);
        }
        if (data.refreshToken && data.accessToken) {
          cfgDraftTokens = {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            tokenTime: data.tokenTime || Date.now(),
            authCodeUrl: ''
          };
          const authInput = document.getElementById('cfg-authcode');
          if (authInput) authInput.value = '';
          const refreshInput = document.getElementById('cfg-refresh-token');
          if (refreshInput) {
            refreshInput.value = '********';
            delete refreshInput.dataset.clear;
          }
        } else {
          cfgDraftTokens = null;
        }
        if (result) {
          result.innerHTML = data.partial
            ? `<span style="color:#F59E0B;">⚠️ ${escapeHtml(data.message || 'Cookie 已获取，Token 需手动授权')}</span>`
            : '<span style="color:#34D399;">✅ Cookie 与 Token 已自动获取并保存生效！</span>';
        }
        if (!data.partial && data.cookie) {
          await saveSettingsFromModal();
        }
      }
    });
  } catch (e) {
    if (result) result.innerHTML = `<span style="color:#EF4444;">❌ ${escapeHtml(e.message)}</span>`;
  }
}

function renderFontStatus(fonts = {}) {
  const el = document.getElementById('font-status-result');
  if (!el) return;
  const tone = fonts.windowsFontsReady ? 'ok' : 'warn';
  el.className = `hint-msg ${tone}`;
  el.innerHTML = `
    <div>${escapeHtml(fonts.message || '字体状态未知')}</div>
    <div style="margin-top:4px;">Microsoft YaHei: ${escapeHtml(fonts.matches?.yahei || '未匹配')}</div>
    <div>Segoe UI: ${escapeHtml(fonts.matches?.segoe || '未匹配')}</div>
    <div>目录: <code>${escapeHtml(fonts.dir || 'data/fonts/windows')}</code> · 文件 ${Number(fonts.fileCount || 0)} 个</div>
  `;
}

function renderVncRuntimeStatus(vnc = {}) {
  const el = document.getElementById('vnc-runtime-status');
  if (!el) return;
  if (!vnc.enabled) {
    el.className = 'hint-msg warn';
    el.textContent = 'VNC 未启用，请设置 VNC_ENABLED=1 并重启容器。';
    return;
  }
  const login = vnc.loginWindow || {};
  el.className = `hint-msg ${login.open ? 'ok' : ''}`;
  el.textContent = login.open
    ? `登录窗口已打开：${login.name || login.draftId || '微软账号'} · ${login.proxy?.label || '直连'}`
    : 'VNC 已启用，可在配置向导或账号编辑中打开微软登录窗口。';
}

async function fetchBrowserRuntimeStatus() {
  try {
    const res = await fetch('/api/browser/runtime').then(r => r.json());
    if (!res.success) return;
    renderFontStatus(res.data?.fonts);
    renderVncRuntimeStatus(res.data?.vnc);
  } catch {}
}

async function handleGpuCheck() {
  const button = document.getElementById('btn-check-gpu');
  const result = document.getElementById('gpu-check-result');
  if (!button || !result) return;
  const original = button.innerText;
  button.disabled = true;
  button.innerText = '正在检测...';
  result.className = 'hint-msg';
  result.textContent = '正在启动临时 Chromium 检测核显...';
  try {
    const res = await fetch('/api/browser/gpu/check', { method: 'POST' }).then(r => r.json());
    const data = res.data || {};
    if (res.success && data.success) {
      result.className = 'hint-msg ok';
      result.innerHTML = `<div>✅ ${escapeHtml(data.message || '核显工作正常')}</div><div style="margin-top:4px;">后端: ${escapeHtml(data.recommendedBackend || data.backend || '未知')}</div><div>Renderer: ${escapeHtml(data.renderer || '未知')}</div><div>耗时: ${Number(data.durationMs || 0)} ms</div>`;
    } else {
      result.className = 'hint-msg warn';
      const attempts = Array.isArray(data.attempts)
        ? data.attempts.map(item => `${item.backend}: ${item.renderer || item.error || '未获取到硬件 WebGL'}`).join(' | ')
        : '';
      result.innerHTML = `<div>⚠️ ${escapeHtml(data.message || res.message || '核显不可用')}</div><div style="margin-top:4px;">/dev/dri: ${(data.dri?.devices || []).map(escapeHtml).join(', ') || '未发现'}</div>${data.renderer ? `<div>Renderer: ${escapeHtml(data.renderer)}</div>` : ''}${attempts ? `<div>尝试: ${escapeHtml(attempts)}</div>` : ''}`;
    }
  } catch (e) {
    result.className = 'hint-msg err';
    result.textContent = `检测失败：${e.message}`;
  } finally {
    button.disabled = false;
    button.innerText = original;
    fetchBrowserRuntimeStatus();
  }
}

async function handleFontRefresh() {
  const button = document.getElementById('btn-refresh-fonts');
  if (!button) return;
  const original = button.innerText;
  button.disabled = true;
  button.innerText = '正在刷新字体缓存...';
  try {
    const res = await fetch('/api/browser/fonts/refresh', { method: 'POST' }).then(r => r.json());
    if (res.success) renderFontStatus(res.data);
  } catch {}
  button.disabled = false;
  button.innerText = original;
}

function stopEpicConfetti() {
  if (celebrationAnimationId !== null) {
    cancelAnimationFrame(celebrationAnimationId);
    celebrationAnimationId = null;
  }
  celebrationTimers.forEach(timer => clearTimeout(timer));
  celebrationTimers = [];
  if (celebrationResizeHandler) {
    window.removeEventListener('resize', celebrationResizeHandler);
    celebrationResizeHandler = null;
  }
  const canvas = document.getElementById('epic-confetti-canvas');
  const ctx = canvas?.getContext('2d');
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function closeEpicCelebration() {
  stopEpicConfetti();
  const layer = document.getElementById('epic-celebration');
  if (layer) {
    layer.classList.remove('show');
    layer.setAttribute('aria-hidden', 'true');
  }
}

function collectEpicSuccesses(resultGroups = []) {
  const successes = [];
  let failures = 0;
  for (const group of resultGroups || []) {
    const accountName = group.accountName
      || epicAccountCache.find(acc => acc.id === group.accountId)?.name
      || group.accountId
      || '';
    for (const result of group.results || []) {
      if (result?.ok && (result.status === 'claimed' || result.status === 'owned')) {
        successes.push({
          accountName,
          title: result.title || '免费游戏',
          message: result.message || (result.status === 'owned' ? '已在库中' : '领取成功')
        });
      } else if (!result?.ok && result?.status !== 'skipped') {
        failures += 1;
      }
    }
    if (group.error) failures += 1;
  }
  return { successes, failures };
}

function showEpicCelebration({ message = '免费游戏已经收入库中。', items = [], note = '' } = {}) {
  const layer = document.getElementById('epic-celebration');
  if (!layer) return;
  const messageEl = document.getElementById('epic-celebration-message');
  const listEl = document.getElementById('epic-celebration-list');
  const noteEl = document.getElementById('epic-celebration-note');
  if (messageEl) messageEl.innerText = message;
  if (listEl) {
    listEl.innerHTML = items.slice(0, 6).map(item => {
      const meta = [item.accountName, item.message].filter(Boolean).join(' · ');
      return `<div class="celebration-item"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(meta)}</span></div>`;
    }).join('');
  }
  const extra = items.length > 6 ? `另有 ${items.length - 6} 个游戏也已入库。` : '';
  if (noteEl) noteEl.innerText = [extra, note].filter(Boolean).join(' ');
  layer.classList.add('show');
  layer.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    if (!layer.classList.contains('show')) return;
    startEpicConfetti();
    document.getElementById('btn-close-epic-celebration')?.focus({ preventScroll: true });
  });
}

function sizeEpicConfettiCanvas() {
  const canvas = document.getElementById('epic-confetti-canvas');
  if (!canvas) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx, width, height };
}

function startEpicConfetti() {
  stopEpicConfetti();
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  let sized = sizeEpicConfettiCanvas();
  if (!sized) return;
  let { canvas, ctx, width, height } = sized;
  let particles = [];
  const colors = ['#10B981', '#38BDF8', '#F59E0B', '#F472B6', '#F8FAFC'];

  const burst = (count, originX, originY) => {
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
      const speed = 5 + Math.random() * 8;
      particles.push({
        x: originX + (Math.random() - 0.5) * 90,
        y: originY + (Math.random() - 0.5) * 34,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: 0.11 + Math.random() * 0.07,
        drag: 0.992,
        size: 4 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.26,
        life: 1
      });
    }
  };

  burst(85, width * 0.5, height * 0.22);
  celebrationTimers.push(setTimeout(() => burst(55, width * 0.22, height * 0.16), 180));
  celebrationTimers.push(setTimeout(() => burst(55, width * 0.78, height * 0.16), 360));

  const startedAt = performance.now();
  const tick = now => {
    ctx.clearRect(0, 0, width, height);
    for (const particle of particles) {
      particle.vx *= particle.drag;
      particle.vy += particle.gravity;
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.rot += particle.spin;
      particle.life -= 0.006;
      ctx.save();
      ctx.globalAlpha = Math.max(0, particle.life);
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.rot);
      ctx.fillStyle = particle.color;
      ctx.fillRect(-particle.size / 2, -particle.size * 0.3, particle.size, particle.size * 0.6);
      ctx.restore();
    }
    particles = particles.filter(particle => particle.life > 0 && particle.y < height + 40);
    if (now - startedAt < 4800 || particles.length > 0) {
      celebrationAnimationId = requestAnimationFrame(tick);
    } else {
      celebrationAnimationId = null;
      ctx.clearRect(0, 0, width, height);
    }
  };
  celebrationAnimationId = requestAnimationFrame(tick);

  celebrationResizeHandler = () => {
    sized = sizeEpicConfettiCanvas();
    if (!sized) return;
    ({ canvas, ctx, width, height } = sized);
  };
  window.addEventListener('resize', celebrationResizeHandler);
}

function showWebConfirm(message, title = '请确认') {
  return new Promise((resolve) => {
    const modal = document.getElementById('web-confirm-modal');
    if (!modal) {
      resolve(false);
      return;
    }
    document.getElementById('web-confirm-title').innerText = title;
    document.getElementById('web-confirm-message').innerText = message;
    webConfirmResolver = resolve;
    openModal('web-confirm-modal');
  });
}

function resolveWebConfirm(value) {
  closeModal('web-confirm-modal');
  if (webConfirmResolver) {
    const resolve = webConfirmResolver;
    webConfirmResolver = null;
    resolve(!!value);
  }
}

function setActionSteps(steps, activeIndex = 0) {
  const box = document.getElementById('epic-action-steps');
  if (!box) return;
  box.innerHTML = steps.map((step, idx) => {
    const cls = idx < activeIndex ? 'done' : (idx === activeIndex ? 'active' : '');
    const icon = idx < activeIndex ? '✓' : (idx === activeIndex ? '●' : '○');
    return `<div class="action-step ${cls}"><span>${icon}</span><span>${escapeHtml(step)}</span></div>`;
  }).join('');
}

function appendEpicActionLog(message, force = false) {
  const text = String(message || '').trim();
  if (!text) return;
  if (!force && text === lastEpicActionLog) return;
  lastEpicActionLog = text;
  const box = document.getElementById('epic-action-log');
  if (!box) return;
  box.style.display = 'block';
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  box.innerText += `${box.innerText ? '\n' : ''}[${time}] ${text}`;
  box.scrollTop = box.scrollHeight;
}

function openEpicActionModal(title, message, steps = [], activeIndex = 0, showStop = false) {
  document.getElementById('epic-action-title').innerText = title;
  document.getElementById('epic-action-message').innerText = message;
  document.getElementById('epic-action-badge').className = 'epic-badge idle';
  document.getElementById('epic-action-badge').innerText = '准备中';
  document.getElementById('epic-action-progress').style.width = '0%';
  document.getElementById('epic-action-result').style.display = 'none';
  document.getElementById('epic-action-result').innerText = '';
  const logBox = document.getElementById('epic-action-log');
  if (logBox) {
    logBox.style.display = 'none';
    logBox.innerText = '';
  }
  lastEpicActionLog = '';
  appendEpicActionLog(message, true);
  const stopBtn = document.getElementById('btn-epic-action-stop');
  if (stopBtn) stopBtn.style.display = showStop ? 'inline-flex' : 'none';
  const backgroundBtn = document.getElementById('btn-epic-action-background');
  if (backgroundBtn) backgroundBtn.style.display = 'inline-flex';
  setActionSteps(steps, activeIndex);
  openModal('epic-action-modal');
}

function updateEpicActionModal({ title, badge, message, progress, activeIndex, result, final } = {}) {
  if (title) document.getElementById('epic-action-title').innerText = title;
  if (badge) {
    const badgeEl = document.getElementById('epic-action-badge');
    badgeEl.innerText = badge.text || badge;
    badgeEl.className = `epic-badge ${badge.cls || 'idle'}`;
  }
  if (message) document.getElementById('epic-action-message').innerText = message;
  if (typeof progress === 'number') {
    document.getElementById('epic-action-progress').style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }
  if (typeof activeIndex === 'number') {
    const steps = [...document.querySelectorAll('#epic-action-steps .action-step')];
    steps.forEach((el, idx) => {
      el.classList.toggle('active', idx === activeIndex);
      el.classList.toggle('done', idx < activeIndex);
      const icon = el.querySelector('span');
      if (icon) icon.innerText = idx < activeIndex ? '✓' : (idx === activeIndex ? '●' : '○');
    });
  }
  if (result !== undefined) {
    const resultEl = document.getElementById('epic-action-result');
    resultEl.style.display = 'block';
    resultEl.innerText = result;
    appendEpicActionLog(`结果：${String(result).split('\n')[0]}`);
  }
  if (final === true || progress === 100) {
    const stopBtn = document.getElementById('btn-epic-action-stop');
    const backgroundBtn = document.getElementById('btn-epic-action-background');
    if (stopBtn) stopBtn.style.display = 'none';
    if (backgroundBtn) backgroundBtn.style.display = 'none';
  }
}

function closeEpicActionModal() {
  stopEpicActionPolling();
  stopMicrosoftActionPolling();
  stopActionProgressTicker();
  const stopBtn = document.getElementById('btn-epic-action-stop');
  if (stopBtn) stopBtn.style.display = 'none';
  const backgroundBtn = document.getElementById('btn-epic-action-background');
  if (backgroundBtn) backgroundBtn.style.display = 'inline-flex';
  closeModal('epic-action-modal');
}

function stopEpicActionPolling() {
  if (epicActionPollTimer) {
    clearInterval(epicActionPollTimer);
    epicActionPollTimer = null;
  }
}

function stopMicrosoftActionPolling() {
  if (microsoftActionPollTimer) {
    clearInterval(microsoftActionPollTimer);
    microsoftActionPollTimer = null;
  }
}

function stopActionProgressTicker() {
  if (actionProgressTimer) {
    clearInterval(actionProgressTimer);
    actionProgressTimer = null;
  }
}

function startActionProgressTicker(start = 10, max = 90, step = 7, message = '正在执行...') {
  stopActionProgressTicker();
  let progress = start;
  updateEpicActionModal({ progress, message });
  actionProgressTimer = setInterval(() => {
    progress = Math.min(max, progress + step);
    updateEpicActionModal({ progress, message });
  }, 800);
}

function startMicrosoftActionPolling() {
  stopMicrosoftActionPolling();
  const poll = async () => {
    try {
      const res = await fetch('/api/browser/status').then(r => r.json());
      if (!res.success) return;
      const b = res.data || {};
      const total = Number(b.totalTarget || 0);
      const count = Number(b.searchCount || 0);
      const progress = total > 0 ? Math.min(95, Math.max(15, Math.round((count / total) * 85))) : 35;
      const active = ['starting', 'navigating', 'typing', 'dwelling', 'waiting'].includes(b.status);
      updateEpicActionModal({
        progress,
        badge: { text: active ? '执行中' : '准备中', cls: active ? 'ok' : 'idle' },
        message: b.lastAction || '正在执行微软账号操作...'
      });
    } catch {}
  };
  poll();
  microsoftActionPollTimer = setInterval(poll, 1000);
}

function buildMicrosoftStatusDetails(data) {
  const summary = data?.summary || {};
  const stats = data?.stats || {};
  const lines = [
    `今日已增：+${Number(stats.earned ?? summary.totalEarned ?? 0)} 积分`,
    `当前总分：${Number(stats.balance ?? summary.totalBalance ?? 0).toLocaleString()}`,
    `任务达成：${Number(stats.doneTasks ?? summary.doneTasksCount ?? 0)}/${Number(stats.totalTasks ?? summary.totalTasksCount ?? 0)} 项`
  ];
  if (stats.streakDays !== undefined) lines.push(`连续签到：${stats.streakDays} 天`);
  if (summary.accountsList?.length > 1) lines.push(`账号数量：${summary.accountsList.length}`);
  return lines.join('\n');
}

async function runTaskCardAction(accountId, taskKey, taskName = taskKey) {
  let targetId = accountId;
  if (!targetId || targetId === 'all') {
    targetId = currentConfig?.accounts?.[0]?.id || null;
  }
  if (!targetId) {
    openEpicActionModal('无法执行任务', '当前没有可用账号。', ['检查账号列表'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '无账号', cls: 'err' } });
    return;
  }

  const targetStatus = (currentStatus?.summary?.accountsList || []).find(a => a.id === targetId);
  const accName = targetStatus?.name || currentConfig?.accounts?.find(a => a.id === targetId)?.name || targetId;
  if (targetStatus?.enabled === false) {
    openEpicActionModal('账号已暂停', `账号 [${accName}] 当前已暂停，请先启用后再执行任务。`, ['检查账号状态'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '已暂停', cls: 'warn' }, result: '暂停账号不会自动执行任务，但数据与凭据仍保留。' });
    return;
  }
  const isSearch = taskKey === 'search';
  openEpicActionModal(
    `${taskName} · ${accName}`,
    `正在执行「${taskName}」一次...`,
    ['检查当前状态', '执行一次任务动作', '刷新官网进度', '输出结果明细'],
    0
  );
  if (isSearch) startMicrosoftActionPolling();
  else startActionProgressTicker(12, 88, 8, `正在执行「${taskName}」一次...`);

  try {
    const response = await fetch('/api/tasks/card-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: targetId, taskKey })
    });
    const res = await readJsonResponse(response);

    stopMicrosoftActionPolling();
    stopActionProgressTicker();

    if (res.success) {
      const d = res.data || {};
      const before = d.before || {};
      const after = d.after || {};
      const lines = [];
      if (before.max || after.max) {
        lines.push(`进度：${before.progress || 0}/${before.max || 0} → ${after.progress || 0}/${after.max || 0}`);
      }
      if (Array.isArray(d.details) && d.details.length) {
        lines.push(...d.details.map(x => `• ${x}`));
      }
      updateEpicActionModal({
        activeIndex: 4,
        progress: 100,
        badge: {
          text: d.alreadyDone ? '已完成' : (d.hadFailure ? '部分完成' : '执行完成'),
          cls: d.alreadyDone || d.hadFailure ? 'warn' : 'ok'
        },
        message: d.message || '任务动作已完成',
        result: lines.length ? lines.join('\n') : (d.message || '任务动作已完成')
      });
    } else {
      updateEpicActionModal({
        progress: 100,
        badge: { text: '执行失败', cls: 'err' },
        message: res.message || '任务执行失败',
        result: `失败原因：${res.message || '未知错误'}`
      });
    }
  } catch (e) {
    stopMicrosoftActionPolling();
    stopActionProgressTicker();
    updateEpicActionModal({
      progress: 100,
      badge: { text: '执行异常', cls: 'err' },
      message: e.message,
      result: `请求异常：${e.message}`
    });
  } finally {
    fetchStatus();
    fetchHistory(currentHistoryDays);
  }
}

let epicChallengeAutoOpened = false;

function startEpicActionPolling() {
  stopEpicActionPolling();
  const poll = async () => {
    try {
      const res = await fetch('/api/epic/status').then(r => r.json());
      if (!res.success) return;
      const data = res.data || {};
      const st = data.state || {};
      if (st.status === 'challenge' && data.visible && !epicChallengeAutoOpened) {
        epicChallengeAutoOpened = true;
        openNovncModal('Epic 人机验证');
      } else if (st.status !== 'challenge') {
        epicChallengeAutoOpened = false;
      }
      const activeStatuses = ['checking', 'navigating', 'challenge', 'clicking', 'ordering', 'waiting', 'retrying', 'verifying', 'stopping'];
      const active = !!data.running || !!data.verifying || activeStatuses.includes(st.status);
      const badgeCls = st.status === 'challenge' ? 'warn' : (active ? 'ok' : 'idle');
      updateEpicActionModal({
        badge: { text: EPIC_STATUS_TEXT[st.status] || '执行中', cls: badgeCls },
        message: st.lastAction || '正在执行...',
        progress: typeof st.progress === 'number' ? st.progress : undefined
      });
      appendEpicActionLog(st.lastAction || '');
    } catch {}
  };
  poll();
  epicActionPollTimer = setInterval(poll, 1000);
}

async function stopEpicTask() {
  const ok = await showWebConfirm('确定立即停止当前 Epic 任务吗？\n正在进行的浏览器页面会被关闭，浏览器资源会尽快释放给微软积分任务。', '停止 Epic 任务');
  if (!ok) return;
  try {
    const res = await fetch('/api/epic/stop', {
      method: 'POST',
      signal: AbortSignal.timeout(20000)
    }).then(r => r.json());
    updateEpicActionModal({
      badge: { text: '停止中', cls: 'warn' },
      message: res.message || '停止指令已发送',
      progress: 100
    });
    // 登录窗口也会被 stop() 一并关闭，内嵌小窗此时已无画面，避免留下一个连不上的黑框。
    epicChallengeAutoOpened = false;
    closeNovncModal();
    await fetchEpicStatus();
    await fetchEpicAccounts();
    setTimeout(fetchEpicStatus, 1200);
  } catch (e) {
    updateEpicActionModal({
      badge: { text: '停止失败', cls: 'err' },
      message: e.message,
      result: `停止失败：${e.message}`
    });
  }
}

let quickAddCookieCleared = false;
let quickAddDraftTokens = null;

function openQuickAddAccountModal(accountId = null) {
  editingAccountIdInQuickModal = accountId;
  quickAddCookieCleared = false;
  quickAddDraftTokens = null;
  proxyDrafts = cloneProxyDrafts(currentConfig?.network);
  const modalTitle = document.getElementById('quick-add-modal-title');
  const saveBtn = document.getElementById('btn-save-quick-add');
  const nameInput = document.getElementById('quick-add-name');
  const orderInput = document.getElementById('quick-add-order');
  const cookieInput = document.getElementById('quick-add-cookie');
  const authInput = document.getElementById('quick-add-authcode');
  const enabledInput = document.getElementById('quick-add-enabled');
  const cookieHint = document.getElementById('quick-add-cookie-hint');
  const clearCookieBtn = document.getElementById('btn-quick-clear-cookie');
  const proxyModeInput = document.getElementById('quick-add-proxy-mode');
  const cookieTestResult = document.getElementById('quick-add-cookie-result');
  const authTestResult = document.getElementById('quick-add-auth-result');
  const vncResult = document.getElementById('quick-add-vnc-result');

  if (clearCookieBtn) {
    clearCookieBtn.style.display = 'none';
    clearCookieBtn.innerText = '清空已有 Cookie';
  }
  if (cookieInput) cookieInput.disabled = false;
  if (cookieTestResult) cookieTestResult.innerHTML = '';
  if (authTestResult) authTestResult.innerHTML = '';
  if (vncResult) vncResult.innerHTML = '';

  if (accountId) {
    const acc = currentConfig?.accounts?.find(a => a.id === accountId);
    if (modalTitle) modalTitle.innerText = `编辑微软账号：${acc?.name || accountId}`;
    if (saveBtn) saveBtn.innerText = '保存修改';
    if (nameInput) nameInput.value = acc?.name || '';
    if (orderInput) orderInput.value = acc?.order !== undefined ? acc.order : 1;
    if (enabledInput) enabledInput.checked = acc?.enabled !== false;
    if (proxyModeInput) {
      proxyModeInput.value = ['inherit', 'direct', 'proxy'].includes(acc?.proxyMode)
        ? acc.proxyMode
        : 'direct';
    }
    updateQuickAddProxyControls(acc?.proxyId || '');
    renderRunHourGrid('quick-add-run-hours', getAccountRunHours(acc), {
      excludeAccountId: acc?.id || null
    });
    if (cookieInput) {
      cookieInput.value = '';
      cookieInput.placeholder = acc?.hasCookie
        ? '已配置 Cookie（内容已隐藏，留空保持不变，可直接粘贴新 Cookie 覆盖）'
        : '粘贴该账号 rewards.bing.com 的 Cookie';
    }
    if (authInput) {
      authInput.value = '';
      authInput.placeholder = acc?.hasAuthCodeUrl || acc?.hasToken
        ? '已配置移动端凭据（留空保持不变，可粘贴包含 code= 的新跳转链接）'
        : '粘贴包含 code= 的跳转链接（可选）';
    }
    if (cookieHint) cookieHint.innerText = '💡 编辑已有账号时：Cookie 与授权码留空均表示保持原配置不变。';
    if (clearCookieBtn && acc?.hasCookie) {
      clearCookieBtn.style.display = 'inline-block';
    }
  } else {
    const nextOrder = (currentConfig?.accounts?.length || 1) + 1;
    if (modalTitle) modalTitle.innerText = '添加新微软账号';
    if (saveBtn) saveBtn.innerText = '确认创建并添加';
    if (nameInput) nameInput.value = `账号 ${nextOrder}`;
    if (orderInput) orderInput.value = nextOrder;
    if (enabledInput) enabledInput.checked = true;
    if (proxyModeInput) proxyModeInput.value = 'direct';
    updateQuickAddProxyControls('');
    renderRunHourGrid('quick-add-run-hours', [pickFirstAvailableRunHour()].filter(Boolean));
    if (cookieInput) {
      cookieInput.value = '';
      cookieInput.placeholder = '粘贴该账号 rewards.bing.com 的 Cookie';
    }
    if (authInput) {
      authInput.value = '';
      authInput.placeholder = '粘贴包含 code= 的跳转链接（可选）';
    }
    if (cookieHint) cookieHint.innerText = '可选填 Cookie 或授权码，稍后也可随时点击「编辑」补充。';
  }
  openModal('account-quick-add-modal');
}

function openGuideModal() {
  const nextOrder = (currentConfig?.accounts?.length || 1) + 1;
  proxyDrafts = cloneProxyDrafts(currentConfig?.network);
  guideNetworkConfirmed = false;
  guideDraftAccount = {
    id: `acc_${Date.now()}`,
    name: `账号 ${nextOrder}`,
    order: nextOrder,
    cookie: '',
    authCodeUrl: '',
    refreshToken: '',
    accessToken: '',
    tokenTime: 0,
    proxyMode: 'direct',
    proxyId: ''
  };
  const nameInput = document.getElementById('guide-account-name');
  if (nameInput) nameInput.value = guideDraftAccount.name;
  const orderInput = document.getElementById('guide-account-order');
  if (orderInput) orderInput.value = guideDraftAccount.order;
  document.getElementById('guide-code-input').value = '';
  document.getElementById('guide-token-result').innerHTML = '';
  document.getElementById('guide-cookie-input').value = '';
  document.getElementById('guide-cookie-result').innerHTML = '';
  const guideVncResult = document.getElementById('guide-vnc-result');
  if (guideVncResult) guideVncResult.innerHTML = '';
  document.querySelectorAll('input[name="guide-credential-mode"]').forEach(input => {
    input.checked = input.value === 'vnc';
  });
  document.getElementById('guide-proxy-result').innerHTML = '';
  document.getElementById('guide-use-proxy').checked = currentConfig?.network?.useProxy === true;
  document.getElementById('guide-proxy-url').value = currentConfig?.network?.proxyUrl || '';
  document.getElementById('guide-lock-region').checked = currentConfig?.network?.lockRegion !== false;
  document.getElementById('guide-account-proxy-mode').value = 'direct';
  document.getElementById('guide-account-proxy-node-group').style.display = 'none';
  renderRunHourGrid('guide-run-hours', [pickFirstAvailableRunHour()].filter(Boolean));
  document.querySelectorAll('.guide-network-summary').forEach(el => { el.textContent = ''; });
  updateGuideProxyControls('');
  updateGuideCredentialMode();
  switchStep(1);
  openModal('guide-modal');
}

// 快速新建账号提交
async function handleQuickAddAccount() {
  const isEditing = !!editingAccountIdInQuickModal;
  const name = document.getElementById('quick-add-name')?.value.trim();
  const order = parseInt(document.getElementById('quick-add-order')?.value, 10) || 1;
  const cookieInput = document.getElementById('quick-add-cookie');
  const cookieVal = cookieInput?.value.trim();
  const authCodeUrl = document.getElementById('quick-add-authcode')?.value.trim();
  const enabled = document.getElementById('quick-add-enabled')?.checked !== false;
  const proxySelection = readProxySelection('quick-add-proxy-mode', 'quick-add-proxy-id');
  const runHours = readRunHours('quick-add-run-hours');
  const runHourConflict = findRunHourConflict(runHours[0], isEditing ? editingAccountIdInQuickModal : null);

  if (!isEditing && !name && !cookieVal) {
    openEpicActionModal('无法保存微软账号', '请至少填写账号备注名称或粘贴 Cookie。', ['填写账号资料', '重新保存'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
    return;
  }
  if (proxySelection.mode === 'proxy' && !proxySelection.proxyId) {
    openEpicActionModal('请选择代理节点', '当前账号选择了指定代理，但尚未选择可用节点。', ['选择代理节点', '重新保存'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
    return;
  }
  if (runHourConflict) {
    renderRunHourGrid('quick-add-run-hours', [], {
      excludeAccountId: isEditing ? editingAccountIdInQuickModal : null
    });
    openEpicActionModal(
      '运行时间已被占用',
      `该时间档位已分配给账号 [${runHourConflict.name || runHourConflict.id}]，当前账号的勾选已清空，请重新选择。`,
      ['重新选择时间档位', '保存账号'],
      0
    );
    updateEpicActionModal({ progress: 100, badge: { text: '时间冲突', cls: 'warn' } });
    return;
  }
  const payload = {
    name: name || (isEditing ? '账号' : '新账号'),
    order,
    enabled,
    proxyMode: proxySelection.mode,
    proxyId: proxySelection.proxyId,
    runHours,
    timeSlot: buildLegacyTimeSlot(runHours)
  };
  if (isEditing) {
    payload.id = editingAccountIdInQuickModal;
  }
  if (quickAddCookieCleared) {
    payload.cookie = SECRET_CLEAR;
  } else if (cookieVal && !cookieVal.startsWith('（已标记清空')) {
    payload.cookie = cookieVal;
  } else if (!isEditing) {
    payload.cookie = '';
  }

  if (quickAddDraftTokens) {
    payload.authCodeUrl = quickAddDraftTokens.authCodeUrl;
    payload.accessToken = quickAddDraftTokens.accessToken;
    payload.refreshToken = quickAddDraftTokens.refreshToken;
    payload.tokenTime = quickAddDraftTokens.tokenTime;
    payload.tokenAlreadyExchanged = true;
  } else if (authCodeUrl) {
    payload.authCodeUrl = authCodeUrl;
  } else if (!isEditing) {
    payload.authCodeUrl = '';
  }

  try {
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(r => r.json());

    if (res.success) {
      const msg = res.scheduleCleared
        ? `所选时间档位已被账号 [${res.data?.scheduleConflict?.occupiedByName || '其他账号'}] 占用，已清空该账号的时间选择；未选择时间的账号不会自动执行。`
        : (isEditing
          ? '账号配置已成功更新！'
          : (res.tokenExchanged ? '账号添加成功，且移动端 Token 已自动换取就绪！' : '账号添加成功！'));
      closeModal('account-quick-add-modal');
      // 清空表单
      document.getElementById('quick-add-name').value = '';
      document.getElementById('quick-add-order').value = '';
      document.getElementById('quick-add-cookie').value = '';
      if (document.getElementById('quick-add-cookie')) {
        document.getElementById('quick-add-cookie').disabled = false;
      }
      document.getElementById('quick-add-authcode').value = '';
      editingAccountIdInQuickModal = null;
      const clearedBeforeReset = quickAddCookieCleared;
      quickAddCookieCleared = false;
      quickAddDraftTokens = null;
      selectedAccountId = res.data?.id || (isEditing ? payload.id : 'all');
      fetchStatus();
      fetchConfig();
      openEpicActionModal(
        isEditing ? '账号配置已更新' : '账号添加成功',
        msg,
        ['保存账号资料', '处理登录凭据', '刷新账号列表'],
        3
      );
      updateEpicActionModal({
        progress: 100,
        badge: { text: res.scheduleCleared ? '已暂停排期' : '已保存', cls: res.scheduleCleared ? 'warn' : 'ok' },
        result: `账号 [${payload.name}] 已就绪。\n${clearedBeforeReset ? '已清空原 Cookie，请重新配置后再执行任务。' : '如 Cookie 已更新，建议点击「账号状态体检」确认登录态。'}`
      });
    } else {
      openEpicActionModal('账号保存失败', res.message || '保存失败', ['保存账号资料', '校验结果'], 0);
      updateEpicActionModal({ progress: 100, badge: { text: '保存失败', cls: 'err' }, result: `保存失败：${res.message || '未知错误'}` });
    }
  } catch (err) {
    openEpicActionModal('账号保存异常', err.message, ['保存账号资料', '校验结果'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '请求异常', cls: 'err' }, result: `请求异常：${err.message}` });
  }
}

// 配置中心中删除当前账号
async function handleDeleteCurrentAccountInModal() {
  if (!editingAccountIdInModal) return;
  const ok = await showWebConfirm('确定要删除当前选中的这个账号吗？\n该账号的浏览器会话也会被清理。', '删除微软账号');
  if (!ok) return;

  try {
    const res = await fetch(`/api/accounts/${editingAccountIdInModal}`, { method: 'DELETE' }).then(r => r.json());
    if (res.success) {
      selectedAccountId = 'all';
      fetchConfig();
      fetchStatus();
      closeModal('settings-modal');
      openEpicActionModal('账号已删除', '账号及其浏览器会话已清理。', ['删除账号配置', '清理浏览器会话', '刷新账号列表'], 3);
      updateEpicActionModal({ progress: 100, badge: { text: '已删除', cls: 'ok' } });
    } else {
      openEpicActionModal('账号删除失败', res.message || '删除失败', ['删除账号配置', '校验结果'], 0);
      updateEpicActionModal({ progress: 100, badge: { text: '删除失败', cls: 'err' }, result: `删除失败：${res.message || '未知错误'}` });
    }
  } catch (e) {
    openEpicActionModal('账号删除异常', e.message, ['删除账号配置', '校验结果'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '删除异常', cls: 'err' }, result: `删除异常：${e.message}` });
  }
}

// 获取状态并渲染大屏
async function fetchStatus() {
  const requestedAccountId = selectedAccountId;
  const requestSeq = ++statusFetchSeq;
  try {
    const res = await fetch(`/api/status?accountId=${requestedAccountId}`).then(r => r.json());
    // 慢请求不能覆盖用户刚切换后的账号详情，否则会出现空进度或串账号数据。
    if (requestSeq !== statusFetchSeq || requestedAccountId !== selectedAccountId) return;
    if (res.success && res.data) {
      currentStatus = res.data;
      renderDashboard(res.data);
    }
  } catch (e) {
    console.error('获取状态失败:', e);
  }
}

// 获取并渲染无头浏览器实时状态监控数据
async function fetchBrowserStatus() {
  try {
    const res = await fetch('/api/browser/status').then(r => r.json());
    if (res.success && res.data) {
      renderBrowserMonitor(res.data);
    }
  } catch {}
}

// 获取并渲染系统硬件与网络实时状态
async function fetchSystemMetrics() {
  try {
    const res = await fetch('/api/system/metrics').then(r => r.json());
    if (res.success && res.data) {
      const d = res.data;
      lastSystemMetrics = d;
      const cpuEl = document.getElementById('metric-cpu');
      const memEl = document.getElementById('metric-mem');
      const pingEl = document.getElementById('metric-ping');
      const pill = document.getElementById('sys-metrics-pill');
      setTextIfChanged(cpuEl, `CPU ${d.cpu}`);
      setTextIfChanged(memEl, `内存 ${d.procMem}`);
      setTextIfChanged(pingEl, `延时 ${d.ping}`);

      if (pill && d.containerDetails) {
        const cd = d.containerDetails;
        const memLine = cd.containerMemory
          ? `🧠 容器内存占用: ${cd.containerMemory} / ${cd.containerMemoryLimit}${cd.containerMemoryPercent !== null ? ` (${cd.containerMemoryPercent}%)` : ''}${cd.containerMemorySource ? ` [来源: ${cd.containerMemorySource}]` : ''}`
          : `🧠 容器内存占用: 读取不到 cgroup，回退为 Node 进程 ${cd.processRss}`;
        const cpuLine = d.cpuIsContainer
          ? `💻 容器 CPU 占用: ${d.cpu}（占单核百分比）`
          : `💻 CPU 占用: ${d.cpu}（宿主机整机，未读到容器 cgroup）`;
        const tip = `📦 容器运行环境: Node.js ${cd.nodeVersion} on ${cd.platform}\n⏱️ 容器运行时间: ${cd.uptime}\n${memLine}\n🧩 Node 进程 RSS: ${cd.processRss} (堆内存: ${cd.heap})\n${cpuLine}\n🖥️ 宿主机物理内存: ${cd.hostMemory}\n🌐 微软网络延时: ${d.ping}\n🔄 提示: 点击立即刷新`;
        if (pill.getAttribute('data-tip') !== tip) pill.setAttribute('data-tip', tip);
      }
    }
  } catch {}
}

let updateInfo = null;
let taskRunning = false;

// 版本与状态复合胶囊的悬停提示（状态 + 是否有新版本，统一在这里合成）
function refreshVersionPillTooltip() {
  const pill = document.getElementById('version-status-pill');
  if (!pill) return;
  const current = updateInfo?.currentVersion || '1.10.18';
  const statusLine = taskRunning
    ? '🟦 系统状态：正在执行自动化任务打卡中…'
    : '🟢 系统状态：后台定时就绪中';
  let text = `${statusLine}\n当前版本：v${current}`;
  if (updateInfo?.hasUpdate) {
    text += `\n\n🚀 发现新版本 v${updateInfo.latestVersion}！\n${updateInfo.releaseTitle || ''}\n点击查看更新日志与升级方式`;
  } else if (updateInfo?.checkFailed) {
    text += `\n\n⚠️ 无法检查更新：${updateInfo.checkError || '连接 GitHub 失败'}\n（这不代表已是最新版本，可稍后重试）`;
  } else {
    text += `\n✅ 已是最新版本`;
  }
  pill.setAttribute('data-tip', text);
}

async function checkVersionUpdate() {
  try {
    const res = await fetch('/api/system/check-update').then(r => r.json());
    if (res.success && res.data) {
      updateInfo = res.data;
      const indicator = document.getElementById('update-indicator');
      const updateText = document.getElementById('update-text');
      const pill = document.getElementById('version-status-pill');
      if (res.data.hasUpdate) {
        if (indicator) indicator.style.display = 'inline-flex';
        if (updateText) updateText.innerText = `发现新版 v${res.data.latestVersion}`;
        if (pill) pill.classList.add('has-update');
      } else if (res.data.checkFailed) {
        // 检查失败不能伪装成「已是最新」，否则用户永远不知道自己是漏检还是真没更新
        if (indicator) indicator.style.display = 'inline-flex';
        if (updateText) updateText.innerText = '更新检查失败';
        if (pill) pill.classList.remove('has-update');
      } else {
        if (indicator) indicator.style.display = 'none';
        if (pill) pill.classList.remove('has-update');
      }
      refreshVersionPillTooltip();
    }
  } catch {}
}

async function handleVersionCheckClick() {
  if (updateInfo?.hasUpdate) {
    const ok = await showWebConfirm(
      `发现新版本 v${updateInfo.latestVersion}（当前 v${updateInfo.currentVersion}）。\n\n更新说明：${updateInfo.releaseTitle || '暂无说明'}\n\n是否前往 GitHub 查看更新日志？`,
      '发现新版本'
    );
    if (ok) {
      window.open(updateInfo.releaseUrl, '_blank');
    }
  } else {
    const failed = updateInfo?.checkFailed;
    openEpicActionModal(
      '版本检查',
      failed
        ? `当前运行版本 v${updateInfo?.currentVersion || '1.10.18'}，但无法连接 GitHub 检查更新。`
        : `当前运行版本 v${updateInfo?.currentVersion || '1.10.18'} 已是最新版本。`,
      ['获取远端版本', '比较版本号', failed ? '检查失败' : '确认无需更新'],
      3
    );
    updateEpicActionModal({
      progress: 100,
      badge: failed ? { text: '检查失败', cls: 'warn' } : { text: '已是最新', cls: 'ok' },
      result: failed
        ? `失败原因：${updateInfo?.checkError || '连接 GitHub 失败'}\n\n常见原因：容器无法直连 api.github.com（国内网络/防火墙），或触发了 GitHub 接口限流。\n这不代表已是最新版本，可稍后重试。`
        : undefined
    });
  }
}

function renderBrowserMonitor(b) {
  const pill = document.getElementById('browser-pill-status');
  const pillText = document.getElementById('browser-pill-text');
  const bmAccount = document.getElementById('bm-account');
  const bmQuery = document.getElementById('bm-query');
  const bmRound = document.getElementById('bm-round');
  const bmCountdown = document.getElementById('bm-countdown');
  const bmMem = document.getElementById('bm-mem');
  const bmAction = document.getElementById('bm-action-text');

  if (!pill) return;

  const isRunning = b.status !== 'idle' && b.status !== 'stopped';
  const pillClass = `browser-status-pill ${isRunning ? 'status-running' : 'status-idle'}`;
  if (pill.className !== pillClass) pill.className = pillClass;

  const statusMap = {
    idle: '空闲休眠中',
    starting: '正在启动 Chromium...',
    navigating: '打开 Bing 页面中...',
    typing: '正在模拟真人键盘打字...',
    dwelling: '等待页面渲染与滚动...',
    waiting: '拟人呼吸休眠中...',
    stopped: '已停止'
  };

  setTextIfChanged(pillText, statusMap[b.status] || (isRunning ? '运行中' : '空闲休眠中'));
  setTextIfChanged(bmAccount, b.activeAccountName || '--');
  setTextIfChanged(bmQuery, b.currentQuery || '--');
  if (bmRound) {
    setTextIfChanged(bmRound, b.totalTarget > 0 ? `${b.searchCount} / ${b.totalTarget}` : '0 / 0');
    // 说明口径：这里统计的是「本次为补足剩余配额需要跑几轮搜索」，不是总进度
    const roundTip = b.totalTarget > 0
      ? `本次需补足剩余配额 ${b.pointsNeeded || b.totalTarget * 3} 分，每次搜索约 +3 分，共安排 ${b.totalTarget} 轮；与上方总进度是两个口径`
      : '本次补分搜索轮次';
    if (bmRound.getAttribute('data-tip') !== roundTip) bmRound.setAttribute('data-tip', roundTip);
  }
  setTextIfChanged(bmCountdown, b.nextSearchIn > 0 ? `${b.nextSearchIn} 秒` : '--');
  // 用容器真实内存（含 Chromium 子进程）替代原来写死的 180MB
  const containerMem = lastSystemMetrics?.procMem;
  setTextIfChanged(bmMem, containerMem || (isRunning ? `${b.memoryMB || '--'} MB` : '--'));
  setTextIfChanged(bmAction, b.lastAction || '浏览器当前处于空闲休眠状态 (0 内存占用)');
}

// 渲染多账号切换胶囊栏
function renderAccountSelectorBar(summary, runtime = {}) {
  const bar = document.getElementById('account-selector-bar');
  if (!bar || !summary) return;

  const accounts = summary.accountsList || [];
  let html = '';

  // 记录 id → 账号名映射，供日志与打卡明细按账号过滤使用
  accountNameById = {};
  accounts.forEach(acc => { accountNameById[acc.id] = acc.name; });

  const signature = JSON.stringify({
    selectedAccountId,
    running: !!runtime.running,
    runningAccountId: runtime.runningAccountId || null,
    totalAccounts: summary.totalAccounts,
    pausedAccounts: summary.pausedAccounts,
    accounts: accounts.map(acc => ({
      id: acc.id,
      name: acc.name,
      balance: acc.balance,
      enabled: acc.enabled,
      lastRunAt: acc.lastRunAt,
      authDiagnosis: acc.authDiagnosis
    }))
  });
  if (signature === accountSelectorRenderSignature && bar.childElementCount > 0) return;
  accountSelectorRenderSignature = signature;

  // 1. 全部账号汇总胶囊
  const isAllActive = selectedAccountId === 'all';
  html += `
    <button class="account-chip ${isAllActive ? 'active' : ''}" data-acc-id="all">
      <span class="chip-icon">🌐</span>
      <span class="chip-name">全部账号汇总</span>
      <span class="chip-badge">${summary.totalAccounts || 1} 个账号${summary.pausedAccounts ? ` · ${summary.pausedAccounts} 暂停` : ''}</span>
    </button>
  `;

  // 2. 各独立账号胶囊
  accounts.forEach(acc => {
    const isActive = selectedAccountId === acc.id;
    const runtimeStatus = getAccountRuntimeStatus(acc, runtime);
    const lastRunText = formatLastRunTime(acc.lastRunAt);
    html += `
      <button class="account-chip ${isActive ? 'active' : ''} ${runtimeStatus.cls}" data-acc-id="${escapeHtml(acc.id)}" data-tip="${escapeHtml(`${runtimeStatus.tip}\n上次运行：${lastRunText}`)}">
        <span class="chip-icon">${runtimeStatus.icon}</span>
        <span class="chip-name">${escapeHtml(acc.name)}</span>
        <span class="chip-sub">${(acc.balance || 0).toLocaleString()} 分</span>
      </button>
    `;
  });

  // 3. 添加账号按钮
  html += `
    <button class="account-chip chip-add" id="btn-add-account-chip">
      <span>➕</span> 添加账号
    </button>
  `;

  bar.innerHTML = html;

  // 绑定切换事件
  bar.querySelectorAll('.account-chip[data-acc-id]').forEach(chip => {
    chip.addEventListener('click', () => {
      selectedAccountId = chip.getAttribute('data-acc-id');
      fetchStatus();
      fetchHistory(currentHistoryDays);
      renderLogs(); // 日志按选中账号实时过滤
    });
  });

  bar.querySelector('#btn-add-account-chip')?.addEventListener('click', () => {
    openQuickAddAccountModal();
  });
}

function accountHistoryPoint(day, accountId) {
  const accounts = Array.isArray(day?.accounts) ? day.accounts : [];
  if (accountId === 'all') {
    const hasAccounts = accounts.length > 0;
    const claimableValues = accounts
      .map(item => item.claimablePoints)
      .filter(value => value !== undefined && value !== null && Number.isFinite(Number(value)));
    const streakValues = accounts
      .map(item => item.streakDays)
      .filter(value => value !== undefined && value !== null && Number.isFinite(Number(value)));
    const stampRows = accounts.filter(item => item.stamps && Number.isFinite(Number(item.stamps.progress)));
    return {
      earned: hasAccounts
        ? accounts.reduce((sum, item) => sum + Number(item.earned || 0), 0)
        : Number(day?.earned || 0),
      balance: hasAccounts
        ? accounts.reduce((sum, item) => sum + Number(item.balance || 0), 0)
        : Number(day?.balance || 0),
      claimablePoints: claimableValues.length > 0
        ? claimableValues.reduce((sum, value) => sum + Number(value), 0)
        : null,
      streakDays: streakValues.length > 0
        ? streakValues.reduce((sum, value) => sum + Number(value), 0)
        : null,
      stamps: stampRows.length > 0
        ? {
            progress: stampRows.reduce((sum, item) => sum + Number(item.stamps.progress || 0), 0),
            max: stampRows.reduce((sum, item) => sum + Math.max(1, Number(item.stamps.max || 12)), 0)
          }
        : null
    };
  }
  const account = accounts.find(item => item.id === accountId);
  return {
    earned: Number(account?.earned || 0),
    balance: Number(account?.balance || 0),
    claimablePoints: account?.claimablePoints === undefined || account?.claimablePoints === null
      ? null
      : Number(account.claimablePoints),
    streakDays: account?.streakDays === undefined || account?.streakDays === null
      ? null
      : Number(account.streakDays),
    stamps: account?.stamps && Number.isFinite(Number(account.stamps.progress))
      ? {
          progress: Number(account.stamps.progress || 0),
          max: Math.max(1, Number(account.stamps.max || 12))
        }
      : null
  };
}

function getAccountEarnedAverage(accountId, days) {
  if (!Array.isArray(accountSummaryHistory) || accountSummaryHistory.length === 0) return null;
  const period = accountSummaryHistory.slice(-days);
  if (period.length === 0) return null;
  const total = period.reduce((sum, day) => sum + accountHistoryPoint(day, accountId).earned, 0);
  return total / days;
}

function metricValueFromHistoryPoint(point, metric) {
  if (metric === 'stamps') {
    return point.stamps
      ? { value: Number(point.stamps.progress || 0), raw: point.stamps }
      : { value: null, raw: null };
  }
  const pointKey = metric === 'claimable'
    ? 'claimablePoints'
    : (metric === 'streak' ? 'streakDays' : metric);
  const value = point?.[pointKey];
  return {
    value: value === undefined || value === null || !Number.isFinite(Number(value)) ? null : Number(value),
    raw: null
  };
}

function getAccountTrendRows(accountId, metric = 'earned', days = 14) {
  if (!Array.isArray(accountSummaryHistory) || accountSummaryHistory.length === 0) return [];
  const spec = ACCOUNT_TREND_METRICS[metric] || ACCOUNT_TREND_METRICS.earned;
  const fullHistory = accountSummaryHistory;
  const startIndex = Math.max(0, fullHistory.length - days);
  const visibleHistory = fullHistory.slice(startIndex);

  if (spec.kind === 'average') {
    const earnedSeries = fullHistory.map(day => accountHistoryPoint(day, accountId).earned);
    const windowDays = Math.max(1, Number(spec.windowDays || 7));
    return visibleHistory.map((day, visibleIndex) => {
      const absoluteIndex = startIndex + visibleIndex;
      const windowValues = earnedSeries.slice(Math.max(0, absoluteIndex - windowDays + 1), absoluteIndex + 1);
      const total = windowValues.reduce((sum, value) => sum + Number(value || 0), 0);
      return {
        date: day.date,
        dayLabel: day.dayLabel,
        value: total / windowDays,
        raw: { total, windowDays }
      };
    });
  }

  return visibleHistory.map(day => {
    const point = accountHistoryPoint(day, accountId);
    const metricValue = metricValueFromHistoryPoint(point, metric);
    return {
      date: day.date,
      dayLabel: day.dayLabel,
      value: metricValue.value,
      raw: metricValue.raw
    };
  });
}

function ensureAccountSummaryHistory(force = false) {
  if (accountSummaryHistoryPromise) return accountSummaryHistoryPromise;
  if (!force && accountSummaryHistoryAt && Date.now() - accountSummaryHistoryAt < 60000) {
    return Promise.resolve(accountSummaryHistory);
  }
  if (force) accountSummaryHistoryAt = 0;
  accountSummaryHistoryPromise = fetch('/api/history?days=30&accountId=all')
    .then(res => res.json())
    .then(res => {
      if (res.success && Array.isArray(res.data)) {
        accountSummaryHistory = res.data;
        accountSummaryHistoryAt = Date.now();
        accountSummaryRenderSignature = '';
        if (currentStatus?.summary) {
          renderAccountSummaryTable(currentStatus.summary, {
            running: currentStatus.running,
            runningAccountId: currentStatus.runningAccountId
          });
        }
      }
      return accountSummaryHistory;
    })
    .catch(() => accountSummaryHistory)
    .finally(() => {
      if (!accountSummaryHistoryAt) accountSummaryHistoryAt = Date.now();
      accountSummaryHistoryPromise = null;
    });
  return accountSummaryHistoryPromise;
}

function formatDailyAverage(value) {
  if (value === null || !Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(numeric >= 10 ? 1 : 2)}`;
}

function summaryTrendCell(value, accountId, metric, className = '', options = {}) {
  const claimable = options.claimable !== undefined
    ? Math.max(0, Number(options.claimable || 0))
    : null;
  const claimableAttrs = claimable !== null && claimable > 0
    ? ` data-claim-points="${escapeHtml(accountId)}" data-claim-name="${escapeHtml(options.accountName || accountId)}" data-claim-value="${claimable}" role="button" title="点击立即领取该账号待领取积分"`
    : '';
  return `<span class="summary-trend-trigger ${className}" tabindex="0" data-trend-account="${escapeHtml(accountId)}" data-trend-metric="${escapeHtml(metric)}"${claimableAttrs}>${escapeHtml(value)}</span>`;
}

function normalizeAccountSummaryColumnWidths(widths, fallback) {
  const normalized = {};
  for (const key of ACCOUNT_SUMMARY_COLUMN_KEYS) {
    const width = Number(widths?.[key]);
    const fallbackWidth = Number(fallback?.[key]) || 100;
    normalized[key] = Math.round(Number.isFinite(width) ? Math.min(460, Math.max(72, width)) : fallbackWidth);
  }
  return normalized;
}

function readStoredAccountSummaryColumnWidths() {
  try {
    const raw = localStorage.getItem(ACCOUNT_SUMMARY_COLUMN_WIDTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function saveAccountSummaryColumnWidths(widths) {
  try {
    localStorage.setItem(ACCOUNT_SUMMARY_COLUMN_WIDTH_KEY, JSON.stringify(widths));
  } catch {}
}

function measureAccountSummaryColumnWidths() {
  const headers = [...document.querySelectorAll('#account-summary-table thead th[data-col-key]')];
  const measured = {};
  headers.forEach(th => {
    measured[th.dataset.colKey] = Math.round(th.getBoundingClientRect().width || 100);
  });
  return normalizeAccountSummaryColumnWidths(measured, {
    account: 190,
    balance: 130,
    earned: 120,
    claimable: 120,
    streak: 110,
    stamps: 100,
    avg7: 130,
    avg30: 130
  });
}

function applyAccountSummaryColumnWidths(widths) {
  const table = document.getElementById('account-summary-table');
  const colgroup = document.getElementById('account-summary-colgroup');
  if (!table || !colgroup) return;
  const normalized = normalizeAccountSummaryColumnWidths(widths, accountSummaryColumnState?.defaults || {});
  for (const key of ACCOUNT_SUMMARY_COLUMN_KEYS) {
    const col = colgroup.querySelector(`col[data-col-key="${key}"]`);
    if (col) col.style.width = `${normalized[key]}px`;
  }
  const totalWidth = ACCOUNT_SUMMARY_COLUMN_KEYS.reduce((sum, key) => sum + normalized[key], 0);
  table.style.width = `${totalWidth}px`;
  table.style.minWidth = `${totalWidth}px`;
  if (accountSummaryColumnState) accountSummaryColumnState.current = normalized;
}

function initAccountSummaryColumnResize() {
  const table = document.getElementById('account-summary-table');
  if (!table || accountSummaryColumnState) return;
  const defaults = measureAccountSummaryColumnWidths();
  const stored = readStoredAccountSummaryColumnWidths();
  accountSummaryColumnState = {
    defaults,
    current: normalizeAccountSummaryColumnWidths(stored || defaults, defaults),
    drag: null
  };
  applyAccountSummaryColumnWidths(accountSummaryColumnState.current);

  table.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('.column-resize-handle');
    if (!handle) return;
    const key = handle.dataset.resizeColumn;
    if (!ACCOUNT_SUMMARY_COLUMN_KEYS.includes(key)) return;
    event.preventDefault();
    event.stopPropagation();
    accountSummaryColumnState.drag = {
      key,
      startX: event.clientX,
      startWidth: Number(accountSummaryColumnState.current[key]) || 100
    };
    document.body.classList.add('account-column-resizing');
  });

  table.addEventListener('dblclick', (event) => {
    if (!event.target.closest('.column-resize-handle')) return;
    event.preventDefault();
    event.stopPropagation();
    accountSummaryColumnState.current = { ...accountSummaryColumnState.defaults };
    applyAccountSummaryColumnWidths(accountSummaryColumnState.current);
    try {
      localStorage.removeItem(ACCOUNT_SUMMARY_COLUMN_WIDTH_KEY);
    } catch {}
  });

  document.addEventListener('pointermove', (event) => {
    const drag = accountSummaryColumnState?.drag;
    if (!drag) return;
    const width = Math.min(460, Math.max(72, drag.startWidth + event.clientX - drag.startX));
    accountSummaryColumnState.current = {
      ...accountSummaryColumnState.current,
      [drag.key]: Math.round(width)
    };
    applyAccountSummaryColumnWidths(accountSummaryColumnState.current);
  });

  document.addEventListener('pointerup', () => {
    if (!accountSummaryColumnState?.drag) return;
    accountSummaryColumnState.drag = null;
    document.body.classList.remove('account-column-resizing');
    saveAccountSummaryColumnWidths(accountSummaryColumnState.current);
  });
}

async function claimSummaryPendingPoints({
  accountId,
  accountName,
  claimable = null,
  trigger = null,
  confirm = false
}) {
  if (!accountId) return;
  hideAccountTrendTooltip();
  if (confirm) {
    const pointsText = claimable === null ? '' : `（${Number(claimable || 0).toLocaleString()} 分）`;
    const ok = await showWebConfirm(
      `确定立即领取账号「${accountName || accountId}」的待领取积分${pointsText}吗？\n领取会短暂占用浏览器上下文。`,
      '领取待领取积分'
    );
    if (!ok) return;
  }

  const allButton = document.getElementById('btn-summary-claim-all');
  const buttonTrigger = trigger === allButton ? allButton : null;
  const cellTrigger = !buttonTrigger && trigger instanceof HTMLElement ? trigger : null;
  const originalButtonText = buttonTrigger?.innerText || '';
  const originalCellText = cellTrigger?.innerText || '';
  if (buttonTrigger) {
    buttonTrigger.disabled = true;
    buttonTrigger.innerText = '⏳ 领取中...';
  }
  if (cellTrigger) {
    cellTrigger.classList.add('is-claiming');
    cellTrigger.innerText = '领取中...';
  }

  const targetLabel = accountId === 'all' ? '全部账号' : (accountName || accountId);
  openEpicActionModal(
    `领取待领积分 · ${targetLabel}`,
    '正在向微软官网提交领取请求...',
    ['锁定账号上下文', '提交领取请求', '刷新积分看板'],
    0
  );
  startActionProgressTicker(15, 88, 9, '正在向微软官网提交领取请求...');
  try {
    const res = await fetch('/api/tasks/claim-points', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId })
    }).then(r => r.json());
    stopActionProgressTicker();
    if (res.success) {
      updateEpicActionModal({
        activeIndex: 3,
        progress: 100,
        badge: { text: '领取完成', cls: 'ok' },
        message: res.message || '领取请求已完成',
        result: res.message || '领取请求已完成'
      });
      await fetchStatus();
      accountSummaryHistoryAt = 0;
      await ensureAccountSummaryHistory(true);
      fetchHistory(currentHistoryDays);
    } else {
      updateEpicActionModal({
        progress: 100,
        badge: { text: '领取失败', cls: 'err' },
        message: res.message || '领取失败',
        result: `领取失败：${res.message || '未知错误'}`
      });
    }
  } catch (e) {
    stopActionProgressTicker();
    updateEpicActionModal({
      progress: 100,
      badge: { text: '请求异常', cls: 'err' },
      message: e.message,
      result: `请求异常：${e.message}`
    });
  } finally {
    if (buttonTrigger) {
      buttonTrigger.innerText = originalButtonText;
      buttonTrigger.disabled = false;
    }
    if (cellTrigger) {
      cellTrigger.classList.remove('is-claiming');
      cellTrigger.innerText = originalCellText;
    }
  }
}

function renderAccountSummaryTable(summary, runtime = {}) {
  const tbody = document.getElementById('account-summary-tbody');
  if (!tbody || !summary) return;

  const accounts = summary.accountsList || [];
  const historyReady = accountSummaryHistory.length > 0;
  const totalClaimable = accounts.reduce((sum, acc) => sum + Number(acc.claimablePoints || 0), 0);
  const totalEarned = accounts.reduce((sum, acc) => sum + Number(acc.earned || 0), 0);
  const totalBalance = accounts.reduce((sum, acc) => sum + Number(acc.balance || 0), 0);
  const accountAverages = new Map(accounts.map(acc => [
    acc.id,
    {
      avg7: historyReady ? getAccountEarnedAverage(acc.id, 7) : null,
      avg30: historyReady ? getAccountEarnedAverage(acc.id, 30) : null
    }
  ]));
  const updatedAt = Math.max(0, ...accounts.map(acc => Number(acc.lastUpdate) || 0));

  const signature = JSON.stringify({
    historyAt: accountSummaryHistoryAt,
    historyLength: accountSummaryHistory.length,
    running: !!runtime.running,
    runningAccountId: runtime.runningAccountId || null,
    accounts: accounts.map(acc => ({
      id: acc.id,
      name: acc.name,
      enabled: acc.enabled,
      balance: acc.balance,
      earned: acc.earned,
      claimable: acc.claimablePoints,
      streak: acc.streakDays,
      stamps: acc.stamps
    })),
    totals: [totalBalance, totalEarned, totalClaimable]
  });
  const updatedEl = document.getElementById('account-summary-updated');
  setTextIfChanged(updatedEl, updatedAt > 0
    ? `更新于 ${new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
    : '等待官网同步');
  const claimBtn = document.getElementById('btn-summary-claim-all');
  if (claimBtn) {
    claimBtn.disabled = !!runtime.running || totalClaimable <= 0;
    claimBtn.title = totalClaimable > 0
      ? `全部账号共有 ${totalClaimable} 点待领取积分`
      : '当前没有待领取积分';
  }
  ensureAccountSummaryHistory();

  if (signature === accountSummaryRenderSignature && tbody.childElementCount > 0) return;
  hideAccountTrendTooltip();
  accountSummaryRenderSignature = signature;

  const rows = accounts.map(acc => {
    const status = getAccountRuntimeStatus(acc, runtime);
    const stampMax = Math.max(1, Number(acc.stamps?.max || 12));
    const stampProgress = Math.max(0, Math.min(stampMax, Number(acc.stamps?.progress || 0)));
    const avg7 = accountAverages.get(acc.id)?.avg7 ?? null;
    const avg30 = accountAverages.get(acc.id)?.avg30 ?? null;
    return `
      <tr class="account-summary-row ${status.cls}" data-account-id="${escapeHtml(acc.id)}" tabindex="0" role="button" aria-label="进入 ${escapeHtml(acc.name || '账号')} 详情">
        <td class="summary-account-cell">
          <span class="summary-account-name">
            <span class="summary-account-dot" data-tip="${escapeHtml(status.tip)}"></span>
            <span>${escapeHtml(acc.name || '账号')}</span>
          </span>
        </td>
        <td>${summaryTrendCell(Number(acc.balance || 0).toLocaleString(), acc.id, 'balance', 'is-balance')}</td>
        <td>${summaryTrendCell(`+${Number(acc.earned || 0).toLocaleString()}`, acc.id, 'earned', 'is-earned')}</td>
        <td>${summaryTrendCell(
          `${Number(acc.claimablePoints || 0).toLocaleString()} 分`,
          acc.id,
          'claimable',
          Number(acc.claimablePoints || 0) > 0 ? 'is-claimable' : '',
          {
            claimable: Number(acc.claimablePoints || 0),
            accountName: acc.name || acc.id
          }
        )}</td>
        <td>${summaryTrendCell(`${Number(acc.streakDays || 0)} 天`, acc.id, 'streak', 'is-streak')}</td>
        <td>${summaryTrendCell(`${stampProgress} / ${stampMax}`, acc.id, 'stamps', 'is-stamps')}</td>
        <td>${summaryTrendCell(`${formatDailyAverage(avg7)}${avg7 === null ? '' : '/日'}`, acc.id, 'avg7', 'is-history')}</td>
        <td>${summaryTrendCell(`${formatDailyAverage(avg30)}${avg30 === null ? '' : '/日'}`, acc.id, 'avg30', 'is-history')}</td>
      </tr>
    `;
  }).join('');

  const totalRow = `
    <tr class="account-summary-total-row">
      <td class="summary-account-cell"><span class="summary-account-name"><span class="summary-account-dot total"></span><span>总计</span></span></td>
      <td>${summaryTrendCell(totalBalance.toLocaleString(), 'all', 'balance', 'is-balance')}</td>
      <td>${summaryTrendCell(`+${totalEarned.toLocaleString()}`, 'all', 'earned', 'is-earned')}</td>
      <td>${summaryTrendCell(`${totalClaimable.toLocaleString()} 分`, 'all', 'claimable', totalClaimable > 0 ? 'is-claimable' : '')}</td>
      <td colspan="4" class="account-summary-total-empty" aria-label="连续签到、印章与日均不参与总计"></td>
    </tr>
  `;

  tbody.innerHTML = rows + totalRow;
}

function formatAccountTrendValue(metric, row) {
  if (!row || !Number.isFinite(Number(row.value))) return '--';
  const spec = ACCOUNT_TREND_METRICS[metric] || ACCOUNT_TREND_METRICS.earned;
  const value = Number(row.value);
  switch (spec.kind) {
    case 'balance':
      return `${value.toLocaleString()} 分`;
    case 'earned':
      return `+${value.toLocaleString()} 分`;
    case 'claimable':
      return `${value.toLocaleString()} 分待领取`;
    case 'streak':
      return `连续 ${value.toLocaleString()} 天`;
    case 'stamps':
      return `${Number(row.raw?.progress || 0)} / ${Math.max(1, Number(row.raw?.max || 12))} 个印章`;
    case 'average':
      return `日均 +${value.toFixed(2)} 分`;
    default:
      return value.toLocaleString();
  }
}

function buildAccountTrendSummary(metric, rows) {
  if (!rows.length) return '--';
  const spec = ACCOUNT_TREND_METRICS[metric] || ACCOUNT_TREND_METRICS.earned;
  const values = rows
    .filter(row => row.value !== null && row.value !== undefined && Number.isFinite(Number(row.value)))
    .map(row => Number(row.value));
  if (values.length === 0) return '--';
  const latest = values[values.length - 1];
  const peak = Math.max(...values);
  if (spec.kind === 'earned') {
    const total = values.reduce((sum, value) => sum + value, 0);
    return `累计 +${total.toLocaleString()} · 日均 +${(total / rows.length).toFixed(1)}`;
  }
  if (spec.kind === 'average') {
    return `最新 +${latest.toFixed(2)}/日 · 峰值 +${peak.toFixed(2)}/日`;
  }
  if (spec.kind === 'balance') {
    return `最新 ${latest.toLocaleString()} · 峰值 ${peak.toLocaleString()}`;
  }
  if (spec.kind === 'claimable') {
    return `当前 ${latest.toLocaleString()} · 峰值 ${peak.toLocaleString()}`;
  }
  if (spec.kind === 'streak') {
    return `当前 ${latest.toLocaleString()} 天 · 最高 ${peak.toLocaleString()} 天`;
  }
  if (spec.kind === 'stamps') {
    const last = rows[rows.length - 1]?.raw;
    return `当前 ${Number(last?.progress || 0)} / ${Math.max(1, Number(last?.max || 12))} · 最高 ${peak}`;
  }
  return `最新 ${latest.toLocaleString()}`;
}

function renderAccountTrendChart(rows) {
  if (!rows.length) return '<div class="account-trend-empty">暂无历史数据</div>';
  const width = 292;
  const height = 106;
  const paddingX = 9;
  const paddingTop = 9;
  const paddingBottom = 9;
  const values = rows.map(row => Number(row.value || 0));
  const max = Math.max(1, ...values);
  const stepX = (width - paddingX * 2) / Math.max(1, rows.length - 1);
  const points = values.map((value, index) => {
    const x = rows.length === 1 ? width / 2 : paddingX + index * stepX;
    const y = height - paddingBottom - (value / max) * (height - paddingTop - paddingBottom);
    return [x, y];
  });
  const line = points.map(point => point.join(',')).join(' ');
  const area = `${paddingX},${height - paddingBottom} ${line} ${width - paddingX},${height - paddingBottom}`;
  const last = points[points.length - 1];
  const gridLines = [0.25, 0.5, 0.75].map(ratio => {
    const y = paddingTop + (height - paddingTop - paddingBottom) * ratio;
    return `<line x1="${paddingX}" y1="${y}" x2="${width - paddingX}" y2="${y}" class="account-trend-grid"></line>`;
  }).join('');
  accountTrendGeometry = { width, height, paddingX, paddingTop, paddingBottom, points };
  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="近 14 日指标趋势折线">
      <defs>
        <linearGradient id="account-trend-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#38BDF8" stop-opacity="0.34"></stop>
          <stop offset="100%" stop-color="#38BDF8" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      ${gridLines}
      <line x1="${paddingX}" y1="${height - paddingBottom}" x2="${width - paddingX}" y2="${height - paddingBottom}" class="account-trend-axis"></line>
      <polygon points="${area}" fill="url(#account-trend-fill)"></polygon>
      <polyline points="${line}" class="account-trend-line"></polyline>
      <line id="account-trend-crosshair-v" class="account-trend-crosshair" visibility="hidden"></line>
      <line id="account-trend-crosshair-h" class="account-trend-crosshair" visibility="hidden"></line>
      <circle id="account-trend-focus-dot" class="account-trend-focus-dot" r="4" visibility="hidden"></circle>
      <circle cx="${last[0]}" cy="${last[1]}" r="3.5" class="account-trend-dot"></circle>
    </svg>
  `;
}

function showAccountTrendTooltip(cell) {
  const tooltip = document.getElementById('account-trend-tooltip');
  const nameEl = document.getElementById('account-trend-name');
  const metricEl = document.getElementById('account-trend-metric');
  const chartEl = document.getElementById('account-trend-chart');
  const focusEl = document.getElementById('account-trend-focus');
  const rangeEl = document.getElementById('account-trend-range');
  const summaryEl = document.getElementById('account-trend-summary');
  if (!tooltip || !nameEl || !metricEl || !chartEl || !focusEl || !rangeEl || !summaryEl) return;

  const accountId = cell.getAttribute('data-trend-account');
  if (!accountId) return;
  if (accountSummaryHistory.length === 0) {
    ensureAccountSummaryHistory();
    return;
  }
  const account = accountId === 'all'
    ? { name: '全部账号' }
    : (currentStatus?.summary?.accountsList || []).find(acc => acc.id === accountId);
  const metric = cell.getAttribute('data-trend-metric') || 'earned';
  const spec = ACCOUNT_TREND_METRICS[metric] || ACCOUNT_TREND_METRICS.earned;
  const rows = getAccountTrendRows(accountId, metric, 14)
    .filter(row => row.value !== null && row.value !== undefined && Number.isFinite(Number(row.value)));
  accountTrendRows = rows;
  accountTrendMetric = metric;
  nameEl.textContent = `${account?.name || accountId} · ${spec.label}`;
  metricEl.textContent = '近 14 日';
  chartEl.innerHTML = renderAccountTrendChart(rows);
  focusEl.textContent = rows.length > 0 ? '左右滑动图表查看每日数据' : '该指标暂无历史快照';
  rangeEl.textContent = rows.length > 0 ? `${rows[0].date.slice(5)} → ${rows[rows.length - 1].date.slice(5)}` : '--';
  summaryEl.textContent = buildAccountTrendSummary(metric, rows);

  tooltip.style.display = 'block';
  const rect = cell.getBoundingClientRect();
  const tipRect = tooltip.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, left));
  let top = rect.top - tipRect.height - 10;
  if (top < 8) top = rect.bottom + 10;
  if (top + tipRect.height > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - tipRect.height - 8);
  }
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function scheduleAccountTrendHide() {
  clearTimeout(accountTrendHideTimer);
  accountTrendHideTimer = setTimeout(() => hideAccountTrendTooltip(), 180);
}

function cancelAccountTrendHide() {
  clearTimeout(accountTrendHideTimer);
  accountTrendHideTimer = null;
}

function resetAccountTrendCrosshair() {
  const svg = document.querySelector('#account-trend-chart svg');
  if (!svg) return;
  ['#account-trend-crosshair-v', '#account-trend-crosshair-h', '#account-trend-focus-dot'].forEach(selector => {
    svg.querySelector(selector)?.setAttribute('visibility', 'hidden');
  });
  const focusEl = document.getElementById('account-trend-focus');
  if (focusEl && accountTrendRows.length > 0) {
    focusEl.textContent = '左右滑动图表查看每日数据';
  }
}

function handleAccountTrendPointerMove(event) {
  const chartEl = document.getElementById('account-trend-chart');
  const svg = chartEl?.querySelector('svg');
  if (!chartEl || !svg || !accountTrendGeometry || accountTrendRows.length === 0) return;
  const rect = chartEl.getBoundingClientRect();
  if (rect.width <= 0) return;
  const chartX = ((event.clientX - rect.left) / rect.width) * accountTrendGeometry.width;
  const index = Math.max(0, Math.min(
    accountTrendGeometry.points.length - 1,
    Math.round((chartX - accountTrendGeometry.paddingX) / Math.max(
      1,
      (accountTrendGeometry.width - accountTrendGeometry.paddingX * 2)
        / Math.max(1, accountTrendGeometry.points.length - 1)
    ))
  ));
  const point = accountTrendGeometry.points[index];
  const row = accountTrendRows[index];
  if (!point || !row) return;

  const vertical = svg.querySelector('#account-trend-crosshair-v');
  const horizontal = svg.querySelector('#account-trend-crosshair-h');
  const focusDot = svg.querySelector('#account-trend-focus-dot');
  vertical?.setAttribute('x1', point[0]);
  vertical?.setAttribute('x2', point[0]);
  vertical?.setAttribute('y1', accountTrendGeometry.paddingTop);
  vertical?.setAttribute('y2', accountTrendGeometry.height - accountTrendGeometry.paddingBottom);
  vertical?.setAttribute('visibility', 'visible');
  horizontal?.setAttribute('x1', accountTrendGeometry.paddingX);
  horizontal?.setAttribute('x2', accountTrendGeometry.width - accountTrendGeometry.paddingX);
  horizontal?.setAttribute('y1', point[1]);
  horizontal?.setAttribute('y2', point[1]);
  horizontal?.setAttribute('visibility', 'visible');
  focusDot?.setAttribute('cx', point[0]);
  focusDot?.setAttribute('cy', point[1]);
  focusDot?.setAttribute('visibility', 'visible');

  const focusEl = document.getElementById('account-trend-focus');
  if (focusEl) {
    focusEl.textContent = `${row.date} · ${formatAccountTrendValue(accountTrendMetric, row)}`;
  }
}

function hideAccountTrendTooltip() {
  cancelAccountTrendHide();
  const tooltip = document.getElementById('account-trend-tooltip');
  if (tooltip) tooltip.style.display = 'none';
  resetAccountTrendCrosshair();
}

async function openAccountDetailFromSummary(accountId) {
  if (!accountId) return;
  hideAccountTrendTooltip();
  selectedAccountId = accountId;
  await Promise.all([
    fetchStatus(),
    fetchHistory(currentHistoryDays, accountId)
  ]);
  renderLogs();
}

// 渲染大屏
function renderDashboard(data) {
  const { running, runningAccountId, summary, stats, timeline } = data;

  // 1. 渲染顶部多账号切换胶囊
  if (summary) {
    renderAccountSelectorBar(summary, { running, runningAccountId });
  }

  // 2. 系统运行状态与复合胶囊
  const versionPill = document.getElementById('version-status-pill');
  const btnRun = document.getElementById('btn-run');
  const btnStop = document.getElementById('btn-stop');
  const btnRunSingle = document.getElementById('btn-run-single-header');
  const btnToggleAccount = document.getElementById('btn-toggle-account-header');
  const btnStopSingle = document.getElementById('btn-stop-single-header');
  const turboBtn = document.getElementById('btn-turbo-mode');
  const turboText = document.getElementById('btn-turbo-text');
  if (turboBtn && turboText) {
    const isTurbo = !!data.turboMode;
    turboBtn.className = `btn ${isTurbo ? 'btn-warning active' : 'btn-secondary'} btn-sm`;
    setTextIfChanged(turboText, isTurbo ? '极速模式: 下次生效' : '极速模式: 关');
    const tip = isTurbo
      ? '⚡ 极速模式已开启！将在下一次任务（手动或自动）中极限提速执行，任务开始后自动恢复为关闭状态'
      : '极速模式：压缩所有搜索与任务间隔以快速赶时间，仅对下一次任务生效（执行一次后自动恢复关闭）';
    if (turboBtn.getAttribute('data-tip') !== tip) turboBtn.setAttribute('data-tip', tip);
  }

  const isAllMode = selectedAccountId === 'all';
  const selectedAcc = isAllMode ? null : (summary?.accountsList || []).find(a => a.id === selectedAccountId);

  taskRunning = !!running;

  if (running) {
    if (versionPill) {
      versionPill.classList.remove('status-idle');
      versionPill.classList.add('status-running');
    }
    if (btnRun) btnRun.style.display = 'none';
    if (btnStop) btnStop.style.display = 'inline-flex';
    if (btnRunSingle) btnRunSingle.style.display = 'none';
    if (btnStopSingle) btnStopSingle.style.display = 'inline-flex';
  } else {
    if (versionPill) {
      versionPill.classList.remove('status-running');
      versionPill.classList.add('status-idle');
    }
    if (btnRun) btnRun.style.display = 'inline-flex';
    if (btnStop) btnStop.style.display = 'none';
    if (btnRunSingle) btnRunSingle.style.display = isAllMode ? 'none' : 'inline-flex';
    if (btnStopSingle) btnStopSingle.style.display = 'none';
  }

  if (btnToggleAccount) {
    btnToggleAccount.style.display = (!isAllMode && selectedAcc) ? 'inline-flex' : 'none';
    if (selectedAcc) {
      const paused = selectedAcc.enabled === false;
      const schedulePaused = getAccountRunHours(selectedAcc).length === 0;
      btnToggleAccount.className = `btn btn-sm ${paused ? 'btn-success' : (schedulePaused ? 'btn-secondary' : 'btn-warning')}`;
      setHtmlIfChanged(btnToggleAccount, paused
        ? '<span>▶️</span> 启用账号'
        : (schedulePaused ? '<span>🕒</span> 选择运行时间' : '<span>⏸️</span> 暂停账号'));
      btnToggleAccount.setAttribute('data-tip', paused
        ? '启用该账号；下一次任务或手动刷新时会按需更新 Token'
        : (schedulePaused
          ? '该账号未选择每日运行时间，自动任务已暂停；点击选择一个空闲档位'
          : '暂停后停止自动任务与自动 Token 刷新，数据、凭据和历史全部保留'));
    }
  }

  if (btnRunSingle && selectedAcc) {
    const paused = selectedAcc.enabled === false;
    btnRunSingle.disabled = paused;
    btnRunSingle.style.opacity = paused ? '0.55' : '';
    btnRunSingle.setAttribute('data-tip', paused
      ? '账号已暂停，请先点击「启用账号」'
      : '立即运行当前账号的自动化任务');
  }

  refreshVersionPillTooltip();

  if (btnRunSingle && !isAllMode) {
    setHtmlIfChanged(btnRunSingle, `<span>▶️</span> 运行当前账号 [${escapeHtml(stats.name || '')}]`);
  }

  // 3. 账号积分与签到汇总表
  renderAccountSummaryTable(summary, { running, runningAccountId });

  // 顶部工具条面包屑/范围更新
  const scopeBadge = document.getElementById('ms-toolbar-scope');
  if (scopeBadge) {
    if (isAllMode) {
      setHtmlIfChanged(scopeBadge, '👥 全部账号汇总');
    } else {
      setHtmlIfChanged(scopeBadge, `👤 当前账号：${escapeHtml(stats.name || selectedAccountId)}`);
    }
  }

  // 运行按钮提示
  const btnRunIcon = btnRun.querySelector('.icon') || btnRun;
  setHtmlIfChanged(btnRun, isAllMode ? '<span>▶️</span> 立即执行全部账号' : `<span>▶️</span> 运行当前账号 [${escapeHtml(stats.name || '')}]`);

  // 4. 汇总视图 vs 单账号视图渲染
  const overviewCard = document.getElementById('accounts-overview-card');
  const taskListTitle = document.getElementById('task-list-title');
  const historyTitle = document.getElementById('history-chart-title');
  const historyCard = document.getElementById('history-card-section');

  if (historyTitle) {
    historyTitle.innerText = '每日积分增长历史记录 (全部账号汇总)';
  }
  if (historyCard) historyCard.style.display = isAllMode ? 'flex' : 'none';

  if (isAllMode) {
    // 汇总模式：显示全账号概览卡片矩阵，隐藏单任务清单（避免在汇总下显示误导的任务列表）
    if (overviewCard) {
      overviewCard.style.display = 'flex';
      renderAccountsOverviewGrid(summary?.accountsList || [], { running, runningAccountId, schedule: data.schedule || {} });
    }
    const taskListSection = document.getElementById('task-list-section');
    if (taskListSection) {
      taskListSection.style.display = 'none';
    }
  } else {
    // 单账号模式：隐藏全账号矩阵，聚焦当前选中账号的专属任务清单
    if (overviewCard) {
      overviewCard.style.display = 'none';
    }
    const taskListSection = document.getElementById('task-list-section');
    if (taskListSection) {
      taskListSection.style.display = 'flex';
    }
    if (taskListTitle) {
      taskListTitle.innerText = `账号 [${escapeHtml(stats.name || '')}] 今日自动化任务进度清单`;
    }
  }

  // 「最后更新」时间：单账号取该账号的 lastUpdate，汇总视图取所有账号里最新的一次。
  // 这个元素以前只写在 HTML 里、JS 从来没赋值，所以一直显示 "--"。
  const lastUpdateEl = document.getElementById('last-update-time');
  if (lastUpdateEl) {
    const lastUpdateTs = isAllMode
      ? Math.max(0, ...(summary?.accountsList || []).map(a => Number(a.lastUpdate) || 0))
      : Number(stats.lastUpdate) || 0;
    lastUpdateEl.innerText = lastUpdateTs > 0
      ? `最后更新：${new Date(lastUpdateTs).toLocaleString('zh-CN', { hour12: false })}`
      : '最后更新：--';
  }

function formatPunchCardTooltip(t) {
  const m = Number(t.max || 1);
  const p = Math.max(0, Math.min(m, Number(t.progress || 0)));
  const logs = Array.isArray(t.stepLogs) ? t.stepLogs : [];
  const lines = [
    `📋 ${t.name || '打孔卡'} 推进历史明细 (${p}/${m}):`
  ];
  if (t.expiresText) {
    lines.push(`⏳ ${t.expiresText}`);
  }
  lines.push('───────────────────────');

  for (let s = 1; s <= m; s++) {
    const log = s <= p ? logs.find(l => Number(l.step) === s) : null;
    if (log && log.at) {
      const d = new Date(log.at);
      const dateStr = !isNaN(d.getTime())
        ? `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        : '已完成';
      const label = log.name ? ` · ${log.name}` : '';
      lines.push(`● 第 ${s} 项: ${dateStr} 已完成${label}`);
    } else if (s <= p) {
      lines.push(`● 第 ${s} 项: 已完成`);
    } else if (s === p + 1) {
      lines.push(`○ 第 ${s} 项: 待打卡 / 待解锁`);
    } else {
      lines.push(`○ 第 ${s} 项: 待解锁 (完成上一项后满 24 小时)`);
    }
  }
  return lines.join('\n');
}

  // 5. 渲染任务网格
  const taskGrid = document.getElementById('task-grid');
  const nextTaskGridSignature = isAllMode ? '' : JSON.stringify({
    selectedAccountId,
    running: !!running,
    tasks: stats.tasks || {},
    streaks: stats.streaks || {},
    streakDays: stats.streakDays
  });
  if (taskGrid && isAllMode) {
    if (taskGrid.childElementCount > 0) taskGrid.innerHTML = '';
    taskGridRenderSignature = '';
  } else if (taskGrid && (nextTaskGridSignature !== taskGridRenderSignature || taskGrid.childElementCount === 0)) {
    taskGridRenderSignature = nextTaskGridSignature;
    taskGrid.innerHTML = '';
    const TASK_PRIORITY = {
      search: 10,
      dailySet: 20,
      appPromotions: 25,
      sign: 30,
      read: 40,
      promos: 50,
      browserExtension: 55,
      desktopApp: 60
    };

    const tasksList = Object.entries(stats.tasks || {});
    tasksList.sort((a, b) => {
      const prioA = TASK_PRIORITY[a[0]] || 100;
      const prioB = TASK_PRIORITY[b[0]] || 100;
      return prioA - prioB;
    });

    for (const [key, t] of tasksList) {
    const card = document.createElement('div');
    const isFeaturedTask = key === 'search' || key === 'dailySet' || key === 'sign';
    card.className = `task-card task-card-clickable${isFeaturedTask ? ' task-card-featured' : ''}`;
    card.dataset.taskKey = key;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('title', '点击立即执行一次该任务');
    const isDone = t.done || (t.max > 0 && t.progress >= t.max);
    
    let subtext = isDone ? '状态: ✅ 已完成' : (running ? '状态: ⏳ 进行中' : '状态: 待执行');
    let pointsBadge = `+${t.points || 0} 积分`;
    let progressLabel = `进度: ${t.progress || 0} / ${t.max || 1} ${t.unit || ''}`;
    let progPercent = t.max > 0 ? Math.min(100, Math.round((t.progress / t.max) * 100)) : (isDone ? 100 : 0);

    const isPunchCard = t.isPunchCard || key === 'desktopApp' || key === 'monthlyQuest' || key.startsWith('quest_');
    if (isPunchCard) {
      const p = Number(t.progress || 0);
      const m = Number(t.max || (key === 'desktopApp' ? 8 : (key === 'quest_halloween' ? 6 : 5))) || 1;
      progPercent = Math.min(100, Math.round((p / m) * 100));
      const typeLabel = t.name?.includes('每周') ? '每周打孔卡' : (t.name?.includes('月') ? '每月打孔卡' : '活动打孔卡');
      if (isDone) {
        subtext = `已全部达成 · ${typeLabel} (悬停查看记录)`;
      } else if (t.available === false && p === 0) {
        subtext = `未检测到该任务 · ${typeLabel}`;
        pointsBadge = '+0 积分';
      } else {
        subtext = t.expiresText ? `${t.expiresText} · ${typeLabel} (悬停查看记录)` : `${typeLabel} (悬停查看记录)`;
      }
      progressLabel = `进度: ${p} / ${m} 个任务`;
      pointsBadge = `+${t.points || (key === 'desktopApp' ? 20 : 50)} 积分`;
      card.setAttribute('data-tip', formatPunchCardTooltip(t));
      card.style.cursor = 'help';
    }

    let extraStreakHtml = '';
    let displayName = t.name || key;

    // 1. 必应 PC 搜索任务：对应官网「必应搜索连续打卡」7 日进度条
    if (key === 'search') {
      const searchStreak = stats.streaks?.bing;
      extraStreakHtml = render7DayStreakTrack(searchStreak, stats.streakDays, isDone, '必应搜索连续打卡');
      if (Number(t.max || 0) > 0) {
        const tierLabel = t.searchTier?.label ? ` · ${t.searchTier.label}` : '';
        progressLabel = `进度: ${t.progress || 0} / ${t.max} ${t.unit || '分'}${tierLabel}`;
      } else {
        progressLabel = '进度: 等待官网同步会员等级配额';
        pointsBadge = '配额待同步';
      }
      if (t.statusMessage) {
        subtext = `${subtext} · ${t.statusMessage}`;
      }
    }

    // 2. 每日活动集：对应官网「每日连续打卡活动」7 日进度条
    if (key === 'dailySet') {
      const dsStreak = stats.streaks?.dailyset;
      extraStreakHtml = render7DayStreakTrack(dsStreak, stats.streakDays, isDone, '每日连续打卡活动');
    }

    if (key === 'appPromotions') {
      displayName = '移动端附加活动';
      pointsBadge = Number(t.max || 0) > 0
        ? (isDone ? `+${t.points || 0} 积分` : `${t.max} 项待处理`)
        : '等待同步';
      if (t.statusMessage) subtext = `${subtext} · ${t.statusMessage}`;
    }

    // 3. 特殊活动：官网 points 为 0，但完成后有固定奖励。
    if (key === 'browserExtension') {
      pointsBadge = `+${Number(t.awardPoints || 30)} 积分`;
      progressLabel = `进度: ${isDone ? 1 : 0} / 1 项`;
      if (t.statusMessage) subtext = t.statusMessage;
    }

    // 4. 移动端签到：与另外两张重点卡保持一致，只展示移动端完成状态
    if (key === 'sign') {
      displayName = '移动端签到';
      const appStreak = stats.streaks?.bingapp;
      extraStreakHtml = render7DayStreakTrack(appStreak, stats.streakDays, isDone, '移动端连续打卡');
      if (t.statusMessage) subtext = `${subtext} · ${t.statusMessage}`;
    }

    if (isPunchCard && !isDone) {
      const cooling = Object.values(t.subtaskState || {}).some(state => Number(state?.cooldownUntil || 0) > Date.now());
      if (cooling) subtext = `${subtext} · 今日已尝试，等待冷却`;
    }

    // 图标处理：所有 rewards app 的任务，图表换成 rewards app 的官方矢量图标
    const isRewardsApp = key === 'desktopApp'
      || /rewards\s*app/i.test(displayName || '')
      || (displayName || '').includes('桌面应用')
      || t.icon === 'rewards-app';
    const iconHtml = isRewardsApp ? getRewardsAppOfficialIconHtml() : escapeHtml(t.icon || '📌');

    card.innerHTML = `
      <div class="task-top">
        <div class="task-info">
          <div class="task-icon">${iconHtml}</div>
          <div>
            <div class="task-name">${escapeHtml(displayName)}</div>
            <div class="task-subtext">${escapeHtml(subtext)}</div>
          </div>
        </div>
        <div class="pts-badge">${escapeHtml(pointsBadge)}</div>
      </div>
      <div class="progress-wrap">
        <div class="progress-labels">
          <span>${escapeHtml(progressLabel)}</span>
          <span>${progPercent}%</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width: ${progPercent}%;"></div>
        </div>
      </div>
      ${extraStreakHtml}
    `;
    const triggerTaskCard = () => runTaskCardAction(selectedAccountId, key, displayName);
    card.addEventListener('click', triggerTaskCard);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerTaskCard();
      }
    });
      taskGrid.appendChild(card);
    }
  }

  // 6. 渲染时间轴（每行带账号名，服务端已按选中账号过滤）
  const timelineList = document.getElementById('timeline-list');
  const nextTimelineSignature = JSON.stringify({
    selectedAccountId,
    timeline: timeline || []
  });
  if (timelineList && (nextTimelineSignature !== timelineRenderSignature || timelineList.childElementCount === 0)) {
    timelineRenderSignature = nextTimelineSignature;
    if (timeline && timeline.length > 0) {
      timelineList.innerHTML = timeline.map(item => {
        const acc = item.accountName || item.tag || '系统';
        return `
      <div class="timeline-item">
        <span class="timeline-time">${item.time}</span>
        <span class="timeline-tag">[${escapeHtml(acc)}]</span>
        <span>${escapeHtml(item.text)}</span>
      </div>`;
      }).join('');
    } else {
      timelineList.innerHTML = selectedAccountId === 'all'
        ? '<div class="timeline-empty">暂无打卡明细</div>'
        : '<div class="timeline-empty">当前账号暂无打卡明细</div>';
    }
  }
}

// 渲染多账号概览矩阵卡片 (在“全部账号汇总”视图中展示)
function formatDiagnosisTime(ts) {
  if (!ts) return '未知时间';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '未知时间';
  }
}

function formatLastRunTime(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return '暂无运行记录';
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '暂无运行记录';
  }
}

// 账号凭据体检状态：有效 / 失效 / 未检测（悬停展示上次检测时间与结果）
function getAccountAuthStatus(acc) {
  const d = acc?.authDiagnosis;
  if (!d || !d.checkedAt) {
    return {
      text: '未检测',
      cls: 'badge-auth-unknown',
      tip: '尚未体检该账号\n点击右上角「账号体检」可检测 Cookie 与 Token 是否过期'
    };
  }
  // 兼容旧体检数据：旧版 overallValid 是“任一有效”，这里必须重新按双端计算。
  const effectiveOverallValid = d.cookieValid !== false
    && d.tokenValid !== false
    && d.overallValid !== false;
  const cookieLine = d.cookieValid ? '✅ Cookie 有效' : '❌ Cookie 失效';
  const tokenLine = d.tokenValid ? '✅ Token 有效' : '❌ Token 失效';
  const tip = [
    `上次检测：${formatDiagnosisTime(d.checkedAt)}`,
    `检测结果：${effectiveOverallValid ? (d.warning ? '已登录但存在异常' : '整体有效') : '存在失效项'}`,
    cookieLine,
    tokenLine,
    ...(d.cookieMessage ? [`Cookie：${d.cookieMessage}`] : []),
    ...(d.tokenMessage ? [`Token：${d.tokenMessage}`] : []),
    ...(d.warning ? [`⚠️ ${d.warningMessage || '凭据存在异常，请重新检查'}`] : [])
  ].join('\n');
  if (!effectiveOverallValid) {
    return { text: '失效', cls: 'badge-auth-invalid', tip };
  }
  if (d.warning) {
    return { text: '需修复', cls: 'badge-auth-warn', tip };
  }
  return { text: '有效', cls: 'badge-auth-valid', tip };
}

/**
 * 账号运行状态统一口径：
 * 蓝=正在执行 > 黄=已暂停 > 红=凭据失效/异常 > 绿=正常 > 灰=未体检。
 */
function getAccountRuntimeStatus(acc, runtime = {}) {
  const auth = getAccountAuthStatus(acc);
  const isRunning = runtime.running === true && runtime.runningAccountId === acc?.id;
  if (isRunning) {
    return {
      key: 'running',
      icon: '🔵',
      label: '运行中',
      cls: 'status-running',
      tip: '正在执行该账号的自动化任务'
    };
  }
  if (acc?.enabled === false) {
    const pausedTip = [
      '账号已暂停',
      '不会自动执行任务，也不会自动刷新 Token / Cookie',
      '手动体检和手动刷新进度仍可使用',
      '账号数据、凭据、历史与浏览器会话全部保留',
      ...(auth.cls === 'badge-auth-invalid' || auth.cls === 'badge-auth-warn'
        ? [`上次体检：${auth.text}`, auth.tip]
        : [])
    ].join('\n');
    return {
      key: 'paused',
      icon: '🟡',
      label: '已暂停',
      cls: 'status-paused',
      tip: pausedTip
    };
  }
  if (getAccountRunHours(acc).length === 0) {
    return {
      key: 'schedule-paused',
      icon: '🟡',
      label: '未排期',
      cls: 'status-paused',
      tip: [
        '账号未选择每日运行时间档位',
        '自动打卡任务已暂停，不会在后台自动启动',
        '在账号编辑中选择一个空闲时间档位后即可恢复自动排期',
        'Cookie、Token、历史与浏览器会话全部保留'
      ].join('\n')
    };
  }
  if (auth.cls === 'badge-auth-invalid' || auth.cls === 'badge-auth-warn') {
    return {
      key: 'invalid',
      icon: '🔴',
      label: auth.text,
      cls: 'status-invalid',
      tip: auth.tip
    };
  }
  if (auth.cls === 'badge-auth-unknown') {
    return {
      key: 'unknown',
      icon: '⚪',
      label: '未检测',
      cls: 'status-unknown',
      tip: auth.tip
    };
  }
  return {
    key: 'valid',
    icon: '🟢',
    label: '正常',
    cls: 'status-valid',
    tip: auth.tip
  };
}

// 下次自动启动时间：今日计划 / 即将启动 / 明日窗口 / 停用等
// 倒计时格式化：把「距下次执行的分钟数」显示为 HH:MM
function formatCountdown(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 下次自动启动：统一只显示倒计时（如 ⏰21:50 = 21 小时 50 分后执行）
function formatNextRun(sched) {
  if (!sched) return { text: '⏰ --', tip: '调度信息尚未就绪' };
  const windowText = `${sched.windowStart} - ${sched.windowEnd}`;
  switch (sched.status) {
    case 'scheduled': {
      const mins = Math.max(0, Math.round(sched.minutesUntil || 0));
      return {
        text: `⏰ ${formatCountdown(mins)}`,
        tip: `距下次自动启动约 ${Math.floor(mins / 60)} 小时 ${mins % 60} 分\n作息窗口：${windowText}`
      };
    }
    case 'imminent':
      return { text: '⏰ 00:00', tip: `已进入 ${windowText} 窗口，调度器下一分钟启动` };
    case 'disabled':
      return { text: '⏰ 已暂停', tip: '该账号已暂停，不会自动启动；手动刷新和手动体检仍可使用' };
    case 'no-schedule':
      return { text: '⏰ 未排期', tip: '未勾选每日运行时间档位，自动任务已暂停；选择一个空闲档位后恢复自动排期' };
    case 'no-credential':
      return { text: '⏰ 未配凭据', tip: '未配置 Cookie / Token，不会自动启动' };
    case 'schedule-off':
      return { text: '⏰ 定时关闭', tip: '后台定时巡检已关闭（可在「配置中心 → 定时巡检」开启）' };
    default:
      return { text: '⏰ --', tip: '调度信息尚未就绪' };
  }
}

function renderAccountsOverviewGrid(accounts, runtime = {}) {
  const grid = document.getElementById('accounts-grid');
  if (!grid) return;

  const { running = false, runningAccountId = null, schedule = {} } = runtime;
  const prepared = accounts.map(acc => {
    const isRunning = running && runningAccountId === acc.id;
    const runtimeStatus = getAccountRuntimeStatus(acc, { running, runningAccountId });
    const paused = acc.enabled === false;
    const schedulePaused = getAccountRunHours(acc).length === 0;
    const nextRun = formatNextRun(schedule[acc.id]);
    const lastRunText = formatLastRunTime(acc.lastRunAt);
    return { acc, isRunning, runtimeStatus, paused, schedulePaused, nextRun, lastRunText };
  });

  const signature = JSON.stringify(prepared.map(({ acc, isRunning, runtimeStatus, paused, schedulePaused, nextRun, lastRunText }) => ({
    id: acc.id,
    name: acc.name,
    enabled: acc.enabled,
    earned: acc.earned,
    balance: acc.balance,
    claimablePoints: acc.claimablePoints,
    streakDays: acc.streakDays,
    doneTasks: acc.doneTasks,
    totalTasks: acc.totalTasks,
    percent: acc.percent,
    auth: acc.authDiagnosis,
    isRunning,
    runtimeStatus: runtimeStatus.key,
    paused,
    schedulePaused,
    nextRun: nextRun.text,
    nextRunTip: nextRun.tip,
    lastRunAt: acc.lastRunAt,
    lastRunText
  })));
  if (signature === accountsOverviewRenderSignature && grid.childElementCount === prepared.length) {
    return;
  }
  accountsOverviewRenderSignature = signature;
  grid.innerHTML = '';

  prepared.forEach(({ acc, isRunning, runtimeStatus, paused, schedulePaused, nextRun, lastRunText }) => {
    const card = document.createElement('div');
    card.className = `account-overview-card ${runtimeStatus.cls}`;
    card.setAttribute('data-tip', [
      `账号：${acc.name}`,
      `状态：${runtimeStatus.label}`,
      `上次运行：${lastRunText}`,
      `下次计划：${nextRun.tip}`
    ].join('\n'));
    card.innerHTML = `
      <div class="acc-card-top">
        <div class="acc-card-title">
          <span>👤</span>
          <span class="acc-card-name" title="${escapeHtml(acc.name)}">${escapeHtml(acc.name)}</span>
        </div>
        <div class="acc-card-badges">
          ${isRunning
            ? '<span class="badge-mini badge-running">● 运行中</span>'
            : `<span class="badge-mini ${runtimeStatus.cls}" data-tip="${escapeHtml(runtimeStatus.tip)}">${runtimeStatus.icon} ${escapeHtml(runtimeStatus.label)}</span>`}
          <span class="badge-mini badge-schedule" data-tip="${escapeHtml(nextRun.tip)}">${nextRun.text}</span>
        </div>
      </div>

      <div class="acc-card-stats">
        <div class="acc-stat-box">
          <span class="acc-stat-lbl">今日已增</span>
          <span class="acc-stat-num" style="color:#34D399;">+${acc.earned || 0}</span>
        </div>
        <div class="acc-stat-box">
          <span class="acc-stat-lbl">当前总分</span>
          <span class="acc-stat-num">${(acc.balance || 0).toLocaleString()}</span>
        </div>
        <div class="acc-stat-box">
          <span class="acc-stat-lbl">连续签到</span>
          <span class="acc-stat-num" style="color:#F59E0B;">${acc.streakDays || 0}天</span>
        </div>
      </div>

      <div class="progress-wrap">
        <div class="progress-labels">
          <span>任务达成率: ${acc.doneTasks || 0}/${acc.totalTasks || 6} 项</span>
          <span>${acc.percent || 0}%</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width: ${acc.percent || 0}%;"></div>
        </div>
      </div>

      <div class="acc-card-actions">
        <button class="btn btn-primary btn-sm btn-run-single" title="${paused ? '账号已暂停，请先启用' : '立即运行此账号打卡'}" ${paused ? 'disabled' : ''}>▶️ 运行</button>
        <button class="btn ${paused ? 'btn-success' : (schedulePaused ? 'btn-secondary' : 'btn-warning')} btn-sm btn-pause-single" title="${paused ? '启用此账号' : (schedulePaused ? '选择一个空闲时间档位以恢复自动任务' : '暂停此账号')}">${paused ? '▶️ 启用' : (schedulePaused ? '🕒 选择时间' : '⏸️ 暂停')}</button>
        <button class="btn btn-secondary btn-sm btn-sync-single" title="从微软官网同步该账号今日真实进度">🔄 刷新</button>
        <button class="btn btn-secondary btn-sm btn-view-acc" title="进入该账号明细大屏">明细 ➜</button>
        <div class="acc-more-wrap">
          <button class="btn btn-secondary btn-sm btn-more-actions" title="更多账号操作">•••</button>
          <div class="acc-more-dropdown">
            <button class="dropdown-item btn-edit-account" title="编辑账号信息与 Cookie 凭据">✏️ 编辑账号 / 更新凭据</button>
            <button class="dropdown-item btn-test-single-search" title="${paused ? '账号已暂停，请先启用' : '单独搜索一次 (拟人键盘输入，安全验证)'}" ${paused ? 'disabled' : ''}>🔍 单次安全测搜</button>
            <button class="dropdown-item btn-test-single" title="测试该账号登录状态">📋 账号状态体检</button>
            <div class="dropdown-sep"></div>
            <button class="dropdown-item btn-toggle-single">${paused ? '▶️ 启用账号' : (schedulePaused ? '🕒 选择运行时间' : '⏸️ 暂停账号')}</button>
          </div>
        </div>
      </div>
    `;

    const moreBtn = card.querySelector('.btn-more-actions');
    const moreMenu = card.querySelector('.acc-more-dropdown');
    moreBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.acc-more-dropdown.show').forEach(m => {
        if (m !== moreMenu) m.classList.remove('show');
      });
      moreMenu?.classList.toggle('show');
    });

    card.querySelector('.btn-edit-account')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.acc-more-dropdown.show').forEach(m => m.classList.remove('show'));
      openQuickAddAccountModal(acc.id);
    });

    // 绑定卡片上的各快捷按钮
    card.querySelector('.btn-sync-single')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.target;
      const origText = btn.innerText;
      btn.innerText = '⏳ 同步中';
      openEpicActionModal(
        `刷新账号进度 · ${acc.name}`,
        '正在从微软官网拉取该账号真实进度...',
        ['锁定账号上下文', '请求微软官网数据', '解析任务与积分', '刷新账号卡片'],
        0
      );
      startActionProgressTicker(12, 88, 8, '正在从微软官网拉取该账号真实进度...');
      try {
        const res = await fetch('/api/status/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: acc.id, force: true })
        }).then(r => r.json());
        stopActionProgressTicker();
        if (res.success) {
          fetchStatus();
          if (res.skipped) {
            updateEpicActionModal({
              progress: 100,
              badge: { text: '已跳过', cls: 'warn' },
              message: res.message || '任务正在执行中，已跳过同步',
              result: '为避免多账号上下文串台，本次同步已安全跳过。'
            });
          } else {
            updateEpicActionModal({
              activeIndex: 4,
              progress: 100,
              badge: { text: '同步完成', cls: 'ok' },
              message: `账号 [${acc.name}] 进度已刷新`,
              result: buildMicrosoftStatusDetails(res.data)
            });
          }
        } else {
          updateEpicActionModal({
            progress: 100,
            badge: { text: '同步失败', cls: 'err' },
            message: res.message || '同步失败',
            result: `失败原因：${res.message || '未知错误'}`
          });
        }
      } catch (err) {
        stopActionProgressTicker();
        updateEpicActionModal({
          progress: 100,
          badge: { text: '同步异常', cls: 'err' },
          message: err.message,
          result: `同步异常：${err.message}`
        });
      } finally {
        btn.innerText = origText;
      }
    });

    card.querySelector('.btn-test-single-search')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.target;
      const origText = btn.innerText;
      btn.innerText = '⏳ 测搜中...';
      openEpicActionModal(
        `单次安全测搜 · ${acc.name}`,
        '正在执行一次拟人搜索并校验积分...',
        ['准备浏览器环境', '校验账号登录态', '执行拟人键盘搜索', '同步积分与配额', '输出测试明细'],
        0
      );
      startMicrosoftActionPolling();
      try {
        const res = await fetch('/api/tasks/single-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: acc.id })
        }).then(r => r.json());
        stopMicrosoftActionPolling();
        if (res.success) {
          const d = res.data || {};
          const credited = d.credited;
          const before = d.before ? `${d.before.progress}/${d.before.max}` : '未知';
          const after = d.after ? `${d.after.progress}/${d.after.max}` : '未知';
          const search = d.searchResult || {};
          const loginText = search.login?.userName
            ? `已登录：${search.login.userName}`
            : (search.login?.isGuest ? '游客态（不会计分）' : '登录态未识别');
          updateEpicActionModal({
            activeIndex: 5,
            progress: 100,
            badge: credited === true
              ? { text: '已计分', cls: 'ok' }
              : { text: credited === false ? '未计分' : '已提交', cls: credited === false ? 'warn' : 'ok' },
            message: credited === true
              ? `账号 [${acc.name}] 搜索已计分`
              : `账号 [${acc.name}] 搜索已提交，官网暂未确认`,
            result: [
              res.data.message || '搜索动作已执行',
              `官网进度：${before} → ${after}`,
              `登录态：${loginText}`,
              search.finalUrl ? `结果页：${search.finalUrl}` : '',
              credited === false ? '如果连续多次仍未计分，可能是新号搜索观察期、搜索限流或账号市场不匹配。' : ''
            ].filter(Boolean).join('\n')
          });
          fetchStatus();
        } else {
          updateEpicActionModal({
            progress: 100,
            badge: { text: '测搜失败', cls: 'err' },
            message: res.message || '测搜失败',
            result: `失败原因：${res.message || '未知错误'}`
          });
        }
      } catch (err) {
        stopMicrosoftActionPolling();
        updateEpicActionModal({
          progress: 100,
          badge: { text: '请求异常', cls: 'err' },
          message: err.message,
          result: `请求异常：${err.message}`
        });
      } finally {
        btn.innerText = origText;
      }
    });

    card.querySelector('.btn-run-single')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await fetch('/api/tasks/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: acc.id })
      }).then(r => r.json());
      if (res.success) fetchStatus();
      else {
        openEpicActionModal('无法启动账号任务', res.message || '启动失败', ['检查运行状态'], 0);
        updateEpicActionModal({ progress: 100, badge: { text: '启动失败', cls: 'err' } });
      }
    });

    card.querySelector('.btn-pause-single')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleAccountById(acc.id);
    });

    card.querySelector('.btn-toggle-single')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleAccountById(acc.id);
    });

    card.querySelector('.btn-test-single')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedAccountId = acc.id;
      diagMode = 'single';
      diagAccountId = acc.id;
      openModal('diag-modal');
      runAccountDiagnosis();
    });

    card.querySelector('.btn-view-acc')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedAccountId = acc.id;
      fetchStatus();
      fetchHistory(currentHistoryDays);
    });

    card.addEventListener('click', () => {
      selectedAccountId = acc.id;
      fetchStatus();
      fetchHistory(currentHistoryDays);
    });

    grid.appendChild(card);
  });
}

// 建立 SSE 实时日志流
// 实时日志：保留全量日志，按当前选中账号过滤后渲染
let allLogs = [];
let accountNameById = {};

function logAccountName(log) {
  return log?.accountName || log?.tag || '系统';
}

function logMatchesSelectedAccount(log) {
  if (selectedAccountId === 'all') return true;
  const target = accountNameById[selectedAccountId];
  if (!target) return true;
  return logAccountName(log) === target;
}

function buildLogLine(log) {
  const div = document.createElement('div');
  div.className = 'log-line';
  const acc = logAccountName(log);
  const cls = acc === '系统' ? 'log-acc log-acc-system' : 'log-acc';
  div.innerHTML = `<span class="log-time">[${escapeHtml(log.time)}]</span> <span>${escapeHtml(log.icon)}</span> <strong class="${cls}">[${escapeHtml(acc)}]</strong> ${escapeHtml(log.message)}`;
  return div;
}

function renderLogs() {
  const terminal = document.getElementById('terminal-logs');
  if (!terminal) return;
  const chkAutoScroll = document.getElementById('chk-auto-scroll');
  const visible = allLogs.filter(log => (log.timestamp || 0) >= logViewSince && logMatchesSelectedAccount(log));
  terminal.innerHTML = '';
  if (visible.length === 0) {
    terminal.innerHTML = `<div class="log-empty">${logViewSince ? '暂无新日志（已清空当前页面显示，后端日志仍保留）' : '当前账号暂无日志记录'}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  visible.forEach(log => frag.appendChild(buildLogLine(log)));
  terminal.appendChild(frag);
  if (chkAutoScroll?.checked) terminal.scrollTop = terminal.scrollHeight;
}

function initLogStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/logs/stream');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'history') {
        allLogs = Array.isArray(data.logs) ? data.logs : [];
        renderLogs();
      } else if (data.type === 'log') {
        allLogs.push(data.entry);
        if (allLogs.length > 800) allLogs.shift();
        appendLogToModal(data.entry);
        if ((data.entry.timestamp || 0) >= logViewSince && logMatchesSelectedAccount(data.entry)) {
          const terminal = document.getElementById('terminal-logs');
          const chkAutoScroll = document.getElementById('chk-auto-scroll');
          if (terminal) {
            terminal.appendChild(buildLogLine(data.entry));
            if (chkAutoScroll?.checked) terminal.scrollTop = terminal.scrollHeight;
          }
        }
      }
    } catch (e) {
      console.error('解析日志流失败:', e);
    }
  };
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getSelectedAccount() {
  if (!selectedAccountId || selectedAccountId === 'all') return null;
  return (currentStatus?.summary?.accountsList || []).find(a => a.id === selectedAccountId) || null;
}

async function toggleSelectedAccount() {
  const acc = getSelectedAccount();
  if (!acc) return;
  await toggleAccountById(acc.id);
}

async function toggleAccountById(accountId) {
  const account = currentConfig?.accounts?.find(item => item.id === accountId)
    || currentStatus?.summary?.accountsList?.find(item => item.id === accountId);
  if (account?.enabled !== false && getAccountRunHours(account).length === 0) {
    openQuickAddAccountModal(accountId);
    return;
  }
  try {
    const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/toggle`, {
      method: 'POST'
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '操作失败');
    await Promise.all([fetchStatus(), fetchConfig()]);
  } catch (e) {
    openEpicActionModal('账号状态切换失败', e.message, ['更新账号状态', '刷新看板'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '操作失败', cls: 'err' }, result: `操作失败：${e.message}` });
  }
}

async function runTasks() {
  try {
    const reqBody = selectedAccountId !== 'all' ? { accountId: selectedAccountId } : {};
    const res = await fetch('/api/tasks/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody)
    }).then(r => r.json());
    if (res.success) {
      fetchStatus();
    } else {
      openEpicActionModal('无法启动任务', res.message || '启动失败', ['检查运行状态'], 0);
      updateEpicActionModal({ progress: 100, badge: { text: '启动失败', cls: 'err' }, result: res.message || '' });
    }
  } catch (e) {
    openEpicActionModal('启动任务异常', e.message, ['检查网络与运行状态'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '请求异常', cls: 'err' }, result: `请求异常：${e.message}` });
  }
}

async function stopTasks() {
  try {
    const res = await fetch('/api/tasks/stop', { method: 'POST' }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '停止失败');
    fetchStatus();
  } catch (e) {
    openEpicActionModal('停止任务失败', e.message, ['发送停止指令'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '停止失败', cls: 'err' }, result: `停止失败：${e.message}` });
  }
}

async function fetchConfig() {
  try {
    const res = await fetch('/api/config').then(r => r.json());
    if (res.success) {
      currentConfig = res.data;
      const conflicts = Array.isArray(res.data.scheduleConflicts) ? res.data.scheduleConflicts : [];
      const conflictSignature = JSON.stringify(conflicts);
      if (conflicts.length === 0) scheduleConflictSignature = '';
      if (conflicts.length > 0 && conflictSignature !== scheduleConflictSignature) {
        scheduleConflictSignature = conflictSignature;
        const detail = conflicts.map(item => (
          `• ${item.name || item.id}：${String(item.hour).padStart(2, '0')}:00（已分配给 ${item.occupiedByName || item.occupiedBy || '其他账号'}）`
        )).join('\n');
        setTimeout(() => {
          openEpicActionModal(
            '已清理重叠的运行时间',
            `检测到多个账号占用了同一时间档位。冲突账号的勾选已自动清空，未选择时间的账号不会自动执行。\n\n${detail}`,
            ['重新选择时间档位', '账号编辑'],
            0
          );
          updateEpicActionModal({ progress: 100, badge: { text: '待重新排期', cls: 'warn' } });
        }, 0);
      }
      if (res.data.ui?.theme && !localStorage.getItem('ms_rewards_theme')) {
        setTheme(res.data.ui.theme, false);
      }
      const cronHint = document.getElementById('cron-hint');
      if (cronHint) {
        cronHint.innerText = `定时巡检: ${res.data.schedule?.enabled ? res.data.schedule?.cron : '已停用'}`;
      }
    }
  } catch (e) {
    console.error('获取配置失败:', e);
  }
}

// ===== 全局搜索节奏（任务与防风控） =====
const SEARCH_MAX_ROUNDS = 20;            // 单账号最多 20 次搜索（60 分 ÷ 3 分/次）
const SEARCH_WINDOW_MAX_SEC = 40 * 60;   // 1 小时档位中为启动随机与其他任务预留 20 分钟
const SEARCH_INTERVAL_MIN = 60;          // 安全下限：基础间隔（秒）
const SEARCH_INTERVAL_MAX = 120;
const SEARCH_JITTER_MIN = 30;            // 安全下限：随机浮动（秒）
const SEARCH_JITTER_MAX = 60;
const SEARCH_STAGNANT_MIN = 1;           // 停滞保护下限
const SEARCH_STAGNANT_MAX = 5;

// 停滞保护：连续多少次搜索官网进度不涨就停手
function readSearchStagnantLimit() {
  let value = parseInt(document.getElementById('cfg-search-stagnant')?.value, 10);
  if (isNaN(value)) value = 5;
  return Math.max(SEARCH_STAGNANT_MIN, Math.min(SEARCH_STAGNANT_MAX, value));
}

function readSearchRhythmInputs() {
  const intervalEl = document.getElementById('cfg-search-interval');
  const jitterEl = document.getElementById('cfg-search-jitter');
  let interval = parseInt(intervalEl?.value, 10);
  let jitter = parseInt(jitterEl?.value, 10);
  if (isNaN(interval)) interval = 60;
  if (isNaN(jitter)) jitter = 60;
  interval = Math.max(1, Math.min(SEARCH_INTERVAL_MAX, interval));
  jitter = Math.max(0, Math.min(SEARCH_JITTER_MAX, jitter));
  return { interval, jitter };
}

function formatDurationCN(sec) {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

// 校验搜索节奏，返回错误文案；空字符串表示通过
function validateSearchRhythm() {
  const { interval, jitter } = readSearchRhythmInputs();
  if (interval < SEARCH_INTERVAL_MIN) {
    return `基础间隔不能低于 ${SEARCH_INTERVAL_MIN} 秒（防风控安全下限）`;
  }
  if (jitter < SEARCH_JITTER_MIN) {
    return `随机浮动不能低于 ${SEARCH_JITTER_MIN} 秒（防风控安全下限）`;
  }
  const slowestSec = (interval + jitter) * SEARCH_MAX_ROUNDS;
  if (slowestSec > SEARCH_WINDOW_MAX_SEC) {
    return `按最多 ${SEARCH_MAX_ROUNDS} 次搜索估算最慢需要 ${formatDurationCN(slowestSec)}，`
      + `超过 40 分钟搜索上限；请让「基础间隔 + 随机浮动」≤ 120 秒`;
  }
  return '';
}

// 更新预估执行时间提示；返回是否通过全部校验
function updateSearchRhythmHint() {
  const hint = document.getElementById('cfg-search-rhythm-hint');
  if (!hint) return true;
  const { interval, jitter } = readSearchRhythmInputs();
  // 随机浮动是「只延后」的叠加模型：单次实际等待 = 间隔 + 0~浮动 秒
  const fastestSec = interval * SEARCH_MAX_ROUNDS;
  const slowestSec = (interval + jitter) * SEARCH_MAX_ROUNDS;
  const err = validateSearchRhythm();

  if (!err) {
    hint.innerHTML = `按最多 ${SEARCH_MAX_ROUNDS} 次搜索估算：单次 ${interval}~${interval + jitter} 秒，`
      + `总耗时约 <strong>${formatDurationCN(fastestSec)} ~ ${formatDurationCN(slowestSec)}</strong>，`
      + `在 40 分钟搜索预算内 ✅（1 小时档位另留 20 分钟给随机启动与其他任务）`;
    hint.style.color = '';
  } else {
    hint.innerHTML = `⚠️ ${err}`;
    hint.style.color = '#F87171';
  }
  return !err;
}

const RUN_HOURS = Array.from({ length: 24 }, (_, index) => index);

function normalizeRunHoursInput(value) {
  const values = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return [...new Set(values
    .map(item => Number(item))
    .filter(item => Number.isInteger(item) && RUN_HOURS.includes(item)))]
    .sort((a, b) => a - b);
}

function getAccountRunHours(account) {
  if (!account) return [];
  const value = account.runHours !== undefined
    ? account.runHours
    : [account.timeSlot?.startHour];
  return normalizeRunHoursInput(value).slice(0, 1);
}

function buildRunHourOccupancy(excludeAccountId = null) {
  const occupancy = new Map();
  for (const account of currentConfig?.accounts || []) {
    if (excludeAccountId && account.id === excludeAccountId) continue;
    const [hour] = getAccountRunHours(account);
    if (hour === undefined) continue;
    if (!occupancy.has(hour)) occupancy.set(hour, []);
    occupancy.get(hour).push(account.name || account.id);
  }
  return occupancy;
}

function pickFirstAvailableRunHour(excludeAccountId = null) {
  const occupancy = buildRunHourOccupancy(excludeAccountId);
  return RUN_HOURS.find(hour => !occupancy.has(hour)) ?? null;
}

function findRunHourConflict(hour, excludeAccountId = null) {
  if (!Number.isInteger(Number(hour))) return null;
  return (currentConfig?.accounts || []).find(account => (
    account.id !== excludeAccountId
    && getAccountRunHours(account)[0] === Number(hour)
  )) || null;
}

function renderRunHourGrid(containerId, selectedHours = [], options = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const occupancy = options.occupancy || buildRunHourOccupancy(options.excludeAccountId || null);
  const requestedHour = normalizeRunHoursInput(selectedHours)[0];
  const selected = requestedHour !== undefined && !occupancy.has(requestedHour)
    ? new Set([requestedHour])
    : new Set();
  container.innerHTML = RUN_HOURS.map(hour => {
    const accountNames = occupancy.get(hour) || [];
    const occupied = accountNames.length > 0;
    const tip = occupied ? `已被以下账号占用：${accountNames.join('、')}。每个时间段只能分配给一个账号。` : '';
    return `
      <label class="run-hour-option${occupied ? ' is-occupied is-disabled' : ''}"
        ${occupied ? `data-tip="${escapeHtml(tip)}" title="${escapeHtml(tip)}"` : ''}>
        <input type="checkbox" value="${hour}" ${selected.has(hour) ? 'checked' : ''} ${occupied ? 'disabled' : ''}>
        <span>${String(hour).padStart(2, '0')}:00</span>
        ${occupied ? '<i class="run-hour-occupied-dot" aria-hidden="true"></i>' : ''}
      </label>
    `;
  }).join('');

  const inputs = [...container.querySelectorAll('input[type="checkbox"]')];
  inputs.forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) {
        inputs.forEach(other => {
          if (other !== input) other.checked = false;
        });
      }
      container.dispatchEvent(new CustomEvent('runhourchange', { bubbles: true }));
    });
  });
}

function readRunHours(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return [];
  return [...container.querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => Number(input.value))
    .filter(hour => RUN_HOURS.includes(hour))
    .sort((a, b) => a - b)
    .slice(0, 1);
}

function buildLegacyTimeSlot(runHours) {
  const [startHour] = normalizeRunHoursInput(runHours);
  if (startHour === undefined) return null;
  return {
    startHour,
    endHour: (startHour + 1) % 24,
    randomDelayMin: 10,
    durationHours: 1
  };
}

function cloneProxyDrafts(network = {}) {
  const source = Array.isArray(network?.proxies) ? network.proxies : [];
  return source.map((item, index) => ({
    id: item.id || `draft_proxy_${Date.now()}_${index}`,
    name: item.name || `代理 ${index + 1}`,
    url: item.url || item.proxyUrl || ''
  }));
}

function collectProxyDraftsFromDom() {
  const cards = Array.from(document.querySelectorAll('#proxy-list .proxy-card'));
  if (cards.length === 0 && proxyDrafts.length === 0) return [];
  proxyDrafts = cards.map((card, index) => ({
    id: card.getAttribute('data-proxy-id') || `draft_proxy_${Date.now()}_${index}`,
    name: card.querySelector('[data-proxy-field="name"]')?.value.trim() || `代理 ${index + 1}`,
    url: card.querySelector('[data-proxy-field="url"]')?.value.trim() || ''
  }));
  return proxyDrafts.map(item => ({ ...item }));
}

function getDefaultProxyId() {
  const select = document.getElementById('cfg-default-proxy');
  if (select) return select.value;
  return currentConfig?.network?.defaultProxyId || '';
}

function isGlobalProxyEnabled() {
  return document.getElementById('cfg-use-proxy')?.checked === true;
}

function setGlobalProxyEnabled(enabled) {
  const direct = document.getElementById('cfg-global-direct');
  const proxy = document.getElementById('cfg-use-proxy');
  if (direct) direct.checked = !enabled;
  if (proxy) proxy.checked = enabled;
}

function getProxyAssignedAccounts(proxyId) {
  if (!proxyId) return [];
  const network = currentConfig?.network || {};
  return (currentConfig?.accounts || []).flatMap(account => {
    if (account.proxyMode === 'proxy' && account.proxyId === proxyId) {
      return [{ name: account.name || account.id, mode: '指定' }];
    }
    if (
      account.proxyMode === 'inherit'
      && network.useProxy === true
      && network.defaultProxyId === proxyId
    ) {
      return [{ name: account.name || account.id, mode: '跟随全局' }];
    }
    return [];
  });
}

function renderProxyAssignedAccounts(proxyId) {
  const assigned = getProxyAssignedAccounts(proxyId);
  const chips = assigned.length > 0
    ? assigned.map(account => `
      <span class="proxy-assignment-chip" title="${escapeHtml(account.name)} · ${escapeHtml(account.mode)}">
        <span>${escapeHtml(account.name)}</span>
        <small>${escapeHtml(account.mode)}</small>
      </span>
    `).join('')
    : '<span class="proxy-assignment-empty">暂无账号使用</span>';
  return `
    <div class="proxy-card-assignments">
      <span class="proxy-assignments-label">当前分配账号</span>
      <div class="proxy-assignment-list">${chips}</div>
    </div>
  `;
}

function renderProxyCards(defaultProxyId = '') {
  const list = document.getElementById('proxy-list');
  if (!list) return;
  if (proxyDrafts.length === 0) {
    list.innerHTML = '<div class="proxy-empty">还没有代理节点。点击右上角「＋ 添加代理」创建第一套配置。</div>';
    return;
  }
  list.innerHTML = proxyDrafts.map((proxy, index) => `
    <div class="proxy-card${proxy.id === defaultProxyId ? ' is-default' : ''}" data-proxy-id="${escapeHtml(proxy.id)}">
      <div class="proxy-card-head">
        <span class="proxy-card-index">PROXY ${String(index + 1).padStart(2, '0')}</span>
        ${proxy.id === defaultProxyId ? '<span class="proxy-default-badge">全局默认</span>' : ''}
      </div>
      <div class="proxy-card-fields">
        <div class="proxy-field">
          <label>节点名称</label>
          <input type="text" class="form-input" data-proxy-field="name" maxlength="60"
            value="${escapeHtml(proxy.name)}" placeholder="例如：上海电信">
        </div>
        <div class="proxy-field">
          <label>代理地址</label>
          <input type="text" class="form-input" data-proxy-field="url" spellcheck="false"
            value="${escapeHtml(proxy.url)}" placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080">
        </div>
      </div>
      ${renderProxyAssignedAccounts(proxy.id)}
      <div class="proxy-card-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-proxy-action="test">测试</button>
        <button type="button" class="btn btn-primary btn-sm" data-proxy-action="save">保存</button>
        <button type="button" class="btn btn-danger-soft btn-sm" data-proxy-action="delete">删除</button>
      </div>
      <div class="proxy-card-status" data-proxy-status></div>
    </div>
  `).join('');
}

function renderDefaultProxyOptions(defaultProxyId = '') {
  const select = document.getElementById('cfg-default-proxy');
  if (!select) return;
  const options = [
    '<option value="">未选择默认代理</option>',
    ...proxyDrafts.map(proxy => `
      <option value="${escapeHtml(proxy.id)}" ${proxy.id === defaultProxyId ? 'selected' : ''}>
        ${escapeHtml(proxy.name || '未命名代理')}
      </option>
    `)
  ];
  select.innerHTML = options.join('');
}

function renderProxySettings() {
  const network = currentConfig?.network || {};
  const defaultProxyId = network.defaultProxyId || proxyDrafts[0]?.id || '';
  renderProxyCards(defaultProxyId);
  renderDefaultProxyOptions(defaultProxyId);
}

function setProxyStatus(proxyId, kind, html) {
  const card = Array.from(document.querySelectorAll('#proxy-list .proxy-card'))
    .find(item => item.getAttribute('data-proxy-id') === proxyId);
  const box = card?.querySelector('[data-proxy-status]');
  if (!box) return;
  box.className = `proxy-card-status${kind ? ` ${kind}` : ''}`;
  box.innerHTML = html;
}

function updateAccountProxyControls(preferredProxyId = null) {
  const modeEl = document.getElementById('cfg-account-proxy-mode');
  const nodeGroup = document.getElementById('cfg-account-proxy-node-group');
  const nodeEl = document.getElementById('cfg-account-proxy-id');
  const hintEl = document.getElementById('cfg-account-proxy-hint');
  if (!modeEl || !nodeGroup || !nodeEl || !hintEl) return;

  const mode = ['inherit', 'direct', 'proxy'].includes(modeEl.value) ? modeEl.value : 'direct';
  nodeEl.innerHTML = proxyDrafts.map(proxy => `
    <option value="${escapeHtml(proxy.id)}">${escapeHtml(proxy.name || '未命名代理')}</option>
  `).join('');

  if (mode === 'proxy') {
    nodeGroup.style.display = '';
    if (preferredProxyId && proxyDrafts.some(proxy => proxy.id === preferredProxyId)) {
      nodeEl.value = preferredProxyId;
    }
    if (proxyDrafts.length === 0) {
      nodeEl.innerHTML = '<option value="">暂无可用代理，请先在「网络与代理」中添加</option>';
      hintEl.textContent = '当前账号需要指定代理，但尚未保存任何代理节点。';
      hintEl.style.color = '#F59E0B';
    } else {
      const selected = proxyDrafts.find(proxy => proxy.id === nodeEl.value);
      hintEl.textContent = `该账号的 HTTP API、浏览器搜索和账号测试将使用「${selected?.name || '指定代理'}」。`;
      hintEl.style.color = '';
    }
    return;
  }

  nodeGroup.style.display = 'none';
  if (mode === 'direct') {
    hintEl.textContent = '该账号始终直连，不使用任何代理。';
    hintEl.style.color = '';
    return;
  }

  const useGlobal = isGlobalProxyEnabled();
  const defaultProxy = proxyDrafts.find(proxy => proxy.id === getDefaultProxyId());
  if (useGlobal && defaultProxy) {
    hintEl.textContent = `跟随全局：使用「${defaultProxy.name}」作为该账号出口。`;
    hintEl.style.color = '';
  } else {
    hintEl.textContent = '跟随全局：全局默认代理当前未启用，该账号将直连。';
    hintEl.style.color = '';
  }
}

function updateAuxiliaryProxyControls({
  modeId,
  groupId,
  nodeId,
  hintId,
  preferredProxyId = '',
  globalToggleId,
  useGlobalOverride,
  inheritHint = '跟随全局默认设置'
}) {
  const modeEl = document.getElementById(modeId);
  const nodeGroup = document.getElementById(groupId);
  const nodeEl = document.getElementById(nodeId);
  const hintEl = document.getElementById(hintId);
  if (!modeEl || !nodeGroup || !nodeEl || !hintEl) return;

  const mode = ['inherit', 'direct', 'proxy'].includes(modeEl.value) ? modeEl.value : 'direct';
  nodeEl.innerHTML = proxyDrafts.map(proxy => `
    <option value="${escapeHtml(proxy.id)}">${escapeHtml(proxy.name || '未命名代理')}</option>
  `).join('');

  if (mode === 'proxy') {
    nodeGroup.style.display = '';
    if (preferredProxyId && proxyDrafts.some(proxy => proxy.id === preferredProxyId)) {
      nodeEl.value = preferredProxyId;
    }
    if (proxyDrafts.length === 0) {
      nodeEl.innerHTML = '<option value="">暂无可用代理节点</option>';
      hintEl.textContent = '需要先在「网络与代理」中保存至少一个代理节点。';
      hintEl.style.color = '#F59E0B';
    } else {
      const selected = proxyDrafts.find(proxy => proxy.id === nodeEl.value);
      hintEl.textContent = `该账号的凭据测试、Token 换取和后续任务将使用「${selected?.name || '指定代理'}」。`;
      hintEl.style.color = '';
    }
    return;
  }

  nodeGroup.style.display = 'none';
  if (mode === 'direct') {
    hintEl.textContent = '该账号将直连，不使用任何代理。';
    hintEl.style.color = '#F59E0B';
    return;
  }

  const useGlobal = useGlobalOverride !== undefined
    ? useGlobalOverride
    : document.getElementById(globalToggleId)?.checked;
  const defaultProxyId = document.getElementById('cfg-default-proxy')?.value
    || currentConfig?.network?.defaultProxyId
    || '';
  const defaultProxy = proxyDrafts.find(proxy => proxy.id === defaultProxyId);
  hintEl.textContent = useGlobal && defaultProxy
    ? `${inheritHint}：使用「${defaultProxy.name}」。`
    : `${inheritHint}：全局默认代理未启用，该账号将直连。`;
  hintEl.style.color = useGlobal && defaultProxy ? '' : '#F59E0B';
}

function updateQuickAddProxyControls(preferredProxyId = '') {
  updateAuxiliaryProxyControls({
    modeId: 'quick-add-proxy-mode',
    groupId: 'quick-add-proxy-node-group',
    nodeId: 'quick-add-proxy-id',
    hintId: 'quick-add-proxy-hint',
    preferredProxyId,
    globalToggleId: 'cfg-use-proxy',
    useGlobalOverride: currentConfig?.network?.useProxy === true,
    inheritHint: '跟随全局默认设置'
  });
}

function updateGuideProxyControls(preferredProxyId = '') {
  updateAuxiliaryProxyControls({
    modeId: 'guide-account-proxy-mode',
    groupId: 'guide-account-proxy-node-group',
    nodeId: 'guide-account-proxy-id',
    hintId: 'guide-account-proxy-hint',
    preferredProxyId,
    globalToggleId: 'guide-use-proxy',
    inheritHint: '跟随全局默认设置'
  });
}

function readProxySelection(modeId, nodeId) {
  const mode = document.getElementById(modeId)?.value || 'direct';
  const proxyId = mode === 'proxy' ? (document.getElementById(nodeId)?.value || '') : '';
  return {
    mode: ['inherit', 'direct', 'proxy'].includes(mode) ? mode : 'direct',
    proxyId
  };
}

function resolveGuideProxyTestTarget() {
  const selection = readProxySelection('guide-account-proxy-mode', 'guide-account-proxy-id');
  if (selection.mode === 'proxy') {
    const proxy = proxyDrafts.find(item => item.id === selection.proxyId);
    if (!proxy?.url) return { error: '请选择有效的代理节点' };
    return { useProxy: true, proxyUrl: proxy.url, label: `指定代理：${proxy.name}` };
  }
  if (selection.mode === 'inherit' && document.getElementById('guide-use-proxy')?.checked) {
    const proxyUrl = document.getElementById('guide-proxy-url')?.value.trim() || '';
    if (!proxyUrl) return { error: '已选择跟随全局代理，请填写全局默认代理地址' };
    return { useProxy: true, proxyUrl, label: '跟随全局默认代理' };
  }
  return { useProxy: false, proxyUrl: '', label: '直连（容器默认网络）' };
}

function describeProxySelection(selection) {
  if (selection.mode === 'direct') return '直连（不使用代理）';
  if (selection.mode === 'proxy') {
    const proxy = proxyDrafts.find(item => item.id === selection.proxyId);
    return proxy ? `指定代理：${proxy.name}` : '指定代理未选择';
  }
  const defaultProxyId = currentConfig?.network?.defaultProxyId || '';
  const defaultProxy = proxyDrafts.find(item => item.id === defaultProxyId);
  const enabled = currentConfig?.network?.useProxy && defaultProxy;
  return enabled ? `跟随全局：${defaultProxy.name}` : '跟随全局：当前为直连';
}

async function persistProxyDrafts(drafts, defaultProxyId, statusProxyId = '') {
  const response = await fetch('/api/network/proxies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proxies: drafts,
      defaultProxyId,
      useProxy: isGlobalProxyEnabled(),
      lockRegion: document.getElementById('cfg-lock-region')?.checked !== false
    })
  }).then(r => r.json());
  if (!response.success) throw new Error(response.message || '代理配置保存失败');

  currentConfig.network = response.data.network;
  const accountProxyUpdates = new Map(
    (response.data.accounts || []).map(item => [item.id, item])
  );
  currentConfig.accounts = (currentConfig.accounts || []).map(account => {
    const update = accountProxyUpdates.get(account.id);
    return update
      ? { ...account, proxyMode: update.proxyMode, proxyId: update.proxyId }
      : account;
  });
  proxyDrafts = cloneProxyDrafts(response.data.network);
  setGlobalProxyEnabled(!!response.data.network.useProxy);
  renderProxyCards(response.data.network.defaultProxyId || '');
  renderDefaultProxyOptions(response.data.network.defaultProxyId || '');
  const currentAccount = currentConfig.accounts.find(account => account.id === editingAccountIdInModal);
  document.getElementById('cfg-account-proxy-mode').value = currentAccount?.proxyMode || 'direct';
  updateAccountProxyControls(currentAccount?.proxyId || '');

  for (const proxy of proxyDrafts) {
    setProxyStatus(proxy.id, 'ok', '✅ 已保存并生效');
  }
  if (statusProxyId) {
    setProxyStatus(statusProxyId, 'ok', '✅ 已保存并生效');
  }
  return response.data;
}

async function saveProxySettingsFromCards() {
  const drafts = collectProxyDraftsFromDom();
  const invalid = drafts.find(item => !item.url);
  if (invalid) {
    setProxyStatus(invalid.id, 'err', '❌ 请先填写代理地址');
    return;
  }
  const defaultProxyId = getDefaultProxyId() || drafts[0]?.id || '';
  const activeCard = document.activeElement?.closest?.('.proxy-card');
  const statusProxyId = activeCard?.getAttribute('data-proxy-id') || '';
  try {
    for (const proxy of drafts) setProxyStatus(proxy.id, '', '⏳ 正在保存代理配置...');
    await persistProxyDrafts(drafts, defaultProxyId, statusProxyId);
  } catch (e) {
    const targetId = statusProxyId || drafts[0]?.id;
    if (targetId) setProxyStatus(targetId, 'err', `❌ ${escapeHtml(e.message)}`);
  }
}

async function testProxyCard(proxyId) {
  const drafts = collectProxyDraftsFromDom();
  const proxy = drafts.find(item => item.id === proxyId);
  if (!proxy) return;
  if (!proxy.url) {
    setProxyStatus(proxyId, 'err', '❌ 请先填写代理地址');
    return;
  }
  setProxyStatus(proxyId, '', '⏳ 正在通过该代理访问网络并查询出口 IP...');
  try {
    const res = await fetch('/api/proxy/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyUrl: proxy.url, useProxy: true })
    }).then(r => r.json());
    if (!res.success) {
      setProxyStatus(proxyId, 'err', `❌ ${escapeHtml(res.message || '代理不可用')}`);
      return;
    }
    const regionText = res.regionPass
      ? `中国大陆 ${escapeHtml(res.region || 'CN')} · 国区检测通过`
      : `出口地区 ${escapeHtml(res.region || '未知')} · 非国区`;
    setProxyStatus(
      proxyId,
      res.regionPass ? 'ok' : 'warn',
      `✅ ${escapeHtml(res.ipInfo || '代理已连通')}<br>${regionText} · ${Number(res.latencyMs || 0)} ms`
    );
  } catch (e) {
    setProxyStatus(proxyId, 'err', `❌ 测试请求失败：${escapeHtml(e.message)}`);
  }
}

async function deleteProxyCard(proxyId) {
  const drafts = collectProxyDraftsFromDom();
  const proxy = drafts.find(item => item.id === proxyId);
  if (!proxy) return;
  const confirmed = await showWebConfirm(
    `确定删除代理「${proxy.name || '未命名代理'}」吗？\n使用该节点的账号会自动改为跟随全局设置。`,
    '删除代理配置'
  );
  if (!confirmed) return;

  const remaining = drafts.filter(item => item.id !== proxyId);
  const persisted = (currentConfig?.network?.proxies || []).some(item => item.id === proxyId);
  if (!persisted) {
    const oldDefault = getDefaultProxyId();
    const nextDefault = oldDefault === proxyId ? (remaining[0]?.id || '') : oldDefault;
    proxyDrafts = remaining;
    renderProxyCards(nextDefault);
    renderDefaultProxyOptions(nextDefault);
    updateAccountProxyControls(document.getElementById('cfg-account-proxy-id')?.value || '');
    return;
  }

  const oldDefault = getDefaultProxyId();
  const nextDefault = oldDefault === proxyId ? (remaining[0]?.id || '') : oldDefault;
  try {
    await persistProxyDrafts(remaining, nextDefault);
  } catch (e) {
    setProxyStatus(proxyId, 'err', `❌ 删除失败：${escapeHtml(e.message)}`);
  }
}

const NOTIFY_PROXY_CHANNELS = ['wework', 'dingding', 'feishu', 'bark', 'pushme', 'telegram', 'qqbot'];

function readNotifyProxyConfig() {
  const channels = {};
  for (const channel of NOTIFY_PROXY_CHANNELS) {
    channels[channel] = document.getElementById(`cfg-notify-proxy-${channel}`)?.checked === true;
  }
  return {
    url: document.getElementById('cfg-notify-proxy-url')?.value.trim() || '',
    channels
  };
}

function setNotifyProxyStatus(kind, html) {
  const el = document.getElementById('test-notify-proxy-result');
  if (!el) return;
  el.className = `proxy-card-status${kind ? ` ${kind}` : ''}`;
  el.innerHTML = html;
}

function populateSettingsForm() {
  if (!currentConfig) return;
  const c = currentConfig;
  const accounts = c.accounts || [];

  // 1. 填充多账号下拉框
  const accSelect = document.getElementById('cfg-account-select');
  if (accSelect) {
    accSelect.innerHTML = accounts.map(a => `
      <option value="${a.id}" ${editingAccountIdInModal === a.id ? 'selected' : ''}>
        ${escapeHtml(a.name || a.id)}
      </option>
    `).join('');
    if (!editingAccountIdInModal && accounts.length > 0) {
      editingAccountIdInModal = accounts[0].id;
    }
  }

  // 网络与代理。先准备代理列表，账号区域才能渲染代理节点下拉框。
  proxyDrafts = cloneProxyDrafts(c.network);
  renderProxySettings();
  setGlobalProxyEnabled(!!c.network?.useProxy);
  document.getElementById('cfg-lock-region').checked = c.network?.lockRegion !== false;
  loadAccountIntoForm(editingAccountIdInModal);

  // 任务
  document.getElementById('cfg-task-sign').checked = c.tasks?.sign !== false;
  document.getElementById('cfg-task-app-promotions').checked = c.tasks?.appPromotions !== false;
  document.getElementById('cfg-task-read').checked = c.tasks?.read !== false;
  document.getElementById('cfg-task-search').checked = c.tasks?.search !== false;
  document.getElementById('cfg-task-promos').checked = c.tasks?.promos !== false;
  document.getElementById('cfg-task-dailyset').checked = c.tasks?.dailySet !== false;
  document.getElementById('cfg-task-desktop').checked = c.tasks?.desktopApp !== false;
  document.getElementById('cfg-task-keep').checked = c.tasks?.keepRunning !== false;
  const gpuEl = document.getElementById('cfg-browser-gpu');
  if (gpuEl) gpuEl.checked = c.browser?.useGpu === true;
  const intervalEl = document.getElementById('cfg-search-interval');
  const jitterEl = document.getElementById('cfg-search-jitter');
  if (intervalEl) intervalEl.value = c.tasks?.searchIntervalSec ?? 60;
  if (jitterEl) jitterEl.value = c.tasks?.searchJitterSec ?? 60;
  const stagnantEl = document.getElementById('cfg-search-stagnant');
  if (stagnantEl) stagnantEl.value = Math.min(5, c.tasks?.searchStagnantLimit ?? 5);
  const gapEl = document.getElementById('cfg-account-gap');
  if (gapEl) gapEl.value = c.tasks?.accountGapSec ?? 180;
  updateSearchRhythmHint();
  document.getElementById('cfg-search-engine').value = c.tasks?.searchEngineMode || 'browser';
  document.getElementById('cfg-search-api').value = c.tasks?.searchApi || 'baidu.official';
  // 主题
  const themeVal = 'dark';
  const themeSelect = document.getElementById('cfg-ui-theme');
  if (themeSelect) themeSelect.value = themeVal;
  // 调度
  document.getElementById('cfg-sched-enabled').checked = c.schedule?.enabled !== false;
  document.getElementById('cfg-sched-cron').value = c.schedule?.cron || '*/25 * * * *';
  // Web 访问密码
  const authPassElem = document.getElementById('cfg-auth-password');
  if (authPassElem) authPassElem.value = c.server?.authPassword || '';
  // 通知
  document.getElementById('cfg-notify-wework').value = c.notify?.wework || '';
  document.getElementById('cfg-notify-dingding').value = c.notify?.dingding || '';
  document.getElementById('cfg-notify-feishu').value = c.notify?.feishu || '';
  document.getElementById('cfg-notify-bark').value = c.notify?.bark || '';
  document.getElementById('cfg-notify-pushme').value = c.notify?.pushme || '';
  document.getElementById('cfg-notify-tg-token').value = c.notify?.telegram?.botToken || '';
  document.getElementById('cfg-notify-tg-chat').value = c.notify?.telegram?.chatId || '';
  document.getElementById('cfg-notify-qq-appid').value = c.notify?.qqbot?.appId || '';
  document.getElementById('cfg-notify-qq-secret').value = c.notify?.qqbot?.clientSecret || '';
  document.getElementById('cfg-notify-qq-openid').value = c.notify?.qqbot?.openId || '';
  document.getElementById('cfg-notify-qq-group-openid').value = c.notify?.qqbot?.groupOpenId || '';
  document.getElementById('cfg-notify-proxy-url').value = c.notify?.proxy?.url || '';
  for (const channel of NOTIFY_PROXY_CHANNELS) {
    const input = document.getElementById(`cfg-notify-proxy-${channel}`);
    if (input) input.checked = c.notify?.proxy?.channels?.[channel] === true;
  }
  setNotifyProxyStatus('', '');
  const telegramCheck = document.getElementById('telegram-check-result');
  if (telegramCheck) {
    telegramCheck.className = 'proxy-card-status';
    telegramCheck.textContent = '';
  }

  // 液态视觉与背景
  const visualVal = c.visual || JSON.parse(localStorage.getItem('msr_visual_config') || 'null') || DEFAULT_VISUAL_CONFIG;
  applyVisualConfig(visualVal);
}

function loadAccountIntoForm(accId) {
  if (!currentConfig || !Array.isArray(currentConfig.accounts)) return;
  const acc = currentConfig.accounts.find(a => a.id === accId) || currentConfig.accounts[0];
  if (!acc) return;

  editingAccountIdInModal = acc.id;
  document.getElementById('cfg-account-name').value = acc.name || '';
  const orderElem = document.getElementById('cfg-account-order');
  if (orderElem) orderElem.value = acc.order !== undefined ? acc.order : 1;
  document.getElementById('cfg-account-enabled').checked = acc.enabled !== false;
  const proxyMode = ['inherit', 'direct', 'proxy'].includes(acc.proxyMode)
    ? acc.proxyMode
    : (acc.proxyId ? 'proxy' : 'direct');
  document.getElementById('cfg-account-proxy-mode').value = proxyMode;
  updateAccountProxyControls(acc.proxyId || '');

  // 凭据字段：接口已脱敏，这里只回填占位符，避免把明文重新渲染到 DOM
  const cookieElem = document.getElementById('cfg-cookie');
  const authCodeElem = document.getElementById('cfg-authcode');
  const hasCookie = acc.cookie === SECRET_PLACEHOLDER || !!acc.hasCookie;
  const hasAuthCode = acc.authCodeUrl === SECRET_PLACEHOLDER || !!acc.hasAuthCodeUrl;
  cookieElem.value = '';
  authCodeElem.value = '';
  cookieElem.placeholder = hasCookie ? '已配置 Cookie（内容已隐藏，可重新粘贴覆盖）' : '粘贴浏览器 rewards.bing.com 的完整 Cookie';
  authCodeElem.placeholder = hasAuthCode ? '已配置授权码（内容已隐藏，可重新粘贴覆盖）' : '粘贴包含 code= 的完整跳转链接';
  cookieElem.type = 'password';
  authCodeElem.type = 'password';
  document.querySelectorAll('.secret-toggle').forEach(btn => { btn.textContent = '👁'; });
  updateCookieHint(hasCookie);

  const refreshTokenElem = document.getElementById('cfg-refresh-token');
  if (refreshTokenElem) {
    refreshTokenElem.value = acc.refreshToken ? '********' : '';
    delete refreshTokenElem.dataset.clear;
  }
  const cookieRes = document.getElementById('cfg-cookie-test-result');
  if (cookieRes) cookieRes.innerHTML = '';
  const authRes = document.getElementById('cfg-auth-test-result');
  if (authRes) authRes.innerHTML = '';
  cfgDraftTokens = null;
  const vncRes = document.getElementById('cfg-vnc-result');
  if (vncRes) vncRes.innerHTML = '';

  renderRunHourGrid('cfg-run-hours', getAccountRunHours(acc), {
    excludeAccountId: acc.id
  });
}

async function saveSettingsFromModal() {
  const saveStatus = document.getElementById('settings-save-status');
  const setSaveStatus = (kind, text) => {
    if (!saveStatus) return;
    saveStatus.className = `settings-save-status${kind ? ` ${kind}` : ''}`;
    saveStatus.textContent = text;
  };
  setSaveStatus('', '');
  // 保护：配置还没加载完成时保存，会用空数据覆盖掉所有账号（连同 Cookie/Token）
  if (!currentConfig || !Array.isArray(currentConfig.accounts) || currentConfig.accounts.length === 0) {
    setSaveStatus('err', '配置尚未加载完成');
    openEpicActionModal('配置尚未加载完成', '为避免覆盖账号数据，请稍后重试。', ['等待配置加载', '重新保存'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '暂不可保存', cls: 'warn' } });
    return;
  }
  // 搜索节奏必须满足安全下限并落在 40 分钟搜索预算内，否则拒绝保存
  const rhythmError = validateSearchRhythm();
  if (rhythmError) {
    setSaveStatus('err', rhythmError);
    updateSearchRhythmHint();
    openEpicActionModal('搜索节奏设置无效', rhythmError, ['调整搜索间隔', '重新保存'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '参数无效', cls: 'err' } });
    return;
  }
  const searchRhythm = readSearchRhythmInputs();
  const proxyDraftsForSave = collectProxyDraftsFromDom();
  const invalidProxy = proxyDraftsForSave.find(item => !item.url);
  if (invalidProxy) {
    setSaveStatus('err', '代理配置不完整');
    openEpicActionModal('代理配置不完整', '请为每一套代理填写地址，或删除不需要的空白节点。', ['检查代理地址', '重新保存'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '参数无效', cls: 'err' } });
    return;
  }
  const useProxy = isGlobalProxyEnabled();
  const defaultProxyId = getDefaultProxyId() || proxyDraftsForSave[0]?.id || '';
  if (useProxy && !defaultProxyId) {
    setSaveStatus('err', '缺少默认代理');
    openEpicActionModal('缺少默认代理', '启用全局默认代理后，请至少添加并选择一个代理节点。', ['添加代理', '重新保存'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '参数无效', cls: 'warn' } });
    return;
  }
  const accountProxyMode = document.getElementById('cfg-account-proxy-mode')?.value || 'direct';
  const accountProxyId = accountProxyMode === 'proxy'
    ? (document.getElementById('cfg-account-proxy-id')?.value || '')
    : '';
  if (accountProxyMode === 'proxy' && !accountProxyId) {
    setSaveStatus('err', '当前账号缺少指定代理');
    openEpicActionModal('缺少账号代理', '当前账号选择了「使用指定代理」，请先选择一套代理节点。', ['选择代理节点', '重新保存'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '参数无效', cls: 'warn' } });
    return;
  }
  const notifyProxy = readNotifyProxyConfig();
  if (Object.values(notifyProxy.channels).some(Boolean) && !notifyProxy.url) {
    setSaveStatus('err', '消息推送代理未填写');
    openEpicActionModal(
      '消息推送代理未填写',
      '已勾选至少一个“使用推送代理”渠道，请先填写消息推送专用代理地址，或取消对应勾选。',
      ['填写推送代理', '重新保存'],
      0
    );
    updateEpicActionModal({ progress: 100, badge: { text: '参数无效', cls: 'warn' } });
    return;
  }
  const runHours = readRunHours('cfg-run-hours');
  const currentAccId = editingAccountIdInModal || 'acc_1';
  const currentAccounts = currentConfig?.accounts || [];
  const idx = currentAccounts.findIndex(a => a.id === currentAccId);
  const runHourConflict = findRunHourConflict(runHours[0], currentAccId);
  if (runHourConflict) {
    renderRunHourGrid('cfg-run-hours', [], { excludeAccountId: currentAccId });
    setSaveStatus('err', '该运行时间档位已被其他账号占用，勾选已清空');
    openEpicActionModal(
      '运行时间已被占用',
      `该时间档位已分配给账号 [${runHourConflict.name || runHourConflict.id}]，当前账号的勾选已清空，请重新选择。`,
      ['重新选择时间档位', '重新保存'],
      0
    );
    updateEpicActionModal({ progress: 100, badge: { text: '时间冲突', cls: 'warn' } });
    return;
  }

  const updatedAccountData = {
    id: currentAccId,
    name: document.getElementById('cfg-account-name').value.trim() || '账号',
    order: parseInt(document.getElementById('cfg-account-order')?.value, 10) || 1,
    enabled: document.getElementById('cfg-account-enabled').checked,
    cookie: document.getElementById('cfg-cookie').value.trim(),
    authCodeUrl: document.getElementById('cfg-authcode').value.trim(),
    proxyMode: accountProxyMode,
    proxyId: accountProxyId,
    runHours,
    timeSlot: buildLegacyTimeSlot(runHours)
  };
  if (document.getElementById('cfg-refresh-token')?.dataset.clear === '1') {
    updatedAccountData.refreshToken = SECRET_CLEAR;
    updatedAccountData.accessToken = SECRET_CLEAR;
  }
  if (cfgDraftTokens) {
    updatedAccountData.authCodeUrl = SECRET_CLEAR;
    updatedAccountData.refreshToken = cfgDraftTokens.refreshToken;
    updatedAccountData.accessToken = cfgDraftTokens.accessToken;
    updatedAccountData.tokenTime = cfgDraftTokens.tokenTime || Date.now();
  }

  if (idx !== -1) {
    currentAccounts[idx] = { ...currentAccounts[idx], ...updatedAccountData };
  } else {
    currentAccounts.push(updatedAccountData);
  }

  const selectedTheme = 'dark';
  setTheme(selectedTheme);

  const visualConfig = readVisualInputs();
  localStorage.setItem('msr_visual_config', JSON.stringify(visualConfig));
  applyVisualConfig(visualConfig);

  const updateData = {
    accounts: currentAccounts,
    visual: visualConfig,
    network: {
      useProxy,
      proxyUrl: proxyDraftsForSave.find(item => item.id === defaultProxyId)?.url || '',
      proxies: proxyDraftsForSave,
      defaultProxyId,
      lockRegion: document.getElementById('cfg-lock-region').checked
    },
    tasks: {
      sign: document.getElementById('cfg-task-sign').checked,
      appPromotions: document.getElementById('cfg-task-app-promotions').checked,
      read: document.getElementById('cfg-task-read').checked,
      search: document.getElementById('cfg-task-search').checked,
      promos: document.getElementById('cfg-task-promos').checked,
      dailySet: document.getElementById('cfg-task-dailyset').checked,
      desktopApp: document.getElementById('cfg-task-desktop').checked,
      keepRunning: document.getElementById('cfg-task-keep').checked,
      searchIntervalSec: searchRhythm.interval,
      searchJitterSec: searchRhythm.jitter,
      searchStagnantLimit: readSearchStagnantLimit(),
      accountGapSec: Math.max(15, parseInt(document.getElementById('cfg-account-gap')?.value, 10) || 180),
      searchEngineMode: document.getElementById('cfg-search-engine')?.value || 'browser',
      searchApi: document.getElementById('cfg-search-api')?.value || 'baidu.official'
    },
    browser: {
      useGpu: document.getElementById('cfg-browser-gpu')?.checked === true
    },
    ui: {
      theme: selectedTheme
    },
    schedule: {
      enabled: document.getElementById('cfg-sched-enabled').checked,
      cron: document.getElementById('cfg-sched-cron').value.trim()
    },
    server: {
      authPassword: document.getElementById('cfg-auth-password')?.value.trim() || ''
    },
    notify: {
      proxy: notifyProxy,
      wework: document.getElementById('cfg-notify-wework').value.trim(),
      dingding: document.getElementById('cfg-notify-dingding').value.trim(),
      feishu: document.getElementById('cfg-notify-feishu').value.trim(),
      bark: document.getElementById('cfg-notify-bark').value.trim(),
      pushme: document.getElementById('cfg-notify-pushme').value.trim(),
      telegram: {
        botToken: document.getElementById('cfg-notify-tg-token').value.trim(),
        chatId: document.getElementById('cfg-notify-tg-chat').value.trim()
      },
      qqbot: {
        appId: document.getElementById('cfg-notify-qq-appid').value.trim(),
        clientSecret: document.getElementById('cfg-notify-qq-secret').value.trim(),
        openId: document.getElementById('cfg-notify-qq-openid').value.trim(),
        groupOpenId: document.getElementById('cfg-notify-qq-group-openid').value.trim()
      }
    }
  };

  setSaveStatus('', '正在保存...');
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateData)
  }).then(r => r.json());

  if (res.success) {
    currentConfig = res.data;
    cfgDraftTokens = null;
    const savedAccount = currentConfig.accounts?.find(account => account.id === currentAccId);
    renderRunHourGrid('cfg-run-hours', getAccountRunHours(savedAccount), { excludeAccountId: currentAccId });
    const cleared = currentConfig.scheduleConflicts?.find(item => item.id === currentAccId);
    setSaveStatus(
      cleared ? 'warn' : 'ok',
      cleared
        ? `⚠️ 时间档位与账号 [${cleared.occupiedByName || cleared.occupiedBy}] 冲突，已清空该账号勾选`
        : (runHours.length === 0
          ? '✅ 配置已保存；未选择运行时间，该账号自动任务已暂停'
          : '✅ 配置已保存并即时生效')
    );
    fetchStatus();
  } else {
    setSaveStatus('err', `保存失败：${res.message || '未知错误'}`);
  }
}

async function saveGuideNetworkSettings() {
  const useProxy = document.getElementById('guide-use-proxy').checked;
  const proxyUrl = document.getElementById('guide-proxy-url').value.trim();
  const lockRegion = document.getElementById('guide-lock-region').checked;
  const proxySelection = readProxySelection('guide-account-proxy-mode', 'guide-account-proxy-id');
  const result = document.getElementById('guide-proxy-result');
  if (useProxy && !proxyUrl) {
    if (result) result.innerHTML = '<span style="color:#EF4444;">已启用全局代理，请填写代理地址。</span>';
    return;
  }
  if (proxySelection.mode === 'proxy' && !proxySelection.proxyId) {
    if (result) result.innerHTML = '<span style="color:#EF4444;">当前账号选择了指定代理，请选择可用节点。</span>';
    return;
  }

  const button = document.getElementById('guide-btn-save-network');
  const originalText = button?.innerText || '';
  if (button) {
    button.disabled = true;
    button.innerText = '正在保存网络出口...';
  }
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ network: { useProxy, proxyUrl, lockRegion } })
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '网络配置保存失败');

    currentConfig = res.data;
    proxyDrafts = cloneProxyDrafts(currentConfig.network);
    guideDraftAccount.proxyMode = proxySelection.mode;
    guideDraftAccount.proxyId = proxySelection.proxyId;
    guideNetworkConfirmed = true;
    updateGuideProxyControls(proxySelection.proxyId);

    const routeText = describeProxySelection(proxySelection);
    const summary = `本次账号会话出口：${routeText}。后续 Cookie 测试与 Token 换取将使用该出口。`;
    document.getElementById('guide-token-network-summary').textContent = summary;
    document.getElementById('guide-cookie-network-summary').textContent = summary;
    if (result) result.innerHTML = `<span style="color:#34D399;">✅ 网络出口已保存：${escapeHtml(routeText)}</span>`;
    switchStep(2, { force: true });
  } catch (e) {
    guideNetworkConfirmed = false;
    if (result) result.innerHTML = `<span style="color:#EF4444;">保存失败：${escapeHtml(e.message)}</span>`;
  } finally {
    if (button) {
      button.disabled = false;
      button.innerText = originalText;
    }
  }
}

async function saveGuideSettings() {
  if (!guideNetworkConfirmed) {
    openEpicActionModal('请先确认网络出口', '必须先保存代理策略，才能绑定 Cookie 或 Token。', ['返回网络出口', '重新保存'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
    return;
  }
  if (getGuideCredentialMode() === 'vnc' && !guideDraftAccount.cookie) {
    openEpicActionModal('尚未获取登录凭据', '请先在第二步打开内置浏览器完成登录，或切换到手动填写模式。', ['返回登录', '切换手动填写'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '等待登录', cls: 'warn' } });
    return;
  }

  const runHours = readRunHours('guide-run-hours');
  const runHourConflict = findRunHourConflict(runHours[0]);
  if (runHourConflict) {
    renderRunHourGrid('guide-run-hours', []);
    openEpicActionModal(
      '运行时间已被占用',
      `该时间档位已分配给账号 [${runHourConflict.name || runHourConflict.id}]，请重新选择一个空闲档位。`,
      ['重新选择时间档位', '保存账号'],
      0
    );
    updateEpicActionModal({ progress: 100, badge: { text: '时间冲突', cls: 'warn' } });
    return;
  }

  // 1) 保存账号本身：名称 / 序号 / Cookie / Token / 时段
  //    以前这里只提交 account.timeSlot，会被 update() 写到第一个账号上，
  //    向导里填的名称和序号则完全没有保存过。
  const name = document.getElementById('guide-account-name')?.value.trim() || guideDraftAccount.name;
  const order = parseInt(document.getElementById('guide-account-order')?.value, 10) || guideDraftAccount.order;
  const cookie = document.getElementById('guide-cookie-input')?.value.trim() || guideDraftAccount.cookie;

  try {
    const accRes = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: guideDraftAccount.id,
        name,
        order,
        enabled: true,
        cookie,
        authCodeUrl: guideDraftAccount.authCodeUrl,
        refreshToken: guideDraftAccount.refreshToken,
        accessToken: guideDraftAccount.accessToken,
        tokenTime: guideDraftAccount.tokenTime,
    proxyMode: guideDraftAccount.proxyMode || 'direct',
        proxyId: guideDraftAccount.proxyId || '',
        runHours,
        tokenAlreadyExchanged: !!(guideDraftAccount.refreshToken && guideDraftAccount.accessToken),
        timeSlot: buildLegacyTimeSlot(runHours)
      })
    }).then(r => r.json());
    if (!accRes.success || !accRes.data?.id) {
      throw new Error(accRes.message || '账号保存失败');
    }
    selectedAccountId = accRes.data.id;
    if (accRes.scheduleCleared) {
      openEpicActionModal(
        '运行时间已被占用',
        `所选时间档位已分配给账号 [${accRes.data.scheduleConflict?.occupiedByName || '其他账号'}]，该账号的时间勾选已清空。未选择时间时自动任务不会启动。`,
        ['进入配置中心', '重新选择时间'],
        0
      );
      updateEpicActionModal({ progress: 100, badge: { text: '已暂停排期', cls: 'warn' } });
    }
  } catch (e) {
    openEpicActionModal('向导保存失败', e.message, ['保存账号资料', '校验网络出口'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '保存失败', cls: 'err' }, result: `保存失败：${e.message}` });
    return;
  }

  fetchConfig();
  fetchStatus();
  switchStep(4);
}

window.testNotifyChannel = async function(channel) {
  let val = '';
  if (channel === 'telegram') {
    const botToken = document.getElementById('cfg-notify-tg-token')?.value.trim();
    const chatId = document.getElementById('cfg-notify-tg-chat')?.value.trim();
    if (!botToken || !chatId) {
      openEpicActionModal('通知参数缺失', '请先输入 Telegram Bot Token 和 Chat ID。', ['填写参数', '重新测试'], 0);
      updateEpicActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
      return;
    }
    val = JSON.stringify({ botToken, chatId });
  } else if (channel === 'qqbot') {
    const appId = document.getElementById('cfg-notify-qq-appid')?.value.trim();
    const clientSecret = document.getElementById('cfg-notify-qq-secret')?.value.trim();
    const openId = document.getElementById('cfg-notify-qq-openid')?.value.trim();
    const groupOpenId = document.getElementById('cfg-notify-qq-group-openid')?.value.trim();
    if (!appId || !clientSecret) {
      openEpicActionModal('通知参数缺失', '请先输入 QQ 机器人 AppID 和 AppSecret。', ['填写参数', '重新测试'], 0);
      updateEpicActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
      return;
    }
    if (!openId && !groupOpenId) {
      openEpicActionModal('通知参数缺失', '请至少输入用户 OpenID 或群 OpenID 之一。', ['填写参数', '重新测试'], 0);
      updateEpicActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
      return;
    }
    val = JSON.stringify({ appId, clientSecret, openId, groupOpenId });
  } else {
    const idMap = {
      wework: 'cfg-notify-wework',
      dingding: 'cfg-notify-dingding',
      feishu: 'cfg-notify-feishu',
      bark: 'cfg-notify-bark',
      pushme: 'cfg-notify-pushme'
    };
    val = document.getElementById(idMap[channel])?.value.trim();
    if (!val) {
      openEpicActionModal('通知参数缺失', '请先输入配置的值。', ['填写参数', '重新测试'], 0);
      updateEpicActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
      return;
    }
  }
  const notifyProxy = readNotifyProxyConfig();
  if (notifyProxy.channels[channel] && !notifyProxy.url) {
    openEpicActionModal(
      '消息推送代理未填写',
      '当前渠道已勾选“使用推送代理”，请先填写消息推送专用代理地址。',
      ['填写推送代理', '重新测试'],
      0
    );
    updateEpicActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
    return;
  }

  openEpicActionModal('通知测试', `正在测试「${channel}」通知渠道...`, ['校验参数', '发送测试消息', '返回结果'], 0);
  startActionProgressTicker(15, 85, 10, `正在测试「${channel}」通知渠道...`);
  try {
    const res = await fetch('/api/notify/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, value: val, proxy: notifyProxy })
    }).then(r => r.json());
    stopActionProgressTicker();
    if (res.success) {
      updateEpicActionModal({ activeIndex: 3, progress: 100, badge: { text: '发送成功', cls: 'ok' }, message: '测试消息发送成功', result: `「${channel}」测试消息发送成功，请查收。` });
    } else {
      updateEpicActionModal({ progress: 100, badge: { text: '发送失败', cls: 'err' }, message: res.message || '测试发送失败', result: `测试发送失败：${res.message || '未知错误'}` });
    }
  } catch (e) {
    stopActionProgressTicker();
    updateEpicActionModal({ progress: 100, badge: { text: '测试异常', cls: 'err' }, message: e.message, result: `测试异常：${e.message}` });
  }
};

window.testNotifyProxy = async function() {
  const proxyUrl = document.getElementById('cfg-notify-proxy-url')?.value.trim() || '';
  if (!proxyUrl) {
    setNotifyProxyStatus('err', '❌ 请先填写消息推送专用代理地址');
    return;
  }
  setNotifyProxyStatus('', '⏳ 正在通过该代理查询出口 IP...');
  try {
    const res = await fetch('/api/proxy/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyUrl, useProxy: true })
    }).then(r => r.json());
    if (!res.success) {
      setNotifyProxyStatus('err', `❌ ${escapeHtml(res.message || '代理不可用')}`);
      return;
    }
    setNotifyProxyStatus(
      'ok',
      `✅ ${escapeHtml(res.ipInfo || '代理已连通')}<br>出口地区 ${escapeHtml(res.location || '未知')} · ${Number(res.latencyMs || 0)} ms`
    );
  } catch (e) {
    setNotifyProxyStatus('err', `❌ 测试请求失败：${escapeHtml(e.message)}`);
  }
};

window.checkTelegramConnection = async function() {
  const botToken = document.getElementById('cfg-notify-tg-token')?.value.trim() || '';
  const chatId = document.getElementById('cfg-notify-tg-chat')?.value.trim() || '';
  const proxy = readNotifyProxyConfig();
  const result = document.getElementById('telegram-check-result');
  const setResult = (kind, text) => {
    if (!result) return;
    result.className = `proxy-card-status${kind ? ` ${kind}` : ''}`;
    result.textContent = text;
  };
  if (!botToken) {
    setResult('err', '❌ 请先填写 Telegram Bot Token');
    return;
  }
  if (proxy.channels.telegram && !proxy.url) {
    setResult('err', '❌ 已启用推送代理，但尚未填写代理地址');
    return;
  }
  setResult('', '⏳ 正在只读检测 Telegram Bot 与 Chat ID...');
  try {
    const res = await fetch('/api/notify/telegram/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: { botToken, chatId },
        proxy
      })
    }).then(r => r.json());
    if (!res.success) {
      setResult('err', `❌ ${res.message || 'Telegram 连接检测失败'}`);
      return;
    }
    const data = res.data || {};
    const chatText = data.chatValid
      ? `Chat ID 可用（${data.chatType || '未知类型'}）`
      : `Chat ID 不可用：${data.chatError || '未填写'}`;
    setResult(
      data.chatValid ? 'ok' : 'warn',
      `Bot @${data.botUsername || 'unknown'} · Telegram API ${Number(data.latencyMs || 0)} ms · ${chatText}`
    );
  } catch (e) {
    setResult('err', `❌ 检测请求失败：${e.message}`);
  }
};

// 账号体检：根据范围选择分发到「单个账号」或「全部账号」
function syncDiagScopeUI() {
  document.querySelectorAll('#diag-scope-group .diag-scope-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === diagMode);
  });
  const selectWrap = document.getElementById('diag-account-select');
  if (selectWrap) selectWrap.style.display = diagMode === 'single' ? '' : 'none';
}

function populateDiagAccountSelect() {
  const select = document.getElementById('diag-account-select');
  if (!select) return;
  const accounts = currentConfig?.accounts || [];
  if (!diagAccountId || !accounts.some(a => a.id === diagAccountId)) {
    diagAccountId = accounts[0]?.id || 'acc_1';
  }
  select.innerHTML = accounts.map(a =>
    `<option value="${a.id}" ${a.id === diagAccountId ? 'selected' : ''}>${escapeHtml(a.name || a.id)}</option>`
  ).join('');
}

function setDiagMode(mode) {
  diagMode = mode === 'all' ? 'all' : 'single';
  syncDiagScopeUI();
  if (diagMode === 'single') populateDiagAccountSelect();
  runAccountDiagnosis();
}

async function runAccountDiagnosis() {
  syncDiagScopeUI();
  if (diagMode === 'single') {
    populateDiagAccountSelect();
    await runSingleAccountDiagnosis(diagAccountId);
  } else {
    await runAllAccountDiagnosis();
  }
}

function setDiagLoading(show, text) {
  const loading = document.getElementById('diag-loading');
  const content = document.getElementById('diag-content');
  const loadingText = document.getElementById('diag-loading-text');
  if (loadingText && text) loadingText.innerText = text;
  if (loading) loading.style.display = show ? 'block' : 'none';
  if (content) content.style.display = show ? 'none' : 'block';
}

// 单个账号：完整的三维检测详情
async function runSingleAccountDiagnosis(accountId) {
  setDiagLoading(true, '正在全面请求微软官方接口检测当前 Docker 中的登录态...');
  document.getElementById('diag-all-summary').style.display = 'none';
  document.getElementById('diag-all-list').style.display = 'none';
  document.getElementById('diag-banner').style.display = '';
  document.getElementById('diag-cards').style.display = '';
  document.querySelector('.diag-summary-box').style.display = '';
  document.getElementById('diag-tips').style.display = '';

  const targetId = accountId
    || (selectedAccountId !== 'all' ? selectedAccountId : (currentConfig?.accounts?.[0]?.id || 'acc_1'));

  try {
    const res = await fetch('/api/auth/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: targetId })
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '诊断接口异常');

    const data = res.data;
    const cookie = data.cookie || {};
    const token = data.token || {};
    const net = data.network || {};
    const accName = data.accountName || '当前账号';

    // 1. 综合 Banner
    const banner = document.getElementById('diag-banner');
    const bIcon = document.getElementById('diag-banner-icon');
    const bTitle = document.getElementById('diag-banner-title');
    const bSub = document.getElementById('diag-banner-sub');

    if (data.allValid && net.regionPass) {
      banner.className = 'diag-banner ok';
      bIcon.innerText = '🟢';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 登录完全正常 (双端在线)`;
      bSub.innerText = '当前 Docker 环境已完美就绪，所有任务通道与网络环境均处于最佳状态！';
    } else if (data.warning) {
      banner.className = 'diag-banner partial';
      bIcon.innerText = '🟡';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 已登录，但 Cookie 存在异常`;
      bSub.innerText = data.warningMessage || '网页端 Cookie 缺少 _U 标头，PC 搜索不会计分，请重新抓取完整 Cookie。';
    } else if (data.overallValid) {
      banner.className = 'diag-banner partial';
      bIcon.innerText = '🟡';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 部分登录有效`;
      bSub.innerText = '部分通道已连接，但仍有项未就绪（如网页端或移动端单边未登录），请根据下方提示补充。';
    } else {
      banner.className = 'diag-banner failed';
      bIcon.innerText = '🔴';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 尚未成功在 Docker 中登录`;
      bSub.innerText = '未检测到有效的微软登录凭据，请点击右上角「新手配置向导」进行绑定。';
    }

    // 2. 网页端 Cookie 卡片
    const pillCookie = document.getElementById('diag-pill-cookie');
    const detailCookie = document.getElementById('diag-detail-cookie');
    if (cookie.valid && cookie.warning) {
      pillCookie.className = 'diag-status-pill pill-warn';
      pillCookie.innerText = '已登录 · 需修复';
      detailCookie.innerHTML = `
        <div style="color:#F59E0B;">状态：⚠️ 身份认证有效，但 Cookie 不完整 —— ${escapeHtml(cookie.warningMessage || '缺少 _U 登录标头')}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">建议：在电脑登录 rewards.bing.com/dashboard 后重新抓取完整 Cookie（必须包含 _U），否则 PC 搜索不会计分。</div>
      `;
    } else if (cookie.valid) {
      pillCookie.className = 'diag-status-pill pill-ok';
      pillCookie.innerText = '已登录正常';
      detailCookie.innerHTML = `
        <div>状态：✅ 身份认证有效，可执行 PC 搜索、每日活动集与桌面专属任务</div>
        <div style="margin-top:4px; color:#E2E8F0;">${escapeHtml(cookie.message || '')}</div>
      `;
    } else {
      pillCookie.className = 'diag-status-pill pill-err';
      pillCookie.innerText = '未登录 / 失效';
      detailCookie.innerHTML = `
        <div style="color:#F87171;">状态：❌ ${escapeHtml(cookie.message || 'Cookie 缺失或已失效')}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">建议：在电脑登录 rewards.bing.com/dashboard，按 F12 复制完整 Cookie 粘贴到配置中心。</div>
      `;
    }

    // 3. 移动端 Token 卡片
    const pillToken = document.getElementById('diag-pill-token');
    const detailToken = document.getElementById('diag-detail-token');
    if (token.valid) {
      pillToken.className = 'diag-status-pill pill-ok';
      pillToken.innerText = '已授权正常';
      detailToken.innerHTML = `
        <div>状态：✅ OAuth Token 活跃，可执行 App 静默签到与新闻资讯阅读 (30分)</div>
        <div style="margin-top:4px; color:#E2E8F0;">${escapeHtml(token.message || '')}</div>
      `;
    } else {
      pillToken.className = 'diag-status-pill pill-err';
      pillToken.innerText = '未授权 / 失效';
      detailToken.innerHTML = `
        <div style="color:#F87171;">状态：❌ ${escapeHtml(token.message || '未获取到移动端 OAuth 授权')}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">建议：点击「新手配置向导」第一步，打开官方链接授权并粘贴跳转 URL。</div>
      `;
    }

    // 4. 网络卡片
    const pillNet = document.getElementById('diag-pill-network');
    const detailNet = document.getElementById('diag-detail-network');
    const networkRoute = net.proxyUsed
      ? `代理：${escapeHtml(net.proxy?.name || '指定代理')}`
      : '直连（未使用代理）';
    if (net.regionPass) {
      pillNet.className = 'diag-status-pill pill-ok';
      pillNet.innerText = '中国大陆 (安全)';
      detailNet.innerHTML = `
        <div>状态：✅ 出口 IP 符合微软国区要求 (${net.region})，防风控检测通过</div>
        <div style="margin-top:4px; color:#E2E8F0;">当前访问 IP：<strong style="font-family:ui-monospace,monospace;">${escapeHtml(net.ip || '未知')}</strong> · ${escapeHtml(net.location || '归属地未知')}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">${networkRoute}</div>
      `;
    } else {
      pillNet.className = 'diag-status-pill pill-err';
      pillNet.innerText = `非大陆地区 (${net.region || '未知'})`;
      detailNet.innerHTML = `
        <div style="color:#F87171;">状态：⚠️ 出口位于非大陆地区，若开启国区保护将被自动停止打卡防风控。</div>
        <div style="margin-top:4px; color:#E2E8F0;">当前访问 IP：<strong style="font-family:ui-monospace,monospace;">${escapeHtml(net.ip || '未知')}</strong> · ${escapeHtml(net.location || '归属地未知')}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">${networkRoute}。建议在配置中心为该账号选择国内 HTTP / SOCKS5 代理。</div>
      `;
    }

    // 5. 数据概览明细
    document.getElementById('diag-val-balance').innerText = data.balance ? `${data.balance.toLocaleString()} 积分` : '--';
    document.getElementById('diag-val-search').innerText = cookie.pcSearch || '--';
    document.getElementById('diag-val-read').innerText = token.readProgress || '--';

    // 6. 建议区
    const tipsBox = document.getElementById('diag-tips');
    if (data.allValid) {
      tipsBox.innerHTML = `💡 <strong>检测完毕：</strong>账号 [${escapeHtml(accName)}] 在 Docker 中运行环境完美，点击「▶️ 立即执行」即可开始打卡！`;
    } else {
      tipsBox.innerHTML = '💡 <strong>下一步建议：</strong>请点击右上角「💡 新手配置向导」，根据缺失的项（Cookie 或 Token）补充配置即可。';
    }

    setDiagLoading(false);

    // 同步刷新大屏
    fetchStatus();
  } catch (e) {
    setDiagLoading(false);
    document.getElementById('diag-banner-title').innerText = '诊断请求失败';
    document.getElementById('diag-banner-sub').innerText = e.message;
  }
}

// 全部账号：逐个串行体检，并在账号间严格执行安全防风控强制间隔
async function runAllAccountDiagnosis() {
  const accounts = (currentConfig?.accounts || []).filter(a => a.enabled !== false);
  document.getElementById('diag-banner').style.display = 'none';
  document.getElementById('diag-cards').style.display = 'none';
  document.querySelector('.diag-summary-box').style.display = 'none';
  document.getElementById('diag-tips').style.display = 'none';
  document.getElementById('diag-all-summary').style.display = 'none';
  document.getElementById('diag-all-list').style.display = 'none';

  if (accounts.length === 0) {
    setDiagLoading(false);
    document.getElementById('diag-all-summary').style.display = 'block';
    document.getElementById('diag-all-summary').innerText = '当前没有可体检的启用账号。';
    return;
  }

  const results = [];
  const gapSec = Math.max(15, parseInt(document.getElementById('cfg-account-gap')?.value, 10) || (currentConfig?.tasks?.accountGapSec ?? 30));

  try {
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      setDiagLoading(true, `正在检测账号登录状态 (${i + 1}/${accounts.length}): ${acc.name || acc.id}...`);
      try {
        const res = await fetch('/api/auth/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: acc.id, force: true })
        }).then(r => r.json());

        if (res.success && res.data) {
          results.push(res.data);
        } else {
          results.push({
            accountId: acc.id,
            accountName: acc.name || acc.id,
            cookie: { valid: false, message: res.message || '体检未通过' },
            token: { valid: false, message: res.message || '体检未通过' },
            overallValid: false,
            allValid: false,
            balance: 0,
            error: res.message || '接口返回失败'
          });
        }
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

      // 多账号体检强制安全隔离倒计时：在界面清晰展示等待时间
      if (i < accounts.length - 1) {
        for (let s = gapSec; s > 0; s--) {
          setDiagLoading(true, `🛡️ 多账号防风控隔离：等待 ${s} 秒后检测下一个账号 (${i + 2}/${accounts.length}: ${accounts[i + 1].name || accounts[i + 1].id})...`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
    renderAllAccountDiagnosisResults(results);
  } catch (e) {
    const summaryBox = document.getElementById('diag-all-summary');
    summaryBox.style.display = 'block';
    summaryBox.innerHTML = `<span style="color:#EF4444;">体检失败: ${escapeHtml(e.message)}</span>`;
  } finally {
    setDiagLoading(false);
    fetchStatus();
  }
}

function renderAllAccountDiagnosisResults(results) {
  const summaryBox = document.getElementById('diag-all-summary');
  const listBox = document.getElementById('diag-all-list');
  const validCount = results.filter(r => r.allValid).length;
  const partialCount = results.filter(r => r.overallValid && !r.allValid).length;
  const failedCount = results.length - validCount - partialCount;
  summaryBox.style.display = 'block';
  summaryBox.innerHTML = `共体检 <strong>${results.length}</strong> 个账号：`
    + `<span style="color:#34D399; font-weight:700;">完全有效 ${validCount}</span> / `
    + `<span style="color:#F59E0B; font-weight:700;">部分有效 ${partialCount}</span> / `
    + `<span style="color:#F87171; font-weight:700;">失效 ${failedCount}</span>`;
  listBox.style.display = 'flex';
  listBox.innerHTML = results.map(r => {
    const name = escapeHtml(r.accountName || r.accountId || '未知账号');
    const cookieOk = !!r.cookie?.valid;
    const tokenOk = !!r.token?.valid;
    const overallOk = !!r.overallValid;
    const err = r.error ? ` · ${escapeHtml(r.error)}` : '';
    const cls = overallOk ? 'pill-ok' : 'pill-err';
    const statusText = overallOk ? (r.allValid ? '整体有效' : '部分有效') : '失效';
    return `
      <div class="diag-all-row">
        <span class="diag-all-name">${name}</span>
        <span class="diag-status-pill ${cookieOk ? 'pill-ok' : 'pill-err'}">Cookie ${cookieOk ? '有效' : '失效'}</span>
        <span class="diag-status-pill ${tokenOk ? 'pill-ok' : 'pill-err'}">Token ${tokenOk ? '有效' : '失效'}</span>
        <span class="diag-status-pill ${cls}">${statusText}</span>
        <span class="diag-all-detail">${r.balance ? r.balance.toLocaleString() + ' 分' : '--'}${err}</span>
      </div>
    `;
  }).join('');
}

// 切换历史记录天数 (7 日 / 30 日)
function switchHistoryDays(days) {
  currentHistoryDays = days;
  document.getElementById('btn-history-7')?.classList.toggle('active', days === 7);
  document.getElementById('btn-history-30')?.classList.toggle('active', days === 30);
  fetchHistory(days, selectedAccountId);
}

// 拉取历史记录数据 (支持单账号与全局汇总)
async function fetchHistory(days = 7, accId = selectedAccountId) {
  try {
    const target = accId || 'all';
    const res = await fetch(`/api/history?days=${days}&accountId=${target}`).then(r => r.json());
    if (res.success && Array.isArray(res.data)) {
      renderHistoryChart(res.data, days);
    }
  } catch (e) {
    console.error('获取历史记录失败:', e);
  }
}

// 渲染历史柱形图与 Hover Tooltip
function renderHistoryChart(dataList, days) {
  const container = document.getElementById('history-chart-container');
  const tooltip = document.getElementById('history-tooltip');
  if (!container || !tooltip) return;

  container.innerHTML = '';
  if (dataList.length === 0) return;

  // 计算最大值，方便归一化高度
  const maxEarned = Math.max(...dataList.map(d => d.earned || 0), 160);

  dataList.forEach((item, index) => {
    const isToday = index === dataList.length - 1;
    const heightPercent = Math.max(12, Math.min(100, Math.round((item.earned / maxEarned) * 100)));

    const col = document.createElement('div');
    col.className = `chart-col ${isToday ? 'today' : ''}`;

    col.innerHTML = `
      <div class="chart-val-hint">+${item.earned}</div>
      <div class="chart-bar-wrap">
        <div class="chart-bar" style="height: ${heightPercent}%;"></div>
      </div>
      <div class="chart-date-label">${days === 30 ? (index % 4 === 0 || isToday ? item.dayLabel : '') : item.dayLabel}</div>
    `;

    // Hover 交互
    const showTooltip = (e) => {
      document.getElementById('tt-date').innerText = `${item.date} (${item.weekday})`;
      document.getElementById('tt-earned').innerText = `+${item.earned} 积分`;
      
      const bdList = document.getElementById('tt-breakdown');
      const accList = Array.isArray(item.accounts) ? item.accounts : null;

      if (accList && accList.length > 0) {
        // 全部账号汇总模式：显示每个账号的当日数值与占比
        const total = Number(item.earned || 0);
        const rows = [...accList].sort((a, b) => Number(b.earned || 0) - Number(a.earned || 0));
        bdList.innerHTML = `
          <div class="tooltip-section-title">各账号占比（${rows.length} 个账号）</div>
          ${rows.map(a => {
            const earned = Number(a.earned || 0);
            const pct = total > 0 ? (earned / total) * 100 : 0;
            return `
              <div class="tooltip-item">
                <span class="tt-acc-name">👤 ${escapeHtml(a.name)}</span>
                <span class="tt-acc-val">+${earned}<em>${pct.toFixed(1)}%</em></span>
              </div>`;
          }).join('')}
        `;
      } else if (item.breakdown && item.breakdown.length > 0) {
        bdList.innerHTML = item.breakdown.map(b => `
          <div class="tooltip-item">
            <span>${b.icon || '📌'} ${b.name}</span>
            <span style="font-weight: 600; color: #34D399;">+${b.points}</span>
          </div>
        `).join('');
      } else {
        bdList.innerHTML = '<div style="color:#64748B;">打卡任务已满额到账</div>';
      }

      document.getElementById('tt-balance').innerText = `当日结余: ${(item.balance || 0).toLocaleString()} 积分`;

      tooltip.style.display = 'block';

      // 先显示再测量，保证多账号长列表时提示框不会被视口裁掉
      const barEl = col.querySelector('.chart-bar') || col;
      const rect = barEl.getBoundingClientRect();
      const tipRect = tooltip.getBoundingClientRect();
      const tipW = tipRect.width;
      const tipH = tipRect.height;
      const centerX = Math.max(
        tipW / 2 + 8,
        Math.min(window.innerWidth - tipW / 2 - 8, rect.left + rect.width / 2)
      );
      let top = rect.top - tipH - 12;
      if (top < 8) top = rect.bottom + 12; // 上方放不下就改放到柱子下方
      if (top + tipH > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - tipH - 8);
      }
      tooltip.style.left = `${centerX - tipW / 2}px`;
      tooltip.style.top = `${top}px`;
    };

    col.addEventListener('mouseenter', showTooltip);
    col.addEventListener('mousemove', showTooltip);
    col.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });

    container.appendChild(col);
  });
}

// 测试词库来源并展示明细
async function handleTestSearchApi() {
  const selectElem = document.getElementById('cfg-search-api');
  const selectedMode = selectElem?.value || 'offline';
  const statusDiv = document.getElementById('words-modal-status');
  const tagsDiv = document.getElementById('words-modal-tags');
  
  openModal('search-words-modal');
  statusDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在请求并测试所选词库接口...</span>';
  tagsDiv.innerHTML = '';

  try {
    const res = await fetch('/api/tasks/test-search-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchApi: selectedMode })
    }).then(r => r.json());

    if (res.success && Array.isArray(res.sample)) {
      statusDiv.innerHTML = `<span style="color:#34D399; font-weight:700;">✅ [${escapeHtml(res.name)}] 接口通畅！成功抓取 ${res.count} 条热词，前 ${res.sample.length} 条明细预览：</span>`;
      tagsDiv.innerHTML = res.sample.map((w, i) => `
        <span style="font-size:12px; padding:4px 9px; background:var(--card-bg); border:1px solid var(--border-color); border-radius:6px; color:var(--text-main);">
          ${i + 1}. ${escapeHtml(w)}
        </span>
      `).join('');
    } else {
      statusDiv.innerHTML = `<span style="color:#F87171; font-weight:700;">❌ [${escapeHtml(res.name || selectedMode)}] 获取失败: ${escapeHtml(res.message || '未知错误')}</span>`;
      tagsDiv.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">未能获取到有效词条，建议切换回「本地离线智能词库（最稳定）」。</span>';
    }
  } catch (e) {
    statusDiv.innerHTML = `<span style="color:#F87171;">❌ 请求异常: ${escapeHtml(e.message)}</span>`;
  }
}

// ===== Epic 免费游戏领取 =====
let epicAccountCache = [];
let epicGamesCache = [];
let epicSettingsCache = {};
let epicStatusCache = {};

function getEpicInitial(name) {
  return Array.from(String(name || 'E').trim())[0]?.toUpperCase() || 'E';
}

function getEpicCoverHue(title) {
  let hash = 0;
  for (const ch of String(title || '')) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return hash;
}

function formatEpicShortTime(ts) {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '--';
  }
}

function formatEpicDeadline(value) {
  if (!value) return '结束时间待公布';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '结束时间待公布';
  const text = date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const remainMs = date.getTime() - Date.now();
  if (remainMs <= 0) return `${text} · 已结束`;
  const days = Math.max(1, Math.ceil(remainMs / 86400000));
  return `${text} · 剩 ${days} 天`;
}

function formatEpicUpcomingDeadline(startDate) {
  if (!startDate) return '即将推出';
  const d = new Date(startDate);
  if (Number.isNaN(d.getTime())) return '即将推出';
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${m}月${day}日 ${h}:${min} 解锁免费`;
}

function getEpicGameProgress(game) {
  if (game.isUpcoming) {
    return { cls: 'pending', text: '预告待开放' };
  }
  const enabledAccounts = epicAccountCache.filter(a => a.enabled !== false);
  const handled = enabledAccounts.filter(a => {
    if ((a.handledGameIds || []).includes(game.id)) return true;
    if (a.handledGames && (a.handledGames[game.id] || Object.values(a.handledGames).some(v => v.title === game.title))) return true;
    return false;
  }).length;
  if (enabledAccounts.length > 0 && handled >= enabledAccounts.length) {
    return { cls: 'complete', text: `已全入库 (${handled}/${enabledAccounts.length})` };
  }
  if (handled > 0) return { cls: 'partial', text: `已处理 ${handled}/${enabledAccounts.length}` };
  return { cls: 'pending', text: enabledAccounts.length > 0 ? '待领取' : '等待添加账号' };
}

function getEpicNextCheckText() {
  if (!epicSettingsCache.enabled || !epicStatusCache.lastCheckAt || !epicSettingsCache.checkIntervalMin) return '';
  const nextAt = epicStatusCache.lastCheckAt + Number(epicSettingsCache.checkIntervalMin) * 60000;
  if (nextAt <= Date.now()) return '即将';
  return formatEpicShortTime(nextAt);
}

function renderEpicStats() {
  const enabledAccounts = epicAccountCache.filter(a => a.enabled !== false);
  const pendingCount = epicGamesCache.filter(game => {
    const handled = enabledAccounts.filter(a => (a.handledGameIds || []).includes(game.id)).length;
    return enabledAccounts.length === 0 || handled < enabledAccounts.length;
  }).length;

  const gamesEl = document.getElementById('epic-stat-games');
  const pendingEl = document.getElementById('epic-stat-pending');
  const accountsEl = document.getElementById('epic-stat-accounts');
  const checkedEl = document.getElementById('epic-stat-checked');
  const checkedLabel = document.getElementById('epic-stat-checked-label');
  const demoBanner = document.getElementById('epic-demo-banner');

  if (gamesEl) gamesEl.innerText = epicGamesCache.length;
  if (pendingEl) pendingEl.innerText = pendingCount;
  if (accountsEl) {
    accountsEl.innerText = enabledAccounts.length;
    accountsEl.title = `共 ${epicAccountCache.length} 个账号，${enabledAccounts.length} 个已启用`;
  }
  if (checkedEl) checkedEl.innerText = epicStatusCache.lastCheckAt ? formatEpicShortTime(epicStatusCache.lastCheckAt) : '尚未检查';
  const nextCheck = getEpicNextCheckText();
  if (checkedLabel) checkedLabel.innerText = nextCheck ? `下次检查 ${nextCheck}` : '上次检查';
  if (demoBanner) demoBanner.style.display = epicStatusCache.demo ? 'flex' : 'none';
}

function initEpicUI() {
  document.getElementById('btn-epic-add')?.addEventListener('click', () => openEpicModal(null));
  document.getElementById('btn-close-epic-modal')?.addEventListener('click', closeEpicAccountModal);
  document.getElementById('btn-cancel-epic-modal')?.addEventListener('click', closeEpicAccountModal);
  document.getElementById('btn-save-epic-modal')?.addEventListener('click', saveEpicAccount);
  document.getElementById('btn-epic-open-login')?.addEventListener('click', openEpicLoginWindow);
  document.getElementById('btn-epic-save-login')?.addEventListener('click', saveEpicLoginWindow);
  document.getElementById('btn-epic-import-session')?.addEventListener('click', importEpicSession);
  document.getElementById('btn-epic-vnc')?.addEventListener('click', () => openNovncModal('Epic 可见浏览器'));
  document.getElementById('btn-epic-fingerprint')?.addEventListener('click', openEpicFingerprintModal);
  document.getElementById('btn-refresh-fingerprint')?.addEventListener('click', loadEpicFingerprint);
  document.getElementById('btn-close-fingerprint')?.addEventListener('click', () => closeModal('epic-fingerprint-modal'));
  document.getElementById('btn-close-fingerprint-btn')?.addEventListener('click', () => closeModal('epic-fingerprint-modal'));
  document.getElementById('btn-epic-claim-all')?.addEventListener('click', () => claimEpic(null));
  document.getElementById('btn-epic-refresh-games')?.addEventListener('click', () => fetchEpicFreeGames(true));
  document.getElementById('btn-epic-save-settings')?.addEventListener('click', saveEpicSettings);
  document.getElementById('btn-epic-stop')?.addEventListener('click', stopEpicTask);
  document.getElementById('btn-close-novnc')?.addEventListener('click', () => {
    if (novncMode === 'microsoft') closeMicrosoftVncSession();
    else closeNovncModal();
  });
  document.getElementById('btn-close-novnc-btn')?.addEventListener('click', () => {
    if (novncMode === 'microsoft') closeMicrosoftVncSession();
    else closeNovncModal();
  });
  document.getElementById('btn-cancel-novnc-session')?.addEventListener('click', closeMicrosoftVncSession);
  document.getElementById('btn-refresh-novnc')?.addEventListener('click', refreshNovncModal);
  document.getElementById('btn-maximize-novnc')?.addEventListener('click', toggleNovncMaximize);
  document.getElementById('btn-novnc-save-login')?.addEventListener('click', () => {
    if (novncMode === 'microsoft') {
      if (latestMicrosoftVncData) {
        closeMicrosoftVncSession();
      } else {
        captureMicrosoftLoginWindow();
      }
    }
    else saveEpicLoginWindow();
  });
  document.getElementById('chk-novnc-auto-close')?.addEventListener('change', (e) => {
    setVncAutoCloseEnabled(e.target.checked);
  });
  document.getElementById('btn-close-epic-celebration')?.addEventListener('click', closeEpicCelebration);
  document.getElementById('epic-celebration')?.addEventListener('click', event => {
    if (event.target?.id === 'epic-celebration') closeEpicCelebration();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById('epic-celebration')?.classList.contains('show')) {
      closeEpicCelebration();
    }
  });

  // 商店检测周期预设（常规每周 vs 节日每日）
  document.querySelectorAll('.cycle-pill').forEach(btn => {
    btn.addEventListener('click', async () => {
      const min = Number(btn.getAttribute('data-min'));
      document.querySelectorAll('.cycle-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const intervalInput = document.getElementById('epic-set-interval');
      if (intervalInput) intervalInput.value = min;
      try {
        const res = await fetch('/api/epic/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checkIntervalMin: min })
        }).then(r => r.json());
        if (res.success) {
          epicSettingsCache = res.data;
          renderEpicStats();
        }
      } catch {}
    });
  });

  // Epic 页激活时轮询浏览器状态，方便判断是否卡死
  setInterval(() => {
    if (document.getElementById('tab-panel-epic')?.classList.contains('active')) {
      fetchEpicStatus();
    }
  }, 3000);
}

function formatEpicTime(ts) {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '--';
  }
}

async function fetchEpicAccounts() {
  try {
    const res = await fetch('/api/epic/accounts').then(r => r.json());
    if (res.success) {
      epicAccountCache = res.data || [];
      renderEpicAccounts(epicAccountCache);
      if (epicGamesCache && epicGamesCache.length > 0) renderEpicGames(epicGamesCache);
    }
  } catch {}
}

function renderEpicAccounts(accounts) {
  const grid = document.getElementById('epic-accounts-grid');
  const empty = document.getElementById('epic-empty');
  if (!grid) return;
  if (!accounts || accounts.length === 0) {
    grid.innerHTML = '';
    if (empty) empty.style.display = 'block';
    renderEpicStats();
    return;
  }
  if (empty) empty.style.display = 'none';

  grid.innerHTML = accounts.map(a => {
    const sessionBadge = !a.hasSession
      ? '<span class="epic-badge warn">未导入会话</span>'
      : a.sessionValid === true
        ? '<span class="epic-badge ok">会话有效</span>'
        : a.sessionValid === false
          ? '<span class="epic-badge err">会话失效</span>'
          : '<span class="epic-badge idle">未校验</span>';
    const enabledBadge = a.enabled ? '<span class="epic-badge ok">已启用</span>' : '<span class="epic-badge idle">已停用</span>';
    const handledCount = (a.handledGameIds || []).length;
    const verifyTip = a.lastVerifyMessage ? ` title="${escapeHtml(a.lastVerifyMessage)}"` : '';
    return `
      <div class="epic-account-card">
        <div class="epic-account-top">
          <div class="epic-account-identity">
            <span class="epic-account-avatar">${escapeHtml(getEpicInitial(a.name))}</span>
            <span class="epic-account-copy">
              <span class="epic-account-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
              <span class="epic-account-order">Epic 账号 #${escapeHtml(String(a.order || '-'))}</span>
            </span>
          </div>
          <span class="epic-account-badges">${enabledBadge}${sessionBadge}</span>
        </div>
        <div class="epic-account-meta">
          <div class="epic-account-meta-item">
            <span>会话凭据</span>
            <strong>${a.cookieCount || 0} 条${a.hasEpicSession ? ' · 含登录态' : ''}</strong>
          </div>
          <div class="epic-account-meta-item"${verifyTip}>
            <span>上次校验</span>
            <strong>${formatEpicTime(a.lastVerifyAt)}</strong>
          </div>
          <div class="epic-account-meta-item">
            <span>已处理游戏</span>
            <strong>${handledCount} 个</strong>
          </div>
          <div class="epic-account-meta-item">
            <span>上次领取</span>
            <strong>${formatEpicTime(a.lastClaimAt)}</strong>
          </div>
        </div>
        <div class="epic-account-actions">
          <button class="btn btn-primary btn-sm epic-claim" data-id="${escapeHtml(a.id)}" title="为这个账号领取">▶️ 领取</button>
          <button class="btn btn-secondary btn-sm epic-verify" data-id="${escapeHtml(a.id)}" title="校验浏览器会话">🔍 校验</button>
          <button class="btn btn-secondary btn-sm epic-import" data-id="${escapeHtml(a.id)}" title="编辑账号名称或更新浏览器会话 Cookie">✏️ 编辑</button>
          <button class="btn btn-secondary btn-sm epic-toggle" data-id="${escapeHtml(a.id)}" title="${a.enabled ? '停用此账号' : '启用此账号'}">${a.enabled ? '⏸️ 停用' : '▶️ 启用'}</button>
          <button class="btn btn-danger btn-sm epic-delete" data-id="${escapeHtml(a.id)}" title="删除此账号">🗑️ 删除</button>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.epic-claim').forEach(b => b.addEventListener('click', () => claimEpic(b.getAttribute('data-id'))));
  grid.querySelectorAll('.epic-verify').forEach(b => b.addEventListener('click', () => verifyEpicSession(b.getAttribute('data-id'))));
  grid.querySelectorAll('.epic-import').forEach(b => b.addEventListener('click', () => openEpicModal(b.getAttribute('data-id'))));
  grid.querySelectorAll('.epic-toggle').forEach(b => b.addEventListener('click', () => toggleEpicAccount(b.getAttribute('data-id'))));
  grid.querySelectorAll('.epic-delete').forEach(b => b.addEventListener('click', () => deleteEpicAccount(b.getAttribute('data-id'))));

  renderEpicStats();
  if (epicStatusCache.records) renderEpicRecords(epicStatusCache.records);
}

function renderEpicGames(games) {
  const list = document.getElementById('epic-games-list');
  const updated = document.getElementById('epic-games-updated');
  if (!list) return;
  epicGamesCache = Array.isArray(games) ? games : [];
  if (updated) updated.innerText = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 共 ${epicGamesCache.length} 款游戏`;
  if (!games || games.length === 0) {
    list.innerHTML = '<div class="epic-empty">当前没有可领取的免费游戏</div>';
    renderEpicStats();
    return;
  }

  const nowFree = epicGamesCache.filter(g => g.isFreeNow !== false && !g.isUpcoming);
  const upcoming = epicGamesCache.filter(g => g.isUpcoming || g.isFreeNow === false);

  const renderCard = (g) => {
    const isUpcoming = !!g.isUpcoming;
    const progress = getEpicGameProgress(g);
    const cover = g.image
      ? `<img src="${escapeHtml(g.image)}" alt="${escapeHtml(g.title)}" loading="lazy">`
      : `<div class="epic-game-cover-fallback"><span>${escapeHtml(getEpicInitial(g.title))}</span><small>${isUpcoming ? 'COMING SOON' : 'FREE GAME'}</small></div>`;
    const link = g.url
      ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(g.url)}" target="_blank" rel="noopener">${isUpcoming ? '预告页面' : '打开商店'}</a>`
      : '';

    // 悬停各账号在库详情与领取时间
    const accountRows = (epicAccountCache || []).map(a => {
      const rec = a.handledGames?.[g.id]
        || (a.handledGames && Object.values(a.handledGames).find(v => v.title === g.title));
      let statusCls = 'pending';
      let label = '⏳ 尚未入库 / 待领取';
      let timeText = '';
      if (isUpcoming) {
        label = '⏳ 尚未解锁 (开放后自动领取)';
      } else if (rec) {
        if (rec.status === 'claimed') {
          statusCls = 'claimed';
          label = '✅ 自动化已领取';
          const at = rec.at ? new Date(rec.at).toLocaleString('zh-CN', { hour12: false }) : '';
          timeText = at ? `领取时间: ${at}` : '';
        } else if (rec.status === 'owned') {
          statusCls = 'owned';
          label = '📦 原已在库中';
          const at = rec.at ? new Date(rec.at).toLocaleDateString('zh-CN') : '';
          timeText = at ? `核验于: ${at}` : '';
        }
      }
      return `
        <div class="epic-tooltip-row">
          <div class="epic-tooltip-acc ${statusCls}">
            <span>👤 ${escapeHtml(a.name || a.id)}</span>
            <span>${escapeHtml(label)}</span>
          </div>
          ${timeText ? `<span class="epic-tooltip-time">${escapeHtml(timeText)}</span>` : ''}
        </div>
      `;
    }).join('');

    const deadlineText = isUpcoming
      ? `<span>⏳</span> ${escapeHtml(formatEpicUpcomingDeadline(g.startDate, g.endDate))}`
      : `<span>⏳</span> ${escapeHtml(formatEpicDeadline(g.endDate))}`;

    const freeTagCls = isUpcoming ? 'epic-game-free-tag tag-upcoming' : 'epic-game-free-tag tag-now';
    const freeTagText = isUpcoming ? '即将推出' : '限时免费';

    return `
      <article class="epic-game-card${isUpcoming ? ' card-upcoming' : ''}">
        <div class="epic-game-tooltip">
          <div class="epic-tooltip-title">${escapeHtml(g.title)} · 各账号在库状态</div>
          <div class="epic-tooltip-list">
            ${accountRows || '<div class="epic-tooltip-row"><span class="epic-tooltip-time">暂未配置任何 Epic 账号</span></div>'}
          </div>
        </div>
        <div class="epic-game-cover" style="--cover-h: ${getEpicCoverHue(g.title)};">
          ${cover}
          <span class="${freeTagCls}">${freeTagText}</span>
        </div>
        <div class="epic-game-card-body">
          <div class="epic-game-card-title" title="${escapeHtml(g.title)}">${escapeHtml(g.title)}</div>
          <div class="epic-game-card-deadline">${deadlineText}</div>
        </div>
        <div class="epic-game-card-footer">
          <span class="epic-game-status ${progress.cls}">● ${escapeHtml(progress.text)}</span>
          ${link}
        </div>
      </article>`;
  };

  // 4 款游戏一行陈列（桌面端 4 列紧凑排布，移动端响应式折行）
  list.innerHTML = `
    <div class="epic-cards-row">
      ${epicGamesCache.map(renderCard).join('')}
    </div>
  `;
  renderEpicStats();
}

function renderEpicRecords(records) {
  const box = document.getElementById('epic-records');
  if (!box) return;
  if (!records || records.length === 0) {
    box.innerHTML = '<div class="epic-empty">暂无领取记录</div>';
    return;
  }
  box.innerHTML = records.map(r => {
    const accountName = epicAccountCache.find(a => a.id === r.accountId)?.name || '';
    const statusMap = {
      claimed: { cls: 'ok', text: '已领取' },
      owned: { cls: 'warn', text: '已拥有' },
      blocked: { cls: 'warn', text: '已拦截' },
      failed: { cls: 'err', text: '失败' }
    };
    const status = statusMap[r.status] || { cls: r.ok ? 'ok' : 'err', text: r.ok ? '成功' : '失败' };
    const message = accountName ? `[${accountName}] ${r.message || ''}` : (r.message || '');
    return `
      <div class="epic-record-row">
        <span class="epic-badge ${status.cls}">${status.text}</span>
        <span class="epic-record-time">${formatEpicTime(r.at)}</span>
        <span class="epic-record-title" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</span>
        <span class="epic-record-message" title="${escapeHtml(message)}">${escapeHtml(message)}</span>
      </div>`;
  }).join('');
}

async function fetchEpicStatus() {
  try {
    const res = await fetch('/api/epic/status').then(r => r.json());
    if (res.success) {
      epicStatusCache = { ...epicStatusCache, ...(res.data || {}) };
      renderEpicRecords(epicStatusCache.records || []);
      renderEpicBrowserStatus(epicStatusCache);
    }
  } catch {}
}

async function fetchEpicFreeGames(manual = false) {
  const list = document.getElementById('epic-games-list');
  if (manual && list) list.innerHTML = '<div class="epic-empty">正在获取免费游戏列表...</div>';
  try {
    const res = await fetch('/api/epic/free-games').then(r => r.json());
    if (res.success) renderEpicGames(res.data || []);
    else if (list) list.innerHTML = `<div class="epic-empty">获取失败：${escapeHtml(res.message || '')}</div>`;
  } catch (e) {
    if (list) list.innerHTML = `<div class="epic-empty">获取失败：${escapeHtml(e.message)}</div>`;
  }
}

function openEpicModal(accountId) {
  const epicBusy = epicStatusCache.running
    || epicStatusCache.verifying
    || ['checking', 'stopping', 'verifying'].includes(epicStatusCache.state?.status);
  if (accountId && epicBusy) {
    openEpicActionModal(
      'Epic 任务正在运行',
      '当前无法编辑会话，请先停止 Epic 任务。',
      ['等待当前任务结束', '或点击停止按钮释放浏览器', '再重新编辑会话'],
      1
    );
    updateEpicActionModal({
      progress: 100,
      badge: { text: '请先停止', cls: 'warn' },
      result: '运行期间更新会话不会被当前浏览器使用，而且可能在结束时覆盖新凭据。请先停止任务。'
    });
    return;
  }
  const acc = accountId ? epicAccountCache.find(a => a.id === accountId) : null;
  document.getElementById('epic-modal-title').innerText = acc ? `编辑 Epic 账号：${acc.name}` : '添加 Epic 账号';
  document.getElementById('epic-account-name').value = acc ? acc.name : '';
  document.getElementById('epic-account-name').dataset.accountId = acc ? acc.id : '';
  const openLoginBtn = document.getElementById('btn-epic-open-login');
  const saveLoginBtn = document.getElementById('btn-epic-save-login');
  const status = document.getElementById('epic-login-status');
  // 新账号点击登录时先自动保存草稿，不能留下一个看起来可点、实际无响应的按钮。
  if (openLoginBtn) openLoginBtn.disabled = false;
  if (saveLoginBtn) saveLoginBtn.disabled = !acc;
  // 会话导入是兜底路径，每次打开都清空，避免把上一次的粘贴内容误提交
  const sessionInput = document.getElementById('epic-session-input');
  if (sessionInput) sessionInput.value = '';
  const importBtn = document.getElementById('btn-epic-import-session');
  if (importBtn) importBtn.disabled = false;
  if (status) {
    status.innerText = acc
      ? (acc.hasSession
        ? '该账号已有登录凭据。点击“打开可见浏览器登录”可在内置 Chromium 中重新登录，完成后点击保存。'
        : '该账号尚未登录。请打开可见浏览器完成 Epic 登录，然后点击“我已登录，保存凭据”。')
      : '请先填写备注名称并保存账号，之后再打开可见浏览器登录。';
  }
  openModal('epic-account-modal');
}

async function closeEpicAccountModal() {
  const accountId = document.getElementById('epic-account-name')?.dataset.accountId;
  if (accountId) {
    await fetch(`/api/epic/accounts/${accountId}/login-window/close`, { method: 'POST' }).catch(() => {});
  }
  closeNovncModal();
  closeModal('epic-account-modal');
}

async function saveEpicAccount() {
  const nameEl = document.getElementById('epic-account-name');
  const accountId = nameEl.dataset.accountId || '';
  const name = nameEl.value.trim();

  if (!name && !accountId) {
    openEpicActionModal('无法保存 Epic 账号', '请先填写账号备注名称。', ['填写账号名称', '重新保存'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '参数缺失', cls: 'warn' } });
    return;
  }

  try {
    const res = await fetch('/api/epic/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accountId ? { id: accountId, name } : { name })
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '保存失败');

    closeModal('epic-account-modal');
    await fetchEpicAccounts();
    openEpicActionModal(
      'Epic 账号已保存',
      '账号备注名称已成功更新！',
      ['保存账号信息', '保留已有登录凭据', '刷新账号列表'],
      2
    );
    updateEpicActionModal({
      progress: 100,
      badge: { text: '已保存', cls: 'ok' },
      result: `账号 [${name || accountId}] 已就绪。\n如需登录或更新凭据，请点击卡片上的「✏️ 编辑」，再打开可见浏览器登录。`
    });
  } catch (e) {
    openEpicActionModal('Epic 账号保存失败', e.message, ['保存账号信息', '校验结果'], 0);
    updateEpicActionModal({
      progress: 100,
      badge: { text: '保存失败', cls: 'err' },
      result: `保存失败：${e.message}`
    });
  }
}

async function ensureEpicAccountSaved() {
  const nameEl = document.getElementById('epic-account-name');
  if (!nameEl) throw new Error('Epic 账号表单未就绪');
  let accountId = nameEl.dataset.accountId || '';
  if (accountId) return accountId;

  const name = nameEl.value.trim();
  if (!name) throw new Error('请先填写账号备注名称');

  const res = await fetch('/api/epic/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  }).then(r => r.json());
  if (!res.success || !res.data?.id) {
    throw new Error(res.message || '账号保存失败');
  }

  accountId = res.data.id;
  nameEl.dataset.accountId = accountId;
  const title = document.getElementById('epic-modal-title');
  if (title) title.innerText = `编辑 Epic 账号：${name}`;
  const saveLoginBtn = document.getElementById('btn-epic-save-login');
  const importBtn = document.getElementById('btn-epic-import-session');
  if (saveLoginBtn) saveLoginBtn.disabled = false;
  if (importBtn) importBtn.disabled = false;
  await fetchEpicAccounts();
  return accountId;
}

async function openEpicLoginWindow() {
  let accountId = document.getElementById('epic-account-name')?.dataset.accountId;
  if (!accountId) {
    openEpicActionModal('正在准备 Epic 账号', '正在保存账号备注并准备打开 Chromium...', ['保存账号', '启动 Chromium', '打开登录页'], 0);
    startActionProgressTicker(10, 35, 8, '正在保存账号备注...');
    try {
      accountId = await ensureEpicAccountSaved();
      stopActionProgressTicker();
    } catch (e) {
      stopActionProgressTicker();
      updateEpicActionModal({
        progress: 100,
        badge: { text: '无法继续', cls: 'warn' },
        message: e.message,
        result: `无法打开登录窗口：${e.message}`
      });
      return;
    }
  }
  openEpicActionModal('正在打开 Epic 登录窗口', '正在容器内启动 Chromium 并打开 Epic 登录页...', ['启动 Chromium', '打开登录页', '等待手动登录'], 0);
  startActionProgressTicker(15, 75, 10, '正在启动 Chromium 登录窗口...');
  try {
    const res = await fetch(`/api/epic/accounts/${accountId}/login-window`, { method: 'POST' }).then(r => r.json());
    stopActionProgressTicker();
    if (!res.success) throw new Error(res.message || '打开登录窗口失败');
    updateEpicActionModal({
      activeIndex: 3,
      progress: 100,
      badge: { text: '等待登录', cls: 'warn' },
      message: '请在可见浏览器中完成 Epic 登录',
      result: '登录完成后，回到账号编辑弹窗点击“我已登录，保存凭据”。'
    });
    openNovncModal('Epic 登录窗口', { showSave: true });
    const status = document.getElementById('epic-login-status');
    if (status) status.innerText = '登录窗口已打开。请在下方小窗完成 Epic 登录，然后点击“我已登录，保存凭据”。';
  } catch (e) {
    stopActionProgressTicker();
    updateEpicActionModal({ progress: 100, badge: { text: '打开失败', cls: 'err' }, message: e.message, result: `打开登录窗口失败：${e.message}` });
  }
}

async function saveEpicLoginWindow() {
  const accountId = document.getElementById('epic-account-name')?.dataset.accountId;
  if (!accountId) return;
  openEpicActionModal('正在保存 Epic 登录凭据', '正在通过 Epic 账号接口检测并复验登录态...', ['检测登录状态', '隔离复验会话', '保存 Cookie 与 profile', '关闭登录窗口'], 0);
  startActionProgressTicker(20, 85, 10, '正在通过 Epic 账号接口复验登录态...');
  try {
    const res = await fetch(`/api/epic/accounts/${accountId}/login-window/save`, { method: 'POST' }).then(r => r.json());
    stopActionProgressTicker();
    if (!res.success) throw new Error(res.message || '保存登录凭据失败');
    if (res.data?.saved) {
      closeNovncModal();
      await fetchEpicAccounts();
      const status = document.getElementById('epic-login-status');
      if (status) status.innerText = `登录凭据已保存，共 ${res.data.cookieCount || 0} 条 Cookie。`;
      updateEpicActionModal({
        activeIndex: 4,
        progress: 100,
        badge: { text: '已保存', cls: 'ok' },
        message: 'Epic 登录凭据已保存',
        result: `已保存 ${res.data.cookieCount || 0} 条 Cookie 到内置 Chromium profile。`
      });
    } else {
      updateEpicActionModal({
        progress: 100,
        badge: { text: '登录未确认', cls: 'warn' },
        message: res.data?.message || '尚未检测到登录完成',
        result: res.data?.message || '请等待可见浏览器中的商城页面完全加载并显示账号后，再点击保存。'
      });
    }
  } catch (e) {
    stopActionProgressTicker();
    updateEpicActionModal({ progress: 100, badge: { text: '保存失败', cls: 'err' }, message: e.message, result: `保存登录凭据失败：${e.message}` });
  }
}

// ===== Epic 指纹自检 =====
async function openEpicFingerprintModal() {
  openModal('epic-fingerprint-modal');
  await loadEpicFingerprint();
}

async function loadEpicFingerprint() {
  const summary = document.getElementById('epic-fingerprint-summary');
  const detail = document.getElementById('epic-fingerprint-detail');
  if (summary) summary.innerHTML = '正在启动临时浏览器采集指纹…';
  if (detail) detail.innerHTML = '';
  try {
    const res = await fetch('/api/epic/fingerprint').then(r => r.json());
    if (!res.success) throw new Error(res.message || '自检失败');
    const { signals = {}, warnings = [], browserVersion } = res.data || {};
    if (summary) {
      summary.innerHTML = warnings.length === 0
        ? `<div style="color:#22C55E;">✅ 未发现明显的自动化特征（内置 Chromium ${escapeHtml(String(browserVersion || '?'))}）</div>`
        : `<div style="color:#F59E0B;">⚠️ 发现 ${warnings.length} 处可疑特征，Epic 风控可能据此拦截登录：</div>
           <ul style="margin:6px 0 0 18px;">${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
    }
    if (detail) {
      const rows = [
        ['User-Agent', signals.userAgent],
        ['appVersion', signals.appVersion],
        ['platform', signals.platform],
        ['oscpu', signals.oscpu],
        ['languages', (signals.languages || []).join(', ')],
        ['hardwareConcurrency', signals.hardwareConcurrency],
        ['navigator.webdriver', String(signals.webdriver)],
        ['navigator.plugins', signals.pluginsCount],
        ['window.chrome', signals.hasWindowChrome ? '存在（异常）' : '不存在'],
        ['WebGL 厂商', signals.webglVendor || '（不可用）'],
        ['WebGL 渲染器', signals.webglRenderer || '（不可用）'],
        ['时区', signals.timezone],
        ['屏幕', signals.screen]
      ];
      detail.innerHTML = `<table style="width:100%; border-collapse:collapse; font-size:12px;">${
        rows.map(([k, v]) => `<tr><td style="padding:4px 8px; color:#94A3B8; white-space:nowrap; vertical-align:top;">${escapeHtml(k)}</td><td style="padding:4px 8px; word-break:break-all;">${escapeHtml(String(v ?? ''))}</td></tr>`).join('')
      }</table>`;
    }
  } catch (e) {
    if (summary) summary.innerHTML = `<div style="color:#EF4444;">自检失败：${escapeHtml(e.message)}</div>`;
  }
}

// ===== Epic 会话导入（内置登录被风控拦住时的兜底） =====
async function importEpicSession() {
  let accountId = document.getElementById('epic-account-name')?.dataset.accountId;
  const session = document.getElementById('epic-session-input')?.value.trim();
  if (!accountId) {
    try {
      accountId = await ensureEpicAccountSaved();
    } catch (e) {
      openEpicActionModal('无法导入会话', e.message, ['保存账号', '导入会话'], 0);
      updateEpicActionModal({ progress: 100, badge: { text: '无法继续', cls: 'warn' }, result: e.message });
      return;
    }
  }
  if (!session) {
    openEpicActionModal('没有可导入的内容', '请先粘贴 storageState JSON 或 Cookie 字符串。', ['粘贴会话', '重新导入'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '内容为空', cls: 'warn' } });
    return;
  }
  openEpicActionModal('正在导入 Epic 会话', '正在解析并写入账号凭据…', ['解析会话', '写入配置', '刷新账号'], 0);
  startActionProgressTicker(20, 85, 10, '正在解析会话…');
  try {
    const res = await fetch(`/api/epic/accounts/${accountId}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session })
    }).then(r => r.json());
    stopActionProgressTicker();
    if (!res.success) throw new Error(res.message || '导入失败');
    const input = document.getElementById('epic-session-input');
    if (input) input.value = '';
    await fetchEpicAccounts();
    updateEpicActionModal({
      activeIndex: 3,
      progress: 100,
      badge: { text: '已导入', cls: 'ok' },
      message: '会话已导入',
      result: `共导入 ${res.data?.cookieCount ?? 0} 个 Cookie。${
        res.data?.hasEpicSession
          ? '已检测到 Epic 登录凭据。'
          : '⚠️ 未检测到 EPIC 登录 Cookie，请确认粘贴的是 Epic 站点的会话。'
      }`
    });
  } catch (e) {
    stopActionProgressTicker();
    updateEpicActionModal({ progress: 100, badge: { text: '导入失败', cls: 'err' }, message: e.message, result: `导入失败：${e.message}` });
  }
}

async function verifyEpicSession(accountId) {
  const acc = epicAccountCache.find(a => a.id === accountId);
  const ok = await showWebConfirm(
    `确定要校验 Epic 账号「${acc?.name || accountId}」的会话吗？\n将启动持久化无头浏览器访问 Epic 官网并实时返回检测进度。`,
    '校验 Epic 会话'
  );
  if (!ok) return;

  openEpicActionModal(
    `校验 Epic 账号 · ${acc?.name || accountId}`,
    '正在启动持久化浏览器并检测商城会话...',
    ['初始化持久化配置', '打开 Epic 商城首页', '核验登录状态', '同步游戏入库状态', '更新账号数据'],
    0,
    true
  );
  startEpicActionPolling();

  try {
    updateEpicActionModal({ activeIndex: 1, message: '正在加载 Epic 商城首页...', progress: 25 });
    const res = await fetch(`/api/epic/accounts/${accountId}/verify`, { method: 'POST' }).then(r => r.json());
    stopEpicActionPolling();
    if (res.success) {
      const d = res.data || {};
      if (d.valid) {
        const gameLines = (d.gameStatuses || []).map(game => {
          const label = game.status === 'owned'
            ? '已在库'
            : (game.status === 'available' ? '可领取' : '未确认');
          return `• ${game.title}：${label}`;
        });
        updateEpicActionModal({
          activeIndex: 5,
          progress: 100,
          badge: { text: '会话有效', cls: 'ok' },
          message: '✅ 校验通过，登录态与游戏入库状态已刷新',
          result: `账号 [${acc?.name || accountId}] 校验成功！\n状态：${d.message}${gameLines.length ? `\n\n${gameLines.join('\n')}` : ''}\n\n已自动保留持久化指纹与 Cookie，可正常执行自动化领取。`
        });
      } else if (d.blocked) {
        updateEpicActionModal({
          activeIndex: 2,
          progress: 80,
          badge: { text: '人机验证拦截', cls: 'warn' },
          message: '⚠️ 触发 Epic 商店人机验证',
          result: `提示：${d.message}\n持久化配置文件已保留。如果当前网络环境风险较高，可稍后再试，或通过电脑端将最新有效会话重新导入。`
        });
      } else {
        updateEpicActionModal({
          activeIndex: 3,
          progress: 100,
          badge: { text: '会话失效', cls: 'err' },
          message: '❌ 会话已失效或未登录',
          result: `提示：${d.message}\n请在电脑浏览器中登录 store.epicgames.com 后重新导出并粘贴最新 Cookie。`
        });
      }
    } else {
      updateEpicActionModal({
        progress: 100,
        badge: { text: '校验失败', cls: 'err' },
        message: res.message || '校验失败',
        result: `失败原因：${res.message || '未知错误'}`
      });
    }
    await fetchEpicAccounts();
    await fetchEpicStatus();
  } catch (e) {
    stopEpicActionPolling();
    updateEpicActionModal({
      progress: 100,
      badge: { text: '校验异常', cls: 'err' },
      message: e.message,
      result: `请求异常：${e.message}`
    });
  }
}

async function toggleEpicAccount(accountId) {
  const acc = epicAccountCache.find(a => a.id === accountId);
  if (!acc) return;
  try {
    const res = await fetch('/api/epic/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: accountId, name: acc.name, enabled: !acc.enabled })
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '更新失败');
    await fetchEpicAccounts();
  } catch (e) {
    openEpicActionModal('Epic 账号操作失败', e.message, ['更新账号状态', '刷新账号列表'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '操作失败', cls: 'err' }, result: `操作失败：${e.message}` });
  }
}

async function deleteEpicAccount(accountId) {
  const acc = epicAccountCache.find(a => a.id === accountId);
  const ok = await showWebConfirm(`确定删除 Epic 账号「${acc?.name || accountId}」吗？\n该账号的会话与持久化浏览器数据将被一并清理。`, '删除 Epic 账号');
  if (!ok) return;
  try {
    const res = await fetch(`/api/epic/accounts/${accountId}`, { method: 'DELETE' }).then(r => r.json());
    if (!res.success) {
      openEpicActionModal('Epic 账号删除失败', res.message || '删除失败', ['删除账号配置', '校验结果'], 0);
      updateEpicActionModal({ progress: 100, badge: { text: '删除失败', cls: 'err' } });
      return;
    }
    await fetchEpicAccounts();
  } catch (e) {
    openEpicActionModal('Epic 账号删除异常', e.message, ['删除账号配置', '校验结果'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '删除异常', cls: 'err' }, result: `删除异常：${e.message}` });
  }
}

async function claimEpic(accountId) {
  const label = accountId
    ? `Epic 账号「${epicAccountCache.find(a => a.id === accountId)?.name || accountId}」`
    : '全部已启用的 Epic 账号';
  const ok = await showWebConfirm(
    `立即为${label}领取当前免费游戏？\n系统将启动持久化无头浏览器自动完成订单，弹窗将实时跟踪当前步数。`,
    '领取 Epic 免费游戏'
  );
  if (!ok) return;

  const btn = accountId ? null : document.getElementById('btn-epic-claim-all');
  const orig = btn ? btn.innerHTML : '';
  if (btn) btn.innerHTML = '⏳ 领取中...';

  openEpicActionModal(
    `免费游戏自动领取 · ${label}`,
    '正在检查免费游戏列表与各账号在库状态...',
    ['检查本周免费游戏', '启动持久化浏览器', '进入游戏商品页', '处理人机验证覆盖层', '确认并提交订单', '核销入库结果'],
    0,
    true
  );
  startEpicActionPolling();

  try {
    const res = await fetch('/api/epic/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accountId ? { accountId } : {})
    }).then(r => r.json());
    stopEpicActionPolling();

    if (!res.success) throw new Error(res.message || '领取失败');

    const data = res.data || {};
    let resultText = '';
    const rawResults = data.results || [];
    const resultGroups = accountId
      ? [{
          accountId,
          accountName: epicAccountCache.find(a => a.id === accountId)?.name || accountId,
          results: rawResults
        }]
      : rawResults;
    if (resultGroups.length > 0) {
      const blocks = [];
      resultGroups.forEach(group => {
        const title = group.accountName ? `【账号: ${group.accountName}】` : '';
        const items = (group.results || []).map(r => {
          const icon = r.ok ? '✅' : (r.status === 'blocked' ? '🛡️' : '❌');
          return `  ${icon} ${r.title}：${r.message || (r.ok ? '成功' : '失败')}`;
        });
        if (group.error) items.push(`  ⚠️ 异常：${group.error}`);
        blocks.push(`${title}\n${items.join('\n') || '  (无需处理的游戏)'}`);
      });
      resultText = blocks.join('\n\n');
    } else {
      resultText = '本轮执行完毕，所有游戏均无需重复领取。';
    }
    const { successes, failures } = collectEpicSuccesses(resultGroups);

    updateEpicActionModal({
      activeIndex: 6,
      progress: 100,
      badge: { text: '领取结束', cls: 'ok' },
      message: '本轮免费游戏领取已全部处理完毕',
      result: resultText
    });

    if (successes.length > 0) {
      epicChallengeAutoOpened = false;
      closeNovncModal();
      const message = successes.length === 1
        ? '免费游戏已经稳稳收入库中。'
        : `本次共 ${successes.length} 个游戏成功入库。`;
      const note = failures > 0 ? `另有 ${failures} 项未完成，可稍后重试。` : '';
      showEpicCelebration({ message, items: successes, note });
    }

    await fetchEpicAccounts();
    await fetchEpicStatus();
  } catch (e) {
    stopEpicActionPolling();
    updateEpicActionModal({
      progress: 100,
      badge: { text: '领取异常', cls: 'err' },
      message: e.message,
      result: `领取异常：${e.message}`
    });
  } finally {
    if (btn) btn.innerHTML = orig;
  }
}

async function refreshEpicTab() {
  const list = document.getElementById('epic-games-list');
  await Promise.all([
    loadEpicSettings(),
    fetchEpicAccounts(),
    fetchEpicStatus()
  ]);
  if (!list?.dataset.loaded) {
    await fetchEpicFreeGames(false);
    if (list) list.dataset.loaded = '1';
  } else if (epicGamesCache && epicGamesCache.length > 0) {
    renderEpicGames(epicGamesCache);
  }
  renderEpicStats();
}

// ===== Epic 领取设置 =====
async function loadEpicSettings() {
  try {
    const res = await fetch('/api/epic/settings').then(r => r.json());
    if (!res.success) return;
    const s = res.data || {};
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
    };
    const enabledEl = document.getElementById('epic-set-enabled');
    if (enabledEl) enabledEl.checked = s.enabled !== false;
    set('epic-set-auto-time', s.autoClaimTime || '10:00');
    set('epic-set-interval', s.checkIntervalMin ?? 30);
    set('epic-set-retry', s.retryCount ?? 2);
    set('epic-set-retry-interval', s.retryIntervalSec ?? 60);
    set('epic-set-account-gap', s.accountGapSec ?? 20);

    const curMin = Number(s.checkIntervalMin ?? 30);
    document.querySelectorAll('.cycle-pill').forEach(btn => {
      const bMin = Number(btn.getAttribute('data-min'));
      if (bMin === curMin) btn.classList.add('active');
      else btn.classList.remove('active');
    });

    epicSettingsCache = s;
    renderEpicStats();
  } catch {}
}

async function saveEpicSettings() {
  const body = {
    enabled: document.getElementById('epic-set-enabled')?.checked !== false,
    autoClaimTime: document.getElementById('epic-set-auto-time')?.value || '10:00',
    checkIntervalMin: Number(document.getElementById('epic-set-interval')?.value),
    retryCount: Number(document.getElementById('epic-set-retry')?.value),
    retryIntervalSec: Number(document.getElementById('epic-set-retry-interval')?.value),
    accountGapSec: Number(document.getElementById('epic-set-account-gap')?.value)
  };
  try {
    const res = await fetch('/api/epic/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '保存失败');
    epicSettingsCache = res.data || {};
    await loadEpicSettings();
    openEpicActionModal('Epic 领取设置已保存', `新的检查与重试策略已即时生效。每天 ${body.autoClaimTime} 之后才会开始自动检查。`, ['校验设置参数', '写入配置', '重启调度器'], 3);
    updateEpicActionModal({ progress: 100, badge: { text: '已保存', cls: 'ok' } });
  } catch (e) {
    openEpicActionModal('Epic 设置保存失败', e.message, ['校验设置参数', '写入配置'], 0);
    updateEpicActionModal({ progress: 100, badge: { text: '保存失败', cls: 'err' }, result: `保存失败：${e.message}` });
  }
}

// ===== Epic 无头浏览器状态 =====
const EPIC_STATUS_TEXT = {
  idle: '空闲',
  checking: '检查中',
  navigating: '打开页面',
  clicking: '点击获取',
  ordering: '确认订单',
  waiting: '等待中',
  retrying: '重试中',
  stopping: '停止中',
  login_window: '等待登录',
  done: '已完成'
};

function renderEpicBrowserStatus(data) {
  const badge = document.getElementById('epic-browser-badge');
  const action = document.getElementById('epic-browser-action');
  const meta = document.getElementById('epic-browser-meta');
  const updated = document.getElementById('epic-browser-updated');
  if (!badge || !action) return;

  epicStatusCache = { ...epicStatusCache, ...(data || {}) };
  const st = data.state || {};
  const running = !!data.running;
  const activeStatuses = ['checking', 'navigating', 'challenge', 'clicking', 'ordering', 'waiting', 'retrying', 'verifying', 'stopping', 'login_window'];
  const active = running || data.verifying || !!data.loginWindow?.open || activeStatuses.includes(st.status);
  const label = EPIC_STATUS_TEXT[st.status] || '空闲';
  badge.className = `epic-badge ${st.status === 'stopping' || st.status === 'challenge' ? 'warn' : (active || st.status === 'done' ? 'ok' : 'idle')}`;
  badge.innerText = active ? `● ${label}` : label;
  action.innerText = st.lastAction || (active ? '执行中...' : '当前没有正在执行的领取任务');

  const parts = [];
  if (st.accountName) parts.push(`账号：${st.accountName}`);
  if (st.gameTitle) parts.push(`游戏：${st.gameTitle}`);
  if (st.maxAttempts > 0) parts.push(`尝试：${st.attempt || 0}/${st.maxAttempts}`);
  if (data.lastCheckAt) parts.push(`上次检查：${formatEpicTime(data.lastCheckAt)}`);
  const nextCheck = getEpicNextCheckText();
  if (nextCheck) parts.push(`下次检查：${nextCheck}`);
  parts.push(`引擎：${data.engine === 'firefox' ? 'Firefox' : 'Chromium'}`);
  parts.push(data.visible ? '模式：可见浏览器' : '模式：无头');
  if (data.loginWindow?.open) parts.push('登录窗口：已打开');
  if (data.demo) parts.push('⚠️ 演示模式（不启动浏览器）');
  if (meta) meta.innerText = parts.length > 0 ? parts.join('  ｜  ') : '等待首次检查';
  if (updated) {
    updated.innerText = st.lastUpdate
      ? `更新于 ${new Date(st.lastUpdate).toLocaleTimeString('zh-CN', { hour12: false })}`
      : '--';
  }
  const stopBtn = document.getElementById('btn-epic-stop');
  if (stopBtn) {
    stopBtn.style.display = active ? 'inline-flex' : 'none';
    stopBtn.disabled = st.status === 'stopping';
    stopBtn.innerText = st.status === 'stopping' ? '⏳ 停止中' : '⏹️ 停止 Epic';
  }
  const vncBtn = document.getElementById('btn-epic-vnc');
  if (vncBtn) {
    if (data.visible) {
      vncBtn.style.display = 'inline-flex';
      vncBtn.title = '在网页小窗中打开 Epic 可见浏览器';
    } else {
      vncBtn.style.display = 'none';
    }
  }
  renderEpicStats();
}

// ===== 全部历史日志弹窗 =====
let logsModalEntries = [];
let logsModalOpen = false;
let diagnosticsReport = null;

function initLogsModal() {
  document.getElementById('btn-open-logs')?.addEventListener('click', openLogsModal);
  document.getElementById('btn-close-logs')?.addEventListener('click', closeLogsModal);
  document.getElementById('btn-close-logs-btn')?.addEventListener('click', closeLogsModal);
  document.getElementById('logs-filter')?.addEventListener('input', () => renderLogsModal());
  document.getElementById('btn-logs-clear')?.addEventListener('click', () => {
    logsModalEntries = [];
    renderLogsModal();
  });
  document.getElementById('btn-logs-export-diagnostics')?.addEventListener('click', openDiagnosticsExport);
  document.getElementById('btn-terminal-export-diagnostics')?.addEventListener('click', openDiagnosticsExport);
  document.getElementById('btn-close-diagnostics')?.addEventListener('click', closeDiagnosticsExport);
  document.getElementById('btn-close-diagnostics-btn')?.addEventListener('click', closeDiagnosticsExport);
  document.getElementById('btn-copy-diagnostics')?.addEventListener('click', copyDiagnosticsExport);
  document.getElementById('btn-download-diagnostics')?.addEventListener('click', downloadDiagnosticsExport);
}

async function openLogsModal() {
  logsModalOpen = true;
  openModal('logs-modal');
  const list = document.getElementById('logs-modal-list');
  if (list) list.innerHTML = '<div class="logs-empty">正在加载历史日志...</div>';
  try {
    const res = await fetch('/api/logs/history?limit=500').then(r => r.json());
    logsModalEntries = res.success ? (res.data || []) : [];
  } catch {
    logsModalEntries = [];
  }
  renderLogsModal(true);
}

function closeLogsModal() {
  logsModalOpen = false;
  closeModal('logs-modal');
}

function renderLogsModal(scrollToBottom = false) {
  const list = document.getElementById('logs-modal-list');
  if (!list) return;
  const filter = (document.getElementById('logs-filter')?.value || '').trim().toLowerCase();
  const rows = logsModalEntries.filter(e => {
    if (!filter) return true;
    return `${e.accountName || ''} ${e.message || ''} ${e.icon || ''}`.toLowerCase().includes(filter);
  });
  if (rows.length === 0) {
    list.innerHTML = `<div class="logs-empty">${logsModalEntries.length === 0 ? '暂无日志' : '没有匹配的日志'}</div>`;
    return;
  }
  list.innerHTML = rows.map(e => `
    <div class="logs-line">
      <span class="logs-time">[${escapeHtml(e.fullTime || e.time || '')}]</span>
      <span>${escapeHtml(e.icon || 'ℹ️')}</span>
      ${e.accountName ? `<span class="logs-acc">[${escapeHtml(e.accountName)}]</span>` : ''}
      <span>${escapeHtml(e.message || '')}</span>
    </div>`).join('');

  const auto = document.getElementById('logs-autoscroll');
  if (scrollToBottom || auto?.checked) list.scrollTop = list.scrollHeight;
}

function appendLogToModal(entry) {
  if (!logsModalOpen || !entry) return;
  logsModalEntries.push({
    fullTime: entry.fullTime || '',
    time: entry.time || '',
    icon: entry.icon || 'ℹ️',
    accountName: entry.accountName || '',
    message: entry.message || ''
  });
  if (logsModalEntries.length > 800) logsModalEntries.shift();
  renderLogsModal();
}

function formatDiagnosticBytes(bytes = 0) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function setDiagnosticActionsEnabled(enabled) {
  const copy = document.getElementById('btn-copy-diagnostics');
  const download = document.getElementById('btn-download-diagnostics');
  if (copy) copy.disabled = !enabled;
  if (download) download.disabled = !enabled;
}

async function openDiagnosticsExport() {
  const preview = document.getElementById('diagnostics-preview');
  const meta = document.getElementById('diagnostics-meta');
  diagnosticsReport = null;
  setDiagnosticActionsEnabled(false);
  if (preview) preview.value = '';
  if (meta) meta.textContent = '正在生成最近 24 小时脱敏诊断日志...';
  openModal('diagnostics-modal');

  try {
    const res = await fetch('/api/logs/diagnostics', {
      cache: 'no-store'
    }).then(r => r.json());
    if (!res.success || !res.data?.content) {
      throw new Error(res.message || '诊断日志生成失败');
    }
    diagnosticsReport = res.data;
    if (preview) preview.value = res.data.content;
    if (meta) {
      const truncateText = res.data.truncated ? ' · 内容已按大小上限截断' : '';
      meta.textContent = `最近 ${res.data.windowHours} 小时 · ${res.data.lineCount} 行日志 · ${formatDiagnosticBytes(res.data.bytes)}${truncateText}`;
    }
    setDiagnosticActionsEnabled(true);
  } catch (e) {
    if (preview) preview.value = '';
    if (meta) meta.textContent = `生成失败：${e.message}`;
  }
}

function closeDiagnosticsExport() {
  closeModal('diagnostics-modal');
}

async function copyDiagnosticsExport() {
  const preview = document.getElementById('diagnostics-preview');
  const meta = document.getElementById('diagnostics-meta');
  if (!diagnosticsReport?.content || !preview) return;
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(diagnosticsReport.content);
      copied = true;
    }
  } catch {}
  if (!copied) {
    preview.focus();
    preview.select();
    try {
      copied = document.execCommand('copy');
    } catch {}
  }
  if (copied) {
    if (meta) meta.textContent = '已复制全部脱敏诊断日志，可直接粘贴到 Issue 或 AI 对话中。';
  } else {
    if (meta) meta.textContent = '复制失败，预览内容已全选，请使用系统复制快捷键。';
    preview.focus();
    preview.select();
  }
}

function downloadDiagnosticsExport() {
  if (!diagnosticsReport?.content) return;
  const blob = new Blob([diagnosticsReport.content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = diagnosticsReport.filename || 'msr-diagnostics-redacted.txt';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const meta = document.getElementById('diagnostics-meta');
  if (meta) meta.textContent = `已下载 ${anchor.download}。公开前请再次检查内容。`;
}
