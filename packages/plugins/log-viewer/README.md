# 日志查看面板（org.issheepbox.log-viewer）

> UI 面板插件：消费 `logging` 服务，实时滚动日志 + 按级别/插件筛选，error/warn 高亮。

## 权限

声明 `logs:read`。未授权时 fail-safe：注册一个静态提示面板，**不转发任何日志数据**。

## 数据桥（同 echo-panel）

- 主进程 → 面板：订阅 `log:entry`，经 `panel:outbound` 转发 `{ type:'entry', entry }`。
- 面板 → 主进程：面板发 `{ type:'filter', filter }`，本插件调 `logging.query(ctx.manifest.id, filter)` 后经 `panel:outbound` 回 `{ type:'history', entries }`。

## 软依赖

依赖 `logging` 服务（logger 插件）。logger 未启用时面板显示「日志服务未就绪」，不崩。

## 构建与验证

```bash
pnpm --filter @issheepbox/plugin-log-viewer build
node packages/plugins/verify-log-viewer.cjs
```
