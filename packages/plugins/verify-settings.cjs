/**
 * 设置中心插件（org.issheepbox.settings）端到端验证。
 *
 * 前置：
 *   pnpm --filter @issheepbox/kernel --filter @issheepbox/approval-policy --filter @issheepbox/shell-default build
 *   pnpm --filter @issheepbox/plugin-settings build
 *
 * 运行：
 *   node packages/plugins/verify-settings.cjs
 *
 * 覆盖：
 *   S1  授权后挂载 → 面板注册 → set-registryUrl 写盘读回 → reset-registryUrl 恢复默认 →
 *       request-enable/disable/set-shell 事件正确发出 → 宿主模拟执行后 profile 生效 →
 *       诊断字段存在 → 卸载面板注销
 *   S2  DenyPrompter 拒绝 files:read/write → settings 不可启用
 */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IsSheepBoxKernel } = require('../kernel/dist/index.js');
const { createApprovalPolicyPlugin } = require('../approval-policy/dist/index.js');

const SETTINGS_ID = 'org.issheepbox.settings';
const SHELL_ID = 'org.issheepbox.shell-default';
const PANEL_ID = 'settings-main';
const DEFAULT_REGISTRY =
  'https://raw.githubusercontent.com/PastSheep/issheepbox-registry/main/plugins.json';

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}

class GrantAllPrompter {
  async prompt() { return { kind: 'grant-all' }; }
}
class DenyPrompter {
  async prompt() { return { kind: 'deny' }; }
}

