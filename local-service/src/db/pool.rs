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
        Self::connect_url(&provisioned.service_url()).await
    }

    pub async fn connect_owner(provisioned: &ProvisionedDatabase) -> Result<Self, DbError> {
        Self::connect_url(&provisioned.owner_url(&provisioned.database_name)).await
    }

    pub async fn connect_url(connection: &str) -> Result<Self, DbError> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .connect(connection)
            .await
            .map_err(|_| DbError::Connection)?;
        Ok(Self { pool })
    }

    pub(crate) fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Prepare the minimum Supabase-compatible database primitives required by
    /// the immutable historical migration chain. No hosted service is involved.
    pub async fn prepare_local_compatibility(&self) -> Result<(), DbError> {
        let sql = r#"
        create schema if not exists extensions;
        create extension if not exists pgcrypto with schema extensions;

        create schema if not exists auth;
        create table if not exists auth.users (
          instance_id uuid,
          id uuid primary key,
          aud varchar(255),
          role varchar(255),
          email varchar(255),
          encrypted_password varchar(255),
          email_confirmed_at timestamptz,
          invited_at timestamptz,
          confirmation_token varchar(255),
          confirmation_sent_at timestamptz,
          recovery_token varchar(255),
          recovery_sent_at timestamptz,
          email_change_token_new varchar(255),
          email_change varchar(255),
          email_change_sent_at timestamptz,
          last_sign_in_at timestamptz,
          raw_app_meta_data jsonb not null default '{}'::jsonb,
          raw_user_meta_data jsonb not null default '{}'::jsonb,
          is_super_admin boolean,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          phone text,
          phone_confirmed_at timestamptz,
          phone_change text default '',
          phone_change_token varchar(255) default '',
          phone_change_sent_at timestamptz,
          email_change_token_current varchar(255) default '',
          email_change_confirm_status smallint default 0,
          banned_until timestamptz,
          reauthentication_token varchar(255) default '',
          reauthentication_sent_at timestamptz,
          is_sso_user boolean not null default false,
          deleted_at timestamptz,
          is_anonymous boolean not null default false
        );
        create or replace function auth.uid()
        returns uuid language sql stable as $$
          select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
        $$;
        create or replace function auth.role()
        returns text language sql stable as $$
          select coalesce(
            nullif(current_setting('request.jwt.claim.role', true), ''),
            nullif(current_setting('role', true), ''),
            current_user
          )
        $$;
        create or replace function auth.jwt()
        returns jsonb language sql stable as $$
          select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
        $$;

        create schema if not exists storage;
        create table if not exists storage.buckets (
          id text primary key,
          name text not null unique,
          public boolean not null default false,
          file_size_limit bigint,
          allowed_mime_types text[]
        );
        create table if not exists storage.objects (
          id uuid primary key default gen_random_uuid(),
          bucket_id text references storage.buckets(id),
          name text not null,
          owner uuid,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          metadata jsonb
        );
        create or replace function storage.foldername(name text)
        returns text[] language sql immutable parallel safe as $$
          select (string_to_array(name, '/'))[
            1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)
          ]
        $$;
        "#;
        sqlx::raw_sql(sql)
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|_| DbError::Connection)
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
