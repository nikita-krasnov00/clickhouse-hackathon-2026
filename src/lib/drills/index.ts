/**
 * A4 — каталог drill-запросов: быстрый путь клика мимо LLM (цель ≤300 мс).
 *
 * Каждый дрилл: zod-схема параметров (имена — строго под selectionKeys
 * клик-целей контрактов: point → t/series, row → ключи колонок, cell → x/y)
 * + execute() → готовый ViewSpec. SQL только параметризованный (query_params),
 * исполнение под agent_ro; скорость — на роллапах scratch.* (db/a4_rollups.sh).
 *
 * Составные drillId: `cell-actors:owner/repo` — клик по ячейке heatmap несёт
 * в selection только x/y (контракт), поэтому репо вшивается в сам drillId
 * при сборке спека родительского дрилла.
 *
 * Эталонные запросы и фактические цифры — db/a3_golden.sql, db/A3_DEMO_NOTES.md.
 */
import { z } from "zod";
import type { ClickHouseClient } from "@clickhouse/client";
import { config } from "@/lib/config";
import type { ClickTarget, ViewSpec } from "@/lib/contracts";

/**
 * Таблица событий — из конфига (GITHUB_EVENTS_TABLE). Имя таблицы нельзя
 * передать через query_params (ClickHouse не параметризует идентификаторы),
 * поэтому оно интерполируется в SQL строкой; это значение нашего конфига,
 * не пользовательский ввод.
 */
const EVENTS_TABLE = config.dataset.githubEventsTable;

// ---------------------------------------------------------------------------
// Знания A3: окна аномалий героев демо (агент их «находит», дрилл подсвечивает).
// ---------------------------------------------------------------------------

export const ANOMALY_WINDOWS: Record<string, [string, string]> = {
  "solidSpoon/DashPlayer": ["2024-05-15", "2024-05-25"],
  "deepseek-ai/DeepSeek-VL": ["2024-03-11", "2024-03-17"],
  "Zejun-Yang/AniPortrait": ["2024-03-27", "2024-04-03"],
  "OpenInterpreter/01": ["2024-03-23", "2024-03-25"],
  "lavague-ai/LaVague": ["2024-03-13", "2024-03-19"],
};

/** Окно полного покрытия звёзд в слайсе (см. оговорки A3). */
const FULL_COVERAGE: [string, string] = ["2024-01-01", "2024-07-01"];

/** Контроль-органика для evidence-сравнений (grok-1, фактические цифры Q4). */
const ORGANIC_BASELINE = { medianStars: 15, share100: 0.126, oneAndDone: 0.078 };

// ---------------------------------------------------------------------------
// Инфраструктура каталога
// ---------------------------------------------------------------------------

type Params = Record<string, string | number>;

export type DrillDef = {
  /** Человекочитаемое имя действия (тултипы, дрилл-карточка). */
  title: string;
  params: z.ZodType<Params>;
  execute: (client: ClickHouseClient, params: Params) => Promise<ViewSpec>;
};

async function q<T extends Record<string, unknown>>(
  client: ClickHouseClient,
  query: string,
  query_params: Record<string, unknown>,
): Promise<T[]> {
  const rs = await client.query({ query, query_params, format: "JSONEachRow" });
  return rs.json<T>();
}

const repoRegex = /^[^\s/]+\/[^\s/]+$/;

/** Репо из selection: клик по строке несёт repo/repo_name, по точке — series. */
function resolveRepo(p: Params): string {
  const candidate = String(p.repo ?? p.repo_name ?? p.series ?? "");
  if (!repoRegex.test(candidate)) {
    throw new DrillParamsError(
      `не удалось определить репозиторий из параметров (repo/repo_name/series): ${JSON.stringify(p)}`,
    );
  }
  return candidate;
}

