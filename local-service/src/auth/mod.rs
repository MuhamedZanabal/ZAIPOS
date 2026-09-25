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
    SetupRequired,
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
    if username.is_empty() || password.is_empty() {
        return Err(AuthError::Rejected);
    }
    if tenant_id.is_empty() && branch_id.is_empty() && device_id.is_empty() {
        return login_without_scope(db, &username, password).await;
    }
    if !is_uuid(tenant_id) || !is_uuid(branch_id) || !is_uuid(device_id) {
        return Err(AuthError::Rejected);
    }
    issue_session(db, &username, password, tenant_id, branch_id, device_id).await
}

async fn login_without_scope(
    db: &Database,
    username: &str,
    password: &str,
) -> Result<Value, AuthError> {
    let total: (i64,) = sqlx::query_as("select count(*)::bigint from public.zaipos_local_users")
        .fetch_one(db.pool())
        .await
        .map_err(|_| AuthError::Unavailable)?;
    if total.0 == 0 {
        return Err(AuthError::SetupRequired);
    }
    let rows = sqlx::query(
        "select u.id::text as id, u.tenant_id::text as tenant_id, u.branch_id::text as branch_id, u.password_hash, u.active,
                (select d.id::text from public.zaipos_local_devices d
                  where d.tenant_id = u.tenant_id and d.branch_id = u.branch_id and not d.revoked
                  order by d.id limit 1) as device_id
         from public.zaipos_local_users u
         where u.username = $1",
    )
    .bind(username)
    .fetch_all(db.pool())
    .await
    .map_err(|_| AuthError::Unavailable)?;
    if rows.len() != 1 {
        return Err(AuthError::Unauthorized);
    }
    let user = &rows[0];
    let Some(device_id) = user
        .try_get::<Option<String>, _>("device_id")
        .ok()
        .flatten()
    else {
        return Err(AuthError::Unauthorized);
    };
    issue_session(
        db,
        username,
        password,
        user.get::<String, _>("tenant_id").as_str(),
        user.get::<String, _>("branch_id").as_str(),
        device_id.as_str(),
    )
    .await
}

