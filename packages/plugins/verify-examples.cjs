/**
 * TASK-009 示例插件验证脚本（验证规范 v1）。
 *
 * 复用 TASK-003/008 的验证思路：临时 pluginsDir 驱动真实内核（非 mock），
 * 注入 ApprovalPrompter / 走 approval-policy 授权服务验证权限路径。
 *
 * 前置（先构建、后验证，推送的树 = 验证的树）：
 *   pnpm build                                     # 根：kernel / approval-policy / shell-default 等
 *   pnpm --filter @issheepbox/plugin-note --filter \
 *        @issheepbox/plugin-file-stats --filter \
 *        @issheepbox/plugin-theme-service run build # 三个示例插件 → dist/
 *
 * 运行：
 *   node packages/plugins/verify-examples.cjs
 *
 * 覆盖（对齐 TASK-009 验收标准）：
 *   场景 A  内核加载 + enable + 正常使用 + unmount 无残留（无权限形态 + 服务形态）
 *   场景 B  权限拒绝路径：注入 deny prompter → 授权被拒 → 插件不可启用（含事件广播）
 *   场景 C  权限授权路径：注入 grant-all prompter → 授权通过 → 插件启用并工作
 *           （file-stats 经宿主 ctx.files.readFile 读真实临时文件并统计正确）→ 卸载无残留
 *   场景 D  FailSafePrompter 默认拒绝（未注入 prompter）
 *   场景 E  运行时 fail-safe：未授权强制挂载 → 插件自检拒绝暴露能力；
 *           宿主 files 能力门禁：approval-policy 未挂载 / 探针未授权时读文件均被拒
 *
 * 历史 seam 缺口（规范反馈 F-006，原登记 P-006，编号顺延后为 docs/TASKS.md P-007）
 * 已闭环：shell:ui.registerPanel 返回 unregister，注册方经 ctx.effects.add 登记进
 * 自身 effect scope，插件卸载后面板记录随 scope dispose 自动回滚（场景 A 断言无残留）。
 *
 * P-009（闭环规范反馈 F-008）：file-stats 不再走「宿主传入文本」沙箱模式，改为经宿主
 * ctx.files.readFile 读真实文件；场景 C 由 statsOfText 改为 statsOfFile，场景 E 补充
 * 宿主 files 能力运行时门禁（服务不可用 / 未授权均拒绝读文件）断言。
 */
'use strict';

// 本文件是 Node 验证测试台（harness），需要 require() 加载已构建的内核/插件产物；
// @typescript-eslint/no-require-imports 针对插件运行时代码（沙箱内禁止 require），
// 不适用于测试台。内核侧同样用 createRequire 规避该规则（见 loader/index.ts），
// 此处测试台直接 require 构建产物，故按文件豁免。
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IsSheepBoxKernel } = require('../kernel/dist/index.js');
const {
  APPROVAL_EVENTS,
  APPROVAL_SERVICE_NAME,
  createApprovalPolicyPlugin,
} = require('../approval-policy/dist/index.js');

// ---------------------------------------------------------------------------
// 常量与工具
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = __dirname; // packages/plugins

const EXAMPLE_PLUGIN_DIRS = ['note', 'file-stats', 'theme-service'];

const SHELL_ID = 'org.issheepbox.shell-default';
const APPROVAL_POLICY_ID = 'org.issheepbox.approval-policy';
const NOTE_ID = 'org.issheepbox.example.note';
const FILE_STATS_ID = 'org.issheepbox.example.file-stats';
const THEME_ID = 'org.issheepbox.example.theme-service';

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 测试用授权 UI：全部授权。 */
class GrantAllPrompter {
  async prompt() {
    return { kind: 'grant-all' };
  }
}

/** 测试用授权 UI：全部拒绝，并记录提示次数。 */
class DenyPrompter {
  constructor() {
    this.prompts = 0;
  }
  async prompt() {
    this.prompts += 1;
    return { kind: 'deny' };
  }
}

/** 构造注入自定义 prompter/store 的 approval-policy LoadedPlugin（仿 TASK-008 测试）。 */
function makeInjectedApprovalPolicy(options) {
  const factory = createApprovalPolicyPlugin(options);
  return {
    dir: path.join('virtual', APPROVAL_POLICY_ID),
    manifest: {
      id: APPROVAL_POLICY_ID,
      name: '权限授权',
      version: '1.0.0',
      apiVersion: '^1.0.0',
      entry: 'dist/index.js',
      permissions: [],
    },
    module: { default: factory },
  };
}

