/**
 * 鼠鼠数据索引插件（com.pastsheep.shushu-data）端到端验证。
 *
 * 用 stub 的 global.fetch 喂入真实形状的 manifest fixture，走真实内核全链路：
 * 授权 → 挂载 → 拉取(假) → 解析 → 注册服务/面板 → 卸载无残留。
 *
 * 前置：
 *   pnpm install
 *   pnpm --filter @issheepbox/kernel --filter @issheepbox/approval-policy build
 *   pnpm --filter @issheepbox/plugin-shushu-data build
 *
 * 运行：node packages/plugins/verify-shushu.cjs
 */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IsSheepBoxKernel } = require('../kernel/dist/index.js');
const { createApprovalPolicyPlugin } = require('../approval-policy/dist/index.js');
const shushuPlugin = require('./shushu-data/dist/index.js');

const SHUSHU_ID = 'com.pastsheep.shushu-data';

// 与 DeltaForceBox-Assets 线上 manifest 同形状（真实字段）。
const FIXTURE = JSON.stringify({
  format: 1,
  generated_at: '2026-10-07T02:47:58+08:00',
  source: 'shushu.fan',
  datasets: {
    'article-map-az3': { count: 1262, schema: 1, sha256: 'a'.repeat(64) },
    'article-map-bks': { count: 520, schema: 1, sha256: 'b'.repeat(64) },
    'article-map-cxjy': { count: 539, schema: 1, sha256: 'c'.repeat(64) },
    'article-map-db': { count: 409, schema: 1, sha256: 'd'.repeat(64) },
    'article-map-htjd': { count: 392, schema: 1, sha256: 'e'.repeat(64) },
    'article-map-yc': { count: 599, schema: 1, sha256: 'f'.repeat(64) },
  },
});

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}

class GrantAllPrompter { async prompt() { return { kind: 'grant-all' }; } }
class DenyPrompter { async prompt() { return { kind: 'deny' }; } }

function makeApproval(options) {
  return {
    dir: path.join('virtual', 'approval-policy'),
    manifest: {
      id: 'org.issheepbox.approval-policy', name: '权限授权', version: '1.0.0',
      apiVersion: '^1.0.0', entry: 'dist/index.js', permissions: [],
    },
    module: { default: createApprovalPolicyPlugin(options) },
  };
}

function copyPackage(srcDir, destRoot) {
  fs.cpSync(srcDir, path.join(destRoot, path.basename(srcDir)), {
    recursive: true,
    filter: (s) => !['node_modules', 'src'].includes(path.basename(s)),
  });
}

/** 挂载 approval-policy + 注入捕获面板的假 shell:ui。返回捕获数组。 */
async function boot(kernel, prompter) {
  await kernel.lifecycle.mount(makeApproval({ prompter }));
  const panels = [];
  kernel.services.register('shell:ui', {
    registerPanel: (id, title, opts) => { panels.push({ id, title, opts }); return () => {}; },
  });
  return panels;
}

function withStubFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => { globalThis.fetch = orig; });
}

async function scenarioHappy(pluginsDir, root) {
  console.log('\n[S1] 授权后拉取(假) → 服务/面板 → 数据正确 → 卸载无残留');
  const kernel = new IsSheepBoxKernel();
  await kernel.start(path.join(root, 'ud'), pluginsDir);
  const panels = await boot(kernel, new GrantAllPrompter());

  await withStubFetch(
    async () => ({ ok: true, status: 200, text: async () => FIXTURE }),
    async () => {
      await kernel.profile.enable(SHUSHU_ID);
    },
  );

  ok(kernel.lifecycle.mountedIds.includes(SHUSHU_ID), 'shushu-data 已挂载');
  const svc = kernel.services.get('shushu-data');
  ok(svc && typeof svc.listDatasets === 'function', 'shushu-data 服务已注册');

  const list = svc.listDatasets();
  ok(list.length === 6, `解析出 6 个数据集（实际 ${list.length}）`);
  const summary = svc.getSummary();
  ok(summary.totalEntries === 3721, `总条目数=3721（实际 ${summary.totalEntries}）`);
  ok(summary.source === 'shushu.fan', 'source=shushu.fan');
  ok(svc.getDataset('article-map-az3').count === 1262, 'getDataset(az3).count=1262');
  ok(svc.lastError() === null, '拉取成功后无错误');

  ok(panels.length === 1 && panels[0].id === 'shushu-data-main', '已向 shell:ui 注册数据面板');
  ok(/article-map-az3/.test(panels[0].opts.html) && /3721/.test(panels[0].opts.html),
    '静态面板 HTML 含数据集与汇总数');

  await kernel.profile.disable(SHUSHU_ID);
  ok(!kernel.services.has('shushu-data'), '卸载后服务注销（无残留）');
  await kernel.stop();
}

async function scenarioOffline(pluginsDir, root) {
  console.log('\n[S2] 网络失败优雅降级：服务仍注册、面板显示降级信息、不崩溃');
  const kernel = new IsSheepBoxKernel();
  await kernel.start(path.join(root, 'ud-off'), pluginsDir);
  await boot(kernel, new GrantAllPrompter());

  await withStubFetch(
    async () => { throw new Error('ENOTFOUND'); },
    async () => { await kernel.profile.enable(SHUSHU_ID); },
  );

  ok(kernel.lifecycle.mountedIds.includes(SHUSHU_ID), '网络失败下插件仍挂载（不阻断）');
  const svc = kernel.services.get('shushu-data');
  ok(Array.isArray(svc.listDatasets()) && svc.listDatasets().length === 0, '无缓存时数据集为空');
  ok(typeof svc.lastError() === 'string' && svc.lastError().length > 0, '记录了拉取错误');
  await kernel.stop();
}

async function scenarioDeny(pluginsDir, root) {
  console.log('\n[S3] DenyPrompter 拒绝 network:fetch：不可启用、不注册服务');
  const kernel = new IsSheepBoxKernel();
  await kernel.start(path.join(root, 'ud-deny'), pluginsDir);
  await boot(kernel, new DenyPrompter());
  await kernel.profile.enable(SHUSHU_ID);
  ok(!kernel.lifecycle.mountedIds.includes(SHUSHU_ID), '拒绝后未挂载');
  ok(!kernel.services.has('shushu-data'), '拒绝后未注册服务');
  await kernel.stop();
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-shushu-verify-'));
  const pluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  copyPackage(path.join(__dirname, 'shushu-data'), pluginsDir);
  ok(fs.existsSync(pluginsDir), '临时 pluginsDir 就绪');

  // 纯函数单测（不走内核）
  ok(shushuPlugin.parseManifest(FIXTURE)?.datasets?.['article-map-az3'].count === 1262,
    'parseManifest 解析 fixture 正确');
  ok(shushuPlugin.parseManifest('not json') === null, 'parseManifest 对非法输入返回 null');

  try {
    await scenarioHappy(pluginsDir, path.join(tmpRoot, 's1'));
    await scenarioOffline(pluginsDir, path.join(tmpRoot, 's2'));
    await scenarioDeny(pluginsDir, path.join(tmpRoot, 's3'));
    console.log(`\n全部通过：${checks} 项断言（3 个场景 + 2 项纯函数）`);
  } catch (err) {
    console.error(`\n验证失败：${err.message}`);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main();
