/**
 * Смоук-тест контрактов: `npm run contracts:smoke`.
 * По каждому виду ViewSpec: валидный пример (из VIEW_SPEC_CATALOG — заодно
 * проверяем, что каталог не разъехался со схемами) парсится, невалидный —
 * отклоняется. Плюс строгость (лишний ключ — ошибка) и точечные проверки
 * ClickContext / Ask / RunStep (v2: дрилл-контракты удалены).
 */
import {
  VIEW_KINDS,
  VIEW_SPEC_CATALOG,
  askRequestSchema,
  clickContextSchema,
  runStepSchema,
  viewSpecSchema,
} from "../src/lib/contracts";

let failures = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok      ${name}`);
  } else {
    failures += 1;
    console.error(`  FAILED  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function expectValid(name: string, value: unknown) {
  const r = viewSpecSchema.safeParse(value);
  check(name, r.success, r.success ? undefined : r.error.issues[0]?.message);
}

function expectInvalid(name: string, value: unknown) {
  const r = viewSpecSchema.safeParse(value);
  check(name, !r.success, "ожидалась ошибка валидации, но парсинг прошёл");
}

// --- Валидные примеры всех видов (из каталога) ------------------------------

console.log("Валидные ViewSpec (примеры из VIEW_SPEC_CATALOG):");
for (const kind of VIEW_KINDS) {
  expectValid(`${kind}: пример каталога`, VIEW_SPEC_CATALOG[kind].example);
}

// --- Невалидные примеры каждого вида ----------------------------------------

console.log("Невалидные ViewSpec:");
const valid = VIEW_SPEC_CATALOG;

expectInvalid("timeline: v — строка вместо числа", {
  ...valid.timeline.example,
  series: [{ name: "s", points: [{ t: "2024-03-02", v: "842" }] }],
});
expectInvalid("timeline: anomalyWindow из одной даты", {
  ...valid.timeline.example,
  anomalyWindow: ["2024-03-02"],
});
expectInvalid("leaderboard: нет columns", {
  kind: "leaderboard",
  title: "t",
  rows: [],
  clicks: [],
});
expectInvalid("leaderboard: значение строки — объект", {
  ...valid.leaderboard.example,
  rows: [{ repo: { name: "acme/turbo-widget" } }],
});
expectInvalid("histogram: у корзины нет count", {
  ...valid.histogram.example,
  buckets: [{ label: "< 7 дней" }],
});
expectInvalid("graph: нет maxNodes", {
  kind: "graph",
  title: "t",
  nodes: [],
  edges: [],
});
expectInvalid("heatmap: value — строка", {
  ...valid.heatmap.example,
  cells: [{ x: "Пн", y: "00–06", value: "3" }],
});
expectInvalid("verdict: confidence вне enum", {
  ...valid.verdict.example,
  confidence: "certain",
});
expectInvalid("bignumber: нет value", {
  kind: "bignumber",
  title: "t",
  label: "звёзд всего",
});
expectInvalid("bignumber: delta — строка вместо числа", {
  ...valid.bignumber.example,
  delta: "+412%",
});
expectInvalid("scatter: x точки — строка вместо числа", {
  ...valid.scatter.example,
  points: [{ x: "2", y: 1, label: "star-bot-101" }],
});
expectInvalid("scatter: нет xLabel", {
  kind: "scatter",
  title: "t",
  points: [{ x: 1, y: 2 }],
  yLabel: "y",
  clicks: [],
});
expectInvalid("map: широта вне диапазона (100°)", {
  ...valid.map.example,
  points: [{ lat: 100, lon: 30, value: 1 }],
});
expectInvalid("map: точка без lon", {
  ...valid.map.example,
  points: [{ lat: 40.7 }],
});
expectInvalid("treemap: value ≤ 0", {
  ...valid.treemap.example,
  items: [{ label: "Пустое", value: 0 }],
});
expectInvalid("treemap: пустой items", {
  ...valid.treemap.example,
  items: [],
});
expectInvalid("funnel: один этап (нужно ≥ 2)", {
  ...valid.funnel.example,
  stages: [{ label: "Визит", count: 12400 }],
});
expectInvalid("funnel: count отрицательный", {
  ...valid.funnel.example,
  stages: [
    { label: "Визит", count: 100 },
    { label: "Оплата", count: -5 },
  ],
});
expectInvalid("boxplot: квантили немонотонны (med < q1)", {
  ...valid.boxplot.example,
  groups: [{ label: "Новые", lo: 4, q1: 11, med: 8, q3: 34, hi: 92 }],
});
expectInvalid("boxplot: нет q3", {
  ...valid.boxplot.example,
  groups: [{ label: "Новые", lo: 4, q1: 11, med: 18, hi: 92 }],
});
expectInvalid("неизвестный kind", { kind: "piechart", title: "t" });
expectInvalid("строгость: лишний ключ на верхнем уровне", {
  ...valid.verdict.example,
  extra: 1,
});
expectInvalid("строгость: лишний ключ в ClickTarget", {
  ...valid.histogram.example,
  clicks: [{ on: "bucket", selectionKeys: ["label"], url: "https://evil" }],
});

