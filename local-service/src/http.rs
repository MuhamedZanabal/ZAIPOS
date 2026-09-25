use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde::Serialize;
use serde_json::Value;
use tower::ServiceExt;
use tower_http::limit::RequestBodyLimitLayer;

use crate::auth::{self, AuthError};
use crate::commands::{self, ExecError, execute_backend, execute_command};
use crate::db::Database;

pub const MAX_REQUEST_BYTES: usize = 1_048_576;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub database: &'static str,
}

#[derive(Clone, Debug)]
pub struct AppState {
    health: HealthResponse,
    database: Option<Database>,
}

impl AppState {
    pub fn starting() -> Self {
        Self {
            health: HealthResponse {
                status: "starting",
                database: "unavailable",
            },
            database: None,
        }
    }

    pub fn ready(database: Database) -> Self {
        Self {
            health: HealthResponse {
                status: "ready",
                database: "ready",
            },
            database: Some(database),
        }
    }
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/backend", post(backend))
        .route("/v1/auth/login", post(login))
        .route("/v1/auth/bootstrap", post(bootstrap))
        .route("/v1/auth/logout", post(logout))
        .route("/v1/commands/{name}", post(command))
        .fallback(not_found)
        .layer(RequestBodyLimitLayer::new(MAX_REQUEST_BYTES))
        .with_state(state)
}

async fn health(
    State(state): State<AppState>,
    request: axum::extract::Request,
) -> Result<Json<HealthResponse>, StatusCode> {
    let _ = limited_body(request).await?;
    Ok(Json(state.health.clone()))
}

async fn backend(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    request: axum::extract::Request,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    let value = json_body(request).await?;
    commands::validate_backend(&value).map_err(|_| StatusCode::BAD_REQUEST)?;
    let Some(database) = state.database.as_ref() else {
        return Ok(unavailable());
    };
    if value.get("kind").and_then(Value::as_str) == Some("rpc") {
        let name = value.get("fn").and_then(Value::as_str).unwrap_or("");
        if name != "report_daily_sales" {
            return match execute_named_command(
                database,
                &headers,
                name,
                value.get("args").unwrap_or(&Value::Null),
                None,
            )
            .await
            {
                Ok((status, Json(data))) if status.is_success() => {
                    Ok((status, Json(serde_json::json!({"data": data}))))
                }
                Ok((status, Json(data))) => {
                    let message = data
                        .get("message")
                        .or_else(|| data.get("error"))
                        .and_then(Value::as_str)
                        .unwrap_or("LOCAL_COMMAND_FAILED");
                    Ok((status, Json(serde_json::json!({"error": message}))))
                }
                Err(status) => Err(status),
            };
        }
    }
    match execute_backend(database, &value).await {
        Ok(data) => Ok((StatusCode::OK, Json(serde_json::json!({"data": data})))),
        Err(ExecError::Rejected) => Err(StatusCode::BAD_REQUEST),
        Err(ExecError::Unavailable | ExecError::Failed { .. }) => Ok(unavailable()),
    }
}

async fn login(
    State(state): State<AppState>,
    request: axum::extract::Request,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    let value = json_body(request).await?;
    commands::validate_backend(&value).map_err(|_| StatusCode::BAD_REQUEST)?;
    let Some(database) = state.database.as_ref() else {
        return Ok(unavailable());
    };
    match auth::login(database, &value).await {
        Ok(data) => {
            let rendered = data.to_string();
            if value
                .get("password")
                .and_then(Value::as_str)
                .is_some_and(|password| rendered.contains(password))
            {
                return Ok(unavailable());
            }
            Ok((StatusCode::OK, Json(serde_json::json!({"data": data}))))
        }
        Err(AuthError::Unauthorized) => Ok((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"invalid_credentials"})),
        )),
        Err(AuthError::Forbidden) => Ok((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error":"forbidden"})),
        )),
        Err(AuthError::Rejected) => Err(StatusCode::BAD_REQUEST),
        Err(AuthError::SetupRequired) => Ok((
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error":"FIRST_OWNER_REQUIRED"})),
        )),
        Err(AuthError::Unavailable) => Ok(unavailable()),
    }
}

