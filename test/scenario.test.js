import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runScenario } from '../src/scenario.js';
import { RecoveryVerdict } from '../src/constants.js';

describe('声明式场景运行器', () => {
  it('缓存故障 + 回写中断 + journal 损坏的组合场景输出完整报告', () => {
    const result = runScenario([
      { type: 'write', cacheBlock: 1, startSector: 64 },
      { type: 'write', cacheBlock: 2, startSector: 128 },
      { type: 'write', cacheBlock: 3, startSector: 192 },
      { type: 'flush', cacheBlock: 3 },
      { type: 'flush_partial', cacheBlock: 1, tornBytes: 512, interrupt: true },
      { type: 'journal_corrupt', seq: 1 },
      { type: 'cache_failed', loseJournal: false },
      { type: 'analyze', writebackOrder: [1, 2] },
    ]);

    const report = result.lastReport;
    assert.equal(report.safeBlocks.length, 1);
    assert.equal(report.safeBlocks[0].cacheBlock, 3);
    assert.deepEqual(report.summary.corruptedJournalSeqs, [1]);
    assert.equal(report.dirtyConflicts.length, 1);
    assert.equal(report.dirtyConflicts[0].reason, 'torn_backing_write');
    assert.equal(report.dirtyConflicts[0].cacheBlock, 1);
    assert.equal(report.recoverableBlocks.length, 1);
    assert.equal(report.recoverableBlocks[0].cacheBlock, 2);

    const steps = report.recoveryOrder;
    assert.equal(steps[0].cacheBlock, 2);
    assert.equal(steps.at(-1).autoSafe, false);
    assert.equal(steps.at(-1).action, 'quarantine_then_rewrite');
  });

  it('重复挂载场景可多次 analyze 且结论稳定', () => {
    const result = runScenario([
      { type: 'write', cacheBlock: 1, startSector: 64 },
      { type: 'reuse', cacheBlock: 1, newStartSector: 256 },
      { type: 'cache_failed', loseJournal: false },
      { type: 'analyze' },
      { type: 'remount' },
      { type: 'remount' },
      { type: 'analyze' },
    ]);

    assert.equal(result.reports.length, 2);
    const [first, second] = result.reports;
    assert.deepEqual(first.summary, second.summary);
    assert.equal(second.recoverableBlocks[0].verdict, RecoveryVerdict.RECOVERABLE);
    assert.equal(result.timeline.filter((event) => event.type === 'remount').length, 2);
  });

  it('未知事件类型抛出可读错误', () => {
    assert.throws(() => runScenario([{ type: 'nope' }]), /未知场景事件类型/);
  });

  it('回写顺序引用不存在的缓存块时校验失败', () => {
    assert.throws(
      () => runScenario([
        { type: 'write', cacheBlock: 1, startSector: 64 },
        { type: 'analyze', writebackOrder: [99] },
      ]),
      /不存在的缓存块 99/,
    );
  });
});
