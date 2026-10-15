/**
 * 应用更新检查插件（org.issheepbox.updater）。
 *
 * 只管应用本体（Electron 桌面端）更新；功能插件更新归市场链路，不在此列。
 *
 * 职责：
 *  - checkForUpdate(currentVersion)：查 GitHub Releases latest，semver 比对；
 *    发现新版且未被忽略时广播 updater:update-available。
 *  - getState()：最近检查时间、已忽略版本、最新版本。
 *  - dismiss(version)：忽略某个版本（不再提示）。
 *  - 断网/请求失败静默降级：返回 error 字段，不抛错、不崩。
 *
 * 权限：network:fetch（查 Releases）+ files:read/write（持久化检查状态到 userData）。
 *
 * ctx 只用 v1 已交付接口：manifest / apiVersion / logger / events / services / effects / files。
 */
import type { PluginContext } from '@issheepbox/kernel';

const NETWORK_FETCH = 'network:fetch';
const FILES_READ = 'files:read';
const FILES_WRITE = 'files:write';

export const UPDATER_SERVICE_NAME = 'updater';
export const UPDATER_EVENT_AVAILABLE = 'updater:update-available';

/** GitHub 官方仓库 latest release 接口。 */
const GITHUB_LATEST_URL =
  'https://api.github.com/repos/PastSheep/issheepbox/releases/latest';

const STATE_FILE = 'issheepbox-updater-state.json';

interface ApprovalPolicyShape {
  checkPermission(pluginId: string, permission: string): boolean;
}
interface HostUserDataShape {
  dir: string;
}

/** 最小 fetch 形状（主进程 Node 22 自带全局 fetch；测试可注入 mock）。 */
export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  /** 失败原因（网络错误/解析失败）；成功时为 null。 */
  error: string | null;
}

interface UpdaterState {
  lastCheckAt: number | null;
  ignoredVersion: string | null;
  latestVersion: string | null;
  releaseUrl: string | null;
}

export interface UpdaterService {
  /**
   * 检查更新。失败时 resolve 为 { updateAvailable:false, error }，不 reject。
   * @param currentVersion 当前应用版本（如 "0.2.2"）
   * @param opts.fetchImpl 可注入 fetch（测试用）；缺省用全局 fetch
   */
  checkForUpdate(
    currentVersion: string,
    opts?: { fetchImpl?: FetchLike },
  ): Promise<UpdateCheckResult>;
  /** 只读快照：最近检查时间、忽略版本、已知最新版。 */
  getState(): UpdaterState;
  /** 忽略某版本（之后不再提示该版本）。 */
  dismiss(version: string): void;
}

