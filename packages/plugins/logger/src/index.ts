/**
 * 日志服务插件（org.issheepbox.logger · 内置级 · 一切皆插件）。
 *
 * 为什么是一个插件而不是内核能力：
 *  - 内核只做加载/生命周期/services/events/profile，不内置日志系统；
 *  - 日志可启停、可替换实现（本地文件 / 远程上报），对消费方只是一个 service。
 *
 * 职责：
 *  - 注册 `logging` 服务：write(level, scope, message, meta?) / query(callerPluginId, filter)。
 *  - 每条日志实时广播 `log:entry` 事件（面板/调试器可订阅）。
 *  - 持久化到 userData 下的 JSONL 文件，按大小轮转（仿 storage 落盘方式）。
 *
 * 权限模型：
 *  - 写入免费：任意插件经 logging.write 写日志，不需要申请权限（scope 由调用方自报）。
 *  - 查询受控：logging.query(callerPluginId, filter) 要求调用方持有 `logs:read` 权限；
 *    本插件经 approval-policy 服务 checkPermission(callerPluginId, 'logs:read') 判定，
 *    未授权抛错拒绝、不泄漏任何日志数据（fail-safe）。
 *  - 本插件自身声明 files:read + files:write 用于落盘/重启读回；未授权时 fail-safe 不注册服务。
 *
 * 沙箱边界：不直接使用 node:fs/node:path；文件读写走宿主 ctx.files 能力（P-009），
 * 路径用正斜杠拼接（规范 §2）。
 *
 * 可逆 effects：services.register 在卸载时由内核自动注销；事件广播无残留。
 *
 * ctx 只用 v1 已交付接口：manifest / apiVersion / logger / events / services / effects / files。
 */
import type { PluginContext } from '@issheepbox/kernel';

const FILES_READ = 'files:read';
const FILES_WRITE = 'files:write';
/** 消费方调用 query 时需持有的权限（由各消费方在自身 manifest 声明，approval-policy 记录授权）。 */
const LOGS_READ = 'logs:read';

/** 对外服务名（contributes.services[0].name 与之保持一致）。 */
export const LOGGING_SERVICE_NAME = 'logging';
/** 实时日志事件名（contributes.events[0].name 与之保持一致）。 */
export const LOG_EVENT_ENTRY = 'log:entry';

/** 允许的日志级别（严重度递增）。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** 一条日志记录。 */
export interface LogEntry {
  /** 毫秒时间戳。 */
  ts: number;
  level: LogLevel;
  /** 来源插件 id（调用方自报 scope）。 */
  scope: string;
  message: string;
  meta?: unknown;
}

/** query 筛选条件（全部可选，AND 组合）。 */
export interface LogFilter {
  /** 仅返回 >= 指定级别的日志（如 'warn' 含 warn/error）。 */
  minLevel?: LogLevel;
  /** 精确匹配 scope。 */
  scope?: string;
  /** 仅返回此时间戳之后的日志。 */
  since?: number;
  /** 最多返回条数（最新优先）。 */
  limit?: number;
}

/** logging 服务形状（消费方经 ctx.services.get('logging') 调用）。 */
export interface LoggingService {
  /**
   * 写一条日志（免费，不校验调用方权限）。
   * @param level 日志级别
   * @param scope 来源插件 id（通常传 ctx.manifest.id）
   * @param message 日志正文
   * @param meta 可选结构化数据
   */
  write(level: LogLevel, scope: string, message: string, meta?: unknown): void;
  /**
   * 查询历史日志（需调用方持有 logs:read 权限）。
   * @param callerPluginId 调用方插件 id（自报；本插件据此向 approval-policy 校验）
   * @param filter 筛选条件
   * @throws 当 callerPluginId 未获 logs:read 授权时抛错（不返回任何数据）
   */
  query(callerPluginId: string, filter?: LogFilter): LogEntry[];
  /** 当前内存中缓存的日志条数（诊断用）。 */
  size(): number;
  /** 是否处于持久化模式（false = 仅内存，宿主未注入 host:user-data 或落盘失败）。 */
  isPersistent(): boolean;
}

