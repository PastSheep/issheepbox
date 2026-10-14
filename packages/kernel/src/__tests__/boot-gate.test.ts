/**
 * ProfileEngine 启动/恢复/切换路径授权门禁单元测试（TASK-013，契约 C2）。
 *
 * 真实缺陷背景（P-006 只拦显式 enable）：boot()/restore()/switchTo() 挂载
 * profile.enabled 时不做授权检查——file-stats 未授权即被启用。本文件覆盖：
 *  - boot()：带权限插件无授权服务/无记录 → 不挂载且记入 mountFailures；
 *    授权 granted 记录 → 挂载；denied 记录 → 不挂载；profile.enabled 保持不变
 *  - restore()/switchTo()：同一套门禁（source 分别为 'restore'/'switchTo'）
 *  - 无权限插件启动直通（不查询网关）
 *  - 基础设施语义：enabled 含带权限插件而 'approval-policy' 服务未挂载时，
 *    先把已发现的 approval-policy 挂载到带权限插件之前（不写入 enabled）；
 *    未发现则带权限插件 fail-safe 拒绝
 *
 * 门禁经 services 注册表按名查询 'approval-policy' 服务；本测试用 FakeGateway
 * 注册进真实 ServiceRegistryImpl，内核不依赖 @issheepbox/approval-policy 包。
 * profile 经磁盘预置（profiles/*.json），模拟「上一会话已授权并持久化进 enabled、
 * 本次启动恢复」的真实场景。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBusImpl } from '../events';
import { ServiceRegistryImpl } from '../services';
import { LifecycleManager } from '../lifecycle';
import { ProfileEngine, DEFAULT_SHELL_ID, APPROVAL_POLICY_PLUGIN_ID } from '../profile';
import {
  APPROVAL_SERVICE_NAME,
  type ApprovalDecisionLike,
  type ApprovalGateway,
  type Profile,
} from '../profile/types';
import type { LoadedPlugin } from '../loader';
import type { PluginManifest } from '../types';

const PERM_PLUGIN_ID = 'org.example.needs-files';
const PLAIN_PLUGIN_ID = 'org.example.plain';

function makeManifest(id: string, permissions?: string[]): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: '^1.0.0',
    entry: 'index.js',
    ...(permissions ? { permissions } : {}),
  };
}

function makeLoaded(id: string, permissions?: string[]): LoadedPlugin {
  return {
    dir: `/virtual/${id}`,
    manifest: makeManifest(id, permissions),
    module: { default: async () => { /* 无 mount 副作用 */ } },
  };
}

/** 可编程的授权网关：decision 可运行时改写；记录调用（pluginId, source）。 */
class FakeGateway implements ApprovalGateway {
  readonly calls: Array<{ pluginId: string; source?: string }> = [];
  constructor(public decision: ApprovalDecisionLike) {}

  async requestApprovalForManifest(
    manifest: PluginManifest,
    source?: string,
  ): Promise<ApprovalDecisionLike> {
    this.calls.push({ pluginId: manifest.id, source });
    return { ...this.decision, pluginId: manifest.id };
  }
}

interface Harness {
  userDataDir: string;
  bus: EventBusImpl;
  registry: ServiceRegistryImpl;
  lifecycle: LifecycleManager;
}

function setup(): Harness {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'isb-boot-gate-'));
  const bus = new EventBusImpl();
  const registry = new ServiceRegistryImpl();
  const lifecycle = new LifecycleManager(bus, registry);
  return { userDataDir, bus, registry, lifecycle };
}

function makeEngine(h: Harness): ProfileEngine {
  return new ProfileEngine({
    userDataDir: h.userDataDir,
    lifecycle: h.lifecycle,
    events: h.bus,
    services: h.registry,
  });
}

