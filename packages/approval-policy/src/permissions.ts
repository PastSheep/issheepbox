/**
 * 权限目录与归一化（TASK-008）。
 *
 * v1 权限最小集合（对齐 docs/TASKS.md TASK-008 与 docs/plugin-spec-v1.md 第 3 节）：
 *  - 需用户授权的权限：files:read / files:write / network:fetch /
 *    clipboard:read / clipboard:write / shell:exec
 *  - 默认授予、无需声明的权限：storage:plugin
 *
 * 未知权限一律不授予（fail-safe），仅记日志告警。
 */
import type { PermissionId, PermissionInfo } from './types';

/** 需要用户授权的权限（v1 最小集合）。 */
export const APPROVAL_REQUIRED_PERMISSIONS: readonly PermissionId[] = [
  'files:read',
  'files:write',
  'network:fetch',
  'clipboard:read',
  'clipboard:write',
  'shell:exec',
] as const;

/** 默认授予、无需声明的权限（storage:plugin 按规范默认授予）。 */
export const DEFAULT_GRANTED_PERMISSIONS: readonly PermissionId[] = [
  'storage:plugin',
] as const;

/** 全部已知权限 = 需授权 ∪ 默认授予。 */
export const KNOWN_PERMISSIONS: readonly PermissionId[] = [
  ...APPROVAL_REQUIRED_PERMISSIONS,
  ...DEFAULT_GRANTED_PERMISSIONS,
];

/** 权限展示目录（授权 UI 渲染权限清单的数据源）。 */
const PERMISSION_CATALOG: Record<string, PermissionInfo> = {
  'files:read': {
    id: 'files:read',
    label: '读取文件',
    description: '读取用户选择/指定的文件与目录内容',
    risk: 'medium',
    requiresSecondaryConfirmation: false,
  },
  'files:write': {
    id: 'files:write',
    label: '写入文件',
    description: '写入用户选择/指定的文件与目录',
    risk: 'high',
    requiresSecondaryConfirmation: false,
  },
  'network:fetch': {
    id: 'network:fetch',
    label: '网络请求',
    description: '发起 HTTP/HTTPS 网络请求',
    risk: 'medium',
    requiresSecondaryConfirmation: false,
  },
  'clipboard:read': {
    id: 'clipboard:read',
    label: '读取剪贴板',
    description: '读取系统剪贴板内容',
    risk: 'low',
    requiresSecondaryConfirmation: false,
  },
  'clipboard:write': {
    id: 'clipboard:write',
    label: '写入剪贴板',
    description: '向系统剪贴板写入内容',
    risk: 'low',
    requiresSecondaryConfirmation: false,
  },
  'shell:exec': {
    id: 'shell:exec',
    label: '执行系统命令',
    description: '执行系统命令（高危，需要二次确认）',
    risk: 'high',
    requiresSecondaryConfirmation: true,
  },
  'storage:plugin': {
    id: 'storage:plugin',
    label: '插件私有存储',
    description: '读写插件私有存储（默认授予，无需授权）',
    risk: 'low',
    requiresSecondaryConfirmation: false,
  },
};

/** 权限是否已知（在 v1 目录中）。 */
export function isKnownPermission(permission: string): boolean {
  return KNOWN_PERMISSIONS.includes(permission as PermissionId);
}

/** 权限是否需要用户授权。 */
export function isApprovalRequired(permission: string): boolean {
  return APPROVAL_REQUIRED_PERMISSIONS.includes(permission as PermissionId);
}

/** 权限是否默认授予（无需授权）。 */
export function isDefaultGranted(permission: string): boolean {
  return DEFAULT_GRANTED_PERMISSIONS.includes(permission as PermissionId);
}

/** 取权限的展示信息；未知权限返回 undefined。 */
export function getPermissionInfo(
  permission: string,
): PermissionInfo | undefined {
  return PERMISSION_CATALOG[permission];
}

/**
 * manifest.permissions 的归一化结果。
 *
 * 声明顺序不保证稳定，这里统一去重并按目录顺序排序；
 * 未知权限单独列出（不授予），由调用方记日志告警。
 */
export interface NormalizedPermissions {
  /** 归一化后的全部声明（去重、排序，含未知）。 */
  declared: string[];
  /** 已知权限（可能被授予）。 */
  known: string[];
  /** 需要用户授权的已知权限（提示 UI 的清单）。 */
  requiringApproval: string[];
  /** 默认授予的已知权限（storage:plugin）。 */
  defaultGranted: string[];
  /** 未知权限（不授予，仅告警）。 */
  unknown: string[];
}

/**
 * 归一化 manifest.permissions。
 *
 * @param raw manifest.permissions 原始值；undefined / 非数组按空权限（[]）处理。
 */
export function normalizePermissions(raw: string[] | undefined): NormalizedPermissions {
  // 未声明 / 非法输入一律按空权限处理（规范：未声明 = 没有）。
  const input = Array.isArray(raw) ? raw : [];

  const declared = [...new Set(input)].sort();
  const known: string[] = [];
  const requiringApproval: string[] = [];
  const defaultGranted: string[] = [];
  const unknown: string[] = [];

  for (const permission of declared) {
    if (!isKnownPermission(permission)) {
      unknown.push(permission);
      continue;
    }
    known.push(permission);
    if (isApprovalRequired(permission)) {
      requiringApproval.push(permission);
    } else if (isDefaultGranted(permission)) {
      defaultGranted.push(permission);
    }
  }

  // 展示清单按目录顺序排列，保证 UI 稳定。
  requiringApproval.sort(
    (a, b) =>
      APPROVAL_REQUIRED_PERMISSIONS.indexOf(a as PermissionId) -
      APPROVAL_REQUIRED_PERMISSIONS.indexOf(b as PermissionId),
  );

  return { declared, known, requiringApproval, defaultGranted, unknown };
}
