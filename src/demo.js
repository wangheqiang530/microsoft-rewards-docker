import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEMO_DATA_DIR = path.join(PROJECT_ROOT, 'data', 'demo');

// 强制使用独立演示目录与 Epic 演示模式，彻底隔离真实生产环境
process.env.MSR_DATA_DIR = DEMO_DATA_DIR;
process.env.MSR_ENABLE_DEMO = '1';

fs.mkdirSync(DEMO_DATA_DIR, { recursive: true });

const { default: configManager } = await import('./config.js');
const { default: logger } = await import('./logger.js');
const { default: taskManager } = await import('./core/taskManager.js');
const { default: historyManager } = await import('./core/history.js');
const { default: browserManager } = await import('./core/browser.js');
const { default: authManager } = await import('./core/auth.js');
const { default: rewardsApi } = await import('./core/api.js');
const { createServer } = await import('./web/server.js');

// 拦截在线同步与外网请求，避免 demo 数据被未授权的外网空响应重置为 0
taskManager.syncAccountOfficialStatus = async (accCfg) => {
  return taskManager.ensureAccountStats(accCfg?.id);
};
taskManager.syncAllOfficialStatus = async () => {
  return taskManager.computeSummary();
};
authManager.refreshToken = async () => true;
authManager.checkTokenStatus = async () => ({ valid: true, message: '移动端 Token 有效 (演示模式)' });
authManager.checkCookieStatus = async () => ({ valid: true, message: '网页端 Cookie 有效 (演示模式)' });
rewardsApi.checkRegion = async () => true;
rewardsApi.getIPInfo = async () => ' 出口IP: 127.0.0.1 所在地: 本地演示环境';

console.log(`
==============================================================
🎁 Microsoft Rewards 微软积分自动化控制台 (本地安全演示模式)
==============================================================
⚠️  此模式完全处于沙盒隔离环境：
   • 数据隔离：所有配置与历史存放在 data/demo/，不读取也不修改真实 data/
   • 零请求零冲突：后台定时器已禁用，不执行真实打卡，与 NAS 容器完全互斥隔离
   • 视觉效果完整：注入多账号完整大屏、对称 4 Hero 布局、印章进度与操作菜单
==============================================================
`);

// 1. 注入 3 个典型状态的多账号配置
configManager.update({
  accounts: [
    {
      id: 'demo_acc_1',
      name: '主账号 (张三)',
      order: 1,
      enabled: true,
      cookie: 'DEMO_COOKIE_1;_U=mock_user_1',
      refreshToken: 'mock_rt_1',
      timeSlot: { startHour: 9, endHour: 13, randomDelayMin: 45, durationHours: 2 }
    },
    {
      id: 'demo_acc_2',
      name: '副账号 1 (李四)',
      order: 2,
      enabled: true,
      cookie: 'DEMO_COOKIE_2;_U=mock_user_2',
      refreshToken: 'mock_rt_2',
      timeSlot: { startHour: 13, endHour: 17, randomDelayMin: 30, durationHours: 2 }
    },
    {
      id: 'demo_acc_3',
      name: '副账号 2 (王五)',
      order: 3,
      enabled: true,
      cookie: 'DEMO_COOKIE_3;_U=mock_user_3',
      refreshToken: 'mock_rt_3',
      timeSlot: { startHour: 17, endHour: 21, randomDelayMin: 50, durationHours: 2 }
    }
  ],
  schedule: {
    enabled: false // 禁用自动调度
  }
});

