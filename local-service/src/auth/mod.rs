mod password;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use unicode_normalization::UnicodeNormalization;

use crate::db::{Database, DbError};

pub use password::{hash_password, verify_password};

const IDENTITY_DDL: &str = "
create table if not exists public.zaipos_local_users (
  id uuid primary key,
  tenant_id uuid not null,
  branch_id uuid not null,
  username text not null,
  password_hash text not null,
  active boolean not null default true,
  unique (tenant_id, username)
);
create table if not exists public.zaipos_local_devices (
  id uuid primary key,
  tenant_id uuid not null,
  branch_id uuid not null,
  revoked boolean not null default false
);
create table if not exists public.zaipos_local_sessions (
  id uuid primary key,
  user_id uuid not null references public.zaipos_local_users(id),
  device_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked boolean not null default false
);
";

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    Unavailable,
    Unauthorized,
    Forbidden,
    Rejected,
}

pub async fn ensure_identity(db: &Database) -> Result<(), DbError> {
    sqlx::raw_sql(IDENTITY_DDL)
        .execute(db.pool())
        .await
        .map(|_| ())
        .map_err(|_| DbError::Connection)
}

pub fn normalize_username(value: &str) -> String {
    value.trim().nfc().collect::<String>().to_lowercase()
}

pub async fn login(db: &Database, body: &Value) -> Result<Value, AuthError> {
    let username = normalize_username(body.get("email").and_then(Value::as_str).unwrap_or(""));
    let password = body.get("password").and_then(Value::as_str).unwrap_or("");
    let tenant_id = body.get("tenant_id").and_then(Value::as_str).unwrap_or("");
    let branch_id = body.get("branch_id").and_then(Value::as_str).unwrap_or("");
    let device_id = body.get("device_id").and_then(Value::as_str).unwrap_or("");
    if username.is_empty()
        || password.is_empty()
        || !is_uuid(tenant_id)
        || !is_uuid(branch_id)
        || !is_uuid(device_id)
    {
        return Err(AuthError::Rejected);
    }
    let device = sqlx::query(
        "select revoked from public.zaipos_local_devices where id = $1::uuid and tenant_id = $2::uuid and branch_id = $3::uuid",
    )
    .bind(device_id)
    .bind(tenant_id)
    .bind(branch_id)
    .fetch_optional(db.pool())
    .await
    .map_err(|_| AuthError::Unavailable)?;
    if device.is_none_or(|row| row.get::<bool, _>("revoked")) {
        return Err(AuthError::Unauthorized);
    }
    let user = sqlx::query(
        "select id::text as id, password_hash, active from public.zaipos_local_users where tenant_id = $1::uuid and branch_id = $2::uuid and username = $3",
    )
    .bind(tenant_id)
    .bind(branch_id)
    .bind(&username)
    .fetch_optional(db.pool())
    .await
    .map_err(|_| AuthError::Unavailable)?;
    let Some(user) = user else {
        return Err(AuthError::Unauthorized);
    };
    if !user.get::<bool, _>("active") {
        return Err(AuthError::Forbidden);
    }
    if !verify_password(password, user.get::<String, _>("password_hash").as_str()) {
        return Err(AuthError::Unauthorized);
    }
    let token = random_token();
    let token_hash = sha256_hex(token.as_bytes());
    let user_id: String = user.get("id");
    sqlx::query(
        "insert into public.zaipos_local_sessions (id, user_id, device_id, token_hash, expires_at)
         values (gen_random_uuid(), $1::uuid, $2::uuid, $3, now() + interval '12 hours')",
    )
    .bind(&user_id)
    .bind(device_id)
    .bind(&token_hash)
    .execute(db.pool())
    .await
    .map_err(|_| AuthError::Unavailable)?;
    Ok(json!({
        "session": {
            "access_token": token,
            "expires_at": null,
            "user": { "id": user_id, "email": username }
        }
    }))
}

fn is_uuid(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 5
        && parts[0].len() == 8
        && parts[1].len() == 4
        && parts[2].len() == 4
        && parts[3].len() == 4
        && parts[4].len() == 12
        && value
            .chars()
            .all(|char| char.is_ascii_hexdigit() || char == '-')
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("session token entropy");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames_normalize_to_the_same_identity() {
        let composed = "Café";
        let decomposed = "Cafe\u{0301}";
        assert_eq!(normalize_username(composed), normalize_username(decomposed));
    }
}
