/**
 * 授权判定引擎（approval policy，TASK-008）。
 *
 * 职责：
 *  - 解析 manifest.permissions（缺省按空权限）
 *  - 需要授权的权限 → 通过 ApprovalPrompter 向用户展示权限清单，收集决策
 *  - 决策（granted / denied）写入 ApprovalStore
 *  - 对外暴露授权判定服务：requestApproval / checkPermission / isApproved 等
 *
 * 语义（对齐 docs/plugin-spec-v1.md 第 7 节）：
 *  - 未声明 = 没有：空权限清单自动通过，无需用户介入
 *  - 用户拒绝（deny）→ 插件不可启用；拒绝记录持久化，避免反复打扰，
 *    调用方可在用户重新申请时先 revoke() 再 requestApproval()
 *  - 已授权且覆盖本次全部声明 → 自动复用，不重复提示
 *  - 未知权限一律不授予（fail-safe），仅记日志告警
 *  - 运行时越权调用由消费方通过 checkPermission() 拒绝
 */
import type { Logger, PluginManifest } from '@issheepbox/kernel';
import type { ApprovalStore } from './storage';
import type {
  ApprovalDecision,
  ApprovalPromptRequest,
  ApprovalPrompter,
  ApprovalRequest,
} from './types';
import {
  getPermissionInfo,
  isDefaultGranted,
  normalizePermissions,
} from './permissions';

/**
 * 启动恢复路径来源（批次契约 C2）：kernel ProfileEngine 的 boot / restore /
 * switchTo 在挂载带权限插件前调用 requestApprovalForManifest(manifest, source)。
 * 这些来源下不弹窗（启动期无交互上下文），仅查存储做门禁。
 */
export const BOOT_PATH_SOURCES = new Set(['boot', 'restore', 'switchTo']);

/** source 是否属于启动恢复路径（boot/restore/switchTo）。 */
export function isBootPathSource(source: string | undefined): boolean {
  return source !== undefined && BOOT_PATH_SOURCES.has(source);
}

/** ApprovalPolicy 构造选项。 */
export interface ApprovalPolicyOptions {
  /** 授权记录存储（最小实现：MemoryApprovalStore；后续可注入 profile 引擎实现）。 */
  store: ApprovalStore;
  /** 授权 UI（展示权限清单、收集用户决策）。 */
  prompter: ApprovalPrompter;
  /** 日志（可选；未提供则静默）。 */
  logger?: Logger;
}

/**
 * 授权判定服务实现。
 *
 * 插件通过 ctx.services.register('approval-policy', policy) 暴露给其他插件与宿主；
 * 安装/启用流程（市场客户端、profile 引擎、壳 UI）调用其方法完成授权闭环。
 */
export class ApprovalPolicy {
  private readonly store: ApprovalStore;
  private readonly prompter: ApprovalPrompter;
  private readonly logger?: Logger;

  constructor(options: ApprovalPolicyOptions) {
    this.store = options.store;
    this.prompter = options.prompter;
    this.logger = options.logger;
  }

