# 文件文本统计（示例插件 · 带权限形态）

TASK-009 官方示例插件，验证规范 v1 的**带权限形态**：manifest 声明 `files:read`，经 approval-policy 授权后注册服务并工作。

## 权限工作流（本插件演示）

```
启用流程（宿主/验证脚本）
  → approval-policy.requestApprovalForManifest(manifest)   # 经 ctx.services.get('approval-policy')
  → 用户决策：granted（授权） / denied（拒绝）
  → denied → 插件不启用（拒绝路径）
  → granted → profile.enable(file-stats) → mount
  → 挂载时运行时自检（第一道闸）：approval-policy.checkPermission(id, 'files:read')
  → 通过 → 注册 file-stats 服务；未通过 → fail-safe 拒绝注册任何能力
  → 调用 statsOfFile(path) → ctx.files.readFile(path)（宿主能力第二道闸：
    内核每次按本插件 id 再做一次 checkPermission，未授权/服务不可用即抛错）
```

> 注意：v1 内核（ProfileEngine）尚未在 enable 时强制查询授权（见 docs/TASKS.md P-005），
> "拒绝后不可启用"依赖宿主/调用方先请求授权再启用；本插件的挂载自检是第一道防线，
> 宿主 `ctx.files` 能力的每次调用门禁是第二道（权威）防线。

## 沙箱边界（规范 §9.1）

插件不直接使用 `node:fs`。需要读文件时改经宿主注入的 `ctx.files.readFile(path)`
（P-009 新增宿主 files 能力，闭环规范反馈 F-008）：内核在每次调用时按本插件 id 经
`approval-policy.checkPermission(pluginId, 'files:read')` 做门禁，未授权或授权服务不可
用时 fail-safe 抛错。纯文本统计逻辑（行数/词数/字符数/字节数）保留在插件内作纯函数。

## 服务契约（本插件贡献）

- 服务名：`file-stats`（v1.0.0）
- 方法：`statsOfFile(path) → { lines, words, chars, bytes }`——经宿主 `ctx.files.readFile`
  读取真实文件后统计；未授权/授权服务不可用时 `readFile` 抛错。

## 目录结构

```
file-stats/
├── plugin.json          # manifest（permissions: ["files:read"]，entry: dist/index.js）
├── package.json         # workspace 包（devDep: @issheepbox/kernel，仅类型）
├── tsconfig.json
├── src/index.ts         # 入口（构建后为 dist/index.js）
└── README.md
```

## 构建与验证

```powershell
pnpm --filter @issheepbox/plugin-file-stats run build
node packages/plugins/verify-examples.cjs   # 覆盖拒绝路径 / 授权路径 / 运行时 fail-safe
```
