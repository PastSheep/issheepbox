/**
 * 授权目录选择面板插件（com.pastsheep.files-picker）。
 *
 * 职责：
 *  - 经 shell:ui 注册交互面板「授权目录」，展示 files 服务维护的已授权目录白名单。
 *  - 只调用 listAuthorizedDirs() 读取白名单字符串列表，从不 readText/listDir/stat
 *    （不读文件内容），因此不申请 files:read——最小权限原则。
 *  - 面板点「添加授权目录」→ panel:inbound {type:'pick-directory'} →
 *    本插件 emit 约定事件 host:pick-directory {pluginId}（桌面宿主 main.ts 目前
 *    并不实现该事件桥，属刻意约定）→ 随即回 panel:outbound
 *    {type:'pick-result', supported:false, message} 优雅降级，绝不抛错或悬挂。
 *
 * 软依赖 files 服务：files-service 未启用时面板显示降级文案，不崩。
 * shell:ui 不可用时 warn 跳过面板注册，不崩。
 *
 * ctx 只用 v1 已交付接口：manifest / apiVersion / logger / events / services / effects。
 */
import type { PluginContext } from '@issheepbox/kernel';

const PANEL_ID = 'files-picker-main';

/** files 服务形状（跨插件消费，结构类型对齐 files-service 插件；本插件只用到白名单查询）。 */
interface FilesServiceShape {
  authorizeDir(dir: string): void;
  listAuthorizedDirs(): string[];
}

interface ShellUiShape {
  registerPanel(
    panelId: string,
    title: string,
    options?: {
      pluginId?: string;
      src?: string;
      html?: string;
      interactive?: boolean;
      width?: number;
      height?: number;
    },
  ): () => void;
}

interface PanelInboundData {
  type?: string;
}

export default function main(ctx: PluginContext): void {
  const pluginId = ctx.manifest.id;
  ctx.logger.info('files-picker 授权目录面板已挂载');

  /**
   * 从 files 服务真实读取白名单并推送给面板。
   * files 服务缺失或读取失败时发降级文案，绝不抛错。
   */
  function pushDirs(): void {
    if (!ctx.services.has('files')) {
      ctx.events.emit('panel:outbound', {
        pluginId,
        panelId: PANEL_ID,
        data: {
          type: 'dirs',
          dirs: [],
          degraded: true,
          message: '文件服务未就绪（files-service 插件未启用）',
        },
      });
      return;
    }
    const files = ctx.services.get<FilesServiceShape>('files');
    let dirs: string[];
    try {
      dirs = files.listAuthorizedDirs();
    } catch (err) {
      ctx.logger.warn(`读取已授权目录失败: ${(err as Error).message}`);
      ctx.events.emit('panel:outbound', {
        pluginId,
        panelId: PANEL_ID,
        data: { type: 'dirs', dirs: [], degraded: true, message: '读取已授权目录失败' },
      });
      return;
    }
    ctx.events.emit('panel:outbound', {
      pluginId,
      panelId: PANEL_ID,
      data: { type: 'dirs', dirs },
    });
  }

  // 注册交互面板（interactive:true → 宿主用 iframe 挂载并接通桥）。
  const shellUi = ctx.services.has('shell:ui')
    ? ctx.services.get<ShellUiShape>('shell:ui')
    : undefined;
  if (shellUi) {
    const unregister = shellUi.registerPanel(PANEL_ID, '授权目录', {
      pluginId,
      src: 'assets/panel.html',
      interactive: true,
      width: 480,
      height: 360,
    });
    ctx.effects.add(unregister);
    // 挂载后推送一次真实白名单快照
    pushDirs();
  } else {
    ctx.logger.warn('shell:ui 服务不可用，跳过面板注册');
  }

  // 面板 → 主进程：只认领自己的 panelId。
  ctx.events.on('panel:inbound', (...args: unknown[]) => {
    const msg = args[0] as { pluginId?: string; panelId?: string; data?: PanelInboundData };
    if (!msg || msg.panelId !== PANEL_ID) return;
    const data = msg.data ?? {};

    // 刷新类消息（面板加载时 / 用户触发时）→ 重新读真实白名单推送
    if (data.type === 'refresh' || data.type === 'dirs') {
      pushDirs();
      return;
    }

    if (data.type === 'pick-directory') {
      // 约定事件：桌面宿主 main.ts 目前并不实现该事件桥（刻意约定）。
      ctx.events.emit('host:pick-directory', { pluginId });
      // 立即优雅降级回面板：宿主暂不支持目录选择，不抛错、不悬挂。
      ctx.events.emit('panel:outbound', {
        pluginId,
        panelId: PANEL_ID,
        data: { type: 'pick-result', supported: false, message: '宿主暂不支持目录选择' },
      });
    }
  });
}
