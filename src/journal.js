import { fakeChecksum } from './util.js';
import { assert } from './util.js';

/**
 * 模拟 bcache journal。
 *
 * 真实 bcache 的 journal 是日志结构设备上的环形区域，这里简化为：
 * - 只追加、带序号与校验和的内存记录数组；
 * - 记录类型仅保留与脏块一致性相关的四种：
 *   dirty_in（脏块登记）、dirty_out（脏块清除）、
 *   flush_begin（回写开始）、flush_end（回写完成）；
 * - 支持把某条记录标记为“损坏”，重放时校验和不匹配即跳过。
 */
export class Journal {
  constructor() {
    /** @type {Array<{seq:number, type:string, payload:object, checksum:string, corrupt:boolean}>} */
    this.records = [];
    this.nextSeq = 1;
    /** 被显式损坏且在重放中检出的记录序号。 */
    this.corruptedSeqs = new Set();
  }

  append(type, payload) {
    assert(type && typeof type === 'string', 'journal 记录必须包含类型');
    assert(payload && typeof payload === 'object', 'journal 记录必须包含 payload');
    const record = {
      seq: this.nextSeq,
      type,
      payload: { ...payload },
      checksum: '',
      corrupt: false,
    };
    record.checksum = fakeChecksum({ seq: record.seq, type, payload: record.payload });
    this.records.push(record);
    this.nextSeq += 1;
    return record.seq;
  }

  /**
   * 模拟 journal 区域损坏：翻转 payload 字段并保留旧校验和，
   * 重放时 checksum 对不上即可识别为损坏记录。
   */
  corruptRecord(seq) {
    const record = this.records.find((item) => item.seq === seq);
    assert(record, `journal 中不存在序号 ${seq} 的记录`);
    record.corrupt = true;
    record.payload = { ...record.payload, _bitRot: `${record.checksum}:${seq}` };
    this.corruptedSeqs.add(seq);
    return seq;
  }

  /** 模拟整段 journal 丢失（缓存盘元数据区被覆盖/无法读取）。 */
  wipe() {
    this.records = [];
    this.nextSeq = 1;
  }

  isValid(record) {
    if (record.corrupt) {
      return false;
    }
    const expected = fakeChecksum({ seq: record.seq, type: record.type, payload: record.payload });
    return expected === record.checksum;
  }

  /**
   * 按序号顺序重放 journal。
   * 返回有效记录与损坏记录两个列表，损坏记录不参与状态推导。
   */
  replay() {
    const valid = [];
    const corrupted = [];
    for (const record of this.records) {
      if (this.isValid(record)) {
        valid.push(record);
      } else {
        corrupted.push(record);
      }
    }
    return { valid, corrupted };
  }

  /** 查找某个缓存块最后一条有效记录（用于判断重用过的脏块）。 */
  latestValidFor(cacheBlock) {
    let found = null;
    for (const record of this.records) {
      if (this.isValid(record) && record.payload.cacheBlock === cacheBlock) {
        found = record;
      }
    }
    return found;
  }
}
