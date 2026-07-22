# Insight Desk

Чат-агент над ClickHouse с интерактивными карточками-расследованиями — dataset-agnostic:
на каждый вопрос сам находит нужные таблицы в живом каталоге ClickHouse (сейчас на
инстансе — `github.github_events` и полная TPC-DS), триажит вопрос на быстрой модели,
рисует скелет дашборда мгновенно и достраивает карточки SQL параллельно. Если данных не
хватает или вопрос неоднозначен — честно просит уточнить, а не выдумывает ответ.
Хакатон «Beyond the Wall of Text» · ClickHouse + Trigger.dev. План и декомпозиция — [PLAN.md](./PLAN.md).

## Dev & Deploy

### Требования

- Node.js 18+ (проверено на 22)
- Аккаунты: [ClickHouse Cloud](https://clickhouse.cloud), [Trigger.dev cloud](https://cloud.trigger.dev), [Vercel](https://vercel.com)

### Локальный запуск

1. Установить зависимости:

   ```bash
   npm install
   ```

2. Создать `.env` из шаблона и заполнить (см. комментарии в файле):

   ```bash
   cp .env.example .env
   ```

3. Проверить подключение к ClickHouse (SELECT 1 под read-only юзером `agent_ro`):

   ```bash
   npm run ch:ping
   ```

4. Запустить Next.js:

   ```bash
   npm run dev        # http://localhost:3000
   ```

5. Во втором терминале — dev-сервер Trigger.dev (спросит логин при первом запуске):

   ```bash
   npx trigger.dev@latest dev
   ```

   Таски из `src/trigger/` появятся в дашборде. Проверка связки: таб **Test** →
   таска `hello` → payload `{"name": "ClickHouse"}`.

Project ref захардкожен в `trigger.config.ts` (канон Trigger.dev); `TRIGGER_SECRET_KEY`
подхватывается из `.env` и в конфиг не пишется. Свой проект — замените `project` в
`trigger.config.ts` (дашборд → Project settings → Project ref).

### Google OAuth (вход на фронтенд)

Весь интерфейс и API (кроме `/login` и `/api/auth/*`) закрыты входом через Google
(NextAuth v5, JWT-сессии — базы не нужно). Настройка:

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) →
   APIs & Services → Credentials → **Create credentials → OAuth client ID** →
   тип **Web application** (если спросит — сначала настроить Consent screen:
   тип External, добавить себя в Test users, пока приложение не опубликовано).
2. **Authorized redirect URIs**: `http://localhost:3000/api/auth/callback/google`
   и `https://<прод-домен>/api/auth/callback/google`.
3. В `.env`: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` из созданного клиента,
   `AUTH_SECRET` — `openssl rand -base64 32`.
4. `AUTH_ALLOWED_EMAILS` — необязательный allowlist через запятую; пустой —
   вход любому Google-аккаунту (режим для жюри: ссылка публичная, но
   анонимного доступа к агенту нет).

На Vercel переменные заливает `npm run vercel:env` (шаг деплоя ниже).

### Деплой (выполняется вручную, не из CI)

**Trigger.dev cloud** — деплой тасок:

```bash
npx trigger.dev@latest login     # один раз
npm run deploy:trigger           # собирает и заливает src/trigger/ в prod
```

Переменные окружения в дашборде задавать не нужно: расширение `syncEnvVars`
(`trigger.config.ts`) при каждом деплое переливает прикладные переменные
(ClickHouse + LLM) из локального `.env` в prod-окружение Trigger.dev.

**Vercel** — деплой Next.js:

```bash
npx vercel login                 # один раз
npx vercel link                  # привязать директорию к проекту (один раз)
TRIGGER_SECRET_KEY_PROD=tr_prod_… npm run vercel:env   # залить env из .env в production
npx vercel deploy --prod
```

`vercel:env` (scripts/vercel-env-push.sh) заливает переменные ClickHouse + LLM +
Auth (Google OAuth) из `.env`; `TRIGGER_SECRET_KEY_PROD` — **prod**-ключ Trigger.dev
(`tr_prod_…`, дашборд → API Keys), передаётся отдельно, чтобы dev-ключ из `.env`
не попал в прод. Не забудьте прод-домен в Authorized redirect URIs OAuth-клиента
(раздел «Google OAuth» выше).

После деплоя проверить публичную ссылку со свежего устройства (задача J4).

### Структура

```
src/app/            # Next.js App Router: страница рабочего места (лента + композер), /login, API-роуты /api/ask, /api/suggest, /api/auth/*
src/auth.ts         # NextAuth v5: Google OAuth, JWT-сессии, allowlist; гейт на всё приложение — src/proxy.ts
src/trigger/        # Таски Trigger.dev v4: hello — смоук; investigate — конвейер; investigate-card — дочерний ран одной карточки; explore-schema — разведка вручную
src/lib/agent/      # Конвейер investigate v2: explore (каталог+разведка) → triage (быстрая модель, env LLM_MODEL_FAST) → generate-sql (LLM_MODEL)
src/lib/clickhouse.ts   # Фабрики клиентов: readonly (agent_ro) и scratch (agent_scratch)
src/lib/contracts/  # Zod-контракты ViewSpec/ClickContext/RunStep — замораживаются на J1
scripts/ch-ping.ts  # Смоук ClickHouse: npm run ch:ping
db/                 # Провижининг ClickHouse (трек A)
trigger.config.ts   # Конфиг Trigger.dev (project ref, retries, maxDuration)
```
