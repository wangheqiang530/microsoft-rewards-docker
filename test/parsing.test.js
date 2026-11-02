import test from 'node:test';
import assert from 'node:assert/strict';
import networkClient from '../src/network.js';
import rewardsApi from '../src/core/api.js';

/**
 * 用最小化的官网页面片段做解析回归。
 * 这些解析是整条链路最脆弱的部分（微软一改版就会失效），
 * 至少保证「字段位置变了」能在测试里立刻暴露。
 */
const EARN_FIXTURE = `
<script>self.__next_f.push([1,"x:\\"pointsCounters\\":{\\"dailyOffer\\":77,\\"pc\\":{\\"max\\":60,\\"progress\\":60,\\"originalMax\\":60},\\"totalPoints\\":137,\\"boostActivated\\":false}"])</script>
<script>self.__next_f.push([1,"y:\\"balance\\":51355,\\"availablePoints\\":51355"])</script>
<script>self.__next_f.push([1,"a:\\"children\\":\\"今日积分\\",\\"b\\":{\\"className\\":\\"text-pageHeader\\",\\"children\\":\\"137\\"}"])</script>
<script>self.__next_f.push([1,"b:\\"partner\\":\\"bingapp\\",\\"isCurrentDayCompleted\\":true,\\"completedDays\\":4,\\"currentDay\\":3,\\"activitiesCompleted\\":1,\\"activitiesTotal\\":1,\\"c\\":1"])</script>
<script>self.__next_f.push([1,"c:\\"activityCards\\":[{\\"isCompleted\\":true,\\"offerId\\":\\"A\\"},{\\"isCompleted\\":false,\\"offerId\\":\\"B\\"}]"])</script>
<script>self.__next_f.push([1,"d:\\"href\\":\\"/earn/quest/ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard\\""])</script>
`;

function withStubbedNetwork(html, fn) {
  const origRequest = networkClient.request;
  const origRead = rewardsApi.getReadProgress;
  const origBalance = rewardsApi.getBalance;
  networkClient.request = async () => html;
  rewardsApi.getReadProgress = async () => null;
  rewardsApi.getBalance = async () => null;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      networkClient.request = origRequest;
      rewardsApi.getReadProgress = origRead;
      rewardsApi.getBalance = origBalance;
    });
}

test('getRewardsInfo 解析官网「今日积分」与余额', async () => {
  await withStubbedNetwork(EARN_FIXTURE, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.ok(info, '应返回解析结果');
    assert.equal(info.todayPoints, 137, '今日积分必须来自官网卡片');
    assert.equal(info.balance, 51355);
    assert.deepEqual(info.pc, { progress: 60, max: 60 });
  });
});

for (const { max, code, label } of [
  { max: 15, code: 'member', label: '会员' },
  { max: 30, code: 'silver', label: '银牌' },
  { max: 60, code: 'gold', label: '金牌' }
]) {
  test(`getRewardsInfo 按官网 ${max} 分配额识别搜索等级`, async () => {
    const html = `<script>self.__next_f.push([1,"x:\\"pointsCounters\\":{\\"pc\\":{\\"max\\":${max},\\"progress\\":3},\\"totalPoints\\":88}"])</script>`;
    await withStubbedNetwork(html, async () => {
      const info = await rewardsApi.getRewardsInfo(1);
      assert.deepEqual(info.pc, { progress: 3, max });
      assert.deepEqual(info.searchTier, { code, label, max });
    });
  });
}

test('getRewardsInfo 未解析到搜索配额时不回退为默认 60', async () => {
  await withStubbedNetwork('<script>{"balance":88}</script>', async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.equal(info.pc, null);
    assert.equal(info.searchTier, null);
  });
});

test('getRewardsInfo 可从 dashboard 读取搜索等级配额', async () => {
  const origRequest = networkClient.request;
  networkClient.request = async ({ url }) => {
    if (url.includes('/dashboard')) {
      return '<script>{"pointsCounters":{"pc":{"max":30,"progress":6},"totalPoints":100}}</script>';
    }
    return '<html><body>loading</body></html>';
  };
  try {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.deepEqual(info.pc, { progress: 6, max: 30 });
    assert.equal(info.searchTier.code, 'silver');
  } finally {
    networkClient.request = origRequest;
  }
});

