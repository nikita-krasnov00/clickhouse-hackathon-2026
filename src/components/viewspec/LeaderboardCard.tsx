"use client";

/**
 * Leaderboard (C4) — columns/rows table: sort on header click, row click →
 * ClickContext (selectionKeys = column keys, null omitted).
 * null values render as "—"; numbers — right-aligned, tabular-nums.
 */
import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ClickContext, LeaderboardSpec, Row } from "@/lib/contracts";
import { useNumberFormat } from "@/lib/i18n/formats";
import { buildClickContext, findClickTarget, rowElementFields } from "./click";

type Sort = { key: string; dir: "asc" | "desc" } | null;

function compareValues(a: Row[string], b: Row[string], locale: string): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // null — always at the bottom
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), locale);
}

export function LeaderboardCard({
  spec,
  cardId,
  onClickContext,
}: {
  spec: LeaderboardSpec;
  cardId: string;
  onClickContext?: (ctx: ClickContext) => void;
}) {
  const t = useTranslations("leaderboard");
  const tCards = useTranslations("cards");
  const locale = useLocale();
  const numFmt = useNumberFormat({ maximumFractionDigits: 2 });
  const [sort, setSort] = useState<Sort>(null);
  const rowTarget = findClickTarget(spec.clicks, "row");
  const clickable = Boolean(rowTarget && onClickContext);

  const rows = useMemo(() => {
    if (!sort) return spec.rows;
    const sorted = [...spec.rows].sort((a, b) =>
      compareValues(a[sort.key], b[sort.key], locale),
    );
    if (sort.dir === "desc") sorted.reverse();
    return sorted;
  }, [spec.rows, sort, locale]);

  const toggleSort = (key: string) => {
    setSort((prev) =>
      prev?.key === key
        ? prev.dir === "desc"
          ? { key, dir: "asc" }
          : null
        : { key, dir: "desc" },
    );
  };

  const numericCols = useMemo(
    () =>
      new Set(
        spec.columns
          .filter((c) => spec.rows.some((r) => typeof r[c.key] === "number"))
          .map((c) => c.key),
      ),
    [spec.columns, spec.rows],
  );

  const fireRow = (row: Row) => {
    if (!rowTarget || !onClickContext) return;
    onClickContext(
      buildClickContext({
        cardId,
        componentKind: "leaderboard",
        target: rowTarget,
        element: rowElementFields(row),
      }),
    );
  };

  if (spec.rows.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-sm text-muted">{tCards("noData")}</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            {spec.columns.map((col) => {
              const active = sort?.key === col.key;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={
                    active
                      ? sort!.dir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  className={`px-3 py-2 text-xs font-medium ${
                    numericCols.has(col.key) ? "text-right" : "text-left"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    title={t("sort")}
                    className={`inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-border/60 hover:text-foreground ${
                      active ? "text-foreground" : "text-muted"
                    }`}
                  >
                    {col.label}
                    <span aria-hidden className="text-[9px]">
                      {active ? (sort!.dir === "desc" ? "▼" : "▲") : "⇅"}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              title={clickable ? rowTarget?.label : undefined}
              onClick={() => fireRow(row)}
              onKeyDown={(e) => {
                if (clickable && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  fireRow(row);
                }
              }}
              className={`border-b border-border/60 last:border-b-0 ${
                clickable
                  ? "cursor-pointer transition-colors hover:bg-border/40 focus-visible:bg-border/40 focus-visible:outline-none"
                  : ""
              }`}
            >
              {spec.columns.map((col) => {
                const v = row[col.key];
                return (
                  <td
                    key={col.key}
                    className={`px-3 py-2 ${
                      numericCols.has(col.key)
                        ? "text-right font-mono text-[13px] tabular-nums"
                        : "text-left"
                    } ${v === null ? "text-muted" : ""}`}
                  >
                    {v === null ? "—" : typeof v === "number" ? numFmt.format(v) : v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {clickable && rowTarget?.label && (
        <p className="mt-2 px-1 text-[11px] text-muted">
          {t("rowClickHint", { label: rowTarget.label.toLowerCase() })}
        </p>
      )}
    </div>
  );
}