/** 把插件包复制进临时 pluginsDir（排除 node_modules/src，保留 plugin.json + dist + assets）。 */
function copyPluginPackage(srcDir, destRoot) {
  fs.cpSync(srcDir, path.join(destRoot, path.basename(srcDir)), {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== 'node_modules' && base !== 'src';
    },
  });
}

/** 构造临时插件目录（5 个插件包：3 示例 + shell-default + approval-policy）。 */
function makePluginsDir(root, pluginsDir) {
  const sources = [
    ...EXAMPLE_PLUGIN_DIRS.map((name) => path.join(PLUGIN_ROOT, name)),
    path.join(PLUGIN_ROOT, '..', 'shell-default'),
    path.join(PLUGIN_ROOT, '..', 'approval-policy'),
  ];
  for (const src of sources) {
    const manifestPath = path.join(src, 'plugin.json');
    const entryPath = path.join(src, 'dist', 'index.js');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(entryPath)) {
      throw new Error(
        `缺少构建产物：${src}。请先运行根 pnpm build 与三个插件的 pnpm --filter ... run build。`,
      );
    }
    copyPluginPackage(src, pluginsDir);
  }
  ok(fs.existsSync(pluginsDir), `临时 pluginsDir 就绪（${root}）`);
}

/**
 * P-006：授权门禁已内置于 ProfileEngine.enable()——调用方直接 profile.enable(id)，
 * 内核在 mount 前自行经 approval-policy 服务 requestApprovalForManifest 判定；
 * granted 才进 enabled 并 mount，denied 不进 enabled。宿主不再需要先授权再 enable。
 */

function findLoaded(discovered, pluginId) {
  const loaded = discovered.find((p) => p.manifest.id === pluginId);
  if (!loaded) throw new Error(`内核未发现插件 ${pluginId}`);
  return loaded;
}

// ---------------------------------------------------------------------------
// 场景 A：内核加载 + enable + 正常使用 + unmount 无残留（无权限 + 服务形态）
// ---------------------------------------------------------------------------

async function scenarioDefaultShellIntegration(pluginsDir, userDataDir) {
  console.log('\n[场景 A] 内核集成：加载 / 启用 / 使用 / 卸载（note + theme-service）');

  const kernel = new IsSheepBoxKernel();
  const { boot, discovered, discoveryFailures } = await kernel.start(
    userDataDir,
    pluginsDir,
  );

  ok(boot.safeMode === false, '默认壳正常挂载，未进入安全模式');
  ok(boot.activeShell === SHELL_ID, `activeShell = ${SHELL_ID}`);
  ok(discoveryFailures.length === 0, '插件扫描无失败');

  const discoveredIds = discovered.map((p) => p.manifest.id);
  for (const pluginId of [SHELL_ID, APPROVAL_POLICY_ID, NOTE_ID, FILE_STATS_ID, THEME_ID]) {
    ok(discoveredIds.includes(pluginId), `内核发现插件 ${pluginId}`);
  }

  // 先启用 theme-service（服务提供方），再启用 note（消费方）
  await kernel.profile.enable(THEME_ID);
  await kernel.profile.enable(NOTE_ID);
  ok(kernel.lifecycle.mountedIds.includes(THEME_ID), 'theme-service 已启用并挂载');
  ok(kernel.lifecycle.mountedIds.includes(NOTE_ID), 'note 已启用并挂载');

  // —— 正常使用：面板注册（shell:ui seam）——
  const ui = kernel.services.get('shell:ui');
  ok(
    ui.panels.some((p) => p.id === 'note-main' && p.title === '我的便签'),
    'note 经 shell:ui seam 注册面板 note-main',
  );

  // —— 正常使用：theme 服务（请求/响应）——
  const theme = kernel.services.get('theme');
  ok(theme.getTheme() === 'light', 'theme 服务初始主题为 light');
  theme.setTheme('dark');
  ok(theme.getTheme() === 'dark', 'setTheme(dark) 生效');
  ok(theme.toggle() === 'light', 'toggle() 从 dark 回到 light');

  // —— 正常使用：插件间协作（note 订阅 theme:changed → 转发 note:theme-synced）——
  const synced = [];
  kernel.events.on('note:theme-synced', (payload) => synced.push(payload));
  theme.setTheme('dark');
  await tick();
  ok(synced.length === 1 && synced[0].theme === 'dark', 'note 消费 theme:changed 并转发 note:theme-synced');

  // —— 正常使用：命令事件（note:new → note:created）——
  const created = [];
  kernel.events.on('note:created', (payload) => created.push(payload));
  kernel.events.emit('note:new');
  ok(created.length === 1 && typeof created[0].at === 'number', 'note:new 触发 note:created');

  // —— unmount 无残留（内核可逆 effects：事件监听）——
  await kernel.profile.disable(NOTE_ID);
  ok(!kernel.lifecycle.mountedIds.includes(NOTE_ID), 'note 已卸载');

  theme.setTheme('light');
  await tick();
  ok(synced.length === 1, 'note 卸载后不再响应 theme:changed（事件监听已回滚）');

  kernel.events.emit('note:new');
  ok(created.length === 1, 'note 卸载后不再响应 note:new（事件监听已回滚）');

  // —— unmount 无残留：shell:ui 面板记录随插件 effect scope 自动回滚（P-007 闭环 F-006）——
  ok(
    !ui.panels.some((p) => p.id === 'note-main'),
    'note 卸载后 shell:ui 面板记录已随 effect scope 回滚（不残留）',
  );

  await kernel.stop();
  ok(kernel.lifecycle.mountedIds.length === 0, 'kernel.stop 后全部插件卸载');
}

