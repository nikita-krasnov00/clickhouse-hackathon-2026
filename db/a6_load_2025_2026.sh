#!/usr/bin/env bash
# A6 — догрузка github.github_events за 2025-01-01 .. 2026-06-30 из gharchive.org.
#
# Источник: https://data.gharchive.org/YYYY-MM-DD-H.json.gz (сырой GH Archive JSON).
# Загрузка идёт ЦЕЛИКОМ на стороне ClickHouse Cloud: INSERT ... SELECT FROM url(...)
# с форматом JSONAsString + JSONExtract* — локальный трафик нулевой.
#
# Состав слайса — консистентен с фоном 2024H1 (см. a2_40_load_background.sh):
#   WatchEvent        — полностью
#   ForkEvent         — полностью
#   CreateEvent       — только создания репозиториев (ref_type='repository')
#   PullRequestEvent  — 25% репозиториев (cityHash64(repo_name)%4=0),
#                       action IN opened/closed/reopened
# Колоночные подмножества те же, что у A2 (A2_COLS_NARROW / A2_COLS_PR);
# отсутствующие колонки остаются дефолтами типов.
#
# Идемпотентность БЕЗ удалений: вставка с анти-join'ом по отпечатку
# (event_type, actor_login, repo_name, created_at) против уже существующих
# строк этого дня — существующий тонкий слайс 2025-2026 (истории акторов,
# целевые репо) проверенно совпадает по отпечаткам с gharchive (239/239 на
# 2026-06-15), поэтому он просто не вставляется повторно. Прерванная вставка
# при повторе доливает только недостающие строки.
#
# Прогресс: таблица scratch.a6_loaded_days (день загружен = строка в ней) +
# кэш db/a6_loaded_days.txt + лог db/a6_progress.log. Перезапуск продолжает
# с места остановки. Параллельные воркеры разводятся lock-каталогами
# db/.a6_locks/<day> и могут делить диапазон аргументами from/to.
#
# Порядок: от НОВЕЙШИХ дней назад (2026-06-30 -> 2025-01-01), чтобы частичный
# результат был ценным.
#
# Usage: a6_load_2025_2026.sh [from] [to]     # ISO-даты, to — эксклюзивно
#        (default: 2025-01-01 2026-07-01)
set -uo pipefail

A6_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A6_ROOT="$(dirname "$A6_DIR")"
A6_LOG="$A6_DIR/a6_progress.log"
A6_DAYS_CACHE="$A6_DIR/a6_loaded_days.txt"
A6_LOCKROOT="$A6_DIR/.a6_locks"

if [[ -f "$A6_ROOT/.env" ]]; then
  set -a; source "$A6_ROOT/.env"; set +a
else
  echo "FATAL: $A6_ROOT/.env not found" >&2; exit 1
fi
: "${CLICKHOUSE_URL:?}" "${CLICKHOUSE_USER:?}" "${CLICKHOUSE_PASSWORD:?}"

A6_FROM="${1:-2025-01-01}"
A6_TO="${2:-2026-07-01}"      # exclusive; выше A2_CUTOFF (2026-07-01) не лезем
A6_TARGET="github.github_events"
A6_STATE="scratch.a6_loaded_days"
A6_SRC="https://data.gharchive.org"

a6_log() {
  printf '%s\t[%s]\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$$" "$1" | tee -a "$A6_LOG" >&2
}

# Запрос на нашем Cloud (админ). SQL — $1, доп. URL-параметры — $2.
a6_ch() {
  local q="$1" params="${2:-}" out http
  out="$(curl -sS --max-time 3600 \
    "https://${CLICKHOUSE_URL}/?default_format=TSV${params}" \
    -u "${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}" \
    --data-binary "$q" \
    -w $'\n__HTTP_%{http_code}__' 2>&1)"
  http="${out##*__HTTP_}"; http="${http%__*}"
  out="${out%$'\n'__HTTP_*}"
  if [[ "$http" != "200" ]]; then
    A6_LAST_ERR="$out"
    return 1
  fi
  printf '%s' "$out"
}

# Локальный предикат: какие строки в таблице принадлежат A6-слайсу.
# Совпадает с фильтром вставки; используется для анти-join'а и контроля.
A6_LOCAL_PRED="(event_type IN ('WatchEvent','ForkEvent')
  OR (event_type = 'CreateEvent' AND ref_type = 'repository')
  OR (event_type = 'PullRequestEvent' AND cityHash64(repo_name) % 4 = 0
      AND action IN ('opened','closed','reopened')))"

