/**
 * 类型化事件总线。
 *
 * 跨插件发布/订阅：插件 A 通过 ctx.events.emit('foo') 广播，
 * 插件 B 通过 ctx.events.on('foo', handler) 接收。
 *
 * TASK-003 将在此基础上包一层可逆 effects：插件卸载时自动 off() 其所有监听。
 */
import type { EventBus } from '../types';

type Handler = (...args: unknown[]) => void;

export class EventBusImpl implements EventBus {
  private readonly handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  off(event: string, handler: Handler): void {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(event);
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // 复制一份，避免 handler 内部 off/on 影响本轮遍历。
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch {
        // 单个 handler 抛错不影响其他订阅者；错误由上层日志记录。
      }
    }
  }
}
