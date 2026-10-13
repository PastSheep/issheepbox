/**
 * 插件市场客户端（TASK-007）。
 *
 * 本任务交付范围（见 TASKS.md TASK-007）：
 *  1. 按 docs/plugin-registry-schema.md（draft-07 JSON Schema）拉取并解析
 *     registry 索引 plugins.json（默认 URL 见 DEFAULT_REGISTRY_URL）。
 *  2. 查询接口：list() 按条件过滤、getById() 精确查询；解析非法条目容错
 *     （非法条目被拒绝并记录原因，不抛异常、不影响其余条目）。
 *  3. 下载/安装/卸载/更新动作依赖后续任务（插件打包、registry 仓库落地、
 *     TASK-011 发布、与 loader/profile 的集成），本任务只留接口占位并
 *     抛出带说明的 Error，不写入 pluginsDir、不触碰
 *     packages/kernel 的 loader/profile 假设。
 */
import { parseRegistryIndex } from './parse';
import type {
  MarketClientOptions,
  RegistryIndex,
  RegistryIndexParseResult,
  RegistryPluginEntry,
  RegistryQuery,
} from './types';
import { RegistryFetchError } from './types';

export * from './types';
export { parseRegistryIndex, SUPPORTED_REGISTRY_VERSIONS } from './parse';
export { compareVersions, parseSemver } from './versions';

/**
 * registry 索引默认地址。
 *
 * 指向官方 registry 仓库（PastSheep/issheepbox-registry）的 raw 索引文件，
 * 该地址已实测返回 200。构造 MarketClient 时仍可传入 registryUrl 覆盖。
 */
export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/PastSheep/issheepbox-registry/main/plugins.json';

/** 默认拉取超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** 占位接口的固定错误信息：说明依赖哪些后续任务。 */
const PLACEHOLDER_ERROR =
  '未实现：依赖后续任务（registry 仓库落地 / 插件打包 / 与 loader、profile 集成），' +
  'TASK-007 明确不写入 pluginsDir。见 docs/TASKS.md TASK-007 与 packages/market-client/README.md。';

/**
 * 市场客户端：拉取 + 解析 registry 索引，提供列表/过滤查询。
 *
 * 使用示例：
 * ```ts
 * const client = new MarketClient();
 * const result = await client.fetchIndex();
 * if (result.topLevelErrors.length > 0) return; // 索引结构非法
 * const notePlugins = client.list({ tag: 'note' });
 * ```
 */
export class MarketClient {
  /** registry 索引 URL（构造时指定或使用占位常量）。 */
  readonly registryUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** 最近一次 fetchIndex() 的解析结果（未拉取过时为 null）。 */
  private lastResult: RegistryIndexParseResult | null = null;

