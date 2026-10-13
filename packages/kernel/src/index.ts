/**
 * Is Sheep Box 自研极薄内核。
 *
 * 边界（docs/requirements.md 4.1）：
 *  - 只做四件事：插件加载、生命周期与依赖、services/events、profile 配置。
 *  - 不渲染任何业务 UI、不实现任何工具能力、不绑定具体壳、不假设插件来源。
 *
 * TASK-002 已交付：PluginLoader、EventBus/ServiceRegistry 最小实现、ctx v1 类型。
 * TASK-003 已交付：LifecycleManager mount/unmount + 可逆 effects
 *  （插件注册的服务/事件监听在 unmount 时自动回滚，无残留）。
 *
 * 后续任务：
 *  - TASK-004：profile 配置引擎
 *  - TASK-005：apiVersion SemVer 范围校验与失败隔离测试
 */
import { PluginLoader } from './loader';
import { LifecycleManager } from './lifecycle';
import { ServiceRegistryImpl } from './services';
import { EventBusImpl } from './events';
import { DependencyResolver } from './dependency';
import { ProfileEngine } from './profile';

export class IsSheepBoxKernel {
  /** 当前内核暴露给插件的 ctx API 主版本（兼容性契约，见 requirements.md 4.5）。 */
  readonly apiVersion = '1.0' as const;

  readonly loader = new PluginLoader();
  readonly services = new ServiceRegistryImpl();
  readonly events = new EventBusImpl();
  readonly lifecycle: LifecycleManager;
  readonly dependency = new DependencyResolver();
  readonly profile = new ProfileEngine();

  constructor() {
    // 共享 bus/registry 注入生命周期管理器：插件通过 ctx 注册的服务/事件
    // 都落在这两个单例上，mount/unmount 时由 LifecycleManager 跟踪 effects。
    this.lifecycle = new LifecycleManager(this.events, this.services);
  }

  /** 启动内核：加载 profile、扫描插件目录、mount 插件。TASK-004 接入。 */
  async start(): Promise<void> {
    throw new Error('IsSheepBoxKernel.start() 未实现：见 TASK-004');
  }

  /** 停止内核：unmount 所有插件并回滚 effects。 */
  async stop(): Promise<void> {
    await this.lifecycle.unmountAll();
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
export { LifecycleManager } from './lifecycle';
export type {
  MountOutcome,
  MountAllResult,
} from './lifecycle';
export { EffectScope } from './effect-scope';
export { parseManifest } from './manifest';
export { createLogger } from './logger';
