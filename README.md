# All-Star

> 基于 Bun + SQLite 的 GitHub Starred 仓库增量同步工具

针对 GitHub REST API 设计的高效抓取器：默认增量模式，仅请求"自上次同步以来新增的 star"，配合 SQLite 单文件存储与 GitHub Actions 自动化，同步数据并发布可视化报表到 GitHub Pages。

## 功能特性

- ⚡ **增量同步**：基于 `starred_at` 早停 + `If-Modified-Since` 304 协商，正常增量场景仅需 1 个请求
- 🔁 **全量校对**：周期性兜底（默认 7 天），精准检测取消 star、改名、元数据变更
- 🗄️ **SQLite 存储**：单文件 + WAL 模式，10k stars 仅 ~3MB，支持 SQL 查询/diff
- 🛡️ **抗风控**：识别主/二级限流、`Retry-After`、`x-ratelimit-*`，自适应节流 + 指数退避
- 📝 **变更日志**：`changes` 表自动记录每次 added / removed / updated
- 📊 **可视化报表**：单文件 HTML 仪表盘（ECharts + shadcn 风格），本地或 CI 一键生成
- 🌐 **GitHub Pages**：Actions 自动打包为 `index.html` 并发布，根路径即可访问
- 🤖 **GitHub Actions**：手动触发即可同步数据、提交仓库并部署报表
- 🧬 **TypeScript strict**：原子写入 / 事务化更新 / 严格类型检查

## 快速开始

```bash
# 安装 Bun（如未安装）
curl -fsSL https://bun.sh/install | bash

# 安装依赖
bun install

# 抓取（首次自动走全量）
bun run index.ts <username>

# 推荐使用 token，避免未认证 60 次/小时的限额
export GITHUB_TOKEN="ghp_xxx"
bun run index.ts <username>
```

## GitHub Token 获取

未认证请求每小时仅 60 次，强烈建议配置 Personal Access Token（PAT）以获得 5000 req/hr 额度。

### 方式一：Fine-grained PAT（推荐，更安全）

1. 打开 [Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new)
2. **Token name**：任意（例 `all-star-fetcher`）
3. **Expiration**：建议 90 天或自定义
4. **Repository access**：选 `Public Repositories (read-only)` 即可（抓取公开 starred 列表无需任何写权限）
5. **Permissions**：保持默认（公开仓库只读已包含 metadata 读取权限，无需额外勾选）
6. 点击 **Generate token**，复制以 `github_pat_` 开头的字符串

### 方式二：Classic PAT

