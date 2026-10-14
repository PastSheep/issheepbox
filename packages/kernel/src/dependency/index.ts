/**
 * 依赖解析（P-005，闭环 TASK-002 占位 / 规范反馈 F-004）。
 *
 * 职责（对齐 docs/plugin-spec-v1.md §3.2 `requires` 与 §10 校验清单 #7/#8）：
 *  - 读取 manifest.requires：键 = 依赖插件 ID（或内核内置提供项），值 = SemVer range
 *  - #7 校验：依赖已安装（在给定插件集合或内核 provided 目录内）且版本满足 range
 *  - #8 校验：依赖图无环；有环则拒绝环上全部插件
 *  - 输出拓扑排序后的加载顺序（依赖在前，被依赖者在后）
 *
 * 失败隔离（与 TASK-002 loader / TASK-003 mount 语义一致）：
 *  - 单个插件缺失依赖 / 版本不满足 / 卷入环 → 仅该插件进 failures，不影响其余插件
 *  - 传播规则：被拒绝插件的依赖者随之按「缺少依赖」拒绝；与失败插件无关的插件照常进入 ordered
 *
 * 不做的事：
 *  - 不调用插件工厂、不 mount（生命周期归 LifecycleManager）
 *  - 不校验 manifest 本身（归 parseManifest / loader）
 */
import semver from 'semver';
import type { LoadedPlugin } from '../loader';

/** 一个被依赖解析拒绝的插件。 */
export interface DependencyFailure {
  /** 插件 ID（manifest.id）。 */
  pluginId: string;
  /** 插件包根目录（便于宿主定位）。 */
  dir: string;
  /** 可读错误列表。 */
  errors: string[];
}

/** 依赖解析结果。 */
export interface ResolutionResult {
  /** 拓扑排序后的插件列表：依赖在前、被依赖者在后；互不依赖者保持输入顺序。 */
  ordered: LoadedPlugin[];
  /** 因 requires 校验失败 / 循环依赖被拒绝的插件。 */
  failures: DependencyFailure[];
}

/** resolveOrder 选项。 */
export interface ResolveOptions {
  /**
   * 内核内置提供项目录（id → 具体版本），供 requires 引用 `service:*` 等内置依赖。
   * 默认空：requires 中出现的未知键一律按「缺少依赖」拒绝（fail-safe）。
   */
  provided?: ReadonlyMap<string, string>;
}

export class DependencyResolver {
  /**
   * 解析一组已加载插件的依赖关系。
   *
   * @param plugins loader.loadAll 产出的已加载插件（尚未做 requires 校验）
   * @param options provided 内置提供项目录
   */
  resolveOrder(
    plugins: readonly LoadedPlugin[],
    options: ResolveOptions = {},
  ): ResolutionResult {
    const provided = options.provided ?? new Map<string, string>();

    // alive：尚未被拒绝的插件（按输入顺序保留，保证结果确定性）。
    let alive: LoadedPlugin[] = [...plugins];
    const failures: DependencyFailure[] = [];

    /** 查某个依赖 ID 的具体版本：先在存活插件集合内找，再查内核 provided 目录。 */
    const versionOf = (id: string): string | undefined => {
      for (const p of alive) {
        if (p.manifest.id === id) return p.manifest.version;
      }
      return provided.get(id);
    };

    /**
     #7 单插件 requires 校验：返回错误列表（空 = 通过）。
     覆盖：range 非法 / 依赖缺失 / 版本不满足。
     */
    const validateRequires = (plugin: LoadedPlugin): string[] => {
      const errors: string[] = [];
      const requires = plugin.manifest.requires ?? {};
      const pluginId = plugin.manifest.id;
      for (const [depId, range] of Object.entries(requires)) {
        if (typeof range !== 'string' || range.trim() === '') {
          errors.push(
            `${pluginId}: requires["${depId}"] 不是合法的 SemVer 范围字符串`,
          );
          continue;
        }
        if (!semver.validRange(range)) {
          errors.push(
            `${pluginId}: requires["${depId}"]="${range}" 不是合法的 SemVer 范围`,
          );
          continue;
        }
        const depVersion = versionOf(depId);
        if (depVersion === undefined) {
          errors.push(`${pluginId}: 缺少依赖 "${depId}"（未安装）`);
          continue;
        }
        if (!semver.satisfies(depVersion, range)) {
          errors.push(
            `${pluginId}: 依赖 "${depId}" 版本 ${depVersion} 不满足要求 "${range}"`,
          );
        }
      }
      return errors;
    };

    const reject = (plugin: LoadedPlugin, errors: string[]): void => {
      alive = alive.filter((p) => p !== plugin);
      failures.push({ pluginId: plugin.manifest.id, dir: plugin.dir, errors });
    };

    for (;;) {
      // 第 1 遍：#7 校验。拒绝一个就重扫——被拒者的依赖者接下来会报「缺少依赖」，
      // 失败沿依赖边传播，直到定点（与失败插件无关的插件不受影响）。
      let rejectedAny = false;
      for (const plugin of alive) {
        const errors = validateRequires(plugin);
        if (errors.length > 0) {
          reject(plugin, errors);
          rejectedAny = true;
          break; // 集合已变，从头重扫
        }
      }
      if (rejectedAny) continue;

      // 第 2 遍：存活插件的 requires 全部合法，做 Kahn 拓扑排序。
      const aliveIds = new Set(alive.map((p) => p.manifest.id));
      const indegree = new Map<string, number>();
      const dependents = new Map<string, LoadedPlugin[]>();
      for (const p of alive) {
        const deps = Object.keys(p.manifest.requires ?? {}).filter((d) =>
          aliveIds.has(d),
        );
        indegree.set(p.manifest.id, deps.length);
        for (const d of deps) {
          const list = dependents.get(d) ?? [];
          list.push(p);
          dependents.set(d, list);
        }
      }

      const ordered: LoadedPlugin[] = [];
      // 入度 0 的插件按输入顺序入队，保证结果确定性。
      const queue: LoadedPlugin[] = alive.filter(
        (p) => (indegree.get(p.manifest.id) ?? 0) === 0,
      );
      while (queue.length > 0) {
        const node = queue.shift()!;
        ordered.push(node);
        for (const dep of dependents.get(node.manifest.id) ?? []) {
          const next = (indegree.get(dep.manifest.id) ?? 0) - 1;
          indegree.set(dep.manifest.id, next);
          if (next === 0) queue.push(dep);
        }
      }

      // #8 校验：Kahn 结束后仍未入列的节点 = 环成员。
      if (ordered.length >= alive.length) {
        return { ordered, failures };
      }
      const cyclic = alive.filter((p) => !ordered.includes(p));
      const cycleDesc = cyclic.map((p) => p.manifest.id).join(' → ');
      for (const plugin of cyclic) {
        reject(plugin, [
          `${plugin.manifest.id}: 检测到循环依赖（${cycleDesc}），内核不允许互相 requires 的插件`,
        ]);
      }
      // 环成员被拒 → 依赖环成员的插件在下一轮第 1 遍报「缺少依赖」。
    }
  }
}
