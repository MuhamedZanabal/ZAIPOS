//! Local port of the `pos-pin` edge function: cashier PINs are argon2id hashed
//! here and stored/verified through the existing SECURITY DEFINER functions,
//! which enforce branch roles, the five-attempt lockout and the attempt audit
//! trail (`employee_pos_pin_attempts`).
use serde_json::{Value, json};

use crate::auth::password::{hash_password, verify_password};
use crate::db::Database;

pub fn uuid_like(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

pub fn valid_pin(pin: &str) -> bool {
    (4..=8).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= (a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0)) as usize;
    }
    diff == 0
}

/// Like the hosted edge function, the PIN functions run as `service_role`; the
/// SECURITY DEFINER functions still check the actor's branch role themselves.
async fn service_tx(
    pool: &sqlx::PgPool,
) -> Result<sqlx::Transaction<'static, sqlx::Postgres>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let can_assume: bool = sqlx::query_scalar(
        "select exists(select 1 from pg_roles where rolname = 'service_role')
            and pg_has_role(current_user, 'service_role', 'MEMBER')",
    )
    .fetch_one(&mut *tx)
    .await?;
    if can_assume {
        sqlx::query("set local role service_role")
            .execute(&mut *tx)
            .await?;
    }
    Ok(tx)
}

async fn scalar_as_service<T>(
    pool: &sqlx::PgPool,
    sql: &str,
    binds: Vec<Option<String>>,
) -> Result<T, sqlx::Error>
where
    T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + Unpin,
{
    let mut tx = service_tx(pool).await?;
    let mut query = sqlx::query_scalar::<_, T>(sql);
    for bind in binds {
        query = query.bind(bind);
    }
    let value = query.fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(value)
}

fn operation_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("os randomness");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Returns (http status, body).
pub async fn handle(database: &Database, caller: &str, body: &Value) -> (u16, Value) {
    let field = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let (tenant, branch, employee, pin) = (
        field("tenant_id"),
        field("branch_id"),
        field("employee_id"),
        field("pin"),
    );
    if !uuid_like(&tenant) || !uuid_like(&branch) || !uuid_like(&employee) || !valid_pin(&pin) {
        return (
            400,
            json!({"error": "Tenant, branch, employee and a 4–8 digit PIN are required"}),
        );
    }
    let pool = database.pool();
    let db_error = |e: sqlx::Error| {
        let forbidden = e
            .as_database_error()
            .and_then(|d| d.code())
            .is_some_and(|c| c == "42501");
        let message = e
            .as_database_error()
            .map(|d| d.message().to_string())
            .unwrap_or_else(|| "POS PIN request failed".to_string());
        (if forbidden { 403 } else { 400 }, json!({"error": message}))
    };
    match field("action").as_str() {
        "set" => {
            let Ok(hash) = hash_password(&pin) else {
                return (400, json!({"error": "PIN rejected"}));
            };
            match scalar_as_service::<String>(
                pool,
                "select public.set_employee_pos_pin_v1($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)::text",
                vec![Some(caller.to_string()), Some(tenant.clone()), Some(branch.clone()), Some(employee.clone()), Some(hash), Some(operation_id())],
            )
            .await
            {
                Ok(credential) => (200, json!({"employee_id": employee, "credential_id": credential, "algorithm": "argon2id"})),
                Err(e) => db_error(e),
            }
        }
        "verify" => {
            let device = field("device_uid");
            let session = field("cash_session_id");
            if device.len() < 8 || (!session.is_empty() && !uuid_like(&session)) {
                return (
                    400,
                    json!({"error": "A registered device and valid session context are required"}),
                );
            }
            let prepared = match scalar_as_service::<Value>(
                pool,
                "select to_jsonb(public.begin_employee_pos_pin_verification_v1($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, nullif($6, '')::uuid, $7))",
                vec![Some(caller.to_string()), Some(tenant.clone()), Some(branch.clone()), Some(employee.clone()), Some(device.clone()), Some(session.clone()), Some(operation_id())],
            )
            .await
            {
                Ok(value) => value,
                Err(e) => return db_error(e),
            };
            if prepared.get("allowed").and_then(Value::as_bool) != Some(true) {
                return (
                    423,
                    json!({"error": "POS PIN is temporarily locked", "locked_until": prepared.get("locked_until")}),
                );
            }
            let mut replacement: Option<String> = None;
            let verified = if let Some(hash) = prepared.get("pin_hash").and_then(Value::as_str) {
                verify_password(&pin, hash)
            } else if let Some(legacy) = prepared.get("legacy_pin").and_then(Value::as_str) {
                let ok = constant_time_eq(legacy, &pin);
                if ok {
                    replacement = hash_password(&pin).ok();
                }
                ok
            } else {
                false
            };
            let attempt = prepared
                .get("attempt_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            match scalar_as_service::<Value>(
                pool,
                "select to_jsonb(public.complete_employee_pos_pin_verification_v1($1::uuid, $2::uuid, $3::boolean, $4))",
                vec![Some(caller.to_string()), Some(attempt), Some(verified.to_string()), replacement],
            )
            .await
            {
                Ok(result) => {
                    let ok = result.get("verified").and_then(Value::as_bool) == Some(true);
                    (if ok { 200 } else { 401 }, result)
                }
                Err(e) => db_error(e),
            }
        }
        _ => (400, json!({"error": "Unknown POS PIN action"})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_and_id_validation() {
        assert!(valid_pin("1234") && valid_pin("12345678"));
        assert!(
            !valid_pin("123") && !valid_pin("123456789") && !valid_pin("12a4") && !valid_pin("")
        );
        assert!(uuid_like("3f2c9a1e-0000-4000-8000-000000000001"));
        assert!(!uuid_like("3f2c9a1e-0000-4000-8000-00000000000g"));
        assert!(
            constant_time_eq("1234", "1234")
                && !constant_time_eq("1234", "1235")
                && !constant_time_eq("1234", "12345")
        );
        assert_eq!(operation_id().len(), 32);
    }

    #[test]
    fn pin_hash_matches_the_database_argon2id_format() {
        let hash = hash_password("4821").unwrap();
        assert!(
            hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"),
            "{hash}"
        );
        assert!(verify_password("4821", &hash) && !verify_password("4822", &hash));
    }
}
