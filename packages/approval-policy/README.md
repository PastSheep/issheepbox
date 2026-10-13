# @issheepbox/approval-policy

第一方基础设施插件：**权限声明解析 + 安装授权（approval policy）**，对应 TASK-008。

插件（`plugin.json`：`org.issheepbox.approval-policy`）以普通插件形态挂载进内核，
不修改 `packages/kernel` 内部，只通过 **services / events** 与内核及其他插件协作。

## 职责

| 职责 | 说明 |
|---|---|
| 解析 `manifest.permissions` | 缺省（`undefined` / 非数组）一律按**空权限**处理（规范：未声明 = 没有） |
| 展示权限清单 | 安装/启用时把需授权权限（含中文名、用途、风险等级）交给 `ApprovalPrompter`（授权 UI）展示 |
| 用户可拒绝 | 拒绝（`deny`）后返回 `denied`，**插件不可启用**；拒绝记录持久化，避免反复弹窗 |
| 运行时校验 | 消费方通过 `checkPermission(pluginId, permission)` 判定某插件能否使用某权限 |
| 授权记录存储 | 定义抽象接口 `ApprovalStore`；本次交付最小内存实现 `MemoryApprovalStore` 跑通闭环 |

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
  → 无需授权（空权限 / 仅 storage:plugin）？→ 自动 granted（auto=true）
  → 需要授权 → ApprovalPrompter 展示权限清单
      ├─ grant-all        → 授予全部已知声明
      ├─ grant-subset     → 授予默认部分 + 勾选的需授权权限
      └─ deny             → 记录 denied，插件不可启用
  → 决策写入 ApprovalStore
```

## 存储接缝

`ApprovalStore` 是授权持久化的唯一接口（`src/storage.ts`）：

- 本次交付：`MemoryApprovalStore`（内存最小实现，进程内闭环）。
- 后续：由 profile 引擎（TASK-004）/ 宿主提供持久化实现（写入 profile 或用户数据目录），
  实现该接口后注入插件即可，引擎无需改动。

## 授权 UI 接缝

`ApprovalPrompter` 是展示权限清单与收集用户决策的唯一接口（`src/prompter.ts`）：

- 未注入时使用 `FailSafePrompter`：**无 UI 一律默认拒绝**（fail-safe，不静默放行），并记日志告警。
- 壳插件（TASK-006）接入真实授权 UI（对话框、二次确认）后，带权限的插件才能被正常授权启用。

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

// 注入授权 UI 与存储（未注入时：fail-safe 默认拒绝 + 内存存储）
const factory = createApprovalPolicyPlugin({ prompter, store });
```

## 范围与后续

- 本任务不修改 `packages/kernel` 内部（TASK-004 并行开发中）。
- `ctx.permissions`（插件侧运行时权限 API）由后续任务与内核维护方协调接入，
  当前通过 `approval-policy` 服务完成同样的判定能力。
