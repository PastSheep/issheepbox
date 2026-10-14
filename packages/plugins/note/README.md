# 便签（示例插件 · 纯 UI 面板形态）

TASK-009 官方示例插件，验证规范 v1 的**纯 UI 面板形态**：无权限声明、经壳 seam 注册面板、经 events/services 与其他插件协作。

## 演示要点

| 规范点 | 本插件做法 |
|---|---|
| 默认无权限（§7.2） | `permissions: []`，启用无需授权 |
| 容器 seam（§6） | 经 `ctx.services.get('shell:ui').registerPanel('note-main', ...)` 注册面板，不直接操作 DOM |
| 插件间协作（§8） | 消费 `theme` 服务 + 订阅 `theme:changed` 事件（软依赖，服务缺失优雅降级） |
| 可逆 effects（§5.2） | 事件监听由内核在卸载时自动回滚 |

## 事件契约（本插件）

- 入向：`note:new`（触发新建便签）、`theme:changed`（跟随主题）
- 出向：`note:created`（新建完成）、`note:theme-synced`（主题已同步，载荷 `{ theme }`）

## 目录结构

```
note/
├── plugin.json          # manifest（entry: dist/index.js）
├── package.json         # workspace 包（devDep: @issheepbox/kernel，仅类型）
├── tsconfig.json        # 构建配置（tsc --build → dist/）
├── src/index.ts         # 入口（构建后为 dist/index.js）
├── assets/panel.html    # 面板模板（规范 §11.4 模型，随包交付）
└── README.md
```

## 构建与验证

```powershell
pnpm --filter @issheepbox/plugin-note run build
node packages/plugins/verify-examples.cjs
```

> 提示：规范 §11 的便签完整示例使用了尚未交付的 `ctx.commands / ctx.panels / ctx.storage`；
> 本插件按 v1 实际接口面（shell:ui seam + events/services）实现，差异见 docs/plugin-spec-v1.md 规范反馈（TASK-009）。