/** approval-policy 服务形状（结构类型对齐，不 import 该包）。 */
interface ApprovalPolicyShape {
  checkPermission(pluginId: string, permission: string): boolean;
}

/** 宿主用户数据目录服务形状（C3，desktop 主进程 kernel.start 前注册）。 */
interface HostUserDataShape {
  dir: string;
}

// ---- 落盘文件命名（平铺在 userData 下，仿 storage 的 issheepbox-storage.json）----
const ACTIVE_FILE = 'issheepbox-logs-current.jsonl';
const ARCHIVE_FILES = ['issheepbox-logs-1.jsonl', 'issheepbox-logs-2.jsonl', 'issheepbox-logs-3.jsonl'];
/** 单文件超过此字节数即轮转（64KB，便于 verify 触发）。 */
const MAX_BYTES_PER_FILE = 64 * 1024;
/** 内存环形缓冲上限（防长时间运行内存膨胀）。 */
const MAX_IN_MEMORY = 1000;
/** 攒够 N 条再批量刷盘（减少 read-modify-write 次数）。 */
const FLUSH_EVERY = 5;

const encoder = new TextEncoder();
function byteLen(s: string): number {
  return encoder.encode(s).length;
}

export default function main(ctx: PluginContext): void {
  if (!hasFilesPermission(ctx)) {
    ctx.logger.error(
      `logger 插件未同时获得 "${FILES_READ}" 与 "${FILES_WRITE}" 授权` +
        '（或 approval-policy 服务不可用），按 fail-safe 拒绝注册 logging 服务',
    );
    return;
  }

  const baseDir = resolveUserDataDir(ctx);
  const entries: LogEntry[] = [];
  const pending: string[] = [];

  // 启动时从磁盘读回历史日志（首启文件不存在则按空启动）。
  if (baseDir) loadFromDisk(ctx, baseDir, entries);

  /** 批量刷盘：把 pending 追加到 active；超阈值则先轮转。 */
  function persist(): void {
    if (!baseDir || pending.length === 0) return;
    try {
      const activePath = baseDir + '/' + ACTIVE_FILE;
      let existing = '';
      try {
        existing = ctx.files.readFile(activePath);
      } catch {
        existing = ''; // 首启文件不存在
      }
      const newLines = pending.join('\n') + '\n';
      const combined = existing + newLines;
      if (byteLen(combined) > MAX_BYTES_PER_FILE) {
        // 轮转：旧 active 沉入归档链，新 active 只保留本次新增行。
        rotate(ctx, baseDir, existing);
        ctx.files.writeFile(activePath, newLines);
      } else {
        ctx.files.writeFile(activePath, combined);
      }
      pending.length = 0;
    } catch (err) {
      ctx.logger.error(`logger 落盘失败（保留内存态）: ${(err as Error).message}`);
    }
  }

  function write(level: LogLevel, scope: string, message: string, meta?: unknown): void {
    const entry: LogEntry = { ts: Date.now(), level, scope, message };
    if (meta !== undefined) entry.meta = meta;
    entries.push(entry);
    if (entries.length > MAX_IN_MEMORY) entries.splice(0, entries.length - MAX_IN_MEMORY);
    pending.push(JSON.stringify(entry));
    ctx.events.emit(LOG_EVENT_ENTRY, entry);
    if (pending.length >= FLUSH_EVERY) persist();
  }

  function assertCanRead(callerPluginId: string): void {
    if (!ctx.services.has('approval-policy')) {
      throw new Error('logs:read 授权服务不可用，fail-safe 拒绝查询');
    }
    const policy = ctx.services.get<ApprovalPolicyShape>('approval-policy');
    if (!policy.checkPermission(callerPluginId, LOGS_READ)) {
      throw new Error(`插件 "${callerPluginId}" 未获 "${LOGS_READ}" 授权，拒绝查询日志`);
    }
  }

  function query(callerPluginId: string, filter?: LogFilter): LogEntry[] {
    assertCanRead(callerPluginId);
    let out = entries.slice();
    if (filter?.minLevel) {
      const minIdx = LEVELS.indexOf(filter.minLevel);
      out = out.filter((e) => LEVELS.indexOf(e.level) >= minIdx);
    }
    if (filter?.scope) out = out.filter((e) => e.scope === filter.scope);
    if (filter?.since) out = out.filter((e) => e.ts >= (filter.since as number));
    if (filter?.limit) out = out.slice(-filter.limit);
    return out;
  }

  const service: LoggingService = {
    write,
    query,
    size: () => entries.length,
    isPersistent: () => baseDir !== null,
  };

  ctx.services.register(LOGGING_SERVICE_NAME, service);
  ctx.logger.info(
    `logging 服务已注册（持久化=${baseDir !== null}${baseDir ? ` → ${baseDir}/${ACTIVE_FILE}` : '；仅内存'}）`,
  );
}

