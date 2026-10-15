/**
 * 授权目录选择面板插件（com.pastsheep.files-picker）端到端验证。
 *
 * 前置：
 *   pnpm --filter @issheepbox/kernel --filter @issheepbox/approval-policy build
 *   pnpm --filter @issheepbox/plugin-files-service --filter @issheepbox/shell-default build
 *   pnpm --filter @issheepbox/plugin-files-picker build
 *
 * 运行：
 *   node packages/plugins/verify-files-picker.cjs
 *
 * 覆盖：
 *   A1  挂载后 shell:ui 已注册交互式面板（files-picker-main）
 *   A2  先经真实 files 服务 authorizeDir 预置 2 个目录 → 挂载推送的 panel:outbound
 *       dirs 列表与真实白名单完全一致（证明读服务真实状态，不是写死）
 *   A3  挂载后再 authorizeDir 第 3 个目录 + 发 refresh → 面板收到最新 3 个目录
 *   A4  安全：所有 panel:outbound 消息里都不出现白名单之外的路径（未授权路径不泄漏）
 *   A5  模拟面板 panel:inbound pick-directory → 内核发出 host:pick-directory 事件，
 *       且面板随即收到 supported:false 的降级回应，全程无异常
 *   A6  unmount 后面板注销无残留
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
const PICKER_ID = 'com.pastsheep.files-picker';
const PANEL_ID = 'files-picker-main';

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

function makeApprovalPolicy() {
  const store = new MemoryApprovalStore();
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

async function scenarioPicker(pluginsDir, root) {
  console.log('\n[S1] 面板注册 / 真实白名单推送 / 刷新 / pick-directory 降级 / 卸载无残留');

  // 三个目录：A、B 预置授权，C 挂载后再授权；SECRET 在白名单外（安全断言用）
  const dirA = path.join(root, 'workspace-a');
  const dirB = path.join(root, 'workspace-b');
  const dirC = path.join(root, 'workspace-c');
  const secretDir = path.join(root, 'secret-outside');
  for (const d of [dirA, dirB, dirC, secretDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const absA = path.resolve(dirA);
  const absB = path.resolve(dirB);
  const absC = path.resolve(dirC);
  const absSecret = path.resolve(secretDir);

  const hostDir = path.join(root, 'host-user-data');
  fs.mkdirSync(hostDir, { recursive: true });

  const kernel = new IsSheepBoxKernel();
  await kernel.start(path.join(root, 'ud'), pluginsDir);
  const out = await kernel.lifecycle.mount(makeApprovalPolicy());
  ok(out.ok === true, 'approval-policy 已挂载');
  kernel.services.register('host:user-data', { dir: hostDir });

  // 先挂 files-service
  await kernel.profile.enable(FILES_SERVICE_ID);
  ok(kernel.lifecycle.mountedIds.includes(FILES_SERVICE_ID), 'files-service 已挂载');
  const files = kernel.services.get('files');
  ok(files && typeof files.listAuthorizedDirs === 'function', 'files 服务已注册');

  // 预置 2 个已授权目录（在 files-picker 挂载前）
  files.authorizeDir(dirA);
  files.authorizeDir(dirB);
  ok(
    files.listAuthorizedDirs().length === 2,
    `预置白名单含 2 个目录（实际 ${files.listAuthorizedDirs().length}）`,
  );

  // 提前挂捕获：panel:outbound（只收本面板）+ host:pick-directory
  const outbound = [];
  kernel.events.on('panel:outbound', (msg) => {
    if (msg && msg.panelId === PANEL_ID) outbound.push(msg.data);
  });
  const pickEvents = [];
  kernel.events.on('host:pick-directory', (payload) => {
    pickEvents.push(payload);
  });

  // 挂载 files-picker → 应注册面板并推送一次真实白名单
  await kernel.profile.enable(PICKER_ID);
  ok(kernel.lifecycle.mountedIds.includes(PICKER_ID), 'files-picker 已挂载');

  // A1 面板已注册（交互式）
  const ui = kernel.services.get('shell:ui');
  ok(
    ui.panels.some((p) => p.id === PANEL_ID && p.interactive === true),
    'files-picker 已注册交互式面板',
  );

  await new Promise((r) => setTimeout(r, 20));

  // A2 挂载推送的 dirs 与真实白名单完全一致
  const dirsMsgs = outbound.filter((d) => d.type === 'dirs');
  ok(dirsMsgs.length >= 1, `panel:outbound 收到 dirs 快照（${dirsMsgs.length} 条）`);
  const mountedDirs = dirsMsgs[dirsMsgs.length - 1].dirs.slice().sort();
  const expectedSeeded = [absA, absB].slice().sort();
  ok(
    JSON.stringify(mountedDirs) === JSON.stringify(expectedSeeded),
    '挂载推送的 dirs 与真实白名单完全一致（读服务真实状态，非写死）',
  );

  // A3 挂载后再授权 C + 发 refresh → 面板收到最新 3 个目录
  files.authorizeDir(dirC);
  kernel.events.emit('panel:inbound', {
    pluginId: PICKER_ID,
    panelId: PANEL_ID,
    data: { type: 'refresh' },
  });
  await new Promise((r) => setTimeout(r, 20));

  const refreshed = outbound.filter((d) => d.type === 'dirs');
  const latestDirs = refreshed[refreshed.length - 1].dirs.slice().sort();
  const expectedAll = [absA, absB, absC].slice().sort();
  ok(
    JSON.stringify(latestDirs) === JSON.stringify(expectedAll),
    'refresh 后面板收到含第 3 个目录的最新白名单',
  );

  // A4 安全：所有 panel:outbound 消息里都不出现白名单之外的路径
  const whitelistSet = new Set(files.listAuthorizedDirs());
  let leaked = false;
  for (const data of outbound) {
    const serialized = JSON.stringify(data);
    // 白名单外目录的绝对路径串不得出现在任何出站消息里
    if (serialized.includes(absSecret)) {
      leaked = true;
    }
    // dirs 数组里的每一项都必须落在真实白名单集合内
    if (Array.isArray(data.dirs)) {
      for (const d of data.dirs) {
        if (!whitelistSet.has(d)) leaked = true;
      }
    }
  }
  ok(!leaked, '安全：panel:outbound 任何消息均不泄漏白名单之外的路径');

  // A5 模拟面板 pick-directory → host:pick-directory 事件 + supported:false 降级
  kernel.events.emit('panel:inbound', {
    pluginId: PICKER_ID,
    panelId: PANEL_ID,
    data: { type: 'pick-directory' },
  });
  await new Promise((r) => setTimeout(r, 20));

  ok(pickEvents.length >= 1, 'panel:inbound pick-directory 触发了 host:pick-directory 事件');
  ok(
    pickEvents[pickEvents.length - 1].pluginId === PICKER_ID,
    'host:pick-directory payload 携带本插件 pluginId',
  );
  const pickResults = outbound.filter((d) => d.type === 'pick-result');
  ok(pickResults.length >= 1, '面板收到 pick-result 降级回应');
  ok(
    pickResults[pickResults.length - 1].supported === false &&
      typeof pickResults[pickResults.length - 1].message === 'string',
    'pick-result 为 supported:false 且带降级文案（不抛错、不悬挂）',
  );

  // A6 unmount 后面板注销无残留
  await kernel.profile.disable(PICKER_ID);
  ok(!kernel.lifecycle.mountedIds.includes(PICKER_ID), 'files-picker 已卸载');
  ok(
    !ui.panels.some((p) => p.id === PANEL_ID),
    '卸载后面板记录随 effect scope 回滚（不残留）',
  );

  await kernel.stop();
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-files-picker-verify-'));
  const pluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  console.log('授权目录选择面板插件验证（真实内核）');
  console.log(`临时目录: ${tmpRoot}`);

  // 拷贝 files-service + files-picker + shell-default
  for (const name of ['files-service', 'files-picker']) {
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
  ok(fs.existsSync(pluginsDir), '临时 pluginsDir 就绪（files-service + files-picker + shell-default）');

  try {
    await scenarioPicker(pluginsDir, path.join(tmpRoot, 's1'));
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
