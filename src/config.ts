import { env } from "node:process";

export interface Config {
  bind: string;
  databaseUrl: string;
  authKey: string;
  opencodeZenToken: string | null;
  opencodeServerUrl: string | null;
  googleApiKey: string | null;
  groqApiKey: string | null;
}

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(name: string): string | null {
  return env[name] ?? null;
}

export function loadConfig(): Config {
  return {
    bind: env.AGENT_SERVICE_BIND ?? "0.0.0.0:8095",
    databaseUrl: required("DATABASE_URL"),
    authKey: required("AGENT_SERVICE_AUTH_KEY"),
    opencodeZenToken: optional("OPENCODE_ZEN_TOKEN"),
    opencodeServerUrl: optional("OPENCODE_SERVER_URL"),
    googleApiKey: optional("GOOGLE_API_KEY"),
    groqApiKey: optional("GROQ_API_KEY"),
  };
}
