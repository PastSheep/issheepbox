/**
 * approval-policy 第一方基础设施插件入口（TASK-008 + TASK-015）。
 *
 * 挂载（mount）时：
 *  - 创建 ApprovalPolicy 引擎：
 *    - store 默认接线（C3）：宿主服务 `host:user-data`（形状 `{ dir: string }`）
 *      存在 → DiskApprovalStore(dir)（approvals.json 持久化，跨重启保留）；
 *      否则 MemoryApprovalStore（进程内闭环）。显式 options.store 始终优先。
 *    - prompter 默认接线（C1）：不缓存，**每次需要弹窗时**经 ctx.services 现查
 *      `approval-ui` 服务（壳 TASK-013 注册，形状 = ApprovalPrompter），
 *      有则用之，无则 FailSafePrompter（无 UI 默认拒绝）。不依赖挂载顺序。
 *      显式 options.prompter 始终优先。
 *  - 注册服务 `approval-policy`（授权判定服务，供安装/启用流程与运行时调用）
 *  - 订阅事件 `approval:requested`，驱动授权流程并发布 `approval:granted` /
 *    `approval:denied` 事件
 *
 * 卸载（unmount）时：服务注销、事件监听移除由内核可逆 effects 自动完成，无残留。
 *
 * 与内核/其他插件的交互只走 services/events（不修改 packages/kernel 内部）：
 *  - 消费方：ctx.services.get('approval-policy')
 *  - 依赖服务：host:user-data（C3，可选）、approval-ui（C1，可选，懒解析）
 *  - 事件契约：见 src/events.ts 与 plugin.json contributes
 *
 * 注意：壳插件未挂载 / 授权 UI 未注册时，FailSafePrompter 默认拒绝，
 * 保证「无 UI 时不静默放行」；带权限插件须由用户经授权 UI 显式决策后才被放行。
 */
import type { PluginContext } from '@issheepbox/kernel';
import { ApprovalPolicy } from './approval-policy';
import { APPROVAL_EVENTS, type ApprovalRequestedEvent } from './events';
import { FailSafePrompter, type ApprovalPrompter } from './prompter';
import { MemoryApprovalStore, type ApprovalStore } from './storage';
import { DiskApprovalStore } from './storage-disk';

/** approval-policy 注册的服务名（消费方：ctx.services.get('approval-policy')）。 */
export const APPROVAL_SERVICE_NAME = 'approval-policy';

/**
 * 宿主用户数据目录服务名（批次契约 C3）。
 * 由 desktop 宿主在 kernel.start() 前注册，形状 `{ dir: string }`。
 */
export const HOST_USER_DATA_SERVICE_NAME = 'host:user-data';

/**
 * 授权 UI 服务名（批次契约 C1）。
 * 由壳（shell-default，TASK-013）注册，形状 = ApprovalPrompter。
 */
export const APPROVAL_UI_SERVICE_NAME = 'approval-ui';

/** 插件挂载选项。 */
export interface ApprovalPolicyPluginOptions {
  /**
   * 授权记录存储。显式传入则始终使用；
   * 缺省自动接线：存在 `host:user-data` 宿主服务 → DiskApprovalStore(dir)，
   * 否则 MemoryApprovalStore。
   */
  store?: ApprovalStore;
  /**
   * 授权 UI。显式传入则始终使用；
   * 缺省自动接线：每次需要弹窗时懒查 `approval-ui` 服务，
   * 无则 FailSafePrompter（无 UI 默认拒绝）。
   */
  prompter?: ApprovalPrompter;
}

/**
 * 构造 approval-policy 插件工厂。
 *
 * 默认 store 按挂载时的 ctx 现查 `host:user-data`；默认 prompter 为懒解析代理，
 * 每次弹窗前现查 `approval-ui`——二者都不依赖插件挂载顺序。
 */
