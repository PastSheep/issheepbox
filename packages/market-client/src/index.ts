/**
 * 插件市场客户端（TASK-007 拉取/解析/查询；TASK-012 安装/卸载/更新）。
 *
 *  1. 按 docs/plugin-registry-schema.md（draft-07 JSON Schema）拉取并解析
 *     registry 索引 plugins.json（默认 URL 见 DEFAULT_REGISTRY_URL）。
 *  2. 查询接口：list() 按条件过滤、getById() 精确查询；解析非法条目容错
 *     （非法条目被拒绝并记录原因，不抛异常、不影响其余条目）。
 *  3. install/uninstall/update（TASK-012）：下载 zip → 完整性校验 → 解压到
 *     pluginsDir（构造选项注入）；update 版本比对后原子替换；失败清理临时目录、
 *     不残留半成品。错误一律为带 code 的 MarketInstallError（见 src/types.ts）。
 *
 * 边界：本包不 import @issheepbox/kernel 运行时内容（loader/profile），
 * 插件发现与授权门禁由宿主（desktop/内核）在安装后接线。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertValidPluginId,
  extractZipTo,
  validatePluginZip,
} from './install';
import { parseRegistryIndex } from './parse';
import type {
  InstallResult,
  InstalledPluginInfo,
  MarketClientOptions,
  RegistryIndex,
  RegistryIndexParseResult,
  RegistryPluginEntry,
  RegistryQuery,
  UpdateResult,
} from './types';
import { MarketInstallError, RegistryFetchError } from './types';
import { compareVersions } from './versions';

export * from './types';
export { parseRegistryIndex, SUPPORTED_REGISTRY_VERSIONS } from './parse';
export { compareVersions, parseSemver } from './versions';
export {
  PLUGIN_ID_RE,
  assertValidPluginId,
  validatePluginZip,
  extractZipTo,
} from './install';
export type { ValidatedZip, ZipManifest } from './install';

/**
 * registry 索引默认地址。
 *
 * 指向官方 registry 仓库（PastSheep/issheepbox-registry）的 raw 索引文件，
 * 该地址已实测返回 200。构造 MarketClient 时仍可传入 registryUrl 覆盖。
 */
export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/PastSheep/issheepbox-registry/main/plugins.json';

/** 默认拉取超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 市场客户端：拉取 + 解析 registry 索引，提供列表/过滤查询。
 *
 * 使用示例：
 * ```ts
 * const client = new MarketClient();
 * const result = await client.fetchIndex();
 * if (result.topLevelErrors.length > 0) return; // 索引结构非法
 * const notePlugins = client.list({ tag: 'note' });
 * ```
 */
export class MarketClient {
  /** registry 索引 URL（构造时指定或使用占位常量）。 */
  readonly registryUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** 插件安装目录（install/uninstall/update 必需；未配置时为 null）。 */
  private readonly pluginsDir: string | null;
  /** 最近一次 fetchIndex() 的解析结果（未拉取过时为 null）。 */
  private lastResult: RegistryIndexParseResult | null = null;

  constructor(options: MarketClientOptions = {}) {
    this.registryUrl = options.registryUrl ?? DEFAULT_REGISTRY_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pluginsDir = options.pluginsDir ?? null;
  }

