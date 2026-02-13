import test from "node:test";
import assert from "node:assert/strict";
import { DmboClient, normalizeHeaders, parseRetryAfterMs, attachDiscordJsRestTelemetry } from "../src/index.js";

test("normalizeHeaders - handles Headers object", () => {
  const headers = new Map([
    ["Content-Type", "application/json"],
    ["X-RateLimit-Limit", "50"],
  ]);
  const normalized = normalizeHeaders(headers);
  
  assert.equal(normalized["content-type"], "application/json");
  assert.equal(normalized["x-ratelimit-limit"], "50");
});

test("normalizeHeaders - handles plain object", () => {
  const headers = {
    "Content-Type": "application/json",
    "X-RateLimit-Limit": "50",
  };
  const normalized = normalizeHeaders(headers);
  
  assert.equal(normalized["content-type"], "application/json");
  assert.equal(normalized["x-ratelimit-limit"], "50");
});

test("normalizeHeaders - handles null/undefined", () => {
  assert.deepEqual(normalizeHeaders(null), {});
  assert.deepEqual(normalizeHeaders(undefined), {});
});

test("parseRetryAfterMs - parses numeric value", () => {
  const headers = { "retry-after": "2.5" };
  const result = parseRetryAfterMs(headers);
  assert.equal(result, 2500);
});

test("parseRetryAfterMs - returns fallback for missing header", () => {
  const headers = {};
  const result = parseRetryAfterMs(headers, 1000);
  assert.equal(result, 1000);
});

test("parseRetryAfterMs - returns fallback for invalid value", () => {
  const headers = { "retry-after": "invalid" };
  const result = parseRetryAfterMs(headers, 500);
  assert.equal(result, 500);
});

test("DmboClient - constructor sets defaults", () => {
  const client = new DmboClient();
  
  assert.ok(client.orchestratorUrl);
  assert.ok(client.clientId);
  assert.ok(client.groupId);
  assert.ok(client.discordIdentity);
  assert.ok(client.localLimiter);
  assert.equal(client.stats.orchestratorGrants, 0);
  assert.equal(client.stats.orchestratorDenials, 0);
  assert.equal(client.stats.fallbackPermits, 0);
});

test("DmboClient - constructor accepts custom options", () => {
  const client = new DmboClient({
    orchestratorUrl: "http://custom:9999",
    clientId: "test-client",
    groupId: "test-group",
    discordIdentity: "test-identity",
    timeoutMs: 5000,
  });
  
  assert.equal(client.orchestratorUrl, "http://custom:9999");
  assert.equal(client.clientId, "test-client");
  assert.equal(client.groupId, "test-group");
  assert.equal(client.discordIdentity, "test-identity");
  assert.equal(client.timeoutMs, 5000);
});

test("DmboClient - buildReportPayload handles NaN values", () => {
  const client = new DmboClient();
  
  const request = {
    request_id: "test-req",
    discord_identity: "test-id",
    group_id: "test-group",
    method: "GET",
    route: "/test",
    major_parameter: "123",
  };
  
  const result = {
    statusCode: 200,
    headers: {
      "x-ratelimit-limit": "not-a-number",
      "x-ratelimit-remaining": "50",
      "x-ratelimit-reset-after": "invalid",
    },
  };
  
  const payload = client._testBuildReportPayload(request, result);
  
  // NaN should be converted to null
  assert.equal(payload.x_ratelimit_limit, null);
  assert.equal(payload.x_ratelimit_remaining, 50);
  assert.equal(payload.x_ratelimit_reset_after_s, null);
});

test("DmboClient - buildReportPayload handles missing headers", () => {
  const client = new DmboClient();
  
  const request = {
    request_id: "test-req",
    discord_identity: "test-id",
    group_id: "test-group",
    method: "GET",
    route: "/test",
    major_parameter: "123",
  };
  
  const result = {
    statusCode: 404,
    headers: {},
  };
  
  const payload = client._testBuildReportPayload(request, result);
  
  assert.equal(payload.status_code, 404);
  assert.equal(payload.x_ratelimit_limit, null);
  assert.equal(payload.x_ratelimit_remaining, null);
  assert.equal(payload.x_ratelimit_bucket, null);
});

test("DmboClient - withPermit respects maxRetries", async () => {
  const client = new DmboClient();
  
  // Mock requestToken to always deny
  client.requestToken = async () => ({
    granted: false,
    retry_after_ms: 1,
    source: "orchestrator",
  });
  
  const requestMeta = {
    route: "/test",
    maxRetries: 3,
  };
  
  await assert.rejects(
    async () => {
      await client.withPermit(requestMeta, async () => ({ statusCode: 200 }));
    },
    { message: /Maximum retries \(3\) exceeded/ }
  );
  
  assert.equal(client.stats.orchestratorDenials, 3);
});