// 2. 注入各账号真实任务数据
const todayNum = taskManager.getTodayNum();
const baseAccountsStats = {
  demo_acc_1: {
    id: 'demo_acc_1',
    name: '主账号 (张三)',
    date: todayNum,
    balance: 51355,
    startBalance: 51218,
    earned: 137,
    claimablePoints: 3,
    streakDays: 42,
    stamps: { progress: 8, max: 12 },
    streaks: {
      bing: { completedDays: 5, currentDay: 6, activitiesCompleted: 3, activitiesTotal: 3, isCurrentDayCompleted: true },
      dailyset: { completedDays: 4, currentDay: 5, activitiesCompleted: 3, activitiesTotal: 3, isCurrentDayCompleted: true },
      bingapp: { completedDays: 3, currentDay: 4, activitiesCompleted: 1, activitiesTotal: 1, isCurrentDayCompleted: true }
    },
    lastUpdate: Date.now() - 12 * 60 * 1000,
    tasks: {
      sign: { name: '移动端签到', progress: 1, max: 1, points: 10, unit: '次', icon: '📱', done: true },
      appPromotions: { name: '移动端附加活动', progress: 3, max: 3, points: 30, unit: '项', icon: '📱', available: true, done: true },
      read: { name: '新闻资讯自动阅读', progress: 30, max: 30, points: 30, unit: '篇', icon: '📖', done: true },
      search: { name: '必应 PC 搜索任务', progress: 60, max: 60, points: 60, unit: '分', icon: '🔍', done: true },
      dailySet: { name: '每日活动集 (Daily Set)', progress: 3, max: 3, points: 30, unit: '个', icon: '📅', done: true },
      promos: { name: '活动卡片与 Quiz 问答', progress: 2, max: 2, points: 15, unit: '项', icon: '🧩', done: true },
      desktopApp: {
        name: '桌面应用每周专属任务',
        progress: 6,
        max: 8,
        points: 0,
        unit: '个任务',
        icon: '🖥️',
        expiresText: '到期日期 3 天后',
        available: true,
        done: false,
        stepLogs: [
          { step: 1, at: Date.now() - 4 * 86400000, name: '搜索 1 次' },
          { step: 2, at: Date.now() - 3 * 86400000, name: '搜索 2 次' },
          { step: 3, at: Date.now() - 2 * 86400000, name: '搜索 3 次' },
          { step: 4, at: Date.now() - 86400000, name: '搜索 4 次' },
          { step: 5, at: Date.now() - 6 * 3600 * 1000, name: '搜索 5 次' },
          { step: 6, at: Date.now() - 1 * 3600 * 1000, name: '搜索 6 次' }
        ]
      },
      monthlyQuest: {
        name: '十月必看五大亮点：服饰、玩具、手机、超值优惠和AI设备',
        progress: 2,
        max: 5,
        points: 0,
        unit: '个任务',
        icon: '🍁',
        expiresText: '到期日期 2 周后',
        available: true,
        done: false,
        isPunchCard: true,
        stepLogs: [
          { step: 1, at: Date.now() - 22 * 3600 * 1000, name: '服装季来了' },
          { step: 2, at: Date.now() - 2 * 3600 * 1000, name: '热门玩具与礼物创意' }
        ]
      },
      quest_halloween: {
        name: 'A 50-point Halloween treat',
        progress: 0,
        max: 6,
        points: 50,
        unit: '个任务',
        icon: '🎃',
        expiresText: '到期日期 17 天后',
        available: true,
        done: false,
        isPunchCard: true,
        stepLogs: []
      }
    }
  },
  demo_acc_2: {
    id: 'demo_acc_2',
    name: '副账号 1 (李四)',
    date: todayNum,
    balance: 32480,
    startBalance: 32390,
    earned: 90,
    claimablePoints: 0,
    streakDays: 18,
    stamps: { progress: 5, max: 12 },
    streaks: {
      bing: { completedDays: 2, currentDay: 3, activitiesCompleted: 1, activitiesTotal: 3, isCurrentDayCompleted: false },
      dailyset: { completedDays: 2, currentDay: 3, activitiesCompleted: 2, activitiesTotal: 3, isCurrentDayCompleted: false },
      bingapp: { completedDays: 2, currentDay: 3, activitiesCompleted: 0, activitiesTotal: 1, isCurrentDayCompleted: false }
    },
    lastUpdate: Date.now() - 45 * 60 * 1000,
    tasks: {
      sign: { name: '移动端签到', progress: 0, max: 1, points: 0, unit: '次', icon: '📱', done: false },
      appPromotions: { name: '移动端附加活动', progress: 1, max: 3, points: 10, unit: '项', icon: '📱', available: true, done: false },
      read: { name: '新闻资讯自动阅读', progress: 30, max: 30, points: 30, unit: '篇', icon: '📖', done: true },
      search: { name: '必应 PC 搜索任务', progress: 42, max: 60, points: 42, unit: '分', icon: '🔍', done: false },
      dailySet: { name: '每日活动集 (Daily Set)', progress: 2, max: 3, points: 0, unit: '个', icon: '📅', done: false },
      promos: { name: '活动卡片与 Quiz 问答', progress: 1, max: 2, points: 8, unit: '项', icon: '🧩', done: false },
      desktopApp: {
        name: '桌面应用每周专属任务',
        progress: 4,
        max: 8,
        points: 0,
        unit: '个任务',
        icon: '🖥️',
        expiresText: '到期日期 3 天后',
        available: true,
        done: false,
        stepLogs: [
          { step: 1, at: Date.now() - 3 * 86400000 },
          { step: 2, at: Date.now() - 2 * 86400000 },
          { step: 3, at: Date.now() - 86400000 },
          { step: 4, at: Date.now() - 5 * 3600 * 1000 }
        ]
      },
      monthlyQuest: {
        name: '十月必看五大亮点：服饰、玩具、手机、超值优惠和AI设备',
        progress: 1,
        max: 5,
        points: 0,
        unit: '个任务',
        icon: '🍁',
        expiresText: '到期日期 2 周后',
        available: true,
        done: false,
        isPunchCard: true,
        stepLogs: [
          { step: 1, at: Date.now() - 18 * 3600 * 1000, name: '服装季来了' }
        ]
      }
    }
  },
  demo_acc_3: {
    id: 'demo_acc_3',
    name: '副账号 2 (王五)',
    date: todayNum,
    balance: 18920,
    startBalance: 18760,
    earned: 160,
    claimablePoints: 5,
    streakDays: 7,
    stamps: { progress: 11, max: 12 },
    streaks: {
      bing: { completedDays: 7, currentDay: 7, activitiesCompleted: 3, activitiesTotal: 3, isCurrentDayCompleted: true },
      dailyset: { completedDays: 7, currentDay: 7, activitiesCompleted: 3, activitiesTotal: 3, isCurrentDayCompleted: true },
      bingapp: { completedDays: 6, currentDay: 7, activitiesCompleted: 1, activitiesTotal: 1, isCurrentDayCompleted: true }
    },
    lastUpdate: Date.now() - 5 * 60 * 1000,
    tasks: {
      sign: { name: '移动端签到', progress: 1, max: 1, points: 10, unit: '次', icon: '📱', done: true },
      appPromotions: { name: '移动端附加活动', progress: 3, max: 3, points: 30, unit: '项', icon: '📱', available: true, done: true },
      read: { name: '新闻资讯自动阅读', progress: 30, max: 30, points: 30, unit: '篇', icon: '📖', done: true },
      search: { name: '必应 PC 搜索任务', progress: 60, max: 60, points: 60, unit: '分', icon: '🔍', done: true },
      dailySet: { name: '每日活动集 (Daily Set)', progress: 3, max: 3, points: 30, unit: '个', icon: '📅', done: true },
      promos: { name: '活动卡片与 Quiz 问答', progress: 3, max: 3, points: 30, unit: '项', icon: '🧩', done: true },
      desktopApp: {
        name: '桌面应用每周专属任务',
        progress: 8,
        max: 8,
        points: 20,
        unit: '个任务',
        icon: '🖥️',
        expiresText: '本周已全部达成',
        available: true,
        done: true,
        isPunchCard: true,
        stepLogs: [
          { step: 1, at: Date.now() - 7 * 86400000 },
          { step: 2, at: Date.now() - 6 * 86400000 },
          { step: 3, at: Date.now() - 5 * 86400000 },
          { step: 4, at: Date.now() - 4 * 86400000 },
          { step: 5, at: Date.now() - 3 * 86400000 },
          { step: 6, at: Date.now() - 2 * 86400000 },
          { step: 7, at: Date.now() - 86400000 },
          { step: 8, at: Date.now() - 3 * 3600 * 1000 }
        ]
      }
    }
  }
};

