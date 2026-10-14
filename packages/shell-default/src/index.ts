/**
 * Is Sheep Box 默认宿主壳插件（shell-default）。
 *
 * 职责（TASK-006 + TASK-013）：
 *  - 作为 DEFAULT_SHELL_ID，被 ProfileEngine.boot() 第一个挂载
 *  - 订阅内核事件（profile 变更 / 安全模式 / 快照恢复），触发 UI 刷新信号
 *  - 注册 shell:ui service，为后续插件提供面板 seam（P-007 可逆注册）
 *  - 注册 approval-ui service（契约 C1）：把 approval-policy 的授权请求经内核事件
 *    approval:ui-request 发给宿主桥（desktop 渲染进程弹权限清单对话框），
 *    等 approval:ui-response 回决策；超时/无人响应按 fail-safe 拒绝
 *
 * 边界：
 *  - 本插件运行于主进程（Node.js），不直接操作 DOM
 *  - 渲染由 Electron 渲染进程负责；本插件通过 EventBus 发信号，
 *    desktop 主进程桥接到 IPC → preload → 渲染进程
 *  - ctx 只使用 v1 已定稿接口面（manifest / events / services / effects / logger）
 *  - 不运行时依赖 @issheepbox/approval-policy：approval-ui 服务的请求/结果形状以
 *    本地结构类型对齐（仿 kernel 的 ApprovalDecisionLike 先例）；permissions 元素
 *    已是 PermissionInfo[]（含中文 label/description/risk，由 approval-policy 构造）
 */
import type { PluginContext } from '@issheepbox/kernel';

/** shell:ui service seam（供后续插件注册面板入口）。 */
export interface ShellUiService {
  /**
   * 注册一个面板入口（占位，TASK-006 仅记录，不实现 UI 挂载）。
   *
   * P-007：返回 unregister 函数——注册方（如 note）应把它登记进自身 ctx.effects，
   * 插件卸载时随 effect scope 自动回滚面板记录（规范 §5.2「卸载无残留」契约）。
   * 重复注册同一 panelId 时，每次返回的 unregister 只撤销本次注册产生的条目。
   */
  registerPanel: (panelId: string, title: string) => () => void;
  /** 已注册面板列表。 */
  panels: Array<{ id: string; title: string }>;
}

// ---------------------------------------------------------------------------
// approval-ui（契约 C1）：以下结构类型与 @issheepbox/approval-policy 的
// ApprovalPrompter / ApprovalPromptRequest / ApprovalPromptResult / PermissionInfo
// 形状对齐；本插件不 import 该包（插件间不直接引用，经 services/events 协作）。
// ---------------------------------------------------------------------------

/** 单一权限展示信息（形状对齐 approval-policy 的 PermissionInfo，由其权限目录构造）。 */
interface UiPermissionInfo {
  id: string;
  label: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  requiresSecondaryConfirmation: boolean;
}

/** 授权提示请求（形状对齐 approval-policy 的 ApprovalPromptRequest）。 */
interface ApprovalUiPromptRequest {
  pluginId: string;
  pluginName: string;
  /** 需要用户决策的权限清单（含展示信息，中文 label/用途/风险由 approval-policy 提供）。 */
  permissions: UiPermissionInfo[];
}

/** 用户对权限清单的决策（形状对齐 approval-policy 的 ApprovalPromptResult）。 */
type ApprovalUiPromptResult =
  | { kind: 'grant-all' }
  | { kind: 'grant-subset'; permissions: string[] }
  | { kind: 'deny' };

/** approval-ui service（形状对齐 approval-policy 的 ApprovalPrompter，契约 C1）。 */
export interface ApprovalUiService {
  prompt(request: ApprovalUiPromptRequest): Promise<ApprovalUiPromptResult>;
}

/** approval:ui-request 事件载荷（C1：壳 → 宿主桥）。 */
interface ApprovalUiRequestPayload {
  /** 唯一标识本次请求，response 按此 token 关联。 */
  token: string;
  pluginId: string;
  pluginName: string;
  permissions: UiPermissionInfo[];
}

/** approval:ui-response 事件载荷（C1：宿主桥 → 壳）。 */
interface ApprovalUiResponsePayload {
  token: string;
  result: ApprovalUiPromptResult;
}

interface ProfileChangedPayload { name: string }
interface SafeModePayload { reason: string }
interface RestoredPayload { snapshotId: string }

/**
 * 授权提示超时（ms）。桌面桥未接 / 无人响应时不得悬挂授权门禁，超时按 fail-safe
 * 拒绝（与 FailSafePrompter「无 UI 不静默放行」语义一致）。
 */
