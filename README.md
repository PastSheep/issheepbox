# Is Sheep Box

多 agent 协作开发的插件化桌面工具箱。本项目使用 Git 进行项目管理，支持多个 agent（无论是否来自同一平台）在独立工作区中并行开发，由专职合并者统一审查与合并。

## 仓库结构

```
repo.git/                中央裸仓库（唯一事实源，只存 Git 对象，不要直接改）
workspaces/
  ├── merger/            合并者工作区（唯一允许写 main 的角色）
  ├── <agent-name>/      每个 agent 一个独立 clone（随开发动态新增）
  └── ...
docs/                    工作流与规范文档（唯一权威，详见下节）
```

## 工程结构（TASK-001 起）

monorepo（pnpm workspace + TypeScript strict + Electron）：

```
apps/
  desktop/               Electron 宿主入口（主进程 + 空窗口）
packages/
  kernel/                自研极薄内核（加载器/生命周期/services+events/依赖/profile 占位骨架）
  shell-default/         最小默认壳插件（第一方 fallback，TASK-006）
  market-client/          插件市场客户端（TASK-007）
  plugins/               第三方/官方示例插件落地目录（TASK-009 入住）
```

## 启动与构建

前置：Node ≥ 20、pnpm ≥ 10（仓库根 `package.json` 声明了 `packageManager`）。

```powershell
# 安装依赖（首次）
pnpm install

# 开发模式：编译后启动 Electron 空窗口
pnpm dev

# 全量构建（按 project references 顺序编译所有 package）
pnpm build

# 类型检查
pnpm typecheck

# Lint
pnpm lint

# 打包 Windows 安装包（NSIS，产物在 release/）
pnpm --filter @issheepbox/desktop run pack
```

> `pnpm dev` 当前只打开一个空窗口并打印内核 apiVersion；
> 真正的插件加载与壳渲染由 TASK-002 起逐步接入。

## 文档入口（开工前必读）

| 文档 | 内容 |
|---|---|
| `AGENTS.md` | 所有 agent 的硬性规则，开工前必须读完 |
| `docs/requirements.md` | 产品需求与架构设计（头脑风暴结论的唯一权威） |
| `docs/workflow.md` | 完整工作流：角色、任务生命周期、新增 agent 流程 |
| `docs/conventions.md` | 分支命名、提交信息、工作区约定 |
| `docs/merge-policy.md` | 合并与审查流程、冲突解决原则、main 保护规则 |
| `docs/version-policy.md` | SemVer 演进规则与发布流程（TASK-011） |
| `docs/TASKS.md` | 任务清单与状态 |

## 重要原则

**仓库即记忆**：本仓库内的文档与 Git 分支是协作状态的唯一权威来源。任何 agent 不依赖会话对话记忆、不依赖某个平台的记忆系统；状态、规则、进度都以仓库中可见的文档与分支为准。

**职责边界**：需求由需求方（用户）提出并选择执行 agent；主 agent（本会话）负责需求头脑风暴确认，收到完成汇报后**派发合并子 agent** 执行审查与合并（唯一 main 写者权限由合并子 agent 代为执行），主 agent 不亲自逐文件审查以精简上下文。**不派发开发任务**。详见 `docs/workflow.md` 与 `docs/merge-policy.md`。
