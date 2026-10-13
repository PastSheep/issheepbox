import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { IsSheepBoxKernel } from '@issheepbox/kernel';
import type { BootResult } from '@issheepbox/kernel';

/**
 * Electron 主进程入口（TASK-006：接入内核与壳 UI）。
 *
 * 职责：
 *  1. 创建 BrowserWindow + preload
 *  2. 启动内核（kernel.start）：加载 profile、扫描插件、挂载默认壳
 *  3. 将内核状态（safeMode / enabled 插件 / mounted 插件）推送到渲染进程
 *  4. 订阅 shell:ui-refresh 事件，变更时重新推送
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

void app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData');
  // 开发态：pluginsDir 指向 monorepo packages/ 目录（loader 会跳过无 plugin.json 的目录）。
  // 生产态应使用 path.join(userDataDir, 'plugins')。
  const pluginsDir = path.join(__dirname, '..', '..', '..', 'packages');

  createWindow();

  try {
    const result = await kernel.start(userDataDir, pluginsDir);
    boot = result.boot;
  } catch (err) {
    console.error('[is-sheep-box] kernel.start() 失败:', err);
  }

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