test('getRewardsInfo 不会被 earn 中残缺的 pointsCounters 遮蔽 dashboard 的有效配额', async () => {
  const origRequest = networkClient.request;
  networkClient.request = async ({ url }) => {
    if (url.includes('/dashboard')) {
      return '<script>{"pointsCounters":{"pc":{"max":30,"progress":6},"totalPoints":100}}</script>';
    }
    return '<script>{"pointsCounters":{"dailyOffer":10,"pc":null,"totalPoints":0}}</script>';
  };
  try {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.deepEqual(info.pc, { progress: 6, max: 30 });
    assert.equal(info.searchTier.code, 'silver');
    assert.equal(info.searchQuotaSource, 'dashboard');
  } finally {
    networkClient.request = origRequest;
  }
});

test('dashboard 的未知配额优先于 earn 中可能残留的已知配额', async () => {
  const origRequest = networkClient.request;
  networkClient.request = async ({ url }) => {
    if (url.includes('/dashboard')) {
      return '<script>{"pointsCounters":{"pc":{"max":45,"progress":3},"totalPoints":100}}</script>';
    }
    return '<script>{"pointsCounters":{"pc":{"max":60,"progress":3},"totalPoints":100}}</script>';
  };
  try {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.deepEqual(info.pc, { progress: 3, max: 45 });
    assert.equal(info.searchTier.code, 'unknown');
  } finally {
    networkClient.request = origRequest;
  }
});

test('getRewardsInfo 遇到多份「今日积分」Flight 数据时取最大值，不被首个 0 覆盖', async () => {
  const html = `
<script>self.__next_f.push([1,"a:\\"children\\":\\"今日积分\\",\\"b\\":{\\"className\\":\\"text-pageHeader\\",\\"children\\":\\"0\\"}"])</script>
<script>self.__next_f.push([1,"b:\\"children\\":\\"今日积分\\",\\"c\\":{\\"className\\":\\"text-pageHeader\\",\\"children\\":\\"112\\"}"])</script>
<script>self.__next_f.push([1,"c:\\"balance\\":781"])</script>
`;
  await withStubbedNetwork(html, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.equal(info.todayPoints, 112, '不能采用旧 Flight 中的隐藏 0');
  });
});

test('getRewardsInfo 解析必应应用连签真实状态', async () => {
  await withStubbedNetwork(EARN_FIXTURE, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.equal(info.streaks.bingapp.isCurrentDayCompleted, true);
    assert.equal(info.streaks.bingapp.completedDays, 4);
  });
});

test('getRewardsInfo 保留官网印章 0/12，不用默认值 8 覆盖', async () => {
  const html = `
<script>self.__next_f.push([1,"a:\\"pointsCounters\\":{\\"pc\\":{\\"max\\":60,\\"progress\\":0}}"])</script>
<div aria-label="收集的印章" aria-valuemax="12" aria-valuenow="0"></div>
`;
  await withStubbedNetwork(html, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.deepEqual(info.stamps, { progress: 0, max: 12 });
  });
});

test('getRewardsInfo 以 dashboard 印章为准，不被 earn 旧数据 8/12 覆盖', async () => {
  const origRequest = networkClient.request;
  networkClient.request = async ({ url }) => {
    if (url.includes('/dashboard')) {
      return '<div aria-label="收集的印章" aria-valuemax="12" aria-valuenow="0"></div>';
    }
    return `
<script>self.__next_f.push([1,"x:\\"pointsCounters\\":{\\"pc\\":{\\"max\\":15,\\"progress\\":0}}"])</script>
<div aria-label="收集的印章" aria-valuemax="12" aria-valuenow="8"></div>`;
  };
  try {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.deepEqual(info.stamps, { progress: 0, max: 12 });
  } finally {
    networkClient.request = origRequest;
  }
});

test('getActivityCardStatus 统计 activityCards 完成情况', async () => {
  await withStubbedNetwork(EARN_FIXTURE, async () => {
    const status = await rewardsApi.getActivityCardStatus();
    assert.deepEqual(status, { total: 2, completed: 1 });
  });
});

