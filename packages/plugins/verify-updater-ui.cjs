/**
 * 更新提示面板插件（com.pastsheep.updater-ui）端到端验证。
 *
 * 前置：
 *   pnpm --filter @issheepbox/kernel build
 *   pnpm --filter @issheepbox/plugin-updater-ui build
 *
 * 运行：
 *   node packages/plugins/verify-updater-ui.cjs
 *
 * 覆盖：
 *   S1  假 updater 服务在线：面板注册（id/标题正确）→ emit updater:update-available
 *       → panel:outbound 收到含 latestVersion/releaseUrl 的消息 → 面板发 panel:inbound
 *       dismiss → 假 updater.dismiss 以正确版本号被调 → panel:outbound 回告 dismissed
 *       → 卸载面板注销无残留、事件监听回滚
 *   S2  无 updater 服务：面板仍注册 → dismiss 优雅降级回 unavailable，不抛错
 */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IsSheepBoxKernel } = require('../kernel/dist/index.js');

const PLUGIN_ID = 'com.pastsheep.updater-ui';
const PANEL_ID = 'updater-main';
const TICK_MS = 20;

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}

const tick = () => new Promise((r) => setTimeout(r, TICK_MS));

/** 捕获式假 shell:ui：记录注册的面板，unregister 时从列表移除。 */
function makeFakeShellUi() {
  const panels = [];
  return {
    panels,
    registerPanel(id, title, options) {
      panels.push({ id, title, options: options ?? {} });
      return () => {
        const i = panels.findIndex((p) => p.id === id);
        if (i >= 0) panels.splice(i, 1);
      };
    },
  };
}

/** 捕获式假 updater 服务：记录 dismiss 调用的版本号。 */
function makeFakeUpdater() {
  return {
    dismissCalls: [],
    dismiss(version) {
      this.dismissCalls.push(version);
    },
    getState() {
      return {
        lastCheckAt: null,
        ignoredVersion: null,
        latestVersion: null,
        releaseUrl: null,
      };
    },
  };
}