/** 预置磁盘 profile（模拟上一会话持久化的 enabled 列表）。 */
function seedProfile(h: Harness, name: string, enabled: string[], current = true): void {
  const profilesDir = path.join(h.userDataDir, 'profiles');
  mkdirSync(profilesDir, { recursive: true });
  const profile: Profile = {
    name,
    shell: DEFAULT_SHELL_ID,
    enabled,
    pluginConfig: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  writeFileSync(
    path.join(profilesDir, `${name}.json`),
    JSON.stringify(profile, null, 2),
    'utf8',
  );
  if (current) {
    writeFileSync(
      path.join(profilesDir, 'current.json'),
      JSON.stringify({ name }, null, 2),
      'utf8',
    );
  }
}

const granted = (): ApprovalDecisionLike => ({
  status: 'granted',
  pluginId: PERM_PLUGIN_ID,
  permissions: ['files:read'],
});
const denied = (reason = '用户拒绝授权'): ApprovalDecisionLike => ({
  status: 'denied',
  pluginId: PERM_PLUGIN_ID,
  permissions: ['files:read'],
  reason,
});

describe('ProfileEngine 启动/恢复/切换路径门禁（TASK-013）', () => {
  it('① boot：带权限插件无授权服务（approval-policy 未挂载/未发现）→ 不挂载且记入 mountFailures，profile.enabled 不变', async () => {
    const h = setup();
    seedProfile(h, 'default', [DEFAULT_SHELL_ID, PERM_PLUGIN_ID]);
    // registry 中不注册 'approval-policy'，available 中也不发现它 → fail-safe
    const engine = makeEngine(h);
    engine.setAvailablePlugins([
      makeLoaded(DEFAULT_SHELL_ID),
      makeLoaded(PERM_PLUGIN_ID, ['files:read']),
    ]);

    const boot = await engine.boot();

    expect(h.lifecycle.mountedIds).toContain(DEFAULT_SHELL_ID);
    expect(h.lifecycle.mountedIds).not.toContain(PERM_PLUGIN_ID);
    const failure = boot.mountFailures.find((f) => f.pluginId === PERM_PLUGIN_ID);
    expect(failure).toBeDefined();
    expect(failure?.error.message).toContain('启动恢复路径门禁');
    expect(failure?.error.message).toContain('boot');
    // profile.enabled 保持不动（不静默改写），用户会话内可重新授权后 enable
    expect(engine.getCurrent().enabled).toContain(PERM_PLUGIN_ID);

    await h.lifecycle.unmountAll();
  });

  it('② boot：带权限插件已有 granted 记录 → 正常挂载（source=boot）', async () => {
    const h = setup();
    const gateway = new FakeGateway(granted());
    h.registry.register(APPROVAL_SERVICE_NAME, gateway);
    seedProfile(h, 'default', [DEFAULT_SHELL_ID, PERM_PLUGIN_ID]);
    const engine = makeEngine(h);
    engine.setAvailablePlugins([
      makeLoaded(DEFAULT_SHELL_ID),
      makeLoaded(PERM_PLUGIN_ID, ['files:read']),
    ]);

    const boot = await engine.boot();

    expect(h.lifecycle.mountedIds).toContain(PERM_PLUGIN_ID);
    expect(boot.mountFailures).toHaveLength(0);
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0].pluginId).toBe(PERM_PLUGIN_ID);
    expect(gateway.calls[0].source).toBe('boot');

    await h.lifecycle.unmountAll();
  });

  it('③ boot：带权限插件有 denied 记录 → 不挂载、记入 mountFailures，profile.enabled 不变', async () => {
    const h = setup();
    const gateway = new FakeGateway(denied());
    h.registry.register(APPROVAL_SERVICE_NAME, gateway);
    seedProfile(h, 'default', [DEFAULT_SHELL_ID, PERM_PLUGIN_ID]);
    const engine = makeEngine(h);
    engine.setAvailablePlugins([
      makeLoaded(DEFAULT_SHELL_ID),
      makeLoaded(PERM_PLUGIN_ID, ['files:read']),
    ]);

    const boot = await engine.boot();

    expect(h.lifecycle.mountedIds).not.toContain(PERM_PLUGIN_ID);
    const failure = boot.mountFailures.find((f) => f.pluginId === PERM_PLUGIN_ID);
    expect(failure).toBeDefined();
    expect(failure?.error.message).toContain('用户拒绝授权');
    expect(engine.getCurrent().enabled).toContain(PERM_PLUGIN_ID);

    await h.lifecycle.unmountAll();
  });

  it('④a switchTo：切换到含带权限插件的 profile——denied 不挂载（source=switchTo），granted 挂载', async () => {
    const h = setup();
    const gateway = new FakeGateway(denied());
    h.registry.register(APPROVAL_SERVICE_NAME, gateway);
    seedProfile(h, 'default', [DEFAULT_SHELL_ID], true);
    seedProfile(h, 'alt', [DEFAULT_SHELL_ID, PERM_PLUGIN_ID], false);
    const engine = makeEngine(h);
    engine.setAvailablePlugins([
      makeLoaded(DEFAULT_SHELL_ID),
      makeLoaded(PERM_PLUGIN_ID, ['files:read']),
    ]);
    await engine.boot(); // default：仅 shell

    // denied：切换后不挂载
    await engine.switchTo('alt');
    expect(h.lifecycle.mountedIds).not.toContain(PERM_PLUGIN_ID);
    expect(engine.getLastMountFailures().some((f) => f.pluginId === PERM_PLUGIN_ID)).toBe(true);
    expect(gateway.calls.at(-1)?.source).toBe('switchTo');

    // granted：切换后挂载
    gateway.decision = granted();
    await engine.switchTo('alt');
    expect(h.lifecycle.mountedIds).toContain(PERM_PLUGIN_ID);
    expect(gateway.calls.at(-1)?.source).toBe('switchTo');

    await h.lifecycle.unmountAll();
  });

  it('④b restore：快照恢复含带权限插件的 profile——denied 不挂载（source=restore），granted 挂载', async () => {
    const h = setup();
    const gateway = new FakeGateway(denied());
    h.registry.register(APPROVAL_SERVICE_NAME, gateway);
    seedProfile(h, 'default', [DEFAULT_SHELL_ID, PERM_PLUGIN_ID], true);
    const engine = makeEngine(h);
    engine.setAvailablePlugins([
      makeLoaded(DEFAULT_SHELL_ID),
      makeLoaded(PERM_PLUGIN_ID, ['files:read']),
    ]);
    const snapshotId = engine.snapshot(); // 快照 = 当前 profile（enabled 含带权限插件）
    await engine.boot();
    expect(h.lifecycle.mountedIds).not.toContain(PERM_PLUGIN_ID); // 首次 boot：denied

    // denied 恢复：仍不挂载，记入 lastMountFailures
    await engine.restore(snapshotId);
    expect(h.lifecycle.mountedIds).not.toContain(PERM_PLUGIN_ID);
    expect(engine.getLastMountFailures().some((f) => f.pluginId === PERM_PLUGIN_ID)).toBe(true);
    expect(gateway.calls.at(-1)?.source).toBe('restore');

    // granted 恢复：挂载
    gateway.decision = granted();
    await engine.restore(snapshotId);
    expect(h.lifecycle.mountedIds).toContain(PERM_PLUGIN_ID);
    expect(gateway.calls.at(-1)?.source).toBe('restore');

    await h.lifecycle.unmountAll();
  });

  it('⑤ 无权限插件启动直通：boot/switchTo 均不查询网关、正常挂载', async () => {
    const h = setup();
    const gateway = new FakeGateway(granted());
    h.registry.register(APPROVAL_SERVICE_NAME, gateway);
    seedProfile(h, 'default', [DEFAULT_SHELL_ID, PLAIN_PLUGIN_ID], true);
    seedProfile(h, 'alt', [DEFAULT_SHELL_ID, PLAIN_PLUGIN_ID], false);
    const engine = makeEngine(h);
    engine.setAvailablePlugins([
      makeLoaded(DEFAULT_SHELL_ID),
      makeLoaded(PLAIN_PLUGIN_ID),
    ]);

    const boot = await engine.boot();
    expect(h.lifecycle.mountedIds).toContain(PLAIN_PLUGIN_ID);
    expect(boot.mountFailures).toHaveLength(0);
    expect(gateway.calls).toHaveLength(0); // 无权限插件直通，不查询网关

    await engine.switchTo('alt');
    expect(h.lifecycle.mountedIds).toContain(PLAIN_PLUGIN_ID);
    expect(gateway.calls).toHaveLength(0);

    await h.lifecycle.unmountAll();
  });

  it('⑥ 默认 profile（仅 shell）启动：不自动挂载 approval-policy 基础设施、enabled 自描述', () => {
    const h = setup();
    // 不预置任何 profile → 构造时创建默认 profile
    const engine = makeEngine(h);
    expect(engine.getCurrent().enabled).toEqual([DEFAULT_SHELL_ID]);
  });

  it('⑦ 基础设施语义：enabled 含带权限插件而 approval-policy 服务未挂载 → 先挂载已发现的 approval-policy（不写入 enabled）再门禁', async () => {
    const h = setup();
    seedProfile(h, 'default', [DEFAULT_SHELL_ID, PERM_PLUGIN_ID]);
    const engine = makeEngine(h);
    // 虚拟 approval-policy 插件：挂载时把 FakeGateway 注册为 'approval-policy' 服务
    const gateway = new FakeGateway(granted());
    const infra: LoadedPlugin = {
      dir: `/virtual/${APPROVAL_POLICY_PLUGIN_ID}`,
      manifest: makeManifest(APPROVAL_POLICY_PLUGIN_ID),
      module: {
        default: (ctx) => {
          ctx.services.register(APPROVAL_SERVICE_NAME, gateway);
        },
      },
    };
    engine.setAvailablePlugins([
      makeLoaded(DEFAULT_SHELL_ID),
      makeLoaded(PERM_PLUGIN_ID, ['files:read']),
      infra,
    ]);
    expect(h.registry.has(APPROVAL_SERVICE_NAME)).toBe(false); // 启动前服务未挂载

    const boot = await engine.boot();

    // approval-policy 作为基础设施被自动挂载（即使不在 enabled）
    expect(h.lifecycle.mountedIds).toContain(APPROVAL_POLICY_PLUGIN_ID);
    // 不写入 profile.enabled（自描述：运行态基础设施 vs 用户可见启用列表）
    expect(engine.getCurrent().enabled).not.toContain(APPROVAL_POLICY_PLUGIN_ID);
    // 授权服务就绪后门禁正常判定：granted → 带权限插件挂载
    expect(h.lifecycle.mountedIds).toContain(PERM_PLUGIN_ID);
    expect(gateway.calls[0].source).toBe('boot');
    expect(boot.mountFailures).toHaveLength(0);

    await h.lifecycle.unmountAll();
  });
});
