/**
 * approval-policy 默认接线集成测试（TASK-015）。
 *
 * 不传入 options.store / options.prompter，验证工厂按 ctx 自动接线：
 *  - C1：prompter 懒解析——先 mount、后注册 approval-ui 服务仍能被使用；
 *        未注册时 FailSafePrompter 默认拒绝。
 *  - C3：store 默认接线——host:user-data 服务存在 → DiskApprovalStore(dir)
 *        （决策落盘 approvals.json，新实例可见）；缺失 → MemoryApprovalStore。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EventBusImpl,
  LifecycleManager,
  ServiceRegistryImpl,
  type LoadedPlugin,
} from '@issheepbox/kernel';
import type { PluginManifest } from '@issheepbox/kernel';
import {
  APPROVAL_SERVICE_NAME,
  APPROVAL_UI_SERVICE_NAME,
  HOST_USER_DATA_SERVICE_NAME,
  createApprovalPolicyPlugin,
} from '../index';
import { APPROVALS_FILE_NAME, DiskApprovalStore } from '../storage-disk';
import type {
  ApprovalPromptRequest,
  ApprovalPromptResult,
  ApprovalPrompter,
} from '../types';

const PLUGIN_ID = 'org.issheepbox.approval-policy';
const TARGET_ID = 'example.file-stats';

/** 可编程 prompter：记录提示请求、返回预设决策。 */
class FakePrompter implements ApprovalPrompter {
  prompts: string[] = [];
  constructor(private readonly result: ApprovalPromptResult) {}

  async prompt(request: ApprovalPromptRequest): Promise<ApprovalPromptResult> {
    this.prompts.push(request.pluginId);
    return this.result;
  }
}

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: TARGET_ID,
    name: '文件统计',
    version: '1.0.0',
    apiVersion: '^1.0.0',
    entry: 'index.js',
    permissions: ['files:read'],
    ...overrides,
  };
}

function makeLoadedPlugin(factory: ReturnType<typeof createApprovalPolicyPlugin>): LoadedPlugin {
  return {
    dir: '/virtual/approval-policy',
    manifest: {
      id: PLUGIN_ID,
      name: '权限授权',
      version: '1.0.0',
      apiVersion: '^1.0.0',
      entry: 'dist/index.js',
      permissions: [],
    },
    module: { default: factory },
  };
}

interface Harness {
  registry: ServiceRegistryImpl;
  lifecycle: LifecycleManager;
  policy: {
    requestApprovalForManifest(
      manifest: PluginManifest,
      source?: string,
    ): Promise<{ status: string; pluginId: string; reason?: string; permissions?: string[] }>;
    hasDecision(pluginId: string): boolean;
    isApproved(pluginId: string): boolean;
  };
}

/** 用默认工厂（无 store/prompter 注入）挂载 approval-policy。 */
async function mountDefault(registry: ServiceRegistryImpl): Promise<Harness> {
  const bus = new EventBusImpl();
  const lifecycle = new LifecycleManager(bus, registry);
  const outcome = await lifecycle.mount(makeLoadedPlugin(createApprovalPolicyPlugin()));
  expect(outcome.ok).toBe(true);
  return {
    registry,
    lifecycle,
    policy: registry.get(APPROVAL_SERVICE_NAME) as Harness['policy'],
  };
}

let tmpRoot = '';
beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'approval-wiring-test-'));
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('approval-policy 默认 prompter 懒解析（C1）', () => {
  it('mount 时无 approval-ui → FailSafePrompter 默认拒绝；之后注册 approval-ui → 下一次弹窗即用之', async () => {
    const registry = new ServiceRegistryImpl();
    const { policy, lifecycle } = await mountDefault(registry);

    // 第一次弹窗：无 approval-ui 服务 → fail-safe 拒绝，写 denied 记录。
    const first = await policy.requestApprovalForManifest(makeManifest(), 'install');
    expect(first.status).toBe('denied');
    expect(policy.hasDecision(TARGET_ID)).toBe(true);

    // 卸载前先清掉该记录，方便观察下一轮弹窗。
    // （这里直接走 revoke：approval-policy 服务暴露的方法。）
    const svc = registry.get(APPROVAL_SERVICE_NAME) as { revoke(id: string): void };
    svc.revoke(TARGET_ID);

    // 关键：approval-ui 在本插件 mount 之后才注册 —— 懒解析必须每次现查。
    const ui = new FakePrompter({ kind: 'grant-all' });
    registry.register(APPROVAL_UI_SERVICE_NAME, ui);

    const second = await policy.requestApprovalForManifest(makeManifest(), 'install');
    expect(second.status).toBe('granted');
    expect(ui.prompts).toEqual([TARGET_ID]); // 确为后注册的 UI 被调用

    await lifecycle.unmount(PLUGIN_ID);
    // 卸载后 approval-ui 不再可见（作用域隔离）。
    expect(registry.has(APPROVAL_SERVICE_NAME)).toBe(false);
  });
});

describe('approval-policy 默认 store 接线（C3）', () => {
  it('host:user-data 存在 → DiskApprovalStore：决策落盘 approvals.json 且可跨实例读回', async () => {
    const dir = path.join(tmpRoot, 'disk-present');
    const registry = new ServiceRegistryImpl();
    registry.register(HOST_USER_DATA_SERVICE_NAME, { dir });

    const { policy, lifecycle } = await mountDefault(registry);
    // 无 approval-ui → fail-safe 拒绝 → denied 记录应落到磁盘。
    const decision = await policy.requestApprovalForManifest(
      makeManifest(),
      'install',
    );
    expect(decision.status).toBe('denied');

    const file = path.join(dir, APPROVALS_FILE_NAME);
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].pluginId).toBe(TARGET_ID);
    expect(parsed[0].status).toBe('denied');

    // 模拟宿主重启：全新实例（同一文件）应读到该记录。
    const reloaded = new DiskApprovalStore({ dir });
    expect(reloaded.get(TARGET_ID)?.status).toBe('denied');

    await lifecycle.unmount(PLUGIN_ID);
  });

  it('host:user-data 缺失 → MemoryApprovalStore：不崩溃、记录进程内有效、跨挂载不共享', async () => {
    const registry1 = new ServiceRegistryImpl();
    const { policy, lifecycle } = await mountDefault(registry1);

    const decision = await policy.requestApprovalForManifest(
      makeManifest(),
      'install',
    );
    expect(decision.status).toBe('denied');
    expect(policy.hasDecision(TARGET_ID)).toBe(true);
    await lifecycle.unmount(PLUGIN_ID);

    // 全新 registry/全新挂载：内存存储不跨实例共享（若误用磁盘则可能串记录）。
    const registry2 = new ServiceRegistryImpl();
    const second = await mountDefault(registry2);
    expect(second.policy.hasDecision(TARGET_ID)).toBe(false);
    await second.lifecycle.unmount(PLUGIN_ID);
  });

  it('host:user-data 形状非法（dir 非字符串）→ 告警回退内存存储，不崩溃', async () => {
    const registry = new ServiceRegistryImpl();
    registry.register(HOST_USER_DATA_SERVICE_NAME, { dir: 42 });

    const { policy, lifecycle } = await mountDefault(registry);
    const decision = await policy.requestApprovalForManifest(
      makeManifest(),
      'install',
    );
    expect(decision.status).toBe('denied');
    expect(policy.hasDecision(TARGET_ID)).toBe(true);
    await lifecycle.unmount(PLUGIN_ID);
  });
});
