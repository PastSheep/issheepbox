# @issheepbox/market-client

Is Sheep Box 插件市场客户端（TASK-007 拉取/解析/查询；TASK-012 安装/卸载/更新）。

按 [docs/plugin-registry-schema.md](../../docs/plugin-registry-schema.md)（registry index 格式
v1，draft-07 JSON Schema）拉取并解析 `plugins.json`，提供插件列表与过滤查询；非法条目容错。
TASK-012 起落地 install/uninstall/update：下载 zip → 完整性校验 → 解压到 pluginsDir
（构造选项注入），错误一律为带 `code` 的 `MarketInstallError`。本包不 import
`@issheepbox/kernel` 运行时（loader/profile），插件发现/授权门禁由宿主（desktop/内核）接线。

## 用法

```ts
import { MarketClient } from '@issheepbox/market-client';

const client = new MarketClient({
  // 默认使用 DEFAULT_REGISTRY_URL（PastSheep/issheepbox-registry 的 raw 索引）；
  // 也可在此传入其他 registry 地址覆盖
  registryUrl: 'https://raw.githubusercontent.com/PastSheep/issheepbox-registry/main/plugins.json',
  // 插件安装目录（install/uninstall/update 必需；不传则安装类方法抛 PLUGINS_DIR_REQUIRED）
  pluginsDir: '/path/to/userData/plugins',
});

const result = await client.fetchIndex(); // 网络失败抛 RegistryFetchError；解析失败不抛
if (result.topLevelErrors.length > 0) {
  // 索引结构非法（非法 JSON / 缺顶层字段）
  console.error(result.topLevelErrors);
  return;
}

const all = client.list(); // 全部合法条目（id/name/version/description/…）
const byTag = client.list({ tag: 'note' }); // 按条件过滤（字段间「且」）
const note = client.getById('org.example.note'); // 精确查询
const invalid = client.invalidEntries(); // 被拒绝的非法条目及原因

// —— 安装 / 卸载 / 更新（TASK-012）——
await client.install('org.issheepbox.example.note');
// → { pluginId, version, dir }：pluginsDir/<pluginId>/
await client.uninstall('org.issheepbox.example.note'); // 移除目录（id 守卫）
await client.update('org.issheepbox.example.note');
// → { pluginId, version, dir, updated }：registry 版本 > 本地才下载替换，否则 updated=false
client.listInstalled(); // [{ pluginId, version, dir }]（供 UI 展示已装状态）
client.installedVersion('org.issheepbox.example.note'); // 本地版本或 null
```

## zip 约定与校验规则（install/update）

zip 顶层**恰好一个目录**，目录名 = 插件 id；内含 `plugin.json`（必填）+ `package.json`
（可选）+ `dist/` + `assets/`。校验在解压前完成，失败即类型化错误、磁盘无残留：

- zip 无法解析 / 空包 / 顶层目录数 ≠ 1 → `INVALID_ZIP`
- zip 顶层目录名 ≠ 插件 id，或 `manifest.id` ≠ 请求 id → `ID_MISMATCH`
- `<id>/plugin.json` 缺失/非法 JSON/缺必填字段/`entry` 文件不在包内 → `MANIFEST_INVALID`
- 含绝对路径 / 盘符路径 / `..` 条目 → `INVALID_ZIP`（防路径穿越）
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
- 顶层非法 → `index=null`，不解析条目。
- 单条非法（缺必填 / 类型错 / id 格式错 / 版本非 SemVer / URL 非 http(s) /
  权限非字符串数组 / 时间不可解析）→ 该条目被拒绝并记录原因，其余条目照常返回。
- id 重复 → 保留首个，重复条目被拒绝。
- 未知额外属性 → 忽略并接受（向前兼容；`additionalProperties:false` 留给 registry
  维护侧机器校验）。
- `permissions` 原样透传，不做授权校验（授权属 TASK-008 approval-policy）。

## 版本对比

`compareVersions(a, b)` 提供严格 SemVer（MAJOR.MINOR.PATCH，可带预发布）比较，
update() 用它判断「本地已装版本 vs 索引最新版本」。

## 验证

```powershell
pnpm --filter @issheepbox/market-client build   # 构建 dist
pnpm --filter @issheepbox/market-client verify:fixture  # fixtures/plugins.fixture.json 实测解析 + 安装类接口契约
```

fixture 含 12 条（4 合法 + 8 非法，覆盖缺字段/格式/类型/重复/未知属性等），
脚本断言解析、过滤、未配置 pluginsDir 的类型化错误、id 守卫、顶层非法结构与版本比较。
zip 解压/安装成功路径与内核集成由 `apps/desktop/scripts/verify-market-e2e.cjs` 覆盖。
