import configManager from '../config.js';
import networkClient from '../network.js';
import logger from '../logger.js';
import { APP_ID, APP_USER_AGENT, pcPageHeaders } from './fingerprint.js';
import {
  accountNamesLikelyMatch,
  cookieValue,
  extractAccountDisplayName,
  isBalanceMismatch,
  searchTierFromMax
} from './accountIdentity.js';

export const AUTH_CONFIG = {
  clientId: '0000000040170455',
  scope: 'service::prod.rewardsplatform.microsoft.com::MBI_SSL',
  redirectUri: 'https://login.live.com/oauth20_desktop.srf',
  authorizeUrl: 'https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&response_type=code&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf',
  tokenUrl: 'https://login.live.com/oauth20_token.srf'
};

export function isActualLoginPageHtml(text) {
  const source = String(text || '');
  const hasCredentialInput = /<(?:input|textarea)[^>]+(?:name|id)=["'](?:loginfmt|i0116|passwd|i0118|password)["']/i.test(source);
  const hasLoginForm = /<form[^>]+action=["'][^"']*login\.(?:live|microsoft)\.com/i.test(source);
  const hasLoginTitle = /<title[^>]*>\s*(?:Sign in|登录)[^<]*Microsoft/i.test(source);
  return hasCredentialInput || hasLoginForm || hasLoginTitle;
}

export class AuthManager {
  constructor() {
    this.accessToken = null;
    this.initFromConfig();
  }

  initFromConfig() {
    const cfg = configManager.get();
    if (cfg.account?.accessToken) {
      this.accessToken = cfg.account.accessToken;
    }
  }

  getAccessToken(accountId = null) {
    // 不传 accountId 时返回全局 token（单账号兼容路径）。
    if (!accountId) return this.accessToken || null;
    // 传了 accountId 就必须精确命中该账号，并且只能用它自己的 token。
    // 旧写法 `acc?.accessToken || this.accessToken` 会在这个账号 token 为空时
    // 回退到「上一个刷新成功的账号」的 token —— 结果副账号的 App 签到 / 阅读
    // 会被算到主账号头上（典型的串号）。
    const acc = configManager.findAccount(accountId);
    if (!acc) return null;
    return acc.accessToken || null;
  }

  /**
   * 从粘贴的 URL 或 code 字符串中提取 code
   */
  extractCode(input) {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (trimmed.includes('code=')) {
      try {
        const u = new URL(trimmed);
        return u.searchParams.get('code');
      } catch {
        const m = trimmed.match(/[?&]code=([^&#]+)/);
        return m ? decodeURIComponent(m[1]) : null;
      }
    }
    return trimmed;
  }

  /**
   * 通过授权码换取 Token
   */
  async exchangeCodeForToken(codeOrUrl, accountId = null, accountMeta = {}) {
    const code = this.extractCode(codeOrUrl);
    if (!code) {
      throw new Error('无效的授权码或链接，未找到 code 参数');
    }

    // 必须精确匹配：accountId 不存在时不能用 getAccount()，
    // 它会静默回退到第一个账号，导致「配置向导换 Token」覆盖主账号。
    const targetAccount = configManager.findAccount(accountId);
    const targetId = targetAccount?.id || accountId || `acc_${Date.now()}`;
    const displayName = targetAccount?.name || accountMeta.name || targetId;

    const params = new URLSearchParams({
      client_id: AUTH_CONFIG.clientId,
      code: code,
      redirect_uri: AUTH_CONFIG.redirectUri,
      grant_type: 'authorization_code'
    });

    const prevCtx = logger.getAccountContext();
    logger.setAccountContext(displayName);

    try {
      logger.log('🔑', `正在为账号 [${displayName}] 换取访问令牌 (Token)...`);
      const res = await networkClient.request({
        url: AUTH_CONFIG.tokenUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: params.toString()
      });

      const data = typeof res === 'string' ? JSON.parse(res) : res;
      if (data.error) {
        throw new Error(`${data.error}: ${data.error_description || ''}`);
      }

      if (data.access_token && data.refresh_token) {
        if (accountMeta.persist !== false) {
          this.accessToken = data.access_token;
        }
        if (accountMeta.persist !== false) {
          configManager.upsertAccount({
            id: targetId,
            // 新账号需要带上名称与序号，否则会生成名为「账号 N」的占位账号
            ...(targetAccount ? {} : { name: accountMeta.name, order: accountMeta.order }),
            authCodeUrl: codeOrUrl,
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            tokenTime: Date.now()
          });
        }
        logger.log('🟢', accountMeta.persist === false
          ? `账号 [${displayName}] OAuth Token 换取成功（向导草稿，尚未写入配置）`
          : `账号 [${displayName}] OAuth Token 换取成功并已持久化保存！`);
        return {
          success: true,
          accountId: targetId,
          accessToken: data.access_token,
          refreshToken: data.refresh_token
        };
      }
      throw new Error('响应中未找到 access_token 或 refresh_token');
    } catch (e) {
      logger.log('🔴', `换取 Token 失败: ${e.message}`);
      throw e;
    } finally {
      logger.setAccountContext(prevCtx);
    }
  }

  /**
   * 使用 Refresh Token 刷新 Access Token
   */
  async refreshToken(force = false, accountId = null, options = {}) {
    const acc = configManager.resolveAccount(accountId);
    if (!acc) return false;
    if (acc.enabled === false && options.allowPaused !== true) {
      logger.log('⏸️', `账号 [${acc.name || acc.id}] 已暂停，自动流程跳过 Token 刷新`, acc.name || acc.id);
      return false;
    }

    // 本函数内的日志统一归属到该账号
    const prevCtx = logger.getAccountContext();
    logger.setAccountContext(acc.name || acc.id);

    let refreshToken = acc.refreshToken;
    const tokenTime = acc.tokenTime || 0;

    // 检查有效期，如果刚刷过且没有强制要求，且已经有 accessToken，则直接复用
    const diffHours = (Date.now() - tokenTime) / (1000 * 60 * 60);
    if (!force && acc.accessToken && diffHours < 12) {
      this.accessToken = acc.accessToken;
      logger.setAccountContext(prevCtx);
      return true;
    }

    if (!refreshToken) {
      logger.log('🟡', `账号 [${acc.name || acc.id}] 未配置 Refresh Token，跳过 Token 刷新`);
      logger.setAccountContext(prevCtx);
      return false;
    }

    const params = new URLSearchParams({
      client_id: AUTH_CONFIG.clientId,
      refresh_token: refreshToken,
      scope: AUTH_CONFIG.scope,
      grant_type: 'REFRESH_TOKEN'
    });

    try {
      logger.log('🔄', `正在为账号 [${acc.name || acc.id}] 自动续期刷新 OAuth Token...`);
      const res = await networkClient.request({
        url: AUTH_CONFIG.tokenUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: params.toString()
      });

      const data = typeof res === 'string' ? JSON.parse(res) : res;
      if (data.error) {
        logger.log('🔴', `账号 [${acc.name}] 刷新 Token 失败: ${data.error} - ${data.error_description || ''}`);
        if (['invalid_grant', 'invalid_request'].includes(data.error)) {
          configManager.upsertAccount({
            id: acc.id,
            accessToken: null,
            refreshToken: null,
            tokenTime: 0
          });
        }
        return false;
      }

      if (data.access_token && data.refresh_token) {
        this.accessToken = data.access_token;
        configManager.upsertAccount({
          id: acc.id,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          tokenTime: Date.now(),
          preserveDiagnosis: true
        });
        logger.log('🟢', `账号 [${acc.name}] OAuth Token 续期刷新成功！`);
        return true;
      }
      return false;
    } catch (e) {
      logger.log('🔴', `刷新 Token 请求异常: ${e.message}`);
      return false;
    } finally {
      logger.setAccountContext(prevCtx);
    }
  }

  /**
   * 验证网页端 Cookie 是否有效并拉取账号详情
   */
  async checkCookieStatus(cookieOverride = null, accountId = null) {
    const acc = configManager.resolveAccount(accountId);
    const cookie = cookieOverride || acc?.cookie;
    if (!cookie) {
      return { valid: false, message: '尚未配置网页端 Cookie' };
    }

    // 优先采用微软最新 Next.js earn 页面进行鉴权检测（解决官方 getuserinfo 接口频报 401 的缺陷）
    try {
      const headers = pcPageHeaders({
        'referer': 'https://rewards.bing.com/',
        'cookie': cookie
      });
      const [earnHtml, dashHtml] = await Promise.all([
        networkClient.request({
          url: 'https://rewards.bing.com/earn',
          headers
        }),
        networkClient.request({
          url: 'https://rewards.bing.com/dashboard',
          headers
        }).catch(() => '')
      ]);

      const clean = String(earnHtml).replace(/\\"/g, '"');
      const cleanDash = String(dashHtml).replace(/\\"/g, '"');
      const authText = `${clean}\n${cleanDash}`;
      const quotaText = clean.includes('"pointsCounters"') ? clean : cleanDash;
      const isAuthValid = authText.includes('pointsCounters')
        || authText.includes('pointsHistory')
        || authText.includes('activityCards');

      if (isAuthValid) {
        let balance = 0;
        let pcProgress = 0, pcMax = 0;
        let streakDays = 0;
        let userName = '';

        // 1. 提取 PC 搜索配额
        const pcIdx = quotaText.indexOf('"pointsCounters":{');
        if (pcIdx !== -1) {
          let start = pcIdx + 17, depth = 0, end = start;
          for (let i = start; i < quotaText.length && i < start + 500; i++) {
            if (quotaText[i] === '{') depth++;
            if (quotaText[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
          }
          try {
            const pts = JSON.parse(quotaText.substring(start, end));
            pcMax = Number(pts.pc?.max);
            pcProgress = pts.pc?.progress ?? 0;
            if (pts.totalPoints != null) balance = Number(pts.totalPoints);
          } catch {}
        }

        // 2. 提取当前总积分余额
        const balMatch = clean.match(/"balance":(\d+)/)
          || clean.match(/"availablePoints":(\d+)/)
          || cleanDash.match(/"balance":(\d+)/)
          || cleanDash.match(/"availablePoints":(\d+)/)
          || authText.match(/class="text-pageHeader">([\d,]+)</);
        if (balMatch) {
          balance = parseInt(String(balMatch[1]).replace(/,/g, ''), 10);
        }

        // 3. 提取连续签到打卡天数
        const streakMatch = authText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').match(/每日连续打卡\s*(\d+)/);
        if (streakMatch) {
          streakDays = parseInt(streakMatch[1], 10);
        }

        // 4. 提取用户名
        const nameMatch = cookie.match(/N=([^;]+)/);
        if (nameMatch) {
          try { userName = decodeURIComponent(nameMatch[1]); } catch {}
        }

        // 5. 提取印章进度 (如 8/12)
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

        // 6. 检查是否存在必应搜索关键登录标头 _U
        const hasU = !!cookieValue(cookie, '_U');
        const searchTier = Number.isFinite(pcMax) && pcMax > 0 ? searchTierFromMax(pcMax) : null;
        const searchReady = hasU && !!searchTier && searchTier.code !== 'unknown';
        const uWarning = hasU ? '' : ' | ⚠️缺少 _U 登录标头，必应搜索无法关联账号计分！请在电脑登录 rewards.bing.com/dashboard 重新抓取完整 Cookie';

        return {
          valid: true,
          hasU,
          searchReady,
          searchTier,
          warning: !hasU,
          warningMessage: hasU ? '' : '缺少 _U 登录标头：必应搜索无法关联账号计分，请在电脑登录 rewards.bing.com/dashboard 后重新抓取完整 Cookie',
          balance,
          userName: userName || '微软用户',
          streakDays,
          stamps: {
            progress: stampsProgress,
            max: stampsMax
          },
          pcSearch: searchReady ? `${pcProgress}/${pcMax}` : '未读取',
          message: `网页端已登录成功！${userName ? `用户: ${userName} | ` : ''}积分: ${balance} | 连续签到: ${streakDays}天 | 印章进度: ${stampsProgress}/${stampsMax} | 搜索配额: ${searchReady ? `${pcProgress}/${pcMax} (${searchTier?.label || '等级未知'})` : '官网未返回'}${uWarning}`
        };
      }

      // 只有真正的登录表单/登录 URL 才能判定 Cookie 过期。
      // 已登录页面也可能在脚本或隐藏导航里出现 login.live.com / Sign in，
      // 旧实现因此会把正常页面误报成 Cookie 失效。
      if (isActualLoginPageHtml(authText)) {
        return { valid: false, message: 'Cookie 已过期失效，页面提示需要重新登录' };
      }

      return {
        valid: false,
        transient: true,
        message: '微软 Rewards 页面响应不完整，未据此判定 Cookie 失效，请稍后重试'
      };
    } catch (e) {
      if (e.message && e.message.includes('401')) {
        return { valid: false, message: '微软官方返回 HTTP 401（未授权），Cookie 已过期，请在浏览器重新登录后获取' };
      }
      return {
        valid: false,
        transient: true,
        message: `网页端请求失败: ${e.message}`
      };
    }
  }

  /**
   * 实测移动端 OAuth Token 与 DAPI 接口连通性
   */
  async checkTokenStatus(accountId = null, options = {}) {
    const acc = options.accountOverride || configManager.resolveAccount(accountId);
    let token = options.accessToken || null;
    if (!token && !acc?.refreshToken && !acc?.accessToken) {
      return { valid: false, message: '尚未完成移动端授权 (未配置 Token)' };
    }

    if (!token) {
      const tokenOk = await this.refreshToken(false, accountId, options);
      token = this.getAccessToken(accountId);
      if (!tokenOk || !token) {
        return { valid: false, message: 'Refresh Token 已过期或失效，请重新授权' };
      }
    }

    try {
      const res = await networkClient.request({
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': APP_USER_AGENT,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_ID,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': 'cn',
          'x-rewards-language': 'zh'
        }
      });

      const data = typeof res === 'string' ? JSON.parse(res) : res;
      if (data?.response) {
        const balance = Number(data.response.balance || 0);
        const userName = extractAccountDisplayName(data.response);
        const promos = data.response.promotions || [];
        const readTask = promos.find(x => x.attributes?.offerid === 'ENUS_readarticle3_30points');
        const readProg = readTask ? `${readTask.attributes.progress || 0}/${readTask.attributes.max || 30}` : '就绪';
        return {
          valid: true,
          balance,
          userName,
          readProgress: readProg,
          message: `移动端已登录${userName ? ` | 用户: ${userName}` : ''} | 积分: ${balance} | 阅读进度: ${readProg}`
        };
      }
      return { valid: true, message: '移动端 Token 有效' };
    } catch (e) {
      return { valid: false, message: `移动端 DAPI 接口验证失败: ${e.message}` };
    }
  }

  /**
   * 一键全面诊断测试账户在 Docker 中的登录状态
   */
  async testAccount(accountId = null, options = {}) {
    const acc = configManager.resolveAccount(accountId);
    const name = acc?.name || accountId || '当前账号';
    const prevCtx = logger.getAccountContext();
    logger.setAccountContext(name);
    logger.log('🔍', `开始检测账号 [${name}] 在 Docker 容器中的登录状态...`);

    const [cookieStatus, tokenStatus] = await Promise.all([
      this.checkCookieStatus(null, accountId),
      this.checkTokenStatus(accountId, options)
    ]);

    const hasCode = !!acc?.authCodeUrl;
    const codeStatus = {
      valid: hasCode || tokenStatus.valid,
      message: hasCode ? '授权码链接已配置' : (tokenStatus.valid ? '已通过历史授权码成功获取Token' : '尚未填写授权码链接')
    };

    const balance = cookieStatus.valid
      ? Number(cookieStatus.balance || 0)
      : Number(tokenStatus.balance || 0);
    const balanceMismatch = cookieStatus.valid && tokenStatus.valid
      && Number.isFinite(Number(cookieStatus.balance)) && Number.isFinite(Number(tokenStatus.balance))
      && isBalanceMismatch(cookieStatus.balance, tokenStatus.balance);
    const nameMatch = cookieStatus.valid && tokenStatus.valid
      ? accountNamesLikelyMatch(cookieStatus.userName, tokenStatus.userName)
      : null;
    const nameMismatch = nameMatch === false;
    const tokenAccountMismatch = balanceMismatch || nameMismatch;
    if (tokenAccountMismatch) {
      tokenStatus.mismatch = true;
      tokenStatus.message += nameMismatch
        ? ` | ⚠️ Token 用户(${tokenStatus.userName || '未知'}) 与网页端(${cookieStatus.userName || '未知'}) 不一致，疑似绑定到了其他微软账号`
        : ` | ⚠️ Token 所属账号积分(${tokenStatus.balance}) 与网页端(${cookieStatus.balance}) 不一致，疑似绑定到了其他微软账号`;
    }
    // 缺少 _U 时虽然「已登录」，但 PC 搜索不会计分，不能算完全正常
    const cookieUsable = cookieStatus.valid && !cookieStatus.warning && cookieStatus.searchReady;
    const allValid = cookieUsable && tokenStatus.valid && !tokenAccountMismatch;
    // 红绿状态以双端为准：任意一端失效都必须标红，避免 Token 过期仍显示绿色。
    const overallValid = !!cookieStatus.valid && !!tokenStatus.valid;
    const partialValid = !!cookieStatus.valid || !!tokenStatus.valid;
    const warning = !!cookieStatus.warning || !cookieStatus.searchReady || tokenAccountMismatch;
    const warningMessage = tokenAccountMismatch
      ? (nameMismatch
        ? `移动端 Token 与网页端 Cookie 疑似属于不同账号（用户 ${tokenStatus.userName || '未知'} vs ${cookieStatus.userName || '未知'}），请重新完成移动端授权`
        : `移动端 Token 与网页端 Cookie 疑似属于不同账号（余额 ${tokenStatus.balance} vs ${cookieStatus.balance}），请重新完成移动端授权`)
      : (cookieStatus.warningMessage
        || (cookieStatus.valid && !cookieStatus.searchReady ? 'Cookie 有效，但官网未返回当日搜索等级配额，已暂停 PC 搜索以避免按错误上限执行' : ''));

    if (allValid) {
      logger.log('🟢', `账号 [${name}] 登录检测完全通过！网页端与移动端均在线，当前总积分: ${balance}`);
    } else if (tokenAccountMismatch) {
      logger.log('🔴', `账号 [${name}] 移动端 Token 绑定错误：Token 余额 ${tokenStatus.balance}，网页端余额 ${cookieStatus.balance}`);
    } else if (cookieStatus.valid && cookieStatus.warning) {
      logger.log('🟡', `账号 [${name}] 网页端 Cookie 异常：${cookieStatus.warningMessage}`);
    } else if (partialValid) {
      logger.log('🟡', `账号 [${name}] 部分登录有效：网页端(${cookieStatus.valid ? '正常' : '未就绪'}) / 移动端(${tokenStatus.valid ? '正常' : '未就绪'})`);
    } else {
      logger.log('🔴', `账号 [${name}] 尚未登录或凭证已失效`);
    }

    logger.setAccountContext(prevCtx);

    return {
      accountId: acc?.id || 'acc_1',
      accountName: name,
      cookie: cookieStatus,
      code: codeStatus,
      token: tokenStatus,
      balance,
      allValid,
      overallValid,
      warning,
      warningMessage
    };
  }
}

export const authManager = new AuthManager();
export default authManager;
