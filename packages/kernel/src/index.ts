/**
 * Is Sheep Box 自研极薄内核。
 *
 * 边界（docs/requirements.md 4.1）：
 *  - 只做四件事：插件加载、生命周期与依赖、services/events、profile 配置。
 *  - 不渲染任何业务 UI、不实现任何工具能力、不绑定具体壳、不假设插件来源。
 *
 * 当前为 TASK-001 交付的「占位骨架」：导出公共类型与各子系统的占位类，
 * 方法体一律抛 "not implemented"，由 TASK-002~005 逐任务填充。
 */
import { PluginLoader } from './loader';
import { LifecycleManager } from './lifecycle';
import { ServiceRegistry } from './services';
import { EventBus } from './events';
import { DependencyResolver } from './dependency';
import { ProfileEngine } from './profile';

export class IsSheepBoxKernel {
  /** 当前内核暴露给插件的 ctx API 主版本（兼容性契约，见 requirements.md 4.5）。 */
  readonly apiVersion = '1.0' as const;

  readonly loader = new PluginLoader();
  readonly lifecycle = new LifecycleManager();
  readonly services = new ServiceRegistry();
  readonly events = new EventBus();
  readonly dependency = new DependencyResolver();
  readonly profile = new ProfileEngine();

  /** 启动内核：加载 profile、扫描插件目录、装载壳插件。TASK-002 起接入。 */
  async start(): Promise<void> {
    throw new Error('IsSheepBoxKernel.start() 未实现：见 TASK-002 / TASK-004');
  }

  /** 停止内核：卸载所有插件并回滚 effects。TASK-003 起接入。 */
  async stop(): Promise<void> {
    throw new Error('IsSheepBoxKernel.stop() 未实现：见 TASK-003');
  }
}

export * from './types';
