import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BcacheWritebackSimulator } from '../src/simulator.js';
import { analyzeRecovery } from '../src/analyzer.js';
import {
  InvalidReason,
  RecoveryVerdict,
  SECTORS_PER_BLOCK,
} from '../src/constants.js';

describe('恢复分析器：缓存故障', () => {
  it('journal 存活时脏块可恢复，已回写净块判定为安全', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.write(2, 128);
    sim.flushBlock({ cacheBlock: 1 });
    sim.failCache({ loseJournal: false });

    const report = analyzeRecovery(sim, { writebackOrder: [2] });
    assert.equal(report.summary.cacheLost, false);
    assert.equal(report.summary.safeBlocks, 1);
    assert.equal(report.summary.recoverableBlocks, 1);
    assert.equal(report.summary.recoverableSectors, SECTORS_PER_BLOCK);

    const safe = report.safeBlocks.find((block) => block.cacheBlock === 1);
    assert.equal(safe.verdict, RecoveryVerdict.SAFE);
    const recoverable = report.recoverableBlocks.find((block) => block.cacheBlock === 2);
    assert.equal(recoverable.startSector, 128);

    assert.deepEqual(report.recoveryOrder.map((step) => step.cacheBlock), [2]);
    assert.equal(report.recoveryOrder[0].autoSafe, true);
  });

  it('缓存连带 journal 丢失：有完整后备的块安全，无后备的块报脏块冲突', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.write(2, 128);
    sim.flushBlock({ cacheBlock: 1 });
    sim.failCache({ loseJournal: true });

    const report = analyzeRecovery(sim);
    assert.equal(report.summary.cacheLost, true);
    assert.equal(report.safeBlocks.length, 1);
    assert.equal(report.safeBlocks[0].reason, 'cache_lost_backing_intact');
    assert.equal(report.dirtyConflicts.length, 1);
    assert.equal(report.dirtyConflicts[0].reason, 'cache_lost_without_backing');
    assert.equal(report.recoverableBlocks.length, 0);
    assert.equal(report.recoveryOrder[0].autoSafe, false);
    assert.equal(report.recoveryOrder[0].action, 'manual_intervention');
  });

  it('强制 detach 带脏块卸载后，未回写块进入冲突列表', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    const dirtyCount = sim.detach({ force: true });
    assert.equal(dirtyCount, 1);

    const report = analyzeRecovery(sim);
    assert.equal(report.dirtyConflicts[0].reason, 'cache_lost_without_backing');
  });

  it('优雅 detach 在存在脏块时直接拒绝', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    assert.throws(() => sim.detach(), /优雅 detach 失败/);
  });
});

describe('恢复分析器：部分回写与回写中断', () => {
  it('torn 后备块判定为脏块冲突，恢复顺序要求隔离后整块重写', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.flushBlock({ cacheBlock: 1, tornBytes: 512, interrupt: true });
    sim.failCache({ loseJournal: false });

    const report = analyzeRecovery(sim);
    assert.equal(report.dirtyConflicts.length, 1);
    const conflict = report.dirtyConflicts[0];
    assert.equal(conflict.verdict, RecoveryVerdict.CONFLICT);
    assert.equal(conflict.reason, 'torn_backing_write');
    assert.equal(conflict.tornBytes, 512);

    const step = report.recoveryOrder.find((item) => item.cacheBlock === 1);
    assert.equal(step.action, 'quarantine_then_rewrite');
    assert.equal(step.autoSafe, false);
  });

  it('回写顺序决定可恢复块的恢复序列，未列出的块按编号追加', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.write(2, 128);
    sim.write(3, 192);
    sim.failCache({ loseJournal: false });

    const report = analyzeRecovery(sim, { writebackOrder: [3, 1] });
    assert.deepEqual(
      report.recoveryOrder.filter((step) => step.autoSafe).map((step) => step.cacheBlock),
      [3, 1, 2],
    );
  });
});

