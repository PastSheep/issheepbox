/**
 * 市场客户端公共类型。
 *
 * 字段形状对齐 docs/plugin-registry-schema.md（registry index 格式 v1，
 * draft-07 JSON Schema）。本模块只做「获取 + 解析 + 查询」，
 * 不涉及安装/卸载/写入 pluginsDir（见 src/index.ts 占位说明）。
 */

/**
 * registry 单条插件条目（镜像 schema 第 3 节字段）。
 *
 * 注意：
 *  - `permissions` 原样透传（string[]），本任务不做授权校验
 *    （授权逻辑属 TASK-008 approval-policy，见 docs/plugin-spec-v1.md 第 7 节）。
 *  - `apiVersion` 为字符串原样保留（range 比对属内核 TASK-005 的职责）。
 */
export interface RegistryPluginEntry {
  /** 插件 ID，反向域名风格，registry 内全局唯一。 */
  id: string;
  /** 展示名（schema maxLength 50）。 */
  name: string;
  /** 一句话描述（schema maxLength 200）。 */
  description: string;
  /** 作者名或组织名（schema maxLength 100）。 */
  author: string;
  /** 当前最新版本，严格 SemVer（MAJOR.MINOR.PATCH）。 */
  version: string;
  /** 该版本兼容的 ctx API range（字符串原样保留）。 */
  apiVersion: string;
  /** 开源协议，SPDX 标识符。 */
  license?: string;
  /** 图标 URL（可指向仓库 raw 地址）。 */
  icon?: string;
  /** 项目主页 URL。 */
  homepage?: string;
  /** 源码仓库 URL（GitHub）。 */
  repository: string;
  /** 当前版本 Release 页面 URL。 */
  releaseUrl: string;
  /** zip 包下载直链（GitHub Release assets，可直接 GET）。 */
  downloadUrl: string;
  /** 该版本声明的权限列表（镜像 manifest，透传）。 */
  permissions: string[];
  /** 依赖列表（键为插件 ID 或服务名，值为 SemVer range）。 */
  requires?: Record<string, string>;
  /** 分类标签，如 ["productivity", "note"]。 */
  tags?: string[];
  /** 该版本发布时间，ISO 8601 UTC。 */
  publishedAt: string;
}

/** registry 索引顶层结构（镜像 schema 第 2 节）。 */
export interface RegistryIndex {
  /** registry 索引格式版本，SemVer，当前 1.0.0。 */
  registryVersion: string;
  /** 索引最后更新时间，ISO 8601 UTC。 */
  generatedAt: string;
  /** 插件条目数组（可为空 []）。 */
  plugins: RegistryPluginEntry[];
}

/** 被拒绝的非法条目（容错结果的一部分）。 */
export interface RegistryEntryError {
  /** 条目在 plugins[] 中的原始下标（顶层非法时为 -1）。 */
  index: number;
  /** 条目 id（能读出才填；缺失/类型错误的条目可能没有）。 */
  id?: string;
  /** 拒绝原因（可读中文，逐条列出）。 */
  reasons: string[];
}

/**
 * 解析结果。解析永不抛异常：非法 JSON / 非法顶层结构 / 非法条目
 * 一律落入结构化错误字段，由调用方决定如何展示。
 */
export interface RegistryIndexParseResult {
  /** 顶层结构合法时返回完整索引（含合法条目）；否则为 null。 */
  index: RegistryIndex | null;
  /** 通过校验的合法条目（已按 id 去重，保留首个）。 */
  entries: RegistryPluginEntry[];
  /** 被拒绝的非法条目及其原因。 */
  invalid: RegistryEntryError[];
  /** 顶层错误（非对象 / 缺 registryVersion|generatedAt|plugins 等）。 */
  topLevelErrors: string[];
  /** 原始 plugins[] 条目总数（含非法条目）。 */
  total: number;
  /**
   * registryVersion 是否在本客户端支持的格式版本内
   * （见 src/parse.ts SUPPORTED_REGISTRY_VERSIONS；不匹配仍返回 index，
   *  由调用方决定是否提示升级客户端）。
   */
  registryVersionSupported: boolean;
}

/** 列表查询条件。所有字段均为「且」关系。 */
export interface RegistryQuery {
  /** id 精确匹配。 */
  id?: string;
  /** name 子串匹配（不区分大小写）。 */
  name?: string;
  /** author 子串匹配（不区分大小写）。 */
  author?: string;
  /** version 精确匹配。 */
  version?: string;
  /** apiVersion 精确匹配（range 原文）。 */
  apiVersion?: string;
  /** license 精确匹配（SPDX 标识符）。 */
  license?: string;
  /** tags 数组包含该标签。 */
  tag?: string;
  /** permissions 数组包含该权限。 */
  permission?: string;
  /** 跨 id/name/description/author 的子串搜索（不区分大小写）。 */
  search?: string;
  /** 截断返回条数（非负整数；省略则返回全部）。 */
  limit?: number;
}

/** MarketClient 构造选项。 */
export interface MarketClientOptions {
  /**
   * registry 索引 URL。
   *
   * ⚠️ 默认值见 index.ts 的 DEFAULT_REGISTRY_URL（占位常量）；
   * GitHub 组织/仓库名待需求方提供后替换，并在此传入真实地址。
   */
  registryUrl?: string;
  /** 自定义 fetch 实现（默认全局 fetch；测试可注入）。 */
  fetchImpl?: typeof fetch;
  /** 拉取超时（毫秒），默认 15000。 */
  timeoutMs?: number;
}

/** 网络层错误（拉取失败 / HTTP 非 2xx）。解析层错误不抛异常。 */
export class RegistryFetchError extends Error {
  /** HTTP 状态码；网络层失败时为 undefined。 */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RegistryFetchError';
    this.status = status;
  }
}
