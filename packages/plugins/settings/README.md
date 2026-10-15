# 设置中心（org.issheepbox.settings）

> 面板形态：registry 源自定义、默认壳切换、插件启停管理、关于与诊断。

## 四块功能

1. **Registry 源**：读写 `userData/config.json` 的 `registryUrl`（默认官方地址、可改、可重置）。
2. **默认壳切换**：发 `settings:request-set-shell` 事件，宿主据此改 `profile.shell`。
3. **插件启停**：读 profile.enabled，发 `settings:request-enable/disable/uninstall` 命令事件（卸载走市场链路，本插件不自行删目录）。
4. **关于与诊断**：`ctx.apiVersion`、当前壳、已启用插件清单。

## 权限

`files:read` + `files:write`（读写 config.json 与 profile JSON）。未授权 fail-safe 不注册面板。

## 边界

本插件是「意图发声」层——启停/壳切换只 emit 事件，由宿主（desktop）执行。

## 构建与验证

```bash
pnpm --filter @issheepbox/plugin-settings build
node packages/plugins/verify-settings.cjs
```