/** Окно анализа: явные from/to → каталог аномалий → окно полного покрытия. */
function resolveWindow(p: Params, repo: string): [string, string] {
  if (p.from && p.to) return [String(p.from), String(p.to)];
  return ANOMALY_WINDOWS[repo] ?? FULL_COVERAGE;
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export class DrillParamsError extends Error {}
export class UnknownDrillError extends Error {}

const num = (v: unknown): number => Number(v ?? 0);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}/);

// Свободная форма selection: нужные ключи валидируем, лишние (v, value, count…)
// zod по умолчанию отбрасывает.
const repoish = { repo: z.string().optional(), repo_name: z.string().optional(), series: z.string().optional() };
const windowish = { from: dateStr.optional(), to: dateStr.optional() };

// ---------------------------------------------------------------------------
// Дриллы
// ---------------------------------------------------------------------------

const starsByDay: DrillDef = {
  title: "Звёзды по дням",
  params: z.object({ ...repoish, ...windowish }),
  async execute(client, p) {
    const repo = resolveRepo(p);
    const known = ANOMALY_WINDOWS[repo];
    // Показ: окно аномалии с полями, иначе — всё окно покрытия.
    const [from, to] = known
      ? [shiftDate(known[0], -60), shiftDate(known[1], 21)]
      : resolveWindow(p, repo);
    // Алиас нарочно не `day`: он затенил бы колонку Date в WHERE (NO_COMMON_TYPE).
    const rows = await q<{ t: string; stars: unknown }>(
      client,
      `SELECT toString(day) AS t, stars
       FROM scratch.daily_stars
       WHERE repo_name = {repo:String} AND day >= {from:Date} AND day <= {to:Date}
       ORDER BY day LIMIT 1000`,
      { repo, from, to },
    );
    const clicks: ClickTarget[] = [
      {
        on: "point",
        selectionKeys: ["t", "series"],
        drillId: "actors-of-day",
        label: "Кто ставил звёзды в этот день?",
      },
    ];
    return {
      kind: "timeline",
      title: `Звёзды ${repo} по дням`,
      series: [{ name: repo, points: rows.map((r) => ({ t: r.t, v: num(r.stars) })) }],
      ...(known ? { anomalyWindow: known } : {}),
      clicks,
    };
  },
};

const actorsOfDay: DrillDef = {
  title: "Акторы дня",
  params: z.object({ t: dateStr, ...repoish }),
  async execute(client, p) {
    const repo = resolveRepo(p);
    const rows = await q<Record<string, unknown>>(
      client,
      `SELECT e.actor_login AS actor,
              a.stars_6mo AS stars_6mo,
              a.active_days AS active_days,
              toString(toDate(a.first_ts)) AS first_seen
       FROM ${EVENTS_TABLE} e
       JOIN scratch.actor_stats_6mo a ON a.actor_login = e.actor_login
       WHERE e.event_type = 'WatchEvent'
         AND e.repo_name = {repo:String}
         AND toDate(e.created_at) = toDate(parseDateTimeBestEffort({t:String}))
       ORDER BY a.stars_6mo DESC
       LIMIT 50`,
      { repo, t: String(p.t) },
    );
    return leaderboard(
      `Кто звездил ${repo} · ${String(p.t).slice(0, 10)}`,
      [
        ["actor", "актор"],
        ["stars_6mo", "звёзд за полгода"],
        ["active_days", "активных дней"],
        ["first_seen", "первое событие"],
      ],
      rows,
      [
        {
          on: "row",
          selectionKeys: ["actor"],
          drillId: "actor-timeline",
          label: "Вся активность актора",
        },
      ],
    );
  },
};

