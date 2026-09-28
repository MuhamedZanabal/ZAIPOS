use zaipos_local_service::db::{DbError, EphemeralDatabase, MigrationError, MigrationRunner};

#[tokio::test]
async fn changed_historical_migration_blocks_readiness() {
    let Some(database) = EphemeralDatabase::open().await else {
        if std::env::var_os("ZAIPOS_REQUIRE_DATABASE_TESTS").is_some() {
            panic!("ZAIPOS_TEST_DATABASE_URL is required");
        }
        eprintln!("skipped migration integration test; ZAIPOS_TEST_DATABASE_URL is unset");
        return;
    };
    let original = MigrationRunner::from_sources(&[(
        "001_base.sql",
        "create table base_fixture(id int primary key);",
    )])
    .unwrap();
    original.apply(database.database()).await.unwrap();
    let tampered = MigrationRunner::from_sources(&[
        (
            "001_base.sql",
            "create table base_fixture(id int primary key, extra int);",
        ),
        (
            "002_later.sql",
            "create table later_fixture(id int primary key);",
        ),
    ])
    .unwrap();
    let error = tampered.apply(database.database()).await.unwrap_err();
    assert!(matches!(error, MigrationError::ChecksumMismatch { .. }));
    assert!(matches!(
        database.database().count_table("later_fixture").await,
        Err(DbError::UndefinedTable)
    ));
    assert_eq!(
        database
            .database()
            .count_table("base_fixture")
            .await
            .unwrap(),
        0
    );
    database.close().await;
}

#[tokio::test]
async fn vanilla_postgres_replays_super_admin_enum_migration_with_local_compatibility() {
    let Some(database) = EphemeralDatabase::open().await else {
        if std::env::var_os("ZAIPOS_REQUIRE_DATABASE_TESTS").is_some() {
            panic!("ZAIPOS_TEST_DATABASE_URL is required");
        }
        eprintln!("skipped migration integration test; ZAIPOS_TEST_DATABASE_URL is unset");
        return;
    };

    database
        .database()
        .prepare_local_compatibility()
        .await
        .expect("local compatibility SQL must execute on vanilla PostgreSQL");
    database
        .database()
        .exec(
            "create type public.app_role as enum ('owner');
             create table public.user_roles (
               user_id uuid not null,
               tenant_id uuid,
               role public.app_role not null
             );",
        )
        .await
        .unwrap();

    let runner = MigrationRunner::from_sources(&[(
        "20260507110000_super_admin_role.sql",
        r#"
        ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'super_admin';

        CREATE OR REPLACE FUNCTION public.has_super_admin_fixture(_user_id UUID)
        RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
          SELECT EXISTS (
            SELECT 1
            FROM public.user_roles
            WHERE user_id = _user_id
              AND role = 'super_admin'
          )
        $$;
        "#,
    )])
    .unwrap();

    let report = runner.apply(database.database()).await.unwrap();
    assert_eq!(
        report.applied,
        vec!["20260507110000_super_admin_role.sql".to_string()]
    );

    database.close().await;
}
