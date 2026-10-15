/**
 * 鼠鼠数据索引插件（com.pastsheep.shushu-data · 跨仓库，network:fetch 形态）。
 *
 * 它把作者另一个产品 DeltaForceBox-Assets（鼠鼠大王工具箱的数据仓库：
 * 各地图 article-map 数据集，含 count/schema/sha256）的 manifest 拉进 Is SheepBox，
 * 对外注册 `shushu-data` 服务，并渲染一个静态数据面板。未来真正的「点位/攻略查询」
 * 插件只需 requires 依赖本服务取数据，不必各自重复抓取与解析。
 *
 * 设计要点：
 *  - 权限：network:fetch；挂载时经 approval-policy 自检（对齐 file-stats 第一道闸）。
 *  - 抓取在主进程（Node）完成，面板用生成的静态 HTML 经 shell:ui 注入——
 *    v1 面板 <script> 不执行，因此不在面板里放交互逻辑。
 *  - 软依赖 storage（org.issheepbox.storage）：若该插件存在则缓存最近一次成功清单，
 *    离线时回退缓存；不写进 requires，缺它也能跑（对齐 note↔theme 的软依赖模式）。
 *  - 失败隔离/优雅降级：网络失败不阻断挂载，服务仍注册，面板显示降级信息。
 *  - 可逆 effects：服务/面板注册在卸载时由内核自动回滚。
 *
 * ctx 使用 v1 已交付接口：manifest / apiVersion / logger / events / services / effects。
 * 网络取值：优先宿主注入的 host:net.fetch（Electron net.fetch，规避 undici 代理 TLS
 * 证书失败）；宿主未注入时回退主进程全局 fetch（undici）；两者皆无则报错。
 */
import type { PluginContext } from '@issheepbox/kernel';

const NETWORK_FETCH = 'network:fetch';
export const SHUSHU_SERVICE_NAME = 'shushu-data';
export const SHUSHU_EVENT_UPDATED = 'shushu-data:updated';

/** DeltaForceBox-Assets 仓库的 manifest raw 地址。 */
const REMOTE_MANIFEST_URL =
  'https://raw.githubusercontent.com/PastSheep/DeltaForceBox-Assets/main/shushu-data-manifest.json';

/** 远端单条数据集记录（见 shushu-data-manifest.json）。 */
export interface DatasetEntry {
  count: number;
  schema: number;
  sha256: string;
}

/** 远端 manifest 整体形状。 */
export interface RawManifest {
  format?: number;
  generated_at?: string;
  source?: string;
  datasets?: Record<string, DatasetEntry>;
}

/** 对外暴露的单条数据集（补回 id 字段）。 */
export interface DatasetInfo {
  id: string;
  count: number;
  schema: number;
  sha256: string;
}

export interface ShushuSummary {
  source: string;
  generatedAt: string;
  datasetCount: number;
  totalEntries: number;
}

export interface ShushuDataService {
  getManifest(): RawManifest | null;
  listDatasets(): DatasetInfo[];
  getDataset(id: string): DatasetEntry | undefined;
  getSummary(): ShushuSummary;
  /** 重新拉取远端清单，返回最新数据集列表。 */
  refresh(): Promise<DatasetInfo[]>;
  /** 最近一次拉取的错误信息（成功后清空）。 */
  lastError(): string | null;
}

interface ApprovalPolicyShape {
  checkPermission(pluginId: string, permission: string): boolean;
}

interface StorageScoped {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}
interface StorageShape {
  namespace(pluginId: string): StorageScoped;
}

interface ShellUiShape {
  registerPanel(
    panelId: string,
    title: string,
    options?: { pluginId?: string; html?: string; width?: number; height?: number },
  ): () => void;
}

/** 最小 fetch 形状（避免引入 DOM lib 类型；主进程 Node 22 自带全局 fetch）。 */
type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export default async function main(ctx: PluginContext): Promise<void> {
  if (!hasNetworkPermission(ctx)) {
    ctx.logger.error(
      `shushu-data 未获 "${NETWORK_FETCH}" 授权（或 approval-policy 不可用），fail-safe 拒绝注册`,
    );
    return;
  }

  let state: RawManifest | null = null;
  let error: string | null = null;
  const cache = tryGetCache(ctx);

  function list(): DatasetInfo[] {
    const datasets = state?.datasets ?? {};
    return Object.entries(datasets).map(([id, entry]) => ({ id, ...entry }));
  }

  async function refresh(): Promise<DatasetInfo[]> {
    try {
      const text = await remoteFetch(ctx, REMOTE_MANIFEST_URL);
      state = parseManifest(text);
      error = null;
      if (state) cache?.set('manifest', state);
      ctx.events.emit(SHUSHU_EVENT_UPDATED, {
        ok: true,
        datasetCount: list().length,
      });
    } catch (err) {
      error = (err as Error).message;
      if (!state) state = cache?.get('manifest') ?? null;
      ctx.logger.warn(`shushu-data 拉取失败（${error}），${state ? '使用缓存' : '无缓存'}`);
      ctx.events.emit(SHUSHU_EVENT_UPDATED, { ok: false, error });
    }
    return list();
  }

  function getSummary(): ShushuSummary {
    const datasets = list();
    return {
      source: state?.source ?? '',
      generatedAt: state?.generated_at ?? '',
      datasetCount: datasets.length,
      totalEntries: datasets.reduce((sum, d) => sum + (d.count || 0), 0),
    };
  }

  const service: ShushuDataService = {
    getManifest: () => state,
    listDatasets: list,
    getDataset: (id) => state?.datasets?.[id],
    getSummary,
    refresh,
    lastError: () => error,
  };

  ctx.services.register(SHUSHU_SERVICE_NAME, service);
  ctx.logger.info('shushu-data 服务已注册，开始拉取远端清单…');

  await refresh();

  registerPanel(ctx, service);
  const s = getSummary();
  ctx.logger.info(
    `shushu-data 就绪：${s.datasetCount} 个数据集 / 共 ${s.totalEntries} 条${error ? `（拉取降级：${error}）` : ''}`,
  );
}

