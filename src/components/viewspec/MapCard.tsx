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
 *
 * ЗУМ И ПАНОРАМА (конвенции TimelineCard): pinch/Ctrl+колесо — непрерывный
 * зум вокруг курсора, перетаскивание — панорама (порог 4px отделяет клик по
 * маркеру), кнопки +/−/⟲ — то же с клавиатуры и на тачах, двойной клик —
 * сброс к автофиту. Обычный скролл отдаётся странице. Вид {z, cx, cy} живёт
 * поверх автофита; кластеризация пересчитывается на каждый вид, поэтому при
 * приближении кластеры распадаются на отдельные точки. Тайлы берутся с
 * ближайшего целого зума и масштабируются (2^(z − zInt)).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { ClickContext, MapPoint, MapSpec } from "@/lib/contracts";
import { useNumberFormat } from "@/lib/i18n/formats";
import { buildClickContext, findClickTarget, mapPointElementFields } from "./click";

const VB_W = 640;
const VB_H = 300;
const M = { top: 10, right: 10, bottom: 22, left: 40 };
const INNER_W = VB_W - M.left - M.right;
const INNER_H = VB_H - M.top - M.bottom;
const PANEL_CX = M.left + INNER_W / 2;
const PANEL_CY = M.top + INNER_H / 2;
/** Экранный размер тайла в единицах viewBox (256 @2x — чётко на ретине). */
const TILE = 256;
const MAX_ZOOM = 18;
const MIN_ZOOM = 1;
/** Порог панорамы в единицах viewBox: до него жест остаётся кликом по маркеру. */
const PAN_THRESHOLD = 4;
/**
 * Радиус кластеризации в единицах viewBox: точки ближе этого сливаются в один
 * маркер со счётчиком. Радиус мал — сливаются только реально перекрывающиеся
 * точки; разнесённые (например именованные районы) остаются раздельными, так
 * что кластеризация самоадаптивна и не портит разреженные карты.
 */
