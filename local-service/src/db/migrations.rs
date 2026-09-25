use sha2::{Digest, Sha256};
use sqlx::Row;
use thiserror::Error;

use super::Database;

pub const MIGRATION_LOCK: i64 = 7_820_192_509;
const HISTORICAL_DEMO_SEED: &str = "20260508120000_seed_bahrain_tenant.sql";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Migration {
    pub filename: String,
    pub sha256: String,
    pub sql: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MigrationError {
    #[error("migration checksum mismatch")]
    ChecksumMismatch { filename: String },
    #[error("migration filename is invalid")]
    InvalidName,
    #[error("migration filename is duplicated")]
    Duplicate,
    #[error("migration failed")]
    Apply { filename: String },
    #[error("database unavailable")]
    Database,
}

#[derive(Debug, PartialEq, Eq)]
pub struct MigrationReport {
    pub applied: Vec<String>,
    pub skipped: Vec<String>,
}

pub struct MigrationRunner {
    migrations: Vec<Migration>,
}

impl MigrationRunner {
    pub fn from_sources(files: &[(&str, &str)]) -> Result<Self, MigrationError> {
        let mut migrations = Vec::with_capacity(files.len());
        for (filename, sql) in files {
            if !valid_source_name(filename) || sql.trim().is_empty() {
                return Err(MigrationError::InvalidName);
            }
            migrations.push(Migration {
                filename: (*filename).to_string(),
                sha256: sha256_hex(sql.as_bytes()),
                sql: (*sql).to_string(),
            });
        }
        migrations.sort_by(|left, right| left.filename.cmp(&right.filename));
        if migrations
            .windows(2)
            .any(|pair| pair[0].filename == pair[1].filename)
        {
            return Err(MigrationError::Duplicate);
        }
        Ok(Self { migrations })
    }

    pub fn embedded() -> Result<Self, MigrationError> {
        let files: &[(&str, &str, &str)] =
            include!(concat!(env!("OUT_DIR"), "/embedded_migrations.rs"));
        let mut migrations = Vec::with_capacity(files.len());
        for (filename, sha256, sql) in files {
            let actual = sha256_hex(sql.as_bytes());
            if actual != *sha256 {
                return Err(MigrationError::ChecksumMismatch {
                    filename: (*filename).to_string(),
                });
            }
            migrations.push(Migration {
                filename: (*filename).to_string(),
                sha256: (*sha256).to_string(),
                sql: (*sql).to_string(),
            });
        }
        Ok(Self { migrations })
    }

    pub fn len(&self) -> usize {
        self.migrations.len()
    }

    pub fn is_empty(&self) -> bool {
        self.migrations.is_empty()
    }

    pub fn plan(&self, applied: &[(String, String)]) -> Result<Vec<&Migration>, MigrationError> {
        for (filename, hash) in applied {
            let Some(migration) = self
                .migrations
                .iter()
                .find(|migration| migration.filename == *filename)
            else {
                return Err(MigrationError::ChecksumMismatch {
                    filename: filename.clone(),
                });
            };
            if migration.sha256 != *hash {
                return Err(MigrationError::ChecksumMismatch {
                    filename: filename.clone(),
                });
            }
        }
        let applied_names: std::collections::BTreeSet<&str> = applied
            .iter()
            .map(|(filename, _)| filename.as_str())
            .collect();
        Ok(self
            .migrations
            .iter()
            .filter(|migration| !applied_names.contains(migration.filename.as_str()))
            .collect())
    }

    pub async fn apply(&self, db: &Database) -> Result<MigrationReport, MigrationError> {
        let pool = db.pool();
        sqlx::query("select pg_advisory_lock($1)")
            .bind(MIGRATION_LOCK)
            .execute(pool)
            .await
            .map_err(|_| MigrationError::Database)?;
        let result = self.apply_locked(db).await;
        let _ = sqlx::query("select pg_advisory_unlock($1)")
            .bind(MIGRATION_LOCK)
            .execute(pool)
            .await;
        result
    }

    async fn apply_locked(&self, db: &Database) -> Result<MigrationReport, MigrationError> {
        let pool = db.pool();
        sqlx::query(
            "create table if not exists public.zaipos_schema_migrations (
                filename text primary key,
                sha256 text not null,
                app_version text not null,
                started_at timestamptz not null default now(),
                completed_at timestamptz,
                failure_detail text
            )",
        )
        .execute(pool)
        .await
        .map_err(|_| MigrationError::Database)?;
        let rows = sqlx::query(
            "select filename, sha256 from public.zaipos_schema_migrations order by filename",
        )
        .fetch_all(pool)
        .await
        .map_err(|_| MigrationError::Database)?;
        let applied = rows
            .iter()
            .map(|row| {
                (
                    row.get::<String, _>("filename"),
                    row.get::<String, _>("sha256"),
                )
            })
            .collect::<Vec<_>>();
        let pending = self.plan(&applied)?;
        let fresh_local_database = applied.is_empty();
        let mut skipped = applied
            .iter()
            .map(|(filename, _)| filename.clone())
            .collect::<Vec<_>>();
        let mut applied_now = Vec::new();
        for migration in pending {
            let mut tx = pool.begin().await.map_err(|_| MigrationError::Database)?;
            // Historical bytes are immutable, but a new self-hosted ZAIPOS store
            // must not install the old demonstration business. Record its exact
            // checksum in the local ledger so later verification still detects
            // tampering, while leaving the fresh database eligible for bootstrap.
            if fresh_local_database && migration.filename == HISTORICAL_DEMO_SEED {
                sqlx::query(
                    "insert into public.zaipos_schema_migrations
                     (filename, sha256, app_version, started_at, completed_at)
                     values ($1, $2, $3, now(), now())",
                )
                .bind(&migration.filename)
                .bind(&migration.sha256)
                .bind(env!("CARGO_PKG_VERSION"))
                .execute(&mut *tx)
                .await
                .map_err(|_| MigrationError::Apply {
                    filename: migration.filename.clone(),
                })?;
                tx.commit().await.map_err(|_| MigrationError::Apply {
                    filename: migration.filename.clone(),
                })?;
                skipped.push(migration.filename.clone());
                continue;
            }
            sqlx::query(
                "insert into public.zaipos_schema_migrations (filename, sha256, app_version, started_at)
                 values ($1, $2, $3, now())",
            )
            .bind(&migration.filename)
            .bind(&migration.sha256)
            .bind(env!("CARGO_PKG_VERSION"))
            .execute(&mut *tx)
            .await
            .map_err(|_| MigrationError::Apply {
                filename: migration.filename.clone(),
            })?;
            sqlx::raw_sql(&migration.sql)
                .execute(&mut *tx)
                .await
                .map_err(|_| MigrationError::Apply {
                    filename: migration.filename.clone(),
                })?;
            sqlx::query(
                "update public.zaipos_schema_migrations set completed_at = now(), failure_detail = null where filename = $1",
            )
            .bind(&migration.filename)
            .execute(&mut *tx)
            .await
            .map_err(|_| MigrationError::Apply {
                filename: migration.filename.clone(),
            })?;
            tx.commit().await.map_err(|_| MigrationError::Apply {
                filename: migration.filename.clone(),
            })?;
            applied_now.push(migration.filename.clone());
        }
        Ok(MigrationReport {
            applied: applied_now,
            skipped,
        })
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_source_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 160
        && name.ends_with(".sql")
        && !name.contains("..")
        && !name.contains('/')
        && !name.contains('\\')
        && name
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '_' | '-' | '.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tampered_history_does_not_plan_later_migrations() {
        let original = MigrationRunner::from_sources(&[(
            "001_base.sql",
            "create table base_fixture(id int primary key);",
        )])
        .unwrap();
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
        let applied = vec![(
            "001_base.sql".to_string(),
            original.migrations[0].sha256.clone(),
        )];
        assert!(matches!(
            tampered.plan(&applied),
            Err(MigrationError::ChecksumMismatch { .. })
        ));
    }

    #[test]
    fn embedded_chain_matches_bytes() {
        let runner = MigrationRunner::embedded().unwrap();
        assert!(runner.len() >= 131);
        assert!(
            runner
                .migrations
                .windows(2)
                .all(|pair| pair[0].filename < pair[1].filename)
        );
    }
}