/** 真实内核 + 临时 userData 目录 + 捕获式假 shell:ui；withUpdater=false 时不注册假 updater。 */
async function bootKernel(userDataDir, withUpdater) {
  const pluginsDir = path.join(userDataDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const kernel = new IsSheepBoxKernel();
  await kernel.start(userDataDir, pluginsDir);
  const shellUi = makeFakeShellUi();
  kernel.services.register('shell:ui', shellUi);
  const updater = withUpdater ? makeFakeUpdater() : null;
  if (updater) kernel.services.register('updater', updater);
  return { kernel, shellUi, updater };
}

/** 加载已构建的 updater-ui 插件（目录直挂，不依赖 profile 装载链路）。 */
function loadUpdaterUiPlugin() {
  const dir = path.join(__dirname, 'updater-ui');
  if (
    !fs.existsSync(path.join(dir, 'plugin.json')) ||
    !fs.existsSync(path.join(dir, 'dist', 'index.js'))
  ) {
    throw new Error(
      `缺少构建产物：${dir}，请先 pnpm --filter @issheepbox/plugin-updater-ui build。`,
    );
  }
  return {
    dir,
    manifest: require(path.join(dir, 'plugin.json')),
    module: require(path.join(dir, 'dist', 'index.js')),
  };
}

/** 收集该面板的 panel:outbound 消息。 */
function attachOutboundCapture(kernel) {
  const outbound = [];
  kernel.events.on('panel:outbound', (msg) => {
    if (msg && msg.panelId === PANEL_ID) outbound.push(msg.data);
  });
  return outbound;
}

async function scenarioWithUpdater(root) {
  console.log('\n[S1] updater 在线：面板注册 / 事件转发 / dismiss 调用 / 卸载无残留');
  const { kernel, shellUi, updater } = await bootKernel(path.join(root, 'ud-with'), true);

  const mounted = await kernel.lifecycle.mount(loadUpdaterUiPlugin());
  ok(mounted.ok === true, 'updater-ui 已挂载（假 updater 在线）');

  ok(
    shellUi.panels.some((p) => p.id === PANEL_ID && p.title === '更新提示'),
    '挂载后面板已注册（id/标题正确）',
  );

  const outbound = attachOutboundCapture(kernel);

  kernel.events.emit('updater:update-available', {
    currentVersion: '0.2.1',
    latestVersion: '0.3.0',
    releaseUrl: 'https://github.com/PastSheep/issheepbox/releases/tag/v0.3.0',
  });
  await tick();

  const avail = outbound.filter((d) => d.type === 'update-available');
  ok(avail.length >= 1, 'emit updater:update-available 后 panel:outbound 收到 update-available');
  ok(
    avail[avail.length - 1].latestVersion === '0.3.0' &&
      avail[avail.length - 1].releaseUrl.includes('releases/tag/v0.3.0'),
    'update-available 载荷含 latestVersion / releaseUrl',
  );

  kernel.events.emit('panel:inbound', {
    pluginId: PLUGIN_ID,
    panelId: PANEL_ID,
    data: { type: 'dismiss', latestVersion: '0.3.0' },
  });
  await tick();

  ok(
    updater.dismissCalls.length === 1 && updater.dismissCalls[0] === '0.3.0',
    '面板 dismiss → 假 updater.dismiss 以正确版本号调用',
  );
  ok(
    outbound.some((d) => d.type === 'dismissed' && d.version === '0.3.0'),
    "panel:outbound 回告 dismissed（面板应收起提示）",
  );

  await kernel.lifecycle.unmount(PLUGIN_ID);
  ok(!kernel.lifecycle.mountedIds.includes(PLUGIN_ID), 'updater-ui 已卸载');
  ok(
    shellUi.panels.length === 0,
    '卸载后面板记录已随 effect scope 回滚（不残留）',
  );

  const before = outbound.length;
  kernel.events.emit('updater:update-available', {
    currentVersion: '0.2.1',
    latestVersion: '0.3.0',
    releaseUrl: 'https://example.com/x',
  });
  await tick();
  ok(outbound.length === before, '卸载后不再转发 updater 事件（监听已回滚）');

  await kernel.stop();
}

async function scenarioWithoutUpdater(root) {
  console.log('\n[S2] updater 缺失：dismiss 优雅降级，不抛错');
  const { kernel, shellUi } = await bootKernel(path.join(root, 'ud-without'), false);

  const mounted = await kernel.lifecycle.mount(loadUpdaterUiPlugin());
  ok(mounted.ok === true, '无 updater 服务时 updater-ui 仍可挂载（fail-safe）');
  ok(
    shellUi.panels.some((p) => p.id === PANEL_ID && p.title === '更新提示'),
    '无 updater 服务时面板仍注册（UI 壳在线）',
  );

  const outbound = attachOutboundCapture(kernel);

  kernel.events.emit('updater:update-available', {
    currentVersion: '0.2.1',
    latestVersion: '0.3.0',
    releaseUrl: 'https://example.com/releases/tag/v0.3.0',
  });
  await tick();
  ok(
    outbound.some((d) => d.type === 'update-available'),
    '事件载荷自包含：无 updater 服务仍转发 update-available',
  );

  kernel.events.emit('panel:inbound', {
    pluginId: PLUGIN_ID,
    panelId: PANEL_ID,
    data: { type: 'dismiss', latestVersion: '0.3.0' },
  });
  await tick();

  ok(
    outbound.some((d) => d.type === 'unavailable'),
    '无 updater 服务时 dismiss 优雅降级回 unavailable（不抛错）',
  );

  await kernel.stop();
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-updater-ui-verify-'));
  console.log('更新提示面板插件验证（真实内核）');
  console.log(`临时目录: ${tmpRoot}`);

  try {
    await scenarioWithUpdater(path.join(tmpRoot, 's1'));
    await scenarioWithoutUpdater(path.join(tmpRoot, 's2'));
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