taskManager.stats = {
  date: todayNum,
  accounts: baseAccountsStats
};
taskManager.loadStats = () => {
  return {
    date: todayNum,
    accounts: structuredClone(baseAccountsStats)
  };
};
// 演示账号的 Cookie 是固定占位符，不应触发真实账号的身份变化清理。
taskManager.ensureAccountStats = (accountId) => {
  const accCfg = configManager.resolveAccount(accountId);
  const id = accCfg?.id || accountId || 'demo_acc_1';
  if (!taskManager.stats.accounts[id]) {
    taskManager.stats.accounts[id] = taskManager.createDefaultAccountStats(id, accCfg?.name || id);
  }
  return taskManager.stats.accounts[id];
};
taskManager.saveStats();

// 3. 注入 7 天真实历史积分趋势
const now = new Date();
for (let i = 6; i >= 0; i--) {
  const d = new Date(now.getTime() - i * 86400000);
  const dateKey = historyManager.formatDate(d);
  const earned1 = i === 0 ? 137 : (120 + ((i * 17) % 35));
  const earned2 = i === 0 ? 90 : (100 + ((i * 13) % 40));
  const earned3 = i === 0 ? 160 : (140 + ((i * 19) % 30));

  historyManager.recordAccountDay('demo_acc_1', dateKey, {
    earned: earned1,
    balance: 51355 - i * 135,
    claimablePoints: i === 0 ? 3 : (i % 3 === 0 ? 5 : 0),
    streakDays: Math.max(0, 42 - i),
    stamps: { progress: Math.max(0, 8 - Math.floor(i / 4)), max: 12 },
    breakdown: [
      { name: '必应 PC 搜索任务', icon: '🔍', points: 60 },
      { name: '每日活动集 (Daily Set)', icon: '📅', points: 30 },
      { name: '新闻资讯自动阅读', icon: '📖', points: 30 },
      { name: '活动卡片与 Quiz 问答', icon: '🧩', points: 15 },
      { name: '移动端签到', icon: '📱', points: 10 }
    ]
  });

  historyManager.recordAccountDay('demo_acc_2', dateKey, {
    earned: earned2,
    balance: 32480 - i * 110,
    claimablePoints: i === 0 ? 0 : (i % 4 === 0 ? 5 : 0),
    streakDays: Math.max(0, 18 - i),
    stamps: { progress: Math.max(0, 5 - Math.floor(i / 5)), max: 12 },
    breakdown: [
      { name: '必应 PC 搜索任务', icon: '🔍', points: 42 },
      { name: '新闻资讯自动阅读', icon: '📖', points: 30 },
      { name: '移动端签到', icon: '📱', points: 10 }
    ]
  });

  historyManager.recordAccountDay('demo_acc_3', dateKey, {
    earned: earned3,
    balance: 18920 - i * 155,
    claimablePoints: i === 0 ? 5 : (i % 2 === 0 ? 3 : 0),
    streakDays: Math.max(0, 7 - i),
    stamps: { progress: Math.max(0, 11 - Math.floor(i / 3)), max: 12 },
    breakdown: [
      { name: '必应 PC 搜索任务', icon: '🔍', points: 60 },
      { name: '每日活动集 (Daily Set)', icon: '📅', points: 30 },
      { name: '新闻资讯自动阅读', icon: '📖', points: 30 },
      { name: '桌面应用每周专属任务', icon: '🖥️', points: 20 },
      { name: '移动端签到', icon: '📱', points: 10 }
    ]
  });
}
historyManager.flush();