const CLUSTER_RADIUS = 18;

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
/** Обратный Web Mercator — для градусных тиков видимой области. */
function invMercLon(x: number): number {
  return x * 360 - 180;
}
function invMercLat(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/** Вид карты: непрерывный зум + центр в мировых координатах Меркатора [0..1]. */
type MapView = { z: number; cx: number; cy: number };

type Tile = { key: string; url: string; px: number; py: number };

type Projection = {
  x: (lon: number) => number;
  y: (lat: number) => number;
  tiles: Tile[];
  /** Экранный размер тайла: TILE × 2^(z − zInt) при дробном зуме. */
  tileSize: number;
  latTicks: number[];
  lonTicks: number[];
  latStep: number;
  lonStep: number;
  /** Автофит-вид (цель сброса) и эффективный текущий вид (после клампов). */
  fit: MapView;
  view: MapView;
};

/**
 * Проекция Web Mercator: автофит bbox точек в панель ЛИБО явный вид
 * {z, cx, cy} от зума/панорамы (центр клампится краями мира), + тайлы
 * подложки и градусные тики по видимой области.
 */
function buildProjection(points: MapPoint[], overrideView: MapView | null): Projection {
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

  // Автофит: bounding box (в мировых координатах Меркатора) влезает в панель.
  const dmx = Math.max(mercX(maxLon) - mercX(minLon), 1e-9);
  const dmy = Math.max(mercY(minLat) - mercY(maxLat), 1e-9); // y растёт вниз
  const zFit = Math.floor(
    Math.log2(Math.min(INNER_W / (TILE * dmx), INNER_H / (TILE * dmy))),
  );
  const fit: MapView = {
    z: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zFit)),
    cx: (mercX(minLon) + mercX(maxLon)) / 2,
    cy: (mercY(maxLat) + mercY(minLat)) / 2,
  };

  // Эффективный вид: явный или автофит; центр кламплен так, чтобы панель не
  // выезжала за край мира (а мир меньше панели — центрируется).
  const z = overrideView
    ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, overrideView.z))
    : fit.z;
  const world = TILE * 2 ** z; // размер мира в px на этом зуме
  const clampCenter = (c: number, inner: number) => {
    const half = inner / 2 / world;
    return half >= 0.5 ? 0.5 : Math.min(1 - half, Math.max(half, c));
  };
  const view: MapView = {
    z,
    cx: clampCenter(overrideView ? overrideView.cx : fit.cx, INNER_W),
    cy: clampCenter(overrideView ? overrideView.cy : fit.cy, INNER_H),
  };

  const x = (lon: number) => PANEL_CX + (mercX(lon) - view.cx) * world;
  const y = (lat: number) => PANEL_CY + (mercY(lat) - view.cy) * world;

  // Тайлы ближайшего целого зума; при дробном z масштабируются рендером.
  const zInt = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z)));
  const n = 2 ** zInt;
  const tileSize = world / n;

  // Видимые границы панели в мировых координатах — тайлы и тики по ним.
  const worldLeft = view.cx - INNER_W / 2 / world;
  const worldRight = view.cx + INNER_W / 2 / world;
  const worldTop = view.cy - INNER_H / 2 / world;
  const worldBottom = view.cy + INNER_H / 2 / world;
  const txMin = Math.max(0, Math.floor(worldLeft * n));
  const txMax = Math.min(n - 1, Math.floor(worldRight * n));
  const tyMin = Math.max(0, Math.floor(worldTop * n));
  const tyMax = Math.min(n - 1, Math.floor(worldBottom * n));
  const tiles: Tile[] = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      tiles.push({
        key: `${zInt}/${tx}/${ty}`,
        url: tileUrl(zInt, tx, ty),
        px: PANEL_CX + (tx / n - view.cx) * world,
        py: PANEL_CY + (ty / n - view.cy) * world,
      });
    }
  }

  // Градусные тики по ВИДИМОЙ области — живут при зуме и панораме
  // (подписи всегда; линии — только в оффлайн-фоллбеке).
  const visMinLat = invMercLat(worldBottom);
  const visMaxLat = invMercLat(worldTop);
  const visMinLon = invMercLon(worldLeft);
  const visMaxLon = invMercLon(worldRight);
  const latStep = niceDegreeStep(visMaxLat - visMinLat);
  const lonStep = niceDegreeStep(visMaxLon - visMinLon);
  const latTicks: number[] = [];
  for (
    let v = Math.ceil(visMinLat / latStep) * latStep;
    v <= visMaxLat;
    v += latStep
  ) {
    latTicks.push(+v.toFixed(6));
  }
  const lonTicks: number[] = [];
  for (
    let v = Math.ceil(visMinLon / lonStep) * lonStep;
    v <= visMaxLon;
    v += lonStep
  ) {
    lonTicks.push(+v.toFixed(6));
  }
  return { x, y, tiles, tileSize, latTicks, lonTicks, latStep, lonStep, fit, view };
}

