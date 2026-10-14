/**
 * ApprovalPolicy 授权判定引擎单元测试（TASK-008）。
 *
 * 覆盖验收标准：
 *  - 安装流程展示权限清单（prompter 收到含展示信息的清单）
 *  - 用户拒绝后插件无法启用（denied + 拒绝记录持久化）
 *  - manifest 缺省 permissions 按空权限自动通过
 *  - 部分授权 / 全量授权 / 授权复用 / 撤销
 *  - 未知权限不授予（fail-safe）
 */
import { describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '@issheepbox/kernel';
import { ApprovalPolicy } from '../approval-policy';
import { MemoryApprovalStore } from '../storage';
import type { ApprovalPrompter } from '../prompter';
import type { ApprovalPromptResult } from '../types';

const ID = 'org.example.note';

function makeManifest(
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    id: ID,
    name: '便签',
    version: '1.0.0',
    apiVersion: '^1.0.0',
    entry: 'index.js',
    ...overrides,
  };
}

/** 可编程 prompter：记录收到的提示请求，返回预设决策。 */
class FakePrompter implements ApprovalPrompter {
  prompts: Array<{ pluginId: string; permissions: string[] }> = [];
  private result: ApprovalPromptResult;

  constructor(result: ApprovalPromptResult = { kind: 'deny' }) {
    this.result = result;
  }

  setResult(result: ApprovalPromptResult): void {
    this.result = result;
  }

  async prompt(request): Promise<ApprovalPromptResult> {
    this.prompts.push({
      pluginId: request.pluginId,
      permissions: request.permissions.map((p) => p.id),
    });
    return this.result;
  }
}

function createPolicy(result: ApprovalPromptResult = { kind: 'deny' }) {
  const store = new MemoryApprovalStore();
  const prompter = new FakePrompter(result);
  const policy = new ApprovalPolicy({ store, prompter });
  return { policy, store, prompter };
}

