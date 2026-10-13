/**
 * fixture 解析实测脚本（验证门禁用，非单元测试框架）。
 *
 * 用法（需先构建 dist）：
 *   pnpm --filter @issheepbox/market-client build
 *   node packages/market-client/scripts/verify-fixture.mjs
 *
 * 覆盖：
 *  1. 含合法/非法条目的 plugins.fixture.json 解析（容错）
 *  2. MarketClient.fetchIndex / list 过滤 / getById / 占位接口 / 网络错误
 *  3. 顶层非法结构（null / 缺 plugins / plugins 非数组 / 空数组）
 *  4. compareVersions 语义
 * 全部断言通过则 exit 0，任一失败 exit 1 并打印明细。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../dist/index.js';

const { MarketClient, parseRegistryIndex, compareVersions } = pkg;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(scriptDir, '..', 'fixtures', 'plugins.fixture.json');
const fixtureRaw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

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

const stubFetch = (payload, status = 200) =>
  async () =>
    new Response(payload, {
      status,
      headers: { 'content-type': 'application/json' },
    });

async function main() {
  // -------------------------------------------------------------------------
  section('1. fixture 解析（合法/非法条目容错）');

  const result = parseRegistryIndex(fixtureRaw);

  assert(
    result.index !== null && result.topLevelErrors.length === 0,
    '顶层结构合法，index 非空',
    JSON.stringify(result.topLevelErrors),
  );
  assert(result.registryVersionSupported === true, 'registryVersion 1.0.0 受支持');
  assert(result.total === 12, `原始条目总数 = 12（实际 ${result.total}）`);
  assert(result.entries.length === 4, `合法条目数 = 4（实际 ${result.entries.length}）`);
  assert(result.invalid.length === 8, `非法条目数 = 8（实际 ${result.invalid.length}）`);

  const validIds = result.entries.map((e) => e.id).sort();
  assert(
    JSON.stringify(validIds) ===
      JSON.stringify(
        ['com.github.someuser.json-formatter', 'org.example.clock', 'org.example.future-plugin', 'org.example.note'].sort(),
      ),
    '合法条目 id 集合正确（note 保留首条、future-plugin 被接受）',
    validIds.join(', '),
  );

  const future = result.entries.find((e) => e.id === 'org.example.future-plugin');
  assert(future !== undefined, '带未知额外属性的条目被接受（向前兼容）');
  assert(
    !Object.prototype.hasOwnProperty.call(future, 'unknownFutureField'),
    '未知属性未透传到 entry 类型',
  );

  const reasonsByIndex = new Map(result.invalid.map((e) => [e.index, e.reasons]));
  assert(
    (reasonsByIndex.get(3) ?? []).some((r) => r.includes('version')),
    'index3 缺 version 被拒绝',
  );
  assert(
    (reasonsByIndex.get(4) ?? []).some((r) => r.includes('反向域名')),
    'index4 非法 id 被拒绝',
  );
  assert(
    (reasonsByIndex.get(5) ?? []).some((r) => r.includes('SemVer')),
    'index5 非严格 SemVer 被拒绝',
  );
  assert(
    (reasonsByIndex.get(6) ?? []).some((r) => r.includes('http(s) URL')),
    'index6 非法 downloadUrl 被拒绝',
  );
  assert(
    (reasonsByIndex.get(7) ?? []).some((r) => r.includes('permissions')),
    'index7 permissions 含非字符串被拒绝',
  );
  assert(
    (reasonsByIndex.get(8) ?? []).some((r) => r.includes('重复')),
    'index8 重复 id 被拒绝',
  );
  assert(
    (reasonsByIndex.get(10) ?? []).some((r) => r.includes('"name"')),
    'index10 name 类型错误被拒绝',
  );
  assert(
    (reasonsByIndex.get(11) ?? []).some((r) => r.includes('publishedAt')),
    'index11 非法 publishedAt 被拒绝',
  );

  const note = result.entries.find((e) => e.id === 'org.example.note');
  assert(
    JSON.stringify(note.permissions) === JSON.stringify(['storage:plugin']),
    'permissions 原样透传',
  );
  assert(note.apiVersion === '^1.0.0', 'apiVersion 原样保留');
  assert(note.downloadUrl.includes('releases/download/'), 'downloadUrl 直链保留');

  // 列出插件摘要（id/name/version/描述 —— 交付物 2 的展示形态）
  section('1a. 合法插件列表摘要（id/name/version/description）');
  for (const e of result.entries) {
    console.log(`  · ${e.id} | ${e.name} | v${e.version} | ${e.description}`);
  }

  // -------------------------------------------------------------------------
  section('2. MarketClient.fetchIndex / list / getById / 占位接口');

  const client = new MarketClient({
    registryUrl: 'http://fixture.local/plugins.json',
    fetchImpl: stubFetch(JSON.stringify(fixtureRaw)),
    timeoutMs: 1000,
  });
  const fetched = await client.fetchIndex();
  assert(
    fetched === client.lastParseResult && fetched.index !== null,
    'fetchIndex() 成功且缓存到 lastParseResult',
  );
  assert(client.currentIndex !== null, 'currentIndex 非空');

  const all = client.list();
  assert(all.length === 4, `list() 返回全部合法条目（实际 ${all.length}）`);

  const byTag = client.list({ tag: 'productivity' });
  assert(
    byTag.map((e) => e.id).sort().join(',') === 'org.example.clock,org.example.note',
    'list({ tag: "productivity" }) 过滤正确',
  );

  const byPermission = client.list({ permission: 'network:fetch' });
  assert(
    byPermission.length === 1 && byPermission[0].id === 'org.example.clock',
    'list({ permission: "network:fetch" }) 过滤正确',
  );

  const bySearch = client.list({ search: 'json' });
  assert(
    bySearch.length === 1 && bySearch[0].id === 'com.github.someuser.json-formatter',
    'list({ search: "json" }) 跨字段搜索正确',
  );

  const byLimit = client.list({ limit: 2 });
  assert(byLimit.length === 2, `list({ limit: 2 }) 截断正确（实际 ${byLimit.length}）`);

  const byId = client.getById('org.example.clock');
  assert(byId !== undefined && byId.version === '2.1.0', 'getById 精确查询正确');
  assert(client.getById('no.such.plugin') === undefined, 'getById 不存在返回 undefined');

  assert(client.invalidEntries().length === 8, 'invalidEntries() 暴露非法条目');

  for (const name of ['download', 'install', 'uninstall', 'update']) {
    let threw = false;
    try {
      await client[name]('org.example.note');
    } catch (err) {
      threw = err instanceof Error && err.message.includes('未实现');
    }
    assert(threw, `${name}() 占位接口抛错（提示未实现）`);
  }

  let networkThrew = false;
  const badClient = new MarketClient({
    registryUrl: 'http://fixture.local/plugins.json',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  try {
    await badClient.fetchIndex();
  } catch (err) {
    networkThrew = err && err.name === 'RegistryFetchError';
  }
  assert(networkThrew, '网络失败抛 RegistryFetchError（不静默吞掉）');

  let httpStatus = null;
  const httpClient = new MarketClient({
    fetchImpl: stubFetch('nope', 503),
  });
  try {
    await httpClient.fetchIndex();
  } catch (err) {
    httpStatus = err && err.status;
  }
  assert(httpStatus === 503, 'HTTP 503 抛 RegistryFetchError(status=503)');

  const jsonClient = new MarketClient({
    fetchImpl: stubFetch('<html>not json</html>'),
  });
  const jsonResult = await jsonClient.fetchIndex();
  assert(
    jsonResult.index === null && jsonResult.topLevelErrors.length === 1,
    '非法 JSON 响应不抛异常，落入 topLevelErrors',
  );

  // -------------------------------------------------------------------------
  section('3. 顶层非法结构（纯函数）');

  const nullResult = parseRegistryIndex(null);
  assert(
    nullResult.index === null && nullResult.topLevelErrors.length === 1,
    '顶层 null 报错且 index=null',
  );
  const noPlugins = parseRegistryIndex({
    registryVersion: '1.0.0',
    generatedAt: '2026-10-13T00:00:00Z',
  });
  assert(
    noPlugins.index === null && noPlugins.topLevelErrors.some((r) => r.includes('"plugins"')),
    '缺 plugins 报错',
  );
  const nonArray = parseRegistryIndex({
    registryVersion: '1.0.0',
    generatedAt: '2026-10-13T00:00:00Z',
    plugins: 'not-array',
  });
  assert(
    nonArray.index === null && nonArray.topLevelErrors.some((r) => r.includes('"plugins"')),
    'plugins 非数组报错',
  );
  const empty = parseRegistryIndex({
    registryVersion: '1.0.0',
    generatedAt: '2026-10-13T00:00:00Z',
    plugins: [],
  });
  assert(
    empty.index !== null && empty.entries.length === 0 && empty.total === 0,
    '空 plugins 数组合法（index 非空、条目为空）',
  );

  // -------------------------------------------------------------------------
  section('4. compareVersions 语义');

  assert(compareVersions('1.0.0', '1.2.0') < 0, '1.0.0 < 1.2.0');
  assert(compareVersions('2.1.0', '2.1.0') === 0, '2.1.0 == 2.1.0');
  assert(compareVersions('2.1.0', '2.1.1') < 0, '2.1.0 < 2.1.1');
  assert(compareVersions('1.0.0-alpha.1', '1.0.0') < 0, '预发布 < 正式版');
  assert(compareVersions('1.0.0-beta', '1.0.0-alpha') > 0, 'beta > alpha');
  assert(Number.isNaN(compareVersions('v1.0.0', '1.0.0')), '非法输入返回 NaN');

  // -------------------------------------------------------------------------
  console.log(`\n=== 共 ${checks} 项断言，失败 ${failures} 项 ===`);
  if (failures > 0) {
    console.error('验证未通过');
    process.exit(1);
  }
  console.log('验证通过：fixture 解析/查询/容错/占位接口全部符合预期');
  process.exit(0);
}

main().catch((err) => {
  console.error('验证脚本执行失败：', err);
  process.exit(1);
});
