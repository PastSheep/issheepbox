/**
 * 文件文本统计示例插件（TASK-009 · 带权限形态，P-009 改造）。
 *
 * 演示要点：
 *  - 权限声明：manifest.permissions = ["files:read"]，启用前须经 approval-policy 授权
 *    （规范 §7.1 权限工作流；授权由宿主/启用流程经 `approval-policy` 服务完成，
 *    见 verify-examples.cjs 的 enableWithApproval 门禁）。
 *  - 运行时授权有两道闸：
 *    ① 挂载自检（第一道，fail-fast）：挂载时经 `ctx.services.get('approval-policy')
 *       .checkPermission()` 确认；未授权（或 approval-policy 不可用）则不注册任何服务；
 *    ② 宿主能力门禁（第二道，权威）：本插件经 `ctx.files.readFile(path)` 读真实文件，
 *       内核在每次调用时按本插件 manifest.id 再做一次 checkPermission 门禁——
 *       即便插件绕过挂载自检被强制挂载，宿主能力仍会 fail-safe 拒绝读取。
 *  - 沙箱边界：插件不直接使用 node:fs（规范 §9.1「不允许打包 Node 内置模块」）；
 *    文件读取统一走宿主 `ctx.files` 能力（P-009 新增，闭环 F-008）。
 *  - 纯文本统计逻辑保留在插件内作纯函数（computeTextStats），无副作用、可单测。
 *  - 可逆 effects：服务注册在卸载时由内核自动注销（规范 §5.2）。
 *
 * ctx 使用 v1 已交付接口：manifest / apiVersion / logger / events / services /
 * files（P-009 新增）。
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
  /**
   * 统计指定文本文件。
   *
   * 经宿主 `ctx.files.readFile(path)` 读取真实文件（内核侧再做 files:read 门禁），
   * 再做纯文本统计；未授权/授权服务不可用时 readFile 直接抛错。
   */
  statsOfFile(path: string): TextStats;
}

export default function main(ctx: PluginContext): void {
  if (!hasFilesReadPermission(ctx)) {
    ctx.logger.error(
      `插件未获 "${FILES_READ}" 授权（或 approval-policy 服务不可用），` +
        '按 fail-safe 拒绝注册服务（挂载自检第一道闸）',
    );
    return;
  }

  ctx.services.register('file-stats', createStatsService(ctx));
  ctx.logger.info(`file-stats 服务已注册（${FILES_READ} 已授权；文件读取走宿主 ctx.files 能力）`);
}

/** 挂载自检（第一道闸）：授权记录 + approval-policy 服务都就绪才放行注册。 */
function hasFilesReadPermission(ctx: PluginContext): boolean {
  if (!ctx.services.has('approval-policy')) {
    ctx.logger.warn('approval-policy 服务不可用，无法校验权限');
    return false;
  }
  const policy = ctx.services.get<ApprovalPolicyShape>('approval-policy');
  return policy.checkPermission(ctx.manifest.id, FILES_READ);
}

function createStatsService(ctx: PluginContext): FileStatsService {
  return {
    statsOfFile(path: string): TextStats {
      // 第二道闸在宿主能力内部：ctx.files.readFile 每次按本插件 id 校验 files:read，
      // 未授权/服务不可用时抛错，不会读到文件内容。
      const text = ctx.files.readFile(path);
      return computeTextStats(text);
    },
  };
}

/** 纯文本统计（无副作用；输入为已读回的文本内容）。 */
function computeTextStats(text: string): TextStats {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized === '' ? 0 : normalized.split('\n').length;
  const words = normalized.split(/\s+/).filter((w) => w.length > 0).length;
  const chars = [...normalized].length;
  // 纯 Web API 字节计数（沙箱兼容，不依赖 Node Buffer）
  const bytes = new TextEncoder().encode(normalized).length;
  return { lines, words, chars, bytes };
}
