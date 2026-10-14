/**
 * v0.2.0「插件生态闭环」端到端验收脚本（Node 级，无 GUI）。
 *
 * 与 apps/desktop/scripts/verify-market-e2e.cjs 同一技术路径：
 * 临时目录驱动真实内核（非 mock），adm-zip 从 monorepo 现制 fixture zip，
 * MarketClient 用注入的假 fetchImpl（本地字节，不访问真实 registry / github）。
 *
 * 与 verify-market-e2e 的差异（验收深度所在）：
 *  - approval-policy 不经编程注入，而是作为磁盘真实包放进临时 pluginsDir，
 *    由内核 ensureApprovalPolicyServiceReady() 以基础设施语义自动挂载；
 *    其默认接线必须真实生效：host:user-data → DiskApprovalStore（approvals.json
 *    落盘）、approval-ui → shell-default 真实注册的 C1 事件往返服务。
 *  - 假桥只模拟宿主渲染进程：监听内核事件 approval:ui-request → 按预设决策
 *    回 approval:ui-response（token 关联）。
 *
 * 前置（先构建、后验证，推送的树 = 验证的树）：
 *   pnpm install
 *   pnpm run build
 *   pnpm --filter @issheepbox/plugin-note --filter @issheepbox/plugin-file-stats run build
 *
 * 运行：
 *   node apps/desktop/scripts/verify-v020-acceptance.cjs
 *
 * 覆盖（对齐 v0.2.0 验收主路径）：
 *  场景 1  市场安装 note（无权限）→ 直通 → enabled+mounted → shell:ui panels
 *          含 note-main 且 C4 面板内容元数据齐全（pluginId/src='assets/panel.html'
 *          /width=360/height=240）→ 插件包 assets/panel.html 落盘可读
 *          （渲染侧 shell:read-plugin-asset 的数据前提）
 *  场景 2  市场安装 file-stats → enable → 真实 C1 授权往返：
 *          approval:ui-request 载荷（token/pluginId/pluginName/permissions，
 *          files:read 的 PermissionInfo[label/description/risk]）→ 假桥回 deny
 *          → 不进 enabled、未挂载；approvals.json 落 denied 记录
 *  场景 3  启动恢复门禁（source='boot'）：手工构造 profile.enabled 含 file-stats
 *          但 approvals.json 为空 → 新内核 start → file-stats 未挂载、
 *          mountFailures 含门禁原因、profile.enabled 不变、不弹窗、不落记录；
 *          无权限插件不受影响
 *  场景 4  授权持久化跨重启保留：实例一 enable(file-stats) 经假桥 grant-all
 *          → granted 落盘 approvals.json → 新内核实例（同 userData）start
 *          → boot 门禁查磁盘 granted 记录 → file-stats 自动挂载（不弹窗）
 *
 * 边界：成功路径一律本地 fixture zip，不伪造真实网络下载；不打 tag。
 */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IsSheepBoxKernel } = require('../../../packages/kernel/dist/index.js');

const repoRoot = path.join(__dirname, '..', '..', '..');
const pluginsRoot = path.join(repoRoot, 'packages', 'plugins');

// adm-zip 是 market-client 的依赖：从 market-client 的解析位置拿（同 verify-market-e2e）。
const marketClientDir = path.dirname(
  require.resolve('@issheepbox/market-client/dist/index.js'),
);
const AdmZip = require(require.resolve('adm-zip', { paths: [marketClientDir] }));
const { MarketClient } = require('@issheepbox/market-client');

const SHELL_DEFAULT_ID = 'org.issheepbox.shell-default';
const APPROVAL_POLICY_ID = 'org.issheepbox.approval-policy';
const NOTE_ID = 'org.issheepbox.example.note';
const FILE_STATS_ID = 'org.issheepbox.example.file-stats';
const PANEL_ID = 'note-main';

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}

// ---------------------------------------------------------------------------
// 工具：复制插件包 / 现制 fixture zip（同 verify-market-e2e.cjs 手法）
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

/** 把插件包目录打成 zip（顶层目录名 = topDirId；排除 node_modules/src）。 */
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

/** 假宿主桥（模拟 desktop 渲染进程权限清单对话框）：
 *  监听内核事件 approval:ui-request（壳 approval-ui 服务发出）→ 按预设决策
 *  回 approval:ui-response（token 关联）。返回请求记录数组供断言。 */
function attachUiBridge(kernel, decideResult) {
  const requests = [];
  kernel.events.on('approval:ui-request', (req) => {
    requests.push(req);
    kernel.events.emit('approval:ui-response', {
      token: req.token,
      result: decideResult(req),
    });
  });
  return requests;
}

