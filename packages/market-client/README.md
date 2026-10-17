# @issheepbox/market-client

Is Sheep Box 插件市场客户端（TASK-007 拉取/解析/查询；TASK-012 安装/卸载/更新；
v3 多源模型：format 2 索引 + 单插件订阅 + 本地导入 + zip sha256 强校验）。

按 [docs/plugin-registry-schema.md](../../docs/plugin-registry-schema.md)（registry index 格式
v1，draft-07 JSON Schema）拉取并解析 `plugins.json`，提供插件列表与过滤查询；非法条目容错。
TASK-012 起落地 install/uninstall/update：下载 zip → 完整性校验 → 解压到 pluginsDir
（构造选项注入），错误一律为带 `code` 的 `MarketInstallError`。本包不 import
`@issheepbox/kernel` 运行时（loader/profile），插件发现/授权门禁由宿主（desktop/内核）接线。

v3（v4 市场架构定稿落地，见 docs/ 下市场设计 v4）：市场从"单 registry 索引"升级为
**多源模型**——任何发现渠道（组织级索引源 `index` / 单插件仓库订阅 `plugin-repo` / 本地
zip 一次性导入）最终产出统一的 `PluginRecord`（format 2）记录列表；同插件出现在多个源时
**不自动选源**，聚合层分组暴露冲突，由 UI 并列展示、安装时用户选择。

## 用法

```ts
import { MarketClient } from '@issheepbox/market-client';

const client = new MarketClient({
  // v3 多源：显式声明源（index 源指向 index.json，plugin-repo 源指向仓库主页）
  sources: [
    { id: 'official', type: 'index', name: '官方源',
      url: 'https://raw.githubusercontent.com/PastSheep/issheepbox-registry/main/index.json',
      enabled: true },
    { id: 'my-repo', type: 'plugin-repo', name: '单插件订阅',
      url: 'https://github.com/someone/issheepbox-plugin-single', enabled: true },
  ],
  // 插件安装目录（install/uninstall/update 必需；不传则安装类方法抛 PLUGINS_DIR_REQUIRED）
  pluginsDir: '/path/to/userData/plugins',
});

// —— v3 多源聚合 ——
const agg = await client.fetchAll(); // 并行语义：遍历启用源，源级失败隔离（ok=false + error）
agg.sources;        // 每源一条结果（UI 可展示源健康状态）
agg.byPluginId;     // Map<pluginId, SourcedPluginRecord[]>：同插件多源冲突在此分组
agg.flat;           // 全部合法记录平铺（含重复 pluginId 的多源记录）
client.getRecordsByPluginId('org.issheepbox.storage'); // 该插件全部来源记录（冲突时 >1 条）
// 每条记录带 source 段：{ id, type, name, url, trusted } —— UI 透明展示来源，客户端不拦截任何源

// —— v3 记录级安装（format 2，zip sha256 强校验）——
await client.installFromRecord(rec); // 下载 zipUrl → sha256 === zipSha256 才解压落盘
await client.updateFromRecord(rec);  // rec.latestVersion > 本地才下载（原子替换）
await client.importLocalZip('/path/to/plugin.zip'); // 本地 zip 一次性导入（不生成源、不参与更新）

// —— v1 单源兼容（registryUrl）——
const result = await client.fetchIndex(); // 网络失败抛 RegistryFetchError；解析失败不抛
if (result.topLevelErrors.length > 0) {
  console.error(result.topLevelErrors);   // 索引结构非法
  return;
}
const all = client.list(); // 全部合法条目（id/name/version/description/…）
const note = client.getById('org.example.note'); // 精确查询
const invalid = client.invalidEntries(); // 被拒绝的非法条目及原因
await client.install('org.issheepbox.example.note'); // v1 路径（凭 id，无 sha 校验）
await client.uninstall('org.issheepbox.example.note'); // 移除目录（id 守卫）
await client.update('org.issheepbox.example.note'); // v1 路径（registry 版本 > 本地才下载）
client.listInstalled(); // [{ pluginId, version, dir }]（供 UI 展示已装状态）
```

## 多源模型（v3）要点

- **源类型**：`index`（组织级索引源，`index.json` 含 `format: 2` + `plugins[]`）与
  `plugin-repo`（单插件仓库订阅；传入仓库主页 `github.com/<owner>/<repo>`，客户端自动构造
  `raw.githubusercontent.com/<owner>/<repo>/main/index.json`——该文件即自描述单条记录）。
- **冲突策略（v4 定稿）**：同 `pluginId` 出现在多个源 → `byPluginId` 分组保留全部记录，
  UI 层并列展示并让用户选源；客户端**不做**去重/优先级裁决。
- **源级失败隔离**：某源网络失败 / 索引非法 → 该源 `ok=false + error`，其他源不受影响。
- **本地 zip 导入**：一次性安装（自报 id 校验：zip 顶层目录 === `manifest.id`）；不持久化
  为源记录、不参与更新查询；已安装时拒绝（需先卸载或用源记录更新）。

