/**
 * Мок-спеки для ленты (C3): по одному правдоподобному ViewSpec каждого из
 * шести kind в сюжете расследования накрутки звёзд. Форма — строго по
 * контрактам (за основу взяты примеры VIEW_SPEC_CATALOG); порядок в
 * MOCK_FEED повторяет драматургию демо: топ подозрительных → таймлайн
 * всплеска → возраст аккаунтов → регулярность → кластер → вердикт.
 *
 * Живые данные заменят это в B3/C2 (Realtime) и C6 (клики → API).
 */
import type { ViewSpec } from "@/lib/contracts";

export type MockCard = { cardId: string; spec: ViewSpec };

const leaderboard: ViewSpec = {
  kind: "leaderboard",
  title: "Репозитории с аномальным всплеском звёзд (последние 14 дней)",
  columns: [
    { key: "repo", label: "Репозиторий" },
    { key: "stars_day", label: "Звёзд в пик" },
    { key: "burst_ratio", label: "Всплеск, ×медиана" },
    { key: "young_share", label: "Молодых аккаунтов, %" },
  ],
  rows: [
    { repo: "acme/turbo-widget", stars_day: 842, burst_ratio: 70.2, young_share: 84 },
    { repo: "dev0/ai-magic", stars_day: 415, burst_ratio: 41.5, young_share: 77 },
    { repo: "starlab/promo-kit", stars_day: 236, burst_ratio: 19.7, young_share: 61 },
    { repo: "bigco/popular-framework", stars_day: 198, burst_ratio: 2.1, young_share: 9 },
    { repo: "solo-dev/weekend-project", stars_day: 154, burst_ratio: 12.8, young_share: null },
    { repo: "oss-org/honest-lib", stars_day: 121, burst_ratio: 1.4, young_share: 6 },
  ],
  clicks: [
    {
      on: "row",
      selectionKeys: ["repo"],
      drillId: "repo-star-timeline",
      label: "Таймлайн звёзд репозитория",
    },
  ],
};

