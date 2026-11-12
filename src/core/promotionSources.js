function toFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function toBoolean(value) {
  return value === true || String(value || '').trim().toLowerCase() === 'true';
}

function localDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function normalizeDateKey(value = '') {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : text.slice(0, 10);
}

function compactDateKey(timestamp = Date.now()) {
  return localDateKey(timestamp).replace(/-/g, '');
}

function normalizeOfferId(item = {}, attributes = {}) {
  return String(
    item.offerId
    || item.offerid
    || item.id
    || attributes.offerid
    || attributes.offerId
    || ''
  ).trim();
}

function normalizePromotionPoints(item = {}, attributes = {}) {
  const progress = toFiniteNumber(
    item.pointProgress,
    item.progress,
    attributes.pointprogress,
    attributes.progress
  );
  const max = toFiniteNumber(
    item.pointProgressMax,
    item.max,
    item.points,
    attributes.pointmax,
    attributes.max,
    attributes.points
  );
  return { progress, max };
}

/**
 * 新版 Rewards Dashboard API 会把今日 Daily Set 放在
 * dashboard.dailySetPromotions[YYYY-MM-DD]。这些卡片不会稳定出现在 /earn
 * 的 activityCards 里，因此必须独立解析。
 */
export function extractDailySetCardsFromDashboard(payload = {}, now = Date.now()) {
  const dashboard = payload?.dashboard || payload?.flyoutResult || payload || {};
  const dailySetPromotions = dashboard?.dailySetPromotions;
  if (!dailySetPromotions || typeof dailySetPromotions !== 'object') return [];

  const today = localDateKey(now);
  let promotions = dailySetPromotions[today];
  if (!Array.isArray(promotions)) {
    const matchingKey = Object.keys(dailySetPromotions)
      .find(key => normalizeDateKey(key) === today);
    promotions = matchingKey ? dailySetPromotions[matchingKey] : [];
  }
  if (!Array.isArray(promotions)) return [];

  const seen = new Set();
  const cards = [];
  for (const item of promotions) {
    if (!item || typeof item !== 'object') continue;
    const attributes = item.attributes && typeof item.attributes === 'object'
      ? item.attributes
      : {};
    const offerId = normalizeOfferId(item, attributes);
    if (!offerId || seen.has(offerId)) continue;
    const { progress, max } = normalizePromotionPoints(item, attributes);
    const complete = toBoolean(item.complete)
      || toBoolean(item.isCompleted)
      || toBoolean(attributes.complete)
      || (max > 0 && progress >= max);
    if (complete) continue;

    const promotionType = String(item.promotionType || attributes.promotionType || '').toLowerCase();
    const rawDestination = String(
      item.destinationUrl
      || item.destination
      || item.url
      || attributes.destinationUrl
      || attributes.destination
      || ''
    );
    const destination = rawDestination.startsWith('/')
      ? `https://www.bing.com${rawDestination}`
      : rawDestination;
    const title = String(item.title || item.name || offerId).trim();
    const kind = /search|explore/.test(promotionType)
      ? 'explore_search'
      : (/quiz|trivia|question|测验|答题/.test(`${title} ${offerId}`) ? 'quiz' : 'open_only');
    const hash = String(item.hash || attributes.hash || '').trim();

    seen.add(offerId);
    cards.push({
      title,
      points: max > 0 ? max : 10,
      offerId,
      hash,
      kind,
      destination,
      url: 'https://rewards.bing.com/dashboard',
      category: 'dailyset',
      source: 'dashboard-api',
      promotionType
    });
  }
  return cards;
}

export function buildDapiDailySetOfferIds(now = Date.now(), locale = 'ZHCN') {
  const date = compactDateKey(now);
  return [1, 2, 3].map(index => `Gamification_DailySet_${locale}_${date}_Child${index}`);
}

/**
 * Dashboard 与 /earn 都可能缺失今日 Daily Set，但 App DAPI 仍接受固定格式的
 * Child offerId。用日期生成兜底卡片，实际完成后由响应积分和余额核验。
 */
export function buildDapiDailySetCards(now = Date.now(), locale = 'ZHCN') {
  return buildDapiDailySetOfferIds(now, locale).map((offerId, index) => ({
    title: `移动端每日活动 ${index + 1}`,
    points: 10,
    offerId,
    hash: '',
    destination: '',
    kind: 'dapi_reward',
    category: 'dailyset',
    source: 'dapi-dailyset-fallback'
  }));
}

