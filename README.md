# CrowdRelay Agents

**LLM worker service that gathers intelligence and drafts content, seeded with real tenant data.**

The brain is the deterministic Autopilot in CrowdRelay. This service is the worker execution layer — LLMs are tools that gather intelligence and draft content. They do not decide strategy. They do not dispatch each other. They run, emit outcomes, and the brain decides what to do with them.

## What it does

Every task pulls live data from the CrowdRelay database — real event dates, real fan counts, real outreach targets — so the LLM writes about the actual situation, not a template. The service does two things:

1. **LLM worker execution** — runs agent templates that produce press pitches, social posts, community engagement drafts, growth strategy analysis, Reddit subreddit scans, Signal invite drafts, and campaign analysis. Each task is scoped to a single workspace.

2. **Reddit authenticated scraping** — launches a headless browser, logs into Reddit via Google OAuth, extracts session cookies, and serves them to the CrowdRelay worker for authenticated API access. This bypasses Reddit's JavaScript bot-detection that blocks all unauthenticated access.

## What it solves

LLMs are useful for drafting creative work, but they're useless without context. Generic prompts produce generic output. CrowdRelay Agents solves this by seeding every task with real tenant data from the database — the LLM writes about the actual event, the actual fan count, the actual outreach target. The brain stays deterministic; the LLMs do the creative heavy lifting.

## How it works

- **Templates** declare what data to fetch and what kind of output to produce
- **Runner** builds context from the database, runs the model with a fallback chain (if the requested model fails, it cascades to free-tier models, then other connected providers)
- **Verification gate** checks output before accepting it
- **Outcomes** are written back to the CrowdRelay database for the brain to consume

## Providers

Six LLM providers: OpenCode Zen (free, no key), OpenAI, Anthropic (Claude), Google Gemini, Groq, OpenRouter. Each workspace connects its own providers. API keys are encrypted at rest and never sent back to the frontend. Google OAuth is supported for providers that need it.

## Ecosystem

Part of the [CrowdRelay](https://github.com/CrowdRelay) platform. The control plane proxies requests to this service via HMAC-signed tokens. See the [organization README](https://github.com/CrowdRelay/.github) for the full picture.