// --- ClickContext / API / RunStep -------------------------------------------

console.log("ClickContext, Ask API, RunStep:");

check(
  "ClickContext: валидный why-клик",
  clickContextSchema.safeParse({
    cardId: "card-1",
    componentKind: "leaderboard",
    selection: { category: "Электроника", sales_day: 842 },
    action: "why",
  }).success,
);
check(
  "ClickContext: action 'drill' удалён из контракта — отклонён",
  !clickContextSchema.safeParse({
    cardId: "card-1",
    componentKind: "leaderboard",
    selection: {},
    action: "drill",
  }).success,
);
check(
  "AskRequest: вопрос с контекстом клика",
  askRequestSchema.safeParse({
    question: "Почему всплеск продаж 2 марта?",
    context: {
      cardId: "card-1",
      componentKind: "timeline",
      selection: { t: "2024-03-02", series: "заказы" },
      action: "why",
    },
  }).success,
);
check(
  "AskRequest: пустой question отклонён",
  !askRequestSchema.safeParse({ question: "" }).success,
);
check(
  "RunStep: healing с попыткой и ошибкой",
  runStepSchema.safeParse({
    step: "healing",
    attempt: 2,
    error: "Code: 47. Unknown identifier: star_count",
  }).success,
);
check(
  "RunStep: board_planned несёт манифест карточек",
  runStepSchema.safeParse({
    step: "board_planned",
    cards: [{ cardId: "card-1", kind: "timeline", title: "Заказы по дням" }],
  }).success,
);
check(
  "RunStep: board_planned с пустым манифестом отклонён",
  !runStepSchema.safeParse({ step: "board_planned", cards: [] }).success,
);
check(
  "RunStep: clarify несёт вопрос и варианты",
  runStepSchema.safeParse({
    step: "clarify",
    question: "За какой период считать?",
    options: ["за месяц", "за год"],
  }).success,
);
check(
  "RunStep: impossible несёт причину",
  runStepSchema.safeParse({
    step: "impossible",
    reason: "В данных нет сигнала о ценах",
    available: ["события по дням", "топ сущностей"],
  }).success,
);
check(
  "RunStep: card_ready с cardId скелета",
  runStepSchema.safeParse({
    step: "card_ready",
    cardId: "card-1",
    viewSpec: valid.timeline.example,
  }).success,
);
check(
  "RunStep: card_failed несёт ошибку",
  runStepSchema.safeParse({
    step: "card_failed",
    cardId: "card-2",
    error: "SQL не удался после 3 попыток",
  }).success,
);
check(
  "RunStep: done несёт viewSpecs",
  runStepSchema.safeParse({
    step: "done",
    viewSpecs: [valid.verdict.example],
  }).success,
);
check(
  "RunStep: done без viewSpecs отклонён",
  !runStepSchema.safeParse({ step: "done" }).success,
);
check(
  "RunStep: error без message отклонён",
  !runStepSchema.safeParse({ step: "error" }).success,
);
check(
  "RunStep: неизвестный шаг отклонён",
  !runStepSchema.safeParse({ step: "thinking" }).success,
);

// ----------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\ncontracts:smoke FAILED — проверок упало: ${failures}`);
  process.exit(1);
}
console.log("\ncontracts:smoke OK — все проверки прошли");
