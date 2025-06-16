import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string;
  html_url: string;
  stargazers_count: number;
  language: string;
  created_at: string;
  updated_at: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

interface GitHubApiResponse {
  data: GitHubRepo[];
  hasNextPage: boolean;
  nextPage?: number;
}

export class GitHubStarredFetcher {
  private readonly baseUrl = 'https://api.github.com';
  private readonly perPage = 100; // GitHub API 允许的最大每页数量
  private readonly delay = 200; // 每次请求之间的延时，单位为毫秒
  private readonly dataDir = './data';
  private readonly userDataDir: string;

  constructor(private username: string, private token?: string) {
    // 为每个用户创建单独的数据目录
    this.userDataDir = join(this.dataDir, this.username);
  }

  /**
   * 获取指定用户的所有 starred 项目
   */
  async fetchAllStarredRepos(): Promise<void> {
    try {
      console.log(`🚀 开始获取用户 ${this.username} 的 starred 项目...`);

      // 确保 data 目录存在
      await this.ensureDataDirectory();

      let page = 1;
      let totalRepos = 0;

      while (true) {
        console.log(`📄 正在获取第 ${page} 页...`);

        const response = await this.fetchStarredPage(page);

        if (response.data.length === 0) {
          console.log('✅ 没有更多数据，获取完成！');
          break;
        }

        // 保存当前页数据
        await this.savePageData(page, response.data);
        totalRepos += response.data.length;

        console.log(`✅ 第 ${page} 页保存完成，包含 ${response.data.length} 个项目`);

        // 检查是否还有下一页
        if (!response.hasNextPage) {
          console.log('✅ 已获取所有页面，完成！');
          break;
        }

        page++;

        // 添加延迟避免触发 API 限制
        await this.sleep(this.delay);
      }

      console.log(`🎉 获取完成！总共获取了 ${totalRepos} 个 starred 项目，分 ${page} 页保存`);

      // 生成汇总信息
      await this.generateSummary(totalRepos, page);

    } catch (error) {
      console.error('❌ 获取过程中发生错误:', error);
      throw error;
    }
  }

  /**
   * 获取指定页的 starred 项目
   */
  private async fetchStarredPage(page: number): Promise<GitHubApiResponse> {
    const url = `${this.baseUrl}/users/${this.username}/starred?page=${page}&per_page=${this.perPage}`;

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'all-star-fetcher'
    };

    // 如果提供了 token，添加认证头
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(url, { headers });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`用户 ${this.username} 不存在或其 starred 项目不可访问`);
        } else if (response.status === 403) {
          throw new Error('API 请求频率限制或需要认证。请检查您的 GitHub token');
        } else {
          throw new Error(`GitHub API 请求失败: ${response.status} ${response.statusText}`);
        }
      }

      const data = await response.json() as GitHubRepo[];

      // 检查是否有下一页
      const linkHeader = response.headers.get('Link');
      const hasNextPage = linkHeader ? linkHeader.includes('rel="next"') : false;

      return {
        data,
        hasNextPage,
        nextPage: hasNextPage ? page + 1 : undefined
      };
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`网络请求失败: ${error}`);
    }
  }

  /**
   * 确保用户数据目录存在
   */
  private async ensureDataDirectory(): Promise<void> {
    try {
      await mkdir(this.userDataDir, { recursive: true });
      console.log(`📁 数据将保存到: ${this.userDataDir}`);
    } catch (error) {
      throw new Error(`创建用户数据目录失败: ${error}`);
    }
  }

  /**
   * 保存指定页的数据
   */
  private async savePageData(page: number, repos: GitHubRepo[]): Promise<void> {
    const filename = `starred-page-${page}.json`;
    const filepath = join(this.userDataDir, filename);

    const pageData = {
      username: this.username,
      page,
      per_page: this.perPage,
      count: repos.length,
      fetched_at: new Date().toISOString(),
      repositories: repos
    };

    try {
      await Bun.write(filepath, JSON.stringify(pageData, null, 2));
    } catch (error) {
      throw new Error(`保存文件失败 ${filepath}: ${error}`);
    }
  }

  /**
   * 生成汇总信息
   */
  private async generateSummary(totalRepos: number, totalPages: number): Promise<void> {
    const summary = {
      username: this.username,
      total_repositories: totalRepos,
      total_pages: totalPages,
      per_page: this.perPage,
      fetched_at: new Date().toISOString(),
      data_directory: this.userDataDir,
      files: Array.from({ length: totalPages }, (_, i) =>
        `starred-page-${i + 1}.json`
      )
    };

    const summaryPath = join(this.userDataDir, 'summary.json');

    try {
      await Bun.write(summaryPath, JSON.stringify(summary, null, 2));
      console.log(`📊 汇总信息已保存到: ${summaryPath}`);
    } catch (error) {
      console.error(`保存汇总信息失败: ${error}`);
    }
  }

  /**
   * 延迟函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 主函数
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('❌ 请提供 GitHub 用户名');
    console.log('使用方法: bun run index.ts <username> [github_token]');
    console.log('示例: bun run index.ts octocat');
    console.log('示例: bun run index.ts octocat ghp_xxxxxxxxxxxx');
    process.exit(1);
  }

  const username = args[0];
  const token = args[1] || process.env.GITHUB_TOKEN;

  if (!token) {
    console.log('⚠️  未提供 GitHub token，可能会受到 API 限制');
    console.log('您可以通过以下方式提供 token:');
    console.log('1. 命令行参数: bun run index.ts <username> <token>');
    console.log('2. 环境变量: export GITHUB_TOKEN="your_token"');
    console.log('');
  }

  if (!username) {
    console.error('❌ 用户名不能为空');
    console.log('使用方法: bun run index.ts <username> [github_token]');
    process.exit(1);
  }

  const fetcher = new GitHubStarredFetcher(username, token);

  try {
    await fetcher.fetchAllStarredRepos();
  } catch (error) {
    console.error('❌ 程序执行失败:', error);
    process.exit(1);
  }
}

// 运行主函数
main().catch(console.error);
