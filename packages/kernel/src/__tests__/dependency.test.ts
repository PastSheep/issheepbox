/**
 * DependencyResolver 测试（P-005）。
 *
 * 验证 docs/plugin-spec-v1.md §10 校验清单 #7（requires 已安装且版本满足）/ #8（依赖图无环）：
 *  - 合法链 / 扇出：拓扑排序顺序正确（依赖在前），互不依赖者保持输入顺序
 *  - 缺失依赖被拒；版本 range 不满足被拒；非法 range 被拒
 *  - 循环依赖被拒
 *  - 失败隔离：坏插件不影响好插件；失败沿依赖边传播（被拒者的依赖者随之拒绝）
 *  - provided 内置提供项目录可满足 service:* 类 requires
 */
import { describe, it, expect } from 'vitest';
import { DependencyResolver } from '../dependency';
import type { ResolutionResult } from '../dependency';
import type { LoadedPlugin } from '../loader';
import type { PluginManifest } from '../types';

/** 构造一个合成的已加载插件（不碰磁盘）。 */
function lp(
  id: string,
  version = '1.0.0',
  requires: Record<string, string> = {},
): LoadedPlugin {
  const manifest: PluginManifest = {
    id,
    name: id,
    version,
    apiVersion: '^1.0.0',
    entry: 'index.js',
    requires,
  };
  return {
    dir: `/fake/${id}`,
    manifest,
    module: { default: async () => ({}) },
  };
}

const resolver = new DependencyResolver();
const ids = (r: ResolutionResult): string[] => r.ordered.map((p) => p.manifest.id);
const failIds = (r: ResolutionResult): string[] =>
  r.failures.map((f) => f.pluginId);

describe('DependencyResolver 拓扑排序', () => {
  it('空集合：返回空结果，不崩溃', () => {
    const r = resolver.resolveOrder([]);
    expect(r.ordered).toEqual([]);
    expect(r.failures).toEqual([]);
  });

  it('无依赖的插件按输入顺序通过', () => {
    const r = resolver.resolveOrder([lp('org.a'), lp('org.b'), lp('org.c')]);
    expect(ids(r)).toEqual(['org.a', 'org.b', 'org.c']);
    expect(r.failures).toEqual([]);
  });

  it('合法链：依赖者排在被依赖者之后', () => {
    // a requires b requires c → 加载顺序 c → b → a
    const a = lp('org.a', '1.0.0', { 'org.b': '^1.0.0' });
    const b = lp('org.b', '1.2.0', { 'org.c': '^1.0.0' });
    const c = lp('org.c', '1.5.0');
    const r = resolver.resolveOrder([a, b, c]);
    expect(ids(r)).toEqual(['org.c', 'org.b', 'org.a']);
    expect(r.failures).toEqual([]);
  });

  it('扇出：公共依赖排在所有依赖者之前，同层保持输入顺序', () => {
    const base = lp('org.base');
    const x = lp('org.x', '1.0.0', { 'org.base': '^1.0.0' });
    const y = lp('org.y', '1.0.0', { 'org.base': '^1.0.0' });
    const r = resolver.resolveOrder([x, y, base]);
    expect(ids(r)[0]).toBe('org.base');
    expect(ids(r)).toEqual(['org.base', 'org.x', 'org.y']);
    expect(r.failures).toEqual([]);
  });

  it('菱形依赖：base → m/n → top，顺序确定', () => {
    const base = lp('org.base');
    const m = lp('org.m', '1.0.0', { 'org.base': '^1.0.0' });
    const n = lp('org.n', '1.0.0', { 'org.base': '^1.0.0' });
    const top = lp('org.top', '1.0.0', { 'org.m': '^1.0.0', 'org.n': '^1.0.0' });
    const r = resolver.resolveOrder([top, m, n, base]);
    expect(ids(r)).toEqual(['org.base', 'org.m', 'org.n', 'org.top']);
    expect(r.failures).toEqual([]);
  });

  it('版本满足 range：patch/minor 在 range 内照常通过', () => {
    const base = lp('org.base', '1.4.2');
    const consumer = lp('org.consumer', '1.0.0', { 'org.base': '^1.0.0' });
    const r = resolver.resolveOrder([consumer, base]);
    expect(ids(r)).toEqual(['org.base', 'org.consumer']);
    expect(r.failures).toEqual([]);
  });
});

