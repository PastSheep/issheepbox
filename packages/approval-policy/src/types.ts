/**
 * approval-policy 公共领域类型（TASK-008）。
 *
 * 语义对齐 docs/plugin-spec-v1.md 第 7 节权限声明：
 *  - 未声明 = 没有；manifest.permissions 缺省按空权限处理
 *  - 安装/启用时展示权限清单，用户可全部授权 / 部分拒绝 / 全部拒绝
 *  - shell:exec 为高危权限，UI 侧需二次确认（见 PermissionInfo.requiresSecondaryConfirmation）
 */

/** 权限 ID。v1 为粗粒度字符串；后续版本可能细化为 `network:fetch:https://...` 形态。 */
export type PermissionId = string;

/** 单一权限的展示信息（供授权 UI 渲染权限清单）。 */
export interface PermissionInfo {
  /** 权限 ID，如 files:read。 */
  id: PermissionId;
  /** 展示名（用户可见）。 */
  label: string;
  /** 用途说明（用户可见）。 */
  description: string;
  /** 风险等级，用于 UI 分级展示。 */
  risk: 'low' | 'medium' | 'high';
  /** 是否需二次确认（shell:exec 等高危权限由授权 UI 负责二次确认）。 */
  requiresSecondaryConfirmation: boolean;
}

/** 一次授权请求（由安装/启用流程构造）。 */
export interface ApprovalRequest {
  /** 插件 ID（manifest.id）。 */
  pluginId: string;
  /** 插件展示名（manifest.name）。 */
  pluginName: string;
  /** 插件声明的权限列表（manifest.permissions；缺省已归一化为 []）。 */
  permissions: string[];
  /** 请求来源标注，如 install / enable，便于日志与 UI 提示。 */
  source?: string;
}

/** 授权判定结果：granted = 插件可启用；denied = 插件不可启用。 */
export type ApprovalDecision =
  | {
      status: 'granted';
      pluginId: string;
      /** 实际授予的权限集合（含默认授予部分；部分授权时为用户授权的子集）。 */
      permissions: string[];
      /** true = 无需用户介入自动通过（空权限/默认权限/已有授权覆盖）。 */
      auto: boolean;
    }
  | {
      status: 'denied';
      pluginId: string;
      /** 本次被拒绝的、需要授权的权限清单（用户可见）。 */
      permissions: string[];
      reason?: string;
    };

/** 授权 UI（prompter）收到的提示请求。 */
export interface ApprovalPromptRequest {
  pluginId: string;
  pluginName: string;
  /** 需要用户决策的权限清单（含展示信息，按目录顺序排列）。 */
  permissions: PermissionInfo[];
}

/** 用户对权限清单的决策。 */
export type ApprovalPromptResult =
  | { kind: 'grant-all' }
  | { kind: 'grant-subset'; permissions: string[] }
  | { kind: 'deny' };

/** 授权 UI 提供方（壳/宿主注入；见 prompter.ts 的 FailSafePrompter 默认实现）。 */
export interface ApprovalPrompter {
  prompt(request: ApprovalPromptRequest): Promise<ApprovalPromptResult>;
}
