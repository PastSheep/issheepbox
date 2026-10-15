/**
 * 宿主文件能力服务（org.issheepbox.files-service · F-008）端到端验证。
 *
 * 前置：
 *   pnpm --filter @issheepbox/kernel --filter @issheepbox/approval-policy build
 *   pnpm --filter @issheepbox/plugin-files-service build
 *
 * 运行：
 *   node packages/plugins/verify-files-service.cjs
 *
 * 覆盖：
 *   S1  授权目录内读文本/枚举/统计成功；.. 与白名单外路径被拒且不泄漏；
 *       未持 files:read 的 caller 被拒；卸载服务注销无残留
 */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IsSheepBoxKernel } = require('../kernel/dist/index.js');
const {
  createApprovalPolicyPlugin,
  MemoryApprovalStore,
} = require('../approval-policy/dist/index.js');

const FILES_SERVICE_ID = 'org.issheepbox.files-service';
const CONSUMER_ID = 'org.test.consumer';
const DENIED_ID = 'org.test.denied';

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}

class GrantAllPrompter {
  async prompt() { return { kind: 'grant-all' }; }
}

function makeApprovalPolicy() {
  const store = new MemoryApprovalStore();
  // 预置消费方的 files:read 授权
  store.set({
    pluginId: CONSUMER_ID,
    status: 'granted',
    permissions: ['files:read'],
    decidedAt: new Date().toISOString(),
  });
  const factory = createApprovalPolicyPlugin({ prompter: new GrantAllPrompter(), store });
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

async function scenarioWhitelist(pluginsDir, root) {
  console.log('\n[S1] 白名单内读写 / 越权拒绝 / 门禁 / 卸载无残留');
  const hostDir = path.join(root, 'host-user-data');
  fs.mkdirSync(hostDir, { recursive: true });

  // 构造一个已授权目录及测试文件
  const allowedDir = path.join(root, 'allowed-workspace');
  fs.mkdirSync(path.join(allowedDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(allowedDir, 'hello.txt'), '你好世界', 'utf8');
  fs.writeFileSync(path.join(allowedDir, 'sub', 'inner.txt'), 'inner-content', 'utf8');
  // 一个白名单外的目录
  const outsideDir = path.join(root, 'outside-secret');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'SECRET', 'utf8');

  const kernel = new IsSheepBoxKernel();
  await kernel.start(path.join(root, 'ud'), pluginsDir);
  const out = await kernel.lifecycle.mount(makeApprovalPolicy());
  ok(out.ok === true, 'approval-policy 已挂载');
  kernel.services.register('host:user-data', { dir: hostDir });

  await kernel.profile.enable(FILES_SERVICE_ID);
  ok(kernel.lifecycle.mountedIds.includes(FILES_SERVICE_ID), 'files-service 已挂载（无权限自动放行）');

  const files = kernel.services.get('files');
  ok(files && typeof files.readText === 'function', 'files 服务已注册');

  files.authorizeDir(allowedDir);
  ok(
    files.listAuthorizedDirs().includes(path.resolve(allowedDir)),
    'authorizeDir 后白名单含该目录',
  );

  // —— 白名单内读文本成功 ——
  const text = files.readText(CONSUMER_ID, path.join(allowedDir, 'hello.txt'));
  ok(text === '你好世界', '已授权目录内 readText 读取成功');

  // —— 白名单内枚举目录成功 ——
  const entries = files.listDir(CONSUMER_ID, allowedDir);
  ok(entries.includes('hello.txt') && entries.includes('sub'), 'listDir 枚举成功（含子目录）');

  // —— stat 成功 ——
  const st = files.stat(CONSUMER_ID, path.join(allowedDir, 'hello.txt'));
  ok(st.size > 0 && st.isDir === false, 'stat 返回 size/isDir 正确');

  // —— .. 穿越被拒 ——
  let threw = null;
  try {
    files.readText(CONSUMER_ID, path.join(allowedDir, '..', 'outside-secret', 'secret.txt'));
  } catch (e) { threw = e; }
  ok(threw !== null, '含 .. 的路径被拒绝');
  ok(threw && /越权|\.\./.test(threw.message), '错误信息指明路径越权');

  // —— 白名单外绝对路径被拒 ——
  threw = null;
  try {
    files.readText(CONSUMER_ID, path.join(outsideDir, 'secret.txt'));
  } catch (e) { threw = e; }
  ok(threw !== null, '白名单外绝对路径被拒绝');
  ok(threw && !/SECRET/.test(threw.message), '错误信息不泄漏文件内容');

  // —— 未持 files:read 的 caller 被拒 ——
  threw = null;
  try {
    files.readText(DENIED_ID, path.join(allowedDir, 'hello.txt'));
  } catch (e) { threw = e; }
  ok(threw !== null, '未持 files:read 的 caller 调用被拒绝');
  ok(threw && /files:read/.test(threw.message), '错误信息指明 files:read 未授权');

  // —— 卸载无残留 ——
  await kernel.profile.disable(FILES_SERVICE_ID);
  ok(!kernel.lifecycle.mountedIds.includes(FILES_SERVICE_ID), 'files-service 已卸载');
  ok(!kernel.services.has('files'), '卸载后 files 服务已注销（可逆 effects）');

  await kernel.stop();
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-files-service-verify-'));
  const pluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  console.log('宿主文件能力服务插件验证（真实内核）');
  console.log(`临时目录: ${tmpRoot}`);

  const src = path.join(__dirname, 'files-service');
  if (!fs.existsSync(path.join(src, 'dist', 'index.js'))) {
    throw new Error('缺少构建产物：packages/plugins/files-service/dist。请先 pnpm --filter @issheepbox/plugin-files-service build。');
  }
  copyPluginPackage(src, pluginsDir);
  ok(fs.existsSync(pluginsDir), '临时 pluginsDir 就绪');

  try {
    await scenarioWhitelist(pluginsDir, path.join(tmpRoot, 's1'));
    console.log(`\n全部通过：${checks} 项断言（1 个场景）`);
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
