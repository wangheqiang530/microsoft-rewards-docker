import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-fixes-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager, SECRET_PLACEHOLDER, SECRET_CLEAR } = await import('../src/config.js');
const { default: rewardsApi } = await import('../src/core/api.js');
const { default: scheduler } = await import('../src/scheduler.js');
const { default: networkClient, normalizeCookieString } = await import('../src/network.js');
const { default: browserManager } = await import('../src/core/browser.js');
const { TaskManager } = await import('../src/core/taskManager.js');

test('SECRET_CLEAR 和 null 可以彻底清空凭据，而不是被旧值复原', () => {
  configManager.upsertAccount({
    id: 'acc_clear_test',
    name: '清空测试账号',
    cookie: 'ORIGINAL_COOKIE',
    refreshToken: 'ORIGINAL_REFRESH_TOKEN',
    accessToken: 'ORIGINAL_ACCESS_TOKEN'
  });

  let acc = configManager.findAccount('acc_clear_test');
  assert.equal(acc.cookie, 'ORIGINAL_COOKIE');
  assert.equal(acc.refreshToken, 'ORIGINAL_REFRESH_TOKEN');

  // 1. 用 null 清空 Token
  configManager.upsertAccount({
    id: 'acc_clear_test',
    accessToken: null,
    refreshToken: null
  });
  acc = configManager.findAccount('acc_clear_test');
  assert.equal(acc.accessToken, '', 'accessToken 应被清空为字符串');
  assert.equal(acc.refreshToken, '', 'refreshToken 应被清空为字符串');
  assert.equal(acc.cookie, 'ORIGINAL_COOKIE', '未声明清空的 cookie 仍保留');

  // 2. 用 SECRET_CLEAR 清空 Cookie
  configManager.upsertAccount({
    id: 'acc_clear_test',
    cookie: SECRET_CLEAR
  });
  acc = configManager.findAccount('acc_clear_test');
  assert.equal(acc.cookie, '', 'cookie 应被清空');
});

test('getHotSearchWord 在热词耗尽且网络失败时不抛异常且绝不返回 undefined', async () => {
  rewardsApi.hotWordList = ['词1', '词2'];
  rewardsApi.hotWordIndex = 2; // 模拟已取完

  // 模拟网络请求失败
  const origFetch = rewardsApi.fetchSearchWordList;
  rewardsApi.fetchSearchWordList = async () => ({ success: false, sample: [] });

  try {
    const word = await rewardsApi.getHotSearchWord();
    assert.ok(typeof word === 'string' && word.length > 0, '必须返回非空字符串兜底词');
    assert.notEqual(word, 'undefined', '不能返回字符串 undefined');
    assert.notEqual(word, undefined, '不能返回 undefined');
  } finally {
    rewardsApi.fetchSearchWordList = origFetch;
  }
});

test('scheduler 计划落盘与跨实例恢复：已执行状态不丢失', () => {
  const today = scheduler.getTodayNum();
  scheduler.ensureDayPlans(today, false);
  const plan = scheduler.plannedDailyRuns[String(today)]?.acc_1;
  if (plan) {
    plan.executed = true;
    scheduler.savePlans();

    // 重新从磁盘加载
    scheduler.plannedDailyRuns = {};
    scheduler.loadPlans();
    assert.equal(scheduler.plannedDailyRuns[String(today)]?.acc_1?.executed, true, '重启后已执行状态必须保持 true');
  }
});

test('getRewardsInfo 解析 dashboard 待领取额外积分与必应应用连签真实状态', async () => {
  const dashHtml = `
    <div>
      <p class="text-labelControl">可领取</p>
      <img alt="可领取" src="icon.svg">
      <div class="flex"><p class="text-pageHeader">12</p></div>
      <p class="text-metadata">领取</p>
    </div>
    <button>
      <p class="text-globalBody2Strong">必应应用连续打卡</p>
      <div class="sr-only"><div>已完成连续打卡 3 天，共 7 天。</div></div>
      <div class="line-clamp-2">签到: 1/1</div>
    </button>
  `;
  const origRequest = networkClient.request;
  networkClient.request = async (opt) => {
    if (opt.url.includes('/dashboard')) return dashHtml;
    return '<script>self.__next_f.push([1,"x:\\"pointsCounters\\":{\\"pc\\":{\\"max\\":60,\\"progress\\":60}}"])</script>';
  };
  try {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.equal(info.claimablePoints, 12, '待领取额外积分应解析为 12');
    assert.equal(info.streaks.bingapp.isCurrentDayCompleted, true, '签到 1/1 应判定为当日已完成');
    assert.equal(info.streaks.bingapp.completedDays, 3);
  } finally {
    networkClient.request = origRequest;
  }
});

