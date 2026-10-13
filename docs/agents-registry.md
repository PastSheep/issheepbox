# Agent 登记表（agents registry）

> 记录当前活跃的 agent 与工作区。**仓库即记忆**：新 agent 加入、离开时更新此表。由合并者维护。

| Agent 名称 | 工作区路径 | 当前分支 | 状态 | 加入日期 | 备注 |
|---|---|---|---|---|---|
| merger（主 agent） | `workspaces/merger` | `main` | active | 2026-10-13 | 合并者，唯一 main 写者 |

## 新增 agent 步骤

```powershell
git clone E:\Projects\IsSheepBox\repo.git E:\Projects\IsSheepBox\workspaces\<agent-name>
```

1. 在上述表格中登记。
2. 新 agent 开工前通读 `README.md`、`AGENTS.md`、`docs/` 全部文档。
3. agent 分支命名见 `docs/conventions.md`。
