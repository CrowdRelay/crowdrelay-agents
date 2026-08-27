import Fastify from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { createPool, runMigrations, type DbPool } from "./store/db.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerCredentialRoutes } from "./routes/credentials.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import { recoverStaleTasks } from "./store/tasks.js";
import { claimDueSchedules } from "./agent/schedules.js";
import { findTemplate } from "./templates/catalog.js";
import { runTask } from "./agent/runner.js";

// Track in-flight background tasks so graceful shutdown can wait for them.
const inFlightTasks = new Set<Promise<void>>();

// Unique ID for this process instance. Used to scope stale-task recovery
// so a restart only fails tasks owned by this instance, not those being
// processed by other instances in a multi-instance deployment.
const INSTANCE_ID = randomUUID();

async function main(): Promise<void> {
  const config = loadConfig();
  const pool: DbPool = createPool(config.databaseUrl);

  // Run migrations on startup
  await runMigrations(pool);
  console.log("migrations complete");

  // Mark tasks left "running" by a previous process of THIS instance as
  // failed. Without this, a container restart mid-task leaks the task
  // forever. Scoped to this instance_id so other live instances are not
  // affected.
  const recovered = await recoverStaleTasks(pool, INSTANCE_ID);
  if (recovered > 0) {
    console.log(`recovered ${recovered} stale task(s) left running by a previous process`);
  }

  const app = Fastify({
    logger: true,
    bodyLimit: 64 * 1024,
  });

  await app.register(cors, {
    // Only allow configured origins. If none are configured, CORS is
    // disabled — requests must be same-origin. This prevents any website
    // from making authenticated cross-origin requests.
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
  });

  // Health routes (no auth — the control plane checks these)
  registerHealthRoutes(app, { pool });

  // Provider catalog (no auth — static data)
  // Credential routes (auth required)
  registerCredentialRoutes(app, {
    pool,
    authKey: config.authKey,
    encryptionKey: config.encryptionKey,
    previousEncryptionKey: config.previousEncryptionKey,
    oauthClients: config.oauthClients,
  });

  // OAuth routes (auth required for start, callback uses state token)
  registerOAuthRoutes(app, {
    pool,
    authKey: config.authKey,
    encryptionKey: config.encryptionKey,
    oauthClients: config.oauthClients,
  });

  // Template routes (auth required)
  registerTemplateRoutes(app, { authKey: config.authKey });

  // Task routes (auth required)
  registerTaskRoutes(app, {
    pool,
    authKey: config.authKey,
    encryptionKey: config.encryptionKey,
    previousEncryptionKey: config.previousEncryptionKey,
    zenToken: config.opencodeZenToken,
    fallbackGoogleKey: config.googleApiKey,
    fallbackGroqKey: config.groqApiKey,
    outcomesEnabled: config.outcomesEnabled,
    defaultMonthlyBudgetMicroUsd: config.defaultMonthlyBudgetMicroUsd,
    inFlightTasks,
    instanceId: INSTANCE_ID,
  });

  // Schedule routes (auth required)
  registerScheduleRoutes(app, {
    pool,
    authKey: config.authKey,
  });

  const [host, portStr] = config.bind.split(":");
  const port = parseInt(portStr, 10);
  await app.listen({ host, port });
  console.log(`crowdrelay-agents listening on ${config.bind}`);

  // Schedule ticker — every 60s, claim due schedules and fire tasks.
  // Reuses the normal task runner so rate limits, budgets, and fallback
  // chains all apply. Skipped when schedulerEnabled is false or the
  // pool is closed during shutdown.
  let schedulerTimer: NodeJS.Timeout | null = null;
  if (config.schedulerEnabled) {
    const tick = async () => {
      try {
        const due = await claimDueSchedules(pool, 5);
        for (const sched of due) {
          const template = findTemplate(sched.template_id);
          if (!template) continue;
          const taskPromise = runTask({
            pool,
            taskId: sched.id, // schedule id doubles as task id for schedule-fired runs
            workspaceId: sched.workspace_id,
            template,
            modelId: sched.model_id,
            prompt: sched.instruction || `Run ${template.name} for this workspace.`,
            encryptionKey: config.encryptionKey,
            previousEncryptionKey: config.previousEncryptionKey,
            zenToken: config.opencodeZenToken,
            fallbackGoogleKey: config.googleApiKey,
            fallbackGroqKey: config.groqApiKey,
            outcomesEnabled: config.outcomesEnabled,
          }).catch((err) => {
            console.error(`scheduled task ${sched.id} crashed:`, err);
          });
          inFlightTasks.add(taskPromise);
          void taskPromise.finally(() => inFlightTasks.delete(taskPromise));
        }
      } catch (err) {
        console.error("schedule ticker error:", err);
      }
    };
    schedulerTimer = setInterval(tick, 60_000);
    schedulerTimer.unref();
  }

  // Graceful shutdown: drain HTTP requests, wait for in-flight tasks (up to
  // 30s), then close the DB pool. Without this, SIGTERM kills the process
  // immediately — in-flight tasks are left in "running" forever.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // ignore duplicate signals
    shuttingDown = true;
    console.log(`received ${signal}, shutting down gracefully`);
    if (schedulerTimer) clearInterval(schedulerTimer);
    await app.close();

    if (inFlightTasks.size > 0) {
      console.log(`waiting for ${inFlightTasks.size} in-flight task(s)…`);
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000));
      await Promise.race([Promise.allSettled([...inFlightTasks]), timeout]);
      console.log(`in-flight tasks settled (${inFlightTasks.size} remaining)`);
    }

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
