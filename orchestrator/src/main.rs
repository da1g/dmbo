use axum::{
    extract::State,
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use redis::{AsyncCommands, Script};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    env,
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{net::TcpListener, time::sleep};

const REQUEST_TOKEN_LUA: &str = r#"
local guard_key = KEYS[1]
local global_key = KEYS[2]
local route_key = KEYS[3]
local global_limit = tonumber(ARGV[1])
local route_limit = tonumber(ARGV[2])
local ttl_ms = tonumber(ARGV[3])
local min_retry_ms = tonumber(ARGV[4])

local guard_ttl = redis.call('PTTL', guard_key)
if guard_ttl and guard_ttl > 0 then
  if guard_ttl < min_retry_ms then guard_ttl = min_retry_ms end
  return {0, guard_ttl, 'invalid_guardrail_active'}
end

local global_count = redis.call('INCR', global_key)
if global_count == 1 then redis.call('PEXPIRE', global_key, ttl_ms) end
if global_count > global_limit then
  local retry_ms = redis.call('PTTL', global_key)
  if retry_ms < min_retry_ms then retry_ms = min_retry_ms end
  return {0, retry_ms, 'global_bucket_exhausted'}
end

local route_count = redis.call('INCR', route_key)
if route_count == 1 then redis.call('PEXPIRE', route_key, ttl_ms) end
if route_count > route_limit then
  local retry_ms = redis.call('PTTL', route_key)
  if retry_ms < min_retry_ms then retry_ms = min_retry_ms end
  return {0, retry_ms, 'route_bucket_exhausted'}
end

return {1, 0, 'ok'}
"#;

const INCR_WITH_EXPIRE_LUA: &str = r#"
local key = KEYS[1]
local ttl_seconds = tonumber(ARGV[1])

local count = redis.call('INCR', key)
if count == 1 then
  redis.call('EXPIRE', key, ttl_seconds)
end

return count
"#;

#[derive(Clone)]
struct Config {
    bind_addr: SocketAddr,
    redis_url: String,
    global_rps: u64,
    route_rps: u64,
    min_retry_ms: u64,
    invalid_threshold: u64,
    guardrail_cooldown_ms: u64,
    redis_required_for_health: bool,
}

impl Config {
    fn from_env() -> Self {
        let bind_addr = env::var("DMBO_BIND")
            .ok()
            .and_then(|value| value.parse::<SocketAddr>().ok())
            .unwrap_or_else(|| "127.0.0.1:8787".parse().expect("default bind should parse"));
        Self {
            bind_addr,
            redis_url: env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379/".to_string()),
            global_rps: env_u64("DMBO_GLOBAL_RPS", 50),
            route_rps: env_u64("DMBO_ROUTE_RPS", 5),
            min_retry_ms: env_u64("DMBO_MIN_RETRY_MS", 50),
            invalid_threshold: env_u64("DMBO_INVALID_THRESHOLD", 8000),
            guardrail_cooldown_ms: env_u64("DMBO_GUARDRAIL_COOLDOWN_MS", 30000),
            redis_required_for_health: env_bool("DMBO_REDIS_REQUIRED_FOR_HEALTH", true),
        }
    }
}

#[derive(Clone)]
struct Metrics {
    request_granted: Arc<AtomicU64>,
    request_denied: Arc<AtomicU64>,
    request_error: Arc<AtomicU64>,
    tokens_granted_total: Arc<AtomicU64>,
    tokens_denied_total: Arc<AtomicU64>,
    queue_depth: Arc<AtomicU64>,
    inflight_requests: Arc<AtomicU64>,
    redis_errors_total: Arc<AtomicU64>,
    observed_429_global: Arc<AtomicU64>,
    observed_429_user: Arc<AtomicU64>,
    observed_429_shared: Arc<AtomicU64>,
    observed_429_unknown: Arc<AtomicU64>,
    invalid_401: Arc<AtomicU64>,
    invalid_403: Arc<AtomicU64>,
    invalid_429: Arc<AtomicU64>,
    request_wait_ms_sum: Arc<AtomicU64>,
    request_wait_ms_count: Arc<AtomicU64>,
    redis_latency_ms_sum: Arc<AtomicU64>,
    redis_latency_ms_count: Arc<AtomicU64>,
}

impl Metrics {
    fn new() -> Self {
        Self {
            request_granted: Arc::new(AtomicU64::new(0)),
            request_denied: Arc::new(AtomicU64::new(0)),
            request_error: Arc::new(AtomicU64::new(0)),
            tokens_granted_total: Arc::new(AtomicU64::new(0)),
            tokens_denied_total: Arc::new(AtomicU64::new(0)),
            queue_depth: Arc::new(AtomicU64::new(0)),
            inflight_requests: Arc::new(AtomicU64::new(0)),
            redis_errors_total: Arc::new(AtomicU64::new(0)),
            observed_429_global: Arc::new(AtomicU64::new(0)),
            observed_429_user: Arc::new(AtomicU64::new(0)),
            observed_429_shared: Arc::new(AtomicU64::new(0)),
            observed_429_unknown: Arc::new(AtomicU64::new(0)),
            invalid_401: Arc::new(AtomicU64::new(0)),
            invalid_403: Arc::new(AtomicU64::new(0)),
            invalid_429: Arc::new(AtomicU64::new(0)),
            request_wait_ms_sum: Arc::new(AtomicU64::new(0)),
            request_wait_ms_count: Arc::new(AtomicU64::new(0)),
            redis_latency_ms_sum: Arc::new(AtomicU64::new(0)),
            redis_latency_ms_count: Arc::new(AtomicU64::new(0)),
        }
    }

    fn observe_request_wait_ms(&self, value: u64) {
        self.request_wait_ms_sum.fetch_add(value, Ordering::Relaxed);
        self.request_wait_ms_count.fetch_add(1, Ordering::Relaxed);
    }

    fn observe_redis_latency_ms(&self, value: u64) {
        self.redis_latency_ms_sum
            .fetch_add(value, Ordering::Relaxed);
        self.redis_latency_ms_count
            .fetch_add(1, Ordering::Relaxed);
    }
}

#[derive(Clone)]
struct AppState {
    redis: redis::Client,
    config: Config,
    metrics: Metrics,
    request_token_script: Script,
    incr_with_expire_script: Script,
}

#[derive(Debug, Deserialize)]
struct RequestTokenRequest {
    #[serde(default)]
    #[allow(dead_code)]
    client_id: String,
    #[serde(default = "default_group_id")]
    #[allow(dead_code)]
    group_id: String,
    discord_identity: String,
    method: String,
    route: String,
    major_parameter: String,
    #[serde(default = "default_priority")]
    #[allow(dead_code)]
    priority: String,
    #[serde(default)]
    max_wait_ms: u64,
    #[serde(default)]
    #[allow(dead_code)]
    request_id: String,
}

#[derive(Debug, Serialize)]
struct RequestTokenResponse {
    granted: bool,
    not_before_unix_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    lease_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u64>,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct ReportResultRequest {
    #[serde(default)]
    #[allow(dead_code)]
    request_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    lease_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    discord_identity: String,
    #[serde(default = "default_group_id")]
    group_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    method: String,
    #[serde(default)]
    #[allow(dead_code)]
    route: String,
    #[serde(default)]
    #[allow(dead_code)]
    major_parameter: String,
    #[serde(default)]
    status_code: u16,
    #[serde(default)]
    x_ratelimit_scope: Option<String>,
}

#[tokio::main]
async fn main() {
    let config = Config::from_env();
    let redis = redis::Client::open(config.redis_url.clone()).expect("invalid REDIS_URL");
    let state = Arc::new(AppState {
        redis,
        config: config.clone(),
        metrics: Metrics::new(),
        request_token_script: Script::new(REQUEST_TOKEN_LUA),
        incr_with_expire_script: Script::new(INCR_WITH_EXPIRE_LUA),
    });

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics))
        .route("/request_token", post(request_token))
        .route("/report_result", post(report_result))
        .with_state(state);

    let listener = TcpListener::bind(config.bind_addr)
        .await
        .expect("failed to bind orchestrator");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("orchestrator server failed");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn healthz(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let redis_ok = match state.redis.get_multiplexed_async_connection().await {
        Ok(mut conn) => redis::cmd("PING")
            .query_async::<_, String>(&mut conn)
            .await
            .is_ok(),
        Err(_) => false,
    };
    let status = if redis_ok || !state.config.redis_required_for_health {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "ok": status == StatusCode::OK,
            "redis": if redis_ok { "up" } else { "down" }
        })),
    )
}

