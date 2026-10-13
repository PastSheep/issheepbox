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
import { ProfileStore } from './store';
import {
  type BootResult,
  type PermissionStore,
  type Profile,
  type ProfileSnapshot,
} from './types';

/** 默认壳插件 ID（TASK-006 实现真实 UI，这里是 fallback 占位）。 */
export const DEFAULT_SHELL_ID = 'org.issheepbox.shell-default';

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

  /** 当前 profile（内存态）。 */
  private current: Profile;
  /** 已发现的插件查找表（pluginId → LoadedPlugin）。 */
  private available = new Map<string, LoadedPlugin>();

  constructor(opts: {
    userDataDir: string;
    lifecycle: LifecycleManager;
    events: EventBusImpl;
    permissions?: PermissionStore;
  }) {
    this.store = new ProfileStore(opts.userDataDir);
    this.lifecycle = opts.lifecycle;
    this.events = opts.events;
    // opts.permissions 由 TASK-008 接入；本任务只定义接口与对接点，不实现权限逻辑。
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

    // 挂载新 profile 启用的插件。
    const enabled = this.current.enabled
      .map((id) => this.available.get(id))
      .filter((p): p is LoadedPlugin => Boolean(p));
    await this.lifecycle.mountAll(enabled);
  }

  /**
   * 启用插件：加入 enabled 列表，持久化，立即 mount。
   */
  async enable(pluginId: string): Promise<void> {
    if (this.current.enabled.includes(pluginId)) return;
    this.snapshot();
    this.current.enabled.push(pluginId);
    if (!this.current.pluginConfig[pluginId]) {
      this.current.pluginConfig[pluginId] = {};
    }
    this.save();

    const loaded = this.available.get(pluginId);
    if (loaded) {
      await this.lifecycle.mount(loaded);
    }
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

    const enabled = this.current.enabled
      .map((id) => this.available.get(id))
      .filter((p): p is LoadedPlugin => Boolean(p));
    await this.lifecycle.mountAll(enabled);
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

    const result = await this.lifecycle.mountAll(enabledPlugins);
    failures.push(...result.failures);

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