const actorAgeProfile: DrillDef = {
  title: "Возраст аккаунтов",
  params: z.object({ ...repoish, ...windowish }),
  async execute(client, p) {
    const repo = resolveRepo(p);
    const [from, to] = resolveWindow(p, repo);
    const [r] = await q<Record<string, unknown>>(
      client,
      `SELECT
         countIf(age <          86400) AS lt_1d,
         countIf(age >=         86400 AND age <   7*86400) AS d1_w1,
         countIf(age >=       7*86400 AND age <  30*86400) AS w1_m1,
         countIf(age >=      30*86400 AND age < 365*86400) AS m1_y1,
         countIf(age >=     365*86400) AS y1_plus
       FROM (
         SELECT e.created_at - a.first_ts AS age
         FROM ${EVENTS_TABLE} e
         JOIN scratch.actor_stats_6mo a ON a.actor_login = e.actor_login
         WHERE e.event_type = 'WatchEvent'
           AND e.repo_name = {repo:String}
           AND toDate(e.created_at) BETWEEN {from:Date} AND {to:Date}
       )`,
      { repo, from, to },
    );
    const buckets = [
      { label: "моложе суток", count: num(r?.lt_1d) },
      { label: "1–7 дней", count: num(r?.d1_w1) },
      { label: "1–4 недели", count: num(r?.w1_m1) },
      { label: "1–12 месяцев", count: num(r?.m1_y1) },
      { label: "старше года", count: num(r?.y1_plus) },
    ];
    return {
      kind: "histogram",
      title: `Возраст аккаунтов на момент звезды · ${repo} · ${from}..${to}`,
      bucketLabel: "Возраст аккаунта (первое событие в слайсе → звезда)",
      buckets,
      clicks: [
        {
          on: "bucket",
          selectionKeys: ["label", "count"],
          label: "Разобрать эту корзину (новый ран агента)",
        },
      ],
    };
  },
};

/** Общий SELECT ко-старинга: доли толпы окна против контроля grok-1. */
async function costarRows(
  client: ClickHouseClient,
  repo: string,
  from: string,
  to: string,
  limit: number,
) {
  return q<{ repo: string; s_actors: unknown; s_share: unknown; lift: unknown }>(
    client,
    `WITH suspects AS (
       SELECT DISTINCT actor_login FROM ${EVENTS_TABLE}
       WHERE event_type = 'WatchEvent' AND repo_name = {repo:String}
         AND toDate(created_at) BETWEEN {from:Date} AND {to:Date}
     )
     SELECT sp.repo_name AS repo,
            uniqExactIf(sp.actor_login, sp.actor_login IN suspects) AS s_actors,
            round(s_actors / (SELECT count() FROM suspects), 3) AS s_share,
            uniqExactIf(sp.actor_login, sp.actor_login IN (SELECT actor_login FROM scratch.control_actors)) AS c_actors,
            round(c_actors / (SELECT count() FROM scratch.control_actors), 4) AS c_share,
            round(s_share / greatest(c_share, 0.0002), 1) AS lift
     FROM scratch.star_pairs sp
     WHERE sp.actor_login IN (SELECT actor_login FROM suspects
                              UNION DISTINCT SELECT actor_login FROM scratch.control_actors)
       AND sp.repo_name != {repo:String} AND sp.repo_name != 'xai-org/grok-1'
     GROUP BY sp.repo_name
     HAVING s_actors >= 15
     ORDER BY lift DESC
     LIMIT {limit:UInt32}`,
    { repo, from, to, limit },
  );
}

const coStarredRepos: DrillDef = {
  title: "Что ещё звездили эти аккаунты",
  params: z.object({ ...repoish, ...windowish }),
  async execute(client, p) {
    const repo = resolveRepo(p);
    const [from, to] = resolveWindow(p, repo);
    const rows = await costarRows(client, repo, from, to, 20);
    return leaderboard(
      `Портфель толпы ${repo} (${from}..${to}) — лифт против органики grok-1`,
      [
        ["repo", "репозиторий"],
        ["s_actors", "общих акторов"],
        ["s_share", "доля толпы"],
        ["lift", "лифт ×"],
      ],
      rows,
      [
        {
          on: "row",
          selectionKeys: ["repo"],
          drillId: "stars-by-day",
          label: "Таймлайн звёзд этого репо",
        },
      ],
    );
  },
};

