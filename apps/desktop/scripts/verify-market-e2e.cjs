/**
 * TASK-012 市场安装链路端到端验证（Node 级，无 GUI）。
 *
 * 仿 packages/plugins/verify-examples.cjs 与 scripts/verify-builtin-refresh.cjs 模式：
 * 临时 userData/plugins 目录驱动真实内核（非 mock），market-client 用注入的
 * 假 fetchImpl（本地 fixture zip，不访问真实 registry / github）。
 *
 * 前置（先构建、后验证，推送的树 = 验证的树）：
 *   pnpm install --ignore-scripts
 *   pnpm run build                                    # 全工作区 tsc
 *   pnpm --filter @issheepbox/plugin-note --filter \
 *        @issheepbox/plugin-file-stats run build      # 示例插件 dist
 *
 * 运行：
 *   node apps/desktop/scripts/verify-market-e2e.cjs
 *
 * 覆盖（对齐 TASK-012 验收标准）：
 *  场景 1  干净状态 → 安装 note（本地 fixture zip）→ 无权限直通 → enabled+mounted
 *          → shell:ui panels 含 note 面板（id/title 存在）
 *  场景 2  安装 file-stats（fixture）→ enable 触发 C1 授权往返：
 *          收到 approval:ui-request（PermissionInfo 形状）→ 回 approval:ui-response(deny)
 *          → 不可启用 / 未挂载
 *  场景 3  容错：网络失败（fetchImpl 抛错）→ NETWORK；损坏 zip → INVALID_ZIP 且无残留；
 *          顶层目录名≠id → ID_MISMATCH 且无残留；重复安装 → ALREADY_INSTALLED；
 *          uninstall('../evil') → INVALID_PLUGIN_ID；卸载未安装 → NOT_INSTALLED
 *  场景 4  卸载 note → 目录移除 → 可重装；update：registry v1.0.1 > 本地 v1.0.0
 *          → 原子替换成功；再 update → updated=false（已是最新）
 *
 * 边界：本机 github.com 不可达，真实下载路径不做成功测试；成功路径一律本地 fixture zip。
 * approval-policy 不在磁盘临时 pluginsDir 内，按 verify-examples.cjs 既有做法经
 * kernel.lifecycle.mount 注入（prompter 模拟 TASK-013 shell-default 的 C1 事件协议）。
 */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IsSheepBoxKernel } = require('../../../packages/kernel/dist/index.js');
const { createApprovalPolicyPlugin } = require('../../../packages/approval-policy/dist/index.js');
const { MarketClient, MarketInstallError } = require('../../../packages/market-client/dist/index.js');

const repoRoot = path.join(__dirname, '..', '..', '..');
const pluginsRoot = path.join(repoRoot, 'packages', 'plugins');

// adm-zip 是 market-client 的依赖：从 market-client 的解析位置拿。
const marketClientDir = path.dirname(
  require.resolve('@issheepbox/market-client/dist/index.js'),
);
const AdmZip = require(require.resolve('adm-zip', { paths: [marketClientDir] }));

const APPROVAL_POLICY_ID = 'org.issheepbox.approval-policy';
const NOTE_ID = 'org.issheepbox.example.note';
const FILE_STATS_ID = 'org.issheepbox.example.file-stats';
const CORRUPT_ID = 'org.issheepbox.example.corrupt';
const TOPMISMATCH_ID = 'org.issheepbox.example.top-mismatch';

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}

// ---------------------------------------------------------------------------
// 工具：构造 fixture zip（顶层目录 = 插件 id）
// ---------------------------------------------------------------------------

function copyPluginPackage(srcDir, destRoot) {
  fs.cpSync(srcDir, path.join(destRoot, path.basename(srcDir)), {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== 'node_modules' && base !== 'src';
    },
  });
}

/** 把插件包目录打成 zip（顶层目录名 = topDirId；排除 node_modules/src，贴合真实包形态）。 */
function makePluginZip(srcDir, topDirId) {
  const zip = new AdmZip();
  for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const rel = path.relative(srcDir, abs).split(path.sep).join('/');
    if (rel === 'node_modules' || rel.startsWith('node_modules/') || rel === 'src' || rel.startsWith('src/')) {
      continue;
    }
    zip.addLocalFile(abs, `${topDirId}/${path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)}`);
  }
  return zip.toBuffer();
}

