# 主题服务（示例插件 · 带服务形态）

TASK-009 官方示例插件，验证规范 v1 的**带服务形态**：注册 `theme` 服务供其他插件消费，并广播 `theme:changed` 事件，示范插件间协作（不直接引用，经 ctx.services / ctx.events）。

## 服务契约（本插件贡献）

| 项 | 值 |
|---|---|
| 服务名 | `theme`（v1.0.0，manifest contributes 已声明） |
| 方法 | `getTheme(): string` / `setTheme(theme)` / `toggle(): string` |
| 事件 | `theme:changed`，载荷 `{ theme }`，仅在主题实际变更时广播 |
| 内置主题 | `light` / `dark` |

## 消费者示范（便签插件 note）

便签插件不 import 本插件代码，只做两件事：

1. 挂载时 `ctx.services.get('theme').getTheme()` 读取当前主题（服务缺失时降级）；
2. 订阅 `theme:changed` 事件，变更时转发为 `note:theme-synced`。

## 目录结构

```
theme-service/
├── plugin.json          # manifest（contributes: theme 服务 + theme:changed 事件）
├── package.json         # workspace 包（devDep: @issheepbox/kernel，仅类型）
├── tsconfig.json
├── src/index.ts         # 入口（构建后为 dist/index.js）
└── README.md
```

## 构建与验证

```powershell
pnpm --filter @issheepbox/plugin-theme-service run build
node packages/plugins/verify-examples.cjs   # 覆盖服务消费 / 事件广播 / 卸载无残留
```
