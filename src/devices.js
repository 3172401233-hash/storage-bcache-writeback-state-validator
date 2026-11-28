import {
  BYTES_PER_BLOCK,
  DeviceState,
  DirtyState,
  PersistState,
} from './constants.js';
import { Journal } from './journal.js';
import { assert } from './util.js';

/**
 * 模拟的 bcache 缓存设备（SSD 侧）。
 *
 * 不打开任何真实设备文件，所有状态都保存在进程内存里。
 * 缓存以“缓存块编号”为索引，每块固定 BYTES_PER_BLOCK 字节，
 * 记录它当前映射到的后备设备起始扇区、脏净状态与数据代际。
 */
export class CacheDevice {
  constructor(name = 'sim-cache0') {
    this.name = name;
    this.state = DeviceState.ONLINE;
    /** @type {Map<number, {cacheBlock:number, startSector:number, data:Buffer, dirty:string, generation:number, writtenAt:number}>} */
    this.blocks = new Map();
    this.journal = new Journal();
    /** 缓存故障时是否连带损坏 journal（模拟元数据区不可读）。 */
    this.journalLostOnFailure = false;
    this.generationCounter = 0;
    /** 故障前持久化在“缓存元数据区”的块副本，仅在 journal 存活时可用于重新挂载。 */
    this.persistedBlocks = null;
    /** 缓存数据是否已对恢复流程不可读（故障丢盘或 detach）。 */
    this.dataLost = false;
  }

  requireOnline() {
    assert(this.state === DeviceState.ONLINE, `缓存设备 ${this.name} 当前状态为 ${this.state}，无法写入`);
  }

  hasBlock(cacheBlock) {
    return this.blocks.has(cacheBlock);
  }

  getBlock(cacheBlock) {
    return this.blocks.get(cacheBlock) ?? null;
  }

  /** 缓存写命中/新写入：登记脏块并写 journal（dirty_in）。 */
  writeBlock(cacheBlock, startSector, data, timestamp = Date.now()) {
    this.requireOnline();
    assert(Buffer.isBuffer(data) && data.length === BYTES_PER_BLOCK,
      `缓存块数据必须是 ${BYTES_PER_BLOCK} 字节的 Buffer`);
    const previous = this.blocks.get(cacheBlock);
    const generation = previous ? previous.generation + 1 : 1;
    this.generationCounter = Math.max(this.generationCounter, generation);
    this.blocks.set(cacheBlock, {
      cacheBlock,
      startSector,
      data: Buffer.from(data),
      dirty: DirtyState.DIRTY,
      generation,
      writtenAt: timestamp,
    });
    this.journal.append('dirty_in', {
      cacheBlock,
      startSector,
      generation,
      previousSector: previous ? previous.startSector : null,
    });
    return generation;
  }

  /** 回写完成后清除脏标记，并写 journal（dirty_out）。 */
  markClean(cacheBlock) {
    const block = this.blocks.get(cacheBlock);
    assert(block, `缓存块 ${cacheBlock} 不存在`);
    block.dirty = DirtyState.CLEAN;
    this.journal.append('dirty_out', {
      cacheBlock,
      startSector: block.startSector,
      generation: block.generation,
    });
  }

  /**
   * 脏块重用：同一缓存块被新的后备扇区覆盖。
   * 旧映射在 journal 中以 reused 记录标注，恢复时旧键按无效映射处理。
   */
  reuseBlock(cacheBlock, newStartSector, data, timestamp = Date.now()) {
    const previous = this.blocks.get(cacheBlock);
    assert(previous, `重用要求缓存块 ${cacheBlock} 已存在`);
    assert(previous.startSector !== newStartSector,
      `缓存块 ${cacheBlock} 重用目标与现有映射相同，应使用普通写入`);
    this.journal.append('dirty_reuse', {
      cacheBlock,
      oldSector: previous.startSector,
      newSector: newStartSector,
      oldGeneration: previous.generation,
    });
    return this.writeBlock(cacheBlock, newStartSector, data, timestamp);
  }

