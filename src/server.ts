import Fastify from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { loadConfig } from "./config.js";
import { createPool, runMigrations, type DbPool } from "./store/db.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerCredentialRoutes } from "./routes/credentials.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { registerPremiumRoutes } from "./routes/premium.js";
import { runDiscoveryCycle } from "./agent/discovery.js";
import { recoverStaleTasks, createTask } from "./store/tasks.js";
import { claimDueSchedules } from "./agent/schedules.js";
import { findTemplate } from "./templates/catalog.js";
import { runTask } from "./agent/runner.js";
import { checkBudgetForTask } from "./agent/usage.js";

// Track in-flight background tasks so graceful shutdown can wait for them.
const inFlightTasks = new Set<Promise<void>>();

// Stable instance ID for this container/pod. Used to scope stale-task
// recovery so a restart only fails tasks owned by this instance, not those
// being processed by other instances in a multi-instance deployment.
//
// MUST be stable across restarts of the same pod/container — otherwise a
// restarted process will never match the instance_id of tasks left running
// by its previous incarnation, and those tasks stay "running" forever.
// We prefer HOSTNAME (set by Docker/Kubernetes to the pod name), fall back
// to POD_NAME, then os.hostname(), and finally a random UUID only if none
// of those are available (single-process dev mode).
const INSTANCE_ID =
  process.env.HOSTNAME ||
  process.env.POD_NAME ||
  hostname() ||
  randomUUID();

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

  // Chatbot route (auth required — uses free Zen models)
  registerChatRoutes(app, {
    authKey: config.authKey,
    zenToken: config.opencodeZenToken,
  });

  // Workflow routes (auth required — observation of brain-dispatched runs)
  // The brain is the deterministic Rust autopilot. These routes let the
  // control panel observe worker runs that the brain has dispatched.
  registerWorkflowRoutes(app, {
    pool,
    authKey: config.authKey,
  });

  // Premium AI routes (auth required — usage tracking + connected models)
  registerPremiumRoutes(app, {
    pool,
    authKey: config.authKey,
    defaultMonthlyBudgetMicroUsd: config.defaultMonthlyBudgetMicroUsd,
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

          // Budget pre-check — scheduled tasks must respect the monthly
          // budget just like ad-hoc tasks. Without this, a schedule can
          // consume paid quota after the budget is exhausted.
          const budget = await checkBudgetForTask(
            pool,
            sched.workspace_id,
            "",
            sched.model_id,
            config.defaultMonthlyBudgetMicroUsd,
          );
          if (!budget.allowed) {
            console.log(
              `schedule ${sched.id} skipped — budget exhausted for workspace ${sched.workspace_id}`,
            );
            continue;
          }

          // Create a proper agent_service_tasks row for this scheduled run.
          // Previously the schedule ID was passed directly as taskId, but
          // there was no corresponding task row — causing updateTaskStatus
          // and result inserts to fail silently on FK violations.
          const task = await createTask(
            pool,
            sched.workspace_id,
            sched.template_id,
            sched.model_id,
            sched.instruction || `Run ${template.name} for this workspace.`,
            { source: "schedule", schedule_id: sched.id },
            INSTANCE_ID,
            "basic",
          );
          const taskPromise = runTask({
            pool,
            taskId: task.id,
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
            tier: "basic",
          }).catch((err) => {
            console.error(`scheduled task ${task.id} crashed:`, err);
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

  // Model discovery ticker — every 24h, poll OpenRouter's public /models
  // endpoint and upsert free-tier models into agent_service_discovered_models.
  // The runner reads this table to augment the hardcoded MODELS fallback
  // chain, so new free models appear automatically without a code deploy.
  // Runs once on startup (after 30s delay) then every 24h.
  let discoveryTimer: NodeJS.Timeout | null = null;
  const discoveryTick = async () => {
    try {
      await runDiscoveryCycle(pool, config.opencodeZenToken);
    } catch (err) {
      console.error("model discovery ticker error:", err);
    }
  };
  // Initial run after 30s (let the service settle first)
  const initialDiscovery = setTimeout(discoveryTick, 30_000);
  initialDiscovery.unref();
  // Then every 24 hours
  discoveryTimer = setInterval(discoveryTick, 24 * 60 * 60 * 1000);
  discoveryTimer.unref();

  // Graceful shutdown: drain HTTP requests, wait for in-flight tasks (up to
  // 30s), then close the DB pool. Without this, SIGTERM kills the process
  // immediately — in-flight tasks are left in "running" forever.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // ignore duplicate signals
    shuttingDown = true;
    console.log(`received ${signal}, shutting down gracefully`);
    if (schedulerTimer) clearInterval(schedulerTimer);
    if (discoveryTimer) clearInterval(discoveryTimer);
    await app.close();

    if (inFlightTasks.size > 0) {
      console.log(`waiting for ${inFlightTasks.size} in-flight task(s)…`);
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000));
      await Promise.race([Promise.allSettled([...inFlightTasks]), timeout]);
      console.log(`in-flight tasks settled (${inFlightTasks.size} remaining)`);
    }

    // Hard-cap pool.end() — if a DB client is still held by a long-running
    // task, don't let shutdown hang indefinitely.
    await Promise.race([
      pool.end(),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
