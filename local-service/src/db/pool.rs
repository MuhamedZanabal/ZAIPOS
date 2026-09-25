use secrecy::ExposeSecret;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use thiserror::Error;

use crate::provisioning::ProvisionedDatabase;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("postgres connection failed")]
    Connection,
}

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
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&connection)
            .await
            .map_err(|_| DbError::Connection)?;
        Ok(Self { pool })
    }

    pub async fn is_ready(&self) -> Result<(), DbError> {
        sqlx::query("select 1")
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
