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
  MountedPlugin as MountedPluginType,
  PluginContext,
  PluginManifest,
} from '../types';
import type { LoadedPlugin } from '../loader';
import { readFileSync, writeFileSync } from 'node:fs';
import { EventBusImpl } from '../events';
import { ServiceRegistryImpl } from '../services';
import { EffectScope } from '../effect-scope';
import { createLogger } from '../logger';
import { CURRENT_API_VERSION } from '../compat';
import { APPROVAL_SERVICE_NAME, type RuntimePermissionChecker } from '../profile/types';

/**
 * P-009：宿主 files 能力运行时授权门禁（fail-safe）。
 *
 * 每次 ctx.files 调用都按「本插件 manifest.id」经 services 注册表查询
 * 'approval-policy' 服务的 checkPermission(pluginId, permission)：
 *  - 服务未挂载 → 抛错拒绝（无静默放行，与 P-006 enable 门禁语义一致）；
 *  - checkPermission 返回 false（未授权 / denied / 无记录）→ 抛错拒绝。
 *
 * ctx 作用域 API 在 createScopedCtx 内闭包捕获 manifest.id，调用方无法伪造身份。
 */
function assertFilePermission(
  registry: ServiceRegistryImpl,
  pluginId: string,
  permission: string,
): void {
  if (!registry.has(APPROVAL_SERVICE_NAME)) {
    throw new Error(
      `权限门禁不可用：approval-policy 服务未挂载，按 fail-safe 拒绝插件 ${pluginId} 的 "${permission}" 请求`,
    );
  }
  const checker = registry.get<RuntimePermissionChecker>(APPROVAL_SERVICE_NAME);
  if (!checker.checkPermission(pluginId, permission)) {
    throw new Error(
      `权限不足：插件 ${pluginId} 未被授予 "${permission}"（运行时门禁拒绝）`,
    );
  }
}

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
   *  - ctx.effects.add(fn)（P-007）把第三方 service 返回的 cleanup 登记进同一 scope
   */
  private createScopedCtx(
    manifest: PluginManifest,
    scope: EffectScope,
  ): PluginContext {
    const bus = this.bus;
    const registry = this.registry;

    return {
      apiVersion: CURRENT_API_VERSION,
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
      effects: {
        add(fn: () => void) {
          // 与 events/services 自动登记的 cleanup 同 scope；
          // scope 已 dispose 时 EffectScope.add 自身幂等忽略（如 mount 失败回滚后调用）。
          scope.add(fn);
        },
      },
      files: {
        // P-009：宿主文件能力。闭包捕获 manifest.id → 每次调用自动按本插件身份过门禁；
        // 内部用 node:fs（宿主能力），插件侧仍被规范 §9.1 禁止直接使用 fs/path。
        readFile(path: string): string {
          assertFilePermission(registry, manifest.id, 'files:read');
          return readFileSync(path, 'utf8');
        },
        writeFile(path: string, content: string): void {
          assertFilePermission(registry, manifest.id, 'files:write');
          writeFileSync(path, content, 'utf8');
        },
      },
    };
  }
}