const APPROVAL_UI_TIMEOUT_MS = 120_000;

export default function shellDefault(ctx: PluginContext): void {
  ctx.logger.info('默认壳已挂载');

  // 注册 shell:ui service：面板 seam，供其他插件贡献 UI 区域。
  const panels: Array<{ id: string; title: string }> = [];
  const uiService: ShellUiService = {
    panels,
    registerPanel(panelId, title) {
      // P-007：面板记录本身是壳的宿主侧状态，内核无法自动跟踪第三方 service 的
      // 注册动作——因此返回 unregister，由注册方经 ctx.effects.add 挂进自身 scope。
      const panel = { id: panelId, title };
      panels.push(panel);
      ctx.events.emit('shell:ui-refresh', { reason: 'panel-registered', panelId });
      return () => {
        // 按对象引用精确移除本次注册的条目（容忍重复 panelId），并触发刷新。
        const idx = panels.indexOf(panel);
        if (idx !== -1) panels.splice(idx, 1);
        ctx.events.emit('shell:ui-refresh', { reason: 'panel-unregistered', panelId });
      };
    },
  };
  ctx.services.register('shell:ui', uiService);

  // —— approval-ui service（契约 C1，TASK-013）——
  // 经内核事件往返：发 approval:ui-request → 宿主桥弹权限清单对话框 →
  // 回 approval:ui-response（按 token 关联）→ 返回用户决策。
  const pending = new Map<
    string,
    { resolve: (result: ApprovalUiPromptResult) => void; timer: NodeJS.Timeout }
  >();
  let tokenSeq = 0;

  ctx.events.on('approval:ui-response', (...args: unknown[]) => {
    const payload = args[0] as ApprovalUiResponsePayload | undefined;
    if (!payload || typeof payload.token !== 'string' || !payload.result) return;
    const entry = pending.get(payload.token);
    if (!entry) return; // 过期/伪造 token：忽略（已超时或未发起）
    clearTimeout(entry.timer);
    pending.delete(payload.token);
    entry.resolve(payload.result);
  });

  const approvalUi: ApprovalUiService = {
    prompt(request: ApprovalUiPromptRequest): Promise<ApprovalUiPromptResult> {
      return new Promise<ApprovalUiPromptResult>((resolve) => {
        tokenSeq += 1;
        const token = `approval-ui-${Date.now()}-${tokenSeq}`;
        const timer = setTimeout(() => {
          pending.delete(token);
          ctx.logger.warn(
            `授权 UI 超时（${APPROVAL_UI_TIMEOUT_MS}ms）未收到 approval:ui-response，` +
              `fail-safe 拒绝插件 ${request.pluginId}（${request.pluginName}）的授权请求`,
          );
          resolve({ kind: 'deny' });
        }, APPROVAL_UI_TIMEOUT_MS);
        pending.set(token, { resolve, timer });
        const payload: ApprovalUiRequestPayload = {
          token,
          pluginId: request.pluginId,
          pluginName: request.pluginName,
          permissions: request.permissions,
        };
        ctx.events.emit('approval:ui-request', payload);
      });
    },
  };
  ctx.services.register('approval-ui', approvalUi);

  // 卸载兜底（P-007 可逆 effects）：壳卸载时若有在途授权请求，按 fail-safe 拒绝，
  // 并清理定时器，避免悬挂的 setTimeout 阻止退出。
  ctx.effects.add(() => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ kind: 'deny' });
    }
    pending.clear();
  });

  // 订阅内核事件：profile 变更、安全模式、快照恢复时触发 UI 刷新。
  ctx.events.on('app:profile-changed', (...args: unknown[]) => {
    const payload = args[0] as ProfileChangedPayload;
    ctx.logger.info(`profile 变更: ${payload.name}`);
    ctx.events.emit('shell:ui-refresh', { reason: 'profile-changed', name: payload.name });
  });

  ctx.events.on('app:safe-mode', (...args: unknown[]) => {
    const payload = args[0] as SafeModePayload;
    ctx.logger.warn(`进入安全模式: ${payload.reason}`);
    ctx.events.emit('shell:ui-refresh', { reason: 'safe-mode', detail: payload.reason });
  });

  ctx.events.on('app:profile-restored', (...args: unknown[]) => {
    const payload = args[0] as RestoredPayload;
    ctx.logger.info(`从快照恢复: ${payload.snapshotId}`);
    ctx.events.emit('shell:ui-refresh', { reason: 'profile-restored', snapshotId: payload.snapshotId });
  });

  // 挂载完成时发一次初始刷新信号。
  ctx.events.emit('shell:ui-refresh', { reason: 'shell-mounted' });
}
