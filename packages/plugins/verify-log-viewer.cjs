/**
 * 日志查看面板插件（org.issheepbox.log-viewer）端到端验证。
 *
 * 前置：
 *   pnpm --filter @issheepbox/kernel --filter @issheepbox/approval-policy build
 *   pnpm --filter @issheepbox/plugin-logger build
 *   pnpm --filter @issheepbox/plugin-log-viewer build
 *
 * 运行：
 *   node packages/plugins/verify-log-viewer.cjs
 *
 * 覆盖：
 *   S1  已授权（store 预置 logs:read）→ 面板注册 → write 后 panel:outbound 收到 entry
 *       → 面板发 filter 请求 → panel:outbound 收到 history → 卸载面板注销无残留
 *   S2  未授权（store 无 logs:read 记录）→ 面板注册但不转发任何日志（fail-safe）
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
const VIEWER_ID = 'org.issheepbox.log-viewer';
const PANEL_ID = 'log-viewer-main';

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

/** 构造 approval-policy；preGrant = 是否预置 log-viewer 的 logs:read 授权记录。 */
function makeApprovalPolicy(prompter, preGrant) {
  const store = new MemoryApprovalStore();
  if (preGrant) {
    store.set({
      pluginId: VIEWER_ID,
      status: 'granted',
      permissions: ['logs:read'],
      decidedAt: new Date().toISOString(),
    });
  }
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

async function bootKernel(userDataDir, pluginsDir, preGrant) {
  const kernel = new IsSheepBoxKernel();
  await kernel.start(userDataDir, pluginsDir);
  const out = await kernel.lifecycle.mount(makeApprovalPolicy(new GrantAllPrompter(), preGrant));
  ok(out.ok === true, 'approval-policy 已挂载');
  const hostDir = path.join(userDataDir, 'host-data');
  fs.mkdirSync(hostDir, { recursive: true });
  kernel.services.register('host:user-data', { dir: hostDir });
  return kernel;
}

async function scenarioAuthorized(pluginsDir, root) {
  console.log('\n[S1] 已授权：面板注册 / entry 实时转发 / filter 查询 / 卸载无残留');
  const kernel = await bootKernel(path.join(root, 'ud-auth'), pluginsDir, true);

  await kernel.profile.enable(LOGGER_ID);
  ok(kernel.lifecycle.mountedIds.includes(LOGGER_ID), 'logger 已挂载');
  await kernel.profile.enable(VIEWER_ID);
  ok(kernel.lifecycle.mountedIds.includes(VIEWER_ID), 'log-viewer 已挂载（已授权）');

  const ui = kernel.services.get('shell:ui');
  ok(
    ui.panels.some((p) => p.id === PANEL_ID && p.interactive === true),
    'log-viewer 已注册交互式面板',
  );

  // 收集 panel:outbound 消息
  const outbound = [];
  kernel.events.on('panel:outbound', (msg) => {
    if (msg && msg.panelId === PANEL_ID) outbound.push(msg.data);
  });

  // 写一条日志 → log-viewer 应转发 entry
  const logging = kernel.services.get('logging');
  logging.write('error', 'org.test.app', '测试错误日志');
  await new Promise((r) => setTimeout(r, 20));

  const entryMsgs = outbound.filter((d) => d.type === 'entry');
  ok(entryMsgs.length >= 1, `panel:outbound 收到实时 entry 消息（${entryMsgs.length} 条）`);
  ok(
    entryMsgs[0].entry.level === 'error' && entryMsgs[0].entry.message === '测试错误日志',
    'entry 载荷正确（级别/内容）',
  );

  // 模拟面板发 filter 请求 → log-viewer 应回 history
  kernel.events.emit('panel:inbound', {
    pluginId: VIEWER_ID,
    panelId: PANEL_ID,
    data: { type: 'filter', filter: { minLevel: 'error' } },
  });
  await new Promise((r) => setTimeout(r, 20));

  const historyMsgs = outbound.filter((d) => d.type === 'history');
  ok(historyMsgs.length >= 1, 'panel:outbound 收到 history 响应');
  ok(
    historyMsgs[historyMsgs.length - 1].entries.some((e) => e.message === '测试错误日志'),
    'history 结果含 error 日志（筛选生效）',
  );

  // 卸载无残留
  await kernel.profile.disable(VIEWER_ID);
  ok(!kernel.lifecycle.mountedIds.includes(VIEWER_ID), 'log-viewer 已卸载');
  ok(
    !ui.panels.some((p) => p.id === PANEL_ID),
    '卸载后面板记录已随 effect scope 回滚（不残留）',
  );

  // 卸载后再写日志，不应再有 entry 转发
  const before = outbound.length;
  logging.write('warn', 'org.test.app', '卸载后不应转发');
  await new Promise((r) => setTimeout(r, 20));
  ok(outbound.length === before, 'log-viewer 卸载后不再转发日志事件（监听已回滚）');

  await kernel.stop();
}

async function scenarioUnauthorized(pluginsDir, root) {
  console.log('\n[S2] 未授权：面板注册但 fail-safe 不转发任何日志');
  const kernel = await bootKernel(path.join(root, 'ud-noauth'), pluginsDir, false);

  await kernel.profile.enable(LOGGER_ID);
  await kernel.profile.enable(VIEWER_ID);
  ok(kernel.lifecycle.mountedIds.includes(VIEWER_ID), '未授权 log-viewer 仍可挂载（空权限自动放行）');

  const ui = kernel.services.get('shell:ui');
  ok(ui.panels.some((p) => p.id === PANEL_ID), '未授权时仍注册了面板（提示面板）');

  const outbound = [];
  kernel.events.on('panel:outbound', (msg) => {
    if (msg && msg.panelId === PANEL_ID) outbound.push(msg.data);
  });

  const logging = kernel.services.get('logging');
  logging.write('error', 'org.secret.app', '机密内容不应泄漏');
  await new Promise((r) => setTimeout(r, 20));

  ok(
    outbound.filter((d) => d.type === 'entry').length === 0,
    '未授权时 panel:outbound 不转发任何日志 entry（fail-safe 无泄漏）',
  );

  await kernel.stop();
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-logviewer-verify-'));
  const pluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  console.log('日志查看面板插件验证（真实内核）');
  console.log(`临时目录: ${tmpRoot}`);

  // 拷贝 logger + log-viewer + shell-default
  for (const name of ['logger', 'log-viewer']) {
    const src = path.join(__dirname, name);
    if (!fs.existsSync(path.join(src, 'plugin.json')) || !fs.existsSync(path.join(src, 'dist', 'index.js'))) {
      throw new Error(`缺少构建产物：${src}，请先 pnpm --filter @issheepbox/plugin-${name} build。`);
    }
    copyPluginPackage(src, pluginsDir);
  }
  const shellSrc = path.join(__dirname, '..', 'shell-default');
  if (!fs.existsSync(path.join(shellSrc, 'dist', 'index.js'))) {
    throw new Error('缺少 shell-default 构建产物，请先 pnpm --filter @issheepbox/shell-default build。');
  }
  copyPluginPackage(shellSrc, pluginsDir);
  ok(fs.existsSync(pluginsDir), '临时 pluginsDir 就绪（logger + log-viewer + shell-default）');

  try {
    await scenarioAuthorized(pluginsDir, path.join(tmpRoot, 's1'));
    await scenarioUnauthorized(pluginsDir, path.join(tmpRoot, 's2'));
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
