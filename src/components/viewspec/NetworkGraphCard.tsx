"use client";

/**
 * NetworkGraph (C5) — кульминация демо: кластер бот-аккаунтов вокруг репо.
 *
 * Рукописный SVG без зависимостей. Лейаут — детерминированная force-симуляция
 * (Fruchterman–Reingold, фиксированные итерации в useMemo): стартовые позиции
 * из хэша id (никакого Math.random → одинаковая картинка на каждый рендер и
 * без гидрационных расхождений), затем отталкивание всех пар, притяжение по
 * рёбрам (weight усиливает), гравитация к центру, финальная подгонка в кадр.
 *
 * Жёсткий cap maxNodes из спека: узлы сортируются по score (узлы без score —
 * структурные хабы, режутся последними), лишние отбрасываются с пометкой
 * «показаны топ-N».
 *
 * Цвет узла — аномальность: color-mix от нейтрального muted к статусному
 * critical по score; узлы без score (структурные хабы) — series-1. Идентичность
 * не только цветом: легенда + подпись + score в тултипе.
 *
 * Клик узла: в контракте у graph нет clicks[] (решение J1) — клик захардкожен
 * как action:'why' с selection { node: id }, ClickContext это уже позволяет.
 */
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { ClickContext, GraphNode, GraphSpec } from "@/lib/contracts";
import { useNumberFormat } from "@/lib/i18n/formats";

const VB_W = 640;
const VB_H = 360;
const PAD = 36; // поле подгонки: максимальный радиус + подписи хабов

/** Детерминированный хэш строки → [0, 1). FNV-1a. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Радиус узла: size приоритетнее, иначе score; клампы держат кадр. */
function nodeRadius(n: GraphNode): number {
  if (n.size !== undefined) return Math.min(Math.max(3 + n.size * 0.55, 5), 22);
  return 6 + Math.min(Math.max(n.score ?? 0.3, 0), 1) * 8;
}

/** Цвет узла: без score — «структурный» series-1; со score — muted → critical. */
function nodeColor(n: GraphNode): string {
  if (n.score === undefined) return "var(--viz-series-1)";
  const pct = Math.round(Math.min(Math.max(n.score, 0), 1) * 100);
  return `color-mix(in oklab, var(--viz-critical) ${pct}%, var(--muted))`;
}

type LaidNode = { node: GraphNode; x: number; y: number; r: number };

