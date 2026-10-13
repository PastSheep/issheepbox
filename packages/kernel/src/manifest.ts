/**
 * Manifest 解析与校验。
 *
 * 规则对齐 docs/plugin-spec-v1.md 第 3 节与第 10 节校验清单：
 *  - plugin.json 必须是合法 JSON 对象
 *  - 必填字段：id / name / version / apiVersion / entry
 *  - id 必须是反向域名风格（至少两级，全小写字母数字点号）
 *  - version 必须是 MAJOR.MINOR.PATCH 形态（宽松校验，SemVer 范围比对留给 TASK-005）
 *
 * 任何一条失败都返回结构化错误数组，由加载器收集进 failures，不影响其他插件。
 */
import type { PluginManifest } from './types';

const ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+([-+].+)?$/;

export interface ParseManifestResult {
  manifest: PluginManifest | null;
  errors: string[];
}

/**
 * 解析并校验一份未知 JSON，返回 manifest 或错误列表。
 *
 * @param raw plugin.json 解析后的对象（unknown）
 * @param where 用于错误信息标注来源目录
 */
export function parseManifest(raw: unknown, where: string): ParseManifestResult {
  const errors: string[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manifest: null, errors: [`${where}: plugin.json 必须是 JSON 对象`] };
  }

  const obj = raw as Record<string, unknown>;

  const required: Array<keyof PluginManifest> = [
    'id',
    'name',
    'version',
    'apiVersion',
    'entry',
  ];
  for (const field of required) {
    const value = obj[field];
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${where}: 缺少必填字段 "${field}" 或不是非空字符串`);
    }
  }

  const id = obj.id;
  if (typeof id === 'string' && !ID_RE.test(id)) {
    errors.push(
      `${where}: id "${id}" 不符合反向域名格式（如 org.example.my-tool）`,
    );
  }

  const version = obj.version;
  if (typeof version === 'string' && !SEMVER_RE.test(version)) {
    errors.push(
      `${where}: version "${version}" 不是合法 SemVer（应为 MAJOR.MINOR.PATCH）`,
    );
  }

  const entry = obj.entry;
  if (typeof entry === 'string') {
    if (entry === '' || entry.startsWith('/') || entry.includes('..')) {
      errors.push(`${where}: entry "${entry}" 必须是包内相对路径，不得越出包根`);
    }
  }

  if (errors.length > 0) {
    return { manifest: null, errors };
  }

  // 通过校验，组装 manifest（可选字段按规范默认值补全）。
  const manifest: PluginManifest = {
    id: id as string,
    name: obj.name as string,
    version: version as string,
    apiVersion: obj.apiVersion as string,
    entry: entry as string,
    description: typeof obj.description === 'string' ? obj.description : '',
    author: typeof obj.author === 'string' ? obj.author : '',
    homepage: typeof obj.homepage === 'string' ? obj.homepage : undefined,
    repository: typeof obj.repository === 'string' ? obj.repository : undefined,
    license: typeof obj.license === 'string' ? obj.license : 'MIT',
    icon: typeof obj.icon === 'string' ? obj.icon : undefined,
    ui: obj.ui as PluginManifest['ui'],
    permissions: Array.isArray(obj.permissions) ? (obj.permissions as string[]) : [],
    requires:
      obj.requires && typeof obj.requires === 'object'
        ? (obj.requires as Record<string, string>)
        : {},
    contributes: obj.contributes as PluginManifest['contributes'],
  };

  return { manifest, errors: [] };
}
