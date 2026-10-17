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
   * registry 索引 URL（v1 单源兼容；默认 DEFAULT_REGISTRY_URL）。
   * 传了 sources 时此字段仅供 fetchIndex()（v1）使用，fetchAll() 以 sources 为准。
   */
  registryUrl?: string;
  /**
   * 多源配置（v3）。省略时：若传了 registryUrl → 自动生成一条 legacy index 源；
   * 两者都省略 → 源列表为空（fetchAll 返回空聚合）。
   */
  sources?: MarketSource[];
  /** 自定义 fetch 实现（默认全局 fetch；测试可注入）。 */
  fetchImpl?: typeof fetch;
  /** 拉取超时（毫秒），默认 15000。 */
  timeoutMs?: number;
  /**
   * 插件安装目录（pluginsDir，TASK-012）。
   *
   * install / uninstall / update / listInstalled / installedVersion /
   * installFromRecord / updateFromRecord / importLocalZip 依赖此目录；
   * 未传入时调用这些方法会抛 MarketInstallError(code=PLUGINS_DIR_REQUIRED)。
   */
  pluginsDir?: string;
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

/**
 * 安装 / 卸载 / 更新的类型化错误码（TASK-012）。
 *
 * 供 UI 按 code 展示友好文案，不必依赖错误消息原文匹配。
 */
export type MarketInstallErrorCode =
  | /** 下载或索引拉取网络失败（含超时 / abort）。 */ 'NETWORK'
  | /** 下载返回非 2xx 状态码。 */ 'HTTP_STATUS'
  | /** zip 损坏 / 空包 / 顶层结构非法 / 含路径穿越条目。 */ 'INVALID_ZIP'
  /** `<id>/plugin.json` 缺失/不可解析/缺必填字段/entry 文件不存在。 */
  | 'MANIFEST_INVALID'
  /** zip 顶层目录名 ≠ 插件 id，或 manifest.id ≠ 请求的插件 id。 */
  | 'ID_MISMATCH'
  /** pluginsDir 已存在同名合法插件。 */
  | 'ALREADY_INSTALLED'
  /** 未安装即调用 uninstall / update。 */
  | 'NOT_INSTALLED'
  /** 解压或磁盘写入失败（临时目录已清理，不破坏现装版本）。 */
  | 'EXTRACT_FAILED'
  /** registry 索引中没有该插件 id。 */
  | 'NOT_IN_REGISTRY'
  /** 插件 id 不合法（与内核 manifest ID_RE 一致的正则）。 */
  | 'INVALID_PLUGIN_ID'
  /** 构造时未传 pluginsDir 却调用了安装类方法。 */
  | 'PLUGINS_DIR_REQUIRED'
  /** zip 二进制 sha256 与索引声明的 zipSha256 不一致（供应链防线）。 */
  | 'SHA_MISMATCH';

/** 安装 / 卸载 / 更新的类型化错误（带 code，供 UI 分类展示）。 */
export class MarketInstallError extends Error {
  /** 错误码（见 MarketInstallErrorCode）。 */
  readonly code: MarketInstallErrorCode;
  /** HTTP 状态码（仅 HTTP_STATUS 时有值）。 */
  readonly status?: number;

  constructor(code: MarketInstallErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'MarketInstallError';
    this.code = code;
    this.status = status;
  }
}

/** install / update 成功返回值。 */
export interface InstallResult {
  /** 插件 id。 */
  pluginId: string;
  /** 落盘插件 plugin.json 的 version。 */
  version: string;
  /** 插件包目录绝对路径（pluginsDir/<pluginId>）。 */
  dir: string;
}

/** update 成功返回值（updated=false 表示已是最新、未下载）。 */
export interface UpdateResult extends InstallResult {
  /** 是否真的替换了磁盘上的版本。 */
  updated: boolean;
}

/** 已安装插件摘要（listInstalled 返回；供市场 UI 展示已装状态）。 */
export interface InstalledPluginInfo {
  pluginId: string;
  version: string;
  dir: string;
}

// ---------------------------------------------------------------------------
// 多源市场模型（v4 定稿 / format 2）：
// 任何"发现渠道"（index 索引源 / plugin-repo 单插件仓库）最终产出 PluginRecord[]；
// 本地 zip 导入是一次性安装动作，不持久化为源。
// ---------------------------------------------------------------------------

