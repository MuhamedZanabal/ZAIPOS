use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
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
