/**
 * Смоук-тест контрактов: `npm run contracts:smoke`.
 * По каждому виду ViewSpec: валидный пример (из VIEW_SPEC_CATALOG — заодно
 * проверяем, что каталог не разъехался со схемами) парсится, невалидный —
 * отклоняется. Плюс строгость (лишний ключ — ошибка) и точечные проверки
 * ClickContext / Drill / Ask / RunStep.
 */
import {
  VIEW_KINDS,
  VIEW_SPEC_CATALOG,
  askRequestSchema,
  clickContextSchema,
  drillRequestSchema,
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

console.log("ClickContext, Drill/Ask API, RunStep:");

check(
  "ClickContext: валидный drill-клик",
  clickContextSchema.safeParse({
    cardId: "card-1",
    componentKind: "leaderboard",
    selection: { repo: "acme/turbo-widget", stars_day: 842 },
    action: "drill",
  }).success,
);
check(
  "ClickContext: action вне enum отклонён",
  !clickContextSchema.safeParse({
    cardId: "card-1",
    componentKind: "leaderboard",
    selection: {},
    action: "zoom",
  }).success,
);
check(
  "DrillRequest: валидный",
  drillRequestSchema.safeParse({
    drillId: "stars-by-day",
    params: { series: "acme/turbo-widget", t: "2024-03-02" },
  }).success,
);
check(
  "DrillRequest: null в params отклонён",
  !drillRequestSchema.safeParse({ drillId: "x", params: { repo: null } }).success,
);
check(
  "AskRequest: вопрос с контекстом клика",
  askRequestSchema.safeParse({
    question: "Почему всплеск звёзд 2 марта?",
    context: {
      cardId: "card-1",
      componentKind: "timeline",
      selection: { t: "2024-03-02", series: "acme/turbo-widget" },
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
