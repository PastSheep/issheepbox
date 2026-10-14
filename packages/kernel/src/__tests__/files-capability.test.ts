/**
 * 宿主 files 能力（ctx.files）授权门单单测（跨任务待办 P-009，闭环 F-008）。
 *
 * 覆盖：
 *  - granted：checkPermission=true → readFile 读回真实文件内容、writeFile 落盘
 *  - denied：checkPermission=false → readFile/writeFile 抛错（fail-safe，无静默放行）
 *  - 服务不可用：approval-policy 未挂载 → 任何 ctx.files 调用抛错
 *
 * 门禁经 services 注册表按名查 'approval-policy'.checkPermission；此处注册一个
 * 脚本化假服务（结构形状对齐，不 import @issheepbox/approval-policy）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventBusImpl } from '../events';
import { ServiceRegistryImpl } from '../services';
import { LifecycleManager } from '../lifecycle';
import type { LoadedPlugin } from '../loader';
import type { PluginContext, PluginManifest } from '../types';

const PLUGIN_ID = 'org.example.files-cap-test';

const manifest: PluginManifest = {
  id: PLUGIN_ID,
  name: 'files 能力测试插件',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  entry: 'index.js',
};

function makeLoadedPlugin(factory: (ctx: PluginContext) => void): LoadedPlugin {
  return { dir: '/virtual/files-cap-test', manifest, module: { default: factory } };
}

/** 注册脚本化假 approval-policy：allow 时对本插件一切权限放行，否则一律拒绝。 */
function registerFakeChecker(registry: ServiceRegistryImpl, allow: boolean): void {
  registry.register('approval-policy', {
    checkPermission: (pluginId: string, _permission: string) =>
      allow && pluginId === PLUGIN_ID ? true : false,
  });
}

describe('ctx.files 宿主文件能力授权门禁（P-009）', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'isb-files-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('granted：授权后 readFile 读回真实文件、writeFile 落盘', async () => {
    const registry = new ServiceRegistryImpl();
    registerFakeChecker(registry, true);
    const lifecycle = new LifecycleManager(new EventBusImpl(), registry);

    const target = path.join(tmpDir, 'in.txt');
    writeFileSync(target, '你好\nworld', 'utf8');

    let readBack = '';
    let written = '';
    const outFile = path.join(tmpDir, 'out.txt');
    const outcome = await lifecycle.mount(
      makeLoadedPlugin((ctx) => {
        readBack = ctx.files.readFile(target);
        ctx.files.writeFile(outFile, '写入内容');
        written = readFileSync(outFile, 'utf8');
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(readBack).toBe('你好\nworld');
    expect(written).toBe('写入内容');
    await lifecycle.unmount(PLUGIN_ID);
  });

  it('denied：未授权时 readFile / writeFile 抛错（fail-safe）', async () => {
    const registry = new ServiceRegistryImpl();
    registerFakeChecker(registry, false);
    const lifecycle = new LifecycleManager(new EventBusImpl(), registry);

    const target = path.join(tmpDir, 'secret.txt');
    writeFileSync(target, 'secret', 'utf8');

    const errors: string[] = [];
    const outcome = await lifecycle.mount(
      makeLoadedPlugin((ctx) => {
        // 工厂内部捕获：mount 本身不炸（失败隔离），但门禁抛错被记录
        try {
          ctx.files.readFile(target);
        } catch (e) {
          errors.push((e as Error).message);
        }
        try {
          ctx.files.writeFile(target, 'x');
        } catch (e) {
          errors.push((e as Error).message);
        }
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/files:read/);
    expect(errors[1]).toMatch(/files:write/);
    // 拒绝路径下真实文件未被改写（仍是原始 secret）
    expect(readFileSync(target, 'utf8')).toBe('secret');
    await lifecycle.unmount(PLUGIN_ID);
  });

  it('approval-policy 未挂载：任何 ctx.files 调用都被 fail-safe 拒绝', async () => {
    const registry = new ServiceRegistryImpl(); // 不注册 approval-policy
    const lifecycle = new LifecycleManager(new EventBusImpl(), registry);
    const target = path.join(tmpDir, 'x.txt');

    const errors: string[] = [];
    const outcome = await lifecycle.mount(
      makeLoadedPlugin((ctx) => {
        try {
          ctx.files.readFile(target);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/approval-policy/);
    await lifecycle.unmount(PLUGIN_ID);
  });
});
