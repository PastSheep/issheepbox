/**
 * Profile 配置引擎。
 *
 * 职责（TASK-004）：
 *  - 命名组合（启用插件 ID + 每插件配置 + 壳选择）的持久化/加载/切换
 *  - 运行时启停插件并热重载（enable/disable 即时 mount/unmount）
 *  - 启动时按 profile 加载壳；失败/缺失 → 安全模式（回退默认壳占位）
 *  - 升级/变更前自动快照，可一键恢复
 *
 * 对接点：
 *  - LifecycleManager：enable/disable 时 mount/unmount 插件
 *  - EventBusImpl：emit app:profile-changed / app:safe-mode 等事件
 *  - PermissionStore（TASK-008）：mount 前查询授权，默认全量放行
 */
import type { LoadedPlugin } from '../loader';
import type { LifecycleManager } from '../lifecycle';
import type { EventBusImpl } from '../events';
import type { PluginManifest, ServiceRegistry } from '../types';
import { ProfileStore } from './store';
import {
  APPROVAL_SERVICE_NAME,
  type ApprovalDecisionLike,
  type ApprovalGateway,
  type BootResult,
  type PermissionStore,
  type Profile,
  type ProfileSnapshot,
} from './types';

/** 默认壳插件 ID（TASK-006 实现真实 UI，这里是 fallback 占位）。 */
export const DEFAULT_SHELL_ID = 'org.issheepbox.shell-default';

/**
 * approval-policy 第一方基础设施插件 ID（与 packages/approval-policy/plugin.json 对齐）。
 * TASK-013：启动/恢复/切换路径在授权服务未挂载时，先按基础设施语义挂载它以通过
 * 带权限插件门禁；挂载结果不写入 profile.enabled（enabled 列表保持自描述）。
 */
export const APPROVAL_POLICY_PLUGIN_ID = 'org.issheepbox.approval-policy';

function now(): number {
  return Date.now();
}