// 4. 注入无头浏览器监控演示状态
browserManager.updateState({
  status: 'dwelling',
  activeAccountId: 'demo_acc_2',
  activeAccountName: '副账号 1 (李四)',
  currentQuery: '神舟十九号载人飞船发射成功',
  searchCount: 14,
  totalTarget: 20,
  pointsNeeded: 18,
  nextSearchIn: 88,
  memoryMB: 195,
  lastAction: '[演示状态] 模拟真人浏览搜索结果中，带 3.5 分钟拟人平缓呼吸间隔'
});

// 5. 注入日志
logger.log('🟢', '演示服务已加载 3 个多账号示例');
logger.log('👤', '账号 [主账号 (张三)] 今日打卡满额 +137 积分达成', '', '主账号 (张三)');
logger.log('🔍', '账号 [副账号 1 (李四)] 正在执行平缓搜索 (进度 42/60 分)', '', '副账号 1 (李四)');
logger.log('🎮', 'Epic 模块就绪（演示模式：已预置 3 个示例游戏与历史领取清单）');

logger.addTimeline('主账号 (张三)', '移动端签到完成 (+10 积分)');
logger.addTimeline('主账号 (张三)', '新闻阅读完成 30/30 (+30 积分)');
logger.addTimeline('主账号 (张三)', 'PC 搜索满额达成 (+60 积分)');
logger.addTimeline('副账号 1 (李四)', '移动端签到已生效 (官网连签第 18 天)');
logger.addTimeline('副账号 2 (王五)', '全套打卡完成 (+160 积分)');

