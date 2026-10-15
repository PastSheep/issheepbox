# 宿主文件能力服务（org.issheepbox.files-service）

> 落地规范 F-008：在用户授权目录白名单内提供读文本/枚举/统计，受 `files:read` 门禁，越权路径一律拒绝。

## 服务形状

```ts
interface FilesService {
  authorizeDir(dir: string): void;
  listAuthorizedDirs(): string[];
  readText(callerPluginId: string, filePath: string): string;
  listDir(callerPluginId: string, dirPath: string): string[];
  stat(callerPluginId: string, filePath: string): { size: number; isDir: boolean };
}
```

## 安全模型

- 每次调用须传 callerPluginId；经 `approval-policy.checkPermission(callerPluginId, 'files:read')` 门禁。
- 路径校验：含 `..` 段拒绝；解析为绝对路径后必须落在已授权目录内；越权统一抛错，不泄漏路径信息。
- 白名单持久化到 `userData/files-whitelist.json`。

## 构建与验证

```bash
pnpm --filter @issheepbox/plugin-files-service build
node packages/plugins/verify-files-service.cjs
```
