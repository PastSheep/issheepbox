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
- 状态：已完成
- 负责 agent：agent-kernel
- 分支：agent-kernel/feat-scaffold
- 需求描述：初始化 monorepo 工程：`packages/kernel`（自研内核）、`packages/shell-default`（最小默认壳插件）、`packages/market-client`（市场客户端）、`packages/plugins/*`（示例插件）、`apps/desktop`（Electron 宿主入口）。TypeScript 严格模式，统一构建脚本（pnpm workspace 或等价方案），Electron 应用可启动空窗口。
- 验收标准：`npm run dev`（或等价）能启动 Electron 空窗口；各 package 可独立构建；lint/typecheck 通过；CI 脚本占位（lint + typecheck）。
- 依赖：无
- 完成时间：2026-10-13
- **合并记录（merger）**：2026-10-13 审查通过并合并（merge `24d9688`），远端分支已删除。
- **待办（CI 后续）**：CI 流水线当前仅跑 typecheck+lint，build/test/electron-packager 步骤待后续任务追加。

### TASK-002：内核·插件加载器与 ctx API v1
- 状态：已完成
- 负责 agent：agent-kernel
- 分支：agent-kernel/feat-kernel-loader
- 需求描述：实现插件加载器：扫描本地插件目录、解析 `plugin.json`（按 docs/requirements.md 第 5 节字段）、加载入口代码。定义并实现 `ctx` API v1（内核暴露给插件的服务接口，含注册服务、发布/订阅事件的最小集合）。输出 ctx API v1 的类型定义文件作为契约。
- 验收标准：能扫描目录并加载合法插件；缺字段/格式错误的 manifest 报错且不影响其他插件；ctx v1 类型定义文档化。
- 依赖：TASK-001
- 完成时间：2026-10-13
- **合并记录（merger）**：2026-10-13 审查通过并合并（merge `fcf2c2e`），远端分支已删除。
- **待办**：① 插件工厂调用（mount/生命周期）→ TASK-003；② apiVersion SemVer range 比对（manifest 校验 #5）→ TASK-005；③ 文档清理：docs/plugin-spec-v1.md 文末「下一步」清单首条（「TASK-002 完成后，补充第 4.2 节 ctx API 完整方法签名与类型定义链接」）为过时 TODO，待后续清理。

### TASK-003：内核·生命周期 + services/events + 可逆 effects
- 状态：已完成
- 负责 agent：agent-kernel
- 分支：agent-kernel/feat-kernel-lifecycle
- 需求描述：实现插件生命周期（mount/init/start/stop/unmount）与可逆 effects：插件注册的服务、事件监听在其卸载时自动回滚清理；services 注册表与类型化事件总线；插件间通过 services/events 协作，不直接引用。
- 验收标准：卸载插件后无残留注册（服务/监听全部清理）；服务可被其他插件消费；事件可跨插件收发；提供生命周期钩子文档。
- 依赖：TASK-002
- 完成时间：2026-10-13
- **合并记录（merger）**：2026-10-13 审查通过并合并（merge `fa82b0a`），远端分支已删除。
- **边界标注**：本任务不实现 TASK-004 profile 配置引擎 / TASK-005 apiVersion 比对 / TASK-002 依赖拓扑排序。

### TASK-004：内核·profile 配置引擎
- 状态：已完成
- 负责 agent：agent-kernel
- 分支：agent-kernel/feat-kernel-profile
- 需求描述：实现 profile：命名组合（启用的插件 ID 列表 + 每插件配置）的持久化、加载、切换；运行时启停插件并热重载（HMR）；启动时按 profile 加载壳插件，失败/缺失则回退到内置最小默认壳（安全模式）；升级/变更前自动快照。
- 验收标准：创建/保存/切换多个 profile 均生效；勾选启停即时生效；壳加载失败自动回退默认壳；快照可恢复。
- 依赖：TASK-003
- 完成时间：2026-10-13
- **合并记录（merger）**：2026-10-13 审查通过并合并（merge `a72f09f`），远端分支已删除。功能复跑验收 25 项全部通过（临时目录造 org.example.tool 插件驱动内核：start 发现插件、无壳时 safeMode=true 且 activeShell=DEFAULT_SHELL_ID 并 emit app:safe-mode、enable/disable 即时 mount/unmount 且 effects 回滚、create+switchTo 切换生效且 current.json 指针持久化、变更前自动快照、restore 恢复 enabled 并重新挂载）。
- **边界标注**：默认壳 UI 本体留 TASK-006（本任务只交付 safeMode fallback 机制 + DEFAULT_SHELL_ID 占位）；实际权限校验留 TASK-008（本任务只定义 PermissionStore 接口 + PermissivePermissionStore 全量放行占位）。

### TASK-005：内核·兼容性校验与失败隔离
- 状态：已完成
- 负责 agent：agent-compat
- 分支：agent-compat/feat-kernel-compat
- 需求描述：实现兼容性校验：插件 manifest 的 `apiVersion` 与当前 ctx API 版本比对（SemVer 范围），不匹配拒绝加载并提示用户；单插件加载失败不影响其他插件（失败隔离）；校验策略文档化。
- 验收标准：`apiVersion` 不匹配的插件被拒绝且其他插件正常；拒绝原因可读；提供校验规则的单元测试。
- 依赖：TASK-002
- 完成时间：2026-10-13
- **合并记录（merger）**：2026-10-13 审查通过并合并（merge `2353960`），远端分支已删除。

### TASK-006：壳插件·最小默认壳
- 状态：已完成
- 负责 agent：agent-kernel
- 分支：agent-kernel/feat-shell-default
- 需求描述：实现最小默认壳（第一方、不可卸载 fallback）：主界面（导航栏 + 工具箱网格 + 插件管理页 + 设置页）；提供容器 seam（面板/入口注册 API）；插件启停开关；展示各插件状态。
- 验收标准：默认壳可启动并渲染；工具插件可通过 seam 注册入口并在网格显示；启停开关实时生效；壳本身是可替换的插件（结构上验证）。
- 依赖：TASK-004
- 完成时间：2026-10-13
- **合并记录（merger）**：2026-10-13 审查通过并合并（merge `6ec2816`），远端分支已删除。功能复跑验收（Node 直连内核双场景）：有壳场景 discovered=[approval-policy, shell-default]、safeMode=false、activeShell=org.issheepbox.shell-default、shell:ui service 已注册、app:profile-changed/app:profile-restored 均转发为 shell:ui-refresh（含 shell-mounted 初始信号）；无壳场景 safeMode=true 且 app:safe-mode 触发（reason=壳插件未加载，回退默认壳）；typecheck/lint exit 0。
- **边界标注**（任务方声明，合并者登记）：① 未在真实 Electron 窗口人工验证 UI 渲染（无图形环境，IPC 经 Node 侧事件流验证）；② pluginsDir 开发态硬编码指向 monorepo packages/，生产态改 userData/plugins 留打包任务（TASK-011）；③ shell:ui.registerPanel 仅记录面板列表，未实现实际挂载区域。

### TASK-007：市场客户端（GitHub registry）
- 状态：已完成
- 负责 agent：agent-market
- 分支：agent-market/feat-market-client
- 需求描述：实现市场客户端：拉取 registry（`plugins.json`，registry URL 可配置）、展示插件列表（名称/描述/作者/版本）、从 GitHub Releases 下载 zip、解压到本地插件目录、按 manifest 注册；支持安装/卸载/更新；GitHub 不可用时走本地缓存与手动导入。
- 验收标准：能安装/卸载/更新一个真实示例插件；版本对比正确；网络失败有缓存兜底；registry URL 可配置。
- 依赖：TASK-004
- 完成时间：2026-10-13
- **合并记录（merger）**：2026-10-13 审查通过并合并（merge `5ade5b9`），远端分支已删除。功能复跑验收：verify:fixture 46/46 断言通过（fixture 12 条：4 合法 + 8 非法；覆盖顶层/单条/重复 id 分层容错、list 九类过滤、compareVersions SemVer 语义、占位接口抛错）；typecheck/lint exit 0。交付范围：registry 类型族 + 容错解析 parseRegistryIndex（永不抛异常）+ compareVersions/parseSemver 纯函数 + MarketClient（fetchIndex/list/getById/invalidEntries/topLevelErrors）。
- **边界标注**（任务方声明，合并者登记）：① 未改 pnpm-workspace.yaml（P-002 已由 TASK-008 落库 esbuild:true，本任务 pull 到 58003b4 后 pnpm install/typecheck 实测可用，P-002 保持销项）；② id 校验接受连字符，与 schema pattern 冲突 → 登记 P-003 后续修订；③ download/install/uninstall/update 为 Promise<never> 占位，依赖 registry 仓库落地与 TASK-011 打包；④ 未跑 CI（合并后由流水线执行）；⑤ DEFAULT_REGISTRY_URL 为占位常量（REPLACE_ORG/REPLACE_REPO），待需求方提供 GitHub 组织/仓库名（与 TASK-010 遗留的 registry 初始化待办相关）。
- **registry URL 落库**：574fe54 已合并（merge `336e004`），DEFAULT_REGISTRY_URL 由占位替换为 `https://raw.githubusercontent.com/PastSheep/issheepbox-registry/main/plugins.json`；合并者复验：该 URL 实测 HTTP 200，正文 registryVersion=1.0.0/plugins=[]，经 market-client dist 的 parseRegistryIndex 解析无顶层错误（边界⑤的占位状态自此解除）。

