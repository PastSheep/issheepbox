# Is Sheep Box 插件规范 v1

> **版本**：v1.0.0-draft  
> **状态**：规范先行（草案正式版），ctx API 细节待 TASK-002 定稿后修订  
> **适用范围**：所有第三方插件开发者、第一方插件开发者、内核实现者  
> **最后更新**：2026-10-13

本文档是 Is Sheep Box（以下简称 ISB）插件开发的唯一权威规范。一个第三方开发者仅依赖本文档即可从零开发出合规插件，无需与项目维护者额外沟通。

---

## 目录

1. [概述](#1-概述)
2. [插件目录结构](#2-插件目录结构)
3. [Manifest：plugin.json](#3-manifestpluginjson)
4. [入口代码与 ctx API](#4-入口代码与-ctx-api)
5. [生命周期](#5-生命周期)
6. [容器 seam 与 UI 注册](#6-容器-seam-与-ui-注册)
7. [权限声明](#7-权限声明)
8. [插件间依赖与协作](#8-插件间依赖与协作)
9. [构建、打包与发布](#9-构建打包与发布)
10. [校验规则汇总](#10-校验规则汇总)
11. [完整示例：一个便签插件](#11-完整示例一个便签插件)
12. [版本与兼容性承诺](#12-版本与兼容性承诺)

---

## 1. 概述

ISB 采用「一切皆插件」的微内核架构：

- **内核**只做四件事：插件加载、生命周期、services/events、profile 配置。
- **壳插件**提供 UI 容器与布局插槽，是可替换的第一方插件。
- **工具插件**面向容器 seam 注册功能，不感知具体壳实现。
- **插件之间不直接引用**，通过 services（请求/响应）和 events（发布/订阅）协作。

一个 ISB 插件 = 一个 `plugin.json` manifest + 一段 Web 技术编写的入口代码 + 静态资源。

### 1.1 设计原则

| 原则 | 含义 |
|---|---|
| **规范先行** | manifest 与 ctx API 契约在编码前定稿，插件开发者可离线开发 |
| **失败隔离** | 单个插件加载/运行失败不影响其他插件，更不影响宿主 |
| **可逆 effects** | 插件注册的一切（服务、事件监听、UI 入口）在卸载时自动回滚 |
| **声明式权限** | 权限在 manifest 中声明，安装时用户授权，不允许运行时动态索取 |
| **SemVer 严格** | 插件版本与 ctx API 版本均遵守 SemVer，破坏性变更只在主版本号 |

---

## 2. 插件目录结构

一个插件在源码仓库中的推荐布局：

```
my-note-plugin/
├── plugin.json          # （必填）manifest
├── package.json         # （可选）npm 工程配置
├── tsconfig.json        # （可选）TypeScript 配置
├── src/
│   └── index.ts         # （必填）入口源码，构建后产物对应 manifest.entry
├── assets/
│   ├── icon.png         # （可选）插件图标
│   └── panel.html       # （可选）面板模板/静态资源
├── dist/                # （构建产物目录，不入库）
│   ├── index.js         #   构建后的入口文件
│   └── assets/          #   构建后的静态资源
└── README.md
```

**发布时的插件包结构**（zip 解压后的样子）：

```
my-note-plugin/
├── plugin.json          # manifest（必须在包根目录）
├── index.js             # 入口代码（路径对应 manifest.entry）
└── assets/
    ├── icon.png
    └── panel.html
```

**硬约束**：
- `plugin.json` 必须在包根目录，不能嵌套。
- `entry` 字段指向的入口文件必须存在于包内，路径为相对包根的相对路径。
- 包内所有路径使用正斜杠 `/`，Windows 也不例外。

---

## 3. Manifest：plugin.json

`plugin.json` 是插件的唯一声明文件。以下为 v1 完整字段定义。

### 3.1 字段总览

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `id` | string | ✅ | — | 全局唯一插件 ID，反向域名风格 |
| `name` | string | ✅ | — | 展示名（用户可见） |
| `version` | string | ✅ | — | 插件自身版本，SemVer 格式 |
| `apiVersion` | string | ✅ | — | 所需 ctx API 版本范围，SemVer range |
| `description` | string | ❌ | `""` | 一句话描述 |
| `author` | string | ❌ | `""` | 作者或组织名 |
| `homepage` | string | ❌ | — | 项目主页 URL |
| `repository` | string | ❌ | — | 源码仓库 URL |
| `license` | string | ❌ | `"MIT"` | 开源协议（SPDX 标识符） |
| `entry` | string | ✅ | — | 入口代码相对路径，如 `index.js` |
| `icon` | string | ❌ | — | 图标相对路径，如 `assets/icon.png` |
| `ui` | object | ❌ | 见下 | UI 注册声明（面板、工具箱入口等） |
| `permissions` | string[] | ❌ | `[]` | 所需权限列表 |
| `requires` | object | ❌ | `{}` | 依赖的其他插件/服务及版本范围 |
| `contributes` | object | ❌ | `{}` | 向内核/其他插件贡献的服务与事件声明 |

### 3.2 字段详细说明

#### `id`

- **格式**：反向域名风格，全小写，点号分隔。
- **规则**：`[a-z][a-z0-9]*(\.[a-z0-9]+)+`，至少两级（如 `com.example.my-tool`）。
- **唯一性**：全局唯一，registry 中不得重复。同名插件以后来者为准被拒绝上架。
- **示例**：
  - `org.issheepbox.note`
  - `com.github.someuser.json-formatter`

#### `version`

- **格式**：严格 SemVer `MAJOR.MINOR.PATCH`，如 `1.2.3`。
- **规则**：不得带 `v` 前缀，不得用 `latest`。
- **语义**：
  - PATCH：内部修复，不影响 manifest、ctx 调用面
  - MINOR：新增功能，向后兼容
  - MAJOR：破坏性变更（manifest 字段变更、权限新增、ctx 调用方式变化）

#### `apiVersion`

- **格式**：SemVer range，如 `^1.0.0`、`~1.2`、`>=1.0 <2.0`。
- **语义**：声明本插件兼容的 ctx API 主版本范围。内核加载时校验。
- **推荐**：v1 插件一律写 `^1.0.0`。
- **⚠️ 待对齐**：具体 ctx API v1 的版本号与可用接口集合，待 TASK-002 内核定稿后补充。当前按 `^1.0.0` 占位。

#### `entry`

- **格式**：相对包根的文件路径，正斜杠分隔。
- **规则**：指向一个 JS 模块文件。该模块必须 `export default` 一个**插件主函数**（见第 4 节）。

#### `icon`

- **格式**：相对包根的图片路径。
- **推荐**：PNG，尺寸 128×128，透明背景。

#### `ui`

声明插件向壳注册的 UI 入口。所有字段均可选。

```jsonc
{
  "ui": {
    "toolbox": {
      "label": "便签",           // 工具箱网格中显示的名称
      "icon": "assets/icon.png", // 覆盖 manifest 顶层 icon
      "defaultOpen": "panel"     // 点击后打开什么：panel / window / command
    },
    "panels": [
      {
        "id": "note-main",       // 面板唯一 ID（插件内唯一即可）
        "title": "我的便签",     // 面板标题
        "src": "assets/panel.html", // 面板内容（HTML 文件路径或内联）
        "width": 400,            // 建议宽度 px
        "height": 300            // 建议高度 px
      }
    ],
    "commands": [
      {
        "id": "note-new",
        "label": "新建便签",
        "shortcut": "CmdOrCtrl+N" // 可选快捷键
      }
    ]
  }
}
```

**说明**：
- `toolbox`：是否在主界面工具箱网格显示入口。不写则插件不在工具箱出现（纯后台服务型插件）。
- `panels`：可注册多个面板。壳决定面板展示位置（侧栏、标签页、模态等）。
- `commands`：可被命令面板或其他插件触发的命令。命令的实际行为在入口代码中通过 `ctx.commands.register` 绑定。

#### `permissions`

字符串数组，声明插件运行所需权限。安装/启用时内核会向用户展示并请求授权。

v1 预定义权限清单：

| 权限 | 含义 |
|---|---|
| `files:read` | 读取用户选择的文件/目录 |
| `files:write` | 写入用户选择的文件/目录 |
| `network:fetch` | 发起 HTTP/HTTPS 请求 |
| `clipboard:read` | 读取系统剪贴板 |
| `clipboard:write` | 写入系统剪贴板 |
| `shell:exec` | 执行系统命令（高危，需二次确认） |
| `storage:plugin` | 读写插件私有存储（默认授予，无需声明） |

**规则**：
- 未声明 = 没有。运行时越权调用会被内核拒绝。
- 权限粒度后续版本可能细分（如 `network:fetch:https://api.example.com`），v1 先粗粒度。
- `shell:exec` 为高危权限，用户拒绝率高，非必要不声明。

#### `requires`

声明插件依赖的其他插件或服务。键为依赖项 ID，值为 SemVer range。

```jsonc
{
  "requires": {
    "org.issheepbox.theme-service": "^1.0.0",
    "org.issheepbox.storage": "^1.0.0"
  }
}
```

**规则**：
- 键可以是插件 ID，也可以是内核内置服务名（如 `service:storage`）。
- 加载时内核做拓扑排序，依赖缺失或版本不满足则拒绝加载本插件。
- 不允许循环依赖。

#### `contributes`

声明本插件向内核/其他插件贡献的服务与事件（供其他插件依赖时参考）。

```jsonc
{
  "contributes": {
    "services": [
      {
        "name": "theme",          // 服务名
        "version": "1.0.0",       // 服务语义化版本
        "description": "主题切换服务"
      }
    ],
    "events": [
      {
        "name": "theme.changed",  // 事件名
        "description": "主题变更时触发"
      }
    ]
  }
}
```

**说明**：
- `contributes` 是声明式文档，不做强制校验。其他插件通过 `requires` 依赖本插件后，用 `ctx.services.get('theme')` 获取服务实例。

### 3.3 完整 manifest 示例

```json
{
  "id": "org.example.note",
  "name": "便签",
  "version": "1.0.0",
  "apiVersion": "^1.0.0",
  "description": "一个简洁的桌面便签工具",
  "author": "Example Developer",
  "homepage": "https://example.com/note",
  "repository": "https://github.com/example/note",
  "license": "MIT",
  "entry": "index.js",
  "icon": "assets/icon.png",
  "ui": {
    "toolbox": {
      "label": "便签",
      "defaultOpen": "panel"
    },
    "panels": [
      {
        "id": "note-main",
        "title": "我的便签",
        "src": "assets/panel.html",
        "width": 400,
        "height": 300
      }
    ]
  },
  "permissions": ["storage:plugin"],
  "requires": {},
  "contributes": {}
}
```

---

## 4. 入口代码与 ctx API

### 4.1 入口函数签名

插件入口是一个默认导出的异步函数，接收 `ctx` 参数：

```typescript
// src/index.ts
export default async function main(ctx: PluginContext): Promise<void> {
  // 插件启动逻辑
  ctx.logger.info('便签插件已启动');

  // 注册命令
  ctx.commands.register('note-new', () => {
    ctx.panels.open('note-main');
  });

  // 监听事件
  ctx.events.on('app:started', () => {
    ctx.logger.info('应用已启动，便签就绪');
  });
}
```

**关键约定**：
- 函数可以是 async，内核会等待它 resolve 后才认为插件「启动完成」。
- 函数内注册的一切（命令、事件监听、UI 入口）在插件卸载时由内核**自动回滚**，插件代码无需手动清理。
- 插件运行在隔离的 JS 上下文，不能访问宿主的 `window` / `document` / `require` 等全局对象，一切通过 `ctx` 通信。

### 4.2 ctx API 概览

> **⚠️ 待对齐（TASK-002）**  
> 以下为 v1 预期接口面，具体方法签名、事件名、服务名以 TASK-002 输出的 `ctx.d.ts` 类型定义为准。本节列出的接口清单用于规范先行，插件开发者可先据此设计，待类型定义发布后做最终对齐。

| 命名空间 | 用途 | 主要方法 |
|---|---|---|
| `ctx.logger` | 日志 | `info()`, `warn()`, `error()`, `debug()` |
| `ctx.events` | 事件总线（发布/订阅） | `on()`, `off()`, `emit()` |
| `ctx.services` | 服务注册表（请求/响应） | `register()`, `get()`, `has()` |
| `ctx.commands` | 命令注册 | `register()`, `execute()` |
| `ctx.panels` | 面板操作（壳提供） | `open()`, `close()`, `setTitle()` |
| `ctx.storage` | 插件私有存储 | `get()`, `set()`, `delete()` |
| `ctx.config` | 插件配置（用户可改的设置项） | `get()`, `set()`, `defineSchema()` |
| `ctx.permissions` | 权限查询 | `has()`, `request()` |
| `ctx.ui` | 动态 UI 能力（对话框、消息提示等） | `showMessage()`, `showConfirm()`, `showInput()` |

**事件命名规范**：`命名空间:动作`，如 `app:started`、`app:will-unmount`、`theme:changed`。  
**服务命名规范**：小写字母与连字符，如 `theme`、`storage`、`clipboard`。

---

## 5. 生命周期

### 5.1 阶段

| 阶段 | 触发时机 | 插件可做什么 |
|---|---|---|
| **load** | 内核加载 manifest、校验通过后 | 只读操作，不宜有副作用 |
| **mount** | 调用入口函数 `main(ctx)` | 注册命令、服务、事件监听、UI |
| **start** | mount 完成后，插件进入运行态 | 开始响应事件、处理用户操作 |
| **stop** | 用户禁用插件 / 卸载前 | 可做收尾（但 effects 由内核自动回滚） |
| **unmount** | 完全卸载，资源释放 | — |

### 5.2 可逆 effects（自动回滚）

插件在 `mount` 阶段通过 `ctx` 注册的一切，都被内核记录为「effect」。卸载时内核自动撤销：

- `ctx.events.on()` → 自动 `off()`
- `ctx.services.register()` → 自动注销服务
- `ctx.commands.register()` → 自动注销命令
- `ctx.panels.open()` 注册的面板 → 自动关闭

**插件开发者无需写 cleanup 函数**。这是 v1 的硬约定，也是与 Cordis/DSH 的重要区别——简化插件代码的同时保证卸载干净。

---

## 6. 容器 seam 与 UI 注册

### 6.1 什么是容器 seam

壳插件（如默认壳）定义了一组 UI 插槽（seam）：面板区域、工具箱网格、命令面板、状态栏等。工具插件**不直接操作 DOM**，而是通过 `ctx.panels`、`ctx.commands` 等 API 向 seam 注册自己的功能入口。

### 6.2 面板（Panels）

面板是插件的主要 UI 载体。

- 面板内容可以是：
  - 一个 HTML 文件路径（manifest `ui.panels[].src` 指向）
  - 或运行时通过 `ctx.panels.setContent(id, htmlString)` 设置
- 面板在隔离的 webview 中渲染，与壳、其他插件隔离。
- 面板内的 JS 与插件主上下文通过约定消息协议通信（v1 简化：面板可直接调用 `ctx` 子集）。

### 6.3 工具箱入口（Toolbox）

在 manifest `ui.toolbox` 中声明后，插件图标与标签会出现在主界面工具箱网格中。用户点击后按 `defaultOpen` 行为响应。

### 6.4 命令（Commands）

命令是可被命令面板、快捷键、其他插件触发的动作。插件在 `main()` 中通过 `ctx.commands.register(id, handler)` 绑定实际行为。

---

## 7. 权限声明

### 7.1 权限工作流

```
插件安装/启用
  → 内核读取 manifest.permissions
  → 向用户展示权限清单与用途说明
  → 用户全部授权 / 部分拒绝 / 全部拒绝
  → 授权结果持久化到 profile
  → 插件运行时，ctx 调用受权限约束
```

### 7.2 权限最佳实践

- **最小权限原则**：只声明插件确实需要的权限。
- **默认无权限**：不写 `permissions` 字段 = 纯 UI 插件，只能用 `storage:plugin` 私有存储。
- **高危权限慎重**：`shell:exec`、`files:write` 等权限会显著降低用户信任，能用更细粒度方案就不用粗粒度。

---

## 8. 插件间依赖与协作

### 8.1 不直接引用

插件 A 不能 `import` 插件 B 的代码。这是硬约束，保证：
- 插件可独立安装/卸载，不破坏其他插件。
- 换壳不影响工具插件。
- 依赖关系在 manifest 中显式声明，可被内核解析与校验。

### 8.2 协作方式

| 方式 | 场景 | API |
|---|---|---|
| **Services** | 插件 A 提供能力，插件 B 调用（请求/响应） | `ctx.services.register()` / `ctx.services.get()` |
| **Events** | 一对多广播状态变化 | `ctx.events.emit()` / `ctx.events.on()` |
| **Commands** | 触发其他插件的动作 | `ctx.commands.execute(id)` |

---

## 9. 构建、打包与发布

### 9.1 构建

- 插件使用任意构建工具（esbuild / rollup / webpack / tsc）。
- 构建产物必须满足：
  - 输出单个或多个 JS 文件（路径与 manifest `entry` 一致）。
  - 静态资源（HTML、CSS、图片）一并输出到 `dist/assets/`。
  - 不允许打包 Node.js 内置模块（`fs`、`path` 等）——插件运行在 webview 沙箱中。

### 9.2 打包

发布物为 zip 包，解压后结构：

```
plugin-name-x.y.z.zip
├── plugin.json
├── index.js
└── assets/
    └── ...
```

**规则**：
- zip 根目录直接是文件，**不要套一层文件夹**。
- 文件名推荐 `<plugin-id>-<version>.zip`。
- 大小建议 < 5 MB（不含大资源）。

### 9.3 发布到 registry

1. 在 GitHub 创建插件仓库，推送源码与 manifest。
2. 打 Git tag `vX.Y.Z`，在 GitHub Releases 上传 zip 包。
3. 向 registry 仓库提交 PR：在 `plugins.json` 中追加本插件条目。
4. registry 维护者审核（manifest 合规、权限合理）后合并，即上架。

> **registry 仓库地址**：⚠️ 待需求方提供 GitHub 组织/仓库信息后补充。见 TASKS.md 中 TASK-010 的待办备注。

---

## 10. 校验规则汇总

内核加载插件时按以下顺序校验，任一失败即拒绝加载该插件：

| # | 校验项 | 失败表现 |
|---|---|---|
| 1 | `plugin.json` 存在且为合法 JSON | 拒绝，日志报错 |
| 2 | 必填字段齐全：`id` / `name` / `version` / `apiVersion` / `entry` | 拒绝，提示缺哪个字段 |
| 3 | `id` 格式合规（反向域名） | 拒绝 |
| 4 | `version` 是合法 SemVer | 拒绝 |
| 5 | `apiVersion` range 与当前内核 ctx 主版本兼容 | 拒绝，提示版本不匹配 |
| 6 | `entry` 指向的文件存在于包内 | 拒绝 |
| 7 | `requires` 中所有依赖插件已安装且版本满足 | 拒绝，提示缺哪个依赖 |
| 8 | 依赖图无环 | 拒绝 |
| 9 | 入口模块能成功加载并 resolve `main()` | 拒绝，不影响其他插件 |

**失败隔离**：以上任何一条失败，仅该插件被禁用，宿主与其他插件正常运行。

---

## 11. 完整示例：一个便签插件

以下是一个可直接运行的最小插件示例，覆盖 manifest、入口代码、面板 HTML。

### 11.1 目录结构

```
note-plugin/
├── plugin.json
├── src/
│   └── index.ts
└── panel/
    └── note.html
```

### 11.2 plugin.json

```json
{
  "id": "org.example.note",
  "name": "便签",
  "version": "1.0.0",
  "apiVersion": "^1.0.0",
  "description": "简单的桌面便签",
  "author": "Example Dev",
  "license": "MIT",
  "entry": "index.js",
  "ui": {
    "toolbox": {
      "label": "便签",
      "defaultOpen": "panel"
    },
    "panels": [
      {
        "id": "note-main",
        "title": "我的便签",
        "src": "panel/note.html",
        "width": 360,
        "height": 240
      }
    ]
  },
  "permissions": ["storage:plugin"]
}
```

### 11.3 src/index.ts

```typescript
export default async function main(ctx: any) {
  // 读取已保存的便签内容
  const saved = await ctx.storage.get('content') ?? '';

  // 注册「新建便签」命令
  ctx.commands.register('note-new', async () => {
    await ctx.panels.open('note-main');
    // 通知面板渲染最新内容
    ctx.events.emit('note:render', { content: saved });
  });

  // 监听面板内发来的「内容更新」消息
  ctx.events.on('note:content-updated', async (content: string) => {
    await ctx.storage.set('content', content);
    ctx.logger.info('便签已保存');
  });

  ctx.logger.info('便签插件 v1.0.0 已启动');
}
```

### 11.4 panel/note.html

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; font-family: system-ui; }
    textarea {
      width: 100%; height: 100vh; border: none; outline: none;
      padding: 12px; box-sizing: border-box; font-size: 14px;
      background: #fff8dc; resize: none;
    }
  </style>
</head>
<body>
  <textarea id="note" placeholder="写点什么..."></textarea>
  <script>
    // 面板内通过 ctx 子集与主上下文通信
    const ta = document.getElementById('note');

    // 接收主上下文发来的渲染事件
    ctx.events.on('note:render', ({ content }) => {
      ta.value = content;
    });

    // 输入时通知主上下文保存
    let timer;
    ta.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        ctx.events.emit('note:content-updated', ta.value);
      }, 500);
    });
  </script>
</body>
</html>
```

### 11.5 构建后产物（zip 内容）

```
org.example.note-1.0.0.zip
├── plugin.json
├── index.js          # ts 编译产物
└── panel/
    └── note.html
```

---

## 12. 版本与兼容性承诺

### 12.1 ISB 对插件开发者的承诺

1. **ctx API v1** 在 1.x 生命周期内**只增不破**：新增方法、新增事件，但不删除、不改变已有方法签名。
2. 内核升级（Electron、壳、其他插件）不会破坏已合规的 v1 插件。
3. 破坏性变更仅在 ctx API v2 发生，且提供迁移期与新旧并存方案。

### 12.2 插件开发者对 ISB 的责任

1. 在 manifest 中如实声明 `apiVersion`、`permissions`、`requires`。
2. 遵守 SemVer：破坏性变更必须升 MAJOR 版本。
3. 不绕过权限沙箱，不尝试访问宿主全局对象。

### 12.3 规范修订

- 本规范随 TASK-002（ctx API 定稿）、TASK-009（示例插件验证）迭代修订。
- 修订记录见 git history。重大变更会在文档头部标注版本与变更摘要。

---

> **下一步**：  
> - TASK-002 完成后，补充第 4.2 节 ctx API 完整方法签名与类型定义链接。  
> - TASK-009 示例插件验证后，根据实际开发体验修订本文档。  
> - registry 仓库地址确定后，补充第 9.3 节发布流程中的具体仓库链接。
