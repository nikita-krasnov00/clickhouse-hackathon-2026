#!/usr/bin/env bash
# a2_lib.sh — common helpers for the A2 slice-loading scripts.
# Source this file; do not execute it directly.
set -euo pipefail

A2_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A2_ROOT="$(dirname "$A2_DIR")"
A2_LOG="$A2_DIR/a2_progress.log"

# --- env ---------------------------------------------------------------------
if [[ -f "$A2_ROOT/.env" ]]; then
  set -a; source "$A2_ROOT/.env"; set +a
else
  echo "FATAL: $A2_ROOT/.env not found" >&2; exit 1
fi

: "${CLICKHOUSE_URL:?}" "${CLICKHOUSE_USER:?}" "${CLICKHOUSE_PASSWORD:?}"

# --- slice configuration (frozen; changing it breaks idempotency) ------------
# Repos with documented fake-star campaigns (StarScout dataset, hehao98/StarScout
# data/long_living_repos.csv; see final report for links):
#   lavague-ai/LaVague       p_fake=0.76  campaign 2024-03
#   Zejun-Yang/AniPortrait   p_fake=0.83  campaign 2024-03..04
#   deepseek-ai/DeepSeek-VL  p_fake=0.78  campaign 2024-03
#   solidSpoon/DashPlayer    p_fake=0.86  campaign 2024-05
#   OpenInterpreter/01       p_fake=0.46  campaign 2024-03 (mixed organic+fake, contrast case)
A2_REPOS_SQL="'lavague-ai/LaVague','Zejun-Yang/AniPortrait','deepseek-ai/DeepSeek-VL','solidSpoon/DashPlayer','OpenInterpreter/01'"

# Global determinism cutoff: playground ingests live data; everything we copy
# is pinned strictly before this timestamp.
A2_CUTOFF="2026-07-01 00:00:00"

# Background window around the fake-star campaigns (all of them are 2024-03..05).
A2_BG_FROM="2024-01-01"
A2_BG_TO="2024-07-01"   # exclusive

# Source (public ClickHouse playground).
A2_SRC_HOST="play.clickhouse.com:9440"
A2_SRC_HTTP="https://play.clickhouse.com"
A2_SRC_TABLE="default.github_events"
A2_SRC_USER="explorer"
A2_SRC_PASSWORD=""

# Column subsets: WatchEvent/CreateEvent/ForkEvent rows only ever populate
# these columns (verified: max() of every other column is 0/'' on the source),
# and PullRequestEvent everything except long-text/rarely-used fields (body,
# labels, assignees, requested_*, shas, mergeable state — dropped consciously:
# they are not used by the fraud-detection demo and triple the transfer cost).
# Narrow subsets cut source-side scan memory ~7x, which is what makes bigger
# time chunks fit into the source per-query memory budget.
# LowCardinality columns are CAST to plain String on the source: the source's
# max_result_bytes (953 MiB, not overridable) counts the ALLOCATED bytes of
# streamed blocks, and LowCardinality columns drag the part's huge shared
# dictionary into that accounting — a query "returning" a few MB gets killed
# at "953 MiB". Plain String blocks count only real data. (toString() does NOT
# help: functions preserve LowCardinality; only an explicit CAST strips it.)
# Our INSERT converts String back to LowCardinality on the fly.
A2_COLS_NARROW="file_time, event_type, actor_login, repo_name, created_at, updated_at, action, ref, ref_type"
A2_COLS_NARROW_SRC="file_time, event_type, CAST(actor_login AS String) AS actor_login, CAST(repo_name AS String) AS repo_name, created_at, updated_at, action, CAST(ref AS String) AS ref, ref_type"
A2_COLS_PR="file_time, event_type, actor_login, repo_name, created_at, updated_at, action, number, title, state, locked, author_association, closed_at, merged_at, head_ref, base_ref, merged, merged_by, review_comments, commits, additions, deletions, changed_files"
A2_COLS_PR_SRC="file_time, event_type, CAST(actor_login AS String) AS actor_login, CAST(repo_name AS String) AS repo_name, created_at, updated_at, action, number, title, state, locked, author_association, closed_at, merged_at, CAST(head_ref AS String) AS head_ref, CAST(base_ref AS String) AS base_ref, merged, CAST(merged_by AS String) AS merged_by, review_comments, commits, additions, deletions, changed_files"

A2_TARGET="github.github_events"

# Local subquery producing the frozen actor set (actors who starred the repos).
# Evaluated on OUR server against part-"а" data (cleanup + control counts).
A2_ACTORS_SUBQ="SELECT DISTINCT actor_login FROM ${A2_TARGET} WHERE event_type = 'WatchEvent' AND repo_name IN (${A2_REPOS_SQL})"

# The SAME actor set phrased for the source side: the playground has the same
# events, pinned by the cutoff, so the sets are identical. Used inside the
# view() remote query (see a2_load_batch) so filtering happens entirely on the
# source. (GLOBAL IN does NOT work here: table-function pushdown only forwards
# primary-key predicates; everything else is filtered on the initiator AFTER
# pulling rows, which explodes into the source's 1M-row / 953MiB result caps.)
A2_ACTORS_SUBQ_SRC="SELECT DISTINCT actor_login FROM ${A2_SRC_TABLE} WHERE event_type = 'WatchEvent' AND repo_name IN (${A2_REPOS_SQL}) AND created_at < '${A2_CUTOFF}'"

