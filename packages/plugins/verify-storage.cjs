/**
 * KV 存储服务插件（org.issheepbox.storage）端到端验证。
 *
 * 复用 TASK-009 verify-examples.cjs 的思路：临时 pluginsDir 驱动真实内核（非 mock），
 * 注入 GrantAll/Deny Prompter 走 approval-policy 授权门禁。
 *
 * 前置（先构建、后验证，推送的树 = 验证的树）：
 *   pnpm install
 *   pnpm --filter @issheepbox/kernel --filter @issheepbox/approval-policy build
 *   pnpm --filter @issheepbox/plugin-storage build
 *
 * 运行：
 *   node packages/plugins/verify-storage.cjs
 *
 * 覆盖：
 *   S1  授权后挂载 → namespace get/set → storage:changed 事件 → 写穿透落盘 →
 *       跨「内核重启」从磁盘读回 → 命名空间隔离 → 卸载后服务注销无残留
 *   S2  DenyPrompter 拒绝授权 → 插件不可启用、不注册 storage 服务
 */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IsSheepBoxKernel } = require('../kernel/dist/index.js');
const { createApprovalPolicyPlugin } = require('../approval-policy/dist/index.js');

const STORAGE_ID = 'org.issheepbox.storage';
const DATA_FILE_NAME = 'issheepbox-storage.json';

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}

class GrantAllPrompter {
  async prompt() {
    return { kind: 'grant-all' };
  }
}
class DenyPrompter {
  async prompt() {
    return { kind: 'deny' };
  }
}

function makeInjectedApprovalPolicy(options) {
  const factory = createApprovalPolicyPlugin(options);
  return {
    dir: path.join('virtual', 'approval-policy'),
    manifest: {
      id: 'org.issheepbox.approval-policy',
      name: '权限授权',
      version: '1.0.0',
      apiVersion: '^1.0.0',
      entry: 'dist/index.js',
      permissions: [],
    },
    module: { default: factory },
  };
}

function copyPluginPackage(srcDir, destRoot) {
  fs.cpSync(srcDir, path.join(destRoot, path.basename(srcDir)), {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== 'node_modules' && base !== 'src';
    },
  });
}

/** 挂载注入的 approval-policy，并在 kernel.services 上注入 host:user-data（C3 宿主服务）。 */
async function bootWithApproval(kernel, prompter, hostDir) {
  const out = await kernel.lifecycle.mount(makeInjectedApprovalPolicy({ prompter }));
  ok(out.ok === true, 'approval-policy 已挂载');
  kernel.services.register('host:user-data', { dir: hostDir });
}

async function scenarioHappyPath(pluginsDir, root) {
  console.log('\n[S1] 授权后挂载 / 读写 / 落盘 / 跨重启读回 / 隔离 / 卸载无残留');
  const hostDir = path.join(root, 'host-user-data');
  fs.mkdirSync(hostDir, { recursive: true });

  // —— 第一轮内核：写入 ——
  const kernel = new IsSheepBoxKernel();
  await kernel.start(path.join(root, 'userdata-a'), pluginsDir);
  await bootWithApproval(kernel, new GrantAllPrompter(), hostDir);

  await kernel.profile.enable(STORAGE_ID);
  ok(kernel.lifecycle.mountedIds.includes(STORAGE_ID), '授权后 storage 插件已挂载');

  const storage = kernel.services.get('storage');
  ok(storage && typeof storage.set === 'function', 'storage 服务已注册');
  ok(storage.isPersistent() === true, '检测到 host:user-data，storage 处于持久化模式');

  const changed = [];
  kernel.events.on('storage:changed', (p) => changed.push(p));

  const mine = storage.namespace('org.foo.note');
  mine.set('theme', 'dark');
  ok(mine.get('theme') === 'dark', 'namespace().set/get 读写一致');

  ok(
    changed.length === 1 &&
      changed[0].namespace === 'org.foo.note' &&
      changed[0].key === 'theme' &&
      changed[0].op === 'set' &&
      changed[0].value === 'dark',
    'storage:changed 事件载荷正确',
  );

  // 命名空间隔离
  storage.set('org.bar.other', 'k', 1);
  ok(storage.get('org.foo.note', 'k') === undefined, '命名空间隔离：其他命名空间的键不可见');
  ok(storage.get('org.bar.other', 'k') === 1, '另一命名空间独立读写');

  // 落盘断言
  const diskFile = path.join(hostDir, DATA_FILE_NAME);
  ok(fs.existsSync(diskFile), '数据已写穿透落盘（issheepbox-storage.json）');
  const disk = JSON.parse(fs.readFileSync(diskFile, 'utf8'));
  ok(disk['org.foo.note']?.theme === 'dark', '落盘内容包含本命名空间的数据');

  await kernel.stop();

  // —— 第二轮内核：模拟重启，从磁盘读回 ——
  const kernel2 = new IsSheepBoxKernel();
  await kernel2.start(path.join(root, 'userdata-b'), pluginsDir);
  await bootWithApproval(kernel2, new GrantAllPrompter(), hostDir);
  await kernel2.profile.enable(STORAGE_ID);
  const storage2 = kernel2.services.get('storage');
  ok(
    storage2.get('org.foo.note', 'theme') === 'dark',
    '跨「内核重启」后从磁盘读回此前写入的值（持久化生效）',
  );
  ok(
    storage2.get('org.bar.other', 'k') === 1,
    '跨重启后另一命名空间数据同样保留',
  );

  // 卸载无残留：服务注销
  await kernel2.profile.disable(STORAGE_ID);
  ok(!kernel2.lifecycle.mountedIds.includes(STORAGE_ID), 'storage 已卸载');
  ok(!kernel2.services.has('storage'), '卸载后 storage 服务已注销（可逆 effects，不残留）');

  await kernel2.stop();
}

async function scenarioDeny(pluginsDir, root) {
  console.log('\n[S2] DenyPrompter 拒绝授权：插件不可启用、不注册服务');
  const hostDir = path.join(root, 'host-user-data-deny');
  fs.mkdirSync(hostDir, { recursive: true });

  const kernel = new IsSheepBoxKernel();
  await kernel.start(path.join(root, 'userdata-deny'), pluginsDir);
  await bootWithApproval(kernel, new DenyPrompter(), hostDir);

  await kernel.profile.enable(STORAGE_ID);
  ok(!kernel.lifecycle.mountedIds.includes(STORAGE_ID), '拒绝后 storage 未被挂载');
  ok(!kernel.services.has('storage'), '拒绝后未注册 storage 服务');
  ok(
    !kernel.profile.getCurrent().enabled.includes(STORAGE_ID),
    '拒绝后 storage 未进入 profile.enabled',
  );

  await kernel.stop();
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-storage-verify-'));
  const pluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  console.log('KV 存储服务插件验证（真实内核）');
  console.log(`临时目录: ${tmpRoot}`);

  const src = path.join(__dirname, 'storage');
  if (!fs.existsSync(path.join(src, 'plugin.json')) || !fs.existsSync(path.join(src, 'dist', 'index.js'))) {
    throw new Error(`缺少构建产物：${src}。请先 pnpm install && pnpm --filter @issheepbox/plugin-storage build。`);
  }
  copyPluginPackage(src, pluginsDir);
  ok(fs.existsSync(pluginsDir), '临时 pluginsDir 就绪');

  try {
    await scenarioHappyPath(pluginsDir, path.join(tmpRoot, 's1'));
    await scenarioDeny(pluginsDir, path.join(tmpRoot, 's2'));
    console.log(`\n全部通过：${checks} 项断言（2 个场景）`);
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
