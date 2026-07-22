"use client";

/**
 * Map — geo points {lat, lon, value?, label?} on an SVG map WITH BASEMAP.
 *
 * Basemap — CARTO dark_matter raster tiles (© OpenStreetMap © CARTO): dark,
 * matching the app; attribution — in the caption under the map (required by
 * license). Projection — Web Mercator (otherwise tiles won't align); zoom is
 * chosen so the points' bounding box fits the panel, tiles are clipped with
 * clipPath. OFFLINE FALLBACK: until at least one tile loads (or network is
 * unavailable), the previous degree grid is drawn — the card is never empty.
 *
 * value magnitude is encoded CONSISTENTLY with one hue: marker area (sqrt
 * scale) + opacity; surface-colored ring separates markers from the busy
 * basemap. Hover tooltip, hit target ≥ 12px, keyboard; point click →
 * ClickContext (on:'point').
 *
 * ZOOM AND PAN (TimelineCard conventions): pinch/Ctrl+wheel — continuous zoom
 * around cursor, drag — pan (4px threshold separates marker click), +/−/⟲
 * buttons — same from keyboard and touch, double-click — reset to auto-fit.
 * Normal scroll goes to the page. View {z, cx, cy} lives on top of auto-fit;
 * clustering is recomputed on every view, so zooming in splits clusters into
 * individual points. Tiles come from the nearest integer zoom and are scaled
 * (2^(z − zInt)).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ClickContext, MapPoint, MapSpec } from "@/lib/contracts";
import { buildClickContext, findClickTarget, mapPointElementFields } from "./click";

const VB_W = 640;
const VB_H = 300;
const M = { top: 10, right: 10, bottom: 22, left: 40 };
const INNER_W = VB_W - M.left - M.right;
const INNER_H = VB_H - M.top - M.bottom;
const PANEL_CX = M.left + INNER_W / 2;
const PANEL_CY = M.top + INNER_H / 2;
/** Tile screen size in viewBox units (256 @2x — sharp on retina). */
const TILE = 256;
const MAX_ZOOM = 18;
const MIN_ZOOM = 1;
/** Pan threshold in viewBox units: below it the gesture stays a marker click. */
const PAN_THRESHOLD = 4;
/**
 * Clustering radius in viewBox units: points closer than this merge into one
 * marker with a counter. Radius is small — only truly overlapping points merge;
 * separated ones (e.g. named districts) stay distinct, so clustering is
 * self-adaptive and doesn't ruin sparse maps.
 */
const CLUSTER_RADIUS = 18;

const numFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

/** CARTO tiles (dark) — free basemap with mandatory attribution. */
function tileUrl(z: number, x: number, y: number): string {
  const sub = "abcd"[(x + y) % 4];
  return `https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}@2x.png`;
}

/** "Nice" degree grid step for span in degrees (offline fallback). */
function niceDegreeStep(span: number): number {
  const steps = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 45];
  const rough = span / 4;
  for (const s of steps) {
    if (s >= rough) return s;
  }
  return 45;
}

/** Coordinate label with grid step precision: 40.75° / −73.98°. */
function fmtDegree(v: number, step: number): string {
  const decimals = Math.max(0, Math.min(4, -Math.floor(Math.log10(step))));
  return `${v.toFixed(decimals)}°`;
}

