#!/usr/bin/env bash
# Перезапускает a2_run_all до чистого финиша (квота источника: 600 с/час).
# До 8 попыток с паузой 20 мин; лог — db/a2_resume.log.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for i in $(seq 1 8); do
  echo "=== resume attempt $i · $(date -u +%FT%TZ) ===" >> "$DIR/a2_resume.log"
  if "$DIR/a2_run_all.sh" >> "$DIR/a2_resume.log" 2>&1; then
    echo "=== CLEAN FINISH · $(date -u +%FT%TZ) ===" >> "$DIR/a2_resume.log"
    exit 0
  fi
  sleep 1200
done
echo "=== GAVE UP after 8 attempts ===" >> "$DIR/a2_resume.log"
