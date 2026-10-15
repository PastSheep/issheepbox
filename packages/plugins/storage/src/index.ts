/**
 * KV 存储服务插件（第一方基础设施 · 一切皆插件）。
 *
 * 为什么是一个插件而不是内核能力（docs/requirements.md §3）：
 *  - 需求规划的第一方基础设施插件含「存储插件：配置/插件数据持久化」，
 *    但 ctx.storage 至今未交付（plugin-spec-v1 §4.2 后续追加，F-002），
 *    note 等插件只能把「持久化待 ctx.storage 交付」挂着。
 *  - 按「一切皆插件」理念，存储本就不该烤进内核：它可启停、可替换实现
 *    （本地 JSON / 未来的 SQLite / 云同步），对消费方只是一个 service。
 *
 * 职责边界（与内核 §4.1 对齐）：
 *  - 只做「按命名空间隔离的 KV + 落盘 + 变更事件」，不渲染任何 UI、不假设插件来源。
 *  - 消费方经 manifest requires 声明依赖本插件，再 ctx.services.get('storage') 使用，
 *    不直接 import 本包代码（规范 §8.1 不直接引用）。
 *
 * 权限与沙箱：
 *  - 声明 files:read + files:write；启用前经 approval-policy 授权（规范 §7）。
 *  - 两道闸（对齐 file-stats）：① 挂载自检 checkPermission，未授权不注册服务；
 *    ② 宿主能力 ctx.files.readFile/writeFile 在内核侧按本插件 id 再做权威门禁（P-009）。
 *  - 不直接使用 node:fs / node:path（规范 §9.1）；路径用正斜杠字符串拼接。
 *
 * 可逆 effects：ctx.services.register('storage') 在卸载时由内核自动注销（规范 §5.2）。
 *
 * ctx 使用 v1 已交付接口：manifest / apiVersion / logger / events / services /
 * effects（本插件无 UI，不需要 effects.add）/ files（P-009）。
 */
import type { PluginContext } from '@issheepbox/kernel';

const FILES_READ = 'files:read';
const FILES_WRITE = 'files:write';

/** 对外服务名（contributes.services[0].name 与之保持一致）。 */
export const STORAGE_SERVICE_NAME = 'storage';
/** 变更事件名（contributes.events[0].name 与之保持一致）。 */
export const STORAGE_EVENT_CHANGED = 'storage:changed';

/** 数据落盘文件名（落在宿主 userData 目录下，经 host:user-data 服务定位）。 */
const DATA_FILE_NAME = 'issheepbox-storage.json';

/** 宿主注入的用户数据目录服务（C3，见 TASK-012：desktop 主进程 kernel.start 前注册）。 */
interface HostUserDataShape {
  dir: string;
}

/** approval-policy 授权判定服务形状（见 packages/approval-policy）。 */
interface ApprovalPolicyShape {
  checkPermission(pluginId: string, permission: string): boolean;
}

/** 某命名空间下的 KV 句柄（消费方最常用的形态）。 */
export interface ScopedStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  /** 返回该命名空间下全部键值的浅拷贝。 */
  all(): Record<string, unknown>;
  /** 清空该命名空间（不影响其他命名空间）。 */
  clear(): void;
}

/** storage 服务形状（其他插件经 ctx.services.get('storage') 消费）。 */
export interface StorageService {
  /** 获取某命名空间（通常传本插件自己的 manifest.id）的作用域句柄。 */
  namespace(pluginId: string): ScopedStore;
  get(pluginId: string, key: string): unknown;
  set(pluginId: string, key: string, value: unknown): void;
  delete(pluginId: string, key: string): void;
  all(pluginId: string): Record<string, unknown>;
  clear(pluginId: string): void;
  /** 是否真的落盘持久化（false = 仅内存，重启后不保留，通常是宿主未注入 host:user-data）。 */
  isPersistent(): boolean;
}

/** 落盘数据形状：{ [namespace]: { [key]: value } }。 */
type DataFile = Record<string, Record<string, unknown>>;

