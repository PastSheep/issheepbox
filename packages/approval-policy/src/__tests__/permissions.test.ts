/**
 * 权限目录与归一化单元测试（TASK-008）。
 *
 * 覆盖：
 *  - v1 权限最小集合完整（6 个需授权 + storage:plugin 默认授予）
 *  - manifest.permissions 缺省 / 非数组 → 空权限
 *  - 未知权限不授予
 *  - shell:exec 高危、需二次确认
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_REQUIRED_PERMISSIONS,
  DEFAULT_GRANTED_PERMISSIONS,
  getPermissionInfo,
  isApprovalRequired,
  isDefaultGranted,
  isKnownPermission,
  normalizePermissions,
} from '../permissions';

describe('权限目录（v1 最小集合）', () => {
  it('需授权的 6 个权限齐全', () => {
    expect([...APPROVAL_REQUIRED_PERMISSIONS].sort()).toEqual(
      [
        'files:read',
        'files:write',
        'network:fetch',
        'clipboard:read',
        'clipboard:write',
        'shell:exec',
      ].sort(),
    );
  });

  it('storage:plugin 为默认授予权限', () => {
    expect(DEFAULT_GRANTED_PERMISSIONS).toContain('storage:plugin');
    expect(isDefaultGranted('storage:plugin')).toBe(true);
    expect(isApprovalRequired('storage:plugin')).toBe(false);
  });

  it('每个需授权权限都有展示信息', () => {
    for (const p of APPROVAL_REQUIRED_PERMISSIONS) {
      const info = getPermissionInfo(p);
      expect(info).toBeDefined();
      expect(info!.label.length).toBeGreaterThan(0);
      expect(info!.description.length).toBeGreaterThan(0);
    }
  });

  it('shell:exec 为高危权限且需二次确认', () => {
    const info = getPermissionInfo('shell:exec')!;
    expect(info.risk).toBe('high');
    expect(info.requiresSecondaryConfirmation).toBe(true);
  });

  it('未知权限不在目录中', () => {
    expect(isKnownPermission('totally:unknown')).toBe(false);
    expect(getPermissionInfo('totally:unknown')).toBeUndefined();
  });
});

describe('normalizePermissions', () => {
  it('manifest 未声明 permissions（undefined）→ 空权限', () => {
    const norm = normalizePermissions(undefined);
    expect(norm.declared).toEqual([]);
    expect(norm.known).toEqual([]);
    expect(norm.requiringApproval).toEqual([]);
    expect(norm.unknown).toEqual([]);
  });

  it('非数组输入按空权限处理', () => {
    const norm = normalizePermissions(undefined as never);
    expect(norm.declared).toEqual([]);
  });

  it('空数组 → 空权限', () => {
    const norm = normalizePermissions([]);
    expect(norm.declared).toEqual([]);
    expect(norm.requiringApproval).toEqual([]);
  });

  it('需授权权限进入 requiringApproval', () => {
    const norm = normalizePermissions(['files:read', 'network:fetch']);
    expect(norm.requiringApproval).toEqual(['files:read', 'network:fetch']);
    expect(norm.defaultGranted).toEqual([]);
    expect(norm.unknown).toEqual([]);
  });

  it('storage:plugin 归入默认授予，不要求授权', () => {
    const norm = normalizePermissions(['storage:plugin']);
    expect(norm.defaultGranted).toEqual(['storage:plugin']);
    expect(norm.requiringApproval).toEqual([]);
  });

  it('未知权限被标记且不进入 known', () => {
    const norm = normalizePermissions(['files:read', 'hack:all']);
    expect(norm.unknown).toEqual(['hack:all']);
    expect(norm.known).toEqual(['files:read']);
  });

  it('去重并按目录顺序排列', () => {
    const norm = normalizePermissions([
      'shell:exec',
      'files:read',
      'shell:exec',
      'network:fetch',
    ]);
    expect(norm.declared).toEqual([
      'files:read',
      'network:fetch',
      'shell:exec',
    ]);
    expect(norm.requiringApproval).toEqual([
      'files:read',
      'network:fetch',
      'shell:exec',
    ]);
  });
});
