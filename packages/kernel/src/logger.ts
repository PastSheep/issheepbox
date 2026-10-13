/**
 * 日志实现。
 *
 * 内核侧把每条日志打上插件 id 前缀，便于在宿主控制台区分来自哪个插件。
 * 后续任务（壳插件、Electron 主进程）可替换为更结构化的输出。
 */
import type { Logger } from './types';

export function createLogger(pluginId: string): Logger {
  const tag = `[isb:${pluginId}]`;
  return {
    debug: (msg, ...args) => console.debug(tag, msg, ...args),
    info: (msg, ...args) => console.info(tag, msg, ...args),
    warn: (msg, ...args) => console.warn(tag, msg, ...args),
    error: (msg, ...args) => console.error(tag, msg, ...args),
  };
}
