import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// ============================================================
// 类型定义
// ============================================================

interface RepoRow {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  starred_at: string;
  pushed_at: string;
  owner_login: string;
  owner_avatar_url: string;
}

interface ChangeRow {
  generated_at: string;
  mode: string;
  kind: string;
  full_name: string;
  details_json: string | null;
}

interface KpiBlock {
  label: string;
  value: number | string;
  hint?: string;
  delta?: { value: number; direction: 'up' | 'down' | 'flat'; tone: 'positive' | 'negative' | 'neutral' };
  /** 30 点位的稀疏化数值序列，用于渲染 KPI 内嵌 sparkline */
  spark?: { values: number[]; tone: 'primary' | 'positive' | 'neutral' | 'warning' };
}

interface ReportData {
  username: string;
  generated_at: string;
  meta: Record<string, string | null>;
  /** 自动生成的"本期摘要"叙事段落 */
  narrative: string;
  totals: {
    repos: number;
    languages: number;
    owners: number;
    stars_sum: number;
  };
  kpis: KpiBlock[];
  activity: {
    by_date: { date: string; count: number }[];
    cumulative: { date: string; total: number }[];
    velocity_30d: { date: string; value: number }[];
    insight: string;
  };
  discovery: {
    by_dow: { dow: number; label: string; count: number }[];
    by_hour: { hour: number; count: number }[];
    insight: string;
  };
  composition: {
    by_language: { language: string; count: number; stars: number; pct: number }[];
    top_owners: { owner: string; avatar: string; count: number; stars: number }[];
    language_top5_pct: number;
    owner_top10_pct: number;
    insight_language: string;
    insight_owner: string;
  };
  health: {
    popularity: { tier: string; label: string; count: number; pct: number }[];
    freshness: { bucket: string; label: string; count: number; pct: number }[];
    repo_age: { year: number; count: number }[];
    insight_popularity: string;
    insight_freshness: string;
  };
  lists: {
    recent_stars: RepoRow[];
    top_repos: RepoRow[];
    recent_changes: ChangeRow[];
  };
}

const DOW_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 报表统计与展示统一使用东八区（GitHub API 时间为 UTC） */
const REPORT_TZ = 'Asia/Shanghai';
const SQL_TZ_OFFSET = '+8 hours';

/** SQLite：UTC 列转为东八区 datetime 表达式 */
function sqlAtTz(column: string): string {
  return `datetime(${column}, '${SQL_TZ_OFFSET}')`;
}

/** SQLite：东八区下的 date(列) */
function sqlDateAtTz(column: string): string {
  return `date(${sqlAtTz(column)})`;
}

/** SQLite：相对东八区「当前」的 datetime 锚点 */
function sqlNowAtTz(): string {
  return `datetime('now', '${SQL_TZ_OFFSET}')`;
}

// ============================================================
// 数据采集与分析
// ============================================================

