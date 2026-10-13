/**
 * Manifest 解析校验单元测试。
 *
 * 覆盖 docs/plugin-spec-v1.md 第 10 节校验规则 #1~#4：
 *  - 必须是 JSON 对象
 *  - 必填字段齐全
 *  - id 格式合规（反向域名）
 *  - version 是合法 SemVer
 *  - entry 路径安全（不越出包根）
 */
import { describe, it, expect } from 'vitest';
import { parseManifest } from '../manifest';

const validBase = {
  id: 'org.example.my-plugin',
  name: '我的插件',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  entry: 'index.js',
};

describe('parseManifest', () => {
  it('合法 manifest 解析成功，可选字段补全默认值', () => {
    const { manifest, errors } = parseManifest(validBase, '/plugins/test');
    expect(errors).toEqual([]);
    expect(manifest).not.toBeNull();
    expect(manifest!.id).toBe('org.example.my-plugin');
    expect(manifest!.license).toBe('MIT');
    expect(manifest!.permissions).toEqual([]);
    expect(manifest!.requires).toEqual({});
    expect(manifest!.description).toBe('');
  });

  it('拒绝 null 输入', () => {
    const { manifest, errors } = parseManifest(null, '/plugins/test');
    expect(manifest).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('JSON 对象');
  });

  it('拒绝数组输入', () => {
    const { manifest, errors } = parseManifest([1, 2, 3], '/plugins/test');
    expect(manifest).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('拒绝字符串输入', () => {
    const { manifest, errors } = parseManifest('just a string', '/plugins/test');
    expect(manifest).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('缺少必填字段时列出所有缺失字段', () => {
    const { manifest, errors } = parseManifest({}, '/plugins/test');
    expect(manifest).toBeNull();
    // 5 个必填字段全部缺失
    expect(errors.length).toBe(5);
    expect(errors.some((e) => e.includes('"id"'))).toBe(true);
    expect(errors.some((e) => e.includes('"name"'))).toBe(true);
    expect(errors.some((e) => e.includes('"version"'))).toBe(true);
    expect(errors.some((e) => e.includes('"apiVersion"'))).toBe(true);
    expect(errors.some((e) => e.includes('"entry"'))).toBe(true);
  });

  it('id 不符合反向域名格式时报错', () => {
    const badIds = [
      'justonelevel',      // 只有一级
      'UPPER.Case',        // 大写
      'org..double',       // 双点
      '.org.example',      // 开头点
      'org.example.',      // 结尾点
      '123.numbers',       // 开头数字
    ];
    for (const id of badIds) {
      const input = { ...validBase, id };
      const { manifest, errors } = parseManifest(input, '/plugins/test');
      expect(manifest).toBeNull();
      expect(errors.some((e) => e.includes('反向域名'))).toBe(true);
    }
  });

  it('version 不是合法 SemVer 时报错', () => {
    const badVersions = ['1.0', 'v1.0.0', 'latest', '1.0.0.0', 'abc'];
    for (const version of badVersions) {
      const input = { ...validBase, version };
      const { manifest, errors } = parseManifest(input, '/plugins/test');
      expect(manifest).toBeNull();
      expect(errors.some((e) => e.includes('SemVer'))).toBe(true);
    }
  });

  it('entry 路径越出包根时报错', () => {
    const badEntries = ['../index.js', '/abs/path.js', ''];
    for (const entry of badEntries) {
      const input = { ...validBase, entry };
      const { manifest, errors } = parseManifest(input, '/plugins/test');
      expect(manifest).toBeNull();
      expect(errors.some((e) => e.includes('entry'))).toBe(true);
    }
  });

  it('可选字段正确透传', () => {
    const input = {
      ...validBase,
      description: '测试描述',
      author: '测试作者',
      license: 'Apache-2.0',
      permissions: ['network:fetch'],
    };
    const { manifest } = parseManifest(input, '/plugins/test');
    expect(manifest!.description).toBe('测试描述');
    expect(manifest!.author).toBe('测试作者');
    expect(manifest!.license).toBe('Apache-2.0');
    expect(manifest!.permissions).toEqual(['network:fetch']);
  });
});
