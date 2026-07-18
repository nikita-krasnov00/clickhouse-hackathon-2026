#!/usr/bin/env bash
# A2 orchestrator: full idempotent load of the github_events slice.
# Safe to re-run at any point — completed batches are skipped via a2_progress.log,
# interrupted batches are cleaned up (DELETE by predicate) and re-inserted.
#
# Phases:
#   1. create table            (a2_10)
#   2. target repos, all events (a2_20)  — sequential, small
#   3. two parallel streams over the remaining parts (the source enforces an
#      execution-time quota of 600 s/hour per client — more parallelism only
#      makes the streams starve each other):
#        stream 1: background watch -> create -> fork
#        stream 2: actor stars (a2_30) -> sampled background PRs
source "$(dirname "${BASH_SOURCE[0]}")/a2_lib.sh"

a2_log "RUN	a2_run_all started"

"$A2_DIR/a2_10_create_table.sh"
"$A2_DIR/a2_20_load_repos.sh"

pids=()
( "$A2_DIR/a2_40_load_background.sh" watch \
  && "$A2_DIR/a2_40_load_background.sh" create \
  && "$A2_DIR/a2_40_load_background.sh" fork )      & pids+=($!)
( "$A2_DIR/a2_30_load_actor_stars.sh" \
  && "$A2_DIR/a2_40_load_background.sh" pullrequest ) & pids+=($!)

fail=0
for pid in "${pids[@]}"; do
  wait "$pid" || fail=1
done

if (( fail )); then
  a2_log "RUN	a2_run_all FINISHED WITH ERRORS — re-run to resume"
  exit 1
fi
a2_log "RUN	a2_run_all complete"
"$A2_DIR/a2_50_verify.sh"