# INSERT ... SELECT из gharchive.
#   $1 = url-глоб без префикса/суффикса (например 2025-01-01-{0..23})
#   $2 = from_ts, $3 = to_ts (границы created_at, [from, to))
a6_insert_sql() {
  local glob="$1" from_ts="$2" to_ts="$3"
  cat <<SQL
INSERT INTO ${A6_TARGET}
  (file_time, event_type, actor_login, repo_name, created_at, updated_at,
   action, ref, ref_type, number, title, state, locked, author_association,
   closed_at, merged_at, head_ref, base_ref, merged, merged_by,
   review_comments, commits, additions, deletions, changed_files)
WITH
  JSONExtractString(line, 'type')        AS t,
  JSONExtractRaw(line, 'payload')        AS p,
  JSONExtractRaw(p, 'pull_request')      AS pr,
  JSONExtractString(pr, 'state')         AS pr_state,
  JSONExtractString(pr, 'author_association') AS pr_aa
SELECT
  toDateTime(substring(_file, 1, 10))
    + toIntervalHour(toUInt8OrZero(extract(_file, '-([0-9]+)[.]json'))) AS file_time,
  t                                                     AS event_type,
  JSONExtractString(line, 'actor', 'login')             AS actor_login,
  JSONExtractString(line, 'repo', 'name')               AS repo_name,
  parseDateTimeBestEffort(JSONExtractString(line, 'created_at')) AS created_at,
  if(t = 'PullRequestEvent',
     parseDateTimeBestEffortOrZero(JSONExtractString(pr, 'updated_at')),
     toDateTime(0))                                     AS updated_at,
  multiIf(t = 'WatchEvent', 'started',
          t = 'PullRequestEvent', JSONExtractString(p, 'action'),
          'none')                                       AS action,
  if(t = 'CreateEvent', JSONExtractString(p, 'ref'), '') AS ref,
  if(t = 'CreateEvent', 'repository', 'none')           AS ref_type,
  if(t = 'PullRequestEvent', JSONExtractUInt(p, 'number'), 0) AS number,
  JSONExtractString(pr, 'title')                        AS title,
  if(pr_state IN ('open','closed'), pr_state, 'none')   AS state,
  JSONExtractBool(pr, 'locked')                         AS locked,
  if(pr_aa IN ('CONTRIBUTOR','OWNER','COLLABORATOR','MEMBER','MANNEQUIN'),
     pr_aa, 'NONE')                                     AS author_association,
  parseDateTimeBestEffortOrZero(JSONExtractString(pr, 'closed_at'))  AS closed_at,
  parseDateTimeBestEffortOrZero(JSONExtractString(pr, 'merged_at'))  AS merged_at,
  JSONExtractString(pr, 'head', 'ref')                  AS head_ref,
  JSONExtractString(pr, 'base', 'ref')                  AS base_ref,
  JSONExtractBool(pr, 'merged')                         AS merged,
  JSONExtractString(pr, 'merged_by', 'login')           AS merged_by,
  JSONExtractUInt(pr, 'review_comments')                AS review_comments,
  JSONExtractUInt(pr, 'commits')                        AS commits,
  JSONExtractUInt(pr, 'additions')                      AS additions,
  JSONExtractUInt(pr, 'deletions')                      AS deletions,
  JSONExtractUInt(pr, 'changed_files')                  AS changed_files
FROM url('${A6_SRC}/${glob}.json.gz', 'JSONAsString', 'line String')
WHERE (t IN ('WatchEvent','ForkEvent')
       OR (t = 'CreateEvent' AND JSONExtractString(p, 'ref_type') = 'repository')
       OR (t = 'PullRequestEvent'
           AND cityHash64(JSONExtractString(line, 'repo', 'name')) % 4 = 0
           AND JSONExtractString(p, 'action') IN ('opened','closed','reopened')))
  AND created_at >= '${from_ts}' AND created_at < '${to_ts}'
  AND (t, actor_login, repo_name, created_at) NOT IN (
      SELECT toString(event_type), toString(actor_login), toString(repo_name), created_at
      FROM ${A6_TARGET}
      WHERE created_at >= '${from_ts}' AND created_at < '${to_ts}' AND ${A6_LOCAL_PRED})
SQL
}

A6_INS_PARAMS="&max_execution_time=3000&input_format_allow_errors_num=100000&input_format_allow_errors_ratio=0.05&max_insert_threads=4"

a6_day_done_db() {  # 0 = день уже загружен по данным scratch
  local n
  n="$(a6_ch "SELECT count() FROM ${A6_STATE} WHERE day = '$1'")" || return 1
  [[ "$n" != "0" ]]
}

a6_mark_day_done() {  # $1=day $2=rows $3=elapsed
  a6_ch "INSERT INTO ${A6_STATE} (day, rows, elapsed_s) VALUES ('$1', $2, $3)" >/dev/null \
    && echo "$1" >> "$A6_DAYS_CACHE"
}

