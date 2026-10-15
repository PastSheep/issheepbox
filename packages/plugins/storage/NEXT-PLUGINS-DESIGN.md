# 后续插件设计方案（agent-doubao 提案）

> 基于对 Is SheepBox 仓库、registry、以及作者另外两个仓库（DeltaForceBox-Releases /
> DeltaForceBox-Assets「鼠鼠大王工具箱」）的探索整理。
> 旗舰件 `org.issheepbox.storage`（KV 持久化服务）已随本分支实现并通过端到端验证。
> 本文是**待办 backlog**：每个方案给出定位、manifest 草案、ctx/服务/事件、权限、
> 依赖，以及它**卡在哪个尚未交付的 ctx 能力上**。

---

## 0. 探索结论（影响设计的关键事实）

1. **作者的兴趣轴**：
   - 一条轴是**微内核 / 一切皆插件**本身（Is SheepBox 用 Cordis/DSH 思想自研极薄内核）；
   - 另一条轴是**游戏辅助工具箱**（鼠鼠大王工具箱，配套资源是拼图图片、特征文件、主题/语言包）。
   - 因此下面的插件既补基础设施，也向「鼠鼠 / 开发者工具箱」气质靠拢。
2. **v1 当前运行边界（实测，非文档推断）**：
   - 面板经 `apps/desktop/index.html` 用 `body.innerHTML = readPluginAsset(...)` 注入，
     **innerHTML 内的 `<script>` 不会执行**——所以当前面板实际上是**静态 HTML/CSS**，
     面板与主上下文之间没有可交互桥。任何「面板里点按钮触发逻辑」的插件在 v1 都跑不通，
     需要等壳提供 webview/iframe + 面板↔主上下文消息桥（建议登记为新 P 项）。
   - `ctx.commands / ctx.panels / ctx.storage / ctx.ui` 均未交付；UI 只能走
     `shell:ui.registerPanel`，文件只能走 `ctx.files`（带权限门禁）。
   - 这就是为什么旗舰件选了一个**纯服务型、可 headless 验证**的插件。

---

## 1. com.pastsheep.devkit —— 开发者速查工具箱面板

**定位**：all-in-one 工具箱最缺的那类「开发者随手工具」。一页多 Tab：
JSON 格式化/校验、Base64 与 URL 编解码、时间戳↔人类时间互转、HEX/RGB 颜色转换、UUID/随机串生成。

- **权限**：无（纯前端计算）。
- **依赖**：`org.issheepbox.storage`（记住上次输入/最近用的工具）。
- **ctx 用法**：`shell:ui.registerPanel(..., { html })`；消费 `storage.namespace(...)` 持久化最近输入。
- **形态**：纯 UI 面板（与 note 同类，但功能密度高）。
- **卡点**：**面板脚本暂不执行**（见 §0.2）。落地前需要壳交付「可交互面板」桥；
  桥就绪后此插件无需改内核即可工作。

## 2. com.pastsheep.shushu-data —— 鼠鼠数据索引（跨仓库彩蛋）

**定位**：把作者自己的 DeltaForceBox-Assets（拼图图片 / 特征文件 / 主题语言清单）
拉进 Is SheepBox：挂载时经 `network:fetch` 拉 `shushu-data-manifest.json`，
用 `storage` 缓存，对外注册 `shushu-data` 服务 + 一个静态参考面板（列出条目、跳转链接）。
未来真正的「拼图助手 / 特征查询」插件只需依赖本服务取数据，不必各自重复抓取。

- **权限**：`network:fetch`。
- **依赖**：`org.issheepbox.storage`（缓存 manifest、避免每次启动打 GitHub）。
- **contributes**：服务 `shushu-data`（`listPuzzles()/listFeatures()/getManifest()`）、
  事件 `shushu-data:updated`。
- **ctx 用法**：Node 主进程 `fetch()`（主进程在 Node 上下文，可联网）→ 渲染为静态 HTML 面板。
- **形态**：带权限 + 服务 + 静态面板，**在 v1 就能跑**（数据抓取在主进程，不依赖面板脚本）。
- **说明**：这是把作者另一条产品线接入 ISB 生态的示范件；离线时走缓存 + 降级。

## 3. com.pastsheep.clipboard-history —— 剪贴板历史

**定位**：工具箱标配。记录复制历史，面板浏览/置顶/一键重新写入。

- **权限**：`clipboard:read` + `clipboard:write`。
- **依赖**：`org.issheepbox.storage`（持久化历史与置顶）。
- **卡点**：v1 没有「剪贴板变化」宿主事件，也没有轮询宿主能力。需要内核/壳补一个
  `host:clipboard-changed` 事件（或暴露受控轮询钩子）。在那之前只能设计、不能真录历史。

## 4. org.issheepbox.storage（本分支旗舰）—— 已实现

见 `packages/plugins/storage/README.md`。它同时解锁上面 #1/#2/#3 的「持久化」前提。

---

## 建议的落地顺序

1. **先推壳的可交互面板桥**（webview/iframe + 面板↔主上下文消息协议）——这是当前最大的
   生态卡口，解锁后一大批 UI 插件才能真正可用。建议在 `docs/TASKS.md` 登记该 P 项。
2. 合入本分支的 `storage`（基础设施，无卡口，立即可用）。
3. 面板桥就绪后做 `devkit`（纯前端、低风险、立刻有用）。
4. 紧随其后 `shushu-data`（跨仓库、体现产品协同）。
5. `clipboard-history` 待宿主剪贴板事件就绪。