test("DmboClient - withPermit handles execute errors", async () => {
  const client = new DmboClient();
  
  // Mock requestToken to grant immediately
  client.requestToken = async () => ({
    granted: true,
    source: "orchestrator",
    lease_id: "test-lease",
  });
  
  let reportedPayload = null;
  client.reportResult = async (payload) => {
    reportedPayload = payload;
  };
  
  const requestMeta = {
    route: "/test",
    maxRetries: 1,
  };
  
  const testError = new Error("Execute failed");
  
  await assert.rejects(
    async () => {
      await client.withPermit(requestMeta, async () => {
        throw testError;
      });
    },
    testError
  );
  
  // Should still report result with status 500
  assert.ok(reportedPayload);
  assert.equal(reportedPayload.status_code, 500);
  assert.equal(reportedPayload.lease_id, "test-lease");
});

test("attachDiscordJsRestTelemetry - attaches and cleans up event listeners", () => {
  const events = new Map();
  const mockRest = {
    on: (event, listener) => {
      if (!events.has(event)) events.set(event, []);
      events.get(event).push(listener);
    },
    off: (event, listener) => {
      const listeners = events.get(event) || [];
      const index = listeners.indexOf(listener);
      if (index > -1) listeners.splice(index, 1);
    },
  };

  let reportedPayload = null;
  const mockClient = {
    discordIdentity: "test-identity",
    groupId: "test-group",
    reportResult: (payload) => {
      reportedPayload = payload;
    },
  };

  const cleanup = attachDiscordJsRestTelemetry(mockRest, mockClient);

  assert.equal(events.get("rateLimited")?.length, 1);
  assert.equal(events.get("invalidRequestWarning")?.length, 1);

  cleanup();

  assert.equal(events.get("rateLimited")?.length, 0);
  assert.equal(events.get("invalidRequestWarning")?.length, 0);
});

test("attachDiscordJsRestTelemetry - transforms rateLimited event data correctly", () => {
  const mockRest = {
    on: () => {},
  };

  let reportedPayload = null;
  const mockClient = {
    discordIdentity: "test-identity",
    groupId: "test-group",
    reportResult: (payload) => {
      reportedPayload = payload;
    },
  };

  const listeners = [];
  mockRest.on = (event, listener) => {
    listeners.push({ event, listener });
  };

  attachDiscordJsRestTelemetry(mockRest, mockClient);

  const rateLimitListener = listeners.find((l) => l.event === "rateLimited")?.listener;
  assert.ok(rateLimitListener);

  const rateLimitData = {
    method: "POST",
    route: "/channels/123/messages",
    majorParameter: "123",
    hash: "abc123",
    limit: 5,
    remaining: 2,
    retryAfter: 2500,
    scope: "shared",
  };

  rateLimitListener(rateLimitData);

  assert.ok(reportedPayload);
  assert.equal(reportedPayload.discord_identity, "test-identity");
  assert.equal(reportedPayload.group_id, "test-group");
  assert.equal(reportedPayload.method, "POST");
  assert.equal(reportedPayload.route, "/channels/123/messages");
  assert.equal(reportedPayload.major_parameter, "123");
  assert.equal(reportedPayload.status_code, 429);
  assert.equal(reportedPayload.x_ratelimit_bucket, "abc123");
  assert.equal(reportedPayload.x_ratelimit_limit, 5);
  assert.equal(reportedPayload.x_ratelimit_remaining, 2);
  assert.equal(reportedPayload.x_ratelimit_reset_after_s, 2.5);
  assert.equal(reportedPayload.x_ratelimit_scope, "shared");
  assert.equal(reportedPayload.retry_after_ms, 2500);
  assert.ok(reportedPayload.request_id);
  assert.equal(reportedPayload.lease_id, null);
});

test("attachDiscordJsRestTelemetry - handles missing fields in rateLimited event", () => {
  const mockRest = {
    on: () => {},
  };

  let reportedPayload = null;
  const mockClient = {
    discordIdentity: "test-identity",
    groupId: "test-group",
    reportResult: (payload) => {
      reportedPayload = payload;
    },
  };

  const listeners = [];
  mockRest.on = (event, listener) => {
    listeners.push({ event, listener });
  };

  attachDiscordJsRestTelemetry(mockRest, mockClient);

  const rateLimitListener = listeners.find((l) => l.event === "rateLimited")?.listener;
  rateLimitListener({});

  assert.ok(reportedPayload);
  assert.equal(reportedPayload.method, "UNKNOWN");
  assert.equal(reportedPayload.route, "/unknown");
  assert.equal(reportedPayload.major_parameter, "unknown");
  assert.equal(reportedPayload.x_ratelimit_bucket, null);
  assert.equal(reportedPayload.x_ratelimit_limit, null);
  assert.equal(reportedPayload.x_ratelimit_remaining, null);
  assert.equal(reportedPayload.x_ratelimit_reset_after_s, null);
  assert.equal(reportedPayload.x_ratelimit_scope, null);
  assert.equal(reportedPayload.retry_after_ms, null);
});

