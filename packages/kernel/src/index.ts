/**
 * Is Sheep Box 自研极薄内核。
 *
 * 边界（docs/requirements.md 4.1）：
 *  - 只做四件事：插件加载、生命周期与依赖、services/events、profile 配置。
 *  - 不渲染任何业务 UI、不实现任何工具能力、不绑定具体壳、不假设插件来源。
 *
 * TASK-002 已交付：PluginLoader、EventBus/ServiceRegistry 最小实现、ctx v1 类型。
 * TASK-003 已交付：LifecycleManager mount/unmount + 可逆 effects。
 * TASK-004 已交付：ProfileEngine（持久化/热重载/快照/壳 fallback）。
 * TASK-005 已交付：apiVersion SemVer 兼容性校验。
 */
import { PluginLoader } from './loader';
import type { LoadedPlugin } from './loader';
import { LifecycleManager } from './lifecycle';
import { ServiceRegistryImpl } from './services';
import { EventBusImpl } from './events';
import { DependencyResolver } from './dependency';
import { ProfileEngine } from './profile';
import { CURRENT_API_VERSION } from './compat';

export class IsSheepBoxKernel {
  /** 当前内核暴露给插件的 ctx API 版本（兼容性契约，见 requirements.md 4.5）。 */
  readonly apiVersion = CURRENT_API_VERSION;

  readonly loader = new PluginLoader();
  readonly services = new ServiceRegistryImpl();
  readonly events = new EventBusImpl();
  readonly lifecycle: LifecycleManager;
  readonly dependency = new DependencyResolver();
  /** ProfileEngine 在 start() 时初始化（需要 userDataDir）。 */
  profile!: ProfileEngine;

  constructor() {
    this.lifecycle = new LifecycleManager(this.events, this.services);
  }

  /**
   * 启动内核：
   *  1. 初始化 ProfileEngine（读当前 profile）
   *  2. 扫描 pluginsDir 发现可用插件
   *  3. 按 profile 启用列表 mount 插件
   *  4. 壳缺失/失败 → 安全模式 fallback
   *
   * @param userDataDir 用户数据目录（存 profiles/snapshots）
   * @param pluginsDir 插件包目录
   */
  async start(userDataDir: string, pluginsDir: string): Promise<{
    boot: import('./profile/types').BootResult;
    discovered: LoadedPlugin[];
    discoveryFailures: Array<{ dir: string; errors: string[] }>;
  }> {
    this.profile = new ProfileEngine({
      userDataDir,
      lifecycle: this.lifecycle,
      events: this.events,
    });

    const discovery = this.loader.loadAll(pluginsDir);
    this.profile.setAvailablePlugins(discovery.loaded);

    const boot = await this.profile.boot();
    return {
      boot,
      discovered: discovery.loaded,
      discoveryFailures: discovery.failures,
    };
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
export {
  CURRENT_API_VERSION,
  validateApiVersionRange,
  checkApiCompatibility,
} from './compat';
export type { CompatCheckResult } from './compat';
export { ProfileEngine, DEFAULT_SHELL_ID } from './profile';
export type {
  Profile,
  ProfileSnapshot,
  PermissionStore,
  BootResult,
} from './profile/types';
export { PermissivePermissionStore } from './profile/types';
