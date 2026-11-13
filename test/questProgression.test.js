import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateQuestAdvance,
  isQuestSubtaskCoolingDown,
  resolveQuestTargetUrl,
  classifyQuestAction,
  extractQuestSearchQuery,
  isQuestSearchTarget,
  resolveQuestFailureCooldown,
  questVerificationAttempts
} from '../src/core/questStatus.js';

test('打孔卡总进度未增加时，不能因页面扫描出更多子任务而判定完成', () => {
  const result = evaluateQuestAdvance({
    targetCompletedBefore: false,
    targetCompletedAfter: false,
    targetProgressBefore: null,
    targetProgressAfter: null,
    officialProgressBefore: 1,
    officialProgressAfter: 1,
    officialProgressKnown: true
  });
  assert.equal(result.advanced, false);
  assert.equal(result.verifiedBy, '');
});

test('只有任务页总进度增加才算打孔卡真正推进', () => {
  const result = evaluateQuestAdvance({
    officialProgressBefore: 1,
    officialProgressAfter: 2,
    officialProgressKnown: true
  });
  assert.equal(result.advanced, true);
  assert.equal(result.verifiedBy, 'official-progress');
});

test('无法读取总进度时才允许使用当前子任务自身完成状态兜底', () => {
  const result = evaluateQuestAdvance({
    targetCompletedBefore: false,
    targetCompletedAfter: true,
    officialProgressKnown: false
  });
  assert.equal(result.advanced, true);
  assert.equal(result.verifiedBy, 'subtask-completed');
});

test('子任务原有进度未知时，不能把 null 当成 0 伪造推进', () => {
  const result = evaluateQuestAdvance({
    targetProgressBefore: null,
    targetProgressAfter: 2,
    officialProgressKnown: false
  });
  assert.equal(result.advanced, false);
});

test('打孔卡目标地址支持缺协议域名与相对路径', () => {
  assert.equal(
    resolveQuestTargetUrl('bing.com/search?q=test', 'https://rewards.bing.com/earn'),
    'https://bing.com/search?q=test'
  );
  assert.equal(
    resolveQuestTargetUrl('/earn/quest/test', 'https://rewards.bing.com/earn'),
    'https://rewards.bing.com/earn/quest/test'
  );
  assert.equal(resolveQuestTargetUrl('javascript:void(0)'), '');
});

test('旧版未经验证的假完成冷却不会继续挡住任务', () => {
  const now = Date.now();
  assert.equal(isQuestSubtaskCoolingDown({
    lastResult: 'advanced',
    lastProgressAfter: null,
    cooldownUntil: now + 24 * 60 * 60 * 1000
  }, now), false);
  assert.equal(isQuestSubtaskCoolingDown({
    lastResult: 'advanced',
    lastProgressAfter: 2,
    lastVerification: 'official-progress',
    cooldownUntil: now + 24 * 60 * 60 * 1000
  }, now), true);
});

test('月度打孔卡第 3 项虽写着“比较电子产品”，但 Bing 搜索 href 必须识别为搜索', () => {
  const target = {
    title: '11月电子产品优惠',
    actionText: '比较电子产品',
    rawText: '11月电子产品优惠 比较电子产品',
    href: 'https://www.bing.com/search?q=2026%E5%B9%B4%E9%BB%91%E8%89%B2%E6%98%9F%E6%9C%9F%E4%BA%94%E7%94%B5%E5%AD%90%E4%BA%A7%E5%93%81%E4%BC%98%E6%83%A0&form=ML2YB2'
  };
  assert.equal(classifyQuestAction(target), 'unknown');
  assert.equal(isQuestSearchTarget(target), true);
  assert.equal(
    extractQuestSearchQuery(target),
    '2026年黑色星期五电子产品优惠'
  );
});

test('搜索 href 里的 q 参数优先于随机热词，保证官网任务可核验', () => {
  assert.equal(extractQuestSearchQuery({
    href: 'https://www.bing.com/search?q=coffee+beans&amp;form=ML2YB2'
  }), 'coffee beans');
  assert.equal(extractQuestSearchQuery({
    href: 'https://example.com/search?q=wrong-domain'
  }), '');
  assert.equal(isQuestSearchTarget({
    href: 'https://example.com/search?q=wrong-domain'
  }), false);
});

test('旧版未验证的 visit 冷却会失效，允许重新执行修正后的搜索动作', () => {
  const now = Date.now();
  assert.equal(isQuestSubtaskCoolingDown({
    lastResult: 'no-change',
    lastProgressAfter: 1,
    lastVerification: '',
    attempts: 7,
    cooldownUntil: now + 60 * 60 * 1000
  }, now), false);
  assert.equal(isQuestSubtaskCoolingDown({
    lastResult: 'no-change',
    lastProgressAfter: 1,
    lastVerification: '',
    attempts: 1,
    cooldownUntil: now + 60 * 60 * 1000
  }, now), true);
});

test('未确认的搜索只做 10 分钟短冷却，避免月度打孔卡被锁到次日', () => {
  assert.equal(resolveQuestFailureCooldown('search'), 10 * 60 * 1000);
  assert.equal(resolveQuestFailureCooldown('unknown'), 10 * 60 * 1000);
  assert.equal(resolveQuestFailureCooldown('visit'), 30 * 60 * 1000);
});

test('打孔卡执行器对 href 搜索任务也必须真实提交指定搜索词', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/core/browser.js'),
    'utf-8'
  );
  assert.match(source, /const searchKind = target\.kind === 'search' \|\| targetIsBingSearch/);
  assert.match(source, /const questQuery = extractQuestSearchQuery\(target\)/);
  // 官网给的带 form/OCID/PUBL 追踪参数的搜索链接必须被直接访问，
  // 而不是被重输关键词冲掉追踪参数（否则月度打孔卡会卡在 2/5）。
  assert.match(source, /const officialSearchTarget = isQuestSearchTarget\(\{ href: targetUrl \|\| target\.href \}\)/);
  assert.match(source, /searchPage\.goto\(officialSearchTarget/);
  assert.match(source, /!searchKind[\s\S]*?\['visit', 'quiz', 'reward', 'unknown'\]\.includes\(target\.kind\)/);
});

test('动作已提交但官网延迟写入时，会多回读几次而不是立刻判失败', () => {
  assert.deepEqual(questVerificationAttempts({ performed: true }), {
    attempts: 5,
    delayMs: 2500
  });
  assert.deepEqual(questVerificationAttempts({
    searchResult: { searchSubmitted: true }
  }), {
    attempts: 5,
    delayMs: 2500
  });
  assert.deepEqual(questVerificationAttempts({}), {
    attempts: 3,
    delayMs: 1200
  });
});
