// 测试脚本 - 演示获取一个有较多 starred 项目的用户
import { GitHubStarredFetcher } from './index';

async function test() {
  console.log('🧪 测试分页功能...');

  // 使用一个有更多 starred 项目的用户进行测试
  // 注意：这只是演示，实际使用时请替换为真实用户名
  const username = 'sindresorhus'; // 这个用户通常有很多 starred 项目

  const fetcher = new GitHubStarredFetcher(username);

  try {
    await fetcher.fetchAllStarredRepos();
    console.log('✅ 测试完成！');
  } catch (error) {
    console.error('❌ 测试失败:', error);
  }
}

// 如果直接运行此文件则执行测试
if (import.meta.main) {
  test();
}
