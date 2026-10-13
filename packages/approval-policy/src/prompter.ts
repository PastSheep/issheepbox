/**
 * 授权 UI（prompter）接口与 fail-safe 默认实现（TASK-008）。
 *
 * approval-policy 是基础设施插件，自身不渲染 UI；展示权限清单与收集用户决策
 * 由壳（TASK-006）/宿主注入的 ApprovalPrompter 完成：
 *  - prompt(request) 收到「需要用户决策的权限清单」，
 *  - 返回 grant-all / grant-subset / deny。
 *
 * 未注入 prompter（或壳尚未实现授权 UI）时使用 FailSafePrompter：
 * 默认拒绝（fail-safe），保证「无 UI 时不静默放行」，并记日志告警。
 */
import type { Logger } from '@issheepbox/kernel';
import type { ApprovalPrompter, ApprovalPromptRequest, ApprovalPromptResult } from './types';

export type { ApprovalPrompter, ApprovalPromptRequest, ApprovalPromptResult } from './types';

/** fail-safe 默认实现：无 UI 时一律拒绝。 */
export class FailSafePrompter implements ApprovalPrompter {
  constructor(private readonly logger?: Logger) {}

  async prompt(request: ApprovalPromptRequest): Promise<ApprovalPromptResult> {
    const list = request.permissions.map((p) => p.id).join(', ');
    const message =
      `插件 ${request.pluginName}（${request.pluginId}）请求权限 [${list}]，` +
      `但当前没有可用的授权 UI（ApprovalPrompter），按 fail-safe 默认拒绝。` +
      `壳插件（TASK-006）接入授权 UI 后，插件可被正常授权启用。`;
    if (this.logger) {
      this.logger.warn(message);
    }
    return { kind: 'deny' };
  }
}