# --- helpers -----------------------------------------------------------------
a2_log() {
  local msg="$1"
  printf '%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$msg" | tee -a "$A2_LOG" >&2
}

# Run a query on OUR ClickHouse Cloud (admin). Query on stdin or as $1.
# Extra URL params may be passed as $2 (e.g. "&max_execution_time=3600").
a2_ch() {
  local q="${1:-$(cat)}"
  local params="${2:-}"
  local out http
  out="$(curl -sS --max-time 5400 \
    "https://${CLICKHOUSE_URL}/?default_format=TSV${params}" \
    -u "${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}" \
    --data-binary "$q" \
    -w $'\n__HTTP_%{http_code}__')"
  http="${out##*__HTTP_}"; http="${http%__*}"
  out="${out%$'\n'__HTTP_*}"
  if [[ "$http" != "200" ]]; then
    echo "CH ERROR (http $http): $out" >&2
    return 1
  fi
  printf '%s' "$out"
}

# Has this batch already been marked done in the progress log?
a2_done() { grep -qF "DONE	$1" "$A2_LOG" 2>/dev/null; }
a2_mark_done() { a2_log "DONE	$1"; }

# If the source quota (600s execution / hour, per client) is exhausted, sleep
# until the interval resets. Returns 0 if it slept (caller should retry).
a2_quota_wait() {
  local probe
  probe="$(curl -sS --max-time 30 "${A2_SRC_HTTP}/?user=${A2_SRC_USER}" --data-binary "SELECT 1" 2>&1 || true)"
  if [[ "$probe" == *QUOTA_EXCEEDED* || "$probe" == *"Quota for user"* ]]; then
    local end_ts wait_s
    end_ts="$(sed -n 's/.*Interval will end at \([0-9-]* [0-9:]*\).*/\1/p' <<<"$probe")"
    if [[ -n "$end_ts" ]]; then
      wait_s=$(( $(TZ=UTC python3 -c "from datetime import datetime,timezone;print(int(datetime.strptime('$end_ts','%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc).timestamp()))") - $(date -u +%s) + 5 ))
      (( wait_s < 5 )) && wait_s=5
      (( wait_s > 3700 )) && wait_s=3700
    else
      wait_s=120
    fi
    a2_log "QUOTA	source quota exhausted, sleeping ${wait_s}s until $end_ts"
    sleep "$wait_s"
    return 0
  fi
  return 1
}

# HTTP-pipe loader: pulls a batch from the source over its HTTP API (the whole
# WHERE clause executes verbatim on the source — table-function pushdown is NOT
# involved) and streams it zstd-compressed straight into our Cloud HTTP INSERT.
#   $1 = batch id     $2 = local predicate     $3 = source predicate
#   $4 = source SELECT list (subset, with CASTs stripping LowCardinality)
#   $5 = INSERT column names matching $4 positionally (default: $4)
# Missing columns land as type defaults. Same idempotency contract as
# a2_load_batch.
a2_http_load_batch() {
  local id="$1" local_pred="$2" src_pred="${3:-$2}" cols="${4:-*}" ins_cols="${5:-${4:-*}}"
  if a2_done "$id"; then
    return 0
  fi
  local lockroot="$A2_DIR/.a2_locks" lockdir owner age
  lockdir="$lockroot/$id"
  mkdir -p "$lockroot"
  if ! mkdir "$lockdir" 2>/dev/null; then
    owner="$(cat "$lockdir/pid" 2>/dev/null || true)"
    if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then return 0; fi
    age=$(( $(date +%s) - $(stat -f %m "$lockdir" 2>/dev/null || echo 0) ))
    if [[ -z "$owner" ]] && (( age < 120 )); then return 0; fi
    rm -rf "$lockdir"
    mkdir "$lockdir" 2>/dev/null || return 0
  fi
  echo $$ > "$lockdir/pid"

  local ins_q src_q attempt existing n t0 hdr
  ins_q="$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' \
           "INSERT INTO ${A2_TARGET} (${ins_cols}) FORMAT Native")"
  src_q="SELECT ${cols} FROM ${A2_SRC_TABLE}
         WHERE created_at < '${A2_CUTOFF}' AND ${src_pred}
         FORMAT Native"
  hdr="$lockdir/headers"
  for attempt in 1 2 3 4 5; do
    t0=$SECONDS
    if existing="$(a2_ch "SELECT count() FROM ${A2_TARGET} WHERE ${local_pred}")" \
       && { [[ "$existing" == "0" ]] || {
              a2_log "CLEANUP	$id	deleting $existing leftover rows"
              a2_ch "DELETE FROM ${A2_TARGET} WHERE ${local_pred}" "&lightweight_deletes_sync=2" >/dev/null
            }; } \
       && a2_log "START	$id (attempt $attempt, http)" \
       && curl -sS --fail --max-time 900 -D "$hdr" -H 'Accept-Encoding: zstd' \
            "${A2_SRC_HTTP}/?user=${A2_SRC_USER}&enable_http_compression=1" \
            --data-binary "$src_q" \
          | curl -sS --fail --max-time 900 -H 'Content-Encoding: zstd' \
              "https://${CLICKHOUSE_URL}/?query=${ins_q}" \
              -u "${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}" \
              --data-binary @- >/dev/null \
       && n="$(a2_ch "SELECT count() FROM ${A2_TARGET} WHERE ${local_pred}")"; then
      local exec_ns
      exec_ns="$(sed -n 's/.*"elapsed_ns":"\([0-9]*\)".*/\1/p' "$hdr" | tail -1)"
      a2_log "LOADED	$id	rows=$n	elapsed=$((SECONDS - t0))s	src_exec=$(( ${exec_ns:-0} / 1000000 ))ms"
      a2_mark_done "$id"
      rm -rf "$lockdir"
      return 0
    fi
    if a2_quota_wait; then
      a2_log "RETRY	$id	retrying after quota wait"
      continue
    fi
    a2_log "RETRY	$id	attempt $attempt failed, sleeping $((attempt * 10))s"
    sleep $((attempt * 10))
  done
  a2_log "FAILED	$id	giving up after 5 attempts"
  rm -rf "$lockdir"
  return 1
}