async fn metrics(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let body = format!(
        "# HELP orchestrator_request_token_total request_token outcomes\n\
# TYPE orchestrator_request_token_total counter\n\
orchestrator_request_token_total{{outcome=\"granted\"}} {}\n\
orchestrator_request_token_total{{outcome=\"denied\"}} {}\n\
orchestrator_request_token_total{{outcome=\"error\"}} {}\n\
# HELP tokens_granted_total Granted permit count\n\
# TYPE tokens_granted_total counter\n\
tokens_granted_total {}\n\
# HELP tokens_denied_total Denied permit count\n\
# TYPE tokens_denied_total counter\n\
tokens_denied_total {}\n\
# HELP orchestrator_queue_depth Current server-side queue depth\n\
# TYPE orchestrator_queue_depth gauge\n\
orchestrator_queue_depth {}\n\
# HELP inflight_requests Inflight request_token handlers\n\
# TYPE inflight_requests gauge\n\
inflight_requests {}\n\
# HELP orchestrator_429_observed_total 429 observations by scope\n\
# TYPE orchestrator_429_observed_total counter\n\
orchestrator_429_observed_total{{scope=\"global\"}} {}\n\
orchestrator_429_observed_total{{scope=\"user\"}} {}\n\
orchestrator_429_observed_total{{scope=\"shared\"}} {}\n\
orchestrator_429_observed_total{{scope=\"unknown\"}} {}\n\
# HELP orchestrator_invalid_requests_total Invalid request counts by status\n\
# TYPE orchestrator_invalid_requests_total counter\n\
orchestrator_invalid_requests_total{{status=\"401\"}} {}\n\
orchestrator_invalid_requests_total{{status=\"403\"}} {}\n\
orchestrator_invalid_requests_total{{status=\"429\"}} {}\n\
# HELP redis_errors_total Redis errors\n\
# TYPE redis_errors_total counter\n\
redis_errors_total {}\n\
# HELP orchestrator_request_token_wait_ms Total wait milliseconds before request_token responses\n\
# TYPE orchestrator_request_token_wait_ms summary\n\
orchestrator_request_token_wait_ms_sum {}\n\
orchestrator_request_token_wait_ms_count {}\n\
# HELP redis_latency_ms Total redis roundtrip latency milliseconds\n\
# TYPE redis_latency_ms summary\n\
redis_latency_ms_sum {}\n\
redis_latency_ms_count {}\n\
# HELP redis_roundtrip_ms Alias summary for redis roundtrip latency milliseconds\n\
# TYPE redis_roundtrip_ms summary\n\
redis_roundtrip_ms_sum {}\n\
redis_roundtrip_ms_count {}\n",
        state.metrics.request_granted.load(Ordering::Relaxed),
        state.metrics.request_denied.load(Ordering::Relaxed),
        state.metrics.request_error.load(Ordering::Relaxed),
        state.metrics.tokens_granted_total.load(Ordering::Relaxed),
        state.metrics.tokens_denied_total.load(Ordering::Relaxed),
        state.metrics.queue_depth.load(Ordering::Relaxed),
        state.metrics.inflight_requests.load(Ordering::Relaxed),
        state.metrics.observed_429_global.load(Ordering::Relaxed),
        state.metrics.observed_429_user.load(Ordering::Relaxed),
        state.metrics.observed_429_shared.load(Ordering::Relaxed),
        state.metrics.observed_429_unknown.load(Ordering::Relaxed),
        state.metrics.invalid_401.load(Ordering::Relaxed),
        state.metrics.invalid_403.load(Ordering::Relaxed),
        state.metrics.invalid_429.load(Ordering::Relaxed),
        state.metrics.redis_errors_total.load(Ordering::Relaxed),
        state.metrics.request_wait_ms_sum.load(Ordering::Relaxed),
        state.metrics.request_wait_ms_count.load(Ordering::Relaxed),
        state.metrics.redis_latency_ms_sum.load(Ordering::Relaxed),
        state.metrics.redis_latency_ms_count.load(Ordering::Relaxed),
        state.metrics.redis_latency_ms_sum.load(Ordering::Relaxed),
        state.metrics.redis_latency_ms_count.load(Ordering::Relaxed),
    );
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    )
}

