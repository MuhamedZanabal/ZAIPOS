//! Real-Postgres checks for the guided setup: first-owner bootstrap with each
//! business type through the full embedded migration chain, the type-specific
//! defaults, table-service enforcement, the owner-only type change, and
//! staff creation from the setup wizard.
use tower::util::ServiceExt;
use zaipos_local_service::auth;
use zaipos_local_service::db::{EphemeralDatabase, MigrationRunner};
use zaipos_local_service::http::{AppState, build_router};

async fn migrated() -> Option<EphemeralDatabase> {
    let Some(database) = EphemeralDatabase::open().await else {
        if std::env::var_os("ZAIPOS_REQUIRE_DATABASE_TESTS").is_some() {
            panic!("ZAIPOS_TEST_DATABASE_URL is required");
        }
        return None;
    };
    // Cluster roles the Supabase-shaped migrations grant to (created by the
    // provisioner in production).
    database
        .database()
        .exec(
            "do $$ begin
               if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
               if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
               if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
             exception when unique_violation or duplicate_object then null;
             end $$",
        )
        .await
        .unwrap();
    database
        .database()
        .prepare_local_compatibility()
        .await
        .unwrap();
    MigrationRunner::embedded()
        .unwrap()
        .apply(database.database())
        .await
        .unwrap();
    auth::ensure_identity(database.database()).await.unwrap();
    Some(database)
}

fn post(path: &str, body: &str, token: Option<&str>) -> axum::http::Request<axum::body::Body> {
    let mut request = axum::http::Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    request
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}