export function NetworkGraphCard({
  spec,
  cardId,
  onClickContext,
}: {
  spec: GraphSpec;
  cardId: string;
  onClickContext?: (ctx: ClickContext) => void;
}) {
  const t = useTranslations("graph");
  const numFmt = useNumberFormat();
  const scoreFmt = useNumberFormat({ maximumFractionDigits: 2 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const clickable = Boolean(onClickContext);

  const layout = useMemo(() => {
    if (spec.nodes.length === 0) return null;

    // --- Cap maxNodes: режем наименее подозрительных; хабы без score живут ---
    const prio = (n: GraphNode) => n.score ?? Number.POSITIVE_INFINITY;
    const sorted = [...spec.nodes].sort((a, b) =>
      prio(a) === prio(b) ? 0 : prio(b) - prio(a),
    );
    const kept = sorted.slice(0, spec.maxNodes);
    const truncated = spec.nodes.length - kept.length;

    const index = new Map(kept.map((n, i) => [n.id, i]));
    const edges = spec.edges.filter(
      (e) => index.has(e.source) && index.has(e.target) && e.source !== e.target,
    );

    // --- Детерминированная force-симуляция (Fruchterman–Reingold) ---
    const n = kept.length;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    kept.forEach((node, i) => {
      const t = hash01(node.id);
      const angle = (i / n) * Math.PI * 2 + t;
      const radius = 0.35 + 0.55 * t;
      xs[i] = VB_W / 2 + Math.cos(angle) * radius * (VB_W / 3);
      ys[i] = VB_H / 2 + Math.sin(angle) * radius * (VB_H / 3);
    });

    const k = Math.sqrt((VB_W * VB_H) / Math.max(n, 1)) * 0.62;
    const ITER = 220;
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let it = 0; it < ITER; it++) {
      const temp = 1 + (VB_W / 9) * (1 - it / ITER);
      dx.fill(0);
      dy.fill(0);
      // Отталкивание всех пар: f = k²/d
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let ddx = xs[i] - xs[j];
          let ddy = ys[i] - ys[j];
          let d = Math.hypot(ddx, ddy);
          if (d < 0.01) {
            // Совпавшие точки разводим детерминированно
            ddx = ((i - j) % 3) + 0.1;
            ddy = ((i + j) % 3) - 0.1;
            d = Math.hypot(ddx, ddy);
          }
          const f = (k * k) / d / d;
          dx[i] += ddx * f;
          dy[i] += ddy * f;
          dx[j] -= ddx * f;
          dy[j] -= ddy * f;
        }
      }
      // Притяжение по рёбрам: f = d/k, weight усиливает связь
      for (const e of edges) {
        const a = index.get(e.source)!;
        const b = index.get(e.target)!;
        const ddx = xs[a] - xs[b];
        const ddy = ys[a] - ys[b];
        const d = Math.max(Math.hypot(ddx, ddy), 0.01);
        const w = Math.sqrt(Math.min(e.weight ?? 1, 9));
        const f = (d / k) * w * 0.9;
        dx[a] -= (ddx / d) * f;
        dy[a] -= (ddy / d) * f;
        dx[b] += (ddx / d) * f;
        dy[b] += (ddy / d) * f;
      }
      // Гравитация к центру + применение с температурным капом
      for (let i = 0; i < n; i++) {
        dx[i] += (VB_W / 2 - xs[i]) * 0.04;
        dy[i] += (VB_H / 2 - ys[i]) * 0.04;
        const d = Math.hypot(dx[i], dy[i]);
        if (d > 0) {
          const step = Math.min(d, temp);
          xs[i] += (dx[i] / d) * step;
          ys[i] += (dy[i] / d) * step;
        }
      }
    }

    // --- Подгонка в кадр: равномерный масштаб + центрирование ---
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, xs[i]);
      maxX = Math.max(maxX, xs[i]);
      minY = Math.min(minY, ys[i]);
      maxY = Math.max(maxY, ys[i]);
    }
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const scale = Math.min((VB_W - PAD * 2) / spanX, (VB_H - PAD * 2) / spanY, 1.6);
    const offX = VB_W / 2 - ((minX + maxX) / 2) * scale;
    const offY = VB_H / 2 - ((minY + maxY) / 2) * scale;

    const laid: LaidNode[] = kept.map((node, i) => ({
      node,
      x: xs[i] * scale + offX,
      y: ys[i] * scale + offY,
      r: nodeRadius(node),
    }));
    const byId = new Map(laid.map((l) => [l.node.id, l]));
    // Крупные узлы рисуем первыми, чтобы мелкие не тонули под хабом
    const drawOrder = [...laid].sort((a, b) => b.r - a.r);

    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    return { laid, byId, drawOrder, edges, degree, truncated };
  }, [spec.nodes, spec.edges, spec.maxNodes]);

  if (!layout) {
    return (
      <p className="px-1 py-6 text-center text-sm text-muted">
        {t("noNodes")}
      </p>
    );
  }
  const { byId, drawOrder, edges, degree, truncated } = layout;

  const hovered = hoverId !== null ? (byId.get(hoverId) ?? null) : null;
  const neighborIds = new Set<string>();
  if (hoverId !== null) {
    neighborIds.add(hoverId);
    for (const e of edges) {
      if (e.source === hoverId) neighborIds.add(e.target);
      if (e.target === hoverId) neighborIds.add(e.source);
    }
  }

  const fire = (node: GraphNode) => {
    // Решение J1: у graph нет clicks[] — клик узла всегда action:'why'
    onClickContext?.({
      cardId,
      componentKind: "graph",
      selection: { node: node.id },
      action: "why",
    });
  };

  return (
    <div>
      {/* Легенда: идентичность не только цветом */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: "var(--viz-series-1)" }}
          />
          {t("hub")}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-1.5 w-16 rounded-full"
            style={{
              background:
                "linear-gradient(90deg, var(--muted), var(--viz-critical))",
            }}
          />
          {t("anomalyScale")}
        </span>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="block w-full"
          role="img"
          aria-label={spec.title}
        >
          {/* Рёбра: рецессивные, hover подсвечивает связи узла */}
          {edges.map((e, i) => {
            const a = byId.get(e.source)!;
            const b = byId.get(e.target)!;
            const active =
              hoverId !== null && (e.source === hoverId || e.target === hoverId);
            const dimmed = hoverId !== null && !active;
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={active ? "var(--accent)" : "var(--viz-axis)"}
                strokeWidth={1 + Math.min((e.weight ?? 1) - 1, 4) * 0.5}
                strokeOpacity={active ? 0.9 : dimmed ? 0.15 : 0.7}
              />
            );
          })}

          {/* Узлы: 2px кольцо цвета поверхности, hover — подсветка соседей */}
          {drawOrder.map((l) => {
            const isHovered = hoverId === l.node.id;
            const dimmed = hoverId !== null && !neighborIds.has(l.node.id);
            const isHub = l.node.score === undefined;
            const deg = degree.get(l.node.id) ?? 0;
            return (
              <g key={l.node.id} opacity={dimmed ? 0.35 : 1}>
                <circle
                  cx={l.x}
                  cy={l.y}
                  r={isHovered ? l.r + 1.5 : l.r}
                  fill={nodeColor(l.node)}
                  stroke={isHovered ? "var(--accent)" : "var(--surface)"}
                  strokeWidth={2}
                  pointerEvents="none"
                />
                {/* Прямые подписи — только структурные хабы (селективно) */}
                {isHub && (
                  <text
                    x={l.x}
                    y={l.y + l.r + 12}
                    textAnchor="middle"
                    fontSize={10}
                    fill="var(--muted)"
                    pointerEvents="none"
                  >
                    {l.node.label}
                  </text>
                )}
                {/* Хит-таргет больше видимого узла */}
                <circle
                  cx={l.x}
                  cy={l.y}
                  r={Math.max(l.r + 4, 14)}
                  fill="transparent"
                  className={clickable ? "cursor-pointer" : undefined}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-label={
                    clickable
                      ? `${l.node.label}${
                          l.node.score !== undefined
                            ? ` · score ${scoreFmt.format(l.node.score)}`
                            : ""
                        } · ${t("links", { count: deg })} — ${t("askWhySuffix")}`
                      : undefined
                  }
                  onMouseEnter={() => setHoverId(l.node.id)}
                  onMouseLeave={() => setHoverId(null)}
                  onFocus={() => setHoverId(l.node.id)}
                  onBlur={() => setHoverId(null)}
                  onClick={() => fire(l.node)}
                  onKeyDown={(e) => {
                    if (clickable && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      fire(l.node);
                    }
                  }}
                />
              </g>
            );
          })}
        </svg>

        {/* Тултип узла */}
        {hovered && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-background px-2.5 py-1.5 shadow-lg"
            style={{
              left: `${(hovered.x / VB_W) * 100}%`,
              top: `${((hovered.y - hovered.r) / VB_H) * 100}%`,
              marginTop: "-10px",
            }}
          >
            <div className="flex items-center gap-1.5 text-sm font-semibold whitespace-nowrap">
              <span
                aria-hidden
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: nodeColor(hovered.node) }}
              />
              {hovered.node.label}
            </div>
            <div className="text-xs whitespace-nowrap text-muted">
              {hovered.node.score !== undefined
                ? `score ${scoreFmt.format(hovered.node.score)} · `
                : ""}
              {t("links", { count: degree.get(hovered.node.id) ?? 0 })}
            </div>
            {clickable && (
              <div className="mt-0.5 text-[10px] whitespace-nowrap text-accent">
                {t("whyNode")}
              </div>
            )}
          </div>
        )}
      </div>

      {truncated > 0 && (
        <p className="mt-2 px-1 text-[11px] text-muted">
          {t("topShown", {
            max: numFmt.format(spec.maxNodes),
            total: numFmt.format(spec.nodes.length),
          })}
        </p>
      )}
      {clickable && (
        <p className="mt-2 px-1 text-[11px] text-muted">
          {t("clickHint")}
        </p>
      )}
    </div>
  );
}
