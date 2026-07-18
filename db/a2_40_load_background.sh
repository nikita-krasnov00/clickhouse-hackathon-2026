#!/usr/bin/env bash
# A2 step 4 (slice part "в"): background slice for realism around the fake-star
# campaigns (all campaigns fall in 2024-03..05; window 2024-01-01 .. 2024-07-01).
#   WatchEvent        — minus target repos, minus part-"б" actors (3-day chunks)
#   CreateEvent       — repository creations only (ref_type='repository'), minus
#                       target repos (4-day chunks)
#   ForkEvent         — minus target repos (5-day chunks)
#   PullRequestEvent  — minus target repos (2-day chunks)
# Chunk sizes keep every source query under the playground's caps:
#   max_result_rows = 1M  (measured max daily counts: watch 279k, create-repo
#                          211k, fork 141k, pr 447k)
#   max_result_bytes ~ 953 MiB (PullRequestEvent rows are wide — one full day
#                          is ~1 GB uncompressed, hence 6-hour chunks for PRs)
#
# Usage: a2_40_load_background.sh [watch|create|fork|pullrequest] [from] [to]
#        (no arguments = all four types sequentially over the whole window;
#         from/to = ISO dates to restrict the range, for parallel workers)
source "$(dirname "${BASH_SOURCE[0]}")/a2_lib.sh"

# Guard: part "а" must be complete (repo/actor exclusions depend on it).
n_actors="$(a2_ch "SELECT count() FROM (${A2_ACTORS_SUBQ})")"
if (( n_actors < 15000 )); then
  a2_log "FATAL	actor set has only $n_actors actors — run a2_20_load_repos.sh first"
  exit 1
fi

run_type() {
  local kind="$1" range_from="${2:-$A2_BG_FROM}" range_to="${3:-$A2_BG_TO}"
  local pred_local pred_src hours cols ins_cols idkind="$1"
  case "$kind" in
    watch)
      pred_local="event_type = 'WatchEvent' AND repo_name NOT IN (${A2_REPOS_SQL}) AND actor_login NOT IN (${A2_ACTORS_SUBQ})"
      pred_src="event_type = 'WatchEvent' AND repo_name NOT IN (${A2_REPOS_SQL}) AND actor_login NOT IN (${A2_ACTORS_SUBQ_SRC})"
      hours=72; cols="$A2_COLS_NARROW_SRC"; ins_cols="$A2_COLS_NARROW" ;;
    create)
      pred_local="event_type = 'CreateEvent' AND ref_type = 'repository' AND repo_name NOT IN (${A2_REPOS_SQL})"
      pred_src="$pred_local"
      hours=96; cols="$A2_COLS_NARROW_SRC"; ins_cols="$A2_COLS_NARROW" ;;
    fork)
      pred_local="event_type = 'ForkEvent' AND repo_name NOT IN (${A2_REPOS_SQL})"
      pred_src="$pred_local"
      hours=120; cols="$A2_COLS_NARROW_SRC"; ins_cols="$A2_COLS_NARROW" ;;
    pullrequest)
      # PR background is sampled: 25% of repos, deterministically by repo hash
      # (all-or-nothing per repo, so per-repo PR histories stay complete).
      # Full-fidelity PR loading blows the source hourly execution quota.
      pred_local="event_type = 'PullRequestEvent' AND repo_name NOT IN (${A2_REPOS_SQL}) AND cityHash64(repo_name) % 4 = 0"
      pred_src="$pred_local"
      hours=24; cols="$A2_COLS_PR_SRC"; ins_cols="$A2_COLS_PR"; idkind="prsample"  # old C-pullrequest-* ids are inert
      # one-time reset: drop full-fidelity PR rows loaded by the abandoned
      # unsampled scheme (their batch ids C-pullrequest-* are inert now)
      if ! a2_done "C-prsample-reset"; then
        a2_log "RESET	deleting unsampled PullRequestEvent background rows"
        a2_ch "DELETE FROM ${A2_TARGET} WHERE event_type = 'PullRequestEvent' AND repo_name NOT IN (${A2_REPOS_SQL})" "&lightweight_deletes_sync=2" >/dev/null
        a2_mark_done "C-prsample-reset"
      fi ;;
    *) echo "unknown type: $kind" >&2; exit 1 ;;
  esac

  while IFS='|' read -r id from to; do
    range="created_at >= '${from}' AND created_at < '${to}'"
    a2_http_load_batch "$id" "${pred_local} AND ${range}" "${pred_src} AND ${range}" "$cols" "$ins_cols"
  done < <(python3 - "$idkind" "$hours" "$range_from" "$range_to" <<'PY'
import sys
from datetime import datetime, timedelta
kind, hours = sys.argv[1], int(sys.argv[2])
start, end = (datetime.fromisoformat(a) for a in sys.argv[3:5])
d = start
while d < end:
    nxt = min(d + timedelta(hours=hours), end)
    # day-granular chunks keep the historical day-based batch ids (already
    # marked DONE in the progress log by earlier runs)
    bid = f"C-{kind}-{d:%Y%m%d}" if hours % 24 == 0 and d.hour == 0 else f"C-{kind}-{d:%Y%m%d%H}"
    print(f"{bid}|{d:%Y-%m-%d %H:%M:%S}|{nxt:%Y-%m-%d %H:%M:%S}")
    d = nxt
PY
)
  a2_log "PHASE-C-${kind}	complete (${range_from}..${range_to})"
}

if [[ $# -ge 1 ]]; then
  run_type "$@"
else
  for k in watch create fork pullrequest; do run_type "$k"; done
fi