async fn bootstrap(
    State(state): State<AppState>,
    request: axum::extract::Request,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    let value = json_body(request).await?;
    commands::validate_backend(&value).map_err(|_| StatusCode::BAD_REQUEST)?;
    let Some(database) = state.database.as_ref() else {
        return Ok(unavailable());
    };
    match auth::bootstrap_owner(database, &value).await {
        Ok(data) => session_response(&value, data),
        Err(AuthError::Unauthorized) => Ok((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"invalid_credentials"})),
        )),
        Err(AuthError::Forbidden) => Ok((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error":"already_initialized"})),
        )),
        Err(AuthError::Rejected | AuthError::SetupRequired) => Err(StatusCode::BAD_REQUEST),
        Err(AuthError::Unavailable) => Ok(unavailable()),
    }
}

async fn command(
    State(state): State<AppState>,
    Path(name): Path<String>,
    headers: axum::http::HeaderMap,
    request: axum::extract::Request,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    let sql_name = name.replace('-', "_");
    commands::valid_command_name(&sql_name).map_err(|_| StatusCode::BAD_REQUEST)?;
    let value = json_body(request).await?;
    let Some(database) = state.database.as_ref() else {
        return Ok(unavailable());
    };
    execute_named_command(
        database,
        &headers,
        &sql_name,
        &value,
        value.get("_device_credential").and_then(Value::as_str),
    )
    .await
}

async fn execute_named_command(
    database: &Database,
    headers: &axum::http::HeaderMap,
    name: &str,
    arguments: &Value,
    secret: Option<&str>,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    commands::valid_command_name(name).map_err(|_| StatusCode::BAD_REQUEST)?;
    if !arguments.is_object() || arguments.get("sql").is_some() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let token = bearer_token(headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let user_id = auth::session_user_id(database, &token)
        .await
        .map_err(|error| match error {
            AuthError::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            AuthError::Unauthorized
            | AuthError::Forbidden
            | AuthError::Rejected
            | AuthError::SetupRequired => StatusCode::UNAUTHORIZED,
        })?;
    match execute_command(database, name, arguments, &user_id).await {
        Ok(data) => {
            if secret.is_some_and(|secret| !secret.is_empty() && data.to_string().contains(secret))
            {
                return Ok(unavailable());
            }
            Ok((StatusCode::OK, Json(data)))
        }
        Err(ExecError::Rejected) => Err(StatusCode::BAD_REQUEST),
        Err(ExecError::Unavailable) => Ok((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error":"LOCAL_COMMAND_FAILED"})),
        )),
        Err(ExecError::Failed { code, message }) => {
            if secret.is_some_and(|secret| !secret.is_empty() && message.contains(secret)) {
                return Ok(unavailable());
            }
            let status = match code.as_str() {
                "42501" => StatusCode::FORBIDDEN,
                "23505" | "P0001" => StatusCode::CONFLICT,
                _ => StatusCode::BAD_REQUEST,
            };
            Ok((
                status,
                Json(serde_json::json!({"code": code, "message": message})),
            ))
        }
    }
}

fn bearer_token(headers: &axum::http::HeaderMap) -> Option<String> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

fn session_response(value: &Value, data: Value) -> Result<(StatusCode, Json<Value>), StatusCode> {
    let rendered = data.to_string();
    if value
        .get("password")
        .and_then(Value::as_str)
        .is_some_and(|password| rendered.contains(password))
    {
        return Ok(unavailable());
    }
    Ok((StatusCode::OK, Json(serde_json::json!({"data": data}))))
}

async fn logout(
    State(state): State<AppState>,
    request: axum::extract::Request,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    let value = json_body(request).await?;
    commands::validate_backend(&value).map_err(|_| StatusCode::BAD_REQUEST)?;
    if state.database.is_none() {
        return Ok(unavailable());
    }
    Ok((StatusCode::OK, Json(serde_json::json!({"data":"ok"}))))
}

fn unavailable() -> (StatusCode, Json<Value>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({"error": "LOCAL_RUNTIME_NOT_CONFIGURED"})),
    )
}

async fn json_body(request: axum::extract::Request) -> Result<Value, StatusCode> {
    let bytes = limited_body(request).await?;
    serde_json::from_slice(&bytes).map_err(|_| StatusCode::BAD_REQUEST)
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
        Json(serde_json::json!({"error":"not_found"})),
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
