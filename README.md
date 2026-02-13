# dmbo

Discord Multi-Bot Orchestrator MVP (Option A) with:

- Redis-backed Rust orchestrator (`orchestrator/`)
- JavaScript client with safe fallback (`client-js/`)
- Simulation harness + acceptance tests (`sim/`)

## Quick start

```bash
npm --prefix sim test
```

## Planning and operations docs

- Implementation spec: `docs/dmbo-report.md`
- Runtime runbook: `docs/runbook.md`
