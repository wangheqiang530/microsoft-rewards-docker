/**
 * 判断打孔卡子任务是否已经完成。
 *
 * 不能只看文案：例如“开始搜索”的描述里会写“(1/5 天已完成)”，
 * 但子任务本身仍未完成。页面的成功图标 / 空圆圈才是可靠状态。
 */
export function isQuestSubtaskCompleted({ hasSuccessIcon = false, hasEmptyCircle = false, rawText = '' } = {}) {
  if (hasSuccessIcon) return true;
  if (hasEmptyCircle) return false;
  return /(^|\n)\s*(已完成|Complete|Completed)\s*($|\n)/i.test(String(rawText || ''));
}

/**
 * 从子任务文案中提取形如 1/5、3 / 8 的进度。
 * 只用于展示和动作后对比，不能据此推断整个子任务已经完成。
 */
export function parseQuestProgress(text = '') {
  const match = String(text || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  const progress = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(progress) || !Number.isFinite(max) || max <= 0) return null;
  return { progress, max, done: progress >= max };
}

/**
 * 打孔卡子任务动作分类。
 *
 * 判断顺序很重要：同一个卡片可能同时出现“Bing”和“继续搜索”，
 * 必须优先识别为搜索动作，才能在点击后真正提交一次搜索。
 */
export function classifyQuestAction({ title = '', actionText = '', rawText = '' } = {}) {
  const titleText = String(title || '');
  const action = String(actionText || '');
  const all = `${titleText}\n${action}\n${rawText || ''}`;
  if (/activate|激活/i.test(`${action}\n${titleText}`)) return 'activate';
  if (/搜索|search|bing/i.test(all)) return 'search';
  if (/测验|答题|quiz|trivia|question/i.test(`${action}\n${titleText}`)) return 'quiz';
  if (/观看|了解|试用|探索|查看|打开|watch|visit|try|explore|learn/i.test(`${action}\n${titleText}`)) return 'visit';
  if (/领取|reward|redeem|claim/i.test(`${action}\n${titleText}`)) return 'reward';
  return 'unknown';
}

/**
 * 决定一个打孔卡子任务应该按哪种动作执行。
 *
 * href 是比按钮文案更硬的证据：只要卡片指向 bing.com/search?q=...，
 * 微软就是在要求「用这个关键词真正搜一次」。
 *
 * 旧实现只在 classifyQuestAction 返回 unknown 时才采信 href，于是
 * 「黑色星期五优惠，就在这里」+「查看热门优惠」这种卡片被判成 visit，
 * 走浏览分支裸开新页（无 Referer），官网永远不认这次搜索，
 * 月度打孔卡就长期钉在 1/5、2/5。
 *
 * activate 必须保留最高优先级：激活按钮点击后卡片才展开出真正的子任务。
 */
export function resolveQuestKind({ title = '', actionText = '', rawText = '', href = '' } = {}) {
  const classified = classifyQuestAction({ title, actionText, rawText });
  if (classified === 'activate') return 'activate';
  if (isQuestSearchTarget({ href })) return 'search';
  return classified;
}

/**
 * 打孔卡子任务的目标是否明确指向 Bing 搜索。
 * 这比读取按钮文案更可靠，因为卡片可能只写“比较电子产品”。
 */
