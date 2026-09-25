use std::collections::BTreeMap;

use tower::util::ServiceExt;
use zaipos_local_service::auth::{self, hash_password};
use zaipos_local_service::backup::BackupManifest;
use zaipos_local_service::db::EphemeralDatabase;
use zaipos_local_service::events::{append_durable, ensure_durable, read_durable};
use zaipos_local_service::http::{AppState, build_router};
use zaipos_local_service::import::import_json_rows;

#[tokio::test]
async fn enrolled_read_returns_rows_and_rejects_mutation() {
    let Some(database) = EphemeralDatabase::open().await else {
        if std::env::var_os("ZAIPOS_REQUIRE_DATABASE_TESTS").is_some() {
            panic!("ZAIPOS_TEST_DATABASE_URL is required");
        }
        return;
    };
    database
        .database()
        .exec("create table products (id text primary key, name text not null)")
        .await
        .unwrap();
    database
        .database()
        .exec("insert into products (id, name) values ('p1', 'Karama tea')")
        .await
        .unwrap();
    let response = build_router(AppState::ready(database.database().clone()))
        .oneshot(post(
            "/v1/backend",
            r#"{"kind":"table","table":"products","steps":[["select",["id,name"]],["eq",["id","p1"]]]}"#,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body = body(response).await;
    assert!(body.contains("Karama tea"));
    let rejected = build_router(AppState::ready(database.database().clone()))
        .oneshot(post(
            "/v1/backend",
            r#"{"kind":"table","table":"products","steps":[["insert",["name","x"]]]}"#,
        ))
        .await
        .unwrap();
    assert_eq!(rejected.status(), axum::http::StatusCode::BAD_REQUEST);
    database.close().await;
}

#[tokio::test]
async fn inactive_user_cannot_login_and_password_is_not_echoed() {
    let Some(database) = EphemeralDatabase::open().await else {
        if std::env::var_os("ZAIPOS_REQUIRE_DATABASE_TESTS").is_some() {
            panic!("ZAIPOS_TEST_DATABASE_URL is required");
        }
        return;
    };
    auth::ensure_identity(database.database()).await.unwrap();
    let password = "correct-password";
    let hash = hash_password(password).unwrap().replace('\'', "''");
    database
        .database()
        .exec(
            "insert into zaipos_local_devices (id, tenant_id, branch_id, revoked) values
             ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', false)",
        )
        .await
        .unwrap();
    database
        .database()
        .exec(&format!(
            "insert into zaipos_local_users (id, tenant_id, branch_id, username, password_hash, active) values
             ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'cashier', '{hash}', false)"
        ))
        .await
        .unwrap();
    let response = build_router(AppState::ready(database.database().clone()))
        .oneshot(post(
            "/v1/auth/login",
            &format!(
                r#"{{"kind":"auth","email":"cashier","password":"{password}","tenant_id":"22222222-2222-2222-2222-222222222222","branch_id":"33333333-3333-3333-3333-333333333333","device_id":"11111111-1111-1111-1111-111111111111"}}"#
            ),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
    assert!(!body(response).await.contains(password));
    database.close().await;
}

#[tokio::test]
async fn checksum_failure_imports_zero_rows_and_outbox_is_isolated() {
    let Some(database) = EphemeralDatabase::open().await else {
        if std::env::var_os("ZAIPOS_REQUIRE_DATABASE_TESTS").is_some() {
            panic!("ZAIPOS_TEST_DATABASE_URL is required");
        }
        return;
    };
    database
        .database()
        .exec("create table products (id text primary key, name text not null)")
        .await
        .unwrap();
    let files = BTreeMap::from([(
        "products.json".to_string(),
        br#"[{"id":"p1","name":"tea"}]"#.to_vec(),
    )]);
    let manifest = BackupManifest::from_files(files.clone());
    assert_eq!(
        import_json_rows(database.database(), &manifest, &files)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        database.database().count_table("products").await.unwrap(),
        1
    );
    let mut tampered = files.clone();
    tampered.get_mut("products.json").unwrap().push(b'x');
    assert!(
        import_json_rows(database.database(), &manifest, &tampered)
            .await
            .is_err()
    );
    assert_eq!(
        database.database().count_table("products").await.unwrap(),
        1
    );
    ensure_durable(database.database()).await.unwrap();
    append_durable(database.database(), "tenant-a", "branch-a", "sale")
        .await
        .unwrap();
    let second = append_durable(database.database(), "tenant-a", "branch-a", "payment")
        .await
        .unwrap();
    append_durable(database.database(), "tenant-b", "branch-b", "sale")
        .await
        .unwrap();
    let resumed = read_durable(database.database(), "tenant-a", "branch-a", 1)
        .await
        .unwrap();
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].sequence, second);
    database.close().await;
}

fn post(path: &str, body: &str) -> axum::http::Request<axum::body::Body> {
    axum::http::Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}

async fn body(response: axum::response::Response) -> String {
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    String::from_utf8(bytes.to_vec()).unwrap()
}