describe('ApprovalPolicy.requestApproval', () => {
  it('manifest 未声明 permissions → 空权限自动通过，不打扰用户', async () => {
    const { policy, prompter } = createPolicy();
    const decision = await policy.requestApprovalForManifest(
      makeManifest({ permissions: undefined }),
    );
    expect(decision.status).toBe('granted');
    if (decision.status === 'granted') {
      expect(decision.permissions).toEqual([]);
      expect(decision.auto).toBe(true);
    }
    expect(prompter.prompts).toEqual([]); // 未调用授权 UI
    expect(policy.isApproved(ID)).toBe(true);
  });

  it('仅声明默认授予权限（storage:plugin）→ 自动通过，不展示清单', async () => {
    const { policy, prompter } = createPolicy();
    const decision = await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['storage:plugin'] }),
    );
    expect(decision.status).toBe('granted');
    if (decision.status === 'granted') {
      expect(decision.permissions).toEqual(['storage:plugin']);
      expect(decision.auto).toBe(true);
    }
    expect(prompter.prompts).toEqual([]);
  });

  it('安装流程向用户展示权限清单（含全部需授权权限与展示信息）', async () => {
    const { policy, prompter } = createPolicy({ kind: 'grant-all' });
    await policy.requestApprovalForManifest(
      makeManifest({
        permissions: ['files:read', 'network:fetch'],
      }),
    );
    expect(prompter.prompts).toHaveLength(1);
    expect(prompter.prompts[0].pluginId).toBe(ID);
    expect(prompter.prompts[0].permissions).toEqual([
      'files:read',
      'network:fetch',
    ]);
  });

  it('用户全部授权 → granted，授权记录持久化，运行时校验放行', async () => {
    const { policy, store } = createPolicy({ kind: 'grant-all' });
    const decision = await policy.requestApproval({
      pluginId: ID,
      pluginName: '便签',
      permissions: ['files:read', 'clipboard:write'],
    });
    expect(decision.status).toBe('granted');
    expect(policy.isApproved(ID)).toBe(true);
    expect(policy.checkPermission(ID, 'files:read')).toBe(true);
    expect(policy.checkPermission(ID, 'clipboard:write')).toBe(true);

    const record = store.get(ID);
    expect(record?.status).toBe('granted');
    expect(record?.permissions).toEqual(['clipboard:write', 'files:read']);
    expect(typeof record?.decidedAt).toBe('string');
  });

  it('用户拒绝 → denied，插件不可启用，拒绝记录持久化', async () => {
    const { policy, store, prompter } = createPolicy({ kind: 'deny' });
    const decision = await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['shell:exec'] }),
    );
    expect(decision.status).toBe('denied');
    expect(policy.isApproved(ID)).toBe(false);
    expect(policy.hasDecision(ID)).toBe(true);
    expect(policy.checkPermission(ID, 'shell:exec')).toBe(false);

    const record = store.get(ID);
    expect(record?.status).toBe('denied');
    expect(record?.permissions).toEqual([]);
    expect(prompter.prompts).toHaveLength(1);
  });

  it('拒绝后再次请求 → 维持拒绝，不重复弹窗；revoke 后可重新申请', async () => {
    const { policy, prompter } = createPolicy({ kind: 'deny' });
    await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['files:read'] }),
    );
    expect(prompter.prompts).toHaveLength(1);

    // 再次请求：直接返回 denied，不重复提示
    const again = await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['files:read'] }),
    );
    expect(again.status).toBe('denied');
    expect(prompter.prompts).toHaveLength(1);

    // 用户重新申请：先 revoke 清掉拒绝记录，再走完整流程
    policy.revoke(ID);
    const retry = await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['files:read'] }),
    );
    expect(retry.status).toBe('denied'); // prompter 仍预设 deny
    expect(prompter.prompts).toHaveLength(2);
  });

  it('部分授权 → 只授予用户勾选的权限，未勾选权限运行时被拒', async () => {
    const { policy } = createPolicy({
      kind: 'grant-subset',
      permissions: ['files:read'],
    });
    const decision = await policy.requestApproval({
      pluginId: ID,
      pluginName: '便签',
      permissions: ['files:read', 'shell:exec'],
    });
    expect(decision.status).toBe('granted');
    if (decision.status === 'granted') {
      expect(decision.permissions).toEqual(['files:read']);
      expect(decision.auto).toBe(false);
    }
    expect(policy.checkPermission(ID, 'files:read')).toBe(true);
    expect(policy.checkPermission(ID, 'shell:exec')).toBe(false);
  });

  it('部分授权时 UI 传入清单外权限 ID 被忽略', async () => {
    const { policy } = createPolicy({
      kind: 'grant-subset',
      permissions: ['files:read', 'hack:all'],
    });
    const decision = await policy.requestApproval({
      pluginId: ID,
      pluginName: '便签',
      permissions: ['files:read', 'network:fetch'],
    });
    expect(decision.status).toBe('granted');
    if (decision.status === 'granted') {
      expect(decision.permissions).toEqual(['files:read']);
    }
  });

  it('已授权且覆盖全部声明 → 复用授权，不重复弹窗', async () => {
    const { policy, prompter } = createPolicy({ kind: 'grant-all' });
    await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['files:read'] }),
    );
    expect(prompter.prompts).toHaveLength(1);

    const again = await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['files:read'] }),
    );
    expect(again.status).toBe('granted');
    if (again.status === 'granted') {
      expect(again.auto).toBe(true);
    }
    expect(prompter.prompts).toHaveLength(1); // 未再次弹窗

    // 声明新增权限 → 覆盖不足，重新弹窗
    await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['files:read', 'shell:exec'] }),
    );
    expect(prompter.prompts).toHaveLength(2);
  });

  it('未知权限不授予（grant-all 也只授予已知权限）', async () => {
    const { policy } = createPolicy({ kind: 'grant-all' });
    const decision = await policy.requestApproval({
      pluginId: ID,
      pluginName: '便签',
      permissions: ['files:read', 'hack:all'],
    });
    expect(decision.status).toBe('granted');
    if (decision.status === 'granted') {
      expect(decision.permissions).toEqual(['files:read']);
    }
    expect(policy.checkPermission(ID, 'hack:all')).toBe(false);
  });

  it('checkPermission：storage:plugin 默认授予恒放行；无记录的其他权限恒拒绝', async () => {
    const { policy } = createPolicy();
    expect(policy.checkPermission('any-plugin', 'storage:plugin')).toBe(true);
    expect(policy.checkPermission('any-plugin', 'files:read')).toBe(false);
  });

  it('revoke 撤销后插件不再处于已授权状态', async () => {
    const { policy } = createPolicy({ kind: 'grant-all' });
    await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['files:read'] }),
    );
    expect(policy.isApproved(ID)).toBe(true);

    policy.revoke(ID);
    expect(policy.isApproved(ID)).toBe(false);
    expect(policy.hasDecision(ID)).toBe(false);
    expect(policy.checkPermission(ID, 'files:read')).toBe(false);
  });

  it('未知权限声明会记日志告警', async () => {
    const warn = vi.fn();
    const store = new MemoryApprovalStore();
    const prompter = new FakePrompter({ kind: 'grant-all' });
    const policy = new ApprovalPolicy({
      store,
      prompter,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
      },
    });
    await policy.requestApproval({
      pluginId: ID,
      pluginName: '便签',
      permissions: ['hack:all'],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('hack:all');
  });
});

