# @issheepbox/kernel

Is Sheep Box 自研**极薄内核**。边界见 `docs/requirements.md` 4.1：

- 只做四件事：插件加载、生命周期与依赖、services/events、profile 配置。
- **不**渲染业务 UI、**不**实现工具能力、**不**绑定具体壳、**不**假设插件来源。

## 当前状态

TASK-001 交付的是**占位骨架**：导出公共类型与各子系统的占位类，方法体一律抛
`not implemented`，由后续任务填充：

| 子系统 | 入口 | 实现任务 |
|---|---|---|
| 插件加载器 | `src/loader` | TASK-002 |
| 生命周期 + 可逆 effects | `src/lifecycle` | TASK-003 |
| services 注册表 | `src/services` | TASK-003 |
| 事件总线 | `src/events` | TASK-003 |
| 依赖解析 / 拓扑排序 | `src/dependency` | TASK-002 |
| profile 配置引擎 | `src/profile` | TASK-004 |
| apiVersion 兼容校验 | `src/loader` | TASK-005 |

公共类型（manifest、ctx v1、PluginInstance）见 `src/types.ts`，
是内核与插件之间的兼容性契约起点，正式 schema 由 TASK-010 定稿。
