/**
 * 设置中心插件（org.issheepbox.settings · 面板形态）。
 *
 * 四块功能：
 *  1) registry 源自定义：userData/config.json 的 registryUrl 读写（默认官方地址、可改、可重置）。
 *  2) 默认壳切换：发 settings:request-set-shell 事件，宿主据此改 profile.shell（本插件不直接写 profile）。
 *  3) 插件启停管理 UI：读 profile.enabled（经磁盘读 profile JSON），发 enable/disable/uninstall 命令事件。
 *  4) 关于与诊断页：ctx.apiVersion（内核 ctx API 版本）、当前壳、已装插件清单。
 *
 * 权限：files:read + files:write（读写 config.json 与 profile JSON）。未授权 fail-safe 不注册面板。
 *
 * 边界：本插件是「意图发声」层——启停/壳切换只 emit 事件，由宿主（desktop）执行
 * profile.enable/disable/set-shell；本插件不自行删目录、不直接改 profile。
 *
 * ctx 只用 v1 已交付接口：manifest / apiVersion / logger / events / services / effects / files。
 */
import type { PluginContext } from '@issheepbox/kernel';

const PANEL_ID = 'settings-main';
const FILES_READ = 'files:read';
const FILES_WRITE = 'files:write';

/** 官方 registry 默认地址（与 market-client DEFAULT_REGISTRY_URL 对齐）。 */
const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/PastSheep/issheepbox-registry/main/plugins.json';
const CONFIG_FILE = 'config.json';

interface ApprovalPolicyShape {
  checkPermission(pluginId: string, permission: string): boolean;
}
interface HostUserDataShape {
  dir: string;
}
interface ShellUiShape {
  registerPanel(
    panelId: string,
    title: string,
    options?: { pluginId?: string; src?: string; html?: string; interactive?: boolean; width?: number; height?: number },
  ): () => void;
}

interface ConfigFile {
  registryUrl?: string;
  [key: string]: unknown;
}

interface ProfileFile {
  name: string;
  shell: string;
  enabled: string[];
}

