# 应用更新检查（org.issheepbox.updater）

> 只管应用本体（Electron 桌面端）更新；功能插件更新归市场链路。

## 服务形状

```ts
interface UpdaterService {
  checkForUpdate(currentVersion: string, opts?: { fetchImpl?: FetchLike }): Promise<UpdateCheckResult>;
  getState(): { lastCheckAt, ignoredVersion, latestVersion, releaseUrl };
  dismiss(version: string): void;
}
// UpdateCheckResult: { updateAvailable, currentVersion, latestVersion?, releaseUrl?, error }
```

## 行为

- 查 GitHub Releases latest（`api.github.com/repos/PastSheep/issheepbox/releases/latest`）。
- semver 比对 current vs latest；发现新版且未被忽略时广播 `updater:update-available`。
- `dismiss(version)` 后该版本不再提示。
- 断网/请求失败静默降级：返回 `{ updateAvailable:false, error }`，不抛错。
- 状态持久化到 `userData/issheepbox-updater-state.json`。

## 权限

`network:fetch` + `files:read` + `files:write`。

## 构建与验证

```bash
pnpm --filter @issheepbox/plugin-updater build
node packages/plugins/verify-updater.cjs
```
