//! Local replacement for the hosted `activate-device` edge function.
//!
//! The hosted function checked the approval and the caller's branch role, then
//! called `activate_device_enrollment` as `service_role`. The local service is
//! the trusted server process, so it applies the same checks before assuming
//! `service_role` for the single activation call.

use serde_json::{Value, json};

use super::read_model::{ExecError, map_command};
use crate::db::Database;

fn text<'a>(arguments: &'a Value, key: &str, max: usize) -> Result<&'a str, ExecError> {
    let value = arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if value.is_empty() || value.len() > max {
        return Err(ExecError::Rejected);
    }
    Ok(value)
}

fn rejected() -> ExecError {
    ExecError::Failed {
        code: "42501".to_string(),
        message: "Activation approval rejected".to_string(),
    }
}

pub async fn activate_device(
    db: &Database,
    arguments: &Value,
    user_id: &str,
) -> Result<Value, ExecError> {
    let approval_id = text(arguments, "approval_id", 64)?;
    let device_uid = text(arguments, "device_uid", 128)?;
    let app_version = text(arguments, "app_version", 64)?;
    let os = text(arguments, "os", 64)?;
    let mut tx = db.pool().begin().await.map_err(map_command)?;
    let (can_assume,): (bool,) = sqlx::query_as(
        "select exists(select 1 from pg_roles where rolname = 'service_role')
            and pg_has_role(current_user, 'service_role', 'MEMBER')",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(map_command)?;
    if can_assume {
        sqlx::query("set local role service_role")
            .execute(&mut *tx)
            .await
            .map_err(map_command)?;
    }
    let approval: Option<(String, String, String, Option<String>, bool)> = sqlx::query_as(
        "select tenant_id::text, branch_id::text, device_uid, approved_by::text,
                consumed_at is null and expires_at > now()
           from public.device_enrollment_approvals
          where id::text = $1
          for update",
    )
    .bind(approval_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(map_command)?;
    let Some((tenant_id, branch_id, approved_uid, approved_by, usable)) = approval else {
        return Err(rejected());
    };
    if approved_by.as_deref() != Some(user_id) || approved_uid != device_uid || !usable {
        return Err(rejected());
    }
    let (allowed,): (bool,) = sqlx::query_as(
        "select public.has_branch_role($1::uuid, $2::uuid, $3::uuid,
                array['owner', 'admin', 'manager']::public.app_role[])",
    )
    .bind(user_id)
    .bind(&tenant_id)
    .bind(&branch_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(map_command)?;
    if !allowed {
        return Err(rejected());
    }
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "select device_id::text, device_uid, credential
           from public.activate_device_enrollment($1::uuid, $2, $3)",
    )
    .bind(approval_id)
    .bind(app_version)
    .bind(os)
    .fetch_all(&mut *tx)
    .await
    .map_err(map_command)?;
    let [(device_id, activated_uid, credential)] = rows.as_slice() else {
        return Err(ExecError::Failed {
            code: "ZX001".to_string(),
            message: "Device activation failed".to_string(),
        });
    };
    if activated_uid != device_uid
        || credential.len() != 64
        || !credential.chars().all(|char| char.is_ascii_hexdigit())
    {
        return Err(ExecError::Failed {
            code: "ZX001".to_string(),
            message: "Device activation response rejected".to_string(),
        });
    }
    let result = json!({
        "device_id": device_id,
        "device_uid": activated_uid,
        "credential": credential,
    });
    tx.commit().await.map_err(map_command)?;
    Ok(result)
}
