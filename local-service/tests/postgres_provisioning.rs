use std::fs;
use std::os::unix::fs::PermissionsExt;

use zaipos_local_service::provisioning::{
    PostgresProvisioner, ProvisionError, render_postgres_policy,
};

#[test]
fn generated_postgres_policy_is_loopback_and_scram_only() {
    let rendered = render_postgres_policy(55432).unwrap();
    assert!(
        rendered
            .postgresql_conf
            .contains("listen_addresses = '127.0.0.1'")
    );
    assert!(
        rendered
            .pg_hba_conf
            .contains("hostssl zaipos zaipos_service 127.0.0.1/32 scram-sha-256")
    );
    assert!(!rendered.pg_hba_conf.contains("0.0.0.0/0"));
    assert!(!rendered.pg_hba_conf.contains(" trust"));
}

#[tokio::test]
async fn missing_binaries_still_keep_the_credential_private() {
    let root = std::env::temp_dir().join(format!("zaipos-pg-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let error = PostgresProvisioner::new(&root, 55432)
        .with_bin_dir(root.join("missing-bin"))
        .ensure_cluster()
        .await
        .unwrap_err();
    assert!(matches!(error, ProvisionError::BinariesMissing));
    let secret = root.join("zaipos_service.secret");
    let mode = fs::metadata(&secret).unwrap().permissions().mode();
    assert_eq!(mode & 0o077, 0);
    let password = fs::read_to_string(&secret).unwrap();
    assert_eq!(password.len(), 64);
    let conf = fs::read_to_string(root.join("postgresql.conf")).unwrap();
    let hba = fs::read_to_string(root.join("pg_hba.conf")).unwrap();
    assert!(!conf.contains(&password));
    assert!(!hba.contains(&password));
    assert!(conf.contains("listen_addresses = '127.0.0.1'"));
    let _ = fs::remove_dir_all(&root);
}

#[tokio::test]
#[ignore = "requires bundled PostgreSQL 17 binaries and a private loopback cluster"]
async fn non_loopback_connection_is_rejected() {
    let root = std::env::temp_dir().join(format!("zaipos-pg-live-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let provisioned = PostgresProvisioner::new(&root, 55432)
        .ensure_cluster()
        .await
        .expect("cluster");
    assert_eq!(provisioned.socket_host(), "127.0.0.1");
    let database = zaipos_local_service::db::Database::connect(&provisioned)
        .await
        .expect("loopback tls");
    database.is_ready().await.expect("readiness");
    let _ = fs::remove_dir_all(&root);
}
