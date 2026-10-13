/**
 * PluginLoader 失败隔离测试（TASK-005 核心验收）。
 *
 * 验证：
 *  - 单个插件加载失败（apiVersion 不匹配 / 缺 plugin.json / JSON 非法 / 入口缺失）
 *    不影响其他正常插件的加载
 *  - 失败信息可读、可定位
 *  - 校验顺序：manifest → apiVersion 兼容 → entry 文件 → require 模块 → default 导出
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PluginLoader } from '../loader';

let tmpDir: string;

function makePlugin(
  name: string,
  manifest: Record<string, unknown>,
  entryCode = 'module.exports = { default: async function main(ctx) {} };',
): string {
  const dir = path.join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  writeFileSync(path.join(dir, 'index.js'), entryCode);
  return dir;
}

const validManifest = {
  id: 'org.example.valid',
  name: '合法插件',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  entry: 'index.js',
};

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'isb-loader-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('PluginLoader 失败隔离', () => {
  it('混合正常与异常插件：正常的全部加载成功，异常的全部进 failures', () => {
    // 三个正常插件
    makePlugin('plugin-a', { ...validManifest, id: 'org.example.a' });
    makePlugin('plugin-b', { ...validManifest, id: 'org.example.b' });
    makePlugin('plugin-c', { ...validManifest, id: 'org.example.c' });

    // 一个 apiVersion 不兼容
    makePlugin('plugin-bad-api', {
      ...validManifest,
      id: 'org.example.badapi',
      apiVersion: '^2.0.0',
    });

    // 一个缺 plugin.json
    const noJsonDir = path.join(tmpDir, 'plugin-no-json');
    mkdirSync(noJsonDir, { recursive: true });

    // 一个 plugin.json 是非法 JSON
    const badJsonDir = path.join(tmpDir, 'plugin-bad-json');
    mkdirSync(badJsonDir, { recursive: true });
    writeFileSync(path.join(badJsonDir, 'plugin.json'), '{ not valid json !!!');

    const loader = new PluginLoader();
    const result = loader.loadAll(tmpDir);

    expect(result.loaded).toHaveLength(3);
    const loadedIds = result.loaded.map((p) => p.manifest.id).sort();
    expect(loadedIds).toEqual(['org.example.a', 'org.example.b', 'org.example.c']);

    expect(result.failures).toHaveLength(3);
    // 每条失败都有可读的错误信息
    for (const f of result.failures) {
      expect(f.errors.length).toBeGreaterThan(0);
      expect(typeof f.errors[0]).toBe('string');
      expect(f.errors[0].length).toBeGreaterThan(5);
    }
  });

  it('apiVersion 不兼容的插件被拒绝，错误信息可读', () => {
    makePlugin('good-one', { ...validManifest, id: 'org.example.good' });
    makePlugin(
      'bad-api-one',
      { ...validManifest, id: 'org.example.badapi', apiVersion: '^9.9.9' },
    );

    const result = new PluginLoader().loadAll(tmpDir);

    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0].manifest.id).toBe('org.example.good');

    expect(result.failures).toHaveLength(1);
    const fail = result.failures[0];
    expect(fail.errors[0]).toContain('apiVersion');
    expect(fail.errors[0]).toContain('不兼容');
    expect(fail.errors[0]).toContain('^9.9.9');
  });

  it('apiVersion 格式非法的插件被拒绝', () => {
    makePlugin('good-one', { ...validManifest, id: 'org.example.good' });
    makePlugin(
      'bad-range-one',
      { ...validManifest, id: 'org.example.baddrange', apiVersion: 'not-a-range' },
    );

    const result = new PluginLoader().loadAll(tmpDir);

    expect(result.loaded).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].errors[0]).toContain('SemVer');
  });

  it('入口文件缺失的插件被拒绝，不影响其他插件', () => {
    makePlugin('good-one', { ...validManifest, id: 'org.example.good' });

    // manifest 里 entry 指向不存在的文件
    const missingEntryDir = path.join(tmpDir, 'missing-entry');
    mkdirSync(missingEntryDir, { recursive: true });
    writeFileSync(
      path.join(missingEntryDir, 'plugin.json'),
      JSON.stringify({ ...validManifest, id: 'org.example.missingentry' }),
    );
    // 不写 index.js

    const result = new PluginLoader().loadAll(tmpDir);

    expect(result.loaded).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].errors[0]).toContain('入口文件不存在');
  });

  it('入口模块加载失败（语法错误）被隔离', () => {
    makePlugin('good-one', { ...validManifest, id: 'org.example.good' });

    makePlugin(
      'syntax-error',
      { ...validManifest, id: 'org.example.syntaxerr' },
      'this is not valid javascript {{{',
    );

    const result = new PluginLoader().loadAll(tmpDir);

    expect(result.loaded).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].errors[0]).toContain('入口模块加载失败');
  });

  it('入口模块没有 default 导出工厂函数时被拒绝', () => {
    makePlugin('good-one', { ...validManifest, id: 'org.example.good' });

    makePlugin(
      'no-default-export',
      { ...validManifest, id: 'org.example.nodefault' },
      'module.exports = { notDefault: 123 };',
    );

    const result = new PluginLoader().loadAll(tmpDir);

    expect(result.loaded).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].errors[0]).toContain('default');
  });

  it('插件目录不存在时返回错误而非崩溃', () => {
    const result = new PluginLoader().loadAll(path.join(tmpDir, 'nonexistent'));
    expect(result.loaded).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].errors[0]).toContain('无法读取');
  });

  it('所有插件都失败时不崩溃，loaded 为空', () => {
    makePlugin(
      'bad-api',
      { ...validManifest, id: 'org.example.b1', apiVersion: '^2.0.0' },
    );
    makePlugin(
      'bad-range',
      { ...validManifest, id: 'org.example.b2', apiVersion: 'garbage' },
    );

    const result = new PluginLoader().loadAll(tmpDir);

    expect(result.loaded).toHaveLength(0);
    expect(result.failures).toHaveLength(2);
  });
});
