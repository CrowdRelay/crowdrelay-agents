import pg from "pg";

const { Pool } = pg;

export type DbPool = pg.Pool;

export function createPool(databaseUrl: string): DbPool {
  return new Pool({
    connectionString: databaseUrl,
    max: 5,
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
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
}
