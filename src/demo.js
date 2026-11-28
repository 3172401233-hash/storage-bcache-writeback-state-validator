#!/usr/bin/env node

import { runScenario } from './scenario.js';
import { RecoveryVerdict } from './constants.js';

/**
 * 演示入口：所有设备均为进程内内存模拟，不打开 /dev 下的任何设备，
 * 也不调用 mount/bcache-super-show 等系统命令。
 */

const scenarios = [
  {
    name: '场景一：缓存盘故障（journal 存活）',
    events: [
      { type: 'write', cacheBlock: 1, startSector: 64 },
      { type: 'write', cacheBlock: 2, startSector: 128 },
      { type: 'flush', cacheBlock: 1 },
      { type: 'cache_failed', loseJournal: false },
      { type: 'analyze', writebackOrder: [2] },
    ],
  },
  {
    name: '场景二：部分回写中断 + journal 损坏',
    events: [
      { type: 'write', cacheBlock: 1, startSector: 64 },
      { type: 'write', cacheBlock: 2, startSector: 128 },
      { type: 'flush_partial', cacheBlock: 1, tornBytes: 512, interrupt: true },
      { type: 'journal_corrupt', seq: 2 },
      { type: 'cache_failed', loseJournal: false },
      { type: 'analyze', writebackOrder: [1, 2] },
    ],
  },
  {
    name: '场景三：脏块重用与缓存重复挂载',
    events: [
      { type: 'write', cacheBlock: 1, startSector: 64 },
      { type: 'reuse', cacheBlock: 1, newStartSector: 256 },
      { type: 'write', cacheBlock: 3, startSector: 320 },
      { type: 'cache_failed', loseJournal: false },
      { type: 'remount' },
      { type: 'remount' },
      { type: 'analyze', writebackOrder: [1, 3] },
    ],
  },
];

function printReport(name, result) {
  const report = result.lastReport;
  console.log('='.repeat(72));
  console.log(name);
  console.log('-'.repeat(72));
  console.log('汇总:', JSON.stringify(report.summary));
  for (const block of report.safeBlocks) {
    console.log(`  [安全块]   cb${block.cacheBlock} ${block.sectorRange} (${block.reason})`);
  }
  for (const block of report.recoverableBlocks) {
    console.log(`  [可恢复]   cb${block.cacheBlock} ${block.sectorRange} gen${block.generation} (${block.reason})`);
  }
  for (const block of report.dirtyConflicts) {
    console.log(`  [脏块冲突] cb${block.cacheBlock} ${block.sectorRange} (${block.reason}) ${block.detail}`);
  }
  for (const block of report.invalidMappings) {
    console.log(`  [无效映射] cb${block.cacheBlock} ${block.sectorRange} (${block.reason}) ${block.detail}`);
  }
  console.log('恢复顺序:');
  for (const step of report.recoveryOrder) {
    const flag = step.autoSafe ? '自动可执行' : '需人工确认';
    console.log(`  ${String(step.step).padStart(2)}. cb${step.cacheBlock} -> sector ${step.startSector} [${step.action}] ${flag}`);
  }
  console.log('');
}

console.log('bcache 写回模式恢复验证器（纯内存模拟，不访问任何真实设备）');
console.log(`判定类别: ${Object.values(RecoveryVerdict).join(' / ')}`);
console.log('');

for (const scenario of scenarios) {
  const result = runScenario(scenario.events);
  printReport(scenario.name, result);
}

console.log('提示: 运行 `node --test` 执行完整测试套件。');
