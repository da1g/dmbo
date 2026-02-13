import test from "node:test";
import assert from "node:assert/strict";
import { DmboClient, normalizeHeaders, parseRetryAfterMs } from "../src/index.js";

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
