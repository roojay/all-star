# All-Star GitHub Repository Fetcher

一个使用 Bun 构建的工具，用于获取指定 GitHub 用户的所有 starred 项目。

## 功能特性

- 🚀 使用 GitHub REST API 获取用户的 starred 项目
- 📄 支持自动分页，每页获取 100 个项目（GitHub API 允许的最大值）
- 💾 按页面分别保存数据到 JSON 文件
- 📊 生成汇总信息文件
- 🔧 完善的错误处理机制
- ⚡ 使用 Bun 运行时，性能优异

## 安装依赖

确保您已安装 Bun：

```bash
# 安装 Bun (如果尚未安装)
curl -fsSL https://bun.sh/install | bash

# 安装项目依赖
bun install
```

## 使用方法

### 基本用法

```bash
# 获取指定用户的 starred 项目
bun run index.ts <username>

# 示例
bun run index.ts octocat
```

### 使用 GitHub Token（推荐）

为了避免 API 限制，建议使用 GitHub Personal Access Token：

```bash
# 方法 1: 通过命令行参数传递
bun run index.ts <username> <github_token>

# 示例
bun run index.ts octocat ghp_xxxxxxxxxxxx
```

```bash
# 方法 2: 通过环境变量
export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"
bun run index.ts <username>
```

## GitHub Token 设置

1. 访问 [GitHub Settings > Developer settings > Personal access tokens](https://github.com/settings/tokens)
2. 点击 "Generate new token (classic)"
3. 选择适当的权限（对于获取公开的 starred 项目，不需要特殊权限）
4. 复制生成的 token

## 输出文件结构

运行后会在 `data/<username>/` 目录下生成以下文件：

```
data/
└── <username>/
    ├── starred-page-1.json    # 第一页数据
    ├── starred-page-2.json    # 第二页数据
    ├── ...
    └── summary.json           # 汇总信息
```

### 文件内容示例

**页面数据文件** (`starred-page-1.json`):
```json
{
  "username": "octocat",
  "page": 1,
  "per_page": 100,
  "count": 100,
  "fetched_at": "2025-06-16T12:00:00.000Z",
  "repositories": [
    {
      "id": 1296269,
      "name": "Hello-World",
      "full_name": "octocat/Hello-World",
      "description": "This your first repo!",
      "html_url": "https://github.com/octocat/Hello-World",
      "stargazers_count": 80,
      "language": "C",
      "created_at": "2011-01-26T19:01:12Z",
      "updated_at": "2011-01-26T19:14:43Z",
      "owner": {
        "login": "octocat",
        "avatar_url": "https://github.com/images/error/octocat_happy.gif"
      }
    }
  ]
}
```

**汇总信息文件** (`summary.json`):
```json
{
  "username": "octocat",
  "total_repositories": 250,
  "total_pages": 3,
  "per_page": 100,
  "fetched_at": "2025-06-16T12:00:00.000Z",
  "data_directory": "./data/octocat",
  "files": [
    "starred-page-1.json",
    "starred-page-2.json",
    "starred-page-3.json"
  ]
}
```

## 错误处理

程序包含完善的错误处理机制：

- ✅ 用户不存在或项目不可访问
- ✅ API 请求频率限制
- ✅ 网络连接问题
- ✅ 文件系统操作错误
- ✅ JSON 解析错误

## API 限制

- 未认证请求：每小时 60 次
- 认证请求：每小时 5000 次

建议使用 GitHub Token 以获得更高的请求限制。

## 技术栈

- **运行时**: Bun
- **语言**: TypeScript
- **API**: GitHub REST API v3

## 开发

```bash
# 运行开发模式
bun run --watch index.ts <username>

# 类型检查
bun run tsc --noEmit
```

## 许可证

MIT License

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.16. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
