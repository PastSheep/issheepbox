/**
 * approval-policy 第一方基础设施插件入口（TASK-008）。
 *
 * 挂载（mount）时：
 *  - 创建 ApprovalPolicy 引擎（存储默认 MemoryApprovalStore；可注入）
 *  - 注册服务 `approval-policy`（授权判定服务，供安装/启用流程与运行时调用）
 *  - 订阅事件 `approval:requested`，驱动授权流程并发布 `approval:granted` /
 *    `approval:denied` 事件
 *
 * 卸载（unmount）时：服务注销、事件监听移除由内核可逆 effects 自动完成，无残留。
 *
 * 与内核的交互只走 services/events（不修改 packages/kernel 内部）：
 *  - 消费方：ctx.services.get('approval-policy')
 *  - 事件契约：见 src/events.ts 与 plugin.json contributes
 *
 * 注意：未注入 ApprovalPrompter 时使用 FailSafePrompter（默认拒绝），
 * 壳插件（TASK-006）接入真实授权 UI 前，带权限的插件不会被放行。
 */
import type { PluginContext } from '@issheepbox/kernel';
import { ApprovalPolicy } from './approval-policy';
import { APPROVAL_EVENTS, type ApprovalRequestedEvent } from './events';
import { FailSafePrompter, type ApprovalPrompter } from './prompter';
import { MemoryApprovalStore, type ApprovalStore } from './storage';

/** approval-policy 注册的服务名（消费方：ctx.services.get('approval-policy')）。 */
export const APPROVAL_SERVICE_NAME = 'approval-policy';

/** 插件挂载选项。 */
export interface ApprovalPolicyPluginOptions {
  /** 授权记录存储；缺省使用 MemoryApprovalStore（内存最小实现）。 */
  store?: ApprovalStore;
  /** 授权 UI；缺省使用 FailSafePrompter（无 UI 默认拒绝）。 */
  prompter?: ApprovalPrompter;
}

/**
 * 构造 approval-policy 插件工厂。
 *
 * 每次挂载独立创建存储（未注入时），保证多内核实例互不共享授权记录；
 * 需要跨挂载/跨重启共享记录时，注入同一个持久化 ApprovalStore。
 */
export function createApprovalPolicyPlugin(
  options: ApprovalPolicyPluginOptions = {},
): (ctx: PluginContext) => Promise<void> {
  return async (ctx: PluginContext): Promise<void> => {
    const store = options.store ?? new MemoryApprovalStore();
    const prompter = options.prompter ?? new FailSafePrompter(ctx.logger);
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

/** 默认导出：无注入选项的插件工厂（存储内存化、授权 UI 为 fail-safe 默认拒绝）。 */
export default createApprovalPolicyPlugin();

export * from './types';
export * from './permissions';
export * from './storage';
export * from './prompter';
export * from './events';
export { ApprovalPolicy } from './approval-policy';
export type { ApprovalPolicyOptions } from './approval-policy';
