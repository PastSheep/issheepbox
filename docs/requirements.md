# Is Sheep Box 需求文档（Requirements）

> 本文件是产品需求的唯一权威，沉淀自 2026-10-13 头脑风暴。状态变更以 `docs/TASKS.md` 为准。

## 1. 产品愿景

**一个 all-in-one 桌面程序**：用户通过界面勾选启用/禁用功能插件，组装出属于自己的专有工具箱（Profile）。插件规范完全开放，第三方与项目内各 agent 均可按规范开发贡献。

## 2. 已确认决策

| 决策点 | 结论 | 依据/备注 |
|---|---|---|
| 运行形态 | 桌面应用（Electron + TypeScript） | 与参考架构 DSH 同栈；插件以 Web 技术编写最自然 |
| 组装机制 | 运行时勾选启用（插件模式） | 用户勾选 = 编辑 Profile，切换即时生效 |
| 模块来源 | 开放第三方贡献 | 规范开放，各执行 agent/第三方均可开发 |
| 分发渠道 | 中央插件市场，GitHub registry + Releases | 免费、版本管理天然；registry index 可控上架 |
| 安全模型 | MVP：权限声明 + 安装时授权；沙箱后迭代 | 对齐 DSH approval policy |
| 宿主壳 | 壳本身也是插件（一切皆插件） | 用户组装粒度 = 选壳 + 选工具 |
| 架构参考 | DeepSeek Harness「一切皆插件」（Cordis 微内核） | 只继承思想，不照搬 agent 领域概念 |
| 内核 | 渐进式自研极薄内核 | 只做加载/生命周期/services+events/依赖/profile；兼容性契约第一天定义 |

## 3. 总体架构

```
宿主（Electron 应用，随发布不可卸载）
│
├─ 内核（自研极薄，类比 Cordis 微内核）
│   ├─ 插件加载器：扫描、manifest 解析、代码加载
│   ├─ 生命周期：mount / unmount、可逆 effects（卸载自动清理注册）
│   ├─ services 注册表 + events 事件总线
│   ├─ 依赖解析（插件间依赖、拓扑排序）
│   └─ profile 配置引擎：启停组合、持久化、热重载、快照回滚
│
├─ 壳插件（= UI bundle，可替换，类比 dsh-web-app）
│   ├─ 主界面：导航、工具箱网格、插件管理页、设置
│   └─ 提供「容器 seam」：面板注册、入口注册、布局插槽
│
├─ 工具插件（第三方/官方）
│   └─ 面向容器 seam 注册，不感知具体壳实现
│
└─ 基础设施插件（第一方）
    ├─ 权限插件：权限声明解析 + 安装授权（approval policy）
    ├─ 存储插件：配置/插件数据持久化
    └─ 市场客户端：拉 registry、安装/卸载/更新

Profile（= 用户的专有工具箱）
  ├─ 命名组合：启用的插件 ID 列表 + 每插件配置
  ├─ 预置模板：极简壳 / 工作台壳 / 开发壳
  ├─ 可保存多个 profile、随时切换
  └─ 升级前自动快照，失败一键回滚
```

## 4. 核心设计

### 4.1 内核（自研，职责边界）

**只做四件事**：插件加载、生命周期与依赖、services/events、profile 配置。内核不渲染任何业务 UI、不实现任何工具能力。

**内核不做的事**：不实现业务功能、不绑定具体壳、不假设插件来源。

**规模预期**：核心 ≈ 2500~3000 行 TS，1 人 2~3 周；稳定性、兼容性契约、示例与文档是同等成本，不可省。

### 4.2 壳插件

- 壳是普通插件，只是**第一方、预置**，用户可替换。
- 随宿主内置一个**最小默认壳**（不可卸载的 fallback）：内核启动时加载用户配置的壳，失败/缺失则回退默认壳，保证用户永远进得去界面（安全模式）。
- 壳定义容器 seam（面板/入口/布局插槽），工具插件通过 seam 注册，不感知壳实现。

### 4.3 工具插件与容器 seam

- 工具插件 = manifest（plugin.json）+ 代码（Web 技术：TS/JS + HTML 渲染入口）。
- 工具插件**只面向宿主提供的容器 API** 注册（面板、入口、页面），换壳不破坏工具插件。
- 工具插件之间不直接引用，通过 services/events 协作。

