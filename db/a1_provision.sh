#!/bin/bash
# A1: провижининг сущностей ClickHouse для Insight Desk.
# Читает креды администратора и пароли агентских юзеров из .env в корне репо.
# Идемпотентен: IF NOT EXISTS везде, безопасно перезапускать.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$REPO_ROOT/.env"; set +a

CH="https://$CLICKHOUSE_URL"
q() {
  local sql="$1"
  local out
  out=$(curl -sS --max-time 60 "$CH" -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --data-binary "$sql")
  if [ -n "$out" ]; then echo "$out"; fi
}

echo "== databases =="
q "CREATE DATABASE IF NOT EXISTS github"
q "CREATE DATABASE IF NOT EXISTS scratch"

echo "== users =="
q "CREATE USER IF NOT EXISTS agent_ro IDENTIFIED BY '$AGENT_RO_PASSWORD'"
q "CREATE USER IF NOT EXISTS agent_scratch IDENTIFIED BY '$AGENT_SCRATCH_PASSWORD'"
# CREATE IF NOT EXISTS не обновляет пароль существующего юзера — приводим к .env явно
q "ALTER USER agent_ro IDENTIFIED BY '$AGENT_RO_PASSWORD'"
q "ALTER USER agent_scratch IDENTIFIED BY '$AGENT_SCRATCH_PASSWORD'"

echo "== grants: agent_ro (только чтение) =="
q "GRANT SELECT ON github.* TO agent_ro"
q "GRANT SELECT ON scratch.* TO agent_ro"
q "GRANT SELECT ON default.* TO agent_ro"

echo "== grants: agent_scratch (workspace агента) =="
q "GRANT SELECT, INSERT, ALTER, CREATE TABLE, CREATE VIEW, DROP TABLE, DROP VIEW, TRUNCATE ON scratch.* TO agent_scratch"
q "GRANT SELECT ON github.* TO agent_scratch"
q "GRANT SELECT ON default.* TO agent_scratch"

echo "== settings profile: лимиты agent_ro =="
q "CREATE SETTINGS PROFILE IF NOT EXISTS agent_ro_profile SETTINGS readonly = 2 CONST, allow_ddl = 0 CONST, max_execution_time = 60, max_result_rows = 100000, max_memory_usage = 10000000000 TO agent_ro"

echo "== verify: grants =="
q "SHOW GRANTS FOR agent_ro"
echo "---"
q "SHOW GRANTS FOR agent_scratch"

echo "== verify: agent_ro не может писать (ожидаем ACCESS_DENIED) =="
curl -sS --max-time 30 "$CH" -u "agent_ro:$AGENT_RO_PASSWORD" \
  --data-binary "CREATE TABLE scratch.should_fail (x UInt8) ENGINE = MergeTree ORDER BY x" || true

echo "== verify: agent_scratch создаёт таблицу с TTL =="
curl -sS --max-time 30 "$CH" -u "agent_scratch:$AGENT_SCRATCH_PASSWORD" \
  --data-binary "CREATE TABLE IF NOT EXISTS scratch.ttl_smoke (d DateTime, x UInt8) ENGINE = MergeTree ORDER BY d TTL d + INTERVAL 1 DAY"
curl -sS --max-time 30 "$CH" -u "agent_scratch:$AGENT_SCRATCH_PASSWORD" \
  --data-binary "INSERT INTO scratch.ttl_smoke VALUES (now(), 1)"
curl -sS --max-time 30 "$CH" -u "agent_scratch:$AGENT_SCRATCH_PASSWORD" \
  --data-binary "SELECT 'ttl_smoke rows:', count() FROM scratch.ttl_smoke"
curl -sS --max-time 30 "$CH" -u "agent_scratch:$AGENT_SCRATCH_PASSWORD" \
  --data-binary "DROP TABLE scratch.ttl_smoke"

echo "== A1 done =="
