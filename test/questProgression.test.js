import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateQuestAdvance,
  isQuestSubtaskCoolingDown,
  resolveQuestTargetUrl
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
