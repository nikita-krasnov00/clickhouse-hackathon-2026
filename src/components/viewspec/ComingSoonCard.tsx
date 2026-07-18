/**
 * Заглушки следующей версии (C5): Histogram, NetworkGraph, CalendarHeatmap.
 * Не пустой экран — заголовок карточки рисует диспетчер, здесь аккуратная
 * плашка с краткой сводкой данных, которые компонент отрисует в v2.
 */
import type { GraphSpec, HeatmapSpec, HistogramSpec } from "@/lib/contracts";

const numFmt = new Intl.NumberFormat("ru-RU");

function ComingSoonShell({
  componentName,
  summary,
}: {
  componentName: string;
  summary: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-8 text-center">
      <p className="text-sm text-muted">
        {componentName} — компонент версии 2 (задача C5)
      </p>
      <p className="text-xs text-muted/80">Данные уже здесь: {summary}</p>
    </div>
  );
}

export function HistogramCard({ spec }: { spec: HistogramSpec }) {
  const total = spec.buckets.reduce((acc, b) => acc + b.count, 0);
  return (
    <ComingSoonShell
      componentName="Histogram"
      summary={`${numFmt.format(spec.buckets.length)} корзин «${spec.bucketLabel}», ${numFmt.format(total)} наблюдений`}
    />
  );
}

export function NetworkGraphCard({ spec }: { spec: GraphSpec }) {
  return (
    <ComingSoonShell
      componentName="NetworkGraph"
      summary={`${numFmt.format(spec.nodes.length)} узлов · ${numFmt.format(spec.edges.length)} связей (cap ${numFmt.format(spec.maxNodes)})`}
    />
  );
}

export function HeatmapCard({ spec }: { spec: HeatmapSpec }) {
  return (
    <ComingSoonShell
      componentName="Heatmap"
      summary={`матрица ${numFmt.format(spec.xLabels.length)}×${numFmt.format(spec.yLabels.length)}, ${numFmt.format(spec.cells.length)} заполненных ячеек`}
    />
  );
}
