/**
 * 主题服务示例插件（TASK-009 · 带服务形态）。
 *
 * 演示要点：
 *  - 服务提供：`ctx.services.register('theme', ...)` 注册服务，
 *    供其他插件经 `ctx.services.get('theme')` 消费（请求/响应，规范 §8.2）。
 *  - 事件广播：主题变更时 `ctx.events.emit('theme:changed')`，一对多通知订阅者。
 *  - 不直接引用：消费者（如便签插件）不 import 本插件代码，仅经 services/events 协作
 *    （规范 §8.1）。
 *  - 可逆 effects：服务注册在卸载时由内核自动注销，事件监听自动 off（规范 §5.2）。
 *
 * ctx 只使用 v1 已交付接口（manifest / apiVersion / logger / events / services）。
 */
import type { PluginContext } from '@issheepbox/kernel';

/** 内置主题清单（v1 最小集：浅色/深色）。 */
const THEMES: readonly string[] = ['light', 'dark'];

/** theme 服务形状（消费者经 ctx.services.get('theme') 获取）。 */
export interface ThemeService {
  /** 当前主题名（'light' | 'dark'）。 */
  getTheme(): string;
  /** 切换主题；非法值忽略并告警；实际变更时广播 theme:changed。 */
  setTheme(theme: string): void;
  /** light ↔ dark 往返切换，返回切换后的主题名。 */
  toggle(): string;
}

export default function main(ctx: PluginContext): void {
  let current: string = 'light';

  const service: ThemeService = {
    getTheme: () => current,
    setTheme(theme) {
      if (!THEMES.includes(theme)) {
        ctx.logger.warn(`未知主题 "${theme}"，忽略（可选: ${THEMES.join('/')}）`);
        return;
      }
      if (theme === current) return;
      current = theme;
      ctx.events.emit('theme:changed', { theme: current });
    },
    toggle() {
      const next: string = current === 'light' ? 'dark' : 'light';
      service.setTheme(next);
      return current;
    },
  };

  ctx.services.register('theme', service);
  ctx.logger.info('主题服务已注册（theme: light/dark）');
}