/** Размер/яркость по value: sqrt-шкала площади + непрозрачность (одна тональность). */
function buildValueScale(items: { value?: number }[]) {
  const values = items.filter((p) => p.value !== undefined).map((p) => p.value as number);
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

/** Кластер точек: экранный и гео-центр (взвешенные), число и сумма величин. */
type Cluster = {
  cx: number;
  cy: number;
  lat: number;
  lon: number;
  count: number;
  /** Сумма value членов (undefined — если ни у одного члена нет value). */
  value?: number;
  /** Подпись доминирующей (самой тяжёлой) точки кластера. */
  label?: string;
  /** Индекс доминирующей точки в spec.points — по нему собирается клик. */
  seedIdx: number;
};

/**
 * Жадная кластеризация по ЭКРАННОМУ расстоянию: точки сортируются по величине,
 * каждая тяжёлая становится сидом и поглощает все ещё не занятые точки в радиусе
 * CLUSTER_RADIUS. Центр кластера — взвешенный по величине (тяжёлые тянут центр
 * на себя), величина — сумма, подпись — от сида. O(n²) при n ≤ 1000 — дёшево.
 */
function clusterPoints(
  points: MapPoint[],
  proj: Projection,
): Cluster[] {
  const scr = points.map((p, idx) => ({
    idx,
    p,
    x: proj.x(p.lon),
    y: proj.y(p.lat),
    // Вес для центра тяжести: величина, а без величины — равный (1).
    w: p.value !== undefined && p.value > 0 ? p.value : 1,
  }));
  scr.sort((a, b) => (b.p.value ?? 0) - (a.p.value ?? 0));

  const used = new Array(scr.length).fill(false);
  const clusters: Cluster[] = [];
  const r2 = CLUSTER_RADIUS * CLUSTER_RADIUS;
  for (let i = 0; i < scr.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const seed = scr[i];
    const members = [seed];
    for (let j = i + 1; j < scr.length; j++) {
      if (used[j]) continue;
      const dx = scr[j].x - seed.x;
      const dy = scr[j].y - seed.y;
      if (dx * dx + dy * dy <= r2) {
        used[j] = true;
        members.push(scr[j]);
      }
    }
    const hasValues = members.some((m) => m.p.value !== undefined);
    const wsum = members.reduce((s, m) => s + m.w, 0) || 1;
    clusters.push({
      cx: members.reduce((s, m) => s + m.x * m.w, 0) / wsum,
      cy: members.reduce((s, m) => s + m.y * m.w, 0) / wsum,
      lat: members.reduce((s, m) => s + m.p.lat * m.w, 0) / wsum,
      lon: members.reduce((s, m) => s + m.p.lon * m.w, 0) / wsum,
      count: members.length,
      value: hasValues ? members.reduce((s, m) => s + (m.p.value ?? 0), 0) : undefined,
      label: seed.p.label,
      seedIdx: seed.idx,
    });
  }
  return clusters;
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
  const t = useTranslations("map");
  const tCards = useTranslations("cards");
  const numFmt = useNumberFormat({ maximumFractionDigits: 2 });
  const [hover, setHover] = useState<Hover>(null);
  /** Сколько тайлов подложки реально загрузилось: 0 → оффлайн-фоллбек с сеткой. */
  const [tilesLoaded, setTilesLoaded] = useState(0);
  /** Явный вид (зум/панорама); null — автофит по данным. */
  const [view, setView] = useState<MapView | null>(null);
  const [panning, setPanning] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x0: number;
    y0: number;
    view0: MapView;
    panning: boolean;
  } | null>(null);
  const clipId = useId();
  const pointTarget = findClickTarget(spec.clicks, "point");
  const clickable = Boolean(pointTarget && onClickContext);

  // Новые данные — новый автофит: явный вид сбрасывается. Корректировка
  // состояния прямо в рендере (официальный паттерн React для «сброса по
  // смене пропа») — без эффекта и лишнего кадра со старым видом.
  const [prevPoints, setPrevPoints] = useState(spec.points);
  if (prevPoints !== spec.points) {
    setPrevPoints(spec.points);
    setView(null);
  }

  const layout = useMemo(() => {
    if (spec.points.length === 0) return null;
    const proj = buildProjection(spec.points, view);
    // Близкие точки объединяем в кластеры; шкала размера — уже по величине
    // КЛАСТЕРА (сумма может превышать максимум одиночной точки). Кластеры
    // живут в экранных координатах, поэтому при зуме пересчитываются —
    // приближение раскрывает кластер на отдельные точки.
    const clusters = clusterPoints(spec.points, proj);
    const scale = buildValueScale(clusters);
    // Крупные снизу, мелкие сверху — маленькие маркеры не тонут под большими.
    const order = clusters
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (b.c.value ?? 0) - (a.c.value ?? 0));
    return { proj, scale, clusters, order, clustered: clusters.length < spec.points.length };
  }, [spec.points, view]);

  /** Координаты события мыши → координаты viewBox. */
  const vbPos = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: PANEL_CX, y: PANEL_CY };
    return {
      x: ((clientX - rect.left) / rect.width) * VB_W,
      y: ((clientY - rect.top) / rect.height) * VB_H,
    };
  };

  /** Зум на dz уровней; anchor (viewBox) — гео-точка под ним остаётся на месте. */
  const zoomBy = (dz: number, anchor?: { x: number; y: number }) => {
    if (!layout) return;
    const cur = layout.proj.view;
    const z2 = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cur.z + dz));
    if (z2 === cur.z) return;
    const w1 = TILE * 2 ** cur.z;
    const w2 = TILE * 2 ** z2;
    if (anchor) {
      const wx = cur.cx + (anchor.x - PANEL_CX) / w1;
      const wy = cur.cy + (anchor.y - PANEL_CY) / w1;
      setView({
        z: z2,
        cx: wx - (anchor.x - PANEL_CX) / w2,
        cy: wy - (anchor.y - PANEL_CY) / w2,
      });
    } else {
      setView({ z: z2, cx: cur.cx, cy: cur.cy });
    }
  };

  // Колесо: pinch/Ctrl — зум вокруг курсора; обычный скролл отдаём странице.
  // Нативный listener с passive:false — React вешает wheel пассивно,
  // preventDefault не сработал бы (паттерн TimelineCard).
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  const handleWheel = (e: WheelEvent) => {
    if (!layout || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoomBy(-e.deltaY / 240, vbPos(e.clientX, e.clientY));
  };
  useEffect(() => {
    wheelRef.current = handleWheel;
  });
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // Панорама: до порога — обычный клик по маркеру; после — захват указателя
  // (клики маркеров при этом не стреляют — их перехватывает svg).
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !layout) return;
    const p = vbPos(e.clientX, e.clientY);
    dragRef.current = {
      pointerId: e.pointerId,
      x0: p.x,
      y0: p.y,
      view0: layout.proj.view,
      panning: false,
    };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = vbPos(e.clientX, e.clientY);
    if (!drag.panning && Math.hypot(p.x - drag.x0, p.y - drag.y0) > PAN_THRESHOLD) {
      drag.panning = true;
      try {
        // Захват глушит клики маркеров до конца панорамы; на синтетических
        // указателях (тесты, автоматизация) капчер может кинуть — панорама
        // обязана работать и без него.
        svgRef.current?.setPointerCapture(drag.pointerId);
      } catch {
        // NotFoundError для неактивного pointerId — игнорируем
      }
      setHover(null);
      setPanning(true);
    }
    if (drag.panning) {
      const w = TILE * 2 ** drag.view0.z;
      setView({
        z: drag.view0.z,
        cx: drag.view0.cx - (p.x - drag.x0) / w,
        cy: drag.view0.cy - (p.y - drag.y0) / w,
      });
    }
  };
  const endPan = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setPanning(false);
  };

  if (!layout) {
    return (
      <p className="px-1 py-6 text-center text-sm text-muted">{tCards("noPoints")}</p>
    );
  }
  const { proj, scale, clusters, order, clustered } = layout;
  const basemapVisible = tilesLoaded > 0;

  // Клик по кластеру уводит в доминирующую (самую тяжёлую) точку области.
  const fire = (seedIdx: number) => {
    if (!pointTarget || !onClickContext) return;
    onClickContext(
      buildClickContext({
        cardId,
        componentKind: "map",
        target: pointTarget,
        element: mapPointElementFields(spec.points[seedIdx]),
      }),
    );
  };

  const hovered = hover !== null ? clusters[hover.idx] : null;
  const valueLabel = spec.valueLabel ?? t("valueFallback");

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
          <span className="text-muted">{t("noValues")}</span>
        )}
        <span className="text-[11px] text-muted/80">
          {clustered
            ? `${t("points", { count: spec.points.length })} → ${t("clusters", { count: clusters.length })}`
            : t("points", { count: spec.points.length })}
        </span>
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className={`block w-full select-none ${panning ? "cursor-grabbing" : "cursor-grab"}`}
          // touch-action: none — тач-драг уходит в панораму, не в скролл страницы
          style={{ touchAction: "none" }}
          role="img"
          aria-label={`${t("ariaBase", {
            title: spec.title,
            points: t("points", { count: spec.points.length }),
          })}${
            scale.hasValues
              ? t("ariaRange", {
                  label: valueLabel,
                  min: numFmt.format(scale.min),
                  max: numFmt.format(scale.max),
                })
              : ""
          }`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onDoubleClick={() => setView(null)}
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
                width={proj.tileSize}
                height={proj.tileSize}
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

          {/* Кластеры: крупные снизу, мелкие сверху; кольцо поверхности — зазор.
              Кластер из >1 точки — крупнее, с числом-счётчиком внутри. */}
          <g clipPath={`url(#${clipId})`}>
            {order.map(({ c, i }) => {
              const isHovered = hover?.idx === i;
              const base = scale.r(c.value);
              // Кластеру нужен минимум под цифру; одиночке — как есть.
              const r = c.count > 1 ? Math.max(base, 9) : base;
              const showCount = c.count > 1 && r >= 8;
              return (
                <g key={i}>
                  <circle
                    cx={c.cx}
                    cy={c.cy}
                    r={isHovered ? r + 1.5 : r}
                    fill="var(--viz-series-1)"
                    fillOpacity={isHovered ? 1 : scale.opacity(c.value)}
                    stroke="var(--surface)"
                    strokeWidth={c.count > 1 ? 1.75 : 1.25}
                    pointerEvents="none"
                  />
                  {showCount && (
                    <text
                      x={c.cx}
                      y={c.cy + 3}
                      textAnchor="middle"
                      fontSize={Math.min(Math.max(r, 9), 13)}
                      fontWeight={600}
                      fill="var(--background)"
                      pointerEvents="none"
                    >
                      {c.count}
                    </text>
                  )}
                  <circle
                    cx={c.cx}
                    cy={c.cy}
                    r={Math.max(r + 3, 12)}
                    fill="transparent"
                    className={clickable ? "cursor-pointer" : undefined}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    aria-label={
                      clickable
                        ? `${
                            c.count > 1
                              ? `${t("nearby", { count: c.count })} · ${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}`
                              : c.label ?? `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`
                          }${
                            c.value !== undefined ? ` — ${valueLabel} ${numFmt.format(c.value)}` : ""
                          }${pointTarget?.label ? ` — ${pointTarget.label}` : ""}`
                        : undefined
                    }
                    onMouseEnter={() => setHover({ idx: i, cx: c.cx, cy: c.cy })}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover({ idx: i, cx: c.cx, cy: c.cy })}
                    onBlur={() => setHover(null)}
                    onClick={() => fire(c.seedIdx)}
                    // Быстрый двойной клик по маркеру — это два дрилла, а не сброс вида.
                    onDoubleClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (clickable && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        fire(c.seedIdx);
                      }
                    }}
                  />
                </g>
              );
            })}
          </g>
        </svg>

        {/* Кнопки зума: то же, что pinch/Ctrl+колесо, но дискаверабельно */}
        <div className="absolute top-2 right-2 z-10 flex flex-col gap-1">
          <button
            type="button"
            aria-label={t("zoomIn")}
            className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface/90 font-mono text-[13px] leading-none text-muted transition-colors hover:text-foreground"
            onClick={() => zoomBy(1)}
          >
            +
          </button>
          <button
            type="button"
            aria-label={t("zoomOut")}
            className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface/90 font-mono text-[13px] leading-none text-muted transition-colors hover:text-foreground"
            onClick={() => zoomBy(-1)}
          >
            −
          </button>
          <button
            type="button"
            aria-label={t("resetView")}
            className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface/90 font-mono text-[13px] leading-none text-muted transition-colors hover:text-foreground disabled:opacity-35 disabled:hover:text-muted"
            onClick={() => setView(null)}
            disabled={view === null}
          >
            ⟲
          </button>
        </div>

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
            {hovered.count > 1 ? (
              <div className="text-sm font-semibold whitespace-nowrap">
                {t("nearby", { count: hovered.count })}
              </div>
            ) : (
              hovered.label && (
                <div className="text-sm font-semibold whitespace-nowrap">{hovered.label}</div>
              )
            )}
            <div className="text-xs whitespace-nowrap text-muted">
              {hovered.value !== undefined && (
                <>
                  {hovered.count > 1 ? t("valueSum", { label: valueLabel }) : valueLabel}:{" "}
                  {numFmt.format(hovered.value)} ·{" "}
                </>
              )}
              {hovered.lat.toFixed(4)}, {hovered.lon.toFixed(4)}
            </div>
            {clickable && pointTarget?.label && (
              <div className="mt-0.5 text-[10px] whitespace-nowrap text-accent">
                {hovered.count > 1 ? t("drillCluster") : pointTarget.label} →
              </div>
            )}
          </div>
        )}
      </div>

      {/* Как читать + обязательная атрибуция подложки */}
      <p className="mt-1 px-1 text-[10px] text-muted/80">
        {clustered ? t("howToClustered") : t("howToEach")}
        {scale.hasValues
          ? `${t("howToValue", { label: valueLabel })}${clustered ? t("howToValueClusterSuffix") : ""}`
          : ""}
        {clickable ? t("howToClick") : ""}
        {t("howToNav")}
        {basemapVisible ? (
          <>
            {t("attribution")}
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
          t("offline")
        )}
      </p>
    </div>
  );
}
