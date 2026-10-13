/**
 * 服务注册表。
 *
 * 插件通过 ctx.services.register(name, service) 提供能力，
 * 其他插件通过 ctx.services.get(name) 消费。
 *
 * TASK-003 将在此基础上包一层可逆 effects：插件卸载时自动注销其注册的服务。
 */
import type { ServiceRegistry } from '../types';

export class ServiceRegistryImpl implements ServiceRegistry {
  private readonly services = new Map<string, unknown>();

  register<T>(name: string, service: T): void {
    if (this.services.has(name)) {
      throw new Error(`Service "${name}" 已注册，重复注册不被允许`);
    }
    this.services.set(name, service);
  }

  get<T>(name: string): T {
    if (!this.services.has(name)) {
      throw new Error(`Service "${name}" 未注册`);
    }
    return this.services.get(name) as T;
  }

  has(name: string): boolean {
    return this.services.has(name);
  }
}
