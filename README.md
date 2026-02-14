# dmbo

Discord Multi-Bot Orchestrator MVP (Option A) with:

dev note: if anyone stumbles on this, it was accidentally made public and since it is just a orchestrator, i've decided to keep it public for now. 

if you have any questions about it, feel free to message me here, or find me on discord @da1g


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
