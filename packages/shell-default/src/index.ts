/**
 * Is Sheep Box 默认宿主壳插件（shell-default）。
 *
 * 职责（TASK-006）：
 *  - 作为 DEFAULT_SHELL_ID，被 ProfileEngine.boot() 第一个挂载
 *  - 订阅内核事件（profile 变更 / 安全模式 / 快照恢复），触发 UI 刷新信号
 *  - 注册 shell:ui service，为后续插件提供面板 seam（本任务仅占位）
 *
 * 边界：
 *  - 本插件运行于主进程（Node.js），不直接操作 DOM
 *  - 渲染由 Electron 渲染进程负责；本插件通过 EventBus 发信号，
 *    desktop 主进程桥接到 IPC → preload → renderer
 *  - ctx 只使用 v1 已定稿接口面（manifest / events / services / logger）
 */
import type { PluginContext } from '@issheepbox/kernel';

/** shell:ui service seam（供后续插件注册面板入口）。 */
export interface ShellUiService {
  /**
   * 注册一个面板入口（占位，TASK-006 仅记录，不实现 UI 挂载）。
   *
   * P-007：返回 unregister 函数——注册方（如 note）应把它登记进自身 ctx.effects，
   * 插件卸载时随 effect scope 自动回滚面板记录（规范 §5.2「卸载无残留」契约）。
   * 重复注册同一 panelId 时，每次返回的 unregister 只撤销本次注册产生的条目。
   */
  registerPanel: (panelId: string, title: string) => () => void;
  /** 已注册面板列表。 */
  panels: Array<{ id: string; title: string }>;
}

interface ProfileChangedPayload { name: string }
interface SafeModePayload { reason: string }
interface RestoredPayload { snapshotId: string }

export default function shellDefault(ctx: PluginContext): void {
  ctx.logger.info('默认壳已挂载');

  // 注册 shell:ui service：面板 seam，供其他插件贡献 UI 区域。
  const panels: Array<{ id: string; title: string }> = [];
  const uiService: ShellUiService = {
    panels,
    registerPanel(panelId, title) {
      // P-007：面板记录本身是壳的宿主侧状态，内核无法自动跟踪第三方 service 的
      // 注册动作——因此返回 unregister，由注册方经 ctx.effects.add 挂进自身 scope。
      const panel = { id: panelId, title };
      panels.push(panel);
      ctx.events.emit('shell:ui-refresh', { reason: 'panel-registered', panelId });
      return () => {
        // 按对象引用精确移除本次注册的条目（容忍重复 panelId），并触发刷新。
        const idx = panels.indexOf(panel);
        if (idx !== -1) panels.splice(idx, 1);
        ctx.events.emit('shell:ui-refresh', { reason: 'panel-unregistered', panelId });
      };
    },
  };
  ctx.services.register('shell:ui', uiService);

  // 订阅内核事件：profile 变更、安全模式、快照恢复时触发 UI 刷新。
  ctx.events.on('app:profile-changed', (...args: unknown[]) => {
    const payload = args[0] as ProfileChangedPayload;
    ctx.logger.info(`profile 变更: ${payload.name}`);
    ctx.events.emit('shell:ui-refresh', { reason: 'profile-changed', name: payload.name });
  });

  ctx.events.on('app:safe-mode', (...args: unknown[]) => {
    const payload = args[0] as SafeModePayload;
    ctx.logger.warn(`进入安全模式: ${payload.reason}`);
    ctx.events.emit('shell:ui-refresh', { reason: 'safe-mode', detail: payload.reason });
  });

  ctx.events.on('app:profile-restored', (...args: unknown[]) => {
    const payload = args[0] as RestoredPayload;
    ctx.logger.info(`从快照恢复: ${payload.snapshotId}`);
    ctx.events.emit('shell:ui-refresh', { reason: 'profile-restored', snapshotId: payload.snapshotId });
  });

  // 挂载完成时发一次初始刷新信号。
  ctx.events.emit('shell:ui-refresh', { reason: 'shell-mounted' });
}
