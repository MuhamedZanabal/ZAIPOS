use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use zaipos_local_service::test_support::{body_text, request, test_app};
use zaipos_local_service::{ConfigError, ServiceConfig, ServicePaths};

#[tokio::test]
async fn health_never_discloses_secrets() {
    let app = test_app().await;
    let response = request(app, "/v1/health").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_text(response).await;
    assert_eq!(body, r#"{"status":"starting","database":"unavailable"}"#);
    assert!(!body.contains("password"));
}

#[test]
fn rejects_config_outside_program_data() {
    let err = ServiceConfig::load(ServicePaths::new(r"C:\Users\Public\zaipos")).unwrap_err();
    assert!(matches!(err, ConfigError::UnsafeRoot));
}

#[test]
fn rejects_relative_user_and_traversal_roots() {
    for root in [
        "zaipos",
        r"..\ZAIPOS",
        r"C:\ProgramData\ZAIPOS\..\Windows",
        "/home/cashier/zaipos",
        "/root",
    ] {
        let err = ServiceConfig::load(ServicePaths::new(root)).unwrap_err();
        assert!(matches!(err, ConfigError::UnsafeRoot), "{root}");
    }
}

#[test]
fn rejects_wildcard_plaintext_unknown_and_exposed_secrets() {
    let root = std::env::temp_dir().join(format!("zaipos-config-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("secrets")).unwrap();
    let secret = root.join("secrets").join("database.secret");
    fs::write(&secret, b"database-password-should-not-leak").unwrap();
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)).unwrap();

    let missing = load_case(
        &root,
        r#"{"listen":"127.0.0.1:8443","tls":"required","database_secret_file":"secrets/absent.secret"}"#,
    );
    assert!(matches!(missing, Err(ConfigError::MissingSecret)));

    fs::set_permissions(&secret, fs::Permissions::from_mode(0o644)).unwrap();
    let exposed = load_case(
        &root,
        r#"{"listen":"127.0.0.1:8443","tls":"required","database_secret_file":"secrets/database.secret"}"#,
    );
    assert!(matches!(exposed, Err(ConfigError::UnsafeSecretPermissions)));
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)).unwrap();

    let wildcard = load_case(
        &root,
        r#"{"listen":"0.0.0.0:8443","tls":"required","database_secret_file":"secrets/database.secret"}"#,
    );
    assert!(matches!(wildcard, Err(ConfigError::WildcardListen)));

    let plaintext = load_case(
        &root,
        r#"{"listen":"127.0.0.1:8443","tls":"off","database_secret_file":"secrets/database.secret"}"#,
    );
    assert!(matches!(plaintext, Err(ConfigError::PlaintextLan)));

    let unknown = load_case(
        &root,
        r#"{"listen":"127.0.0.1:8443","tls":"required","database_secret_file":"secrets/database.secret","password":"nope"}"#,
    );
    assert!(matches!(unknown, Err(ConfigError::UnknownKey)));

    let public_ip = load_case(
        &root,
        r#"{"listen":"8.8.8.8:8443","tls":"required","database_secret_file":"secrets/database.secret"}"#,
    );
    assert!(matches!(public_ip, Err(ConfigError::PublicListen)));

    let config = load_case(
        &root,
        r#"{"listen":"127.0.0.1:8443","tls":"required","database_secret_file":"secrets/database.secret"}"#,
    )
    .unwrap();
    let rendered = format!("{config:?}");
    assert!(rendered.contains("<redacted>"));
    assert!(!rendered.contains("database-password-should-not-leak"));
    assert_eq!(config.listen().to_string(), "127.0.0.1:8443");
    assert!(config.has_database_secret());
    let _ = fs::remove_dir_all(&root);
}

#[tokio::test]
async fn oversized_request_is_rejected_without_a_secret_echo() {
    let app = test_app().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/health")
                .header("content-length", "1048577")
                .body(Body::from(vec![b'a'; 64]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&bytes);
    assert!(!body.contains("database-password"));
}

fn load_case(root: &Path, json: &str) -> Result<ServiceConfig, ConfigError> {
    fs::write(root.join("config.json"), json).unwrap();
    ServiceConfig::load(ServicePaths::test_root(root.to_string_lossy().to_string()))
}
