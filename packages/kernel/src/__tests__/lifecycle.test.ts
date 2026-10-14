/**
 * LifecycleManager ctx 注入单元测试（跨任务待办 P-007 / P-008）。
 *
 * 覆盖：
 *  - createScopedCtx 注入给插件工厂的 ctx.apiVersion 必须是完整 SemVer，
 *    且与 compat.ts 的 CURRENT_API_VERSION 同源
 *    （原硬编码 '1.0' 会让插件侧版本判断出现歧义，见 docs/plugin-spec-v1.md F-010）
 *  - ctx.effects.add(fn) 登记的 cleanup 与 events/services 同 effect scope：
 *    unmount 时自动逆序执行（P-007，闭环规范反馈 F-006：shell:ui.registerPanel
 *    返回的 unregister 即经此挂进注册方插件 scope）
 */
import { describe, it, expect } from 'vitest';
import { EventBusImpl } from '../events';
import { ServiceRegistryImpl } from '../services';
import { LifecycleManager } from '../lifecycle';
import { CURRENT_API_VERSION } from '../compat';
import type { LoadedPlugin } from '../loader';
import type { PluginContext, PluginManifest } from '../types';

const testManifest: PluginManifest = {
  id: 'org.example.lifecycle-ctx-test',
  name: '生命周期 ctx 注入测试插件',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  entry: 'index.js',
};

function makeLoadedPlugin(factory: (ctx: PluginContext) => Promise<void>): LoadedPlugin {
  return {
    dir: '/virtual/lifecycle-ctx-test',
    manifest: testManifest,
    module: { default: factory },
  };
}

describe('LifecycleManager ctx.apiVersion 注入（P-008）', () => {
  it('插件工厂收到的 ctx.apiVersion 为完整 SemVer，与 CURRENT_API_VERSION 一致', async () => {
    let captured: PluginContext | undefined;
    const lifecycle = new LifecycleManager(new EventBusImpl(), new ServiceRegistryImpl());

    const outcome = await lifecycle.mount(
      makeLoadedPlugin(async (ctx) => {
        captured = ctx;
      }),
    );

    expect(outcome.ok).toBe(true);
    // P-008：原注入值为 '1.0'（非完整 SemVer），现已对齐为 CURRENT_API_VERSION 全值
    expect(captured).toBeDefined();
    expect(captured!.apiVersion).toBe(CURRENT_API_VERSION);
    expect(captured!.apiVersion).toBe('1.0.0');
    // 已挂载实例暴露的 ctx 同源同值
    expect(outcome.plugin!.ctx.apiVersion).toBe('1.0.0');

    await lifecycle.unmount(testManifest.id);
  });
});

describe('LifecycleManager ctx.effects.add 可逆 cleanup（P-007）', () => {
  it('unmount 时自动执行 ctx.effects.add 登记的 cleanup（与 events.on 同 scope 逆序）', async () => {
    const bus = new EventBusImpl();
    const lifecycle = new LifecycleManager(bus, new ServiceRegistryImpl());
    const calls: string[] = [];

    const outcome = await lifecycle.mount(
      makeLoadedPlugin(async (ctx) => {
        // 模拟 shell:ui.registerPanel 返回的 unregister 登记路径
        ctx.effects.add(() => calls.push('panel-unregister'));
        // 与既有 events.on 自动登记同 scope：其 unsub 只摘监听（不 push）
        ctx.events.on('theme:changed', () => calls.push('theme-listener'));
        ctx.effects.add(() => calls.push('another-cleanup'));
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(calls).toEqual([]);

    // 卸载前事件监听是活的：手动 emit 能触发 handler
    bus.emit('theme:changed');
    expect(calls).toEqual(['theme-listener']);

    await lifecycle.unmount(testManifest.id);
    // 逆序：后登记的 cleanup 先跑。登记顺序：
    //   effects#1(panel-unregister) → events.on 自动 unsub#2 → effects#3(another-cleanup)
    // calls 序列：卸载前 emit 的 theme-listener → dispose 逆序 another-cleanup →
    //   unsub（只摘监听，不 push）→ panel-unregister
    expect(calls).toEqual(['theme-listener', 'another-cleanup', 'panel-unregister']);
    expect(lifecycle.mountedIds).not.toContain(testManifest.id);

    // 卸载后再发事件：监听已随 scope 摘除，不再触发 handler
    bus.emit('theme:changed');
    expect(calls).toEqual(['theme-listener', 'another-cleanup', 'panel-unregister']);
  });

  it('mount 失败回滚时，已登记的 effects cleanup 也随 scope dispose 执行', async () => {
    const lifecycle = new LifecycleManager(new EventBusImpl(), new ServiceRegistryImpl());
    const calls: string[] = [];

    const outcome = await lifecycle.mount(
      makeLoadedPlugin(async (ctx) => {
        ctx.effects.add(() => calls.push('rolled-back-cleanup'));
        throw new Error('mount 中途失败');
      }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toBe('mount 中途失败');
    expect(calls).toEqual(['rolled-back-cleanup']);
  });
});
