import { createHash } from "node:crypto";
import { createServer } from "node:http";

function keyFor(identity, method, route, major) {
  return `${identity}:${method}:${route}:${major}`;
}

function routeBucket(method, route) {
  return createHash("sha1").update(`${method}:${route}`).digest("hex").slice(0, 10);
}

export async function startFakeDiscordServer({
  port = 9980,
  globalLimit = 50,
  routeLimit = 5,
} = {}) {
  const state = {
    globalCounters: new Map(),
    routeCounters: new Map(),
    responses: [],
  };

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/request") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    const now = Date.now();
    const second = Math.floor(now / 1000);
    const nextSecondMs = (second + 1) * 1000;
    const resetAfterSeconds = Math.max(0.001, (nextSecondMs - now) / 1000);

    const identity = String(req.headers["x-discord-identity"] ?? "unknown");
    const method = String(req.headers["x-dmbo-method"] ?? "POST").toUpperCase();
    const route = String(req.headers["x-dmbo-route"] ?? "/unknown");
    const major = String(req.headers["x-dmbo-major"] ?? "unknown");

    const globalKey = `${identity}:${second}`;
    const routeKey = `${keyFor(identity, method, route, major)}:${second}`;
    const bucket = routeBucket(method, route);

    const globalCount = (state.globalCounters.get(globalKey) ?? 0) + 1;
    const routeCount = (state.routeCounters.get(routeKey) ?? 0) + 1;
    state.globalCounters.set(globalKey, globalCount);
    state.routeCounters.set(routeKey, routeCount);

    const globalExceeded = globalCount > globalLimit;
    const routeExceeded = routeCount > routeLimit;
    const statusCode = globalExceeded || routeExceeded ? 429 : 200;
    const scope = globalExceeded ? "global" : "user";

    const retryAfterSeconds = Number(resetAfterSeconds.toFixed(3));
    const remaining = Math.max(0, routeLimit - routeCount);

    res.setHeader("x-ratelimit-bucket", bucket);
    res.setHeader("x-ratelimit-limit", String(routeLimit));
    res.setHeader("x-ratelimit-remaining", String(remaining));
    res.setHeader("x-ratelimit-reset-after", String(retryAfterSeconds));
    if (statusCode === 429) {
      res.setHeader("x-ratelimit-scope", scope);
      res.setHeader("retry-after", String(retryAfterSeconds));
    }

    state.responses.push({
      ts: now,
      identity,
      statusCode,
      scope: statusCode === 429 ? scope : null,
    });

    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: statusCode !== 429,
        statusCode,
        retry_after: statusCode === 429 ? retryAfterSeconds : 0,
      }),
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: async () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}

export async function sendFakeDiscordRequest(baseUrl, request) {
  const response = await fetch(`${baseUrl}/request`, {
    method: "POST",
    headers: {
      "x-discord-identity": request.discordIdentity,
      "x-dmbo-method": request.method,
      "x-dmbo-route": request.route,
      "x-dmbo-major": String(request.majorParameter),
    },
  });

  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    status: response.status,
    headers,
  };
}
