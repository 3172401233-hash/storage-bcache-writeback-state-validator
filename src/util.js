/**
 * 极简校验和，用于模拟 journal 记录的 CRC。
 * 不是加密哈希，也不对应内核里的真实 crc32c，仅用于模拟“记录损坏可被检出”。
 */
export function fakeChecksum(value) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 键顺序稳定的 JSON 序列化，保证同一逻辑记录每次得到相同校验和。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',');
  return `{${body}}`;
}

/** 把“起始扇区 + 长度（扇区）”转成可读区间。 */
export function formatRange(startSector, sectorCount) {
  return `sectors[${startSector}..${startSector + sectorCount - 1}]`;
}

/** 断言条件成立，否则抛出带上下文的错误。 */
export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