async fn request_token(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RequestTokenRequest>,
) -> impl IntoResponse {
    let _inflight = InflightGuard::new(state.metrics.clone());
    let started = unix_ms();
    let deadline = started.saturating_add(request.max_wait_ms);
    let mut waited_ms = 0_u64;

    loop {
        let decision = issue_permit(&state, &request).await;
        if decision.granted {
            state
                .metrics
                .request_granted
                .fetch_add(1, Ordering::Relaxed);
            state
                .metrics
                .tokens_granted_total
                .fetch_add(1, Ordering::Relaxed);
            state.metrics.observe_request_wait_ms(waited_ms);
            let response = RequestTokenResponse {
                granted: true,
                not_before_unix_ms: unix_ms(),
                lease_id: Some(format!("lease-{}-{}", request.request_id, unix_ms())),
                retry_after_ms: None,
                reason: decision.reason,
            };
            return (StatusCode::OK, Json(response));
        }

        let now = unix_ms();
        let retry_after_ms = decision.retry_after_ms.max(state.config.min_retry_ms);
        let can_wait = request.max_wait_ms > 0
            && now < deadline
            && now.saturating_add(retry_after_ms) <= deadline
            && waited_ms.saturating_add(retry_after_ms) <= request.max_wait_ms;

        if can_wait {
            state.metrics.queue_depth.fetch_add(1, Ordering::Relaxed);
            sleep(Duration::from_millis(retry_after_ms)).await;
            state.metrics.queue_depth.fetch_sub(1, Ordering::Relaxed);
            waited_ms = waited_ms.saturating_add(retry_after_ms);
            continue;
        }

        if decision.errored {
            state.metrics.request_error.fetch_add(1, Ordering::Relaxed);
        } else {
            state
                .metrics
                .request_denied
                .fetch_add(1, Ordering::Relaxed);
        }
        state
            .metrics
            .tokens_denied_total
            .fetch_add(1, Ordering::Relaxed);
        state.metrics.observe_request_wait_ms(waited_ms);

        let response = RequestTokenResponse {
            granted: false,
            not_before_unix_ms: now.saturating_add(retry_after_ms),
            lease_id: None,
            retry_after_ms: Some(retry_after_ms),
            reason: decision.reason,
        };
        return (StatusCode::OK, Json(response));
    }
}

