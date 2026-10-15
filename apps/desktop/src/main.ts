import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, ipcMain, net } from 'electron';
import { IsSheepBoxKernel } from '@issheepbox/kernel';
import type { BootResult } from '@issheepbox/kernel';
import { MarketClient, PLUGIN_ID_RE } from '@issheepbox/market-client';
import type { MarketInstallError } from '@issheepbox/market-client';
import {
  hashDirectoryContent,
  readExpansionMeta,
  readPluginVersion,
  resolveBuiltinAction,
  writeExpansionMeta,
} from './builtinPlugins';

/**
 * Electron 主进程入口（TASK-006/011：内核接入 + 生产打包；P-004：内置插件刷新策略；
 * TASK-012：市场安装链路桌面侧接线）。
 *
 * 职责：
 *  1. 创建 BrowserWindow + preload
 *  2. 解析 pluginsDir：开发态用 monorepo packages/；生产态用 userData/plugins
 *  3. 生产态展开 resources/builtin-plugins/ 下的第一方插件
 *     （shell-default、approval-policy）到 userData/plugins/：
 *     幂等键 = resources 侧目录内容 hash（记录在 userData/plugins/.builtin-meta.json），
 *     首启全量拷贝；hash 不变跳过；应用升级后包内容 hash 变化即重拷刷新。
 *     策略细节与覆盖取舍见 builtinPlugins.ts 头注释。
 *  4. 启动内核（kernel.start）前注册宿主服务 host:user-data（契约 C3，供 TASK-015
 *     持久化授权记录消费）；启动：加载 profile、扫描插件、挂载默认壳
 *  5. 启动失败回退：尝试从最新快照恢复；失败则记录并进入安全模式
 *  6. 将内核状态推送到渲染进程（含 shell:ui panels，契约 C4）；订阅 shell:ui-refresh 即时刷新
 *  7. 权限对话框桥（契约 C1）：内核事件 approval:ui-request → 转发渲染进程；
 *     渲染进程 approval:ui-response → 回发内核事件 approval:ui-response；
 *     窗口已销毁时确定性拒绝（deny）。
 *  8. 市场 IPC（契约 C4 消费）：market-list/install/uninstall/update 与
 *     shell:read-plugin-asset（面板 src 资源读取，带路径守卫）。
 */

let win: BrowserWindow | null = null;
let boot: BootResult = { safeMode: false, activeShell: '', mountFailures: [] };
/** 当前内核扫描的插件目录（resolvePluginsDir 结果；市场安装与资源读取共用）。 */
let pluginsDir = '';
/** 市场客户端（懒构造；依赖 pluginsDir 解析完成）。 */
let marketClient: MarketClient | null = null;
const kernel = new IsSheepBoxKernel();

/** shell:ui 服务面板元素形状（契约 C4；TASK-014 落地前只有 id/title）。 */
interface UiPanel {
  id: string;
  title: string;
  pluginId?: string;
  src?: string;
  html?: string;
  width?: number;
  height?: number;
}

/** 收集当前内核 UI 状态并推送到渲染进程。 */
function pushUiState(): void {
  if (!win || win.isDestroyed()) return;
  const profile = kernel.profile?.getCurrent();
  const panels: UiPanel[] = kernel.services.has('shell:ui')
    ? kernel.services.get<{ panels: UiPanel[] }>('shell:ui').panels
    : [];
  win.webContents.send('shell:ui-state', {
    profileName: profile?.name ?? '(未初始化)',
    enabled: profile?.enabled ?? [],
    shell: profile?.shell ?? '',
    mountedIds: kernel.lifecycle.mountedIds,
    safeMode: boot.safeMode,
    activeShell: boot.activeShell,
    panels,
    mountFailures: boot.mountFailures.map((f) => ({
      pluginId: f.pluginId,
      error: f.error.message,
    })),
  });
}

/** 取/懒构造市场客户端（绑定当前 pluginsDir）。 */
function getMarketClient(): MarketClient {
  if (!marketClient) {
    // 用 Electron net.fetch（Chromium 网络栈）而非 Node 全局 fetch（undici）：
    // 用户本机 Windows 加速器代理下 undici 校验代理证书链失败
    // （UNABLE_TO_VERIFY_LEAF_SIGNATURE），net.fetch 走 Chromium 网络栈，
    // 信任系统/代理证书链，与渲染进程网络行为一致。
    // 类型适配：Electron 33 net.fetch 的 TS 签名首参为 string | Request
    // （缺 typeof fetch 的 URL 重载），而 market-client 恒传 string URL，
    // 故 cast 为 typeof fetch 注入（运行时行为一致）。
    marketClient = new MarketClient({
      pluginsDir,
      fetchImpl: net.fetch as typeof fetch,
    });
  }
  return marketClient;
}

/**
 * 安装/卸载/更新后重新扫描插件目录并刷新 profile 的可用插件表。
 *
 * 与 kernel.start() 内的发现流程同构：loader.loadAll → dependency.resolveOrder →
 * profile.setAvailablePlugins（不重复 mount；enable/disable 由调用方在后面驱动）。
 */
