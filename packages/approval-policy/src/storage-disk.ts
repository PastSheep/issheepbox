/**
 * 授权记录磁盘持久化实现（TASK-015）。
 *
 * DiskApprovalStore 把 ApprovalStore 记录落到 `<dir>/approvals.json`，
 * 使授权/拒绝决策跨进程重启保留（对齐批次契约 C3：宿主 desktop 经
 * `host:user-data` 服务提供用户数据目录，本插件默认接线时注入）。
 *
 * 可靠性约定：
 *  - 文件缺失 = 空存储（首启正常路径）；
 *  - 文件损坏 / 非法 JSON / 结构异常 → 视为空存储并 logger.warn，**不抛错不崩溃**
 *    （宁可丢失记录重新授权，也不让应用起不来）；
 *  - set/delete 立即落盘，且**原子写**：先写同目录临时文件（唯一命名），
 *    再 rename 覆盖 approvals.json（Node 在 Windows 上 renameSync 可覆盖既有文件）。
 *    写入中断只留下半成品临时文件或旧的 approvals.json，不会出现「半写的正式文件」；
 *  - 落盘失败抛错（调用方可见），但既有 approvals.json 不被破坏；
 *  - 记录按 pluginId 排序写出，内容确定可复现。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '@issheepbox/kernel';
import type { ApprovalRecord, ApprovalStatus, ApprovalStore } from './storage';

/** DiskApprovalStore 构造选项。 */
export interface DiskApprovalStoreOptions {
  /** 用户数据目录（宿主 `host:user-data` 服务提供）；approvals.json 落在其下。 */
  dir: string;
  /** 日志（可选）：损坏文件告警等；未提供则静默。 */
  logger?: Logger;
}

/** 存储文件名（位于 dir 下）。 */
export const APPROVALS_FILE_NAME = 'approvals.json';

/** 写入序号（保证同一进程内并发/连续 flush 的临时文件名唯一）。 */
let flushSeq = 0;

/**
 * 磁盘授权记录存储。
 *
 * get/list 语义与 MemoryApprovalStore 一致；set/delete 会同步落盘。
 * 同一进程内可多实例指向同一文件——构造时加载一次，各自 set/delete
 * 经 rename 相互覆盖，后写胜出（与 Memory 单写者语义一致；多写者并发
 * 场景 v1 不做文件锁，桌面单进程模型足够）。
 */
export class DiskApprovalStore implements ApprovalStore {
  private readonly filePath: string;
  private readonly logger?: Logger;
  private readonly records = new Map<string, ApprovalRecord>();

  constructor(options: DiskApprovalStoreOptions) {
    this.filePath = path.join(options.dir, APPROVALS_FILE_NAME);
    this.logger = options.logger;

    // 目录缺失时自愈创建（宿主保证目录存在，这里只做防御）。
    mkdirSync(options.dir, { recursive: true });

    this.load();
  }

  get(pluginId: string): ApprovalRecord | undefined {
    return this.records.get(pluginId);
  }

  set(record: ApprovalRecord): void {
    // 先成功落盘，再更新内存视图：落盘抛错时内存与磁盘都停留在旧状态，
    // 调用方拿到异常后可安全重试，不会出现「内存新、磁盘旧」的分叉。
    const next = new Map(this.records);
    next.set(record.pluginId, record);
    this.flushMap(next);
    this.records.set(record.pluginId, record);
  }

  delete(pluginId: string): void {
    const next = new Map(this.records);
    next.delete(pluginId);
    this.flushMap(next);
    this.records.delete(pluginId);
  }

  list(): ApprovalRecord[] {
    return [...this.records.values()];
  }

  /**
   * 构造时加载既有记录。任何异常都吞掉并降级为空存储（fail-safe 启动）。
   */
  private load(): void {
    if (!existsSync(this.filePath)) {
      return; // 首启：无文件 = 空存储，正常路径
    }
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      this.logger?.warn(
        `[approval-policy] 读取 ${APPROVALS_FILE_NAME} 失败，视为空存储：${formatError(err)}`,
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger?.warn(
        `[approval-policy] ${APPROVALS_FILE_NAME} 不是合法 JSON，视为空存储：${formatError(err)}`,
      );
      return;
    }

    if (!Array.isArray(parsed)) {
      this.logger?.warn(
        `[approval-policy] ${APPROVALS_FILE_NAME} 顶层非数组，视为空存储`,
      );
      return;
    }

    for (const item of parsed) {
      const record = coerceRecord(item);
      if (record) {
        this.records.set(record.pluginId, record);
      } else {
        this.logger?.warn(
          `[approval-policy] ${APPROVALS_FILE_NAME} 中存在无法识别的记录条目，已跳过`,
        );
      }
    }
  }

  /**
   * 原子写：序列化 → 同目录临时文件 → rename 覆盖正式文件。
   * 抛错即落盘失败：正式文件保持旧内容（或尚不存在），不产生半写的 approvals.json。
   */
  private flushMap(map: Map<string, ApprovalRecord>): void {
    const sorted = [...map.values()].sort((a, b) =>
      a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0,
    );
    const body = JSON.stringify(sorted, null, 2);

    flushSeq += 1;
    const tmpPath = path.join(
      path.dirname(this.filePath),
      `.approvals.${process.pid}.${Date.now()}.${flushSeq}.tmp`,
    );
    writeFileSync(tmpPath, body, 'utf8');
    // Windows 上 renameSync 可直接覆盖既有目标文件。
    renameSync(tmpPath, this.filePath);
  }
}

/**
 * 宽松反序列化：只接受形状合法的条目，其余丢弃（容错，不抛错）。
 */
function coerceRecord(item: unknown): ApprovalRecord | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const rec = item as Record<string, unknown>;
  if (typeof rec.pluginId !== 'string' || rec.pluginId.length === 0) return undefined;
  if (rec.status !== 'granted' && rec.status !== 'denied') return undefined;
  const permissions =
    Array.isArray(rec.permissions) && rec.permissions.every((p) => typeof p === 'string')
      ? (rec.permissions as string[])
      : [];
  return {
    pluginId: rec.pluginId,
    status: rec.status as ApprovalStatus,
    permissions,
    decidedAt:
      typeof rec.decidedAt === 'string' && rec.decidedAt.length > 0
        ? rec.decidedAt
        : new Date(0).toISOString(),
    ...(typeof rec.reason === 'string' ? { reason: rec.reason } : {}),
  };
}

/** 把异常压缩成一行可读文本（日志告警用）。 */
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
