# @issheepbox/approval-policy

第一方基础设施插件：**权限声明解析 + 安装授权（approval policy）**，对应 TASK-008（授权引擎）与 TASK-015（磁盘持久化 + 默认接线 + 启动路径 source 语义）。

插件（`plugin.json`：`org.issheepbox.approval-policy`）以普通插件形态挂载进内核，
不修改 `packages/kernel` 内部，只通过 **services / events** 与内核及其他插件协作。

## 职责

| 职责 | 说明 |
|---|---|
| 解析 `manifest.permissions` | 缺省（`undefined` / 非数组）一律按**空权限**处理（规范：未声明 = 没有） |
| 展示权限清单 | 安装/启用时把需授权权限（含中文名、用途、风险等级）交给 `ApprovalPrompter`（授权 UI）展示 |
| 用户可拒绝 | 拒绝（`deny`）后返回 `denied`，**插件不可启用**；拒绝记录持久化，避免反复弹窗 |
| 运行时校验 | 消费方通过 `checkPermission(pluginId, permission)` 判定某插件能否使用某权限 |
| 授权记录存储 | 定义抽象接口 `ApprovalStore`；内置内存实现 `MemoryApprovalStore` 与磁盘实现 `DiskApprovalStore`（跨重启保留） |

## v1 权限集合

| 权限 | 展示名 | 风险 | 说明 |
|---|---|---|---|
| `files:read` | 读取文件 | medium | 读取用户选择/指定的文件与目录 |
| `files:write` | 写入文件 | high | 写入用户选择/指定的文件与目录 |
| `network:fetch` | 网络请求 | medium | 发起 HTTP/HTTPS 请求 |
| `clipboard:read` | 读取剪贴板 | low | 读取系统剪贴板 |
| `clipboard:write` | 写入剪贴板 | low | 写入系统剪贴板 |
| `shell:exec` | 执行系统命令 | high | 执行系统命令（**需二次确认**，UI 侧实现） |
| `storage:plugin` | 插件私有存储 | low | **默认授予**，无需声明、无需授权 |

- 未知权限一律**不授予**（fail-safe），仅记日志告警。
- `shell:exec` 的二次确认由授权 UI（`ApprovalPrompter` 实现方）负责，
  引擎通过 `PermissionInfo.requiresSecondaryConfirmation` 标记该权限。

## 服务契约

挂载后注册服务 **`approval-policy`**，消费方：

```ts
const approval = ctx.services.get<ApprovalPolicyService>('approval-policy');
```

| 方法 | 说明 |
|---|---|
| `requestApproval(request): Promise<ApprovalDecision>` | 请求一次授权；`granted` = 可启用，`denied` = 不可启用 |
| `requestApprovalForManifest(manifest, source?)` | 便捷入口：传入 `PluginManifest` 自动提取 permissions（缺省按空权限） |
| `checkPermission(pluginId, permission): boolean` | 运行时权限校验（`storage:plugin` 恒放行；其余需 granted 记录包含） |
| `isApproved(pluginId): boolean` | 是否已获授权 |
| `getGrantedPermissions(pluginId): string[]` | 实际授予的权限集合 |
| `hasDecision(pluginId): boolean` | 是否存在授权/拒绝记录 |
| `revoke(pluginId): void` | 撤销记录（卸载插件 / 用户重新申请前调用） |

## 事件契约

| 事件 | 方向 | 载荷 |
|---|---|---|
| `approval:requested` | 入（本插件订阅） | `{ pluginId, pluginName, permissions, source? }` |
| `approval:granted` | 出（本插件发布） | `{ pluginId, permissions, auto? }` |
| `approval:denied` | 出（本插件发布） | `{ pluginId, permissions, reason? }` |

**接入方（TASK-004 profile 引擎 / TASK-007 市场客户端 / TASK-006 壳）**：

```
安装/启用插件
  → 读取 manifest.permissions
  → 发布 approval:requested（或直接调用服务 requestApprovalForManifest）
  → 收到 approval:granted → 继续启用插件
  → 收到 approval:denied   → 中止启用插件，提示用户
```

授权流程（引擎内部）：

