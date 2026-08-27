# crowdrelay-agents

Free LLM agent service for CrowdRelay tenants. Delegates creative tasks
(press pitches, social posts, research, analysis) to free-tier LLMs via
OpenCode Zen, Google Gemini, and Groq.

## Architecture

```
Control Plane (Rust) → proxy → Agent Service (Node.js) → LLM APIs
                                         ↓
                                   MCP tools (read-only Postgres)
```

The agent service exposes tenant-scoped read-only MCP tools that pull data
from the crowdrelay Postgres. The LLM calls these tools during a session to
seed its prompt with real tenant data (events, fans, outreach targets).

## Quick start

```bash
cp .env.example .env
# edit .env with your DATABASE_URL and AGENT_SERVICE_AUTH_KEY
npm install
npm run dev
```

## API

```
POST   /tasks              Create and run an agent task
GET    /tasks              List tasks
GET    /tasks/:id          Get task status
GET    /tasks/:id/result   Get task result
GET    /templates          List agent templates
GET    /templates/:id      Get template details
GET    /health             Service health
GET    /health/providers   Provider health + quota status
```

All task/template routes require:
- `Authorization: Bearer <hmac>` (derived from management master key)
- `X-Workspace-Id: <uuid>` (tenant scope)

## Templates

| Template | Category | Description |
|----------|----------|-------------|
| press-pitch | content | Write press pitches for events targeting media outlets |
| social-post | content | Create social media posts from show/event data |

## Free models

| Model | Provider | Free limit | Context |
|-------|----------|-----------|---------|
| zen-default | OpenCode Zen | 100 req/day | 128K |
| zen-fast | OpenCode Zen | 100 req/day | 32K |
| deepseek-v4-flash-free | OpenCode Zen | 100 req/day | 200K |
| gemini-2.5-flash | Google | 250 req/day | 1M |
| groq/llama-3.3-70b | Groq | 14K req/day | 128K |