export default function main(ctx: PluginContext): void {
  if (!hasFilesPermission(ctx)) {
    ctx.logger.error(
      `settings 未获 "${FILES_READ}"/"${FILES_WRITE}" 授权（或 approval-policy 不可用），fail-safe 不注册`,
    );
    return;
  }

  const baseDir = resolveUserDataDir(ctx);
  if (!baseDir) {
    ctx.logger.warn('host:user-data 不可用，settings 降级为只读内存态');
  }

  // ---- config.json 读写 ----
  function readConfig(): ConfigFile {
    if (!baseDir) return {};
    try {
      const raw = ctx.files.readFile(baseDir + '/' + CONFIG_FILE);
      if (!raw || raw.trim() === '') return {};
      const parsed = JSON.parse(raw) as ConfigFile;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  function writeConfig(cfg: ConfigFile): void {
    if (!baseDir) return;
    ctx.files.writeFile(baseDir + '/' + CONFIG_FILE, JSON.stringify(cfg, null, 2));
  }
  function getRegistryUrl(): string {
    const cfg = readConfig();
    return typeof cfg.registryUrl === 'string' && cfg.registryUrl ? cfg.registryUrl : DEFAULT_REGISTRY_URL;
  }
  function setRegistryUrl(url: string): void {
    const cfg = readConfig();
    cfg.registryUrl = url;
    writeConfig(cfg);
  }
  function resetRegistryUrl(): void {
    const cfg = readConfig();
    delete cfg.registryUrl;
    writeConfig(cfg);
  }

  // ---- profile 读取（经磁盘，只读）----
  function readProfile(): ProfileFile | null {
    if (!baseDir) return null;
    try {
      const cur = JSON.parse(ctx.files.readFile(baseDir + '/profiles/current.json')) as { name?: string };
      if (!cur || typeof cur.name !== 'string') return null;
      const p = JSON.parse(ctx.files.readFile(baseDir + `/profiles/${cur.name}.json`)) as ProfileFile;
      return p && typeof p.shell === 'string' && Array.isArray(p.enabled) ? p : null;
    } catch {
      return null;
    }
  }

  function getDiagnostics() {
    const p = readProfile();
    return {
      apiVersion: ctx.apiVersion,
      pluginId: ctx.manifest.id,
      pluginVersion: ctx.manifest.version,
      registryUrl: getRegistryUrl(),
      defaultRegistryUrl: DEFAULT_REGISTRY_URL,
      currentShell: p?.shell ?? '',
      enabled: p?.enabled ?? [],
    };
  }

  // ---- 注册面板 ----
  if (!ctx.services.has('shell:ui')) {
    ctx.logger.warn('shell:ui 不可用，跳过设置面板注册');
    return;
  }
  const ui = ctx.services.get<ShellUiShape>('shell:ui');
  ctx.effects.add(
    ui.registerPanel(PANEL_ID, '设置中心', {
      pluginId: ctx.manifest.id,
      src: 'assets/panel.html',
      interactive: true,
      width: 600,
      height: 480,
    }),
  );
  ctx.logger.info('settings 面板已注册');

  // ---- 面板消息桥 ----
  ctx.events.on('panel:inbound', (...args: unknown[]) => {
    const msg = args[0] as { pluginId?: string; panelId?: string; data?: Record<string, unknown> };
    if (!msg || msg.panelId !== PANEL_ID) return;
    const data = (msg.data ?? {}) as { type?: string; url?: string; pluginId?: string; shellId?: string };

    const reply = (payload: unknown) => {
      ctx.events.emit('panel:outbound', {
        pluginId: ctx.manifest.id,
        panelId: PANEL_ID,
        data: payload,
      });
    };

    switch (data.type) {
      case 'get-all':
        reply({ type: 'state', diagnostics: getDiagnostics() });
        break;
      case 'set-registryUrl':
        if (typeof data.url === 'string' && data.url.trim()) {
          setRegistryUrl(data.url.trim());
        }
        reply({ type: 'state', diagnostics: getDiagnostics() });
        break;
      case 'reset-registryUrl':
        resetRegistryUrl();
        reply({ type: 'state', diagnostics: getDiagnostics() });
        break;
      case 'request-enable':
        if (typeof data.pluginId === 'string') {
          ctx.events.emit('settings:request-enable', { pluginId: data.pluginId });
        }
        reply({ type: 'accepted', action: 'enable', pluginId: data.pluginId });
        break;
      case 'request-disable':
        if (typeof data.pluginId === 'string') {
          ctx.events.emit('settings:request-disable', { pluginId: data.pluginId });
        }
        reply({ type: 'accepted', action: 'disable', pluginId: data.pluginId });
        break;
      case 'request-uninstall':
        if (typeof data.pluginId === 'string') {
          ctx.events.emit('settings:request-uninstall', { pluginId: data.pluginId });
        }
        reply({ type: 'accepted', action: 'uninstall', pluginId: data.pluginId });
        break;
      case 'request-set-shell':
        if (typeof data.shellId === 'string') {
          ctx.events.emit('settings:request-set-shell', { shellId: data.shellId });
        }
        reply({ type: 'accepted', action: 'set-shell', shellId: data.shellId });
        break;
    }
  });
}

function hasFilesPermission(ctx: PluginContext): boolean {
  if (!ctx.services.has('approval-policy')) return false;
  const policy = ctx.services.get<ApprovalPolicyShape>('approval-policy');
  return (
    policy.checkPermission(ctx.manifest.id, FILES_READ) &&
    policy.checkPermission(ctx.manifest.id, FILES_WRITE)
  );
}

function resolveUserDataDir(ctx: PluginContext): string | null {
  if (!ctx.services.has('host:user-data')) return null;
  const host = ctx.services.get<HostUserDataShape>('host:user-data');
  if (!host || typeof host.dir !== 'string' || host.dir.trim() === '') return null;
  return host.dir.replace(/[\\/]+$/, '');
}
