# DMBO API Spec (ENG-001)

## `POST /request_token`

Requests a permit for attempting a Discord REST call.

### Request

```json
{
  "client_id": "bot-1",
  "group_id": "homelab-ip",
  "discord_identity": "sha256-of-token-or-app-id",
  "method": "POST",
  "route": "/channels/:channel_id/messages",
  "major_parameter": "123456789012345678",
  "priority": "normal",
  "max_wait_ms": 2000,
  "request_id": "uuid-v4-or-v7"
}
```

### Response (granted)

```json
{
  "granted": true,
  "not_before_unix_ms": 1739325600123,
  "lease_id": "opaque",
  "reason": "ok"
}
```

### Response (denied)

```json
{
  "granted": false,
  "not_before_unix_ms": 1739325600273,
  "retry_after_ms": 150,
  "reason": "global_bucket_exhausted"
}
```

### Semantics

- Time fields are in milliseconds unless otherwise noted; `x_ratelimit_reset_after_s` is in seconds to match Discord's API response headers.
- `group_id` gates invalid-request guardrail at homelab/IP scope.
- `discord_identity` gates per-token global and bucket controls.
- `max_wait_ms > 0` enables server-side waiting before deny.

## `POST /report_result`

Reports the observed Discord response so the orchestrator can calibrate limits.

### Request

```json
{
  "request_id": "uuid-v4-or-v7",
  "lease_id": "opaque",
  "discord_identity": "sha256-of-token-or-app-id",
  "group_id": "homelab-ip",
  "method": "POST",
  "route": "/channels/:channel_id/messages",
  "major_parameter": "123456789012345678",
  "status_code": 429,
  "x_ratelimit_bucket": "abcd1234",
  "x_ratelimit_limit": 5,
  "x_ratelimit_remaining": 0,
  "x_ratelimit_reset_after_s": 1.234,
  "x_ratelimit_scope": "user",
  "retry_after_ms": 1234,
  "fallback_reason": "orchestrator_down",
  "observed_at_unix_ms": 1739325600456
}
```

### Response

```json
{ "ok": true }
```
