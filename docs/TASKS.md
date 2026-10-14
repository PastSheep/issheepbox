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

## 跨任务待办（pending）

> 非阻塞项，由下一个适用任务顺带处理（prompt 附加项）。

### P-001：修正 packages/kernel/src/index.ts 头部过时注释
- 状态：已解决（销项）
- 说明：TASK-005 已完成，index.ts 头部注释仍将其列为「后续任务」。TASK-004 合并时已顺带修正（现按序登记 TASK-002~005 均已交付），销项于 2026-10-13 由需求方确认。

### P-002：pnpm esbuild 构建审批落库
- 状态：已解决（销项）
- 说明：TASK-008（agent-permission）合并时已在 pnpm-workspace.yaml 的 allowBuilds 中显式声明 `esbuild: true`（与已有 `electron: true` 同字段）并随分支落库；合并前实测 `pnpm install` 非交互通过（exit 0，lockfile 通过 supply-chain 校验，无 esbuild 构建审批弹窗、无 ERR_PNPM_IGNORED_BUILDS）。销项于 2026-10-13。

### P-003：修订 plugin-registry-schema.md 的 id pattern 对齐连字符
- 状态：待处理
- 说明：docs/plugin-registry-schema.md 第 5 节 id pattern（`^[a-z][a-z0-9]*(\.[a-z0-9]+)+$`）不含连字符，与权威规范冲突——docs/plugin-spec-v1.md 第 3.2 节 id 示例（com.example.my-tool）及 kernel manifest 校验（packages/kernel/src/manifest.ts）均接受连字符。TASK-007（agent-market）客户端已按规范权威放宽（parse.ts ID_RE 含 `-`，并有注释说明）。后续需修订 schema 的 id pattern 为 `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$` 对齐，并回归 registry 机器校验流程。

### P-004：内置插件 version 钉死 0.0.0，应用升级后不刷新
- 状态：待处理
- 说明：TASK-011 的 apps/desktop/src/main.ts 中 copyDirIfNewer 以「userData/plugins 与 resources/builtin-plugins 的 plugin.json version 一致则跳过覆盖」为幂等条件；但 packages/shell-default 与 packages/approval-policy 的 version 均钉死 0.0.0，后续应用升级重打安装包后两侧版本恒等，已展开到 userData 的内置插件不会被新版安装包刷新。MVP 首启无影响（首次展开逻辑正确），升级路径上的内置插件更新失效。修复方向：升级时按应用版本号记录展开标记、改为「resources 侧 buildId/版本戳更新即覆盖」，或在打包流水线中给内置插件自增版本。不随 TASK-011 修复（避免扩大范围），由后续适用任务顺带处理。

### P-005：内核·依赖解析（requires 校验 / 拓扑排序）未实现
- 状态：待处理
- 来源：TASK-009 规范反馈 F-004（agent-examples）
- 说明：docs/plugin-spec-v1.md §10 校验清单 #7（requires 依赖已安装且版本满足）/ #8（依赖图无环）标注为已实现，但 `packages/kernel/src/dependency/` 仍是占位骨架（resolveOrder 抛「未实现」），loader 不解析 `requires`。建议后续任务实现 DependencyResolver 并接入 loader，或在规范中明确降级为文档声明。

### P-006：ProfileEngine.enable 未接入权限校验
- 状态：待处理
- 来源：TASK-009 规范反馈 F-007（agent-examples）
- 说明：`packages/kernel/src/profile/index.ts` 构造函数接收 `opts.permissions` 但仅 `void opts.permissions`（TASK-008 边界标注「权限校验留后续集成」）；"拒绝后插件不可启用"目前依赖宿主/调用方先经 `approval-policy.requestApprovalForManifest` 再 enable（TASK-009 验证脚本按此门禁实现）。建议 ProfileEngine.enable 在 mount 前查询授权（granted 才启用），并把授权记录持久化进 profile 或注入持久化 ApprovalStore。

### P-007：shell:ui 面板注册无回滚（宿主侧状态残留）
- 状态：待处理
- 来源：TASK-009 规范反馈 F-006（agent-examples）
- 说明：`packages/shell-default/src/index.ts` 的 `registerPanel` 仅向内部 `panels` 数组 push，无 unregister、不参与内核 EffectScope；插件卸载后其面板记录不自动回滚，与规范 §5.2「卸载无残留」契约不符（TASK-009 验证脚本已按当前行为断言并标注）。建议：registerPanel 返回 unregister 函数，或由内核/壳对面板注册做 effect 包装；同时可考虑把面板声明来源（manifest ui.panels）纳入壳记录以支持自动回滚。

### P-008：ctx.apiVersion 注入值非完整 SemVer
- 状态：已解决（销项）
- 来源：TASK-009 规范反馈 F-010（agent-examples）
- 说明：`packages/kernel/src/lifecycle/index.ts` 的 `createScopedCtx` 注入 `apiVersion: '1.0'`，而 `CURRENT_API_VERSION='1.0.0'`（compat.ts）；插件读取 `ctx.apiVersion` 得到非完整 SemVer。建议内核注入 `CURRENT_API_VERSION` 全值，避免插件侧版本判断歧义。
- **解决说明**（agent-fix/p008-apiversion，提交 f1a7f9e）：createScopedCtx 注入值由硬编码 '1.0' 改为 compat.ts 导出的 CURRENT_API_VERSION（'1.0.0'），消除插件侧版本判断歧义；新增 lifecycle 单测断言 ctx.apiVersion === '1.0.0'。全仓无其他断言/文档依赖旧注入值（manifest.test.ts 的 '1.0' 为插件 version 非法值用例，无关；verify-examples 无断言依赖；F-010 为审查历史记录保留原样）。
- **合并记录（merger）**：2026-10-14 审查通过并合并（merge `9476ab0`），远端分支已删除。合并后复跑：typecheck/lint exit 0；kernel 36/36、approval-policy 32/32 测试通过；verify-examples.cjs 47 断言 × 5 场景通过。

### P-009：files:read 等权限缺少可消费的宿主能力服务
- 状态：待处理
- 来源：TASK-009 规范反馈 F-008（agent-examples）
- 说明：规范 §9.1 禁止插件打包 Node 内置模块（fs/path），但 v1 无宿主 `files` 能力服务，带 `files:read` 的插件无实际文件读取通道（TASK-009 的 file-stats 示例采用「宿主经服务/事件传入文本内容」的沙箱模式）。建议后续任务提供受 approval-policy 约束的宿主 files capability service（files:read → 仅读、files:write → 仅写），作为权限语义的落地通道。

---

## 状态说明

- **待派发**：已登记，等待需求方选择执行 agent。
- **开发中**：执行 agent 已在分支上工作。
- **待合并**：分支已推送，等待合并者审查。
- **已完成**：已合并进 main 并验证。
- **待处理（P 开头）**：跨任务待办，由适用的下一个任务顺带处理。
