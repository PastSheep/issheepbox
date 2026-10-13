/**
 * Is Sheep Box 自研极薄内核。
 *
 * 边界（docs/requirements.md 4.1）：
 *  - 只做四件事：插件加载、生命周期与依赖、services/events、profile 配置。
 *  - 不渲染任何业务 UI、不实现任何工具能力、不绑定具体壳、不假设插件来源。
 *
 * TASK-002 已交付：
 *  - PluginLoader：扫描目录、解析 manifest、require 入口模块，失败隔离
 *  - EventBus / ServiceRegistry：跨插件事件与服务最小实现
 *  - ctx API v1 类型（见 types.ts PluginContext）
 *
 * 后续任务继续填充：
 *  - TASK-003：生命周期 mount/unmount + 可逆 effects
 *  - TASK-004：profile 配置引擎
 *  - TASK-005：apiVersion SemVer 范围校验与失败隔离测试
 */
import { PluginLoader } from './loader';
import { LifecycleManager } from './lifecycle';
import { ServiceRegistryImpl } from './services';
import { EventBusImpl } from './events';
import { DependencyResolver } from './dependency';
import { ProfileEngine } from './profile';
import { createLogger } from './logger';
import { CURRENT_API_VERSION } from './compat';
import type { PluginContext, PluginManifest } from './types';

export class IsSheepBoxKernel {
  /** 当前内核暴露给插件的 ctx API 版本（兼容性契约，见 requirements.md 4.5）。 */
  readonly apiVersion = CURRENT_API_VERSION;

  readonly loader = new PluginLoader();
  readonly lifecycle = new LifecycleManager();
  readonly services = new ServiceRegistryImpl();
  readonly events = new EventBusImpl();
  readonly dependency = new DependencyResolver();
  readonly profile = new ProfileEngine();

  /**
   * 为给定插件构造一个 ctx 实例（TASK-003 mount 时调用）。
   * 共享 events/services 单例，插件间通过它们协作。
   */
  createContext(manifest: PluginManifest): PluginContext {
    return {
      apiVersion: this.apiVersion,
      manifest,
      logger: createLogger(manifest.id),
      events: this.events,
      services: this.services,
    };
  }

  /** 启动内核：加载 profile、扫描插件目录、装载壳插件。TASK-003/004 接入。 */
  async start(): Promise<void> {
    throw new Error('IsSheepBoxKernel.start() 未实现：见 TASK-003 / TASK-004');
  }

  /** 停止内核：卸载所有插件并回滚 effects。TASK-003 接入。 */
  async stop(): Promise<void> {
    throw new Error('IsSheepBoxKernel.stop() 未实现：见 TASK-003');
  }
}

export * from './types';
export { PluginLoader } from './loader';
export type {
  LoadedPlugin,
  PluginLoadFailure,
  LoadResult,
} from './loader';
export { EventBusImpl } from './events';
export { ServiceRegistryImpl } from './services';
export { parseManifest } from './manifest';
export { createLogger } from './logger';
export {
  CURRENT_API_VERSION,
  validateApiVersionRange,
  checkApiCompatibility,
} from './compat';
export type { CompatCheckResult } from './compat';
