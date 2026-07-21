/**
 * VIEW_SPEC_CATALOG — каталог компонентов для промпта text-to-SQL (задача B4).
 * Одно место правды о том, какие карточки бывают, когда какую выбирать и как
 * выглядит валидный JSON. Примеры типизированы точным вариантом ViewSpec и
 * прогоняются через схемы в contracts:smoke — каталог не может разъехаться
 * с контрактом.
 *
 * Примеры НАРОЧНО нейтральные (заказы/выручка/сегменты): движок
 * dataset-agnostic, домен приходит из живого schema context, а не из каталога.
 * Описания — на английском (уходят в промпт LLM), заголовки примеров — на
 * русском (язык демо; промпт просит писать title на языке вопроса).
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
      title: "Заказы по дням",
      series: [
        {
          name: "заказы",
          points: [
            { t: "2024-03-01", v: 120 },
            { t: "2024-03-02", v: 842 },
            { t: "2024-03-03", v: 131 },
          ],
        },
      ],
      anomalyWindow: ["2024-03-02", "2024-03-03"],
      clicks: [
        {
          on: "point",
          selectionKeys: ["t", "series"],
          label: "Разобраться с этим моментом",
        },
      ],
    },
  },
  leaderboard: {
    kind: "leaderboard",
    summary: "Ranked table of entities with a few metric columns.",
    whenToUse:
      "The question is 'which/top N': entities ranked by a metric. Best entry point of an investigation — rows are clickable.",
    dataShape:
      "columns: [{key, label}] define the table; rows: records keyed by column key, values string|number|null (null renders as a dash). clicks: targets with on:'row', selectionKeys are column keys.",
    example: {
      kind: "leaderboard",
      title: "Категории с аномальным всплеском продаж",
      columns: [
        { key: "category", label: "Категория" },
        { key: "sales_day", label: "Продаж за день" },
        { key: "burst_ratio", label: "Всплеск, ×медиана" },
      ],
      rows: [
        { category: "Электроника", sales_day: 842, burst_ratio: 7.2 },
        { category: "Игрушки", sales_day: 415, burst_ratio: 4.5 },
      ],
      clicks: [
        {
          on: "row",
          selectionKeys: ["category"],
          label: "Разобраться с этой строкой",
        },
      ],
    },
  },
  histogram: {
    kind: "histogram",
    summary: "Distribution of a value across labelled buckets.",
    whenToUse:
      "The question is about how a value is distributed: order size buckets, entity age, events per entity. Great for showing 'the mass is concentrated in one bucket'.",
    dataShape:
      "bucketLabel: axis name for the buckets; buckets: [{label, count}] in display order. clicks: targets with on:'bucket', selectable fields 'label', 'count'.",
    example: {
      kind: "histogram",
      title: "Распределение чеков по размеру",
      bucketLabel: "Размер чека",
      buckets: [
        { label: "< 10", count: 611 },
        { label: "10–100", count: 128 },
        { label: "100–1000", count: 54 },
        { label: "> 1000", count: 9 },
      ],
      clicks: [
        {
          on: "bucket",
          selectionKeys: ["label"],
          label: "Что попало в эту корзину?",
        },
      ],
    },
  },
  graph: {
    kind: "graph",
    summary: "Network of related entities (nodes + weighted edges).",
    whenToUse:
      "The question is about relationships/links between entity PAIRS: who co-occurs with whom, clusters around hubs, communities. The pipeline builds it from pair rows (source, target, weight) — node sizes and anomaly scores are derived from weighted degree automatically.",
    dataShape:
      "nodes: [{id, label, score? (anomaly 0..1 → color), size?}]; edges: [{source, target, weight?}] referencing node ids; maxNodes: hard cap, required. Node click is built in (selection {node: id}) — no clicks field.",
    example: {
      kind: "graph",
      title: "Кластер связанных сущностей",
      nodes: [
        { id: "hub:alpha", label: "alpha", size: 24 },
        { id: "node:beta", label: "beta", score: 0.97, size: 14 },
        { id: "node:gamma", label: "gamma", score: 0.93, size: 12 },
      ],
      edges: [
        { source: "node:beta", target: "hub:alpha", weight: 1 },
        { source: "node:gamma", target: "hub:alpha", weight: 1 },
        { source: "node:beta", target: "node:gamma", weight: 5 },
      ],
      maxNodes: 50,
    },
  },
  heatmap: {
    kind: "heatmap",
    summary: "Intensity matrix over two categorical/time axes.",
    whenToUse:
      "The question is about a pattern across two dimensions: hour-of-day × day-of-week activity, category × day matrix. Great for showing machine-like regularity.",
    dataShape:
      "xLabels/yLabels: axis values in display order; cells: [{x, y, value}] where x ∈ xLabels, y ∈ yLabels; sparse cells allowed (missing = 0). clicks: targets with on:'cell', selectable fields 'x', 'y', 'value'.",
    example: {
      kind: "heatmap",
      title: "Активность: час × день недели",
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
          label: "Разобраться с этим слотом",
        },
      ],
    },
  },
  verdict: {
    kind: "verdict",
    summary: "Final conclusion card: verdict sentence, confidence, evidence stats.",
    whenToUse:
      "The investigation has reached a conclusion and you can back it with numbers. Use as the last card of a run; keep the verdict to one or two sentences, put numbers into evidence. Also the honest way to say the data cannot answer the question.",
    dataShape:
      "verdict: the conclusion; confidence: 'low'|'medium'|'high'; evidence: [{label, value: string|number, detail?}] — 2–5 hard stats supporting the verdict.",
    example: {
      kind: "verdict",
      verdict:
        "Всплеск продаж 2 марта аномален: ×70 к медиане, 84% заказов пришли из одного сегмента за два часа.",
      confidence: "high",
      evidence: [
        { label: "Всплеск", value: "×70", detail: "842 заказа за день против медианы 12" },
        { label: "Концентрация", value: "84%", detail: "доля одного сегмента в пике" },
        { label: "Окно", value: "2 часа", detail: "почти все события — в узком интервале" },
      ],
    },
  },
  bignumber: {
    kind: "bignumber",
    summary: "Single large KPI: one value with a label, optional % delta and detail caption.",
    whenToUse:
      "The answer is ONE number: a total, a share, a count. Prefer it over a one-row leaderboard. Add delta only when there is a meaningful baseline to compare against (previous period, median).",
    dataShape:
      "value: number or pre-formatted string ('84%', '×70'); label: what the number means; delta: optional number, % change vs baseline (positive renders green, negative red); detail: optional secondary caption. No clicks field.",
    example: {
      kind: "bignumber",
      title: "Выручка за 14 дней",
      value: 180300,
      label: "выручка за последние 14 дней",
      delta: 41.5,
      detail: "против медианы 127 400 в предыдущие периоды",
    },
  },
  map: {
    kind: "map",
    summary:
      "Geographic scatter: points {lat, lon} on an auto-fitted map pane, with optional per-point value (marker size/intensity) and label.",
    whenToUse:
      "The question is about WHERE something happens: spatial density, hotspots, geographic spread. ONLY when the data really carries coordinate columns (latitude/longitude in degrees) — never geocode names yourself. Aggregate dense raw coordinates in SQL (round to 2–3 decimals + count()/sum()) instead of returning raw event rows.",
    dataShape:
      "points: [{lat: -90..90, lon: -180..180, value?: number (aggregated weight → marker size/intensity), label?: string (entity name)}], ≤ 1000 points; valueLabel: what value means (legend). clicks: targets with on:'point', selectable fields 'lat', 'lon', 'value', 'label'.",
    example: {
      kind: "map",
      title: "Плотность заказов по районам города",
      valueLabel: "заказы",
      points: [
        { lat: 40.758, lon: -73.9855, value: 412, label: "Midtown" },
        { lat: 40.7128, lon: -74.006, value: 260, label: "Downtown" },
        { lat: 40.6413, lon: -73.7781, value: 88, label: "Airport" },
      ],
      clicks: [
        {
          on: "point",
          selectionKeys: ["label", "lat", "lon"],
          label: "Разобраться с этой точкой",
        },
      ],
    },
  },
  treemap: {
    kind: "treemap",
    summary:
      "Treemap of a whole: tiles whose area is the share of each part in the total; optional top-level groups give color and legend.",
    whenToUse:
      "The question is about composition / share of a whole: «из чего состоит», «что доминирует», «какая доля». Prefer it over leaderboard when the share of the total matters more than exact ranks. Fold the long tail into an «прочее» bucket in SQL so the shown tiles really are the whole.",
    dataShape:
      "items: [{label, value > 0, group?: string (top-level group → color/legend)}], ≤ 40 tiles; valueLabel: what value means (tooltip). clicks: on:'tile', selectable fields 'label', 'value', 'group'.",
    example: {
      kind: "treemap",
      title: "Из чего состоит выручка",
      valueLabel: "выручка",
      items: [
        { label: "Ноутбуки", value: 421000, group: "Электроника" },
        { label: "Смартфоны", value: 388000, group: "Электроника" },
        { label: "Диваны", value: 154000, group: "Мебель" },
        { label: "Столы", value: 61000, group: "Мебель" },
        { label: "Прочее", value: 90000 },
      ],
      clicks: [
        {
          on: "tile",
          selectionKeys: ["label"],
          label: "Разобраться с этой категорией",
        },
      ],
    },
  },
  funnel: {
    kind: "funnel",
    summary:
      "Staged funnel: ordered stages with counts; the card computes stage-to-stage and overall conversion itself.",
    whenToUse:
      "The question is about a staged process: conversion, drop-off, «где теряем», «какая воронка». Stages go in process order, widest first. Use windowFunnel() for strict event sequences per user/session.",
    dataShape:
      "stages: [{label, count}] in funnel order (first = widest), at least 2 stages. clicks: on:'bucket', selectable fields 'label', 'count'.",
    example: {
      kind: "funnel",
      title: "Воронка заказа: визит → оплата",
      stages: [
        { label: "Визит", count: 12400 },
        { label: "Корзина", count: 3100 },
        { label: "Оформление", count: 1450 },
        { label: "Оплата", count: 1180 },
      ],
      clicks: [
        {
          on: "bucket",
          selectionKeys: ["label"],
          label: "Кто отвалился на этом этапе?",
        },
      ],
    },
  },
  boxplot: {
    kind: "boxplot",
    summary:
      "Box plots comparing the distribution of one numeric metric across groups: median, quartile box, p05–p95 whiskers.",
    whenToUse:
      "The question compares HOW a numeric metric is distributed across groups: «как отличается чек по сегментам», spread, skew, outliers. One quantiles() row per group is cheap in ClickHouse. Prefer it over histogram when there are 2+ groups to compare.",
    dataShape:
      "groups: [{label, lo, q1, med, q3, hi}] — five ascending quantiles per group (lo/hi are the p05/p95 whiskers), ≤ 20 groups; valueLabel: metric name for the axis. clicks: on:'box', selectable fields 'label', 'med'.",
    example: {
      kind: "boxplot",
      title: "Размер чека по сегментам покупателей",
      valueLabel: "сумма чека",
      groups: [
        { label: "Новые", lo: 4, q1: 11, med: 18, q3: 34, hi: 92 },
        { label: "Постоянные", lo: 9, q1: 24, med: 41, q3: 78, hi: 210 },
        { label: "Оптовые", lo: 120, q1: 340, med: 610, q3: 980, hi: 2400 },
      ],
      clicks: [
        {
          on: "box",
          selectionKeys: ["label"],
          label: "Разобраться с этим сегментом",
        },
      ],
    },
  },
  scatter: {
    kind: "scatter",
    summary:
      "Scatter plot: entities as points on two numeric axes; the card draws a trend line and Pearson r itself.",
    whenToUse:
      "The question is about a relationship/dependency between two numeric properties of many entities: price vs volume, size vs frequency. The trend line + r answer «is there a relationship?» directly. Tight clusters expose anomalous groups. Keep at most 500 points.",
    dataShape:
      "points: [{x: number, y: number, label?: string (entity name)}], ≤ 500 points, RAW numbers (never log-transform in SQL). xLabel/yLabel: plain quantity names. xScale/yScale: 'log' when a quantity spans orders of magnitude — the card log-scales the axis and labels ticks with real values. clicks: targets with on:'point', selectable fields 'x', 'y', 'label'.",
    example: {
      kind: "scatter",
      title: "Цена vs объём продаж: есть ли связь?",
      points: [
        { x: 46475, y: 812, label: "SKU-1042" },
        { x: 5300, y: 240, label: "SKU-0077" },
        { x: 120, y: 15, label: "SKU-0009" },
      ],
      xLabel: "Цена",
      yLabel: "Продажи",
      xScale: "log",
      yScale: "log",
      clicks: [
        {
          on: "point",
          selectionKeys: ["label"],
          label: "Разобраться с этой точкой",
        },
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
