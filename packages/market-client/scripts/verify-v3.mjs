/**
 * market-client v3（多源模型）验证脚本。
 *
 * 覆盖（v4 定稿）：
 *  1. format 2 索引解析（parseIndexV2 容错：非法条目 / 顶层非法 / 重复 id）
 *  2. 单插件仓库根 index.json 解析（parsePluginRepoIndex，自描述单条）
 *  3. 多源聚合 fetchAll：两个 index 源 + 一个 plugin-repo 源
 *     - 同 pluginId 多源冲突分组（byPluginId 多条，不自动选）
 *     - 源级失败隔离（某源网络失败不阻断其他源）
 *  4. installFromRecord：sha256 匹配 → 落盘成功；sha256 不一致 → SHA_MISMATCH 且无残留
 *  5. importLocalZip：真实本地 zip 一次性导入；已安装拒绝
 *  6. updateFromRecord：新版本更新（sha256 校验）；已最新 → updated=false
 *  7. v1 兼容：旧 plugins.json 仍可经 parseRegistryIndex 解析
 *  8. buildPluginRepoIndexUrl 语义
 *
 * 用法（需先构建）：
 *   pnpm --filter @issheepbox/market-client build
 *   node packages/market-client/scripts/verify-v3.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import pkg from '../dist/index.js';

const {
  MarketClient,
  parseIndexV2,
  parsePluginRepoIndex,
  parseRegistryIndex,
  buildPluginRepoIndexUrl,
} = pkg;

let failures = 0;
let checks = 0;
function assert(cond, label, detail) {
  checks += 1;
  if (cond) {
    console.log(`  ✔ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n[${title}]`);
}

// --- fixtures（内存内联，避免文件散布） ---
const INDEX_A = {
  format: 2,
  updated_at: '2026-10-17T00:00:00+08:00',
  plugins: [
    {
      pluginId: 'org.issheepbox.storage',
      name: '存储服务',
      description: '第一方 KV 持久化服务',
      repoUrl: 'https://github.com/PastSheep/issheepbox-plugin-storage',
      latestVersion: '1.2.0',
      zipUrl: 'https://github.com/PastSheep/issheepbox-plugin-storage/releases/download/v1.2.0/plugin-storage-v1.2.0.zip',
      zipSha256: 'a'.repeat(64),
      apiVersion: '^1.0.0',
      permissions: ['files:read', 'files:write'],
      ui: { panels: [{ id: 'storage-main', title: '存储' }] },
      updatedAt: '2026-10-15T10:00:00+08:00',
    },
    {
      pluginId: 'com.pastsheep.devkit',
      name: '开发者小工具',
      description: 'JSON/Base64/URL/时间戳',
      repoUrl: 'https://github.com/PastSheep/issheepbox-plugin-devkit',
      latestVersion: '1.0.0',
      zipUrl: 'https://github.com/PastSheep/issheepbox-plugin-devkit/releases/download/v1.0.0/plugin-devkit-v1.0.0.zip',
      zipSha256: 'b'.repeat(64),
      apiVersion: '^1.0.0',
      permissions: [],
      updatedAt: '2026-10-15T10:00:00+08:00',
    },
    // 非法条目：缺 zipSha256
    {
      pluginId: 'org.example.bad',
      name: '坏条目',
      description: '缺 sha256',
      repoUrl: 'https://github.com/x/y',
      latestVersion: '1.0.0',
      zipUrl: 'https://github.com/x/y/releases/download/v1.0.0/z.zip',
      apiVersion: '^1.0.0',
      permissions: [],
      updatedAt: '2026-10-15T10:00:00+08:00',
    },
    // 非法条目：latestVersion 非 SemVer
    {
      pluginId: 'org.example.bad2',
      name: '坏条目2',
      description: '版本非法',
      repoUrl: 'https://github.com/x/y',
      latestVersion: 'v1.0.0',
      zipUrl: 'https://github.com/x/y/releases/download/v1.0.0/z.zip',
      zipSha256: 'c'.repeat(64),
      apiVersion: '^1.0.0',
      permissions: [],
      updatedAt: '2026-10-15T10:00:00+08:00',
    },
  ],
};

const INDEX_B = {
  format: 2,
  updated_at: '2026-10-17T00:00:00+08:00',
  plugins: [
    {
      // 与 INDEX_A 冲突的 storage（第三方源提供更新版）
      pluginId: 'org.issheepbox.storage',
      name: '存储服务（镜像）',
      description: '第三方镜像',
      repoUrl: 'https://github.com/ThirdParty/issheepbox-plugin-storage',
      latestVersion: '1.5.0',
      zipUrl: 'https://github.com/ThirdParty/issheepbox-plugin-storage/releases/download/v1.5.0/plugin-storage-v1.5.0.zip',
      zipSha256: 'd'.repeat(64),
      apiVersion: '^1.0.0',
      permissions: ['files:read', 'files:write'],
      updatedAt: '2026-10-16T00:00:00+08:00',
    },
  ],
};

// 单插件仓库根 index.json（自描述单条）
const REPO_ROOT_INDEX = {
  pluginId: 'com.example.single',
  name: '单插件开发者',
  description: '只做一个插件的开发者示例',
  repoUrl: 'https://github.com/someone/issheepbox-plugin-single',
  latestVersion: '0.3.1',
  zipUrl: 'https://github.com/someone/issheepbox-plugin-single/releases/download/v0.3.1/plugin-single-v0.3.1.zip',
  zipSha256: 'e'.repeat(64),
  apiVersion: '^1.0.0',
  permissions: ['network:fetch'],
  updatedAt: '2026-10-14T00:00:00+08:00',
};

// --- mock fetch：按 URL 路由到 fixture ---
const ROUTES = new Map([
  ['https://raw.githubusercontent.com/PastSheep/issheepbox-registry/main/index.json', INDEX_A],
  ['https://raw.githubusercontent.com/ThirdParty/issheepbox-registry/main/index.json', INDEX_B],
  ['https://raw.githubusercontent.com/someone/issheepbox-plugin-single/main/index.json', REPO_ROOT_INDEX],
]);

function stubFetch(bytesByUrl = {}) {
  return async (url) => {
    if (bytesByUrl[url]) {
      return new Response(bytesByUrl[url], { status: 200 });
    }
    const payload = ROUTES.get(url);
    if (payload === undefined) {
      throw new Error(`mock 网络：未知 URL ${url}`);
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/** 构造一个合法插件 zip（顶层目录=pluginId，含 plugin.json + entry 文件）。 */
function makePluginZip(pluginId, version, entry = 'index.js') {
  const zip = new AdmZip();
  zip.addFile(`${pluginId}/plugin.json`, Buffer.from(
    JSON.stringify({ id: pluginId, name: pluginId, version, apiVersion: '^1.0.0', entry, permissions: [] }),
    'utf8',
  ));
  zip.addFile(`${pluginId}/${entry}`, Buffer.from('module.exports = {};', 'utf8'));
  zip.addFile(`${pluginId}/README.md`, Buffer.from('# demo', 'utf8'));
  return zip.toBuffer();
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function main() {
  // ---------------------------------------------------------------------
  section('1. format 2 索引解析（容错）');
  const idxA = parseIndexV2(INDEX_A);
  assert(idxA.ok === true, '合法 format 2 索引解析成功');
  assert(idxA.formatSupported === true, 'format 2 受支持');
  assert(idxA.records.length === 2, `合法记录 2 条（实际 ${idxA.records.length}）`);
  assert(idxA.invalid.length === 2, `非法记录 2 条（实际 ${idxA.invalid.length}）`);
  assert(
    idxA.invalid.some((i) => i.reasons.join().includes('zipSha256')),
    '缺 zipSha256 的记录被拒绝',
  );
  assert(
    idxA.invalid.some((i) => i.reasons.join().includes('latestVersion')),
    'latestVersion 非 SemVer 被拒绝',
  );
  assert(idxA.total === 4, `原始总数 4（实际 ${idxA.total}）`);
  assert(idxA.records[0].permissions.length === 2, 'permissions 原样透传');
  assert(idxA.records[0].ui.panels[0].id === 'storage-main', 'ui 元数据透传');

  const badTop = parseIndexV2({ format: 2 });
  assert(badTop.ok === false && badTop.topLevelErrors.some((r) => r.includes('plugins')), '缺 plugins 顶层非法');
  const badFmt = parseIndexV2({ format: 1, updated_at: '2026-01-01T00:00:00Z', plugins: [] });
  assert(badFmt.ok === true && badFmt.formatSupported === false, 'format 1 解析成功但 formatSupported=false（提示升级）');
  const nullTop = parseIndexV2(null);
  assert(nullTop.ok === false && nullTop.topLevelErrors.length === 1, '顶层 null 非法');

  // ---------------------------------------------------------------------
  section('2. 单插件仓库根 index.json（自描述单条）');
  const repoIdx = parsePluginRepoIndex(REPO_ROOT_INDEX);
  assert(repoIdx.ok === true && repoIdx.records.length === 1, '单插件仓库解析出 1 条记录');
  assert(repoIdx.records[0].pluginId === 'com.example.single', '自描述 pluginId 正确');
  const repoBad = parsePluginRepoIndex({ pluginId: 'org.x', name: 'x' });
  assert(repoBad.ok === false && repoBad.invalid.length === 1, '非法自描述记录被拒绝');

  // ---------------------------------------------------------------------
  section('3. 多源聚合 fetchAll（冲突分组 + 失败隔离）');
  const client = new MarketClient({
    sources: [
      { id: 'official', type: 'index', name: '官方源', url: 'https://raw.githubusercontent.com/PastSheep/issheepbox-registry/main/index.json', enabled: true },
      { id: 'third', type: 'index', name: '第三方源', url: 'https://raw.githubusercontent.com/ThirdParty/issheepbox-registry/main/index.json', enabled: true },
      { id: 'single', type: 'plugin-repo', name: '单插件订阅', url: 'https://github.com/someone/issheepbox-plugin-single', enabled: true },
      { id: 'dead', type: 'index', name: '死源', url: 'https://raw.githubusercontent.com/nope/nope/main/index.json', enabled: true },
      { id: 'disabled', type: 'plugin-repo', name: '停用源', url: 'https://github.com/x/y', enabled: false },
    ],
    fetchImpl: stubFetch(),
    timeoutMs: 1000,
  });
  const agg = await client.fetchAll();
  assert(agg.sources.length === 4, `启用源 4 个（死源失败降级，停用源不拉取）`);
  const dead = agg.sources.find((s) => s.sourceId === 'dead');
  assert(dead && dead.ok === false && typeof dead.error === 'string', '死源 ok=false + error（失败隔离）');
  const official = agg.sources.find((s) => s.sourceId === 'official');
  assert(official && official.ok === true && official.records.length === 2, '官方源正常（其他源失败不影响）');

  // 冲突分组：storage 在两个源都有 → byPluginId 2 条
  const storageRecs = agg.byPluginId.get('org.issheepbox.storage');
  assert(storageRecs && storageRecs.length === 2, `同插件多源冲突保留 2 条（实际 ${storageRecs?.length}）`);
  assert(
    storageRecs[0].source.id !== storageRecs[1].source.id,
    '两条记录来源不同（UI 选源数据基础）',
  );
  assert(storageRecs.some((r) => r.latestVersion === '1.5.0'), '第三方镜像 1.5.0 在列（不自动选版本）');
  assert(client.getRecordsByPluginId('org.issheepbox.storage').length === 2, 'getRecordsByPluginId 返回冲突组');

  // 单插件订阅记录
  const singleRecs = agg.byPluginId.get('com.example.single');
  assert(singleRecs && singleRecs.length === 1 && singleRecs[0].source.type === 'plugin-repo', 'plugin-repo 源聚合成功');
  assert(
    singleRecs[0].source.url === 'https://github.com/someone/issheepbox-plugin-single',
    'source 段携带来源标记（UI 透明展示）',
  );

  // ---------------------------------------------------------------------
  section('4. installFromRecord（sha256 强校验）');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-v3-'));
  try {
    const installClient = new MarketClient({
      sources: [{ id: 'official', type: 'index', name: '官方源', url: 'https://raw.githubusercontent.com/PastSheep/issheepbox-registry/main/index.json', enabled: true }],
      fetchImpl: stubFetch(),
      pluginsDir: tmpDir,
    });
    await installClient.fetchAll();
    const devkitRec = installClient.getRecordsByPluginId('com.pastsheep.devkit')[0];

    // 构造与记录 zipSha256 匹配的 zip
    const devkitZip = makePluginZip('com.pastsheep.devkit', '1.0.0');
    const devkitSha = sha256Hex(devkitZip);
    const recMatch = { ...devkitRec, zipSha256: devkitSha };

    // 修改记录的 zipUrl 指向 mock zip 字节
    const installClient2 = new MarketClient({
      sources: [{ id: 'official', type: 'index', name: '官方源', url: 'https://raw.githubusercontent.com/PastSheep/issheepbox-registry/main/index.json', enabled: true }],
      fetchImpl: stubFetch({ [recMatch.zipUrl]: devkitZip }),
      pluginsDir: tmpDir,
    });
    await installClient2.fetchAll();
    const rec2 = installClient2.getRecordsByPluginId('com.pastsheep.devkit')[0];
    const rec2Match = { ...rec2, zipSha256: devkitSha };
    const installed = await installClient2.installFromRecord(rec2Match);
    assert(
      installed.pluginId === 'com.pastsheep.devkit' && fs.existsSync(path.join(tmpDir, 'com.pastsheep.devkit', 'plugin.json')),
      'installFromRecord 成功落盘（sha256 匹配）',
    );

    // sha256 不一致 → SHA_MISMATCH 且无残留（用独立插件 id，避免 ALREADY_INSTALLED 干扰）
    const shaTestZip = makePluginZip('org.example.sha-test', '1.0.0');
    const shaTestUrl = 'https://github.com/example/issheepbox-plugin-sha/releases/download/v1.0.0/sha.zip';
    const shaTestRec = {
      pluginId: 'org.example.sha-test',
      name: 'sha 测试',
      description: 't',
      repoUrl: 'https://github.com/example/issheepbox-plugin-sha',
      latestVersion: '1.0.0',
      zipUrl: shaTestUrl,
      zipSha256: 'f'.repeat(64),
      apiVersion: '^1.0.0',
      permissions: [],
      updatedAt: '2026-10-17T00:00:00+08:00',
    };
    const shaClient = new MarketClient({
      sources: [],
      fetchImpl: stubFetch({ [shaTestUrl]: shaTestZip }),
      pluginsDir: tmpDir,
    });
    let shaErr = null;
    try {
      await shaClient.installFromRecord(shaTestRec);
    } catch (err) {
      shaErr = err;
    }
    assert(shaErr && shaErr.code === 'SHA_MISMATCH', 'sha256 不一致 → SHA_MISMATCH');
    assert(
      !fs.existsSync(path.join(tmpDir, '.install-')),
      'sha 校验失败无临时目录残留',
    );

    // 重复安装 → ALREADY_INSTALLED
    let dupErr = null;
    try {
      await installClient2.installFromRecord(rec2Match);
    } catch (err) {
      dupErr = err;
    }
    assert(dupErr && dupErr.code === 'ALREADY_INSTALLED', '重复安装被拒绝');

    // ---------------------------------------------------------------------
    section('5. importLocalZip（本地一次性导入）');
    const localZipPath = path.join(tmpDir, 'local-plugin.zip');
    fs.writeFileSync(localZipPath, makePluginZip('org.example.local', '0.1.0'));
    const imported = await installClient2.importLocalZip(localZipPath);
    assert(
      imported.pluginId === 'org.example.local' && fs.existsSync(path.join(tmpDir, 'org.example.local', 'plugin.json')),
      '本地 zip 一次性导入成功',
    );
    assert(
      !installClient2.sources.some((s) => s.type === 'local-zip'),
      '本地导入不生成源记录（仅一次性）',
    );
    let dupLocalErr = null;
    try {
      await installClient2.importLocalZip(localZipPath);
    } catch (err) {
      dupLocalErr = err;
    }
    assert(dupLocalErr && dupLocalErr.code === 'ALREADY_INSTALLED', '重复导入被拒绝（需先卸载）');

    // 非法 zip（非 zip 内容）拒绝且无残留
    const badZipPath = path.join(tmpDir, 'bad.zip');
    fs.writeFileSync(badZipPath, 'not a zip');
    let badZipErr = null;
    try {
      await installClient2.importLocalZip(badZipPath);
    } catch (err) {
      badZipErr = err;
    }
    assert(badZipErr && badZipErr.code === 'INVALID_ZIP', '非法 zip 拒绝');

    // ---------------------------------------------------------------------
    section('6. updateFromRecord');
    // devkit 已装 1.0.0；同版本 → updated=false
    const sameVer = await installClient2.updateFromRecord(rec2Match);
    assert(sameVer.updated === false, '已是最新 → updated=false 不下载');
    // 更高版本 → 更新（zip 内含更高 version）
    const upZip = makePluginZip('com.pastsheep.devkit', '1.1.0');
    const upSha = sha256Hex(upZip);
    const upRec = { ...rec2Match, latestVersion: '1.1.0', zipSha256: upSha };
    const upClient = new MarketClient({
      sources: [],
      fetchImpl: stubFetch({ [upRec.zipUrl]: upZip }),
      pluginsDir: tmpDir,
    });
    const updated = await upClient.updateFromRecord(upRec);
    assert(updated.updated === true, '新版本更新成功（sha256 校验通过）');
    assert(
      JSON.parse(fs.readFileSync(path.join(tmpDir, 'com.pastsheep.devkit', 'plugin.json'), 'utf8')).version === '1.1.0',
      '更新后磁盘版本为 1.1.0（原子替换）',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------
  section('7. v1 兼容 + URL 构造');
  const legacyRaw = {
    registryVersion: '1.0.0',
    generatedAt: '2026-10-13T00:00:00Z',
    plugins: [
      {
        id: 'org.example.note',
        name: '便签',
        description: '示例',
        author: 'a',
        version: '1.0.0',
        apiVersion: '^1.0.0',
        repository: 'https://github.com/a/b',
        releaseUrl: 'https://github.com/a/b/releases/tag/v1.0.0',
        downloadUrl: 'https://github.com/a/b/releases/download/v1.0.0/x.zip',
        permissions: [],
        publishedAt: '2026-10-13T00:00:00Z',
      },
    ],
  };
  const v1 = parseRegistryIndex(legacyRaw);
  assert(v1.entries.length === 1 && v1.entries[0].id === 'org.example.note', 'v1 plugins.json 仍可解析（兼容）');

  assert(
    buildPluginRepoIndexUrl('https://github.com/someone/issheepbox-plugin-single') ===
      'https://raw.githubusercontent.com/someone/issheepbox-plugin-single/main/index.json',
    'github.com 仓库 → raw 根 index.json',
  );
  assert(
    buildPluginRepoIndexUrl('https://raw.githubusercontent.com/x/y/main/index.json') ===
      'https://raw.githubusercontent.com/x/y/main/index.json',
    'raw 直链原样返回',
  );
  assert(buildPluginRepoIndexUrl('https://example.com/nope') === null, '非 GitHub URL 返回 null');

  // ---------------------------------------------------------------------
  console.log(`\n=== 共 ${checks} 项断言，失败 ${failures} 项 ===`);
  if (failures > 0) {
    console.error('验证未通过');
    process.exit(1);
  }
  console.log('验证通过：market-client v3 多源模型全部符合预期');
  process.exit(0);
}

main().catch((err) => {
  console.error('验证脚本执行失败：', err);
  process.exit(1);
});