/** 挂载自检：files:read + files:write 都被授权才放行注册。 */
function hasFilesPermission(ctx: PluginContext): boolean {
  if (!ctx.services.has('approval-policy')) {
    ctx.logger.warn('approval-policy 服务不可用，无法校验 files 权限');
    return false;
  }
  const policy = ctx.services.get<ApprovalPolicyShape>('approval-policy');
  return (
    policy.checkPermission(ctx.manifest.id, FILES_READ) &&
    policy.checkPermission(ctx.manifest.id, FILES_WRITE)
  );
}

/** 定位 userData 目录（经 host:user-data 服务）；不可用返回 null。 */
function resolveUserDataDir(ctx: PluginContext): string | null {
  if (!ctx.services.has('host:user-data')) return null;
  const host = ctx.services.get<HostUserDataShape>('host:user-data');
  if (!host || typeof host.dir !== 'string' || host.dir.trim() === '') return null;
  return host.dir.replace(/[\\/]+$/, '');
}

/** 从磁盘读回 active + archive 文件，逐行 JSON.parse 进 entries。 */
function loadFromDisk(ctx: PluginContext, baseDir: string, entries: LogEntry[]): void {
  const files = [ACTIVE_FILE, ...ARCHIVE_FILES];
  for (const name of files) {
    let raw: string;
    try {
      raw = ctx.files.readFile(baseDir + '/' + name);
    } catch {
      continue; // 不存在的归档文件跳过
    }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as LogEntry;
        if (obj && typeof obj.ts === 'number' && typeof obj.level === 'string') {
          entries.push(obj);
        }
      } catch {
        // 损坏行跳过，不阻塞启动
      }
    }
  }
}

/**
 * 轮转：旧 active → archive-1，旧 archive-1 → archive-2，旧 archive-2 → archive-3，
 * 旧 archive-3 丢弃。用 readFile/writeFile 模拟（ctx.files 无 rename/delete）。
 */
function rotate(ctx: PluginContext, baseDir: string, oldActive: string): void {
  let a1 = '';
  let a2 = '';
  try {
    a1 = ctx.files.readFile(baseDir + '/' + ARCHIVE_FILES[0]);
  } catch { /* 忽略 */ }
  try {
    a2 = ctx.files.readFile(baseDir + '/' + ARCHIVE_FILES[1]);
  } catch { /* 忽略 */ }
  // 写顺序：先写最老槽位（archive-3 ← 旧 archive-2），避免覆盖未读内容。
  ctx.files.writeFile(baseDir + '/' + ARCHIVE_FILES[2], a2);
  ctx.files.writeFile(baseDir + '/' + ARCHIVE_FILES[1], a1);
  ctx.files.writeFile(baseDir + '/' + ARCHIVE_FILES[0], oldActive);
  ctx.logger.info('日志轮转：active 沉入归档链（保留 3 份归档）');
}
