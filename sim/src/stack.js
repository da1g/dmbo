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
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
          socket.end();
          resolve();
        });
        socket.on("error", reject);
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

  const exitPromise = once(proc, "exit");
  const timeoutPromise = sleep(timeoutMs).then(() => {
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
    }
  });
  await Promise.race([exitPromise, timeoutPromise]);
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
  await waitForPort(redisPort, 20000);
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
  await waitForHealth(`http://127.0.0.1:${orchestratorPort}/healthz`, 30000);
  return orchestrator;
}

export async function startStack({ redisPort, orchestratorPort }) {
  const redis = await startRedis(redisPort);
  let orchestrator = await startOrchestrator({ redisPort, orchestratorPort });

  return {
    redis,
    get orchestrator() {
      return orchestrator;
    },
    orchestratorUrl: `http://127.0.0.1:${orchestratorPort}`,
    redisPort,
    orchestratorPort,
    restartOrchestrator: async () => {
      await stopProcess(orchestrator);
      orchestrator = await startOrchestrator({ redisPort, orchestratorPort });
    },
    stopOrchestrator: async () => {
      await stopProcess(orchestrator);
    },
    startOrchestrator: async () => {
      if (orchestrator.exitCode === null) {
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
