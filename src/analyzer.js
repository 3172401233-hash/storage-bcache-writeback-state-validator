import {
  DirtyState,
  InvalidReason,
  PersistState,
  RecoveryVerdict,
  SECTORS_PER_BLOCK,
} from './constants.js';
import { assert, formatRange } from './util.js';

/**
 * 恢复分析器：纯函数式地交叉比对四类输入，
 * 推导缓存盘故障/detach 后每个块的可恢复性。
 *
 * 输入（全部来自模拟器的内存状态，无真实设备 IO）：
 * 1. dirty sectors   —— 缓存元数据中的脏块映射（cacheBlock -> 后备起始扇区）；
 * 2. writeback order —— 故障前计划/实际执行的回写顺序；
 * 3. journal         —— 带校验和的日志，重放时损坏记录被剔除；
 * 4. backing persist —— 后备设备上已持久化（含部分回写 torn）的块；
 * 5. cache failure / detach 事件 —— 决定缓存内容与 journal 是否仍可读。
 *
 * 输出四类互斥判定：safe / recoverable / conflict / invalid，
 * 以及按回写顺序给出的恢复序列。
 */

/**
 * @param {import('./simulator.js').BcacheWritebackSimulator} simulator
 * @param {object} [options]
 * @param {number[]} [options.writebackOrder] 期望的回写顺序（cacheBlock 列表）
 * @param {boolean} [options.cacheLost]       覆盖“缓存数据已丢失”的判断
 */
