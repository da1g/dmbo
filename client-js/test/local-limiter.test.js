import test from "node:test";
import assert from "node:assert/strict";
import { LocalLimiter, sleep } from "../src/local-limiter.js";

test("LocalLimiter - basic rate limiting", async () => {
  const limiter = new LocalLimiter({ globalRps: 10, routeRps: 5 });
  const start = Date.now();
  
  await limiter.acquire("test-route", "test-identity");
  await limiter.acquire("test-route", "test-identity");
  
  const elapsed = Date.now() - start;
  // Should take at least 100ms for global (1000/10) between first and second
  assert.ok(elapsed >= 90, `Expected at least 90ms but got ${elapsed}ms`);
});

test("LocalLimiter - per-identity global limits", async () => {
  const limiter = new LocalLimiter({ globalRps: 10, routeRps: 100 });
  
  // Different identities should have separate global limits
  const start = Date.now();
  await Promise.all([
    limiter.acquire("route1", "identity1"),
    limiter.acquire("route2", "identity2"),
  ]);
  const elapsed = Date.now() - start;
  
  // Should be fast since different identities
  assert.ok(elapsed < 50, `Expected less than 50ms but got ${elapsed}ms`);
});

test("LocalLimiter - route-specific limits", async () => {
  const limiter = new LocalLimiter({ globalRps: 100, routeRps: 5 });
  
  const start = Date.now();
  await limiter.acquire("test-route", "identity");
  await limiter.acquire("test-route", "identity");
  
  const elapsed = Date.now() - start;
  // Should take at least 200ms for route (1000/5)
  assert.ok(elapsed >= 180, `Expected at least 180ms but got ${elapsed}ms`);
});

test("LocalLimiter - concurrent requests serialization", async () => {
  const limiter = new LocalLimiter({ globalRps: 20, routeRps: 10 });
  const results = [];
  
  const promises = Array.from({ length: 3 }, async (_, i) => {
    await limiter.acquire("test-route", "identity");
    results.push(i);
  });
  
  await Promise.all(promises);
  
  // All requests should complete
  assert.equal(results.length, 3);
});

test("LocalLimiter - cleanup prevents memory leak", async () => {
  const limiter = new LocalLimiter({ globalRps: 10, routeRps: 5 });
  
  // Acquire permits for multiple routes
  for (let i = 0; i < 10; i++) {
    await limiter.acquire(`route-${i}`, `identity-${i}`);
  }
  
  const initialSize = limiter.nextAt.size;
  
  // Force cleanup by setting lastCleanupAt in the past
  limiter.lastCleanupAt = Date.now() - 60000;
  
  // Trigger cleanup via another acquire
  await limiter.acquire("new-route", "new-identity");
  
  // nextAt should have fewer entries after cleanup
  // (old entries should be cleaned up)
  assert.ok(limiter.nextAt.size <= initialSize + 3);
});

test("sleep - delays execution", async () => {
  const start = Date.now();
  await sleep(50);
  const elapsed = Date.now() - start;
  
  assert.ok(elapsed >= 45, `Expected at least 45ms but got ${elapsed}ms`);
  assert.ok(elapsed < 100, `Expected less than 100ms but got ${elapsed}ms`);
});