/** 构造一个「顶层目录名 ≠ 插件 id」的非法 zip。 */
function makeWrongTopDirZip(pluginDir, topDirName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-wrongtop-'));
  try {
    copyPluginPackage(pluginDir, tmp);
    return makePluginZip(path.join(tmp, path.basename(pluginDir)), topDirName);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** C1 桥 prompter（模拟 TASK-013 shell-default 的 ApprovalPrompter）：
 *  发内核事件 approval:ui-request（带 token）→ 等待 approval:ui-response。 */
class UiBridgePrompter {
  constructor(events) {
    this.events = events;
    this.n = 0;
  }

  async prompt(request) {
    const token = `tok-${++this.n}`;
    return await new Promise((resolve) => {
      // 先注册响应监听再 emit 请求（模拟真实 IPC 异步往返，避免同步响应丢失）。
      const off = this.events.on('approval:ui-response', (payload) => {
        if (payload.token !== token) return;
        off();
        resolve(payload.result);
      });
      this.events.emit('approval:ui-request', { token, ...request });
    });
  }
}

function makeInjectedApprovalPolicy(prompter) {
  const factory = createApprovalPolicyPlugin({ prompter });
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

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-market-e2e-'));
  try {
    await run(tmpRoot);
  } catch (err) {
    console.error(`\n验证失败：${err.message}`);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function run(tmpRoot) {
  const userDataDir = path.join(tmpRoot, 'userData');
  fs.mkdirSync(userDataDir, { recursive: true });
  const pluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  console.log(`TASK-012 市场安装链路 e2e`);
  console.log(`临时目录: ${tmpRoot}`);

  // 磁盘临时 pluginsDir 只放默认壳（shell-default）；note/file-stats 走市场安装。
  copyPluginPackage(path.join(repoRoot, 'packages', 'shell-default'), pluginsDir);
  ok(fs.existsSync(path.join(pluginsDir, 'shell-default', 'plugin.json')), '临时 pluginsDir 就绪（含 shell-default）');

  // 准备 fixture zip 字节。
  const noteV1Zip = makePluginZip(path.join(pluginsRoot, 'note'), NOTE_ID);
  const fileStatsZip = makePluginZip(path.join(pluginsRoot, 'file-stats'), FILE_STATS_ID);
  const corruptZip = Buffer.from('this is not a zip at all');
  const wrongTopZip = makeWrongTopDirZip(path.join(pluginsRoot, 'note'), 'wrong-top-dir');

  // note v1.0.1 zip（把复制件的 plugin.json version 改成 1.0.1）。
  const noteV101Src = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-note-v101-'));
  try {
    copyPluginPackage(path.join(pluginsRoot, 'note'), noteV101Src);
    const manifestPath = path.join(noteV101Src, 'note', 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = '1.0.1';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    var noteV101Zip = makePluginZip(path.join(noteV101Src, 'note'), NOTE_ID);
  } finally {
    fs.rmSync(noteV101Src, { recursive: true, force: true });
  }

  // registry fixture 索引（可变：note 版本随 update 场景切换）。
  const REGISTRY_URL = 'http://fixture.local/plugins.json';
  const downloadUrls = {
    note: 'http://fixture.local/note.zip',
    fileStats: 'http://fixture.local/file-stats.zip',
    corrupt: 'http://fixture.local/corrupt.zip',
    wrongTop: 'http://fixture.local/wrong-top.zip',
  };
  const downloads = new Map([
    [downloadUrls.note, noteV1Zip],
    [downloadUrls.fileStats, fileStatsZip],
    [downloadUrls.corrupt, corruptZip],
    [downloadUrls.wrongTop, wrongTopZip],
  ]);
  function registryIndex(noteVersion) {
    return {
      registryVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      plugins: [
        {
          id: NOTE_ID,
          name: '便签',
          description: '纯 UI 面板示例插件',
          author: 'Is Sheep Box',
          version: noteVersion,
          apiVersion: '^1.0.0',
          repository: 'http://fixture.local/note',
          releaseUrl: 'http://fixture.local/note',
          downloadUrl: downloadUrls.note,
          permissions: [],
          publishedAt: new Date().toISOString(),
        },
        {
          id: FILE_STATS_ID,
          name: '文件统计',
          description: '带 files:read 权限的示例插件',
          author: 'Is Sheep Box',
          version: '1.0.0',
          apiVersion: '^1.0.0',
          repository: 'http://fixture.local/fs',
          releaseUrl: 'http://fixture.local/fs',
          downloadUrl: downloadUrls.fileStats,
          permissions: ['files:read'],
          publishedAt: new Date().toISOString(),
        },
        {
          id: CORRUPT_ID,
          name: '损坏包',
          description: '损坏 zip 的安装失败用例',
          author: 'Is Sheep Box',
          version: '1.0.0',
          apiVersion: '^1.0.0',
          repository: 'http://fixture.local/c',
          releaseUrl: 'http://fixture.local/c',
          downloadUrl: downloadUrls.corrupt,
          permissions: [],
          publishedAt: new Date().toISOString(),
        },
        {
          id: TOPMISMATCH_ID,
          name: '顶层不匹配',
          description: 'zip 顶层目录名≠id 的安装失败用例',
          author: 'Is Sheep Box',
          version: '1.0.0',
          apiVersion: '^1.0.0',
          repository: 'http://fixture.local/t',
          releaseUrl: 'http://fixture.local/t',
          downloadUrl: downloadUrls.wrongTop,
          permissions: [],
          publishedAt: new Date().toISOString(),
        },
      ],
    };
  }
  let currentNoteVersion = '1.0.0';

  // 假 fetchImpl：registryUrl → 索引 JSON；其他 URL → downloads 表里的 zip 字节。
  async function fakeFetch(url) {
    if (url === REGISTRY_URL) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(registryIndex(currentNoteVersion)),
      };
    }
    const buf = downloads.get(url);
    if (buf) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    }
    throw new Error(`ECONNREFUSED ${url}`);
  }

  const kernel = new IsSheepBoxKernel();
  // 契约 C3：main.ts 在 kernel.start() 前注册 host:user-data。此处复现该注册。
  kernel.services.register('host:user-data', { dir: userDataDir });

  const { boot } = await kernel.start(userDataDir, pluginsDir);
  ok(boot.safeMode === false, '默认壳正常挂载，未进入安全模式');
  ok(kernel.services.has('host:user-data'), 'host:user-data 宿主服务已注册（契约 C3）');

  // C1 假桥（模拟 main.ts 桥：收到 approval:ui-request 即按规则回 approval:ui-response）。
  const uiRequests = [];
  kernel.events.on('approval:ui-request', (req) => {
    uiRequests.push(req);
    // 规则：file-stats 一律拒绝。
    const result = { kind: 'deny' };
    kernel.events.emit('approval:ui-response', { token: req.token, result });
  });

  // approval-policy 编程挂载（verify-examples.cjs 模式），prompter 走 C1 事件协议。
  const mounted = await kernel.lifecycle.mount(makeInjectedApprovalPolicy(new UiBridgePrompter(kernel.events)));
  ok(mounted.ok === true, 'approval-policy（注入 C1 桥 prompter）已挂载');

  const client = new MarketClient({ registryUrl: REGISTRY_URL, pluginsDir, fetchImpl: fakeFetch });

  // -------------------------------------------------------------------------
  // 场景 1：安装 note（无权限直通）→ enabled + mounted + panels
  // -------------------------------------------------------------------------
  console.log('\n[场景 1] 安装 note → 无权限直通 → 面板注册');
  const installedNote = await client.install(NOTE_ID);
  ok(installedNote.version === '1.0.0', `install(note) 返回版本 ${installedNote.version}`);
  ok(fs.existsSync(path.join(installedNote.dir, 'plugin.json')), 'note 包已落盘 pluginsDir');

  // 重新发现插件（main.ts 安装编排同构）。
  const discovery = kernel.loader.loadAll(pluginsDir);
  const resolved = kernel.dependency.resolveOrder(discovery.loaded);
  kernel.profile.setAvailablePlugins(resolved.ordered);
  ok(resolved.ordered.some((p) => p.manifest.id === NOTE_ID), '重扫后内核发现 note');

  await kernel.profile.enable(NOTE_ID);
  ok(kernel.lifecycle.mountedIds.includes(NOTE_ID), 'note 无权限直通，已启用并挂载');
  ok(uiRequests.length === 0, '无权限插件未触发授权请求');
  const ui = kernel.services.get('shell:ui');
  ok(
    ui.panels.some((p) => p.id === 'note-main' && !!p.title),
    'shell:ui panels 含 note 面板（id/title 存在，契约 C4 形状）',
  );

  // -------------------------------------------------------------------------
  // 场景 2：安装 file-stats → C1 授权往返 → 拒绝 → 不可启用
  // -------------------------------------------------------------------------
  console.log('\n[场景 2] 安装 file-stats → C1 授权往返 → 拒绝');
  await client.install(FILE_STATS_ID);
  const discovery2 = kernel.loader.loadAll(pluginsDir);
  const resolved2 = kernel.dependency.resolveOrder(discovery2.loaded);
  kernel.profile.setAvailablePlugins(resolved2.ordered);

  await kernel.profile.enable(FILE_STATS_ID);
  ok(
    !kernel.lifecycle.mountedIds.includes(FILE_STATS_ID),
    '授权被拒后 file-stats 未挂载（不可启用）',
  );
  ok(
    !kernel.profile.getCurrent().enabled.includes(FILE_STATS_ID),
    '授权被拒后 file-stats 未进入 profile.enabled',
  );
  ok(uiRequests.length === 1, '恰好收到 1 次 approval:ui-request（C1 往返）');
  const req = uiRequests[0];
  ok(typeof req.token === 'string' && req.token.length > 0, '请求载荷带 token');
  ok(req.pluginId === FILE_STATS_ID, '请求载荷 pluginId 正确');
  ok(
    Array.isArray(req.permissions) &&
      req.permissions.length === 1 &&
      req.permissions[0].id === 'files:read' &&
      typeof req.permissions[0].label === 'string' &&
      ['low', 'medium', 'high'].includes(req.permissions[0].risk),
    '请求载荷 permissions 为 PermissionInfo 形状（id/label/risk）',
  );

  // -------------------------------------------------------------------------
  // 场景 3：容错（网络失败 / 损坏 zip / 顶层不匹配 / 重复安装 / id 守卫）
  // -------------------------------------------------------------------------
  console.log('\n[场景 3] 容错路径');

  // 3a. 网络失败：fetchImpl 抛错 → NETWORK。
  const netClient = new MarketClient({
    registryUrl: REGISTRY_URL,
    pluginsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'isb-net-')),
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  let err = null;
  try {
    await netClient.install(CORRUPT_ID);
  } catch (e) {
    err = e;
  }
  ok(err instanceof MarketInstallError && err.code === 'NETWORK', '网络失败抛 MarketInstallError(NETWORK)');

  // 3b. 损坏 zip → INVALID_ZIP 且无残留。
  err = null;
  try {
    await client.install(CORRUPT_ID);
  } catch (e) {
    err = e;
  }
  ok(err instanceof MarketInstallError && err.code === 'INVALID_ZIP', '损坏 zip 抛 INVALID_ZIP');
  ok(
    !fs.existsSync(path.join(pluginsDir, CORRUPT_ID)),
    '损坏 zip 失败后 pluginsDir 无半解压残留',
  );

  // 3c. 顶层目录名 ≠ id → ID_MISMATCH 且无残留。
  err = null;
  try {
    await client.install(TOPMISMATCH_ID);
  } catch (e) {
    err = e;
  }
  ok(err instanceof MarketInstallError && err.code === 'ID_MISMATCH', '顶层目录名≠id 抛 ID_MISMATCH');
  ok(
    !fs.existsSync(path.join(pluginsDir, TOPMISMATCH_ID)) &&
      !fs.existsSync(path.join(pluginsDir, 'wrong-top-dir')),
    'ID_MISMATCH 失败后 pluginsDir 无残留',
  );

  // 3d. 重复安装 → ALREADY_INSTALLED。
  err = null;
  try {
    await client.install(NOTE_ID);
  } catch (e) {
    err = e;
  }
  ok(err instanceof MarketInstallError && err.code === 'ALREADY_INSTALLED', '重复安装抛 ALREADY_INSTALLED');

  // 3e. id 守卫：uninstall 邪恶路径 / 未安装卸载。
  err = null;
  try {
    await client.uninstall('../escape');
  } catch (e) {
    err = e;
  }
  ok(err instanceof MarketInstallError && err.code === 'INVALID_PLUGIN_ID', "uninstall('../escape') 被 id 守卫拒绝");
  err = null;
  try {
    await client.uninstall('org.issheepbox.example.no-such');
  } catch (e) {
    err = e;
  }
  ok(err instanceof MarketInstallError && err.code === 'NOT_INSTALLED', '卸载未安装插件抛 NOT_INSTALLED');

  // -------------------------------------------------------------------------
  // 场景 4：卸载 note → 重装；update v1.0.0 → v1.0.1 原子替换
  // -------------------------------------------------------------------------
  console.log('\n[场景 4] 卸载/重装 + update 原子替换');
  await kernel.profile.disable(NOTE_ID);
  await client.uninstall(NOTE_ID);
  ok(!fs.existsSync(path.join(pluginsDir, NOTE_ID)), 'uninstall(note) 目录已移除');

  await client.install(NOTE_ID);
  ok(fs.existsSync(path.join(pluginsDir, NOTE_ID, 'plugin.json')), '卸载后可重装 note');

  // update：registry 切到 v1.0.1，downloads 切到 v1.0.1 zip。
  currentNoteVersion = '1.0.1';
  downloads.set(downloadUrls.note, noteV101Zip);
  const updated = await client.update(NOTE_ID);
  ok(updated.updated === true && updated.version === '1.0.1', 'update 替换到 registry v1.0.1');
  const afterManifest = JSON.parse(
    fs.readFileSync(path.join(pluginsDir, NOTE_ID, 'plugin.json'), 'utf8'),
  );
  ok(afterManifest.version === '1.0.1', '落盘 plugin.json 版本已翻到 1.0.1');

  const noop = await client.update(NOTE_ID);
  ok(noop.updated === false && noop.version === '1.0.1', '再次 update 不下载（updated=false）');

  await kernel.stop();
  ok(kernel.lifecycle.mountedIds.length === 0, 'kernel.stop 后全部插件卸载');

  console.log(`\n全部通过：${checks} 项断言（4 个场景）`);
  process.exitCode = 0;
}

main();
