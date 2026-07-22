# Insight Desk

A chat agent over ClickHouse with interactive investigation cards — dataset-agnostic:
for every question it finds the relevant tables itself in the live ClickHouse catalog
(currently on the instance — `github.github_events` and the full TPC-DS), triages the
question on a fast model, draws the dashboard skeleton instantly and fills in the cards
with SQL in parallel. If the data is insufficient or the question is ambiguous, it
honestly asks for clarification rather than making up an answer.
"Beyond the Wall of Text" hackathon · ClickHouse + Trigger.dev. Plan and breakdown — [PLAN.md](./PLAN.md).

## Dev & Deploy

### Requirements

- Node.js 18+ (tested on 22)
- Accounts: [ClickHouse Cloud](https://clickhouse.cloud), [Trigger.dev cloud](https://cloud.trigger.dev), [Vercel](https://vercel.com)

### Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` from the template and fill it in (see the comments in the file):

   ```bash
   cp .env.example .env
   ```

3. Check the ClickHouse connection (SELECT 1 under the read-only user `agent_ro`):

   ```bash
   npm run ch:ping
   ```

4. Start Next.js:

   ```bash
   npm run dev        # http://localhost:3000
   ```

5. In a second terminal — the Trigger.dev dev server (it will ask you to log in on first run):

   ```bash
   npx trigger.dev@latest dev
   ```

   Tasks from `src/trigger/` will appear in the dashboard. Sanity check: **Test** tab →
   the `hello` task → payload `{"name": "ClickHouse"}`.

The project ref is hardcoded in `trigger.config.ts` (Trigger.dev convention); `TRIGGER_SECRET_KEY`
is picked up from `.env` and is not written into the config. For your own project — replace `project` in
`trigger.config.ts` (dashboard → Project settings → Project ref).

### Google OAuth (frontend login)

The entire interface and API (except `/login` and `/api/auth/*`) are gated behind Google
sign-in (NextAuth v5, JWT sessions — no database needed). Setup:

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) →
   APIs & Services → Credentials → **Create credentials → OAuth client ID** →
   type **Web application** (if prompted — first configure the Consent screen:
   type External, add yourself to Test users while the app is unpublished).
2. **Authorized redirect URIs**: `http://localhost:3000/api/auth/callback/google`
   and `https://<prod-domain>/api/auth/callback/google`.
3. In `.env`: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` from the created client,
   `AUTH_SECRET` — `openssl rand -base64 32`.
4. `AUTH_ALLOWED_EMAILS` — an optional comma-separated allowlist; empty means
   any Google account can sign in (judge mode: the link is public, but there's
   no anonymous access to the agent).

On Vercel the variables are uploaded by `npm run vercel:env` (deploy step below).

### Deploy (done manually, not from CI)

**Trigger.dev cloud** — deploying tasks:

```bash
npx trigger.dev@latest login     # once
npm run deploy:trigger           # builds and uploads src/trigger/ to prod
```

There's no need to set environment variables in the dashboard: the `syncEnvVars`
extension (`trigger.config.ts`) re-syncs the application variables
(ClickHouse + LLM) from the local `.env` into the Trigger.dev prod environment on every deploy.

**Vercel** — deploying Next.js:

```bash
npx vercel login                 # once
npx vercel link                  # link the directory to the project (once)
npm run vercel:env               # upload env from .env to production
npx vercel deploy --prod
```

`vercel:env` (scripts/vercel-env-push.sh) uploads the ClickHouse + LLM + Auth
(Google OAuth) variables from `.env`, plus `TRIGGER_SECRET_KEY_PROD` — the **prod**
Trigger.dev key (`tr_prod_…`, dashboard → API Keys; see .env.example). The key lives
under its own name and is validated by prefix so the dev key from `TRIGGER_SECRET_KEY`
doesn't end up in prod. Don't forget the prod domain in the OAuth client's Authorized
redirect URIs (the "Google OAuth" section above).

After deploying, verify the public link from a fresh device (task J4).

### Structure

```
src/app/            # Next.js App Router: workspace page (feed + composer), /login, API routes /api/ask, /api/suggest, /api/auth/*
src/auth.ts         # NextAuth v5: Google OAuth, JWT sessions, allowlist; the gate over the whole app — src/proxy.ts
src/trigger/        # Trigger.dev v4 tasks: hello — smoke; investigate — pipeline; investigate-card — child run for a single card; explore-schema — manual reconnaissance
src/lib/agent/      # investigate v2 pipeline: explore (catalog + reconnaissance) → triage (fast model, env LLM_MODEL_FAST) → generate-sql (LLM_MODEL)
src/lib/clickhouse.ts   # Client factories: readonly (agent_ro) and scratch (agent_scratch)
src/lib/contracts/  # Zod contracts ViewSpec/ClickContext/RunStep — frozen at J1
scripts/ch-ping.ts  # ClickHouse smoke test: npm run ch:ping
db/                 # ClickHouse provisioning (track A)
trigger.config.ts   # Trigger.dev config (project ref, retries, maxDuration)
```