  constructor(options: MarketClientOptions = {}) {
    this.registryUrl = options.registryUrl ?? DEFAULT_REGISTRY_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * 拉取并解析 registry 索引。
   *
   * - 网络失败 / 非 2xx：抛 RegistryFetchError（携带 HTTP 状态码）。
   * - 响应体非法 JSON / 顶层结构非法：不抛异常，错误落在返回结果的
   *   topLevelErrors（index=null）。
   * - 部分条目非法：合法条目保留，非法条目在 invalid 中逐条记录原因。
   */
  async fetchIndex(): Promise<RegistryIndexParseResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.registryUrl, { signal: controller.signal });
    } catch (err) {
      throw new RegistryFetchError(`拉取 registry 失败：${String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new RegistryFetchError(`registry 返回 HTTP ${res.status}`, res.status);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new RegistryFetchError(`读取 registry 响应失败：${String(err)}`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      // 响应体不是合法 JSON：按解析失败处理，不抛异常。
      const failed: RegistryIndexParseResult = {
        index: null,
        entries: [],
        invalid: [],
        topLevelErrors: [`plugins.json 不是合法 JSON：${String(err)}`],
        total: 0,
        registryVersionSupported: false,
      };
      this.lastResult = failed;
      return failed;
    }

    this.lastResult = parseRegistryIndex(raw);
    return this.lastResult;
  }

  /**
   * 兼容旧占位命名：拉取并解析（等价 fetchIndex）。
   * 仅保留给既有调用方；新代码请使用 fetchIndex。
   */
  refresh(): Promise<RegistryIndexParseResult> {
    return this.fetchIndex();
  }

  /** 最近一次解析结果（未 fetchIndex 过则为 null）。 */
  get lastParseResult(): RegistryIndexParseResult | null {
    return this.lastResult;
  }

  /** 当前缓存的索引（顶层非法或未拉取时为 null）。 */
  get currentIndex(): RegistryIndex | null {
    return this.lastResult?.index ?? null;
  }

  /**
   * 列出插件（按查询条件过滤，字段间为「且」关系）。
   * 未拉取过 / 顶层解析失败时返回空数组。
   */
  list(query: RegistryQuery = {}): RegistryPluginEntry[] {
    const entries = this.lastResult?.entries ?? [];
    let out = entries;

    if (query.id !== undefined) {
      out = out.filter((e) => e.id === query.id);
    }
    if (query.name !== undefined) {
      const needle = query.name.toLowerCase();
      out = out.filter((e) => e.name.toLowerCase().includes(needle));
    }
    if (query.author !== undefined) {
      const needle = query.author.toLowerCase();
      out = out.filter((e) => e.author.toLowerCase().includes(needle));
    }
    if (query.version !== undefined) {
      out = out.filter((e) => e.version === query.version);
    }
    if (query.apiVersion !== undefined) {
      out = out.filter((e) => e.apiVersion === query.apiVersion);
    }
    if (query.license !== undefined) {
      out = out.filter((e) => e.license === query.license);
    }
    const tag = query.tag;
    if (tag !== undefined) {
      out = out.filter((e) => e.tags?.includes(tag) ?? false);
    }
    const permission = query.permission;
    if (permission !== undefined) {
      out = out.filter((e) => e.permissions.includes(permission));
    }
    if (query.search !== undefined) {
      const needle = query.search.toLowerCase();
      out = out.filter((e) =>
        [e.id, e.name, e.description, e.author]
          .map((s) => s.toLowerCase())
          .some((s) => s.includes(needle)),
      );
    }

    if (query.limit !== undefined && query.limit >= 0) {
      out = out.slice(0, query.limit);
    }
    return out;
  }

  /** 按 id 精确查询（未拉取过或 id 不存在时返回 undefined）。 */
  getById(id: string): RegistryPluginEntry | undefined {
    return this.lastResult?.entries.find((e) => e.id === id);
  }

  /** 顶层解析错误（未拉取过时为空数组）。 */
  topLevelErrors(): string[] {
    return this.lastResult?.topLevelErrors ?? [];
  }

  /** 非法条目清单（未拉取过时为空数组）。 */
  invalidEntries(): RegistryIndexParseResult['invalid'] {
    return this.lastResult?.invalid ?? [];
  }

  // ---------------------------------------------------------------------
  // 下载 / 安装 / 卸载 / 更新 —— 接口占位（后续任务实现）
  // ---------------------------------------------------------------------

  /** 下载插件 zip（依赖 TASK-011 打包产物与 registry 仓库落地后实现）。 */
  async download(_pluginId: string): Promise<never> {
    throw new Error(`MarketClient.download() ${PLACEHOLDER_ERROR}`);
  }

  /** 安装插件（依赖后续任务：解压、manifest 校验、权限授权、loader 集成）。 */
  async install(_pluginId: string): Promise<never> {
    throw new Error(`MarketClient.install() ${PLACEHOLDER_ERROR}`);
  }

  /** 卸载插件（依赖后续任务：与内核 LifecycleManager / profile 集成）。 */
  async uninstall(_pluginId: string): Promise<never> {
    throw new Error(`MarketClient.uninstall() ${PLACEHOLDER_ERROR}`);
  }

  /** 更新插件（依赖后续任务：版本对比 + 安装流程落地）。 */
  async update(_pluginId: string): Promise<never> {
    throw new Error(`MarketClient.update() ${PLACEHOLDER_ERROR}`);
  }
}
