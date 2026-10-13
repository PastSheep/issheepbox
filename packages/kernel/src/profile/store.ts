/**
 * Profile 磁盘持久化。
 *
 * 目录布局（用户数据目录下）：
 *   <userData>/
 *     profiles/
 *       current.json        # { "name": "default" }
 *       <name>.json         # 每个 profile 一个文件
 *     snapshots/
 *       <timestamp>-<name>.json
 *
 * 所有读写都用同步 API（Node/Electron 主进程内，启动期阻塞可接受）。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import type { Profile, ProfileSnapshot } from './types';

export class ProfileStore {
  private readonly profilesDir: string;
  private readonly snapshotsDir: string;

  constructor(userDataDir: string) {
    this.profilesDir = path.join(userDataDir, 'profiles');
    this.snapshotsDir = path.join(userDataDir, 'snapshots');
    mkdirSync(this.profilesDir, { recursive: true });
    mkdirSync(this.snapshotsDir, { recursive: true });
  }

  /** 读取当前 profile 名称指针。 */
  readCurrentName(): string | null {
    const p = path.join(this.profilesDir, 'current.json');
    if (!existsSync(p)) return null;
    try {
      const data = JSON.parse(readFileSync(p, 'utf8')) as { name?: string };
      return typeof data.name === 'string' ? data.name : null;
    } catch {
      return null;
    }
  }

  /** 写入当前 profile 名称指针。 */
  writeCurrentName(name: string): void {
    writeFileSync(
      path.join(this.profilesDir, 'current.json'),
      JSON.stringify({ name }, null, 2),
      'utf8',
    );
  }

  /** 列出所有 profile 名称。 */
  listProfileNames(): string[] {
    return readdirSync(this.profilesDir)
      .filter((f) => f.endsWith('.json') && f !== 'current.json')
      .map((f) => f.replace(/\.json$/, ''));
  }

  /** 读取指定 profile。 */
  readProfile(name: string): Profile | null {
    const p = path.join(this.profilesDir, `${name}.json`);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as Profile;
    } catch {
      return null;
    }
  }

  /** 写入 profile。 */
  writeProfile(profile: Profile): void {
    writeFileSync(
      path.join(this.profilesDir, `${profile.name}.json`),
      JSON.stringify(profile, null, 2),
      'utf8',
    );
  }

  /** 删除 profile。 */
  deleteProfile(name: string): void {
    const p = path.join(this.profilesDir, `${name}.json`);
    if (existsSync(p)) {
      rmSync(p);
    }
  }

  /** 写入快照。 */
  writeSnapshot(snapshot: ProfileSnapshot): void {
    writeFileSync(
      path.join(this.snapshotsDir, `${snapshot.id}.json`),
      JSON.stringify(snapshot, null, 2),
      'utf8',
    );
  }

  /** 列出所有快照 ID。 */
  listSnapshotIds(): string[] {
    return readdirSync(this.snapshotsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  /** 读取快照。 */
  readSnapshot(id: string): ProfileSnapshot | null {
    const p = path.join(this.snapshotsDir, `${id}.json`);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as ProfileSnapshot;
    } catch {
      return null;
    }
  }
}
