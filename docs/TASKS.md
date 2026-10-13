# 任务清单（TASKS）

> 任务状态的唯一权威。由合并者（主 agent）维护：登记、合并后更新。

格式：

```
### TASK-XXX：<任务标题>
- 状态：待派发 | 开发中 | 待合并 | 已完成 | 已取消
- 负责 agent：
- 分支：
- 需求描述：
- 验收标准：
- 依赖：
- 完成时间：
```

---

## MVP 任务（来源：docs/requirements.md）

### TASK-001：工程脚手架（monorepo + TS + Electron）
- 状态：待派发
- 负责 agent：待定
- 分支：待定
- 需求描述：初始化 monorepo 工程：`packages/kernel`（自研内核）、`packages/shell-default`（最小默认壳插件）、`packages/market-client`（市场客户端）、`packages/plugins/*`（示例插件）、`apps/desktop`（Electron 宿主入口）。TypeScript 严格模式，统一构建脚本（pnpm workspace 或等价方案），Electron 应用可启动空窗口。
- 验收标准：`npm run dev`（或等价）能启动 Electron 空窗口；各 package 可独立构建；lint/typecheck 通过；CI 脚本占位（lint + typecheck）。
- 依赖：无
- 完成时间：

### TASK-002：内核·插件加载器与 ctx API v1
- 状态：待派发
- 负责 agent：待定
- 分支：待定
- 需求描述：实现插件加载器：扫描本地插件目录、解析 `plugin.json`（按 docs/requirements.md 第 5 节字段）、加载入口代码。定义并实现 `ctx` API v1（内核暴露给插件的服务接口，含注册服务、发布/订阅事件的最小集合）。输出 ctx API v1 的类型定义文件作为契约。
- 验收标准：能扫描目录并加载合法插件；缺字段/格式错误的 manifest 报错且不影响其他插件；ctx v1 类型定义文档化。
- 依赖：TASK-001
- 完成时间：

### TASK-003：内核·生命周期 + services/events + 可逆 effects
- 状态：待派发
- 负责 agent：待定
- 分支：待定
- 需求描述：实现插件生命周期（mount/init/start/stop/unmount）与可逆 effects：插件注册的服务、事件监听在其卸载时自动回滚清理；services 注册表与类型化事件总线；插件间通过 services/events 协作，不直接引用。
- 验收标准：卸载插件后无残留注册（服务/监听全部清理）；服务可被其他插件消费；事件可跨插件收发；提供生命周期钩子文档。
- 依赖：TASK-002
- 完成时间：

### TASK-004：内核·profile 配置引擎
- 状态：待派发
- 负责 agent：待定
- 分支：待定
- 需求描述：实现 profile：命名组合（启用的插件 ID 列表 + 每插件配置）的持久化、加载、切换；运行时启停插件并热重载（HMR）；启动时按 profile 加载壳插件，失败/缺失则回退到内置最小默认壳（安全模式）；升级/变更前自动快照。
- 验收标准：创建/保存/切换多个 profile 均生效；勾选启停即时生效；壳加载失败自动回退默认壳；快照可恢复。
- 依赖：TASK-003
- 完成时间：

### TASK-005：内核·兼容性校验与失败隔离
- 状态：待派发
- 负责 agent：待定
- 分支：待定
- 需求描述：实现兼容性校验：插件 manifest 的 `apiVersion` 与当前 ctx API 版本比对（SemVer 范围），不匹配拒绝加载并提示用户；单插件加载失败不影响其他插件（失败隔离）；校验策略文档化。
- 验收标准：`apiVersion` 不匹配的插件被拒绝且其他插件正常；拒绝原因可读；提供校验规则的单元测试。
- 依赖：TASK-002
- 完成时间：

### TASK-006：壳插件·最小默认壳
- 状态：待派发
- 负责 agent：待定
- 分支：待定
- 需求描述：实现最小默认壳（第一方、不可卸载 fallback）：主界面（导航栏 + 工具箱网格 + 插件管理页 + 设置页）；提供容器 seam（面板/入口注册 API）；插件启停开关；展示各插件状态。
- 验收标准：默认壳可启动并渲染；工具插件可通过 seam 注册入口并在网格显示；启停开关实时生效；壳本身是可替换的插件（结构上验证）。
- 依赖：TASK-004
- 完成时间：

### TASK-007：市场客户端（GitHub registry）
- 状态：待派发
- 负责 agent：待定
- 分支：待定
- 需求描述：实现市场客户端：拉取 registry（`plugins.json`，registry URL 可配置）、展示插件列表（名称/描述/作者/版本）、从 GitHub Releases 下载 zip、解压到本地插件目录、按 manifest 注册；支持安装/卸载/更新；GitHub 不可用时走本地缓存与手动导入。
- 验收标准：能安装/卸载/更新一个真实示例插件；版本对比正确；网络失败有缓存兜底；registry URL 可配置。
- 依赖：TASK-004
- 完成时间：

### TASK-008：权限声明与安装授权
- 状态：待派发
- 负责 agent：待定
- 分支：待定
- 需求描述：实现权限插件（approval policy）：解析 manifest 的 `permissions` 字段；安装/启用时向用户展示权限清单并可拒绝；拒绝后插件不可启用；权限声明的最小集合（`files:read/write`、`network:fetch`、`clipboard:read/write`、`shell:exec`）。
- 验收标准：安装流程展示权限清单；用户拒绝后插件无法启用；权限在 manifest 缺省时按空权限处理。
- 依赖：TASK-003
- 完成时间：

### TASK-009：示例插件 ×3（验证规范）
- 状态：待派发
- 负责 agent：待定
- 分支：待定
- 需求描述：开发三个示例插件验证规范 v1：①纯 UI 面板插件（如便签）；②带权限插件（如文件文本统计，需 `files:read`）；③带服务插件（提供服务被其他插件消费，如主题服务）。三个插件均含完整 manifest 与可运行代码。
- 验收标准：三个插件均可被内核加载、勾选启用、正常使用、卸载无残留；示范三种典型形态；代码可作第三方插件模板。
- 依赖：TASK-006、TASK-008
- 完成时间：

### TASK-010：插件规范 v1 文档 + registry 仓库初始化
- 状态：待派发
- 负责 agent：待定
- 分支：待定
- 需求描述：输出插件规范 v1 正式文档（manifest 全字段、目录结构、发布要求、校验规则、示例）；定义 `plugins.json`（registry index）格式；初始化 GitHub registry 仓库（含 README 与首个示例条目）。
- 验收标准：规范文档可指导第三方独立开发插件；plugins.json 格式有 schema 或文档；registry 仓库就绪。
- 依赖：TASK-009
- 完成时间：

### TASK-011：Electron 打包与发布
- 状态：待派发
- 负责 agent：待定
- 分支：待定
- 需求描述：配置 Electron 打包（Windows 安装包优先），内置最小默认壳与第一方基础设施插件；升级/启动失败回退机制；发布说明与版本策略（内核/插件 API SemVer）。
- 验收标准：打包产物可安装并正常启动；默认壳可用；升级路径验证（旧 profile 快照回滚）。
- 依赖：TASK-006、TASK-007
- 完成时间：

---

## 状态说明

- **待派发**：已登记，等待需求方选择执行 agent。
- **开发中**：执行 agent 已在分支上工作。
- **待合并**：分支已推送，等待合并者审查。
- **已完成**：已合并进 main 并验证。
