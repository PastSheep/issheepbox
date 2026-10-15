/**
 * 开发者小工具（com.pastsheep.devkit）。
 *
 * 演示可交互面板桥 + storage 软依赖的真实用法：
 *  - 面板（assets/panel.html，iframe）内本地完成 JSON/Base64/URL/时间戳计算；
 *  - 用户点「收藏」→ isbPanel.post({type:'history:push', ...}) → panel:inbound
 *    → 本插件把条目写进 org.issheepbox.storage（按命名空间隔离）→
 *    panel:outbound 回推最新历史；面板启动时发 history:load 拉回历史。
 *
 * 本插件不申请权限（纯 UI + 经 storage 服务间接落盘，storage 自己持有文件权限）。
 * storage 缺失时优雅降级：历史只存内存，不落盘。
 */
import type { PluginContext } from '@issheepbox/kernel';

const PANEL_ID = 'devkit-main';
const HISTORY_KEY = 'history';
const MAX_HISTORY = 50;

interface HistoryItem {
  kind: string;
  text: string;
  at: number;
}

interface StorageScoped {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}
interface StorageShape {
  namespace(pluginId: string): StorageScoped;
}

interface ShellUiShape {
  registerPanel(
    panelId: string,
    title: string,
    options?: Record<string, unknown>,
  ): () => void;
}

export default function main(ctx: PluginContext): void {
  const pluginId = ctx.manifest.id;
  ctx.logger.info('devkit 开发者小工具已挂载');

  // 软依赖 storage：存在则历史落盘，否则仅内存。
  const store: StorageScoped | null = (() => {
    if (!ctx.services.has('storage')) return null;
    try {
      return ctx.services.get<StorageShape>('storage').namespace(pluginId);
    } catch {
      return null;
    }
  })();

  let history: HistoryItem[] = loadHistory(store);

  function send(data: unknown): void {
    ctx.events.emit('panel:outbound', { pluginId, panelId: PANEL_ID, data });
  }

  function persist(): void {
    try {
      store?.set(HISTORY_KEY, history);
    } catch (e) {
      ctx.logger.warn(`devkit 历史落盘失败：${(e as Error).message}`);
    }
  }

  function replyHistory(): void {
    send({ type: 'history', items: history });
  }

  // 注册交互面板。
  if (ctx.services.has('shell:ui')) {
    const ui = ctx.services.get<ShellUiShape>('shell:ui');
    ctx.effects.add(
      ui.registerPanel(PANEL_ID, '开发者小工具', {
        pluginId,
        src: 'assets/panel.html',
        interactive: true,
        width: 680,
        height: 520,
      }),
    );
  } else {
    ctx.logger.warn('shell:ui 不可用，devkit 面板未注册');
  }

  // 面板 → 主进程：只认领自己的面板。
  ctx.events.on('panel:inbound', (...args: unknown[]) => {
    const msg = args[0] as {
      panelId?: string;
      data?: { type?: string; kind?: string; text?: string };
    };
    if (!msg || msg.panelId !== PANEL_ID) return;
    const d = msg.data ?? {};
    switch (d.type) {
      case 'history:load':
        replyHistory();
        break;
      case 'history:push': {
        if (typeof d.text === 'string' && d.text.length > 0) {
          history = [{ kind: d.kind ?? 'raw', text: d.text, at: Date.now() }, ...history]
            .slice(0, MAX_HISTORY);
          persist();
        }
        replyHistory();
        break;
      }
      case 'history:clear':
        history = [];
        persist();
        replyHistory();
        break;
      default:
        ctx.logger.warn(`devkit 未知面板消息类型: ${String(d.type)}`);
    }
  });
}

function loadHistory(store: StorageScoped | null): HistoryItem[] {
  if (!store) return [];
  try {
    const v = store.get(HISTORY_KEY);
    if (Array.isArray(v)) return v as HistoryItem[];
  } catch {
    /* 忽略损坏缓存 */
  }
  return [];
}
