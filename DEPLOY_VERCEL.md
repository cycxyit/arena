# Deploy to Vercel with Turso

This app supports two storage modes:

- Local development: Python script + local SQLite at `data/arena.db`
- Vercel deployment: pure Next.js/TypeScript + Turso remote SQLite

Vercel does not run the Python store path. Set `TURSO_DATABASE_URL` in Vercel to enable the Turso store.

## 1. Create Turso database

Install/login with Turso, then create a database and token:

```bash
turso db create alpha-arena
turso db show alpha-arena
turso db tokens create alpha-arena
```

Copy the database URL and token into Vercel environment variables.

## 2. Vercel environment variables

Required:

```bash
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
ALPHAVANTAGE_API_KEYS=key1,key2,key3
RUN_SECRET=make-a-long-random-secret
LLM_TIMEOUT_SECONDS=20
```

Optional LLM seats:

```bash
OPENAI_API_KEY=
OPENROUTER_API_KEY=
GEMINI_API_KEY=
SILICONFLOW_API_KEY=
NEXT_PUBLIC_SITE_URL=https://your-project.vercel.app
```

## 3. Deploy

```bash
vercel
```

The first request creates the Turso table automatically.

## 4. Auto sync

This repository intentionally does not include `vercel.json` cron config, because some Vercel projects reject cron settings during config validation.

The app still exposes this endpoint:

```text
GET /api/run?secret=YOUR_RUN_SECRET
```

Set `RUN_SECRET` in Vercel first. When it is set, `/api/run` rejects requests that do not include the matching `secret` query parameter or `x-run-secret` header.

Use GitHub Actions or any external scheduler to call it every 30 minutes. For cron-job.org, EasyCron, or UptimeRobot, schedule this URL:

```text
https://your-project.vercel.app/api/run?secret=YOUR_RUN_SECRET
```

For GitHub Actions, create a scheduled workflow manually after generating a token with `workflow` scope, or use any external scheduler that supports GET requests.

