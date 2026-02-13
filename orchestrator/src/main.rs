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
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::net::TcpListener;

const REQUEST_TOKEN_LUA: &str = r#"
local global_key = KEYS[1]
local route_key = KEYS[2]
local global_limit = tonumber(ARGV[1])
local route_limit = tonumber(ARGV[2])
local ttl_ms = tonumber(ARGV[3])
local min_retry_ms = tonumber(ARGV[4])

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

#[derive(Clone)]
struct Config {
    bind_addr: SocketAddr,
    redis_url: String,
    global_rps: u64,
    route_rps: u64,
    min_retry_ms: u64,
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
        }
    }
}

#[derive(Clone)]
struct Metrics {
    granted: Arc<AtomicU64>,
    denied: Arc<AtomicU64>,
}

impl Metrics {
    fn new() -> Self {
        Self {
            granted: Arc::new(AtomicU64::new(0)),
            denied: Arc::new(AtomicU64::new(0)),
        }
    }
}

#[derive(Clone)]
struct AppState {
    redis: redis::Client,
    config: Config,
    metrics: Metrics,
    request_token_script: Script,
}

#[derive(Debug, Deserialize)]
struct RequestTokenRequest {
    discord_identity: String,
    method: String,
    route: String,
    major_parameter: String,
    #[serde(default)]
    #[allow(dead_code)]
    request_id: String,
}

#[derive(Debug, Serialize)]
struct RequestTokenResponse {
    granted: bool,
    not_before_unix_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u64>,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct ReportResultRequest {
    #[serde(default)]
    request_id: String,
    #[serde(default)]
    status_code: u16,
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
    let status = if redis_ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(json!({ "ok": redis_ok })))
}

async fn metrics(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let body = format!(
        "# HELP tokens_granted_total Granted permit count\n\
# TYPE tokens_granted_total counter\n\
tokens_granted_total {}\n\
# HELP tokens_denied_total Denied permit count\n\
# TYPE tokens_denied_total counter\n\
tokens_denied_total {}\n\
# HELP orchestrator_request_token_total request_token outcomes\n\
# TYPE orchestrator_request_token_total counter\n\
orchestrator_request_token_total{{outcome=\"granted\"}} {}\n\
orchestrator_request_token_total{{outcome=\"denied\"}} {}\n",
        state.metrics.granted.load(Ordering::Relaxed),
        state.metrics.denied.load(Ordering::Relaxed),
        state.metrics.granted.load(Ordering::Relaxed),
        state.metrics.denied.load(Ordering::Relaxed),
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
    let now_ms = unix_ms();
    let second = now_ms / 1000;
    let global_key = format!("rl:global:{}:{second}", normalize_key_part(&request.discord_identity));
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
            state.metrics.denied.fetch_add(1, Ordering::Relaxed);
            let response = RequestTokenResponse {
                granted: false,
                not_before_unix_ms: now_ms + state.config.min_retry_ms,
                retry_after_ms: Some(state.config.min_retry_ms),
                reason: "redis_unavailable".to_string(),
            };
            return (StatusCode::OK, Json(response));
        }
    };

    let result: redis::RedisResult<(i32, i64, String)> = state
        .request_token_script
        .key(global_key)
        .key(route_key)
        .arg(state.config.global_rps as i64)
        .arg(state.config.route_rps as i64)
        .arg(1_500_i64)
        .arg(state.config.min_retry_ms as i64)
        .invoke_async(&mut conn)
        .await;

    let (granted, retry_after_ms, reason) = match result {
        Ok(data) => data,
        Err(_) => (0, state.config.min_retry_ms as i64, "redis_error".to_string()),
    };

    let granted_bool = granted == 1;
    if granted_bool {
        state.metrics.granted.fetch_add(1, Ordering::Relaxed);
    } else {
        state.metrics.denied.fetch_add(1, Ordering::Relaxed);
    }

    let response = RequestTokenResponse {
        granted: granted_bool,
        not_before_unix_ms: now_ms + retry_after_ms.max(0) as u64,
        retry_after_ms: if granted_bool {
            None
        } else {
            Some(retry_after_ms.max(0) as u64)
        },
        reason,
    };
    (StatusCode::OK, Json(response))
}

async fn report_result(
    State(state): State<Arc<AppState>>,
    Json(report): Json<ReportResultRequest>,
) -> impl IntoResponse {
    let mut conn = match state.redis.get_multiplexed_async_connection().await {
        Ok(conn) => conn,
        Err(_) => return (StatusCode::OK, Json(json!({ "ok": false }))),
    };
    let key = format!("rl:report:{}:{}", report.status_code, report.request_id);
    let _: redis::RedisResult<()> = conn.set_ex(key, 1_u8, 300).await;
    (StatusCode::OK, Json(json!({ "ok": true })))
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
