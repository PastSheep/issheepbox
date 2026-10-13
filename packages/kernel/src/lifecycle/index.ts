/**
 * 插件生命周期管理（占位骨架）。
 *
 * 职责（TASK-003 实现）：
 *  - mount / init / start / stop / unmount 钩子调度
 *  - 可逆 effects：插件注册的服务、事件监听在卸载时自动回滚
 *  - 失败隔离：单插件异常不拖垮其他插件
 */
export class LifecycleManager {
  async mountAll(): Promise<never> {
    throw new Error('LifecycleManager.mountAll() 未实现：见 TASK-003');
  }

  async unmountAll(): Promise<never> {
    throw new Error('LifecycleManager.unmountAll() 未实现：见 TASK-003');
  }
}