// ---------------------------------------------------------------------------
// 场景 B：权限拒绝路径（注入 deny prompter）
// ---------------------------------------------------------------------------

async function scenarioPermissionDeny(pluginsDir, userDataDir) {
  console.log('\n[场景 B] 权限拒绝路径：拒绝授权后插件不可启用');

  const kernel = new IsSheepBoxKernel();
  const { discovered } = await kernel.start(userDataDir, pluginsDir);

  // 注入 deny prompter 的 approval-policy
  const denyPrompter = new DenyPrompter();
  const outcome = await kernel.lifecycle.mount(
    makeInjectedApprovalPolicy({ prompter: denyPrompter }),
  );
  ok(outcome.ok === true, 'approval-policy（注入 deny prompter）已挂载');
  const policy = kernel.services.get(APPROVAL_SERVICE_NAME);

  const fileStats = findLoaded(discovered, FILE_STATS_ID);

  // P-006：门禁内置于 profile.enable —— 直接 enable，由内核自行查询授权。
  // 注入的 denyPrompter 会在内部门禁内被触发一次：拒绝并记录。
  await kernel.profile.enable(fileStats.manifest.id);
  ok(
    !kernel.lifecycle.mountedIds.includes(FILE_STATS_ID),
    '拒绝后插件未被挂载（不可启用）',
  );
  ok(
    !kernel.profile.getCurrent().enabled.includes(FILE_STATS_ID),
    '拒绝后插件未进入 profile.enabled',
  );

  // 事件路径：approval:requested → approval:denied 广播
  const deniedEvents = [];
  kernel.events.on(APPROVAL_EVENTS.Denied, (payload) => deniedEvents.push(payload));
  kernel.events.emit(APPROVAL_EVENTS.Requested, {
    pluginId: FILE_STATS_ID,
    pluginName: '文件文本统计',
    permissions: ['files:read'],
    source: 'enable',
  });
  await tick();
  ok(deniedEvents.length === 1, 'approval:denied 事件已广播（拒绝路径契约）');
  ok(deniedEvents[0].pluginId === FILE_STATS_ID, 'denied 事件载荷 pluginId 正确');
  ok(
    denyPrompter.prompts === 1,
    '拒绝记录已持久化：enable 内部门禁仅提示 1 次，事件路径复用拒绝记录不重复弹窗',
  );

  // 运行时校验语义：拒绝后 checkPermission = false
  ok(policy.checkPermission(FILE_STATS_ID, 'files:read') === false, '拒绝后 checkPermission=false');

  await kernel.stop();
}

// ---------------------------------------------------------------------------
// 场景 C：权限授权路径（注入 grant-all prompter）
// ---------------------------------------------------------------------------