export function analyzeRecovery(simulator, options = {}) {
  const { cache, backing, timeline } = simulator;
  const writebackOrder = options.writebackOrder ?? inferWritebackOrder(timeline);
  validateWritebackOrder(writebackOrder, cache);

  const { valid, corrupted } = cache.journal.replay();
  const journalIndex = buildJournalIndex(valid);
  const failureEvent = [...timeline].reverse().find((event) =>
    event.type === 'cache_failed' || event.type === 'detach');
  const journalUnreadable = cache.journal.records.length === 0 || valid.length === 0;
  const cacheLost = options.cacheLost
    ?? (Boolean(cache.dataLost)
      || (cache.state !== 'online' && journalUnreadable));

  const safeBlocks = [];
  const recoverableBlocks = [];
  const dirtyConflicts = [];
  const invalidMappings = [];

  const cacheBlocks = [...(cache.blocks.size > 0
    ? cache.blocks.values()
    : (cache.persistedBlocks ?? [])
  )].sort((a, b) => a.cacheBlock - b.cacheBlock);

  for (const block of cacheBlocks) {
    const key = makeKey(block.cacheBlock, block.startSector);
    const persisted = backing.getPersisted(block.startSector);
    const journalEntry = journalIndex.latest.get(block.cacheBlock) ?? null;
    const base = {
      cacheBlock: block.cacheBlock,
      startSector: block.startSector,
      sectorRange: formatRange(block.startSector, SECTORS_PER_BLOCK),
      generation: block.generation,
      key,
    };

    // 1) 缓存内容已丢失（故障连带丢盘/强制 detach 后无缓存可读）。
    //    此时 journal 同样不可信，优先按后备持久化情况分类。
    if (cacheLost) {
      if (persisted && persisted.persistState === PersistState.INTACT) {
        // 后备完整块仍是安全的，但它不是缓存里那份最新脏数据。
        safeBlocks.push({
          ...base,
          verdict: RecoveryVerdict.SAFE,
          reason: 'cache_lost_backing_intact',
          backingGeneration: persisted.generation,
          detail: '缓存副本丢失，后备设备的完整旧版本可读，脏数据本身不可恢复',
        });
      } else {
        dirtyConflicts.push({
          ...base,
          verdict: RecoveryVerdict.CONFLICT,
          reason: 'cache_lost_without_backing',
          detail: '缓存故障且后备设备没有完整持久化，最新写入丢失',
        });
      }
      continue;
    }

    // 2) journal 不可信：该块最新一条记录损坏（且之后没有更新的有效记录），
    //    或没有任何有效日志。
    const latestCorrupted = [...corrupted]
      .reverse()
      .find((record) => record.payload.cacheBlock === block.cacheBlock) ?? null;
    if (latestCorrupted && (!journalEntry || latestCorrupted.seq >= journalEntry.seq)) {
      invalidMappings.push({
        ...base,
        verdict: RecoveryVerdict.INVALID,
        reason: InvalidReason.JOURNAL_CORRUPT,
        detail: `该脏块最新 journal 记录（seq=${latestCorrupted.seq}）校验和失败，映射与数据代际无法证明`,
      });
      continue;
    }
    if (!journalEntry) {
      invalidMappings.push({
        ...base,
        verdict: RecoveryVerdict.INVALID,
        reason: InvalidReason.JOURNAL_MISSING,
        detail: '脏块表有条目但 journal 无有效记录，来源不可追溯',
      });
      continue;
    }

    // 3) 脏块重用：journal 显示该缓存块已改映射，且当前脏块表仍指向旧扇区。
    if (isStaleReuse(journalIndex, block)) {
      invalidMappings.push({
        ...base,
        verdict: RecoveryVerdict.INVALID,
        reason: InvalidReason.REUSED_DIRTY_BLOCK,
        detail: `缓存块已重用到扇区 ${latestReuseTarget(journalIndex, block.cacheBlock)}，旧映射不得恢复`,
      });
      continue;
    }
    if (journalEntry.payload.startSector !== undefined
      && journalEntry.payload.startSector !== block.startSector
      && journalEntry.type !== 'dirty_reuse') {
      invalidMappings.push({
        ...base,
        verdict: RecoveryVerdict.INVALID,
        reason: InvalidReason.STALE_MAPPING,
        detail: `journal 最新映射扇区 ${journalEntry.payload.startSector} 与脏块表不一致`,
      });
      continue;
    }

    // 4) 后备设备上的部分回写：旧数据与新数据拼接，构成脏块冲突。
    if (persisted && persisted.persistState === PersistState.TORN) {
      dirtyConflicts.push({
        ...base,
        verdict: RecoveryVerdict.CONFLICT,
        reason: 'torn_backing_write',
        tornBytes: persisted.tornBytes ?? null,
        detail: '部分回写导致后备块内容混合，必须以缓存副本整块重写，禁止直接暴露后备数据',
      });
      continue;
    }

    // 5) 净块：缓存与后备一致，天然安全，不进入恢复序列。
    if (block.dirty === DirtyState.CLEAN) {
      safeBlocks.push({
        ...base,
        verdict: RecoveryVerdict.SAFE,
        reason: 'clean_block_backing_intact',
        backingGeneration: persisted?.generation ?? null,
      });
      continue;
    }

    // 6) 常规脏块：缓存副本可读且 journal 可证明，可按回写顺序恢复。
    const backingState = persisted ? persisted.persistState : 'absent';
    recoverableBlocks.push({
      ...base,
      verdict: RecoveryVerdict.RECOVERABLE,
      reason: persisted ? 'backing_superseded_by_cache' : 'backing_absent',
      backingState,
      detail: persisted
        ? '后备存在旧版本，恢复时以缓存代际更高的副本整块覆盖'
        : '后备无数据，直接把缓存脏块回写即可',
    });
  }

  const recoveryOrder = buildRecoveryOrder(
    writebackOrder,
    recoverableBlocks,
    dirtyConflicts,
    cache,
  );

  return {
    summary: {
      totalCacheBlocks: cacheBlocks.length,
      safeBlocks: safeBlocks.length,
      recoverableBlocks: recoverableBlocks.length,
      dirtyConflicts: dirtyConflicts.length,
      invalidMappings: invalidMappings.length,
      recoverableSectors: recoverableBlocks.length * SECTORS_PER_BLOCK,
      corruptedJournalSeqs: corrupted.map((record) => record.seq),
      cacheLost: Boolean(cacheLost),
      failureEvent: failureEvent ? { type: failureEvent.type, at: failureEvent.at } : null,
    },
    safeBlocks,
    recoverableBlocks,
    dirtyConflicts,
    invalidMappings,
    recoveryOrder,
  };
}

