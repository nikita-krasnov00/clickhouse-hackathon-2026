"use client";

/**
 * Map — гео-точки {lat, lon, value?, label?} на SVG-карте С ПОДЛОЖКОЙ.
 *
 * Подложка — растровые тайлы CARTO dark_matter (© OpenStreetMap © CARTO):
 * тёмная, в тон приложению; атрибуция — в подписи под картой (обязательна по
 * лицензии). Проекция — Web Mercator (иначе тайлы не лягут); зум подбирается
 * так, чтобы bounding box точек влез в панель, тайлы режутся clipPath.
 * ОФФЛАЙН-ФОЛЛБЕК: пока не загрузился ни один тайл (или сеть недоступна),
 * рисуется прежняя градусная сетка — карточка никогда не пустая.
 *
 * Величина value кодируется ПОСЛЕДОВАТЕЛЬНО одной тональностью: площадь
 * маркера (sqrt-шкала) + непрозрачность; кольцо поверхности отделяет маркеры
 * от пёстрой подложки. Hover-тултип, хит-таргет ≥ 12px, клавиатура; клик по
 * точке → ClickContext (on:'point').
 */
import { useId, useMemo, useState } from "react";
import type { ClickContext, MapPoint, MapSpec } from "@/lib/contracts";
import { buildClickContext, findClickTarget, mapPointElementFields } from "./click";

const VB_W = 640;
const VB_H = 300;
const M = { top: 10, right: 10, bottom: 22, left: 40 };
/** Экранный размер тайла в единицах viewBox (256 @2x — чётко на ретине). */
const TILE = 256;
const MAX_ZOOM = 18;

const numFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

/** Тайлы CARTO (dark) — бесплатная подложка с обязательной атрибуцией. */
function tileUrl(z: number, x: number, y: number): string {
  const sub = "abcd"[(x + y) % 4];
  return `https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}@2x.png`;
}

/** «Красивый» шаг градусной сетки под размах в градусах (оффлайн-фоллбек). */
function niceDegreeStep(span: number): number {
  const steps = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 45];
  const rough = span / 4;
  for (const s of steps) {
    if (s >= rough) return s;
  }
  return 45;
}

/** Подпись координаты с точностью шага сетки: 40.75° / −73.98°. */
function fmtDegree(v: number, step: number): string {
  const decimals = Math.max(0, Math.min(4, -Math.floor(Math.log10(step))));
  return `${v.toFixed(decimals)}°`;
}

/** Web Mercator: (lon, lat) → нормализованные мировые координаты [0..1]. */
function mercX(lon: number): number {
  return (lon + 180) / 360;
}
function mercY(lat: number): number {
  // Кламп ±85.05° — предел проекции; на данных это не сказывается.
  const phi = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
}

type Tile = { key: string; url: string; px: number; py: number };

type Projection = {
  x: (lon: number) => number;
  y: (lat: number) => number;
  tiles: Tile[];
  latTicks: number[];
  lonTicks: number[];
  latStep: number;
  lonStep: number;
};

