/**
 * 应用更新提示面板插件（com.pastsheep.updater-ui · UI 面板形态）。
 *
 * 职责：
 *  - 订阅内核事件 updater:update-available（由 updater 插件广播），
 *    把载荷 { currentVersion, latestVersion, releaseUrl } 转发给自己的交互面板渲染；
 *  - 面板「忽略一次」按钮 → panel:inbound → 调 updater 服务 dismiss(version)；
 *  - updater 服务缺失时优雅降级：面板提示「更新服务暂不可用」，不抛错。
 *
 * 权限：无。纯 UI 事件消费——network:fetch 与状态持久化由 updater 插件持有，
 * 本插件只做事件转发与面板桥接。
 *
 * 面板桥（同 echo-panel / log-viewer）：
 *  - 主进程 → 面板：ctx.events.emit('panel:outbound', { pluginId, panelId, data })
 *  - 面板 → 主进程：ctx.events.on('panel:inbound') 只认领自己的 panelId
 *
 * ctx 只用 v1 已交付接口：manifest / apiVersion / logger / events / services / effects。
 */
import type { PluginContext } from '@issheepbox/kernel';

const PANEL_ID = 'updater-main';
const UPDATER_SERVICE_NAME = 'updater';
const UPDATER_EVENT_AVAILABLE = 'updater:update-available';

/** updater:update-available 事件载荷（与 updater 插件 contributes.events 对齐）。 */
interface UpdateAvailablePayload {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}

/** updater 服务形状（跨插件消费，结构类型对齐 updater 插件，只取本面板用到的方法）。 */
interface UpdaterServiceShape {
  dismiss(version: string): void;
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

export default function main(ctx: PluginContext): void {
  const pluginId = ctx.manifest.id;

  const shellUi = ctx.services.has('shell:ui')
    ? ctx.services.get<ShellUiShape>('shell:ui')
    : undefined;
  if (!shellUi) {
    ctx.logger.warn('shell:ui 服务不可用，跳过更新提示面板注册');
    return;
  }

  const unregister = shellUi.registerPanel(PANEL_ID, '更新提示', {
    pluginId,
    src: 'assets/panel.html',
    interactive: true,
    width: 420,
    height: 260,
  });
  ctx.effects.add(unregister);
  ctx.logger.info('updater-ui 面板已注册');

  // —— 内核 → 面板：updater 插件广播新版本 → 转发面板渲染 ——
  ctx.events.on(UPDATER_EVENT_AVAILABLE, (payload: unknown) => {
    const p = (payload ?? {}) as Partial<UpdateAvailablePayload>;
    ctx.events.emit('panel:outbound', {
      pluginId,
      panelId: PANEL_ID,
      data: {
        type: 'update-available',
        currentVersion: typeof p.currentVersion === 'string' ? p.currentVersion : '',
        latestVersion: typeof p.latestVersion === 'string' ? p.latestVersion : '',
        releaseUrl: typeof p.releaseUrl === 'string' ? p.releaseUrl : '',
      },
    });
  });

  // —— 面板 → 主进程：「忽略一次」→ 调 updater.dismiss，回告面板收起 ——
  ctx.events.on('panel:inbound', (...args: unknown[]) => {
    const msg = args[0] as {
      pluginId?: string;
      panelId?: string;
      data?: { type?: string; latestVersion?: string };
    };
    if (!msg || msg.panelId !== PANEL_ID) return;
    const data = msg.data ?? {};
    if (data.type !== 'dismiss') return;

    const version = typeof data.latestVersion === 'string' ? data.latestVersion : '';

    if (!ctx.services.has(UPDATER_SERVICE_NAME)) {
      // 优雅降级：updater 插件未启用/未授权，面板提示服务暂不可用，不抛错
      ctx.logger.warn('updater 服务不可用，dismiss 请求降级为提示');
      ctx.events.emit('panel:outbound', {
        pluginId,
        panelId: PANEL_ID,
        data: { type: 'unavailable', message: '更新服务暂不可用' },
      });
      return;
    }

    try {
      const updater = ctx.services.get<UpdaterServiceShape>(UPDATER_SERVICE_NAME);
      updater.dismiss(version);
    } catch (err) {
      ctx.logger.error(`updater-ui 调用 dismiss 失败: ${(err as Error).message}`);
      ctx.events.emit('panel:outbound', {
        pluginId,
        panelId: PANEL_ID,
        data: { type: 'unavailable', message: '更新服务暂不可用' },
      });
      return;
    }

    ctx.events.emit('panel:outbound', {
      pluginId,
      panelId: PANEL_ID,
      data: { type: 'dismissed', version },
    });
  });
}
