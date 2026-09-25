use secrecy::ExposeSecret;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use thiserror::Error;

use crate::provisioning::ProvisionedDatabase;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DbError {
    #[error("postgres connection failed")]
    Connection,
    #[error("postgres table is not present")]
    UndefinedTable,
}

#[derive(Clone)]
pub struct Database {
    pool: PgPool,
}

impl Database {
    pub async fn connect(provisioned: &ProvisionedDatabase) -> Result<Self, DbError> {
        let connection = format!(
            "postgres://zaipos_service:{}@{}:{}/{}?sslmode=require",
            provisioned.credential().expose_secret(),
            provisioned.socket_host(),
            provisioned.port,
            provisioned.database_name
        );
        Self::connect_url(&connection).await
    }

    pub async fn connect_url(connection: &str) -> Result<Self, DbError> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(connection)
            .await
            .map_err(|_| DbError::Connection)?;
        Ok(Self { pool })
    }

    pub(crate) fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn is_ready(&self) -> Result<(), DbError> {
        sqlx::query("select 1")
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|_| DbError::Connection)
    }

    pub async fn count_table(&self, table: &str) -> Result<i64, DbError> {
        if !table
            .chars()
            .all(|char| char.is_ascii_lowercase() || char.is_ascii_digit() || char == '_')
            || table.is_empty()
        {
            return Err(DbError::Connection);
        }
        let sql = format!("select count(*)::bigint from {table}");
        let row: (i64,) = sqlx::query_as(&sql)
            .fetch_one(&self.pool)
            .await
            .map_err(|error| {
                if let sqlx::Error::Database(db) = &error
                    && db.code().as_deref() == Some("42P01")
                {
                    return DbError::UndefinedTable;
                }
                DbError::Connection
            })?;
        Ok(row.0)
    }

    #[cfg(feature = "test-utils")]
    pub async fn exec(&self, sql: &str) -> Result<(), DbError> {
        sqlx::raw_sql(sql)
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|_| DbError::Connection)
    }
}

impl std::fmt::Debug for Database {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Database")
            .field("pool", &"<redacted>")
            .finish()
    }
}

#[cfg(feature = "test-utils")]
pub struct EphemeralDatabase {
    database: Database,
    admin: PgPool,
    name: String,
}

#[cfg(feature = "test-utils")]
impl EphemeralDatabase {
    pub async fn open() -> Option<Self> {
        let url = std::env::var("ZAIPOS_TEST_DATABASE_URL").ok()?;
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .ok()?;
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).ok()?;
        let name = format!(
            "zaipos_{}",
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        sqlx::query(&format!("create database {name}"))
            .execute(&admin)
            .await
            .ok()?;
        let connection = with_database(&url, &name);
        let database = Database::connect_url(&connection).await.ok()?;
        Some(Self {
            database,
            admin,
            name,
        })
    }

    pub fn database(&self) -> &Database {
        &self.database
    }

    pub async fn close(self) {
        drop(self.database);
        let _ = sqlx::query(&format!(
            "select pg_terminate_backend(pid) from pg_stat_activity where datname = '{}' and pid <> pg_backend_pid()",
            self.name
        ))
        .execute(&self.admin)
        .await;
        let _ = sqlx::query(&format!("drop database if exists {}", self.name))
            .execute(&self.admin)
            .await;
    }
}

#[cfg(feature = "test-utils")]
fn with_database(admin_url: &str, name: &str) -> String {
    let (base, query) = admin_url.split_once('?').unwrap_or((admin_url, ""));
    let prefix = base
        .rsplit_once('/')
        .map(|(prefix, _)| prefix)
        .unwrap_or(base);
    if query.is_empty() {
        format!("{prefix}/{name}")
    } else {
        format!("{prefix}/{name}?{query}")
    }
}