function makeSnapshotId(profileName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ts}-${profileName}`;
}

function createDefaultProfile(name: string): Profile {
  return {
    name,
    shell: DEFAULT_SHELL_ID,
    enabled: [DEFAULT_SHELL_ID],
    pluginConfig: { [DEFAULT_SHELL_ID]: {} },
    createdAt: now(),
    updatedAt: now(),
  };
}

export class ProfileEngine {
  private readonly store: ProfileStore;
  private readonly lifecycle: LifecycleManager;
  private readonly events: EventBusImpl;
  /**
   * 内核服务注册表（P-006）。enable() 经其按名查询 'approval-policy' 服务做授权
   * 门禁；未注入或服务未挂载时，带权限插件按 fail-safe 拒绝。
   */
  private readonly services?: ServiceRegistry;

  /** 当前 profile（内存态）。 */
  private current: Profile;
  /** 已发现的插件查找表（pluginId → LoadedPlugin）。 */
  private available = new Map<string, LoadedPlugin>();
  /**
   * 最近一次 boot()/restore()/switchTo() 的挂载失败（mountAll 失败 + 启动路径门禁拒绝）。
   * TASK-013：boot() 结果另经 BootResult.mountFailures 暴露给 UI；restore()/switchTo()
   * 无返回通道，经此 getter 供观测/测试。
   */
  private lastMountFailures: Array<{ pluginId: string; error: Error }> = [];

  constructor(opts: {
    userDataDir: string;
    lifecycle: LifecycleManager;
    events: EventBusImpl;
    permissions?: PermissionStore;
    /** P-006：内核服务注册表，enable() 据此查询 approval-policy 授权网关。 */
    services?: ServiceRegistry;
  }) {
    this.store = new ProfileStore(opts.userDataDir);
    this.lifecycle = opts.lifecycle;
    this.events = opts.events;
    this.services = opts.services;
    // opts.permissions 为 TASK-008 的旧接缝（同步单权限查询）；P-006 起授权门禁改经
    // services 注册表查询 'approval-policy' 服务的 requestApprovalForManifest（异步、
    // 可弹窗、含授权/拒绝记录复用）。保留该形参不删，避免破坏既有用方。
    void opts.permissions;

    // 初始化当前 profile：优先读磁盘，否则创建 default。
    this.current = this.bootCurrentProfile();
  }

  /** 注入已发现的插件（loader.loadAll 后调用）。 */
  setAvailablePlugins(plugins: LoadedPlugin[]): void {
    this.available = new Map(plugins.map((p) => [p.manifest.id, p]));
  }

  /** 当前 profile（只读快照）。 */
  getCurrent(): Profile {
    return { ...this.current };
  }

  /** 最近一次 boot()/restore()/switchTo() 的挂载失败（只读快照，TASK-013）。 */
  getLastMountFailures(): Array<{ pluginId: string; error: Error }> {
    return [...this.lastMountFailures];
  }

  /** 列出所有 profile 名称。 */
  listProfiles(): string[] {
    return this.store.listProfileNames();
  }

  /**
   * 创建新 profile（不切换）。
   * @param name profile 名称
   * @param template 基于哪个已有 profile 复制（默认 default）
   */
  create(name: string, template?: string): Profile {
    if (this.store.readProfile(name)) {
      throw new Error(`Profile "${name}" 已存在`);
    }
    const base = template ? this.store.readProfile(template) : null;
    const profile: Profile = base
      ? {
          ...base,
          name,
          pluginConfig: { ...base.pluginConfig },
          enabled: [...base.enabled],
          createdAt: now(),
          updatedAt: now(),
        }
      : createDefaultProfile(name);
    this.store.writeProfile(profile);
    return profile;
  }

  /** 保存当前 profile 到磁盘。 */
  save(): void {
    this.current.updatedAt = now();
    this.store.writeProfile(this.current);
    this.events.emit('app:profile-changed', { name: this.current.name });
  }

  /**
   * 切换到指定 profile（持久化指针），并按新 profile 重新挂载插件。
   */
  async switchTo(name: string): Promise<void> {
    const profile = this.store.readProfile(name);
    if (!profile) {
      throw new Error(`Profile "${name}" 不存在`);
    }
    // 先卸载所有当前插件，再按新 profile 挂载。
    await this.lifecycle.unmountAll();
    this.current = profile;
    this.store.writeCurrentName(name);
    this.events.emit('app:profile-changed', { name });

    // 挂载新 profile 启用的插件（TASK-013：带权限插件先过启动路径门禁）。
    const enabled = this.current.enabled
      .map((id) => this.available.get(id))
      .filter((p): p is LoadedPlugin => Boolean(p));
    const gated = await this.gateEnabledPlugins(enabled, 'switchTo');
    const result = await this.lifecycle.mountAll(gated.allowed);
    this.lastMountFailures = [...result.failures, ...gated.gateFailures];
  }

  /**
   * 启用插件：加入 enabled 列表，持久化，立即 mount。
   *
   * P-006：mount 前先经授权门禁（requestApprovalIfNeeded）：
   *  - 插件未声明权限 → 自动放行，不弹窗；
   *  - 带权限插件 → 经 'approval-policy' 服务 requestApprovalForManifest 判定；
   *  - granted 才加入 enabled 并 mount；denied → 直接返回，不进 enabled、
   *    不持久化、不 mount、不触发快照。
   *
   * TASK-013 补充：带权限插件门禁前若授权服务缺失而 approval-policy 已被发现，
   * 先以基础设施语义自动挂载（ensureApprovalPolicyServiceReady，不写入 enabled），
   * 否则市场安装主路径下权限清单弹不出来；未发现时维持 fail-safe 拒绝。
   */
  async enable(pluginId: string): Promise<void> {
    if (this.current.enabled.includes(pluginId)) return;
    const loaded = this.available.get(pluginId);

    // P-006 授权门禁（仅对已发现、可读到 manifest 的插件生效；未知 pluginId 维持
    // 旧行为：仅登记进 enabled，不 mount）。
    if (loaded) {
      // TASK-013 补充：带权限插件门禁前先确保授权服务就绪——市场安装主路径下全新
      // profile 仅 shell-default 在 enabled，approval-policy 未挂载，不先自动挂载的话
      // P-006 会 fail-safe 直接拒绝，权限清单永远弹不出来。
      if ((loaded.manifest.permissions ?? []).length > 0) {
        await this.ensureApprovalPolicyServiceReady();
      }
      const decision = await this.requestApprovalIfNeeded(loaded.manifest);
      if (decision.status === 'denied') {
        return;
      }
    }

    this.snapshot();
    this.current.enabled.push(pluginId);
    if (!this.current.pluginConfig[pluginId]) {
      this.current.pluginConfig[pluginId] = {};
    }
    this.save();

    if (loaded) {
      await this.lifecycle.mount(loaded);
    }
  }

  /**
   * TASK-013：授权服务就绪前置（基础设施语义）。
   *
   * 'approval-policy' 服务未挂载而已发现 APPROVAL_POLICY_PLUGIN_ID 时，先把它挂载
   * （不写入 profile.enabled——用户可见的 enabled 列表保持自描述）。enable() 显式
   * 启用带权限插件、boot/restore/switchTo 挂载带权限插件时共用此前置：
   *  - 授权服务已在场（含宿主/测试注入的实例）→ 直接复用，不重复挂载；
   *  - 未注入 services / approval-policy 未被发现 → 跳过，调用方门禁按 fail-safe 拒绝。
   */
  private async ensureApprovalPolicyServiceReady(): Promise<void> {
    if (!this.services || this.services.has(APPROVAL_SERVICE_NAME)) return;
    const infra = this.available.get(APPROVAL_POLICY_PLUGIN_ID);
    if (infra) {
      await this.lifecycle.mount(infra);
    }
  }

  /**
   * P-006：mount 前授权门禁。
   *
   * - 插件未声明权限（缺省或空数组）→ 自动放行，不弹窗。
   * - 声明了权限 → 经 services 注册表查询 'approval-policy' 服务，由其做
   *   requestApprovalForManifest 判定（含已有授权复用 / 拒绝记录复用 / 弹窗收集决策）。
   * - 授权服务不可用（未注入 services 或该服务未挂载）→ 带权限插件一律拒绝
   *   （fail-safe，无静默放行；与 TASK-008 FailSafePrompter 语义一致）。
   *
   * @param source 授权来源：enable() 显式启用（缺省）；TASK-013 启动恢复路径传
   *   'boot' / 'restore' / 'switchTo'，由 approval-policy 按来源语义处理（仅查存储）。
   */
  private async requestApprovalIfNeeded(
    manifest: PluginManifest,
    source: string = 'enable',
  ): Promise<ApprovalDecisionLike> {
    const declared = manifest.permissions ?? [];
    if (declared.length === 0) {
      return { status: 'granted', pluginId: manifest.id, permissions: [], auto: true };
    }
    if (!this.services || !this.services.has(APPROVAL_SERVICE_NAME)) {
      return {
        status: 'denied',
        pluginId: manifest.id,
        permissions: declared,
        reason: '授权服务（approval-policy）不可用，按 fail-safe 拒绝带权限插件',
      };
    }
    const gateway = this.services.get<ApprovalGateway>(APPROVAL_SERVICE_NAME);
    return gateway.requestApprovalForManifest(manifest, source);
  }

  /**
   * TASK-013：启动/恢复/切换路径挂载门禁（契约 C2）。
   *
   * 与 enable() 显式门禁同一套判定，但针对「profile.enabled 已持久化、本次启动恢复」：
   *  - 前置：enabled 中存在带权限插件而 'approval-policy' 服务未挂载时，先把已发现的
   *    APPROVAL_POLICY_PLUGIN_ID 作为基础设施挂载（不写入 profile.enabled）；未发现则
   *    带权限插件按 fail-safe 拒绝（与 P-006 一致）。
   *  - 每个带权限插件先 requestApprovalForManifest(manifest, source)：granted 才放行；
   *    denied / 无记录 / 服务不可用 → 不挂载，记入 gateFailures（error.message 写明
   *    「启动恢复路径门禁」与原因），profile.enabled 保持不变（用户可在会话内重新授权
   *    后 enable，不静默改写 profile）。
   *  - 无权限插件直通，不查询网关。
   */
  private async gateEnabledPlugins(
    plugins: LoadedPlugin[],
    source: 'boot' | 'restore' | 'switchTo',
  ): Promise<{
    allowed: LoadedPlugin[];
    gateFailures: Array<{ pluginId: string; error: Error }>;
  }> {
    // 前置：enabled 中存在带权限插件而授权服务未挂载时，先按基础设施语义挂载
    // approval-policy（不写入 enabled）；挂载失败则服务仍缺失，下方门禁按 fail-safe 拒绝。
    const hasPermissionPlugin = plugins.some(
      (p) => (p.manifest.permissions ?? []).length > 0,
    );
    if (hasPermissionPlugin) {
      await this.ensureApprovalPolicyServiceReady();
    }

    const allowed: LoadedPlugin[] = [];
    const gateFailures: Array<{ pluginId: string; error: Error }> = [];
    for (const plugin of plugins) {
      if ((plugin.manifest.permissions ?? []).length === 0) {
        allowed.push(plugin);
        continue;
      }
      const decision = await this.requestApprovalIfNeeded(plugin.manifest, source);
      if (decision.status === 'granted') {
        allowed.push(plugin);
        continue;
      }
      gateFailures.push({
        pluginId: plugin.manifest.id,
        error: new Error(
          `启动恢复路径门禁（${source}）：插件 ${plugin.manifest.id} 未授权，本次不挂载。` +
            `原因：${decision.reason ?? '无授权记录或已被拒绝'}`,
        ),
      });
    }
    return { allowed, gateFailures };
  }

  /**
   * 禁用插件：从 enabled 移除，持久化，立即 unmount。
   */
  async disable(pluginId: string): Promise<void> {
    if (!this.current.enabled.includes(pluginId)) return;
    this.snapshot();
    this.current.enabled = this.current.enabled.filter((id) => id !== pluginId);
    this.save();
    await this.lifecycle.unmount(pluginId);
  }

  /** 创建当前 profile 的快照（变更前自动调用）。 */
  snapshot(): string {
    const id = makeSnapshotId(this.current.name);
    const snapshot: ProfileSnapshot = {
      id,
      profileName: this.current.name,
      profile: { ...this.current, pluginConfig: { ...this.current.pluginConfig } },
      createdAt: now(),
    };
    this.store.writeSnapshot(snapshot);
    return id;
  }

  /** 列出所有快照 ID。 */
  listSnapshots(): string[] {
    return this.store.listSnapshotIds();
  }

  /** 从快照恢复当前 profile，并按恢复后的状态重新挂载插件。 */
  async restore(snapshotId: string): Promise<Profile> {
    const snapshot = this.store.readSnapshot(snapshotId);
    if (!snapshot) {
      throw new Error(`快照 "${snapshotId}" 不存在`);
    }
    await this.lifecycle.unmountAll();
    this.current = { ...snapshot.profile };
    this.store.writeProfile(this.current);
    this.store.writeCurrentName(this.current.name);
    this.events.emit('app:profile-restored', { snapshotId });

    // TASK-013：恢复路径同样过启动门禁（source='restore'）。
    const enabled = this.current.enabled
      .map((id) => this.available.get(id))
      .filter((p): p is LoadedPlugin => Boolean(p));
    const gated = await this.gateEnabledPlugins(enabled, 'restore');
    const result = await this.lifecycle.mountAll(gated.allowed);
    this.lastMountFailures = [...result.failures, ...gated.gateFailures];
    return this.current;
  }

  /**
   * 启动时按当前 profile 挂载启用的插件，处理壳 fallback。
   *
   * 由 kernel.start() 调用。
   */
  async boot(): Promise<BootResult> {
    const failures: Array<{ pluginId: string; error: Error }> = [];
    const enabledPlugins = this.current.enabled
      .map((id) => this.available.get(id))
      .filter((p): p is LoadedPlugin => Boolean(p));

    // TASK-013：启动路径门禁（契约 C2）——带权限插件先 requestApprovalForManifest
    // （source='boot'），未授权不挂载并记入 mountFailures；profile.enabled 保持不变。
    const gated = await this.gateEnabledPlugins(enabledPlugins, 'boot');
    const result = await this.lifecycle.mountAll(gated.allowed);
    failures.push(...result.failures);
    failures.push(...gated.gateFailures);
    this.lastMountFailures = [...failures];

    // 壳 fallback：检查 profile.shell 是否成功 mount。
    const shellMounted = this.lifecycle.mountedIds.includes(this.current.shell);
    let safeMode = false;
    let activeShell = this.current.shell;

    if (!shellMounted) {
      safeMode = true;
      activeShell = DEFAULT_SHELL_ID;
      this.events.emit('app:safe-mode', {
        reason: `壳插件 "${this.current.shell}" 未加载，回退默认壳`,
      });
    }

    return { safeMode, activeShell, mountFailures: failures };
  }

  /** 初始化：读当前 profile，若不存在则创建 default。 */
  private bootCurrentProfile(): Profile {
    const name = this.store.readCurrentName();
    if (name) {
      const profile = this.store.readProfile(name);
      if (profile) return profile;
    }
    // 首次启动：创建 default profile。
    const def = createDefaultProfile('default');
    this.store.writeProfile(def);
    this.store.writeCurrentName('default');
    return def;
  }
}
