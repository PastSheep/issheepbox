# 工作流（Workflow）

本文档描述 Is Sheep Box 项目的完整协作工作流。它是协作状态的权威描述，任何参与方（豆包子 agent、外部 agent、人类）都以本文档为准，不依赖任何平台的记忆系统。

## 1. 角色定义

| 角色 | 承担者 | 职责 |
|---|---|---|
| **需求方** | 用户 | 提出需求、确认方向；**选择并接入执行 agent**；做最终决策 |
| **主 agent（合并者）** | 本会话 | 与需求方头脑风暴、确认并拆解需求；收到完成汇报后**派发合并子 agent** 执行审查与合并；向需求方汇报结果；不亲自深入阅读分支内容，保持上下文精简 |
| **合并子 agent** | 主 agent 按需派发 | 按 `docs/merge-policy.md` 执行审查、解决冲突、合并进 main、更新 TASKS.md、清理分支 |
| **执行 agent** | 需求方选择接入 | 在各自独立工作区执行开发/审查任务，推送自己的分支，不碰 main |

> **派发边界**：主 agent（合并者）**不派发开发任务**。开发任务由需求方选择的执行 agent 完成——执行 agent 可能来自豆包之外，主 agent 无法直接派发。主 agent 仅在收到完成汇报后派发**合并子 agent** 执行合并流程；主 agent 自身不逐文件审查，以精简上下文。

## 2. 任务生命周期

一个任务从提出到落地，走以下闭环：

```
① 需求头脑风暴与确认
   └─ 主 agent 与需求方对话，明确：做什么、验收标准、涉及范围
② 任务登记
   └─ 在 docs/TASKS.md 中登记任务（编号、描述、验收标准、状态）
③ 领取与开发准备
   └─ 需求方选择执行 agent 并接入（可能为豆包或外部平台）；agent 通读文档、拉取 main 最新状态
④ 独立开发
   └─ agent 在自己的工作区创建分支 <agent-name>/<任务标识>，并行开发
   └─ 允许不同 agent 同时修改同一文件，冲突不阻塞开发
⑤ 推送分支
   └─ agent 完成开发，推送分支到中央仓库，并告知合并者
⑥ 审查与合并
   └─ 需求方将执行 agent 的完成汇报转交主 agent；主 agent 派发合并子 agent
   └─ 合并子 agent 按 docs/merge-policy.md 审查、解决冲突、合并进 main、更新 TASKS.md、清理分支
   └─ 合并子 agent 向主 agent 汇报结果，主 agent 转达需求方
⑦ 下一轮派发
   └─ 下一次启用 agent 时，任务 prompt 中必须包含「拉取最新 main」步骤：
      复用已存在 agent → 显式 git fetch + git pull origin main；
      新启用 agent → clone 即天然最新
   └─ 合并后不做全局广播，避免噪音
```

## 3. 状态管理（仓库即记忆）

- **任务状态**：`docs/TASKS.md` 是任务清单的唯一权威，合并子 agent 按 merge-policy 在每次合并后更新它。
- **agent 清单**：`docs/AGENTS.md`（仓库内副本）或 `docs/agents-registry.md` 记录当前活跃 agent 与各自工作区/分支。
- **分支状态**：以中央仓库 `repo.git` 的实际分支为准，无需额外维护。
- 任何 agent 需要了解项目现状时，先读 `docs/` 目录与 `git branch -r`，不要依赖对话历史。

## 4. 新增 agent 流程

当需要增加一个并行工作的 agent（数量不固定，随开发动态新增）：

1. 在 `workspaces/` 下创建独立工作区：
   ```powershell
   git clone E:\Projects\IsSheepBox\repo.git E:\Projects\IsSheepBox\workspaces\<agent-name>
   ```
2. 在 `docs/agents-registry.md` 登记：agent 名称、工作区路径、当前分支。
3. agent 首次开工前通读 `README.md`、`AGENTS.md` 与 `docs/` 下全部文档。
4. 无需任何平台方批准即可加入；离开时在登记表中标记 inactive，分支由合并者归档。

## 5. 多 agent 同时修改同一文件

这是本工作流的**设计特性**而非异常：

- agent 之间不需要预先协调文件归属，各自基于自己的分支修改。
- 合并子 agent 负责合并并解决冲突；解决冲突时以提交信息中的「为什么改」为依据判断保留哪边，必要时与相关 agent 沟通。
- 若某文件被高频改动导致反复冲突，合并子 agent 可在文档中登记「热点文件」并建议 agent 错峰修改。
