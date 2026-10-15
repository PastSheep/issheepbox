/**
 * 可交互面板桥（panel:inbound / panel:outbound）内核级验证。
 *
 * 本脚本只验证「主进程内的事件契约」——即插件侧协议：
 *   - shell:ui.registerPanel(..., {interactive:true}) 把交互标记透传进 panels 数组
 *   - 插件 ctx.events.on('panel:inbound') 只认领自己的 panelId
 *   - 插件 ctx.events.emit('panel:outbound') 回发消息
 *   - 卸载后面板记录与监听随 effect scope 回滚（无残留）
 *
 * 真正的 Electron 渲染侧（iframe srcdoc / postMessage / webContents.send）
 * 是 desktop main.ts + preload + index.html 的薄胶水，无法在无显示环境 headless
 * 验证；其正确性由 tsc 构建 + 人工 `pnpm dev` 确认。
 *
 * 前置（先构建）：
 *   pnpm build                                                       # kernel/approval-policy/shell-default
 *   pnpm --filter @issheepbox/plugin-echo-panel run build            # echo-panel → dist/
 * 运行：
 *   node packages/plugins/verify-panel-bridge.cjs
 */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IsSheepBoxKernel } = require('../kernel/dist/index.js');

const PLUGIN_ROOT = __dirname;
const ECHO_ID = 'com.pastsheep.echo-panel';
const SHELL_ID = 'org.issheepbox.shell-default';

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function copyPluginPackage(srcDir, destRoot) {
  fs.cpSync(srcDir, path.join(destRoot, path.basename(srcDir)), {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== 'node_modules' && base !== 'src';
    },
  });
}

function makePluginsDir(pluginsDir) {
  const sources = [
    path.join(PLUGIN_ROOT, '..', 'shell-default'),
    path.join(PLUGIN_ROOT, 'echo-panel'),
  ];
  for (const src of sources) {
    const manifestPath = path.join(src, 'plugin.json');
    const entryPath = path.join(src, 'dist', 'index.js');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(entryPath)) {
      throw new Error(`缺少构建产物：${src}。请先 pnpm build 与 pnpm --filter @issheepbox/plugin-echo-panel run build。`);
    }
    copyPluginPackage(src, pluginsDir);
  }
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-panel-bridge-'));
  const pluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  console.log('可交互面板桥事件契约验证');
  console.log(`临时目录: ${tmpRoot}`);
  makePluginsDir(pluginsDir);

  const kernel = new IsSheepBoxKernel();
  const { boot, discovered } = await kernel.start(path.join(tmpRoot, 'userdata'), pluginsDir);
  ok(boot.safeMode === false, '默认壳正常挂载，未进入安全模式');
  ok(discovered.map((p) => p.manifest.id).includes(ECHO_ID), `内核发现插件 ${ECHO_ID}`);

  // echo 无任何权限 → 无需授权门禁，直接 enable。
  await kernel.profile.enable(ECHO_ID);
  ok(kernel.lifecycle.mountedIds.includes(ECHO_ID), 'echo-panel 已启用并挂载');

  // —— 交互面板元数据透传 ——
  const ui = kernel.services.get('shell:ui');
  const panel = ui.panels.find((p) => p.id === 'echo-main');
  ok(panel, 'shell:ui.panels 含 echo-main');
  ok(panel.interactive === true, '面板条目 interactive === true（宿主据此切 iframe）');
  ok(panel.src === 'assets/panel.html' && panel.pluginId === ECHO_ID, '面板 src/pluginId 透传到渲染进程');

  // —— 面板 → 主进程 → 主进程回发 panel:outbound ——
  const outbound = [];
  kernel.events.on('panel:outbound', (payload) => outbound.push(payload));

  kernel.events.emit('panel:inbound', {
    pluginId: ECHO_ID,
    panelId: 'echo-main',
    data: { text: '你好面板桥' },
  });
  await tick();
  ok(outbound.length === 1, '面板 inbound 触发一次 outbound 回发');
  ok(outbound[0].panelId === 'echo-main', 'outbound 路由回 echo-main');
  ok(/你好面板桥/.test(outbound[0].data.text), '回显文本包含面板发来的原文');
  ok(typeof outbound[0].data.at === 'number', 'outbound 携带主进程时间戳');

  // —— panelId 隔离：别人的面板消息 echo 不应认领 ——
  kernel.events.emit('panel:inbound', {
    pluginId: ECHO_ID,
    panelId: 'some-other-panel',
    data: { text: '别理我' },
  });
  await tick();
  ok(outbound.length === 1, '非自身 panelId 的 inbound 被忽略（不串台）');

  // —— 卸载无残留：面板记录回滚 + inbound 监听回滚 ——
  await kernel.profile.disable(ECHO_ID);
  ok(!kernel.lifecycle.mountedIds.includes(ECHO_ID), 'echo-panel 已卸载');
  ok(!ui.panels.some((p) => p.id === 'echo-main'), '卸载后面板记录已回滚（不残留）');

  outbound.length = 0;
  kernel.events.emit('panel:inbound', {
    pluginId: ECHO_ID, panelId: 'echo-main', data: { text: '卸载后再发' },
  });
  await tick();
  ok(outbound.length === 0, '卸载后不再响应 panel:inbound（监听随 effect scope 回滚）');

  await kernel.stop();
  ok(kernel.lifecycle.mountedIds.length === 0, 'kernel.stop 后全部插件卸载');

  console.log(`\n全部通过：${checks} 项断言`);
  process.exitCode = 0;

  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(`\n验证失败：${err.message}`);
  console.error(err.stack);
  process.exitCode = 1;
});
