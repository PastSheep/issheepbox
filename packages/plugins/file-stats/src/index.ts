/**
 * 文件文本统计示例插件（TASK-009 · 带权限形态）。
 *
 * 演示要点：
 *  - 权限声明：manifest.permissions = ["files:read"]，启用前须经 approval-policy 授权
 *    （规范 §7.1 权限工作流；授权由宿主/启用流程经 `approval-policy` 服务完成，
 *    见 verify-examples.cjs 的 enableWithApproval 门禁）。
 *  - 运行时权限自检：挂载时经 `ctx.services.get('approval-policy').checkPermission()`
 *    二次确认；未授权（或 approval-policy 不可用）则 fail-safe 拒绝注册任何能力。
 *  - 沙箱边界：插件不直接使用 node:fs（规范 §9.1「不允许打包 Node 内置模块」）；
 *    宿主/调用方经服务传入文本内容，本插件做纯文本统计。
 *  - 可逆 effects：服务注册在卸载时由内核自动注销（规范 §5.2）。
 *
 * ctx 只使用 v1 已交付接口（manifest / apiVersion / logger / events / services）。
 */
import type { PluginContext } from '@issheepbox/kernel';

/** 本插件声明并依赖的权限（与 manifest.permissions[0] 一致）。 */
const FILES_READ = 'files:read';

/** approval-policy 提供的授权判定服务形状（见 packages/approval-policy）。 */
interface ApprovalPolicyShape {
  checkPermission(pluginId: string, permission: string): boolean;
}

/** 文本统计结果。 */
export interface TextStats {
  /** 行数（按 \n 计，\r\n 已归一化）。 */
  lines: number;
  /** 词数（空白分隔的非空 token 数）。 */
  words: number;
  /** 字符数（按 Unicode 码点计）。 */
  chars: number;
  /** 字节数（UTF-8 编码长度）。 */
  bytes: number;
}

/** file-stats 服务形状（宿主/其他插件经 ctx.services.get('file-stats') 消费）。 */
export interface FileStatsService {
  statsOfText(text: string): TextStats;
}

export default function main(ctx: PluginContext): void {
  if (!hasFilesReadPermission(ctx)) {
    ctx.logger.error(
      `插件未获 "${FILES_READ}" 授权（或 approval-policy 服务不可用），` +
        '按 fail-safe 拒绝提供服务',
    );
    return;
  }

  ctx.services.register('file-stats', createStatsService());
  ctx.logger.info(`file-stats 服务已注册（${FILES_READ} 已授权）`);
}

/** 运行时权限自检：授权记录 + approval-policy 服务都就绪才放行。 */
function hasFilesReadPermission(ctx: PluginContext): boolean {
  if (!ctx.services.has('approval-policy')) {
    ctx.logger.warn('approval-policy 服务不可用，无法校验权限');
    return false;
  }
  const policy = ctx.services.get<ApprovalPolicyShape>('approval-policy');
  return policy.checkPermission(ctx.manifest.id, FILES_READ);
}

function createStatsService(): FileStatsService {
  return {
    statsOfText(text: string): TextStats {
      const normalized = text.replace(/\r\n/g, '\n');
      const lines = normalized === '' ? 0 : normalized.split('\n').length;
      const words = normalized.split(/\s+/).filter((w) => w.length > 0).length;
      const chars = [...normalized].length;
      // 纯 Web API 字节计数（沙箱兼容，不依赖 Node Buffer）
      const bytes = new TextEncoder().encode(normalized).length;
      return { lines, words, chars, bytes };
    },
  };
}
