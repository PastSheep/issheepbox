# Plugin Registry Index 格式规范（plugins.json）

> **版本**：v1.0.0  
> **对应规范**：[plugin-spec-v1.md](./plugin-spec-v1.md)  
> **用途**：registry 仓库根目录的 `plugins.json` 是 ISB 插件市场的索引文件，宿主客户端启动时拉取此文件展示可安装插件列表。

---

## 1. 文件位置与作用

```
plugin-registry/               # registry 仓库（待创建）
├── plugins.json               # ← 本文件：全量插件索引
├── README.md
└── schemas/
    └── plugins.schema.json    # JSON Schema（机器校验用）
```

- `plugins.json` 是**全量索引**，不是分页、不是增量。
- 每个条目对应一个已上架插件的**最新版本**信息。
- 历史版本由各插件自己的 GitHub Releases 承载，registry 不存历史。

---

## 2. 顶层结构

```jsonc
{
  "registryVersion": "1.0.0",     // registry 自身格式版本，SemVer
  "generatedAt": "2026-10-13T00:00:00Z",  // 索引生成时间 ISO 8601
  "plugins": [                    // 插件条目数组，见第 3 节
    // ...
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `registryVersion` | string | ✅ | registry 索引格式版本，SemVer。当前 `1.0.0`。 |
| `generatedAt` | string | ✅ | 索引最后更新时间，ISO 8601 UTC。 |
| `plugins` | array | ✅ | 插件条目数组，可为空 `[]`。 |

---

## 3. 插件条目字段

`plugins[]` 中每个对象结构如下：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 插件 ID，与插件 manifest 中 `id` 一致，全局唯一 |
| `name` | string | ✅ | 展示名 |
| `description` | string | ✅ | 一句话描述（50 字以内） |
| `author` | string | ✅ | 作者名或组织名 |
| `version` | string | ✅ | 当前最新版本，SemVer |
| `apiVersion` | string | ✅ | 该版本兼容的 ctx API range |
| `license` | string | ❌ | 开源协议，SPDX 标识符 |
| `icon` | string | ❌ | 图标 URL（可指向仓库 raw 地址） |
| `homepage` | string | ❌ | 项目主页 URL |
| `repository` | string | ✅ | 源码仓库 URL（GitHub） |
| `status` | string | ❌ | 上架状态，缺省视为 active。active=已发布可下载；pending=元数据已登记、zip 资产待发布 |
| `releaseUrl` | string | 条件 | 当前版本 Release 页面 URL。active 必填；pending 可缺省，留待发布后补齐 |
| `downloadUrl` | string | 条件 | zip 包下载直链（GitHub Release assets）。active 必填；pending 可缺省，留待发布后补齐 |
| `permissions` | string[] | ✅ | 该版本声明的权限列表（镜像 manifest） |
| `requires` | object | ❌ | 依赖列表（镜像 manifest） |
| `tags` | string[] | ❌ | 分类标签，如 `["productivity", "note"]` |
| `publishedAt` | string | ✅ | 该版本发布时间，ISO 8601 UTC |

### 3.1 字段约束说明

- **`id`**：registry 内全局唯一。重复 ID 的新条目会被维护者拒绝。
- **`downloadUrl`**：必须是可直接 GET 下载的 zip 包地址，不允许跳转中间页。GitHub Release 资产 URL 格式：`https://github.com/<owner>/<repo>/releases/download/v<version>/<file>.zip`。
- **`version`**：必须与该 Release 的 Git tag 对应。registry 只存最新版；宿主客户端通过版本对比判断是否需要更新。
- **`permissions`**：镜像 manifest 中的权限数组。客户端在展示市场列表时即可预览权限，无需下载 zip。
- **`tags`**：建议从受控词表选择（v1 暂不强制），便于分类浏览。

---

## 4. 完整示例

```json
{
  "registryVersion": "1.0.0",
  "generatedAt": "2026-10-13T12:00:00Z",
  "plugins": [
    {
      "id": "org.example.note",
      "name": "便签",
      "description": "一个简洁的桌面便签工具",
      "author": "Example Developer",
      "version": "1.0.0",
      "apiVersion": "^1.0.0",
      "license": "MIT",
      "icon": "https://raw.githubusercontent.com/example/note/main/assets/icon.png",
      "homepage": "https://example.com/note",
      "repository": "https://github.com/example/note",
      "releaseUrl": "https://github.com/example/note/releases/tag/v1.0.0",
      "downloadUrl": "https://github.com/example/note/releases/download/v1.0.0/org.example.note-1.0.0.zip",
      "permissions": ["storage:plugin"],
      "requires": {},
      "tags": ["productivity", "note"],
      "publishedAt": "2026-10-10T08:30:00Z"
    }
  ]
}
```