/** 第一道闸：network:fetch 已授权才放行注册。 */
function hasNetworkPermission(ctx: PluginContext): boolean {
  if (!ctx.services.has('approval-policy')) {
    ctx.logger.warn('approval-policy 不可用，无法校验 network:fetch');
    return false;
  }
  const policy = ctx.services.get<ApprovalPolicyShape>('approval-policy');
  return policy.checkPermission(ctx.manifest.id, NETWORK_FETCH);
}

/** 软依赖 storage：存在则用它做离线缓存，不存在则返回 null（优雅降级）。 */
function tryGetCache(ctx: PluginContext): StorageScoped | null {
  if (!ctx.services.has('storage')) return null;
  try {
    return ctx.services.get<StorageShape>('storage').namespace(ctx.manifest.id);
  } catch {
    return null;
  }
}

/** 取网络 fetch：优先宿主 host:net.fetch（Electron net.fetch，规避 undici 代理 TLS
 *  证书链校验失败）；宿主未注入时回退主进程全局 fetch（undici）；两者皆无则报错。 */
function remoteFetch(ctx: PluginContext, url: string): Promise<string> {
  let fn: FetchLike | undefined;
  if (ctx.services.has('host:net')) {
    const host = ctx.services.get<{ fetch?: unknown }>('host:net');
    if (host && typeof host.fetch === 'function') {
      fn = host.fetch as FetchLike;
    }
  }
  if (!fn) {
    fn = (globalThis as { fetch?: FetchLike }).fetch;
  }
  if (!fn) return Promise.reject(new Error('当前环境无 fetch 能力（host:net 与全局 fetch 均缺失）'));
  return fn(url).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  });
}

/** 解析并校验远端 manifest；非法返回 null。 */
export function parseManifest(text: string): RawManifest | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const datasets = (parsed as RawManifest).datasets;
    if (!datasets || typeof datasets !== 'object' || Array.isArray(datasets)) return null;
    return parsed as RawManifest;
  } catch {
    return null;
  }
}

/** 经 shell:ui 注册静态数据面板（壳未挂载时降级）。 */
function registerPanel(ctx: PluginContext, service: ShushuDataService): void {
  if (!ctx.services.has('shell:ui')) return;
  const ui = ctx.services.get<ShellUiShape>('shell:ui');
  const html = buildPanelHtml(service.getSummary(), service.listDatasets(), service.lastError());
  ctx.effects.add(
    ui.registerPanel('shushu-data-main', '鼠鼠数据索引', {
      pluginId: ctx.manifest.id,
      html,
      width: 520,
      height: 480,
    }),
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/** 生成静态面板 HTML（v1 面板不执行脚本，纯展示）。 */
export function buildPanelHtml(
  summary: ShushuSummary,
  datasets: DatasetInfo[],
  error: string | null,
): string {
  const rows = datasets
    .map(
      (d) => `<tr><td>${escapeHtml(d.id)}</td><td style="text-align:right">${d.count}</td>` +
        `<td style="font-family:monospace;font-size:11px;color:#888">${escapeHtml(d.sha256.slice(0, 10))}…</td></tr>`,
    )
    .join('');
  const banner = error
    ? `<div style="background:#fff3e0;border:1px solid #ffcc80;color:#e65100;padding:8px 10px;border-radius:6px;font-size:12px;margin-bottom:10px">拉取失败，显示缓存/空数据：${escapeHtml(error)}</div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:system-ui,'Microsoft YaHei',sans-serif;padding:14px;color:#333;font-size:13px}
    h2{font-size:14px;margin:0 0 4px} .meta{color:#888;font-size:12px;margin-bottom:10px}
    table{width:100%;border-collapse:collapse} td{padding:6px 8px;border-bottom:1px solid #eee}
    .total{margin-top:10px;font-size:12px;color:#555}
  </style></head><body>
    ${banner}
    <h2>鼠鼠数据索引</h2>
    <div class="meta">来源 ${escapeHtml(summary.source || '?')} · 更新于 ${escapeHtml(summary.generatedAt || '?')}</div>
    <table><thead><tr><td>数据集</td><td style="text-align:right">条目数</td><td>sha256</td></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" style="color:#aaa">暂无数据</td></tr>'}</tbody></table>
    <div class="total">共 ${summary.datasetCount} 个数据集 / ${summary.totalEntries} 条记录</div>
  </body></html>`;
}