export default function main(ctx: PluginContext): void {
  if (!hasPermissions(ctx)) {
    ctx.logger.error(
      `updater 未获 "${NETWORK_FETCH}"/"${FILES_READ}"/"${FILES_WRITE}" 授权，fail-safe 不注册`,
    );
    return;
  }

  const baseDir = resolveUserDataDir(ctx);
  const state: UpdaterState = loadState(ctx, baseDir);

  function persist(): void {
    if (!baseDir) return;
    try {
      ctx.files.writeFile(baseDir + '/' + STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      ctx.logger.error(`updater 状态持久化失败: ${(err as Error).message}`);
    }
  }

  async function checkForUpdate(
    currentVersion: string,
    opts?: { fetchImpl?: FetchLike },
  ): Promise<UpdateCheckResult> {
    const fetchImpl = opts?.fetchImpl ?? defaultFetch();
    if (!fetchImpl) {
      return { updateAvailable: false, currentVersion, error: '当前环境无 fetch 能力' };
    }

    let latest: string;
    let releaseUrl: string;
    try {
      const res = await fetchImpl(GITHUB_LATEST_URL);
      if (!res.ok) {
        return { updateAvailable: false, currentVersion, error: `GitHub API HTTP ${res.status}` };
      }
      const json = (await res.json()) as { tag_name?: string; html_url?: string };
      if (!json || typeof json.tag_name !== 'string') {
        return { updateAvailable: false, currentVersion, error: 'GitHub Releases 响应结构异常' };
      }
      latest = json.tag_name.replace(/^v/i, '');
      releaseUrl = typeof json.html_url === 'string' ? json.html_url : GITHUB_LATEST_URL;
    } catch (err) {
      // 断网静默降级：不抛错
      return { updateAvailable: false, currentVersion, error: (err as Error).message };
    }

    state.lastCheckAt = Date.now();
    state.latestVersion = latest;
    state.releaseUrl = releaseUrl;
    persist();

    const available = compareVersions(latest, currentVersion) > 0;
    const ignored = state.ignoredVersion === latest;
    if (available && !ignored) {
      ctx.events.emit(UPDATER_EVENT_AVAILABLE, {
        currentVersion,
        latestVersion: latest,
        releaseUrl,
      });
    }
    return {
      updateAvailable: available && !ignored,
      currentVersion,
      latestVersion: latest,
      releaseUrl,
      error: null,
    };
  }

  const service: UpdaterService = {
    checkForUpdate,
    getState: () => ({ ...state }),
    dismiss: (version: string) => {
      state.ignoredVersion = version;
      persist();
      ctx.logger.info(`updater 已忽略版本: ${version}`);
    },
  };

  ctx.services.register(UPDATER_SERVICE_NAME, service);
  ctx.logger.info('updater 服务已注册（应用本体更新检查；功能插件更新归市场）');
}

/** 简单 semver 比对：a > b 返回 1，a < b 返回 -1，相等返回 0。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function parseVersion(v: string): [number, number, number] {
  const m = (v || '0.0.0').replace(/^v/i, '').split('.');
  const num = (s: string | undefined) => {
    const n = parseInt(s ?? '0', 10);
    return Number.isFinite(n) ? n : 0;
  };
  return [num(m[0]), num(m[1]), num(m[2])];
}

function hasPermissions(ctx: PluginContext): boolean {
  if (!ctx.services.has('approval-policy')) return false;
  const policy = ctx.services.get<ApprovalPolicyShape>('approval-policy');
  return (
    policy.checkPermission(ctx.manifest.id, NETWORK_FETCH) &&
    policy.checkPermission(ctx.manifest.id, FILES_READ) &&
    policy.checkPermission(ctx.manifest.id, FILES_WRITE)
  );
}

function resolveUserDataDir(ctx: PluginContext): string | null {
  if (!ctx.services.has('host:user-data')) return null;
  const host = ctx.services.get<HostUserDataShape>('host:user-data');
  if (!host || typeof host.dir !== 'string' || host.dir.trim() === '') return null;
  return host.dir.replace(/[\\/]+$/, '');
}

function loadState(ctx: PluginContext, baseDir: string | null): UpdaterState {
  const fallback: UpdaterState = { lastCheckAt: null, ignoredVersion: null, latestVersion: null, releaseUrl: null };
  if (!baseDir) return fallback;
  try {
    const raw = ctx.files.readFile(baseDir + '/' + STATE_FILE);
    if (!raw || raw.trim() === '') return fallback;
    const parsed = JSON.parse(raw) as Partial<UpdaterState>;
    return {
      lastCheckAt: typeof parsed.lastCheckAt === 'number' ? parsed.lastCheckAt : null,
      ignoredVersion: typeof parsed.ignoredVersion === 'string' ? parsed.ignoredVersion : null,
      latestVersion: typeof parsed.latestVersion === 'string' ? parsed.latestVersion : null,
      releaseUrl: typeof parsed.releaseUrl === 'string' ? parsed.releaseUrl : null,
    };
  } catch {
    return fallback;
  }
}

/** 取全局 fetch（主进程 Node 22 自带）。 */
function defaultFetch(): FetchLike | null {
  const fn = (globalThis as { fetch?: FetchLike }).fetch;
  return fn ?? null;
}