// 6. 注入演示用 Epic 账号与历史处理记录
configManager.update({
  epic: {
    enabled: true,
    checkIntervalMin: 720,
    retryCount: 2,
    retryIntervalSec: 60,
    accountGapSec: 20,
    accounts: [
      {
        id: 'epic_demo_1',
        name: 'Epic 账号 1 (主号)',
        order: 1,
        enabled: true,
        storageState: { cookies: [{ name: 'EPIC_BEARER', value: 'mock_bearer_1', domain: '.epicgames.com' }], origins: [] },
        sessionValid: true,
        lastVerifyAt: Date.now() - 40 * 60 * 1000,
        lastVerifyMessage: '会话有效（已登录）',
        lastClaimAt: Date.now() - 25 * 60 * 1000,
        lastClaimMessage: '本次领取 1 个 / 已有 1 个 / 失败 0 个',
        handledGames: {
          'demo_game_1': { title: '虎视眈眈 (Out of Sight)', at: Date.now() - 25 * 60 * 1000, status: 'claimed' },
          'demo_game_2': { title: 'TerraScape', at: Date.now() - 24 * 60 * 1000, status: 'owned' },
          'cb733f3432db46bca94965b422c33ede': { title: '虎视眈眈 (Out of Sight)', at: Date.now() - 25 * 60 * 1000, status: 'claimed' },
          'af6b823b8698465f9aedc3bddf2e8686': { title: 'TerraScape', at: Date.now() - 24 * 60 * 1000, status: 'owned' }
        }
      },
      {
        id: 'epic_demo_2',
        name: 'Epic 账号 2 (二号机)',
        order: 2,
        enabled: true,
        storageState: { cookies: [{ name: 'EPIC_BEARER', value: 'mock_bearer_2', domain: '.epicgames.com' }], origins: [] },
        sessionValid: true,
        lastVerifyAt: Date.now() - 30 * 60 * 1000,
        lastVerifyMessage: '会话有效（已登录）',
        lastClaimAt: Date.now() - 15 * 60 * 1000,
        lastClaimMessage: '本次领取 1 个 / 已有 0 个 / 失败 0 个',
        handledGames: {
          'demo_game_1': { title: '虎视眈眈 (Out of Sight)', at: Date.now() - 15 * 60 * 1000, status: 'claimed' },
          'cb733f3432db46bca94965b422c33ede': { title: '虎视眈眈 (Out of Sight)', at: Date.now() - 15 * 60 * 1000, status: 'claimed' }
        }
      },
      {
        id: 'epic_demo_3',
        name: 'Epic 账号 3 (三号机)',
        order: 3,
        enabled: true,
        storageState: { cookies: [{ name: 'EPIC_BEARER', value: 'mock_bearer_3', domain: '.epicgames.com' }], origins: [] },
        sessionValid: true,
        lastVerifyAt: Date.now() - 10 * 60 * 1000,
        lastVerifyMessage: '会话有效（已登录）',
        lastClaimAt: 0,
        lastClaimMessage: '',
        handledGames: {}
      }
    ],
    claimRecords: [
      { accountId: 'epic_demo_1', title: '虎视眈眈 (Out of Sight)', ok: true, status: 'claimed', message: '领取成功', at: Date.now() - 25 * 60 * 1000 },
      { accountId: 'epic_demo_1', title: 'TerraScape', ok: true, status: 'owned', message: '已在库中', at: Date.now() - 24 * 60 * 1000 },
      { accountId: 'epic_demo_2', title: '虎视眈眈 (Out of Sight)', ok: true, status: 'claimed', message: '领取成功', at: Date.now() - 15 * 60 * 1000 }
    ]
  }
});

const port = process.env.PORT || 5399;
const app = createServer();
app.listen(port, '0.0.0.0', () => {
  console.log(`
✨ 演示服务已启动！
👉 请在本地浏览器访问: http://localhost:${port}
`);
});
