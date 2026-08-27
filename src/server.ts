import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadConfig } from "./config";
import { createPool, runMigrations, type DbPool } from "./store/db";
import { registerTemplateRoutes } from "./routes/templates";
import { registerTaskRoutes } from "./routes/tasks";
import { registerHealthRoutes } from "./routes/health";
import { registerCredentialRoutes } from "./routes/credentials";
import { registerOAuthRoutes } from "./routes/oauth";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool: DbPool = createPool(config.databaseUrl);

  // Run migrations on startup
  await runMigrations(pool);
  console.log("migrations complete");

  const app = Fastify({
    logger: true,
    bodyLimit: 64 * 1024,
  });

  await app.register(cors, {
    origin: true,
  });

  // Health routes (no auth — the control plane checks these)
  registerHealthRoutes(app, { pool });

  // Provider catalog (no auth — static data)
  // Credential routes (auth required)
  registerCredentialRoutes(app, {
    pool,
    authKey: config.authKey,
    encryptionKey: config.encryptionKey,
  });

  // OAuth routes (auth required for start, callback uses state token)
  registerOAuthRoutes(app, {
    pool,
    authKey: config.authKey,
    encryptionKey: config.encryptionKey,
    oauth: {
      googleClientId: config.googleOAuthClientId,
      googleClientSecret: config.googleOAuthClientSecret,
      googleRedirectUri: config.googleOAuthRedirectUri,
    },
  });

  // Template routes (auth required)
  registerTemplateRoutes(app, { authKey: config.authKey });

  // Task routes (auth required)
  registerTaskRoutes(app, {
    pool,
    authKey: config.authKey,
    encryptionKey: config.encryptionKey,
    zenToken: config.opencodeZenToken,
    fallbackGoogleKey: config.googleApiKey,
    fallbackGroqKey: config.groqApiKey,
  });

  const [host, portStr] = config.bind.split(":");
  const port = parseInt(portStr, 10);
  await app.listen({ host, port });
  console.log(`crowdrelay-agents listening on ${config.bind}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
