# @issheepbox/kernel

Is Sheep Box 自研**极薄内核**。边界见 `docs/requirements.md` 4.1：

- 只做四件事：插件加载、生命周期与依赖、services/events、profile 配置。
- **不**渲染业务 UI、**不**实现工具能力、**不**绑定具体壳、**不**假设插件来源。

## 当前状态

| 子系统 | 入口 | 状态 |
|---|---|---|
| 插件加载器 | `src/loader` | ✅ TASK-002：扫描目录、解析 manifest、require 入口，失败隔离 |
| ctx API v1 | `src/types.ts` | ✅ TASK-002：manifest/apiVersion/logger/events/services |
| 事件总线 | `src/events` | ✅ TASK-002：on/off/emit，on 返回 unsubscribe |
| services 注册表 | `src/services` | ✅ TASK-002：register/get/has/unregister |
| 生命周期 + 可逆 effects | `src/lifecycle` + `src/effect-scope` | ✅ TASK-003：mount/unmount，插件注册的服务/事件监听 unmount 时自动回滚 |
| 依赖解析 / 拓扑排序 | `src/dependency` | 占位（TASK-002 骨架） |
| profile 配置引擎 | `src/profile` | 占位（TASK-004） |
| apiVersion 兼容校验 | `src/loader` | 占位（TASK-005） |

## 可逆 effects 工作原理

插件 mount 时，内核为其创建一个 `EffectScope`。插件通过 `ctx.events.on()` 或
`ctx.services.register()` 注册的一切，其 cleanup 函数（unsubscribe / unregister）
会自动登记进 scope。unmount 时逆序 dispose scope：

- `ctx.events.on()` 注册的监听 → 自动 `off()`
- `ctx.services.register()` 注册的服务 → 自动 `unregister()`

**插件开发者无需写 cleanup 函数**——这是 v1 的硬约定（见
`docs/plugin-spec-v1.md` 第 5.2 节）。

## 生命周期阶段

| 阶段 | 触发时机 | 插件可做什么 |
|---|---|---|
| load | 内核加载 manifest、校验通过后 | 只读操作 |
| mount | 调用入口函数 `main(ctx)` | 注册服务、事件监听（effects 自动跟踪） |
| start | mount 完成后 | 响应事件、处理用户操作 |
| stop | 用户禁用 / 卸载前 | 收尾（effects 由内核回滚） |
| unmount | 完全卸载 | — |

公共类型见 `src/types.ts`，是内核与插件之间的兼容性契约。
