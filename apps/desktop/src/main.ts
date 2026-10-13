import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { IsSheepBoxKernel } from '@issheepbox/kernel';

/**
 * Electron 主进程入口（TASK-001：空窗口脚手架）。
 *
 * 当前职责：创建一个空 BrowserWindow，加载 index.html；
 * 实例化内核并打印其 apiVersion，验证 monorepo 跨包引用已打通。
 * 真正的 kernel.start()（profile 加载、插件装载、壳渲染）由 TASK-002 起接入。
 */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
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
  win.once('ready-to-show', () => win.show());
  return win;
}

void app.whenReady().then(() => {
  const kernel = new IsSheepBoxKernel();
  console.log(`[is-sheep-box] kernel api v${kernel.apiVersion} loaded`);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