/** Web Mercator: (lon, lat) → normalized world coordinates [0..1]. */
function mercX(lon: number): number {
  return (lon + 180) / 360;
}
function mercY(lat: number): number {
  // Clamp ±85.05° — projection limit; doesn't affect typical data.
  const phi = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
}
/** Inverse Web Mercator — for degree ticks of the visible area. */
function invMercLon(x: number): number {
  return x * 360 - 180;
}
function invMercLat(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/** Map view: continuous zoom + center in Mercator world coordinates [0..1]. */
type MapView = { z: number; cx: number; cy: number };

type Tile = { key: string; url: string; px: number; py: number };

type Projection = {
  x: (lon: number) => number;
  y: (lat: number) => number;
  tiles: Tile[];
  /** Tile screen size: TILE × 2^(z − zInt) at fractional zoom. */
  tileSize: number;
  latTicks: number[];
  lonTicks: number[];
  latStep: number;
  lonStep: number;
  /** Auto-fit view (reset target) and effective current view (after clamps). */
  fit: MapView;
  view: MapView;
};

/**
 * Web Mercator projection: auto-fit points bbox into panel OR explicit view
 * {z, cx, cy} from zoom/pan (center clamped to world edges), + basemap tiles
 * and degree ticks for the visible area.
 */
function buildProjection(points: MapPoint[], overrideView: MapView | null): Projection {
  let minLat = Math.min(...points.map((p) => p.lat));
  let maxLat = Math.max(...points.map((p) => p.lat));
  let minLon = Math.min(...points.map((p) => p.lon));
  let maxLon = Math.max(...points.map((p) => p.lon));

  // Degenerate span (single point) — expand by ±0.01°.
  if (maxLat - minLat < 1e-6) {
    minLat -= 0.01;
    maxLat += 0.01;
  }
  if (maxLon - minLon < 1e-6) {
    minLon -= 0.01;
    maxLon += 0.01;
  }
  // 6% padding — markers at the edge aren't clipped by the frame.
  const padLat = (maxLat - minLat) * 0.06;
  const padLon = (maxLon - minLon) * 0.06;
  minLat -= padLat;
  maxLat += padLat;
  minLon -= padLon;
  maxLon += padLon;

  // Auto-fit: bounding box (in Mercator world coordinates) fits in the panel.
  const dmx = Math.max(mercX(maxLon) - mercX(minLon), 1e-9);
  const dmy = Math.max(mercY(minLat) - mercY(maxLat), 1e-9); // y grows downward
  const zFit = Math.floor(
    Math.log2(Math.min(INNER_W / (TILE * dmx), INNER_H / (TILE * dmy))),
  );
  const fit: MapView = {
    z: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zFit)),
    cx: (mercX(minLon) + mercX(maxLon)) / 2,
    cy: (mercY(maxLat) + mercY(minLat)) / 2,
  };

  // Effective view: explicit or auto-fit; center clamped so the panel doesn't
  // go past the world edge (if the world is smaller than the panel — centered).
  const z = overrideView
    ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, overrideView.z))
    : fit.z;
  const world = TILE * 2 ** z; // world size in px at this zoom
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

  // Tiles at nearest integer zoom; scaled by renderer at fractional z.
  const zInt = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z)));
  const n = 2 ** zInt;
  const tileSize = world / n;

  // Visible panel bounds in world coordinates — tiles and ticks from them.
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

  // Degree ticks for VISIBLE area — live during zoom and pan
  // (labels always; lines — only in offline fallback).
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

/** Size/brightness by value: sqrt area scale + opacity (single hue). */
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

/** Point cluster: screen and geo center (weighted), count and value sum. */
type Cluster = {
  cx: number;
  cy: number;
  lat: number;
  lon: number;
  count: number;
  /** Sum of member values (undefined — if no member has value). */
  value?: number;
  /** Label of the dominant (heaviest) cluster point. */
  label?: string;
  /** Index of the dominant point in spec.points — used to build the click. */
  seedIdx: number;
};

