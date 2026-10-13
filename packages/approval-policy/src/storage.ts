/**
 * 授权记录存储抽象与最小本地实现（TASK-008）。
 *
 * ApprovalStore 是授权持久化的唯一接缝：
 *  - 本次交付使用 MemoryApprovalStore（内存实现）跑通「授权 → 记录 → 判定」闭环；
 *  - 后续与 profile 引擎（TASK-004）集成时，由 profile 引擎/宿主提供持久化实现
 *    （如把授权记录写入 profile 快照或用户数据目录），仅需实现本接口并注入。
 */

/** 授权记录状态。 */
export type ApprovalStatus = 'granted' | 'denied';

/** 一条授权记录。 */
export interface ApprovalRecord {
  /** 插件 ID。 */
  pluginId: string;
  /** granted = 用户已授权；denied = 用户已拒绝。 */
  status: ApprovalStatus;
  /** granted 时 = 实际授予的权限集合；denied 时 = []。 */
  permissions: string[];
  /** 决策时间（ISO 8601）。 */
  decidedAt: string;
  /** 拒绝原因（可选）。 */
  reason?: string;
}

/** 授权记录存储抽象接口。 */
export interface ApprovalStore {
  /** 读取某插件的授权记录；无记录返回 undefined。 */
  get(pluginId: string): ApprovalRecord | undefined;
  /** 写入/覆盖某插件的授权记录。 */
  set(record: ApprovalRecord): void;
  /** 删除某插件的授权记录（卸载/撤销时）。 */
  delete(pluginId: string): void;
  /** 列出全部授权记录。 */
  list(): ApprovalRecord[];
}

/**
 * 最小本地实现：内存存储。
 *
 * 进程内有效，满足 MVP 闭环；跨重启持久化由后续 profile 引擎集成实现。
 */
export class MemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();

  get(pluginId: string): ApprovalRecord | undefined {
    return this.records.get(pluginId);
  }

  set(record: ApprovalRecord): void {
    this.records.set(record.pluginId, record);
  }

  delete(pluginId: string): void {
    this.records.delete(pluginId);
  }

  list(): ApprovalRecord[] {
    return [...this.records.values()];
  }
}
