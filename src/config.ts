import { env } from "node:process";

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string | null;
}

export interface Config {
  bind: string;
  databaseUrl: string;
  authKey: string;
  encryptionKey: string;
  /** Decrypt-only fallback used while rotating AGENT_SERVICE_ENCRYPTION_KEY. */
  previousEncryptionKey: string | null;
  corsOrigins: string[];
  opencodeZenToken: string | null;
  opencodeServerUrl: string | null;
  googleApiKey: string | null;
  groqApiKey: string | null;
  /**
   * Per-provider OAuth clients, keyed by provider id. A provider's OAuth flow
   * is available only when its client id is configured here. Secrets stay in
   * the environment; nothing about a client is persisted.
   */
  oauthClients: Record<string, OAuthClientConfig>;
  /** When "false", the runner stops writing agent_outcomes rows (kill switch). */
  outcomesEnabled: boolean;
  /** When "false", the schedule ticker does not create tasks. */
  schedulerEnabled: boolean;
  /** Default monthly spend ceiling per workspace, in micro-USD (1e-6 USD). */
  defaultMonthlyBudgetMicroUsd: number;
}

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(name: string): string | null {
  return env[name] ?? null;
}

function oauthClient(prefix: string): OAuthClientConfig | null {
  const clientId = optional(`${prefix}_OAUTH_CLIENT_ID`);
  if (!clientId) return null;
  return { clientId, clientSecret: optional(`${prefix}_OAUTH_CLIENT_SECRET`) };
}

export function loadConfig(): Config {
  const oauthClients: Record<string, OAuthClientConfig> = {};
  for (const [providerId, prefix] of [
    ["google", "GOOGLE"],
    ["openrouter", "OPENROUTER"],
    ["anthropic", "ANTHROPIC"],
    ["openai", "OPENAI"],
    ["github-copilot", "GITHUB"],
  ] as const) {
    const client = oauthClient(prefix);
    if (client) oauthClients[providerId] = client;
  }

  return {
    bind: env.AGENT_SERVICE_BIND ?? "0.0.0.0:8095",
    databaseUrl: required("DATABASE_URL"),
    authKey: required("AGENT_SERVICE_AUTH_KEY"),
    encryptionKey: required("AGENT_SERVICE_ENCRYPTION_KEY"),
    previousEncryptionKey: optional("AGENT_SERVICE_PREVIOUS_ENCRYPTION_KEY"),
    // Comma-separated list of allowed CORS origins. If unset, CORS is
    // disabled entirely (requests must be same-origin). This prevents any
    // website from making authenticated cross-origin requests to the agent
    // service using stolen workspace IDs and derived tokens.
    corsOrigins: optional("AGENT_SERVICE_CORS_ORIGINS")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [],
    opencodeZenToken: optional("OPENCODE_ZEN_TOKEN"),
    opencodeServerUrl: optional("OPENCODE_SERVER_URL"),
    googleApiKey: optional("GOOGLE_API_KEY"),
    groqApiKey: optional("GROQ_API_KEY"),
    oauthClients,
    outcomesEnabled: optional("AGENT_OUTCOMES_ENABLED") !== "false",
    schedulerEnabled: optional("AGENT_SCHEDULER_ENABLED") !== "false",
    defaultMonthlyBudgetMicroUsd: Number(
      optional("AGENT_DEFAULT_MONTHLY_BUDGET_MICRO_USD") ?? 5_000_000,
    ),
  };
}
