import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import configManager from './config.js';
import { normalizeProxyUrl } from './core/proxy.js';

// 只有这些域名才允许附带微软账号 Cookie。
// 否则推送渠道（企业微信/钉钉/飞书/Bark/PushMe/Telegram）、热搜词接口、IP 查询接口
// 都会收到完整的 Bing 会话 Cookie —— 那等于把账号凭据发给第三方。
const MICROSOFT_COOKIE_DOMAINS = [
  'bing.com',
  'microsoft.com',
  'live.com',
  'msn.com',
  'microsoftonline.com',
  'microsoftonline.cn',
  'windows.net',
  'office.com',
  'sharepoint.com',
  'microsoft365.com'
];

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN'
]);

const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isTransientNetworkError(error) {
  if (!error || error.response) return false;
  const code = String(error.code || '').toUpperCase();
  if (TRANSIENT_NETWORK_CODES.has(code)) return true;
  const message = String(error.message || '');
  return /Socks5 proxy rejected connection|NetworkUnreachable|socket hang up|ECONNRESET|ECONNABORTED|ETIMEDOUT/i.test(message);
}

function isMicrosoftHost(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return MICROSOFT_COOKIE_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * 规整化 Cookie 字符串，兼容 Safari / Chrome / Edge 不同的复制格式。
 * 移除多余换行符、制表符与重复分号，防止 Node.js http 抛出 Invalid character in header。
 */
export function normalizeCookieString(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .split(/[\r\n]+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      // 兼容 Safari 表格复制格式：name \t value
      if (line.includes('\t') && !line.includes('=')) {
        const cols = line.split('\t');
        return `${cols[0].trim()}=${cols[1].trim()}`;
      }
      return line;
    })
    .join('; ')
    .replace(/;\s*;/g, ';')
    .trim();
}

class NetworkClient {
  constructor() {
    this.cookieJar = new Map();
    this.activeCookie = null;
    // null 表示没有账号上下文，使用全局默认代理；对象用于明确记录账号的代理策略。
    this.activeProxyContext = null;
    this.initDefaultCookies();
  }

  setActiveCookie(cookieStr) {
    this.activeCookie = (cookieStr === undefined || cookieStr === null)
      ? null
      : normalizeCookieString(String(cookieStr));
  }

  /**
   * 切换账号时同时绑定代理上下文，确保 HTTP API 与浏览器使用同一出口。
   * 指定节点缺失时保持“直连”，不回退到全局默认代理。
   */
  setActiveAccount(acc) {
    this.setActiveCookie(acc ? (acc.cookie || '') : null);
    if (!acc) {
      this.activeProxyContext = null;
      return;
    }
    const mode = configManager.getAccountProxyMode(acc);
    const proxy = configManager.getEffectiveProxy(acc);
    this.activeProxyContext = {
      mode,
      proxyId: proxy?.id || acc.proxyId || '',
      proxyName: proxy?.name || '',
      proxyUrl: proxy?.url || '',
      missing: mode === 'proxy' && !proxy
    };
  }

  getActiveProxyContext() {
    return this.activeProxyContext ? structuredClone(this.activeProxyContext) : null;
  }

  setActiveProxyContext(context) {
    this.activeProxyContext = context ? structuredClone(context) : null;
  }

  /**
   * 在账号尚未落库时，为一次 Cookie 测试 / Token 换取临时指定出口。
   * 选择必须是显式的，避免候选账号误用当前上下文中的其他账号代理。
   */
  setActiveProxySelection(selection) {
    if (!selection || typeof selection !== 'object') return;
    const mode = ['inherit', 'direct', 'proxy'].includes(selection.mode)
      ? selection.mode
      : 'direct';
    if (mode === 'inherit') {
      this.activeProxyContext = { mode, proxyId: '', proxyName: '', proxyUrl: '', missing: false };
      return;
    }
    if (mode === 'direct') {
      this.activeProxyContext = { mode, proxyId: '', proxyName: '', proxyUrl: '', missing: false };
      return;
    }

    const savedProxy = selection.proxyId ? configManager.findProxy(selection.proxyId) : null;
    const proxyUrl = savedProxy?.url || normalizeProxyUrl(selection.url || selection.proxyUrl || '');
    if (!proxyUrl) {
      throw new Error('已选择指定代理，但代理节点不存在');
    }
    this.activeProxyContext = {
      mode: 'proxy',
      proxyId: savedProxy?.id || 'candidate_proxy',
      proxyName: savedProxy?.name || '候选代理',
      proxyUrl,
      missing: false
    };
  }