async fn issue_session(
    db: &Database,
    username: &str,
    password: &str,
    tenant_id: &str,
    branch_id: &str,
    device_id: &str,
) -> Result<Value, AuthError> {
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
    .bind(username)
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

pub async fn session_user_id(db: &Database, token: &str) -> Result<String, AuthError> {
    if token.len() < 32 || token.len() > 256 {
        return Err(AuthError::Unauthorized);
    }
    let row = sqlx::query(
        "select user_id::text as user_id from public.zaipos_local_sessions
         where token_hash = $1 and revoked = false and expires_at > now()",
    )
    .bind(sha256_hex(token.as_bytes()))
    .fetch_optional(db.pool())
    .await
    .map_err(|_| AuthError::Unavailable)?;
    row.map(|row| row.get("user_id"))
        .ok_or(AuthError::Unauthorized)
}

pub async fn bootstrap_owner(db: &Database, body: &Value) -> Result<Value, AuthError> {
    let username = normalize_username(body.get("email").and_then(Value::as_str).unwrap_or(""));
    let password = body.get("password").and_then(Value::as_str).unwrap_or("");
    let tenant_name = body
        .get("tenant_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let branch_name = body
        .get("branch_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if username.is_empty()
        || !(8..=1024).contains(&password.len())
        || tenant_name.is_empty()
        || tenant_name.len() > 80
        || branch_name.is_empty()
        || branch_name.len() > 80
    {
        return Err(AuthError::Rejected);
    }
    let hash = hash_password(password).map_err(|_| AuthError::Rejected)?;
    let mut tx = db
        .pool()
        .begin()
        .await
        .map_err(|_| AuthError::Unavailable)?;
    sqlx::query("select pg_advisory_xact_lock($1)")
        .bind(7_820_192_510_i64)
        .execute(&mut *tx)
        .await
        .map_err(|_| AuthError::Unavailable)?;
    let total: (i64,) = sqlx::query_as("select count(*)::bigint from public.zaipos_local_users")
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| AuthError::Unavailable)?;
    if total.0 != 0 {
        return Err(AuthError::Forbidden);
    }
    let (mut tenant_id, mut branch_id, user_id, device_id): (String, String, String, String) =
        sqlx::query_as(
            "select gen_random_uuid()::text, gen_random_uuid()::text, gen_random_uuid()::text, gen_random_uuid()::text",
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| AuthError::Unavailable)?;
    let business: (bool,) = sqlx::query_as(
        "select to_regprocedure('public.bootstrap_tenant_v2(text,text,numeric,text)') is not null",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| AuthError::Unavailable)?;
    if business.0 {
        sqlx::query(
            "insert into auth.users (id, email, raw_user_meta_data)
             values ($1::uuid, $2, jsonb_build_object('full_name', $2))",
        )
        .bind(&user_id)
        .bind(&username)
        .execute(&mut *tx)
        .await
        .map_err(|_| AuthError::Unavailable)?;
        sqlx::query("select set_config('request.jwt.claim.sub', $1, true)")
            .bind(&user_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| AuthError::Unavailable)?;
        sqlx::query("select set_config('request.jwt.claim.role', 'authenticated', true)")
            .execute(&mut *tx)
            .await
            .map_err(|_| AuthError::Unavailable)?;
        let can_assume: (bool,) =
            sqlx::query_as("select exists(select 1 from pg_roles where rolname = 'authenticated')")
                .fetch_one(&mut *tx)
                .await
                .map_err(|_| AuthError::Unavailable)?;
        let original_role: (String,) = sqlx::query_as("select current_user")
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| AuthError::Unavailable)?;
        if can_assume.0 {
            sqlx::query("select set_config('role', 'authenticated', true)")
                .execute(&mut *tx)
                .await
                .map_err(|_| AuthError::Unavailable)?;
        }
        let created: (String, String) = sqlx::query_as(
            "select tenant_id::text, branch_id::text from public.bootstrap_tenant_v2($1, $2, 10, 'RETAIL')",
        )
        .bind(tenant_name)
        .bind(branch_name)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| AuthError::Unavailable)?;
        if can_assume.0 {
            sqlx::query("select set_config('role', $1, true)")
                .bind(original_role.0)
                .execute(&mut *tx)
                .await
                .map_err(|_| AuthError::Unavailable)?;
        }
        tenant_id = created.0;
        branch_id = created.1;
    } else {
        let tenants: (bool,) = sqlx::query_as("select to_regclass('public.tenants') is not null")
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| AuthError::Unavailable)?;
        if tenants.0 {
            let slug = slug_for(&username, &tenant_id);
            sqlx::query(
                "insert into public.tenants (id, name, slug, currency, tax_rate, business_mode)
                 values ($1::uuid, $2, $3, 'BHD', 10, 'RETAIL')",
            )
            .bind(&tenant_id)
            .bind(tenant_name)
            .bind(&slug)
            .execute(&mut *tx)
            .await
            .map_err(|_| AuthError::Unavailable)?;
            sqlx::query(
                "insert into public.branches (id, tenant_id, name) values ($1::uuid, $2::uuid, $3)",
            )
            .bind(&branch_id)
            .bind(&tenant_id)
            .bind(branch_name)
            .execute(&mut *tx)
            .await
            .map_err(|_| AuthError::Unavailable)?;
            sqlx::query(
                "insert into auth.users (id, email, raw_user_meta_data)
                 values ($1::uuid, $2, jsonb_build_object('full_name', $2))",
            )
            .bind(&user_id)
            .bind(&username)
            .execute(&mut *tx)
            .await
            .map_err(|_| AuthError::Unavailable)?;
            sqlx::query(
                "insert into public.user_roles (user_id, tenant_id, branch_id, role)
                 values ($1::uuid, $2::uuid, $3::uuid, 'owner')",
            )
            .bind(&user_id)
            .bind(&tenant_id)
            .bind(&branch_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| AuthError::Unavailable)?;
            sqlx::query(
                "insert into public.cash_registers (tenant_id, branch_id, name)
                 values ($1::uuid, $2::uuid, 'Front counter')",
            )
            .bind(&tenant_id)
            .bind(&branch_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| AuthError::Unavailable)?;
        }
    }
    sqlx::query(
        "insert into public.zaipos_local_devices (id, tenant_id, branch_id, revoked)
         values ($1::uuid, $2::uuid, $3::uuid, false)",
    )
    .bind(&device_id)
    .bind(&tenant_id)
    .bind(&branch_id)
    .execute(&mut *tx)
    .await
    .map_err(|_| AuthError::Unavailable)?;
    sqlx::query(
        "insert into public.zaipos_local_users (id, tenant_id, branch_id, username, password_hash, active)
         values ($1::uuid, $2::uuid, $3::uuid, $4, $5, true)",
    )
    .bind(&user_id)
    .bind(&tenant_id)
    .bind(&branch_id)
    .bind(&username)
    .bind(&hash)
    .execute(&mut *tx)
    .await
    .map_err(|_| AuthError::Unavailable)?;
    let token = random_token();
    sqlx::query(
        "insert into public.zaipos_local_sessions (id, user_id, device_id, token_hash, expires_at)
         values (gen_random_uuid(), $1::uuid, $2::uuid, $3, now() + interval '12 hours')",
    )
    .bind(&user_id)
    .bind(&device_id)
    .bind(sha256_hex(token.as_bytes()))
    .execute(&mut *tx)
    .await
    .map_err(|_| AuthError::Unavailable)?;
    tx.commit().await.map_err(|_| AuthError::Unavailable)?;
    Ok(json!({
        "session": {
            "access_token": token,
            "expires_at": null,
            "user": { "id": user_id, "email": username }
        }
    }))
}

fn slug_for(username: &str, tenant_id: &str) -> String {
    let mut slug: String = username
        .chars()
        .filter(|char| char.is_ascii_alphanumeric())
        .flat_map(|char| char.to_lowercase())
        .take(24)
        .collect();
    if slug.is_empty() {
        slug.push_str("shop");
    }
    slug.push('-');
    slug.push_str(&tenant_id[..8]);
    slug
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