```
requestApproval
  → 归一化 permissions（缺省 = []，未知权限剔除并告警）
  → 已有授权覆盖全部声明？→ 自动复用（auto=true）
  → 已有拒绝记录？→ 维持 denied（先 revoke 再重新申请）
  → source ∈ {boot, restore, switchTo}（启动恢复路径）：仅查存储，不弹窗、不写记录
      ├─ 无权限需授权 → granted(auto) 直通
      └─ 其余情况     → denied(fail-safe)，reason 注明「启动路径未授权」
  → 无需授权（空权限 / 仅 storage:plugin）？→ 自动 granted（auto=true）
  → 需要授权 → ApprovalPrompter 展示权限清单
      ├─ grant-all        → 授予全部已知声明
      ├─ grant-subset     → 授予默认部分 + 勾选的需授权权限
      └─ deny             → 记录 denied，插件不可启用
  → 决策写入 ApprovalStore
```

## 启动路径 source 语义（C2 契约）

`requestApproval` / `requestApprovalForManifest` 的 `source` 标注请求来源：

| source | 语义 |
|---|---|
| `boot` / `restore` / `switchTo` | **启动恢复路径**（内核 ProfileEngine 调起）：仅查存储——granted 记录覆盖全部声明 → 自动 granted；denied 记录 → 复用原因维持拒绝；无记录（或 granted 未覆盖）→ denied（fail-safe，不弹窗）。**绝不写记录**：避免把用户尚未决策的插件永久锁死。 |
| `install` / `enable` / 缺省 | 显式决策路径：维持完整流程——granted 覆盖自动复用、denied 记录复用不重复弹窗、需授权则经 prompter 弹窗、决策写存储。 |

## 存储接缝与默认接线（C3 契约）

`ApprovalStore` 是授权持久化的唯一接口（`src/storage.ts`），两种内置实现：

- `MemoryApprovalStore`：进程内内存，跨重启丢失。
- `DiskApprovalStore`（`src/storage-disk.ts`）：`<dir>/approvals.json` 持久化。
  构造时加载既有记录（文件缺失 = 空；损坏/非法 JSON → 视为空并 `logger.warn`，不崩溃）；
  set/delete 立即落盘，**原子写**（写同目录唯一临时文件后 `rename` 覆盖，中断不产生半写正式文件）；
  记录按 pluginId 排序写出，内容确定可复现。

`createApprovalPolicyPlugin()` 默认接线（显式 `options.store` 始终优先）：

- 挂载时经 `ctx.services` 查宿主服务 **`host:user-data`**（形状 `{ dir: string }`，desktop 注册）：
  存在 → `DiskApprovalStore(dir)`；形状非法 → warn 回退内存；不存在 → `MemoryApprovalStore`。

## 授权 UI 接缝与默认接线（C1 契约）

`ApprovalPrompter` 是展示权限清单与收集用户决策的唯一接口（`src/prompter.ts`）：

- `FailSafePrompter`：无 UI 时**一律默认拒绝**（fail-safe，不静默放行），并记日志告警。
- `createApprovalPolicyPlugin()` 默认接线（显式 `options.prompter` 始终优先）：
  返回一个**懒解析代理**——每次需要弹窗时现查 `ctx.services` 的 **`approval-ui`** 服务
  （壳 shell-default 注册，形状 = `ApprovalPrompter`），有则用之，无则 `FailSafePrompter`。
  不缓存、不依赖插件挂载顺序：壳后于本插件挂载时，下一次弹窗即自动用上。

## 构建与测试

```powershell
# 依赖安装（根目录）
pnpm install

# 类型检查 + lint（必须 exit 0，先验证后提交）
pnpm run typecheck
pnpm run lint

# 本包测试（先 typecheck 以产出 kernel dist，测试经公开 API 挂载内核）
pnpm --filter @issheepbox/approval-policy test
```

## 挂载方式

作为普通插件由内核加载器扫描（`plugin.json` entry 指向 `dist/index.js`）；
也可在代码中直接使用工厂：

```ts
import { createApprovalPolicyPlugin } from '@issheepbox/approval-policy';

// 未注入时自动接线：
//  - store：宿主提供 host:user-data → DiskApprovalStore(dir)，否则 MemoryApprovalStore
//  - prompter：每次弹窗现查 approval-ui 服务，无则 FailSafePrompter
const factory = createApprovalPolicyPlugin({ prompter, store });
```

## 范围与后续

- 本任务不修改 `packages/kernel` 内部；启动门禁的 kernel 侧调用（boot/restore/switchTo
  调 `requestApprovalForManifest(manifest, source)`）由 TASK-013 实现。
- `ctx.permissions`（插件侧运行时权限 API）由后续任务与内核维护方协调接入，
  当前通过 `approval-policy` 服务完成同样的判定能力。
- `DiskApprovalStore` v1 不做文件锁（桌面单进程模型足够）；多实例并发写同一文件时
  后写胜出，后续如需可再加锁。
