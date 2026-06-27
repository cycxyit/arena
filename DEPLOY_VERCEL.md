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

`vercel.json` uses a Hobby-safe daily cron by default:

```json
{ "path": "/api/run", "schedule": "0 0 * * *" }
```

Vercel Hobby only supports once-per-day Cron Jobs. For true 30-minute sync, use one of these:

1. Upgrade the Vercel project to Pro, then change `vercel.json` to:

```json
{ "path": "/api/run", "schedule": "0,30 * * * *" }
```

2. Keep Vercel Hobby and use an external scheduler, such as GitHub Actions, EasyCron, cron-job.org, or UptimeRobot, to send a GET request to:

```text
https://your-project.vercel.app/api/run
```