### TASK-008：权限声明与安装授权
- 状态：已完成
- 负责 agent：agent-permission
- 分支：agent-permission/feat-permission
- 需求描述：实现权限插件（approval policy）：解析 manifest 的 `permissions` 字段；安装/启用时向用户展示权限清单并可拒绝；拒绝后插件不可启用；权限声明的最小集合（`files:read/write`、`network:fetch`、`clipboard:read/write`、`shell:exec`）。
- 验收标准：安装流程展示权限清单；用户拒绝后插件无法启用；权限在 manifest 缺省时按空权限处理。
- 依赖：TASK-003
- 完成时间：2026-10-13
- **合并记录（merger）**：2026-10-13 审查通过并合并（merge `6df5536`），远端分支已删除。功能复跑验收：approval-policy 单测 32/32 通过（permissions 归一化 12 + ApprovalPolicy 引擎 14 + 经内核 LifecycleManager 挂载的集成测试 6），kernel 回归 35/35 通过；typecheck/lint exit 0。授权语义核对通过：denied 记录持久化且不重复弹窗、revoke() 后可重新申请（无功能死锁）、manifest 缺省 permissions 按空权限自动通过、未知权限 fail-safe 不授予并记日志告警、FailSafePrompter 无授权 UI 时默认拒绝无静默放行路径、approval:requested/granted/denied 事件契约齐全。
- **边界标注**：权限目录 v1 为粗粒度字符串 ID（后续版本可细化为 `network:fetch:https://...`）；MemoryApprovalStore 为内存最小实现，跨重启持久化待 profile 引擎（TASK-004 方向）集成时注入持久化 ApprovalStore；授权 UI 由壳（TASK-006）注入 ApprovalPrompter，壳接入前 FailSafePrompter 对带权限插件默认拒绝。

### TASK-009：示例插件 ×3（验证规范）
- 状态：已完成
- 负责 agent：agent-examples
- 分支：agent-examples/feat-plugins-examples
- 需求描述：开发三个示例插件验证规范 v1：①纯 UI 面板插件（如便签）；②带权限插件（如文件文本统计，需 `files:read`）；③带服务插件（提供服务被其他插件消费，如主题服务）。三个插件均含完整 manifest 与可运行代码。
- 验收标准：三个插件均可被内核加载、勾选启用、正常使用、卸载无残留；示范三种典型形态；代码可作第三方插件模板。
- 依赖：TASK-006、TASK-008
- 完成时间：2026-10-14
- **交付（agent-examples）**：
  - `packages/plugins/note`（纯 UI 面板，无权限）、`packages/plugins/file-stats`（files:read 权限）、`packages/plugins/theme-service`（theme 服务 + theme:changed 事件）；验证脚本 `packages/plugins/verify-examples.cjs`；规范反馈修订 docs/plugin-spec-v1.md（附录 F-001~F-010）。
