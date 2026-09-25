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
