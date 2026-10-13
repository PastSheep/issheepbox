import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, ipcMain } from 'electron';
import { IsSheepBoxKernel } from '@issheepbox/kernel';
import type { BootResult } from '@issheepbox/kernel';

/**
 * Electron 主进程入口（TASK-006/011：内核接入 + 生产打包）。
 *
 * 职责：
 *  1. 创建 BrowserWindow + preload
 *  2. 解析 pluginsDir：开发态用 monorepo packages/；生产态用 userData/plugins
 *  3. 生产态首次启动：把 resources/builtin-plugins/ 下的第一方插件
 *     （shell-default、approval-policy）展开到 userData/plugins/
 *  4. 启动内核（kernel.start）：加载 profile、扫描插件、挂载默认壳
 *  5. 启动失败回退：尝试从最新快照恢复；失败则记录并进入安全模式
 *  6. 将内核状态推送到渲染进程；订阅 shell:ui-refresh 即时刷新
 */

let win: BrowserWindow | null = null;
let boot: BootResult = { safeMode: false, activeShell: '', mountFailures: [] };
const kernel = new IsSheepBoxKernel();

/** 收集当前内核 UI 状态并推送到渲染进程。 */
function pushUiState(): void {
  if (!win || win.isDestroyed()) return;
  const profile = kernel.profile?.getCurrent();
  win.webContents.send('shell:ui-state', {
    profileName: profile?.name ?? '(未初始化)',
    enabled: profile?.enabled ?? [],
    shell: profile?.shell ?? '',
    mountedIds: kernel.lifecycle.mountedIds,
    safeMode: boot.safeMode,
    activeShell: boot.activeShell,
    mountFailures: boot.mountFailures.map((f) => ({
      pluginId: f.pluginId,
      error: f.error.message,
    })),
  });
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
 * 递归拷贝目录（内置插件展开用）。
 * 已存在且 plugin.json 版本一致则跳过，避免覆盖用户本地修改。
 */
function copyDirIfNewer(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  // 版本一致则跳过。
  if (fs.existsSync(path.join(dest, 'plugin.json'))) {
    try {
      const srcPkg = JSON.parse(
        fs.readFileSync(path.join(src, 'plugin.json'), 'utf8'),
      ) as { version?: string };
      const destPkg = JSON.parse(
        fs.readFileSync(path.join(dest, 'plugin.json'), 'utf8'),
      ) as { version?: string };
      if (srcPkg.version && srcPkg.version === destPkg.version) return;
    } catch {
      // 读取失败则继续覆盖。
    }
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    if (fs.statSync(s).isDirectory()) {
      copyDirIfNewer(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * 解析插件目录。
 *  - 开发态（app.isPackaged === false）：monorepo packages/，loader 自动跳过无 plugin.json 的目录。
 *  - 生产态：userData/plugins；首次启动把 resources/builtin-plugins/ 展开到该目录。
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
    for (const entry of fs.readdirSync(builtinDir)) {
      const src = path.join(builtinDir, entry);
      const dest = path.join(pluginsDir, entry);
      if (fs.statSync(src).isDirectory()) {
        copyDirIfNewer(src, dest);
      }
    }
  }
  return pluginsDir;
}

/** 启动内核；失败时尝试从最新快照回滚。 */
async function startKernelWithFallback(userDataDir: string): Promise<void> {
  const pluginsDir = resolvePluginsDir(userDataDir);
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
