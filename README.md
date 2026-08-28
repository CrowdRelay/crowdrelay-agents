# CrowdRelay Agents

**Free + paid LLM agent service and Reddit authenticated scraper, seeded with real tenant data.**

Node.js + TypeScript + Fastify service that does two things:

1. **LLM worker execution** — integrates free and paid LLM providers (OpenCode Zen,
   OpenAI, Anthropic, Google Gemini, Groq, OpenRouter) to generate press pitches,
   social posts, community engagement drafts, growth strategy analysis, Reddit
   subreddit scans, Signal invite drafts, and campaign analysis for music industry
   tenants. Each task pulls live data from the CrowdRelay Postgres database via
   MCP-style tools, so the LLM writes about real events, real fan counts, and real
   outreach targets.

2. **Reddit authenticated scraping** — launches a headless Chromium browser via
   Playwright, logs into Reddit via Google OAuth, extracts session cookies, and
   serves them to the Rust worker for authenticated JSON API access. This bypasses
   Reddit's JavaScript bot-detection challenge that blocks all unauthenticated
   `.json` endpoint access.

## Features

### LLM Provider Integration
- **6 providers**: OpenCode Zen (free, no key), OpenAI, Anthropic (Claude),
  Google Gemini (OAuth or API key), Groq (free tier), OpenRouter (all models via one key)
- **Paste + validate**: API keys are validated with a test API call before storing
- **Google OAuth**: Real OAuth flow with CSRF state tokens and refresh token storage
- **Encrypted vault**: AES-256-GCM encryption for all stored credentials
- **Per-tenant credentials**: Each workspace connects its own providers; keys are
  never shared across tenants and never sent back to the frontend
- **Dynamic model availability**: The model selector only shows models the tenant
  can actually use — free models always available, paid models require a connected provider

### Task Execution
- **8 templates**: growth-strategist, reddit-scanner, community-engager,
  signal-inviter, press-pitch, social-post, campaign-analysis, audience-research
- **MCP-style data tools**: `list_events`, `list_outreach_targets`, `fan_stats` —
  read-only, tenant-scoped Postgres queries that seed the LLM prompt with real data
- **Model fallback chain**: If the requested model fails, the runner tries free-tier
  models, then other connected providers
- **Anthropic-native client**: Claude uses its own API format (not OpenAI-compatible)
- **Async task queue**: Tasks run in the background; status is polled by the UI

### Task Suggestions
- **Data-driven prompts**: The service analyzes tenant data (upcoming events, recent
  events, fan growth, outreach target count, active campaigns) and generates actionable
  suggestions — "Event in 7 days, write a press pitch" or "Only 5 outreach targets,
  research more"
- **Priority-sorted**: High priority for urgent windows (event in <7 days), medium for
  upcoming, low for growth opportunities
- **One-click run**: Click a suggestion to pre-fill the template, model, and prompt

### Security
- **HMAC-SHA256 auth**: Matches the control plane's `derived_management_token` scheme
- **AES-256-GCM encryption**: Credential vault uses authenticated encryption
- **Read-only MCP tools**: Tenant data tools only query — never mutate
- **Workspace-scoped**: All credentials, tasks, and results are scoped to `workspace_id`

### Reddit Authenticated Scraping
- **Playwright + Chromium**: Headless browser logs into Reddit via Google OAuth
- **Session cookie extraction**: Cookies stored in `agent_service_reddit_cookies`
  with a 7-day expiry; auto-refreshed by a background ticker every 6 hours
- **Cookie serving**: The Rust worker fetches cookies via `GET /reddit/cookies`
  and uses them with reqwest for authenticated JSON API calls
- **Bypasses JS challenge**: Reddit blocks all unauthenticated `.json` endpoints
  with a JavaScript bot-detection challenge; authenticated cookies from a real
  browser session bypass this completely

## Architecture

