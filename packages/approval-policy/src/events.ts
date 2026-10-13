/**
 * 权限授权事件契约（TASK-008）。
 *
 * 命名对齐 docs/plugin-spec-v1.md 第 4.2 节：`命名空间:动作`。
 *
 * 入向事件（approval-policy 订阅）：
 *  - approval:requested —— 安装/启用流程（市场客户端 TASK-007 / profile 引擎
 *    TASK-004）请求授权时发布；approval-policy 据此驱动授权流程。
 *
 * 出向事件（approval-policy 发布）：
 *  - approval:granted —— 授权通过（含空权限自动通过），请求方可以继续启用插件；
 *  - approval:denied   —— 用户拒绝，请求方必须中止启用插件。
 *
 * 事件载荷字段在代码中定义类型，与 docs/plugin-spec-v1.md 第 3 节 contributes
 * 声明保持一致。
 */

/** 事件名常量。 */
export const APPROVAL_EVENTS = {
  /** 安装/启用流程请求授权（入向）。 */
  Requested: 'approval:requested',
  /** 授权通过（出向）。 */
  Granted: 'approval:granted',
  /** 用户拒绝（出向）。 */
  Denied: 'approval:denied',
} as const;

/** approval:requested 载荷。 */
export interface ApprovalRequestedEvent {
  pluginId: string;
  pluginName: string;
  /** 插件声明的权限列表（manifest.permissions）。 */
  permissions: string[];
  /** 请求来源标注：install / enable 等。 */
  source?: string;
}

/** approval:granted 载荷。 */
export interface ApprovalGrantedEvent {
  pluginId: string;
  /** 实际授予的权限集合。 */
  permissions: string[];
  /** true = 自动通过（空权限/默认权限/已有授权覆盖）。 */
  auto?: boolean;
}

/** approval:denied 载荷。 */
export interface ApprovalDeniedEvent {
  pluginId: string;
  /** 被拒绝的、需要授权的权限清单。 */
  permissions: string[];
  reason?: string;
}
