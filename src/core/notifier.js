import configManager from '../config.js';
import networkClient from '../network.js';
import logger from '../logger.js';
import { normalizeProxyUrl } from './proxy.js';

const NOTIFY_CHANNEL_LABELS = {
  wework: '企业微信',
  dingding: '钉钉',
  feishu: '飞书',
  bark: 'Bark',
  pushme: 'PushMe',
  telegram: 'Telegram',
  qqbot: 'QQ 机器人'
};

export class Notifier {
  getNotificationProxyOptions(channel, override = null) {
    if (!NOTIFY_CHANNEL_LABELS[channel]) {
      throw new Error('不支持的通知渠道');
    }

    const configured = configManager.get().notify?.proxy || {};
    let enabled = configured.channels?.[channel] === true;
    let rawUrl = configured.url || '';
    if (override && typeof override === 'object') {
      if (override.channels && typeof override.channels === 'object') {
        enabled = override.channels[channel] === true;
      }
      if (override.useProxy !== undefined || override.enabled !== undefined) {
        enabled = override.useProxy === true || override.enabled === true;
      }
      if (override.proxyUrl !== undefined || override.url !== undefined) {
        rawUrl = override.proxyUrl ?? override.url ?? '';
      }
    }

    if (!enabled) {
      return { useProxy: false, proxyUrl: '', ignoreAccountProxy: true };
    }
    const proxyUrl = normalizeProxyUrl(rawUrl);
    if (!proxyUrl) {
      throw new Error(`「${NOTIFY_CHANNEL_LABELS[channel]}」已启用推送代理，但未填写专用代理地址`);
    }
    return { useProxy: true, proxyUrl, ignoreAccountProxy: true };
  }

  async send(title, content) {
    const cfg = configManager.get();
    const notify = cfg.notify || {};
    const timeStr = new Date().toLocaleString('zh-CN', { hour12: false });
    const fullContent = `【${title}】\n时间: ${timeStr}\n\n${content}`;

    const tasks = [];

    // 1. 企业微信
    if (notify.wework) {
      tasks.push(this.sendWeWork(notify.wework.trim(), fullContent));
    }

    // 2. 钉钉
    if (notify.dingding) {
      tasks.push(this.sendDingTalk(notify.dingding.trim(), title, fullContent));
    }

    // 3. 飞书
    if (notify.feishu) {
      tasks.push(this.sendFeishu(notify.feishu.trim(), title, fullContent));
    }

    // 4. Bark
    if (notify.bark) {
      tasks.push(this.sendBark(notify.bark.trim(), title, content));
    }

    // 5. PushMe
    if (notify.pushme) {
      tasks.push(this.sendPushMe(notify.pushme.trim(), title, content));
    }

    // 6. Telegram
    if (notify.telegram?.botToken && notify.telegram?.chatId) {
      tasks.push(this.sendTelegram(
        notify.telegram.botToken.trim(),
        notify.telegram.chatId.trim(),
        title,
        fullContent
      ));
    }

    // 7. QQ 官方机器人 (QQBot OpenAPI v2)
    if (notify.qqbot?.appId && notify.qqbot?.clientSecret && (notify.qqbot?.openId || notify.qqbot?.groupOpenId)) {
      tasks.push(this.sendQqBot(
        notify.qqbot,
        title,
        fullContent
      ));
    }

    if (tasks.length > 0) {
      const results = await Promise.allSettled(tasks);
      return results;
    }
  }

