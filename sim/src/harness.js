import { DmboClient } from "../../client-js/src/index.js";
import { sendFakeDiscordRequest, startFakeDiscordServer } from "./fake-discord.js";
import { startStack } from "./stack.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hasSustained429(events, { startMs, warmupMs, windowMs, max429 }) {
  const thresholdStart = startMs + warmupMs;
  const relevant = events
    .filter(
      (event) =>
        event.ts >= thresholdStart &&
        event.statusCode === 429 &&
        (event.scope === "user" || event.scope === "global"),
    )
    .sort((a, b) => a.ts - b.ts);

  let left = 0;
  for (let right = 0; right < relevant.length; right += 1) {
    while (relevant[right].ts - relevant[left].ts > windowMs) {
      left += 1;
    }
    if (right - left + 1 > max429) {
      return true;
    }
  }
  return false;
}

async function runTrafficWorkers({
  clients,
  discordUrl,
  durationMs,
  route,
  majorParameter,
  workerCountPerClient,
}) {
  const startMs = Date.now();
  const endMs = startMs + durationMs;
  const events = [];

  const workers = clients.flatMap((client) =>
    Array.from({ length: workerCountPerClient }, async () => {
      while (Date.now() < endMs) {
        const meta = {
          method: "POST",
          route,
          majorParameter,
          maxWaitMs: 2000,
          discordIdentity: client.discordIdentity,
        };
        const response = await client.withPermit(meta, () =>
          sendFakeDiscordRequest(discordUrl, {
            discordIdentity: client.discordIdentity,
            method: meta.method,
            route: meta.route,
            majorParameter: meta.majorParameter,
          }),
        );
        events.push({
          ts: Date.now(),
          identity: client.discordIdentity,
          statusCode: response.status,
          scope: response.headers["x-ratelimit-scope"] ?? null,
          source: client.lastPermitSource,
        });
        await sleep(5);
      }
    }),
  );

  await Promise.all(workers);
  return { startMs, events };
}

export async function runBurstAcceptanceTest({
  redisPort = 6380,
  orchestratorPort = 8787,
  fakeDiscordPort = 9980,
  durationMs = 95_000,
  warmupMs = 60_000,
  windowMs = 30_000,
  max429 = 3,
} = {}) {
  const stack = await startStack({ redisPort, orchestratorPort });
  const fakeDiscord = await startFakeDiscordServer({ port: fakeDiscordPort });

  try {
    const clients = ["bot-1", "bot-2", "bot-3"].map(
      (identity) =>
        new DmboClient({
          orchestratorUrl: stack.orchestratorUrl,
          clientId: identity,
          discordIdentity: identity,
          groupId: "homelab-ip",
          localGlobalRps: 45,
          localRouteRps: 5,
        }),
    );

    const { startMs, events } = await runTrafficWorkers({
      clients,
      discordUrl: fakeDiscord.url,
      durationMs,
      route: "/channels/:channel_id/messages",
      majorParameter: "123456789012345678",
      workerCountPerClient: 3,
    });

    const byIdentity = new Map();
    for (const event of events) {
      const list = byIdentity.get(event.identity) ?? [];
      list.push(event);
      byIdentity.set(event.identity, list);
    }

    const identities = [...byIdentity.keys()];
    const sustained = Object.fromEntries(
      identities.map((identity) => [
        identity,
        hasSustained429(byIdentity.get(identity), { startMs, warmupMs, windowMs, max429 }),
      ]),
    );

    const metricsResponse = await fetch(`${stack.orchestratorUrl}/metrics`);
    const metricsText = await metricsResponse.text();
    const passed = Object.values(sustained).every((value) => value === false);

    return {
      test: "burst",
      passed,
      sustained429: sustained,
      totalRequests: events.length,
      total429: events.filter((event) => event.statusCode === 429).length,
      metricsSnippet: metricsText
        .split("\n")
        .filter((line) =>
          [
            "tokens_granted_total",
            "tokens_denied_total",
            "orchestrator_429_observed_total",
            "orchestrator_queue_depth",
          ].some((name) => line.startsWith(name)),
        )
        .join("\n"),
    };
  } finally {
    await fakeDiscord.close();
    await stack.stopAll();
  }
}

export async function runOrchestratorDownAcceptanceTest({
  redisPort = 6381,
  orchestratorPort = 8788,
  fakeDiscordPort = 9981,
  totalDurationMs = 35_000,
  outageAfterMs = 5_000,
  outageDurationMs = 10_000,
} = {}) {
  const stack = await startStack({ redisPort, orchestratorPort });
  const fakeDiscord = await startFakeDiscordServer({ port: fakeDiscordPort });
  const clients = ["bot-a", "bot-b"].map(
    (identity) =>
      new DmboClient({
        orchestratorUrl: stack.orchestratorUrl,
        clientId: identity,
        discordIdentity: identity,
        groupId: "homelab-ip",
        localGlobalRps: 45,
        localRouteRps: 5,
      }),
  );

  const allEvents = [];
  const startedAt = Date.now();
  const outageStartAt = startedAt + outageAfterMs;
  const outageEndAt = outageStartAt + outageDurationMs;
  const endAt = startedAt + totalDurationMs;

  try {
    const workers = clients.map(async (client) => {
      while (Date.now() < endAt) {
        const result = await client.withPermit(
          {
            method: "POST",
            route: "/channels/:channel_id/messages",
            majorParameter: "123456789012345678",
            maxWaitMs: 1500,
            discordIdentity: client.discordIdentity,
          },
          () =>
            sendFakeDiscordRequest(fakeDiscord.url, {
              discordIdentity: client.discordIdentity,
              method: "POST",
              route: "/channels/:channel_id/messages",
              majorParameter: "123456789012345678",
            }),
        );
        allEvents.push({
          ts: Date.now(),
          identity: client.discordIdentity,
          source: client.lastPermitSource,
          statusCode: result.status,
        });
        await sleep(10);
      }
    });

    await sleep(outageAfterMs);
    await stack.stopOrchestrator();
    await sleep(outageDurationMs);
    await stack.startOrchestrator();

    await Promise.all(workers);

    const fallbackDuringOutage = allEvents.filter(
      (event) => event.ts >= outageStartAt && event.ts <= outageEndAt && event.source === "fallback",
    ).length;
    const resumedAfterRestart = allEvents.filter(
      (event) => event.ts > outageEndAt + 1000 && event.source === "orchestrator",
    ).length;
    const noCrash = allEvents.length > 0 && clients.every((client) => client.stats.reportErrors >= 0);

    return {
      test: "orchestrator-down",
      passed: fallbackDuringOutage > 0 && resumedAfterRestart > 0 && noCrash,
      fallbackDuringOutage,
      resumedAfterRestart,
      events: allEvents.length,
    };
  } finally {
    await fakeDiscord.close();
    await stack.stopAll();
  }
}
