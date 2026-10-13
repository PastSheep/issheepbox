# 版本策略（Version Policy）

Is Sheep Box 的 SemVer 演进规则与发布流程。

## 1. 版本号约定

项目内三类版本号独立演进：

| 版本号 | 语义 | 当前值 |
|---|---|---|
| **应用版本**（`apps/desktop`） | 整个 Electron 应用的对外版本 | `0.1.0`（预发布） |
| **内核 ctx API 版本**（`packages/kernel`） | 插件面向的 ctx 接口面，由 `CURRENT_API_VERSION` 导出 | `1.0.0` |
| **插件版本**（各插件包） | 单个插件的版本，遵循 SemVer | 各插件自管 |

## 2. 内核 ctx API 兼容性契约

对齐 `docs/requirements.md` 4.5 与 `docs/plugin-spec-v1.md` 第 10 节：

- **主版本号是兼容性边界**。MAJOR 不同 = 破坏性变更，旧插件必须拒绝加载。
- **1.x 生命周期内只增不破**：
  - 可以新增 ctx 接口方法、新增事件、新增服务
  - 不可以删除/重命名已有方法、不可以改变已有参数签名
  - minor / patch 升级不需要插件作者修改任何代码
- **破坏性变更只允许在新主版本发生**（如 2.0.0），且必须同时：
  - 提供迁移指南
  - 在过渡期内同时支持两个主版本（并行挂载）
  - 给出至少一个 minor 版本的弃用警告窗口

## 3. 应用版本发布

- 预发布阶段（0.x）：可以引入不向后兼容的变更，但必须在 CHANGELOG 标注。
- 1.0.0 之后：应用版本遵循 SemVer：
  - **MAJOR**：不兼容的内核 API 变更或用户工作流破坏性变更
  - **MINOR**：新功能、新插件、新 profile 能力，向后兼容
  - **PATCH**：bug 修复、安全补丁、文档更新

## 4. 插件版本

- 插件 manifest 中的 `version` 遵循 SemVer。
- 插件 manifest 中的 `apiVersion` 是 SemVer range（如 `^1.0.0`），声明该插件兼容的内核 ctx API 范围。
- 插件升级时：
  - 不兼容变更（删除导出、改变入口签名）→ major bump
  - 新增能力 → minor bump
  - bug 修复 → patch bump

## 5. 发布流程

1. **合并到 main**：所有功能通过 feature 分支 + PR 合入 main（永不直接 push main）。
2. **打 tag**：在 main 上打 `vX.Y.Z` tag（应用版本）。
3. **CI 构建**：tag 推送后，`.github/workflows/release.yml` 触发：
   - `pnpm install --frozen-lockfile`
   - `pnpm build`（编译所有包）
   - `pnpm --filter @issheepbox/desktop pack`（electron-builder 出 Windows NSIS 安装包）
   - 上传产物到 GitHub Release
4. **手动验证**：下载安装包，在干净环境安装启动，确认：
   - 默认壳正常加载
   - 内置插件（shell-default、approval-policy）自动展开到 userData/plugins
   - 无壳场景进入安全模式并提示
5. **公告**：在项目渠道发布 Release Notes，列出新插件、破坏性变更、已知问题。

## 6. 回滚策略

- 每次 profile 变更前自动快照（见 TASK-004）。
- 启动失败时，`apps/desktop/src/main.ts` 自动尝试从最新快照恢复并重试。
- 应用级回滚：用户可手动安装旧版本安装包；profile 数据保留在 userData，跨版本兼容。