async fn text(response: axum::response::Response) -> String {
    String::from_utf8(
        axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}

async fn scalar(database: &EphemeralDatabase, sql: &str) -> String {
    sqlx::query_scalar::<_, String>(sql)
        .fetch_one(database.database().pool_for_tests())
        .await
        .unwrap()
}

async fn bootstrap(app: &axum::Router, mode: &str) -> String {
    let response = app
        .clone()
        .oneshot(post(
            "/v1/auth/bootstrap",
            &format!(r#"{{"kind":"auth","email":"owner@{mode}.test","password":"owner-password","tenant_name":"Shop {mode}","branch_name":"Main","business_mode":"{mode}"}}"#),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        axum::http::StatusCode::OK,
        "bootstrap {mode}"
    );
    let body = text(response).await;
    body.split("\"access_token\":\"")
        .nth(1)
        .and_then(|v| v.split('"').next())
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn bootstrap_sets_type_and_defaults_for_every_business_type() {
    for (mode, channels, tables_allowed) in [
        ("RESTAURANT", "{pos,tables,talabat,whatsapp,delivery}", true),
        ("CAFE", "{pos,talabat,whatsapp,delivery}", true),
        ("SUPERMARKET", "{pos,whatsapp}", false),
        ("RETAIL", "{pos,whatsapp}", false),
    ] {
        let Some(database) = migrated().await else {
            return;
        };
        let app = build_router(AppState::ready(database.database().clone()));
        bootstrap(&app, mode).await;
        assert_eq!(
            scalar(&database, "select business_mode from public.tenants").await,
            mode
        );
        assert_eq!(
            scalar(
                &database,
                "select active_channels::text from public.tenants"
            )
            .await,
            channels,
            "{mode}"
        );
        assert_eq!(
            scalar(&database, "select role::text from public.user_roles").await,
            "owner"
        );
        // Table service is enforced in the database, not only hidden in the UI.
        let inserted = sqlx::query(
            "insert into public.tables (tenant_id, branch_id, name) select t.id, b.id, 'T1' from public.tenants t join public.branches b on b.tenant_id = t.id",
        )
        .execute(database.database().pool_for_tests())
        .await;
        assert_eq!(inserted.is_ok(), tables_allowed, "{mode} tables");
        database.close().await;
    }
}

#[tokio::test]
async fn unknown_type_is_rejected_and_direct_type_updates_are_blocked() {
    let Some(database) = migrated().await else {
        return;
    };
    let app = build_router(AppState::ready(database.database().clone()));
    let rejected = app
        .clone()
        .oneshot(post(
            "/v1/auth/bootstrap",
            r#"{"kind":"auth","email":"o@x.test","password":"owner-password","tenant_name":"X","branch_name":"Main","business_mode":"BAKERY"}"#,
            None,
        ))
        .await
        .unwrap();
    assert_ne!(rejected.status(), axum::http::StatusCode::OK);
    bootstrap(&app, "RETAIL").await;
    let direct = sqlx::query("update public.tenants set business_mode = 'RESTAURANT'")
        .execute(database.database().pool_for_tests())
        .await;
    assert!(direct.is_err(), "direct mode update must be blocked");
    database.close().await;
}

#[tokio::test]
async fn owner_changes_type_and_adds_staff_who_can_sign_in() {
    let Some(database) = migrated().await else {
        return;
    };
    let app = build_router(AppState::ready(database.database().clone()));
    let token = bootstrap(&app, "CAFE").await;
    let tenant = scalar(&database, "select id::text from public.tenants").await;

    let changed = app
        .clone()
        .oneshot(post(
            "/v1/backend",
            &format!(r#"{{"kind":"rpc","fn":"change_business_mode_v1","args":{{"_tenant_id":"{tenant}","_business_mode":"SUPERMARKET"}}}}"#),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(
        changed.status(),
        axum::http::StatusCode::OK,
        "{}",
        text(changed).await
    );
    assert_eq!(
        scalar(&database, "select business_mode from public.tenants").await,
        "SUPERMARKET"
    );
    assert_eq!(
        scalar(
            &database,
            "select active_channels::text from public.tenants"
        )
        .await,
        "{pos,whatsapp}"
    );

    let created = app
        .clone()
        .oneshot(post(
            "/v1/backend",
            &format!(r#"{{"kind":"function","name":"create-user","body":{{"email":"Cashier1","password":"cashier-pass","full_name":"Ali","role":"cashier","tenant_id":"{tenant}","branch_id":null}}}}"#),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(
        created.status(),
        axum::http::StatusCode::OK,
        "{}",
        text(created).await
    );
    assert_eq!(
        scalar(
            &database,
            "select string_agg(role::text, ',' order by role::text) from public.user_roles"
        )
        .await,
        "owner,cashier"
            .split(',')
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
            .join(",")
    );
    let login = app
        .clone()
        .oneshot(post(
            "/v1/auth/login",
            r#"{"kind":"auth","email":"cashier1","password":"cashier-pass"}"#,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(login.status(), axum::http::StatusCode::OK);
    let cashier = text(login).await;
    assert!(!cashier.contains("cashier-pass"));
    let cashier_token = cashier
        .split("\"access_token\":\"")
        .nth(1)
        .and_then(|v| v.split('"').next())
        .unwrap()
        .to_string();

    // A cashier can neither add staff nor change the business type; nothing is left behind.
    let refused = app
        .clone()
        .oneshot(post(
            "/v1/backend",
            &format!(r#"{{"kind":"function","name":"create-user","body":{{"email":"sneaky","password":"sneaky-pass","role":"manager","tenant_id":"{tenant}"}}}}"#),
            Some(&cashier_token),
        ))
        .await
        .unwrap();
    assert_eq!(refused.status(), axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(
        scalar(
            &database,
            "select count(*)::text from public.zaipos_local_users where username = 'sneaky'"
        )
        .await,
        "0"
    );
    let refused_mode = app
        .clone()
        .oneshot(post(
            "/v1/backend",
            &format!(r#"{{"kind":"rpc","fn":"change_business_mode_v1","args":{{"_tenant_id":"{tenant}","_business_mode":"RESTAURANT"}}}}"#),
            Some(&cashier_token),
        ))
        .await
        .unwrap();
    assert_ne!(refused_mode.status(), axum::http::StatusCode::OK);
    assert_eq!(
        scalar(&database, "select business_mode from public.tenants").await,
        "SUPERMARKET"
    );

    // Duplicate login names are refused.
    let duplicate = app
        .clone()
        .oneshot(post(
            "/v1/backend",
            &format!(r#"{{"kind":"function","name":"create-user","body":{{"email":"cashier1","password":"cashier-pass","role":"cashier","tenant_id":"{tenant}"}}}}"#),
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(duplicate.status(), axum::http::StatusCode::BAD_REQUEST);
    database.close().await;
}
