/**
 * 日志查看面板插件（org.issheepbox.log-viewer · UI 面板形态）。
 *
 * 职责：
 *  - 消费 logging 服务：订阅 log:entry 实时滚动 + query 历史筛选（级别/插件/时间）。
 *  - error/warn 高亮由面板 HTML/CSS 负责；本插件只做主进程侧数据桥。
 *  - 未授权（logs:read）时 fail-safe：注册一个静态提示面板，不转发任何日志数据。
 *
 * 面板桥（同 echo-panel）：
 *  - 主进程 → 面板：ctx.events.emit('panel:outbound', { pluginId, panelId, data })
 *  - 面板 → 主进程：ctx.events.on('panel:inbound', (msg) => ...) 认领自己的 panelId
 *
 * 软依赖 logging 服务：logger 插件未启用时面板显示「日志服务未就绪」，不崩。
 *
 * ctx 只用 v1 已交付接口：manifest / apiVersion / logger / events / services / effects。
 */
import type { PluginContext } from '@issheepbox/kernel';

const PANEL_ID = 'log-viewer-main';
const LOGS_READ = 'logs:read';

/** logging 服务形状（跨插件消费，结构类型对齐 logger 插件）。 */
interface LogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  meta?: unknown;
}
interface LogFilter {
  minLevel?: LogEntry['level'];
  scope?: string;
  since?: number;
  limit?: number;
}
interface LoggingService {
  write(level: LogEntry['level'], scope: string, message: string, meta?: unknown): void;
  query(callerPluginId: string, filter?: LogFilter): LogEntry[];
}

interface ApprovalPolicyShape {
  checkPermission(pluginId: string, permission: string): boolean;
}

interface ShellUiShape {
  registerPanel(
    panelId: string,
    title: string,
    options?: { pluginId?: string; src?: string; html?: string; interactive?: boolean; width?: number; height?: number },
  ): () => void;
}

export default function main(ctx: PluginContext): void {
  const authorized = hasLogsRead(ctx);

  if (!authorized) {
    // fail-safe：注册静态提示面板，不接入任何日志数据流。
    registerStaticPanel(ctx, 'logs:read 未授权', '本面板需要 logs:read 权限才能查看日志。请在设置中授权后重试。');
    ctx.logger.warn('log-viewer 未获 logs:read 授权，已注册不可用提示面板（不泄漏日志）');
    return;
  }

  const shellUi = ctx.services.has('shell:ui')
    ? ctx.services.get<ShellUiShape>('shell:ui')
    : undefined;
  if (!shellUi) {
    ctx.logger.warn('shell:ui 服务不可用，跳过面板注册');
    return;
  }

  const unregister = shellUi.registerPanel(PANEL_ID, '日志查看', {
    pluginId: ctx.manifest.id,
    src: 'assets/panel.html',
    interactive: true,
    width: 560,
    height: 420,
  });
  ctx.effects.add(unregister);
  ctx.logger.info('log-viewer 面板已注册（logs:read 已授权）');

  // —— 主进程 → 面板：实时转发 log:entry ——
  ctx.events.on('log:entry', (entry: unknown) => {
    ctx.events.emit('panel:outbound', {
      pluginId: ctx.manifest.id,
      panelId: PANEL_ID,
      data: { type: 'entry', entry: entry as LogEntry },
    });
  });

  // —— 面板 → 主进程：面板请求历史查询（filter）或初始快照 ——
  ctx.events.on('panel:inbound', (...args: unknown[]) => {
    const msg = args[0] as { pluginId?: string; panelId?: string; data?: { type?: string; filter?: LogFilter } };
    if (!msg || msg.panelId !== PANEL_ID) return;
    const data = msg.data ?? {};

    if (!ctx.services.has('logging')) {
      ctx.events.emit('panel:outbound', {
        pluginId: ctx.manifest.id,
        panelId: PANEL_ID,
        data: { type: 'history', entries: [], error: '日志服务未就绪（logger 插件未启用）' },
      });
      return;
    }

    if (data.type === 'filter' || data.type === 'history') {
      const logging = ctx.services.get<LoggingService>('logging');
      let entries: LogEntry[] = [];
      try {
        entries = logging.query(ctx.manifest.id, data.filter);
      } catch (err) {
        ctx.events.emit('panel:outbound', {
          pluginId: ctx.manifest.id,
          panelId: PANEL_ID,
          data: { type: 'history', entries: [], error: (err as Error).message },
        });
        return;
      }
      ctx.events.emit('panel:outbound', {
        pluginId: ctx.manifest.id,
        panelId: PANEL_ID,
        data: { type: 'history', entries },
      });
    }
  });
}

/** 挂载自检：logs:read 已授权才放行实时数据流。 */
function hasLogsRead(ctx: PluginContext): boolean {
  if (!ctx.services.has('approval-policy')) return false;
  const policy = ctx.services.get<ApprovalPolicyShape>('approval-policy');
  return policy.checkPermission(ctx.manifest.id, LOGS_READ);
}

/** 未授权时注册静态提示面板（html 内联，非 interactive，不接数据流）。 */
function registerStaticPanel(ctx: PluginContext, title: string, body: string): void {
  if (!ctx.services.has('shell:ui')) return;
  const ui = ctx.services.get<ShellUiShape>('shell:ui');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{font-family:system-ui,'Microsoft YaHei',sans-serif;padding:20px;color:#888;font-size:13px}
    .box{background:#fff3e0;border:1px solid #ffcc80;border-radius:6px;padding:12px 14px}
  </style><body><div class="box"><b>${title}</b><br/>${body}</div></body>`;
  ctx.effects.add(
    ui.registerPanel(PANEL_ID, '日志查看', {
      pluginId: ctx.manifest.id,
      html,
      width: 420,
      height: 200,
    }),
  );
}
