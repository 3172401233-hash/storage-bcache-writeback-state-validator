/**
 * 模拟环境使用的常量。
 *
 * 注意：这里的扇区大小只是内存模拟中用于地址换算的逻辑值，
 * 与真实内核 bcache 的 bucket/btree 实现没有任何关系。
 */

export const SECTORS_PER_BLOCK = 8;
export const BYTES_PER_SECTOR = 512;
export const BYTES_PER_BLOCK = SECTORS_PER_BLOCK * BYTES_PER_SECTOR;

/** 缓存/后备设备状态。 */
export const DeviceState = Object.freeze({
  ONLINE: 'online',
  FAILED: 'failed',
  DETACHED: 'detached',
});

/** 缓存块的脏/净状态。 */
export const DirtyState = Object.freeze({
  DIRTY: 'dirty',
  CLEAN: 'clean',
});

/** 后备块的持久化结果。 */
export const PersistState = Object.freeze({
  INTACT: 'intact',
  TORN: 'torn',
});

/** 恢复分析器对单个脏块给出的分类。 */
export const RecoveryVerdict = Object.freeze({
  SAFE: 'safe',
  RECOVERABLE: 'recoverable',
  CONFLICT: 'conflict',
  INVALID: 'invalid',
});

/** 无效映射的具体原因。 */
export const InvalidReason = Object.freeze({
  JOURNAL_CORRUPT: 'journal_corrupt',
  JOURNAL_MISSING: 'journal_missing',
  STALE_MAPPING: 'stale_mapping',
  REUSED_DIRTY_BLOCK: 'reused_dirty_block',
});
