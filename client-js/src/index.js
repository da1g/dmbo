import { randomUUID } from "node:crypto";
import { LocalLimiter, sleep } from "./local-limiter.js";

const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:8787";

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

    const maxRetries = requestMeta.maxRetries ?? 100;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      const permit = await this.requestToken(permitRequest);
      if (permit.source === "fallback") {
        await this.localLimiter.acquire(
          `${permitRequest.discord_identity}:${permitRequest.method}:${permitRequest.route}:${permitRequest.major_parameter}`,
          permitRequest.discord_identity,
        );
        this.stats.fallbackPermits += 1;
        this.lastPermitSource = "fallback";
        this.onFallback({
          reason: permit.reason,
          requestId: permitRequest.request_id,
          atUnixMs: Date.now(),
        });

        let result;
        let executeError;
        try {
          result = await execute();
        } catch (error) {
          executeError = error;
          result = { statusCode: 500, headers: {} };
        }
        await this.reportResult(
          this.#buildReportPayload(permitRequest, result, permit.lease_id, permit.reason),
        );
        if (executeError) {
          throw executeError;
        }
        return result;
      }

      if (permit.granted) {
        this.stats.orchestratorGrants += 1;
        this.lastPermitSource = "orchestrator";
        let result;
        let executeError;
        try {
          result = await execute();
        } catch (error) {
          executeError = error;
          result = { statusCode: 500, headers: {} };
        }
        await this.reportResult(this.#buildReportPayload(permitRequest, result, permit.lease_id));
        if (executeError) {
          throw executeError;
        }
        return result;
      }

      this.stats.orchestratorDenials += 1;
      retryCount += 1;
      if (retryCount < maxRetries) {
        await sleep(Math.max(permit.retry_after_ms ?? 50, 10));
      }
    }

    throw new Error(`Maximum retries (${maxRetries}) exceeded for permit request`);
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
    
    const parseHeaderNumber = (value) => {
      if (value == null) return null;
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };
    
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
      x_ratelimit_limit: parseHeaderNumber(headers["x-ratelimit-limit"]),
      x_ratelimit_remaining: parseHeaderNumber(headers["x-ratelimit-remaining"]),
      x_ratelimit_reset_after_s: parseHeaderNumber(headers["x-ratelimit-reset-after"]),
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

export { LocalLimiter };
