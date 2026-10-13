/**
 * EffectScope —— 可逆 effects 的底层原语。
 *
 * 每个插件 mount 时拥有一个 EffectScope；插件通过 ctx 注册的一切
 * （事件监听、服务注册、后续追加的命令/面板等）都往 scope 里加 cleanup。
 * unmount 时逆序 dispose，保证先注册的后清理（处理注册顺序上的依赖）。
 *
 * 单个 cleanup 抛错不影响其他 cleanup；错误被吞掉并在 dispose 后由调用方记录。
 */
export class EffectScope {
  private cleanups: Array<() => void> = [];
  private disposed = false;

  /** 追加一个 cleanup 函数。 */
  add(fn: () => void): void {
    if (this.disposed) return;
    this.cleanups.push(fn);
  }

  /** 是否已 dispose。 */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 已登记的 cleanup 数量（调试/测试用）。 */
  get size(): number {
    return this.cleanups.length;
  }

  /** 逆序执行所有 cleanup，清空列表。重复调用安全。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 逆序：后注册的先清理，避免先注销被依赖的服务导致后续 cleanup 失败。
    for (const fn of [...this.cleanups].reverse()) {
      try {
        fn();
      } catch {
        // 单个 cleanup 失败不阻断其他 cleanup；调用方可通过 size/isDisposed 观察。
      }
    }
    this.cleanups = [];
  }
}