export function createApprovalPolicyPlugin(
  options: ApprovalPolicyPluginOptions = {},
): (ctx: PluginContext) => Promise<void> {
  return async (ctx: PluginContext): Promise<void> => {
    const store = options.store ?? resolveDefaultStore(ctx);
    const prompter = options.prompter ?? createLazyPrompter(ctx);
    const policy = new ApprovalPolicy({ store, prompter, logger: ctx.logger });

    // 服务路径：安装/启用流程与运行时直接调用。
    ctx.services.register(APPROVAL_SERVICE_NAME, policy);

    // 事件路径：收到 approval:requested 后驱动授权流程，结果以事件广播。
    ctx.events.on(APPROVAL_EVENTS.Requested, async (payload) => {
      const request = payload as ApprovalRequestedEvent;
      const decision = await policy.requestApproval(request);
      if (decision.status === 'granted') {
        ctx.events.emit(APPROVAL_EVENTS.Granted, {
          pluginId: decision.pluginId,
          permissions: decision.permissions,
          auto: decision.auto,
        });
      } else {
        ctx.events.emit(APPROVAL_EVENTS.Denied, {
          pluginId: decision.pluginId,
          permissions: decision.permissions,
          reason: decision.reason,
        });
      }
    });

    ctx.logger.info('权限授权插件已启动（approval policy）');
  };
}

/**
 * 默认存储接线（C3）：宿主提供 `host:user-data` → 磁盘持久化；否则内存。
 * 显式 options.store 优先，不经此函数。
 */
function resolveDefaultStore(ctx: PluginContext): ApprovalStore {
  if (ctx.services.has(HOST_USER_DATA_SERVICE_NAME)) {
    const host = ctx.services.get<{ dir?: string }>(HOST_USER_DATA_SERVICE_NAME);
    if (host && typeof host.dir === 'string' && host.dir.length > 0) {
      ctx.logger.info(
        `[approval-policy] 检测到宿主用户数据目录（${HOST_USER_DATA_SERVICE_NAME}），` +
          `授权记录持久化到 ${host.dir}`,
      );
      return new DiskApprovalStore({ dir: host.dir, logger: ctx.logger });
    }
    ctx.logger.warn(
      `[approval-policy] 宿主服务 ${HOST_USER_DATA_SERVICE_NAME} 形状非法` +
        `（期望 { dir: string }），回退内存存储`,
    );
  }
  return new MemoryApprovalStore();
}

/**
 * 默认 prompter 接线（C1）：返回一个「每次弹窗前现查 approval-ui」的代理。
 *
 * - 不缓存服务实例、不依赖挂载顺序：壳后于本插件挂载时，下一次弹窗即自动用上；
 * - 服务缺失或形状异常 → FailSafePrompter（无 UI 默认拒绝，fail-safe）。
 * 显式 options.prompter 优先，不经此函数。
 */
function createLazyPrompter(ctx: PluginContext): ApprovalPrompter {
  return {
    async prompt(request) {
      if (ctx.services.has(APPROVAL_UI_SERVICE_NAME)) {
        const ui = ctx.services.get<Partial<ApprovalPrompter>>(APPROVAL_UI_SERVICE_NAME);
        if (ui && typeof ui.prompt === 'function') {
          return ui.prompt(request);
        }
        ctx.logger.warn(
          `[approval-policy] 服务 ${APPROVAL_UI_SERVICE_NAME} 形状非法` +
            `（期望 ApprovalPrompter），本次按 fail-safe 拒绝`,
        );
      }
      return new FailSafePrompter(ctx.logger).prompt(request);
    },
  };
}

/** 默认导出：无注入选项的插件工厂（按 ctx 自动接线持久化存储与授权 UI）。 */
export default createApprovalPolicyPlugin();

export * from './types';
export * from './permissions';
export * from './storage';
export * from './storage-disk';
export * from './prompter';
export * from './events';
export { ApprovalPolicy } from './approval-policy';
export type { ApprovalPolicyOptions } from './approval-policy';
export { BOOT_PATH_SOURCES, isBootPathSource } from './approval-policy';