describe('ApprovalPolicy.checkPermission 运行时边界', () => {
  it('denied 记录下所有需授权权限均被拒绝', async () => {
    const { policy } = createPolicy({ kind: 'deny' });
    await policy.requestApproval({
      pluginId: ID,
      pluginName: '便签',
      permissions: ['network:fetch'],
    });
    expect(policy.checkPermission(ID, 'network:fetch')).toBe(false);
  });
});

describe('ApprovalPolicy.requestApproval 启动路径语义（boot/restore/switchTo，C2）', () => {
  /** 预置一条 granted 记录并返回策略。 */
  function seedGranted(permissions: string[]) {
    const store = new MemoryApprovalStore();
    const prompter = new FakePrompter({ kind: 'grant-all' });
    store.set({
      pluginId: ID,
      status: 'granted',
      permissions,
      decidedAt: new Date().toISOString(),
    });
    const policy = new ApprovalPolicy({ store, prompter });
    return { policy, store, prompter };
  }

  it('boot：已有 granted 记录覆盖全部声明 → 自动 granted(auto)，不弹窗', async () => {
    const { policy, prompter, store } = seedGranted(['files:read']);
    const before = store.get(ID);

    const decision = await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['files:read'] }),
      'boot',
    );
    expect(decision.status).toBe('granted');
    if (decision.status === 'granted') {
      expect(decision.auto).toBe(true);
      expect(decision.permissions).toEqual(['files:read']);
    }
    expect(prompter.prompts).toEqual([]);
    // 记录不被重写（decidedAt 不变）。
    expect(store.get(ID)).toBe(before);
  });

  it('boot：已有 denied 记录 → denied 并复用原因，不弹窗、不重写记录', async () => {
    const store = new MemoryApprovalStore();
    const prompter = new FakePrompter({ kind: 'grant-all' });
    store.set({
      pluginId: ID,
      status: 'denied',
      permissions: [],
      decidedAt: new Date().toISOString(),
      reason: '用户此前拒绝（测试预置）',
    });
    const policy = new ApprovalPolicy({ store, prompter });

    const decision = await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['files:read'] }),
      'restore',
    );
    expect(decision.status).toBe('denied');
    if (decision.status === 'denied') {
      expect(decision.reason).toBe('用户此前拒绝（测试预置）');
    }
    expect(prompter.prompts).toEqual([]);
    expect(store.get(ID)?.status).toBe('denied');
  });

  it('boot：无记录 → denied（fail-safe），不弹窗、绝不写入记录', async () => {
    const { policy, store, prompter } = createPolicy({ kind: 'grant-all' });

    const decision = await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['files:read'] }),
      'boot',
    );
    expect(decision.status).toBe('denied');
    if (decision.status === 'denied') {
      expect(decision.reason).toContain('boot');
      expect(decision.reason).toContain('不弹窗');
    }
    // 关键：无记录场景下启动路径不得写记录，否则用户尚未决策即被永久锁死。
    expect(prompter.prompts).toEqual([]);
    expect(store.get(ID)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('switchTo：granted 记录未覆盖新增权限 → denied，不弹窗、不改写既有 granted 记录', async () => {
    const { policy, prompter, store } = seedGranted(['files:read']);

    const decision = await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['files:read', 'shell:exec'] }),
      'switchTo',
    );
    expect(decision.status).toBe('denied');
    expect(prompter.prompts).toEqual([]);
    // 既有 granted 记录原样保留（不被降级成 denied）。
    expect(store.get(ID)?.status).toBe('granted');
    expect(store.get(ID)?.permissions).toEqual(['files:read']);
  });

  it('boot：空权限插件直通 granted(auto)，不弹窗、不写记录', async () => {
    const { policy, store, prompter } = createPolicy({ kind: 'grant-all' });

    const decision = await policy.requestApprovalForManifest(
      makeManifest({ permissions: [] }),
      'boot',
    );
    expect(decision.status).toBe('granted');
    if (decision.status === 'granted') expect(decision.auto).toBe(true);
    expect(prompter.prompts).toEqual([]);
    expect(store.get(ID)).toBeUndefined();
  });

  it('对照：缺省 source（安装/启用）无记录时仍弹窗并写决策记录', async () => {
    const { policy, store, prompter } = createPolicy({ kind: 'deny' });

    await policy.requestApprovalForManifest(
      makeManifest({ permissions: ['files:read'] }),
      'install',
    );
    expect(prompter.prompts).toHaveLength(1);
    expect(store.get(ID)?.status).toBe('denied');
  });
});
