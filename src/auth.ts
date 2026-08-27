import { createHmac } from "node:crypto";

const NAMESPACE = "crowdrelay-agent-service-v1:";

/**
 * Derives an HMAC-SHA256 token for a workspace, matching the control plane's
 * `derived_management_token` scheme in `tenant_area_client.rs`.
 *
 * token = hex(HMAC-SHA256(master_key, namespace + workspace_id_string))
 */
export function deriveToken(masterKey: string, workspaceId: string): string {
  const message = NAMESPACE + workspaceId;
  return createHmac("sha256", masterKey).update(message).digest("hex");
}

/**
 * Verifies that the provided bearer token matches the expected derived token
 * for the given workspace. Uses timing-safe comparison.
 */
export function verifyToken(
  masterKey: string,
  workspaceId: string,
  bearerToken: string,
): boolean {
  const expected = deriveToken(masterKey, workspaceId);
  if (bearerToken.length !== expected.length) return false;
  return timingSafeEqual(bearerToken, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Extracts and verifies auth from a Fastify request.
 * Returns the workspace_id if valid, throws otherwise.
 */
export function extractWorkspaceId(
  authKey: string,
  headers: Record<string, string | string[] | undefined>,
): string {
  const workspaceId = headers["x-workspace-id"];
  const auth = headers["authorization"];

  if (typeof workspaceId !== "string" || !workspaceId) {
    throw new AuthError("missing X-Workspace-Id header");
  }
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
    throw new AuthError("missing or malformed Authorization header");
  }

  const token = auth.slice(7);
  if (!verifyToken(authKey, workspaceId, token)) {
    throw new AuthError("invalid auth token");
  }

  return workspaceId;
}

export class AuthError extends Error {
  readonly statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