  async sendWeWork(key, text, proxyOptions = null) {
    const url = key.startsWith('http') ? key : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`;
    const requestProxy = proxyOptions || this.getNotificationProxyOptions('wework');
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          msgtype: 'text',
          text: { content: text }
        },
        ...requestProxy
      });
      logger.log('🔵', '「企业微信」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「企业微信」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendDingTalk(token, title, text, proxyOptions = null) {
    const url = token.startsWith('http') ? token : `https://oapi.dingtalk.com/robot/send?access_token=${token}`;
    const requestProxy = proxyOptions || this.getNotificationProxyOptions('dingding');
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          msgtype: 'markdown',
          markdown: {
            title: `# ${title}`,
            text: text
          }
        },
        ...requestProxy
      });
      logger.log('🔵', '「钉钉」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「钉钉」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendFeishu(urlOrKey, title, text, proxyOptions = null) {
    const url = urlOrKey.startsWith('http') ? urlOrKey : `https://open.feishu.cn/open-apis/bot/v2/hook/${urlOrKey}`;
    const requestProxy = proxyOptions || this.getNotificationProxyOptions('feishu');
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          msg_type: 'interactive',
          card: {
            schema: '2.0',
            header: {
              title: { tag: 'plain_text', content: title },
              template: 'blue'
            },
            body: {
              elements: [{ tag: 'markdown', content: text }]
            }
          }
        },
        ...requestProxy
      });
      logger.log('🔵', '「飞书」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「飞书」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendBark(keyOrUrl, title, text, proxyOptions = null) {
    const base = keyOrUrl.startsWith('http') ? keyOrUrl.replace(/\/$/, '') : `https://api.day.app/${keyOrUrl}`;
    const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(text)}?group=rewards&icon=https://rewards.bing.com/rewards.png`;
    const requestProxy = proxyOptions || this.getNotificationProxyOptions('bark');
    try {
      await networkClient.request({ url, method: 'GET', ...requestProxy });
      logger.log('🔵', '「Bark」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「Bark」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendPushMe(key, title, text, proxyOptions = null) {
    const url = `https://push.i-i.me/?push_key=${encodeURIComponent(key)}`;
    const requestProxy = proxyOptions || this.getNotificationProxyOptions('pushme');
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          title: `Microsoft Rewards - ${title}`,
          content: text,
          type: 'markdown'
        },
        ...requestProxy
      });
      logger.log('🔵', '「PushMe」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「PushMe」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendTelegram(botToken, chatId, title, text, proxyOptions = null) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    // Telegram 基础 Markdown 模式下，未配对的下划线 _ 会导致 400 实体解析异常
    const safeTitle = String(title || '').replace(/(?<!\\)_/g, '\\_');
    const safeText = String(text || '').replace(/(?<!\\)_/g, '\\_');
    const message = `*${safeTitle}*\n\n${safeText}`;
    const requestProxy = proxyOptions || this.getNotificationProxyOptions('telegram');
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown'
        },
        ...requestProxy
      });
      logger.log('🔵', '「Telegram」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「Telegram」推送失败: ${e.message}`);
      throw e;
    }
  }

  async getQqBotAccessToken(appId, clientSecret, proxyOptions = null) {
    const now = Date.now();
    if (this.qqTokenCache?.appId === appId && this.qqTokenCache?.token && this.qqTokenCache?.expiresAt > now + 60000) {
      return this.qqTokenCache.token;
    }
    const res = await networkClient.request({
      url: 'https://bots.qq.com/app/getAppAccessToken',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: { appId, clientSecret },
      ...(proxyOptions || this.getNotificationProxyOptions('qqbot'))
    });
    const data = typeof res === 'string' ? JSON.parse(res) : res;
    if (!data?.access_token) {
      const errMsg = data?.msg || data?.message || '返回数据缺少 access_token';
      throw new Error(`获取 QQ 机器人 AccessToken 失败: ${errMsg}`);
    }
    const expiresInSec = Number(data.expires_in) || 7200;
    this.qqTokenCache = {
      appId,
      token: data.access_token,
      expiresAt: now + expiresInSec * 1000
    };
    return this.qqTokenCache.token;
  }

  async sendQqBot(config, title, text, proxyOptions = null) {
    const appId = String(config?.appId || '').trim();
    const clientSecret = String(config?.clientSecret || '').trim();
    const openId = String(config?.openId || '').trim();
    const groupOpenId = String(config?.groupOpenId || '').trim();

    if (!appId || !clientSecret) {
      throw new Error('QQ 机器人 AppID 与 AppSecret 不能为空');
    }
    if (!openId && !groupOpenId) {
      throw new Error('QQ 机器人 OpenID 与群 OpenID 均为空');
    }

    const requestProxy = proxyOptions || this.getNotificationProxyOptions('qqbot');
    const token = await this.getQqBotAccessToken(appId, clientSecret, requestProxy);
    const targets = [];
    if (openId) {
      targets.push({ type: '私聊', url: `https://api.sgroup.qq.com/v2/users/${openId}/messages` });
    }
    if (groupOpenId) {
      targets.push({ type: '群聊', url: `https://api.sgroup.qq.com/v2/groups/${groupOpenId}/messages` });
    }

    const errors = [];
    let successCount = 0;
    for (const target of targets) {
      try {
        await networkClient.request({
          url: target.url,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `QQBot ${token}`
          },
          data: {
            msg_type: 0,
            content: text
          },
          ...requestProxy
        });
        successCount++;
      } catch (e) {
        errors.push(`[${target.type}] ${e.message}`);
      }
    }

    if (successCount === 0) {
      logger.log('🔴', `「QQ 机器人」推送失败: ${errors.join('; ')}`);
      throw new Error(`「QQ 机器人」推送失败: ${errors.join('; ')}`);
    }

    logger.log('🔵', `「QQ 机器人」消息推送成功 (${successCount}/${targets.length} 目标)`);
    return true;
  }

  async testChannel(channel, value, proxyOverride = null) {
    const title = '测试通知';
    const content = '如果你看到这条消息，说明该推送渠道已成功配置并联通！';
    const proxyOptions = this.getNotificationProxyOptions(channel, proxyOverride);
    switch (channel) {
      case 'wework':
        return this.sendWeWork(value, `【${title}】\n${content}`, proxyOptions);
      case 'dingding':
        return this.sendDingTalk(value, title, `### ${title}\n${content}`, proxyOptions);
      case 'feishu':
        return this.sendFeishu(value, title, content, proxyOptions);
      case 'bark':
        return this.sendBark(value, title, content, proxyOptions);
      case 'pushme':
        return this.sendPushMe(value, title, content, proxyOptions);
      case 'telegram': {
        const { botToken, chatId } = typeof value === 'object' ? value : JSON.parse(value);
        return this.sendTelegram(botToken, chatId, title, content, proxyOptions);
      }
      case 'qqbot': {
        const conf = typeof value === 'object' ? value : JSON.parse(value);
        return this.sendQqBot(conf, title, `【${title}】\n${content}`, proxyOptions);
      }
      default:
        throw new Error('不支持的通知渠道');
    }
  }
}

export const notifier = new Notifier();
export default notifier;
