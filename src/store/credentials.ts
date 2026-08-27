import type { DbPool } from "./db.js";
import { encrypt, decrypt, decryptWithRotation } from "../crypto.js";
import type { TokenFlavor } from "../providers/registry.js";

export interface Credential {
  id: string;
  workspace_id: string;
  provider: string;
  label: string;
  credential_type: "api_key" | "oauth_refresh_token";
  status: "active" | "revoked" | "invalid";
  last_validated_at: string | null;
  last_validation_error: string | null;
  created_at: string;
}

export interface CredentialWithKey extends Credential {
  /** Decrypted API key or refresh token. Only available in the runner, never sent to the frontend. */
  decryptedValue: string;
}

/**
 * Full secret-bearing row for OAuth flows. `flavor` drives how the runner
 * turns the row into a usable bearer token (see providers/oauth/refresh.ts).
 */
export interface OAuthCredentialRow extends Credential {
  flavor: string;
  accessToken: string | null;
  refreshToken: string | null;
  apiKey: string | null;
  expiresAt: Date | null;
  scope: string | null;
  providerAccount: string | null;
}

export async function storeCredential(
  pool: DbPool,
  workspaceId: string,
  provider: string,
  label: string,
  credentialType: "api_key" | "oauth_refresh_token",
  plaintextValue: string,
  encryptionKey: string,
): Promise<Credential> {
  const encrypted = encrypt(plaintextValue, encryptionKey);
  const { rows } = await pool.query(
    `INSERT INTO agent_service_credentials
      (workspace_id, provider, label, credential_type, encrypted_value, status, last_validated_at)
     VALUES ($1, $2, $3, $4, $5, 'active', now())
     ON CONFLICT (workspace_id, provider)
     DO UPDATE SET label = $3, credential_type = $4, encrypted_value = $5,
                   status = 'active', last_validated_at = now(), last_validation_error = NULL
     RETURNING id, workspace_id, provider, label, credential_type, status,
               last_validated_at, last_validation_error, created_at`,
    [workspaceId, provider, label, credentialType, encrypted],
  );
  return rowToCredential(rows[0]);
}

/**
 * Upserts a full OAuth token set. For api_key_returned providers the
 * exchanged key lands in encrypted_value so every existing consumer of
 * getCredential keeps working unchanged.
 */
export async function storeOAuthTokens(
  pool: DbPool,
  workspaceId: string,
  provider: string,
  tokens: {
    flavor: TokenFlavor;
    accessToken?: string;
    refreshToken?: string;
    apiKey?: string;
    expiresInSeconds?: number;
    scope?: string;
    account?: string;
  },
  encryptionKey: string,
): Promise<Credential> {
  const canonicalValue = tokens.apiKey ?? tokens.refreshToken ?? tokens.accessToken ?? "";
  const encryptedValue = encrypt(canonicalValue, encryptionKey);
  const encryptedAccess = tokens.accessToken ? encrypt(tokens.accessToken, encryptionKey) : null;
  const encryptedRefresh = tokens.refreshToken ? encrypt(tokens.refreshToken, encryptionKey) : null;
  const expiresAt =
    tokens.expiresInSeconds !== undefined
      ? new Date(Date.now() + tokens.expiresInSeconds * 1000)
      : null;
  const { rows } = await pool.query(
    `INSERT INTO agent_service_credentials
      (workspace_id, provider, label, credential_type, encrypted_value,
       encrypted_access_token, encrypted_refresh_token, expires_at, scope,
       provider_account, credential_flavor, status, last_validated_at)
     VALUES ($1, $2, $3, 'oauth_refresh_token', $4,
             $5, $6, $7, $8, $9, $10, 'active', now())
     ON CONFLICT (workspace_id, provider)
     DO UPDATE SET credential_type = 'oauth_refresh_token',
                   encrypted_value = $4,
                   encrypted_access_token = $5,
                   encrypted_refresh_token = $6,
                   expires_at = $7,
                   scope = $8,
                   provider_account = COALESCE($9, agent_service_credentials.provider_account),
                   credential_flavor = $10,
                   status = 'active', last_validated_at = now(), last_validation_error = NULL
     RETURNING id, workspace_id, provider, label, credential_type, status,
               last_validated_at, last_validation_error, created_at`,
    [
      workspaceId,
      provider,
      `${provider} OAuth`,
      encryptedValue,
      encryptedAccess,
      encryptedRefresh,
      expiresAt,
      tokens.scope ?? null,
      tokens.account ?? null,
      tokens.flavor,
    ],
  );
  return rowToCredential(rows[0]);
}

/**
 * Persists a refreshed access token (and possibly new refresh token) without
 * touching validation state.
 */
