/**
 * 版本对比工具（纯函数，无外部依赖）。
 *
 * 只处理 registry/manifest 使用的严格 SemVer（MAJOR.MINOR.PATCH，
 * 可选 -prerelease 与 +build 元数据），对齐 docs/plugin-spec-v1.md 第 3.2 节。
 * 解析失败返回 NaN，调用方应先做合法性校验（见 src/parse.ts）。
 */

/** 解析严格 SemVer；非法返回 null。 */
export function parseSemver(input: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
} | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    input.trim(),
  );
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/**
 * 比较两个严格 SemVer：
 *   - a < b  → 负数
 *   - a == b → 0
 *   - a > b  → 正数
 *   - 任一非法 → NaN（不抛异常）
 *
 * 优先级按 SemVer 规范：先比较主次补丁号；相等时，
 * 带预发布号 < 正式版，预发布号按点分段逐段比较。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return NaN;

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  // 主次补丁相同：预发布号比较
  const preA = pa.prerelease;
  const preB = pb.prerelease;
  if (preA === null && preB === null) return 0;
  // 正式版（无预发布）大于任何带预发布的版本
  if (preA === null) return 1;
  if (preB === null) return -1;

  const partsA = preA.split('.');
  const partsB = preB.split('.');
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const x = partsA[i];
    const y = partsB[i];
    if (x === undefined) return -1; // 段多者大
    if (y === undefined) return 1;
    // 数字段按数值比较；字母段按字典序；数字 < 字母
    const numX = /^\d+$/.test(x);
    const numY = /^\d+$/.test(y);
    if (numX && numY) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (numX !== numY) {
      return numX ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
