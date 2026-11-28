import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CacheDevice, BackingDevice } from '../src/devices.js';
import { BYTES_PER_BLOCK, DeviceState, DirtyState, PersistState } from '../src/constants.js';
import { BcacheWritebackSimulator } from '../src/simulator.js';

describe('缓存设备', () => {
  it('写入后块为脏且生成 dirty_in 日志，数据长度按模拟块大小对齐', () => {
    const cache = new CacheDevice();
    const data = Buffer.alloc(BYTES_PER_BLOCK);
    cache.writeBlock(1, 64, data);

    const block = cache.getBlock(1);
    assert.equal(block.dirty, DirtyState.DIRTY);
    assert.equal(block.startSector, 64);
    assert.equal(block.generation, 1);
    assert.equal(cache.journal.records[0].type, 'dirty_in');
    assert.deepEqual(cache.dirtyBlocks().map((item) => item.cacheBlock), [1]);
  });

  it('故障设备拒绝继续写入，remount 可在 journal 存活时恢复脏块视图', () => {
    const cache = new CacheDevice();
    cache.writeBlock(1, 64, Buffer.alloc(BYTES_PER_BLOCK));
    cache.fail(false);
    assert.equal(cache.state, DeviceState.FAILED);
    assert.throws(() => cache.writeBlock(2, 128, Buffer.alloc(BYTES_PER_BLOCK)),
      /无法写入/);

    const snapshot = cache.snapshotBlocks();
    cache.remount(snapshot);
    assert.equal(cache.state, DeviceState.ONLINE);
    assert.equal(cache.getBlock(1).dirty, DirtyState.DIRTY);
  });

  it('journal 随故障丢失时禁止重新挂载为写回缓存', () => {
    const cache = new CacheDevice();
    cache.writeBlock(1, 64, Buffer.alloc(BYTES_PER_BLOCK));
    cache.fail(true);
    assert.throws(() => cache.remount(cache.snapshotBlocks()), /journal 已随故障丢失/);
  });

  it('reuseBlock 记录 dirty_reuse 并提升数据代际', () => {
    const cache = new CacheDevice();
    cache.writeBlock(1, 64, Buffer.alloc(BYTES_PER_BLOCK));
    cache.reuseBlock(1, 256, Buffer.alloc(BYTES_PER_BLOCK));
    const block = cache.getBlock(1);
    assert.equal(block.startSector, 256);
    assert.equal(block.generation, 2);
    assert.equal(cache.journal.records.some((record) => record.type === 'dirty_reuse'), true);
  });
});

describe('后备设备', () => {
  it('完整持久化标记 intact，部分回写标记 torn 并保留旧内容前缀', () => {
    const backing = new BackingDevice();
    const oldData = Buffer.alloc(BYTES_PER_BLOCK, 0xab);
    backing.persistBlock(64, oldData);
    assert.equal(backing.hasIntact(64), true);

    const newData = Buffer.alloc(BYTES_PER_BLOCK, 0x11);
    backing.persistPartial(64, newData, 512);
    const torn = backing.getPersisted(64);
    assert.equal(torn.persistState, PersistState.TORN);
    assert.equal(torn.tornBytes, 512);
    assert.equal(torn.data[0], 0x11);
    assert.equal(torn.data[1024], 0xab);
    assert.equal(backing.hasIntact(64), false);
  });

  it('部分回写参数越界时抛出错误', () => {
    const backing = new BackingDevice();
    assert.throws(() => backing.persistPartial(64, Buffer.alloc(BYTES_PER_BLOCK), 0),
      /部分回写字节数/);
  });
});

describe('模拟器事件流水', () => {
  it('写回模式下普通写入不会触碰后备设备', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    assert.equal(sim.backing.getPersisted(64), null);
    assert.equal(sim.snapshot().dirtyBlocks.length, 1);
  });

  it('完整回写后缓存转净、后备 intact，部分回写保持脏且后备 torn', () => {
    const sim = new BcacheWritebackSimulator();
    sim.write(1, 64);
    sim.write(2, 128);
    sim.flushBlock({ cacheBlock: 1 });
    sim.flushBlock({ cacheBlock: 2, tornBytes: 256, interrupt: true });

    assert.equal(sim.cache.getBlock(1).dirty, DirtyState.CLEAN);
    assert.equal(sim.backing.hasIntact(64), true);
    assert.equal(sim.cache.getBlock(2).dirty, DirtyState.DIRTY);
    assert.equal(sim.backing.getPersisted(128).persistState, PersistState.TORN);
    const types = sim.timeline.map((event) => event.type);
    assert.ok(types.includes('flush_interrupted'));
  });
});
