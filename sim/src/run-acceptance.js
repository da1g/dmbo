import {
  runBurstAcceptanceTest,
  runOrchestratorDownAcceptanceTest,
} from "./harness.js";

async function main() {
  const burst = await runBurstAcceptanceTest();
  const orchestratorDown = await runOrchestratorDownAcceptanceTest();

  const summary = {
    burst,
    orchestratorDown,
    passed: burst.passed && orchestratorDown.passed,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
