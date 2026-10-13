/**
 * services 注册表（占位骨架）。
 *
 * 职责（TASK-003 实现）：插件通过 ctx 注册/消费服务；
 * 插件卸载时其注册的服务自动注销（可逆 effects）。
 */
export class ServiceRegistry {
  register<T>(_name: string, _service: T): void {
    throw new Error('ServiceRegistry.register() 未实现：见 TASK-003');
  }

  resolve<T>(_name: string): T {
    throw new Error('ServiceRegistry.resolve() 未实现：见 TASK-003');
  }
}
