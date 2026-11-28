import { BackingDevice, CacheDevice } from './devices.js';
import { BYTES_PER_BLOCK, DeviceState, PersistState } from './constants.js';
import { assert } from './util.js';

/**
 * 事件驱动的 bcache 写回模式模拟器。
 *
 * 所有“设备”都是普通内存对象：
 * - cache 模拟 SSD 缓存，保存脏块与 journal；
 * - backing 模拟后备块设备，只保存已经回写完成（或部分落盘）的数据。
 *
 * 该类负责产生事件序列，真正的一致性判定在 analyzeRecovery 中完成，
 * 以便对同一组状态做可重复的恢复分析（例如重复挂载后的再次分析）。
 */
export class BcacheWritebackSimulator {
  constructor(options = {}) {
    this.cache = options.cache ?? new CacheDevice(options.cacheName);
    this.backing = options.backing ?? new BackingDevice(options.backingName);
    /** 已发生的事件流水，供测试与报告引用。 */
    this.timeline = [];
    this.clock = 0;
  }

  tick() {
    this.clock += 1;
    return this.clock;
  }

  record(event) {
    const entry = { at: this.tick(), ...event };
    this.timeline.push(entry);
    return entry;
  }

  /** 构造一块可识别的模拟数据：前缀 + 扇区号 + 填充。 */
  static makeBlockData(pattern, startSector, generation = 1) {
    const data = Buffer.alloc(BYTES_PER_BLOCK);
    const prefix = Buffer.from(`gen${generation}:${pattern}:sec${startSector}:`);
    prefix.copy(data, 0);
    for (let offset = prefix.length; offset < data.length; offset += 1) {
      data[offset] = (offset + startSector + generation) & 0xff;
    }
    return data;
  }

  /** 向缓存写入一个块（写回模式：写入只到缓存，后备设备不更新）。 */
  write(cacheBlock, startSector, data) {
    const payload = data ?? BcacheWritebackSimulator.makeBlockData('w', startSector);
    const generation = this.cache.writeBlock(cacheBlock, startSector, payload, this.tick());
    this.record({ type: 'write', cacheBlock, startSector, generation });
    return generation;
  }

  /** 脏块重用：同一缓存块改映射到新的后备扇区。 */
  reuse(cacheBlock, newStartSector, data) {
    const previous = this.cache.getBlock(cacheBlock);
    const payload = data ?? BcacheWritebackSimulator.makeBlockData('reuse', newStartSector);
    const generation = this.cache.reuseBlock(cacheBlock, newStartSector, payload, this.tick());
    this.record({
      type: 'reuse',
      cacheBlock,
      oldSector: previous.startSector,
      newSector: newStartSector,
      generation,
    });
    return generation;
  }

  /**
   * 回写一个脏块。
   *
   * @param {object} options
   * @param {number} options.cacheBlock     要回写的缓存块
   * @param {number} [options.tornBytes]    给定后模拟部分回写：仅此前缀字节落盘
   * @param {boolean} [options.interrupt]   回写中断（等价于 torn + 缓存保持脏）
   */
  flushBlock({ cacheBlock, tornBytes, interrupt = false }) {
    const block = this.cache.getBlock(cacheBlock);
    assert(block, `缓存块 ${cacheBlock} 不存在，无法回写`);
    assert(block.dirty === 'dirty', `缓存块 ${cacheBlock} 不是脏块，无需回写`);
    const timestamp = this.tick();
    this.cache.journal.append('flush_begin', {
      cacheBlock,
      startSector: block.startSector,
      generation: block.generation,
      partial: Boolean(tornBytes || interrupt),
    });

    if (tornBytes && tornBytes > 0) {
      this.backing.persistPartial(block.startSector, block.data, tornBytes, timestamp, block.generation);
      this.record({
        type: 'flush_partial',
        cacheBlock,
        startSector: block.startSector,
        tornBytes,
        generation: block.generation,
      });
      if (interrupt) {
        this.record({
          type: 'flush_interrupted',
          cacheBlock,
          startSector: block.startSector,
          generation: block.generation,
        });
      }
      // 部分回写不能清除脏标记，也不会产生 flush_end/dirty_out。
      return { completed: false, torn: true, startSector: block.startSector };
    }

    this.backing.persistBlock(block.startSector, block.data, timestamp, block.generation);
    this.cache.journal.append('flush_end', {
      cacheBlock,
      startSector: block.startSector,
      generation: block.generation,
    });
    this.cache.markClean(cacheBlock);
    this.record({
      type: 'flush_complete',
      cacheBlock,
      startSector: block.startSector,
      generation: block.generation,
    });
    return { completed: true, torn: false, startSector: block.startSector };
  }

  /** 按给定顺序批量回写；任意一块可声明部分回写或中断。 */
  flushMany(plan) {
    const results = [];
    for (const item of plan) {
      results.push(this.flushBlock(item));
    }
    return results;
  }

  /** 损坏指定 journal 序号的记录（模拟 journal 区域坏块）。 */
  corruptJournal(seq) {
    this.cache.journal.corruptRecord(seq);
    this.record({ type: 'journal_corrupt', seq });
  }

  /** 缓存盘故障。loseJournal=true 时 journal 一并不可读，缓存数据全部丢失。 */
  failCache({ loseJournal = false } = {}) {
    this.cache.fail(loseJournal);
    this.record({ type: 'cache_failed', loseJournal });
  }

  /**
   * detach 事件。
   * - 优雅 detach：所有脏块必须已回写，否则报错；
   * - 强制 detach：允许带脏块卸载，未回写内容在后备设备上不可用。
   */
  detach({ force = false } = {}) {
    const dirtyCount = this.cache.dirtyBlocks().length;
    if (!force && dirtyCount > 0) {
      throw new Error(`优雅 detach 失败：仍有 ${dirtyCount} 个脏块未回写`);
    }
    this.cache.detach();
    this.record({ type: 'detach', force, dirtyCount });
    return dirtyCount;
  }

  /**
   * 缓存重新挂载。
   * 只有缓存元数据（脏块表 + journal）在故障中存活才能成功；
   * 重复挂载同一在线设备会原样返回，保证幂等。
   */
  remount() {
    if (this.cache.state === DeviceState.ONLINE) {
      this.record({ type: 'remount', noop: true });
      return { remounted: false, reason: 'already_online' };
    }
    if (this.cache.journalLostOnFailure) {
      this.record({ type: 'remount_rejected', reason: 'journal_lost' });
      return { remounted: false, reason: 'journal_lost' };
    }
    const surviving = this.cache.snapshotBlocks();
    this.cache.remount(surviving);
    this.record({ type: 'remount', restoredBlocks: surviving.length });
    return { remounted: true, restoredBlocks: surviving.length };
  }

  /** 供测试使用的状态快照。 */
  snapshot() {
    return {
      cacheState: this.cache.state,
      dirtyBlocks: this.cache.dirtyBlocks().map((block) => ({
        cacheBlock: block.cacheBlock,
        startSector: block.startSector,
        generation: block.generation,
      })),
      persistedSectors: [...this.backing.persisted.keys()].sort((a, b) => a - b),
      tornSectors: [...this.backing.persisted.values()]
        .filter((block) => block.persistState === PersistState.TORN)
        .map((block) => block.startSector)
        .sort((a, b) => a - b),
      journalSeqs: this.cache.journal.records.map((record) => record.seq),
    };
  }
}