describe('恢复分析器：journal 损坏', () => {
  it('脏块最新 journal 记录损坏时映射无效，其他块不受影响', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.write(2, 128);
    sim.corruptJournal(1);
    sim.failCache({ loseJournal: false });

    const report = analyzeRecovery(sim);
    assert.equal(report.invalidMappings.length, 1);
    assert.equal(report.invalidMappings[0].reason, InvalidReason.JOURNAL_CORRUPT);
    assert.equal(report.invalidMappings[0].cacheBlock, 1);
    assert.equal(report.recoverableBlocks.length, 1);
    assert.deepEqual(report.summary.corruptedJournalSeqs, [1]);
  });

  it('在线状态下整段 journal 被清空且无故障事件时，脏块按 journal_missing 判无效', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.write(2, 128);
    sim.cache.journal.wipe();

    const report = analyzeRecovery(sim);
    assert.equal(report.invalidMappings.length, 2);
    assert.ok(report.invalidMappings.every((block) =>
      block.reason === InvalidReason.JOURNAL_MISSING));
  });

  it('故障导致整段 journal 丢失时，按后备持久化情况区分安全块与冲突块', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.write(2, 128);
    sim.flushBlock({ cacheBlock: 1 });
    sim.failCache({ loseJournal: true });

    const report = analyzeRecovery(sim);
    assert.equal(report.safeBlocks[0].reason, 'cache_lost_backing_intact');
    assert.equal(report.dirtyConflicts[0].reason, 'cache_lost_without_backing');
    assert.equal(report.invalidMappings.length, 0);
  });

  it('损坏记录之后又有新有效记录时，以新记录为准仍可恢复', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.corruptJournal(1);
    sim.write(1, 64);
    sim.failCache({ loseJournal: false });

    const report = analyzeRecovery(sim);
    assert.equal(report.recoverableBlocks.length, 1);
    assert.equal(report.invalidMappings.length, 0);
  });
});

describe('恢复分析器：脏块重用', () => {
  it('重用后旧扇区映射无效，新映射可恢复', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.reuse(1, 256);
    sim.failCache({ loseJournal: false });

    const report = analyzeRecovery(sim);
    assert.equal(report.invalidMappings.length, 0);
    assert.equal(report.recoverableBlocks.length, 1);
    const block = report.recoverableBlocks[0];
    assert.equal(block.startSector, 256);
    assert.equal(block.generation, 2);
  });

  it('旧映射残留在脏块表时按 reused_dirty_block 判无效', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.reuse(1, 256);
    // 模拟脏块表与 journal 不一致：缓存元数据仍指向旧扇区。
    sim.cache.getBlock(1).startSector = 64;
    sim.failCache({ loseJournal: false });

    const report = analyzeRecovery(sim);
    assert.equal(report.invalidMappings.length, 1);
    assert.equal(report.invalidMappings[0].reason, InvalidReason.REUSED_DIRTY_BLOCK);
  });
});

describe('恢复分析器：缓存重新挂载', () => {
  it('重新挂载后脏块表与 journal 完整保留，分析结果与故障前一致', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.write(2, 128);
    sim.flushBlock({ cacheBlock: 1 });
    sim.failCache({ loseJournal: false });

    const before = analyzeRecovery(sim, { writebackOrder: [2] });
    const remount = sim.remount();
    assert.equal(remount.remounted, true);
    assert.equal(remount.restoredBlocks, 2);

    const after = analyzeRecovery(sim, { writebackOrder: [2] });
    assert.deepEqual(
      after.summary,
      before.summary,
    );
    assert.equal(after.recoverableBlocks[0].cacheBlock, 2);
  });

  it('重复挂载在线设备是幂等 noop，不改变恢复结论', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.failCache({ loseJournal: false });
    sim.remount();
    const second = sim.remount();
    assert.deepEqual(second, { remounted: false, reason: 'already_online' });

    const report = analyzeRecovery(sim);
    assert.equal(report.recoverableBlocks.length, 1);
  });

  it('journal 丢失的故障缓存重新挂载被拒绝', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.failCache({ loseJournal: true });
    const result = sim.remount();
    assert.deepEqual(result, { remounted: false, reason: 'journal_lost' });
  });
});