- **合并记录（merger）**：2026-10-14 审查通过并合并（merge `dfbcde1`，分支 tip `443c3ac`，基于 4aa191d 落后 main 3 提交，无并行开发分支故直接并入），远端分支已删除。
  - 审查结论：5 提交信息符合 conventions（3×feat(plugins) / 1×test(plugins) / 1×docs，正文写明改了什么/为什么）；diff 范围 20 文件 +1090 行与任务一致；无密钥/本机路径（仅注释中出现"token 数"一词）；无 dist/node_modules/二进制产物入库。
  - 冲突处理：docs/TASKS.md P 编号撞车——main 的 P-004（TASK-011 内置插件 version 钉死）保留原样，分支登记的 P-004~P-008 整体顺延为 P-005~P-009（顺序不变、双方内容逐字保留），执行汇报块内引用同步顺延（原 P-006 shell:ui 面板缺口 → 现 P-007）；pnpm-lock.yaml 自动合并后经 `pnpm install` 验证（exit 0，lockfile 同时含 3 个新 importer 与 electron-builder/electron-winstaller 条目，allowBuilds 已有 TASK-011 修复的 electron-winstaller: true）。
  - 合并后复跑验证：`pnpm install` exit 0；`pnpm run typecheck` exit 0；`pnpm run lint` exit 0；`node packages/plugins/verify-examples.cjs` exit 0——47 项断言 × 5 场景全部通过（A 内核发现/enable/使用/unmount 无残留、B 权限拒绝路径、C 授权路径、D FailSafePrompter 默认拒绝、E 未授权强制挂载 fail-safe）。
  - F-001~F-010 审查结论：逐条核对与 kernel / shell-default / approval-policy 实际实现一致——F-001（note 仅用 v1 已交付 ctx.manifest/apiVersion/logger/events/services，无 ctx.commands/panels/storage）✓；F-002（shell:ui 与 approval-policy 服务真实存在，验证脚本对真实服务跑通）✓；F-003（§3.2 id 正则已对齐连字符，与 kernel manifest.ts ID_RE 一致）✓；F-004（dependency/ 确为占位骨架，resolveOrder 抛「未实现」）✓；F-005（start/stop 标注为设计目标，注释属实）✓；F-006（shell-default registerPanel 仅 push 无 unregister、无回滚）✓；F-007（profile/index.ts 确为 `void opts.permissions` 占位）✓；F-008（内核/壳无 files 宿主服务，file-stats 走文本传入沙箱模式）✓；F-010（lifecycle 注入 `apiVersion: '1.0'` 而 CURRENT_API_VERSION='1.0.0'）✓。未发现反馈与实现不符或文档内部矛盾。
  - P-003 去留结论：保留待处理——分支仅修订 docs/plugin-spec-v1.md，docs/plugin-registry-schema.md 的 id pattern（不含连字符）未动，registry 机器校验流程仍待对齐回归。
  - 备注：verify-examples.cjs 文件头含 `/* eslint-disable @typescript-eslint/no-require-imports */` 及理由说明（该规则针对插件运行时沙箱，测试台需 require 构建产物），判定合理；脚本注释中「P-006」字样为顺延前旧编号引用，按边界不改 packages/** 代码，留待后续任务顺带修订。

### TASK-010：插件规范 v1 文档 + registry 仓库初始化
- 状态：已完成
- 负责 agent：agent-spec
- 分支：agent-spec/docs-plugin-spec-v1
- 需求描述：输出插件规范 v1 正式文档（manifest 全字段、目录结构、发布要求、校验规则、示例）；定义 `plugins.json`（registry index）格式；初始化 GitHub registry 仓库（含 README 与首个示例条目）。**规范先行**：草案先行定稿，manifest 字段与 TASK-002 的 ctx API v1 对齐（未完成时先按草案写、后续修订）；TASK-009 示例插件实现时验证规范并反馈修订。若需求方尚未提供 GitHub 仓库信息，先交付规范文档与格式定义，仓库初始化待信息就绪。
- 验收标准：规范文档可指导第三方独立开发插件；plugins.json 格式有 schema 或文档；registry 仓库就绪（或已明确待办）。
- 依赖：无（规范先行；TASK-009 负责验证反馈）
- 完成时间：2026-10-13
- **本次交付（agent-spec）**：
  - `docs/plugin-spec-v1.md`：插件规范 v1 正式文档，含 manifest 全字段、目录结构、生命周期、容器 seam、权限、依赖协作、构建打包、校验规则、完整便签插件示例。ctx API 方法签名部分标注「待对齐 TASK-002」。
  - `docs/plugin-registry-schema.md`：`plugins.json` registry index 格式定义，含完整字段文档、JSON Schema、示例条目、维护流程。
- **合并记录（merger）**：2026-10-13 审查通过并合并（merge `ab96dac`），远端分支已删除。
- **待办（registry 仓库初始化）**：✅ 已销项（2026-10-13）。registry 仓库已初始化：`https://github.com/PastSheep/issheepbox-registry`（含 README、空 `plugins.json`（registryVersion=1.0.0/plugins=[]）、`schemas/plugins.schema.json`），raw 地址实测 HTTP 200；market-client `DEFAULT_REGISTRY_URL` 已落库为真实地址（见 TASK-007 条目 registry URL 落库记录）。

### TASK-011：Electron 打包与发布
- 状态：已完成
- 负责 agent：agent-kernel
- 分支：agent-kernel/feat-packaging
- 需求描述：配置 Electron 打包（Windows 安装包优先），内置最小默认壳与第一方基础设施插件；升级/启动失败回退机制；发布说明与版本策略（内核/插件 API SemVer）。
- 验收标准：打包产物可安装并正常启动；默认壳可用；升级路径验证（旧 profile 快照回滚）。
- 依赖：TASK-006、TASK-007
- 完成时间：2026-10-13
- **合并记录（merger）**：2026-10-13 审查通过并合并（merge `8823333`，来源提交 `91b31e4`），远端分支已删除。合并后复验：`pnpm install` exit 0、全工作区 `pnpm run typecheck` exit 0（与干净 main 基线一致）、`pnpm --filter @issheepbox/desktop run build` exit 0、`eslint apps/desktop` exit 0。合并后追加修复提交 `7296544`（见下）。
- **合并后修复（merger）**：`7296544` chore(desktop)：lockfile 引入 electron-builder 但未在 pnpm-workspace.yaml allowBuilds 声明其传递依赖 electron-winstaller，导致 `pnpm install` 以 ERR_PNPM_IGNORED_BUILDS exit 1（CI release.yml 的 frozen-lockfile 安装同样会失败）；审批后 exit 0。处理方式沿用 P-002（esbuild）先例。
- **基线核查结论（pre-existing typecheck 故障）**：任务方提交信息称「approval-policy 包存在 tsc 编译错误（找不到 @issheepbox/kernel）」。parent 已在干净 main（6c131a1）独立复跑全工作区 typecheck：exit 0、零错误（clean 后全量重建 3 次均 0），该错误无法复现。引入提交 4161a6d（TASK-008）接线完整（workspace 依赖 + tsconfig references + 根 tsconfig 挂接齐全）；错误仅能在单包非 build 模式（`npx tsc --noEmit -p packages/approval-policy`，kernel/dist 不存在 → TS2307）下复现，属任务方环境/用法问题。建议流程要求：typecheck 一律在 install 成功后从根目录 `pnpm run typecheck`，禁止裸跑单包 tsc。
- **边界标注**（任务方声明 + 合并者登记）：
  ① 本机未实际出包（无图形环境，未跑 electron-builder --win），CI release job 首次 tag 触发时验证打包链路；
  ② 未配置代码签名，Windows SmartScreen 警告留后续任务；
  ③ extraResources / directories.output 相对路径基准为 apps/desktop 目录：pack 脚本靠 `pnpm --filter @issheepbox/desktop run pack` 保证 cwd=apps/desktop 运行（CI 与本地均如此，release/ 落仓库根、与 release.yml 上传路径一致）；若从仓库根直接调 electron-builder 会错位；
  ④ pre-existing typecheck 故障：经基线核查被驳回（见上条）；
  ⑤ apps/desktop/src/main.ts 开发态 pluginsDir 经 `__dirname` 相对定位 monorepo packages/（无硬编码绝对路径，比任务方原声明边界更干净），生产态用 userData/plugins。

---

## v0.2.0（插件生态闭环）任务

> 批次契约（跨任务接线，由合并者 2026-10-15 登记，执行 agent 必须遵守）：
> - **C1 授权 UI 契约（013 shell ↔ 012 desktop ↔ 015 approval-policy）**：shell-default 注册服务 `approval-ui`（形状 = approval-policy 的 `ApprovalPrompter`：`prompt(request): Promise<ApprovalPromptResult>`）；实现经内核事件往返——发 `approval:ui-request`（载荷 `{ token, pluginId, pluginName, permissions: PermissionInfo[] }`）→ desktop 主进程桥接渲染进程弹权限清单对话框（全部/部分/拒绝）→ 以 `approval:ui-response`（`{ token, result: ApprovalPromptResult }`）回内核事件；超时 fail-safe 拒绝。approval-policy 挂载时：有 `approval-ui` 服务用之，否则 FailSafePrompter。权限中文名/用途/风险取自 approval-policy 权限目录（getPermissionInfo）。
> - **C2 启动门禁契约（013 kernel ↔ 015 approval-policy）**：ProfileEngine 启动恢复路径（boot/restore/switchTo）对声明权限插件调用 `requestApprovalForManifest(manifest, source='boot'|'restore'|'switchTo')`，未授权不挂载；approval-policy 对 source ∈ {boot, restore, switchTo} 仅查存储不弹窗（granted 记录→自动 granted；denied/无记录→denied）。其余来源（enable/install/缺省）维持现行为。
> - **C3 持久化接线（012 desktop ↔ 015 approval-policy）**：desktop 主进程在 kernel.start() 前注册宿主服务 `host:user-data`（`{ dir: string }`）；approval-policy 默认 store = 有 `host:user-data` 则 DiskApprovalStore(dir)，否则 MemoryApprovalStore。
> - **C4 面板渲染契约（014 shell ↔ 012 desktop）**：shell:ui 的 panels 元素形状 `{ id, title, pluginId?, src?, html?, width?, height? }`（向后兼容：旧 2 参 registerPanel 仍有效）；desktop 渲染进程右侧主区域按此渲染——html 直接注入、src 经新 IPC `shell:read-plugin-asset` 读插件包资源、无面板显示占位；pushUiState 从 shell:ui 服务读取 panels 随 UI 状态下发。
> - 合并顺序建议：012 与 015 可先合，013 尽量在 015 合并后合（避免启动路径弹窗的中间态），014 必须等 013 合并。

### TASK-012：市场安装链路（install/uninstall/update + desktop 最小市场入口）
- 状态：已完成
- 负责 agent：agent-market-install
- 分支：agent-market-install/feat-market-install
- 需求描述：
  - packages/market-client：落地 install/uninstall/update（现为 Promise<never> 占位）。install=下载 zip→完整性校验（zip 结构/plugin.json 可解析且顶层目录=插件 id）→解压到 pluginsDir（防路径穿越）；update=版本比对后替换；uninstall=移除目录。zip 约定：顶层目录=插件 id（含 plugin.json+package.json+dist+assets）。registry 4 个 downloadUrl 真实可下载（shell-default 0.1.0、note/file-stats/theme-service 1.0.0，v0.1.0 release 资产）。market-client 保持内核无关（不 import @issheepbox/kernel，TASK-007 边界），pluginsDir 经构造选项注入。
  - apps/desktop：① kernel.start() 前注册宿主服务 host:user-data（C3）；② 权限对话框桥（C1）：监听 approval:ui-request→转发渲染进程→回发 approval:ui-response；③ 渲染进程：市场视图（拉 registry active 插件列表、安装/卸载/更新按钮）+ 权限清单对话框（全部/部分/拒绝）+ 面板挂载区（C4，无面板显示占位）；④ 安装编排：市场安装→（经 kernel.profile.enable 走授权门禁：无权限直通、带权限弹权限清单）→挂载；拒绝则已安装但不可启用；卸载=停用+移除目录+profile 移除。
- 验收标准：端到端（干净 userData，Node 直连内核脚本复现）：安装 note→无权限直通→面板可渲染（内容元数据经 shell:ui 读取）；安装 file-stats→权限清单弹出（契约 C1 事件往返可测）；容错：网络失败/非法 zip/重复安装有明确错误且无半残留；desktop build/typecheck/lint 通过；kernel 63、approval-policy 32、verify-examples 49×5 回归全绿；新增针对性测试（install 容错等）。
- 依赖：TASK-007（market-client 骨架）、TASK-011（打包）
- 完成时间：2026-10-15
  - 合并记录（merger）：
    - 合并提交：3143007（merge --no-ff，基于 2e94ce8；分支 tip 89869ed，6 提交）。
    - 审查结论：6 提交信息符合 conventions（feat/test/docs/fix 类型与范围齐全，正文均写明改了什么/为什么改/影响范围）；diff 范围 13 文件 +1580/-60，全部位于 packages/market-client（src/install.ts 新增、src/index.ts、src/types.ts、scripts/verify-fixture.mjs、README、package.json +adm-zip）与 apps/desktop（src/main.ts、src/preload.ts、index.html、tsconfig/package.json、scripts/verify-market-e2e.cjs 新增）及 pnpm-lock.yaml；无 kernel/approval-policy/shell-default/packages/plugins 夹带；无密钥/本机路径；无 dist/node_modules/二进制入库。
    - 语义核对（TASK-012 + C1/C3/C4）：market-client——install=下载 zip→validatePluginZip（顶层唯一目录=插件 id、plugin.json 可解析且 id/version/entry 齐全、entry 文件在包内存在、拒绝绝对路径/盘符/.. 穿越条目）→解压（剥除 topDir 前缀，destDir 即包根，destDir/plugin.json 直接存在）→临时目录 rename 原子落盘，失败清理临时目录无半残留；uninstall=PLUGIN_ID_RE 正则 + resolve 路径守卫（basename===pluginId），只删合法 id 顶层目录；update=registry 版本>本地才下载，临时解压→现装改名备份→换入，换入失败回滚备份、成功后清备份；错误统一 MarketInstallError(code)（NETWORK/HTTP_STATUS/INVALID_ZIP/MANIFEST_INVALID/ID_MISMATCH/ALREADY_INSTALLED/NOT_INSTALLED/EXTRACT_FAILED/NOT_IN_REGISTRY/INVALID_PLUGIN_ID/PLUGINS_DIR_REQUIRED 共 11 类）；pluginsDir 经构造选项注入；install.ts 纯 node:fs，不 import kernel 运行时（PLUGIN_ID_RE 与 packages/kernel/src/manifest.ts ID_RE 逐字一致，头注释登记复制原因）。desktop——kernel.start() 前注册 host:user-data { dir }（C3）；approval:ui-request→IPC 转发渲染进程、approval:ui-response→回发内核事件，窗口已销毁时确定性 emit deny（C1，载荷形状与 shell-default ApprovalUiRequest/ResponsePayload {token,pluginId,pluginName,permissions}/{token,result} 一致）；pushUiState 附 panels（C4，shell:ui 缺失降级 []）；shell:read-plugin-asset 双重路径守卫（pluginId 正则 + 禁绝对路径/.. 段 + resolve 须落在插件目录内）。e2e——临时 userData/plugins + 注入假 fetchImpl（成功路径全部走本地 fixture zip，不访问真实 registry/github）；approval-policy 经 kernel.lifecycle.mount 编程挂载，prompter 模拟 C1 事件协议；note 无权限直通→enabled+mounted→panels 含 note 面板；file-stats 触发 C1 往返→deny→不可启用/未入 enabled；网络失败/损坏 zip/ID_MISMATCH/重复安装/邪恶路径卸载/卸载未安装容错均真实断言；update v1.0.0→v1.0.1 断言落盘 plugin.json 版本翻转。
    - 冲突处理：无。分支基于 f4bbda8，main 增量（TASK-015/TASK-013 合并 + docs 登记）均为 approval-policy/kernel/shell-default/docs 改动，与本分支文件零重叠（lockfile 侧 main 未碰），ort 策略自动合并。
    - 合并后复跑验证（仓库根真实复跑）：pnpm install exit 0（Lockfile is up to date，adm-zip 相关 +2 包落盘，lockfile 一致性通过）；pnpm run typecheck exit 0；pnpm run lint exit 0；pnpm --filter @issheepbox/kernel test 72/72；pnpm --filter @issheepbox/approval-policy test 51/51；node packages/plugins/verify-examples.cjs 49 断言×5 场景（exit 0；场景 D 经 approval-ui 事件往返等 120s 超时 deny，等待较长属预期）；pnpm --filter @issheepbox/market-client run verify:fixture 47/47；pnpm --filter @issheepbox/desktop run build exit 0；node apps/desktop/scripts/verify-market-e2e.cjs 30 断言×4 场景（exit 0）。
    - 依赖登记：pnpm-lock.yaml 变更仅 adm-zip@0.6.1（纯 JS、无构建脚本）+ @types/adm-zip@0.6.0（stub，上游标注 deprecated 但无害）+ desktop→@issheepbox/market-client workspace 链接；无夹带无关条目。
    - GitHub 不可达登记：本机 github.com 不可达，真实 downloadUrl 下载成功路径不在本地验证（仅网络失败容错测），验收成功路径一律本地 fixture zip 复现；registry 4 条目真实可下载性待批次末 github 连通后统一核对。

### TASK-013：授权 UI（shell-default ApprovalPrompter）+ 启动路径门禁修复（kernel）
- 状态：已完成
- 负责 agent：agent-authz-ui
- 分支：agent-authz-ui/feat-authz-ui
- 需求描述：
  ① shell-default 实现 ApprovalPrompter：注册服务 approval-ui（形状=ApprovalPrompter，C1）；实现方式=发 approval:ui-request 事件并等待 approval:ui-response（载荷按 C1，超时 fail-safe 拒绝）；权限中文名/用途/风险取自 approval-policy 权限目录。
  ② kernel ProfileEngine 启动恢复路径门禁修复（真实问题：file-stats 未授权即被启用，P-006 门禁只拦显式 enable）：boot()/restore()/switchTo() 挂载 enabled 插件前，对声明权限的插件同样 requestApprovalForManifest(manifest, source='boot'/'restore'/'switchTo')——未授权（denied 或无记录）不挂载并记录（mountFailures 或等价可观测位置），profile.enabled 保持不动（用户后续可授权后重启用）；boot 时需保证 approval-policy 服务先就绪（enabled 含带权限插件且服务未挂载时先挂载 approval-policy 或等价机制）；enable() 显式门禁保持现状。内核改动仅限此门禁修复处。
- 验收标准：无权限插件启动直通；带权限插件无授权记录/denied 时启动不挂载（启动恢复路径复测）；shell 挂载后 approval-ui 服务可被 approval-policy 消费；kernel 63 基线 + 新增启动门禁用例、approval-policy 32、verify-examples 49×5 回归全绿；typecheck/lint exit 0。
- 依赖：TASK-006、TASK-008（P-006）
- 完成时间：2026-10-15
- 合并记录（merger）：
  - 合并提交：dbc4bcf（merge --no-ff，基于 721ad87；分支 tip 0f91049，5 提交）。
  - 审查结论：5 提交信息符合 conventions（2×fix(kernel)/1×feat(shell-default)/2×test(kernel)，正文均写明改了什么/为什么改/影响范围）；diff 范围 4 文件 +627/-10，全部位于 packages/kernel（profile/index.ts、新增 __tests__/boot-gate.test.ts）与 packages/shell-default（src/index.ts、plugin.json），无 approval-policy/market-client/desktop/plugins 夹带；无密钥/本机路径；无 dist/node_modules/lockfile/二进制入库。
  - 语义核对：C2——boot()/restore()/switchTo() 挂载 profile.enabled 前经 gateEnabledPlugins() 对带权限插件 requestApprovalForManifest(manifest, source)（source='boot'/'restore'/'switchTo'，与 015 的 BOOT_PATH_SOURCES 集合逐字一致），denied/无记录/服务不可用 → 不挂载并记入 mountFailures（boot）/getLastMountFailures()（restore/switchTo），profile.enabled 不被静默改写 ✓；enable() 门禁其余语义不变（denied 不进 enabled、无权限直通、granted 挂载）✓；infra 自动挂载——ensureApprovalPolicyServiceReady() 仅在 enabled/待启用列表含带权限插件且 'approval-policy' 服务缺席、且 org.issheepbox.approval-policy 已被发现时挂载，不写入 profile.enabled；服务已在场（含宿主/测试注入）直接复用不重复挂载；未发现则 fail-safe 拒绝 ✓。C1——shell-default 注册 approval-ui 服务（形状=ApprovalPrompter 的本地结构类型，不运行时依赖 approval-policy），发 approval:ui-request（载荷 { token, pluginId, pluginName, permissions: PermissionInfo[] 原样透传 }）→ 按 token 等 approval:ui-response（{ token, result }）→ 返回 grant-all/grant-subset/deny；120s 超时 fail-safe 拒绝；壳卸载经 ctx.effects 兜底拒绝在途请求并清理定时器（P-007 可逆）；过期/伪造 token 响应直接忽略不串扰 ✓。
  - 冲突处理：无。分支基于 f4bbda8，main 增量（TASK-015 合并 + docs 提交）均为 approval-policy/docs 改动，与本分支文件零重叠，ort 策略自动合并。
  - 合并后复跑验证：`pnpm install` exit 0（already up to date）；`pnpm run typecheck` exit 0；`pnpm run lint` exit 0；`pnpm --filter @issheepbox/kernel test` 72/72 通过（63 基线 + boot-gate.test.ts 9 新增）；`pnpm --filter @issheepbox/approval-policy test` 51/51 通过；`node packages/plugins/verify-examples.cjs` 49 断言 × 5 场景全部通过（node 真实退出码 0；场景 D 因 shell-default 注册 approval-ui 后经事件往返等 120s 超时 deny，断言仍全绿）；`pnpm --filter @issheepbox/market-client run verify:fixture` 46/46 通过；`pnpm --filter @issheepbox/desktop run build` exit 0。
  - 设计偏离登记：默认 profile.enabled 仍为 [shell-default]，不持久化 approval-policy——approval-policy 仅按基础设施语义在门禁需要时由 kernel 按需 ensureApprovalPolicyServiceReady 挂载。硬约束理由（merger 复核 verify-examples.cjs 成立）：场景 B/C/D/E 均在 kernel.start() 后自行 lifecycle.mount(makeInjectedApprovalPolicy(...)) 注入自定义 prompter/store 的 approval-policy；若默认 enabled 持久化 approval-policy，boot 会先挂载它并注册同名服务，脚本再注入时撞 ServiceRegistry 同名注册致 49×5 变红；且场景 E 阶段 1 依赖「approval-policy 服务未挂载」验证 fail-safe，默认持久化会直接破坏该断言。packages/plugins 禁改，此偏离为唯一可行接线，结论合理。
  - infra 自动挂载语义与 approval-ui 事件契约已在上方「语义核对」登记；approval-ui 事件桥接渲染进程权限清单对话框由 TASK-012 desktop 承接。

### TASK-014：面板渲染（shell:ui 面板挂载区）
- 状态：已完成
- 负责 agent：agent-panel-render
- 分支：agent-panel-render/feat-panel-render
- 需求描述：shell-default 扩展 shell:ui：registerPanel(panelId, title, options?: { pluginId?, src?, html?, width?, height? })——面板记录携带渲染内容元数据（C4）；panels 元素形状 { id, title, pluginId?, src?, html?, width?, height? } 向后兼容（旧 2 参调用仍有效）；note 面板经其 manifest ui.panels 声明（src=assets/panel.html、360×240），调用点顺带传参——仅允许修改 packages/plugins/note/src/index.ts 的 registerPanel 调用一处（含必要的类型对齐）；P-007 回滚契约保持（unregister 随 effect scope 移除，卸载面板记录无残留）。
- 验收标准：registerPanel 后面板内容元数据可被宿主读取（shell:ui 服务面板数组形状符合 C4）；卸载后随 effect scope 移除（P-007 复测）；note 面板内容可被宿主渲染（端到端由 TASK-012 契约承接，本任务验证数据契约与回滚）；verify-examples.cjs 面板断言保持兼容；回归全绿。
- 依赖：TASK-013（同包串行，须其合并后再开工）
- 完成时间：2026-10-15
- **合并记录（merger）**：2026-10-15 审查通过并合并（merge `ddc82c4`，分支 tip `4f53e33`，基于 `2e94ce8`；main 已前进至 `2ead606` 且增量为 TASK-012 合并（desktop/market-client/lockfile），与本分支改动文件零重叠，无冲突直接并入），远端分支 `agent-panel-render/feat-panel-render` 已删除。
  - 审查结论：2 提交信息符合 conventions（`feat(shell-ui)` / `docs(plugin-spec)`，正文均写明改了什么/为什么/影响范围）；diff 范围 3 文件 +86/-15，全部位于 packages/shell-default/src/index.ts、packages/plugins/note/src/index.ts（经批准的唯一边界外改动）、docs/plugin-spec-v1.md，无 kernel/approval-policy/market-client/desktop/verify-examples.cjs/TASKS.md 夹带；无密钥/本机路径；无 dist/node_modules/lockfile/二进制入库。
  - C4 契约要点：registerPanel 新增第三参 `options?: PanelContentOptions = { pluginId?, src?, html?, width?, height? }`，panels 元素 = `{ id, title } & PanelContentOptions`，实现为 `{ id: panelId, title, ...options }` 展开——未传字段缺省不出现；向后兼容旧 2 参调用条目键集恰为 `{ id, title }`；P-007 回滚契约不变——unregister 按 `panels.indexOf(panel)` 对象引用精确移除（容忍重复 panelId），注册/注销仍发 `shell:ui-refresh` reason=panel-registered/panel-unregistered；approval-ui 服务与全部事件订阅 diff 未触及、原样保留；宿主消费语义：html 直接注入、src 经 IPC `shell:read-plugin-asset` 读插件包资源（TASK-012 desktop 侧承接）。
  - note 调用点批准说明：TASK-014 需求描述明确授权「仅允许修改 packages/plugins/note/src/index.ts 的 registerPanel 调用一处（含必要的类型对齐）」；分支实际改动恰为此文件一处调用（options `{ pluginId: 'org.issheepbox.example.note', src: 'assets/panel.html', width: 360, height: 240 }`，与 manifest ui.panels[0] 完全对齐）+ 局部 ShellUiShape/PanelContentOptions 类型定义，note 其余代码/资源/manifest 未动，未越界。plugin-spec-v1.md §4.2/§5.2/§11.3/§11.4 同步内容与实现一致。
  - 冲突处理：无。分支基于 `2e94ce8`，main 增量（`3143007`/`2ead606`，TASK-012）位于 desktop/market-client/lockfile，与本分支改动零重叠，ort 策略直接并入。
  - 合并后复跑验证：`pnpm install` exit 0（Already up to date）；`pnpm run typecheck` exit 0；`pnpm run lint` exit 0；`pnpm --filter @issheepbox/kernel test` 72/72 通过；`pnpm --filter @issheepbox/approval-policy test` 51/51 通过（5 个测试文件）；`node packages/plugins/verify-examples.cjs` 49 断言 × 5 场景全部通过；`pnpm --filter @issheepbox/market-client run verify:fixture` 47/47 通过；`pnpm --filter @issheepbox/desktop run build` exit 0；`node apps/desktop/scripts/verify-market-e2e.cjs` 30 断言 × 4 场景全部通过。

### TASK-015：授权持久化（ApprovalStore 磁盘实现）
- 状态：已完成
- 负责 agent：agent-approval-store
- 分支：agent-approval-store/feat-approval-store
- 需求描述：approval-policy 落地持久化：① DiskApprovalStore（userData 下 approvals.json，原子写=临时文件+rename；set/delete 即落盘；构造时加载既有记录）；② createApprovalPolicyPlugin 默认接线：store=宿主服务 host:user-data（C3）存在则 DiskApprovalStore(dir) 否则 MemoryApprovalStore；prompter=服务 approval-ui（C1）存在则用之否则 FailSafePrompter；③ requestApproval 按 source 区分：source ∈ {boot, restore, switchTo} 为启动路径——仅查存储：granted 记录→自动 granted、denied/无记录→denied（不弹窗，fail-safe）；其余来源维持现行为（granted 覆盖自动复用、denied 记录复用不重复弹窗、需授权则经 prompter）。
- 验收标准：重启后授权记录保留（磁盘 roundtrip：新实例读同一文件）；原子写（中断不产生半写文件——临时文件+rename 机制验证）；approval-policy 32 基线 + 新增持久化/来源语义用例；kernel 63、verify-examples 49×5 回归全绿。
- 依赖：TASK-008（P-006）
- 完成时间：2026-10-15
- **合并记录（merger）**：2026-10-15 审查通过并合并（merge `279ec79`，分支 tip `2627db4`，基于 f4bbda8；main 已前进至 33be1ee 且增量仅 docs 提交，改动零重叠，无冲突直接并入），远端分支 `agent-approval-store/feat-approval-store` 已删除。
  - 审查结论：4 提交信息符合 conventions（3×feat(approval-policy) / 1×docs(approval-policy)，正文均写明改了什么/为什么/影响范围）；diff 范围 7 文件 +830/-24，全部位于 packages/approval-policy（新增 src/storage-disk.ts、wiring.test.ts、storage-disk.test.ts；index.ts 默认接线；approval-policy.ts 启动路径 source 语义 +6 例；README），无 kernel/shell-default/market-client/desktop/plugins 夹带；无密钥/本机路径；无 dist/node_modules/lockfile/二进制入库。
  - 语义核对：C3 原子写——临时文件（pid+时间戳+序号唯一）同目录写出后 rename 覆盖，且 set/delete 先 flushMap 落盘成功再更新内存，落盘抛错不破坏既有 approvals.json ✓；C3 默认接线——host:user-data 形状合法→DiskApprovalStore(dir)，形状非法 warn 回退 Memory，显式 options.store 优先 ✓；C1——prompter 为懒解析代理，每次弹窗前现查 approval-ui（形状校验），缺失/非法→FailSafePrompter，不缓存、不依赖挂载顺序，显式 options.prompter 优先 ✓；C2——BOOT_PATH_SOURCES={boot,restore,switchTo} 走仅查存储分支：granted 覆盖自动复用、denied 记录复用、无记录/未覆盖→denied(fail-safe) 且绝不 store.set、空权限直通 granted(auto)；其余来源行为不变 ✓。
  - 冲突处理：无。分支基于 f4bbda8，main 增量（8facbe8/a488d33/33be1ee）均为 docs/TASKS.md 提交，与本分支改动文件零重叠。
  - 合并后复跑验证：`pnpm install` exit 0（already up to date，无需 --ignore-scripts）；`pnpm run typecheck` exit 0；`pnpm run lint` exit 0；`pnpm --filter @issheepbox/approval-policy test` 51/51 通过（5 个测试文件：32 基线零修订 + 19 新增=storage-disk 9 / wiring 4 / boot-path 6）；`pnpm --filter @issheepbox/kernel test` 63/63 通过；`node packages/plugins/verify-examples.cjs` 49 断言 × 5 场景全部通过；`pnpm --filter @issheepbox/market-client run verify:fixture` 46/46 通过；`pnpm --filter @issheepbox/desktop run build` exit 0。
  - 设计决定要点：①原子写「先落盘后更新内存」——落盘失败时内存与磁盘同停旧态，调用方可安全重试，无「内存新、磁盘旧」分叉；②启动路径「无记录不写策略」——绝不 store.set，避免把用户尚未决策的插件永久锁死在 denied；③prompter 懒解析——不缓存服务实例，壳后于本插件挂载时，下一次弹窗即自动用上 approval-ui；④损坏 approvals.json 容错降级为空存储 + logger.warn，不抛错不阻塞启动（宁可重新授权也不让应用起不来）；⑤v1 多实例同写不做文件锁（桌面单进程模型足够），局限已在 README 标注。

---

## 外部 agent 交付（v0.2.1）

> 批次说明（合并者 2026-10-15 登记）：本批为外部 agent（DESKTOP-OKH9QGI-DouBao）在 github 远端直接开发、推送功能分支后的首次合并；两分支均经独立审核（§2 全部 PASS、无 BLOCKER、零密钥、无不应入库产物、权限声明与实现一致、命名空间与 plugin-spec §3.2 一致），由合并者在 workspaces/merger 工作区执行 --no-ff 合并、复跑验证并登记。

### TASK-021：可交互面板桥（panel-bridge）
- 状态：已完成
- 负责 agent：外部 agent（DESKTOP-OKH9QGI-DouBao）
- 分支：agent-doubao/feat-panel-bridge（tip `f666329`，1 提交）
- 需求描述：宿主通用面板传输全链路——desktop main.ts 新增 `panel:post` / `panel:msg` IPC、preload 暴露 `panelBridge`；shell-default registerPanel 的 `interactive: true` 标记透传进 panels 数组；渲染进程对 interactive 面板切 iframe srcdoc 并经 `window.isbPanel` postMessage 路由 inbound/outbound 消息；echo-panel 示例插件（`com.pastsheep.echo-panel`）dogfood 全链路（面板 inbound 收到消息后 outbound 回发原文）。验证脚本 `packages/plugins/verify-panel-bridge.cjs`（内核侧事件契约 15 断言）。
- 验收标准：registerPanel 交互标记透传、面板消息经 postMessage 路由回 echo-main 且回显原文、非自身 panelId 不串台、卸载后面板记录与监听随 effect scope 回滚无残留；typecheck/lint exit 0；kernel / approval-policy / verify-examples 回归持平。
- 依赖：TASK-014（面板渲染契约 C4）
- 完成时间：2026-10-15
- **合并记录（merger）**：2026-10-15 审查通过并合并（merge `becc2de`，merge --no-ff；分支基于 `213dd51`=main HEAD 最新基线，零冲突直接并入），远端分支 `agent-doubao/feat-panel-bridge` 已删除。
  - 审查结论：§2 全项 PASS（分支基于最新 main、提交信息符合 conventions、改动范围与任务描述一致、代码可构建测试通过、无密钥/凭据/本机专属路径、无 dist/node_modules/二进制入库）；diff 范围 11 文件 +380/-2，全部位于 apps/desktop（index.html/main.ts/preload.ts）、packages/shell-default（src/index.ts +4 行 interactive 透传位）、packages/plugins/echo-panel（新增示例插件 5 文件）、packages/plugins/verify-panel-bridge.cjs、pnpm-lock.yaml（+6 行新 importer）。
  - 合并后复跑验证：`pnpm install` exit 0（lockfile up to date）；`pnpm run typecheck` exit 0；`pnpm run lint` **初次 exit 1**（见下「合并后修复」）；`pnpm build` + `pnpm --filter @issheepbox/plugin-echo-panel run build` exit 0（verify 脚本前置构建产物）；`node packages/plugins/verify-panel-bridge.cjs` exit 0——15 项断言全部通过（默认壳挂载、echo-panel 启用、interactive===true、src/pluginId 透传、inbound→outbound 回发路由回 echo-main、回显原文、携带主进程时间戳、非自身 panelId 忽略不串台、卸载后面板记录回滚、监听随 effect scope 回滚、kernel.stop 全卸载）。
  - **合并后修复（merger）**：fix `86c06d8` —— `fix(plugins): 移除 verify-panel-bridge.cjs 未使用的 SHELL_ID（lint 门禁）`。合并后首次 lint exit 1：`packages/plugins/verify-panel-bridge.cjs:33 'SHELL_ID' is assigned a value but never used`（@typescript-eslint/no-unused-vars）；该常量声明后全文无任何引用，按先例（fc7d15d「fix(desktop): 移除 verify-v020-acceptance.cjs 未使用的 APPROVAL_POLICY_ID（lint 门禁）」、TASK-011 合并后修复 7296544）仅删除该未使用常量一行（1 文件 +0/-1，不动其他内容）。提交后复跑：`pnpm run lint` exit 0；`node packages/plugins/verify-panel-bridge.cjs` 15 断言仍全过。
  - 最终全量门禁（本批合并后）：kernel 72/72、approval-policy 51/51、verify-examples 49 断言×5 场景、`pnpm --filter @issheepbox/desktop run build` exit 0，全部与基线持平。
- **遗留问题**：iframe 真实渲染（srcdoc 注入 / postMessage / webContents.send）未经 headless 验证——该侧为 desktop 主进程 + preload + index.html 薄胶水，正确性由 tsc 构建保证；外部 agent 已请求 `pnpm dev` 点验 echo-panel 回显，**转交需求方真机确认**。

### TASK-022：storage KV 服务 + shushu-data 数据索引插件
- 状态：已完成
- 负责 agent：外部 agent（DESKTOP-OKH9QGI-DouBao）
- 分支：agent-doubao/feat-storage-plugin（tip `6308ed5`，2 提交：f91b6fc org.issheepbox.storage、6308ed5 com.pastsheep.shushu-data）
- 需求描述：① 第一方 KV 持久化服务插件 `org.issheepbox.storage`——namespace().set/get 读写、storage:changed 事件、命名空间隔离、数据写穿透落盘到 host:user-data（issheepbox-storage.json）、跨「内核重启」从磁盘读回；`files:read` + `files:write` 双权限声明，经 approval-policy（host:user-data 存在性）与 ctx.files（P-009 宿主能力运行时门禁）双闸；DenyPrompter 拒绝后不可启用、不注册服务；卸载经可逆 effects 注销无残留。② 跨仓库数据索引插件 `com.pastsheep.shushu-data`——`network:fetch` 声明 + 挂载自检（第一道闸），拉取 DeltaForceBox-Assets 公开 manifest（实测 6 数据集 / 3721 条目），注册数据服务并向 shell:ui 注册静态数据面板；网络失败优雅降级（插件仍挂载、数据集为空、记录拉取错误、不崩溃）；拒绝 network:fetch 后不可启用。③ `packages/plugins/storage/NEXT-PLUGINS-DESIGN.md` 后续插件方向设计。验证脚本 `verify-storage.cjs`（20 断言）与 `verify-shushu.cjs`（18 断言）。
- 验收标准：storage 授权后挂载/读写/落盘/跨重启读回/命名空间隔离/卸载无残留、拒绝后不挂载不注册服务；shushu-data 授权后拉取 manifest 条目数正确、注册服务与面板、网络失败降级、拒绝后不可启用；typecheck/lint exit 0；kernel / approval-policy / verify-examples 回归持平。
- 依赖：TASK-015（host:user-data 持久化接线 C3）、P-009（ctx.files 宿主能力）
- 完成时间：2026-10-15
- **合并记录（merger）**：2026-10-15 审查通过并合并（merge `02cb2cf`，merge --no-ff；分支基于 `fc7d15d`，落后 main 4 提交；改动域 packages/plugins/** 与 main 增量 docs/ + apps/desktop/ 逐文件零重叠；pnpm-lock.yaml 两分支均改过不同 importer 段，ort 自动合并干净，无文本冲突），远端分支 `agent-doubao/feat-storage-plugin` 已删除。
  - 审查结论：§2 全项 PASS；diff 范围 14 文件 +1163（纯新增），位于 packages/plugins/storage（plugin.json/package.json/src/tsconfig/README/NEXT-PLUGINS-DESIGN.md）、packages/plugins/shushu-data（plugin.json/package.json/src/tsconfig/README）、packages/plugins/verify-storage.cjs、verify-shushu.cjs、pnpm-lock.yaml（+12 行新 importer）；零密钥、无 dist/node_modules/二进制入库；权限声明与实现一致（storage 声明 files:read+files:write、shushu-data 声明 network:fetch，均与代码实际调用面相符）；命名空间依据 docs/plugin-spec-v1.md §3.2（org.issheepbox.* 第一方 / com.pastsheep.* 第三方）。
  - 合并后复跑验证：`pnpm install` exit 0（工作区项目数 10→12，lockfile 通过 supply-chain 校验 439 条目）；`pnpm run typecheck` exit 0；`pnpm run lint` exit 0；`pnpm --filter @issheepbox/plugin-storage run build` / `pnpm --filter @issheepbox/plugin-shushu-data run build` exit 0；`node packages/plugins/verify-storage.cjs` exit 0——20 项断言（2 场景：授权后挂载/读写/落盘/跨重启读回/隔离/卸载无残留 + DenyPrompter 拒绝路径）；`node packages/plugins/verify-shushu.cjs` exit 0——18 项断言（3 场景 + 2 纯函数：授权后拉取 6 数据集/3721 条目/getDataset(az3).count=1262/注册服务与面板/卸载无残留、网络失败 ENOTFOUND 优雅降级、拒绝 network:fetch 不可启用）。
  - 最终全量门禁：kernel 72/72、approval-policy 51/51、verify-examples 49 断言×5 场景、verify-panel-bridge 15、verify-storage 20、verify-shushu 18、desktop build exit 0，全部与基线持平。
- **遗留问题（NOTE）**：① shushu-data 数据源为外部仓库 `raw.githubusercontent.com/PastSheep/DeltaForceBox-Assets`（合并者实测拉取 HTTP 200、6 数据集/3721 条目可达），**可达性随外部仓库变化**——外部仓库被删除/改名/网络不通时插件自动降级为空数据集（已优雅处理），但面板数据将为空；② `NEXT-PLUGINS-DESIGN.md` 位于 packages/plugins/storage/ 插件目录而非 docs/，且文档中 shushu-data 仍列于 backlog（实际 shushu-data 已实现）——**文档未同步**，登记 NOTE，建议后续文档任务将其迁移至 docs/ 并把 shushu-data 从 backlog 勾销。

---

## v0.3.0 规划（方向已确认，待 v0.2.0 批次完成后派发）

> 架构依据（2026-10-15 需求方确认）：「一切皆插件、最小可运行版本精简」——内核只保留**原语层**（loader/lifecycle/events/profile/权限接口 + fs 读写已有；本批补充进程执行原语），一切**业务能力以独立插件形态提供**（git 解析/拓扑 UI 均为插件）；插件依赖链（P-005 requires + 拓扑排序）作为聚合基础，插件组提供场景化组合；**插件发布与应用版本解耦**——应用发布（v0.x.0 tag）仅含内核 + 内置插件（shell-default/approval-policy），功能插件独立版本、独立 Release、由市场拉取（TASK-020）。

### TASK-016：内核进程执行原语（受权限门禁）
- 状态：待派发（v0.3.0）
- 负责 agent：（v0.2.0 完成后指派）
- 分支：（v0.2.0 完成后指派）
- 需求描述：内核新增受限进程执行原语（对应权限目录 `shell:exec`，高危需二次确认）：命令白名单（git 只读命令集：`rev-list --parents` / `for-each-ref` / `show -s --format=...`）+ 参数校验（无 shell 拼接、禁止路径注入）+ 仓库路径白名单（用户授权）+ 输出大小限制；经 approval-policy 门禁（shell:exec 权限，二次确认）。为 git-service 插件（TASK-017）提供取数通道。备选路线（若评审确认更优）：fs 原语增强（目录枚举 + 二进制/zlib 读取）走纯解析路线，本任务改为 fs 增强。
- 验收标准：白名单外命令拒绝；未授权拒绝；输出超限截断；无 shell 注入路径；kernel 回归 + 新增原语门禁用例；approval-policy 32、verify-examples 49×5 回归全绿。
- 依赖：TASK-013（授权 UI）/ TASK-015（授权持久化）——门禁语义与来源判定
- 完成时间：

### TASK-017：git-service 独立插件（org.issheepbox.git-service）
- 状态：待派发（v0.3.0）
- 负责 agent：（v0.2.0 完成后指派）
- 分支：（v0.2.0 完成后指派）
- 需求描述：独立服务形态插件（非内核能力，贯彻 EVP）：消费内核进程原语（TASK-016），调 git CLI 只读命令解析拓扑数据——`rev-list --all --parents` → 提交 DAG；`for-each-ref --format` → 分支/标签；`show -s --format` → 提交详情；输出拓扑数据模型（commits/refs/merge 结构），注册 `git:` 服务 + 事件；权限目录新增 `git:read`（中危：只读仓库元数据）。参考 git-history-ui（后端执行 git 命令）与 gitweb。
- 验收标准：真实仓库取数正确（与 git CLI 原始输出对账）；服务注册/卸载无残留（effect scope 回滚）；git:read 未授权拒绝（fail-safe）；新增权限项中文展示/风险登记；回归全绿。
- 依赖：TASK-016
- 完成时间：

### TASK-018：git-topology 面板插件（org.issheepbox.git-topology）
- 状态：待派发（v0.3.0）
- 负责 agent：（v0.2.0 完成后指派）
- 分支：（v0.2.0 完成后指派）
- 需求描述：UI 面板插件，manifest 声明 `requires: org.issheepbox.git-service`（插件依赖链真实用例，配合 TASK-019 组功能）；右侧主区域渲染 SVG 拓扑图（分支线/合并点/commit 节点/ref 徽标，参考 gitweb.js 与 Git Overview）；点击 commit 查看详情（作者/时间/消息/变更文件）；仓库路径经用户授权选择。
- 验收标准：真实仓库渲染拓扑正确；requires 依赖自动启用；面板随 effect scope 回滚（卸载无残留）；验证脚本覆盖；回归全绿。
- 依赖：TASK-014（面板渲染）、TASK-017、TASK-019（插件组）
- 完成时间：

### TASK-019：插件组基础（manifest group + 生命周期联动 + registry 组条目）
- 状态：待派发（v0.3.0）
- 负责 agent：（v0.2.0 完成后指派）
- 分支：（v0.2.0 完成后指派）
- 需求描述：插件聚合层：manifest 新增 group 声明（组 id/成员/描述）；lifecycle 组生命周期——启用 A 自动按拓扑序启用其 requires 依赖、卸载组反转序逐一下线、依赖缺失阻止启用并提示；market-client 组安装（原子性：中途失败回滚）；registry 新增 groupEntry/group 字段。首个用例：git-service + git-topology 组成「Git 开发组」。
- 验收标准：组启用/卸载顺序正确（依赖反转序）；依赖缺失阻止启用；组安装中途失败回滚无半残留；验证脚本覆盖；回归全绿。
- 依赖：TASK-012（市场安装链路）
- 完成时间：

### TASK-020：插件独立发布流水线（发布与应用版本解耦）
- 状态：待派发（v0.3.0）
- 负责 agent：（v0.2.0 完成后指派）
- 分支：（v0.2.0 完成后指派）
- 需求描述：功能插件发布流程落地，与应用 tag 完全解耦：① 单插件 zip 构建（复用 release/build_plugin_zips.py，支持按插件 id 构建，zip 命名含版本如 git-service-1.0.0.zip，顶层=插件 id）；② 上传独立 Release（如 tag git-service-v1.0.0，不进应用 v0.x.0 tag）；③ registry plugins.json 版本登记/更新流程（新 version + downloadUrl → status=active，validate_index.py 校验 0 error）；④ 文档化发布 SOP（docs/release-plugins.md）；⑤ 与 market-client update（TASK-012）对接：按 registry 版本比对拉新。应用安装包不含功能插件。
- 验收标准：以 git-service（TASK-017 完成后）跑通一次端到端——构建 zip → 独立 Release 上传 → registry 登记新版本 → market-client 实测拉取/解析/版本比对；zip 结构校验；validate_index 0 error；发布不触发应用 tag、不进入应用安装包。
- 依赖：TASK-017（git-service）、TASK-012（安装链路）、TASK-019（registry 组条目，如组发布一并处理）
- 完成时间：

---

## 跨任务待办（pending）

> 非阻塞项，由下一个适用任务顺带处理（prompt 附加项）。

### P-001：修正 packages/kernel/src/index.ts 头部过时注释
- 状态：已解决（销项）
- 说明：TASK-005 已完成，index.ts 头部注释仍将其列为「后续任务」。TASK-004 合并时已顺带修正（现按序登记 TASK-002~005 均已交付），销项于 2026-10-13 由需求方确认。

### P-002：pnpm esbuild 构建审批落库
- 状态：已解决（销项）
- 说明：TASK-008（agent-permission）合并时已在 pnpm-workspace.yaml 的 allowBuilds 中显式声明 `esbuild: true`（与已有 `electron: true` 同字段）并随分支落库；合并前实测 `pnpm install` 非交互通过（exit 0，lockfile 通过 supply-chain 校验，无 esbuild 构建审批弹窗、无 ERR_PNPM_IGNORED_BUILDS）。销项于 2026-10-13。

### P-003：修订 plugin-registry-schema.md 的 id pattern 对齐连字符
- 状态：已解决（销项）
- 说明：docs/plugin-registry-schema.md 第 5 节 id pattern（`^[a-z][a-z0-9]*(\.[a-z0-9]+)+$`）不含连字符，与权威规范冲突——docs/plugin-spec-v1.md 第 3.2 节 id 示例（com.example.my-tool）及 kernel manifest 校验（packages/kernel/src/manifest.ts）均接受连字符。TASK-007（agent-market）客户端已按规范权威放宽（parse.ts ID_RE 含 `-`，并有注释说明）。后续需修订 schema 的 id pattern 为 `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$` 对齐，并回归 registry 机器校验流程。
- **解决说明**（agent-fix/p003-registry-id，提交 cebc82e）：docs/plugin-registry-schema.md 第 5 节 id pattern 放宽为 ^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$，与 plugin-spec-v1.md §3.2 及 kernel manifest.ts ID_RE 对齐；同节 schema 配套 registry 上架 pending 方案：新增 status（active/pending）枚举，releaseUrl/downloadUrl 改条件必填（status=pending 可缺省，active 或缺省必填，draft-07 if/then/else）；第 3 节字段表与 6.1 维护流程同步补充 pending→active 流转。registry 仓库 schemas/plugins.schema.json 由上架任务按此形态镜像修订以保持同构。验证：schema JSON 合法、7 例语义用例全过、typecheck/lint exit 0。
- **合并记录（merger）**：2026-10-14 审查通过并合并（merge `ef0b955`），远端分支已删除。合并后复跑：typecheck/lint exit 0；kernel 36/36、approval-policy 32/32 测试通过；verify-examples.cjs 47 断言 × 5 场景通过。

### P-004：内置插件 version 钉死 0.0.0，应用升级后不刷新
- 状态：已解决（销项）
- 说明：TASK-011 的 apps/desktop/src/main.ts 中 copyDirIfNewer 以「userData/plugins 与 resources/builtin-plugins 的 plugin.json version 一致则跳过覆盖」为幂等条件；但 packages/shell-default 与 packages/approval-policy 的 version 均钉死 0.0.0，后续应用升级重打安装包后两侧版本恒等，已展开到 userData 的内置插件不会被新版安装包刷新。MVP 首启无影响（首次展开逻辑正确），升级路径上的内置插件更新失效。修复方向：升级时按应用版本号记录展开标记、改为「resources 侧 buildId/版本戳更新即覆盖」，或在打包流水线中给内置插件自增版本。不随 TASK-011 修复（避免扩大范围），由后续适用任务顺带处理。
- **解决说明**（agent-fix/p004-builtin-version，提交 9c6facd/adec4db/49e89e3）：前提已过时——两内置插件 plugin.json 现为 0.1.0/1.0.0（package.json 仍 0.0.0），真实形态为「plugin.json version 手动 bump 滞后于代码变更时两侧版本恒等→应用升级后 userData 内置插件不刷新」。修复：幂等键由「两侧 plugin.json version 比较」改为「resources 侧目录内容 sha256」（apps/desktop/src/builtinPlugins.ts，resolveBuiltinAction 纯函数），记入 userData/plugins/.builtin-meta.json——首启全量拷贝保留；同包重复启动 hash 不变跳过；应用升级后包内容 hash 变化即重拷；legacy 无 marker 安装自举补写。策略不依赖任何人 bump 版本号（应用版本 0.0.0→0.1.0 已对齐 version-policy 但仅作观测不入决策）。验证：新增 apps/desktop/scripts/verify-builtin-refresh.cjs 14 项断言（含原故障复现路径）全过；全量门槛 install/typecheck/lint/kernel 35/approval 32/verify 47×5/desktop build 全绿。
- **合并记录（merger）**：2026-10-14 审查通过并合并（merge 6e65b26d100e3dafccc8375656fd86c93fb67874），远端分支已删除。合并后复跑：typecheck/lint exit 0；kernel 36/36、approval-policy 32/32 测试通过；verify-examples.cjs 47 断言 × 5 场景通过；desktop build exit 0；verify-builtin-refresh.cjs 14 断言通过。

### P-005：内核·依赖解析（requires 校验 / 拓扑排序）未实现
- 状态：已解决（销项）
- 来源：TASK-009 规范反馈 F-004（agent-examples）
- 说明：docs/plugin-spec-v1.md §10 校验清单 #7（requires 依赖已安装且版本满足）/ #8（依赖图无环）标注为已实现，但 `packages/kernel/src/dependency/` 仍是占位骨架（resolveOrder 抛「未实现」），loader 不解析 `requires`。建议后续任务实现 DependencyResolver 并接入 loader，或在规范中明确降级为文档声明。
- **解决说明**（agent-fix/p005-dependency，提交 fcca3c2/7a70d59）：DependencyResolver 落地——kernel.start() 接入 requires 校验（缺失依赖/版本 range 不满足/非法 range）+ 环检测 + Kahn 拓扑排序；失败隔离沿依赖边传播（被拒插件的依赖者连锁拒绝，无关插件照常加载）；loader 保持磁盘扫描单一职责，不合规插件并入 discoveryFailures。spec §10 #7/#8 从「未实现」翻转为「已实现」，F-004 闭环（7a70d59）。验证：typecheck/lint exit 0；kernel 52 项（36 基线+16 新增）、approval-policy 32 项、verify-examples 47×5 全绿；lifecycle/profile/services/events/manifest 行为未动。
- **合并记录（merger）**：2026-10-14 审查通过并合并（merge 77bd2eafd876626943b472cfd96a08f9a7c6fdb8），远端分支已删除。合并后复跑：typecheck/lint exit 0；kernel 52/52、approval-policy 32/32 测试通过；verify-examples.cjs 47 断言 × 5 场景通过。

### P-006：ProfileEngine.enable 未接入权限校验
- 状态：已解决（销项）
- 来源：TASK-009 规范反馈 F-007（agent-examples）
- 说明：`packages/kernel/src/profile/index.ts` 构造函数接收 `opts.permissions` 但仅 `void opts.permissions`（TASK-008 边界标注「权限校验留后续集成」）；"拒绝后插件不可启用"目前依赖宿主/调用方先经 `approval-policy.requestApprovalForManifest` 再 enable（TASK-009 验证脚本按此门禁实现）。建议 ProfileEngine.enable 在 mount 前查询授权（granted 才启用），并把授权记录持久化进 profile 或注入持久化 ApprovalStore。
- **解决说明**（agent-fix/p006-profile-authz，提交 4dba527）：ProfileEngine.enable 在 mount 前经 services 注册表按名查询 'approval-policy' 服务、requestApprovalForManifest 做授权判定——声明非空 permissions 的插件须 granted 才进 enabled 并 mount，denied 不进 enabled/不持久化/不 mount/不快照（在 snapshot 前 return）；无权限插件自动放行。接线走 services 注册表（内核不 import approval-policy 包，结构接口 ApprovalGateway/ApprovalDecisionLike 定义于 profile/types.ts）；approval-policy 服务未挂载时带权限插件 fail-safe 拒绝（与 FailSafePrompter 一致）。boot()/restore()/switchTo() 不重复门禁（enable 为唯一写路径入口；启动期 approval 服务通常未挂载且 ApprovalStore 为内存实现，重复门禁会破坏 shell-default 无权限启动；持久化授权记录留待后续接入持久化 ApprovalStore）。测试：kernel 新增 6 项门禁用例（granted/denied/空权限/缺省 permissions/服务未挂载/未注入 services）；verify-examples.cjs 场景 B/C/D 改直接 profile.enable()，B 的 prompts 计数仍为 1（拒绝记录复用）。验证：typecheck/lint exit 0；kernel 58（52+6）、approval-policy 32 全过；verify-examples 46 断言 × 5 场景 exit 0（较基线 47 少 1：移除 enable() 返回不可见的 decision.status 断言，改以状态断言）。
- **合并记录（merger）**：2026-10-14 审查通过并合并（merge a28a683b5a6d901880d535ef23c95b8fc359988a），远端分支已删除。合并后复跑：typecheck/lint exit 0；kernel 58/58、approval-policy 32/32 测试通过；verify-examples.cjs 46 断言 × 5 场景通过。

### P-007：shell:ui 面板注册无回滚（宿主侧状态残留）
- 状态：已解决（销项）
- 来源：TASK-009 规范反馈 F-006（agent-examples）
- 说明：`packages/shell-default/src/index.ts` 的 `registerPanel` 仅向内部 `panels` 数组 push，无 unregister、不参与内核 EffectScope；插件卸载后其面板记录不自动回滚，与规范 §5.2「卸载无残留」契约不符（TASK-009 验证脚本已按当前行为断言并标注）。建议：registerPanel 返回 unregister 函数，或由内核/壳对面板注册做 effect 包装；同时可考虑把面板声明来源（manifest ui.panels）纳入壳记录以支持自动回滚。
- **解决说明**（agent-fix/p007-panel-effects，提交 4ba7c11）：① kernel 新增公开 ctx.effects.add(fn)（EffectsRegistry 类型 + createScopedCtx 接线，与 events/services 自动登记同 effect scope，卸载逆序自动执行，EffectScope.add 自身幂等故 mount 失败回滚安全）；② shell-default registerPanel 改为返回 unregister（按面板对象引用精确移除并发 panel-unregistered refresh）；③ note 注册面板时 ctx.effects.add(unregister) 挂进自身 scope，卸载自动回滚；④ verify-examples.cjs 场景 A 断言翻转为「面板已随 scope 回滚」，头部旧编号 P-006 更正为 P-007；⑤ plugin-spec-v1.md §4.2/§5.2/§11.3/F-006 行同步新回滚契约。内核改动最小（复用既有 EffectScope 原语），未做 service 调用归因包装或 manifest 声明回滚。验证：typecheck/lint exit 0；kernel 60/60（58+2）、approval-policy 32/32；verify-examples.cjs 46 断言 × 5 场景通过。
- **合并记录（merger）**：2026-10-14 审查通过并合并（merge c8fc42e7bb536e182b6c1cf9e21d31b23483190b），远端分支已删除。合并后复跑：typecheck/lint exit 0；kernel 60/60、approval-policy 32/32 测试通过；verify-examples.cjs 46 断言 × 5 场景通过。

### P-008：ctx.apiVersion 注入值非完整 SemVer
- 状态：已解决（销项）
- 来源：TASK-009 规范反馈 F-010（agent-examples）
- 说明：`packages/kernel/src/lifecycle/index.ts` 的 `createScopedCtx` 注入 `apiVersion: '1.0'`，而 `CURRENT_API_VERSION='1.0.0'`（compat.ts）；插件读取 `ctx.apiVersion` 得到非完整 SemVer。建议内核注入 `CURRENT_API_VERSION` 全值，避免插件侧版本判断歧义。
- **解决说明**（agent-fix/p008-apiversion，提交 f1a7f9e）：createScopedCtx 注入值由硬编码 '1.0' 改为 compat.ts 导出的 CURRENT_API_VERSION（'1.0.0'），消除插件侧版本判断歧义；新增 lifecycle 单测断言 ctx.apiVersion === '1.0.0'。全仓无其他断言/文档依赖旧注入值（manifest.test.ts 的 '1.0' 为插件 version 非法值用例，无关；verify-examples 无断言依赖；F-010 为审查历史记录保留原样）。
- **合并记录（merger）**：2026-10-14 审查通过并合并（merge `9476ab0`），远端分支已删除。合并后复跑：typecheck/lint exit 0；kernel 36/36、approval-policy 32/32 测试通过；verify-examples.cjs 47 断言 × 5 场景通过。

### P-009：files:read 等权限缺少可消费的宿主能力服务
- 状态：已解决（销项）
- 来源：TASK-009 规范反馈 F-008（agent-examples）
- 说明：规范 §9.1 禁止插件打包 Node 内置模块（fs/path），但 v1 无宿主 `files` 能力服务，带 `files:read` 的插件无实际文件读取通道（TASK-009 的 file-stats 示例采用「宿主经服务/事件传入文本内容」的沙箱模式）。建议后续任务提供受 approval-policy 约束的宿主 files capability service（files:read → 仅读、files:write → 仅写），作为权限语义的落地通道。
- **解决说明**（agent-fix/p009-host-files，提交 c5572c2 / aa456dd / 71b0288）：① kernel 新增宿主 files 能力 ctx.files.readFile(path)/writeFile(path,content)（FilesCapability 接入 PluginContext；createScopedCtx 闭包捕获本插件 manifest.id，每次调用经 services 注册表查 'approval-policy'.checkPermission 做运行时门禁；profile/types.ts 新增 RuntimePermissionChecker 结构类型，内核不 import approval-policy 包，同 P-006 ApprovalGateway 先例；内部用 node:fs，插件仍被 §9.1 禁止直接用 fs/path）。fail-safe：服务未挂载或未授权一律抛错，无静默放行。② file-stats 由 statsOfText(text) 改为 statsOfFile(path)，经 ctx.files 读真实文件，纯文本统计保留为插件内纯函数 computeTextStats；挂载自检保留为第一道闸，宿主能力每次调用门禁为第二道/权威闸；files:write 为同步覆盖写最小实现（无路径白名单/追加/流式，留待后续 minor）。③ verify-examples.cjs 场景 C 改真实临时文件+statsOfFile、场景 E 补「服务不可用/未授权读文件被拒」；kernel 新增 files-capability.test.ts 三例（granted/denied/服务不可用）。④ plugin-spec-v1.md §4.2/§7.1/§9.1 同步，F-008 行保留历史原文并追加「已闭环（P-009）」注记。验证：typecheck/lint exit 0；kernel 63/63（60+3）、approval-policy 32/32；verify-examples.cjs 49 断言 × 5 场景通过（基线 46→49，文档原「47」系 P-007 时期残留笔误一并更正）。
- **合并记录（merger）**：2026-10-14 审查通过并合并（merge `ae642704`），远端分支已删除。合并后复跑：typecheck/lint exit 0；kernel 63/63、approval-policy 32/32 测试通过；verify-examples.cjs 49 断言 × 5 场景通过。

### Registry 上架（跨任务待办）
- 状态：已解决（销项）
- 仓库：E:\Projects\IsSheepBox\workspaces\registry（origin → https://github.com/PastSheep/issheepbox-registry.git，独立仓库）
- 解决说明（分支 agent-fix/registry-listing，提交 17af956 / 69fb7ae；registry main 合并提交 af62a13）：plugins.json 登记 4 个第一方插件（org.issheepbox.shell-default / example.note / example.file-stats / example.theme-service），均以 status=pending 占位——downloadUrl 需可 GET 的真实 zip 资产 URL，而插件均未发布过 zip（发布流水线 TASK-011 未跑通），故不伪造 URL，先以 pending 登记元数据，待发布流程产出 zip 后补 releaseUrl/downloadUrl 转 active；schemas/plugins.schema.json 镜像主仓库 docs/plugin-registry-schema.md §5（id 连字符 + status 枚举 + if/then/else 条件必填）；README 记录 pending 语义与流转条件。未上架 approval-policy（第一方基础设施、随应用内置，公开上架会与内置副本版本分裂）与 market-client（无 plugin.json，是客户端库包而非插件）。校验：jsonschema Draft7 0 error + 57 项语义断言 + 反向用例（active 缺 URL 正确报错）。

### P-010：内核类型包发布（@issheepbox/kernel npm）
- 状态：待处理
- 说明：第三方插件脱离 monorepo 独立开发的**前置条件**——当前插件依赖内核 ctx API 类型经 `workspace:*` 引用，仅在 monorepo 内有效；独立仓库开发者需可安装的类型包。方向：发布 `@issheepbox/kernel` 类型包（npm 公开或私有 registry），含 ctx API / PluginManifest / services / events 类型与 d.ts；版本与 version-policy 的「内核 ctx API 版本」对齐（CURRENT_API_VERSION）。发布流程与 TASK-020（插件独立发布流水线）可共用发布基建。

### P-011：第三方插件模板仓库 + scaffold 脚手架
- 状态：待处理
- 说明：让第三方开发者「一键生成插件骨架」：plugin.json（合规 manifest）+ src（消费 ctx v1 API）+ tsconfig + GitHub Actions workflow（构建 dist → 打 zip → 上传 Release）+ registry 上架脚本（提交 plugins.json 条目）。模板仓库可容纳多插件（共享一个 CI，与「一仓库多插件」模型一致）。零门槛 = 开发者不必理解 monorepo 内部结构。

### P-012：registry 第三方上架流程文档（PR 审核模式）
- 状态：待处理
- 说明：官方 registry（PastSheep/issheepbox-registry）接受第三方上架的方式与约束文档化：开发者 fork → 提交 plugins.json 条目（status=pending）→ PR → 维护者审核（schema 校验 + zip 资产可下载核验）→ 合并转 active；发布方自持 downloadUrl（zip 在其自己的 Release，官方不代托管）；README/docs 补充上架流程、schema 语义（pending/active）、校验命令（validate_index.py）。配套：registry 仓库独立于主仓库，上架不触发应用发布。

### P-013：自定义 registry 源配置 + 自建 registry 文档 + zip 完整性校验
- 状态：待处理
- 说明：用户自由搭建工具箱的配置层落地：① 应用配置 `userData/config.json` 的 `registryUrl`（默认官方地址，未配置=官方），market-client 构造时读取（构造参数已支持，改默认值来源），配置变更刷新索引；② desktop 市场 UI 提供「数据源」设置入口（显示当前 URL、可修改、重置默认）；③ 自建 registry 文档：协议为开放静态 JSON（plugins.json + schema 镜像即可自建，无需审批）——docs/registry-guide.md 说明自建/镜像/内网托管/离线场景；④ schema 增加 `sha256` 字段（zip 资产完整性校验，防下载篡改——自定义源场景下尤其必要），market-client install 时校验。

---

## 状态说明

- **待派发**：已登记，等待需求方选择执行 agent。
- **开发中**：执行 agent 已在分支上工作。
- **待合并**：分支已推送，等待合并者审查。
- **已完成**：已合并进 main 并验证。
- **待处理（P 开头）**：跨任务待办，由适用的下一个任务顺带处理。
