/**
 * 插件加载器。
 *
 * 职责：
 *  - 扫描本地插件目录（一层子目录即一个插件包）
 *  - 读取并解析 plugin.json（见 manifest.ts）
 *  - 兼容性校验：apiVersion SemVer range 与当前内核版本比对（见 compat.ts）
 *  - require() 入口模块，校验默认导出是工厂函数
 *  - 失败隔离：单个插件解析/加载失败只记录到 failures，不影响其他插件
 *
 * 不做的事：
 *  - 不调用插件工厂（mount/生命周期由 TASK-003 负责）
 *  - 不做依赖拓扑排序与 requires 校验（由 Kernel.start 经 DependencyResolver
 *    在全量 manifest 就绪后统一处理，见 dependency/）
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { PluginManifest, PluginModule } from '../types';
import { parseManifest } from '../manifest';
import { checkApiCompatibility } from '../compat';

// 用 createRequire 拿到 require 函数，避免 ESLint no-require-imports。
const loadModule = createRequire(__filename);

/** 一个加载成功的插件：manifest + 入口模块（尚未调用工厂）。 */
export interface LoadedPlugin {
  /** 插件包根目录（绝对路径）。 */
  dir: string;
  manifest: PluginManifest;
  /** require() 后的入口模块。 */
  module: PluginModule;
}

/** 一个加载失败的插件：目录 + 错误列表。 */
export interface PluginLoadFailure {
  dir: string;
  errors: string[];
}

/** 扫描结果。 */
export interface LoadResult {
  loaded: LoadedPlugin[];
  failures: PluginLoadFailure[];
}

export class PluginLoader {
  /**
   * 扫描 pluginsDir 下的一层子目录，逐个尝试加载。
   *
   * @param pluginsDir 插件根目录（如 userData/plugins）
   */
  loadAll(pluginsDir: string): LoadResult {
    const loaded: LoadedPlugin[] = [];
    const failures: PluginLoadFailure[] = [];

    let entries: string[];
    try {
      entries = readdirSync(pluginsDir);
    } catch (err) {
      failures.push({
        dir: pluginsDir,
        errors: [`无法读取插件目录: ${(err as Error).message}`],
      });
      return { loaded, failures };
    }

    for (const entry of entries) {
      const dir = path.join(pluginsDir, entry);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;

      const result = this.tryLoad(dir);
      if (result.ok) {
        loaded.push(result.plugin);
      } else {
        failures.push({ dir, errors: result.errors });
      }
    }

    return { loaded, failures };
  }

  /** 尝试加载单个插件目录；成功返回 plugin，失败返回错误列表。 */
  private tryLoad(
    dir: string,
  ): { ok: true; plugin: LoadedPlugin } | { ok: false; errors: string[] } {
    const manifestPath = path.join(dir, 'plugin.json');
    if (!existsSync(manifestPath)) {
      return { ok: false, errors: [`${dir}: 缺少 plugin.json`] };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      return {
        ok: false,
        errors: [`${dir}: plugin.json 不是合法 JSON: ${(err as Error).message}`],
      };
    }

    const { manifest, errors } = parseManifest(raw, dir);
    if (!manifest) {
      return { ok: false, errors };
    }

    // 兼容性校验：apiVersion SemVer range 与当前内核 ctx API 版本比对
    const compat = checkApiCompatibility(manifest.apiVersion, dir);
    if (!compat.compatible) {
      return { ok: false, errors: [compat.error!] };
    }

    const entryAbs = path.join(dir, manifest.entry);
    if (!existsSync(entryAbs)) {
      return {
        ok: false,
        errors: [`${dir}: 入口文件不存在: ${manifest.entry}`],
      };
    }

    let mod: PluginModule;
    try {
      // require 缓存：同一进程内重复加载同一插件不会重复执行模块代码。
      mod = loadModule(entryAbs) as PluginModule;
    } catch (err) {
      return {
        ok: false,
        errors: [`${dir}: 入口模块加载失败: ${(err as Error).message}`],
      };
    }

    if (typeof mod.default !== 'function') {
      return {
        ok: false,
        errors: [`${dir}: 入口模块必须 export default 一个工厂函数`],
      };
    }

    return { ok: true, plugin: { dir, manifest, module: mod } };
  }
}
