/**
 * Contract smoke test: `npm run contracts:smoke`.
 * For each ViewSpec kind: a valid example (from VIEW_SPEC_CATALOG — also checks
 * the catalog has not drifted from schemas) parses, an invalid one is rejected.
 * Plus strictness (extra key → error) and targeted ClickContext / Ask / RunStep
 * checks (v2: drill contracts removed).
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
  check(name, !r.success, "expected validation error, but parsing succeeded");
}

// --- Valid examples for all kinds (from catalog) ------------------------------

console.log("Valid ViewSpec (examples from VIEW_SPEC_CATALOG):");
for (const kind of VIEW_KINDS) {
  expectValid(`${kind}: catalog example`, VIEW_SPEC_CATALOG[kind].example);
}

// --- Invalid examples for each kind -------------------------------------------

console.log("Invalid ViewSpec:");
const valid = VIEW_SPEC_CATALOG;

expectInvalid("timeline: v — string instead of number", {
  ...valid.timeline.example,
  series: [{ name: "s", points: [{ t: "2024-03-02", v: "842" }] }],
});
expectInvalid("timeline: anomalyWindow with one date", {
  ...valid.timeline.example,
  anomalyWindow: ["2024-03-02"],
});
expectInvalid("leaderboard: missing columns", {
  kind: "leaderboard",
  title: "t",
  rows: [],
  clicks: [],
});
expectInvalid("leaderboard: row value is an object", {
  ...valid.leaderboard.example,
  rows: [{ repo: { name: "acme/turbo-widget" } }],
});
expectInvalid("histogram: bucket missing count", {
  ...valid.histogram.example,
  buckets: [{ label: "< 7 дней" }],
});
expectInvalid("graph: missing maxNodes", {
  kind: "graph",
  title: "t",
  nodes: [],
  edges: [],
});
expectInvalid("heatmap: value is a string", {
  ...valid.heatmap.example,
  cells: [{ x: "Пн", y: "00–06", value: "3" }],
});
expectInvalid("verdict: confidence outside enum", {
  ...valid.verdict.example,
  confidence: "certain",
});
expectInvalid("bignumber: missing value", {
  kind: "bignumber",
  title: "t",
  label: "звёзд всего",
});
expectInvalid("bignumber: delta is a string instead of number", {
  ...valid.bignumber.example,
  delta: "+412%",
});
expectInvalid("scatter: point x is a string instead of number", {
  ...valid.scatter.example,
  points: [{ x: "2", y: 1, label: "star-bot-101" }],
});
expectInvalid("scatter: missing xLabel", {
  kind: "scatter",
  title: "t",
  points: [{ x: 1, y: 2 }],
  yLabel: "y",
  clicks: [],
});
expectInvalid("map: latitude out of range (100°)", {
  ...valid.map.example,
  points: [{ lat: 100, lon: 30, value: 1 }],
});
expectInvalid("map: point missing lon", {
  ...valid.map.example,
  points: [{ lat: 40.7 }],
});
expectInvalid("treemap: value ≤ 0", {
  ...valid.treemap.example,
  items: [{ label: "Пустое", value: 0 }],
});
expectInvalid("treemap: empty items", {
  ...valid.treemap.example,
  items: [],
});
expectInvalid("funnel: one stage (need ≥ 2)", {
  ...valid.funnel.example,
  stages: [{ label: "Визит", count: 12400 }],
});
expectInvalid("funnel: negative count", {
  ...valid.funnel.example,
  stages: [
    { label: "Визит", count: 100 },
    { label: "Оплата", count: -5 },
  ],
});
expectInvalid("boxplot: non-monotonic quantiles (med < q1)", {
  ...valid.boxplot.example,
  groups: [{ label: "Новые", lo: 4, q1: 11, med: 8, q3: 34, hi: 92 }],
});
expectInvalid("boxplot: missing q3", {
  ...valid.boxplot.example,
  groups: [{ label: "Новые", lo: 4, q1: 11, med: 18, hi: 92 }],
});
expectInvalid("unknown kind", { kind: "piechart", title: "t" });
expectInvalid("strictness: extra key at top level", {
  ...valid.verdict.example,
  extra: 1,
});
expectInvalid("strictness: extra key in ClickTarget", {
  ...valid.histogram.example,
  clicks: [{ on: "bucket", selectionKeys: ["label"], url: "https://evil" }],
});

// --- ClickContext / API / RunStep -------------------------------------------

console.log("ClickContext, Ask API, RunStep:");

check(
  "ClickContext: valid why click",
  clickContextSchema.safeParse({
    cardId: "card-1",
    componentKind: "leaderboard",
    selection: { category: "Электроника", sales_day: 842 },
    action: "why",
  }).success,
);
check(
  "ClickContext: action 'drill' removed from contract — rejected",
  !clickContextSchema.safeParse({
    cardId: "card-1",
    componentKind: "leaderboard",
    selection: {},
    action: "drill",
  }).success,
);
check(
  "AskRequest: question with click context",
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
  "AskRequest: empty question rejected",
  !askRequestSchema.safeParse({ question: "" }).success,
);
check(
  "RunStep: healing with attempt and error",
  runStepSchema.safeParse({
    step: "healing",
    attempt: 2,
    error: "Code: 47. Unknown identifier: star_count",
  }).success,
);
check(
  "RunStep: board_planned carries card manifest",
  runStepSchema.safeParse({
    step: "board_planned",
    cards: [{ cardId: "card-1", kind: "timeline", title: "Заказы по дням" }],
  }).success,
);
check(
  "RunStep: board_planned with empty manifest rejected",
  !runStepSchema.safeParse({ step: "board_planned", cards: [] }).success,
);
check(
  "RunStep: clarify carries question and options",
  runStepSchema.safeParse({
    step: "clarify",
    question: "За какой период считать?",
    options: ["за месяц", "за год"],
  }).success,
);
check(
  "RunStep: impossible carries reason",
  runStepSchema.safeParse({
    step: "impossible",
    reason: "В данных нет сигнала о ценах",
    available: ["события по дням", "топ сущностей"],
  }).success,
);
check(
  "RunStep: card_ready with skeleton cardId",
  runStepSchema.safeParse({
    step: "card_ready",
    cardId: "card-1",
    viewSpec: valid.timeline.example,
  }).success,
);
check(
  "RunStep: card_failed carries error",
  runStepSchema.safeParse({
    step: "card_failed",
    cardId: "card-2",
    error: "SQL не удался после 3 попыток",
  }).success,
);
check(
  "RunStep: done carries viewSpecs",
  runStepSchema.safeParse({
    step: "done",
    viewSpecs: [valid.verdict.example],
  }).success,
);
check(
  "RunStep: done without viewSpecs rejected",
  !runStepSchema.safeParse({ step: "done" }).success,
);
check(
  "RunStep: error without message rejected",
  !runStepSchema.safeParse({ step: "error" }).success,
);
check(
  "RunStep: unknown step rejected",
  !runStepSchema.safeParse({ step: "thinking" }).success,
);

// ----------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\ncontracts:smoke FAILED — checks failed: ${failures}`);
  process.exit(1);
}
console.log("\ncontracts:smoke OK — all checks passed");
