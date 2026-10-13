/**
 * registry 索引解析（容错）。
 *
 * 校验规则对齐 docs/plugin-registry-schema.md 第 5 节 draft-07 JSON Schema：
 *  - 顶层必填：registryVersion / generatedAt / plugins
 *  - 条目必填：id / name / description / author / version / apiVersion /
 *    repository / releaseUrl / downloadUrl / permissions / publishedAt
 *  - id 反向域名风格；version 严格 SemVer；URL 须为 http(s)
 *  - 可选字段：license / icon / homepage / requires / tags
 *
 * 容错策略（「解析非法条目容错」）：
 *  - 任何层级的错误都不抛异常，一律落入结构化错误字段。
 *  - 顶层非法 → index=null，不解析条目。
 *  - 单条非法 → 该条目被拒绝并记录原因，其余条目照常返回。
 *  - id 重复 → 保留首个，重复条目被拒绝。
 *  - 未知额外属性 → 忽略（向前兼容；schema 的 additionalProperties:false
 *    留给 registry 维护侧机器校验，客户端放宽接受）。
 */
import type {
  RegistryIndex,
  RegistryIndexParseResult,
  RegistryPluginEntry,
} from './types';

/** 本客户端支持的 registry 格式版本（schema 当前 1.0.0）。 */
export const SUPPORTED_REGISTRY_VERSIONS = ['1.0.0'];

/**
 * 反向域名风格：至少两级，小写字母数字点号。
 *
 * 注意：docs/plugin-registry-schema.md 第 5 节 schema 的 id pattern 未含连字符
 * （^[a-z][a-z0-9]*(\.[a-z0-9]+)+$），与权威规范冲突：
 *  - docs/plugin-spec-v1.md 第 3.2 节 id 示例即含连字符（com.example.my-tool）；
 *  - kernel 的 manifest 校验（packages/kernel/src/manifest.ts）同样允许连字符。
 * registry 条目 id「与插件 manifest 中 id 一致」，故客户端按规范接受连字符，
 * schema 的 pattern 视为草稿疏漏（后续修订 schema 时对齐）。
 */
const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
/** 严格 SemVer（MAJOR.MINOR.PATCH，不带 v 前缀、不带预发布/build）。 */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
/** 简单 URI 校验：要求 http/https 且非空。 */
const HTTP_URL_RE = /^https?:\/\/\S+$/i;

interface EntryValidationOk {
  ok: true;
  entry: RegistryPluginEntry;
}

interface EntryValidationFail {
  ok: false;
  /** 能读出的 id（缺失/类型错误时可能为 undefined）。 */
  id?: string;
  reasons: string[];
}

