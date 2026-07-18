#!/usr/bin/env bash
# A2 step 3 (slice part "б"): ALL WatchEvents of every actor that starred one
# of the target repos (needed for the co-starring matrix), excluding the target
# repos themselves (already loaded by a2_20).
# Batches: yearly 2011-2018 (small), monthly 2019-01 .. 2026-06.
# The source-side query recomputes the actor set on the playground itself
# (A2_ACTORS_SUBQ_SRC, pinned by the cutoff — identical to our local set);
# the whole filter runs remotely inside view(...), see a2_lib.sh.
source "$(dirname "${BASH_SOURCE[0]}")/a2_lib.sh"

# Guard: part "а" must be complete, otherwise the actor set is partial.
n_actors="$(a2_ch "SELECT count() FROM (${A2_ACTORS_SUBQ})")"
if (( n_actors < 15000 )); then
  a2_log "FATAL	actor set has only $n_actors actors — run a2_20_load_repos.sh first"
  exit 1
fi
a2_log "PHASE-B	actor set: $n_actors actors"

base_local="event_type = 'WatchEvent' AND repo_name NOT IN (${A2_REPOS_SQL}) AND actor_login IN (${A2_ACTORS_SUBQ})"
base_src="event_type = 'WatchEvent' AND repo_name NOT IN (${A2_REPOS_SQL}) AND actor_login IN (${A2_ACTORS_SUBQ_SRC})"

while read -r id from to; do
  range="created_at >= '${from} 00:00:00' AND created_at < '${to} 00:00:00'"
  a2_http_load_batch "$id" "${base_local} AND ${range}" "${base_src} AND ${range}" "$A2_COLS_NARROW_SRC" "$A2_COLS_NARROW"
done < <(python3 - <<'PY'
from datetime import date
# yearly 2011-2018 (max ~0.77M rows/year, under the 1M source result cap)
for y in range(2011, 2019):
    print(f"B-{y} {y}-01-01 {y+1}-01-01")
# monthly 2019-01 .. 2026-06 (max month ~0.4M rows)
m = date(2019, 1, 1)
while m < date(2026, 7, 1):
    nxt = date(m.year + (m.month == 12), m.month % 12 + 1, 1)
    print(f"B-{m:%Y-%m} {m:%Y-%m-%d} {nxt:%Y-%m-%d}")
    m = nxt
PY
)

a2_log "PHASE-B	complete: $(a2_ch "SELECT count() FROM ${A2_TARGET} WHERE ${base_local}") actor-star rows"
