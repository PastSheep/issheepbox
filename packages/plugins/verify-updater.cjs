/**
 * 应用更新检查插件（org.issheepbox.updater）端到端验证。
 *
 * 前置：
 *   pnpm --filter @issheepbox/kernel --filter @issheepbox/approval-policy build
 *   pnpm --filter @issheepbox/plugin-updater build
 *
 * 运行：
 *   node packages/plugins/verify-updater.cjs
 *
 * 覆盖：
 *   S1  semver 比对（新版/同版/旧版）+ update-available 事件广播
 *   S2  dismiss 后同版本不再提示
 *   S3  断网/请求失败静默降级（不抛错，error 字段填充）
 *   S4  状态持久化（lastCheckAt）+ 卸载服务注销
 *   S5  宿主注入 host:net：checkForUpdate 缺省走 host:net.fetch（不碰全局 fetch）
 *   S6  未注册 host:net：checkForUpdate 缺省回退全局 fetch（stub 全局）
 */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IsSheepBoxKernel } = require('../kernel/dist/index.js');
const { createApprovalPolicyPlugin } = require('../approval-policy/dist/index.js');

const UPDATER_ID = 'org.issheepbox.updater';

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}

class GrantAllPrompter {
  async prompt() { return { kind: 'grant-all' }; }
}

/** 构造一个返回固定 GitHub Releases 响应的 mock fetch。 */
function mockFetch(tagName, htmlUrl) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: tagName, html_url: htmlUrl }),
  });
}
/** 构造一个抛错的 mock fetch（模拟断网）。 */
function failingFetch() {
  return async () => { throw new Error('network down'); };
}
/** 构造一个返回 HTTP 500 的 mock fetch。 */
function serverErrorFetch() {
  return async () => ({ ok: false, status: 500, json: async () => ({}) });
}