# Run one idempotent load batch.
#   $1 = batch id (stable string)
#   $2 = local predicate  — evaluated on OUR table (cleanup + control count);
#        must exactly describe the set of rows this batch owns (batches are
#        pairwise disjoint under their local predicates).
#   $3 = source predicate — same semantics, phrased for the remote query
#        (subqueries must reference source tables, e.g. A2_ACTORS_SUBQ_SRC).
#        Defaults to $2.
# The source query is wrapped in remoteSecure(host, view(SELECT ...)) so the
# ENTIRE predicate executes on the source — required to stay under the source
# result caps (1M rows / 953MiB per query, 60s max_execution_time, none
# overridable: readonly=1 profile).
# Idempotency: if the batch is not marked DONE, any rows matching the local
# predicate are first deleted (cleanup of a previously interrupted attempt).
# NOTE: do not raise max_execution_time on the INSERT — changed settings are
# forwarded to the source, whose readonly profile rejects them.
a2_load_batch() {
  local id="$1" local_pred="$2" src_pred="${3:-$2}"
  if a2_done "$id"; then
    a2_log "SKIP	$id	already done"
    return 0
  fi
  # Per-batch lock so several workers may share (overlapping) chunk lists.
  local lockroot="$A2_DIR/.a2_locks" lockdir owner age
  lockdir="$lockroot/$id"
  mkdir -p "$lockroot"
  if ! mkdir "$lockdir" 2>/dev/null; then
    owner="$(cat "$lockdir/pid" 2>/dev/null || true)"
    if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
      return 0  # live worker owns it
    fi
    age=$(( $(date +%s) - $(stat -f %m "$lockdir" 2>/dev/null || echo 0) ))
    if [[ -z "$owner" ]] && (( age < 120 )); then
      return 0  # freshly created, pid not written yet
    fi
    rm -rf "$lockdir"
    mkdir "$lockdir" 2>/dev/null || return 0
  fi
  echo $$ > "$lockdir/pid"
  # (no trap: a stale lock from a killed worker is reclaimed via the dead-pid
  # check above; the lock is removed explicitly on both exit paths below)
  local attempt existing n t0
  for attempt in 1 2 3 4 5; do
    t0=$SECONDS
    if existing="$(a2_ch "SELECT count() FROM ${A2_TARGET} WHERE ${local_pred}")" \
       && { [[ "$existing" == "0" ]] || {
              a2_log "CLEANUP	$id	deleting $existing leftover rows from interrupted attempt"
              a2_ch "DELETE FROM ${A2_TARGET} WHERE ${local_pred}" "&lightweight_deletes_sync=2" >/dev/null
            }; } \
       && a2_log "START	$id (attempt $attempt)" \
       && a2_ch "INSERT INTO ${A2_TARGET}
                 SELECT * FROM remoteSecure('${A2_SRC_HOST}',
                   view(SELECT * FROM ${A2_SRC_TABLE}
                        WHERE created_at < '${A2_CUTOFF}' AND ${src_pred}),
                   '${A2_SRC_USER}', '${A2_SRC_PASSWORD}')" >/dev/null \
       && n="$(a2_ch "SELECT count() FROM ${A2_TARGET} WHERE ${local_pred}")"; then
      a2_log "LOADED	$id	rows=$n	elapsed=$((SECONDS - t0))s"
      a2_mark_done "$id"
      rm -rf "$lockdir"
      return 0
    fi
    a2_log "RETRY	$id	attempt $attempt failed, sleeping $((attempt * 10))s"
    sleep $((attempt * 10))
  done
  a2_log "FAILED	$id	giving up after 5 attempts"
  rm -rf "$lockdir"
  return 1
}
