# Redis Schema + Atomic Permit Issuance (ENG-002)

## Keys

- `rl:global:{discord_identity}:{second}`
  - Per-identity global request window counter.
  - TTL: ~1.5s.
- `rl:route:{discord_identity}:{method}:{route}:{major_parameter}:{second}`
  - Coarse per-route request window counter.
  - TTL: ~1.5s.
- `rl:bucket_map:{method}:{route}`
  - Last observed `x-ratelimit-bucket` for route+method.
  - TTL: 24h.
- `rl:bucket_state:{discord_identity}:{bucket_hash}:{major_parameter}`
  - Observed bucket state (`limit`, `remaining`, `reset_at_unix_ms`, `scope`).
  - TTL: `reset_after + 5s`.
- `rl:invalid:{group_id}`
  - Invalid request rolling counter for 10-minute window.
  - TTL: 600s.
- `rl:guard:{group_id}`
  - Invalid-request guardrail cooldown lock.
  - TTL: configurable (`DMBO_GUARDRAIL_COOLDOWN_MS`).

## Atomic permit issuance

- Implemented with Redis Lua script (`REQUEST_TOKEN_LUA`) as a single `EVAL` operation.
- The script atomically:
  1. Checks guardrail (`rl:guard:*`).
  2. Checks observed bucket state if known.
  3. Increments + bounds global counter.
  4. Increments + bounds route counter.
  5. Decrements observed remaining bucket count when applicable.
- Returns `(granted, retry_after_ms, reason)` to avoid race conditions and double-grants under concurrency.

## Invalid-request guardrail

- Implemented with second Lua script (`INVALID_GUARD_LUA`) that atomically:
  1. Increments `rl:invalid:{group_id}` and sets 10-minute TTL.
  2. Activates `rl:guard:{group_id}` when threshold is reached.