describe('DependencyResolver #7 requires 校验', () => {
  it('缺失依赖被拒：错误提示缺哪个依赖', () => {
    const p = lp('org.lonely', '1.0.0', { 'org.missing': '^1.0.0' });
    const r = resolver.resolveOrder([p]);
    expect(r.ordered).toEqual([]);
    expect(failIds(r)).toEqual(['org.lonely']);
    expect(r.failures[0].errors[0]).toContain('缺少依赖');
    expect(r.failures[0].errors[0]).toContain('org.missing');
  });

  it('版本 range 不满足被拒', () => {
    const base = lp('org.base', '1.0.0');
    const consumer = lp('org.consumer', '1.0.0', { 'org.base': '^2.0.0' });
    const r = resolver.resolveOrder([consumer, base]);
    expect(ids(r)).toEqual(['org.base']);
    expect(failIds(r)).toEqual(['org.consumer']);
    expect(r.failures[0].errors[0]).toContain('不满足');
    expect(r.failures[0].errors[0]).toContain('^2.0.0');
  });

  it('非法 SemVer range 被拒', () => {
    const p = lp('org.badrange', '1.0.0', { 'org.base': 'not-a-range' });
    const r = resolver.resolveOrder([p, lp('org.base')]);
    expect(r.ordered.map((x) => x.manifest.id)).toEqual(['org.base']);
    expect(failIds(r)).toEqual(['org.badrange']);
    expect(r.failures[0].errors[0]).toContain('SemVer');
  });

  it('失败传播：中间层版本不满足 → 其依赖者随之拒绝，无辜叶子保留', () => {
    // chain: leaf ← mid(bad version range) ← top
    const leaf = lp('org.leaf', '1.0.0');
    const mid = lp('org.mid', '1.0.0', { 'org.leaf': '^9.9.9' });
    const top = lp('org.top', '1.0.0', { 'org.mid': '^1.0.0' });
    const r = resolver.resolveOrder([top, mid, leaf]);
    // leaf 无辜保留；mid 版本不满足被拒；top 依赖 mid → 缺少依赖被拒
    expect(ids(r)).toEqual(['org.leaf']);
    expect(new Set(failIds(r))).toEqual(new Set(['org.mid', 'org.top']));
  });

  it('provided 内置目录可满足 service:* requires；未知键按缺少依赖拒绝', () => {
    const withProvided = lp('org.a', '1.0.0', { 'service:storage': '^1.0.0' });
    const r1 = resolver.resolveOrder([withProvided], {
      provided: new Map([['service:storage', '1.2.0']]),
    });
    expect(ids(r1)).toEqual(['org.a']);
    expect(r1.failures).toEqual([]);

    const r2 = resolver.resolveOrder([withProvided]); // 无 provided 目录
    expect(r2.ordered).toEqual([]);
    expect(r2.failures[0].errors[0]).toContain('缺少依赖');
  });
});

describe('DependencyResolver #8 循环依赖', () => {
  it('两两互 requires：双方都被拒，ordered 为空', () => {
    const a = lp('org.a', '1.0.0', { 'org.b': '^1.0.0' });
    const b = lp('org.b', '1.0.0', { 'org.a': '^1.0.0' });
    const r = resolver.resolveOrder([a, b]);
    expect(r.ordered).toEqual([]);
    expect(new Set(failIds(r))).toEqual(new Set(['org.a', 'org.b']));
    for (const f of r.failures) {
      expect(f.errors[0]).toContain('循环依赖');
    }
  });

  it('三环：a→b→c→a 全部被拒', () => {
    const a = lp('org.a', '1.0.0', { 'org.b': '^1.0.0' });
    const b = lp('org.b', '1.0.0', { 'org.c': '^1.0.0' });
    const c = lp('org.c', '1.0.0', { 'org.a': '^1.0.0' });
    const r = resolver.resolveOrder([a, b, c]);
    expect(r.ordered).toEqual([]);
    expect(r.failures).toHaveLength(3);
  });

  it('环外依赖者被传播拒绝，环外无辜插件照常通过', () => {
    const a = lp('org.a', '1.0.0', { 'org.b': '^1.0.0' });
    const b = lp('org.b', '1.0.0', { 'org.a': '^1.0.0' });
    const outer = lp('org.outer', '1.0.0', { 'org.a': '^1.0.0' }); // 依赖环成员
    const safe = lp('org.safe'); // 与环完全无关
    const r = resolver.resolveOrder([a, b, outer, safe]);
    expect(ids(r)).toEqual(['org.safe']);
    expect(new Set(failIds(r))).toEqual(new Set(['org.a', 'org.b', 'org.outer']));
  });
});

describe('DependencyResolver 失败隔离', () => {
  it('坏插件（缺依赖）不影响好插件加载', () => {
    const good = lp('org.good');
    const bad = lp('org.bad', '1.0.0', { 'org.ghost': '^1.0.0' });
    const r = resolver.resolveOrder([bad, good]);
    expect(ids(r)).toEqual(['org.good']);
    expect(failIds(r)).toEqual(['org.bad']);
  });

  it('全部插件都违规时不崩溃，failures 收集全部错误', () => {
    const a = lp('org.a', '1.0.0', { 'org.nope': '^1.0.0' });
    const b = lp('org.b', '1.0.0', { 'org.a': '^1.0.0' });
    const r = resolver.resolveOrder([a, b]);
    expect(r.ordered).toEqual([]);
    expect(r.failures).toHaveLength(2);
  });
});