export default function main(ctx: PluginContext): void {
  if (!hasFilesPermission(ctx)) {
    ctx.logger.error(
      `storage 插件未同时获得 "${FILES_READ}" 与 "${FILES_WRITE}" 授权` +
        '（或 approval-policy 服务不可用），按 fail-safe 拒绝注册 storage 服务',
    );
    return;
  }

  const filePath = resolveDataFilePath(ctx);
  const data: DataFile = filePath ? loadPersisted(ctx, filePath) : {};

  const service = createStorageService(ctx, data, filePath);
  ctx.services.register(STORAGE_SERVICE_NAME, service);
  ctx.logger.info(
    `storage 服务已注册（持久化=${filePath !== null}${filePath ? ` → ${filePath}` : '；宿主未注入 host:user-data，仅内存'}）`,
  );
}

/** 挂载自检（第一道闸）：files:read + files:write 都被授权才放行注册。 */
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

/**
 * 定位数据文件路径。
 *
 * 宿主（desktop）在 kernel.start 前注册 host:user-data = { dir }（C3）；
 * 若不可用（如纯 Node 测试台未注入）则降级为纯内存，不阻塞插件挂载。
 * 插件沙箱内禁止 node:path，统一正斜杠拼接（规范 §2 路径约定）。
 */
function resolveDataFilePath(ctx: PluginContext): string | null {
  if (!ctx.services.has('host:user-data')) {
    ctx.logger.warn('host:user-data 服务不可用，storage 降级为纯内存（重启后不保留）');
    return null;
  }
  const host = ctx.services.get<HostUserDataShape>('host:user-data');
  if (!host || typeof host.dir !== 'string' || host.dir.trim() === '') {
    ctx.logger.warn('host:user-data.dir 缺失或为空，storage 降级为纯内存');
    return null;
  }
  return host.dir.replace(/[\\/]+$/, '') + '/' + DATA_FILE_NAME;
}

/** 启动时加载已有数据；文件不存在/损坏按空存储启动（fail-safe，不阻塞挂载）。 */
function loadPersisted(ctx: PluginContext, filePath: string): DataFile {
  try {
    const raw = ctx.files.readFile(filePath);
    if (!raw || raw.trim() === '') return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as DataFile;
    }
    ctx.logger.warn('storage 数据文件结构异常（非对象），按空存储启动');
    return {};
  } catch (err) {
    // 首启时文件不存在是常见情形；读失败也按空启动，不阻塞插件挂载。
    ctx.logger.warn(`storage 数据读取失败（按空启动）: ${(err as Error).message}`);
    return {};
  }
}

function createStorageService(
  ctx: PluginContext,
  data: DataFile,
  filePath: string | null,
): StorageService {
  /** 写穿透落盘；失败仅记日志，保留内存态（不抛给消费方，避免一次磁盘抖动崩掉所有插件）。 */
  function persist(): void {
    if (!filePath) return;
    try {
      ctx.files.writeFile(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      ctx.logger.error(`storage 持久化写入失败: ${(err as Error).message}`);
    }
  }

  function emitChanged(namespace: string, key: string | null, op: string, value: unknown): void {
    ctx.events.emit(STORAGE_EVENT_CHANGED, { namespace, key, op, value });
  }

  function get(namespace: string, key: string): unknown {
    return data[namespace]?.[key];
  }

  function set(namespace: string, key: string, value: unknown): void {
    if (!data[namespace]) data[namespace] = {};
    data[namespace][key] = value;
    persist();
    emitChanged(namespace, key, 'set', value);
  }

  function del(namespace: string, key: string): void {
    if (data[namespace] && key in data[namespace]) {
      delete data[namespace][key];
      persist();
      emitChanged(namespace, key, 'delete', undefined);
    }
  }

  function all(namespace: string): Record<string, unknown> {
    return { ...(data[namespace] ?? {}) };
  }

  function clear(namespace: string): void {
    if (data[namespace] && Object.keys(data[namespace]).length > 0) {
      data[namespace] = {};
      persist();
      emitChanged(namespace, null, 'clear', undefined);
    }
  }

  function namespace(namespace: string): ScopedStore {
    return {
      get: (key: string) => get(namespace, key),
      set: (key: string, value: unknown) => set(namespace, key, value),
      delete: (key: string) => del(namespace, key),
      all: () => all(namespace),
      clear: () => clear(namespace),
    };
  }

  return {
    namespace,
    get,
    set,
    delete: del,
    all,
    clear,
    isPersistent: () => filePath !== null,
  };
}