async function scenarioPermissionGrant(pluginsDir, userDataDir) {
  console.log('\n[场景 C] 权限授权路径：授权通过后插件启用并工作');

  const kernel = new IsSheepBoxKernel();
  const { discovered } = await kernel.start(userDataDir, pluginsDir);

  const outcome = await kernel.lifecycle.mount(
    makeInjectedApprovalPolicy({ prompter: new GrantAllPrompter() }),
  );
  ok(outcome.ok === true, 'approval-policy（注入 grant-all prompter）已挂载');
  const policy = kernel.services.get(APPROVAL_SERVICE_NAME);

  const fileStats = findLoaded(discovered, FILE_STATS_ID);

  // P-006：门禁内置于 profile.enable —— 内部门禁经 GrantAllPrompter 授权后才挂载。
  await kernel.profile.enable(fileStats.manifest.id);
  ok(kernel.lifecycle.mountedIds.includes(FILE_STATS_ID), '授权后插件已启用并挂载');
  ok(
    kernel.profile.getCurrent().enabled.includes(FILE_STATS_ID),
    '授权后插件进入 profile.enabled',
  );
  ok(policy.isApproved(FILE_STATS_ID), '授权记录为 granted');
  ok(
    policy.getGrantedPermissions(FILE_STATS_ID).includes('files:read'),
    '授予集合包含 files:read',
  );
  ok(policy.checkPermission(FILE_STATS_ID, 'files:read') === true, '运行时 checkPermission=true');

  // 正常使用：file-stats 服务（P-009：经宿主 ctx.files 读真实临时文件后统计）
  const samplesDir = path.join(userDataDir, 'samples');
  fs.mkdirSync(samplesDir, { recursive: true });
  const asciiFile = path.join(samplesDir, 'ascii.txt');
  fs.writeFileSync(asciiFile, 'a\nbb\nccc', 'utf8');
  const utf8File = path.join(samplesDir, 'utf8.txt');
  fs.writeFileSync(utf8File, '你好\nworld', 'utf8');
  const emptyFile = path.join(samplesDir, 'empty.txt');
  fs.writeFileSync(emptyFile, '', 'utf8');

  const stats = kernel.services.get('file-stats');
  ok(typeof stats.statsOfFile === 'function', 'file-stats 服务已注册可用（statsOfFile）');
  ok(
    JSON.stringify(stats.statsOfFile(asciiFile)) ===
      JSON.stringify({ lines: 3, words: 3, chars: 8, bytes: 8 }),
    'statsOfFile 读取真实 ASCII 文件统计正确（经宿主 ctx.files.readFile）',
  );
  ok(
    JSON.stringify(stats.statsOfFile(utf8File)) ===
      JSON.stringify({ lines: 2, words: 2, chars: 8, bytes: 12 }),
    'statsOfFile 读取真实中文文件统计正确（chars 按码点、bytes 按 UTF-8）',
  );
  ok(
    JSON.stringify(stats.statsOfFile(emptyFile)) ===
      JSON.stringify({ lines: 0, words: 0, chars: 0, bytes: 0 }),
    'statsOfFile 读取真实空文件统计正确',
  );

  // unmount 无残留：服务注销
  await kernel.profile.disable(FILE_STATS_ID);
  ok(!kernel.lifecycle.mountedIds.includes(FILE_STATS_ID), 'file-stats 已卸载');
  ok(!kernel.services.has('file-stats'), '卸载后 file-stats 服务已注销（可逆 effects）');

  await kernel.stop();
}

// ---------------------------------------------------------------------------
// 场景 D：FailSafePrompter 默认拒绝（未注入 prompter）
// ---------------------------------------------------------------------------

async function scenarioFailSafeDefault(pluginsDir, userDataDir) {
  console.log('\n[场景 D] FailSafePrompter：无授权 UI 时默认拒绝（无静默放行路径）');

  const kernel = new IsSheepBoxKernel();
  const { discovered } = await kernel.start(userDataDir, pluginsDir);

  const outcome = await kernel.lifecycle.mount(makeInjectedApprovalPolicy({}));
  ok(outcome.ok === true, 'approval-policy（默认选项 → FailSafePrompter）已挂载');

  const fileStats = findLoaded(discovered, FILE_STATS_ID);
  // P-006：门禁内置于 enable —— FailSafePrompter 在内部门禁内默认拒绝。
  await kernel.profile.enable(fileStats.manifest.id);
  ok(
    !kernel.lifecycle.mountedIds.includes(FILE_STATS_ID),
    'FailSafePrompter 默认拒绝下插件保持未挂载',
  );
  ok(
    !kernel.profile.getCurrent().enabled.includes(FILE_STATS_ID),
    'FailSafePrompter 默认拒绝下插件未进入 profile.enabled',
  );

  await kernel.stop();
}