/** Проекция Web Mercator, вписанная в панель, + список тайлов подложки. */
function buildProjection(points: MapPoint[]): Projection {
  let minLat = Math.min(...points.map((p) => p.lat));
  let maxLat = Math.max(...points.map((p) => p.lat));
  let minLon = Math.min(...points.map((p) => p.lon));
  let maxLon = Math.max(...points.map((p) => p.lon));

  // Вырожденный размах (одна точка) — раздвигаем на ±0.01°.
  if (maxLat - minLat < 1e-6) {
    minLat -= 0.01;
    maxLat += 0.01;
  }
  if (maxLon - minLon < 1e-6) {
    minLon -= 0.01;
    maxLon += 0.01;
  }
  // Поля 6% — маркеры у края не режутся рамкой.
  const padLat = (maxLat - minLat) * 0.06;
  const padLon = (maxLon - minLon) * 0.06;
  minLat -= padLat;
  maxLat += padLat;
  minLon -= padLon;
  maxLon += padLon;

  const innerW = VB_W - M.left - M.right;
  const innerH = VB_H - M.top - M.bottom;

  // Зум: bounding box (в мировых координатах Меркатора) должен влезть в панель.
  const dmx = Math.max(mercX(maxLon) - mercX(minLon), 1e-9);
  const dmy = Math.max(mercY(minLat) - mercY(maxLat), 1e-9); // y растёт вниз
  const zFit = Math.floor(
    Math.log2(Math.min(innerW / (TILE * dmx), innerH / (TILE * dmy))),
  );
  const z = Math.max(1, Math.min(MAX_ZOOM, zFit));
  const world = TILE * 2 ** z; // размер мира в px на этом зуме

  // Центровка bbox в панели.
  const cx = (mercX(minLon) + mercX(maxLon)) / 2;
  const cy = (mercY(maxLat) + mercY(minLat)) / 2;
  const panelCx = M.left + innerW / 2;
  const panelCy = M.top + innerH / 2;

  const x = (lon: number) => panelCx + (mercX(lon) - cx) * world;
  const y = (lat: number) => panelCy + (mercY(lat) - cy) * world;

  // Тайлы, покрывающие панель: от левого-верхнего угла панели в мир и обратно.
  const worldLeft = cx + (M.left - panelCx) / world;
  const worldTop = cy + (M.top - panelCy) / world;
  const worldRight = cx + (VB_W - M.right - panelCx) / world;
  const worldBottom = cy + (VB_H - M.bottom - panelCy) / world;
  const n = 2 ** z;
  const txMin = Math.max(0, Math.floor(worldLeft * n));
  const txMax = Math.min(n - 1, Math.floor(worldRight * n));
  const tyMin = Math.max(0, Math.floor(worldTop * n));
  const tyMax = Math.min(n - 1, Math.floor(worldBottom * n));
  const tiles: Tile[] = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      tiles.push({
        key: `${z}/${tx}/${ty}`,
        url: tileUrl(z, tx, ty),
        px: panelCx + (tx / n - cx) * world,
        py: panelCy + (ty / n - cy) * world,
      });
    }
  }

  // Градусные тики (подписи всегда; линии — только в оффлайн-фоллбеке).
  const latStep = niceDegreeStep(maxLat - minLat);
  const lonStep = niceDegreeStep(maxLon - minLon);
  const latTicks: number[] = [];
  for (let v = Math.ceil(minLat / latStep) * latStep; v <= maxLat; v += latStep) {
    latTicks.push(+v.toFixed(6));
  }
  const lonTicks: number[] = [];
  for (let v = Math.ceil(minLon / lonStep) * lonStep; v <= maxLon; v += lonStep) {
    lonTicks.push(+v.toFixed(6));
  }
  return { x, y, tiles, latTicks, lonTicks, latStep, lonStep };
}

