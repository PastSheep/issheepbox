/**
 * 兼容性校验单元测试（TASK-005）。
 *
 * 覆盖：
 *  - validateApiVersionRange：合法/非法 SemVer range 识别
 *  - checkApiCompatibility：与当前内核版本的比对（通过/拒绝）
 *  - 边界场景：空字符串、非法格式、主版本不匹配、patch 级兼容
 */
import { describe, it, expect } from 'vitest';
import {
  CURRENT_API_VERSION,
  validateApiVersionRange,
  checkApiCompatibility,
} from '../compat';

describe('validateApiVersionRange', () => {
  it('接受标准 caret range（^1.0.0）', () => {
    const r = validateApiVersionRange('^1.0.0', 'test');
    expect(r.valid).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('接受 tilde range（~1.2.0）', () => {
    const r = validateApiVersionRange('~1.2.0', 'test');
    expect(r.valid).toBe(true);
  });

  it('接受比较符 range（>=1.0.0 <2.0.0）', () => {
    const r = validateApiVersionRange('>=1.0.0 <2.0.0', 'test');
    expect(r.valid).toBe(true);
  });

  it('接受精确版本（1.0.0）', () => {
    const r = validateApiVersionRange('1.0.0', 'test');
    expect(r.valid).toBe(true);
  });

  it('接受 x-range（1.x）', () => {
    const r = validateApiVersionRange('1.x', 'test');
    expect(r.valid).toBe(true);
  });

  it('拒绝空字符串', () => {
    const r = validateApiVersionRange('', 'test-plugin');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('apiVersion');
  });

  it('拒绝完全非法的字符串', () => {
    const r = validateApiVersionRange('not-a-version', 'test-plugin');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('SemVer');
  });

  it('拒绝只有文字的字符串', () => {
    const r = validateApiVersionRange('latest', 'test-plugin');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('SemVer');
  });

  it('错误信息包含 where 前缀', () => {
    const r = validateApiVersionRange('invalid!!!', '/path/to/plugin');
    expect(r.error).toContain('/path/to/plugin');
  });
});

describe('checkApiCompatibility', () => {
  it('^1.0.0 与当前 1.0.0 兼容', () => {
    const r = checkApiCompatibility('^1.0.0', 'test');
    expect(r.compatible).toBe(true);
  });

  it('~1.0.0 与当前 1.0.0 兼容', () => {
    const r = checkApiCompatibility('~1.0.0', 'test');
    expect(r.compatible).toBe(true);
  });

  it('>=1.0.0 <2.0.0 与当前 1.0.0 兼容', () => {
    const r = checkApiCompatibility('>=1.0.0 <2.0.0', 'test');
    expect(r.compatible).toBe(true);
  });

  it('精确 1.0.0 与当前 1.0.0 兼容', () => {
    const r = checkApiCompatibility('1.0.0', 'test');
    expect(r.compatible).toBe(true);
  });

  it('^2.0.0 与当前 1.x 不兼容（主版本不匹配）', () => {
    const r = checkApiCompatibility('^2.0.0', 'test-plugin');
    expect(r.compatible).toBe(false);
    expect(r.error).toContain('不兼容');
    expect(r.error).toContain('^2.0.0');
    expect(r.error).toContain(CURRENT_API_VERSION);
  });

  it('>=2.0.0 与当前 1.x 不兼容', () => {
    const r = checkApiCompatibility('>=2.0.0', 'test-plugin');
    expect(r.compatible).toBe(false);
  });

  it('范围格式非法时返回错误', () => {
    const r = checkApiCompatibility('garbage!!!', 'test-plugin');
    expect(r.compatible).toBe(false);
    expect(r.error).toContain('SemVer');
  });

  it('可以传入自定义 kernelVersion 进行比对', () => {
    // 模拟内核升级到 1.5.0
    const r = checkApiCompatibility('^1.0.0', 'test', '1.5.0');
    expect(r.compatible).toBe(true);

    // 模拟内核升级到 2.0.0，^1.0.0 不兼容
    const r2 = checkApiCompatibility('^1.0.0', 'test', '2.0.0');
    expect(r2.compatible).toBe(false);
  });

  it('错误信息包含插件路径前缀', () => {
    const r = checkApiCompatibility('^3.0.0', '/plugins/my-broken-plugin');
    expect(r.error).toContain('/plugins/my-broken-plugin');
  });
});
