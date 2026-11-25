import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-v1810-'));
process.env.MSR_DATA_DIR = tmpDir;

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'src/web/public/app.js'), 'utf-8');
const { TaskManager } = await import('../src/core/taskManager.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('打孔卡日志只保留当前进度以内的唯一记录', () => {
  const manager = new TaskManager();
  const task = {
    progress: 3,
    max: 8,
    done: false,
    stepLogs: [
      { step: 1, at: 1 },
      { step: 2, at: 2 },
      { step: 2, at: 3 },
      { step: 3, at: 4 },
      { step: 4, at: 5 },
      { step: 7, at: 6 }
    ]
  };
  const result = manager.normalizePunchCardTask(task);
  assert.equal(result.changed, true);
  assert.equal(task.progress, 3);
  assert.deepEqual(task.stepLogs.map(log => log.step), [1, 2, 3]);
  assert.equal(task.stepLogs[1].at, 3);
});

test('新周期重置旧打孔进度，同周期仍防止瞬时 0 回退', () => {
  const manager = new TaskManager();
  const previous = {
    cycleKey: 'old-week',
    progress: 7,
    max: 8,
    done: false,
    stepLogs: [1, 2, 3, 4, 5, 6, 7].map(step => ({ step, at: step }))
  };
  const nextCycle = manager.mergePunchCardTask(previous, {
    cycleKey: 'new-week',
    progress: 3,
    max: 8,
    done: false,
    stepLogs: [1, 2, 3].map(step => ({ step, at: step + 10 }))
  });
  assert.equal(nextCycle.progress, 3);
  assert.deepEqual(nextCycle.stepLogs.map(log => log.step), [1, 2, 3]);

  const sameCycle = manager.mergePunchCardTask(nextCycle, {
    cycleKey: 'new-week',
    progress: 0,
    max: 8,
    done: false,
    stepLogs: []
  });
  assert.equal(sameCycle.progress, 3);
  assert.deepEqual(sameCycle.stepLogs.map(log => log.step), [1, 2, 3]);
});

test('悬浮明细不会把超过当前进度的旧日志显示为已完成', () => {
  assert.match(APP_SOURCE, /const log = s <= p \? logs\.find\(l => Number\(l\.step\) === s\) : null/);
  assert.match(APP_SOURCE, /const p = Math\.max\(0, Math\.min\(m, Number\(t\.progress \|\| 0\)\)\)/);
});
