#!/usr/bin/env bash
# Заливка прикладных переменных окружения в Vercel (production) из локального .env.
# Требования: авторизованный CLI (npx vercel login) и привязанный проект (npx vercel link).
#
# TRIGGER_SECRET_KEY — отдельный случай: в .env лежит DEV-ключ (tr_dev_…), а на
# Vercel нужен PROD-ключ (tr_prod_…, дашборд Trigger.dev → API Keys). Поэтому он
# передаётся явно, чтобы dev-ключ не утёк в прод:
#   TRIGGER_SECRET_KEY_PROD=tr_prod_… scripts/vercel-env-push.sh
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "нет .env — скопируйте .env.example и заполните" >&2; exit 1; }

# Значение из .env «как есть»: без source, чтобы спецсимволы в паролях
# не интерпретировались шеллом. Берём последнее вхождение.
env_get() {
  local line
  line=$(grep -E "^$1=" .env | tail -1 || true)
  printf '%s' "${line#*=}"
}

# push NAME VALUE — переписывает переменную в production-окружении Vercel.
push() {
  local name="$1" value="$2"
  if [[ -z "$value" ]]; then
    echo "· $name: пусто в .env — пропуск"
    return
  fi
  npx vercel env rm "$name" production --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | npx vercel env add "$name" production >/dev/null
  echo "· $name: задано"
}

# Группы из src/lib/config.ts: ClickHouse (агентские юзеры) + LLM.
for name in CLICKHOUSE_URL AGENT_RO_USER AGENT_RO_PASSWORD \
            AGENT_SCRATCH_USER AGENT_SCRATCH_PASSWORD \
            OPENROUTER_API_KEY LLM_MODEL LLM_MODEL_FAST; do
  push "$name" "$(env_get "$name")"
done

if [[ -n "${TRIGGER_SECRET_KEY_PROD:-}" ]]; then
  push TRIGGER_SECRET_KEY "$TRIGGER_SECRET_KEY_PROD"
else
  echo "! TRIGGER_SECRET_KEY не задан. Возьмите tr_prod_… (дашборд Trigger.dev → API Keys)"
  echo "  и повторите: TRIGGER_SECRET_KEY_PROD=tr_prod_… scripts/vercel-env-push.sh"
fi
