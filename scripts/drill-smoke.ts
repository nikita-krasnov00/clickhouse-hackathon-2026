/**
 * A4 — смоук drill-каталога: каждый drillId с реальными параметрами героев A3,
 * замер времени, валидация viewSpecSchema. Запуск: npm run drill:smoke
 */
import { createReadonlyClient } from "../src/lib/clickhouse";
import { viewSpecSchema } from "../src/lib/contracts";
import { resolveDrill } from "../src/lib/drills";

const CASES: { drillId: string; params: Record<string, string | number> }[] = [
  { drillId: "stars-by-day", params: { repo: "solidSpoon/DashPlayer" } },
  { drillId: "actors-of-day", params: { series: "solidSpoon/DashPlayer", t: "2024-05-17" } },
  { drillId: "actor-age-profile", params: { repo: "OpenInterpreter/01" } },
  { drillId: "co-starred-repos", params: { repo: "solidSpoon/DashPlayer" } },
  { drillId: "costar-graph", params: { repo: "solidSpoon/DashPlayer", maxNodes: 20 } },
  { drillId: "hourly-heatmap", params: { repo: "deepseek-ai/DeepSeek-VL" } },
  { drillId: "cell-actors:deepseek-ai/DeepSeek-VL", params: { x: 12, y: "2024-03-13" } },
  // actor подставляется живьём из результата actors-of-day (см. main).
  { drillId: "actor-timeline", params: { actor: "__from-actors-of-day__" } },
  { drillId: "burst-metrics", params: { repo: "deepseek-ai/DeepSeek-VL" } },
  { drillId: "burst-metrics", params: { repo: "xai-org/grok-1" } },
  { drillId: "one-and-done", params: { repo: "deepseek-ai/DeepSeek-VL" } },
];

async function main() {
  const client = createReadonlyClient();
  let failed = 0;
  let liveActor = "";
  try {
    for (const c of CASES) {
      const t0 = Date.now();
      try {
        const def = resolveDrill(c.drillId);
        if (c.params.actor === "__from-actors-of-day__") {
          if (!liveActor) throw new Error("actors-of-day не дал ни одного актора");
          c.params.actor = liveActor;
        }
        const params = def.params.parse(c.params);
        const spec = viewSpecSchema.parse(await def.execute(client, params));
        const ms = Date.now() - t0;
        if (c.drillId === "actors-of-day" && spec.kind === "leaderboard") {
          liveActor = String(spec.rows[0]?.actor ?? "");
        }
        const size =
          spec.kind === "timeline"
            ? `${spec.series[0]?.points.length ?? 0} точек`
            : spec.kind === "leaderboard"
              ? `${spec.rows.length} строк`
              : spec.kind === "graph"
                ? `${spec.nodes.length} узлов / ${spec.edges.length} рёбер`
                : spec.kind === "heatmap"
                  ? `${spec.cells.length} ячеек`
                  : spec.kind === "histogram"
                    ? `${spec.buckets.length} корзин`
                    : spec.kind === "scatter"
                      ? `${spec.points.length} точек`
                      : spec.kind === "bignumber"
                        ? `значение ${spec.value}`
                        : `${spec.evidence.length} улик`;
        const over = ms > 300 ? "  ⚠ >300мс" : "";
        console.log(
          `OK   ${c.drillId.padEnd(40)} ${String(ms).padStart(5)} мс  ${spec.kind}: ${size}${over}`,
        );
      } catch (err) {
        failed++;
        console.error(
          `FAIL ${c.drillId.padEnd(40)} ${Date.now() - t0} мс — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } finally {
    await client.close();
  }
  console.log(failed === 0 ? "\ndrill-smoke: все зелёные" : `\ndrill-smoke: ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