function makeApprovalPolicy(prompter) {
  const factory = createApprovalPolicyPlugin({ prompter });
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

async function bootKernel(userDataDir, pluginsDir, prompter) {
  const kernel = new IsSheepBoxKernel();
  await kernel.start(userDataDir, pluginsDir);
  const out = await kernel.lifecycle.mount(makeApprovalPolicy(prompter));
  ok(out.ok === true, 'approval-policy 已挂载');
  const hostDir = path.join(userDataDir, 'host-data');
  fs.mkdirSync(hostDir, { recursive: true });
  kernel.services.register('host:user-data', { dir: hostDir });
  return kernel;
}

async function scenarioHappyPath(pluginsDir, root) {
  console.log('\n[S1] 授权后挂载 / registry 读写 / 启停事件 / 诊断 / 卸载无残留');
  const kernel = await bootKernel(path.join(root, 'ud'), pluginsDir, new GrantAllPrompter());
  const hostDir = kernel.services.get('host:user-data').dir;

  await kernel.profile.enable(SETTINGS_ID);
  ok(kernel.lifecycle.mountedIds.includes(SETTINGS_ID), 'settings 已挂载');

  const ui = kernel.services.get('shell:ui');
  ok(ui.panels.some((p) => p.id === PANEL_ID), 'settings 面板已注册');

  // —— registryUrl 写盘读回 ——
  kernel.events.emit('panel:inbound', {
    pluginId: SETTINGS_ID,
    panelId: PANEL_ID,
    data: { type: 'set-registryUrl', url: 'https://my-registry.example.com/plugins.json' },
  });
  await new Promise((r) => setTimeout(r, 20));
  const cfgPath = path.join(hostDir, 'config.json');
  ok(fs.existsSync(cfgPath), 'config.json 已写盘');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok(cfg.registryUrl === 'https://my-registry.example.com/plugins.json', 'config.json registryUrl 读回正确');

  // —— 重置默认 ——
  kernel.events.emit('panel:inbound', {
    pluginId: SETTINGS_ID,
    panelId: PANEL_ID,
    data: { type: 'reset-registryUrl' },
  });
  await new Promise((r) => setTimeout(r, 20));
  const cfg2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok(!cfg2.registryUrl, '重置默认后 registryUrl 已移除（回落到内置默认）');

  // —— request-disable 事件 → 宿主模拟执行 → profile 生效 ——
  const disableEvents = [];
  kernel.events.on('settings:request-disable', (p) => disableEvents.push(p));
  kernel.events.emit('panel:inbound', {
    pluginId: SETTINGS_ID,
    panelId: PANEL_ID,
    data: { type: 'request-disable', pluginId: SHELL_ID },
  });
  await new Promise((r) => setTimeout(r, 10));
  ok(disableEvents.length === 1 && disableEvents[0].pluginId === SHELL_ID, 'settings:request-disable 事件正确发出');

  // 宿主模拟执行
  await kernel.profile.disable(SHELL_ID);
  ok(
    !kernel.profile.getCurrent().enabled.includes(SHELL_ID),
    '宿主执行 disable 后 profile.enabled 移除壳插件',
  );

  // request-enable 事件 → 宿主模拟执行 → profile 生效
  const enableEvents = [];
  kernel.events.on('settings:request-enable', (p) => enableEvents.push(p));
  kernel.events.emit('panel:inbound', {
    pluginId: SETTINGS_ID,
    panelId: PANEL_ID,
    data: { type: 'request-enable', pluginId: SHELL_ID },
  });
  await new Promise((r) => setTimeout(r, 10));
  ok(enableEvents.length === 1 && enableEvents[0].pluginId === SHELL_ID, 'settings:request-enable 事件正确发出');
  await kernel.profile.enable(SHELL_ID);
  ok(kernel.profile.getCurrent().enabled.includes(SHELL_ID), '宿主执行 enable 后 profile.enabled 含壳插件');

  // request-set-shell 事件
  const shellEvents = [];
  kernel.events.on('settings:request-set-shell', (p) => shellEvents.push(p));
  kernel.events.emit('panel:inbound', {
    pluginId: SETTINGS_ID,
    panelId: PANEL_ID,
    data: { type: 'request-set-shell', shellId: SHELL_ID },
  });
  await new Promise((r) => setTimeout(r, 10));
  ok(shellEvents.length === 1 && shellEvents[0].shellId === SHELL_ID, 'settings:request-set-shell 事件正确发出');

  // —— 诊断字段存在 ——
  const diagOutbound = [];
  kernel.events.on('panel:outbound', (msg) => {
    if (msg && msg.panelId === PANEL_ID && msg.data && msg.data.type === 'state') diagOutbound.push(msg.data);
  });
  kernel.events.emit('panel:inbound', {
    pluginId: SETTINGS_ID,
    panelId: PANEL_ID,
    data: { type: 'get-all' },
  });
  await new Promise((r) => setTimeout(r, 20));
  ok(diagOutbound.length >= 1, '面板请求 get-all 后收到 state 响应');
  const diag = diagOutbound[diagOutbound.length - 1].diagnostics;
  ok(typeof diag.apiVersion === 'string' && diag.apiVersion.length > 0, '诊断含 ctx apiVersion');
  ok(Array.isArray(diag.enabled), '诊断含 enabled 插件清单');
  ok(diag.defaultRegistryUrl === DEFAULT_REGISTRY, '诊断含默认 registry 地址');

  // —— 卸载无残留 ——
  await kernel.profile.disable(SETTINGS_ID);
  ok(!ui.panels.some((p) => p.id === PANEL_ID), '卸载后 settings 面板记录已回滚');

  await kernel.stop();
}

async function scenarioDeny(pluginsDir, root) {
  console.log('\n[S2] DenyPrompter 拒绝 files:read/write：settings 不可启用');
  const kernel = await bootKernel(path.join(root, 'ud-deny'), pluginsDir, new DenyPrompter());
  await kernel.profile.enable(SETTINGS_ID);
  ok(!kernel.lifecycle.mountedIds.includes(SETTINGS_ID), '拒绝后 settings 未挂载');
  ok(!kernel.profile.getCurrent().enabled.includes(SETTINGS_ID), '拒绝后 settings 未进 profile.enabled');
  await kernel.stop();
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-settings-verify-'));
  const pluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  console.log('设置中心插件验证（真实内核）');
  console.log(`临时目录: ${tmpRoot}`);

  const src = path.join(__dirname, 'settings');
  if (!fs.existsSync(path.join(src, 'dist', 'index.js'))) {
    throw new Error('缺少构建产物：packages/plugins/settings/dist。请先 pnpm --filter @issheepbox/plugin-settings build。');
  }
  copyPluginPackage(src, pluginsDir);
  copyPluginPackage(path.join(__dirname, '..', 'shell-default'), pluginsDir);
  ok(fs.existsSync(pluginsDir), '临时 pluginsDir 就绪（settings + shell-default）');

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