const costarGraph: DrillDef = {
  title: "Граф фермы",
  params: z.object({ ...repoish, ...windowish, maxNodes: z.coerce.number().int().positive().optional() }),
  async execute(client, p) {
    const repo = resolveRepo(p);
    const [from, to] = resolveWindow(p, repo);
    const maxNodes = Math.min(Number(p.maxNodes ?? 30), 50);
    const top = await costarRows(client, repo, from, to, Math.max(maxNodes - 1, 5));
    if (top.length === 0) {
      throw new DrillParamsError(`нет заметного ко-старинга у ${repo} в окне ${from}..${to}`);
    }
    const maxLift = Math.max(...top.map((r) => num(r.lift)), 1);
    const repoSet = [repo, ...top.map((r) => r.repo)];
    // Рёбра между ко-репо: общие акторы ИЗ ТОЛПЫ ОКНА (портфель фермы, не толпа).
    const pairRows = await q<{ source: string; target: string; w: unknown }>(
      client,
      `WITH suspects AS (
         SELECT DISTINCT actor_login FROM ${EVENTS_TABLE}
         WHERE event_type = 'WatchEvent' AND repo_name = {repo:String}
           AND toDate(created_at) BETWEEN {from:Date} AND {to:Date}
       )
       SELECT a.repo_name AS source, b.repo_name AS target, uniqExact(a.actor_login) AS w
       FROM scratch.star_pairs_by_repo a
       JOIN scratch.star_pairs_by_repo b ON a.actor_login = b.actor_login
       WHERE a.repo_name IN {repos:Array(String)} AND b.repo_name IN {repos:Array(String)}
         AND a.repo_name < b.repo_name
         AND a.actor_login IN suspects
       GROUP BY source, target
       HAVING w >= 10
       ORDER BY w DESC
       LIMIT 200`,
      { repo, from, to, repos: repoSet },
    );
    return {
      kind: "graph",
      title: `Ферма вокруг ${repo}: общий портфель толпы ${from}..${to}`,
      nodes: [
        { id: repo, label: repo, size: 3 },
        ...top.map((r) => ({
          id: r.repo,
          label: r.repo,
          score: Math.min(1, num(r.lift) / maxLift),
          size: 1 + Math.log10(Math.max(num(r.s_actors), 1)),
        })),
      ],
      edges: pairRows.map((e) => ({ source: e.source, target: e.target, weight: num(e.w) })),
      maxNodes,
    };
  },
};

const hourlyHeatmap: DrillDef = {
  title: "Почасовой профиль",
  params: z.object({ ...repoish, ...windowish }),
  async execute(client, p) {
    const repo = resolveRepo(p);
    const [from, to] = resolveWindow(p, repo);
    const rows = await q<{ x: string; y: string; value: unknown }>(
      client,
      `SELECT toString(toHour(created_at)) AS x,
              toString(toDate(created_at)) AS y,
              count() AS value
       FROM ${EVENTS_TABLE}
       WHERE event_type = 'WatchEvent' AND repo_name = {repo:String}
         AND toDate(created_at) BETWEEN {from:Date} AND {to:Date}
       GROUP BY x, y ORDER BY y, x`,
      { repo, from, to },
    );
    const yLabels = [...new Set(rows.map((r) => r.y))].sort();
    return {
      kind: "heatmap",
      title: `Звёзды ${repo} по часам UTC · ${from}..${to}`,
      xLabels: Array.from({ length: 24 }, (_, h) => String(h)),
      yLabels,
      cells: rows.map((r) => ({ x: r.x, y: r.y, value: num(r.value) })),
      clicks: [
        {
          on: "cell",
          selectionKeys: ["x", "y"],
          drillId: `cell-actors:${repo}`,
          label: "Кто звездил в этот час?",
        },
      ],
    };
  },
};

