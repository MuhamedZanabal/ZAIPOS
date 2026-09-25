use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde::Serialize;
use tower::ServiceExt;
use tower_http::limit::RequestBodyLimitLayer;

pub const MAX_REQUEST_BYTES: usize = 1_048_576;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub database: &'static str,
}

#[derive(Clone, Debug)]
pub struct AppState {
    health: HealthResponse,
}

impl AppState {
    pub fn starting() -> Self {
        Self {
            health: HealthResponse {
                status: "starting",
                database: "unavailable",
            },
        }
    }
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/backend", post(backend))
        .route("/v1/auth/login", post(login))
        .route("/v1/auth/logout", post(logout))
        .fallback(not_found)
        .layer(RequestBodyLimitLayer::new(MAX_REQUEST_BYTES))
        .with_state(state)
}

async fn health(
    State(state): State<AppState>,
    request: axum::extract::Request,
) -> Result<Json<HealthResponse>, StatusCode> {
    let advertised = request
        .headers()
        .get(http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if advertised.is_some_and(|length| length > MAX_REQUEST_BYTES) {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let received = request
        .into_body()
        .collect()
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    if received.to_bytes().len() > MAX_REQUEST_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    Ok(Json(state.health.clone()))
}

async fn backend(
    request: axum::extract::Request,
) -> Result<(StatusCode, Json<serde_json::Value>), StatusCode> {
    reject_until_database(request).await
}

async fn login(
    request: axum::extract::Request,
) -> Result<(StatusCode, Json<serde_json::Value>), StatusCode> {
    reject_until_database(request).await
}

async fn logout(
    request: axum::extract::Request,
) -> Result<(StatusCode, Json<serde_json::Value>), StatusCode> {
    reject_until_database(request).await
}

async fn reject_until_database(
    request: axum::extract::Request,
) -> Result<(StatusCode, Json<serde_json::Value>), StatusCode> {
    let bytes = limited_body(request).await?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| StatusCode::BAD_REQUEST)?;
    crate::commands::validate_backend(&value).map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok((
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({"error": "LOCAL_RUNTIME_NOT_CONFIGURED"})),
    ))
}

async fn limited_body(request: axum::extract::Request) -> Result<Vec<u8>, StatusCode> {
    let advertised = request
        .headers()
        .get(http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if advertised.is_some_and(|length| length > MAX_REQUEST_BYTES) {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let received = request
        .into_body()
        .collect()
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let bytes = received.to_bytes();
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    Ok(bytes.to_vec())
}

async fn not_found() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({"error": "not_found"})),
    )
}

pub mod test_support {
    use super::*;

    pub async fn test_app() -> Router {
        build_router(AppState::starting())
    }

    pub async fn request(app: Router, path: &str) -> axum::response::Response {
        app.oneshot(
            Request::builder()
                .uri(path)
                .body(Body::empty())
                .expect("health request is valid"),
        )
        .await
        .expect("router accepts the request")
    }

    pub async fn body_text(response: axum::response::Response) -> String {
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        String::from_utf8(bytes.to_vec()).expect("health body is utf-8")
    }
}
