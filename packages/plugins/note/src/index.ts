/**
 * 便签示例插件（TASK-009 · 纯 UI 面板形态）。
 *
 * 演示要点：
 *  - 无权限：manifest.permissions 为空，启用无需授权（规范 §7.2「默认无权限」）。
 *  - 面板 seam：经 `ctx.services.get('shell:ui').registerPanel()` 向默认壳注册面板；
 *    v1 不直接操作 DOM/壳（规范 §6.1）。shell:ui 由默认壳提供，缺失时优雅降级。
 *  - 插件间协作：消费 theme-service 的 `theme` 服务（ctx.services）并订阅
 *    `theme:changed` 事件（ctx.events），不直接 import 其他插件（规范 §8.1）。
 *  - 可逆 effects：事件监听/服务注册在卸载时由内核自动回滚（规范 §5.2）；
 *    面板注册的 unregister 经 ctx.effects.add 登记进同一 scope，卸载时面板记录
 *    同样自动回滚（P-007，闭环规范反馈 F-006）。
 *
 * 注意：ctx 只使用 v1 已交付接口（manifest / apiVersion / logger / events /
 * services / effects），不使用规范 §11 示例中的 ctx.commands / ctx.panels /
 * ctx.storage（尚未交付，见规范反馈）。
 */
import type { PluginContext } from '@issheepbox/kernel';

/** 本插件在 shell:ui 注册的面板 ID（与 manifest ui.panels[0].id 一致）。 */
const PANEL_ID = 'note-main';

/**
 * shell:ui 服务形状（由默认壳插件注册，见 packages/shell-default/src/index.ts）。
 * options 为面板内容渲染元数据（契约 C4），与本插件 manifest ui.panels[0] 对齐。
 */
interface PanelContentOptions {
  pluginId?: string;
  src?: string;
  html?: string;
  width?: number;
  height?: number;
}

interface ShellUiShape {
  registerPanel(
    panelId: string,
    title: string,
    options?: PanelContentOptions,
  ): () => void;
}

/** theme-service 提供的主题服务形状（跨插件消费，仅作类型对齐）。 */
interface ThemeServiceShape {
  getTheme(): string;
}

export default function main(ctx: PluginContext): void {
  registerPanel(ctx);
  syncTheme(ctx);
  bindNewNoteCommand(ctx);
  ctx.logger.info(
    `便签插件 v${ctx.manifest.version} 已启动（ctx apiVersion=${ctx.apiVersion}）`,
  );
}

/** 经 shell:ui seam 注册面板（壳未挂载时降级，不影响插件其余功能）。 */
function registerPanel(ctx: PluginContext): void {
  if (!ctx.services.has('shell:ui')) {
    ctx.logger.warn('shell:ui 服务不可用（默认壳未挂载），跳过面板注册');
    return;
  }
  const ui = ctx.services.get<ShellUiShape>('shell:ui');
  // P-007：把壳返回的 unregister 登记进本插件 effect scope——卸载时面板记录
  // 随 scope dispose 自动回滚，符合规范 §5.2「卸载无残留」契约。
  // 契约 C4：随调用传面板内容元数据（与 manifest ui.panels[0] 对齐），
  // 宿主渲染进程据此经 IPC shell:read-plugin-asset 读 assets/panel.html 挂载。
  const unregister = ui.registerPanel(PANEL_ID, '我的便签', {
    pluginId: 'org.issheepbox.example.note',
    src: 'assets/panel.html',
    width: 360,
    height: 240,
  });
  ctx.effects.add(unregister);
  ctx.logger.info(`已向默认壳注册面板 ${PANEL_ID}（卸载时自动回滚）`);
}

/**
 * 与主题服务协作（软依赖）：
 *  - 服务路径：挂载时读取当前主题（ctx.services.get('theme')）
 *  - 事件路径：订阅 theme:changed 跟随主题变化，并转发为本插件自己的
 *    note:theme-synced 事件（供验证脚本/宿主观察协作闭环）
 */
function syncTheme(ctx: PluginContext): void {
  if (ctx.services.has('theme')) {
    const theme = ctx.services.get<ThemeServiceShape>('theme').getTheme();
    ctx.logger.info(`便签面板使用主题: ${theme}`);
  } else {
    ctx.logger.info('theme 服务未就绪，等待 theme:changed 事件同步');
  }

  ctx.events.on('theme:changed', (payload: unknown) => {
    const theme = (payload as { theme?: string } | undefined)?.theme ?? 'unknown';
    ctx.events.emit('note:theme-synced', { theme });
    ctx.logger.info(`便签面板已同步主题: ${theme}`);
  });
}

/** 命令事件示范：宿主/其他插件触发 note:new，本插件响应并广播 note:created。 */
function bindNewNoteCommand(ctx: PluginContext): void {
  ctx.events.on('note:new', () => {
    ctx.events.emit('note:created', { at: Date.now() });
    ctx.logger.info('已创建新便签');
  });
}
