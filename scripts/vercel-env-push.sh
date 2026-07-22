#!/usr/bin/env bash
# Заливка прикладных переменных окружения в Vercel (production) из локального .env.
# Требования: авторизованный CLI (npx vercel login) и привязанный проект (npx vercel link).
#
# TRIGGER_SECRET_KEY — отдельный случай: в TRIGGER_SECRET_KEY в .env лежит
# DEV-ключ (tr_dev_…), а на Vercel нужен PROD-ключ (tr_prod_…, дашборд
# Trigger.dev → API Keys). Поэтому prod-ключ живёт под своим именем
# TRIGGER_SECRET_KEY_PROD — строкой в .env либо переменной окружения запуска
# (окружение приоритетнее). Значение не с префиксом tr_prod_ отбрасывается:
# dev-ключ в прод не утечёт.
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

# Группы из src/lib/config.ts: ClickHouse (агентские юзеры) + LLM + Auth
# (Google OAuth: AUTH_ALLOWED_EMAILS пустой — пропуск, вход любому аккаунту).
for name in CLICKHOUSE_URL AGENT_RO_USER AGENT_RO_PASSWORD \
            AGENT_SCRATCH_USER AGENT_SCRATCH_PASSWORD \
            OPENROUTER_API_KEY LLM_MODEL LLM_MODEL_FAST \
            AUTH_SECRET AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET AUTH_ALLOWED_EMAILS; do
  push "$name" "$(env_get "$name")"
done

secret_prod="${TRIGGER_SECRET_KEY_PROD:-$(env_get TRIGGER_SECRET_KEY_PROD)}"
if [[ -z "$secret_prod" ]]; then
  echo "! TRIGGER_SECRET_KEY не залит. Возьмите tr_prod_… (дашборд Trigger.dev → API Keys),"
  echo "  добавьте в .env строку TRIGGER_SECRET_KEY_PROD=tr_prod_… и повторите запуск"
elif [[ "$secret_prod" != tr_prod_* ]]; then
  echo "! TRIGGER_SECRET_KEY_PROD не похож на prod-ключ (ожидается tr_prod_…) — пропуск,"
  echo "  чтобы dev-ключ не попал в прод"
else
  push TRIGGER_SECRET_KEY "$secret_prod"
fi