function collect(username: string, dbPath: string): ReportData {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    // ---------- 元数据 ----------
    const meta: Record<string, string | null> = {};
    for (const r of db.query<{ key: string; value: string | null }, []>('SELECT key, value FROM meta').all()) {
      meta[r.key] = r.value;
    }

    // ---------- 总量 ----------
    const total = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM repos').get()?.c ?? 0;
    const langCount = db.query<{ c: number }, []>('SELECT COUNT(DISTINCT language) c FROM repos WHERE language IS NOT NULL').get()?.c ?? 0;
    const ownerCount = db.query<{ c: number }, []>('SELECT COUNT(DISTINCT owner_login) c FROM repos').get()?.c ?? 0;
    const starsSum = db.query<{ s: number }, []>('SELECT COALESCE(SUM(stargazers_count),0) s FROM repos').get()?.s ?? 0;

    // ---------- KPI（带 delta） ----------
    const starredLocal = sqlAtTz('starred_at');
    const nowLocal = sqlNowAtTz();
    const periodCounts = db.query<{ p30: number; p60: number; p365: number; p730: number; this_year: number; last_year: number }, []>(`
      SELECT
        SUM(CASE WHEN ${starredLocal} >= datetime(${nowLocal}, '-30 days') THEN 1 ELSE 0 END) p30,
        SUM(CASE WHEN ${starredLocal} >= datetime(${nowLocal}, '-60 days') AND ${starredLocal} < datetime(${nowLocal}, '-30 days') THEN 1 ELSE 0 END) p60,
        SUM(CASE WHEN ${starredLocal} >= datetime(${nowLocal}, '-365 days') THEN 1 ELSE 0 END) p365,
        SUM(CASE WHEN ${starredLocal} >= datetime(${nowLocal}, '-730 days') AND ${starredLocal} < datetime(${nowLocal}, '-365 days') THEN 1 ELSE 0 END) p730,
        SUM(CASE WHEN ${starredLocal} >= datetime(${nowLocal}, 'start of year') THEN 1 ELSE 0 END) this_year,
        SUM(CASE WHEN ${starredLocal} >= datetime(${nowLocal}, 'start of year', '-1 years') AND ${starredLocal} < datetime(${nowLocal}, 'start of year') THEN 1 ELSE 0 END) last_year
      FROM repos
    `).get()!;
    const last30 = periodCounts.p30;
    const prev30 = periodCounts.p60;
    const last365 = periodCounts.p365;
    const prev365 = periodCounts.p730;
    const thisYear = periodCounts.this_year;
    const lastYear = periodCounts.last_year;

    const pushedLocal = sqlAtTz('pushed_at');
    const stale2y = db.query<{ c: number }, []>(`
      SELECT COUNT(*) c FROM repos WHERE ${pushedLocal} < datetime(${nowLocal}, '-730 days')
    `).get()?.c ?? 0;
    const stalePct = total > 0 ? Math.round((stale2y / total) * 100) : 0;

    // 顶级语言占比
    const topLang = db.query<{ lang: string; c: number }, []>(`
      SELECT COALESCE(language,'Unknown') lang, COUNT(*) c FROM repos
      WHERE language IS NOT NULL
      GROUP BY language ORDER BY c DESC LIMIT 1
    `).get();
    const topLangPct = topLang && total > 0 ? Math.round((topLang.c / total) * 100) : 0;

    const dailyAvg30 = +(last30 / 30).toFixed(1);

    // ---------- Activity（提前到 KPI 之前算，用于 sparkline） ----------
    const byDate = db.query<{ date: string; count: number }, []>(`
      SELECT ${sqlDateAtTz('starred_at')} date, COUNT(*) count FROM repos
      GROUP BY date ORDER BY date
    `).all();

    // KPI sparkline 数据：连续 30 天序列（缺失日填 0）
    const dailyLast30 = fillDailySeries(byDate, 30);
    const rollingAvg30 = rolling7DaySeries(byDate, 30);
    const cumulativeLast90 = cumulativeSeries(byDate, 90);
    const totalsSinceJan = cumulativeSeries(byDate, daysSinceCstYearStart());

    const kpis: KpiBlock[] = [
      {
        label: '总 Stars',
        value: total,
        hint: `${fmtNum(starsSum)} 累计 ★`,
        spark: { values: cumulativeLast90, tone: 'primary' },
      },
      {
        label: '今年新增',
        value: thisYear,
        hint: lastYear > 0 ? `去年同期 ${fmtNum(lastYear)}` : '去年无数据',
        delta: makeDelta(thisYear, lastYear),
        spark: { values: totalsSinceJan, tone: 'positive' },
      },
      {
        label: '近 30 天',
        value: last30,
        hint: `前 30 天 ${fmtNum(prev30)}`,
        delta: makeDelta(last30, prev30),
        spark: { values: dailyLast30, tone: 'primary' },
      },
      {
        label: '日均发现',
        value: `${dailyAvg30}`,
        hint: '近 30 天 7d 滚动均值',
        spark: { values: rollingAvg30, tone: 'neutral' },
      },
      {
        label: '陈旧 Stars',
        value: `${stalePct}%`,
        hint: `${fmtNum(stale2y)} 个 2 年未推送`,
        delta:
          stalePct >= 30
            ? { value: stalePct, direction: 'flat', tone: 'negative' }
            : stalePct >= 15
              ? { value: stalePct, direction: 'flat', tone: 'neutral' }
              : { value: stalePct, direction: 'flat', tone: 'positive' },
      },
      {
        label: '主力语言',
        value: topLang?.lang ?? '—',
        hint: topLang ? `占 ${topLangPct}%（${fmtNum(topLang.c)} 个）` : '',
      },
    ];

    const cumulative: { date: string; total: number }[] = [];
    let acc = 0;
    for (const d of byDate) {
      acc += d.count;
      cumulative.push({ date: d.date, total: acc });
    }

    const velocity30 = db.query<{ d: string; v: number }, []>(`
      WITH daily AS (
        SELECT ${sqlDateAtTz('starred_at')} d, COUNT(*) n FROM repos GROUP BY d
      )
      SELECT d, SUM(n) OVER (ORDER BY d ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) v FROM daily
    `).all().map((r) => ({ date: r.d, value: r.v }));

    // Activity 洞察：找到历史上单天最高 + 当前节奏对比
    const peakDay = byDate.reduce((a, b) => (b.count > a.count ? b : a), { date: '', count: 0 });
    const recentVelocity = velocity30.length > 0 ? velocity30[velocity30.length - 1]!.value : 0;
    const peakVelocity = velocity30.reduce((m, x) => Math.max(m, x.value), 0);
    const velocityRatio = peakVelocity > 0 ? Math.round((recentVelocity / peakVelocity) * 100) : 0;
    const activityInsight =
      peakDay.count > 0
        ? `历史单日峰值 ${peakDay.count} 个（${peakDay.date}）；当前 30 天节奏为历史峰值的 ${velocityRatio}%。`
        : '尚无足够数据生成洞察。';

    // ---------- Discovery ----------
    const dowRaw = db.query<{ dow: number; c: number }, []>(`
      SELECT CAST(strftime('%w', ${starredLocal}) AS INTEGER) dow, COUNT(*) c
      FROM repos GROUP BY dow ORDER BY dow
    `).all();
    const dowMap = new Map(dowRaw.map((r) => [r.dow, r.c]));
    const byDow = DOW_LABELS.map((label, dow) => ({ dow, label, count: dowMap.get(dow) ?? 0 }));

    const hourRaw = db.query<{ h: number; c: number }, []>(`
      SELECT CAST(strftime('%H', ${starredLocal}) AS INTEGER) h, COUNT(*) c
      FROM repos GROUP BY h ORDER BY h
    `).all();
    const hourMap = new Map(hourRaw.map((r) => [r.h, r.c]));
    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hourMap.get(h) ?? 0 }));

    const topDow = byDow.reduce((a, b) => (b.count > a.count ? b : a));
    const totalForDowPct = byDow.reduce((s, d) => s + d.count, 0);
    const topDowPct = totalForDowPct > 0 ? Math.round((topDow.count / totalForDowPct) * 100) : 0;

    const peakHour = byHour.reduce((a, b) => (b.count > a.count ? b : a));
    const period =
      peakHour.hour < 6 ? '凌晨' : peakHour.hour < 12 ? '上午' : peakHour.hour < 18 ? '下午' : '晚间';
    const discoveryInsight = `你最常在 ${topDow.label} 发现新仓库（占 ${topDowPct}%），活跃时段集中在 ${period}（东八区 ${peakHour.hour}:00 前后）。`;

    // ---------- Composition ----------
    const byLanguageRaw = db.query<{ language: string; count: number; stars: number }, []>(`
      SELECT COALESCE(language,'Unknown') language, COUNT(*) count, COALESCE(SUM(stargazers_count),0) stars
      FROM repos GROUP BY language ORDER BY count DESC LIMIT 30
    `).all();
    const byLanguage = byLanguageRaw.map((l) => ({
      ...l,
      pct: total > 0 ? +((l.count / total) * 100).toFixed(1) : 0,
    }));
    const lang5 = byLanguage.slice(0, 5).reduce((s, l) => s + l.count, 0);
    const langTop5Pct = total > 0 ? Math.round((lang5 / total) * 100) : 0;

    const topOwners = db.query<{ owner: string; avatar: string; count: number; stars: number }, []>(`
      SELECT owner_login owner, MAX(owner_avatar_url) avatar,
             COUNT(*) count, COALESCE(SUM(stargazers_count),0) stars
      FROM repos GROUP BY owner_login ORDER BY count DESC, stars DESC LIMIT 20
    `).all();
    const owner10 = topOwners.slice(0, 10).reduce((s, o) => s + o.count, 0);
    const ownerTop10Pct = total > 0 ? Math.round((owner10 / total) * 100) : 0;

    const insightLanguage =
      langTop5Pct >= 70
        ? `Top 5 语言覆盖 ${langTop5Pct}% — 技术栈高度聚焦，建议关注跨栈视野。`
        : langTop5Pct >= 50
          ? `Top 5 语言覆盖 ${langTop5Pct}% — 主线清晰且适度多元。`
          : `Top 5 语言覆盖 ${langTop5Pct}% — 兴趣广泛，技术涉猎多元。`;
    const insightOwner =
      ownerTop10Pct >= 40
        ? `Top 10 作者贡献 ${ownerTop10Pct}% — 高度依赖少数高产组织。`
        : ownerTop10Pct >= 20
          ? `Top 10 作者贡献 ${ownerTop10Pct}% — 来源相对集中。`
          : `Top 10 作者贡献 ${ownerTop10Pct}% — 来源高度分散，发现面广。`;

    // ---------- Health ----------
    const popularityRaw = db.query<{ tier: string; c: number }, []>(`
      SELECT
        CASE
          WHEN stargazers_count >= 50000 THEN 'mega'
          WHEN stargazers_count >= 10000 THEN 'mainstream'
          WHEN stargazers_count >= 1000  THEN 'popular'
          WHEN stargazers_count >= 100   THEN 'growing'
          ELSE 'niche'
        END tier,
        COUNT(*) c
      FROM repos GROUP BY tier
    `).all();
    const popOrder = ['niche', 'growing', 'popular', 'mainstream', 'mega'];
    const popLabel: Record<string, string> = {
      niche: '小众 (<100)',
      growing: '上升 (100-1k)',
      popular: '热门 (1k-10k)',
      mainstream: '主流 (10k-50k)',
      mega: '殿堂 (>50k)',
    };
    const popMap = new Map(popularityRaw.map((p) => [p.tier, p.c]));
    const popularity = popOrder.map((t) => {
      const c = popMap.get(t) ?? 0;
      return { tier: t, label: popLabel[t]!, count: c, pct: total > 0 ? +((c / total) * 100).toFixed(1) : 0 };
    });
    const nichePct = popularity.find((p) => p.tier === 'niche')?.pct ?? 0;
    const mainstreamPct = (popularity.find((p) => p.tier === 'mainstream')?.pct ?? 0) + (popularity.find((p) => p.tier === 'mega')?.pct ?? 0);
    const insightPopularity =
      nichePct >= 30
        ? `${nichePct}% 是小众项目（<100★）— 你是早期发现者倾向的探索者。`
        : mainstreamPct >= 30
          ? `${mainstreamPct}% 是 10k★ 以上的主流项目 — 关注趋势与成熟方案。`
          : `分布相对均衡，兼顾趋势与小众。`;

    const freshnessRaw = db.query<{ b: string; c: number }, []>(`
      SELECT
        CASE
          WHEN ${pushedLocal} >= datetime(${nowLocal}, '-90 days')   THEN 'active'
          WHEN ${pushedLocal} >= datetime(${nowLocal}, '-365 days')  THEN 'recent'
          WHEN ${pushedLocal} >= datetime(${nowLocal}, '-730 days')  THEN 'stale1'
          WHEN ${pushedLocal} >= datetime(${nowLocal}, '-1825 days') THEN 'stale3'
          ELSE 'abandoned'
        END b,
        COUNT(*) c
      FROM repos GROUP BY b
    `).all();
    const freshOrder = ['active', 'recent', 'stale1', 'stale3', 'abandoned'];
    const freshLabel: Record<string, string> = {
      active: '活跃 (90 天)',
      recent: '近期 (1 年)',
      stale1: '陈旧 (1-2 年)',
      stale3: '冷却 (2-5 年)',
      abandoned: '可能弃坑 (5 年+)',
    };
    const freshMap = new Map(freshnessRaw.map((r) => [r.b, r.c]));
    const freshness = freshOrder.map((b) => {
      const c = freshMap.get(b) ?? 0;
      return { bucket: b, label: freshLabel[b]!, count: c, pct: total > 0 ? +((c / total) * 100).toFixed(1) : 0 };
    });
    const abandonedCount = (freshMap.get('stale3') ?? 0) + (freshMap.get('abandoned') ?? 0);
    const abandonedPct = total > 0 ? Math.round((abandonedCount / total) * 100) : 0;
    const insightFreshness =
      abandonedPct >= 25
        ? `${abandonedPct}% 仓库 2 年以上未推送（${fmtNum(abandonedCount)} 个）— 建议批量清理腾出关注带宽。`
        : abandonedPct >= 10
          ? `${abandonedPct}% 仓库长期未更新，可定期复核。`
          : `仓库活跃度健康，绝大多数仍在维护中。`;

    const repoAge = db.query<{ year: number; count: number }, []>(`
      SELECT CAST(strftime('%Y', datetime(json_extract(raw_json,'$.created_at'), '${SQL_TZ_OFFSET}')) AS INTEGER) year, COUNT(*) count
      FROM repos
      WHERE json_extract(raw_json,'$.created_at') IS NOT NULL
      GROUP BY year ORDER BY year
    `).all();

    // ---------- 列表 ----------
    const repoCols =
      `id, full_name, html_url, description, language, stargazers_count, starred_at, pushed_at, owner_login, owner_avatar_url`;
    const topRepos = db.query<RepoRow, []>(`SELECT ${repoCols} FROM repos ORDER BY stargazers_count DESC LIMIT 50`).all();
    const recentStars = db.query<RepoRow, []>(`SELECT ${repoCols} FROM repos ORDER BY starred_at DESC LIMIT 24`).all();
    const recentChanges = db.query<ChangeRow, []>(`
      SELECT generated_at, mode, kind, full_name, details_json FROM changes ORDER BY id DESC LIMIT 40
    `).all();

    // ---------- 叙事摘要（AI-narrative style） ----------
    const narrative = buildNarrative({
      total,
      last30,
      prev30,
      dailyAvg30,
      thisYear,
      lastYear,
      topLang: topLang ? { lang: topLang.lang, pct: topLangPct } : null,
      topDow: { label: topDow.label, pct: topDowPct },
      peakHour: peakHour.hour,
      abandonedCount,
      abandonedPct,
      langTop5Pct,
      ownerTop10Pct,
    });

    return {
      username,
      generated_at: new Date().toISOString(),
      meta,
      narrative,
      totals: { repos: total, languages: langCount, owners: ownerCount, stars_sum: starsSum },
      kpis,
      activity: { by_date: byDate, cumulative, velocity_30d: velocity30, insight: activityInsight },
      discovery: { by_dow: byDow, by_hour: byHour, insight: discoveryInsight },
      composition: {
        by_language: byLanguage,
        top_owners: topOwners,
        language_top5_pct: langTop5Pct,
        owner_top10_pct: ownerTop10Pct,
        insight_language: insightLanguage,
        insight_owner: insightOwner,
      },
      health: {
        popularity,
        freshness,
        repo_age: repoAge,
        insight_popularity: insightPopularity,
        insight_freshness: insightFreshness,
      },
      lists: { recent_stars: recentStars, top_repos: topRepos, recent_changes: recentChanges },
    };
  } finally {
    db.close();
  }
}