// ---------------------------------------------------------------------------
// 场景 E：运行时 fail-safe（未授权强制挂载）
// ---------------------------------------------------------------------------

async function scenarioRuntimeFailSafe(pluginsDir, userDataDir) {
  console.log('\n[场景 E] 运行时 fail-safe：未授权/门禁不可用时不暴露能力、读文件被拒');

  const kernel = new IsSheepBoxKernel();
  const { discovered } = await kernel.start(userDataDir, pluginsDir);

  // 不挂载 approval-policy（模拟宿主跳过授权门禁的错误路径）
  const fileStats = findLoaded(discovered, FILE_STATS_ID);
  const outcome = await kernel.lifecycle.mount(fileStats);
  ok(outcome.ok === true, '强制挂载本身不抛错（失败隔离语义）');
  ok(
    !kernel.services.has('file-stats'),
    '未授权时插件挂载自检（第一道闸）拒绝注册 file-stats 服务（fail-safe）',
  );

  // P-009：宿主 files 能力的运行时门禁（第二道/权威闸）——即便插件被强制挂载，
  // 经 ctx.files.readFile 读真实文件也会被内核按本插件 id 门禁拒绝。
  const probeFile = path.join(userDataDir, 'probe.txt');
  fs.writeFileSync(probeFile, 'secret', 'utf8');

  // 阶段 1：approval-policy 服务未挂载 → 宿主能力 fail-safe 拒绝（无静默放行）
  const probeErrorsNoService = [];
  await kernel.lifecycle.mount({
    dir: path.join('virtual', 'probe-files-no-gate'),
    manifest: {
      id: 'org.example.probe.files-no-gate',
      name: 'files 探针（无授权服务）',
      version: '1.0.0',
      apiVersion: '^1.0.0',
      entry: 'index.js',
    },
    module: {
      default: (ctx) => {
        try {
          ctx.files.readFile(probeFile);
        } catch (e) {
          probeErrorsNoService.push(e.message);
        }
      },
    },
  });
  ok(
    probeErrorsNoService.length === 1 && /approval-policy/.test(probeErrorsNoService[0]),
    'approval-policy 未挂载时 ctx.files.readFile 被 fail-safe 拒绝（服务不可用）',
  );

  // 阶段 2：挂载 approval-policy（FailSafePrompter，不对该探针授予 files:read）
  const mounted = await kernel.lifecycle.mount(makeInjectedApprovalPolicy({}));
  ok(mounted.ok === true, '挂载 approval-policy（FailSafePrompter，不授予探针权限）');
  const probeErrorsDenied = [];
  await kernel.lifecycle.mount({
    dir: path.join('virtual', 'probe-files-denied'),
    manifest: {
      id: 'org.example.probe.files-denied',
      name: 'files 探针（未授权）',
      version: '1.0.0',
      apiVersion: '^1.0.0',
      entry: 'index.js',
    },
    module: {
      default: (ctx) => {
        try {
          ctx.files.readFile(probeFile);
        } catch (e) {
          probeErrorsDenied.push(e.message);
        }
      },
    },
  });
  ok(
    probeErrorsDenied.length === 1 && /files:read/.test(probeErrorsDenied[0]),
    'approval-policy 已挂载但探针未获 files:read 授权时，ctx.files.readFile 被拒',
  );

  await kernel.lifecycle.unmount(FILE_STATS_ID);
  await kernel.stop();
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-verify-'));
  const pluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  console.log('TASK-009 示例插件验证（验证规范 v1）');
  console.log(`临时目录: ${tmpRoot}`);
  makePluginsDir(tmpRoot, pluginsDir);

  try {
    await scenarioDefaultShellIntegration(pluginsDir, path.join(tmpRoot, 's1'));
    await scenarioPermissionDeny(pluginsDir, path.join(tmpRoot, 's2'));
    await scenarioPermissionGrant(pluginsDir, path.join(tmpRoot, 's3'));
    await scenarioFailSafeDefault(pluginsDir, path.join(tmpRoot, 's4'));
    await scenarioRuntimeFailSafe(pluginsDir, path.join(tmpRoot, 's5'));

    console.log(`\n全部通过：${checks} 项断言（5 个场景）`);
    process.exitCode = 0;
  } catch (err) {
    console.error(`\n验证失败：${err.message}`);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main();
