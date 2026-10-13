/**
 * 类型化事件总线（占位骨架）。
 *
 * 职责（TASK-003 实现）：插件间通过 events 协作，不直接引用；
 * 插件卸载时其事件订阅自动取消（可逆 effects）。
 */
export class EventBus {
  on(_event: string, _handler: (...args: unknown[]) => void): void {
    throw new Error('EventBus.on() 未实现：见 TASK-003');
  }

  emit(_event: string, ..._args: unknown[]): void {
    throw new Error('EventBus.emit() 未实现：见 TASK-003');
  }
}
