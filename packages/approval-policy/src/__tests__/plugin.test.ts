/**
 * approval-policy 插件级集成测试（TASK-008）。
 *
 * 通过内核公开 API（EventBusImpl / ServiceRegistryImpl / LifecycleManager）挂载
 * approval-policy 插件工厂，验证：
 *  - 挂载后注册 `approval-policy` 服务
 *  - approval:requested 事件驱动授权流程，结果以 approval:granted / denied 广播
 *  - 卸载（unmount）后服务注销、事件监听清理（内核可逆 effects，无残留）
 *
 * 不修改 packages/kernel 内部，仅使用其公开导出。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EventBusImpl,
  LifecycleManager,
  ServiceRegistryImpl,
  type LoadedPlugin,
} from '@issheepbox/kernel';
import {
  APPROVAL_EVENTS,
  APPROVAL_SERVICE_NAME,
  createApprovalPolicyPlugin,
} from '../index';
import { MemoryApprovalStore } from '../storage';
import type { ApprovalPromptResult } from '../types';

const PLUGIN_ID = 'org.issheepbox.approval-policy';

/** 记录收到的提示请求并返回预设决策的 prompter。 */
class FakePrompter {
  prompts: Array<{ pluginId: string; permissions: string[] }> = [];
  result: ApprovalPromptResult;

  constructor(result: ApprovalPromptResult = { kind: 'deny' }) {
    this.result = result;
  }

  async prompt(request: {
    pluginId: string;
    permissions: Array<{ id: string }>;
  }): Promise<ApprovalPromptResult> {
    this.prompts.push({
      pluginId: request.pluginId,
      permissions: request.permissions.map((p) => p.id),
    });
    return this.result;
  }
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

async function mountApprovalPolicy(options?: {
  prompter?: FakePrompter;
  store?: MemoryApprovalStore;
}) {
  const bus = new EventBusImpl();
  const registry = new ServiceRegistryImpl();
  const lifecycle = new LifecycleManager(bus, registry);

  const prompter = options?.prompter ?? new FakePrompter({ kind: 'grant-all' });
  const store = options?.store ?? new MemoryApprovalStore();
  const factory = createApprovalPolicyPlugin({ prompter, store });
  const outcome = await lifecycle.mount(makeLoadedPlugin(factory));
  expect(outcome.ok).toBe(true);

  return { bus, registry, lifecycle, prompter, store };
}

describe('approval-policy 插件（通过内核挂载）', () => {
  it('挂载后注册 approval-policy 服务', async () => {
    const { registry, lifecycle } = await mountApprovalPolicy();
    expect(registry.has(APPROVAL_SERVICE_NAME)).toBe(true);

    const service = registry.get(APPROVAL_SERVICE_NAME);
    expect(typeof service.requestApproval).toBe('function');
    expect(typeof service.checkPermission).toBe('function');

    await lifecycle.unmount(PLUGIN_ID);
  });

  it('approval:requested → 展示权限清单 → approval:granted 广播', async () => {
    const { bus, prompter, lifecycle } = await mountApprovalPolicy();
    const granted = vi.fn();
    const denied = vi.fn();
    bus.on(APPROVAL_EVENTS.Granted, granted);
    bus.on(APPROVAL_EVENTS.Denied, denied);

    bus.emit(APPROVAL_EVENTS.Requested, {
      pluginId: 'org.example.note',
      pluginName: '便签',
      permissions: ['files:read', 'network:fetch'],
      source: 'install',
    });

    // 事件处理器是异步的：等待微任务结算。
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prompter.prompts).toHaveLength(1);
    expect(prompter.prompts[0]).toEqual({
      pluginId: 'org.example.note',
      permissions: ['files:read', 'network:fetch'],
    });
    expect(granted).toHaveBeenCalledTimes(1);
    expect(granted.mock.calls[0][0]).toMatchObject({
      pluginId: 'org.example.note',
      permissions: ['files:read', 'network:fetch'],
      auto: false,
    });
    expect(denied).not.toHaveBeenCalled();

    await lifecycle.unmount(PLUGIN_ID);
  });

  it('用户拒绝 → approval:denied 广播，插件不可启用', async () => {
    const { bus, prompter, lifecycle } = await mountApprovalPolicy({
      prompter: new FakePrompter({ kind: 'deny' }),
    });
    const granted = vi.fn();
    const denied = vi.fn();
    bus.on(APPROVAL_EVENTS.Granted, granted);
    bus.on(APPROVAL_EVENTS.Denied, denied);

    bus.emit(APPROVAL_EVENTS.Requested, {
      pluginId: 'org.example.note',
      pluginName: '便签',
      permissions: ['shell:exec'],
      source: 'enable',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prompter.prompts).toHaveLength(1);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied.mock.calls[0][0]).toMatchObject({
      pluginId: 'org.example.note',
      permissions: ['shell:exec'],
    });
    expect(granted).not.toHaveBeenCalled();

    await lifecycle.unmount(PLUGIN_ID);
  });

  it('空权限请求自动通过并广播 granted（auto=true）', async () => {
    const { bus, prompter, lifecycle } = await mountApprovalPolicy();
    const granted = vi.fn();
    bus.on(APPROVAL_EVENTS.Granted, granted);

    bus.emit(APPROVAL_EVENTS.Requested, {
      pluginId: 'org.example.note',
      pluginName: '便签',
      permissions: [],
      source: 'install',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prompter.prompts).toEqual([]); // 无权限无需弹窗
    expect(granted).toHaveBeenCalledTimes(1);
    expect(granted.mock.calls[0][0]).toMatchObject({
      pluginId: 'org.example.note',
      permissions: [],
      auto: true,
    });

    await lifecycle.unmount(PLUGIN_ID);
  });

  it('unmount 后服务注销、事件监听清理，无残留', async () => {
    const { bus, registry, prompter, lifecycle } = await mountApprovalPolicy({
      prompter: new FakePrompter({ kind: 'deny' }),
    });

    await lifecycle.unmount(PLUGIN_ID);

    // 服务已注销
    expect(registry.has(APPROVAL_SERVICE_NAME)).toBe(false);

    // 事件监听已清理：再发 approval:requested 不再触发授权流程
    bus.emit(APPROVAL_EVENTS.Requested, {
      pluginId: 'org.example.note',
      pluginName: '便签',
      permissions: ['files:read'],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompter.prompts).toEqual([]);
  });

  it('注入 store：授权记录对引擎可见（同一存储实例闭环）', async () => {
    const store = new MemoryApprovalStore();
    const { registry, lifecycle, prompter } = await mountApprovalPolicy({ store });
    const policy = registry.get(APPROVAL_SERVICE_NAME) as {
      isApproved(pluginId: string): boolean;
      checkPermission(pluginId: string, permission: string): boolean;
    };

    // 初始无记录 → 未授权
    expect(policy.isApproved('org.example.note')).toBe(false);

    // 授权流程（或 profile 引擎后续集成）写入记录 → 引擎即时可见
    store.set({
      pluginId: 'org.example.note',
      status: 'granted',
      permissions: ['files:read'],
      decidedAt: new Date().toISOString(),
    });
    expect(policy.isApproved('org.example.note')).toBe(true);
    expect(policy.checkPermission('org.example.note', 'files:read')).toBe(true);
    expect(policy.checkPermission('org.example.note', 'shell:exec')).toBe(false);

    await lifecycle.unmount(PLUGIN_ID);
    expect(prompter.prompts).toEqual([]);
  });
});
