//! Real-Postgres roundtrip: backup, change data, restore, verify; tampered
//! backups are refused; chunked import produces an identical restorable copy.

use std::path::PathBuf;

use secrecy::SecretString;
use sqlx::Row;
use zaipos_local_service::backup::{BackupError, BackupStore, Connection};
use zaipos_local_service::db::Database;

struct Target {
    admin: String,
    name: String,
    url: String,
    connection: Connection,
}

fn parse(url: &str, name: &str) -> Target {
    // postgres://user:pass@host:port/db?query
    let rest = url.split_once("://").unwrap().1;
    let (auth, hostpart) = rest.split_once('@').unwrap();
    let (user, password) = auth.split_once(':').unwrap();
    let hostport = hostpart.split('/').next().unwrap();
    let (host, port) = hostport.split_once(':').unwrap_or((hostport, "5432"));
    let (base, query) = url.split_once('?').unwrap_or((url, ""));
    let prefix = base.rsplit_once('/').unwrap().0;
    let db_url = if query.is_empty() {
        format!("{prefix}/{name}")
    } else {
        format!("{prefix}/{name}?{query}")
    };
    Target {
        admin: url.to_string(),
        name: name.to_string(),
        url: db_url,
        connection: Connection {
            host: host.to_string(),
            port: port.parse().unwrap(),
            database: name.to_string(),
            user: user.to_string(),
            password: SecretString::from(password.to_string()),
            require_tls: query.contains("sslmode=require"),
        },
    }
}

fn bin_dir() -> Option<PathBuf> {
    std::env::var_os("ZAIPOS_TEST_PG_BIN")
        .map(PathBuf::from)
        .or_else(|| zaipos_local_service::provisioning::resolve_bin_dir(None).ok())
}

async fn names(db: &Database) -> Vec<String> {
    sqlx::query("select note from public.sales order by note")
        .fetch_all(db.pool_for_tests())
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.get::<String, _>("note"))
        .collect()
}

#[tokio::test]
async fn backup_restore_roundtrip_on_real_postgres() {
    let required = std::env::var_os("ZAIPOS_REQUIRE_DATABASE_TESTS").is_some();
    let Ok(url) = std::env::var("ZAIPOS_TEST_DATABASE_URL") else {
        assert!(!required, "ZAIPOS_TEST_DATABASE_URL is required");
        return;
    };
    let Some(bin) = bin_dir() else {
        assert!(
            !required,
            "pg_dump/pg_restore are required (set ZAIPOS_TEST_PG_BIN)"
        );
        return;
    };
    let mut suffix = [0u8; 6];
    getrandom::fill(&mut suffix).unwrap();
    let name = format!(
        "zaipos_bk_{}",
        suffix
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    let target = parse(&url, &name);
    let admin = Database::connect_url(&target.admin).await.unwrap();
    admin
        .exec(&format!("create database {name}"))
        .await
        .unwrap();
    let db = Database::connect_url(&target.url).await.unwrap();
    db.exec("create table public.sales (id serial primary key, note text not null, total numeric(14,3) not null)").await.unwrap();
    db.exec("insert into public.sales (note, total) values ('karak', 0.220), ('machboos', 3.025)")
        .await
        .unwrap();

    let dir = std::env::temp_dir().join(&name);
    let store = BackupStore::from_parts(target.connection, &bin, dir.clone()).unwrap();
    let backup = store.create().await.unwrap();
    assert!(backup.bytes > 0 && backup.sha256.len() == 64);
    assert_eq!(store.list().await.unwrap()[0].name, backup.name);

    // Business continues, then something goes wrong.
    db.exec("delete from public.sales where note = 'karak'")
        .await
        .unwrap();
    db.exec("insert into public.sales (note, total) values ('mistake', 99.000)")
        .await
        .unwrap();
    assert_eq!(names(&db).await, vec!["machboos", "mistake"]);

    let safety = store.restore(&backup.name).await.unwrap();
    assert_eq!(names(&db).await, vec!["karak", "machboos"]);
    assert_eq!(safety.kind, "before-restore");

    // The safety backup really holds the pre-restore state.
    store.restore(&safety.name).await.unwrap();
    assert_eq!(names(&db).await, vec!["machboos", "mistake"]);

    // Chunked export/import yields an identical, restorable copy.
    let mut bytes = Vec::new();
    let mut offset = 0u64;
    loop {
        let (chunk, total) = store.read_chunk(&backup.name, offset).await.unwrap();
        offset += chunk.len() as u64;
        bytes.extend(chunk);
        if offset >= total {
            break;
        }
    }
    let upload = store.import_begin().await.unwrap();
    let mut sent = 0u64;
    for piece in bytes.chunks(1000) {
        sent = store.import_chunk(&upload, sent, piece).await.unwrap();
    }
    let imported = store.import_finish(&upload).await.unwrap();
    assert_eq!(imported.sha256, backup.sha256);
    store.restore(&imported.name).await.unwrap();
    assert_eq!(names(&db).await, vec!["karak", "machboos"]);

    // A tampered backup is refused and the database is untouched.
    let path = dir.join(&backup.name);
    let mut raw = std::fs::read(&path).unwrap();
    let last = raw.len() - 10;
    raw[last] ^= 0xff;
    std::fs::write(&path, raw).unwrap();
    assert_eq!(
        store.restore(&backup.name).await.unwrap_err(),
        BackupError::Corrupt
    );
    assert_eq!(names(&db).await, vec!["karak", "machboos"]);
    assert_eq!(
        store.restore("../etc/passwd").await.unwrap_err(),
        BackupError::InvalidName
    );

    // Scheduled backups: tagged automatic, mirrored off the till disk, and
    // only the newest `keep` automatic backups are retained.
    let mirror = std::env::temp_dir().join(format!("{name}-mirror"));
    let mut automatic = Vec::new();
    for _ in 0..3 {
        automatic.push(
            store
                .create_automatic(2, Some(mirror.clone()))
                .await
                .unwrap(),
        );
    }
    assert!(automatic.iter().all(|b| b.kind == "automatic"));
    let listed: Vec<_> = store.list().await.unwrap();
    let kept: Vec<_> = listed
        .iter()
        .filter(|b| b.kind == "automatic")
        .map(|b| b.name.clone())
        .collect();
    assert_eq!(
        kept,
        vec![automatic[2].name.clone(), automatic[1].name.clone()]
    );
    assert!(
        listed.iter().any(|b| b.kind == "manual"),
        "manual backups are never pruned"
    );
    for b in &automatic {
        assert!(
            mirror.join(&b.name).is_file() && mirror.join(format!("{}.json", b.name)).is_file()
        );
    }
    // The mirrored copy restores like the original.
    store.restore(&automatic[2].name).await.unwrap();
    assert_eq!(names(&db).await, vec!["karak", "machboos"]);
    let _ = std::fs::remove_dir_all(&mirror);

    drop(db);
    let _ = admin
        .exec(&format!(
            "select pg_terminate_backend(pid) from pg_stat_activity where datname = '{name}'"
        ))
        .await;
    let _ = admin.exec(&format!("drop database if exists {name}")).await;
    let _ = std::fs::remove_dir_all(dir);
    let _ = target.name;
}
