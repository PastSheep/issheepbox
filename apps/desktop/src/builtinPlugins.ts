import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 内置插件展开策略（P-004 修复）。
 *
 * 背景（docs/TASKS.md P-004）：旧实现 copyDirIfNewer 以「userData 与 resources 两侧
 * plugin.json 的 version 一致则跳过覆盖」为幂等条件。该条件依赖人工 bump 插件版本号，
 * 存在两类失效：
 *   1. 内置插件代码变更但 plugin.json version 忘记 bump（版本恒等 → 跳过 → 升级不刷新）；
 *   2. 应用版本号本身（apps/desktop/package.json，当前 0.0.0，docs/version-policy.md
 *      记 0.1.0）依赖发布流程人工 bump，同样不可靠，不能作为幂等键。
 *
 * 现行策略（「resources 侧版本戳更新即覆盖」的运行时自举变体）：
 *   - 幂等键 = resources/builtin-plugins/<插件目录> 的「内容 sha256」，
 *     由应用在启动时自行计算，不依赖任何人记着 bump 任何版本号；
 *   - 每次展开后把 contentHash 记入 userData/plugins/.builtin-meta.json；
 *   - 下次启动：hash 不变 → 跳过（同一安装包内重复启动不碰 userData）；
 *     hash 变化 → 重拷（应用升级 / 包内置内容变化即刷新，即 P-004 修复目标）。
 *
 * 覆盖取舍（替代旧注释「避免覆盖用户本地修改」）：
 *   内置插件是第一方、随安装包分发，升级时以包内内容为准——跨包升级重拷会覆盖
 *   userData 侧同名文件；但同一包内重复启动 hash 不变即跳过，用户在当前版本下对
 *   内置插件的临时修改不会被反复重拷冲掉。二者自洽：保护的粒度是「同一安装包」，
 *   而不是「永不覆盖」。
 */

/** 单个内置插件目录上次展开时记录的信息。 */
export interface BuiltinExpansionRecord {
  /** 展开时 resources 侧 plugin.json 的 version（仅观测/调试用，不参与决策）。 */
  pluginVersion: string;
  /** 展开时 resources 侧插件目录全部文件内容的 sha256（幂等键）。 */
  contentHash: string;
}

/** userData/plugins/.builtin-meta.json 的完整结构。 */
export interface BuiltinExpansionMeta {
  /** 写入 marker 时的应用版本（app.getVersion()，仅观测用，不参与决策）。 */
  appVersion: string;
  /** 按内置插件目录名（如 shell-default）记录上次展开信息。 */
  plugins: Record<string, BuiltinExpansionRecord>;
}

/** 启动时对某个内置插件目录的展开决策。 */
export type BuiltinAction =
  | { readonly action: 'copy'; readonly reason: 'first-launch' | 'legacy-migration' | 'content-changed' }
  | { readonly action: 'skip'; readonly reason: 'already-expanded' };

export interface BuiltinDecisionInput {
  /** userData 侧插件目录中是否已存在 plugin.json（缺失 = 从未展开过）。 */
  destPluginExists: boolean;
  /** resources 侧当前目录内容 hash；读取/计算失败时为 undefined（保守按内容已变处理）。 */
  srcContentHash: string | undefined;
  /** marker 中记录的上次展开信息；legacy 安装（旧版二进制展开过但无 marker）时为 undefined。 */
  recorded: BuiltinExpansionRecord | undefined;
}

/**
 * 展开决策纯函数（无 IO，可单测）。
 *
 * 决策表：
 *   dest 无 plugin.json          → copy（first-launch：首次启动全量展开）
 *   resources hash 不可读         → copy（content-changed：保守重拷，不写 marker 记录）
 *   无上次展开记录（legacy）      → copy（legacy-migration：自举一次，补写 marker）
 *   记录 hash !== 当前 hash      → copy（content-changed：包内容已变，应用升级后刷新）
 *   记录 hash === 当前 hash      → skip（already-expanded：同一包内重复启动，保留 userData）
 */
export function resolveBuiltinAction(input: BuiltinDecisionInput): BuiltinAction {
  if (!input.destPluginExists) {
    return { action: 'copy', reason: 'first-launch' };
  }
  if (!input.srcContentHash) {
    return { action: 'copy', reason: 'content-changed' };
  }
  if (!input.recorded) {
    return { action: 'copy', reason: 'legacy-migration' };
  }
  if (input.recorded.contentHash !== input.srcContentHash) {
    return { action: 'copy', reason: 'content-changed' };
  }
  return { action: 'skip', reason: 'already-expanded' };
}

/**
 * 计算目录全部文件内容的 sha256（确定性：按相对 POSIX 路径排序拼接）。
 * 读取失败时返回 undefined，由决策层保守处理（见 resolveBuiltinAction）。
 */
export function hashDirectoryContent(rootDir: string): string | undefined {
  try {
    const hasher = crypto.createHash('sha256');
    const walk = (dir: string, relPrefix: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort();
      const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
      for (const name of files) {
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        // 路径名参与哈希：重命名/移动文件也能被检出。
        hasher.update(`${rel}\0`);
        hasher.update(fs.readFileSync(path.join(dir, name)));
        hasher.update('\0');
      }
      for (const name of subdirs) {
        walk(path.join(dir, name), relPrefix ? `${relPrefix}/${name}` : name);
      }
    };
    walk(rootDir, '');
    return hasher.digest('hex');
  } catch {
    return undefined;
  }
}

/** 容忍读取 plugin.json 的 version（缺失/损坏时返回 'unknown'，仅观测用）。 */
export function readPluginVersion(pluginJsonPath: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 读取展开 marker；文件缺失/损坏时返回 undefined（按 legacy 首次处理）。 */
export function readExpansionMeta(metaPath: string): BuiltinExpansionMeta | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Partial<BuiltinExpansionMeta>;
    if (typeof parsed.appVersion !== 'string' || typeof parsed.plugins !== 'object' || !parsed.plugins) {
      return undefined;
    }
    return { appVersion: parsed.appVersion, plugins: parsed.plugins as Record<string, BuiltinExpansionRecord> };
  } catch {
    return undefined;
  }
}

/** 原子性较差的直接写盘：marker 只是观测/幂等记录，写坏了下次启动按 legacy 自举重拷。 */
export function writeExpansionMeta(metaPath: string, meta: BuiltinExpansionMeta): void {
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}
