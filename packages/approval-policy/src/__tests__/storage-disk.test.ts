/**
 * DiskApprovalStore 磁盘持久化测试（TASK-015）。
 *
 * 覆盖验收标准：
 *  - 磁盘 roundtrip：同一文件两个实例先后读写一致（跨重启语义）
 *  - 原子写：set 后文件为合法 JSON、临时文件不残留、可覆盖既有文件
 *  - 容错：文件缺失 = 空；文件损坏/非法 JSON → 不抛错、视为空
 *  - 记录按 pluginId 排序写出，内容确定可复现
 */
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPROVALS_FILE_NAME, DiskApprovalStore } from '../storage-disk';
import type { ApprovalRecord } from '../storage';

let tmpRoot = '';

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'approval-store-test-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 新建一个独立子目录的 store（用例间隔离）。 */
function makeStore(label: string, logger?: { warn: (m: string) => void }) {
  const dir = path.join(tmpRoot, label);
  const store = new DiskApprovalStore({ dir, logger });
  return { dir, store, file: path.join(dir, APPROVALS_FILE_NAME) };
}

function grantedRecord(pluginId: string, permissions: string[]): ApprovalRecord {
  return {
    pluginId,
    status: 'granted',
    permissions,
    decidedAt: '2026-10-15T00:00:00.000Z',
  };
}

describe('DiskApprovalStore', () => {
  it('目录无 approvals.json → 空存储，不抛错', () => {
    const { store, file } = makeStore('empty');
    expect(existsSync(file)).toBe(false);
    expect(store.get('org.example.note')).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('set 后立即落盘：文件为合法 JSON，可被新实例读回（磁盘 roundtrip）', () => {
    const first = makeStore('roundtrip');
    first.store.set(grantedRecord('org.example.note', ['files:read']));

    // 新实例模拟「重启后」：构造时从同一文件加载。
    const second = new DiskApprovalStore({ dir: first.dir });
    const record = second.get('org.example.note');
    expect(record).not.toBeUndefined();
    expect(record?.status).toBe('granted');
    expect(record?.permissions).toEqual(['files:read']);
    expect(record?.decidedAt).toBe('2026-10-15T00:00:00.000Z');
  });

  it('delete 落盘后新实例不再持有该记录', () => {
    const { store, dir } = makeStore('delete');
    store.set(grantedRecord('org.example.a', []));
    store.set(grantedRecord('org.example.b', []));
    store.delete('org.example.a');

    const reloaded = new DiskApprovalStore({ dir });
    expect(reloaded.get('org.example.a')).toBeUndefined();
    expect(reloaded.get('org.example.b')?.pluginId).toBe('org.example.b');
  });

  it('原子写：set 后文件为合法 JSON 且无临时文件残留；重复 set 覆盖成功', () => {
    const { store, file, dir } = makeStore('atomic');
    store.set(grantedRecord('org.example.note', ['files:read']));
    store.set(grantedRecord('org.example.note', ['files:read', 'network:fetch']));

    // 文件可解析（无半写损坏）。
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ApprovalRecord[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].permissions).toEqual(['files:read', 'network:fetch']);

    // 同目录无 .approvals.*.tmp 残留。
    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('记录按 pluginId 排序写出，内容确定可复现', () => {
    const { store, file } = makeStore('sorted');
    store.set(grantedRecord('org.example.zeta', []));
    store.set(grantedRecord('org.example.alpha', []));
    store.set(grantedRecord('org.example.middle', []));

    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ApprovalRecord[];
    expect(parsed.map((r) => r.pluginId)).toEqual([
      'org.example.alpha',
      'org.example.middle',
      'org.example.zeta',
    ]);
  });

  it('损坏文件（非法 JSON）→ 构造不抛错，logger.warn，视为空存储', () => {
    const dir = path.join(tmpRoot, 'corrupt');
    const file = path.join(dir, APPROVALS_FILE_NAME);
    new DiskApprovalStore({ dir }); // 先建目录
    writeFileSync(file, '{{{ this is not json', 'utf8');

    const warns: string[] = [];
    const store = new DiskApprovalStore({
      dir,
      logger: { warn: (m: string) => warns.push(m) } as never,
    });
    expect(store.list()).toEqual([]);
    expect(store.get('org.example.note')).toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]).toContain('JSON');
  });

  it('文件顶层非数组 → 视为空存储并告警', () => {
    const dir = path.join(tmpRoot, 'wrong-shape');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, APPROVALS_FILE_NAME), '{"pluginId":1}', 'utf8');

    const warns: string[] = [];
    const store = new DiskApprovalStore({
      dir,
      logger: { warn: (m: string) => warns.push(m) } as never,
    });
    expect(store.list()).toEqual([]);
    expect(warns.length).toBeGreaterThan(0);
  });

  it('坏条目被跳过，合法条目正常加载', () => {
    const dir = path.join(tmpRoot, 'mixed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, APPROVALS_FILE_NAME),
      JSON.stringify([
        { pluginId: 'org.example.ok', status: 'granted', permissions: ['files:read'], decidedAt: '2026-01-01T00:00:00.000Z' },
        { pluginId: 42, status: 'granted' }, // pluginId 非法
        { pluginId: 'org.example.badstatus', status: 'weird' },
        'just a string',
      ]),
      'utf8',
    );

    const store = new DiskApprovalStore({ dir });
    expect(store.list()).toHaveLength(1);
    expect(store.get('org.example.ok')?.permissions).toEqual(['files:read']);
  });

  it('get/list 语义与 MemoryApprovalStore 一致：list 返回副本不暴露内部 Map', () => {
    const { store } = makeStore('semantics');
    store.set(grantedRecord('org.example.note', ['files:read']));
    const listed = store.list();
    listed.pop(); // 改返回值不应影响内部状态
    expect(store.list()).toHaveLength(1);
    expect(store.get('org.example.note')?.permissions).toEqual(['files:read']);
  });
});
