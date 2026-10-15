/**
 * 可交互面板桥最小示例（com.pastsheep.echo-panel）。
 *
 * 演示契约（与 desktop main.ts / preload.ts / index.html 配合）：
 *  - 注册一个 interactive 面板（assets/panel.html，iframe srcdoc 加载）
 *  - 面板内 window.isbPanel.post(data) → iframe postMessage → 渲染进程转发
 *    → IPC panel:post → 内核事件 panel:inbound（本插件在此认领）
 *  - 本插件 ctx.events.emit('panel:outbound', {pluginId, panelId, data})
 *    → 宿主 webContents.send('panel:msg') → 渲染进程路由回该 iframe
 *    → 面板 window.isbPanel.on(cb) 收到
 *
 * 本插件不申请任何权限（纯 UI 消息往返，不碰文件/网络）。
 */
import type { PluginContext } from '@issheepbox/kernel';

const PANEL_ID = 'echo-main';

export default function main(ctx: PluginContext): void {
  const pluginId = ctx.manifest.id;
  ctx.logger.info('echo-panel 示例插件已挂载');

  // 注册交互面板（interactive:true → 宿主用 iframe 挂载并接通桥）。
  const shellUi = ctx.services.has('shell:ui')
    ? (ctx.services.get('shell:ui') as {
        registerPanel: (
          id: string,
          title: string,
          options?: Record<string, unknown>,
        ) => () => void;
      })
    : undefined;

  if (shellUi) {
    const unregister = shellUi.registerPanel(PANEL_ID, '可交互面板示例', {
      pluginId,
      src: 'assets/panel.html',
      interactive: true,
      width: 420,
      height: 320,
    });
    ctx.effects.add(unregister);
  } else {
    ctx.logger.warn('shell:ui 服务不可用，跳过面板注册');
  }

  // 面板 → 主进程：只认领自己的 panelId，回发一条 echo 消息。
  ctx.events.on('panel:inbound', (...args: unknown[]) => {
    const msg = args[0] as { pluginId?: string; panelId?: string; data?: { text?: string } };
    if (!msg || msg.panelId !== PANEL_ID) return;
    ctx.logger.info(`收到面板消息: ${JSON.stringify(msg.data)}`);
    ctx.events.emit('panel:outbound', {
      pluginId,
      panelId: PANEL_ID,
      data: {
        type: 'echo',
        text: `主进程已收到：${msg.data?.text ?? ''}`,
        at: Date.now(),
      },
    });
  });
}
