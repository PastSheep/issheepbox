# packages/plugins/

第三方/官方示例插件的落地目录。TASK-009 将在此目录下放置三个示例插件：

- `notes-ui/`     纯 UI 面板插件（便签）
- `file-stats/`   带权限插件（需 `files:read`）
- `theme-service/` 带服务插件（提供服务被其他插件消费）

每个示例插件自带 `plugin.json`（manifest）与可运行代码，
代码即第三方插件模板。具体规范由 TASK-010 定稿。
