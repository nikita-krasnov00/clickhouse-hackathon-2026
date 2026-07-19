#!/usr/bin/env bash
# A4 — роллапы в scratch для бюджета drill ≤300 мс (см. db/A3_DEMO_NOTES.md).
# Идемпотентен: CREATE OR REPLACE TABLE. Запуск под админом из .env корня.
#
#   daily_stars        repo × день → звёзды (Q1/Q5 мгновенно)
#   actor_stats_6mo    actor → активность за 2024-01..07 + первое событие в слайсе
#   control_actors     толпа grok-1 марта — контроль органики для lift
#   star_pairs         (actor, repo) DISTINCT WatchEvent 2024H1 — ко-старинг по акторам
#   star_pairs_by_repo то же, ключ (repo, actor) — пары репо для costar-graph
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$REPO_ROOT/.env"; set +a
CH="https://$CLICKHOUSE_URL"

q() {
  local label="$1" sql="$2" t0 out
  t0=$(date +%s)
  out=$(curl -sS --max-time 600 "$CH" -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" \
    --data-binary "$sql") || { echo "FAIL $label: $out"; exit 1; }
  [ -n "$out" ] && echo "$out"
  echo "OK  $label ($(( $(date +%s) - t0 )) s)"
}

q "daily_stars" "
CREATE OR REPLACE TABLE scratch.daily_stars
ENGINE = MergeTree ORDER BY (repo_name, day) AS
SELECT repo_name, toDate(created_at) AS day, count() AS stars
FROM github.github_events
WHERE event_type = 'WatchEvent'
GROUP BY repo_name, day
SETTINGS max_execution_time = 570"

q "actor_stats_6mo" "
CREATE OR REPLACE TABLE scratch.actor_stats_6mo
ENGINE = MergeTree ORDER BY actor_login AS
SELECT
  actor_login,
  countIf(created_at >= '2024-01-01' AND created_at < '2024-07-01') AS ev_6mo,
  countIf(event_type = 'WatchEvent'
      AND created_at >= '2024-01-01' AND created_at < '2024-07-01') AS stars_6mo,
  uniqExactIf(toDate(created_at),
      created_at >= '2024-01-01' AND created_at < '2024-07-01') AS active_days,
  min(created_at) AS first_ts
FROM github.github_events
GROUP BY actor_login
SETTINGS max_execution_time = 570"

q "control_actors" "
CREATE OR REPLACE TABLE scratch.control_actors
ENGINE = MergeTree ORDER BY actor_login AS
SELECT DISTINCT actor_login
FROM github.github_events
WHERE event_type = 'WatchEvent' AND repo_name = 'xai-org/grok-1'
  AND created_at >= '2024-03-01' AND created_at < '2024-04-01'"

q "star_pairs" "
CREATE OR REPLACE TABLE scratch.star_pairs
ENGINE = MergeTree ORDER BY (actor_login, repo_name) AS
SELECT DISTINCT actor_login, repo_name
FROM github.github_events
WHERE event_type = 'WatchEvent'
  AND created_at >= '2024-01-01' AND created_at < '2024-07-01'
SETTINGS max_execution_time = 570"

q "star_pairs_by_repo" "
CREATE OR REPLACE TABLE scratch.star_pairs_by_repo
ENGINE = MergeTree ORDER BY (repo_name, actor_login) AS
SELECT repo_name, actor_login FROM scratch.star_pairs"

echo "== counts =="
q "counts" "
SELECT table, total_rows FROM system.tables
WHERE database = 'scratch' AND table IN
  ('daily_stars','actor_stats_6mo','control_actors','star_pairs','star_pairs_by_repo')
FORMAT TSV"
echo "== a4_rollups DONE =="
