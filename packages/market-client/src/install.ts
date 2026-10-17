/**
 * 插件 zip 完整性校验与解压（TASK-012）。
 *
 * zip 约定（docs/plugin-spec-v1.md 打包节）：
 *  - 顶层恰好一个目录，目录名 = 插件 id（如 org.example.note/）
 *  - 顶层目录内含 plugin.json（必填）+ package.json（可选）+ dist/ + assets/
 *
 * 校验规则（install/update 共用）：
 *  1. zip 必须可被 adm-zip 解析且非空，否则 INVALID_ZIP。
 *  2. 防路径穿越：拒绝绝对路径、盘符路径、含 `..` 的条目。
 *  3. 顶层恰好一个目录且目录名 === 目标插件 id（否则 ID_MISMATCH / INVALID_ZIP）。
 *  4. `<id>/plugin.json` 必须存在且可解析；manifest.id === 请求的插件 id
 *     （否则 MANIFEST_INVALID / ID_MISMATCH）；entry 指向的文件必须存在。
 *
 * 本模块保持纯函数 + node:fs，不 import @issheepbox/kernel 运行时
 * （id 正则与 kernel manifest.ts ID_RE 保持一致，见下注释）。
 */
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { MarketInstallError } from './types';

/**
 * 插件 id 正则（与 packages/kernel/src/manifest.ts 的 ID_RE 逐字一致）。
 *
 * 复制而非 import，是为了保持 market-client 不依赖 @issheepbox/kernel 运行时
 * （TASK-007 边界：market-client 包虽声明 workspace 依赖，代码上保持解耦）。
 */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

/** 从 zip 读出的插件清单子集（install/update 只用得到这几个字段）。 */
export interface ZipManifest {
  id: string;
  version: string;
  entry: string;
}

/** validatePluginZip 的返回值。 */
export interface ValidatedZip {
  /** 顶层目录名（=== pluginId）。 */
  topDir: string;
  /** `<id>/plugin.json` 解析后的清单。 */
  manifest: ZipManifest;
}

/** 校验插件 id 合法（uninstall 守卫只接受合法 id 对应的顶层目录）。 */
export function assertValidPluginId(pluginId: string): void {
  if (!PLUGIN_ID_RE.test(pluginId)) {
    throw new MarketInstallError(
      'INVALID_PLUGIN_ID',
      `插件 id "${pluginId}" 不符合反向域名格式（如 org.example.my-tool），拒绝操作`,
    );
  }
}

/**
 * 校验 zip 内单个条目路径是否安全（防路径穿越）。
 *
 * 拒绝：绝对路径（Unix `/...`、Windows 盘符 `C:\...`）、含 `..` 的分段。
 * adm-zip 在 Windows 上 entryName 一律使用 `/` 分隔；此处按 `/` 切分。
 */
function assertSafeEntryName(name: string): void {
  if (name.length === 0) {
    throw new MarketInstallError('INVALID_ZIP', 'zip 含空文件名条目');
  }
  if (name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name)) {
    throw new MarketInstallError('INVALID_ZIP', `zip 含绝对路径条目：${name}`);
  }
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new MarketInstallError('INVALID_ZIP', `zip 含路径穿越条目：${name}`);
  }
}

/** 读取并解析 zip；损坏时抛 INVALID_ZIP。 */
function openZip(buf: Buffer): AdmZip {
  try {
    return new AdmZip(buf);
  } catch (err) {
    throw new MarketInstallError(
      'INVALID_ZIP',
      `zip 无法解析（损坏的压缩包）：${(err as Error).message}`,
    );
  }
}

/**
 * 校验插件 zip 完整性。失败抛 MarketInstallError，成功返回顶层目录与清单。
 * 本函数不写磁盘，可安全地在「下载后、解压前」调用。
 */
