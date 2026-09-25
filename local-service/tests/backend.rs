use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use zaipos_local_service::{AppState, build_router};

#[tokio::test]
async fn backend_rejects_secrets_and_unknown_tables() {
    let app = build_router(AppState::starting());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/backend")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"kind":"table","table":"sales","password":"hunter2"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let ok_body = response_text(response).await;
    assert_eq!(ok_body, r#"{"error":"LOCAL_RUNTIME_NOT_CONFIGURED"}"#);
    assert!(!ok_body.contains("hunter2"));

    let rejected = build_router(AppState::starting())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"kind":"table","table":"pg_catalog;drop","password":"hunter2"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    assert!(!response_text(rejected).await.contains("hunter2"));
}

async fn response_text(response: axum::response::Response) -> String {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8(bytes.to_vec()).unwrap()
}
