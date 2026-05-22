import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

/**
 * GitHub starred 仓库的最小子集类型。
 * description / language 在 GitHub REST API 中可空。
 */
interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

/** 带 starred_at 时间戳的响应项（Accept: application/vnd.github.star+json） */
interface StarredItem {
  starred_at: string;
  repo: GitHubRepo;
}

interface FetcherOptions {
  perPage?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  rateLimitBuffer?: number;
  mode?: 'incremental' | 'full';
  fullSyncIntervalDays?: number;
  dataDir?: string;
}

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'all-star-fetcher (+https://github.com/roojay/all-star)';

// ============================================================
// SQLite 存储层
// ============================================================

const SCHEMA_VERSION = 1;

interface RepoRow {
  id: number;
  full_name: string;
  starred_at: string;
  updated_at: string;
  stargazers_count: number;
  language: string | null;
}

class Store {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true, strict: true });
    // WAL：并发读 + 单写，崩溃恢复友好
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS repos (
        id INTEGER PRIMARY KEY,
        full_name TEXT NOT NULL,
        starred_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pushed_at TEXT NOT NULL,
        stargazers_count INTEGER NOT NULL,
        language TEXT,
        description TEXT,
        html_url TEXT NOT NULL,
        owner_login TEXT NOT NULL,
        owner_avatar_url TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_repos_starred_at ON repos(starred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_repos_stars ON repos(stargazers_count DESC);
      CREATE INDEX IF NOT EXISTS idx_repos_language ON repos(language);

      CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generated_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        kind TEXT NOT NULL,
        repo_id INTEGER NOT NULL,
        full_name TEXT NOT NULL,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_changes_generated_at ON changes(generated_at DESC);
    `);
    const v = this.getMeta('schema_version');
    if (!v) this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  getMeta(key: string): string | null {
    const row = this.db
      .query<{ value: string | null }, { key: string }>(
        'SELECT value FROM meta WHERE key = $key',
      )
      .get({ key });
    return row?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    this.db
      .query(
        'INSERT INTO meta (key, value) VALUES ($key, $value) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run({ key, value });
  }

  countRepos(): number {
    const r = this.db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM repos').get();
    return r?.c ?? 0;
  }

  getAllRepoIds(): Set<number> {
    const rows = this.db.query<{ id: number }, []>('SELECT id FROM repos').all();
    return new Set(rows.map((r) => r.id));
  }

  getRepoSummary(id: number): RepoRow | null {
    return this.db
      .query<RepoRow, { id: number }>(
        'SELECT id, full_name, starred_at, updated_at, stargazers_count, language ' +
          'FROM repos WHERE id = $id',
      )
      .get({ id });
  }

  /**
   * 批量 upsert：在事务中执行，崩溃即回滚。
   */
  upsertRepos(items: StarredItem[]): void {
    if (items.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO repos (
        id, full_name, starred_at, updated_at, pushed_at, stargazers_count,
        language, description, html_url, owner_login, owner_avatar_url,
        raw_json, last_seen_at
      ) VALUES (
        $id, $full_name, $starred_at, $updated_at, $pushed_at, $stargazers_count,
        $language, $description, $html_url, $owner_login, $owner_avatar_url,
        $raw_json, $last_seen_at
      ) ON CONFLICT(id) DO UPDATE SET
        full_name = excluded.full_name,
        starred_at = excluded.starred_at,
        updated_at = excluded.updated_at,
        pushed_at = excluded.pushed_at,
        stargazers_count = excluded.stargazers_count,
        language = excluded.language,
        description = excluded.description,
        html_url = excluded.html_url,
        owner_login = excluded.owner_login,
        owner_avatar_url = excluded.owner_avatar_url,
        raw_json = excluded.raw_json,
        last_seen_at = excluded.last_seen_at`,
    );
    const now = new Date().toISOString();
    const tx = this.db.transaction((batch: StarredItem[]) => {
      for (const it of batch) {
        stmt.run({
          id: it.repo.id,
          full_name: it.repo.full_name,
          starred_at: it.starred_at,
          updated_at: it.repo.updated_at,
          pushed_at: it.repo.pushed_at,
          stargazers_count: it.repo.stargazers_count,
          language: it.repo.language,
          description: it.repo.description,
          html_url: it.repo.html_url,
          owner_login: it.repo.owner.login,
          owner_avatar_url: it.repo.owner.avatar_url,
          raw_json: JSON.stringify(it.repo),
          last_seen_at: now,
        });
      }
    });
    tx(items);
  }

  deleteRepos(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare('DELETE FROM repos WHERE id = $id');
    const tx = this.db.transaction((batch: number[]) => {
      for (const id of batch) stmt.run({ id });
    });
    tx(ids);
  }

  appendChanges(entries: ChangeEntry[]): void {
    if (entries.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO changes (generated_at, mode, kind, repo_id, full_name, details_json)
       VALUES ($generated_at, $mode, $kind, $repo_id, $full_name, $details_json)`,
    );
    const tx = this.db.transaction((batch: ChangeEntry[]) => {
      for (const e of batch) {
        stmt.run({
          generated_at: e.generated_at,
          mode: e.mode,
          kind: e.kind,
          repo_id: e.repo_id,
          full_name: e.full_name,
          details_json: e.details_json ?? null,
        });
      }
    });
    tx(entries);
  }

  /** 多操作的原子包装：sync 末尾统一提交，崩溃则全回滚 */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

interface ChangeEntry {
  generated_at: string;
  mode: 'incremental' | 'full';
  kind: 'added' | 'removed' | 'updated';
  repo_id: number;
  full_name: string;
  details_json?: string;
}

// ============================================================
// Fetcher
// ============================================================

export class GitHubStarredFetcher {
  private readonly perPage: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly rateLimitBuffer: number;
  private readonly mode: 'incremental' | 'full';
  private readonly fullSyncIntervalMs: number;
  private readonly userDataDir: string;
  private readonly dbPath: string;
  private store!: Store;

  constructor(
    private readonly username: string,
    private readonly token?: string,
    opts: FetcherOptions = {},
  ) {
    this.perPage = Math.min(Math.max(opts.perPage ?? 100, 1), 100);
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 5;
    this.rateLimitBuffer = opts.rateLimitBuffer ?? 10;
    this.mode = opts.mode ?? 'incremental';
    this.fullSyncIntervalMs = (opts.fullSyncIntervalDays ?? 7) * 86_400_000;
    const dataDir = opts.dataDir ?? './data';
    this.userDataDir = join(dataDir, this.username);
    this.dbPath = join(this.userDataDir, 'stars.db');
  }

  async run(): Promise<void> {
    console.log(`🚀 用户 ${this.username} | 请求模式: ${this.mode}`);
    if (!this.token) {
      console.log('⚠️  未提供 token：未认证限额仅 60 次/小时');
    }

    await mkdir(this.userDataDir, { recursive: true });
    this.store = new Store(this.dbPath);

    try {
      const effectiveMode = this.resolveMode();
      if (effectiveMode !== this.mode) {
        console.log(`ℹ️  自动切换为 ${effectiveMode} 模式（首次同步或距上次全量已过期）`);
      }

      if (effectiveMode === 'incremental') {
        await this.runIncremental();
      } else {
        await this.runFull();
      }
    } finally {
      this.store.close();
    }
  }

  // ---------- 增量模式：If-Modified-Since + 早停 ----------

  private async runIncremental(): Promise<void> {
    const cursor = this.store.getMeta('last_starred_at');
    const lastModified = this.store.getMeta('last_modified');
    console.log(`📌 增量游标 starred_at > ${cursor}`);

    const firstPage = await this.fetchStarredPage(1, lastModified ?? undefined);

    // 服务端 Last-Modified 未变 → 零字节、零变化
    if (firstPage.notModified) {
      console.log('✅ 304 Not Modified：无任何变化');
      this.store.setMeta('last_incremental_at', new Date().toISOString());
      return;
    }

    const newItems: StarredItem[] = [];
    let stop = false;
    for (const item of firstPage.items) {
      if (cursor && item.starred_at <= cursor) {
        stop = true;
        break;
      }
      newItems.push(item);
    }

    let page = 1;
    let hasNext = firstPage.hasNextPage && !stop;
    let lastRateLimit = firstPage.rateLimit;

    while (hasNext) {
      await this.throttle(lastRateLimit);
      page++;
      const result = await this.fetchStarredPage(page);
      lastRateLimit = result.rateLimit;
      if (result.items.length === 0) break;

      for (const item of result.items) {
        if (cursor && item.starred_at <= cursor) {
          stop = true;
          break;
        }
        newItems.push(item);
      }
      if (stop || !result.hasNextPage) break;
    }

    const now = new Date().toISOString();

    if (newItems.length === 0) {
      console.log('✅ 无新增 star');
      this.store.transaction(() => {
        this.store.setMeta('last_incremental_at', now);
        if (firstPage.lastModified) this.store.setMeta('last_modified', firstPage.lastModified);
      });
      return;
    }

    // 按 starred_at 升序，使游标单调递增
    newItems.sort((a, b) => (a.starred_at < b.starred_at ? -1 : 1));

    const changes: ChangeEntry[] = [];
    for (const item of newItems) {
      const prev = this.store.getRepoSummary(item.repo.id);
      if (!prev) {
        changes.push({
          generated_at: now,
          mode: 'incremental',
          kind: 'added',
          repo_id: item.repo.id,
          full_name: item.repo.full_name,
        });
      } else {
        const diff = diffRepo(prev, item.repo);
        if (Object.keys(diff).length > 0) {
          changes.push({
            generated_at: now,
            mode: 'incremental',
            kind: 'updated',
            repo_id: item.repo.id,
            full_name: item.repo.full_name,
            details_json: JSON.stringify(diff),
          });
        }
      }
    }

    this.store.transaction(() => {
      this.store.upsertRepos(newItems);
      this.store.appendChanges(changes);
      this.store.setMeta('last_starred_at', newItems[newItems.length - 1]!.starred_at);
      this.store.setMeta('last_incremental_at', now);
      this.store.setMeta('total', String(this.store.countRepos()));
      if (firstPage.lastModified) this.store.setMeta('last_modified', firstPage.lastModified);
    });

    const added = changes.filter((c) => c.kind === 'added').length;
    const updated = changes.filter((c) => c.kind === 'updated').length;
    console.log(
      `🎉 增量完成：新增 ${added}，元数据更新 ${updated}（扫描 ${page} 页，写入 ${newItems.length} 条）`,
    );
  }

  // ---------- 全量模式：完整 diff + 删除检测 ----------

  private async runFull(): Promise<void> {
    console.log('🔁 全量同步与校对');
    const currentItems = new Map<number, StarredItem>();
    let page = 1;
    let firstPageLastModified: string | undefined;

    while (true) {
      const result = await this.fetchStarredPage(page);
      if (page === 1) firstPageLastModified = result.lastModified;
      if (result.items.length === 0) break;

      for (const item of result.items) currentItems.set(item.repo.id, item);
      console.log(`✅ 第 ${page} 页 ${result.items.length} 个 | 累计 ${currentItems.size}`);

      if (!result.hasNextPage) break;
      await this.throttle(result.rateLimit);
      page++;
    }

    const now = new Date().toISOString();
    const prevIds = this.store.getAllRepoIds();
    const currIds = new Set(currentItems.keys());
    const items = Array.from(currentItems.values());

    const changes: ChangeEntry[] = [];
    for (const [id, item] of currentItems) {
      const prev = this.store.getRepoSummary(id);
      if (!prev) {
        changes.push({
          generated_at: now,
          mode: 'full',
          kind: 'added',
          repo_id: id,
          full_name: item.repo.full_name,
        });
      } else {
        const diff = diffRepo(prev, item.repo);
        if (Object.keys(diff).length > 0) {
          changes.push({
            generated_at: now,
            mode: 'full',
            kind: 'updated',
            repo_id: id,
            full_name: item.repo.full_name,
            details_json: JSON.stringify(diff),
          });
        }
      }
    }

    const removed: number[] = [];
    for (const id of prevIds) {
      if (!currIds.has(id)) {
        const prev = this.store.getRepoSummary(id)!;
        changes.push({
          generated_at: now,
          mode: 'full',
          kind: 'removed',
          repo_id: id,
          full_name: prev.full_name,
        });
        removed.push(id);
      }
    }

    let maxStarredAt: string | null = null;
    for (const item of currentItems.values()) {
      if (!maxStarredAt || item.starred_at > maxStarredAt) maxStarredAt = item.starred_at;
    }

    this.store.transaction(() => {
      this.store.upsertRepos(items);
      this.store.deleteRepos(removed);
      this.store.appendChanges(changes);
      if (maxStarredAt) this.store.setMeta('last_starred_at', maxStarredAt);
      this.store.setMeta('last_full_sync_at', now);
      this.store.setMeta('last_incremental_at', now);
      this.store.setMeta('total', String(currIds.size));
      if (firstPageLastModified) this.store.setMeta('last_modified', firstPageLastModified);
    });

    const added = changes.filter((c) => c.kind === 'added').length;
    const updated = changes.filter((c) => c.kind === 'updated').length;
    console.log(
      `🎉 全量完成：新增 ${added} | 删除 ${removed.length} | 更新 ${updated} | 总 ${currIds.size}`,
    );
  }

  // ---------- 网络层 ----------

  private async fetchStarredPage(
    page: number,
    ifModifiedSince?: string,
  ): Promise<{
    items: StarredItem[];
    hasNextPage: boolean;
    rateLimit?: RateLimit;
    lastModified?: string;
    notModified?: boolean;
  }> {
    const url =
      `${API_BASE}/users/${this.username}/starred` +
      `?page=${page}&per_page=${this.perPage}&sort=created&direction=desc`;

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.star+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (ifModifiedSince) headers['If-Modified-Since'] = ifModifiedSince;

    console.log(`📄 GET page=${page}${ifModifiedSince ? ' (If-Modified-Since)' : ''}`);

    const response = await this.requestWithRetry(url, headers);
    const rateLimit = parseRateLimit(response.headers);
    const linkHeader = response.headers.get('Link');
    const hasNextPage = linkHeader ? linkHeader.includes('rel="next"') : false;
    const lastModified = response.headers.get('Last-Modified') ?? undefined;

    if (response.status === 304) {
      await response.body?.cancel();
      return { items: [], hasNextPage: false, rateLimit, lastModified, notModified: true };
    }

    const items = (await response.json()) as StarredItem[];
    return { items, hasNextPage, rateLimit, lastModified };
  }

  private async requestWithRetry(
    url: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });

        if (response.status === 403 || response.status === 429) {
          const waitMs = secondaryRateLimitWait(response);
          if (waitMs !== null && attempt < this.maxRetries) {
            console.warn(
              `⚠️  限流（status=${response.status}），等待 ${Math.ceil(waitMs / 1000)}s 后重试`,
            );
            await response.body?.cancel();
            await Bun.sleep(waitMs);
            continue;
          }
          throw await buildHttpError(response);
        }

        if (response.status >= 500 && attempt < this.maxRetries) {
          const wait = backoffWithJitter(attempt);
          console.warn(
            `⚠️  服务端 ${response.status}，${Math.ceil(wait / 1000)}s 后第 ${attempt + 1} 次重试`,
          );
          await response.body?.cancel();
          await Bun.sleep(wait);
          continue;
        }

        if (!response.ok && response.status !== 304) throw await buildHttpError(response);
        return response;
      } catch (err) {
        lastError = err;
        if (err instanceof HttpError) throw err;
        if (attempt >= this.maxRetries) break;
        const wait = backoffWithJitter(attempt);
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `⚠️  网络错误：${reason}，${Math.ceil(wait / 1000)}s 后第 ${attempt + 1} 次重试`,
        );
        await Bun.sleep(wait);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`请求失败且重试用尽: ${String(lastError)}`);
  }

  private async throttle(rateLimit: RateLimit | undefined): Promise<void> {
    if (!rateLimit) {
      await Bun.sleep(200);
      return;
    }
    const { remaining, resetAt } = rateLimit;
    if (remaining <= this.rateLimitBuffer) {
      const waitMs = Math.max(0, resetAt - Date.now()) + 1_000;
      console.warn(`⚠️  配额仅剩 ${remaining}，等待 ${Math.ceil(waitMs / 1000)}s 至重置`);
      await Bun.sleep(waitMs);
      return;
    }
    const base = 200;
    const factor = remaining < 100 ? 4 : remaining < 500 ? 2 : 1;
    await Bun.sleep(base * factor);
  }

  private resolveMode(): 'incremental' | 'full' {
    if (this.mode === 'full') return 'full';
    const lastFull = this.store.getMeta('last_full_sync_at');
    if (!lastFull) return 'full'; // 首次必须全量建底
    const elapsed = Date.now() - Date.parse(lastFull);
    if (elapsed > this.fullSyncIntervalMs) return 'full';
    return 'incremental';
  }
}

// ============================================================
// 工具函数
// ============================================================

interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: number;
}

class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

async function buildHttpError(response: Response): Promise<HttpError> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    /* ignore */
  }
  const msg =
    response.status === 404
      ? `用户不存在或 starred 列表不可访问 (404)`
      : response.status === 401
        ? `认证失败：请检查 GITHUB_TOKEN (401)`
        : `GitHub API 请求失败: ${response.status} ${response.statusText} ${body.slice(0, 200)}`;
  return new HttpError(msg, response.status);
}

function parseRateLimit(headers: Headers): RateLimit | undefined {
  const limit = Number(headers.get('x-ratelimit-limit'));
  const remaining = Number(headers.get('x-ratelimit-remaining'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(reset)) {
    return undefined;
  }
  return { limit, remaining, resetAt: reset * 1000 };
}

function secondaryRateLimitWait(response: Response): number | null {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const sec = Number(retryAfter);
    if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (remaining === 0 && Number.isFinite(reset)) {
    return Math.max(0, reset * 1000 - Date.now()) + 1_000;
  }
  return null;
}

function backoffWithJitter(attempt: number): number {
  const base = Math.min(1_000 * 2 ** attempt, 30_000);
  return base + Math.floor(Math.random() * 500);
}

function diffRepo(
  prev: RepoRow,
  curr: GitHubRepo,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  if (prev.full_name !== curr.full_name)
    diff.full_name = { from: prev.full_name, to: curr.full_name };
  if (prev.updated_at !== curr.updated_at)
    diff.updated_at = { from: prev.updated_at, to: curr.updated_at };
  if (prev.stargazers_count !== curr.stargazers_count)
    diff.stargazers_count = { from: prev.stargazers_count, to: curr.stargazers_count };
  if (prev.language !== curr.language)
    diff.language = { from: prev.language, to: curr.language };
  return diff;
}

// ============================================================
// CLI
// ============================================================

interface ParsedArgs {
  username?: string;
  token?: string;
  mode: 'incremental' | 'full';
  fullSyncIntervalDays: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let mode: 'incremental' | 'full' = 'incremental';
  let fullSyncIntervalDays = 7;

  for (const a of argv) {
    if (a === '--full') mode = 'full';
    else if (a === '--incremental') mode = 'incremental';
    else if (a.startsWith('--full-interval=')) {
      const v = Number(a.slice('--full-interval='.length));
      if (Number.isFinite(v) && v > 0) fullSyncIntervalDays = v;
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  const username = positional[0];
  const token = positional[1] ?? process.env.GITHUB_TOKEN;
  return { username, token, mode, fullSyncIntervalDays };
}

async function main() {
  const { username, token, mode, fullSyncIntervalDays } = parseArgs(process.argv.slice(2));

  if (!username) {
    console.error('❌ 请提供 GitHub 用户名');
    console.log('使用: bun run index.ts <username> [token] [flags]');
    console.log('  --incremental          增量模式（默认）');
    console.log('  --full                 强制全量校对（含取消 star 检测）');
    console.log('  --full-interval=<天>   超过该间隔自动转全量，默认 7');
    console.log('  token 也可通过环境变量 GITHUB_TOKEN 提供');
    process.exit(1);
  }

  const fetcher = new GitHubStarredFetcher(username, token, { mode, fullSyncIntervalDays });

  try {
    await fetcher.run();
  } catch (error) {
    console.error('❌ 执行失败:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
