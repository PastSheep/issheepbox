/**
 * 宿主文件能力服务插件（org.issheepbox.files-service · 落地规范 F-008）。
 *
 * 为什么是插件而不是内核能力：
 *  - 内核 ctx.files（P-009）是「任意路径读/写 + files:read 门禁」的薄封装，无白名单；
 *  - 本插件在其上加「用户授权目录白名单 + 路径越权拒绝」一层，供 file-stats 等
 *    声明 files:read 的插件消费——插件只能读用户明确授权的目录，不能任意读全盘。
 *
 * 安全模型：
 *  - 调用方每次 readText/listDir/stat 须传 callerPluginId；本插件经 approval-policy
 *    checkPermission(callerPluginId, 'files:read') 判定，未授权抛错。
 *  - 路径校验：任何含 `..` 段的路径一律拒绝；解析为绝对路径后必须落在某个
 *    已授权目录内，否则拒绝（不返回「文件不存在」等可能泄漏路径信息的细节）。
 *  - 白名单持久化到 userData/files-whitelist.json。
 *
 * 实现说明：本插件是宿主级文件能力提供方，内部直接使用 node:fs/node:path
 * （与内核 lifecycle createScopedCtx 内的 files 实现同层）；业务插件仍走 ctx.files。
 *
 * ctx 只用 v1 已交付接口：manifest / apiVersion / logger / events / services / effects。
 */
import type { PluginContext } from '@issheepbox/kernel';
import fs from 'node:fs';
import path from 'node:path';

const FILES_READ = 'files:read';
export const FILES_SERVICE_NAME = 'files';

interface ApprovalPolicyShape {
  checkPermission(pluginId: string, permission: string): boolean;
}
interface HostUserDataShape {
  dir: string;
}

export interface FileStat {
  size: number;
  isDir: boolean;
}

export interface FilesService {
  /** 授权一个目录（加入白名单并持久化）。 */
  authorizeDir(dir: string): void;
  /** 当前已授权目录清单（返回拷贝）。 */
  listAuthorizedDirs(): string[];
  /** 读取文本文件（UTF-8）；须 callerId 持有 files:read 且路径在白名单内。 */
  readText(callerPluginId: string, filePath: string): string;
  /** 枚举目录直接子项名。 */
  listDir(callerPluginId: string, dirPath: string): string[];
  /** 简单统计：字节数 + 是否目录。 */
  stat(callerPluginId: string, filePath: string): FileStat;
}

export default function main(ctx: PluginContext): void {
  const whitelistPath = resolveWhitelistPath(ctx);
  const whitelist: string[] = loadWhitelist(whitelistPath);

  function persistWhitelist(): void {
    if (!whitelistPath) return;
    try {
      fs.writeFileSync(whitelistPath, JSON.stringify({ dirs: whitelist }, null, 2), 'utf8');
    } catch (err) {
      ctx.logger.error(`files-service 白名单持久化失败: ${(err as Error).message}`);
    }
  }

  function assertCanRead(callerPluginId: string): void {
    if (!ctx.services.has('approval-policy')) {
      throw new Error('files:read 授权服务不可用，fail-safe 拒绝');
    }
    const policy = ctx.services.get<ApprovalPolicyShape>('approval-policy');
    if (!policy.checkPermission(callerPluginId, FILES_READ)) {
      throw new Error(`插件 "${callerPluginId}" 未获 "${FILES_READ}" 授权，拒绝访问文件`);
    }
  }

  /**
   * 把用户传入的路径解析为安全绝对路径。
   * - 任何含 `..` 段的路径直接拒绝；
   * - 解析为绝对路径后必须落在某个已授权目录内；
   * - 越权时统一抛「路径越权」，不泄漏目标是否存在。
   */
  function resolveSafe(targetPath: string): string {
    if (typeof targetPath !== 'string' || targetPath.trim() === '') {
      throw new Error('非法路径：为空');
    }
    const segments = targetPath.split(/[\\/]+/).filter((s) => s.length > 0);
    if (segments.includes('..')) {
      throw new Error('路径越权：禁止 .. 穿越');
    }
    const abs = path.resolve(targetPath);
    for (const dir of whitelist) {
      const normalizedDir = path.resolve(dir);
      if (abs === normalizedDir || abs.startsWith(normalizedDir + path.sep)) {
        return abs;
      }
    }
    throw new Error('路径越权：不在已授权目录内');
  }

  const service: FilesService = {
    authorizeDir(dir: string): void {
      const abs = path.resolve(dir);
      if (!whitelist.includes(abs)) {
        whitelist.push(abs);
        persistWhitelist();
        ctx.logger.info(`files-service 已授权目录: ${abs}`);
      }
    },
    listAuthorizedDirs(): string[] {
      return [...whitelist];
    },
    readText(callerPluginId: string, filePath: string): string {
      assertCanRead(callerPluginId);
      const safe = resolveSafe(filePath);
      return fs.readFileSync(safe, 'utf8');
    },
    listDir(callerPluginId: string, dirPath: string): string[] {
      assertCanRead(callerPluginId);
      const safe = resolveSafe(dirPath);
      return fs.readdirSync(safe);
    },
    stat(callerPluginId: string, filePath: string): FileStat {
      assertCanRead(callerPluginId);
      const safe = resolveSafe(filePath);
      const s = fs.statSync(safe);
      return { size: s.size, isDir: s.isDirectory() };
    },
  };

  ctx.services.register(FILES_SERVICE_NAME, service);
  ctx.logger.info(
    `files 服务已注册（已授权 ${whitelist.length} 个目录；${whitelistPath ? '白名单持久化' : '内存态'}）`,
  );
}

function resolveWhitelistPath(ctx: PluginContext): string | null {
  if (!ctx.services.has('host:user-data')) return null;
  const host = ctx.services.get<HostUserDataShape>('host:user-data');
  if (!host || typeof host.dir !== 'string' || host.dir.trim() === '') return null;
  return host.dir.replace(/[\\/]+$/, '') + '/files-whitelist.json';
}

function loadWhitelist(whitelistPath: string | null): string[] {
  if (!whitelistPath) return [];
  try {
    const raw = fs.readFileSync(whitelistPath, 'utf8');
    const parsed = JSON.parse(raw) as { dirs?: string[] };
    return Array.isArray(parsed.dirs) ? parsed.dirs : [];
  } catch {
    return [];
  }
}