```
Control Plane (Rust)                    Agent Service (Node.js)
┌─────────────────────┐                ┌──────────────────────────┐
│  AgentPanel.tsx     │                │  Fastify server :8095    │
│  (SolidJS)          │                │                          │
│                     │  HMAC proxy    │  /providers              │
│  /tenants/:slug/    │ ──────────→    │  /credentials (CRUD)     │
│  agents/*           │                │  /oauth/google/*         │
│                     │                │  /models                 │
│                     │                │  /suggestions            │
│                     │                │  /templates              │
│                     │                │  /tasks (async)          │
│                     │                │  /health                 │
└─────────────────────┘                │                          │
                                       │  Credential vault        │
                                       │  (AES-256-GCM, Postgres) │
                                       │                          │
                                       │  MCP tools (read-only)   │
                                       │  → list_events           │
                                       │  → list_outreach_targets │
                                       │  → fan_stats             │
                                       │                          │
                                       │  LLM clients             │
                                       │  → OpenAI-compatible     │
                                       │  → Anthropic-native      │
                                       └──────────────────────────┘
                                                  │
                                                  ▼
                                       ┌──────────────────────────┐
                                       │  LLM Providers           │
                                       │  OpenCode Zen (free)     │
                                       │  OpenAI (GPT-4o, o1)     │
                                       │  Anthropic (Claude 3.5)  │
                                       │  Google (Gemini 2.0)     │
                                       │  Groq (Llama 3.3, free)  │
                                       │  OpenRouter (200+ models)│
                                       └──────────────────────────┘
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env
cp .env.example .env

# 3. Generate an encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# → set as AGENT_SERVICE_ENCRYPTION_KEY in .env

# 4. Set DATABASE_URL to the CrowdRelay Postgres
# 5. Set AGENT_SERVICE_AUTH_KEY to match CONTROL_PLANE_MANAGEMENT_MASTER_KEY

# 6. Run
npm run dev
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | CrowdRelay Postgres connection string |
| `AGENT_SERVICE_AUTH_KEY` | Yes | HMAC master key — must match control plane |
| `AGENT_SERVICE_ENCRYPTION_KEY` | Yes | 64-char hex key for credential encryption |
| `AGENT_SERVICE_BIND` | No | Bind address (default `0.0.0.0:8095`) |
| `OPENCODE_ZEN_TOKEN` | No | Zen API token (free tier works without) |
| `GOOGLE_API_KEY` | No | Platform-level Google fallback key |
| `GROQ_API_KEY` | No | Platform-level Groq fallback key |
| `GOOGLE_OAUTH_CLIENT_ID` | No | Enables Google OAuth flow |
| `GOOGLE_OAUTH_CLIENT_SECRET` | No | Enables Google OAuth flow |
| `GOOGLE_OAUTH_REDIRECT_URI` | No | OAuth callback URL |

## API Endpoints

### Providers & Credentials
- `GET /providers` — List available LLM providers
- `GET /credentials` — List connected credentials (no keys returned)
- `POST /credentials` — Paste + validate an API key
- `DELETE /credentials/:provider` — Disconnect a provider
- `POST /credentials/:provider/validate` — Re-validate a stored credential
- `GET /models` — List models available to this tenant (free + connected)

### OAuth
- `GET /oauth/google/start` — Start Google OAuth flow (returns redirect URL)
- `GET /oauth/google/callback` — Handle OAuth callback

### Templates & Tasks
- `GET /templates` — List available templates
- `GET /templates/:id` — Get template details
- `GET /suggestions` — Data-driven task suggestions
- `GET /tasks` — List tasks
- `POST /tasks` — Create + start a task
- `GET /tasks/:id` — Get task status
- `GET /tasks/:id/result` — Get task result

### Health
- `GET /health` — Service health
- `GET /health/providers` — Provider connectivity status

## Database Tables

All tables are prefixed with `agent_service_` and stored in the shared CrowdRelay Postgres:

- `agent_service_tasks` — Task queue (template, model, prompt, status)
- `agent_service_task_results` — Completed task outputs
- `agent_service_credentials` — Encrypted provider credentials (per workspace)
- `agent_service_provider_health` — Provider connectivity monitoring
- `agent_service_reddit_cookies` — Reddit session cookies (per workspace, 7-day expiry)
- `agent_service_discovered_models` — Free-tier models discovered from OpenRouter/Zen catalogs
- `agent_service_schedules` — Scheduled agent runs (minutes granularity)
- `agent_service_workflows` — Brain-dispatched growth plans with sub-tasks
- `agent_service_usage` — Per-workspace, per-model daily usage ledger
- `agent_service_budgets` — Per-workspace monthly spend ceiling

## Docker

```bash
docker build -t crowdrelay-agents .
docker run -p 8095:8095 \
  -e DATABASE_URL=... \
  -e AGENT_SERVICE_AUTH_KEY=... \
  -e AGENT_SERVICE_ENCRYPTION_KEY=... \
  crowdrelay-agents
```

## License

See CrowdRelay ecosystem license.
