import type { PluginInstance } from '@issheepbox/kernel';

/**
 * 最小默认壳插件（占位）。
 *
 * TASK-006 实现：
 *  - 主界面（导航栏 + 工具箱网格 + 插件管理页 + 设置页）
 *  - 提供容器 seam（面板/入口/布局插槽）
 *  - 插件启停开关
 *  - 第一方、预置、不可卸载的 fallback 壳
 *
 * 当前仅导出一个占位插件实例，保证包可独立构建。
 */
const shellDefault: PluginInstance = {
  mount(): void {
    // TASK-006：注册壳 UI、容器 seam
  },
  unmount(): void {
    // TASK-006：卸载时清理 UI 注册
  },
};

export default shellDefault;