test('getRewardsInfo 解析月度打孔卡（十月必看五大亮点）与到期天数', async () => {
  const earnHtml = `
    <div>
      <h1>十月必看五大亮点：服饰、玩具、手机、超值优惠和AI设备</h1>
      <p>+50</p>
      <p>状态: 2/5 个任务</p>
      <p>到期日期 14 天后</p>
      <a href="/earn/quest/ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard">查看</a>
    </div>
  `;
  const origRequest = networkClient.request;
  networkClient.request = async (opt) => {
    if (opt.url.includes('/earn')) return earnHtml;
    return '';
  };
  try {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.ok(info.monthlyQuest, '必须识别出月度打孔卡');
    assert.equal(info.monthlyQuest.progress, 2);
    assert.equal(info.monthlyQuest.max, 5);
    assert.equal(info.monthlyQuest.points, 50);
    assert.match(info.monthlyQuest.title, /十月必看五大亮点/);
    assert.match(info.monthlyQuest.expiresText, /14 天后/);
  } finally {
    networkClient.request = origRequest;
  }
});

test('TaskManager recordPunchCardSteps 记录多步时间戳且支持同天多步', () => {
  const tm = new TaskManager();
  const accId = 'acc_test_steps';
  tm.ensureAccountStats(accId);

  const now = Date.now();
  tm.recordPunchCardSteps(accId, [
    { title: '十月必看五大亮点', stepName: '服装季来了', at: now - 3600000, progressAfter: 1, verified: true },
    { title: '十月必看五大亮点', stepName: '热门玩具与礼物创意', at: now, progressAfter: 2, verified: true }
  ]);

  const st = tm.ensureAccountStats(accId);
  const mQuest = st.tasks.monthlyQuest;
  assert.ok(mQuest);
  assert.equal(mQuest.progress, 2);
  assert.equal(mQuest.stepLogs.length, 2);
  assert.equal(mQuest.stepLogs[0].name, '服装季来了');
  assert.equal(mQuest.stepLogs[1].name, '热门玩具与礼物创意');
  assert.ok(mQuest.stepLogs[1].at > mQuest.stepLogs[0].at);
});

test('TaskManager recordPunchCardSteps 不把未确认的点击计入官网进度', () => {
  const tm = new TaskManager();
  const accId = 'acc_test_unverified_steps';
  tm.ensureAccountStats(accId);
  tm.recordPunchCardSteps(accId, [
    { title: '十月必看五大亮点', stepName: '未确认点击', progressAfter: 1, verified: false }
  ]);
  const quest = tm.ensureAccountStats(accId).tasks.monthlyQuest;
  assert.equal(quest.progress, 0);
  assert.equal(quest.stepLogs.length, 0);
});

test('getRewardsInfo 动态解析多打孔卡（包含万圣节 A 50-point Halloween treat）', async () => {
  const flightHtml = `
    <script>self.__next_f.push([1,"\\"text-globalBody2Strong\\",\\"children\\":\\"A 50-point Halloween treat\\",\\"b\\":{\\"children\\":\\"0/6 个任务\\"}"])</script>
    <script>self.__next_f.push([1,"\\"text-globalBody2Strong\\",\\"children\\":\\"十月必看五大亮点：服饰、玩具、手机、超值优惠和AI设备\\",\\"b\\":{\\"children\\":\\"3/5 个任务\\"}"])</script>
  `;
  const origRequest = networkClient.request;
  networkClient.request = async (opt) => {
    if (opt.url.includes('/earn')) return flightHtml;
    return '';
  };
  try {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.ok(Array.isArray(info.quests), '必须返回全量 quests 数组');
    assert.equal(info.quests.length, 2, '应解析出全部 2 个打孔卡任务');
    const h = info.quests.find(q => q.title.includes('Halloween'));
    assert.ok(h, '必须包含 Halloween 打孔卡');
    assert.equal(h.max, 6);
    assert.equal(h.progress, 0);
    assert.equal(h.icon, '🎃');
  } finally {
    networkClient.request = origRequest;
  }
});

