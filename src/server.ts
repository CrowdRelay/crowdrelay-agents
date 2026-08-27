import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadConfig } from "./config";
import { createPool, runMigrations, type DbPool } from "./store/db";
import { registerTemplateRoutes } from "./routes/templates";
import { registerTaskRoutes } from "./routes/tasks";
import { registerHealthRoutes } from "./routes/health";

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
    origin: true, // control plane proxies, so CORS is permissive
  });

  // Health routes (no auth — the control plane checks these)
  registerHealthRoutes(app, { pool });

  // Template routes (auth required)
  registerTemplateRoutes(app, { authKey: config.authKey });

  // Task routes (auth required)
  registerTaskRoutes(app, {
    pool,
    authKey: config.authKey,
    availableKeys: {
      google: !!config.googleApiKey,
      groq: !!config.groqApiKey,
    },
    opencodeServerUrl: config.opencodeServerUrl,
    zenToken: config.opencodeZenToken,
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