/**
 * Greedy clustering by SCREEN distance: points sorted by magnitude, each heavy
 * one becomes a seed and absorbs all still-free points within CLUSTER_RADIUS.
 * Cluster center — magnitude-weighted (heavy ones pull the center), value — sum,
 * label — from seed. O(n²) at n ≤ 1000 — cheap.
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
    // Weight for center of mass: magnitude, or equal (1) without magnitude.
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
  const [hover, setHover] = useState<Hover>(null);
  /** How many basemap tiles actually loaded: 0 → offline fallback with grid. */
  const [tilesLoaded, setTilesLoaded] = useState(0);
  /** Explicit view (zoom/pan); null — auto-fit from data. */
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

  // New data — new auto-fit: explicit view resets. State adjustment directly
  // in render (official React pattern for "reset on prop change") — no effect
  // and no extra frame with the old view.
  const [prevPoints, setPrevPoints] = useState(spec.points);
  if (prevPoints !== spec.points) {
    setPrevPoints(spec.points);
    setView(null);
  }

  const layout = useMemo(() => {
    if (spec.points.length === 0) return null;
    const proj = buildProjection(spec.points, view);
    // Merge nearby points into clusters; size scale — by CLUSTER magnitude
    // (sum can exceed a single point's max). Clusters live in screen coords,
    // so they're recomputed on zoom — zooming in splits a cluster into points.
    const clusters = clusterPoints(spec.points, proj);
    const scale = buildValueScale(clusters);
    // Large at bottom, small on top — small markers don't sink under big ones.
    const order = clusters
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (b.c.value ?? 0) - (a.c.value ?? 0));
    return { proj, scale, clusters, order, clustered: clusters.length < spec.points.length };
  }, [spec.points, view]);

  /** Mouse event coordinates → viewBox coordinates. */
  const vbPos = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: PANEL_CX, y: PANEL_CY };
    return {
      x: ((clientX - rect.left) / rect.width) * VB_W,
      y: ((clientY - rect.top) / rect.height) * VB_H,
    };
  };

  /** Zoom by dz levels; anchor (viewBox) — geo point under it stays in place. */
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

  // Wheel: pinch/Ctrl — zoom around cursor; normal scroll goes to the page.
  // Native listener with passive:false — React attaches wheel passively,
  // preventDefault wouldn't work (TimelineCard pattern).
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

  // Pan: below threshold — normal marker click; after — pointer capture
  // (marker clicks don't fire — svg intercepts them).
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
        // Capture suppresses marker clicks until pan ends; on synthetic
        // pointers (tests, automation) capture may throw — pan must work
        // without it too.
        svgRef.current?.setPointerCapture(drag.pointerId);
      } catch {
        // NotFoundError for inactive pointerId — ignore
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
      <p className="px-1 py-6 text-center text-sm text-muted">Нет точек для отображения</p>
    );
  }
  const { proj, scale, clusters, order, clustered } = layout;
  const basemapVisible = tilesLoaded > 0;

  // Cluster click drills into the dominant (heaviest) point in the area.
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
  const valueLabel = spec.valueLabel ?? "значение";

  return (
    <div>
      {/* Value legend: size and brightness — one sequential scale. */}
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
        <span className="text-[11px] text-muted/80">
          {clustered
            ? `${spec.points.length} точек → ${clusters.length} кластеров`
            : `${spec.points.length} точек`}
        </span>
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className={`block w-full select-none ${panning ? "cursor-grabbing" : "cursor-grab"}`}
          // touch-action: none — touch drag goes to pan, not page scroll
          style={{ touchAction: "none" }}
          role="img"
          aria-label={`${spec.title}. Карта: ${spec.points.length} точек${
            scale.hasValues ? `, ${valueLabel} от ${numFmt.format(scale.min)} до ${numFmt.format(scale.max)}` : ""
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

          {/* Basemap: CARTO dark tiles, muted under data points. */}
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
                  // Hide broken/unavailable tile — fallback grid underneath.
                  (e.currentTarget as SVGImageElement).style.display = "none";
                }}
              />
            ))}
          </g>

          {/* Offline fallback: degree grid until no tile has loaded. */}
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

          {/* Panel frame over basemap */}
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

          {/* Coordinate labels on edges (with and without basemap) */}
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

          {/* Clusters: large at bottom, small on top; surface ring — gap.
              Cluster of >1 points — larger, with count inside. */}
          <g clipPath={`url(#${clipId})`}>
            {order.map(({ c, i }) => {
              const isHovered = hover?.idx === i;
              const base = scale.r(c.value);
              // Cluster needs minimum size for the digit; single point — as-is.
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
                              ? `${c.count} точек около ${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}`
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
                    // Quick double-click on marker — two drills, not view reset.
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

        {/* Zoom buttons: same as pinch/Ctrl+wheel, but discoverable */}
        <div className="absolute top-2 right-2 z-10 flex flex-col gap-1">
          <button
            type="button"
            aria-label="Приблизить"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface/90 font-mono text-[13px] leading-none text-muted transition-colors hover:text-foreground"
            onClick={() => zoomBy(1)}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Отдалить"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface/90 font-mono text-[13px] leading-none text-muted transition-colors hover:text-foreground"
            onClick={() => zoomBy(-1)}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Сбросить обзор к охвату данных"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface/90 font-mono text-[13px] leading-none text-muted transition-colors hover:text-foreground disabled:opacity-35 disabled:hover:text-muted"
            onClick={() => setView(null)}
            disabled={view === null}
          >
            ⟲
          </button>
        </div>

        {/* Tooltip: name — primary, value and coordinates — secondary */}
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
                {hovered.count} точек рядом
              </div>
            ) : (
              hovered.label && (
                <div className="text-sm font-semibold whitespace-nowrap">{hovered.label}</div>
              )
            )}
            <div className="text-xs whitespace-nowrap text-muted">
              {hovered.value !== undefined && (
                <>
                  {hovered.count > 1 ? `${valueLabel} (сумма)` : valueLabel}:{" "}
                  {numFmt.format(hovered.value)} ·{" "}
                </>
              )}
              {hovered.lat.toFixed(4)}, {hovered.lon.toFixed(4)}
            </div>
            {clickable && pointTarget?.label && (
              <div className="mt-0.5 text-[10px] whitespace-nowrap text-accent">
                {hovered.count > 1 ? "Копнуть в этот кластер" : pointTarget.label} →
              </div>
            )}
          </div>
        )}
      </div>

      {/* How to read + mandatory basemap attribution */}
      <p className="mt-1 px-1 text-[10px] text-muted/80">
        {clustered ? "маркер — место на карте; близкие точки объединены, число внутри — сколько их" : "каждая точка — место на карте"}
        {scale.hasValues ? `; площадь и яркость — ${valueLabel}${clustered ? " (сумма в кластере)" : ""}` : ""}
        {clickable ? "; клик копает глубже" : ""}
        {"; зум — кнопки или pinch/Ctrl+колесо, панорама — перетаскиванием, двойной клик — сброс"}
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
