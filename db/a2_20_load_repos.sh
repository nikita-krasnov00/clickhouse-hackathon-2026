#!/usr/bin/env bash
# A2 step 2 (slice part "а"): ALL events, all history, for the target repos
# with documented fake-star campaigns. One idempotent batch per repo.
source "$(dirname "${BASH_SOURCE[0]}")/a2_lib.sh"

REPOS=(
  'lavague-ai/LaVague'
  'Zejun-Yang/AniPortrait'
  'deepseek-ai/DeepSeek-VL'
  'solidSpoon/DashPlayer'
  'OpenInterpreter/01'
)

for repo in "${REPOS[@]}"; do
  id="A-repo-${repo//\//_}"
  a2_load_batch "$id" "repo_name = '${repo}'"
done

a2_log "PHASE-A	complete: $(a2_ch "SELECT count() FROM ${A2_TARGET} WHERE repo_name IN (${A2_REPOS_SQL})") rows for target repos"