test('getQuestPunchCards 提取任务区打孔卡链接', async () => {
  await withStubbedNetwork(EARN_FIXTURE, async () => {
    const quests = await rewardsApi.getQuestPunchCards();
    assert.equal(quests.length, 1);
    assert.equal(quests[0].questId, 'ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard');
    assert.match(quests[0].url, /^https:\/\/rewards\.bing\.com\/earn\/quest\//);
  });
});

test('discoverCards 给卡片打上分类，供独立开关过滤', async () => {
  const cardsFixture = `
  <script>self.__next_f.push([1,"a:{\\"offerId\\":\\"Gamification_DailySet_ZHCN_20261015_Child1\\",\\"hash\\":\\"h1\\",\\"points\\":10,\\"title\\":\\"每日活动\\"}"])</script>
  <script>self.__next_f.push([1,"b:{\\"offerId\\":\\"ZHstar_Rewards_DailyGlobalOffer_Evergreen_Monday\\",\\"hash\\":\\"h2\\",\\"points\\":5,\\"title\\":\\"拼图\\"}"])</script>
  `;
  await withStubbedNetwork(cardsFixture, async () => {
    const cards = await rewardsApi.discoverCards();
    const byId = Object.fromEntries(cards.map(c => [c.offerId, c.category]));
    assert.equal(byId['Gamification_DailySet_ZHCN_20261015_Child1'], 'dailyset');
    assert.equal(byId['ZHstar_Rewards_DailyGlobalOffer_Evergreen_Monday'], 'promo');
  });
});

test('discoverCards 遇到瞬时空页会自动重试并恢复活动卡片', async () => {
  const origRequest = networkClient.request;
  let requests = 0;
  let earnRequests = 0;
  const retries = [];
  networkClient.request = async ({ url }) => {
    requests++;
    if (String(url).includes('/api/getuserinfo')) {
      return { dashboard: { dailySetPromotions: {} } };
    }
    earnRequests++;
    if (earnRequests === 1) return '<html><body>loading</body></html>';
    return `
  <script>self.__next_f.push([1,"a:{\\"offerId\\":\\"Gamification_DailySet_ZHCN_20261015_Child1\\",\\"hash\\":\\"h1\\",\\"points\\":10,\\"title\\":\\"每日活动\\"}"])</script>
  <script>self.__next_f.push([1,"b:{\\"offerId\\":\\"ZHstar_Rewards_DailyGlobalOffer_Evergreen_Monday\\",\\"hash\\":\\"h2\\",\\"points\\":5,\\"title\\":\\"拼图\\"}"])</script>
    `;
  };
  try {
    const cards = await rewardsApi.discoverCards({
      retryEmpty: true,
      attempts: 2,
      retryDelaysMs: [0],
      onRetry: event => retries.push(event)
    });
    assert.equal(earnRequests, 2);
    assert.equal(requests, 4);
    assert.equal(cards.length, 2);
    assert.equal(retries.length, 1);
  } finally {
    networkClient.request = origRequest;
  }
});

test('discoverCards 从 Dashboard API 补全 /earn 缺失的 Daily Set 卡片', async () => {
  const origRequest = networkClient.request;
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  networkClient.request = async ({ url }) => {
    if (String(url).includes('/api/getuserinfo')) {
      return {
        dashboard: {
          dailySetPromotions: {
            [todayKey]: [{
              offerId: 'DailySet_App_Search_1',
              title: 'Upcoming live music events',
              promotionType: 'search',
              destinationUrl: 'https://www.bing.com/search?q=music',
              pointProgress: 0,
              pointProgressMax: 10
            }]
          }
        }
      };
    }
    return `
  <script>self.__next_f.push([1,"a:{\\"offerId\\":\\"DailySet_App_Search_1\\",\\"hash\\":\\"h1\\",\\"points\\":10,\\"title\\":\\"Upcoming live music events\\"}"])</script>
    `;
  };
  try {
    const cards = await rewardsApi.discoverCards();
    const matches = cards.filter(card => card.offerId === 'DailySet_App_Search_1');
    assert.equal(matches.length, 1);
    const dailySet = matches[0];
    assert.ok(dailySet);
    assert.equal(dailySet.category, 'dailyset');
    assert.equal(dailySet.kind, 'explore_search');
    assert.equal(dailySet.points, 10);
    assert.equal(dailySet.hash, 'h1');
  } finally {
    networkClient.request = origRequest;
  }
});

test('无 hash 的 Daily Set 链接卡片通过目标链接上报', async () => {
  const original = rewardsApi.reportDailyActivity;
  let reportedUrl = '';
  rewardsApi.reportDailyActivity = async url => {
    reportedUrl = url;
    return true;
  };
  try {
    const claimed = await rewardsApi.claimCard({
      offerId: 'DailySet_App_Search_1',
      title: 'Upcoming live music events',
      hash: '',
      destination: 'https://www.bing.com/search?q=music',
      url: 'https://rewards.bing.com/dashboard',
      kind: 'explore_search'
    });
    assert.equal(claimed, true);
    assert.equal(reportedUrl, 'https://www.bing.com/search?q=music');
  } finally {
    rewardsApi.reportDailyActivity = original;
  }
});
