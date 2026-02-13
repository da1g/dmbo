import test from "node:test";
import assert from "node:assert/strict";
import {
  runBurstAcceptanceTest,
  runOrchestratorDownAcceptanceTest,
} from "../src/harness.js";

test("burst acceptance: no sustained 429s after warmup", { timeout: 260000 }, async () => {
  const result = await runBurstAcceptanceTest();
  assert.equal(result.passed, true, JSON.stringify(result, null, 2));
});

test(
  "orchestrator-down acceptance: clients fallback and recover",
  { timeout: 140000 },
  async () => {
    const result = await runOrchestratorDownAcceptanceTest();
    assert.equal(result.passed, true, JSON.stringify(result, null, 2));
  },
);
