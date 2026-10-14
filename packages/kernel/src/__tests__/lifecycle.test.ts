/**
 * LifecycleManager ctx 注入单元测试（跨任务待办 P-008）。
 *
 * 覆盖：
 *  - createScopedCtx 注入给插件工厂的 ctx.apiVersion 必须是完整 SemVer，
 *    且与 compat.ts 的 CURRENT_API_VERSION 同源
 *    （原硬编码 '1.0' 会让插件侧版本判断出现歧义，见 docs/plugin-spec-v1.md F-010）
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