function makeDelta(curr: number, prev: number): KpiBlock['delta'] {
  if (prev === 0) {
    return curr > 0
      ? { value: 100, direction: 'up', tone: 'positive' }
      : { value: 0, direction: 'flat', tone: 'neutral' };
  }
  const diff = ((curr - prev) / prev) * 100;
  const value = Math.round(Math.abs(diff));
  if (Math.abs(diff) < 2) return { value, direction: 'flat', tone: 'neutral' };
  if (diff > 0) return { value, direction: 'up', tone: 'positive' };
  return { value, direction: 'down', tone: 'negative' };
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

/** 东八区日历日 YYYY-MM-DD（与 SQL date(datetime(..., '+8 hours')) 对齐） */
function cstDateKey(ms: number = Date.now()): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: REPORT_TZ });
}

/** 东八区 date key → 该日 12:00 的 UTC 毫秒（中国无夏令时，固定 +8） */
function cstDateKeyToNoonUtcMs(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!, 4, 0, 0);
}

/** 东八区当年 1 月 1 日至今的天数（含今天） */
function daysSinceCstYearStart(): number {
  const todayKey = cstDateKey();
  const year = todayKey.slice(0, 4);
  const startKey = `${year}-01-01`;
  const days = Math.round((cstDateKeyToNoonUtcMs(todayKey) - cstDateKeyToNoonUtcMs(startKey)) / 86_400_000) + 1;
  return Math.max(1, Math.min(days, 366));
}

/** 把按日聚合的稀疏序列展开为最近 N 天的密集序列（缺失日 = 0，东八区） */
function fillDailySeries(byDate: { date: string; count: number }[], days: number): number[] {
  const map = new Map(byDate.map((d) => [d.date, d.count]));
  const result: number[] = [];
  const todayNoon = cstDateKeyToNoonUtcMs(cstDateKey());
  for (let i = days - 1; i >= 0; i--) {
    const key = cstDateKey(todayNoon - i * 86_400_000);
    result.push(map.get(key) ?? 0);
  }
  return result;
}

/** 7 日滚动平均序列（最近 N 天） */
function rolling7DaySeries(byDate: { date: string; count: number }[], days: number): number[] {
  const padded = fillDailySeries(byDate, days + 6);
  const result: number[] = [];
  for (let i = 6; i < padded.length; i++) {
    let sum = 0;
    for (let j = i - 6; j <= i; j++) sum += padded[j]!;
    result.push(+(sum / 7).toFixed(2));
  }
  return result;
}

/** 累积序列（最近 N 天，基于总累积值） */
function cumulativeSeries(byDate: { date: string; count: number }[], days: number): number[] {
  // 先算出全量累积，再切窗
  const total = byDate.reduce((s, d) => s + d.count, 0);
  const recent = fillDailySeries(byDate, days);
  const tailSum = recent.reduce((s, n) => s + n, 0);
  let acc = total - tailSum;
  return recent.map((n) => (acc += n));
}

interface NarrativeInput {
  total: number;
  last30: number;
  prev30: number;
  dailyAvg30: number;
  thisYear: number;
  lastYear: number;
  topLang: { lang: string; pct: number } | null;
  topDow: { label: string; pct: number };
  peakHour: number;
  abandonedCount: number;
  abandonedPct: number;
  langTop5Pct: number;
  ownerTop10Pct: number;
}

/** 用模板拼接"本期摘要"叙事段落，模拟 AI 报表导语 */
function buildNarrative(n: NarrativeInput): string {
  const parts: string[] = [];

  // 1. 周期变化（最关键的"本期"信号）
  if (n.prev30 > 0) {
    const diff = ((n.last30 - n.prev30) / n.prev30) * 100;
    const arrow = Math.abs(diff) < 2 ? '基本持平' : diff > 0 ? `↑ ${Math.round(diff)}%` : `↓ ${Math.round(Math.abs(diff))}%`;
    parts.push(`过去 30 天新增 ${n.last30} 个 ★，相比前 30 天 ${arrow}（日均 ${n.dailyAvg30} 个）`);
  } else {
    parts.push(`过去 30 天新增 ${n.last30} 个 ★（日均 ${n.dailyAvg30} 个）`);
  }

  // 2. 同比
  if (n.lastYear > 0) {
    const diff = ((n.thisYear - n.lastYear) / n.lastYear) * 100;
    if (Math.abs(diff) >= 10) {
      const arrow = diff > 0 ? `↑ ${Math.round(diff)}%` : `↓ ${Math.round(Math.abs(diff))}%`;
      parts.push(`今年已收 ${n.thisYear} 个，同比去年 ${arrow}`);
    }
  }

  // 3. 技术栈
  if (n.topLang) {
    const distribution =
      n.langTop5Pct >= 70 ? '高度聚焦' : n.langTop5Pct >= 50 ? '主线清晰' : '兴趣广泛';
    parts.push(`技术栈以 ${n.topLang.lang} 为主线（${n.topLang.pct}%），整体${distribution}`);
  }

  // 4. 探索画像
  const period = n.peakHour < 6 ? '凌晨' : n.peakHour < 12 ? '上午' : n.peakHour < 18 ? '下午' : '晚间';
  parts.push(`${n.topDow.label}${period}（东八区）是发现高峰`);

  // 5. 健康信号（可操作建议）
  if (n.abandonedPct >= 25) {
    parts.push(`⚠️ 有 ${fmtNum(n.abandonedCount)} 个仓库已 2 年未推送，可考虑批量清理`);
  } else if (n.abandonedPct >= 10) {
    parts.push(`${n.abandonedPct}% 仓库长期未更新，建议定期复核`);
  } else {
    parts.push(`仓库活跃度健康`);
  }

  return parts.join('；') + '。';
}