function makeApprovalPolicy() {
  const factory = createApprovalPolicyPlugin({ prompter: new GrantAllPrompter() });
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

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isb-updater-verify-'));
  const pluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const hostDir = path.join(tmpRoot, 'host-user-data');
  fs.mkdirSync(hostDir, { recursive: true });

  console.log('应用更新检查插件验证（真实内核）');
  console.log(`临时目录: ${tmpRoot}`);

  const src = path.join(__dirname, 'updater');
  if (!fs.existsSync(path.join(src, 'dist', 'index.js'))) {
    throw new Error('缺少构建产物：packages/plugins/updater/dist。请先 pnpm --filter @issheepbox/plugin-updater build。');
  }
  copyPluginPackage(src, pluginsDir);
  ok(fs.existsSync(pluginsDir), '临时 pluginsDir 就绪');

  try {
    const kernel = new IsSheepBoxKernel();
    await kernel.start(path.join(tmpRoot, 'ud'), pluginsDir);
    const out = await kernel.lifecycle.mount(makeApprovalPolicy());
    ok(out.ok === true, 'approval-policy 已挂载');
    kernel.services.register('host:user-data', { dir: hostDir });

    await kernel.profile.enable(UPDATER_ID);
    ok(kernel.lifecycle.mountedIds.includes(UPDATER_ID), 'updater 已挂载');

    const updater = kernel.services.get('updater');
    ok(updater && typeof updater.checkForUpdate === 'function', 'updater 服务已注册');

    // —— S1：semver 比对 ——
    const events = [];
    kernel.events.on('updater:update-available', (p) => events.push(p));

    // 新版：0.2.2 → 0.3.0
    let r = await updater.checkForUpdate('0.2.2', { fetchImpl: mockFetch('v0.3.0', 'https://github.com/x/releases/tag/v0.3.0') });
    ok(r.updateAvailable === true, 'semver：0.3.0 > 0.2.2 → updateAvailable=true');
    ok(r.latestVersion === '0.3.0', 'latestVersion 正确解析（去 v 前缀）');
    ok(events.length === 1 && events[0].latestVersion === '0.3.0', 'updater:update-available 事件广播');

    // 同版：0.3.0 → 0.3.0
    events.length = 0;
    r = await updater.checkForUpdate('0.3.0', { fetchImpl: mockFetch('v0.3.0', 'https://x') });
    ok(r.updateAvailable === false, 'semver：0.3.0 === 0.3.0 → updateAvailable=false');
    ok(events.length === 0, '同版不广播事件');

    // 旧版：当前 0.4.0，远端 0.3.0
    r = await updater.checkForUpdate('0.4.0', { fetchImpl: mockFetch('v0.3.0', 'https://x') });
    ok(r.updateAvailable === false, 'semver：远端 0.3.0 < 当前 0.4.0 → 不提示');

    // —— S2：dismiss 后同版本不再提示 ——
    updater.dismiss('0.3.0');
    ok(updater.getState().ignoredVersion === '0.3.0', 'dismiss 后 ignoredVersion 记录正确');
    events.length = 0;
    r = await updater.checkForUpdate('0.2.2', { fetchImpl: mockFetch('v0.3.0', 'https://x') });
    ok(r.updateAvailable === false, 'dismiss(0.3.0) 后同版本不再提示');
    ok(events.length === 0, '被忽略版本不重复广播');

    // 忽略 0.3.0 后，远端出 0.4.0 仍提示
    r = await updater.checkForUpdate('0.2.2', { fetchImpl: mockFetch('v0.4.0', 'https://x') });
    ok(r.updateAvailable === true, '忽略旧版后，新版 0.4.0 仍提示');

    // —— S3：断网/请求失败静默降级 ——
    r = await updater.checkForUpdate('0.2.2', { fetchImpl: failingFetch() });
    ok(r.updateAvailable === false, '断网时 updateAvailable=false');
    ok(typeof r.error === 'string' && r.error.length > 0, '断网时 error 字段填充（不抛错）');

    r = await updater.checkForUpdate('0.2.2', { fetchImpl: serverErrorFetch() });
    ok(r.updateAvailable === false, 'HTTP 500 时 updateAvailable=false');
    ok(/500/.test(r.error), 'HTTP 500 时 error 含状态码');

    // —— S5：宿主注入 host:net，checkForUpdate 缺省走 host:net.fetch ——
    const netCalls = [];
    kernel.services.register('host:net', {
      fetch: async (url) => {
        netCalls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ tag_name: 'v0.5.0', html_url: 'https://github.com/x/releases/tag/v0.5.0' }),
        };
      },
    });
    // 全局 fetch 换成会抛错的，证明插件没走它
    const origGlobal = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('不应调用全局 fetch'); };
    let r5;
    try {
      r5 = await updater.checkForUpdate('0.2.2');
    } finally {
      globalThis.fetch = origGlobal;
    }
    ok(netCalls.length === 1, `host:net.fetch 被调用 1 次（实际 ${netCalls.length}）`);
    ok(typeof netCalls[0] === 'string' && /api\.github\.com/.test(netCalls[0]),
      'host:net.fetch 收到 GitHub API URL');
    ok(r5.updateAvailable === true && r5.latestVersion === '0.5.0',
      '经 host:net 完成更新检查（0.5.0 > 0.2.2）');

    // —— S4：状态持久化 + 卸载 ——
    ok(updater.getState().lastCheckAt !== null, 'getState().lastCheckAt 已记录');
    const stateFile = path.join(hostDir, 'issheepbox-updater-state.json');
    ok(fs.existsSync(stateFile), '状态已落盘（updater-state.json）');

    await kernel.profile.disable(UPDATER_ID);
    ok(!kernel.services.has('updater'), '卸载后 updater 服务已注销（可逆 effects）');

    await kernel.stop();

    // —— S6：未注册 host:net 时，checkForUpdate 缺省回退全局 fetch ——
    console.log('\n[S6] 未注册 host:net：缺省回退全局 fetch（stub 全局 fetch，不崩）');
    const kernel2 = new IsSheepBoxKernel();
    await kernel2.start(path.join(tmpRoot, 'ud-fallback'), pluginsDir);
    await kernel2.lifecycle.mount(makeApprovalPolicy());
    kernel2.services.register('host:user-data', { dir: hostDir });

    // stub 全局 fetch 返回固定 GitHub Releases 响应
    const globalCalls = [];
    const origGlobal2 = globalThis.fetch;
    globalThis.fetch = async (url) => {
      globalCalls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v0.6.0', html_url: 'https://github.com/x/releases/tag/v0.6.0' }),
      };
    };

    try {
      await kernel2.profile.enable(UPDATER_ID);
      const updater2 = kernel2.services.get('updater');
      ok(updater2 && typeof updater2.checkForUpdate === 'function', 'fallback 场景 updater 服务已注册');
      const r6 = await updater2.checkForUpdate('0.2.2');
      ok(globalCalls.length === 1, `全局 fetch 被调用 1 次（实际 ${globalCalls.length}）`);
      ok(r6.updateAvailable === true && r6.latestVersion === '0.6.0',
        '经全局 fetch 完成更新检查（回退路径不崩）');
    } finally {
      globalThis.fetch = origGlobal2;
    }
    await kernel2.stop();

    console.log(`\n全部通过：${checks} 项断言（6 组）`);
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