### 4.4 Profile（专有工具箱）

- Profile = 命名组合：`{ 启用的插件 ID 列表, 每插件配置 }`，存储于用户数据目录。
- 用户勾选启用/禁用 = 修改当前 profile + 热重载（DSH 的 HMR 思路）。
- 预置模板（极简/工作台/开发）供用户起步，可复制修改。
- 升级内核/安装插件前自动快照 profile，失败可回滚。

### 4.5 兼容性契约（第一天定义）

原则：**插件不兼容源于 API 破坏性变更，不源于内核更新**。

1. 内核暴露给插件的 `ctx` API 独立版本号（当前 v1）。
2. 内核升级遵守 SemVer：主版本内只增不破，旧插件永远可用。
3. 插件 manifest 声明所需 `apiVersion` 范围（如 `^1.0`），加载时校验。
4. 校验失败 = 拒绝加载该插件 + 提示用户，**不影响其他插件**（失败隔离）。
5. 破坏性变更仅允许在新主版本发生，提供迁移期与新旧并存；配合 profile 快照回滚。

### 4.6 安全模型（MVP）

- 插件 manifest 声明所需权限（如 `files:read`、`network:fetch`、`clipboard:write`、`shell:exec`）。
- 安装/启用时向用户展示权限清单，用户可拒绝（approval policy）。
- 沙箱隔离（iframe/Worker/进程）列为后迭代项，进入插件规范 v2。

### 4.7 插件分发（GitHub registry）

```
registry 仓库（如 IsSheepBox/plugin-registry）
  └─ plugins.json      # 插件清单：id、名称、描述、作者、仓库地址、版本

每插件一个 GitHub 仓库
  └─ plugin.json       # manifest
  └─ Releases vX.Y.Z   # 打 zip 包（manifest + 代码 + 配置行）

宿主：启动拉 plugins.json → 展示市场 → 从 Releases 下载 zip
     → 解压到本地插件目录 → 校验 manifest/apiVersion → 注册、可勾选启用
```

- registry URL 可配置（支持镜像/自建）；GitHub 不可用时走本地缓存 + 手动导入兜底。

## 5. 插件规范 v1（草案）

`plugin.json` 字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 全局唯一，反向域名风格：`org.example.my-tool` |
| `name` | 是 | 展示名 |
| `version` | 是 | SemVer，插件自身版本 |
| `apiVersion` | 是 | 所需 ctx API 版本范围，如 `^1.0` |
| `description` | 否 | 描述 |
| `author` | 否 | 作者/组织 |
| `entry` | 是 | 代码入口（相对路径） |
| `ui` | 否 | UI 声明：`icon`、`panel`、`toolbox` 等 |
| `permissions` | 否 | 权限声明数组 |
| `requires` | 否 | 依赖的其他插件/服务及版本范围 |

规范正式版随 TASK-010 输出，含示例与校验规则。

## 6. MVP 范围与验收标准

MVP 目标：跑通「装插件 → 勾选启用 → 使用 → 卸载」全闭环。

| 组件 | 验收标准 |
|---|---|
| 工程脚手架 | monorepo（kernel/shell/market/示例插件），TS+Electron 可启动 |
| 内核·加载器 | 扫描本地插件目录、解析 manifest、加载入口 |
| 内核·生命周期 | mount/unmount 正确，卸载无残留（effects 回滚） |
| 内核·profile | 启停组合持久化、热重载、默认壳 fallback 启动 |
| 内核·兼容校验 | apiVersion 不匹配的插件被拒绝且不影响其他插件 |
| 壳插件·默认壳 | 工具箱网格、启停开关、插件管理页 |
| 市场客户端 | 拉 GitHub registry、安装/卸载/更新插件 |
| 权限授权 | 安装时展示权限清单，可拒绝 |
| 示例插件 ×3 | 验证规范：一个纯 UI、一个带权限、一个带服务 |
| 插件规范 v1 + registry | 规范文档、plugins.json 格式、registry 仓库初始化 |
| 打包发布 | Electron 打包产物可安装运行，含内置默认壳 |

## 7. 参考

- DeepSeek Harness（dsh）：https://github.com/deepseek-ai/deepseek-harness
- 官方架构文档：https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/HEAD/docs/architecture.md
- Cordis（微内核框架）：https://github.com/cordiverse/cordis