---

## 5. JSON Schema

以下为 `plugins.json` 的机器可读校验 schema（保存为 `schemas/plugins.schema.json`）：

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://issheepbox.org/schemas/plugins.schema.json",
  "title": "ISB Plugin Registry Index",
  "type": "object",
  "required": ["registryVersion", "generatedAt", "plugins"],
  "properties": {
    "registryVersion": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "registry 索引格式版本，SemVer"
    },
    "generatedAt": {
      "type": "string",
      "format": "date-time",
      "description": "索引最后更新时间 ISO 8601 UTC"
    },
    "plugins": {
      "type": "array",
      "items": { "$ref": "#/definitions/pluginEntry" }
    }
  },
  "definitions": {
    "pluginEntry": {
      "type": "object",
      "required": [
        "id", "name", "description", "author", "version", "apiVersion",
        "repository", "permissions", "publishedAt"
      ],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)+$",
          "description": "反向域名风格全局唯一 ID"
        },
        "name": { "type": "string", "maxLength": 50 },
        "description": { "type": "string", "maxLength": 200 },
        "author": { "type": "string", "maxLength": 100 },
        "version": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+$"
        },
        "apiVersion": { "type": "string" },
        "license": { "type": "string" },
        "icon": { "type": "string", "format": "uri" },
        "homepage": { "type": "string", "format": "uri" },
        "repository": { "type": "string", "format": "uri" },
        "status": {
          "type": "string",
          "enum": ["active", "pending"],
          "description": "上架状态：active=已发布可下载；pending=元数据已登记、zip 资产待发布"
        },
        "releaseUrl": { "type": "string", "format": "uri" },
        "downloadUrl": { "type": "string", "format": "uri" },
        "permissions": {
          "type": "array",
          "items": { "type": "string" },
          "description": "权限列表，镜像 manifest"
        },
        "requires": { "type": "object" },
        "tags": {
          "type": "array",
          "items": { "type": "string" }
        },
        "publishedAt": { "type": "string", "format": "date-time" }
      },
      "if": {
        "properties": { "status": { "const": "pending" } },
        "required": ["status"]
      },
      "then": {},
      "else": {
        "required": ["releaseUrl", "downloadUrl"]
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

---

## 6. 维护流程

### 6.1 新增插件上架

1. 插件开发者在自己的 GitHub 仓库准备好 Release 与 zip 包。
2. 向 registry 仓库提交 PR，在 `plugins.json` 数组中追加条目。
3. 维护者审核：
   - manifest 合规性（下载 zip 校验）
   - 权限合理性
   - ID 唯一性
   - `downloadUrl` 可访问
4. 合并后更新 `generatedAt` 字段。
5. pending → active 流转：开发者发布 zip 资产后，补齐 `releaseUrl`/`downloadUrl` 并将 `status` 置为 `active`，更新 `generatedAt`。

### 6.2 插件更新版本

1. 插件作者发布新的 GitHub Release。
2. 提交 PR 修改 `plugins.json` 中对应条目：`version`、`downloadUrl`、`releaseUrl`、`publishedAt`、`permissions`（如有变化）。
3. 维护者审核合并。

### 6.3 插件下架

- 删除数组中对应条目即可。
- 已安装该插件的用户不受影响，只是市场不再展示新安装入口。

---

## 7. 客户端消费约定

宿主客户端拉取 `plugins.json` 后：

1. 校验 `registryVersion` 与客户端支持的格式版本兼容。
2. 按 `plugins[]` 渲染市场列表（名称、描述、作者、版本、权限预览、图标）。
3. 用户点击安装 → 从 `downloadUrl` 下载 zip → 解压到本地插件目录 → 按插件规范校验 manifest → 展示权限授权 → 完成安装。
4. 版本更新：对比本地已安装版本与索引中 `version`，有新版本提示用户更新。

---

> **⚠️ 待办**：registry 仓库（GitHub 组织 + 仓库名）尚未由需求方提供。本格式定义已就绪，仓库创建后将此文件与首个空条目 `{"registryVersion":"1.0.0","generatedAt":"...","plugins":[]}` 一并提交。