1. 打开 [Settings → Developer settings → Personal access tokens → Tokens (classic)](https://github.com/settings/tokens/new)
2. **Note**：任意（例 `all-star-fetcher`）
3. **Expiration**：建议设置过期时间
4. **Select scopes**：**全部不勾选**即可（公开 starred API 不需要任何 scope；如需读取私有仓库 starred 才需勾选 `repo`）
5. 点击 **Generate token**，复制以 `ghp_` 开头的字符串

### 配置 Token

**本地使用**（任选其一）：

```bash
# 方式 A：环境变量（推荐，避免泄露到命令历史）
export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"
bun run index.ts <username>

# 方式 B：写入 .env 文件（自动加载，已 gitignore）
echo 'GITHUB_TOKEN=ghp_xxxxxxxxxxxx' > .env
bun run index.ts <username>

# 方式 C：命令行参数（不推荐，会进入 shell 历史）
bun run index.ts <username> ghp_xxxxxxxxxxxx
```

**GitHub Actions 中**：默认已注入 `secrets.GITHUB_TOKEN`（1000 req/hr 配额），无需额外配置。

> ⚠️ **安全提醒**
> - Token 一旦生成后只显示一次，务必妥善保存
> - 不要 commit 到代码仓库（`.env` 已在 `.gitignore` 中）
> - 怀疑泄露时立即到 [Token 管理页](https://github.com/settings/tokens) **Revoke**
> - 优先选 Fine-grained PAT 并设置最短可用的过期时间

## 命令行参数

### 同步（index.ts）

```
bun run index.ts <username> [token] [flags]

  --incremental          增量模式（默认）
  --full                 强制全量校对（含取消 star 检测）
  --full-interval=<天>   超过该间隔自动转全量，默认 7

  token 也可通过环境变量 GITHUB_TOKEN 提供
```

### 报表（report.ts）

```
bun run report.ts <username> [flags]

  --data-dir=<path>      数据目录，默认 ./data
  --output=<path>        输出 HTML 路径，默认 data/<username>/report.html
```

### 模式选择逻辑

```diagram
╭──────────────────────────────────────────────────╮
│ 首次运行 / 检测不到 last_full_sync_at  → full    │
│ --full                                  → full   │
│ 距上次全量 > --full-interval 天        → full    │
│ 其余情况                                → incr   │
╰──────────────────────────────────────────────────╯
```

## 工作原理

### 增量模式

```diagram
1. 读 SQLite 中的 last_starred_at / last_modified
2. GET /users/{u}/starred?sort=created&direction=desc
     带 If-Modified-Since: <last_modified>
     Accept: application/vnd.github.star+json
3a. 服务端 304 → 零字节、结束
3b. 服务端 200 → 逐项扫描，遇到 starred_at <= 游标即停
4. 事务化写入 repos + changes，更新游标
```

### 全量模式

- 遍历所有页 → 构建当前 ID 集合
- diff `prevIds − currIds` 检测**取消 star**
- 字段级 diff 检测元数据变化（full_name 改名、stars、language、updated_at）
- 单事务提交：upsert + delete + changes + meta

## 存储结构

```diagram
data/<username>/
  ├─ stars.db          ← SQLite 主文件（入库）
  ├─ report.html       ← 本地生成的报表（可选，默认输出）
  ├─ stars.db-wal      ← 运行时 WAL（已 gitignore）
  └─ stars.db-shm      ← 共享内存（已 gitignore）

_site/                 ← CI 构建产物（index.html，已 gitignore）
```

### Schema

| 表 | 说明 |
|---|---|
| `meta` | KV 元数据：`last_starred_at` / `last_modified` / `last_full_sync_at` / `last_incremental_at` / `total` / `schema_version` |
| `repos` | 仓库主表，含 `raw_json` 字段保留完整原始响应；索引：`starred_at DESC` / `stargazers_count DESC` / `language` |
| `changes` | 变更历史：`generated_at` / `mode` / `kind`(added\|removed\|updated) / `details_json` |

### 常用查询

```sql
-- 近 7 天新 star
SELECT full_name, starred_at FROM repos
WHERE starred_at > datetime('now', '-7 days')
ORDER BY starred_at DESC;

-- 按语言聚合 Top 10
SELECT language, COUNT(*) c FROM repos
WHERE language IS NOT NULL
GROUP BY language ORDER BY c DESC LIMIT 10;

-- 最近 50 条变更
SELECT generated_at, kind, full_name, details_json
FROM changes ORDER BY id DESC LIMIT 50;
```

可用 `sqlite3 data/<username>/stars.db`、DBeaver、TablePlus 等任意 SQLite 客户端打开。

## 可视化报表

生成一份本地 HTML 仪表盘（深色主题 + ECharts，单文件可分享）：

```bash
# 在同步之后跑（需要 stars.db 已存在）
bun run report.ts <username>

# 自定义输出位置（适合 GitHub Pages 根目录访问）
bun run report.ts <username> --output=./_site/index.html
```

设计语言对齐 **shadcn/ui v4 + Vercel Geist**：
- **OKLCH 色彩空间**：感知均匀的 shadcn token 体系（`--background` / `--card` / `--chart-1..5` 等）
- **Geist Variable + Geist Mono**：经 `@fontsource-variable` 从 jsDelivr / unpkg 加载
- **ECharts**：jsDelivr → unpkg → Cloudflare cdnjs 三级回退
- **本期摘要叙事段落**：顶部导语，把多维数据压缩成一句话洞察
- **KPI Sparkline**：每张 KPI 卡内嵌 SVG 微型趋势线
- 每张图表附洞察文案，把图表从"装饰"变成"信号"

**5 个分析维度**

| 区块 | 图表 | 解决的问题 |
|---|---|---|
| **Overview** | 6 张 KPI 卡（带同比/环比 delta） | 一眼看出当前节奏 vs 历史基线 |
| **Activity** | 日历热力图 + 累积曲线 + 30 天滚动速率 | 探索强度的"心跳"——爆发期 / 平台期 |
| **Discovery** | 周几柱图 + 24 小时极坐标 | 学习时间画像：周末党 / 夜猫子 / 工作日学习者 |
| **Composition** | 语言 Treemap + Top 15 作者横向条形 | 技术栈聚焦度 + 来源集中度 |
| **Health** | 流行度分层 Donut + 新鲜度堆叠 + 仓库出生年柱图 | 早期发现者 vs 趋势追随者；陈旧 stars 清理提示 |

**输出位置**

| 场景 | 路径 | 说明 |
|---|---|---|
| 本地默认 | `data/<username>/report.html` | 双击浏览器打开 |
| CI / Pages | `_site/index.html` | 作为站点根目录 `index.html` 发布 |

> `_site/` 为 CI 构建产物，已在 `.gitignore` 中忽略，不会提交到仓库。

## GitHub Actions 自动同步与发布

工作流文件：[.github/workflows/update-stars.yml](.github/workflows/update-stars.yml)

### 首次启用 GitHub Pages

1. 打开仓库 **Settings → Pages**
2. **Build and deployment → Source** 选择 **GitHub Actions**（不要选 Deploy from a branch）
3. 保存后，首次 workflow 成功运行即可访问站点

站点 URL 形如：`https://<owner>.github.io/<repo>/`（根路径即报表首页）

### 手动触发

**仅仓库 Owner** 可运行（`github.actor` 须与 `github.repository_owner` 一致）。协作者或其他有 Write 权限的用户触发时，`authorize` job 会失败并提示错误。

仓库页 → **Actions** → **Update Starred Repos** → **Run workflow**：

| 输入 | 说明 |
|---|---|
| `username` | 留空则使用触发者（`github.actor`，即 Owner 本人） |
| `mode` | `incremental` / `full` |
| `full-interval-days` | 增量模式下，距上次全量超此天数自动转全量 |

### 执行流程

```diagram
authorize job
  └─ 校验触发者是否为仓库 Owner

update job
  ├─ Fetch starred repos     → 写入 data/<username>/stars.db
  ├─ Build report            → 生成 _site/index.html
  ├─ Upload Pages artifact   → 上传静态站点产物
  ├─ Commit & push（有变化时）→ 仅提交 data/
  └─ Summary

deploy-pages job（依赖 update）
  └─ Deploy to GitHub Pages  → 发布报表，Summary 输出访问 URL
```

特性：
- **仅 Owner 可手动触发**（组织仓库下 `repository_owner` 为组织名，须由组织 Owner 账号触发）
- 使用仓库默认 `GITHUB_TOKEN`（1000 req/hr 配额，足够使用）
- 权限：`contents: write`（提交数据）+ `pages: write` / `id-token: write`（Pages 部署）
- 并发分组：同一用户避免并行抓取竞争
- 数据有变化时才 commit & push `data/`，避免空提交
- **无论数据是否变化，每次运行都会重新生成并发布报表**
- 结果写入 `$GITHUB_STEP_SUMMARY`，Actions 页直接看

可选扩展（按需启用）：
```yaml
on:
  schedule:
    - cron: '0 */6 * * *'   # 每 6 小时定时同步 + 发布
```

## 抗风控策略

| 场景 | 处理 |
|---|---|
| `x-ratelimit-remaining` ≤ 阈值（默认 10） | sleep 至 `x-ratelimit-reset` |
| 剩余 < 100 / < 500 | 节流间隔 × 4 / × 2 |
| 403 / 429（含 secondary rate limit） | 优先读 `Retry-After`，否则按 reset 计算 |
| 5xx / 网络错误 | 指数退避 + 抖动，最多 5 次（1s→2s→4s→8s→16s+jitter，封顶 30s） |
| 请求级超时 | `AbortSignal.timeout(30s)` |
| 写入崩溃 | SQLite 事务回滚 + WAL 恢复 |

## API 限额参考

| 模式 | 限额 |
|---|---|
| 未认证 | 60 req/hr |
| Personal Access Token | 5000 req/hr |
| GitHub Actions 默认 token | 1000 req/hr |

> 增量模式下，"无变化"仅消耗 1 配额（304），即便每小时跑一次也几乎无压力。

## 项目脚本

```bash
# 类型检查
bunx tsc --noEmit

# 同步 starred 仓库
bun run index.ts <username>

# 生成本地报表
bun run report.ts <username>

# 监听模式开发
bun run --watch index.ts <username>
```

## 技术栈

- **运行时**：Bun（`bun:sqlite` / `Bun.sleep` / `Bun.write`）
- **语言**：TypeScript（strict + noUncheckedIndexedAccess + verbatimModuleSyntax）
- **API**：GitHub REST API `2022-11-28` + `application/vnd.github.star+json`
- **存储**：SQLite（WAL 模式）
- **可视化**：ECharts 5 + Fontsource Geist（jsDelivr / unpkg / cdnjs）
- **部署**：GitHub Actions + GitHub Pages

## 许可证

MIT