  /** 读取当前生效的账号 Cookie（null 表示「未指定账号，走默认账号回退」） */
  getActiveCookie() {
    return this.activeCookie;
  }

  initDefaultCookies() {
    const cfg = configManager.get();
    if (cfg.account?.cookie) {
      this.parseAndStoreCookies(cfg.account.cookie, 'rewards.bing.com');
      this.parseAndStoreCookies(cfg.account.cookie, 'bing.com');
    }
  }

  parseAndStoreCookies(cookieStr, domain = 'bing.com') {
    if (!cookieStr || typeof cookieStr !== 'string') return;
    const normalized = normalizeCookieString(cookieStr);
    const parts = normalized.split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        this.setCookie(key, val, domain);
      }
    }
  }

  setCookie(key, value, domain = 'bing.com') {
    if (key === '_EDGE_S') return; // 原脚本明确需清除此 cookie
    this.cookieJar.set(`${domain}:${key}`, value);
    this.cookieJar.set(`*:${key}`, value);
  }

  deleteCookie(key, domain = 'bing.com') {
    this.cookieJar.delete(`${domain}:${key}`);
    this.cookieJar.delete(`*:${key}`);
  }

  getCookieString(targetUrl) {
    // 必须用 !== null：空字符串代表「当前账号没有 Cookie」，不能回退
    if (this.activeCookie !== null) {
      return this.activeCookie;
    }

    let hostname = '';
    try {
      hostname = new URL(targetUrl).hostname;
    } catch {
      hostname = 'bing.com';
    }

    const cfg = configManager.get();
    const cookies = new Map();

    // 先导入用户配置的原始 Cookie
    if (cfg.account?.cookie) {
      const parts = normalizeCookieString(cfg.account.cookie).split(';');
      for (const p of parts) {
        const t = p.trim();
        const eq = t.indexOf('=');
        if (eq > 0) {
          const k = t.slice(0, eq).trim();
          const v = t.slice(eq + 1).trim();
          if (k !== '_EDGE_S') {
            cookies.set(k, v);
          }
        }
      }
    }

    // 再注入运行时动态积累的 Cookie
    for (const [dk, v] of this.cookieJar.entries()) {
      const [dom, k] = dk.split(':');
      if (dom === '*' || hostname.endsWith(dom) || dom.endsWith(hostname)) {
        if (k !== '_EDGE_S') {
          cookies.set(k, v);
        }
      }
    }

    return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  getEffectiveProxyUrl(options = {}) {
    if (options.proxyUrl !== undefined) {
      if (options.useProxy === false) return '';
      return normalizeProxyUrl(options.proxyUrl);
    }
    if (options.useProxy === false) return '';

    // Epic 等全局接口不属于当前微软账号，必须显式忽略账号级代理上下文，
    // 否则上一个账号的代理会残留在后续无关请求中。
    if (options.ignoreAccountProxy !== true) {
      const ctx = this.activeProxyContext;
      if (ctx) {
        if (ctx.mode === 'direct' || ctx.missing) return '';
        if (ctx.mode === 'proxy') return ctx.proxyUrl || '';
      }
    }

    const network = configManager.get().network || {};
    if (!network.useProxy) return '';
    const defaultProxy = configManager.getDefaultProxy();
    return defaultProxy?.url || '';
  }

  createAgent(proxyUrl) {
    const normalized = normalizeProxyUrl(proxyUrl);
    if (!normalized) return null;
    if (/^(socks|socks4|socks5|socks5h):\/\//i.test(normalized)) {
      return new SocksProxyAgent(normalized);
    }
    return new HttpsProxyAgent(normalized);
  }

  getAgent(options = {}) {
    return this.createAgent(this.getEffectiveProxyUrl(options));
  }

  /**
   * 核心网络请求方法，兼容原脚本 Utils.xhr
   */
  async request(options) {
    const {
      url,
      method = 'GET',
      headers = {},
      data,
      timeout = 20000,
      followRedirects = true,
      cookieOverride = null,
      responseType = 'text',
      proxyUrl,
      useProxy,
      ignoreAccountProxy = false,
      returnResponse = false,
      retryTransient = true,
      transientRetries = 1,
      transientRetryDelaysMs = [600]
    } = options;

    const finalHeaders = { ...headers };
    if (finalHeaders.cookie !== undefined) {
      finalHeaders.cookie = normalizeCookieString(String(finalHeaders.cookie));
    }
    if (finalHeaders.Cookie !== undefined) {
      finalHeaders.Cookie = normalizeCookieString(String(finalHeaders.Cookie));
    }

    // 自动添加 Cookie（仅限微软/Bing 域名，防止账号凭据外泄给第三方接口）
    const cookieHeader = cookieOverride !== null
      ? normalizeCookieString(String(cookieOverride))
      : (isMicrosoftHost(url) ? this.getCookieString(url) : '');
    if (cookieHeader && !finalHeaders['cookie'] && !finalHeaders['Cookie']) {
      finalHeaders['cookie'] = cookieHeader;
    }

    const normalizedMethod = String(method || 'GET').toUpperCase();
    const maxTransientRetries = retryTransient && RETRYABLE_METHODS.has(normalizedMethod)
      ? Math.max(0, Math.min(2, Math.trunc(Number(transientRetries) || 0)))
      : 0;
    const retryDelays = Array.isArray(transientRetryDelaysMs) ? transientRetryDelaysMs : [600];

    for (let attempt = 0; attempt <= maxTransientRetries; attempt++) {
      // 每次重试重新创建 agent，避免复用已被 SOCKS 服务端关闭的底层连接。
      const agent = this.getAgent({ proxyUrl, useProxy, ignoreAccountProxy });
      const axiosConfig = {
        url,
        method: normalizedMethod,
        headers: finalHeaders,
        data,
        timeout,
        responseType,
        validateStatus: (status) => {
          if (!followRedirects) {
            return (status >= 200 && status < 400);
          }
          return status >= 200 && status < 300;
        }
      };

      if (agent) {
        axiosConfig.httpAgent = agent;
        axiosConfig.httpsAgent = agent;
      }

      if (!followRedirects) {
        axiosConfig.maxRedirects = 0;
      }

      try {
        const response = await axios(axiosConfig);

        // 处理 Set-Cookie
        if (response.headers['set-cookie']) {
          let domain = 'bing.com';
          try { domain = new URL(url).hostname; } catch {}
          const setCookies = Array.isArray(response.headers['set-cookie'])
            ? response.headers['set-cookie']
            : [response.headers['set-cookie']];
          for (const sc of setCookies) {
            const cookiePart = sc.split(';')[0];
            const eq = cookiePart.indexOf('=');
            if (eq > 0) {
              const k = cookiePart.slice(0, eq).trim();
              const v = cookiePart.slice(eq + 1).trim();
              this.setCookie(k, v, domain);
            }
          }
        }

        // 如果是重定向响应，返回 Location
        if ([301, 302, 307, 308].includes(response.status)) {
          return response.headers.location || true;
        }

        return returnResponse
          ? { data: response.data, status: response.status, headers: response.headers }
          : response.data;
      } catch (error) {
        if (error.response && [301, 302, 307, 308].includes(error.response.status)) {
          return error.response.headers.location || true;
        }
        if (attempt < maxTransientRetries && isTransientNetworkError(error)) {
          const delayMs = Math.max(0, Number(retryDelays[Math.min(attempt, retryDelays.length - 1)]) || 0);
          if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
          continue;
        }
        const status = error.response ? `HTTP ${error.response.status}` : (error.code || error.message);
        const wrapped = new Error(`${status}`);
        wrapped.code = error.code || '';
        wrapped.response = error.response;
        wrapped.cause = error;
        throw wrapped;
      }
    }

    throw new Error('网络请求失败');
  }

  xhr(options) {
    return this.request(options);
  }
}

export const networkClient = new NetworkClient();
export default networkClient;
