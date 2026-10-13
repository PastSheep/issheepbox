/**
 * profile 配置引擎（占位骨架）。
 *
 * 职责（TASK-004 实现）：
 *  - 命名组合（启用的插件 ID 列表 + 每插件配置）的持久化/加载/切换
 *  - 运行时启停插件并热重载（HMR）
 *  - 启动时按 profile 加载壳；失败/缺失回退内置默认壳（安全模式）
 *  - 升级/变更前自动快照，失败可回滚
 */
export class ProfileEngine {
  async loadCurrent(): Promise<never> {
    throw new Error('ProfileEngine.loadCurrent() 未实现：见 TASK-004');
  }

  async switch(_name: string): Promise<never> {
    throw new Error('ProfileEngine.switch() 未实现：见 TASK-004');
  }
}
