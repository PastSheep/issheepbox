/**
 * P-004 内置插件刷新策略验证脚本。
 *
 * 验证 apps/desktop/src/builtinPlugins.ts 的展开决策（编译产物 dist/builtinPlugins.js）：
 *   首启全量展开 / 同包重复启动跳过 / 应用升级后包内容变化即重拷 / legacy 自举。
 *
 * 前置（先构建、后验证，推送的树 = 验证的树）：
 *   pnpm install
 *   pnpm --filter @issheepbox/desktop run build
 *
 * 运行：
 *   node apps/desktop/scripts/verify-builtin-refresh.cjs
 *
 * 覆盖：
 *   场景 1  纯决策表 resolveBuiltinAction（5 分支）
 *   场景 2  hashDirectoryContent 稳定性/敏感性（内容变、改名、遍历顺序）
 *   场景 3  端到端模拟：v1 首启 → v1 重复启动跳过 → v2 同 plugin.json 版本但代码变
 *           → 必须重拷（P-004 原故障复现并修复的关键路径）→ v2 重复启动跳过
 *   场景 4  legacy 迁移：userData 已有展开但无 marker → 自举重拷并补写 marker
 *
 * 说明：本脚本的 simulateLaunch 与 main.ts resolvePluginsDir 生产分支同构
 * （同一组纯函数 + 同一递归拷贝语义），不加载 electron（main.ts 无法在纯 Node 运行）。
 */
'use strict';

// 本文件是 Node 验证测试台（harness），需要 require() 加载已构建产物；
// @typescript-eslint/no-require-imports 针对插件运行时代码（沙箱内禁止 require），
// 不适用于测试台（与 packages/plugins/verify-examples.cjs 同一豁免理由）。
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveBuiltinAction,
  hashDirectoryContent,
  readPluginVersion,
  readExpansionMeta,
  writeExpansionMeta,
} = require('../dist/builtinPlugins.js');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`  ok  ${name}`);
}

/** 与 apps/desktop/src/main.ts copyDirectoryRecursive 同构（覆盖写、不删多余文件）。 */
function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    if (fs.statSync(s).isDirectory()) {
      copyRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/** 与 main.ts resolvePluginsDir 生产分支同构的一次「启动」。返回各插件目录决策。 */
function simulateLaunch(resourcesDir, pluginsDir) {
  const metaPath = path.join(pluginsDir, '.builtin-meta.json');
  const meta = readExpansionMeta(metaPath) ?? { appVersion: '0.1.0', plugins: {} };
  const actions = {};
  for (const entry of fs.readdirSync(resourcesDir)) {
    const src = path.join(resourcesDir, entry);
    if (!fs.statSync(src).isDirectory()) continue;
    const dest = path.join(pluginsDir, entry);
    const srcContentHash = hashDirectoryContent(src);
    const decision = resolveBuiltinAction({
      destPluginExists: fs.existsSync(path.join(dest, 'plugin.json')),
      srcContentHash,
      recorded: meta.plugins[entry],
    });
    if (decision.action === 'copy') copyRecursive(src, dest);
    actions[entry] = decision;
    if (srcContentHash) {
      meta.plugins[entry] = {
        pluginVersion: readPluginVersion(path.join(src, 'plugin.json')),
        contentHash: srcContentHash,
      };
    }
  }
  writeExpansionMeta(metaPath, meta);
  return actions;
}

function makeBuiltin(root, { version, code }) {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({
    id: 'org.issheepbox.shell-default', name: '默认壳', version, entry: 'dist/index.js',
  }), 'utf8');
  fs.writeFileSync(path.join(root, 'dist', 'index.js'), code, 'utf8');
}

// ---------- 场景 1：纯决策表 ----------
console.log('场景 1  resolveBuiltinAction 决策表');
check('dest 无 plugin.json → copy/first-launch', () => {
  const d = resolveBuiltinAction({ destPluginExists: false, srcContentHash: 'h1', recorded: undefined });
  assert.equal(d.action, 'copy');
  assert.equal(d.reason, 'first-launch');
});
check('同 hash + 有记录 → skip/already-expanded（保留 userData）', () => {
  const d = resolveBuiltinAction({
    destPluginExists: true, srcContentHash: 'h1', recorded: { pluginVersion: '0.1.0', contentHash: 'h1' },
  });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'already-expanded');
});
check('hash 变化 → copy/content-changed（P-004 修复点）', () => {
  const d = resolveBuiltinAction({
    destPluginExists: true, srcContentHash: 'h2', recorded: { pluginVersion: '0.1.0', contentHash: 'h1' },
  });
  assert.equal(d.action, 'copy');
  assert.equal(d.reason, 'content-changed');
});
check('legacy（有 dest 无记录）→ copy/legacy-migration', () => {
  const d = resolveBuiltinAction({ destPluginExists: true, srcContentHash: 'h1', recorded: undefined });
  assert.equal(d.action, 'copy');
  assert.equal(d.reason, 'legacy-migration');
});
check('hash 不可读 → copy/content-changed（保守重拷）', () => {
  const d = resolveBuiltinAction({
    destPluginExists: true, srcContentHash: undefined, recorded: { pluginVersion: '0.1.0', contentHash: 'h1' },
  });
  assert.equal(d.action, 'copy');
  assert.equal(d.reason, 'content-changed');
});

