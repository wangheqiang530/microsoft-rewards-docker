import crypto from 'crypto';
import configManager from '../config.js';
import networkClient from '../network.js';
import logger from '../logger.js';
import authManager from './auth.js';
import {
  extractAccountDisplayName,
  searchTierFromMax,
  toOptionalFiniteNumber
} from './accountIdentity.js';
import {
  classifySpecialActivity,
  extractActivityCardsFromHtml,
  extractSpecialActivitiesFromHtml
} from './specialActivities.js';
import {
  buildAppActivityPayload,
  buildDapiDailySetCards,
  extractDailySetCardsFromDashboard,
  getAppCheckInStatusFromPromotions,
  isAppReadPromotion,
  normalizeAppPromotions
} from './promotionSources.js';
import {
  PC_USER_AGENT,
  MOBILE_USER_AGENT,
  APP_USER_AGENT,
  APP_ID,
  DESKTOP_APP_USER_AGENT,
  pcPageHeaders,
  pcXhrHeaders
} from './fingerprint.js';

export const USER_AGENTS = {
  // 统一来自 fingerprint.js，避免各处硬编码版本号漂移（历史上就出现过前后不一致）
  pc: PC_USER_AGENT,
  mobile: MOBILE_USER_AGENT,
  app: APP_USER_AGENT
};

export const DESKTOP_APP_HEADERS = {
  'user-agent': DESKTOP_APP_USER_AGENT,
  'X-MSRewards-App': '1',
  'X-Rewards-Source': 'msrewards-desktop'
};

export const APP_CONFIG = {
  rewardsAppId: APP_ID,
  channel: 'SAAndroid',
  offerIds: {
    dailyCheckIn: 'Gamification_Sapphire_DailyCheckIn',
    readArticle: 'ENUS_readarticle3_30points'
  }
};

/**
 * 从 Next.js Flight 文本中提取包含指定键的完整 JSON 对象。
 * 简单的非嵌套正则会把 pcchild 子任务截断，导致锁定/完成数量长期不准。
 */
export function extractJsonObjectsWithKey(text, anchor = '"offerId"') {
  const source = String(text || '');
  const objects = [];
  let position = 0;

  while ((position = source.indexOf(anchor, position)) !== -1) {
    const start = source.lastIndexOf('{', position);
    if (start === -1) {
      position += anchor.length;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end === -1) {
      position += anchor.length;
      continue;
    }

    const raw = source.slice(start, end)
      .replace(/:\$undefined/g, ':null')
      .replace(/:\$D[^\",}\]]+/g, ':null');
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        objects.push(parsed);
      }
    } catch {}
    position = end;
  }

  return objects;
}

const KNOWN_SEARCH_QUOTAS = new Set([15, 30, 60]);