/** Составной дрилл `cell-actors:owner/repo` — репо вшито в drillId. */
function cellActors(repo: string): DrillDef {
  return {
    title: "Акторы часа",
    params: z.object({ x: z.coerce.number().int().min(0).max(23), y: dateStr }),
    async execute(client, p) {
      const rows = await q<Record<string, unknown>>(
        client,
        `SELECT e.actor_login AS actor,
                a.stars_6mo AS stars_6mo,
                a.active_days AS active_days,
                toString(toDate(a.first_ts)) AS first_seen
         FROM ${EVENTS_TABLE} e
         JOIN scratch.actor_stats_6mo a ON a.actor_login = e.actor_login
         WHERE e.event_type = 'WatchEvent' AND e.repo_name = {repo:String}
           AND toDate(e.created_at) = {y:Date} AND toHour(e.created_at) = {x:UInt8}
         ORDER BY a.stars_6mo DESC LIMIT 50`,
        { repo, x: Number(p.x), y: String(p.y) },
      );
      return leaderboard(
        `Звездившие ${repo} · ${p.y} в ${p.x}:00 UTC`,
        [
          ["actor", "актор"],
          ["stars_6mo", "звёзд за полгода"],
          ["active_days", "активных дней"],
          ["first_seen", "первое событие"],
        ],
        rows,
        [
          {
            on: "row",
            selectionKeys: ["actor"],
            drillId: "actor-timeline",
            label: "Вся активность актора",
          },
        ],
      );
    },
  };
}

const actorTimeline: DrillDef = {
  title: "Активность актора",
  params: z.object({ actor: z.string().min(1) }),
  async execute(client, p) {
    const actor = String(p.actor);
    const rows = await q<{ t: string; v: unknown }>(
      client,
      `SELECT toString(toDate(created_at)) AS t, count() AS v
       FROM ${EVENTS_TABLE}
       WHERE actor_login = {actor:String}
       GROUP BY t ORDER BY t LIMIT 1000`,
      { actor },
    );
    return {
      kind: "timeline",
      title: `События актора ${actor} по дням (весь слайс)`,
      series: [{ name: actor, points: rows.map((r) => ({ t: r.t, v: num(r.v) })) }],
      clicks: [
        { on: "point", selectionKeys: ["t", "series"], label: "Что делал в этот день?" },
      ],
    };
  },
};

const burstMetrics: DrillDef = {
  title: "Burst-метрики",
  params: z.object({ ...repoish }),
  async execute(client, p) {
    const repo = resolveRepo(p);
    const rows = await q<{ t: string; stars: unknown }>(
      client,
      `SELECT toString(day) AS t, stars FROM scratch.daily_stars
       WHERE repo_name = {repo:String} AND day >= {from:Date} AND day < {to:Date}
       ORDER BY day LIMIT 1000`,
      { repo, from: FULL_COVERAGE[0], to: FULL_COVERAGE[1] },
    );
    if (rows.length === 0) {
      throw new DrillParamsError(`нет звёзд у ${repo} в окне покрытия ${FULL_COVERAGE.join("..")}`);
    }
    const days = rows.map((r) => ({ day: r.t, stars: num(r.stars) }));
    const total = days.reduce((s, d) => s + d.stars, 0);
    const peak = days.reduce((m, d) => (d.stars > m.stars ? d : m), days[0]);
    const sorted = [...days].sort((a, b) => a.stars - b.stars);
    const median = sorted[Math.floor(sorted.length / 2)].stars;
    const plateau = days.filter((d) => d.stars >= 0.5 * peak.stars).length;
    const burst = Math.round((peak.stars / Math.max(median, 1)) * 10) / 10;
    const topShare = Math.round((peak.stars / total) * 1000) / 10;

    // Правила A3 (Q5): фрод отличает ФОРМА кривой, не сам burst.
    const [verdict, confidence] =
      plateau >= 4
        ? [`«Полка»: ${plateau} дн. подряд ≥50% пика — почерк дрип-кампании по квоте, а не виральный всплеск.`, "high" as const]
        : plateau === 3
          ? [`${plateau} дня у пика — подозрительная полка; нужен профиль толпы (one-and-done, ко-старинг).`, "medium" as const]
          : [`Пик + быстрый распад — форма органики (burst ${burst}× сам по себе фрод не доказывает).`, "medium" as const];

    return {
      kind: "verdict",
      verdict: `${repo}: ${verdict}`,
      confidence,
      evidence: [
        { label: "звёзд за полгода", value: total },
        { label: "пиковый день", value: `${peak.stars}`, detail: peak.day },
        { label: "медиана активного дня", value: median },
        { label: "burst-ratio", value: `${burst}×`, detail: "у органики grok-1 — 610×" },
        { label: "доля топ-дня", value: `${topShare}%` },
        { label: "дней ≥50% пика", value: plateau, detail: "полка ≥4 — дрип-кампания; у grok-1 — 1" },
      ],
    };
  },
};