async fn report_result(
    State(state): State<Arc<AppState>>,
    Json(report): Json<ReportResultRequest>,
) -> impl IntoResponse {
    if report.status_code == 429 {
        match report.x_ratelimit_scope.as_deref() {
            Some("global") => state
                .metrics
                .observed_429_global
                .fetch_add(1, Ordering::Relaxed),
            Some("user") => state
                .metrics
                .observed_429_user
                .fetch_add(1, Ordering::Relaxed),
            Some("shared") => state
                .metrics
                .observed_429_shared
                .fetch_add(1, Ordering::Relaxed),
            _ => state
                .metrics
                .observed_429_unknown
                .fetch_add(1, Ordering::Relaxed),
        };
    }

    match report.status_code {
        401 => {
            state.metrics.invalid_401.fetch_add(1, Ordering::Relaxed);
        }
        403 => {
            state.metrics.invalid_403.fetch_add(1, Ordering::Relaxed);
        }
        429 if report.x_ratelimit_scope.as_deref() != Some("shared") => {
            state.metrics.invalid_429.fetch_add(1, Ordering::Relaxed);
        }
        _ => {}
    }

    let mut conn = match state.redis.get_multiplexed_async_connection().await {
        Ok(conn) => conn,
        Err(_) => {
            state
                .metrics
                .redis_errors_total
                .fetch_add(1, Ordering::Relaxed);
            return (StatusCode::OK, Json(json!({ "ok": false })));
        }
    };
    let key = format!("rl:report:{}:{}", report.status_code, report.request_id);
    let persisted: redis::RedisResult<()> = conn.set_ex(key, 1_u8, 300).await;
    if persisted.is_err() {
        state
            .metrics
            .redis_errors_total
            .fetch_add(1, Ordering::Relaxed);
        return (StatusCode::OK, Json(json!({ "ok": false })));
    }

    if counts_toward_invalid_limit(report.status_code, report.x_ratelimit_scope.as_deref()) {
        let group = normalize_key_part(&report.group_id);
        let invalid_key = format!("rl:invalid:{group}");
        let guard_key = format!("rl:guard:{group}");

        let invalid_count: redis::RedisResult<i64> = state
            .incr_with_expire_script
            .key(&invalid_key)
            .arg(600)
            .invoke_async(&mut conn)
            .await;
        let invalid_count = match invalid_count {
            Ok(count) => count,
            Err(_) => {
                state
                    .metrics
                    .redis_errors_total
                    .fetch_add(1, Ordering::Relaxed);
                return (StatusCode::OK, Json(json!({ "ok": false })));
            }
        };

        if invalid_count as u64 >= state.config.invalid_threshold {
            let guard_result = redis::cmd("PSETEX")
                .arg(&guard_key)
                .arg(state.config.guardrail_cooldown_ms as i64)
                .arg(invalid_count)
                .query_async::<_, ()>(&mut conn)
                .await;
            if guard_result.is_err() {
                state
                    .metrics
                    .redis_errors_total
                    .fetch_add(1, Ordering::Relaxed);
                return (StatusCode::OK, Json(json!({ "ok": false })));
            }
        }
    }
    (StatusCode::OK, Json(json!({ "ok": true })))
}