/**
 * 移动端 DAPI 的 promotions 同时承载签到、阅读和 sapphire 每日活动。
 * 统一归一化后，调用方不需要猜 attributes 字段名。
 */
export function normalizeAppPromotions(payload = {}) {
  const promotions = payload?.response?.promotions
    || payload?.promotions
    || [];
  if (!Array.isArray(promotions)) return [];

  return promotions.map((item, index) => {
    const attributes = item?.attributes && typeof item.attributes === 'object'
      ? item.attributes
      : {};
    const offerId = normalizeOfferId(item, attributes);
    const { progress, max } = normalizePromotionPoints(item, attributes);
    const complete = toBoolean(item.complete)
      || toBoolean(item.isCompleted)
      || toBoolean(attributes.complete)
      || (max > 0 && progress >= max);
    const type = String(item.type || attributes.type || '').trim().toLowerCase();
    const name = String(item.name || item.title || offerId || `promotion-${index + 1}`).trim();
    const lastUpdated = String(item.last_updated || attributes.last_updated || '').trim();
    return {
      index,
      name,
      offerId,
      type,
      complete,
      progress,
      max,
      lastUpdated,
      attributes
    };
  }).filter(item => item.offerId || item.name);
}

export function isSapphireAppPromotion(promotion = {}) {
  return String(promotion.type || '').trim().toLowerCase() === 'sapphire';
}

export function isAppCheckInPromotion(promotion = {}) {
  return String(promotion.type || '').trim().toLowerCase() === 'checkin'
    || String(promotion.offerId || '').trim().toLowerCase() === 'gamification_sapphire_dailycheckin';
}

export function isAppReadPromotion(promotion = {}) {
  return String(promotion.type || '').trim().toLowerCase() === 'msnreadearn'
    || String(promotion.offerId || '').trim().toLowerCase() === 'enus_readarticle3_30points';
}

export function getPendingSapphireAppPromotions(promotions = []) {
  if (!Array.isArray(promotions)) return [];
  return promotions.filter(promotion => (
    isSapphireAppPromotion(promotion)
    && promotion.offerId
    && promotion.complete !== true
  ));
}

export function getAppCheckInStatusFromPromotions(promotions = [], now = Date.now()) {
  if (!Array.isArray(promotions)) return null;
  const promotion = promotions.find(isAppCheckInPromotion);
  if (!promotion) return null;
  // last_updated 会在启动 App、加载活动等场景刷新，并不代表今日签到成功。
  // 真实签到响应还可能 p=0，因此这里只认活动自身的明确 complete 状态。
  const completedToday = promotion.complete === true;
  const day = Math.max(0, toFiniteNumber(promotion.progress));
  return {
    isCurrentDayCompleted: completedToday,
    completedDays: day,
    currentDay: day,
    activitiesCompleted: completedToday ? 1 : 0,
    activitiesTotal: 1,
    source: 'dapi'
  };
}

/**
 * Dashboard 的 bingapp streak 可能长期停留在 0/7，而同一账号的 DAPI
 * check-in promotion 已明确标记今日完成。Token 归属校验通过时，DAPI 的
 * 今日完成状态必须优先，否则会把真实签到误判成失败并覆盖回 0/1。
 */
export function resolveAppCheckInStatus(webStatus = null, dapiStatus = null) {
  const webCompleted = webStatus?.isCurrentDayCompleted === true;
  const dapiCompleted = dapiStatus?.isCurrentDayCompleted === true;
  if (dapiCompleted) {
    return {
      ...dapiStatus,
      webStatusMismatch: webStatus
        && typeof webStatus.isCurrentDayCompleted === 'boolean'
        && !webCompleted
    };
  }
  if (webStatus && typeof webStatus.isCurrentDayCompleted === 'boolean') {
    return webStatus;
  }
  return dapiStatus || webStatus || null;
}

export function buildAppActivityPayload(offerId, {
  id,
  country = 'cn',
  channel = 'SAAndroid'
} = {}) {
  return {
    amount: 1,
    country,
    id,
    type: 101,
    channel,
    attributes: { offerid: offerId }
  };
}