export function isQuestSearchTarget({ href = '' } = {}) {
  const value = String(href || '').replace(/&amp;/g, '&').trim();
  if (!value) return false;
  return /(?:\/search\?(?:[^#]*&)?q=|[?&]q=)/i.test(value)
    && /(?:^|\/\/|\.)bing\.com(?::\d+)?\//i.test(value);
}

/**
 * 从搜索型子任务里提取官网指定的 Bing 搜索词。
 * 任务卡片常把动作写成“比较电子产品”，实际 href 才是带 q= 的搜索目标。
 */
export function extractQuestSearchQuery({ href = '', title = '', actionText = '' } = {}) {
  const rawHref = String(href || '').trim();
  if (!rawHref) return '';
  const parseQuery = (value) => {
    try {
      const url = new URL(value, 'https://www.bing.com');
      if (!/^(?:[^.]+\.)?bing\.com$/i.test(url.hostname) || !/^\/search\/?$/i.test(url.pathname)) return '';
      return String(url.searchParams.get('q') || '').trim();
    } catch {
      return '';
    }
  };
  const direct = parseQuery(rawHref);
  if (direct) return direct;

  // Flight 数据偶尔把 & 转义成 &amp;，先还原后再按 query string 提取。
  const decoded = rawHref.replace(/&amp;/g, '&');
  const match = decoded.match(/[?&]q=([^&#]+)/i);
  if (!match) return '';
  if (!/^(?:https?:)?\/\/(?:[^.]+\.)?bing\.com(?::\d+)?\//i.test(decoded)) return '';
  try {
    return decodeURIComponent(match[1]).replace(/\+/g, ' ').trim();
  } catch {
    return '';
  }
}

function normalizeKeyPart(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * 子任务稳定键：优先 href，其次标题 + 动作文案。
 * 不使用 DOM 序号，避免页面重排后把冷却状态套到别的任务上。
 */
export function questSubtaskKey({ href = '', title = '', actionText = '', kind = 'unknown' } = {}) {
  const hrefPart = normalizeKeyPart(href);
  if (hrefPart) return `${kind}|href:${hrefPart}`;
  return `${kind}|text:${normalizeKeyPart(title)}|${normalizeKeyPart(actionText)}`;
}

/**
 * 从打孔卡子任务的「h3 → 祖先链」帧信息里，选出这张卡片自己的容器。
 *
 * 微软的月度打孔卡是「一层共享外层容器 + 每张卡片各自的 div」。旧实现一路上溯到
 * 第一个带可点击元素的祖先就停下，于是越过卡片边界落到共享外层：那里只有一个
 * CTA 链接，所有子任务都被指到同一个元素、同一个 href，编号还会互相覆盖，
 * 最终 locator 找不到目标而超时（3 × 8s = 24s），任务永远不推进。
 *
 * frames[0] 是 h3 自身，frames[i] 是第 i 层祖先；每帧带 h3Count（后代 h3 数量）
 * 与 linkCount（后代可点击元素数量），isBody 标记 document.body。一旦某个祖先里
 * 出现第二个 h3，说明已经跨过卡片边界，必须停在上一层，不能采纳它；body 本身
 * 永远不采纳（它含全站导航链接）。返回 -1 表示这张卡片没有可用容器。
 *
 * 返回值是 frames 下标；调用方从 h3 上溯同样层数即可拿到同一个容器，
 * 因此这里只做纯计算，不依赖 DOM。options.depthLimit 用于收窄上溯深度。
 */
export function selectQuestSubtaskDepth(frames = [], options = {}) {
  if (!Array.isArray(frames) || frames.length === 0) return -1;
  const rawLimit = Number(options.depthLimit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(frames.length, Math.floor(rawLimit))
    : frames.length;
  let chosen = -1;
  for (let depth = 0; depth < limit; depth++) {
    const frame = frames[depth];
    if (!frame) break;
    if (frame.isBody === true) break;
    if (Number(frame.h3Count || 0) > 1) break;
    chosen = depth;
    if (Number(frame.linkCount || 0) > 0) break;
  }
  return chosen;
}

export function isDailyQuestSubtask({ kind = '', rawText = '' } = {}) {
  if (kind === 'search') return true;
  return /24\s*小时|每天|每日|daily|streak|连续/i.test(String(rawText || ''));
}

/**
 * 未获官网确认时的重试冷却。
 *
 * 搜索型子任务不能像旧版一样固定冻结 24 小时：月度打孔卡通常是
 * “完成一个再解锁下一个”，一次关键词或页面波动就可能把整月进度锁死。
 * 这里只做短冷却；同一次浏览器运行仍由 attemptedThisRun 防止重复点击。
 */
export function resolveQuestFailureCooldown(kind = 'unknown') {
  if (kind === 'visit') return 30 * 60 * 1000;
  if (kind === 'search') return 10 * 60 * 1000;
  return 10 * 60 * 1000;
}

/**
 * 任务动作本身成功但官网尚未写入时，给页面更多回读机会。
 * 返回重读次数与间隔，不改变“只有总进度增加才算完成”的原则。
 */
export function questVerificationAttempts(actionResult = {}) {
  const performed = actionResult?.performed === true
    || actionResult?.searchResult?.searchSubmitted === true;
  return performed
    ? { attempts: 5, delayMs: 2500 }
    : { attempts: 3, delayMs: 1200 };
}

export function isQuestSubtaskCoolingDown(state, now = Date.now()) {
  // 旧版把普通网页访问误判为 30 分钟冷却；但“官网未变化”并不等于
  // 这个动作已经做过，尤其月度打孔卡常要求先搜索指定关键词。
  // 迁移时让未验证的 visit 冷却立即失效，由新逻辑重新执行并核验。
  const legacyVisitCooldown = state?.lastResult === 'no-change'
    && !state?.lastVerification
    && Number(state?.lastProgressAfter) >= 1
    && Number(state?.attempts || 0) >= 2;
  if (legacyVisitCooldown) return false;
  // 旧版本会把 hydration 后多扫描出的子任务当成“已推进”，但 progressAfter
  // 仍是 null。这类未经验证的历史冷却不能继续挡住修复后的任务。
  const legacyUnverifiedAdvance = state?.lastResult === 'advanced'
    && !state?.lastVerification
    && (state?.lastProgressAfter === null || state?.lastProgressAfter === undefined);
  if (legacyUnverifiedAdvance) return false;
  const until = Number(state?.cooldownUntil || 0);
  return Number.isFinite(until) && until > now;
}

/**
 * 把任务卡片里的 href 归一化为可导航 URL。
 * 官网有时返回 "bing.com/search..." 这种缺少协议的地址。
 */
export function resolveQuestTargetUrl(href = '', baseUrl = 'https://rewards.bing.com') {
  const value = String(href || '').trim();
  if (!value || /^(?:#|javascript:)/i.test(value)) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (/^\/\//.test(value)) return `https:${value}`;
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]|$)/i.test(value)) {
    return `https://${value}`;
  }
  try {
    return new URL(value, baseUrl || 'https://rewards.bing.com').href;
  } catch {
    return '';
  }
}

/**
 * 打孔卡是否真的推进。
 *
 * 页面 hydration 后可能凭空多扫描出几个子任务，旧实现把“子任务进度总和”
 * 变大都当成完成，导致总进度仍是 1/5 却给第二步加了 24 小时冷却。
 * 有任务总进度时必须以总进度为准；总进度不可用时才接受当前子任务自身变化。
 */
export function evaluateQuestAdvance({
  targetCompletedBefore = false,
  targetCompletedAfter = false,
  targetProgressBefore = null,
  targetProgressAfter = null,
  officialProgressBefore = null,
  officialProgressAfter = null,
  officialProgressKnown = false
} = {}) {
  const optionalNumber = (value) => (
    value === null || value === undefined || value === '' ? null : Number(value)
  );
  const officialBefore = optionalNumber(officialProgressBefore);
  const officialAfter = optionalNumber(officialProgressAfter);
  const hasOfficialProgress = officialProgressKnown === true
    && Number.isFinite(officialBefore)
    && Number.isFinite(officialAfter);
  const officialAdvanced = hasOfficialProgress && officialAfter > officialBefore;

  const targetBefore = optionalNumber(targetProgressBefore);
  const targetAfter = optionalNumber(targetProgressAfter);
  const targetProgressAdvanced = Number.isFinite(targetBefore)
    && Number.isFinite(targetAfter)
    && targetAfter > targetBefore;
  const targetCompletedNow = targetCompletedBefore !== true && targetCompletedAfter === true;

  if (hasOfficialProgress) {
    return {
      advanced: officialAdvanced,
      officialAdvanced,
      targetProgressAdvanced,
      targetCompletedNow,
      verifiedBy: officialAdvanced ? 'official-progress' : ''
    };
  }

  return {
    advanced: targetProgressAdvanced || targetCompletedNow,
    officialAdvanced: false,
    targetProgressAdvanced,
    targetCompletedNow,
    verifiedBy: targetProgressAdvanced
      ? 'subtask-progress'
      : (targetCompletedNow ? 'subtask-completed' : '')
  };
}

export function buildQuestSubtaskUpdate({
  previous = null,
  result = 'no-change',
  progressBefore = null,
  progressAfter = null,
  verification = '',
  now = Date.now(),
  cooldownMs = 0
} = {}) {
  return {
    ...(previous && typeof previous === 'object' ? previous : {}),
    lastAttemptAt: now,
    lastResult: result,
    lastProgressBefore: progressBefore,
    lastProgressAfter: progressAfter,
    lastVerification: result === 'advanced' ? String(verification || '') : '',
    lastVerifiedAt: result === 'advanced' ? now : (previous?.lastVerifiedAt || 0),
    cooldownUntil: cooldownMs > 0 ? now + cooldownMs : 0,
    attempts: Math.max(0, Number(previous?.attempts || 0)) + 1
  };
}