const oneAndDone: DrillDef = {
  title: "Профиль толпы",
  params: z.object({ ...repoish, ...windowish }),
  async execute(client, p) {
    const repo = resolveRepo(p);
    const [from, to] = resolveWindow(p, repo);
    const [r] = await q<Record<string, unknown>>(
      client,
      `WITH suspects AS (
         SELECT DISTINCT actor_login FROM ${EVENTS_TABLE}
         WHERE event_type = 'WatchEvent' AND repo_name = {repo:String}
           AND toDate(created_at) BETWEEN {from:Date} AND {to:Date}
       )
       SELECT count() AS actors,
              round(countIf(ev_6mo = 1) / count(), 3) AS one_and_done,
              quantileExact(0.5)(stars_6mo) AS median_stars,
              round(countIf(stars_6mo >= 100) / count(), 3) AS share_100plus,
              quantileExact(0.5)(active_days) AS median_days
       FROM scratch.actor_stats_6mo
       WHERE actor_login IN suspects`,
      { repo, from, to },
    );
    const medianStars = num(r?.median_stars);
    const share100 = num(r?.share_100plus);
    const farm = medianStars >= 40 && share100 >= 0.25;
    return {
      kind: "verdict",
      verdict: farm
        ? `${repo}: толпа окна ${from}..${to} — сериальные звездильщики (камуфляж фермы): медиана ${medianStars} звёзд/полгода против ${ORGANIC_BASELINE.medianStars} у органики.`
        : `${repo}: профиль толпы окна ${from}..${to} близок к органике (медиана ${medianStars} звёзд/полгода).`,
      confidence: farm ? "high" : "medium",
      evidence: [
        { label: "акторов в окне", value: num(r?.actors) },
        {
          label: "one-and-done",
          value: `${(num(r?.one_and_done) * 100).toFixed(1)}%`,
          detail: `органика grok-1: ${(ORGANIC_BASELINE.oneAndDone * 100).toFixed(1)}% — у ботов ПУСТЫХ аккаунтов меньше`,
        },
        { label: "медиана звёзд/полгода", value: medianStars, detail: `органика: ${ORGANIC_BASELINE.medianStars}` },
        {
          label: "звездят 100+ репо",
          value: `${(share100 * 100).toFixed(1)}%`,
          detail: `органика: ${(ORGANIC_BASELINE.share100 * 100).toFixed(1)}%`,
        },
        { label: "медиана активных дней", value: num(r?.median_days) },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Хелперы сборки и публичный резолвер
// ---------------------------------------------------------------------------

function leaderboard(
  title: string,
  cols: [key: string, label: string][],
  rows: Record<string, unknown>[],
  clicks: ClickTarget[],
): ViewSpec {
  return {
    kind: "leaderboard",
    title,
    columns: cols.map(([key, label]) => ({ key, label })),
    rows: rows.map((row) =>
      Object.fromEntries(
        cols.map(([key]) => {
          const v = row[key];
          if (v === null || v === undefined) return [key, null];
          if (typeof v === "number") return [key, v];
          const s = String(v);
          return [key, /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s];
        }),
      ),
    ),
    clicks,
  };
}

const CATALOG: Record<string, DrillDef> = {
  "stars-by-day": starsByDay,
  "actors-of-day": actorsOfDay,
  "actor-age-profile": actorAgeProfile,
  "co-starred-repos": coStarredRepos,
  "costar-graph": costarGraph,
  "hourly-heatmap": hourlyHeatmap,
  "actor-timeline": actorTimeline,
  "burst-metrics": burstMetrics,
  "one-and-done": oneAndDone,
};

export const DRILL_IDS = Object.keys(CATALOG);

/**
 * Документация дриллов для промпта планировщика (B4): LLM собирает дашборд и
 * может взять готовый параметризованный запрос (быстрый путь на роллапах)
 * вместо генерации SQL. Тексты — на английском, уходят в промпт как есть.
 */
const DRILL_TOOL_DOCS: { id: string; params: string; when: string }[] = [
  {
    id: "stars-by-day",
    params: "{repo: 'owner/name', from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD'}",
    when: "Timeline of stars per day for one repo; auto-highlights the known anomaly window if the repo is a demo hero.",
  },
  {
    id: "burst-metrics",
    params: "{repo: 'owner/name'}",
    when: "Verdict card with burst statistics of a repo's star curve (peak vs median, plateau shape, top-day share).",
  },
  {
    id: "one-and-done",
    params: "{repo: 'owner/name', from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD'}",
    when: "Verdict card profiling the crowd that starred a repo in a window (one-and-done share, median stars per account) vs organic baseline.",
  },
  {
    id: "actor-age-profile",
    params: "{repo: 'owner/name', from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD'}",
    when: "Histogram of account age at star time for a repo's stargazers — classic fake-star signal.",
  },
  {
    id: "hourly-heatmap",
    params: "{repo: 'owner/name', from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD'}",
    when: "Heatmap hour-of-day × date of a repo's stars — shows machine-like regularity.",
  },
  {
    id: "co-starred-repos",
    params: "{repo: 'owner/name', from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD'}",
    when: "Leaderboard of other repos starred by the same crowd (farm portfolio, lift vs organic control).",
  },
  {
    id: "costar-graph",
    params: "{repo: 'owner/name', from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD'}",
    when: "Network graph of the star-farm around a repo (co-starred repos weighted by shared actors).",
  },
  {
    id: "actors-of-day",
    params: "{repo: 'owner/name', t: 'YYYY-MM-DD'}",
    when: "Leaderboard of accounts that starred a repo on one specific day.",
  },
  {
    id: "actor-timeline",
    params: "{actor: 'login'}",
    when: "Timeline of all events of one account.",
  },
];

/** Готовый блок каталога дриллов для системного промпта планировщика. */
export function formatDrillCatalogForPrompt(): string {
  return DRILL_TOOL_DOCS.map(
    (d) => `- drillId "${d.id}" · params ${d.params} — ${d.when}`,
  ).join("\n");
}

/** Резолвер drillId, включая составные вида `cell-actors:owner/repo`. */
export function resolveDrill(drillId: string): DrillDef {
  const def = CATALOG[drillId];
  if (def) return def;
  const sep = drillId.indexOf(":");
  if (sep > 0) {
    const base = drillId.slice(0, sep);
    const arg = drillId.slice(sep + 1);
    if (base === "cell-actors" && repoRegex.test(arg)) return cellActors(arg);
  }
  throw new UnknownDrillError(`неизвестный drillId: ${drillId}`);
}
