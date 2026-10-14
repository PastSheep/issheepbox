/**
 * 预加载脚本：向渲染进程暴露受控的壳 API。
 *
 * 安全约束：contextIsolation=true、sandbox=true、nodeIntegration=false。
 * 只暴露最小必要 API，不直接暴露 ipcRenderer。
 *
 * TASK-012 新增：
 *  - onApprovalRequest / approvalResponse（契约 C1：权限清单对话框往返）
 *  - market.{list,install,uninstall,update}（市场安装编排）
 *  - readPluginAsset（契约 C4：面板 src 资源读取）
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

  /**
   * 订阅内核转发来的权限授权请求（契约 C1 approval:ui-request）。
   * 载荷形状 { token, pluginId, pluginName, permissions: PermissionInfo[] }。
   */
  onApprovalRequest: (callback: (request: unknown) => void) => {
    const handler = (_event: unknown, request: unknown) => callback(request);
    ipcRenderer.on('approval:ui-request', handler);
    return () => ipcRenderer.removeListener('approval:ui-request', handler);
  },
  /** 回传授权决策（契约 C1 approval:ui-response）。 */
  approvalResponse: (body: { token: string; result: unknown }) =>
    ipcRenderer.invoke('approval:ui-response', body),

  /** 市场：列出 registry 条目 + 本地已装状态。 */
  market: {
    list: () => ipcRenderer.invoke('shell:market-list'),
    install: (pluginId: string) => ipcRenderer.invoke('shell:market-install', pluginId),
    uninstall: (pluginId: string) => ipcRenderer.invoke('shell:market-uninstall', pluginId),
    update: (pluginId: string) => ipcRenderer.invoke('shell:market-update', pluginId),
  },

  /** 读取插件包内文本资源（契约 C4 面板 src）。 */
  readPluginAsset: (pluginId: string, relativePath: string) =>
    ipcRenderer.invoke('shell:read-plugin-asset', { pluginId, relativePath }),
});
