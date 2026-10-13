/**
 * 插件生命周期管理 + 可逆 effects。
 *
 * mount(plugin) 时：
 *  1. 为该插件创建一个 EffectScope
 *  2. 构造 scoped ctx：ctx.events.on / ctx.services.register 会把
 *     unsubscribe / unregister 函数自动登记进 scope
 *  3. 调用插件工厂 main(ctx)
 *
 * unmount(id) 时：
 *  1. 逆序 dispose scope 内所有 cleanup（事件监听 off、服务注销）
 *  2. 插件注册的一切从共享 bus/registry 中清除，无残留
 *
 * 失败隔离：单个插件 mount 抛错不影响其他插件，错误记录到 MountResult.failures。
 */
import type {
  LoadedPlugin,
  MountedPlugin as MountedPluginType,
  PluginContext,
} from '../types';
import { EventBusImpl } from '../events';
import { ServiceRegistryImpl } from '../services';
import { EffectScope } from '../effect-scope';
import { createLogger } from '../logger';

/** mount 单个插件的结果。 */
export interface MountOutcome {
  ok: boolean;
  plugin?: MountedPluginType;
  error?: Error;
}

/** mountAll 的批量结果。 */
export interface MountAllResult {
  mounted: MountedPluginType[];
  failures: Array<{ pluginId: string; error: Error }>;
}

export class LifecycleManager {
  private readonly bus: EventBusImpl;
  private readonly registry: ServiceRegistryImpl;
  private readonly mounted = new Map<string, { scope: EffectScope; plugin: MountedPluginType }>();

  constructor(bus: EventBusImpl, registry: ServiceRegistryImpl) {
    this.bus = bus;
    this.registry = registry;
  }

  /**
   * mount 一个已加载插件：调用其工厂函数，并跟踪其注册的所有 effects。
   */
  async mount(loaded: LoadedPlugin): Promise<MountOutcome> {
    const { manifest, module } = loaded;
    const factory = module.default;
    if (typeof factory !== 'function') {
      return { ok: false, error: new Error(`插件 ${manifest.id} 入口未导出工厂函数`) };
    }

    const scope = new EffectScope();
    const ctx = this.createScopedCtx(manifest, scope);

    try {
      await factory(ctx);
    } catch (err) {
      // mount 失败：回滚已登记的 effects，避免半成品注册残留。
      scope.dispose();
      return { ok: false, error: err as Error };
    }

    const plugin: MountedPluginType = {
      id: manifest.id,
      manifest,
      ctx,
      state: 'mounted',
    };
    this.mounted.set(manifest.id, { scope, plugin });
    return { ok: true, plugin };
  }

  /**
   * unmount 一个插件：dispose 其 effect scope，自动 off 所有事件监听、
   * 注销所有它注册的服务。
   */
  async unmount(id: string): Promise<void> {
    const entry = this.mounted.get(id);
    if (!entry) return;
    entry.plugin.state = 'unmounted';
    entry.scope.dispose();
    this.mounted.delete(id);
  }

  /**
   * 批量 mount：单个失败不影响其他插件。
   */
  async mountAll(loaded: LoadedPlugin[]): Promise<MountAllResult> {
    const mounted: MountedPluginType[] = [];
    const failures: Array<{ pluginId: string; error: Error }> = [];
    for (const plugin of loaded) {
      const outcome = await this.mount(plugin);
      if (outcome.ok && outcome.plugin) {
        mounted.push(outcome.plugin);
      } else if (outcome.error) {
        failures.push({ pluginId: plugin.manifest.id, error: outcome.error });
      }
    }
    return { mounted, failures };
  }

  /**
   * 批量 unmount：逆序卸载（后 mount 的先 unmount），单个失败不阻断其他。
   */
  async unmountAll(): Promise<void> {
    const ids = [...this.mounted.keys()].reverse();
    for (const id of ids) {
      await this.unmount(id);
    }
  }

  /** 当前已 mount 的插件 ID 列表。 */
  get mountedIds(): string[] {
    return [...this.mounted.keys()];
  }

  /**
   * 构造一个带 effect 跟踪的 ctx：
   *  - ctx.events.on() 返回的 unsubscribe 自动登记进 scope
   *  - ctx.services.register() 后自动登记 unregister 进 scope
   */
  private createScopedCtx(
    manifest: import('../types').PluginManifest,
    scope: EffectScope,
  ): PluginContext {
    const bus = this.bus;
    const registry = this.registry;

    return {
      apiVersion: '1.0',
      manifest,
      logger: createLogger(manifest.id),
      events: {
        on(event, handler) {
          const unsub = bus.on(event, handler);
          scope.add(unsub);
          return unsub;
        },
        off(event, handler) {
          bus.off(event, handler);
        },
        emit(event, ...args) {
          bus.emit(event, ...args);
        },
      },
      services: {
        register(name, service) {
          registry.register(name, service);
          scope.add(() => registry.unregister(name));
        },
        get(name) {
          return registry.get(name);
        },
        has(name) {
          return registry.has(name);
        },
      },
    };
  }
}
