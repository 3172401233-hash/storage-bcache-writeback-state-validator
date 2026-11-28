import { BcacheWritebackSimulator } from './simulator.js';
import { assert } from './util.js';
import { analyzeRecovery } from './analyzer.js';

/**
 * 声明式场景运行器：把一组纯数据事件喂给模拟器，
 * 便于用 JSON 描述测试场景，也便于证明“全程无真实设备访问”。
 *
 * 支持的事件：
 * - { type:'write', cacheBlock, startSector }
 * - { type:'reuse', cacheBlock, newStartSector }
 * - { type:'flush', cacheBlock }
 * - { type:'flush_partial', cacheBlock, tornBytes, interrupt? }
 * - { type:'journal_corrupt', seq }
 * - { type:'journal_wipe' }
 * - { type:'cache_failed', loseJournal? }
 * - { type:'detach', force? }
 * - { type:'remount' }
 * - { type:'analyze', writebackOrder? }   可多次出现，模拟重复挂载后再次分析
 */
export function runScenario(events, options = {}) {
  const sim = new BcacheWritebackSimulator(options);
  const reports = [];

  events.forEach((event, index) => {
    assert(event && typeof event.type === 'string', `第 ${index} 个事件缺少 type`);
    switch (event.type) {
      case 'write':
        sim.write(event.cacheBlock, event.startSector);
        break;
      case 'reuse':
        sim.reuse(event.cacheBlock, event.newStartSector);
        break;
      case 'flush':
        sim.flushBlock({ cacheBlock: event.cacheBlock });
        break;
      case 'flush_partial':
        sim.flushBlock({
          cacheBlock: event.cacheBlock,
          tornBytes: event.tornBytes,
          interrupt: Boolean(event.interrupt),
        });
        break;
      case 'journal_corrupt':
        sim.corruptJournal(event.seq);
        break;
      case 'journal_wipe':
        sim.cache.journal.wipe();
        sim.record({ type: 'journal_wipe' });
        break;
      case 'cache_failed':
        sim.failCache({ loseJournal: Boolean(event.loseJournal) });
        break;
      case 'detach':
        sim.detach({ force: Boolean(event.force) });
        break;
      case 'remount':
        sim.remount();
        break;
      case 'analyze':
        reports.push(analyzeRecovery(sim, { writebackOrder: event.writebackOrder }));
        break;
      default:
        throw new Error(`未知场景事件类型: ${event.type}`);
    }
  });

  return {
    simulator: sim,
    snapshot: sim.snapshot(),
    timeline: sim.timeline,
    reports,
    lastReport: reports.length > 0 ? reports[reports.length - 1] : analyzeRecovery(sim),
  };
}
