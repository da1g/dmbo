import { randomUUID } from "node:crypto";
import { LocalLimiter } from "./local-limiter.js";

const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:8787";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeHeaders(headers) {
  if (!headers) {
    return {};
  }
  if (typeof headers.forEach === "function") {
    const out = {};
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
}

function parseRetryAfterMs(headers, fallbackMs = 0) {
  const retryAfter = headers["retry-after"];
  if (!retryAfter) {
    return fallbackMs;
  }
  const asNumber = Number(retryAfter);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.ceil(asNumber * 1000);
  }
  return fallbackMs;
}

export class DmboClient {
  constructor(options = {}) {
    this.orchestratorUrl = options.orchestratorUrl ?? DEFAULT_ORCHESTRATOR_URL;
    this.clientId = options.clientId ?? `client-${process.pid}`;
    this.groupId = options.groupId ?? "homelab-ip";
    this.discordIdentity = options.discordIdentity ?? this.clientId;
    this.timeoutMs = Math.max(250, options.timeoutMs ?? 3000);
    this.localLimiter =
      options.localLimiter ??
      new LocalLimiter({
        globalRps: options.localGlobalRps ?? 45,
        routeRps: options.localRouteRps ?? 5,
      });
    this.onFallback = options.onFallback ?? (() => {});
    this.stats = {
      orchestratorGrants: 0,
      orchestratorDenials: 0,
      fallbackPermits: 0,
      reportErrors: 0,
    };
    this.lastPermitSource = "orchestrator";
  }

  async withPermit(requestMeta, execute) {
    const permitRequest = {
      client_id: requestMeta.clientId ?? this.clientId,
      group_id: requestMeta.groupId ?? this.groupId,
      discord_identity: requestMeta.discordIdentity ?? this.discordIdentity,
      method: requestMeta.method ?? "POST",
      route: requestMeta.route ?? "/unknown",
      major_parameter: String(requestMeta.majorParameter ?? "unknown"),
      priority: requestMeta.priority ?? "normal",
      max_wait_ms: requestMeta.maxWaitMs ?? 2000,
      request_id: requestMeta.requestId ?? randomUUID(),
    };

    while (true) {
      const permit = await this.requestToken(permitRequest);
      if (permit.source === "fallback") {
        await this.localLimiter.acquire(
          `${permitRequest.discord_identity}:${permitRequest.method}:${permitRequest.route}:${permitRequest.major_parameter}`,
        );
        this.stats.fallbackPermits += 1;
        this.lastPermitSource = "fallback";
        this.onFallback({
          reason: permit.reason,
          requestId: permitRequest.request_id,
          atUnixMs: Date.now(),
        });

        const result = await execute();
        await this.reportResult(
          this.#buildReportPayload(permitRequest, result, permit.lease_id, permit.reason),
        );
        return result;
      }

      if (permit.granted) {
        this.stats.orchestratorGrants += 1;
        this.lastPermitSource = "orchestrator";
        const result = await execute();
        await this.reportResult(this.#buildReportPayload(permitRequest, result, permit.lease_id));
        return result;
      }

      this.stats.orchestratorDenials += 1;
      await sleep(Math.max(permit.retry_after_ms ?? 50, 10));
    }
  }

  async requestToken(payload) {
    const timeoutMs = Math.max(this.timeoutMs, (payload.max_wait_ms ?? 0) + 500);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.orchestratorUrl}/request_token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          granted: true,
          source: "fallback",
          reason: `orchestrator_http_${response.status}`,
          lease_id: null,
        };
      }
      const body = await response.json();
      return { ...body, source: "orchestrator" };
    } catch (_error) {
      return {
        granted: true,
        source: "fallback",
        reason: "orchestrator_down",
        lease_id: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async reportResult(payload) {
    try {
      await fetch(`${this.orchestratorUrl}/report_result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (_error) {
      this.stats.reportErrors += 1;
    }
  }

  #buildReportPayload(request, result, leaseId = null, fallbackReason = null) {
    const statusCode = result?.statusCode ?? result?.status ?? 200;
    const headers = normalizeHeaders(result?.headers);
    return {
      request_id: request.request_id,
      lease_id: leaseId,
      discord_identity: request.discord_identity,
      group_id: request.group_id,
      method: request.method,
      route: request.route,
      major_parameter: request.major_parameter,
      status_code: statusCode,
      x_ratelimit_bucket: headers["x-ratelimit-bucket"] ?? null,
      x_ratelimit_limit: headers["x-ratelimit-limit"]
        ? Number(headers["x-ratelimit-limit"])
        : null,
      x_ratelimit_remaining: headers["x-ratelimit-remaining"]
        ? Number(headers["x-ratelimit-remaining"])
        : null,
      x_ratelimit_reset_after_s: headers["x-ratelimit-reset-after"]
        ? Number(headers["x-ratelimit-reset-after"])
        : null,
      x_ratelimit_scope: headers["x-ratelimit-scope"] ?? null,
      retry_after_ms: parseRetryAfterMs(
        headers,
        headers["x-ratelimit-reset-after"]
          ? Math.ceil(Number(headers["x-ratelimit-reset-after"]) * 1000)
          : 0,
      ),
      fallback_reason: fallbackReason,
      observed_at_unix_ms: Date.now(),
    };
  }
}

export function attachDiscordJsRestTelemetry(rest, dmboClient, defaults = {}) {
  if (!rest || typeof rest.on !== "function" || !dmboClient) {
    return () => {};
  }

  const listeners = [];
  const discordIdentity = defaults.discordIdentity ?? dmboClient.discordIdentity ?? "unknown";
  const groupId = defaults.groupId ?? dmboClient.groupId ?? "homelab-ip";

  const onRateLimited = (data) => {
    dmboClient.reportResult({
      request_id: randomUUID(),
      lease_id: null,
      discord_identity: discordIdentity,
      group_id: groupId,
      method: data?.method ?? "UNKNOWN",
      route: data?.route ?? "/unknown",
      major_parameter: String(data?.majorParameter ?? "unknown"),
      status_code: 429,
      x_ratelimit_bucket: data?.hash ?? null,
      x_ratelimit_limit: data?.limit ?? null,
      x_ratelimit_remaining: data?.remaining ?? 0,
      x_ratelimit_reset_after_s:
        data?.retryAfter != null ? Number(data.retryAfter) / 1000 : null,
      x_ratelimit_scope: data?.scope ?? "user",
      retry_after_ms: data?.retryAfter ?? null,
      observed_at_unix_ms: Date.now(),
    });
  };
  rest.on("rateLimited", onRateLimited);
  listeners.push(["rateLimited", onRateLimited]);

  const onInvalidRequestWarning = (warning) => {
    dmboClient.reportResult({
      request_id: randomUUID(),
      lease_id: null,
      discord_identity: discordIdentity,
      group_id: groupId,
      method: "UNKNOWN",
      route: warning?.route ?? "/unknown",
      major_parameter: "unknown",
      status_code: warning?.statusCode ?? 401,
      observed_at_unix_ms: Date.now(),
    });
  };
  rest.on("invalidRequestWarning", onInvalidRequestWarning);
  listeners.push(["invalidRequestWarning", onInvalidRequestWarning]);

  return () => {
    for (const [event, listener] of listeners) {
      if (typeof rest.off === "function") {
        rest.off(event, listener);
      } else if (typeof rest.removeListener === "function") {
        rest.removeListener(event, listener);
      }
    }
  };
}

export { LocalLimiter };