// ---------- 场景 2：hashDirectoryContent ----------
console.log('场景 2  hashDirectoryContent');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p004-verify-'));
check('同内容两次计算 hash 一致', () => {
  const dir = path.join(tmpRoot, 'same');
  makeBuiltin(dir, { version: '0.1.0', code: 'console.log(1)' });
  assert.equal(hashDirectoryContent(dir), hashDirectoryContent(dir));
});
check('文件内容变化 → hash 变化', () => {
  const dir = path.join(tmpRoot, 'diff');
  makeBuiltin(dir, { version: '0.1.0', code: 'v1' });
  const h1 = hashDirectoryContent(dir);
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'v2', 'utf8');
  assert.notEqual(hashDirectoryContent(dir), h1);
});
check('plugin.json version 不变但代码变 → hash 变化（旧版本比较法会漏判）', () => {
  const dir = path.join(tmpRoot, 'stale-version');
  makeBuiltin(dir, { version: '0.1.0', code: 'v1-code' });
  const h1 = hashDirectoryContent(dir);
  // 模拟开发者忘了 bump plugin.json，只改了代码
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'v2-code-bugfix', 'utf8');
  assert.notEqual(hashDirectoryContent(dir), h1);
});
check('重命名文件 → hash 变化', () => {
  const dir = path.join(tmpRoot, 'rename');
  makeBuiltin(dir, { version: '0.1.0', code: 'x' });
  fs.writeFileSync(path.join(dir, 'extra.txt'), 'extra', 'utf8');
  const h1 = hashDirectoryContent(dir);
  fs.renameSync(path.join(dir, 'extra.txt'), path.join(dir, 'extra2.txt'));
  assert.notEqual(hashDirectoryContent(dir), h1);
});

// ---------- 场景 3/4：端到端启动模拟 ----------
console.log('场景 3/4  端到端展开模拟');
const resourcesDir = path.join(tmpRoot, 'resources', 'builtin-plugins');
const pluginsDir = path.join(tmpRoot, 'userData', 'plugins');
fs.mkdirSync(resourcesDir, { recursive: true });
fs.mkdirSync(pluginsDir, { recursive: true });

// 包 v1：plugin.json 0.1.0，代码 v1
makeBuiltin(path.join(resourcesDir, 'shell-default'), { version: '0.1.0', code: 'v1-code' });

check('启动 1（v1 首启）→ copy/first-launch，dest 落盘，marker 写入', () => {
  const actions = simulateLaunch(resourcesDir, pluginsDir);
  assert.equal(actions['shell-default'].action, 'copy');
  assert.equal(actions['shell-default'].reason, 'first-launch');
  assert.equal(fs.readFileSync(path.join(pluginsDir, 'shell-default', 'dist', 'index.js'), 'utf8'), 'v1-code');
  const meta = readExpansionMeta(path.join(pluginsDir, '.builtin-meta.json'));
  assert.ok(meta && meta.plugins['shell-default']);
  assert.equal(meta.plugins['shell-default'].pluginVersion, '0.1.0');
});
check('启动 2（同 v1 重复启动）→ skip/already-expanded', () => {
  const actions = simulateLaunch(resourcesDir, pluginsDir);
  assert.equal(actions['shell-default'].action, 'skip');
  assert.equal(actions['shell-default'].reason, 'already-expanded');
});
// 包 v2：plugin.json 仍 0.1.0（开发者忘记 bump），代码变 v2
fs.writeFileSync(path.join(resourcesDir, 'shell-default', 'dist', 'index.js'), 'v2-code', 'utf8');
check('启动 3（v2 同版本号但代码变）→ copy/content-changed，dest 刷新为 v2（P-004 原故障）', () => {
  const actions = simulateLaunch(resourcesDir, pluginsDir);
  assert.equal(actions['shell-default'].action, 'copy');
  assert.equal(actions['shell-default'].reason, 'content-changed');
  assert.equal(fs.readFileSync(path.join(pluginsDir, 'shell-default', 'dist', 'index.js'), 'utf8'), 'v2-code');
});
check('启动 4（v2 重复启动）→ skip/already-expanded', () => {
  const actions = simulateLaunch(resourcesDir, pluginsDir);
  assert.equal(actions['shell-default'].action, 'skip');
});
check('场景 4 legacy：删 marker 保留 dest → legacy-migration 重拷并补写 marker', () => {
  fs.unlinkSync(path.join(pluginsDir, '.builtin-meta.json'));
  const actions = simulateLaunch(resourcesDir, pluginsDir);
  assert.equal(actions['shell-default'].action, 'copy');
  assert.equal(actions['shell-default'].reason, 'legacy-migration');
  const meta = readExpansionMeta(path.join(pluginsDir, '.builtin-meta.json'));
  assert.ok(meta && meta.plugins['shell-default'] && meta.plugins['shell-default'].contentHash);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n全部通过：${checks} 项断言。`);
