/**
 * 日志服务插件（org.issheepbox.logger）端到端验证。
 *
 * 复用 verify-storage.cjs 思路：临时 pluginsDir 驱动真实内核（非 mock），
 * 注入自定义 MemoryApprovalStore（预置 viewer 的 logs:read 授权）+ GrantAll Prompter。
 *
 * 前置：
 *   pnpm --filter @issheepbox/kernel --filter @issheepbox/approval-policy build
 *   pnpm --filter @issheepbox/plugin-logger build
 *
 * 运行：
 *   node packages/plugins/verify-logger.cjs
 *
 * 覆盖：
 *   S1  授权后挂载 → write → log:entry 广播 → query 读回 → 落盘 →
 *       跨重启从磁盘读回 → 轮转触发 → 卸载服务注销无残留
 *   S2  logs:read 门禁：已授权 caller 查询成功；未授权 caller 查询抛错且不泄漏数据
 *   S3  DenyPrompter 拒绝 files:read/write → logger 不可启用、不注册服务
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

const LOGGER_ID = 'org.issheepbox.logger';
const ACTIVE_FILE = 'issheepbox-logs-current.jsonl';
const ARCHIVE_1 = 'issheepbox-logs-1.jsonl';
const VIEWER_ID = 'org.test.viewer';
const DENIED_ID = 'org.test.denied';

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

/** 构造预置授权记录的 approval-policy：viewer 已获 logs:read，logger 走 GrantAll 弹窗授权。 */
function makeApprovalPolicy(prompter) {
  const store = new MemoryApprovalStore();
  // 预置 viewer 的 logs:read 授权（logs:read 不在已知权限目录，正常弹窗不会授予，
  // 这里直接写 store 模拟「用户已授权该插件读取日志」）。
  store.set({
    pluginId: VIEWER_ID,
    status: 'granted',
    permissions: ['logs:read'],
    decidedAt: new Date().toISOString(),
  });
  const factory = createApprovalPolicyPlugin({ prompter, store });
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

async function bootKernel(userDataDir, pluginsDir, prompter, hostDir) {
  const kernel = new IsSheepBoxKernel();
  await kernel.start(userDataDir, pluginsDir);
  const out = await kernel.lifecycle.mount(makeApprovalPolicy(prompter));
  ok(out.ok === true, 'approval-policy 已挂载');
  kernel.services.register('host:user-data', { dir: hostDir });
  return kernel;
}

async function scenarioHappyPath(pluginsDir, root) {
  console.log('\n[S1] 授权后挂载 / write / log:entry / query / 落盘 / 重启读回 / 轮转 / 卸载无残留');
  const hostDir = path.join(root, 'host-user-data');
  fs.mkdirSync(hostDir, { recursive: true });

  // —— 第一轮内核：写入 + 事件 + 查询 ——
  const kernel = await bootKernel(path.join(root, 'ud-a'), pluginsDir, new GrantAllPrompter(), hostDir);
  await kernel.profile.enable(LOGGER_ID);
  ok(kernel.lifecycle.mountedIds.includes(LOGGER_ID), '授权后 logger 插件已挂载');

  const logging = kernel.services.get('logging');
  ok(logging && typeof logging.write === 'function', 'logging 服务已注册');
  ok(logging.isPersistent() === true, '检测到 host:user-data，logging 处于持久化模式');

  const received = [];
  kernel.events.on('log:entry', (entry) => received.push(entry));

  logging.write('info', 'org.foo.app', '启动完成');
  logging.write('warn', 'org.foo.app', '磁盘快满了', { percent: 91 });
  logging.write('error', 'org.bar.net', '请求超时', { url: 'https://x' });

  // 等待批量刷盘（FLUSH_EVERY=5，这里 3 条未触发自动 flush，手动触发一条 debug 凑满）
  logging.write('debug', 'org.foo.app', '调试信息');
  logging.write('debug', 'org.foo.app', '再一条凑满 flush');

  await new Promise((r) => setTimeout(r, 20));

  ok(received.length === 5, `log:entry 事件被订阅收到（${received.length} 条）`);
  ok(received[0].level === 'info' && received[0].scope === 'org.foo.app', 'log:entry 载荷正确（首条）');
  ok(received[2].level === 'error' && received[2].message === '请求超时', 'log:entry 载荷正确（error 条）');

  // 已授权 caller 查询
  const all = logging.query(VIEWER_ID);
  ok(all.length >= 5, `已授权 caller query 读回日志（${all.length} 条）`);
  const errors = logging.query(VIEWER_ID, { minLevel: 'error' });
  ok(errors.length === 1 && errors[0].message === '请求超时', 'query 按 minLevel=error 筛选正确');
  const scoped = logging.query(VIEWER_ID, { scope: 'org.foo.app' });
  ok(scoped.length === 4, 'query 按 scope 筛选正确');

  // 落盘断言
  ok(fs.existsSync(path.join(hostDir, ACTIVE_FILE)), '日志已写穿透落盘（active 文件存在）');

  await kernel.stop();

  // —— 第二轮内核：模拟重启，从磁盘读回 ——
  const kernel2 = await bootKernel(path.join(root, 'ud-b'), pluginsDir, new GrantAllPrompter(), hostDir);
  await kernel2.profile.enable(LOGGER_ID);
  const logging2 = kernel2.services.get('logging');
  const afterRestart = logging2.query(VIEWER_ID);
  ok(
    afterRestart.length >= 5,
    `跨「内核重启」后从磁盘读回此前写入的日志（${afterRestart.length} 条）`,
  );
  ok(
    afterRestart.some((e) => e.message === '请求超时'),
    '重启后 error 日志内容完整保留',
  );

  // —— 触发轮转：写大量日志超过 64KB 阈值（每条 ~200B，需 ~330 条；写 600 条保险）——
  const beforeCount = logging2.size();
  for (let i = 0; i < 600; i++) {
    logging2.write(
      'info',
      'org.bulk.gen',
      `批量日志条目编号 ${i}，这是一段足够长的填充文本用于确保单条日志超过两百字节从而快速触发轮转阈值`,
    );
  }
  await new Promise((r) => setTimeout(r, 50));

  ok(fs.existsSync(path.join(hostDir, ARCHIVE_1)), '轮转触发：归档文件 logs-1 已生成');
  ok(logging2.size() >= beforeCount + 400, '批量写入后内存缓冲增长');

  // 卸载无残留：服务注销
  await kernel2.profile.disable(LOGGER_ID);
  ok(!kernel2.lifecycle.mountedIds.includes(LOGGER_ID), 'logger 已卸载');
  ok(!kernel2.services.has('logging'), '卸载后 logging 服务已注销（可逆 effects，不残留）');

  await kernel2.stop();
}

async function scenarioPermissionGate(pluginsDir, root) {
  console.log('\n[S2] logs:read 门禁：已授权查询成功，未授权抛错不泄漏');
  const hostDir = path.join(root, 'host-user-data-gate');
  fs.mkdirSync(hostDir, { recursive: true });

  const kernel = await bootKernel(path.join(root, 'ud-gate'), pluginsDir, new GrantAllPrompter(), hostDir);
  await kernel.profile.enable(LOGGER_ID);
  const logging = kernel.services.get('logging');

  logging.write('info', 'org.secret.app', '机密日志内容');
  await new Promise((r) => setTimeout(r, 10));

  // 已授权 caller
  const okResult = logging.query(VIEWER_ID);
  ok(Array.isArray(okResult) && okResult.length >= 1, '已授权 caller（logs:read）query 返回数据');

  // 未授权 caller：应抛错，且错误信息不含日志内容
  let threw = null;
  try {
    logging.query(DENIED_ID);
  } catch (e) {
    threw = e;
  }
  ok(threw !== null, '未授权 caller query 抛错（fail-safe 拒绝）');
  ok(
    threw && /logs:read/.test(threw.message),
    '错误信息指明 logs:read 未授权（不泄漏日志数据）',
  );
  ok(
    threw && !/机密日志内容/.test(threw.message),
    '错误信息不含任何日志正文（无数据泄漏）',
  );

  await kernel.stop();
}

async function scenarioDeny(pluginsDir, root) {
  console.log('\n[S3] DenyPrompter 拒绝 files:read/write：logger 不可启用、不注册服务');
  const hostDir = path.join(root, 'host-user-data-deny');
  fs.mkdirSync(hostDir, { recursive: true });

  const kernel = await bootKernel(path.join(root, 'ud-deny'), pluginsDir, new DenyPrompter(), hostDir);
  await kernel.profile.enable(LOGGER_ID);
  ok(!kernel.lifecycle.mountedIds.includes(LOGGER_ID), '拒绝后 logger 未被挂载');
  ok(!kernel.services.has('logging'), '拒绝后未注册 logging 服务');
  ok(
    !kernel.profile.getCurrent().enabled.includes(LOGGER_ID),
    '拒绝后 logger 未进入 profile.enabled',
  );
  await kernel.stop();
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-logger-verify-'));
  const pluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  console.log('日志服务插件验证（真实内核）');
  console.log(`临时目录: ${tmpRoot}`);

  const src = path.join(__dirname, 'logger');
  if (!fs.existsSync(path.join(src, 'plugin.json')) || !fs.existsSync(path.join(src, 'dist', 'index.js'))) {
    throw new Error(`缺少构建产物：${src}。请先 pnpm --filter @issheepbox/plugin-logger build。`);
  }
  copyPluginPackage(src, pluginsDir);
  ok(fs.existsSync(pluginsDir), '临时 pluginsDir 就绪');

  try {
    await scenarioHappyPath(pluginsDir, path.join(tmpRoot, 's1'));
    await scenarioPermissionGate(pluginsDir, path.join(tmpRoot, 's2'));
    await scenarioDeny(pluginsDir, path.join(tmpRoot, 's3'));
    console.log(`\n全部通过：${checks} 项断言（3 个场景）`);
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
