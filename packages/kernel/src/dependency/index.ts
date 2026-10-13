/**
 * 依赖解析（占位骨架）。
 *
 * 职责（TASK-002/TASK-003 实现）：
 *  - 读取 manifest.requires
 *  - 对插件加载顺序做拓扑排序
 *  - 缺失/循环依赖时报错并隔离
 */
export class DependencyResolver {
  async resolveOrder(_plugins: readonly unknown[]): Promise<never> {
    throw new Error('DependencyResolver.resolveOrder() 未实现：见 TASK-002');
  }
}
