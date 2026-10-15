# 日志服务插件（org.issheepbox.logger）

> 内置级服务插件：为其他插件提供统一的 `logging` 服务，实时广播 `log:entry` 事件，按大小轮转持久化到 userData。

## 它提供什么

- **服务** `logging`（v1.0.0）：

  ```ts
  interface LoggingService {
    write(level: 'debug'|'info'|'warn'|'error', scope: string, message: string, meta?: unknown): void;
    query(callerPluginId: string, filter?: LogFilter): LogEntry[];  // 需 logs:read
    size(): number;
    isPersistent(): boolean;
  }
  // LogFilter: { minLevel?, scope?, since?, limit? }
  // LogEntry:  { ts, level, scope, message, meta? }
  ```

- **事件** `log:entry`：每条日志实时广播，载荷即 `LogEntry`。

## 权限模型

| 操作 | 权限要求 |
|---|---|
| `write` | **免费**，任意插件可写（scope 自报） |
| `query` | 调用方须持有 `logs:read`；未授权抛错、不返回数据（fail-safe） |
| 本插件自身落盘 | 声明 `files:read` + `files:write`，未授权则不注册服务 |

## 数据位置

经宿主 `host:user-data` 服务定位用户数据目录，落盘为：

- `issheepbox-logs-current.jsonl`（活动文件，JSONL 每行一条）
- `issheepbox-logs-1/2/3.jsonl`（轮转归档，最多 3 份）

单活动文件超过 64KB 时自动轮转。宿主未注入 `host:user-data` 时降级为纯内存。

## 消费方怎么用

```ts
export default function main(ctx) {
  const logging = ctx.services.get('logging');
  logging.write('info', ctx.manifest.id, '插件已启动');

  // 订阅实时流（日志查看面板用）
  ctx.events.on('log:entry', (entry) => { /* 渲染 */ });

  // 历史查询（需在自身 manifest 声明 logs:read 并经授权）
  const errors = logging.query(ctx.manifest.id, { minLevel: 'error', limit: 50 });
}
```

## 构建与验证

```bash
pnpm --filter @issheepbox/kernel --filter @issheepbox/approval-policy build
pnpm --filter @issheepbox/plugin-logger build
node packages/plugins/verify-logger.cjs
```