function makeKey(cacheBlock, startSector) {
  return `cb${cacheBlock}->sec${startSector}`;
}

function inferWritebackOrder(timeline) {
  const order = [];
  const seen = new Set();
  for (const event of timeline) {
    if ((event.type === 'flush_complete' || event.type === 'flush_partial')
      && !seen.has(event.cacheBlock)) {
      seen.add(event.cacheBlock);
      order.push(event.cacheBlock);
    }
  }
  return order;
}

function validateWritebackOrder(writebackOrder, cache) {
  assert(Array.isArray(writebackOrder), '回写顺序必须是 cacheBlock 数组');
  const unique = new Set(writebackOrder);
  assert(unique.size === writebackOrder.length, '回写顺序中存在重复的 cacheBlock');
  const knownBlocks = new Set([
    ...cache.blocks.keys(),
    ...(cache.persistedBlocks ?? []).map((block) => block.cacheBlock),
  ]);
  for (const cacheBlock of writebackOrder) {
    assert(knownBlocks.has(cacheBlock), `回写顺序引用了不存在的缓存块 ${cacheBlock}`);
  }
}

function buildJournalIndex(validRecords) {
  const latest = new Map();
  const reuseEvents = [];
  for (const record of validRecords) {
    const { cacheBlock } = record.payload;
    if (cacheBlock === undefined) {
      continue;
    }
    latest.set(cacheBlock, record);
    if (record.type === 'dirty_reuse') {
      reuseEvents.push(record);
    }
  }
  return { latest, reuseEvents };
}

function isStaleReuse(journalIndex, block) {
  return journalIndex.reuseEvents.some((record) =>
    record.payload.cacheBlock === block.cacheBlock
    && record.payload.oldSector === block.startSector
    && record.payload.newSector !== block.startSector);
}

function latestReuseTarget(journalIndex, cacheBlock) {
  let target = null;
  for (const record of journalIndex.reuseEvents) {
    if (record.payload.cacheBlock === cacheBlock) {
      target = record.payload.newSector;
    }
  }
  return target;
}

/**
 * 恢复顺序：
 * - 先按给定回写顺序排列可恢复块；
 * - 顺序中未列出的可恢复块按 cacheBlock 升序追加；
 * - 冲突块（torn/缓存丢失）排在最后，必须人工确认后处理，不自动回写。
 */
function buildRecoveryOrder(writebackOrder, recoverableBlocks, conflicts, cache) {
  const recoverableByBlock = new Map(
    recoverableBlocks.map((block) => [block.cacheBlock, block]),
  );
  const ordered = [];
  const placed = new Set();

  for (const cacheBlock of writebackOrder) {
    const block = recoverableByBlock.get(cacheBlock);
    if (block) {
      ordered.push({
        step: ordered.length + 1,
        cacheBlock,
        startSector: block.startSector,
        action: 'writeback_cache_copy',
        autoSafe: true,
      });
      placed.add(cacheBlock);
    }
  }

  for (const block of recoverableBlocks) {
    if (!placed.has(block.cacheBlock)) {
      ordered.push({
        step: ordered.length + 1,
        cacheBlock: block.cacheBlock,
        startSector: block.startSector,
        action: 'writeback_cache_copy',
        autoSafe: true,
      });
    }
  }

  for (const conflict of [...conflicts].sort((a, b) => a.cacheBlock - b.cacheBlock)) {
    const cacheBlock = cache.getBlock(conflict.cacheBlock);
    ordered.push({
      step: ordered.length + 1,
      cacheBlock: conflict.cacheBlock,
      startSector: conflict.startSector,
      action: cacheBlock ? 'quarantine_then_rewrite' : 'manual_intervention',
      autoSafe: false,
      reason: conflict.reason,
    });
  }

  return ordered;
}