# Погрузить один день. 0 = день закрыт (загружен или уже был), 1 = не удалось.
a6_load_day() {
  local day="$1" next_day attempt err rows t0 elapsed
  next_day="$(python3 -c "from datetime import date,timedelta;print(date.fromisoformat('$day')+timedelta(days=1))")"

  # быстрый кэш + БД-состояние
  grep -qxF "$day" "$A6_DAYS_CACHE" 2>/dev/null && return 0
  if a6_day_done_db "$day"; then echo "$day" >> "$A6_DAYS_CACHE"; return 0; fi

  # lock от параллельных воркеров
  local lockdir="$A6_LOCKROOT/$day" owner
  mkdir -p "$A6_LOCKROOT"
  if ! mkdir "$lockdir" 2>/dev/null; then
    owner="$(cat "$lockdir/pid" 2>/dev/null || true)"
    if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then return 0; fi
    rm -rf "$lockdir"; mkdir "$lockdir" 2>/dev/null || return 0
  fi
  echo $$ > "$lockdir/pid"

  for attempt in 1 2 3; do
    t0=$SECONDS
    a6_log "START	$day	attempt=$attempt (day-glob)"
    if a6_ch "$(a6_insert_sql "${day}-{0..23}" "$day 00:00:00" "$next_day 00:00:00")" "$A6_INS_PARAMS" >/dev/null; then
      elapsed=$((SECONDS - t0))
      rows="$(a6_ch "SELECT count() FROM ${A6_TARGET} WHERE created_at >= '$day' AND created_at < '$next_day' AND ${A6_LOCAL_PRED}")" || rows=-1
      a6_mark_day_done "$day" "$rows" "$elapsed"
      a6_log "LOADED	$day	rows=$rows	elapsed=${elapsed}s"
      rm -rf "$lockdir"
      return 0
    fi
    err="${A6_LAST_ERR:0:400}"
    a6_log "ERR	$day	attempt=$attempt	${err//$'\n'/ }"
    if [[ "$err" == *"404"* || "$err" == *"Not Found"* ]]; then
      break  # какого-то часа нет — переходим на почасовой режим
    fi
    sleep $((attempt * 20))
  done

  # Почасовой фоллбек: отсутствующие часы (404) пропускаем, остальные ретраим.
  a6_log "HOURLY	$day	falling back to per-hour loading"
  local h ok=1 hfrom hto
  for h in $(seq 0 23); do
    hfrom="$(printf '%s %02d:00:00' "$day" "$h")"
    if (( h == 23 )); then hto="$next_day 00:00:00"; else hto="$(printf '%s %02d:00:00' "$day" $((h+1)))"; fi
    for attempt in 1 2 3; do
      if a6_ch "$(a6_insert_sql "${day}-${h}" "$hfrom" "$hto")" "$A6_INS_PARAMS" >/dev/null; then
        break
      fi
      err="${A6_LAST_ERR:0:200}"
      if [[ "$err" == *"404"* || "$err" == *"Not Found"* ]]; then
        a6_log "MISSING	${day}-${h}	404 from gharchive, skipped"
        break
      fi
      a6_log "ERR	${day}-${h}	attempt=$attempt	${err//$'\n'/ }"
      if (( attempt == 3 )); then ok=0; else sleep $((attempt * 15)); fi
    done
  done
  if (( ok )); then
    elapsed=$((SECONDS - t0))
    rows="$(a6_ch "SELECT count() FROM ${A6_TARGET} WHERE created_at >= '$day' AND created_at < '$next_day' AND ${A6_LOCAL_PRED}")" || rows=-1
    a6_mark_day_done "$day" "$rows" "$elapsed"
    a6_log "LOADED	$day	rows=$rows	elapsed=${elapsed}s (hourly)"
    rm -rf "$lockdir"
    return 0
  fi
  a6_log "FAILED	$day	will retry on next pass/restart"
  rm -rf "$lockdir"
  return 1
}

# --- main ---------------------------------------------------------------------
a6_log "CONFIG	range=[$A6_FROM..$A6_TO) newest-first, target=$A6_TARGET, state=$A6_STATE"

a6_ch "CREATE TABLE IF NOT EXISTS ${A6_STATE}
       (day Date, rows UInt64, elapsed_s UInt32, loaded_at DateTime DEFAULT now())
       ENGINE = MergeTree ORDER BY day" >/dev/null \
  || { a6_log "FATAL	cannot create ${A6_STATE}: ${A6_LAST_ERR:0:300}"; exit 1; }

# прогреть кэш загруженных дней
a6_ch "SELECT DISTINCT day FROM ${A6_STATE} ORDER BY day" > "$A6_DAYS_CACHE.tmp" \
  && mv "$A6_DAYS_CACHE.tmp" "$A6_DAYS_CACHE"

days="$(python3 - "$A6_FROM" "$A6_TO" <<'PY'
import sys
from datetime import date, timedelta
frm, to = (date.fromisoformat(a) for a in sys.argv[1:3])
d = to - timedelta(days=1)          # новейшие -> старейшие
while d >= frm:
    print(d)
    d -= timedelta(days=1)
PY
)"

fails=0; loaded=0; cur_month=""
for day in $days; do
  m="${day:0:7}"
  if [[ "$m" != "$cur_month" ]]; then cur_month="$m"; a6_log "MONTH	$m"; fi
  if a6_load_day "$day"; then
    fails=0; loaded=$((loaded + 1))
  else
    fails=$((fails + 1))
    if (( fails >= 5 )); then
      a6_log "ABORT	5 consecutive day failures — check connectivity/quota, then restart"
      exit 1
    fi
  fi
done
a6_log "COMPLETE	range [$A6_FROM..$A6_TO) processed (this pass loaded $loaded days)"
