/**
 * 插件市场客户端（占位）。
 *
 * TASK-007 实现：
 *  - 拉取 registry（plugins.json，URL 可配置）
 *  - 展示插件列表
 *  - 从 GitHub Releases 下载 zip、解压到本地插件目录
 *  - 安装/卸载/更新；网络失败走本地缓存与手动导入兜底
 */
export class MarketClient {
  async refresh(): Promise<never> {
    throw new Error('MarketClient.refresh() 未实现：见 TASK-007');
  }

  async install(_pluginId: string): Promise<never> {
    throw new Error('MarketClient.install() 未实现：见 TASK-007');
  }

  async uninstall(_pluginId: string): Promise<never> {
    throw new Error('MarketClient.uninstall() 未实现：见 TASK-007');
  }
}
