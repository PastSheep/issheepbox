/**
 * Profile 配置类型。
 *
 * Profile = 命名组合：启用的插件 ID 列表 + 每插件配置 + 壳插件选择。
 * 对齐 docs/requirements.md 4.4。
 */

/** 一个 profile：用户的「专有工具箱」命名组合。 */
export interface Profile {
  /** profile 名称（唯一）。 */
  name: string;
  /** 当前启用的壳插件 ID。 */
  shell: string;
  /** 启用的插件 ID 列表。 */
  enabled: string[];
  /** 每插件配置：pluginId → 配置键值对。 */
  pluginConfig: Record<string, Record<string, unknown>>;
  /** 创建时间戳。 */
  createdAt: number;
  /** 最后更新时间戳。 */
  updatedAt: number;
}

/** 快照记录：升级/变更前自动保存，失败可回滚。 */
export interface ProfileSnapshot {
  /** 快照 ID（时间戳生成）。 */
  id: string;
  /** 快照对应的 profile 名称。 */
  profileName: string;
  /** 快照时的 profile 内容。 */
  profile: Profile;
  /** 快照时间戳。 */
  createdAt: number;
}

/**
 * 权限授权记录抽象接口（对接 TASK-008）。
 *
 * TASK-004 只定义接口与默认实现（全量放行），TASK-008 将替换为真实的
 * 安装授权流程。ProfileEngine 在 mount 插件前查询此接口决定是否允许。
 */
export interface PermissionStore {
  /** 插件是否被授权使用某权限。 */
  isApproved(pluginId: string, permission: string): boolean;
  /** 记录授权结果。 */
  setApproved(pluginId: string, permission: string, approved: boolean): void;
}

/** 默认 PermissionStore：全部放行（TASK-008 接入前的占位）。 */
export class PermissivePermissionStore implements PermissionStore {
  isApproved(_pluginId: string, _permission: string): boolean {
    return true;
  }
  setApproved(_pluginId: string, _permission: string, _approved: boolean): void {
    // no-op
  }
}

/** 启动结果：安全模式标志与诊断信息。 */
export interface BootResult {
  /** 当前是否处于安全模式（壳插件加载失败，回退到默认壳占位）。 */
  safeMode: boolean;
  /** 实际使用的壳插件 ID。 */
  activeShell: string;
  /** mount 失败的插件列表（失败隔离）。 */
  mountFailures: Array<{ pluginId: string; error: Error }>;
}
