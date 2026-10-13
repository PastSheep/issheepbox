/**
 * 内核公共类型。
 *
 * 这些类型是内核与插件之间的兼容性契约的起点（见 docs/requirements.md 4.5）。
 * 字段草案对齐 docs/requirements.md 第 5 节，正式 schema 由 TASK-010 定稿。
 */

/** 插件 manifest（plugin.json）草案。 */
export interface PluginManifest {
  /** 全局唯一 ID，反向域名风格，如 org.example.my-tool。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 插件自身版本（SemVer）。 */
  version: string;
  /** 所需 ctx API 版本范围，如 "^1.0"。 */
  apiVersion: string;
  /** 描述。 */
  description?: string;
  /** 作者/组织。 */
  author?: string;
  /** 代码入口（相对插件根目录）。 */
  entry: string;
  /** UI 声明：图标、面板、工具箱入口等。 */
  ui?: PluginUiDeclaration;
  /** 权限声明数组，如 "files:read"、"network:fetch"。 */
  permissions?: string[];
  /** 依赖的其他插件/服务及版本范围。 */
  requires?: Record<string, string>;
}

/** 插件 UI 声明（具体形状在 TASK-006/TASK-010 定稿）。 */
export interface PluginUiDeclaration {
  icon?: string;
  panel?: unknown;
  toolbox?: unknown;
}

/**
 * 内核暴露给插件的 ctx API v1（骨架）。
 *
 * 内核向插件暴露的服务接口在此聚合；具体方法由 TASK-002 起逐任务填充。
 * 兼容性：主版本内只增不破（见 requirements.md 4.5）。
 */
export interface PluginContext {
  /** 当前内核暴露的 API 主版本。 */
  readonly apiVersion: '1.0';
  /** 本插件的 manifest 快照（由加载器注入）。 */
  readonly manifest: PluginManifest;
}

/** 插件实例：插件入口默认导出的对象，承载生命周期钩子。 */
export interface PluginInstance {
  /** 挂载（TASK-003 实现）。 */
  mount?(ctx: PluginContext): void | Promise<void>;
  /** 卸载：必须自动回滚 mount 期间注册的所有 effects（TASK-003）。 */
  unmount?(): void | Promise<void>;
}

/** 插件工厂：入口导出的函数，接收 ctx 返回插件实例。 */
export type PluginFactory = (
  ctx: PluginContext,
) => PluginInstance | Promise<PluginInstance>;
