# Agent 登记表（agents registry）

> 记录当前活跃的 agent 与工作区。**仓库即记忆**：新 agent 加入、离开时更新此表。由合并者维护。

| Agent 名称 | 工作区路径 | 当前分支 | 状态 | 加入日期 | 提交身份（user.name） | 备注 |
|---|---|---|---|---|---|---|
| merger（主 agent） | `workspaces/merger` | `main` | active | 2026-10-13 | `DESKTOP-G5FAQR9-DouBao` | 合并者，唯一 main 写者 |
| agent-kernel | `workspaces/agent-kernel` | 待创建 | active | 2026-10-13 | —（历史批次） | TASK-001 脚手架；后续承包内核主线 TASK-002~005 |
| agent-spec | `workspaces/agent-spec` | 待创建 | active | 2026-10-13 | —（历史批次） | TASK-010 插件规范 v1 草案 |
| agent-permission | `workspaces/agent-permission` | `agent-permission/feat-permission` | active | 2026-10-13 | —（历史批次） | TASK-008 权限声明与安装授权（approval policy） |

> **提交身份约定**（自 2026-10-15 起，见 `docs/merge-policy.md` §0.5）：所有 git 提交使用 `user.name = <主机名>-<Agent 标识>`（如主 agent 提交 = `DESKTOP-G5FAQR9-DouBao`）；sub-agents 由创建者指定各自标识，登记时更新本表。

## 新增 agent 步骤

执行 agent 由**需求方选择并接入**（可能为豆包或外部平台 agent，主 agent 不派发开发任务）。接入流程：

```powershell
git clone E:\Projects\IsSheepBox\repo.git E:\Projects\IsSheepBox\workspaces\<agent-name>
```

1. 在上述表格中登记（可由需求方或该 agent 自行登记）。
2. 新 agent 开工前通读 `README.md`、`AGENTS.md`、`docs/` 全部文档。
3. agent 分支命名见 `docs/conventions.md`。
