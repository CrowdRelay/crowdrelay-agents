import { createHmac, timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";

const NAMESPACE = "crowdrelay-control-plane-v1:";

// UUID v7 (and v4) format: 8-4-4-4-12 hex digits
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * for the given workspace. Uses Node's constant-time comparison.
 */
export function verifyToken(
  masterKey: string,
  workspaceId: string,
  bearerToken: string,
): boolean {
  const expected = deriveToken(masterKey, workspaceId);
  const expectedBuf = Buffer.from(expected, "hex");
  const bearerBuf = Buffer.from(bearerToken, "hex");
  if (expectedBuf.length !== bearerBuf.length) return false;
  return cryptoTimingSafeEqual(expectedBuf, bearerBuf);
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
  if (!UUID_RE.test(workspaceId)) {
    throw new AuthError("X-Workspace-Id must be a valid UUID");
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