function extractBalancedJsonObject(text, start) {
  if (!text || start < 0 || text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 从 earn/dashboard 页面中提取搜索配额。
 *
 * 两个页面都可能偶发返回骨架、旧 Flight 数据或缺少 pc 字段，因此不能
 * 看到第一个 pointsCounters 就停止。这里收集所有候选，再优先选择
 * dashboard 中已知的 15/30/60 配额；未知配额仍会返回，供调用方拒绝执行。
 */
export function extractSearchQuota(...inputs) {
  const sources = inputs.map((input, index) => {
    if (typeof input === 'string') {
      return { text: input, source: index === 0 ? 'dashboard' : 'earn', priority: index };
    }
    return {
      text: String(input?.text || ''),
      source: input?.source || 'page',
      priority: Number.isFinite(Number(input?.priority)) ? Number(input.priority) : index
    };
  });
  const candidates = [];

  const addCandidate = (source, priority, origin, pc, extra = {}, index = 0) => {
    const max = Number(pc?.max);
    if (!Number.isFinite(max) || max <= 0) return;
    candidates.push({
      max,
      progress: Math.max(0, Number(pc?.progress) || 0),
      mobileMax: Math.max(0, Number(extra.mobile?.max) || 0),
      mobileProgress: Math.max(0, Number(extra.mobile?.progress) || 0),
      dailyOffer: Math.max(0, Number(extra.dailyOffer) || 0),
      source,
      priority,
      origin,
      index
    });
  };

  for (const item of sources) {
    const text = String(item.text || '').replace(/\\"/g, '"');
    if (!text) continue;

    const counterRe = /"pointsCounters"\s*:\s*\{/g;
    let counterMatch;
    while ((counterMatch = counterRe.exec(text)) !== null) {
      const start = counterMatch.index + counterMatch[0].lastIndexOf('{');
      const raw = extractBalancedJsonObject(text, start);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(
          raw.replace(/:\$undefined/g, ':null').replace(/:\$D[^",}]+/g, ':null')
        );
        addCandidate(item.source, item.priority, 'pointsCounters', parsed?.pc, parsed, counterMatch.index);
      } catch {}
    }

    const searchRowMatch = text.match(/<p>\s*必应搜索\s*<\/p>\s*<\/div>\s*<div(?=[^>]*justify-self-end)[^>]*>([\s\S]{0,500}?)<\/div>/i);
    const searchHtmlMatch = searchRowMatch
      ? (searchRowMatch[1].match(/<span[^>]*>([\d,]+)<\/span>\s*<span[^>]*>\s*\/\s*([\d,]+)\s*<\/span>/i)
          || searchRowMatch[1].match(/([\d,]+)\s*\/\s*([\d,]+)/))
      : null;
    if (searchHtmlMatch) {
      addCandidate(item.source, item.priority, 'searchRow', {
        progress: parseInt(String(searchHtmlMatch[1]).replace(/,/g, ''), 10),
        max: parseInt(String(searchHtmlMatch[2]).replace(/,/g, ''), 10)
      });
    }

    const searchRscMatch = text.match(/"combinedSearch":\{[^}]*"progress":(\d+)[^}]*"max":(\d+)/);
    if (searchRscMatch) {
      addCandidate(item.source, item.priority, 'combinedSearch', {
        progress: Number(searchRscMatch[1]),
        max: Number(searchRscMatch[2])
      });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    // dashboard 是当前账号的权威页面。即使它返回未知配额，也不能让
    // earn 中可能残留的旧 15/30/60 数据把它覆盖掉。
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aKnown = KNOWN_SEARCH_QUOTAS.has(a.max) ? 1 : 0;
    const bKnown = KNOWN_SEARCH_QUOTAS.has(b.max) ? 1 : 0;
    if (aKnown !== bKnown) return bKnown - aKnown;
    const aCounter = a.origin === 'pointsCounters' ? 1 : 0;
    const bCounter = b.origin === 'pointsCounters' ? 1 : 0;
    if (aCounter !== bCounter) return bCounter - aCounter;
    if (a.index !== b.index) return b.index - a.index;
    return b.progress - a.progress;
  });
  const best = candidates[0];
  return {
    progress: best.progress,
    max: best.max,
    mobileProgress: best.mobileProgress,
    mobileMax: best.mobileMax,
    dailyOffer: best.dailyOffer,
    source: best.source,
    origin: best.origin
  };
}

export function isServerActionAcknowledged(payload) {
  return /^\d+:true\s*$/m.test(String(payload || ''));
}

export function buildQuestRouterStateTree(questId) {
  const tree = [
    '',
    {
      children: [
        '(nav)',
        {
          children: [
            'earn',
            {
              children: [
                'quest',
                {
                  children: [
                    ['questId', questId, 'd', null],
                    { children: ['__PAGE__', {}, null, null, 0] },
                    null,
                    null,
                    0
                  ]
                },
                null,
                null,
                0
              ]
            },
            null,
            null,
            0
          ]
        },
        null,
        null,
        0
      ]
    },
    null,
    null,
    16
  ];
  return encodeURIComponent(JSON.stringify(tree));
}

export function weekdayFromOfferId(offerId = '') {
  const match = String(offerId).match(/_(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)_/i);
  return match ? match[1].toLowerCase() : '';
}

export { isBalanceMismatch } from './accountIdentity.js';

export const SEARCH_POOL = [
  "what is the weather forecast tomorrow",
  "how do I make sourdough bread at home",
  "where can I find cheap flights to tokyo",
  "why is the sky blue scientific explanation",
  "how to learn rust programming in 2026",
  "what time does the world cup final start",
  "how to fix a leaky kitchen faucet step by step",
  "what are the best vr games of 2026",
  "how to start a vegetable garden in spring",
  "where to watch new movies this week",
  "how to take care of a bonsai tree",
  "what is the difference between python async and threading",
  "how to meditate properly for beginners",
  "what is the origin of halloween traditions",
  "how do solar panels actually work",
  "what is the best mechanical keyboard for typing",
  "how to tie a windsor knot tie",
  "what causes northern lights aurora borealis",
  "how to brew the perfect espresso at home",
  "what are the symptoms of vitamin d deficiency",
  "how to sleep better naturally tonight",
  "why do cats purr when they are happy",
  "best coffee shops in san francisco downtown",
  "italian restaurants near times square",
  "tokyo cherry blossom season 2026 forecast",
  "rtx 5070 ti benchmark vs rtx 4080 super",
  "iphone 17 release date and features",
  "tesla stock price today nasdaq",
  "best noise cancelling headphones under 300",
  "fastest electric cars 0 to 60 mph",
  "vintage camera brands collectors guide",
  "budget gaming laptop with rtx 4070 2026",
  "easy chocolate chip cookies recipe from scratch",
  "30 minute home workout routine no equipment",
  "stretching exercises for lower back pain relief",
  "easy origami crane folding instructions",
  "git rebase vs merge which one to use",
  "markdown cheat sheet with examples",
  "japanese hiragana chart pronunciation",
  "ancient rome history quick overview",
  "pomodoro technique for focus and productivity",
  "healthy breakfast ideas under 10 minutes",
  "天气预报", "今日新闻热点", "美食食谱家常菜", "旅游攻略", "健康养生知识",
  "科技资讯", "电影推荐", "股票行情", "体育赛事", "历史上的今天"
];

const SKIP_PATTERNS = [
  "referral", "refer and earn", "sweepstake", "entries",
  "install the", "set bing as your default", "bing wallpaper",
  "punch card", "ancient coin", "sea of thieves", "rewards extension",
  "redemption goal", "order history", "claim your gift", "shop to earn",
  "set goal", "Available tomorrow", "Offer is Locked", "Earn -1 points"
];

export class RewardsApi {
  constructor() {
    this.region = 'CN';
    this.host = 'www.bing.com';
    this.cachedNextAction = '707e6eb15bdfdd5fba193f0a77e934f7018faf87ce';
    this.hotWordIndex = 0;
    this.hotWordList = [];
    this.restrictedTimes = 0;
    this.lastSearchProgress = -1;
  }

  randomRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  randomDelay(min = 3000, max = 8000) {
    return this.delay(this.randomRange(min, max));
  }

  getRandomUUID() {
    return crypto.randomUUID().replace(/-/g, '').toUpperCase();
  }

  // DAPI 的 activity.id 官方客户端是 56 位十六进制（两段 UUID 拼接）。
  // 只给 32 位时接口虽然返回 200，但部分任务（尤其连签类）不会真正入账。
  getDapiId() {
    return (this.getRandomUUID() + this.getRandomUUID()).slice(0, 56);
  }

  isJSON(str) {
    if (!str || typeof str !== 'string') return false;
    try {
      const j = JSON.parse(str);
      return Array.isArray(j) || (typeof j === 'object' && j !== null);
    } catch {
      return false;
    }
  }

  /**
   * 从 earn 与 dashboard 页面精准提取各 partner（bing / dailyset / bingapp）的连签模型。
   * 通过括号平衡解析独立的 streak JSON 对象，彻底避免旧版窗口正则向前越界抓到其他 partner（如 edge 的 0/7）。
   */
  extractStreakModels(...texts) {
    const result = {};
    const parseOne = (text) => {
      if (!text) return;
      const marker = '"model":{"streak":{';
      let pos = 0;
      let foundAny = false;
      while (true) {
        const idx = text.indexOf(marker, pos);
        if (idx === -1) break;
        const start = idx + marker.length - 1;
        let depth = 0;
        let end = -1;
        for (let i = start; i < text.length && i < start + 3000; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') {
            depth--;
            if (depth === 0) { end = i + 1; break; }
          }
        }
        if (end !== -1) {
          const raw = text.slice(start, end).replace(/:\$undefined/g, ':null').replace(/:\$D[^",}]+/g, ':null');
          try {
            const obj = JSON.parse(raw);
            if (obj.partner) {
              result[obj.partner] = {
                completedDays: Number(obj.completedDays ?? 0),
                currentDay: Number(obj.currentDay ?? 0),
                activitiesCompleted: Number(obj.activitiesCompleted ?? 0),
                activitiesTotal: Number(obj.activitiesTotal ?? 0),
                isCurrentDayCompleted: !!obj.isCurrentDayCompleted
              };
              foundAny = true;
            }
          } catch {
            const mPartner = raw.match(/"partner":"([^"]+)"/);
            if (mPartner) {
              const p = mPartner[1];
              const pick = (re) => { const m = raw.match(re); return m ? Number(m[1]) : 0; };
              result[p] = {
                completedDays: pick(/"completedDays":(\d+)/),
                currentDay: pick(/"currentDay":(\d+)/),
                activitiesCompleted: pick(/"activitiesCompleted":(\d+)/),
                activitiesTotal: pick(/"activitiesTotal":(\d+)/),
                isCurrentDayCompleted: /"isCurrentDayCompleted":true/.test(raw)
              };
              foundAny = true;
            }
          }
        }
        pos = (end !== -1) ? end : (idx + marker.length);
      }

      // 兜底（用于单测小片段）
      if (!foundAny) {
        for (const partner of ['bing', 'dailyset', 'bingapp']) {
          if (result[partner]) continue;
          const pKey = `"partner":"${partner}"`;
          const idx = text.indexOf(pKey);
          if (idx !== -1) {
            const forward = text.slice(idx, idx + 500);
            const backward = text.slice(Math.max(0, idx - 400), idx + 200);
            const win = forward.includes('completedDays') ? forward : backward;
            const pick = (re) => { const m = win.match(re); return m ? Number(m[1]) : 0; };
            result[partner] = {
              completedDays: pick(/"completedDays":(\d+)/),
              currentDay: pick(/"currentDay":(\d+)/),
              activitiesCompleted: pick(/"activitiesCompleted":(\d+)/),
              activitiesTotal: pick(/"activitiesTotal":(\d+)/),
              isCurrentDayCompleted: /"isCurrentDayCompleted":true/.test(win)
            };
          }
        }
        const mApp = text.match(/必应应用连续打卡[\s\S]{0,500}?签到:\s*(\d+)\s*\/\s*(\d+)/i)
          || text.match(/移动应用[\s\S]{0,500}?签到:\s*(\d+)\s*\/\s*(\d+)/i);
        if (mApp && !result['bingapp']) {
          const done = parseInt(mApp[1], 10);
          const total = parseInt(mApp[2], 10);
          const mDays = text.match(/已完成连续打卡\s*(\d+)\s*天/);
          result['bingapp'] = {
            completedDays: mDays ? parseInt(mDays[1], 10) : done,
            currentDay: done,
            activitiesCompleted: done,
            activitiesTotal: total,
            isCurrentDayCompleted: done >= total
          };
        }
      }
    };

    for (const t of texts) parseOne(t);
    return result;
  }

  setCurrentAccount(acc) {
    this.currentAccountId = acc?.id || 'acc_1';
    // 指定了账号就一定显式设定 Cookie 上下文：
    //   - 有 Cookie → 用该账号自己的；
    //   - 该账号没有 Cookie（字段缺失或空串）→ 传空串，让请求「不带 Cookie」，
    //     绝不能传 null，否则 networkClient 会回退到 accounts[0] 的 Cookie，
    //     把副账号的操作算到主账号头上。
    // 只有完全没指定账号（acc 为空）时才用 null，保留「走默认账号」的旧语义。
    networkClient.setActiveAccount(acc);
    // 同步日志归属上下文：该账号下所有未显式传账号名的日志都会自动带上账号名
    logger.setAccountContext(acc?.name || this.currentAccountId);
  }

  /**
   * 快照当前账号上下文（Cookie / 账号 ID / 日志前缀）。
   * 任何会临时切换账号的函数都应在 finally 里 restore，避免污染正在执行的任务。
   */
  snapshotAccountContext() {
    return {
      accountId: this.currentAccountId,
      cookie: networkClient.getActiveCookie(),
      proxyContext: networkClient.getActiveProxyContext(),
      logContext: logger.getAccountContext()
    };
  }

  restoreAccountContext(snapshot) {
    if (!snapshot) return;
    this.currentAccountId = snapshot.accountId;
    networkClient.setActiveCookie(snapshot.cookie);
    networkClient.setActiveProxyContext(snapshot.proxyContext);
    logger.setAccountContext(snapshot.logContext || '');
  }

  async withTokenRetry(requestFn) {
    let token = authManager.getAccessToken(this.currentAccountId);
    if (!token) {
      await authManager.refreshToken(false, this.currentAccountId);
      token = authManager.getAccessToken(this.currentAccountId);
    }
    if (!token) return null;

    try {
      return await requestFn(token);
    } catch (e) {
      if (e.message && e.message.includes('401')) {
        logger.log('🟡', 'Token 可能已过期，尝试重新刷新续期...');
        const ok = await authManager.refreshToken(true, this.currentAccountId);
        if (!ok) return null;
        token = authManager.getAccessToken(this.currentAccountId);
        return await requestFn(token);
      }
      throw e;
    }
  }

  /**
   * 地区与 IP 检测
   */
  async checkRegion(retryCount = 0, options = {}) {
    const cfg = configManager.get();
    if (!options.force && !cfg.network?.lockRegion) return true;
    const maxRetries = Number.isFinite(Number(options.maxRetries))
      ? Math.max(0, Math.min(2, Number(options.maxRetries)))
      : 2;

    try {
      const html = await networkClient.request({
        url: `https://${this.host}/`,
        headers: pcPageHeaders(),
        proxyUrl: options.proxyUrl,
        useProxy: options.useProxy
      });

      if (!html) {
        if (retryCount < maxRetries) {
          if (!options.silent) logger.log('🟡', `地区检测无返回，重试中 (${retryCount + 1}/${maxRetries})...`);
          await this.randomDelay(3000, 6000);
          return await this.checkRegion(retryCount + 1, options);
        }
        return false;
      }

      const match = String(html).replace(/\s/g, '').match(/Region:"(.*?)"(.*?)RevIpCC:"(.*?)"/);
      if (match) {
        this.region = match[3].toUpperCase();
        if (this.region !== 'CN') {
          const ipInfo = await this.getIPInfo(options);
          if (!options.silent) {
            logger.log('🔴', `检测到当前出口 IP 位于非大陆地区 (${this.region})，为了避免被微软风控，自动化已停止！${ipInfo}`);
          }
          return false;
        }
        if (!options.silent) logger.log('🟢', `地区检测通过: ${this.region}（中国大陆）`);
        return true;
      }

      if (retryCount < maxRetries) {
        await this.randomDelay(3000, 6000);
        return await this.checkRegion(retryCount + 1, options);
      }
      return false;
    } catch (e) {
      if (retryCount < maxRetries) {
        await this.randomDelay(3000, 6000);
        return await this.checkRegion(retryCount + 1, options);
      }
      if (!options.silent) logger.log('🔴', `地区检测异常: ${e.message}`);
      return false;
    }
  }

  async getIPInfoDetails(options = {}) {
    try {
      const res = await networkClient.request({
        url: 'https://disp-qryapi.3g.qq.com/v1/dispatch',
        headers: { 'referer': 'https://3g.qq.com/' },
        proxyUrl: options.proxyUrl,
        useProxy: options.useProxy
      });
      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      if (data && data.code === 0) {
        const ip = String(data.extra?.ip || data.ip || '').trim();
        const rawInfo = String(data.ipInfo || data.location || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;|&#160;/gi, ' ')
          .replace(/[#*]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const fallbackLocation = [
          data.country,
          data.province,
          data.city,
          data.isp
        ].filter(Boolean).join(' ').trim();
        const location = rawInfo || fallbackLocation;
        if (!ip && !location) return null;
        return {
          ip,
          location,
          rawInfo: rawInfo || fallbackLocation,
          formatted: `出口 IP: ${ip || '未知'} | 归属地: ${location || '未知'}`
        };
      }
    } catch {}
    return null;
  }

  async getIPInfo(options = {}) {
    const details = await this.getIPInfoDetails(options);
    return details ? ` ${details.formatted}` : '';
  }

  /**
   * 获取当前总积分余额
   */
  async getRewardsDashboardData() {
    try {
      const res = await networkClient.request({
        url: `https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest&_=${Date.now()}`,
        headers: {
          ...pcXhrHeaders(),
          'referer': 'https://rewards.bing.com/',
          'x-requested-with': 'XMLHttpRequest'
        }
      });
      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      return data && typeof data === 'object' ? data : null;
    } catch {}
    return null;
  }

  async getWebBalance() {
    try {
      const data = await this.getRewardsDashboardData();
      const balance = data?.dashboard?.availablePoints ?? data?.dashboard?.userStatus?.availablePoints ?? data?.balance;
      if (balance !== undefined && balance !== null && balance !== '') {
        return Number(balance);
      }
    } catch {}
    return null;
  }

  async getMobileSnapshot() {
    try {
      const res = await this.withTokenRetry(token => networkClient.request({
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=105',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': 'cn',
          'x-rewards-language': 'zh'
        }
      }));
      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      const balance = data?.response?.balance;
      const normalizedBalance = balance !== undefined && balance !== null && balance !== ''
        ? Number(balance)
        : null;
      return {
        balance: Number.isFinite(normalizedBalance) ? normalizedBalance : null,
        userName: extractAccountDisplayName(data?.response)
      };
    } catch {}
    return null;
  }

  async getMobileBalance() {
    const snapshot = await this.getMobileSnapshot();
    return toOptionalFiniteNumber(snapshot?.balance);
  }

  async getAppDashboardData() {
    try {
      const res = await this.withTokenRetry(token => networkClient.request({
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': 'cn',
          'x-rewards-language': 'zh'
        }
      }));
      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      return data?.response ? data : null;
    } catch {
      return null;
    }
  }

  async getAppPromotions() {
    const data = await this.getAppDashboardData();
    return normalizeAppPromotions(data);
  }

  /**
   * 上报移动端 sapphire 每日活动，并回读 DAPI 验证进度或完成状态。
   */
  async claimAppPromotion(promotion = {}) {
    const offerId = String(promotion.offerId || '').trim();
    if (!offerId) {
      return { success: false, verified: false, error: '缺少 App 活动 offerId' };
    }
    const region = 'cn';
    try {
      const res = await this.withTokenRetry(token => networkClient.request({
        method: 'POST',
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': region,
          'x-rewards-language': 'zh'
        },
        data: JSON.stringify(buildAppActivityPayload(offerId, {
          id: this.getRandomUUID().slice(0, 32),
          country: region,
          channel: APP_CONFIG.channel
        }))
      }));
      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      const points = Number(data?.response?.activity?.p || data?.response?.activity?.points || 0);
      const rawBalance = data?.response?.balance;
      const balanceValue = rawBalance === undefined || rawBalance === null || rawBalance === ''
        ? null
        : Number(rawBalance);
      const isDuplicate = !!data?.response?.isDuplicate;

      let after = null;
      let progressed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.delay(attempt === 0 ? 1200 : 900);
        const afterPromotions = await this.getAppPromotions();
        after = afterPromotions.find(item => (
          String(item.offerId || '').toLowerCase() === offerId.toLowerCase()
        ));
        progressed = !!after && (
          after.complete === true
          || after.progress > Number(promotion.progress || 0)
        );
        if (progressed || points > 0) break;
      }
      return {
        success: points > 0 || isDuplicate || progressed,
        points,
        balance: Number.isFinite(balanceValue) ? balanceValue : null,
        isDuplicate,
        verified: progressed || points > 0,
        before: promotion,
        after
      };
    } catch (e) {
      logger.log('🟡', `App 每日活动上报失败: ${e.message}`);
      return {
        success: false,
        verified: false,
        points: 0,
        balance: null,
        isDuplicate: false,
        error: e.message
      };
    }
  }

  async getBalance() {
    // 网页 Cookie 是当前账号身份的主来源；移动端 Token 可能误绑到别的账号。
    const webBalance = await this.getWebBalance();
    if (Number.isFinite(webBalance)) return webBalance;
    const mobileBalance = await this.getMobileBalance();
    if (Number.isFinite(mobileBalance)) return mobileBalance;
    // 取不到余额时返回 null，避免调用方把网络失败误当成「余额归零」写库
    return null;
  }

  /**
   * 独立读取搜索配额。仅在任务真正需要执行搜索且首轮配额为空时调用，
   * 用渐进延迟重试吸收官网偶发的骨架页/不完整 Flight 数据。
   */
  async getSearchQuota(options = {}) {
    const attempts = Math.min(6, Math.max(1, parseInt(options.attempts, 10) || 4));
    const retryDelaysMs = Array.isArray(options.retryDelaysMs)
      ? options.retryDelaysMs
      : [3000, 10000, 30000, 45000, 60000];
    const shouldStop = typeof options.shouldStop === 'function'
      ? options.shouldStop
      : () => false;
    const headers = {
      ...pcPageHeaders(),
      'cache-control': 'no-cache',
      'pragma': 'no-cache'
    };

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (shouldStop()) return { aborted: true };
      try {
        const cacheBust = Date.now();
        const [earnHtml, dashHtml] = await Promise.all([
          networkClient.request({
            url: `https://rewards.bing.com/earn?_=${cacheBust}`,
            headers
          }).catch(() => ''),
          networkClient.request({
            url: `https://rewards.bing.com/dashboard?_=${cacheBust}`,
            headers
          }).catch(() => '')
        ]);
        const quota = extractSearchQuota(
          { text: dashHtml, source: 'dashboard', priority: 0 },
          { text: earnHtml, source: 'earn', priority: 1 }
        );
        if (quota) return { ...quota, attemptsUsed: attempt };
      } catch {}

      if (attempt >= attempts) break;
      const delayMs = Math.max(0, Number(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)]) || 0);
      if (shouldStop()) return { aborted: true };
      if (typeof options.onRetry === 'function') {
        await options.onRetry({ attempt, attempts, delayMs });
      }
      if (delayMs > 0) {
        const deadline = Date.now() + delayMs;
        while (Date.now() < deadline) {
          if (shouldStop()) return { aborted: true };
          await this.delay(Math.min(250, Math.max(0, deadline - Date.now())));
        }
      }
    }
    return null;
  }

  /**
   * 获取用户积分、各项任务配额与明细 (Dashboard Info)
   */
  async getRewardsInfo(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const [html, dashHtml] = await Promise.all([
          networkClient.request({
            url: 'https://rewards.bing.com/earn',
            headers: pcPageHeaders()
          }),
          networkClient.request({
            url: 'https://rewards.bing.com/dashboard',
            headers: pcPageHeaders()
          }).catch(() => '')
        ]);
        const clean = String(html || '').replace(/\\"/g, '"');
        const cleanDash = String(dashHtml || '').replace(/\\"/g, '"');
        const quota = extractSearchQuota(
          { text: cleanDash, source: 'dashboard', priority: 0 },
          { text: clean, source: 'earn', priority: 1 }
        );
        let balance = 0;
        let webBalance = null;
        let pcMax = 0, pcCur = 0, mobMax = 0, mobCur = 0;
        let dailyOffer = 0;
        let searchQuotaFound = false;

        if (quota) {
          pcMax = Number(quota.max);
          pcCur = Number(quota.progress || 0);
          mobMax = Number(quota.mobileMax || 0);
          mobCur = Number(quota.mobileProgress || 0);
          dailyOffer = Number(quota.dailyOffer || 0);
          searchQuotaFound = Number.isFinite(pcMax) && pcMax > 0;
        }

        const balMatch = clean.match(/"balance":(\d+)/) || clean.match(/"availablePoints":(\d+)/);
        if (balMatch) {
          balance = parseInt(balMatch[1], 10);
          webBalance = balance;
        } else if (cleanDash) {
          const dashBalMatch = cleanDash.match(/"balance":(\d+)/)
            || cleanDash.match(/"availablePoints":(\d+)/)
            || cleanDash.match(/class="text-pageHeader">([\d,]+)</);
          if (dashBalMatch) {
            balance = parseInt(String(dashBalMatch[1]).replace(/,/g, ''), 10);
            webBalance = balance;
          }
        }

        // 官方页面偶发未取到有效余额时，尝试通过移动端 DAPI 接口获取真实账户余额。
        // 绝不能回退到用户配置里的静态 Cookie（如 rc=502&rb=502）：那是过去保存配置时的历史快照，
        // 拿旧快照当当前余额会触发「Token 余额与网页端不一致」的虚假风控告警，导致账号变红。
        if (!balance || balance <= 0) {
          try {
            const tokenBal = await this.getBalance();
            if (tokenBal > 0) balance = tokenBal;
          } catch {}
        }

        // 官方「今日积分」：earn 页顶部那张卡片直接展示的真实今日增量。
        // 这是唯一权威的「今日已增」来源，比「各任务积分求和」可靠得多
        // （旧实现求和会把没做的任务也算进去，实测能虚高几十点）。
        let todayPoints = null;
        const todayPointValues = [];
        const todayPointPatterns = [
          /"children":"(?:今日积分|Points earned today|Today(?:'|&#39;)s points)"[\s\S]{0,1600}?"className":"text-pageHeader","children":"([\d,]+)"/g,
          /(?:今日积分|Points earned today|Today(?:'|&#39;)s points)<\/p>[\s\S]{0,1200}?class="text-pageHeader">([\d,]+)</g
        ];
        for (const pattern of todayPointPatterns) {
          for (const match of clean.matchAll(pattern)) {
            const n = parseInt(String(match[1]).replace(/,/g, ''), 10);
            if (Number.isFinite(n)) todayPointValues.push(n);
          }
        }
        // 页面里可能同时存在多个同名卡片（如隐藏模板或旧 Flight 数据）。
        // 旧实现只取第一个，遇到首个值为 0 时会把真实今日积分覆盖成 0。
        if (todayPointValues.length > 0) {
          todayPoints = Math.max(...todayPointValues);
        }

        const todayDetails = [];
        if (searchQuotaFound) {
          todayDetails.push({ title: '必应搜索', points: pcCur, max: pcMax });
        }

        let readProgress = 0, readMax = 30;
        try {
          const readInfo = await this.getReadProgress();
          if (readInfo) {
            readProgress = readInfo.progress;
            readMax = readInfo.max;
          }
        } catch {}

        // 动态解析官网「任务」区域全部打孔卡（自适应 1 个、2 个或多个）
        const quests = this.extractQuests(clean);
        const desktopApp = quests.find(q => q.title.includes('桌面') || q.title.includes('RewardsApp')) || {
          title: "桌面奖励应用每周专属任务",
          progress: 0,
          max: 8,
          expiresText: '',
          available: false
        };
        const monthlyQuest = quests.find(q => /亮点|FY27|Monthly/i.test(q.title)) || null;

        // 印章进度提取 (如 8/12)
        let stampsProgress = 0, stampsMax = 12;
        const stampText = cleanDash.includes('收集的印章') ? cleanDash : clean;
        const stampMatch = stampText.match(/"aria-label":"收集的印章"[^}]*?"aria-valuemax":(\d+)[^}]*?"aria-valuenow":(\d+)/)
          || stampText.match(/aria-label="收集的印章"[^>]*?aria-valuemax="(\d+)"[^>]*?aria-valuenow="(\d+)"/);
        if (stampMatch) {
          const parsedMax = parseInt(stampMatch[1], 10);
          const parsedProgress = parseInt(stampMatch[2], 10);
          stampsMax = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 12;
          stampsProgress = Number.isFinite(parsedProgress) ? parsedProgress : 0;
        }

        // 平台待领取额外积分提取（位于 /dashboard 顶部卡片）
        let claimablePoints = 0;
        const claimableMatch = cleanDash.match(/可领取<\/p>[\s\S]*?class="text-pageHeader">(\d[\d,]*)</i)
          || cleanDash.match(/alt="可领取"[^>]*>[\s\S]*?(\d[\d,]*)/i);
        if (claimableMatch) {
          claimablePoints = parseInt(claimableMatch[1].replace(/,/g, ''), 10) || 0;
        }

        // 连续打卡任务（必应搜索 / 每日活动 / 必应应用）的真实状态。
        // 精准提取独立 streak 对象，彻底杜绝向前切片窗口抓到 edge 导致 bingapp 被误判为 0/7 的 Bug。
        const streaks = this.extractStreakModels(clean, cleanDash);
        const specialActivities = extractSpecialActivitiesFromHtml(clean);

        return {
          balance,
          webBalance,
          balanceKnown: Number.isFinite(webBalance),
          todayPoints,
          claimablePoints,
          pc: searchQuotaFound ? { progress: pcCur, max: pcMax } : null,
          mobile: searchQuotaFound ? { progress: mobCur, max: mobMax } : null,
          readProgress,
          readMax,
          dailyOffer,
          todayDetails,
          desktopApp,
          monthlyQuest,
          quests,
          specialActivities,
          searchTier: searchQuotaFound ? searchTierFromMax(pcMax) : null,
          searchQuotaSource: quota?.source || '',
          stamps: {
            progress: stampsProgress,
            max: stampsMax
          },
          streaks
        };
      } catch (e) {
        if (attempt < maxRetries) {
          await this.delay(3000);
          continue;
        }
        logger.log('🔴', `获取仪表盘信息失败: ${e.message}`);
        return null;
      }
    }
    return null;
  }

  normalizeQuestTitle(title) {
    return String(title || '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  extractQuestCards(cleanText) {
    const text = String(cleanText || '');
    const cards = [];
    const byId = new Map();
    const hrefRe = /"href"\s*:\s*"\/earn\/quest\/([^"?]+)(?:\?[^"]*)?"/g;
    const titlePatterns = [
      /"alt"\s*:\s*"([^"]+)"/g,
      /"text-globalBody2Strong"\s*,\s*"children"\s*:\s*"([^"]+)"/g,
      /<h3[^>]*>([^<]+)<\/h3>/gi
    ];
    const ignoredTitles = new Set(['今日积分', '任务', '查看']);
    const decode = (value) => String(value || '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    const findNearestTitleBeforeProgress = (chunk) => {
      let best = '';
      for (const pattern of titlePatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(chunk)) !== null) {
          const title = decode(match[1]).replace(/\s+/g, ' ').trim();
          if (title && !ignoredTitles.has(title) && !/^\$undefined$/.test(title)) best = title;
        }
      }
      return best;
    };

    let hrefMatch;
    while ((hrefMatch = hrefRe.exec(text)) !== null) {
      const questId = hrefMatch[1];
      if (!questId || questId.includes('newuser_onboarding')) continue;
      const chunk = text.slice(hrefMatch.index, Math.min(text.length, hrefMatch.index + 30000));
      const progressMatch = chunk.match(/"children"\s*:\s*"(\d+)\s*\/\s*(\d+)\s*个任务"/)
        || chunk.match(/(\d+)\s*\/\s*(\d+)\s*个任务/);
      const titleRegion = progressMatch ? chunk.slice(0, progressMatch.index) : chunk.slice(0, 10000);
      const title = findNearestTitleBeforeProgress(titleRegion);
      const progress = progressMatch ? Number(progressMatch[1]) : 0;
      const max = progressMatch ? Number(progressMatch[2]) : 0;
      const previous = byId.get(questId);
      if (!previous) {
        const card = {
          questId,
          title,
          progress,
          max,
          done: max > 0 && progress >= max,
          url: `https://rewards.bing.com/earn/quest/${questId}`
        };
        byId.set(questId, card);
        cards.push(card);
      } else {
        if (!previous.title && title) previous.title = title;
        if (!previous.max && max > 0) {
          previous.progress = progress;
          previous.max = max;
          previous.done = progress >= max;
        }
      }
    }
    return cards;
  }

  /**
   * 从 Flight 数据流或 HTML 中动态提取全部「任务」区打孔卡
   */
  extractQuests(cleanText) {
    const quests = [];
    const questIndexByKey = new Map();
    const cards = this.extractQuestCards(cleanText).filter(card => card.title && card.max > 0);

    const canonicalQuestKey = (title) => {
      const text = String(title || '').toLowerCase();
      if (/halloween|万圣节/.test(text)) return 'halloween';
      if (/桌面|rewardsapp/.test(text)) return 'desktop';
      if (/亮点|fy27|monthly/.test(text)) return 'monthly';
      return `title:${text.replace(/\s+/g, '')}`;
    };

    const addQuest = (title, curP, maxP, chunk, questId = '') => {
      if (!title || title.includes('开始使用 Rewards')) return;
      let expText = '';
      const expM = chunk.match(/expiresAt[^0-9]{0,40}(\d{4}-\d{2}-\d{2}T[^\"]+)/);
      if (expM) {
        const d = new Date(expM[1]);
        if (!isNaN(d.getTime())) {
          const today = new Date(); today.setHours(0, 0, 0, 0);
          const exp = new Date(d); exp.setHours(0, 0, 0, 0);
          const days = Math.max(0, Math.round((exp.getTime() - today.getTime()) / 86400000));
          expText = `到期日期 ${days} 天后`;
        }
      } else {
        const mExpText = chunk.match(/到期日期[^<\"{\\\\]*?(\d+\s*(?:天|周|月)后)/);
        if (mExpText) expText = `到期日期 ${mExpText[1]}`;
      }

      const ptsM = chunk.match(/\[\"[\+\"]*\",\"?(\d+)\"?\]/) || chunk.match(/\+(\d+)/);
      const isDesktop = title.includes('桌面') || title.includes('RewardsApp');
      const pts = ptsM ? parseInt(ptsM[1], 10) : (isDesktop ? 20 : 50);

      let icon = '🎯';
      if (title.includes('Halloween') || title.includes('万圣节')) icon = '🎃';
      else if (isDesktop) icon = 'rewards-app';
      else if (title.includes('秋') || title.includes('亮点')) icon = '🍁';

      const key = canonicalQuestKey(title);
      const existingIndex = questIndexByKey.get(key);
      const next = {
        questId,
        title,
        progress: curP,
        max: maxP,
        points: pts,
        expiresText: expText,
        available: true,
        done: curP >= maxP,
        icon
      };

      if (existingIndex === undefined) {
        questIndexByKey.set(key, quests.length);
        quests.push(next);
        return;
      }

      // 同一活动在 Flight 数据里可能同时出现中英文标题。
      // 必须合并为一张卡，并取较高的真实进度，不能被 0/6 的英文副本覆盖。
      const existing = quests[existingIndex];
      existing.progress = Math.max(Number(existing.progress || 0), Number(next.progress || 0));
      existing.max = Math.max(Number(existing.max || 0), Number(next.max || 0));
      existing.done = existing.progress >= existing.max;
      existing.points = Math.max(Number(existing.points || 0), Number(next.points || 0));
      if (!existing.expiresText && next.expiresText) existing.expiresText = next.expiresText;
      if (!existing.questId && next.questId) existing.questId = next.questId;
      const chineseScore = (value) => /[\u4e00-\u9fff]/.test(String(value || '')) ? 2 : 1;
      if (chineseScore(next.title) > chineseScore(existing.title)) existing.title = next.title;
      if (next.icon && !existing.icon) existing.icon = next.icon;
    };

    // 0. 当前 Next.js Flight 数据：按 href 精确关联标题与进度
    for (const card of cards) {
      addQuest(card.title, card.progress, card.max, '', card.questId);
    }

    // 1. Flight stream 模式：标题 + 任务进度
    const flightRegex = /\"text-globalBody2Strong\",\"children\":\"([^\"]+)\"[\s\S]{0,1500}?\"children\":\"(\d+)\/(\d+)\s*个任务\"/g;
    let m;
    while (cards.length === 0 && (m = flightRegex.exec(cleanText)) !== null) {
      addQuest(m[1], parseInt(m[2], 10), parseInt(m[3], 10), cleanText.slice(Math.max(0, m.index - 500), m.index + 1500));
    }

    // 2. HTML 标题标签备用模式 (h1 / h2 / h3)
    if (cards.length === 0 && quests.length === 0) {
      const htmlRegex = /<h[1-3][^>]*>([^<]+)<\/h[1-3]>[\s\S]{0,1200}?(\d+)\/(\d+)\s*个任务/gi;
      while ((m = htmlRegex.exec(cleanText)) !== null) {
        addQuest(m[1].trim(), parseInt(m[2], 10), parseInt(m[3], 10), cleanText.slice(Math.max(0, m.index - 200), m.index + 1500));
      }
    }

    // 3. 兜底常见打孔卡关键词识别
    if (quests.length === 0 && cleanText.includes('十月必看五大亮点')) {
      addQuest('十月必看五大亮点：服饰、玩具、手机、超值优惠和AI设备', 1, 5, cleanText.slice(cleanText.indexOf('十月必看五大亮点') - 200, cleanText.indexOf('十月必看五大亮点') + 1500));
    }
    if (!quests.some(q => q.title.includes('Halloween')) && cleanText.includes('Halloween')) {
      const hIdx = cleanText.indexOf('Halloween');
      addQuest('A 50-point Halloween treat', 0, 6, cleanText.slice(Math.max(0, hIdx - 300), hIdx + 1500));
    }

    return quests;
  }

  /**
   * 查询「必应应用连续打卡」今日的真实完成状态。
   *
   * 签到接口在「已签过」和「没签成」两种情况下都可能返回 0 积分，
   * 单看返回值分不清，所以这里直接读官网 earn 页里的 streak 模型做判定。
   */
  async getAppCheckInStatus(options = {}) {
    let webStatus = null;
    if (options.allowWebFallback !== false) {
      // 当前官网把权威连签状态放在 /dashboard；/earn 的旧 Flight 模型经常是 0/7。
      // 必须先走 getRewardsInfo 的合并解析，否则同一次执行里会出现前后状态互相矛盾。
      try {
        const info = await this.getRewardsInfo(1);
        const streak = info?.streaks?.bingapp;
        if (streak) webStatus = streak;
      } catch {}

      if (!webStatus) {
        try {
          const html = await networkClient.request({
            url: 'https://rewards.bing.com/earn',
            headers: pcPageHeaders()
          });
          if (html) {
            const clean = String(html).replace(/\\"/g, '"');
            const key = '"partner":"bingapp"';
            let idx = -1;
            // partner 会出现两次（埋点 data 与真正的 streak 模型），只有模型那段带 completedDays
            while ((idx = clean.indexOf(key, idx + 1)) !== -1) {
              const win = clean.slice(Math.max(0, idx - 1600), idx + 300);
              if (!/"completedDays":\d+/.test(win)) continue;
              webStatus = {
                isCurrentDayCompleted: /"isCurrentDayCompleted":true/.test(win),
                completedDays: Number((win.match(/"completedDays":(\d+)/) || [])[1] || 0),
                currentDay: Number((win.match(/"currentDay":(\d+)/) || [])[1] || 0)
              };
              break;
            }
          }
        } catch {}
      }
      // 网页端是用户实际看到的 Rewards 状态，明确 true/false 都必须优先。
      // DAPI 的 check-in promotion 可能属于另一个 App 功能，甚至返回 5/7，
      // 不能再覆盖网页端明确显示的 0/7。
      if (webStatus && typeof webStatus.isCurrentDayCompleted === 'boolean') {
        return webStatus;
      }
    }

    // 新版 App 的连签状态可能只存在于 DAPI promotion，Web Flight 里没有模型。
    const promotions = await this.getAppPromotions().catch(() => []);
    const dapiStatus = getAppCheckInStatusFromPromotions(promotions);
    return dapiStatus || webStatus || null;
  }

  /**
   * 移动端 App 签入
   */
  async signApp() {
    const region = 'cn';
    try {
      const res = await this.withTokenRetry(token => networkClient.request({
        method: 'POST',
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': region,
          'x-rewards-language': 'zh',
          'x-rewards-partnerid': 'startapp',
          'x-rewards-flights': 'rwgobig'
        },
        data: JSON.stringify({
          amount: 1,
          id: this.getDapiId(),
          // 新版 App 的签到活动按普通领取活动处理。type=103 仅触发启动上报，
          // 接口会返回 200，但连签 progress 和 last_updated 不会推进。
          type: 101,
          country: region,
          channel: APP_CONFIG.channel,
          // 关键修复：必须带上 offerid，微软才会把它计入「必应应用连续打卡」。
          // 缺了 attributes.offerid 时接口同样返回 200，但连签任务不会推进，
          // 这正是之前「必应应用连续打卡」一直显示 0/1 的原因。
          attributes: { offerid: APP_CONFIG.offerIds.dailyCheckIn }
        })
      }));

      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      if (data?.response) {
        if (data.response.activity) {
          const act = data.response.activity;
          const points = Number(act.p || act.points || 0);
          const appliedOffer = act.a?.offerid || act.attributes?.offerid || '';
          // balance 是「该 Token 所属账号」的积分，可用于判断 Token 与 Cookie 是否同一个号
          const balance = Number(data.response.balance);
          return {
            points,
            offerId: appliedOffer,
            isDuplicate: !!data.response.isDuplicate,
            balance: Number.isFinite(balance) ? balance : null
          };
        }
        if (data.response.isDuplicate || data.response.activity === null) {
          const balance = Number(data.response.balance);
          return {
            points: 0,
            offerId: APP_CONFIG.offerIds.dailyCheckIn,
            isDuplicate: true,
            balance: Number.isFinite(balance) ? balance : null
          };
        }
      }
    } catch (e) {
      logger.log('🔴', `App 签入异常: ${e.message}`);
      return { points: 0, offerId: APP_CONFIG.offerIds.dailyCheckIn, isDuplicate: false, balance: null, error: e.message };
    }
    return { points: 0, offerId: APP_CONFIG.offerIds.dailyCheckIn, isDuplicate: false, balance: null, error: '接口未返回有效结果' };
  }

  /**
   * PC 端签入
   */
  async signPC() {
    // 优先采用 Server Action 方式签入（避免官方旧接口 401 报废）
    try {
      const ok = await this.claimCard({
        offerId: 'Gamification_DailyCheckIn',
        hash: '1',
        url: 'https://rewards.bing.com/earn'
      });
      if (ok) return 10;
    } catch {}

    try {
      const token = await this.getRequestVerificationToken();
      const params = new URLSearchParams({
        id: 'Gamification_DailyCheckIn',
        hash: '1',
        activityAmount: '1'
      });
      if (token) params.set('__RequestVerificationToken', token);

      const headers = {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        ...pcXhrHeaders(),
        'referer': 'https://rewards.bing.com/',
        'origin': 'https://rewards.bing.com',
        'x-requested-with': 'XMLHttpRequest'
      };
      if (token) headers['RequestVerificationToken'] = token;

      const res = await networkClient.request({
        method: 'POST',
        url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
        headers,
        data: params.toString()
      });

      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      if (data) {
        return Number(data.points || data.response?.activity?.p || 0);
      }
    } catch (e) {
      // 官方改版后旧接口频报 401，移动端已签入成功时静默处理
    }
    return 0;
  }

  async getRequestVerificationToken(pageUrl = 'https://rewards.bing.com/') {
    try {
      const html = await networkClient.request({
        url: pageUrl,
        headers: pcPageHeaders({ referer: 'https://rewards.bing.com/' })
      });
      const tokenMatch = String(html).match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)
        || String(html).match(/RequestVerificationToken.*?value=["']([^"']+)["']/i)
        || String(html).match(/"verificationToken"\s*:\s*"([^"]+)"/i)
        || String(html).match(/"__RequestVerificationToken"\s*:\s*"([^"]+)"/i);
      return tokenMatch ? tokenMatch[1].replace(/&amp;/g, '&') : '';
    } catch {
      return '';
    }
  }

  /**
   * 查询新闻资讯阅读进度
   */
  async getReadProgress() {
    try {
      const promotions = await this.getAppPromotions();
      const task = promotions.find(isAppReadPromotion);
      if (task) return {
        progress: Math.max(0, Number(task.progress || 0)),
        max: Math.max(1, Number(task.max || 30))
      };
    } catch (e) {
      logger.log('🔴', `阅读进度查询失败: ${e.message}`);
    }
    return null;
  }

  /**
   * 执行单篇新闻阅读打卡
   */
  async doReadArticle() {
    const region = 'cn';
    try {
      const res = await this.withTokenRetry(token => networkClient.request({
        method: 'POST',
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': region,
          'x-rewards-language': 'zh'
        },
        data: JSON.stringify({
          amount: 1,
          country: region,
          id: this.getRandomUUID().slice(0, 32),
          type: 101,
          attributes: { offerid: APP_CONFIG.offerIds.readArticle }
        })
      }));

      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      if (data?.response) {
        return {
          points: data.response?.activity?.p || 0,
          isDuplicate: data.response?.isDuplicate || false
        };
      }
      return null;
    } catch (e) {
      logger.log('🔴', `阅读上报失败: ${e.message}`);
      return false;
    }
  }

  /**
   * 扫描「任务」区的打孔卡 (Quest Punch Card)
   *
   * 像「十月必看五大亮点」这类每月/每周任务：每天解锁一个小任务，
   * 完成当天任务后要等满 24 小时才会解锁下一个，全部完成才给奖励分。
   * 旧实现只认识桌面客户端的 WW_pcchild 打孔卡，这类网页打孔卡完全没被处理，
   * 所以在官网会一直停在 0/5。
   */
  async getQuestPunchCards() {
    const quests = [];
    try {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: pcPageHeaders()
      });
      if (!html) return quests;

      const clean = String(html).replace(/\\"/g, '"').replace(/\\u0026/g, '&');
      const seen = new Set();
      const allQuests = this.extractQuests(clean);
      const cards = this.extractQuestCards(clean);
      for (const card of cards) {
        const questId = card.questId;
        if (seen.has(questId) || questId.includes('newuser_onboarding')) continue;
        seen.add(questId);
        const normalizedTitle = this.normalizeQuestTitle(card.title);
        let matched = normalizedTitle
          ? allQuests.find(q => this.normalizeQuestTitle(q.title) === normalizedTitle)
          : null;
        if (!matched && questId.includes('Halloween')) {
          matched = allQuests.find(q => /Halloween|万圣节/i.test(q.title));
        }
        if (!matched && questId.includes('RewardsApp')) {
          matched = allQuests.find(q => /桌面|RewardsApp/i.test(q.title));
        }
        if (!matched && questId.includes('BingMonthlyPC')) {
          matched = allQuests.find(q => /亮点|FY27|Monthly/i.test(q.title));
        }
        if (!matched && /Duolingo/i.test(questId)) {
          matched = allQuests.find(q => /Duolingo/i.test(q.title));
        }
        const progress = card.max > 0 ? card.progress : Number(matched?.progress ?? 0);
        const max = card.max > 0 ? card.max : Number(matched?.max ?? 0);
        const done = card.max > 0 ? card.done : !!matched?.done;
        quests.push({
          questId,
          title: card.title || matched?.title || questId,
          url: card.url,
          progress,
          max,
          done
        });
      }
    } catch (e) {
      logger.log('🔴', `扫描任务打孔卡失败: ${e.message}`);
    }
    return quests;
  }

  /**
   * 读取「日常任务」区（activityCards）的真实完成情况。
   *
   * 用于「今天一张可领卡片都没扫到」时区分到底是「今天没有活动」还是
   * 「已经全部完成」，避免旧实现那样无脑把 promos 标成完成。
   */
  async getActivityCardStatus() {
    try {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: pcPageHeaders()
      });
      if (!html) return null;
      const clean = String(html).replace(/\\"/g, '"');
      if (!clean.includes('"activityCards":[')) return null;
      // 特殊活动由独立任务处理，不能混入普通活动卡片的完成分母。
      const cards = extractActivityCardsFromHtml(clean)
        .filter(card => !classifySpecialActivity(card));
      if (cards.length === 0) return null;
      const completed = cards.filter(c => c.isCompleted === true).length;
      return { total: cards.length, completed };
    } catch {
      return null;
    }
  }

  async getSpecialActivities() {
    try {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: pcPageHeaders()
      });
      return extractSpecialActivitiesFromHtml(html);
    } catch (e) {
      logger.log('🟡', `特殊活动状态读取失败: ${e.message}`);
      return null;
    }
  }

  async discoverCards(options = {}) {
    const attempts = Math.min(4, Math.max(1, parseInt(options.attempts, 10) || 1));
    const retryEmpty = options.retryEmpty === true;
    const retryDelaysMs = Array.isArray(options.retryDelaysMs)
      ? options.retryDelaysMs
      : [3000, 8000, 15000];
    let cards = [];

    for (let attempt = 1; attempt <= attempts; attempt++) {
      cards = await this.discoverCardsOnce();
      const hasDiscoveredCards = cards.some(card => card.source !== 'dapi-dailyset-fallback');
      if (hasDiscoveredCards || !retryEmpty || attempt >= attempts) return cards;
      const delayMs = Math.max(
        0,
        Number(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)]) || 0
      );
      if (typeof options.onRetry === 'function') {
        await options.onRetry({ attempt, attempts, delayMs });
      }
      if (delayMs > 0) await this.delay(delayMs);
    }
    return cards;
  }

  async discoverCardsOnce() {
    const cards = [];
    const cardIndexByOfferId = new Map();

    const pushCard = (card) => {
      const hasAction = card?.hash || card?.destination || card?.kind === 'dapi_reward';
      if (!card || !card.offerId || !hasAction || card.points <= 0) return;
      const existingIndex = cardIndexByOfferId.get(card.offerId);
      if (existingIndex !== undefined) {
        if (!cards[existingIndex].hash && card.hash) {
          cards[existingIndex] = {
            ...card,
            category: card.category || cards[existingIndex].category
          };
        }
        return;
      }
      // 分类标记：供「每日活动集」「桌面端打孔卡」两个独立开关做过滤
      if (!card.category) {
        card.category = /dailyset/i.test(card.offerId) ? 'dailyset' : 'promo';
      }
      cardIndexByOfferId.set(card.offerId, cards.length);
      cards.push(card);
    };

    const inferKind = (offerId = '', title = '') => {
      const text = `${offerId} ${title}`.toLowerCase();
      if (/quiz|trivia|question|测验|答案/.test(text)) return 'quiz';
      if (/puzzle|拼图/.test(text)) return 'puzzle';
      if (/image|图片|设计/.test(text)) return 'image_creator';
      if (/explore|search|浏览|探索/.test(text)) return 'explore_search';
      if (/dailyset|daily|每日/.test(text)) return 'daily';
      if (/streak|打卡|连续/.test(text)) return 'streak';
      return 'open_only';
    };

    const addDailySetFallback = () => {
      if (cards.some(card => card.category === 'dailyset')) return;
      for (const card of buildDapiDailySetCards()) {
        pushCard(card);
      }
    };

    try {
      // Dashboard API 是 Daily Set 的主要来源。新版 /earn 经常只保留
      // more activities，而今日三张 Daily Set 只出现在 dashboard.dailySetPromotions。
      const dashboardData = await this.getRewardsDashboardData().catch(() => null);
      for (const card of extractDailySetCardsFromDashboard(dashboardData)) {
        pushCard(card);
      }

      const html = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: pcPageHeaders()
      });
      if (!html) {
        addDailySetFallback();
        return cards;
      }

      // 1. Next.js Flight Chunks 解析
      try {
        const chunks = [];
        const pushRegex = /self\.__next_f\.push\(\[\d+,\s*"(.*?)"\]\)/gs;
        let mFlight;
        while ((mFlight = pushRegex.exec(String(html))) !== null) {
          try {
            const unescaped = JSON.parse(`"${mFlight[1]}"`);
            chunks.push(unescaped);
          } catch {}
        }
        const fullFlightText = chunks.length > 0 ? chunks.join('') : String(html).replace(/\\"/g, '"');
        const offerObjRegex = /\{[^{}]*?"offerId"\s*:\s*"([^"]+)"[^{}]*?\}/g;
        let om;
        while ((om = offerObjRegex.exec(fullFlightText)) !== null) {
          try {
            const jsonStr = om[0].replace(/:\$undefined/g, ':null').replace(/:\$D[^\",}]+/g, ':null');
            const item = JSON.parse(jsonStr);
            if (!item.offerId || !item.hash) continue;
            if (item.isCompleted === true || item.isLocked === true) continue;
            const points = Number(item.points || 0);
            if (points <= 0 && !item.offerId.includes('DailySet')) continue;
            pushCard({
              title: item.title || item.name || item.offerId,
              points: points || 10,
              offerId: item.offerId,
              hash: item.hash,
              kind: inferKind(item.offerId, item.title || ''),
              destination: item.destination || item.destinationUrl || '',
              url: 'https://rewards.bing.com/earn'
            });
          } catch {}
        }
      } catch (e) {
        logger.log('🟡', `Flight 卡片数据解析异常: ${e.message}`);
      }

      // 2. 桌面客户端专属任务检测 (独家 70 积分/周)
      try {
        const questMatch = String(html).match(/href="(\/earn\/quest\/(WW_pcparent_RewardsApp_weekly_Exclusive[^"]+))"/i)
          || String(html).match(/"(\/earn\/quest\/(WW_pcparent_RewardsApp_weekly_Exclusive[^"]+))"/i);
        if (questMatch) {
          const questUrl = 'https://rewards.bing.com' + questMatch[1];
          const questHtml = await networkClient.request({
            url: questUrl,
            headers: DESKTOP_APP_HEADERS
          });
          if (questHtml) {
            const qChunks = [];
            const qPushRegex = /self\.__next_f\.push\(\[\d+,\s*"(.*?)"\]\)/gs;
            let qm;
            while ((qm = qPushRegex.exec(String(questHtml))) !== null) {
              try { qChunks.push(JSON.parse(`"${qm[1]}"`)); } catch {}
            }
            const qText = qChunks.length > 0 ? qChunks.join('') : String(questHtml).replace(/\\"/g, '"');
            const children = extractJsonObjectsWithKey(qText)
              .filter(item => /^WW_pcchild\d+_/.test(String(item.offerId || '')));
            const uniqueChildren = [...new Map(children.map(item => [item.offerId, item])).values()];
            const parentQuest = this.extractQuests(String(html).replace(/\\"/g, '"').replace(/\\u0026/g, '&'))
              .find(q => /桌面|RewardsApp/i.test(`${q.title || ''} ${q.questId || ''}`));
            const completedCount = Number(parentQuest?.progress || 0);
            const totalCount = Math.max(
              Number(parentQuest?.max || 0),
              uniqueChildren.length + completedCount
            );
            const lockedChildren = uniqueChildren.filter(item => (
              item.isLocked === true || item.isDisabled === true
            ));
            const readyChildren = uniqueChildren.filter(item => (
              item.isCompleted !== true
              && item.isLocked !== true
              && item.isDisabled !== true
              && !!item.hash
            ));

            for (const qItem of readyChildren) {
              logger.log('🖥️', `发现桌面端专享打卡任务: ${qItem.title || qItem.offerId}`);
              pushCard({
                title: `[桌面专享] ${qItem.title || qItem.name || qItem.offerId}`,
                points: Number(qItem.points || 10),
                offerId: qItem.offerId,
                hash: qItem.hash,
                kind: 'desktop_app',
                category: 'desktop',
                destination: qItem.destination || qItem.href || '',
                url: questUrl,
                parentQuestId: questMatch[1].match(/WW_pcparent_[^/?#]+/)?.[0] || '',
                unlockDay: weekdayFromOfferId(qItem.offerId),
                deploymentId: this.getDeploymentId(questHtml)
              });
            }

            if (uniqueChildren.length > 0 || totalCount > 0) {
              const nextDay = weekdayFromOfferId(lockedChildren[0]?.offerId);
              const nextDayLabel = {
                monday: '周一', tuesday: '周二', wednesday: '周三', thursday: '周四',
                friday: '周五', saturday: '周六', sunday: '周日'
              }[nextDay] || nextDay;
              const nextHint = nextDayLabel ? `，下一项 ${nextDayLabel} 解锁` : '';
              logger.log(
                '🖥️',
                `桌面每周专属任务：已完成 ${completedCount}/${totalCount}，本次可打卡 ${readyChildren.length} 项，锁定 ${lockedChildren.length} 项${nextHint}`
              );
            }
          }
        }
      } catch (eQuest) {
        logger.log('🟡', `桌面专属任务解析跳过: ${eQuest.message}`);
      }
    } catch (e) {
      logger.log('🔴', `扫描活动卡片失败: ${e.message}`);
    }

    // 新版 App 的 Daily Set 可能同时从 Dashboard API 和 /earn 消失。
    // 只有完全没发现 Daily Set 时才启用日期兜底，避免重复执行。
    addDailySetFallback();
    return cards;
  }

  getDeploymentId(html = '') {
    const text = String(html || '');
    const deploymentId = text.match(/[?&](?:amp;)?dpl=([A-Za-z0-9._-]+)/i)?.[1]
      || text.match(/"buildId"\s*:\s*"([A-Za-z0-9._-]+)"/i)?.[1]
      || text.match(/\/_next\/static\/([A-Za-z0-9._-]+)\//)?.[1]
      || '';
    if (deploymentId) {
      if (this.cachedDeploymentId && this.cachedDeploymentId !== deploymentId) {
        this.cachedNextAction = null;
      }
      this.cachedDeploymentId = deploymentId;
    }
    return this.cachedDeploymentId || '';
  }

  async getNextActionHash(html, baseUrl = 'https://rewards.bing.com') {
    if (!html || !String(html).includes('_next/static/')) return this.cachedNextAction;
    const source = String(html);
    const scriptSrcs = [...new Set(
      [...source.matchAll(/(?:src|href)="([^"]*\/_next\/static\/[^"]+?\.js(?:\?[^"]*)?)"/g)]
        .map(match => match[1])
    )];

    for (const src of scriptSrcs.slice(0, 80)) {
      try {
        const url = src.startsWith('http') ? src : new URL(src, baseUrl).toString();
        const chunkText = await networkClient.request({ url });
        const createReferenceRegex = /createServerReference\s*\)?\s*\(\s*"([a-f0-9]{40,64})"([\s\S]{0,800}?)\)/g;
        for (const match of String(chunkText).matchAll(createReferenceRegex)) {
          if (match[2].includes('reportActivity')) {
            this.cachedNextAction = match[1];
            return this.cachedNextAction;
          }
        }
      } catch {}
    }
    return this.cachedNextAction;
  }

  /**
   * 完成单张卡片打卡
   */
  async claimCard(card) {
    if (card.kind === 'dapi_reward') {
      const result = await this.claimAppPromotion({
        name: card.title,
        offerId: card.offerId,
        type: 'dailyset',
        complete: false,
        progress: 0,
        max: Number(card.points || 10)
      });
      this.lastCardReport = {
        status: null,
        acknowledged: result.success === true,
        dapi: true,
        points: Number(result.points || 0),
        verified: result.verified === true,
        error: result.error || ''
      };
      return result.success === true;
    }

    const url = card.url || 'https://rewards.bing.com/earn';
    const referer = card.url || 'https://rewards.bing.com/earn';
    let nextAction = this.cachedNextAction;

    // 策略 1: Next.js Server Action（只适用于带 hash 的网页卡片）
    if (card.hash) {
      try {
        let pageHtml = '';
        if (!nextAction
          || !this.cachedDeploymentId
          || (card.deploymentId && card.deploymentId !== this.cachedDeploymentId)) {
          pageHtml = await networkClient.request({
            url,
            headers: card.kind === 'desktop_app' ? DESKTOP_APP_HEADERS : pcPageHeaders()
          }).catch(() => '');
          this.getDeploymentId(pageHtml);
          nextAction = await this.getNextActionHash(pageHtml, url);
        }
        const headers = {
          ...(card.kind === 'desktop_app' ? DESKTOP_APP_HEADERS : {}),
          'accept': 'text/x-component',
          'content-type': 'text/plain;charset=UTF-8',
          'next-action': nextAction,
          'referer': referer,
          'origin': 'https://rewards.bing.com'
        };
        if (card.parentQuestId) {
          headers['next-router-state-tree'] = buildQuestRouterStateTree(card.parentQuestId);
        }
        if (this.cachedDeploymentId) {
          headers['x-deployment-id'] = this.cachedDeploymentId;
        }
        const response = await networkClient.request({
          method: 'POST',
          url,
          headers,
          data: JSON.stringify([card.hash, 11, { offerid: card.offerId, isPromotional: '$undefined', timezoneOffset: '-480' }]),
          returnResponse: true
        });
        this.lastCardReport = {
          status: response?.status || null,
          acknowledged: isServerActionAcknowledged(response?.data)
        };
        if (this.lastCardReport.acknowledged) {
          return true;
        }
      } catch (e) {
        if (e.message && e.message.includes('404')) {
          try {
            const earnHtml = await networkClient.request({ url: 'https://rewards.bing.com/earn' });
            this.getDeploymentId(earnHtml);
            nextAction = await this.getNextActionHash(earnHtml, 'https://rewards.bing.com/earn');
            const retryResponse = await networkClient.request({
              method: 'POST',
              url,
              headers: {
                ...(card.kind === 'desktop_app' ? DESKTOP_APP_HEADERS : {}),
                accept: 'text/x-component',
                'content-type': 'text/plain;charset=UTF-8',
                'next-action': nextAction,
                referer,
                origin: 'https://rewards.bing.com',
                ...(card.parentQuestId ? { 'next-router-state-tree': buildQuestRouterStateTree(card.parentQuestId) } : {}),
                ...(this.cachedDeploymentId ? { 'x-deployment-id': this.cachedDeploymentId } : {})
              },
              data: JSON.stringify([card.hash, 11, { offerid: card.offerId, isPromotional: '$undefined', timezoneOffset: '-480' }]),
              returnResponse: true
            });
            this.lastCardReport = {
              status: retryResponse?.status || null,
              acknowledged: isServerActionAcknowledged(retryResponse?.data)
            };
            if (this.lastCardReport.acknowledged) return true;
          } catch {}
        }
      }
    }

    // 桌面 App 专属任务必须由 Server Action 明确确认，不能走普通网页上报兜底。
    if (card.kind === 'desktop_app') return false;

    // 策略 2: 每日活动目标链接搜索上报
    if (card.destination && card.destination.startsWith('http')) {
      try {
        if (await this.reportDailyActivity(card.destination)) return true;
      } catch {}
    }

    // 策略 3: 老版 reportactivity
    try {
      const token = await this.getRequestVerificationToken();
      if (token) {
        await networkClient.request({
          method: 'POST',
          url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
          headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            ...pcXhrHeaders(),
            'referer': referer,
            'origin': 'https://rewards.bing.com',
            'x-requested-with': 'XMLHttpRequest'
          },
          data: new URLSearchParams({
            id: card.offerId,
            hash: card.hash,
            timeZone: 480,
            activityAmount: 1,
            dbs: 0,
            form: '',
            type: '',
            __RequestVerificationToken: token
          }).toString()
        });
        return true;
      }
    } catch {}

    return false;
  }

  async reportDailyActivity(searchUrl) {
    try {
      const fullUrl = searchUrl.startsWith('http') ? searchUrl : `https://cn.bing.com${searchUrl}`;
      const ig = this.getRandomUUID().substring(0, 32).toUpperCase();
      const cnUrl = fullUrl.replace(/^https?:\/\/www\.bing\.com/, 'https://cn.bing.com')
                           .replace(/^https:\/\/bing\.com/, 'https://cn.bing.com');
      const cnUrlObj = new URL(cnUrl);
      const cnSp = cnUrlObj.searchParams;
      const reportParams = new URLSearchParams();
      reportParams.set('IG', ig);
      reportParams.set('IID', 'commerce.5067');
      if (cnSp.get('form')) reportParams.set('form', cnSp.get('form'));
      if (cnSp.get('ocid') || cnSp.get('OCID')) reportParams.set('ocid', cnSp.get('ocid') || cnSp.get('OCID'));

      await networkClient.request({
        method: 'GET',
        url: cnUrl,
        headers: {
          ...pcPageHeaders(),
          'referer': 'https://rewards.bing.com/'
        }
      });

      await networkClient.request({
        method: 'POST',
        url: `https://cn.bing.com/rewardsapp/reportActivity?${reportParams.toString()}`,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...pcXhrHeaders(),
          'referer': cnUrl,
          'origin': 'https://cn.bing.com'
        },
        data: new URLSearchParams({ url: cnUrl, V: 'web' }).toString()
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 探测并获取当前词库明细列表（用于前端测试与热词轮询）
   */
  async fetchSearchWordList(mode = 'offline') {
    if (mode === 'offline') {
      const sample = SEARCH_POOL.slice(0, 100);
      return { success: true, mode: 'offline', name: '本地离线智能词库', count: SEARCH_POOL.length, sample };
    }

    const apiMap = {
      'baidu.official': { url: 'https://top.baidu.com/api/board?platform=wise&tab=realtime', name: '百度官方实时热搜榜 (直连)' },
      'hot.cnxiaobai.com': { url: 'https://cnxiaobai.com/DailyHotApi/baidu', name: 'DailyHotApi 聚合榜单 (cnxiaobai)' },
      'hot.nntool.cc': { url: 'https://hotapi.nntool.cc/baidu', name: '今日热榜聚合榜单 (nntool)' }
    };

    const target = apiMap[mode] || apiMap['baidu.official'];
    try {
      const res = await networkClient.request({ url: target.url });
      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      let words = [];

      if (mode === 'baidu.official') {
        const rawList = data?.data?.cards?.[0]?.content?.[0]?.content || [];
        words = rawList.map(item => item.word).filter(Boolean);
      } else {
        if (data && Array.isArray(data.data)) {
          words = data.data.map(item => item.title || item.word).filter(Boolean);
        }
      }

      const uniqueWords = Array.from(new Set(words.map(item => String(item || '').trim()).filter(Boolean)));

      if (uniqueWords.length > 0) {
        return { success: true, mode, name: target.name, count: uniqueWords.length, sample: uniqueWords.slice(0, 100) };
      }
      return { success: false, mode, name: target.name, message: '接口返回数据为空或格式变动' };
    } catch (e) {
      return { success: false, mode, name: target.name, message: `网络请求失败: ${e.message}` };
    }
  }

  /**
   * 获取热搜词（支持多 API 轮换与本地随机词池）
   */
  async getHotSearchWord(options = {}) {
    const cfg = configManager.get();
    const mode = cfg.tasks?.searchApi || 'baidu.official';
    const excludeSet = options instanceof Set
      ? options
      : (options?.exclude instanceof Set ? options.exclude : new Set(Array.isArray(options?.exclude) ? options.exclude : []));

    if (mode !== 'offline') {
      try {
        if (this.hotWordList.length === 0 || this.hotWordIndex >= this.hotWordList.length) {
          const listResult = await this.fetchSearchWordList(mode);
          if (listResult.success && Array.isArray(listResult.sample) && listResult.sample.length > 0) {
            this.hotWordList = listResult.sample;
            this.hotWordIndex = 0;
          }
        }
        while (this.hotWordList.length > 0 && this.hotWordIndex < this.hotWordList.length) {
          const word = this.hotWordList[this.hotWordIndex++];
          if (typeof word === 'string' && word.trim()) {
            const candidate = word.trim().slice(0, 30);
            if (!excludeSet.has(candidate)) {
              return candidate;
            }
          }
        }
      } catch (e) {
        logger.log('🟡', `热搜词获取接口异常: ${e.message}，切换到离线词池`, '', logger.getAccountContext());
      }
    }
    for (let attempts = 0; attempts < 50; attempts++) {
      const baseWord = SEARCH_POOL[this.randomRange(0, SEARCH_POOL.length - 1)];
      const randomSuffix = Math.random().toString(36).slice(2, 6);
      const fallbackSentence = `${baseWord} ${randomSuffix}`.slice(0, 30);
      if (!excludeSet.has(fallbackSentence)) {
        return fallbackSentence;
      }
    }
    const baseWord = SEARCH_POOL[this.randomRange(0, SEARCH_POOL.length - 1)];
    return `${baseWord} ${Date.now().toString(36).slice(-4)}`.slice(0, 30);
  }

  /**
   * 执行 PC 端搜索请求与奖励上报
   */
  async doSearchOnce(query) {
    const ig = this.getRandomUUID();
    const mkt = '&mkt=zh-CN';
    const searchUrl = `https://${this.host}/search?q=${encodeURIComponent(query)}&form=QBLH${mkt}`;
    const dateNowStr = `${new Date().getMonth() + 1}/${new Date().getDate()}/${new Date().getFullYear()}`;
    // 关键：_Rwho 必须叠加在账号 Cookie 之上，直接设置 'cookie' 头会覆盖
    // networkClient 自动注入的登录 Cookie（_U/_C_Auth 等），导致搜索不计分。
    // 同时剔除旧版残留的 _EDGE_S 与重复的 _Rwho，避免 Cookie 头里出现同名项。
    const accountCookie = networkClient.getCookieString(`https://${this.host}/`)
      .split(';')
      .map(p => p.trim())
      .filter(p => p && !/^_EDGE_S=/i.test(p) && !/^_Rwho=/i.test(p))
      .join('; ');
    const searchCookie = [accountCookie, `_Rwho=u=d&ts=${dateNowStr}`].filter(Boolean).join('; ');

    // 1. 请求搜索页面
    await networkClient.request({
      url: searchUrl,
      headers: {
        ...pcPageHeaders(),
        'cookie': searchCookie,
        'referer': `https://${this.host}/?form=QBLH`
      }
    });

    // 2. 模拟报送 ncheader
    try {
      await networkClient.request({
        method: 'POST',
        url: `https://${this.host}/rewardsapp/ncheader?ver=88888888&IID=SERP.5047&IG=${ig}&ajaxreq=1`,
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          ...pcXhrHeaders(),
          'referer': `https://${this.host}/?form=QBLH`,
          'cookie': searchCookie
        },
        data: 'wb=1%3bi%3d1%3bv%3d1'
      });
    } catch {}

    // 3. 模拟报送 reportActivity
    const params = `q=${encodeURIComponent(query)}&form=QBLH${mkt}`;
    await networkClient.request({
      method: 'POST',
      url: `https://${this.host}/rewardsapp/reportActivity?IG=${ig}&IID=SERP.5047&${params}&ajaxreq=1`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        ...pcXhrHeaders(),
        'referer': `https://${this.host}/?form=QBLH`,
        'cookie': searchCookie
      },
      data: `url=${encodeURIComponent(`https://${this.host}/search?${params}`)}&V=web`
    });

    return true;
  }

  /**
   * 连签任务检测与视觉搜索
   *
   * 注意：视觉搜索（vsstreak）没法靠一次 HTTP GET 真正完成，原实现每次检测到
   * 未完成就发一次请求，于是「检测到未打卡」会无限刷屏，并且高频访问微软接口
   * 存在风控风险。现改为：
   *   - 只有任务执行期（allowVisualSearchCheckIn=true）才尝试补签；
   *   - 每个账号每天最多尝试一次；
   *   - 跳过时不再打日志，避免刷屏。
   */
  async checkStreak(options = {}) {
    const { allowVisualSearchCheckIn = false } = options;
    try {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: pcPageHeaders()
      });
      if (!html) return null;

      const text = String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
      let streakDays = 0;
      const mStreak = text.match(/每日连续打卡\s*(\d+)/);
      if (mStreak) {
        streakDays = parseInt(mStreak[1]) || 0;
      }

      // 检测视觉搜索
      const vsMatch = text.match(/视觉搜索连续打卡[\s\S]*?活动:\s*(\d+)\/(\d+)/);
      if (vsMatch) {
        const cur = parseInt(vsMatch[1]);
        const max = parseInt(vsMatch[2]);
        if (cur < max && allowVisualSearchCheckIn) {
          const accountKey = this.currentAccountId || 'acc_1';
          const d = new Date();
          const today = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
          if (!this.visualSearchCheckInAt) this.visualSearchCheckInAt = {};
          if (this.visualSearchCheckInAt[accountKey] !== today) {
            this.visualSearchCheckInAt[accountKey] = today;
            logger.log('📅', `视觉搜索未完成 (${cur}/${max})，尝试后台补签（每账号每天一次）...`);
            await networkClient.request({
              url: 'https://www.bing.com/?features=vsstreak,vstooltip&form=ML2XES',
              headers: pcPageHeaders({ referer: 'https://www.bing.com/' })
            });
            await this.randomDelay(2000, 4000);
          }
        }
      }

      return { streakDays };
    } catch (e) {
      logger.log('🔴', `连签检测异常: ${e.message}`);
      return null;
    }
  }

  /**
   * 检测 Dashboard 额外积分
   */
  async checkClaimablePoints({ logFound = true } = {}) {
    try {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/dashboard',
        headers: pcPageHeaders()
      });
      const claimableMatch = String(html).match(/alt="可领取"[^>]*>[\s\S]*?(\d[\d,]*)/i);
      if (claimableMatch) {
        const amount = parseInt(claimableMatch[1].replace(/,/g, '')) || 0;
        if (amount > 0 && logFound) {
          logger.log('🎁', `发现 ${amount} 点额外积分待手动确认领奖`);
        }
        return amount;
      }
      return 0;
    } catch {
      return null;
    }
  }
}

export const rewardsApi = new RewardsApi();
export default rewardsApi;
