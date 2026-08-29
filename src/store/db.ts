import pg from "pg";

const { Pool } = pg;

export type DbPool = pg.Pool;

export function createPool(databaseUrl: string): DbPool {
  return new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.AGENT_DB_POOL_MAX) || 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/**
 * Runs migrations for the agent service's own tables.
 * These live in the crowdrelay Postgres but under agent_service_* prefix.
 * Idempotent — safe to run on every startup.
 */
export async function runMigrations(pool: DbPool): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS agent_service_tasks (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id    UUID NOT NULL,
      template_id     TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'queued',
      error           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at      TIMESTAMPTZ,
      completed_at    TIMESTAMPTZ,
      metadata        JSONB NOT NULL DEFAULT '{}'
    )`,
    `CREATE INDEX IF NOT EXISTS agent_service_tasks_workspace_idx
      ON agent_service_tasks (workspace_id, created_at DESC)`,
    // Add instance_id column for scoped stale-task recovery. Each instance
    // stamps its tasks on creation; on restart it only recovers its own
    // running/queued tasks, not those owned by other live instances.
    `ALTER TABLE agent_service_tasks ADD COLUMN IF NOT EXISTS instance_id TEXT`,
    `CREATE INDEX IF NOT EXISTS agent_service_tasks_instance_idx
      ON agent_service_tasks (instance_id) WHERE status IN ('running', 'queued')`,
    // Sprint 6: intelligent token optimization — tier classification so the
    // runner can route basic tasks to free models and premium tasks to
    // connected paid providers. cost_micro_usd tracks per-task spend.
    `ALTER TABLE agent_service_tasks ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'basic' CHECK (tier IN ('basic', 'premium'))`,
    `ALTER TABLE agent_service_tasks ADD COLUMN IF NOT EXISTS cost_micro_usd BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE agent_service_tasks ADD COLUMN IF NOT EXISTS model_provider TEXT`,
    `CREATE INDEX IF NOT EXISTS agent_service_tasks_tier_idx
      ON agent_service_tasks (workspace_id, tier, created_at DESC) WHERE tier = 'premium'`,
    `CREATE TABLE IF NOT EXISTS agent_service_results (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id         UUID NOT NULL REFERENCES agent_service_tasks(id) ON DELETE CASCADE,
      workspace_id    UUID NOT NULL,
      content         TEXT NOT NULL,
      format          TEXT NOT NULL DEFAULT 'text',
      model_used      TEXT NOT NULL,
      tokens_in       INTEGER,
      tokens_out      INTEGER,
      duration_ms     INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS agent_service_results_task_idx
      ON agent_service_results (task_id)`,
    `CREATE INDEX IF NOT EXISTS agent_service_results_workspace_idx
      ON agent_service_results (workspace_id)`,
    // Parsed structured outcome (envelope JSON) when the template declared an
    // outputKind and the model output validated; NULL for free-form results.
    `ALTER TABLE agent_service_results ADD COLUMN IF NOT EXISTS structured JSONB`,
    `ALTER TABLE agent_service_results ADD COLUMN IF NOT EXISTS schema_version INT`,
    `CREATE TABLE IF NOT EXISTS agent_service_provider_health (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider        TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'unknown',
      requests_remaining INTEGER,
      last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_error      TEXT,
      latency_ms      INTEGER,
      UNIQUE (provider, model_id)
    )`,
    `CREATE TABLE IF NOT EXISTS agent_service_credentials (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id          UUID NOT NULL,
      provider              TEXT NOT NULL,
      label                 TEXT NOT NULL DEFAULT '',
      credential_type       TEXT NOT NULL,
      encrypted_value       TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'active',
      last_validated_at     TIMESTAMPTZ,
      last_validation_error TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, provider)
    )`,
    `CREATE INDEX IF NOT EXISTS agent_service_credentials_workspace_idx
      ON agent_service_credentials (workspace_id)`,
    // OAuth tokens. encrypted_value stays the canonical field for api_key and
    // api_key_returned flavors; refresh-token flows also fill the columns
    // below. credential_flavor drives how the runner resolves a usable token.
    `ALTER TABLE agent_service_credentials ADD COLUMN IF NOT EXISTS encrypted_access_token TEXT`,
    `ALTER TABLE agent_service_credentials ADD COLUMN IF NOT EXISTS encrypted_refresh_token TEXT`,
    `ALTER TABLE agent_service_credentials ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
    `ALTER TABLE agent_service_credentials ADD COLUMN IF NOT EXISTS scope TEXT`,
    `ALTER TABLE agent_service_credentials ADD COLUMN IF NOT EXISTS provider_account TEXT`,
    `ALTER TABLE agent_service_credentials ADD COLUMN IF NOT EXISTS credential_flavor TEXT`,
    // Durable OAuth state. Replaces the earlier in-memory CSRF Map so the
    // flow survives restarts and works with multiple instances.
    `CREATE TABLE IF NOT EXISTS agent_service_oauth_states (
      state         TEXT PRIMARY KEY,
      workspace_id  UUID NOT NULL,
      provider      TEXT NOT NULL,
      code_verifier TEXT,
      redirect_uri  TEXT,
      device_code   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at    TIMESTAMPTZ NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS agent_service_oauth_states_expiry_idx
      ON agent_service_oauth_states (expires_at)`,
    // Per-workspace, per-model usage ledger. Powers budget enforcement and
    // the DB-backed hourly request cap (replaces the in-memory timestamp map).
    `CREATE TABLE IF NOT EXISTS agent_service_usage (
      id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id   UUID NOT NULL,
      day            DATE NOT NULL,
      provider       TEXT NOT NULL,
      model_id       TEXT NOT NULL,
      requests       INT  NOT NULL DEFAULT 0,
      tokens_in      BIGINT NOT NULL DEFAULT 0,
      tokens_out     BIGINT NOT NULL DEFAULT 0,
      cost_micro_usd BIGINT NOT NULL DEFAULT 0,
      UNIQUE (workspace_id, day, provider, model_id)
    )`,
    // Index for the usage analytics dashboard — daily spend trend query
    // filters by workspace_id and day >= range. Without this index the query
    // scans all rows for the workspace.
    `CREATE INDEX IF NOT EXISTS agent_service_usage_workspace_day_idx
      ON agent_service_usage (workspace_id, day DESC)`,
    `CREATE TABLE IF NOT EXISTS agent_service_budgets (
      workspace_id           UUID PRIMARY KEY,
      monthly_cost_micro_usd BIGINT NOT NULL CHECK (monthly_cost_micro_usd > 0),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Scheduled agent runs. Minutes granularity is deliberate: this service
    // does not need cron expression power, and an interval is trivially
    // correct across restarts.
    `CREATE TABLE IF NOT EXISTS agent_service_schedules (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id     UUID NOT NULL,
      template_id      TEXT NOT NULL,
      model_id         TEXT NOT NULL,
      instruction      TEXT NOT NULL DEFAULT '',
      interval_minutes INT  NOT NULL CHECK (interval_minutes BETWEEN 60 AND 20160),
      enabled          BOOLEAN NOT NULL DEFAULT true,
      last_run_at      TIMESTAMPTZ,
      next_run_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 hour',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, template_id)
    )`,
    // Workflow orchestration: a brain agent produces a growth plan, which
    // the dispatcher turns into sub-tasks. Each sub-task is a regular
    // agent_service_tasks row linked back to the workflow.
    `CREATE TABLE IF NOT EXISTS agent_service_workflows (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id    UUID NOT NULL,
      brain_template  TEXT NOT NULL,
      brain_model     TEXT,
      status          TEXT NOT NULL DEFAULT 'planning'
                      CHECK (status IN ('planning','dispatching','running','completed','failed')),
      plan            JSONB,
      parent_task_id  UUID REFERENCES agent_service_tasks(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at    TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS agent_service_workflows_workspace_idx
      ON agent_service_workflows (workspace_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS agent_service_workflows_status_idx
      ON agent_service_workflows (status) WHERE status IN ('planning','dispatching','running')`,
    // One brain task can only spawn one workflow. Prevents the duplicate
    // creation bug from producing orphaned records.
    `CREATE UNIQUE INDEX IF NOT EXISTS agent_service_workflows_parent_task_idx
      ON agent_service_workflows (parent_task_id) WHERE parent_task_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS agent_service_workflow_tasks (
      workflow_id     UUID NOT NULL REFERENCES agent_service_workflows(id) ON DELETE CASCADE,
      task_id         UUID NOT NULL REFERENCES agent_service_tasks(id) ON DELETE CASCADE,
      slot            INT NOT NULL,
      role            TEXT NOT NULL CHECK (role IN ('brain','muscle')),
      PRIMARY KEY (workflow_id, task_id)
    )`,
    `CREATE INDEX IF NOT EXISTS agent_service_workflow_tasks_workflow_idx
      ON agent_service_workflow_tasks (workflow_id, slot)`,
    // Sprint 6.12: Discovered free models. A periodic poller fetches the
    // public model catalogs from OpenRouter (and optionally OpenCode Zen)
    // and upserts free-tier models here. The runner reads this table to
    // augment the hardcoded MODELS fallback chain, so new free models
    // appear automatically without a code deploy.
    `CREATE TABLE IF NOT EXISTS agent_service_discovered_models (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source          TEXT NOT NULL,  -- 'openrouter' | 'opencode-zen'
      model_id        TEXT NOT NULL,  -- e.g. 'z-ai/glm-5.2:free'
      name            TEXT NOT NULL,
      context_window  INTEGER NOT NULL DEFAULT 128000,
      pricing_prompt  TEXT NOT NULL DEFAULT '0',
      pricing_completion TEXT NOT NULL DEFAULT '0',
      discovered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (source, model_id)
    )`,
    `CREATE INDEX IF NOT EXISTS agent_service_discovered_models_source_idx
      ON agent_service_discovered_models (source, last_seen_at DESC)`,
    `CREATE INDEX IF NOT EXISTS agent_service_discovered_models_last_seen_idx
      ON agent_service_discovered_models (last_seen_at DESC)`,
    // Sprint 6 audit: missing indexes for hot query paths
    // Schedule ticker scans next_run_at every 60s — needs an index for the
    // FOR UPDATE SKIP LOCKED claim query.
    `CREATE INDEX IF NOT EXISTS agent_service_schedules_next_run_idx
      ON agent_service_schedules (next_run_at) WHERE enabled = true`,
    // Result lookup sorts by created_at DESC — covering index avoids sort.
    `CREATE INDEX IF NOT EXISTS agent_service_results_task_created_idx
      ON agent_service_results (task_id, created_at DESC)`,
    // Reddit session cookies obtained by the Playwright scraper. The scraper
    // logs into Reddit via Google OAuth in a headless Chromium, extracts the
    // session cookies, and stores them here. The Rust worker fetches them
    // via /reddit/cookies and uses them with reqwest for authenticated JSON
    // API access — bypassing Reddit's JS bot-detection challenge.
    `CREATE TABLE IF NOT EXISTS agent_service_reddit_cookies (
      workspace_id    UUID PRIMARY KEY,
      cookies         JSONB NOT NULL,
      reddit_username TEXT,
      obtained_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at      TIMESTAMPTZ NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'failed'))
    )`,
    // Reddit subreddit search results scraped by the persistent browser
    // (agent/reddit-browser.ts). One row per (workspace, query, subreddit);
    // re-scrapes refresh subscribers/description in place. The Rust worker
    // and the MCP tool read this table INSTEAD of calling Reddit — the
    // browser is the only thing that talks to Reddit directly.
    `CREATE TABLE IF NOT EXISTS reddit_scrape_results (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id    UUID NOT NULL,
      query           TEXT NOT NULL,
      subreddit_name  TEXT NOT NULL,
      display_name    TEXT NOT NULL DEFAULT '',
      description     TEXT NOT NULL DEFAULT '',
      subscribers     INT  NOT NULL DEFAULT 0,
      url             TEXT NOT NULL DEFAULT '',
      over18          BOOLEAN NOT NULL DEFAULT false,
      scraped_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, query, subreddit_name)
    )`,
    `CREATE INDEX IF NOT EXISTS reddit_scrape_results_lookup_idx
      ON reddit_scrape_results (workspace_id, query, subscribers DESC)`,
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
}
