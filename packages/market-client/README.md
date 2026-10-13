# @issheepbox/market-client

Is Sheep Box 插件市场客户端（TASK-007）。

按 [docs/plugin-registry-schema.md](../../docs/plugin-registry-schema.md)（registry index 格式
v1，draft-07 JSON Schema）拉取并解析 `plugins.json`，提供插件列表与过滤查询；非法条目容错。
下载/安装/卸载/更新仅留接口占位（依赖后续任务），本包**不写入 pluginsDir**、不触碰
`packages/kernel` 的 loader/profile 假设。

## 用法

```ts
import { MarketClient } from '@issheepbox/market-client';

const client = new MarketClient({
  // 默认使用 DEFAULT_REGISTRY_URL（PastSheep/issheepbox-registry 的 raw 索引）；
  // 也可在此传入其他 registry 地址覆盖
  registryUrl: 'https://raw.githubusercontent.com/PastSheep/issheepbox-registry/main/plugins.json',
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
```

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
供后续「本地已装版本 vs 索引最新版本」的更新判断使用（本任务仅提供纯函数）。

## 占位接口

`download / install / uninstall / update` 均为 `Promise<never>`，调用即抛错并说明依赖
的后续任务；注册的下载/安装流程待 registry 仓库落地、插件打包（TASK-011）与
loader/profile 集成后实现。

## 验证

```powershell
pnpm --filter @issheepbox/market-client build   # 构建 dist
pnpm --filter @issheepbox/market-client verify:fixture  # 用 fixtures/plugins.fixture.json 实测解析
```

fixture 含 12 条（4 合法 + 8 非法，覆盖缺字段/格式/类型/重复/未知属性等），
脚本断言解析、过滤、占位抛错、顶层非法结构与版本比较，全部通过则 exit 0。