  /**
   * 拉取并解析 registry 索引。
   *
   * - 网络失败 / 非 2xx：抛 RegistryFetchError（携带 HTTP 状态码）。
   * - 响应体非法 JSON / 顶层结构非法：不抛异常，错误落在返回结果的
   *   topLevelErrors（index=null）。
   * - 部分条目非法：合法条目保留，非法条目在 invalid 中逐条记录原因。
   */
  async fetchIndex(): Promise<RegistryIndexParseResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.registryUrl, { signal: controller.signal });
    } catch (err) {
      throw new RegistryFetchError(`拉取 registry 失败：${String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new RegistryFetchError(`registry 返回 HTTP ${res.status}`, res.status);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new RegistryFetchError(`读取 registry 响应失败：${String(err)}`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      // 响应体不是合法 JSON：按解析失败处理，不抛异常。
      const failed: RegistryIndexParseResult = {
        index: null,
        entries: [],
        invalid: [],
        topLevelErrors: [`plugins.json 不是合法 JSON：${String(err)}`],
        total: 0,
        registryVersionSupported: false,
      };
      this.lastResult = failed;
      return failed;
    }

    this.lastResult = parseRegistryIndex(raw);
    return this.lastResult;
  }

  /**
   * 兼容旧占位命名：拉取并解析（等价 fetchIndex）。
   * 仅保留给既有调用方；新代码请使用 fetchIndex。
   */
  refresh(): Promise<RegistryIndexParseResult> {
    return this.fetchIndex();
  }

  /** 最近一次解析结果（未 fetchIndex 过则为 null）。 */
  get lastParseResult(): RegistryIndexParseResult | null {
    return this.lastResult;
  }

  /** 当前缓存的索引（顶层非法或未拉取时为 null）。 */
  get currentIndex(): RegistryIndex | null {
    return this.lastResult?.index ?? null;
  }

  /**
   * 列出插件（按查询条件过滤，字段间为「且」关系）。
   * 未拉取过 / 顶层解析失败时返回空数组。
   */
  list(query: RegistryQuery = {}): RegistryPluginEntry[] {
    const entries = this.lastResult?.entries ?? [];
    let out = entries;

    if (query.id !== undefined) {
      out = out.filter((e) => e.id === query.id);
    }
    if (query.name !== undefined) {
      const needle = query.name.toLowerCase();
      out = out.filter((e) => e.name.toLowerCase().includes(needle));
    }
    if (query.author !== undefined) {
      const needle = query.author.toLowerCase();
      out = out.filter((e) => e.author.toLowerCase().includes(needle));
    }
    if (query.version !== undefined) {
      out = out.filter((e) => e.version === query.version);
    }
    if (query.apiVersion !== undefined) {
      out = out.filter((e) => e.apiVersion === query.apiVersion);
    }
    if (query.license !== undefined) {
      out = out.filter((e) => e.license === query.license);
    }
    const tag = query.tag;
    if (tag !== undefined) {
      out = out.filter((e) => e.tags?.includes(tag) ?? false);
    }
    const permission = query.permission;
    if (permission !== undefined) {
      out = out.filter((e) => e.permissions.includes(permission));
    }
    if (query.search !== undefined) {
      const needle = query.search.toLowerCase();
      out = out.filter((e) =>
        [e.id, e.name, e.description, e.author]
          .map((s) => s.toLowerCase())
          .some((s) => s.includes(needle)),
      );
    }

    if (query.limit !== undefined && query.limit >= 0) {
      out = out.slice(0, query.limit);
    }
    return out;
  }

  /** 按 id 精确查询（未拉取过或 id 不存在时返回 undefined）。 */
  getById(id: string): RegistryPluginEntry | undefined {
    return this.lastResult?.entries.find((e) => e.id === id);
  }

  /** 顶层解析错误（未拉取过时为空数组）。 */
  topLevelErrors(): string[] {
    return this.lastResult?.topLevelErrors ?? [];
  }

  /** 非法条目清单（未拉取过时为空数组）。 */
  invalidEntries(): RegistryIndexParseResult['invalid'] {
    return this.lastResult?.invalid ?? [];
  }

  // ---------------------------------------------------------------------
  // 下载 / 安装 / 卸载 / 更新（TASK-012）
  // ---------------------------------------------------------------------

  /** 取 pluginsDir；未配置时抛 PLUGINS_DIR_REQUIRED。 */
  private requirePluginsDir(): string {
    if (!this.pluginsDir) {
      throw new MarketInstallError(
        'PLUGINS_DIR_REQUIRED',
        '安装/卸载/更新需要在构造 MarketClient 时传入 pluginsDir（插件安装目录）',
      );
    }
    return this.pluginsDir;
  }

  /** 按 id 取 registry 条目；缺失抛 NOT_IN_REGISTRY。 */
  private requireEntry(pluginId: string): RegistryPluginEntry {
    const entry = this.getById(pluginId);
    if (!entry) {
      throw new MarketInstallError('NOT_IN_REGISTRY', `registry 索引中没有插件 "${pluginId}"`);
    }
    return entry;
  }

  /** 下载某个 URL 的 zip 字节（带超时；网络失败/非 2xx 抛类型化错误）。 */
  private async downloadUrl(url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: controller.signal });
    } catch (err) {
      throw new MarketInstallError('NETWORK', `下载插件失败：${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new MarketInstallError(
        'HTTP_STATUS',
        `插件下载返回 HTTP ${res.status}`,
        res.status,
      );
    }
    try {
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw new MarketInstallError('NETWORK', `读取插件下载响应失败：${(err as Error).message}`);
    }
  }

  /** 读取 pluginsDir/<pluginId>/plugin.json 的 version；未安装/损坏返回 null。 */
  installedVersion(pluginId: string): string | null {
    this.requirePluginsDir();
    const manifestPath = path.join(this.pluginsDir as string, pluginId, 'plugin.json');
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return null;
    }
    const version = (raw as { version?: unknown } | null)?.version;
    return typeof version === 'string' && version ? version : null;
  }

  /** 列出 pluginsDir 下已安装的合法插件（跳过点开头的临时目录）。 */
  listInstalled(): InstalledPluginInfo[] {
    const dir = this.requirePluginsDir();
    if (!fs.existsSync(dir)) return [];
    const out: InstalledPluginInfo[] = [];
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      const version = this.installedVersion(entry);
      if (version) {
        out.push({ pluginId: entry, version, dir: path.join(dir, entry) });
      }
    }
    return out;
  }

  /** 下载插件 zip 字节（先刷新索引，再按条目 downloadUrl 下载）。 */
  async download(pluginId: string): Promise<Buffer> {
    const entry = await this.downloadEntry(pluginId);
    return this.downloadUrl(entry.downloadUrl);
  }

  /**
   * 安装插件：下载 zip → 完整性校验 → 解压到 pluginsDir。
   *
   * - 已安装（pluginsDir 已有同名合法插件）→ ALREADY_INSTALLED。
   * - 校验失败（zip 损坏 / 顶层目录名≠id / manifest 不合法 / 路径穿越）→ 类型化错误，
   *   此时磁盘上不会留下任何半成品目录。
   * - 解压失败 → EXTRACT_FAILED，临时目录已清理。
   */
  async install(pluginId: string): Promise<InstallResult> {
    assertValidPluginId(pluginId);
    const dir = this.requirePluginsDir();
    fs.mkdirSync(dir, { recursive: true });
    const targetDir = path.join(dir, pluginId);

    // 已安装守卫：目录存在且 plugin.json 可读出即视为已安装。
    if (this.installedVersion(pluginId) !== null) {
      throw new MarketInstallError(
        'ALREADY_INSTALLED',
        `插件 "${pluginId}" 已安装于 ${targetDir}`,
      );
    }

    const buf = await this.download(pluginId);
    // 校验在解压前完成：失败不产生任何磁盘残留。
    const { topDir, manifest } = validatePluginZip(buf, pluginId);

    const tmpDir = path.join(
      dir,
      `.install-${pluginId}-${process.pid}-${randomBytes(4).toString('hex')}`,
    );
    try {
      extractZipTo(buf, tmpDir, topDir);
      fs.renameSync(tmpDir, targetDir);
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
      if (err instanceof MarketInstallError) throw err;
      throw new MarketInstallError('EXTRACT_FAILED', `解压插件失败：${(err as Error).message}`);
    }

    return { pluginId, version: manifest.version, dir: targetDir };
  }

  /**
   * 卸载插件：移除 pluginsDir/<pluginId> 目录。
   *
   * 守卫：pluginId 必须通过合法 id 校验（与内核 manifest ID_RE 一致），
   * 只删除该 id 对应的顶层目录，绝不接受任意路径。
   */
  async uninstall(pluginId: string): Promise<void> {
    assertValidPluginId(pluginId);
    const dir = this.requirePluginsDir();
    const targetDir = path.join(dir, pluginId);
    // 路径守卫：resolve 后必须仍是 dir 的直接子目录、basename === pluginId。
    const resolved = path.resolve(targetDir);
    if (path.dirname(resolved) !== path.resolve(dir) || path.basename(resolved) !== pluginId) {
      throw new MarketInstallError('INVALID_PLUGIN_ID', `插件 id 非法，拒绝删除：${pluginId}`);
    }
    if (this.installedVersion(pluginId) === null) {
      throw new MarketInstallError('NOT_INSTALLED', `插件 "${pluginId}" 未安装`);
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  /**
   * 更新插件：registry 版本 > 本地已装版本才下载并原子替换。
   *
   * - 未安装 → NOT_INSTALLED。
   * - 已是最新 → 不下载，返回 updated=false。
   * - 更新流程：解压到临时目录 → 现装目录改名备份 → 临时目录换入；
   *   换入失败时恢复备份，现装版本不被破坏。
   */
  async update(pluginId: string): Promise<UpdateResult> {
    assertValidPluginId(pluginId);
    const dir = this.requirePluginsDir();
    const targetDir = path.join(dir, pluginId);
    const installed = this.installedVersion(pluginId);
    if (installed === null) {
      throw new MarketInstallError('NOT_INSTALLED', `插件 "${pluginId}" 未安装，无法更新`);
    }

    const entry = await this.downloadEntry(pluginId);
    const cmp = compareVersions(entry.version, installed);
    if (Number.isNaN(cmp)) {
      throw new MarketInstallError(
        'MANIFEST_INVALID',
        `registry 版本 "${entry.version}" 不是合法 SemVer，无法比较`,
      );
    }
    if (cmp <= 0) {
      return { pluginId, version: installed, dir: targetDir, updated: false };
    }

    const buf = await this.downloadUrl(entry.downloadUrl);
    const { topDir } = validatePluginZip(buf, pluginId);

    const tmpDir = path.join(
      dir,
      `.update-${pluginId}-${process.pid}-${randomBytes(4).toString('hex')}`,
    );
    const backupDir = path.join(
      dir,
      `.backup-${pluginId}-${process.pid}-${randomBytes(4).toString('hex')}`,
    );
    try {
      extractZipTo(buf, tmpDir, topDir);
      fs.renameSync(targetDir, backupDir);
      try {
        fs.renameSync(tmpDir, targetDir);
      } catch (err) {
        // 换入失败：恢复旧版，保证现装版本可用。
        fs.renameSync(backupDir, targetDir);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new MarketInstallError('EXTRACT_FAILED', `换入新版本失败，已恢复旧版：${(err as Error).message}`);
      }
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(backupDir, { recursive: true, force: true });
      if (err instanceof MarketInstallError) throw err;
      throw new MarketInstallError('EXTRACT_FAILED', `更新插件失败：${(err as Error).message}`);
    }

    return { pluginId, version: entry.version, dir: targetDir, updated: true };
  }

  /** 刷新索引并按 id 取条目（install/update 共用；网络/缺失错误已类型化）。 */
  private async downloadEntry(pluginId: string): Promise<RegistryPluginEntry> {
    try {
      await this.fetchIndex();
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new MarketInstallError('NETWORK', `拉取 registry 索引失败：${cause}`);
    }
    return this.requireEntry(pluginId);
  }
}
