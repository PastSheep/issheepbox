/**
 * 预加载脚本：向渲染进程暴露受控的壳 API。
 *
 * 安全约束：contextIsolation=true、sandbox=true、nodeIntegration=false。
 * 只暴露最小必要 API，不直接暴露 ipcRenderer。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('shellAPI', {
  /** 订阅 UI 状态更新。 */
  onUiState: (callback: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on('shell:ui-state', handler);
    return () => ipcRenderer.removeListener('shell:ui-state', handler);
  },
  /** 主动请求一次状态刷新。 */
  requestState: () => ipcRenderer.invoke('shell:get-state'),
});
