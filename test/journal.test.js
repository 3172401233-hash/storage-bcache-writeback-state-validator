import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Journal } from '../src/journal.js';

describe('模拟 journal', () => {
  it('追加记录带递增序号与校验和，重放顺序稳定', () => {
    const journal = new Journal();
    const seq1 = journal.append('dirty_in', { cacheBlock: 1, startSector: 64 });
    const seq2 = journal.append('flush_end', { cacheBlock: 1, startSector: 64 });
    assert.equal(seq1, 1);
    assert.equal(seq2, 2);

    const { valid, corrupted } = journal.replay();
    assert.equal(valid.length, 2);
    assert.equal(corrupted.length, 0);
    assert.deepEqual(valid.map((record) => record.seq), [1, 2]);
  });

  it('损坏记录在重放时被识别并剔除', () => {
    const journal = new Journal();
    journal.append('dirty_in', { cacheBlock: 1, startSector: 64 });
    journal.append('dirty_in', { cacheBlock: 2, startSector: 128 });
    journal.corruptRecord(1);

    const { valid, corrupted } = journal.replay();
    assert.equal(valid.length, 1);
    assert.equal(valid[0].seq, 2);
    assert.deepEqual(corrupted.map((record) => record.seq), [1]);
    assert.deepEqual([...journal.corruptedSeqs], [1]);
  });

  it('wipe 后日志为空且序号重置，模拟元数据区不可读', () => {
    const journal = new Journal();
    journal.append('dirty_in', { cacheBlock: 1, startSector: 64 });
    journal.wipe();
    assert.deepEqual(journal.replay().valid, []);
    assert.equal(journal.append('dirty_in', { cacheBlock: 9, startSector: 8 }), 1);
  });

  it('latestValidFor 只返回校验通过的最新记录', () => {
    const journal = new Journal();
    journal.append('dirty_in', { cacheBlock: 1, startSector: 64, generation: 1 });
    journal.append('dirty_in', { cacheBlock: 1, startSector: 64, generation: 2 });
    journal.corruptRecord(2);
    const latest = journal.latestValidFor(1);
    assert.equal(latest.payload.generation, 1);
  });
});