/** Размер/яркость по value: sqrt-шкала площади + непрозрачность (одна тональность). */
function buildValueScale(points: MapPoint[]) {
  const values = points.filter((p) => p.value !== undefined).map((p) => p.value as number);
  if (values.length === 0) {
    return {
      hasValues: false as const,
      r: () => 3.5,
      opacity: () => 0.55,
      min: 0,
      max: 0,
    };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const norm = (v: number) => (max - min < 1e-9 ? 0.5 : (v - min) / (max - min));
  return {
    hasValues: true as const,
    r: (v: number | undefined) => (v === undefined ? 3 : 3 + 9 * Math.sqrt(norm(v))),
    opacity: (v: number | undefined) => (v === undefined ? 0.4 : 0.45 + 0.5 * norm(v)),
    min,
    max,
  };
}

type Hover = { idx: number; cx: number; cy: number } | null;

export function MapCard({
  spec,
  cardId,
  onClickContext,
}: {
  spec: MapSpec;
  cardId: string;
  onClickContext?: (ctx: ClickContext) => void;
}) {
  const [hover, setHover] = useState<Hover>(null);
  /** Сколько тайлов подложки реально загрузилось: 0 → оффлайн-фоллбек с сеткой. */
  const [tilesLoaded, setTilesLoaded] = useState(0);
  const clipId = useId();
  const pointTarget = findClickTarget(spec.clicks, "point");
  const clickable = Boolean(pointTarget && onClickContext);

  const layout = useMemo(() => {
    if (spec.points.length === 0) return null;
    const proj = buildProjection(spec.points);
    const scale = buildValueScale(spec.points);
    // Крупные снизу, мелкие сверху — маленькие точки не тонут под большими.
    const order = spec.points
      .map((p, idx) => ({ p, idx }))
      .sort((a, b) => (b.p.value ?? 0) - (a.p.value ?? 0));
    return { proj, scale, order };
  }, [spec.points]);

  if (!layout) {
    return (
      <p className="px-1 py-6 text-center text-sm text-muted">Нет точек для отображения</p>
    );
  }
  const { proj, scale, order } = layout;
  const basemapVisible = tilesLoaded > 0;

  const fire = (idx: number) => {
    if (!pointTarget || !onClickContext) return;
    onClickContext(
      buildClickContext({
        cardId,
        componentKind: "map",
        target: pointTarget,
        element: mapPointElementFields(spec.points[idx]),
      }),
    );
  };

  const hovered = hover !== null ? spec.points[hover.idx] : null;
  const valueLabel = spec.valueLabel ?? "значение";

  return (
    <div>
      {/* Легенда величины: размер и яркость — одна последовательная шкала. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs">
        {scale.hasValues ? (
          <span className="flex items-center gap-1.5 text-muted">
            <svg width={46} height={16} aria-hidden className="shrink-0">
              <circle cx={6} cy={8} r={3} fill="var(--viz-series-1)" fillOpacity={0.45} />
              <circle cx={20} cy={8} r={5} fill="var(--viz-series-1)" fillOpacity={0.7} />
              <circle cx={38} cy={8} r={7.5} fill="var(--viz-series-1)" fillOpacity={0.95} />
            </svg>
            <span>
              {valueLabel}: {numFmt.format(scale.min)} → {numFmt.format(scale.max)}
            </span>
          </span>
        ) : (
          <span className="text-muted">точки без величины</span>
        )}
        <span className="text-[11px] text-muted/80">{spec.points.length} точек</span>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="block w-full"
          role="img"
          aria-label={`${spec.title}. Карта: ${spec.points.length} точек${
            scale.hasValues ? `, ${valueLabel} от ${numFmt.format(scale.min)} до ${numFmt.format(scale.max)}` : ""
          }`}
        >
          <defs>
            <clipPath id={clipId}>
              <rect
                x={M.left}
                y={M.top}
                width={VB_W - M.left - M.right}
                height={VB_H - M.top - M.bottom}
                rx={4}
              />
            </clipPath>
          </defs>

          {/* Подложка: тайлы CARTO dark, приглушены под точки данных. */}
          <g clipPath={`url(#${clipId})`}>
            {proj.tiles.map((t) => (
              <image
                key={t.key}
                href={t.url}
                x={t.px}
                y={t.py}
                width={TILE}
                height={TILE}
                opacity={0.75}
                onLoad={() => setTilesLoaded((n) => n + 1)}
                onError={(e) => {
                  // Битый/недоступный тайл прячем — под ним фоллбек-сетка.
                  (e.currentTarget as SVGImageElement).style.display = "none";
                }}
              />
            ))}
          </g>

          {/* Оффлайн-фоллбек: градусная сетка, пока нет ни одного тайла. */}
          {!basemapVisible &&
            proj.latTicks.map((lat) => (
              <line
                key={`lat${lat}`}
                x1={M.left}
                x2={VB_W - M.right}
                y1={proj.y(lat)}
                y2={proj.y(lat)}
                stroke="var(--viz-grid)"
                strokeWidth={1}
              />
            ))}
          {!basemapVisible &&
            proj.lonTicks.map((lon) => (
              <line
                key={`lon${lon}`}
                x1={proj.x(lon)}
                x2={proj.x(lon)}
                y1={M.top}
                y2={VB_H - M.bottom}
                stroke="var(--viz-grid)"
                strokeWidth={1}
              />
            ))}

          {/* Рамка панели поверх подложки */}
          <rect
            x={M.left}
            y={M.top}
            width={VB_W - M.left - M.right}
            height={VB_H - M.top - M.bottom}
            fill="none"
            stroke="var(--viz-axis)"
            strokeWidth={1}
            rx={4}
          />

          {/* Подписи координат по краям (и с подложкой, и без) */}
          {proj.latTicks.map((lat) => (
            <text
              key={`latl${lat}`}
              x={M.left - 6}
              y={proj.y(lat) + 3.5}
              textAnchor="end"
              fontSize={9}
              fill="var(--muted)"
            >
              {fmtDegree(lat, proj.latStep)}
            </text>
          ))}
          {proj.lonTicks.map((lon) => (
            <text
              key={`lonl${lon}`}
              x={proj.x(lon)}
              y={VB_H - M.bottom + 14}
              textAnchor="middle"
              fontSize={9}
              fill="var(--muted)"
            >
              {fmtDegree(lon, proj.lonStep)}
            </text>
          ))}

          {/* Точки: крупные снизу, мелкие сверху; кольцо поверхности — зазор */}
          <g clipPath={`url(#${clipId})`}>
            {order.map(({ p, idx }) => {
              const cx = proj.x(p.lon);
              const cy = proj.y(p.lat);
              const isHovered = hover?.idx === idx;
              const r = scale.r(p.value);
              return (
                <g key={idx}>
                  <circle
                    cx={cx}
                    cy={cy}
                    r={isHovered ? r + 1.5 : r}
                    fill="var(--viz-series-1)"
                    fillOpacity={isHovered ? 1 : scale.opacity(p.value)}
                    stroke="var(--surface)"
                    strokeWidth={1.25}
                    pointerEvents="none"
                  />
                  <circle
                    cx={cx}
                    cy={cy}
                    r={Math.max(r + 3, 12)}
                    fill="transparent"
                    className={clickable ? "cursor-pointer" : undefined}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    aria-label={
                      clickable
                        ? `${p.label ?? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`}${
                            p.value !== undefined ? ` — ${valueLabel} ${numFmt.format(p.value)}` : ""
                          }${pointTarget?.label ? ` — ${pointTarget.label}` : ""}`
                        : undefined
                    }
                    onMouseEnter={() => setHover({ idx, cx, cy })}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover({ idx, cx, cy })}
                    onBlur={() => setHover(null)}
                    onClick={() => fire(idx)}
                    onKeyDown={(e) => {
                      if (clickable && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        fire(idx);
                      }
                    }}
                  />
                </g>
              );
            })}
          </g>
        </svg>

        {/* Тултип: имя — главное, величина и координаты — вторичные */}
        {hover && hovered && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-background px-2.5 py-1.5 shadow-lg"
            style={{
              left: `${(hover.cx / VB_W) * 100}%`,
              top: `${(hover.cy / VB_H) * 100}%`,
              marginTop: "-10px",
            }}
          >
            {hovered.label && (
              <div className="text-sm font-semibold whitespace-nowrap">{hovered.label}</div>
            )}
            <div className="text-xs whitespace-nowrap text-muted">
              {hovered.value !== undefined && (
                <>
                  {valueLabel}: {numFmt.format(hovered.value)} ·{" "}
                </>
              )}
              {hovered.lat.toFixed(4)}, {hovered.lon.toFixed(4)}
            </div>
            {clickable && pointTarget?.label && (
              <div className="mt-0.5 text-[10px] whitespace-nowrap text-accent">
                {pointTarget.label} →
              </div>
            )}
          </div>
        )}
      </div>

      {/* Как читать + обязательная атрибуция подложки */}
      <p className="mt-1 px-1 text-[10px] text-muted/80">
        каждая точка — место на карте{scale.hasValues ? `; площадь и яркость — ${valueLabel}` : ""}
        {clickable ? "; клик по точке копает глубже" : ""}
        {basemapVisible ? (
          <>
            {" · подложка © "}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted hover:text-foreground"
            >
              OpenStreetMap
            </a>
            {" © "}
            <a
              href="https://carto.com/attributions"
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted hover:text-foreground"
            >
              CARTO
            </a>
          </>
        ) : (
          " · подложка недоступна — показана градусная сетка"
        )}
      </p>
    </div>
  );
}