/** 安装后重扫 pluginsDir 并刷新内核可用插件表（main.ts 安装编排同构）。 */
function rescan(kernel, pluginsDir) {
  const discovery = kernel.loader.loadAll(pluginsDir);
  const resolved = kernel.dependency.resolveOrder(discovery.loaded);
  kernel.profile.setAvailablePlugins(resolved.ordered);
  return resolved.ordered;
}

/** 手工构造 userData：profile.enabled 含指定插件、但 approvals.json 不存在。 */
function writeProfileWithEnabled(userDataDir, enabled) {
  const profilesDir = path.join(userDataDir, 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  const profile = {
    name: 'default',
    shell: SHELL_DEFAULT_ID,
    enabled,
    pluginConfig: Object.fromEntries(enabled.map((id) => [id, {}])),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(path.join(profilesDir, 'current.json'), JSON.stringify({ name: 'default' }, null, 2));
  fs.writeFileSync(path.join(profilesDir, 'default.json'), JSON.stringify(profile, null, 2));
}

function readApprovals(userDataDir) {
  const file = path.join(userDataDir, 'approvals.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-v020-accept-'));
  try {
    await run(tmpRoot);
  } catch (err) {
    console.error(`\n验收失败：${err.message}`);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function run(tmpRoot) {
  const pluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const userData1 = path.join(tmpRoot, 'userData1');
  const userData2 = path.join(tmpRoot, 'userData2');
  const userData3 = path.join(tmpRoot, 'userData3');
  fs.mkdirSync(userData1, { recursive: true });
  fs.mkdirSync(userData2, { recursive: true });
  fs.mkdirSync(userData3, { recursive: true });

  console.log(`v0.2.0 插件生态闭环 e2e 验收`);
  console.log(`临时目录: ${tmpRoot}`);

  // 磁盘 pluginsDir 预置第一方基础设施真实包：shell-default + approval-policy。
  copyPluginPackage(path.join(repoRoot, 'packages', 'shell-default'), pluginsDir);
  ok(fs.existsSync(path.join(pluginsDir, 'shell-default', 'plugin.json')), 'pluginsDir 预置 shell-default 真实包');
  copyPluginPackage(path.join(repoRoot, 'packages', 'approval-policy'), pluginsDir);
  ok(fs.existsSync(path.join(pluginsDir, 'approval-policy', 'plugin.json')), 'pluginsDir 预置 approval-policy 真实包');

  // fixture zip 字节（note / file-stats，均含 dist 与 assets）。
  const noteZip = makePluginZip(path.join(pluginsRoot, 'note'), NOTE_ID);
  const fileStatsZip = makePluginZip(path.join(pluginsRoot, 'file-stats'), FILE_STATS_ID);

  // registry fixture 索引。
  const REGISTRY_URL = 'http://fixture.local/plugins.json';
  const downloadUrls = {
    note: 'http://fixture.local/note.zip',
    fileStats: 'http://fixture.local/file-stats.zip',
  };
  const downloads = new Map([
    [downloadUrls.note, noteZip],
    [downloadUrls.fileStats, fileStatsZip],
  ]);
  const registryIndex = {
    registryVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    plugins: [
      {
        id: NOTE_ID,
        name: '便签',
        description: '纯 UI 面板示例插件',
        author: 'Is Sheep Box',
        version: '1.0.0',
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
    ],
  };

  // 假 fetchImpl：registryUrl → 索引 JSON；其他 URL → downloads 表里的 zip 字节。
  async function fakeFetch(url) {
    if (url === REGISTRY_URL) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(registryIndex),
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

  const marketClient = new MarketClient({
    registryUrl: REGISTRY_URL,
    pluginsDir,
    fetchImpl: fakeFetch,
  });

  // =========================================================================
  // 内核 A（userData1）：场景 1 + 场景 2
  // =========================================================================
  console.log('\n[场景 1] 市场安装无权限插件 note → 直通 → C4 面板内容元数据');
  const kernelA = new IsSheepBoxKernel();
  // 契约 C3：宿主在 kernel.start() 前注册 host:user-data { dir }。
  kernelA.services.register('host:user-data', { dir: userData1 });
  const bootA = await kernelA.start(userData1, pluginsDir);
  ok(bootA.boot.safeMode === false, 'shell-default 正常挂载，未进入安全模式');
  ok(kernelA.services.has('host:user-data'), 'host:user-data 宿主服务已注册（契约 C3）');

  // 假宿主桥：file-stats 一律拒绝（场景 2 用）。
  const requestsA = attachUiBridge(kernelA, () => ({ kind: 'deny' }));

  const installedNote = await marketClient.install(NOTE_ID);
  ok(installedNote.version === '1.0.0', `install(note) 返回版本 ${installedNote.version}`);
  ok(
    fs.existsSync(path.join(pluginsDir, NOTE_ID, 'plugin.json')),
    'note 包已落盘 pluginsDir',
  );

  const orderedA = rescan(kernelA, pluginsDir);
  ok(orderedA.some((p) => p.manifest.id === NOTE_ID), '重扫后内核发现 note');

  await kernelA.profile.enable(NOTE_ID);
  ok(kernelA.lifecycle.mountedIds.includes(NOTE_ID), 'note 无权限直通，已启用并挂载');
  ok(requestsA.length === 0, '无权限插件启用未触发授权请求');

  const uiA = kernelA.services.get('shell:ui');
  const panelA = uiA.panels.find((p) => p.id === PANEL_ID);
  ok(!!panelA, 'shell:ui panels 含 note-main 面板');
  ok(typeof panelA.title === 'string' && panelA.title.length > 0, '面板 title 非空');
  ok(panelA.pluginId === NOTE_ID, '面板元数据 pluginId 正确（契约 C4）');
  ok(panelA.src === 'assets/panel.html', '面板元数据 src=assets/panel.html（契约 C4）');
  ok(panelA.width === 360, '面板元数据 width=360（契约 C4）');
  ok(panelA.height === 240, '面板元数据 height=240（契约 C4）');

  const panelHtmlPath = path.join(pluginsDir, NOTE_ID, 'assets', 'panel.html');
  ok(fs.existsSync(panelHtmlPath), '插件包 assets/panel.html 已落盘（shell:read-plugin-asset 数据前提）');
  ok(fs.readFileSync(panelHtmlPath, 'utf8').length > 0, 'assets/panel.html 可读且非空');

  // =========================================================================
  // 场景 2：带权限插件安装 → C1 授权清单往返 → 拒绝不可启用
  // =========================================================================
  console.log('\n[场景 2] 安装 file-stats → C1 授权往返 → 拒绝 → approvals.json 落盘');
  await marketClient.install(FILE_STATS_ID);
  ok(fs.existsSync(path.join(pluginsDir, FILE_STATS_ID, 'plugin.json')), 'file-stats 包已落盘 pluginsDir');
  rescan(kernelA, pluginsDir);

  await kernelA.profile.enable(FILE_STATS_ID);
  ok(
    !kernelA.lifecycle.mountedIds.includes(FILE_STATS_ID),
    '授权被拒后 file-stats 未挂载（不可启用）',
  );
  ok(
    !kernelA.profile.getCurrent().enabled.includes(FILE_STATS_ID),
    '授权被拒后 file-stats 未进入 profile.enabled',
  );
  ok(requestsA.length === 1, '恰好收到 1 次 approval:ui-request（C1 往返）');

  const req = requestsA[0];
  ok(typeof req.token === 'string' && req.token.length > 0, '请求载荷带 token');
  ok(req.pluginId === FILE_STATS_ID, '请求载荷 pluginId 正确');
  ok(typeof req.pluginName === 'string' && req.pluginName.length > 0, '请求载荷 pluginName 非空');
  ok(Array.isArray(req.permissions) && req.permissions.length === 1, '请求载荷 permissions 恰含 1 项');
  ok(req.permissions[0].id === 'files:read', '权限清单首项 id=files:read');
  ok(typeof req.permissions[0].label === 'string' && req.permissions[0].label.length > 0, 'PermissionInfo.label 非空');
  ok(typeof req.permissions[0].description === 'string' && req.permissions[0].description.length > 0, 'PermissionInfo.description 非空');
  ok(['low', 'medium', 'high'].includes(req.permissions[0].risk), 'PermissionInfo.risk ∈ low/medium/high');

  const approvals1 = readApprovals(userData1);
  ok(Array.isArray(approvals1), 'approvals.json 已落盘（DiskApprovalStore 经 host:user-data）');
  const deniedRec = approvals1.find((r) => r.pluginId === FILE_STATS_ID);
  ok(!!deniedRec && deniedRec.status === 'denied', 'approvals.json 含 file-stats 的 denied 记录');

  await kernelA.stop();

  // =========================================================================
  // 场景 3：启动恢复门禁（source='boot'）—— userData2 手工构造 enabled
  // =========================================================================
  console.log('\n[场景 3] 启动恢复门禁：profile.enabled 含 file-stats 但无授权记录 → boot 拒绝');
  writeProfileWithEnabled(userData2, [SHELL_DEFAULT_ID, NOTE_ID, FILE_STATS_ID]);

  const kernelB = new IsSheepBoxKernel();
  kernelB.services.register('host:user-data', { dir: userData2 });
  const requestsB = attachUiBridge(kernelB, () => {
    throw new Error('启动路径不应弹窗！');
  });
  const bootB = await kernelB.start(userData2, pluginsDir);
  ok(bootB.boot.safeMode === false, 'kernel B：shell-default 正常挂载，未进入安全模式');
  ok(kernelB.lifecycle.mountedIds.includes(SHELL_DEFAULT_ID), 'kernel B：shell-default 已挂载');
  ok(kernelB.lifecycle.mountedIds.includes(NOTE_ID), 'kernel B：无权限插件 note 不受影响，已挂载');
  ok(
    !kernelB.lifecycle.mountedIds.includes(FILE_STATS_ID),
    'kernel B：未授权 file-stats 未挂载（boot 门禁拒绝）',
  );
  const failB = bootB.boot.mountFailures.find((f) => f.pluginId === FILE_STATS_ID);
  ok(!!failB, 'kernel B：mountFailures 记录含 file-stats');
  ok(failB.error.message.includes('门禁'), 'kernel B：挂载失败原因写明启动恢复路径门禁');
  ok(
    kernelB.profile.getCurrent().enabled.includes(FILE_STATS_ID),
    'kernel B：profile.enabled 保持不变（file-stats 仍在启用列表，待会话内重新授权）',
  );
  ok(requestsB.length === 0, 'kernel B：boot 路径不弹窗（无 approval:ui-request）');
  ok(readApprovals(userData2) === null, 'kernel B：boot 路径不落 denied 记录（approvals.json 未创建）');

  await kernelB.stop();

  // =========================================================================
  // 场景 4：授权持久化跨重启保留（userData3：grant-all → 落盘 → 新内核复用）
  // =========================================================================
  console.log('\n[场景 4] 授权持久化：grant-all 落盘 → 新内核 boot 自动复用授权');
  const kernelC = new IsSheepBoxKernel();
  kernelC.services.register('host:user-data', { dir: userData3 });
  await kernelC.start(userData3, pluginsDir);
  const requestsC = attachUiBridge(kernelC, () => ({ kind: 'grant-all' }));

  rescan(kernelC, pluginsDir);
  await kernelC.profile.enable(NOTE_ID);
  ok(kernelC.lifecycle.mountedIds.includes(NOTE_ID), 'kernel C：note 已启用并挂载');
  await kernelC.profile.enable(FILE_STATS_ID);
  ok(kernelC.lifecycle.mountedIds.includes(FILE_STATS_ID), 'kernel C：file-stats 经 grant-all 授权后已挂载');
  ok(kernelC.profile.getCurrent().enabled.includes(FILE_STATS_ID), 'kernel C：file-stats 已进入 profile.enabled');
  ok(requestsC.length === 1, 'kernel C：file-stats 启用触发 1 次授权请求（grant-all）');

  const approvals3 = readApprovals(userData3);
  const grantedRec = approvals3.find((r) => r.pluginId === FILE_STATS_ID);
  ok(!!grantedRec && grantedRec.status === 'granted', 'kernel C：granted 记录已落盘 approvals.json');
  ok(grantedRec.permissions.includes('files:read'), 'kernel C：granted 记录含 files:read');
  await kernelC.stop();

  // 新内核实例（同 userData3）：boot 门禁查磁盘 granted 记录，授权跨重启保留。
  const kernelD = new IsSheepBoxKernel();
  kernelD.services.register('host:user-data', { dir: userData3 });
  const requestsD = attachUiBridge(kernelD, () => {
    throw new Error('boot 复用授权记录，不应弹窗！');
  });
  const bootD = await kernelD.start(userData3, pluginsDir);
  ok(bootD.boot.safeMode === false, 'kernel D：boot 正常，未进入安全模式');
  ok(kernelD.lifecycle.mountedIds.includes(NOTE_ID), 'kernel D：note 保持挂载');
  ok(
    kernelD.lifecycle.mountedIds.includes(FILE_STATS_ID),
    'kernel D：file-stats 经磁盘 granted 记录自动挂载（授权跨重启保留）',
  );
  ok(requestsD.length === 0, 'kernel D：boot 复用 granted 记录，不弹窗');
  ok(bootD.boot.mountFailures.length === 0, 'kernel D：boot 无挂载失败');
  const uiD = kernelD.services.get('shell:ui');
  ok(
    uiD.panels.some((p) => p.id === PANEL_ID && p.pluginId === NOTE_ID && p.src === 'assets/panel.html'),
    'kernel D：重挂后 note 面板 C4 元数据重新注册',
  );
  await kernelD.stop();

  console.log(`\n全部通过：${checks} 项断言（4 个场景）`);
  process.exitCode = 0;
}

main();