test('TaskManager 根据官网动态增删打孔卡卡片', () => {
  const tm = new TaskManager();
  const accId = 'acc_dynamic_sync';
  const accCfg = { id: accId, name: '动态卡片测试账号', cookie: 'MOCK_COOKIE' };
  tm.ensureAccountStats(accId);

  // 1. 官网有 2 个打孔卡：Monthly, Halloween
  const mockInfo = {
    todayPoints: 50,
    quests: [
      { title: '十月必看五大亮点', progress: 2, max: 5, points: 50 },
      { title: 'A 50-point Halloween treat', progress: 1, max: 6, points: 50, icon: '🎃' }
    ]
  };

  const origGetRewards = rewardsApi.getRewardsInfo;
  const origStreak = rewardsApi.checkStreak;
  rewardsApi.getRewardsInfo = async () => mockInfo;
  rewardsApi.checkStreak = async () => ({ streakDays: 5 });

  // 同步状态
  return tm.syncAccountOfficialStatus(accCfg, { owned: true }).then(() => {
    const st = tm.ensureAccountStats(accId);
    const punchCards = Object.values(st.tasks).filter(t => t.isPunchCard);
    assert.equal(punchCards.length, 2, '应动态生成 2 个打孔卡');
    assert.ok(st.tasks.quest_halloween, '应包含万圣节打孔卡');
    assert.equal(st.tasks.quest_halloween.icon, '🎃');

    // 2. 模拟万圣节任务活动结束后官网只有 1 个任务
    mockInfo.quests = [
      { title: '十月必看五大亮点', progress: 2, max: 5, points: 50 }
    ];

    return tm.syncAccountOfficialStatus(accCfg, { owned: true }).then(() => {
      const stAfter = tm.ensureAccountStats(accId);
      const punchCardsAfter = Object.values(stAfter.tasks).filter(t => t.isPunchCard);
      assert.equal(punchCardsAfter.length, 1, '下线活动应自动移除，只保留 1 个打孔卡');
      assert.equal(stAfter.tasks.quest_halloween, undefined, '万圣节卡片应已自动清除');
      assert.ok(stAfter.tasks.monthlyQuest, '月度打孔卡应继续保留');
      assert.equal(stAfter.tasks.monthlyQuest.progress, 2);
    });
  }).finally(() => {
    rewardsApi.getRewardsInfo = origGetRewards;
    rewardsApi.checkStreak = origStreak;
  });
});

test('Safari 格式 Cookie 自动规整化与解析测试', () => {
  // 模拟 Safari 换行与表格制表符复制
  const safariRaw = `
    MUID\t36AE7B3059EA689620DD6E8158C269DF
    _U\t"1XDZ_Sample_Auth_Cookie"
    _RwBf\trc=180&rb=180
  `;
  const normalized = normalizeCookieString(safariRaw);
  assert.ok(!normalized.includes('\n'), '规整化后不得包含换行符');
  assert.match(normalized, /MUID=36AE7B3059EA689620DD6E8158C269DF/);
  assert.match(normalized, /_U="1XDZ_Sample_Auth_Cookie"/);

  const parsed = browserManager.parseCookies(safariRaw);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].name, 'MUID');
  assert.equal(parsed[1].name, '_U');
  assert.equal(parsed[1].value, '1XDZ_Sample_Auth_Cookie', '双引号应被自动剥离');
});

test('parseCookies 正确处理 __Host- 与 __Secure- 特殊 Cookie 前缀并兼容 Playwright', () => {
  const raw = '__Host-XY=test_val; __Secure-AUTH=secure_val; MUID=normal_val';
  const parsed = browserManager.parseCookies(raw, '.bing.com');
  assert.equal(parsed.length, 3);

  const hostCookie = parsed.find(c => c.name === '__Host-XY');
  assert.ok(hostCookie);
  assert.equal(hostCookie.domain, undefined, '__Host- Cookie 不得包含 domain 属性');
  assert.equal(hostCookie.url, 'https://bing.com', '__Host- Cookie 应使用 url 指定源');
  assert.equal(hostCookie.secure, true, '__Host- Cookie 必须包含 secure 属性');

  const secureCookie = parsed.find(c => c.name === '__Secure-AUTH');
  assert.ok(secureCookie);
  assert.equal(secureCookie.secure, true, '__Secure- Cookie 必须包含 secure 属性');
  assert.equal(secureCookie.domain, '.bing.com');

  const normalCookie = parsed.find(c => c.name === 'MUID');
  assert.ok(normalCookie);
  assert.equal(normalCookie.domain, '.bing.com');
});

test('官网打孔卡列表瞬时为空时，不得误删已有打孔卡（防闪烁防丢卡）', async () => {
  const tm = new TaskManager();
  const accId = 'acc_preserve_test';
  const accCfg = { id: accId, name: '防闪烁测试账号', cookie: 'MOCK_COOKIE' };
  tm.ensureAccountStats(accId);

  const mockInfo = {
    todayPoints: 50,
    quests: [
      { title: '十月必看五大亮点', progress: 2, max: 5, points: 50 },
      { title: 'A 50-point Halloween treat', progress: 1, max: 6, points: 50 }
    ]
  };

  const origGetRewards = rewardsApi.getRewardsInfo;
  rewardsApi.getRewardsInfo = async () => mockInfo;

  try {
    await tm.syncAccountOfficialStatus(accCfg, { owned: true });
    const st1 = tm.ensureAccountStats(accId);
    assert.ok(st1.tasks.quest_halloween, '初始应包含万圣节卡片');

    // 模拟下一次网络拉取由于未加载完 Flight 流导致 quests 为空
    mockInfo.quests = [];
    await tm.syncAccountOfficialStatus(accCfg, { owned: true });
    const st2 = tm.ensureAccountStats(accId);
    assert.ok(st2.tasks.quest_halloween, '瞬时空响应严禁清空万圣节卡片');
    assert.ok(st2.tasks.monthlyQuest, '瞬时空响应严禁清空月度打孔卡');
  } finally {
    rewardsApi.getRewardsInfo = origGetRewards;
  }
});
