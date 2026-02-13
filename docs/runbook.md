# DMBO Runbook + Dashboard Notes (ENG-009)

## Local development

```bash
cargo build --manifest-path orchestrator/Cargo.toml
npm --prefix sim test
```

## Runtime configuration

- `DMBO_BIND` (default `127.0.0.1:8787`)
- `REDIS_URL` (default `redis://127.0.0.1:6379/`)
- `DMBO_GLOBAL_RPS` (default `50`)
- `DMBO_ROUTE_RPS` (default `5`)
- `DMBO_MIN_RETRY_MS` (default `50`)
- `DMBO_INVALID_THRESHOLD` (default `8000`)
- `DMBO_GUARDRAIL_COOLDOWN_MS` (default `30000`)

## Health and metrics

- `GET /healthz` returns 200 when service is up and Redis is reachable.
- `GET /metrics` exposes Prometheus text with:
  - `orchestrator_request_token_total`
  - `tokens_granted_total`
  - `tokens_denied_total`
  - `orchestrator_queue_depth`
  - `inflight_requests`
  - `orchestrator_429_observed_total{scope=*}`
  - `orchestrator_invalid_requests_total{status=*}`
  - `redis_latency_ms*` / `redis_roundtrip_ms*`
  - `redis_errors_total`
  - `orchestrator_fallback_events_total{reason=*}`

## Failure modes

### Orchestrator down

- JS clients automatically fall back to local limiter mode.
- Expected signal: `orchestrator_fallback_events_total{reason="orchestrator_down"}` increases.

### Redis down

- Orchestrator uses conservative in-memory fallback limiter.
- Expected signal: `redis_errors_total` and `orchestrator_fallback_events_total{reason="redis_down"}` increase.

### 429 storm

- Inspect:
  - `orchestrator_429_observed_total{scope=*}`
  - `orchestrator_invalid_requests_total{status="429"}`
  - `orchestrator_queue_depth`
- If invalid threshold is crossed, guardrail rejects permits with reason `invalid_guardrail_active`.

## Acceptance commands

```bash
npm --prefix sim run acceptance
```

Expected: burst + orchestrator-down both pass.