struct PermitDecision {
    granted: bool,
    retry_after_ms: u64,
    reason: String,
    errored: bool,
}

struct InflightGuard {
    metrics: Metrics,
}

impl InflightGuard {
    fn new(metrics: Metrics) -> Self {
        metrics
            .inflight_requests
            .fetch_add(1, Ordering::Relaxed);
        Self { metrics }
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.metrics
            .inflight_requests
            .fetch_sub(1, Ordering::Relaxed);
    }
}

async fn issue_permit(state: &Arc<AppState>, request: &RequestTokenRequest) -> PermitDecision {
    let now_ms = unix_ms();
    let second = now_ms / 1000;
    let guard_key = format!("rl:guard:{}", normalize_key_part(&request.group_id));
    let global_key = format!(
        "rl:global:{}:{second}",
        normalize_key_part(&request.discord_identity)
    );
    let route_key = format!(
        "rl:route:{}:{}:{}:{}:{second}",
        normalize_key_part(&request.discord_identity),
        normalize_key_part(&request.method),
        normalize_key_part(&request.route),
        normalize_key_part(&request.major_parameter)
    );

    let mut conn = match state.redis.get_multiplexed_async_connection().await {
        Ok(conn) => conn,
        Err(_) => {
            state
                .metrics
                .redis_errors_total
                .fetch_add(1, Ordering::Relaxed);
            return PermitDecision {
                granted: false,
                retry_after_ms: state.config.min_retry_ms,
                reason: "redis_unavailable".to_string(),
                errored: true,
            };
        }
    };

    let started = Instant::now();
    let result: redis::RedisResult<(i32, i64, String)> = state
        .request_token_script
        .key(guard_key)
        .key(global_key)
        .key(route_key)
        .arg(state.config.global_rps as i64)
        .arg(state.config.route_rps as i64)
        .arg(1_500_i64)
        .arg(state.config.min_retry_ms as i64)
        .invoke_async(&mut conn)
        .await;
    state
        .metrics
        .observe_redis_latency_ms(started.elapsed().as_millis() as u64);

    match result {
        Ok((granted, retry_after_ms, reason)) => PermitDecision {
            granted: granted == 1,
            retry_after_ms: retry_after_ms.max(0) as u64,
            reason,
            errored: false,
        },
        Err(_) => {
            state
                .metrics
                .redis_errors_total
                .fetch_add(1, Ordering::Relaxed);
            PermitDecision {
                granted: false,
                retry_after_ms: state.config.min_retry_ms,
                reason: "redis_error".to_string(),
                errored: true,
            }
        }
    }
}

fn normalize_key_part(input: &str) -> String {
    input
        .trim()
        .replace([' ', ':', '/', '\\', '\t', '\n'], "_")
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as u64
}

fn env_u64(key: &str, default: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
}

fn env_bool(key: &str, default: bool) -> bool {
    env::var(key)
        .ok()
        .and_then(|value| match value.to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" => Some(true),
            "0" | "false" | "no" => Some(false),
            _ => None,
        })
        .unwrap_or(default)
}

fn counts_toward_invalid_limit(status_code: u16, scope: Option<&str>) -> bool {
    match status_code {
        401 | 403 => true,
        429 => scope != Some("shared"),
        _ => false,
    }
}

fn default_group_id() -> String {
    "homelab-ip".to_string()
}

fn default_priority() -> String {
    "normal".to_string()
}