  /**
   * 请求一次授权：解析权限 → （必要时）向用户展示清单 → 记录决策并返回。
   *
   * 返回 granted：插件可以启用（permissions 为实际授予集合）；
   * 返回 denied：用户已拒绝，调用方不得启用该插件。
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const { pluginId, pluginName, source } = request;
    const norm = normalizePermissions(request.permissions);

    if (norm.unknown.length > 0) {
      this.logger?.warn(
        `[approval-policy] 插件 ${pluginId} 声明了未知权限：${norm.unknown.join(', ')}，` +
          `按 fail-safe 一律不授予`,
      );
    }

    // 已有授权且覆盖本次全部已知声明 → 自动复用，不重复打扰用户。
    const existing = this.store.get(pluginId);
    if (
      existing?.status === 'granted' &&
      norm.known.every((p) => existing.permissions.includes(p))
    ) {
      return {
        status: 'granted',
        pluginId,
        permissions: existing.permissions,
        auto: true,
      };
    }

    // 已有拒绝记录 → 维持拒绝（不重复弹窗）；用户重新申请时先 revoke()。
    if (existing?.status === 'denied') {
      return {
        status: 'denied',
        pluginId,
        permissions: norm.requiringApproval,
        reason: existing.reason ?? '用户此前已拒绝授权（可撤销后重新申请）',
      };
    }

    // 启动恢复路径（boot/restore/switchTo，C2 契约）：仅查存储、不弹窗、不写新记录。
    // 走到这里说明既无「granted 覆盖」也无「denied 记录」——
    // 即无记录，或 granted 记录未覆盖全部需授权权限 → fail-safe 拒绝。
    // 关键：这里绝不 store.set()，否则会把用户尚未决策的插件永久锁死在 denied。
    if (isBootPathSource(source)) {
      // 空权限插件直通（与显式 enable 语义一致：无权限插件启动不拦）。
      if (norm.requiringApproval.length === 0) {
        return {
          status: 'granted',
          pluginId,
          permissions: norm.known,
          auto: true,
        };
      }
      this.logger?.info(
        `[approval-policy] 插件 ${pluginId}（${pluginName}）在启动路径（${source}）` +
          `下无有效授权记录，不弹窗，按 fail-safe 拒绝挂载`,
      );
      return {
        status: 'denied',
        pluginId,
        permissions: norm.requiringApproval,
        reason:
          `启动路径（${source}）未授权：启动时不弹窗，按 fail-safe 拒绝挂载；` +
          `请在安装/启用流程显式完成授权后，授权记录即被启动路径自动复用`,
      };
    }

    // 无需授权的权限（空权限 / 仅 storage:plugin）→ 自动通过。
    if (norm.requiringApproval.length === 0) {
      this.recordGrant(pluginId, norm.known);
      return { status: 'granted', pluginId, permissions: norm.known, auto: true };
    }

    // 需要用户授权：向 UI 展示权限清单并收集决策。
    const promptRequest: ApprovalPromptRequest = {
      pluginId,
      pluginName,
      permissions: norm.requiringApproval
        .map((p) => getPermissionInfo(p))
        .filter((info): info is NonNullable<typeof info> => info !== undefined),
    };
    this.logger?.info(
      `[approval-policy] 请求用户为插件 ${pluginName}（${pluginId}）授权权限：` +
        `${norm.requiringApproval.join(', ')}（来源：${source ?? 'unknown'}）`,
    );

    const result = await this.prompter.prompt(promptRequest);

    if (result.kind === 'deny') {
      this.store.set({
        pluginId,
        status: 'denied',
        permissions: [],
        decidedAt: new Date().toISOString(),
        reason: '用户拒绝授权',
      });
      return {
        status: 'denied',
        pluginId,
        permissions: norm.requiringApproval,
        reason: '用户拒绝授权',
      };
    }

    const grantedPermissions =
      result.kind === 'grant-all'
        ? norm.known
        : this.computeSubsetGrant(
            norm.defaultGranted,
            norm.requiringApproval,
            result.permissions,
          );
    this.recordGrant(pluginId, grantedPermissions);
    return {
      status: 'granted',
      pluginId,
      permissions: grantedPermissions,
      auto: false,
    };
  }

  /**
   * 便捷入口：直接传入插件 manifest，自动提取 permissions 并构造授权请求。
   *
   * manifest.permissions 缺省（undefined）时按空权限处理（规范：未声明 = 没有）。
   */
  async requestApprovalForManifest(
    manifest: PluginManifest,
    source?: string,
  ): Promise<ApprovalDecision> {
    return this.requestApproval({
      pluginId: manifest.id,
      pluginName: manifest.name,
      permissions: manifest.permissions ?? [],
      source,
    });
  }

  /**
   * 运行时权限校验：插件能否使用某权限。
   *
   * 默认授予权限（storage:plugin）恒为 true；其余权限要求存在 granted 记录
   * 且包含该权限。无记录 / denied / 未授权的权限一律 false（fail-safe）。
   */
  checkPermission(pluginId: string, permission: string): boolean {
    if (isDefaultGranted(permission)) return true;
    const record = this.store.get(pluginId);
    return record?.status === 'granted' && record.permissions.includes(permission);
  }

  /** 插件是否已获授权（存在 granted 记录）。 */
  isApproved(pluginId: string): boolean {
    return this.store.get(pluginId)?.status === 'granted';
  }

  /** 插件实际获得的权限集合（无记录返回空数组）。 */
  getGrantedPermissions(pluginId: string): string[] {
    const record = this.store.get(pluginId);
    return record?.status === 'granted' ? [...record.permissions] : [];
  }

  /** 是否存在授权记录（granted 或 denied）。 */
  hasDecision(pluginId: string): boolean {
    return this.store.get(pluginId) !== undefined;
  }

  /**
   * 撤销授权记录（卸载插件 / 用户重新申请授权前调用）。
   * 撤销后该插件不再处于已授权状态。
   */
  revoke(pluginId: string): void {
    this.store.delete(pluginId);
  }

  /** 写入 granted 记录。 */
  private recordGrant(pluginId: string, permissions: string[]): void {
    this.store.set({
      pluginId,
      status: 'granted',
      permissions,
      decidedAt: new Date().toISOString(),
    });
  }

  /**
   * 部分授权：默认授予部分 + 用户勾选的需授权权限。
   * 仅接受本次请求清单（requiringApproval）内的权限，防止 UI 传入清单外的 ID。
   */
  private computeSubsetGrant(
    defaultGranted: string[],
    requiringApproval: string[],
    selected: string[],
  ): string[] {
    const requiring = new Set(requiringApproval);
    const granted = new Set<string>(defaultGranted);
    for (const permission of selected) {
      if (requiring.has(permission)) granted.add(permission);
    }
    return [...granted].sort();
  }
}
