/**
 * 插件加载器（占位骨架）。
 *
 * 职责（TASK-002 实现）：
 *  - 扫描本地插件目录
 *  - 解析 plugin.json（按 types.ts 中的 manifest 草案）
 *  - 校验 apiVersion（TASK-005）
 *  - 加载入口代码并构造 PluginInstance
 *
 * 当前为占位：任何调用都显式抛出，避免误以为已可用。
 */
export class PluginLoader {
  async loadAll(): Promise<never> {
    throw new Error('PluginLoader.loadAll() 未实现：见 TASK-002 / TASK-005');
  }
}