type EntryValidation = EntryValidationOk | EntryValidationFail;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 校验单个 registry 条目。 */
function validateEntry(raw: unknown, index: number): EntryValidation {
  const reasons: string[] = [];
  if (!isRecord(raw)) {
    return {
      ok: false,
      reasons: [`plugins[${index}] 不是 JSON 对象`],
    };
  }

  const id = raw.id;
  if (typeof id !== 'string' || id.trim() === '') {
    reasons.push(`plugins[${index}] 缺少必填字段 "id" 或不是非空字符串`);
  } else if (!ID_RE.test(id)) {
    reasons.push(`id "${id}" 不符合反向域名格式（如 org.example.my-tool）`);
  }

  const name = raw.name;
  if (typeof name !== 'string' || name.trim() === '') {
    reasons.push(`plugins[${index}] 缺少必填字段 "name" 或不是非空字符串`);
  } else if (name.length > 50) {
    reasons.push(`name "${name.slice(0, 30)}…" 超过 50 字符上限（schema maxLength）`);
  }

  const description = raw.description;
  if (typeof description !== 'string' || description.trim() === '') {
    reasons.push(`plugins[${index}] 缺少必填字段 "description" 或不是非空字符串`);
  } else if (description.length > 200) {
    reasons.push('description 超过 200 字符上限（schema maxLength）');
  }

  const author = raw.author;
  if (typeof author !== 'string' || author.trim() === '') {
    reasons.push(`plugins[${index}] 缺少必填字段 "author" 或不是非空字符串`);
  } else if (author.length > 100) {
    reasons.push(`author "${author.slice(0, 30)}…" 超过 100 字符上限（schema maxLength）`);
  }

  const version = raw.version;
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    reasons.push(
      `version "${String(version)}" 不是严格 SemVer（应为 MAJOR.MINOR.PATCH，如 1.2.3）`,
    );
  }

  const apiVersion = raw.apiVersion;
  if (typeof apiVersion !== 'string' || apiVersion.trim() === '') {
    reasons.push(`plugins[${index}] 缺少必填字段 "apiVersion" 或不是非空字符串`);
  }

  // URL 三件套：repository / releaseUrl / downloadUrl
  const urlFields: Array<[string, unknown]> = [
    ['repository', raw.repository],
    ['releaseUrl', raw.releaseUrl],
    ['downloadUrl', raw.downloadUrl],
  ];
  for (const [field, value] of urlFields) {
    if (typeof value !== 'string' || !HTTP_URL_RE.test(value)) {
      reasons.push(
        `"${field}" 必须是 http(s) URL（当前值：${value === undefined ? '(缺失)' : String(value)}）`,
      );
    }
  }

  // 可选 URL：icon / homepage
  for (const [field, value] of [
    ['icon', raw.icon],
    ['homepage', raw.homepage],
  ] as const) {
    if (value !== undefined && (typeof value !== 'string' || !HTTP_URL_RE.test(value))) {
      reasons.push(`可选字段 "${field}" 存在但必须是 http(s) URL`);
    }
  }

  // permissions：必填，字符串数组（透传，不校验授权）
  if (!Array.isArray(raw.permissions)) {
    reasons.push('缺少必填字段 "permissions" 或不是数组');
  } else if (!raw.permissions.every((p) => typeof p === 'string')) {
    reasons.push('"permissions" 数组含非字符串元素');
  }

  // publishedAt：必填，可被 Date 解析的 ISO 8601 时间
  const publishedAt = raw.publishedAt;
  if (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt))) {
    reasons.push(
      `"publishedAt" 必须是 ISO 8601 时间字符串（当前值：${publishedAt === undefined ? '(缺失)' : String(publishedAt)}）`,
    );
  }

  // 可选字段类型校验
  if (raw.license !== undefined && typeof raw.license !== 'string') {
    reasons.push('可选字段 "license" 必须是字符串');
  }
  if (
    raw.requires !== undefined &&
    (raw.requires === null || typeof raw.requires !== 'object' || Array.isArray(raw.requires))
  ) {
    reasons.push('可选字段 "requires" 必须是对象');
  }
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t) => typeof t === 'string')) {
      reasons.push('可选字段 "tags" 必须是字符串数组');
    }
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      id: typeof id === 'string' ? id : undefined,
      reasons,
    };
  }

  const entry: RegistryPluginEntry = {
    id: id as string,
    name: name as string,
    description: description as string,
    author: author as string,
    version: version as string,
    apiVersion: apiVersion as string,
    repository: raw.repository as string,
    releaseUrl: raw.releaseUrl as string,
    downloadUrl: raw.downloadUrl as string,
    permissions: raw.permissions as string[],
    publishedAt: publishedAt as string,
  };
  // 可选字段仅在「存在且类型正确」时写出（已通过上述校验）。
  if (typeof raw.license === 'string') entry.license = raw.license;
  if (typeof raw.icon === 'string') entry.icon = raw.icon;
  if (typeof raw.homepage === 'string') entry.homepage = raw.homepage;
  if (isRecord(raw.requires)) entry.requires = raw.requires as Record<string, string>;
  if (Array.isArray(raw.tags)) entry.tags = raw.tags as string[];

  return { ok: true, entry };
}

/**
 * 解析未知 JSON 为 registry 索引（容错，永不抛异常）。
 *
 * @param raw JSON.parse 之后的值（unknown）
 */
export function parseRegistryIndex(raw: unknown): RegistryIndexParseResult {
  const result: RegistryIndexParseResult = {
    index: null,
    entries: [],
    invalid: [],
    topLevelErrors: [],
    total: 0,
    registryVersionSupported: false,
  };

  if (!isRecord(raw)) {
    result.topLevelErrors.push('plugins.json 顶层必须是 JSON 对象');
    return result;
  }

  const registryVersion = raw.registryVersion;
  if (typeof registryVersion !== 'string' || !SEMVER_RE.test(registryVersion)) {
    result.topLevelErrors.push(
      `"registryVersion" 必须是 SemVer（如 1.0.0，当前值：${registryVersion === undefined ? '(缺失)' : String(registryVersion)}）`,
    );
  }

  const generatedAt = raw.generatedAt;
  if (typeof generatedAt !== 'string' || Number.isNaN(Date.parse(generatedAt))) {
    result.topLevelErrors.push(
      `"generatedAt" 必须是 ISO 8601 时间字符串（当前值：${generatedAt === undefined ? '(缺失)' : String(generatedAt)}）`,
    );
  }

  if (!Array.isArray(raw.plugins)) {
    result.topLevelErrors.push('"plugins" 必须是数组');
  }

  // 顶层任一字段非法即视为索引结构非法（不继续解析条目）。
  if (result.topLevelErrors.length > 0) {
    return result;
  }

  result.registryVersionSupported = SUPPORTED_REGISTRY_VERSIONS.includes(
    registryVersion as string,
  );

  const rawPlugins = raw.plugins as unknown[];
  result.total = rawPlugins.length;

  const seenIds = new Set<string>();
  rawPlugins.forEach((entryRaw, i) => {
    const outcome = validateEntry(entryRaw, i);
    if (!outcome.ok) {
      result.invalid.push({ index: i, id: outcome.id, reasons: outcome.reasons });
      return;
    }
    if (seenIds.has(outcome.entry.id)) {
      result.invalid.push({
        index: i,
        id: outcome.entry.id,
        reasons: [`id "${outcome.entry.id}" 重复：registry 要求全局唯一（保留首个条目）`],
      });
      return;
    }
    seenIds.add(outcome.entry.id);
    result.entries.push(outcome.entry);
  });

  const index: RegistryIndex = {
    registryVersion: registryVersion as string,
    generatedAt: generatedAt as string,
    plugins: result.entries,
  };
  result.index = index;
  return result;
}
