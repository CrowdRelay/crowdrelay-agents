import type { DbPool } from "./db.js";
import { encrypt, decryptWithRotation } from "../crypto.js";

export interface Credential {
  id: string;
  workspace_id: string;
  provider: string;
  label: string;
  credential_type: "api_key";
  status: "active" | "revoked" | "invalid";
  last_validated_at: string | null;
  last_validation_error: string | null;
  created_at: string;
}

export interface CredentialWithKey extends Credential {
  /** Decrypted API key. Only available in the runner, never sent to the frontend. */
  decryptedValue: string;
}

export async function storeCredential(
  pool: DbPool,
  workspaceId: string,
  provider: string,
  label: string,
  credentialType: "api_key",
  plaintextValue: string,
  encryptionKey: string,
  providerAccount?: string,
): Promise<Credential> {
  const encrypted = encrypt(plaintextValue, encryptionKey);
  const { rows } = await pool.query(
    `INSERT INTO agent_service_credentials
      (workspace_id, provider, label, credential_type, encrypted_value, status, last_validated_at, provider_account)
     VALUES ($1, $2, $3, $4, $5, 'active', now(), $6)
     ON CONFLICT (workspace_id, provider)
     DO UPDATE SET label = $3, credential_type = $4, encrypted_value = $5,
                   status = 'active', last_validated_at = now(), last_validation_error = NULL,
                   provider_account = COALESCE($6, agent_service_credentials.provider_account)
     RETURNING id, workspace_id, provider, label, credential_type, status,
               last_validated_at, last_validation_error, created_at`,
    [workspaceId, provider, label, credentialType, encrypted, providerAccount ?? null],
  );
  return rowToCredential(rows[0]);
}

export async function listCredentials(
  pool: DbPool,
  workspaceId: string,
): Promise<Array<Credential & { provider_account: string | null }>> {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, provider, label, credential_type, status,
            last_validated_at, last_validation_error, created_at,
            provider_account
     FROM agent_service_credentials
     WHERE workspace_id = $1
     ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows.map((row) => ({
    ...rowToCredential(row),
    provider_account: (row.provider_account as string | null) ?? null,
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
