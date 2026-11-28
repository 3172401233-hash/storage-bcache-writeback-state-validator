# storage-bcache-writeback-state-validator

验证 bcache **写回（writeback）模式**下缓存设备脏块、回写顺序与缓存盘故障后的一致性，
计算可恢复块、脏块冲突、无效映射与安全恢复顺序。

## 重要前提：所有设备均为模拟

本项目是一个**纯内存的教学/验证模型**，不是内核 bcache 的管理工具：

- 不会打开、读取或写入 `/dev` 下的任何块设备；
- 不会调用 `mount`、`bcache-super-show`、`make-bcache` 等系统命令；
- 缓存设备、后备设备、journal、扇区与块全部是 Node.js 进程内的普通对象（`Map` 与 `Buffer`）；
- 校验和是教学用的非加密哈希（见 `src/util.js`），不代表内核真实的 crc32c/journal 布局；
- 扇区/块尺寸（`src/constants.js`）只用于地址换算演示，与真实 bcache bucket/btree 无关。

进程退出后所有“设备”状态即消失，不会对宿主系统产生任何持久化影响。

## 模拟的问题模型

写回模式下写入先落在缓存盘并标记为脏，稍后才回写到后备设备。若回写只完成一部分、
journal 损坏或缓存盘直接故障，就会出现元数据与实际数据不一致。模拟器把问题抽象为五类输入：

| 输入 | 模拟位置 | 含义 |
| --- | --- | --- |
| dirty sector（脏块） | `CacheDevice.blocks` | 缓存块到后备起始扇区的映射、脏净标记、数据代际 |
| 回写顺序 | `analyzeRecovery(..., { writebackOrder })` | 故障前计划/实际的缓存块回写次序 |
| journal | `Journal` | 只追加、带序号与校验和的 `dirty_in/dirty_out/flush_begin/flush_end/dirty_reuse` 记录 |
| 后备设备持久化 | `BackingDevice.persisted` | 完整落盘（intact）或部分回写（torn）的块 |
| 缓存故障 / detach 事件 | `BcacheWritebackSimulator` | `failCache`、`detach`、`remount` 等事件流水 |

## 判定输出

分析器（`src/analyzer.js`）交叉比对上述输入，给出四类互斥结论：

- `safe`：净块且后备完整，或缓存丢失但后备存在完整旧版本；
- `recoverable`：缓存副本与 journal 均可证明，可按回写顺序自动回写；
- `conflict`（脏块冲突）：后备存在 torn 部分回写，或缓存丢失且后备无完整数据；
- `invalid`（无效映射）：journal 损坏/缺失、陈旧映射、脏块被重用后的旧映射。

同时输出 `recoveryOrder`：自动可执行的回写步骤在前，需要人工确认的隔离/重写步骤在后。

## 目录结构

```
src/
  constants.js   模拟常量与枚举（扇区/块大小、设备状态、判定类别）
  util.js        教学用校验和与断言工具
  journal.js     追加式 journal，支持注入损坏与重放校验
  devices.js     CacheDevice（缓存盘）与 BackingDevice（后备设备）内存模型
  simulator.js   事件驱动模拟器：写入/重用/回写/部分回写/故障/detach/重新挂载
  analyzer.js    恢复分析器：安全块、可恢复块、冲突、无效映射、恢复顺序
  scenario.js    声明式 JSON 事件场景运行器
  demo.js        命令行演示（npm run demo）
test/            node:test 测试套件
```

## 运行环境与命令

- Node.js `24.16.0`（要求 `>=24`，零第三方依赖，使用内置 `node:test`）

```bash
node --test      # 执行全部测试（等价于 npm test）
npm run demo     # 运行三个内置场景并打印恢复报告
```

## 测试覆盖

`node --test` 覆盖题目要求的全部场景：

- 缓存盘故障：journal 存活可恢复、journal 连带丢失时按后备持久化分类；
- 回写中断与部分回写：torn 块识别为脏块冲突并要求隔离后整块重写；
- journal 损坏与整段丢失：校验和失败的映射判无效，后续新有效记录可恢复可信度；
- 脏块重用：旧扇区映射作废、新映射按新代际恢复；
- detach：优雅 detach 拒绝带脏块卸载，强制 detach 的未回写块进入冲突列表；
- 重复挂载：重新挂载后分析结论保持稳定，在线设备重复挂载为幂等 noop。

## 编程式用法

```js
import { runScenario } from './src/scenario.js';

const { lastReport } = runScenario([
  { type: 'write', cacheBlock: 1, startSector: 64 },
  { type: 'flush_partial', cacheBlock: 1, tornBytes: 512, interrupt: true },
  { type: 'cache_failed', loseJournal: false },
  { type: 'analyze', writebackOrder: [1] },
]);

console.log(lastReport.summary);       // 计数汇总
console.log(lastReport.dirtyConflicts); // 脏块冲突明细
console.log(lastReport.recoveryOrder);  // 恢复顺序
```

再次强调：以上全部操作只发生在进程内存中，**不涉及任何真实设备**。
