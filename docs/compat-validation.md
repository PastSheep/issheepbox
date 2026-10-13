# 兼容性校验策略（Compat Validation）

> **对应任务**：TASK-005  
> **适用范围**：内核插件加载流程的兼容性校验与失败隔离  
> **关联文档**：[requirements.md 4.5](requirements.md)、[plugin-spec-v1.md 第 10 节](plugin-spec-v1.md)

---

## 1. 设计目标

**原则：插件不兼容源于 API 破坏性变更，不源于内核更新。**

- 插件声明它需要的 ctx API 版本范围（SemVer range）
- 内核加载时用当前 ctx API 具体版本与该范围比对
- 不匹配 = 拒绝加载该插件 + 可读原因
- **失败隔离**：任何单插件校验失败不影响宿主与其他插件

---

## 2. 校验流程

内核 `PluginLoader` 加载每个插件时按以下顺序逐项校验，**任一失败即拒绝该插件**，错误记录到 `failures` 数组，继续处理下一个插件。

```
扫描插件目录
  └─ 遍历每个子目录
       ├─ ① 检查 plugin.json 是否存在
       ├─ ② 解析 plugin.json 为 JSON 对象
       ├─ ③ 字段级校验（必填字段、id 格式、version SemVer、entry 路径安全）
       ├─ ④ apiVersion 兼容性校验（SemVer range vs 当前内核版本）  ← TASK-005 新增
       ├─ ⑤ 检查 entry 入口文件存在
       ├─ ⑥ require() 加载入口模块（捕获异常）
       └─ ⑦ 检查模块 default 导出是工厂函数
```

### 2.1 校验项明细

| # | 校验项 | 失败错误示例 | 实现位置 |
|---|---|---|---|
| 1 | plugin.json 存在 | `/path: 缺少 plugin.json` | `loader/index.ts` |
| 2 | plugin.json 是合法 JSON | `/path: plugin.json 不是合法 JSON: ...` | `loader/index.ts` |
| 3 | 必填字段齐全（id/name/version/apiVersion/entry） | `/path: 缺少必填字段 "id"` | `manifest.ts` |
| 4 | id 反向域名格式 | `/path: id "bad id" 不符合反向域名格式` | `manifest.ts` |
| 5 | version 是合法 SemVer | `/path: version "abc" 不是合法 SemVer` | `manifest.ts` |
| 6 | entry 路径安全（包内相对路径） | `/path: entry "../escape.js" 必须是包内相对路径` | `manifest.ts` |
| 7 | **apiVersion 是合法 SemVer range** | `/path: apiVersion "garbage" 不是合法的 SemVer 范围` | `compat.ts` |
| 8 | **apiVersion range 与当前内核版本兼容** | `/path: apiVersion 范围 "^2.0.0" 与当前内核 ctx API 版本 1.0.0 不兼容` | `compat.ts` |
| 9 | entry 文件存在于包内 | `/path: 入口文件不存在: index.js` | `loader/index.ts` |
| 10 | 入口模块能成功 require | `/path: 入口模块加载失败: ...` | `loader/index.ts` |
| 11 | 入口模块 default 导出是函数 | `/path: 入口模块必须 export default 一个工厂函数` | `loader/index.ts` |

---

## 3. SemVer 版本约定

### 3.1 版本号角色

| 角色 | 含义 | 示例 | 来源 |
|---|---|---|---|
| **内核当前版本** | 具体 SemVer 版本号 | `1.0.0` | `compat.ts` → `CURRENT_API_VERSION` |
| **插件声明范围** | SemVer range | `^1.0.0` | `plugin.json` → `apiVersion` |

### 3.2 兼容性规则

- **主版本号不同 = 不兼容**：插件声明 `^2.0.0` 而内核是 `1.0.0` → 拒绝加载
- **同主版本内 = 兼容**：插件声明 `^1.0.0`，内核升级到 `1.5.0` → 仍兼容（只增不破）
- **patch 升级 = 完全兼容**：内核从 `1.0.0` 到 `1.0.1` → 所有 v1 插件无需修改

### 3.3 支持的 range 语法

使用 [`semver`](https://www.npmjs.com/package/semver) 库解析，支持标准 npm SemVer range 语法：

- **Caret ranges**：`^1.0.0`（兼容 1.x.x，不破坏）
- **Tilde ranges**：`~1.2.0`（兼容 1.2.x）
- **比较符**：`>=1.0.0`、`<2.0.0`、`=1.0.0`
- **连字符范围**：`1.0.0 - 2.0.0`
- **X-ranges**：`1.x`、`1.2.x`、`*`
- **联合范围**：`>=1.0.0 <2.0.0 || >=3.0.0`

> **推荐**：v1 插件一律声明 `^1.0.0`。

---

## 4. 失败隔离机制

### 4.1 核心保证

**单个插件的任何加载阶段失败，都不会影响：**
- 宿主内核的正常运行
- 其他插件的加载与运行
- 已成功加载插件的状态

### 4.2 实现方式

1. **逐个尝试**：`loadAll()` 遍历每个插件目录，调用 `tryLoad(dir)` 独立处理
2. **try/catch 包裹**：每个可能抛异常的步骤（文件读取、JSON 解析、require）都被捕获
3. **结构化错误收集**：失败的插件进入 `failures: PluginLoadFailure[]`，包含目录路径与可读错误列表
4. **加载结果分离**：`{ loaded: [...], failures: [...] }` — 成功与失败互不干扰

### 4.3 错误信息设计

- 每条错误以插件目录路径为前缀，便于定位
- 错误信息面向用户可读，不暴露内部堆栈
- 一条插件可能有多条错误（如缺多个字段时全部列出）

---

## 5. 版本演进策略

### 5.1 内核升级流程

| 变更类型 | 内核版本变化 | 对插件的影响 |
|---|---|---|
| Bug 修复 / 内部优化 | PATCH 升级（1.0.0 → 1.0.1） | 无影响，所有插件继续可用 |
| 新增 API 方法 / 事件 | MINOR 升级（1.0.0 → 1.1.0） | 旧插件继续可用，新插件可声明 `^1.1.0` 使用新功能 |
| 破坏 API（删方法/改签名） | MAJOR 升级（1.x → 2.0.0） | v1 插件全部拒绝加载，需迁移到 v2 |

### 5.2 主版本并存（远期规划）

破坏性变更到 v2 时：
- v2 内核同时支持 v1 和 v2 插件（过渡期）
- v1 插件用 v1 ctx API 加载，v2 插件用 v2 ctx API 加载
- 过渡期结束后移除 v1 支持

---

## 6. 测试覆盖

校验规则的单元测试位于 `packages/kernel/src/__tests__/`：

| 测试文件 | 覆盖范围 |
|---|---|
| `compat.test.ts` | apiVersion range 格式校验、兼容性比对、边界场景 |
| `manifest.test.ts` | manifest 字段级校验（必填、id 格式、version、entry 路径） |
| `loader.test.ts` | 失败隔离：混合正常/异常插件、各失败场景、全部失败不崩溃 |

运行测试：
```bash
cd packages/kernel
pnpm test
```
