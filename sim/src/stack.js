import { once } from "node:events";
import net from "node:net";
import { spawn } from "node:child_process";

const ORCHESTRATOR_BIN_DEFAULT = "../orchestrator/target/debug/dmbo-orchestrator";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveOrchestratorBin() {
  return process.env.DMBO_ORCHESTRATOR_BIN ?? ORCHESTRATOR_BIN_DEFAULT;
}

async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      let socket;
      await new Promise((resolve, reject) => {
        socket = net.createConnection({ host: "127.0.0.1", port }, () => {
          socket.end();
          resolve();
        });
        socket.on("error", (error) => {
          // Ensure the socket is always cleaned up on error
          if (socket && !socket.destroyed) {
            socket.destroy();
          }
          reject(error);
        });
      }).finally(() => {
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
      });
      return;
    } catch (_error) {
      await sleep(100);
    }
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

async function waitForHealth(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (_error) {
      // ignore while waiting
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for health endpoint ${url}`);
}

async function stopProcess(proc, timeoutMs = 4000) {
  if (!proc || proc.exitCode !== null || proc.killed) {
    return;
  }
  proc.kill("SIGINT");

  const exitPromise = once(proc, "exit").then(() => "exit");
  const timeoutPromise = sleep(timeoutMs).then(() => {
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
    }
    return "timeout";
  });
  const winner = await Promise.race([exitPromise, timeoutPromise]);
  if (winner === "timeout") {
    await exitPromise;
  }
}

export async function startRedis(redisPort) {
  const redis = spawn(
    "redis-server",
    ["--port", String(redisPort), "--save", "", "--appendonly", "no"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );
  redis.stdout.on("data", () => {});
  redis.stderr.on("data", () => {});
  const portReadyPromise = waitForPort(redisPort, 20000);
  const errorPromise = once(redis, "error").then(([error]) => {
    const message =
      error && typeof error.message === "string"
        ? error.message
        : String(error);
    throw new Error(
      `Failed to start redis-server on port ${redisPort}: ${message}`,
    );
  });
  await Promise.race([portReadyPromise, errorPromise]);
  return redis;
}

export async function startOrchestrator({ orchestratorPort, redisPort }) {
  const orchestrator = spawn(resolveOrchestratorBin(), [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DMBO_BIND: `127.0.0.1:${orchestratorPort}`,
      REDIS_URL: `redis://127.0.0.1:${redisPort}/`,
      RUST_LOG: process.env.RUST_LOG ?? "info",
    },
  });
  orchestrator.stdout.on("data", () => {});
  orchestrator.stderr.on("data", () => {});

  const healthPromise = waitForHealth(`http://127.0.0.1:${orchestratorPort}/healthz`, 30000);
  const errorPromise = once(orchestrator, "error").then(([error]) => {
    // Convert orchestrator spawn errors into a controlled failure instead of an uncaught exception.
    const bin = resolveOrchestratorBin();
    throw new Error(`Failed to start orchestrator process (${bin}): ${error?.message ?? error}`);
  });

  await Promise.race([healthPromise, errorPromise]);
  return orchestrator;
}

export async function startStack({ redisPort, orchestratorPort }) {
  const redis = await startRedis(redisPort);
  let orchestrator;
  try {
    orchestrator = await startOrchestrator({ redisPort, orchestratorPort });
  } catch (error) {
    await stopProcess(redis);
    throw error;
  }

  return {
    redis,
    get orchestrator() {
      return orchestrator;
    },
    orchestratorUrl: `http://127.0.0.1:${orchestratorPort}`,
    redisPort,
    orchestratorPort,
    restartOrchestrator: async () => {
      const previousOrchestrator = orchestrator;
      await stopProcess(previousOrchestrator);
      try {
        orchestrator = await startOrchestrator({ redisPort, orchestratorPort });
      } catch (error) {
        // Explicitly record that there is currently no running orchestrator.
        orchestrator = null;
        throw error;
      }
    },
    stopOrchestrator: async () => {
      await stopProcess(orchestrator);
    },
    startOrchestrator: async () => {
      if (orchestrator && orchestrator.exitCode === null) {
        return;
      }
      orchestrator = await startOrchestrator({ redisPort, orchestratorPort });
    },
    stopAll: async () => {
      await stopProcess(orchestrator);
      await stopProcess(redis);
    },
  };
}
