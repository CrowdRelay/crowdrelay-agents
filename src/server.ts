import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadConfig } from "./config.js";
import { createPool, runMigrations, type DbPool } from "./store/db.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerCredentialRoutes } from "./routes/credentials.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import { recoverStaleTasks } from "./store/tasks.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool: DbPool = createPool(config.databaseUrl);

  // Run migrations on startup
  await runMigrations(pool);
  console.log("migrations complete");

  // Mark tasks left "running" by a previous process as failed.
  // Without this, a container restart mid-task leaks the task forever.
  const recovered = await recoverStaleTasks(pool);
  if (recovered > 0) {
    console.log(`recovered ${recovered} stale task(s) left running by a previous process`);
  }

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

  // Graceful shutdown: drain in-flight requests, then close the DB pool.
  // Without this, SIGTERM kills the process immediately — in-flight tasks
  // are left in "running" forever (recovered by recoverStaleTasks on next boot,
  // but that wastes the work already done).
  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down gracefully`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