export function validatePluginZip(buf: Buffer, pluginId: string): ValidatedZip {
  assertValidPluginId(pluginId);
  const zip = openZip(buf);
  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new MarketInstallError('INVALID_ZIP', 'zip 为空包（无任何条目）');
  }

  // 结构校验：所有条目必须安全，且顶层恰好一个目录、目录名 === pluginId。
  const topDirs = new Set<string>();
  for (const entry of entries) {
    const name = entry.entryName;
    assertSafeEntryName(name);
    const firstSegment = name.split('/')[0];
    if (firstSegment) topDirs.add(firstSegment);
  }
  if (topDirs.size !== 1) {
    throw new MarketInstallError(
      'INVALID_ZIP',
      `zip 顶层必须恰好一个目录（当前顶层项：${[...topDirs].join(', ') || '(无)'}）`,
    );
  }
  const topDir = [...topDirs][0];
  if (topDir !== pluginId) {
    throw new MarketInstallError(
      'ID_MISMATCH',
      `zip 顶层目录名 "${topDir}" ≠ 插件 id "${pluginId}"`,
    );
  }

  // plugin.json 必须存在且可解析。
  const manifestPath = `${topDir}/plugin.json`;
  const manifestEntry = entries.find((e) => e.entryName === manifestPath);
  if (!manifestEntry) {
    throw new MarketInstallError('MANIFEST_INVALID', `zip 缺少 ${manifestPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch (err) {
    throw new MarketInstallError(
      'MANIFEST_INVALID',
      `${manifestPath} 不是合法 JSON：${(err as Error).message}`,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MarketInstallError('MANIFEST_INVALID', `${manifestPath} 必须是 JSON 对象`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id === '') {
    throw new MarketInstallError('MANIFEST_INVALID', `${manifestPath} 缺少必填字段 "id"`);
  }
  if (obj.id !== pluginId) {
    throw new MarketInstallError(
      'ID_MISMATCH',
      `manifest.id "${obj.id}" ≠ 插件 id "${pluginId}"`,
    );
  }
  if (typeof obj.version !== 'string' || obj.version === '') {
    throw new MarketInstallError('MANIFEST_INVALID', `${manifestPath} 缺少必填字段 "version"`);
  }
  if (typeof obj.entry !== 'string' || obj.entry === '') {
    throw new MarketInstallError('MANIFEST_INVALID', `${manifestPath} 缺少必填字段 "entry"`);
  }

  // entry 指向的文件必须在包内存在（可选校验：提前拦截坏包，
  // 避免「解压成功但内核 discovery 失败」的模糊体验）。
  const entryTarget = `${topDir}/${obj.entry}`;
  if (!entries.some((e) => e.entryName === entryTarget)) {
    throw new MarketInstallError(
      'MANIFEST_INVALID',
      `manifest.entry "${obj.entry}" 指向的文件不在包内：${entryTarget}`,
    );
  }

  return {
    topDir,
    manifest: {
      id: obj.id,
      version: obj.version,
      entry: obj.entry,
    },
  };
}

/**
 * 校验插件 zip 完整性（自报 id 形态，本地导入用）。
 *
 * 与 validatePluginZip 的区别：不预先知道 pluginId——校验 zip 结构安全、
 * 顶层恰好一个目录、`<topDir>/plugin.json` 存在且合法、manifest.id === topDir
 * （即 zip 自我声明一致）。返回的 ValidatedZip.manifest.id 即插件 id。
 */
export function validatePluginZipSelf(buf: Buffer): ValidatedZip {
  const zip = openZip(buf);
  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new MarketInstallError('INVALID_ZIP', 'zip 为空包（无任何条目）');
  }

  const topDirs = new Set<string>();
  for (const entry of entries) {
    const name = entry.entryName;
    assertSafeEntryName(name);
    const firstSegment = name.split('/')[0];
    if (firstSegment) topDirs.add(firstSegment);
  }
  if (topDirs.size !== 1) {
    throw new MarketInstallError(
      'INVALID_ZIP',
      `zip 顶层必须恰好一个目录（当前顶层项：${[...topDirs].join(', ') || '(无)'}）`,
    );
  }
  const topDir = [...topDirs][0];
  assertValidPluginId(topDir);

  const manifestPath = `${topDir}/plugin.json`;
  const manifestEntry = entries.find((e) => e.entryName === manifestPath);
  if (!manifestEntry) {
    throw new MarketInstallError('MANIFEST_INVALID', `zip 缺少 ${manifestPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch (err) {
    throw new MarketInstallError(
      'MANIFEST_INVALID',
      `${manifestPath} 不是合法 JSON：${(err as Error).message}`,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MarketInstallError('MANIFEST_INVALID', `${manifestPath} 必须是 JSON 对象`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id === '') {
    throw new MarketInstallError('MANIFEST_INVALID', `${manifestPath} 缺少必填字段 "id"`);
  }
  if (obj.id !== topDir) {
    throw new MarketInstallError(
      'ID_MISMATCH',
      `manifest.id "${obj.id}" ≠ zip 顶层目录名 "${topDir}"（包自报不一致）`,
    );
  }
  if (typeof obj.version !== 'string' || obj.version === '') {
    throw new MarketInstallError('MANIFEST_INVALID', `${manifestPath} 缺少必填字段 "version"`);
  }
  if (typeof obj.entry !== 'string' || obj.entry === '') {
    throw new MarketInstallError('MANIFEST_INVALID', `${manifestPath} 缺少必填字段 "entry"`);
  }
  const entryTarget = `${topDir}/${obj.entry}`;
  if (!entries.some((e) => e.entryName === entryTarget)) {
    throw new MarketInstallError(
      'MANIFEST_INVALID',
      `manifest.entry "${obj.entry}" 指向的文件不在包内：${entryTarget}`,
    );
  }

  return {
    topDir,
    manifest: {
      id: obj.id,
      version: obj.version,
      entry: obj.entry,
    },
  };
}

/**
 * 把已校验的 zip 解压到 destDir（临时目录）。
 *
 * 调用方必须先 validatePluginZip（得到 topDir）；zip 顶层目录 `<topDir>/` 前缀在此剥除，
 * 使 destDir 本身即插件包根（destDir/plugin.json 直接存在）。
 * 本函数仍逐条防御性校验路径（不信任 zip 内容）。
 * 失败时由调用方负责清理 destDir（install/update 均在 try/catch 中清理）。
 */
export function extractZipTo(buf: Buffer, destDir: string, topDir: string): void {
  const zip = openZip(buf);
  fs.mkdirSync(destDir, { recursive: true });
  const prefix = `${topDir}/`;
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    assertSafeEntryName(name);
    if (!name.startsWith(prefix)) {
      throw new MarketInstallError('INVALID_ZIP', `zip 条目不在顶层目录内：${name}`);
    }
    const relative = name.slice(prefix.length);
    if (relative === '') continue;
    const target = path.join(destDir, ...relative.split('/'));
    // 双重保险：resolve 后必须仍在 destDir 下。
    const resolved = path.resolve(target);
    if (path.relative(path.resolve(destDir), resolved).startsWith('..')) {
      throw new MarketInstallError('INVALID_ZIP', `解压目标越出包目录：${name}`);
    }
    if (entry.isDirectory) {
      fs.mkdirSync(resolved, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, entry.getData());
    }
  }
}
