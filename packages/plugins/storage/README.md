# KV 存储服务插件（org.issheepbox.storage）

> 第一方基础设施插件：**按命名空间隔离的键值持久化服务**。
> 它把需求文档 §3 规划但一直缺失的「存储插件」落地，并以插件形态补齐尚未交付的 `ctx.storage`。

## 为什么是一个插件而不是内核能力

Is Sheep Box 的内核极薄（只做加载 / 生命周期 / services+events / profile）。
`ctx.storage` 至今未交付，导致 `note` 等插件只能把"持久化待 ctx.storage 交付"挂着。

按 **「一切皆插件」** 的理念，存储本就不该烤进内核：

- 它是**可启停、可替换**的——今天是本地 JSON 文件，未来可以换成 SQLite、云同步，消费方无感知；
- 它通过标准 `services` / `events` 对外提供能力，其他插件 `requires` 依赖它，不直接 import 代码；
- 它自己也遵守权限与可逆 effects 契约。

## 它提供什么

- **服务** `storage`（v1.0.0）：

  ```ts
  interface StorageService {
    namespace(pluginId: string): ScopedStore;   // 推荐：拿一个本插件的作用域句柄
    get(pluginId: string, key: string): unknown;
    set(pluginId: string, key: string, value: unknown): void;
    delete(pluginId: string, key: string): void;
    all(pluginId: string): Record<string, unknown>;
    clear(pluginId: string): void;
    isPersistent(): boolean;
  }
  // ScopedStore: get/set/delete/all/clear（无需每次再传 pluginId）
  ```

- **事件** `storage:changed`：`{ namespace, key, op: 'set'|'delete'|'clear', value }`。

## 消费方怎么用

```ts
// 1) manifest.requires 声明依赖
//   "requires": { "org.issheepbox.storage": "^1.0.0" }
export default function main(ctx) {
  const storage = ctx.services.get('storage');
  const mine = storage.namespace(ctx.manifest.id); // 用自己的插件 id 命名空间隔离

  mine.set('theme', 'dark');
  const theme = mine.get('theme'); // 'dark'
}
```

- 命名空间按**调用方自己的插件 id** 隔离，插件之间读不到彼此的键。
- 值必须是 **JSON 可序列化**的对象（落盘为 JSON）。
- 写入即落盘（write-through），进程崩溃也不丢。

## 权限

声明 `files:read` + `files:write`：在启用/安装时经 approval-policy 授权。
未授权时本插件**不注册服务**（fail-safe）；磁盘写入失败只记日志、保留内存态，不会崩掉其他插件。

## 数据位置

经宿主注入的 `host:user-data` 服务（C3，desktop 主进程在 `kernel.start` 前注册）定位用户数据目录，
落盘为 `<userData>/issheepbox-storage.json`。宿主未注入时降级为纯内存（重启不保留）并告警。

## 构建与验证

```bash
# 根目录先构建内核等依赖
pnpm install
pnpm --filter @issheepbox/kernel --filter @issheepbox/approval-policy build
# 构建本插件
pnpm --filter @issheepbox/plugin-storage build
# 端到端验证（真实内核，临时目录，不落真实 userData）
node packages/plugins/verify-storage.cjs
```
