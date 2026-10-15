# 鼠鼠数据索引插件（com.pastsheep.shushu-data）

> 跨仓库插件：把你另一个产品 **DeltaForceBox-Assets（鼠鼠大王工具箱的数据仓库）**
> 的 manifest 接进 Is SheepBox，对外提供 `shushu-data` 服务 + 一个静态数据面板。

## 它做什么

- 挂载时拉取
  `https://raw.githubusercontent.com/PastSheep/DeltaForceBox-Assets/main/shushu-data-manifest.json`
  （各地图 article-map 数据集：count / schema / sha256）。
- 对外注册服务 `shushu-data`：
  - `getManifest()` 原始清单
  - `listDatasets()` / `getDataset(id)` 数据集列表与单条
  - `getSummary()` 汇总（来源 / 更新时间 / 数据集数 / 总条目数）
  - `refresh()` 手动重拉
- 注册一个静态 HTML 面板展示数据集表格。
- 软依赖 `org.issheepbox.storage`：存在则缓存最近一次成功清单，离线回退缓存。

未来真正的「点位/攻略查询」插件只需 `requires` 依赖本服务取数，不必各自重复抓取。

## 权限

`network:fetch`。未授权不注册服务；拉取失败不阻断挂载，面板显示降级信息。

## 构建与验证

```bash
pnpm install
pnpm --filter @issheepbox/kernel --filter @issheepbox/approval-policy build
pnpm --filter @issheepbox/plugin-shushu-data build
node packages/plugins/verify-shushu.cjs
```

> v1 边界：v1 尚无 `ctx.net` 宿主能力，当前用主进程全局 `fetch`；待 `ctx.net`
> 交付后替换为受控调用。面板为静态 HTML（v1 面板脚本暂不执行）。