export async function updateOAuthTokens(
  pool: DbPool,
  workspaceId: string,
  provider: string,
  tokens: { accessToken: string; refreshToken?: string | null; expiresInSeconds: number },
  encryptionKey: string,
): Promise<void> {
  await pool.query(
    `UPDATE agent_service_credentials
     SET encrypted_access_token = $3,
         expires_at = $4,
         encrypted_refresh_token = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE encrypted_refresh_token END,
         encrypted_value = $3
     WHERE workspace_id = $1 AND provider = $2`,
    [
      workspaceId,
      provider,
      encrypt(tokens.accessToken, encryptionKey),
      new Date(Date.now() + tokens.expiresInSeconds * 1000),
      tokens.refreshToken ? encrypt(tokens.refreshToken, encryptionKey) : null,
    ],
  );
}

/** Loads and decrypts every secret-bearing field of one credential. */
export async function getOAuthCredentialRow(
  pool: DbPool,
  workspaceId: string,
  provider: string,
  encryptionKey: string,
  previousEncryptionKey: string | null,
): Promise<OAuthCredentialRow | null> {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, provider, label, credential_type, status,
            last_validated_at, last_validation_error, created_at,
            encrypted_value, encrypted_access_token, encrypted_refresh_token,
            expires_at, scope, provider_account, credential_flavor
     FROM agent_service_credentials
     WHERE workspace_id = $1 AND provider = $2 AND status = 'active'`,
    [workspaceId, provider],
  );
  const row = rows[0];
  if (!row) return null;

  const open = (column: string | null): string | null => {
    if (!column) return null;
    return decryptWithRotation(column, encryptionKey, previousEncryptionKey).value;
  };

  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    provider: row.provider as string,
    label: row.label as string,
    credential_type: row.credential_type as Credential["credential_type"],
    status: row.status as Credential["status"],
    last_validated_at: row.last_validated_at as string | null,
    last_validation_error: row.last_validation_error as string | null,
    created_at: row.created_at as string,
    flavor: (row.credential_flavor as string | null) ?? "api_key",
    accessToken: open(row.encrypted_access_token as string | null),
    refreshToken: open(row.encrypted_refresh_token as string | null),
    apiKey: open(row.encrypted_value as string | null),
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    scope: (row.scope as string | null) ?? null,
    providerAccount: (row.provider_account as string | null) ?? null,
  };
}

export async function listCredentials(
  pool: DbPool,
  workspaceId: string,
): Promise<Array<Credential & { credential_flavor: string | null; provider_account: string | null; expires_at: string | null }>> {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, provider, label, credential_type, status,
            last_validated_at, last_validation_error, created_at,
            credential_flavor, provider_account, expires_at
     FROM agent_service_credentials
     WHERE workspace_id = $1
     ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows.map((row) => ({
    ...rowToCredential(row),
    credential_flavor: (row.credential_flavor as string | null) ?? null,
    provider_account: (row.provider_account as string | null) ?? null,
    expires_at: row.expires_at ? new Date(row.expires_at as string).toISOString() : null,
  }));
}

export async function getCredential(
  pool: DbPool,
  workspaceId: string,
  provider: string,
  encryptionKey: string,
  previousEncryptionKey: string | null = null,
): Promise<CredentialWithKey | null> {
  const { rows } = await pool.query(
    `SELECT * FROM agent_service_credentials
     WHERE workspace_id = $1 AND provider = $2 AND status = 'active'`,
    [workspaceId, provider],
  );
  if (!rows[0]) return null;
  const cred = rowToCredential(rows[0]);
  const decryptedValue = decryptWithRotation(
    rows[0].encrypted_value as string,
    encryptionKey,
    previousEncryptionKey,
  ).value;
  return { ...cred, decryptedValue };
}

export async function deleteCredential(
  pool: DbPool,
  workspaceId: string,
  provider: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM agent_service_credentials
     WHERE workspace_id = $1 AND provider = $2`,
    [workspaceId, provider],
  );
  return (rowCount ?? 0) > 0;
}

export async function updateCredentialStatus(
  pool: DbPool,
  workspaceId: string,
  provider: string,
  status: "active" | "revoked" | "invalid",
  validationError?: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE agent_service_credentials
     SET status = $3, last_validation_error = $4,
         last_validated_at = CASE WHEN $3 = 'active' THEN now() ELSE last_validated_at END
     WHERE workspace_id = $1 AND provider = $2`,
    [workspaceId, provider, status, validationError ?? null],
  );
}

export async function getConnectedProviders(
  pool: DbPool,
  workspaceId: string,
): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT provider FROM agent_service_credentials
     WHERE workspace_id = $1 AND status = 'active'`,
    [workspaceId],
  );
  return rows.map((r) => r.provider as string);
}

function rowToCredential(row: Record<string, unknown>): Credential {
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    provider: row.provider as string,
    label: row.label as string,
    credential_type: row.credential_type as Credential["credential_type"],
    status: row.status as Credential["status"],
    last_validated_at: row.last_validated_at as string | null,
    last_validation_error: row.last_validation_error as string | null,
    created_at: row.created_at as string,
  };
}