const timeline: ViewSpec = {
  kind: "timeline",
  title: "Звёзды по дням: acme/turbo-widget против dev0/ai-magic",
  series: [
    {
      name: "acme/turbo-widget",
      points: [
        { t: "2024-02-24", v: 9 },
        { t: "2024-02-25", v: 14 },
        { t: "2024-02-26", v: 11 },
        { t: "2024-02-27", v: 8 },
        { t: "2024-02-28", v: 12 },
        { t: "2024-02-29", v: 10 },
        { t: "2024-03-01", v: 13 },
        { t: "2024-03-02", v: 842 },
        { t: "2024-03-03", v: 761 },
        { t: "2024-03-04", v: 31 },
        { t: "2024-03-05", v: 18 },
        { t: "2024-03-06", v: 12 },
        { t: "2024-03-07", v: 15 },
        { t: "2024-03-08", v: 10 },
      ],
    },
    {
      name: "dev0/ai-magic",
      points: [
        { t: "2024-02-24", v: 6 },
        { t: "2024-02-25", v: 4 },
        { t: "2024-02-26", v: 7 },
        { t: "2024-02-27", v: 5 },
        { t: "2024-02-28", v: 8 },
        { t: "2024-02-29", v: 6 },
        { t: "2024-03-01", v: 5 },
        { t: "2024-03-02", v: 9 },
        { t: "2024-03-03", v: 415 },
        { t: "2024-03-04", v: 44 },
        { t: "2024-03-05", v: 12 },
        { t: "2024-03-06", v: 7 },
        { t: "2024-03-07", v: 6 },
        { t: "2024-03-08", v: 5 },
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
};

const histogram: ViewSpec = {
  kind: "histogram",
  title: "Возраст аккаунтов, ставивших звёзды 2–3 марта",
  bucketLabel: "Возраст аккаунта на момент звезды",
  buckets: [
    { label: "< 1 дня", count: 214 },
    { label: "1–7 дней", count: 397 },
    { label: "7–30 дней", count: 128 },
    { label: "1–6 мес", count: 54 },
    { label: "6–24 мес", count: 31 },
    { label: "> 2 лет", count: 18 },
  ],
  clicks: [
    {
      on: "bucket",
      selectionKeys: ["label"],
      drillId: "accounts-by-age-bucket",
      label: "Аккаунты из этой корзины",
    },
  ],
};

const heatmap: ViewSpec = {
  kind: "heatmap",
  title: "Звёзды acme/turbo-widget: час × день недели",
  xLabels: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
  yLabels: ["00–06", "06–12", "12–18", "18–24"],
  cells: [
    { x: "Пн", y: "06–12", value: 3 },
    { x: "Пн", y: "12–18", value: 5 },
    { x: "Вт", y: "06–12", value: 2 },
    { x: "Вт", y: "12–18", value: 4 },
    { x: "Ср", y: "06–12", value: 2 },
    { x: "Ср", y: "12–18", value: 3 },
    { x: "Ср", y: "18–24", value: 6 },
    { x: "Чт", y: "12–18", value: 3 },
    { x: "Чт", y: "18–24", value: 2 },
    { x: "Пт", y: "06–12", value: 4 },
    { x: "Пт", y: "12–18", value: 7 },
    { x: "Сб", y: "00–06", value: 12 },
    { x: "Сб", y: "06–12", value: 96 },
    { x: "Сб", y: "12–18", value: 431 },
    { x: "Сб", y: "18–24", value: 388 },
    { x: "Вс", y: "00–06", value: 240 },
    { x: "Вс", y: "06–12", value: 41 },
    { x: "Вс", y: "12–18", value: 8 },
    { x: "Вс", y: "18–24", value: 3 },
  ],
  clicks: [
    {
      on: "cell",
      selectionKeys: ["x", "y"],
      drillId: "stars-by-hour-slot",
      label: "События в этом слоте",
    },
  ],
};

/**
 * Граф ко-старинга (кульминация демо): хаб acme/turbo-widget + второй репо,
 * 18 бот-аккаунтов с высоким score (почти все звездят ОБА репо — признак
 * фермы), пара легитимных с низким score и связями только с одним репо.
 * Бот-бот рёбра с weight — синхронные пачки звёзд в одном окне.
 */
const BOTS: Array<{ n: string; score: number; size?: number; both: boolean }> = [
  { n: "star-bot-101", score: 0.97, size: 14, both: true },
  { n: "star-bot-102", score: 0.93, size: 12, both: true },
  { n: "star-bot-103", score: 0.91, size: 12, both: true },
  { n: "star-bot-104", score: 0.9, size: 11, both: true },
  { n: "fresh-dev-2024", score: 0.88, size: 10, both: true },
  { n: "gh-user-77812", score: 0.86, size: 10, both: true },
  { n: "gh-user-77813", score: 0.85, both: true },
  { n: "gh-user-77814", score: 0.85, both: true },
  { n: "nightly-star", score: 0.84, size: 9, both: true },
  { n: "hello-world-9921", score: 0.83, both: true },
  { n: "hello-world-9922", score: 0.82, both: true },
  { n: "dev-acc-swarm-1", score: 0.81, both: true },
  { n: "dev-acc-swarm-2", score: 0.8, both: true },
  { n: "dev-acc-swarm-3", score: 0.79, both: false },
  { n: "new-coder-0301", score: 0.78, both: true },
  { n: "new-coder-0302", score: 0.77, both: false },
  { n: "gitstar-4u", score: 0.75, both: true },
  { n: "starforge-x", score: 0.72, both: false },
];

const graph: ViewSpec = {
  kind: "graph",
  title: "Ко-старинг: кластер аккаунтов вокруг acme/turbo-widget",
  nodes: [
    { id: "repo:acme/turbo-widget", label: "acme/turbo-widget", size: 26 },
    { id: "repo:dev0/ai-magic", label: "dev0/ai-magic", size: 18 },
    ...BOTS.map((b) => ({
      id: `user:${b.n}`,
      label: b.n,
      score: b.score,
      ...(b.size !== undefined ? { size: b.size } : {}),
    })),
    { id: "user:real-contributor", label: "real-contributor", score: 0.12, size: 8 },
    { id: "user:oss-fan-2016", label: "oss-fan-2016", score: 0.08, size: 7 },
    { id: "user:weekend-hacker", label: "weekend-hacker", score: 0.15, size: 6 },
  ],
  edges: [
    // Боты → хаб (все) и второй репо (почти все) — ко-старинг фермы
    ...BOTS.map((b) => ({
      source: `user:${b.n}`,
      target: "repo:acme/turbo-widget",
      weight: 1,
    })),
    ...BOTS.filter((b) => b.both).map((b) => ({
      source: `user:${b.n}`,
      target: "repo:dev0/ai-magic",
      weight: 1,
    })),
    // Синхронные пачки звёзд — плотные бот-бот связи
    { source: "user:star-bot-101", target: "user:star-bot-102", weight: 5 },
    { source: "user:star-bot-102", target: "user:star-bot-103", weight: 4 },
    { source: "user:star-bot-103", target: "user:star-bot-104", weight: 4 },
    { source: "user:dev-acc-swarm-1", target: "user:dev-acc-swarm-2", weight: 3 },
    { source: "user:hello-world-9921", target: "user:hello-world-9922", weight: 3 },
    { source: "user:new-coder-0301", target: "user:new-coder-0302", weight: 2 },
    // Легитимные: только один репо, без бот-бот связей
    { source: "user:real-contributor", target: "repo:acme/turbo-widget", weight: 1 },
    { source: "user:oss-fan-2016", target: "repo:acme/turbo-widget", weight: 1 },
    { source: "user:weekend-hacker", target: "repo:dev0/ai-magic", weight: 1 },
  ],
  maxNodes: 50,
};

const verdict: ViewSpec = {
  kind: "verdict",
  verdict:
    "Всплеск звёзд acme/turbo-widget 2–3 марта — накрутка: 84% звёзд поставили аккаунты моложе недели, действующие синхронным кластером в одном ночном окне.",
  confidence: "high",
  evidence: [
    {
      label: "Всплеск",
      value: "×70",
      detail: "842 звезды за день против медианы 12",
    },
    {
      label: "Молодые аккаунты",
      value: "84%",
      detail: "моложе 7 дней на момент звезды",
    },
    {
      label: "Кластер ко-старинга",
      value: 57,
      detail: "аккаунтов звездят одни и те же 3 репозитория",
    },
    {
      label: "Окно активности",
      value: "6 ч",
      detail: "95% звёзд аномалии — суббота 12:00–18:00 UTC",
    },
  ],
};

/** Лента демо: порядок повторяет драматургию расследования. */
export const MOCK_FEED: MockCard[] = [
  { cardId: "mock-leaderboard-01", spec: leaderboard },
  { cardId: "mock-timeline-02", spec: timeline },
  { cardId: "mock-histogram-03", spec: histogram },
  { cardId: "mock-heatmap-04", spec: heatmap },
  { cardId: "mock-graph-05", spec: graph },
  { cardId: "mock-verdict-06", spec: verdict },
];