// ============================================================
// HTML 渲染
// ============================================================

/** 国际 CDN：jsDelivr → unpkg（npm 官方）→ Cloudflare cdnjs */
const REPORT_CDN = {
  echartsVersion: '5.5.1',
  fontVersion: '5.2.5',
} as const;

function render(data: ReportData): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const ev = REPORT_CDN.echartsVersion;
  const fv = REPORT_CDN.fontVersion;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(data.username)} · Stars Analytics</title>
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
<link rel="preconnect" href="https://unpkg.com" crossorigin />
<link rel="dns-prefetch" href="https://cdnjs.cloudflare.com" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@${fv}/index.css" crossorigin="anonymous" onerror="this.onerror=null;this.href='https://unpkg.com/@fontsource-variable/geist@${fv}/index.css'" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource-variable/geist-mono@${fv}/index.css" crossorigin="anonymous" onerror="this.onerror=null;this.href='https://unpkg.com/@fontsource-variable/geist-mono@${fv}/index.css'" />
<script>
(function(){
  var srcs=[
    'https://cdn.jsdelivr.net/npm/echarts@${ev}/dist/echarts.min.js',
    'https://unpkg.com/echarts@${ev}/dist/echarts.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/echarts/${ev}/echarts.min.js'
  ];
  var i=0;
  function next(){
    if(typeof echarts!=='undefined'){ window.dispatchEvent(new Event('echarts-ready')); return; }
    if(i>=srcs.length){ document.documentElement.classList.add('cdn-failed'); window.dispatchEvent(new Event('echarts-failed')); return; }
    var s=document.createElement('script');
    s.src=srcs[i++]; s.crossOrigin='anonymous';
    s.onload=function(){ window.dispatchEvent(new Event('echarts-ready')); };
    s.onerror=next;
    document.head.appendChild(s);
  }
  next();
})();
</script>
<style>
  /* shadcn/ui 设计 token（dark-first，参照 v4 "new-york" oklch 配色） */
  :root {
    color-scheme: dark;
    --background:          oklch(0.145 0 0);
    --foreground:          oklch(0.985 0 0);
    --card:                oklch(0.205 0 0);
    --card-foreground:     oklch(0.985 0 0);
    --popover:             oklch(0.205 0 0);
    --popover-foreground:  oklch(0.985 0 0);
    --primary:             oklch(0.922 0 0);
    --primary-foreground:  oklch(0.205 0 0);
    --secondary:           oklch(0.269 0 0);
    --secondary-foreground:oklch(0.985 0 0);
    --muted:               oklch(0.269 0 0);
    --muted-foreground:    oklch(0.708 0 0);
    --accent:              oklch(0.269 0 0);
    --accent-foreground:   oklch(0.985 0 0);
    --destructive:         oklch(0.704 0.191 22.216);
    --success:             oklch(0.696 0.17 162.48);
    --warning:             oklch(0.769 0.188 70.08);
    --border:              oklch(1 0 0 / 8%);
    --border-strong:       oklch(1 0 0 / 14%);
    --input:               oklch(1 0 0 / 15%);
    --ring:                oklch(0.556 0 0);
    /* Chart 色板：来自 shadcn v4 默认主题（OKLCH 感知均匀） */
    --chart-1: oklch(0.488 0.243 264.376);
    --chart-2: oklch(0.696 0.17 162.48);
    --chart-3: oklch(0.769 0.188 70.08);
    --chart-4: oklch(0.627 0.265 303.9);
    --chart-5: oklch(0.645 0.246 16.439);
    --radius: 0.625rem;
    --radius-sm: calc(var(--radius) - 4px);
    --radius-md: calc(var(--radius) - 2px);
    --radius-lg: var(--radius);
    --radius-xl: calc(var(--radius) + 4px);
    /* ---- 兼容别名（仍被部分图表/列表 CSS 使用） ---- */
    --bg: var(--background);
    --surface: var(--card);
    --surface-2: var(--secondary);
    --surface-hover: var(--accent);
    --fg: var(--foreground);
    --fg-muted: oklch(0.78 0 0);
    --fg-dim: oklch(0.62 0 0);
    --fg-faint: oklch(0.45 0 0);
    --blue: var(--chart-1);
    --emerald: var(--success);
    --amber: var(--warning);
    --rose: var(--destructive);
    --violet: var(--chart-4);
    --cyan: oklch(0.72 0.13 220);
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: 'Geist Variable', system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-feature-settings: 'cv11', 'ss01', 'ss03';
    color: var(--foreground);
    background: var(--background);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  .mono { font-family: 'Geist Mono Variable', ui-monospace, monospace; font-variant-numeric: tabular-nums; font-feature-settings: 'tnum', 'zero', 'ss01'; }
  html.cdn-failed .chart { position: relative; }
  html.cdn-failed .chart::after {
    content: '图表库加载失败，请检查网络或稍后刷新';
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--muted-foreground); font-size: 13px; background: oklch(0.145 0 0 / 85%);
  }
  .container { max-width: 1280px; margin: 0 auto; padding: 32px 24px 96px; }

  /* ---------- Hero ---------- */
  .hero {
    display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 24px;
    padding-bottom: 28px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 32px;
  }
  .hero-left { display: flex; flex-direction: column; gap: 6px; }
  .hero-brand { display: flex; align-items: center; gap: 10px; color: var(--fg-dim); font-size: 13px; font-weight: 500; }
  .hero-brand-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--emerald); box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.15); }
  .hero-title { font-size: 32px; font-weight: 700; letter-spacing: -0.025em; line-height: 1.15; }
  .hero-sub { color: var(--fg-muted); font-size: 14px; }
  .hero-right {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; border-radius: 10px;
    background: var(--surface); border: 1px solid var(--border);
    font-size: 12px; color: var(--fg-muted);
  }
  .hero-right .sep { width: 1px; height: 14px; background: var(--border); }

  /* ---------- Narrative（本期摘要叙事段落，shadcn alert 风格） ---------- */
  .narrative {
    display: flex; gap: 14px;
    padding: 18px 22px;
    background: var(--card); border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    margin-bottom: 28px;
    position: relative; overflow: hidden;
  }
  .narrative::before {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(90deg, oklch(0.488 0.243 264.376 / 8%), transparent 30%);
    pointer-events: none;
  }
  .narrative-icon {
    flex-shrink: 0; width: 32px; height: 32px; border-radius: var(--radius-md);
    background: oklch(0.488 0.243 264.376 / 15%);
    color: var(--chart-1);
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; font-weight: 600;
    position: relative; z-index: 1;
  }
  .narrative-body { flex: 1; min-width: 0; position: relative; z-index: 1; }
  .narrative-label {
    display: inline-block; color: var(--muted-foreground);
    font-size: 11px; font-weight: 500; letter-spacing: 0.06em;
    text-transform: uppercase; margin-bottom: 4px;
  }
  .narrative-text {
    color: var(--foreground); font-size: 14px; line-height: 1.65;
    font-weight: 400;
  }

  /* ---------- KPI grid ---------- */
  .kpi-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1px; background: var(--border);
    border: 1px solid var(--border); border-radius: var(--radius-lg);
    overflow: hidden; margin-bottom: 40px;
  }
  .kpi {
    background: var(--card); padding: 18px 20px; min-height: 130px;
    display: flex; flex-direction: column; justify-content: space-between;
    position: relative; overflow: hidden;
    transition: background 160ms ease;
  }
  .kpi:hover { background: oklch(0.21 0 0); }
  .kpi-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .kpi-label { color: var(--muted-foreground); font-size: 12px; font-weight: 500; letter-spacing: 0.01em; }
  .kpi-row { display: flex; align-items: baseline; gap: 8px; margin-top: 6px; }
  .kpi-value { font-size: 32px; font-weight: 600; letter-spacing: -0.03em; line-height: 1.05; color: var(--foreground); }
  .kpi-value.small { font-size: 22px; font-weight: 600; }
  .kpi-delta { display: inline-flex; align-items: center; gap: 2px; font-size: 11.5px; font-weight: 500; padding: 1.5px 6px; border-radius: var(--radius-sm); font-variant-numeric: tabular-nums; }
  .kpi-delta.positive { color: var(--success); background: oklch(0.696 0.17 162.48 / 12%); }
  .kpi-delta.negative { color: var(--destructive); background: oklch(0.704 0.191 22.216 / 12%); }
  .kpi-delta.neutral { color: var(--muted-foreground); background: oklch(1 0 0 / 4%); }
  .kpi-hint { color: var(--muted-foreground); font-size: 12px; margin-top: 4px; }
  /* sparkline 容器 */
  .kpi-spark { height: 28px; margin-top: 8px; opacity: 0.95; }
  .kpi-spark svg { width: 100%; height: 100%; display: block; overflow: visible; }
  .kpi-spark-icon { flex-shrink: 0; width: 22px; height: 22px; border-radius: var(--radius-sm); background: oklch(1 0 0 / 4%); display: inline-flex; align-items: center; justify-content: center; color: var(--muted-foreground); font-size: 13px; }

  /* ---------- Section ---------- */
  .section { margin-bottom: 40px; }
  .section-head { margin-bottom: 16px; }
  .section-eyebrow { display: inline-block; padding: 3px 8px; border-radius: 5px; background: var(--surface-2); border: 1px solid var(--border); color: var(--fg-muted); font-size: 11px; font-weight: 500; letter-spacing: 0.05em; text-transform: uppercase; margin-bottom: 10px; }
  .section-title { font-size: 22px; font-weight: 600; letter-spacing: -0.015em; }
  .section-desc { color: var(--fg-muted); font-size: 14px; margin-top: 4px; max-width: 720px; }

  /* ---------- Card ---------- */
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .card-head { padding: 18px 20px 4px; }
  .card-title { font-size: 14px; font-weight: 600; }
  .card-sub { color: var(--fg-dim); font-size: 12px; margin-top: 2px; }
  .card-body { padding: 12px 8px 12px; }
  .card-allow-overflow { overflow: visible; }
  .card-body-chart { overflow: visible; }
  .chart-heatmap { min-height: 200px; }
  .heatmap-legend {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 10px 50px 6px;
  }
  .heatmap-legend-label { color: var(--muted-foreground); font-size: 11px; font-weight: 500; }
  .heatmap-legend-bar {
    height: 10px;
    border-radius: 4px;
    background: linear-gradient(90deg, #1a1a1c 0%, #1e3a8a 25%, #3b82f6 50%, #06b6d4 75%, #a78bfa 100%);
    border: 1px solid var(--border);
  }
  .card-foot { padding: 12px 20px 18px; border-top: 1px solid var(--border); margin-top: 8px; color: var(--fg-muted); font-size: 12.5px; display: flex; align-items: flex-start; gap: 8px; }
  .card-foot::before {
    content: '✦'; color: var(--fg-faint); flex-shrink: 0; line-height: 1.5;
  }

  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  @media (max-width: 960px) {
    .grid-2 { grid-template-columns: 1fr; }
    .grid-3 { grid-template-columns: 1fr; }
  }

  .chart { width: 100%; height: 280px; }
  .chart-md { height: 320px; }
  .chart-tall { height: 360px; }

  /* ---------- Repo list ---------- */
  .repo-list { display: flex; flex-direction: column; max-height: 540px; overflow-y: auto; }
  .repo-list::-webkit-scrollbar { width: 8px; }
  .repo-list::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }
  .repo {
    display: flex; gap: 12px; align-items: center;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    text-decoration: none; color: inherit;
    transition: background 120ms ease;
  }
  .repo:last-child { border-bottom: none; }
  .repo:hover { background: var(--surface-hover); }
  .repo-avatar { width: 32px; height: 32px; border-radius: 6px; flex-shrink: 0; background: var(--surface-2); }
  .repo-info { flex: 1; min-width: 0; }
  .repo-name { font-weight: 500; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .repo-desc { color: var(--fg-muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .repo-meta { display: flex; align-items: center; gap: 12px; color: var(--fg-dim); font-size: 11.5px; flex-shrink: 0; }
  .repo-meta .stars { color: var(--fg-muted); font-weight: 500; }
  .repo-meta .lang-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }

  .changes-list { display: flex; flex-direction: column; max-height: 540px; overflow-y: auto; }
  .change { display: flex; align-items: center; gap: 10px; padding: 10px 20px; border-bottom: 1px solid var(--border); font-size: 13px; }
  .change:last-child { border-bottom: none; }
  .change-kind { display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; font-family: 'JetBrains Mono', monospace; }
  .change-kind.added { background: rgba(16, 185, 129, 0.12); color: var(--emerald); }
  .change-kind.removed { background: rgba(244, 63, 94, 0.12); color: var(--rose); }
  .change-kind.updated { background: rgba(59, 130, 246, 0.12); color: var(--blue); }
  .change-name { font-weight: 500; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .change-time { color: var(--fg-dim); font-size: 11px; }

  .empty { padding: 60px 20px; text-align: center; color: var(--fg-dim); font-size: 13px; }
  .footer { color: var(--fg-dim); font-size: 12px; text-align: center; padding-top: 32px; border-top: 1px solid var(--border); }
  .footer a { color: var(--fg-muted); text-decoration: none; border-bottom: 1px solid var(--border-strong); }
  .footer a:hover { color: var(--fg); }
</style>
</head>
<body>
<div class="container">

  <!-- ============ Hero ============ -->
  <header class="hero">
    <div class="hero-left">
      <div class="hero-brand"><span class="hero-brand-dot"></span> Stars Analytics</div>
      <h1 class="hero-title">${escapeHtml(data.username)}</h1>
      <div class="hero-sub">${data.totals.repos} 个仓库 · ${data.totals.languages} 种语言 · ${data.totals.owners} 位作者</div>
    </div>
    <div class="hero-right">
      <span>同步于 <span id="sync-time" class="mono"></span></span>
      <span class="sep"></span>
      <span>生成于 <span id="gen-time" class="mono"></span></span>
    </div>
  </header>

  <!-- ============ Narrative：自动生成的本期摘要 ============ -->
  <div class="narrative" role="status" aria-label="本期摘要">
    <div class="narrative-icon" aria-hidden="true">✦</div>
    <div class="narrative-body">
      <span class="narrative-label">本期摘要</span>
      <div class="narrative-text">${escapeHtml(data.narrative)}</div>
    </div>
  </div>

  <!-- ============ KPIs ============ -->
  <div class="kpi-grid" id="kpi-grid"></div>

  <!-- ============ Activity ============ -->
  <section class="section">
    <div class="section-head">
      <span class="section-eyebrow">Activity</span>
      <div class="section-title">收藏活动与节奏</div>
      <p class="section-desc">看你在什么时间、以何种节奏发现新仓库；曲线的斜率反映学习与探索强度，平台期与爆发期都值得关注。</p>
    </div>
    <div class="card card-allow-overflow" style="margin-bottom: 16px;">
      <div class="card-head">
        <div class="card-title">每日 Star 热力图</div>
        <div class="card-sub">近 3 年按天聚合（东八区 UTC+8），越暖代表当天 star 越多</div>
      </div>
      <div class="card-body card-body-chart">
        <div id="chart-heatmap" class="chart chart-heatmap" style="height:auto"></div>
        <div class="heatmap-legend" role="img" aria-label="色阶：0 至当日峰值">
          <span class="heatmap-legend-label mono">0</span>
          <div class="heatmap-legend-bar"></div>
          <span class="heatmap-legend-label mono" id="heatmap-legend-max">—</span>
        </div>
      </div>
      <div class="card-foot">${escapeHtml(data.activity.insight)}</div>
    </div>
    <div class="card">
      <div class="card-head">
        <div class="card-title">累积总量 vs 30 天滚动速率</div>
        <div class="card-sub">蓝线：累积 stars；柱：近 30 天滚动总量（探索"心跳"）</div>
      </div>
      <div class="card-body"><div id="chart-growth" class="chart chart-tall"></div></div>
      <div class="card-foot">如果柱形持续走低，可能进入了"信息过载"或"探索疲劳"期，可尝试主题化筛选或定期回看。</div>
    </div>
  </section>

  <!-- ============ Discovery Patterns ============ -->
  <section class="section">
    <div class="section-head">
      <span class="section-eyebrow">Discovery</span>
      <div class="section-title">探索行为画像</div>
      <p class="section-desc">星标动作背后是你的学习时间分配；以下按东八区（UTC+8）统计，避免 UTC 偏移把白天操作算进凌晨。</p>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <div class="card-title">按周几分布</div>
          <div class="card-sub">每周哪一天最常发现新仓库</div>
        </div>
        <div class="card-body"><div id="chart-dow" class="chart"></div></div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">按时段分布</div>
          <div class="card-sub">24 小时探索热力（东八区），反映精力曲线</div>
        </div>
        <div class="card-body"><div id="chart-hour" class="chart"></div></div>
      </div>
    </div>
    <div class="card" style="margin-top: 16px;">
      <div class="card-foot" style="border-top: none; padding-top: 16px;">${escapeHtml(data.discovery.insight)}</div>
    </div>
  </section>

  <!-- ============ Stack Composition ============ -->
  <section class="section">
    <div class="section-head">
      <span class="section-eyebrow">Composition</span>
      <div class="section-title">技术栈与来源结构</div>
      <p class="section-desc">语言分布告诉你"技术兴趣"的形状；作者集中度则反映依赖少数高产者，还是来源高度多元。</p>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <div class="card-title">语言分布 Top 12</div>
          <div class="card-sub">按仓库数量排序，Top 5 占比 <span class="mono" style="color: var(--fg);">${data.composition.language_top5_pct}%</span></div>
        </div>
        <div class="card-body"><div id="chart-language" class="chart chart-tall"></div></div>
        <div class="card-foot">${escapeHtml(data.composition.insight_language)}</div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">Top 15 作者 / 组织</div>
          <div class="card-sub">按收藏数量排序，Top 10 占比 <span class="mono" style="color: var(--fg);">${data.composition.owner_top10_pct}%</span></div>
        </div>
        <div class="card-body"><div id="chart-owners" class="chart chart-tall"></div></div>
        <div class="card-foot">${escapeHtml(data.composition.insight_owner)}</div>
      </div>
    </div>
  </section>

  <!-- ============ Library Health ============ -->
  <section class="section">
    <div class="section-head">
      <span class="section-eyebrow">Health</span>
      <div class="section-title">收藏库健康度</div>
      <p class="section-desc">关注流行度分布与项目活跃度：陈旧 stars 拖累信息密度，定期清理能让收藏库始终保持有用。</p>
    </div>
    <div class="grid-3">
      <div class="card">
        <div class="card-head">
          <div class="card-title">流行度分层</div>
          <div class="card-sub">早期发现者 vs 趋势追随者</div>
        </div>
        <div class="card-body"><div id="chart-popularity" class="chart"></div></div>
        <div class="card-foot">${escapeHtml(data.health.insight_popularity)}</div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">更新新鲜度</div>
          <div class="card-sub">最近一次 push 距今的时间</div>
        </div>
        <div class="card-body"><div id="chart-freshness" class="chart"></div></div>
        <div class="card-foot">${escapeHtml(data.health.insight_freshness)}</div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">仓库出生年代</div>
          <div class="card-sub">收藏的仓库是经典还是新作</div>
        </div>
        <div class="card-body"><div id="chart-age" class="chart"></div></div>
        <div class="card-foot">老仓库不代表过时——很多基础设施级项目持续维护数十年。</div>
      </div>
    </div>
  </section>

  <!-- ============ Lists ============ -->
  <section class="section">
    <div class="section-head">
      <span class="section-eyebrow">Detail</span>
      <div class="section-title">明细浏览</div>
      <p class="section-desc">从聚合钻取到个体：最近、最高、最新变化。</p>
    </div>
    <div class="grid-3">
      <div class="card">
        <div class="card-head">
          <div class="card-title">最近 Star</div>
          <div class="card-sub">最新加入的 ${data.lists.recent_stars.length} 个</div>
        </div>
        <div class="repo-list" id="list-recent"></div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">Top 50 by Stars</div>
          <div class="card-sub">收藏库里的"全明星"</div>
        </div>
        <div class="repo-list" id="list-top"></div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">变更日志</div>
          <div class="card-sub">最近 ${data.lists.recent_changes.length} 条增删改</div>
        </div>
        <div class="changes-list" id="list-changes"></div>
      </div>
    </div>
  </section>

  <div class="footer">
    Generated by <a href="https://bun.sh">Bun</a> · Visualized with <a href="https://echarts.apache.org">ECharts</a>
  </div>
</div>

<script>
const DATA = ${json};

// ---------- 工具 ----------
const fmt = n => Number(n).toLocaleString('en-US');
const fmtCompact = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(n);
const TZ = 'Asia/Shanghai';
const fmtDate = iso => iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: TZ, month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12: false }) : '—';
const fmtDateOnly = iso => iso ? new Date(iso).toLocaleDateString('zh-CN', { timeZone: TZ }) : '—';
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
const langColor = lang => ({
  JavaScript:'#f1e05a', TypeScript:'#3178c6', Python:'#3572A5', Go:'#00ADD8',
  Rust:'#dea584', Java:'#b07219', 'C++':'#f34b7d', C:'#888', 'C#':'#178600',
  Shell:'#89e051', HTML:'#e34c26', CSS:'#563d7c', Vue:'#41b883', Svelte:'#ff3e00',
  Ruby:'#701516', PHP:'#4F5D95', Swift:'#F05138', Kotlin:'#A97BFF', Dart:'#00B4AB',
  Lua:'#000080', R:'#198CE7', Scala:'#c22d40', Elixir:'#6e4a7e', Haskell:'#5e5086',
  Zig:'#ec915c', Solidity:'#AA6746', Nix:'#7e7eff', Markdown:'#888'
}[lang] || '#71717a');

document.getElementById('sync-time').textContent = fmtDate(DATA.meta.last_incremental_at || DATA.meta.last_full_sync_at);
document.getElementById('gen-time').textContent = fmtDate(DATA.generated_at);

// ---------- Sparkline SVG（KPI 内嵌 mini chart，shadcn/charts 风格） ----------
const SPARK_COLORS = {
  primary:  'oklch(0.488 0.243 264.376)',
  positive: 'oklch(0.696 0.17 162.48)',
  neutral:  'oklch(0.708 0 0)',
  warning:  'oklch(0.769 0.188 70.08)'
};
function sparkSvg(values, tone) {
  if (!values || values.length < 2) return '';
  const color = SPARK_COLORS[tone] || SPARK_COLORS.primary;
  const w = 120, h = 28;
  const max = Math.max(...values), min = Math.min(...values);
  const range = max - min || 1;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - ((v - min) / range) * (h - 2) - 1]);
  const line = 'M ' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L ');
  const area = line + \` L \${w},\${h} L 0,\${h} Z\`;
  return \`<svg viewBox="0 0 \${w} \${h}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><linearGradient id="g-\${tone}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="\${color}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="\${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="\${area}" fill="url(#g-\${tone})"/>
    <path d="\${line}" stroke="\${color}" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg>\`;
}

// ---------- KPIs 渲染 ----------
const arrowMap = { up: '↑', down: '↓', flat: '·' };
document.getElementById('kpi-grid').innerHTML = DATA.kpis.map(k => {
  const isText = typeof k.value === 'string' && isNaN(Number(k.value));
  const valClass = (isText && String(k.value).length > 6) ? 'kpi-value small mono' : 'kpi-value mono';
  const delta = k.delta ? \`<span class="kpi-delta \${k.delta.tone}">\${arrowMap[k.delta.direction]} \${k.delta.value}%</span>\` : '';
  const spark = k.spark ? \`<div class="kpi-spark">\${sparkSvg(k.spark.values, k.spark.tone)}</div>\` : '';
  return \`
    <div class="kpi">
      <div>
        <div class="kpi-top">
          <div class="kpi-label">\${escapeHtml(k.label)}</div>
        </div>
        <div class="kpi-row">
          <span class="\${valClass}">\${typeof k.value === 'number' ? fmt(k.value) : escapeHtml(String(k.value))}</span>
          \${delta}
        </div>
        <div class="kpi-hint">\${escapeHtml(k.hint || '')}</div>
      </div>
      \${spark}
    </div>\`;
}).join('');

// ---------- ECharts（等待国际 CDN 加载完成） ----------
function initCharts() {
const TXT = 'oklch(0.985 0 0)', MUTED = 'oklch(0.78 0 0)', DIM = 'oklch(0.62 0 0)';
const GRID = 'oklch(1 0 0 / 6%)';
const CHART = {
  c1: 'oklch(0.488 0.243 264.376)',  // blue
  c2: 'oklch(0.696 0.17 162.48)',    // emerald
  c3: 'oklch(0.769 0.188 70.08)',    // amber
  c4: 'oklch(0.627 0.265 303.9)',    // violet
  c5: 'oklch(0.645 0.246 16.439)',   // rose
};
const baseOption = {
  textStyle: { fontFamily: 'Geist Variable, Inter, sans-serif', color: TXT },
  tooltip: {
    backgroundColor: 'oklch(0.205 0 0)',
    borderColor: 'oklch(1 0 0 / 14%)',
    borderWidth: 1,
    textStyle: { color: TXT, fontSize: 12, fontFamily: 'Geist Variable, sans-serif' },
    extraCssText: 'border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); backdrop-filter: blur(8px);'
  },
  grid: { left: 40, right: 20, top: 20, bottom: 30, containLabel: true }
};
/** 底部横向图例，避免与右上角 Y 轴名称重叠 */
const legendBottom = {
  orient: 'horizontal',
  left: 'center',
  bottom: 6,
  itemGap: 28,
  itemWidth: 14,
  itemHeight: 10,
  textStyle: { color: MUTED, fontSize: 11 },
};
function axis(opts) {
  return {
    axisLine: { lineStyle: { color: GRID } },
    axisTick: { show: false },
    axisLabel: { color: DIM, fontSize: 11 },
    splitLine: { lineStyle: { color: GRID, type: 'dashed' } },
    ...(opts || {})
  };
}

// ---------- 1. 日历热力图 ----------
(() => {
  if (DATA.activity.by_date.length === 0) return;
  const el = document.getElementById('chart-heatmap');
  const chart = echarts.init(el);
  const dates = DATA.activity.by_date.map(d => [d.date, d.count]);
  const max = Math.max(1, ...DATA.activity.by_date.map(d => d.count));
  const lastYear = new Date(dates[dates.length - 1][0]).getFullYear();
  const firstYear = new Date(dates[0][0]).getFullYear();
  const years = [];
  for (let y = lastYear; y >= firstYear && years.length < 3; y--) years.push(y);

  const calendarRowH = 118;
  const calendarTopBase = 8;
  const calLeft = 50;
  const calRight = 30;
  const legendMaxEl = document.getElementById('heatmap-legend-max');
  if (legendMaxEl) legendMaxEl.textContent = String(max);

  chart.setOption({
    textStyle: baseOption.textStyle,
    tooltip: { ...baseOption.tooltip, formatter: p => \`<b>\${p.value[0]}</b><br/>\${p.value[1]} stars\` },
    visualMap: {
      show: false,
      min: 0,
      max,
      dimension: 1,
      inRange: { color: ['#1a1a1c', '#1e3a8a', '#3b82f6', '#06b6d4', '#a78bfa'] },
    },
    calendar: years.map((year, i) => ({
      top: calendarTopBase + i * calendarRowH,
      left: calLeft,
      right: calRight,
      cellSize: ['auto', 14],
      range: String(year),
      itemStyle: { color: '#0e0e10', borderColor: '#0a0a0a', borderWidth: 2 },
      yearLabel: { color: MUTED, fontSize: 12, fontWeight: 600 },
      dayLabel: { color: DIM, fontSize: 10 },
      monthLabel: { color: DIM, fontSize: 10 },
      splitLine: { show: false },
    })),
    series: years.map((year, i) => ({
      type: 'heatmap',
      coordinateSystem: 'calendar',
      calendarIndex: i,
      data: dates.filter(d => d[0].startsWith(String(year))),
    })),
  });
  el.style.height = (calendarTopBase + years.length * calendarRowH + 8) + 'px';
  chart.resize();
  window.addEventListener('resize', () => chart.resize());
})();

// ---------- 2. 累积 + 速率 ----------
(() => {
  if (DATA.activity.cumulative.length === 0) return;
  const chart = echarts.init(document.getElementById('chart-growth'));
  chart.setOption({
    ...baseOption,
    grid: { left: 52, right: 52, top: 28, bottom: 52, containLabel: true },
    legend: { ...legendBottom },
    tooltip: {
      ...baseOption.tooltip,
      trigger: 'axis', axisPointer: { type: 'cross', lineStyle: { color: '#52525b' } }
    },
    xAxis: axis({ type: 'time' }),
    yAxis: [
      axis({ type: 'value', name: '累积', nameGap: 12, nameTextStyle: { color: DIM, fontSize: 11 } }),
      axis({
        type: 'value',
        position: 'right',
        nameGap: 12,
        splitLine: { show: false },
        axisLabel: { color: DIM, fontSize: 11 },
      }),
    ],
    series: [
      {
        name: '累积 Stars', type: 'line', smooth: true, showSymbol: false, yAxisIndex: 0,
        data: DATA.activity.cumulative.map(c => [c.date, c.total]),
        lineStyle: { width: 2, color: '#3b82f6' }, itemStyle: { color: '#3b82f6' },
        areaStyle: { color: { type: 'linear', x:0, y:0, x2:0, y2:1, colorStops: [
          { offset: 0, color: 'rgba(59, 130, 246, 0.25)' },
          { offset: 1, color: 'rgba(59, 130, 246, 0)' }
        ]}}
      },
      {
        name: '30 天滚动量', type: 'bar', yAxisIndex: 1,
        data: DATA.activity.velocity_30d.map(v => [v.date, v.value]),
        itemStyle: { color: 'rgba(139, 92, 246, 0.5)' },
        barMaxWidth: 4
      }
    ]
  });
  window.addEventListener('resize', () => chart.resize());
})();

// ---------- 3. Day of week ----------
(() => {
  const chart = echarts.init(document.getElementById('chart-dow'));
  const data = DATA.discovery.by_dow;
  const max = Math.max(...data.map(d => d.count));
  chart.setOption({
    ...baseOption,
    grid: { left: 20, right: 20, top: 20, bottom: 30, containLabel: true },
    tooltip: { ...baseOption.tooltip, trigger: 'item', formatter: p => \`<b>\${p.name}</b><br/>\${p.value} stars\` },
    xAxis: axis({ type: 'category', data: data.map(d => d.label) }),
    yAxis: axis({ type: 'value' }),
    series: [{
      type: 'bar', data: data.map(d => ({
        value: d.count,
        itemStyle: { color: d.count === max ? '#3b82f6' : 'rgba(59,130,246,0.3)' }
      })),
      barMaxWidth: 36, itemStyle: { borderRadius: [4,4,0,0] }
    }]
  });
  window.addEventListener('resize', () => chart.resize());
})();

// ---------- 4. Hour of day（极坐标） ----------
(() => {
  const chart = echarts.init(document.getElementById('chart-hour'));
  const data = DATA.discovery.by_hour;
  const max = Math.max(...data.map(d => d.count));
  chart.setOption({
    ...baseOption,
    tooltip: { ...baseOption.tooltip, formatter: p => \`<b>\${String(p.dataIndex).padStart(2,'0')}:00</b><br/>\${p.value} stars\` },
    polar: { radius: ['25%', '85%'] },
    angleAxis: {
      type: 'category', data: data.map(d => String(d.hour).padStart(2,'0')),
      axisLine: { lineStyle: { color: GRID } },
      axisLabel: { color: DIM, fontSize: 10 },
      axisTick: { show: false }
    },
    radiusAxis: {
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: DIM, fontSize: 9 },
      splitLine: { lineStyle: { color: GRID, type: 'dashed' } }
    },
    series: [{
      type: 'bar', coordinateSystem: 'polar', data: data.map(d => ({
        value: d.count,
        itemStyle: { color: d.count === max ? '#06b6d4' : 'rgba(6,182,212,0.35)' }
      })),
      itemStyle: { borderRadius: [2,2,0,0] }
    }]
  });
  window.addEventListener('resize', () => chart.resize());
})();

// ---------- 5. 语言分布（treemap）----------
(() => {
  if (DATA.composition.by_language.length === 0) return;
  const chart = echarts.init(document.getElementById('chart-language'));
  const data = DATA.composition.by_language.slice(0, 14).map(l => ({
    name: l.language,
    value: l.count,
    itemStyle: { color: langColor(l.language) }
  }));
  chart.setOption({
    ...baseOption,
    tooltip: { ...baseOption.tooltip, formatter: p => \`<b>\${p.name}</b><br/>\${p.value} 仓库 · \${DATA.composition.by_language.find(x=>x.language===p.name)?.pct || 0}%\` },
    series: [{
      type: 'treemap', data,
      breadcrumb: { show: false },
      roam: false, nodeClick: false,
      itemStyle: { borderColor: '#0a0a0a', borderWidth: 2, gapWidth: 2 },
      label: { color: '#0a0a0a', fontWeight: 600, fontSize: 13, textBorderColor: 'rgba(255,255,255,0.4)', textBorderWidth: 0.5 }
    }]
  });
  window.addEventListener('resize', () => chart.resize());
})();

// ---------- 6. Top owners ----------
(() => {
  if (DATA.composition.top_owners.length === 0) return;
  const chart = echarts.init(document.getElementById('chart-owners'));
  const owners = DATA.composition.top_owners.slice(0, 15).reverse();
  const max = Math.max(...owners.map(o => o.count));
  chart.setOption({
    ...baseOption,
    grid: { left: 100, right: 30, top: 10, bottom: 30 },
    tooltip: { ...baseOption.tooltip, formatter: p => \`<b>\${p.name}</b><br/>\${p.value} 仓库 · \${fmt(owners[p.dataIndex].stars)} 累计 ★\` },
    xAxis: axis({ type: 'value' }),
    yAxis: axis({ type: 'category', data: owners.map(o => o.owner), splitLine: { show: false } }),
    series: [{
      type: 'bar', data: owners.map(o => ({
        value: o.count,
        itemStyle: { color: o.count === max ? '#10b981' : 'rgba(16,185,129,0.4)' }
      })),
      barMaxWidth: 14, itemStyle: { borderRadius: [0,4,4,0] }
    }]
  });
  window.addEventListener('resize', () => chart.resize());
})();

// ---------- 7. 流行度分层（donut）----------
(() => {
  const chart = echarts.init(document.getElementById('chart-popularity'));
  const colors = { niche: '#a78bfa', growing: '#06b6d4', popular: '#3b82f6', mainstream: '#10b981', mega: '#f59e0b' };
  chart.setOption({
    ...baseOption,
    tooltip: { ...baseOption.tooltip, formatter: p => \`<b>\${p.name}</b><br/>\${p.value} 仓库 · \${p.percent}%\` },
    legend: {
      ...legendBottom,
      bottom: 4,
      type: 'scroll',
      width: '92%',
      pageIconColor: MUTED,
      pageTextStyle: { color: DIM, fontSize: 10 },
    },
    series: [{
      type: 'pie', radius: ['42%', '68%'], center: ['50%', '42%'],
      data: DATA.health.popularity.map(p => ({
        name: p.label, value: p.count,
        itemStyle: { color: colors[p.tier] }
      })),
      itemStyle: { borderColor: '#0a0a0a', borderWidth: 2 },
      label: { show: false }, labelLine: { show: false }
    }]
  });
  window.addEventListener('resize', () => chart.resize());
})();

// ---------- 8. 新鲜度（horizontal stacked）----------
(() => {
  const chart = echarts.init(document.getElementById('chart-freshness'));
  const data = DATA.health.freshness;
  const colors = { active: '#10b981', recent: '#3b82f6', stale1: '#f59e0b', stale3: '#f97316', abandoned: '#f43f5e' };
  chart.setOption({
    ...baseOption,
    grid: { left: 100, right: 50, top: 10, bottom: 30 },
    tooltip: { ...baseOption.tooltip, formatter: p => \`<b>\${p.name}</b><br/>\${p.value} 仓库 · \${data[p.dataIndex].pct}%\` },
    xAxis: axis({ type: 'value' }),
    yAxis: axis({ type: 'category', data: data.map(d => d.label), splitLine: { show: false } }),
    series: [{
      type: 'bar', data: data.map(d => ({
        value: d.count,
        itemStyle: { color: colors[d.bucket] }
      })),
      barMaxWidth: 20, itemStyle: { borderRadius: [0,4,4,0] },
      label: { show: true, position: 'right', color: MUTED, fontSize: 11, formatter: p => data[p.dataIndex].pct + '%' }
    }]
  });
  window.addEventListener('resize', () => chart.resize());
})();

// ---------- 9. 仓库出生年 ----------
(() => {
  if (DATA.health.repo_age.length === 0) return;
  const chart = echarts.init(document.getElementById('chart-age'));
  const data = DATA.health.repo_age;
  chart.setOption({
    ...baseOption,
    grid: { left: 30, right: 20, top: 20, bottom: 30, containLabel: true },
    tooltip: { ...baseOption.tooltip, trigger: 'axis', formatter: p => \`<b>\${p[0].name}</b><br/>\${p[0].value} 仓库\` },
    xAxis: axis({ type: 'category', data: data.map(d => String(d.year)) }),
    yAxis: axis({ type: 'value' }),
    series: [{
      type: 'bar', data: data.map(d => d.count),
      barMaxWidth: 20,
      itemStyle: {
        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [
          { offset: 0, color: 'rgba(139, 92, 246, 0.9)' },
          { offset: 1, color: 'rgba(139, 92, 246, 0.3)' }
        ]},
        borderRadius: [4,4,0,0]
      }
    }]
  });
  window.addEventListener('resize', () => chart.resize());
})();

}
if (typeof echarts !== 'undefined') initCharts();
else window.addEventListener('echarts-ready', initCharts, { once: true });

// ---------- Lists ----------
function renderRepo(r) {
  return \`<a class="repo" href="\${r.html_url}" target="_blank" rel="noopener">
    <img class="repo-avatar" src="\${r.owner_avatar_url}&s=64" alt="" loading="lazy" />
    <div class="repo-info">
      <div class="repo-name">\${escapeHtml(r.full_name)}</div>
      <div class="repo-desc">\${escapeHtml(r.description || '—')}</div>
    </div>
    <div class="repo-meta">
      \${r.language ? \`<span><span class="lang-dot" style="background:\${langColor(r.language)}"></span>\${escapeHtml(r.language)}</span>\` : ''}
      <span class="stars mono">★ \${fmtCompact(r.stargazers_count)}</span>
    </div>
  </a>\`;
}
document.getElementById('list-recent').innerHTML = DATA.lists.recent_stars.length
  ? DATA.lists.recent_stars.map(renderRepo).join('')
  : '<div class="empty">暂无数据</div>';
document.getElementById('list-top').innerHTML = DATA.lists.top_repos.length
  ? DATA.lists.top_repos.map(renderRepo).join('')
  : '<div class="empty">暂无数据</div>';
document.getElementById('list-changes').innerHTML = DATA.lists.recent_changes.length
  ? DATA.lists.recent_changes.map(c => \`
    <div class="change">
      <span class="change-kind \${c.kind}">\${c.kind}</span>
      <span class="change-name">\${escapeHtml(c.full_name)}</span>
      <span class="change-time mono">\${fmtDateOnly(c.generated_at)}</span>
    </div>\`).join('')
  : '<div class="empty">还没有变更记录</div>';
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// ============================================================
// CLI
// ============================================================

interface Args {
  username?: string;
  dataDir: string;
  output?: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let dataDir = './data';
  let output: string | undefined;
  for (const a of argv) {
    if (a.startsWith('--data-dir=')) dataDir = a.slice('--data-dir='.length);
    else if (a.startsWith('--output=')) output = a.slice('--output='.length);
    else if (!a.startsWith('--')) positional.push(a);
  }
  return { username: positional[0], dataDir, output };
}

async function main() {
  const { username, dataDir, output } = parseArgs(process.argv.slice(2));
  if (!username) {
    console.error('❌ 请提供 GitHub 用户名');
    console.log('用法: bun run report.ts <username> [--data-dir=./data] [--output=path.html]');
    process.exit(1);
  }

  const dbPath = join(dataDir, username, 'stars.db');
  if (!(await Bun.file(dbPath).exists())) {
    console.error(`❌ 找不到 SQLite: ${dbPath}`);
    console.log(`提示：请先运行 bun run index.ts ${username}`);
    process.exit(1);
  }

  console.log(`📊 生成报表：${username}`);
  const data = collect(username, dbPath);
  const html = render(data);

  const outPath = output ?? join(dataDir, username, 'report.html');
  await mkdir(join(dataDir, username), { recursive: true });
  await Bun.write(outPath, html);

  const sizeKb = (html.length / 1024).toFixed(1);
  console.log(`✅ 已生成：${outPath} (${sizeKb} KB)`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('❌ 失败：', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