function rescanPlugins(): void {
  const discovery = kernel.loader.loadAll(pluginsDir);
  const resolved = kernel.dependency.resolveOrder(discovery.loaded);
  kernel.profile.setAvailablePlugins(resolved.ordered);
}

/** 把 MarketInstallError 转成渲染进程友好的 { ok:false, code, message }。 */
function marketError(err: unknown): { ok: false; code: string; message: string } {
  const e = err as Partial<MarketInstallError>;
  return {
    ok: false,
    code: typeof e?.code === 'string' ? e.code : 'UNKNOWN',
    message: err instanceof Error ? err.message : String(err),
  };
}

function createWindow(): BrowserWindow {
  win = new BrowserWindow({
    width: 1024,
    height: 720,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void win.loadFile(path.join(__dirname, '..', 'index.html'));
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => { win = null; });
  return win;
}

/**
 * 递归拷贝目录（内置插件展开用）：同名文件覆盖写，不删除 userData 侧多余文件。
 * 是否需要拷贝由 resolveBuiltinAction 决策（见 builtinPlugins.ts），本函数只执行。
 * 不清理多余文件是刻意保守的：内核按 manifest entry 加载，userData 侧残留文件不生效；
 * 如需精确对齐，后续可改为先清空 dest 再拷贝。
 */
function copyDirectoryRecursive(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    if (fs.statSync(s).isDirectory()) {
      copyDirectoryRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * 解析插件目录。
 *  - 开发态（app.isPackaged === false）：monorepo packages/，loader 自动跳过无 plugin.json 的目录。
 *  - 生产态：userData/plugins；把 resources/builtin-plugins/ 的第一方插件按内容 hash
 *    幂等展开到该目录（首启全量拷贝；同包内重复启动跳过；应用升级后 hash 变化即重拷）。
 */
function resolvePluginsDir(userDataDir: string): string {
  if (!app.isPackaged) {
    // __dirname = apps/desktop/dist → ../../../packages
    return path.join(__dirname, '..', '..', '..', 'packages');
  }

  const pluginsDir = path.join(userDataDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  // electron-builder 把内置插件打到 resources/builtin-plugins/。
  const builtinDir = path.join(process.resourcesPath, 'builtin-plugins');
  if (fs.existsSync(builtinDir)) {
    const metaPath = path.join(pluginsDir, '.builtin-meta.json');
    const meta = readExpansionMeta(metaPath) ?? { appVersion: app.getVersion(), plugins: {} };
    for (const entry of fs.readdirSync(builtinDir)) {
      const src = path.join(builtinDir, entry);
      if (!fs.statSync(src).isDirectory()) continue;
      const dest = path.join(pluginsDir, entry);

      const srcContentHash = hashDirectoryContent(src);
      const decision = resolveBuiltinAction({
        destPluginExists: fs.existsSync(path.join(dest, 'plugin.json')),
        srcContentHash,
        recorded: meta.plugins[entry],
      });

      if (decision.action === 'copy') {
        copyDirectoryRecursive(src, dest);
        console.log(`[is-sheep-box] 内置插件 ${entry} 已展开（原因：${decision.reason}）`);
      }
      // hash 计算失败时不写记录（下次启动重试）；成功则更新观测记录。
      if (srcContentHash) {
        meta.plugins[entry] = {
          pluginVersion: readPluginVersion(path.join(src, 'plugin.json')),
          contentHash: srcContentHash,
        };
      }
    }
    writeExpansionMeta(metaPath, meta);
  }
  return pluginsDir;
}

/** 启动内核；失败时尝试从最新快照回滚。 */
async function startKernelWithFallback(userDataDir: string): Promise<void> {
  pluginsDir = resolvePluginsDir(userDataDir);
  try {
    const result = await kernel.start(userDataDir, pluginsDir);
    boot = result.boot;
    return;
  } catch (err) {
    console.error('[is-sheep-box] kernel.start() 失败，尝试从快照恢复:', err);
  }

  // 第一次启动失败：尝试用最新快照恢复后重试。
  try {
    const snapshots = kernel.profile?.listSnapshots() ?? [];
    if (snapshots.length > 0 && kernel.profile) {
      await kernel.profile.restore(snapshots[snapshots.length - 1]);
      const result = await kernel.start(userDataDir, pluginsDir);
      boot = result.boot;
      boot.safeMode = true; // 走了回滚路径，标记安全模式。
      console.warn('[is-sheep-box] 已从快照恢复并以安全模式启动');
      return;
    }
  } catch (restoreErr) {
    console.error('[is-sheep-box] 快照恢复也失败:', restoreErr);
  }

  // 彻底失败：标记安全模式，让 UI 显示错误。
  boot = {
    safeMode: true,
    activeShell: '',
    mountFailures: [{ pluginId: '(kernel)', error: new Error('内核启动失败，进入安全模式') }],
  };
}

void app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData');

  // 契约 C3：kernel.start() 前注册宿主服务 host:user-data（{ dir }），
  // approval-policy（TASK-015 落地 DiskApprovalStore）挂载时据此选择持久化存储。
  kernel.services.register('host:user-data', { dir: userDataDir });

  // 契约 C1 桥：内核事件 approval:ui-request → 转发渲染进程弹权限清单；
  // 渲染进程经 IPC approval:ui-response 回 → 回发内核事件 approval:ui-response。
  // 窗口已销毁时确定性拒绝（deny），不悬挂授权请求。
  kernel.events.on('approval:ui-request', (payload) => {
    const req = payload as { token: string } | undefined;
    if (!req || typeof req.token !== 'string') return;
    if (!win || win.isDestroyed()) {
      kernel.events.emit('approval:ui-response', {
        token: req.token,
        result: { kind: 'deny' },
      });
      return;
    }
    win.webContents.send('approval:ui-request', payload);
  });
  ipcMain.handle('approval:ui-response', (_event, body) => {
    kernel.events.emit('approval:ui-response', body);
  });

  createWindow();
  await startKernelWithFallback(userDataDir);

  // 订阅壳刷新信号 → 重新推送状态。
  kernel.events.on('shell:ui-refresh', () => pushUiState());

  // 首次推送。
  pushUiState();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 渲染进程主动请求状态（页面加载后拉一次）。
ipcMain.handle('shell:get-state', () => pushUiState());

// ---------------------------------------------------------------------------
// 市场安装链路 IPC（TASK-012）
// ---------------------------------------------------------------------------

/** 列出 registry 条目 + 本地已装状态（网络失败返回友好错误文案所需的 code/message）。 */
ipcMain.handle('shell:market-list', async () => {
  try {
    const client = getMarketClient();
    const result = await client.fetchIndex();
    return {
      ok: true,
      topLevelErrors: result.topLevelErrors,
      entries: result.entries,
      installed: client.listInstalled(),
    };
  } catch (err) {
    return marketError(err);
  }
});

/** 安装编排：market.install → 重新发现插件 → profile.enable（授权门禁自然生效）。 */
ipcMain.handle('shell:market-install', async (_event, pluginId: string) => {
  try {
    const installed = await getMarketClient().install(pluginId);
    rescanPlugins();
    await kernel.profile.enable(pluginId);
    pushUiState();
    return { ok: true, result: installed };
  } catch (err) {
    return marketError(err);
  }
});

/** 卸载编排：先停用（disable 移除 enabled 并 unmount）→ market.uninstall 删目录。 */
ipcMain.handle('shell:market-uninstall', async (_event, pluginId: string) => {
  try {
    if (kernel.profile?.getCurrent().enabled.includes(pluginId)) {
      await kernel.profile.disable(pluginId);
    }
    await getMarketClient().uninstall(pluginId);
    pushUiState();
    return { ok: true };
  } catch (err) {
    return marketError(err);
  }
});

/** 更新编排：已启用则版本变更后重新 enable（授权记录命中即自动放行）。 */
ipcMain.handle('shell:market-update', async (_event, pluginId: string) => {
  try {
    const wasEnabled = kernel.profile?.getCurrent().enabled.includes(pluginId) ?? false;
    if (wasEnabled) {
      await kernel.profile.disable(pluginId);
    }
    const result = await getMarketClient().update(pluginId);
    if (result.updated) {
      rescanPlugins();
      if (wasEnabled) {
        await kernel.profile.enable(pluginId);
      }
    }
    pushUiState();
    return { ok: true, result };
  } catch (err) {
    return marketError(err);
  }
});

/**
 * 面板资源读取（契约 C4）：读 pluginsDir/<pluginId>/<relativePath> 文本。
 * 路径守卫：pluginId 须过 id 正则；relativePath 禁止绝对路径与 .. 穿越。
 */
ipcMain.handle('shell:read-plugin-asset', (_event, body) => {
  const { pluginId, relativePath } = (body ?? {}) as {
    pluginId?: string;
    relativePath?: string;
  };
  if (!pluginId || !PLUGIN_ID_RE.test(pluginId)) {
    return { ok: false, message: '非法插件 id' };
  }
  if (
    typeof relativePath !== 'string' ||
    relativePath === '' ||
    path.isAbsolute(relativePath) ||
    relativePath.split('/').some((seg) => seg === '..')
  ) {
    return { ok: false, message: '非法资源路径' };
  }
  const abs = path.resolve(pluginsDir, pluginId, relativePath);
  const root = path.resolve(pluginsDir, pluginId);
  if (!abs.startsWith(root + path.sep)) {
    return { ok: false, message: '资源路径越出插件目录' };
  }
  try {
    return { ok: true, content: fs.readFileSync(abs, 'utf8') };
  } catch (err) {
    return { ok: false, message: `读取资源失败：${(err as Error).message}` };
  }
});