/**
 * 插件记录（format 2 条目，全协议统一 schema）。
 *
 * 索引源 index.json 的 plugins[] 元素与此一致；单插件仓库根 index.json
 * 顶层即一条该记录（自描述）。`source` 段不在此 schema 内——由客户端在
 * 聚合时附加（见 SourcedPluginRecord）。
 */
export interface PluginRecord {
  /** 插件 ID，反向域名风格（与 manifest.id 一致）。 */
  pluginId: string;
  /** 展示名。 */
  name: string;
  /** 一句话描述。 */
  description: string;
  /** 插件源码仓库 URL（GitHub 主页）。 */
  repoUrl: string;
  /** 项目主页（可选）。 */
  homepage?: string;
  /** 当前最新版本，严格 SemVer。 */
  latestVersion: string;
  /** zip 包下载直链（GitHub Release assets）。 */
  zipUrl: string;
  /** zip 二进制 sha256（64 位 hex）；安装链路强校验。 */
  zipSha256: string;
  /** 该版本兼容的 ctx API range。 */
  apiVersion: string;
  /** 该版本声明的权限列表。 */
  permissions: string[];
  /** 面板等 UI 元数据摘要（供市场列表免下载展示）。 */
  ui?: { panels?: Array<{ id: string; title: string }> };
  /** 插件组预留（TASK-019）。 */
  group?: string | null;
  /** 记录最后更新时间，ISO 8601。 */
  updatedAt: string;
}

/** 发现渠道类型：组织级索引源 / 单插件仓库订阅。 */
export type MarketSourceType = 'index' | 'plugin-repo';

/** 用户配置的插件源（settings 持久化；本地 zip 导入不构成源）。 */
export interface MarketSource {
  /** 本地唯一标识。 */
  id: string;
  type: MarketSourceType;
  /** 展示名（如"官方源"、"鼠鼠数据"）。 */
  name: string;
  /**
   * index 源：index.json 的完整 URL；
   * plugin-repo 源：仓库主页 URL（github.com/owner/repo，
   * 客户端据此构造 raw 根 index.json）。
   */
  url: string;
  enabled: boolean;
}

/** 聚合后带来源标记的记录（客户端在聚合时附加 source 段）。 */
export interface SourcedPluginRecord extends PluginRecord {
  source: {
    id: string;
    type: MarketSourceType;
    name: string;
    url: string;
    /** 信任标记（UI 透明展示；客户端不拦截任何源，用户自决）。 */
    trusted: boolean;
  };
}

/** 被拒绝的非法 format 2 记录（容错结果的一部分）。 */
export interface PluginEntryErrorV2 {
  /** 记录在 plugins[] 中的原始下标（单插件仓库解析时为 0）。 */
  index: number;
  /** 记录 pluginId（能读出才填）。 */
  pluginId?: string;
  /** 拒绝原因（可读中文）。 */
  reasons: string[];
}

/** 单个源拉取 + 解析结果（源级失败隔离：ok=false 不阻断其他源）。 */
export interface SourceFetchResult {
  sourceId: string;
  /** 网络失败 / HTTP 非 2xx / 顶层结构非法时为 false。 */
  ok: boolean;
  /** 失败原因（成功时 undefined）。 */
  error?: string;
  /** 通过校验的合法记录（已附 source 段）。 */
  records: SourcedPluginRecord[];
  /** 被拒绝的非法记录及其原因。 */
  invalid: PluginEntryErrorV2[];
  /** 原始记录总数（含非法）。 */
  total: number;
}

/**
 * 多源聚合结果（fetchAll 返回）。
 *
 * 同 pluginId 出现在多个源时**不自动去重选源**——flat 保留全部记录，
 * byPluginId 分组暴露冲突，由 UI 层并列展示、用户在安装时选源。
 */
export interface MarketAggregate {
  /** 按 pluginId 分组（每组 1..n 条，多源冲突在此暴露）。 */
  byPluginId: Map<string, SourcedPluginRecord[]>;
  /** 全部合法记录平铺（含重复 pluginId 的多源记录）。 */
  flat: SourcedPluginRecord[];
  /** 每个启用源一条结果（含失败降级，调用方可展示源状态）。 */
  sources: SourceFetchResult[];
}
