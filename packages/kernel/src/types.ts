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
 * 内核暴露给插件的 ctx API v1。
 *
 * v1 初始接口面（TASK-002 交付）：
 *  - manifest / apiVersion：只读快照
 *  - logger：日志
 *  - events：发布/订阅
 *  - services：服务注册与消费
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
