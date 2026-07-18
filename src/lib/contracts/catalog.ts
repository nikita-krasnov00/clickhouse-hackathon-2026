/**
 * VIEW_SPEC_CATALOG — каталог компонентов для промпта text-to-SQL (задача B4).
 * Одно место правды о том, какие карточки бывают, когда какую выбирать и как
 * выглядит валидный JSON. Примеры типизированы точным вариантом ViewSpec и
 * прогоняются через схемы в contracts:smoke — каталог не может разъехаться
 * с контрактом.
 *
 * Описания — на английском (уходят в промпт LLM), заголовки примеров — на
 * русском (язык демо; в промпте B4 стоит попросить писать title на языке
 * вопроса пользователя).
 */
import type { ViewKind, ViewSpec } from "./view-spec";

type CatalogShape = {
  [K in ViewKind]: {
    kind: K;
    /** Что это за карточка, одной строкой. */
    summary: string;
    /** Когда её выбирать. */
    whenToUse: string;
    /** Форма данных, которую надо заполнить. */
    dataShape: string;
    /** Валидный заполненный пример. */
    example: Extract<ViewSpec, { kind: K }>;
  };
};

export type ViewSpecCatalogEntry = CatalogShape[ViewKind];

export const VIEW_SPEC_CATALOG: CatalogShape = {
  timeline: {
    kind: "timeline",
    summary: "Line chart of one or more metrics over time, with an optional shaded anomaly window.",
    whenToUse:
      "The question is about how a metric evolves over time: spikes, bursts, trends, before/after comparisons. Use anomalyWindow to highlight the suspicious range you found.",
    dataShape:
      "series: 1+ named series of points {t: ISO date/datetime string, v: number}. anomalyWindow: optional [fromISO, toISO]. clicks: targets with on:'point', selectable fields 't', 'v', 'series'.",
    example: {
      kind: "timeline",
      title: "Звёзды по дням: acme/turbo-widget",
      series: [
        {
          name: "acme/turbo-widget",
          points: [
            { t: "2024-03-01", v: 12 },
            { t: "2024-03-02", v: 842 },
            { t: "2024-03-03", v: 31 },
          ],
        },
      ],
      anomalyWindow: ["2024-03-02", "2024-03-03"],
      clicks: [
        {
          on: "point",
          selectionKeys: ["t", "series"],
          drillId: "stars-by-day",
          label: "Кто ставил звёзды в этот день?",
        },
      ],
    },
  },
  leaderboard: {
    kind: "leaderboard",
    summary: "Ranked table of entities with a few metric columns.",
    whenToUse:
      "The question is 'which/top N': repos by star burst, accounts by activity, orgs by events. Best entry point of an investigation — rows are clickable.",
    dataShape:
      "columns: [{key, label}] define the table; rows: records keyed by column key, values string|number|null (null renders as a dash). clicks: targets with on:'row', selectionKeys are column keys.",
    example: {
      kind: "leaderboard",
      title: "Репозитории с аномальным всплеском звёзд",
      columns: [
        { key: "repo", label: "Репозиторий" },
        { key: "stars_day", label: "Звёзд за день" },
        { key: "burst_ratio", label: "Всплеск, ×медиана" },
      ],
      rows: [
        { repo: "acme/turbo-widget", stars_day: 842, burst_ratio: 70.2 },
        { repo: "dev0/ai-magic", stars_day: 415, burst_ratio: 41.5 },
      ],
      clicks: [
        {
          on: "row",
          selectionKeys: ["repo"],
          drillId: "repo-star-timeline",
          label: "Таймлайн звёзд репозитория",
        },
      ],
    },
  },
  histogram: {
    kind: "histogram",
    summary: "Distribution of a value across labelled buckets.",
    whenToUse:
      "The question is about how a value is distributed: account age at star time, events per account, stars per hour. Great for showing 'too many brand-new accounts'.",
    dataShape:
      "bucketLabel: axis name for the buckets; buckets: [{label, count}] in display order. clicks: targets with on:'bucket', selectable fields 'label', 'count'.",
    example: {
      kind: "histogram",
      title: "Возраст аккаунтов, ставивших звёзды 2 марта",
      bucketLabel: "Возраст аккаунта",
      buckets: [
        { label: "< 7 дней", count: 611 },
        { label: "7–30 дней", count: 128 },
        { label: "1–6 мес", count: 54 },
        { label: "> 6 мес", count: 49 },
      ],
      clicks: [
        {
          on: "bucket",
          selectionKeys: ["label"],
          drillId: "accounts-by-age-bucket",
          label: "Аккаунты из этой корзины",
        },
      ],
    },
  },
  graph: {
    kind: "graph",
    summary: "Network of related entities (nodes + weighted edges).",
    whenToUse:
      "The question is about relationships or clusters: accounts co-starring the same repos, orgs sharing contributors. Cap the output: keep only the top-scoring nodes and set maxNodes accordingly (50 is a good default).",
    dataShape:
      "nodes: [{id, label, score? (suspicion 0..1), size?}]; edges: [{source, target, weight?}] referencing node ids; maxNodes: hard cap, required. No clicks field.",
    example: {
      kind: "graph",
      title: "Ко-старинг: кластер аккаунтов вокруг acme/turbo-widget",
      nodes: [
        { id: "repo:acme/turbo-widget", label: "acme/turbo-widget", size: 24 },
        { id: "user:star-bot-101", label: "star-bot-101", score: 0.97, size: 14 },
        { id: "user:star-bot-102", label: "star-bot-102", score: 0.93, size: 12 },
      ],
      edges: [
        { source: "user:star-bot-101", target: "repo:acme/turbo-widget", weight: 1 },
        { source: "user:star-bot-102", target: "repo:acme/turbo-widget", weight: 1 },
        { source: "user:star-bot-101", target: "user:star-bot-102", weight: 5 },
      ],
      maxNodes: 50,
    },
  },
  heatmap: {
    kind: "heatmap",
    summary: "Intensity matrix over two categorical/time axes.",
    whenToUse:
      "The question is about a pattern across two dimensions: hour-of-day × day-of-week activity, repo × day star matrix. Great for showing machine-like regularity.",
    dataShape:
      "xLabels/yLabels: axis values in display order; cells: [{x, y, value}] where x ∈ xLabels, y ∈ yLabels; sparse cells allowed (missing = 0). clicks: targets with on:'cell', selectable fields 'x', 'y', 'value'.",
    example: {
      kind: "heatmap",
      title: "Звёзды acme/turbo-widget: час × день недели",
      xLabels: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
      yLabels: ["00–06", "06–12", "12–18", "18–24"],
      cells: [
        { x: "Пн", y: "00–06", value: 2 },
        { x: "Сб", y: "12–18", value: 431 },
        { x: "Сб", y: "18–24", value: 388 },
      ],
      clicks: [
        {
          on: "cell",
          selectionKeys: ["x", "y"],
          drillId: "stars-by-hour-slot",
          label: "События в этом слоте",
        },
      ],
    },
  },
  verdict: {
    kind: "verdict",
    summary: "Final conclusion card: verdict sentence, confidence, evidence stats.",
    whenToUse:
      "The investigation has reached a conclusion and you can back it with numbers. Use as the last card of a run; keep the verdict to one or two sentences, put numbers into evidence.",
    dataShape:
      "verdict: the conclusion; confidence: 'low'|'medium'|'high'; evidence: [{label, value: string|number, detail?}] — 2–5 hard stats supporting the verdict.",
    example: {
      kind: "verdict",
      verdict:
        "Всплеск звёзд acme/turbo-widget 2 марта — накрутка: 84% звёзд поставили аккаунты моложе недели, действующие синхронным кластером.",
      confidence: "high",
      evidence: [
        { label: "Всплеск", value: "×70", detail: "842 звезды за день против медианы 12" },
        { label: "Молодые аккаунты", value: "84%", detail: "моложе 7 дней на момент звезды" },
        { label: "Кластер ко-старинга", value: 57, detail: "аккаунтов звездят одни и те же 3 репозитория" },
      ],
    },
  },
};

/**
 * Готовый блок каталога для системного промпта B4: описание + пример JSON
 * по каждому виду карточки.
 */
export function formatViewSpecCatalogForPrompt(): string {
  return Object.values(VIEW_SPEC_CATALOG)
    .map((entry) =>
      [
        `### ${entry.kind}`,
        entry.summary,
        `When to use: ${entry.whenToUse}`,
        `Data shape: ${entry.dataShape}`,
        "Example:",
        "```json",
        JSON.stringify(entry.example, null, 2),
        "```",
      ].join("\n"),
    )
    .join("\n\n");
}