  /** 缓存盘故障：故障后内容变为不可读，可选地连带丢失 journal。 */
  fail(loseJournal = false) {
    assert(this.state === DeviceState.ONLINE, '只有在线缓存才能发生故障事件');
    this.state = DeviceState.FAILED;
    this.journalLostOnFailure = loseJournal;
    this.dataLost = loseJournal;
    if (loseJournal) {
      this.journal.wipe();
      this.persistedBlocks = this.snapshotBlocks();
      this.blocks = new Map();
    }
  }

  detach() {
    const wasOnline = this.state === DeviceState.ONLINE;
    this.state = DeviceState.DETACHED;
    this.dataLost = true;
    if (wasOnline && this.blocks.size > 0) {
      this.persistedBlocks = this.snapshotBlocks();
      this.blocks = new Map();
    }
  }

  /**
   * 重新挂载：用持久化下来的缓存元数据重建内存视图。
   * 故障设备只有在元数据（含 journal）仍可读时才允许重新挂载。
   */
  remount(survivingBlocks) {
    assert(this.state !== DeviceState.ONLINE, '在线设备无需重新挂载');
    assert(!this.journalLostOnFailure, 'journal 已随故障丢失，缓存无法以写回模式重新挂载');
    this.state = DeviceState.ONLINE;
    this.dataLost = false;
    this.blocks = new Map();
    for (const block of survivingBlocks) {
      this.blocks.set(block.cacheBlock, { ...block, data: Buffer.from(block.data) });
    }
    this.persistedBlocks = null;
    return this;
  }

  dirtyBlocks() {
    return [...this.blocks.values()].filter((block) => block.dirty === DirtyState.DIRTY);
  }

  snapshotBlocks() {
    return [...this.blocks.values()].map((block) => ({
      ...block,
      data: Buffer.from(block.data),
    }));
  }
}

/**
 * 模拟的后备设备（HDD/底层盘侧）。
 *
 * 只记录已经从缓存回写下来的块；未回写的扇区在这里没有数据，
 * 这正是写回模式下缓存故障会丢数据的根本原因。
 */
export class BackingDevice {
  constructor(name = 'sim-backing0') {
    this.name = name;
    this.state = DeviceState.ONLINE;
    /** @type {Map<number, {startSector:number, data:Buffer, persistState:string, updatedAt:number, generation:number}>} */
    this.persisted = new Map();
  }

  /** 完整持久化一个块。 */
  persistBlock(startSector, data, timestamp = Date.now(), generation = 1) {
    assert(this.state === DeviceState.ONLINE, `后备设备 ${this.name} 不在线`);
    assert(Buffer.isBuffer(data) && data.length === BYTES_PER_BLOCK,
      `后备块数据必须是 ${BYTES_PER_BLOCK} 字节的 Buffer`);
    this.persisted.set(startSector, {
      startSector,
      data: Buffer.from(data),
      persistState: PersistState.INTACT,
      updatedAt: timestamp,
      generation,
    });
  }

  /**
   * 部分回写（torn write）：块的前 tornBytes 字节落盘，
   * 其余字节保持旧内容或为零，整体标记为 torn，恢复时不可信。
   */
  persistPartial(startSector, data, tornBytes, timestamp = Date.now(), generation = 1) {
    assert(this.state === DeviceState.ONLINE, `后备设备 ${this.name} 不在线`);
    assert(Buffer.isBuffer(data) && data.length === BYTES_PER_BLOCK,
      `后备块数据必须是 ${BYTES_PER_BLOCK} 字节的 Buffer`);
    assert(tornBytes > 0 && tornBytes < BYTES_PER_BLOCK,
      `部分回写字节数必须位于 1..${BYTES_PER_BLOCK - 1} 之间`);
    const previous = this.persisted.get(startSector);
    const merged = previous && previous.persistState === PersistState.INTACT
      ? Buffer.from(previous.data)
      : Buffer.alloc(BYTES_PER_BLOCK);
    data.copy(merged, 0, 0, tornBytes);
    this.persisted.set(startSector, {
      startSector,
      data: merged,
      persistState: PersistState.TORN,
      updatedAt: timestamp,
      generation,
      tornBytes,
    });
  }

  getPersisted(startSector) {
    return this.persisted.get(startSector) ?? null;
  }

  hasIntact(startSector) {
    const block = this.persisted.get(startSector);
    return Boolean(block) && block.persistState === PersistState.INTACT;
  }
}
