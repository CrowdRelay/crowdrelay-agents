# CrowdRelay Agents

TypeScript agent service that runs LLM worker tasks. The brain is the Rust
autopilot (deterministic). This service is the worker execution layer — LLMs
are tools/slaves that gather intelligence and draft content. They do NOT
decide strategy. The brain dispatches workers; workers feed intelligence back.

## North Star (read before any work)

**Grow real fans for the tenant (Virya is the first tenant).**

1. **Aggregate** fans from all sides of the internet — Reddit, Meta, Spotify,
   Bandsintown, forums, press, live shows — into the fanbase and Signal.
2. **Grow** them for real: genuine engagement, not spam.
3. **Convert** using fan 360 mechanisms: tickets, merch, attendance.

Every agent template, every task, every outcome must trace back to this goal.
Full plan: `/Users/wojciechbator/dev/AGENT_GROWTH_PLAN.md`

## Architecture: brain vs workers

- **Brain (Rust, deterministic):** the autopilot evaluator. Owns the growth
  strategy. Decides what intelligence to gather, when, and what to do with it.
  Dispatches LLM workers via `RequestAgentRun` actions. Never polluted by LLM
  output — it applies deterministic validation before acting.
- **Workers (this service, LLMs):** run templates that gather intelligence and
  draft content. They are tools, slaves, data-feeders. They do NOT decide
  strategy. They do NOT dispatch each other. They just run and emit outcomes.

## Stack
TypeScript, Fastify, node-postgres. Shares CrowdRelay Postgres.
Tables: `agent_service_*` (own migrations) + `agent_outcomes` (CrowdRelay migration 0125).

## Layout
```
src/agent/      runner.ts (main loop), context.ts, structured.ts, verify.ts, outcomes.ts, workflow.ts
src/templates/  catalog.ts (AgentTemplate interface), 9 templates (workers)
src/mcp/        tools.ts (16 read-only Postgres tools)
src/providers/  registry.ts (LLM providers)
src/routes/     tasks, templates, schedules, credentials, health, chat, workflows
src/store/      db.ts, tasks.ts, credentials.ts, workflows.ts
src/config.ts   env config
src/server.ts   main + scheduler ticker
```

## Gates
```
npx tsc --noEmit     # typecheck
npm test             # node:test on tests/*.test.ts
npm run build        # tsc → dist/
```

## Key patterns
- Templates declare `dataScope` (MCP tools to fetch) + `outputKind` (structured outcome).
- Runner: buildContext → model fallback chain → verification gate → emit outcomes.
- All writes go through `agent_outcomes`; the Rust worker owns autopilot mapping.
- Free models (Zen, Gemini Flash, Groq) are the default for workers.
- The `growth-strategist` template is NOT the brain — it's a worker that feeds
  intelligence via `campaign_insight` outcomes. The brain is the Rust autopilot.
