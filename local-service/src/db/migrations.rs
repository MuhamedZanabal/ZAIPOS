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
        let mut connection = db
            .pool()
            .acquire()
            .await
            .map_err(|_| MigrationError::Database)?;
        sqlx::query("select pg_advisory_lock($1)")
            .bind(MIGRATION_LOCK)
            .execute(&mut *connection)
            .await
            .map_err(|_| MigrationError::Database)?;
        let result = self.apply_locked(&mut connection).await;
        let _ = sqlx::query("select pg_advisory_unlock($1)")
            .bind(MIGRATION_LOCK)
            .execute(&mut *connection)
            .await;
        result
    }

    async fn apply_locked(
        &self,
        connection: &mut sqlx::PgConnection,
    ) -> Result<MigrationReport, MigrationError> {
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
        .execute(&mut *connection)
        .await
        .map_err(|_| MigrationError::Database)?;
        let rows = sqlx::query(
            "select filename, sha256 from public.zaipos_schema_migrations
             where completed_at is not null
             order by filename",
        )
        .fetch_all(&mut *connection)
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
            if fresh_local_database && migration.filename == HISTORICAL_DEMO_SEED {
                self.record_applied(connection, migration).await?;
                skipped.push(migration.filename.clone());
                continue;
            }
            // Historical files were authored for PostgreSQL autocommit. A new enum
            // value cannot be used until its ALTER TYPE commits, and several files
            // issue their own COMMIT. One transaction per file cannot apply them.
            sqlx::raw_sql("set search_path to public, extensions")
                .execute(&mut *connection)
                .await
                .map_err(|_| MigrationError::Database)?;
            for statement in split_sql_statements(&migration.sql) {
                sqlx::raw_sql(&statement)
                    .execute(&mut *connection)
                    .await
                    .map_err(|error| MigrationError::Apply {
                        filename: migration.filename.clone(),
                        detail: database_error_detail(&error),
                    })?;
            }
            self.record_applied(connection, migration).await?;
            applied_now.push(migration.filename.clone());
        }
        Ok(MigrationReport {
            applied: applied_now,
            skipped,
        })
    }

    async fn record_applied(
        &self,
        connection: &mut sqlx::PgConnection,
        migration: &Migration,
    ) -> Result<(), MigrationError> {
        sqlx::query(
            "insert into public.zaipos_schema_migrations
             (filename, sha256, app_version, started_at, completed_at)
             values ($1, $2, $3, now(), now())",
        )
        .bind(&migration.filename)
        .bind(&migration.sha256)
        .bind(env!("CARGO_PKG_VERSION"))
        .execute(&mut *connection)
        .await
        .map_err(|error| MigrationError::Apply {
            filename: migration.filename.clone(),
            detail: database_error_detail(&error),
        })?;
        Ok(())
    }
}

fn database_error_detail(error: &sqlx::Error) -> String {
    if let sqlx::Error::Database(database) = error {
        let code = database.code().map(|value| value.into_owned()).unwrap_or_else(|| "unknown".to_string());
        return format!("SQLSTATE {code}: {}", database.message());
    }
    error.to_string()
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

/// Split a migration file the way psql does: one statement per semicolon,
/// without cutting dollar-quoted function bodies, strings, or comments.
fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut chars = sql.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '-' if chars.peek() == Some(&'-') => {
                current.push(character);
                current.push(chars.next().unwrap_or('-'));
                for next in chars.by_ref() {
                    current.push(next);
                    if next == '\n' {
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                current.push(character);
                current.push(chars.next().unwrap_or('*'));
                let mut previous = '\0';
                for next in chars.by_ref() {
                    current.push(next);
                    if previous == '*' && next == '/' {
                        break;
                    }
                    previous = next;
                }
            }
            '\'' | '"' => {
                current.push(character);
                while let Some(next) = chars.next() {
                    current.push(next);
                    if next == character {
                        if chars.peek() == Some(&character) {
                            current.push(chars.next().unwrap_or(character));
                            continue;
                        }
                        break;
                    }
                }
            }
            '$' => {
                let mut tag = String::from("$");
                let mut closed = false;
                while let Some(next) = chars.peek().copied() {
                    if next == '$' {
                        tag.push(next);
                        chars.next();
                        closed = true;
                        break;
                    }
                    if next.is_ascii_alphanumeric() || next == '_' {
                        tag.push(next);
                        chars.next();
                        continue;
                    }
                    break;
                }
                current.push_str(&tag);
                if closed {
                    let mut window = String::new();
                    for next in chars.by_ref() {
                        current.push(next);
                        window.push(next);
                        if window.ends_with(&tag) {
                            break;
                        }
                    }
                }
            }
            ';' => {
                let trimmed = current.trim();
                if !trimmed.is_empty() {
                    statements.push(trimmed.to_string());
                }
                current.clear();
            }
            _ => current.push(character),
        }
    }
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        statements.push(trimmed.to_string());
    }
    statements
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

    #[test]
    fn sql_statements_keep_function_bodies_and_commit_enum_values_separately() {
        let sql = "ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'super_admin';
CREATE OR REPLACE FUNCTION public.has_role()
RETURNS boolean LANGUAGE sql AS $$
  SELECT 1;
  SELECT ';';
$$;
-- comment with a semicolon;
SELECT 'a;b';";
        let statements = split_sql_statements(sql);
        assert_eq!(statements.len(), 3);
        assert!(statements[0].contains("ADD VALUE"));
        assert!(!statements[0].contains("CREATE OR REPLACE"));
        assert!(statements[1].contains("SELECT 1;"));
        assert!(statements[1].contains("SELECT ';'"));
        assert!(statements[2].contains("SELECT 'a;b'"));
        assert!(!statements[2].contains("CREATE OR REPLACE"));

        let runner = MigrationRunner::embedded().unwrap();
        let super_admin = runner
            .migrations
            .iter()
            .find(|migration| migration.filename.contains("super_admin_role"))
            .unwrap();
        let real = split_sql_statements(&super_admin.sql);
        assert!(real.len() >= 3);
        assert!(real[0].contains("ADD VALUE"));
        assert!(!real[0].contains("CREATE OR REPLACE"));
        assert!(real.iter().any(|statement| {
            statement.contains("has_any_role") && statement.contains("super_admin")
        }));
        for migration in &runner.migrations {
            let parts = split_sql_statements(&migration.sql);
            assert!(!parts.is_empty(), "{}", migration.filename);
        }
    }
}
