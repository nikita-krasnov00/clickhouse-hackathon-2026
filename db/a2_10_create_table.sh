#!/usr/bin/env bash
# A2 step 1: create github.github_events (idempotent).
source "$(dirname "${BASH_SOURCE[0]}")/a2_lib.sh"

a2_ch "CREATE DATABASE IF NOT EXISTS github" >/dev/null
a2_ch < "$A2_DIR/a2_10_create_table.sql" >/dev/null
a2_log "TABLE	github.github_events ready"
a2_ch "SELECT count() FROM ${A2_TARGET}" | { read -r n; a2_log "TABLE	current row count: $n"; }
