/**
 * 兼容性校验（TASK-005）。
 *
 * 对齐 docs/requirements.md 4.5 兼容性契约与 docs/plugin-spec-v1.md 第 10 节校验规则 #5：
 *  - 插件 manifest 声明所需 apiVersion 范围（SemVer range）
 *  - 内核加载时用当前 ctx API 具体版本与该范围比对
 *  - 不匹配 = 拒绝加载该插件 + 可读原因，不影响其他插件（失败隔离）
 *
 * 语义化版本约定：
 *  - 内核侧：CURRENT_API_VERSION 是一个具体 SemVer 版本号（如 1.0.0）
 *  - 插件侧：manifest.apiVersion 是一个 SemVer range（如 ^1.0.0）
 *  - 主版本号是兼容性边界：MAJOR 不同 = 破坏性变更，必须拒绝加载
 */
import semver from 'semver';

/**
 * 当前内核暴露给插件的 ctx API 具体版本。
 *
 * 兼容性契约（见 docs/requirements.md 4.5）：
 *  - 1.x 生命周期内只增不破，旧插件永远可用
 *  - 破坏性变更仅允许在新主版本发生
 *  - minor / patch 升级无需插件修改
 */
export const CURRENT_API_VERSION = '1.0.0' as const;

/** 兼容性校验结果。 */
export interface CompatCheckResult {
  /** 是否兼容（通过校验）。 */
  compatible: boolean;
  /** 不兼容时的可读原因。 */
  error?: string;
}

/**
 * 校验 apiVersion 字段是否为合法 SemVer range。
 *
 * @param apiVersion manifest 中的 apiVersion 字段值
 * @param where 错误信息前缀（插件目录路径）
 */
export function validateApiVersionRange(
  apiVersion: string,
  where: string,
): { valid: boolean; error?: string } {
  if (!apiVersion || typeof apiVersion !== 'string') {
    return {
      valid: false,
      error: `${where}: apiVersion 字段缺失或不是字符串`,
    };
  }

  if (!semver.validRange(apiVersion)) {
    return {
      valid: false,
      error: `${where}: apiVersion "${apiVersion}" 不是合法的 SemVer 范围（如 ^1.0.0、~1.2、>=1.0 <2.0）`,
    };
  }

  return { valid: true };
}

/**
 * 检查插件声明的 apiVersion 范围是否与当前内核版本兼容。
 *
 * @param manifestApiVersion 插件 manifest 中的 apiVersion 范围
 * @param where 错误信息前缀（插件目录路径）
 * @param kernelVersion 当前内核 ctx API 版本（默认 CURRENT_API_VERSION）
 */
export function checkApiCompatibility(
  manifestApiVersion: string,
  where: string,
  kernelVersion: string = CURRENT_API_VERSION,
): CompatCheckResult {
  // 先校验范围格式本身是否合法
  const rangeCheck = validateApiVersionRange(manifestApiVersion, where);
  if (!rangeCheck.valid) {
    return { compatible: false, error: rangeCheck.error };
  }

  // 再做兼容性比对
  if (!semver.satisfies(kernelVersion, manifestApiVersion)) {
    return {
      compatible: false,
      error:
        `${where}: apiVersion 范围 "${manifestApiVersion}" ` +
        `与当前内核 ctx API 版本 ${kernelVersion} 不兼容`,
    };
  }

  return { compatible: true };
}
