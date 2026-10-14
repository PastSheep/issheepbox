/**
 * ProfileEngine.enable 授权门禁单元测试（P-006）。
 *
 * 覆盖（对齐任务书要求）：
 *  - granted：带权限插件经 approval-policy 网关判定 granted → 进 enabled 并 mount
 *  - denied：带权限插件被拒 → 不进 enabled、未 mount、不产生快照
 *  - 无权限（缺省/空数组）插件：自动放行、不弹窗、正常 mount
 *  - approval-policy 服务不可用（未挂载 / 未注入 services）：带权限插件 fail-safe 拒绝
 *
 * 门禁经 services 注册表按名查询 'approval-policy' 服务；本测试用 FakeGateway
 * 注册进真实 ServiceRegistryImpl，内核不依赖 @issheepbox/approval-policy 包。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBusImpl } from '../events';
import { ServiceRegistryImpl } from '../services';
import { LifecycleManager } from '../lifecycle';
import { ProfileEngine } from '../profile';
import {
  APPROVAL_SERVICE_NAME,
  type ApprovalDecisionLike,
  type ApprovalGateway,
} from '../profile/types';
import type { LoadedPlugin } from '../loader';
import type { PluginManifest } from '../types';

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

/** 可编程的授权网关：按预设决策返回，并记录调用。 */
class FakeGateway implements ApprovalGateway {
  readonly calls: Array<{ pluginId: string; source?: string }> = [];
  constructor(private readonly decision: ApprovalDecisionLike) {}

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
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'isb-profile-p006-'));
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

describe('ProfileEngine.enable 授权门禁（P-006）', () => {
  it('granted：带权限插件经网关授权后进 enabled 并 mount', async () => {
    const h = setup();
    const gateway = new FakeGateway({
      status: 'granted',
      pluginId: 'x',
      permissions: ['files:read'],
    });
    h.registry.register(APPROVAL_SERVICE_NAME, gateway);
    const engine = makeEngine(h);
    const plugin = makeLoaded('org.example.needs-files', ['files:read']);
    engine.setAvailablePlugins([plugin]);

    await engine.enable('org.example.needs-files');

    expect(engine.getCurrent().enabled).toContain('org.example.needs-files');
    expect(h.lifecycle.mountedIds).toContain('org.example.needs-files');
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0].source).toBe('enable');

    await h.lifecycle.unmountAll();
  });

  it('denied：带权限插件被拒 → 不进 enabled、未 mount、不产生快照', async () => {
    const h = setup();
    const gateway = new FakeGateway({
      status: 'denied',
      pluginId: 'x',
      permissions: ['files:read'],
      reason: '用户拒绝授权',
    });
    h.registry.register(APPROVAL_SERVICE_NAME, gateway);
    const engine = makeEngine(h);
    const plugin = makeLoaded('org.example.needs-files', ['files:read']);
    engine.setAvailablePlugins([plugin]);

    await engine.enable('org.example.needs-files');

    expect(engine.getCurrent().enabled).not.toContain('org.example.needs-files');
    expect(h.lifecycle.mountedIds).not.toContain('org.example.needs-files');
    // 拒绝路径不得触发变更前快照（无快照侧漏）
    expect(engine.listSnapshots()).toHaveLength(0);
    expect(gateway.calls).toHaveLength(1);
  });

  it('无权限插件（空数组）自动放行：不查询网关、直接进 enabled 并 mount', async () => {
    const h = setup();
    // 故意不注册任何网关服务
    const engine = makeEngine(h);
    const plugin = makeLoaded('org.example.ui-only', []);
    engine.setAvailablePlugins([plugin]);

    await engine.enable('org.example.ui-only');

    expect(engine.getCurrent().enabled).toContain('org.example.ui-only');
    expect(h.lifecycle.mountedIds).toContain('org.example.ui-only');

    await h.lifecycle.unmountAll();
  });

  it('无权限插件（缺省 permissions 字段）自动放行：mount 正常', async () => {
    const h = setup();
    const engine = makeEngine(h);
    const plugin = makeLoaded('org.example.ui-legacy'); // 不传 permissions
    engine.setAvailablePlugins([plugin]);

    await engine.enable('org.example.ui-legacy');

    expect(engine.getCurrent().enabled).toContain('org.example.ui-legacy');
    expect(h.lifecycle.mountedIds).toContain('org.example.ui-legacy');

    await h.lifecycle.unmountAll();
  });

  it('approval-policy 服务未挂载：带权限插件 fail-safe 拒绝（无静默放行）', async () => {
    const h = setup();
    // registry 中不注册 'approval-policy'
    const engine = makeEngine(h);
    const plugin = makeLoaded('org.example.needs-files', ['files:read']);
    engine.setAvailablePlugins([plugin]);

    await engine.enable('org.example.needs-files');

    expect(engine.getCurrent().enabled).not.toContain('org.example.needs-files');
    expect(h.lifecycle.mountedIds).not.toContain('org.example.needs-files');
    expect(engine.listSnapshots()).toHaveLength(0);
  });

  it('未注入 services：带权限插件同样 fail-safe 拒绝', async () => {
    const h = setup();
    const engine = new ProfileEngine({
      userDataDir: h.userDataDir,
      lifecycle: h.lifecycle,
      events: h.bus,
      // 不传 services
    });
    const plugin = makeLoaded('org.example.needs-files', ['files:read']);
    engine.setAvailablePlugins([plugin]);

    await engine.enable('org.example.needs-files');

    expect(engine.getCurrent().enabled).not.toContain('org.example.needs-files');
    expect(h.lifecycle.mountedIds).not.toContain('org.example.needs-files');
  });
});
