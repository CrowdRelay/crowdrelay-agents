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
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
}
