/**
 * 内核公共类型与 ctx API v1 契约。
 *
 * 这些类型是内核与插件之间的兼容性契约（见 docs/requirements.md 4.5）。
 * manifest 字段以 docs/plugin-spec-v1.md 第 3 节为准。
 */

/** 插件 UI 声明（形状见 plugin-spec-v1.md 3.2 `ui`）。 */
export interface PluginUiDeclaration {
  toolbox?: unknown;
  panels?: unknown;
  commands?: unknown;
  [key: string]: unknown;
}

/** 插件 manifest（plugin.json），字段以 docs/plugin-spec-v1.md 第 3 节为准。 */
export interface PluginManifest {
  /** 全局唯一 ID，反向域名风格，如 org.example.my-tool。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 插件自身版本（SemVer）。 */
  version: string;
  /** 所需 ctx API 版本范围，如 "^1.0.0"。 */
  apiVersion: string;
  /** 描述。 */
  description?: string;
  /** 作者/组织。 */
  author?: string;
  /** 项目主页 URL。 */
  homepage?: string;
  /** 源码仓库 URL。 */
  repository?: string;
  /** 开源协议（SPDX）。 */
  license?: string;
  /** 代码入口（相对插件根目录）。 */
  entry: string;
  /** 图标相对路径。 */
  icon?: string;
  /** UI 注册声明。 */
  ui?: PluginUiDeclaration;
  /** 权限声明数组。 */
  permissions?: string[];
  /** 依赖的其他插件/服务及版本范围。 */
  requires?: Record<string, string>;
  /** 向内核/其他插件贡献的服务与事件声明。 */
  contributes?: {
    services?: Array<{ name: string; version: string; description?: string }>;
    events?: Array<{ name: string; description?: string }>;
  };
}

/** 日志接口（ctx.logger）。 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * 事件总线句柄（ctx.events）。
 *
 * on() 返回 unsubscribe 函数；TASK-003 会在此基础上做可逆 effects
 * （插件卸载时自动 off 其所有监听）。
 */
export interface EventBus {
  on(event: string, handler: (...args: unknown[]) => void): () => void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

/**
 * 服务注册表句柄（ctx.services）。
 *
 * TASK-003 会在此基础上做可逆 effects：插件卸载时自动注销其注册的服务。
 */
export interface ServiceRegistry {
  register<T>(name: string, service: T): void;
  get<T>(name: string): T;
  has(name: string): boolean;
}

/**
 * 可逆 effects 句柄（ctx.effects，P-007 新增）。
 *
 * events.on / services.register 的 cleanup 由内核自动登记进插件的 effect scope；
 * 但经第三方 service（如 shell:ui.registerPanel）返回的 unregister，内核无法自动
 * 跟踪——插件把它登记到这里，即与 events/services 同 scope，卸载时逆序自动执行。
 */
export interface EffectsRegistry {
  /** 追加一个 cleanup 函数；插件 unmount 时逆序自动调用（同 events/services 的回滚 scope）。 */
  add(fn: () => void): void;
}

/**
 * 宿主文件能力（ctx.files，P-009 新增，闭环规范反馈 F-008）。
 *
 * 规范 §9.1 禁止插件直接使用 Node 内置模块（fs/path）；需要读写文件的插件改经
 * 内核注入的宿主能力。每次调用按「本插件 manifest.id」经 services 注册表查询
 * 'approval-policy' 服务的 `checkPermission(pluginId, permission)` 校验——ctx 作用域
 * API 在 createScopedCtx 内自动携带插件身份，调用方无法伪造或绕过（P-007 已论证：
 * 经 services 注册表的裸 service 方法无法自动归因调用方）。
 *
 * 门禁语义与 P-006 enable 门禁一致（fail-safe）：
 *  - approval-policy 服务未挂载 / checkPermission 未授予 → 抛错拒绝，无静默放行；
 *  - files:read 每次读前校验，files:write 每次写前校验。
 */
export interface FilesCapability {
  /**
   * 读取文本文件（UTF-8）。需 `files:read` 授权；未授权或授权服务不可用时抛错。
   * v1 为同步最小接口；v1 不做路径沙箱/白名单（路径越界责任在调用方）。
   */
  readFile(path: string): string;
  /**
   * 写入文本文件（UTF-8，覆盖写）。需 `files:write` 授权；未授权或授权服务
   * 不可用时抛错。v1 仅同步覆盖写最小接口（无追加/流式/路径白名单，留待后续 minor）。
   */
  writeFile(path: string, content: string): void;
}

/**
 * 内核暴露给插件的 ctx API v1。
 *
 * v1 初始接口面（TASK-002 交付）：
 *  - manifest / apiVersion：只读快照
 *  - logger：日志
 *  - events：发布/订阅
 *  - services：服务注册与消费
 *  - effects（P-007 增补）：登记任意 cleanup（如第三方 service 返回的 unregister），
 *    与 events/services 同 effect scope，卸载时自动回滚
 *  - files（P-009 增补）：宿主文件读写能力，每次调用按本插件 id 经 approval-policy
 *    checkPermission 做授权门禁（files:read / files:write），fail-safe 拒绝
 *
 * 后续 minor 版本只增不破（见 plugin-spec-v1.md 第 12 节）：
 *  - ctx.commands / ctx.panels（TASK-006）
 *  - ctx.storage / ctx.config（TASK-004）
 *  - ctx.permissions（TASK-008）
 *  - ctx.ui（TASK-006）
 */
export interface PluginContext {
  /** 当前内核暴露的 API 版本（SemVer）。 */
  readonly apiVersion: string;
  /** 本插件的 manifest 快照（由加载器注入）。 */
  readonly manifest: PluginManifest;
  /** 日志。 */
  readonly logger: Logger;
  /** 事件总线（跨插件发布/订阅）。 */
  readonly events: EventBus;
  /** 服务注册表（跨插件请求/响应）。 */
  readonly services: ServiceRegistry;
  /** 可逆 effects：登记任意 cleanup，随插件卸载自动逆序回滚（P-007 增补）。 */
  readonly effects: EffectsRegistry;
  /** 宿主文件能力：读写真实文件，受 files:read / files:write 授权门禁约束（P-009 增补）。 */
  readonly files: FilesCapability;
}

/** 插件入口模块：默认导出一个工厂函数。 */
export type PluginFactory = (ctx: PluginContext) => unknown | Promise<unknown>;

/** 插件入口模块（require() 后的形状）。 */
export interface PluginModule {
  default?: PluginFactory;
  [key: string]: unknown;
}

/** 插件生命周期阶段。 */
export type PluginState = 'mounted' | 'started' | 'stopped' | 'unmounted';

/** 一个已 mount 的插件运行时实例。 */
export interface MountedPlugin {
  /** 插件 ID（manifest.id）。 */
  readonly id: string;
  readonly manifest: PluginManifest;
  /** 注入给插件的 ctx（已包装 events/services 以跟踪 effects）。 */
  readonly ctx: PluginContext;
  /** 当前生命周期阶段。 */
  state: PluginState;
}