## zip 约定与校验规则（install/update/导入）

zip 顶层**恰好一个目录**，目录名 = 插件 id；内含 `plugin.json`（必填）+ `package.json`
（可选）+ `dist/` + `assets/`。校验在解压前完成，失败即类型化错误、磁盘无残留：

- zip 无法解析 / 空包 / 顶层目录数 ≠ 1 → `INVALID_ZIP`
- zip 顶层目录名 ≠ 插件 id，或 `manifest.id` ≠ 请求 id → `ID_MISMATCH`
  （本地导入走 `validatePluginZipSelf`：`manifest.id` ≠ 顶层目录名同样拒绝）
- `<id>/plugin.json` 缺失/非法 JSON/缺必填字段/`entry` 文件不在包内 → `MANIFEST_INVALID`
- 含绝对路径 / 盘符路径 / `..` 条目 → `INVALID_ZIP`（防路径穿越）
- **zip 二进制 sha256 ≠ 记录 `zipSha256`（64 位 hex）→ `SHA_MISMATCH`**（v3 供应链防线，
  仅 installFromRecord / updateFromRecord 生效；v1 凭 id 路径无 sha 字段，不校验）
- pluginsDir 已有同名合法插件 → `ALREADY_INSTALLED`
- update 原子替换：解压临时目录 → 现装目录改名备份 → 临时目录换入；换入失败恢复旧版

## 错误语义

安装类方法抛 `MarketInstallError`（`code` 字段，供 UI 分类展示友好文案）：

| code | 含义 |
|---|---|
| `NETWORK` | 索引拉取 / 下载网络失败（含超时） |
| `HTTP_STATUS` | 下载返回非 2xx（附 `status`） |
| `INVALID_ZIP` | zip 损坏 / 结构非法 / 路径穿越 |
| `MANIFEST_INVALID` | plugin.json 不合法 / entry 文件缺失 |
| `ID_MISMATCH` | 顶层目录名或 manifest.id ≠ 请求 id |
| `SHA_MISMATCH` | zip 内容 sha256 与记录声明不一致（供应链防线） |
| `ALREADY_INSTALLED` | 已安装 |
| `NOT_INSTALLED` | 未安装即 uninstall/update |
| `EXTRACT_FAILED` | 解压/换入失败（不破坏现装版本） |
| `NOT_IN_REGISTRY` | 索引中无此 id |
| `INVALID_PLUGIN_ID` | id 不符合反向域名格式（uninstall 守卫） |
| `PLUGINS_DIR_REQUIRED` | 构造未传 pluginsDir |

索引拉取本身的网络错误仍是 `RegistryFetchError`（TASK-007 既有契约）；
install/update 内部会把它包装为 `MarketInstallError(NETWORK)`。

## 解析容错策略

- 解析永不抛异常；错误落在结构化字段（`topLevelErrors` / `invalid`）。
- 顶层非法 → `index=null` / `ok=false`，不解析条目。
- 单条非法（缺必填 / 类型错 / id 格式错 / 版本非 SemVer / URL 非 http(s) /
  权限非字符串数组 / 时间不可解析 / sha256 非 64 位 hex）→ 该条目被拒绝并记录原因，
  其余条目照常返回。
- 索引源内 id 重复 → 保留首个，重复条目被拒绝（跨源重复不在此拒绝，由聚合层分组）。
- 未知额外属性 → 忽略并接受（向前兼容；`additionalProperties:false` 留给 registry
  维护侧机器校验）。
- `permissions` 原样透传，不做授权校验（授权属 TASK-008 approval-policy）。

## 版本对比

`compareVersions(a, b)` 提供严格 SemVer（MAJOR.MINOR.PATCH，可带预发布）比较，
update() 用它判断「本地已装版本 vs 索引最新版本」。

## 验证

```powershell
pnpm --filter @issheepbox/market-client build   # 构建 dist
pnpm --filter @issheepbox/market-client verify:fixture  # v1 回归：fixtures/plugins.fixture.json 解析 + 安装类接口契约
node packages/market-client/scripts/verify-v3.mjs        # v3 回归：format 2 解析/多源聚合/冲突分组/失败隔离/sha256/本地导入/更新
```

fixture 含 12 条（4 合法 + 8 非法，覆盖缺字段/格式/类型/重复/未知属性等），
脚本断言解析、过滤、未配置 pluginsDir 的类型化错误、id 守卫、顶层非法结构与版本比较。
verify-v3.mjs 覆盖 39 项断言：format 2 索引 / 单插件仓库自描述 / 多源聚合与冲突分组 /
源级失败隔离 / installFromRecord 成功与 SHA_MISMATCH / importLocalZip 一次性导入 /
updateFromRecord 原子更新 / v1 兼容 / plugin-repo URL 构造。
zip 解压/安装成功路径与内核集成由 `apps/desktop/scripts/verify-market-e2e.cjs` 覆盖。

