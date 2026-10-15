/**
 * devkit 插件内核级验证：交互面板注册 + 面板桥双向 + storage 落盘。
 *
 * 覆盖：
 *  - 注册 interactive 面板（透传标记）
 *  - 面板 history:push → 主进程写 storage → 回推 history
 *  - storage 命名空间内确有该条目（落盘真生效）
 *  - history:load 回推 / history:clear 清空
 *  - 卸载后面板与监听回滚（无残留）
 *
 * 前置：
 *   pnpm build
 *   pnpm --filter @issheepbox/plugin-storage --filter @issheepbox/plugin-devkit run build
 * 运行：
 *   node packages/plugins/verify-devkit.cjs
 */
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IsSheepBoxKernel } = require('../kernel/dist/index.js');
const { createApprovalPolicyPlugin } = require('../approval-policy/dist/index.js');

const PLUGIN_ROOT = __dirname;
const DEVKIT_ID = 'com.pastsheep.devkit';
const STORAGE_ID = 'org.issheepbox.storage';
const APPROVAL_POLICY_ID = 'org.issheepbox.approval-policy';

let checks = 0;
function ok(c, m) { checks += 1; assert.ok(c, m); console.log(`  ✓ ${m}`); }
const tick = () => new Promise((r) => setTimeout(r, 0));

class GrantAllPrompter { async prompt() { return { kind: 'grant-all' }; } }

function makeApprovalPolicy() {
  return {
    dir: path.join('virtual', APPROVAL_POLICY_ID),
    manifest: {
      id: APPROVAL_POLICY_ID, name: '权限授权', version: '1.0.0',
      apiVersion: '^1.0.0', entry: 'dist/index.js', permissions: [],
    },
    module: { default: createApprovalPolicyPlugin({ prompter: new GrantAllPrompter() }) },
  };
}

function copyPkg(src, destRoot) {
  fs.cpSync(src, path.join(destRoot, path.basename(src)), {
    recursive: true,
    filter: (s) => !['node_modules', 'src'].includes(path.basename(s)),
  });
}

function makePluginsDir(pluginsDir) {
  for (const name of ['shell-default', 'storage', 'devkit']) {
    const src = name === 'shell-default'
      ? path.join(PLUGIN_ROOT, '..', 'shell-default')
      : path.join(PLUGIN_ROOT, name);
    if (!fs.existsSync(path.join(src, 'plugin.json')) || !fs.existsSync(path.join(src, 'dist', 'index.js'))) {
      throw new Error(`缺少构建产物：${src}`);
    }
    copyPkg(src, pluginsDir);
  }
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-devkit-'));
  const pluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  console.log('devkit 插件验证');
  console.log(`临时目录: ${tmpRoot}`);
  makePluginsDir(pluginsDir);

  const kernel = new IsSheepBoxKernel();
  const { boot } = await kernel.start(path.join(tmpRoot, 'userdata'), pluginsDir);
  ok(boot.safeMode === false, '默认壳正常挂载');

  await kernel.lifecycle.mount(makeApprovalPolicy());
  await kernel.profile.enable(STORAGE_ID);
  ok(kernel.lifecycle.mountedIds.includes(STORAGE_ID), 'storage 已授权并挂载');
  await kernel.profile.enable(DEVKIT_ID);
  ok(kernel.lifecycle.mountedIds.includes(DEVKIT_ID), 'devkit 已挂载');

  // 交互面板注册
  const ui = kernel.services.get('shell:ui');
  const panel = ui.panels.find((p) => p.id === 'devkit-main');
  ok(panel && panel.interactive === true, 'devkit 注册了 interactive 面板');

  const outbound = [];
  kernel.events.on('panel:outbound', (p) => outbound.push(p));

  // history:push
  kernel.events.emit('panel:inbound', {
    pluginId: DEVKIT_ID, panelId: 'devkit-main',
    data: { type: 'history:push', kind: 'json', text: '{"a":1}' },
  });
  await tick();
  ok(outbound.length >= 1 && outbound[outbound.length - 1].data.type === 'history', 'push 后回推 history');
  let items = outbound[outbound.length - 1].data.items;
  ok(items.length === 1 && items[0].text === '{"a":1}', 'history 含刚收藏的条目');

  // 真落盘到 storage
  const stored = kernel.services.get('storage').namespace(DEVKIT_ID).get('history');
  ok(Array.isArray(stored) && stored[0].text === '{"a":1}', 'storage 命名空间内确有该条目（落盘生效）');

  // history:load
  outbound.length = 0;
  kernel.events.emit('panel:inbound', { pluginId: DEVKIT_ID, panelId: 'devkit-main', data: { type: 'history:load' } });
  await tick();
  ok(outbound.length === 1 && outbound[0].data.items.length === 1, 'history:load 回推当前历史');

  // clear
  kernel.events.emit('panel:inbound', { pluginId: DEVKIT_ID, panelId: 'devkit-main', data: { type: 'history:clear' } });
  await tick();
  items = outbound[outbound.length - 1].data.items;
  ok(items.length === 0, 'history:clear 后历史为空');
  const storedAfter = kernel.services.get('storage').namespace(DEVKIT_ID).get('history');
  ok(Array.isArray(storedAfter) && storedAfter.length === 0, 'clear 同步清空 storage');

  // 卸载无残留
  await kernel.profile.disable(DEVKIT_ID);
  ok(!ui.panels.some((p) => p.id === 'devkit-main'), '卸载后面板记录回滚');
  outbound.length = 0;
  kernel.events.emit('panel:inbound', { pluginId: DEVKIT_ID, panelId: 'devkit-main', data: { type: 'history:load' } });
  await tick();
  ok(outbound.length === 0, '卸载后不再响应 panel:inbound');

  await kernel.stop();
  console.log(`\n全部通过：${checks} 项断言`);
  process.exitCode = 0;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(`\n验证失败：${e.message}`);
  console.error(e.stack);
  process.exitCode = 1;
});