test("attachDiscordJsRestTelemetry - validates numeric fields in rateLimited event", () => {
  const mockRest = {
    on: () => {},
  };

  let reportedPayload = null;
  const mockClient = {
    reportResult: (payload) => {
      reportedPayload = payload;
    },
  };

  const listeners = [];
  mockRest.on = (event, listener) => {
    listeners.push({ event, listener });
  };

  attachDiscordJsRestTelemetry(mockRest, mockClient);

  const rateLimitListener = listeners.find((l) => l.event === "rateLimited")?.listener;
  
  // Test with invalid numeric values
  rateLimitListener({
    limit: NaN,
    remaining: "not-a-number",
  });

  assert.equal(reportedPayload.x_ratelimit_limit, null);
  assert.equal(reportedPayload.x_ratelimit_remaining, null);

  // Test with valid numeric values
  rateLimitListener({
    limit: 10,
    remaining: 5,
  });

  assert.equal(reportedPayload.x_ratelimit_limit, 10);
  assert.equal(reportedPayload.x_ratelimit_remaining, 5);
});

test("attachDiscordJsRestTelemetry - transforms invalidRequestWarning event data correctly", () => {
  const mockRest = {
    on: () => {},
  };

  let reportedPayload = null;
  const mockClient = {
    discordIdentity: "test-identity",
    groupId: "test-group",
    reportResult: (payload) => {
      reportedPayload = payload;
    },
  };

  const listeners = [];
  mockRest.on = (event, listener) => {
    listeners.push({ event, listener });
  };

  attachDiscordJsRestTelemetry(mockRest, mockClient);

  const warningListener = listeners.find((l) => l.event === "invalidRequestWarning")?.listener;
  assert.ok(warningListener);

  warningListener({
    route: "/channels/456/messages",
    statusCode: 403,
  });

  assert.ok(reportedPayload);
  assert.equal(reportedPayload.discord_identity, "test-identity");
  assert.equal(reportedPayload.group_id, "test-group");
  assert.equal(reportedPayload.method, "UNKNOWN");
  assert.equal(reportedPayload.route, "/channels/456/messages");
  assert.equal(reportedPayload.major_parameter, "unknown");
  assert.equal(reportedPayload.status_code, 403);
  assert.ok(reportedPayload.request_id);
  assert.equal(reportedPayload.lease_id, null);
});

test("attachDiscordJsRestTelemetry - uses default values from dmboClient", () => {
  const mockRest = {
    on: () => {},
  };

  let reportedPayload = null;
  const mockClient = {
    discordIdentity: "client-identity",
    groupId: "client-group",
    reportResult: (payload) => {
      reportedPayload = payload;
    },
  };

  const listeners = [];
  mockRest.on = (event, listener) => {
    listeners.push({ event, listener });
  };

  attachDiscordJsRestTelemetry(mockRest, mockClient);

  const rateLimitListener = listeners.find((l) => l.event === "rateLimited")?.listener;
  rateLimitListener({});

  assert.equal(reportedPayload.discord_identity, "client-identity");
  assert.equal(reportedPayload.group_id, "client-group");
});

test("attachDiscordJsRestTelemetry - uses custom defaults parameter", () => {
  const mockRest = {
    on: () => {},
  };

  let reportedPayload = null;
  const mockClient = {
    discordIdentity: "client-identity",
    groupId: "client-group",
    reportResult: (payload) => {
      reportedPayload = payload;
    },
  };

  const listeners = [];
  mockRest.on = (event, listener) => {
    listeners.push({ event, listener });
  };

  attachDiscordJsRestTelemetry(mockRest, mockClient, {
    discordIdentity: "custom-identity",
    groupId: "custom-group",
  });

  const rateLimitListener = listeners.find((l) => l.event === "rateLimited")?.listener;
  rateLimitListener({});

  assert.equal(reportedPayload.discord_identity, "custom-identity");
  assert.equal(reportedPayload.group_id, "custom-group");
});

test("attachDiscordJsRestTelemetry - returns no-op cleanup for invalid rest", () => {
  const mockClient = {
    reportResult: () => {},
  };

  const cleanup1 = attachDiscordJsRestTelemetry(null, mockClient);
  assert.equal(typeof cleanup1, "function");

  const cleanup2 = attachDiscordJsRestTelemetry({}, mockClient);
  assert.equal(typeof cleanup2, "function");

  const cleanup3 = attachDiscordJsRestTelemetry({ on: "not-a-function" }, mockClient);
  assert.equal(typeof cleanup3, "function");

  const cleanup4 = attachDiscordJsRestTelemetry({ on: () => {} }, null);
  assert.equal(typeof cleanup4, "function");
});

test("attachDiscordJsRestTelemetry - cleanup works with removeListener fallback", () => {
  const events = new Map();
  const mockRest = {
    on: (event, listener) => {
      if (!events.has(event)) events.set(event, []);
      events.get(event).push(listener);
    },
    removeListener: (event, listener) => {
      const listeners = events.get(event) || [];
      const index = listeners.indexOf(listener);
      if (index > -1) listeners.splice(index, 1);
    },
  };

  const mockClient = {
    reportResult: () => {},
  };

  const cleanup = attachDiscordJsRestTelemetry(mockRest, mockClient);

  assert.equal(events.get("rateLimited")?.length, 1);
  assert.equal(events.get("invalidRequestWarning")?.length, 1);

  cleanup();

  assert.equal(events.get("rateLimited")?.length, 0);
  assert.equal(events.get("invalidRequestWarning")?.length, 0);
});
