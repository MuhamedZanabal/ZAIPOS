use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};

use crate::db::{Database, DbError};

use super::CommandError;

#[derive(Debug, PartialEq, Eq)]
pub enum ExecError {
    Rejected,
    Unauthorized,
    Unavailable,
    Failed { code: String, message: String },
}

pub async fn execute_backend(
    db: &Database,
    value: &Value,
    user_id: Option<&str>,
) -> Result<Value, ExecError> {
    let object = value.as_object().ok_or(ExecError::Rejected)?;
    match object.get("kind").and_then(Value::as_str) {
        Some("table") => {
            let table = object.get("table").and_then(Value::as_str).unwrap_or("");
            let steps = object
                .get("steps")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            execute_table(db, table, steps, user_id).await
        }
        Some("rpc") => {
            let name = object.get("fn").and_then(Value::as_str).unwrap_or("");
            let args = object.get("args").cloned().unwrap_or_else(|| json!({}));
            execute_report(db, name, &args).await
        }
        _ => Err(ExecError::Rejected),
    }
}

/// Opens a transaction that acts as the caller: `authenticated` with the
/// session user as `auth.uid()`, or `anon` without a session. Row-level
/// security therefore decides visibility exactly as it did on the hosted stack.
pub(crate) async fn caller_transaction(
    db: &Database,
    user_id: Option<&str>,
) -> Result<Transaction<'static, Postgres>, ExecError> {
    let mut tx = db.pool().begin().await.map_err(map_db)?;
    let role = if user_id.is_some() {
        "authenticated"
    } else {
        "anon"
    };
    sqlx::query("select set_config('request.jwt.claim.sub', $1, true)")
        .bind(user_id.unwrap_or(""))
        .execute(&mut *tx)
        .await
        .map_err(map_db)?;
    sqlx::query("select set_config('request.jwt.claim.role', $1, true)")
        .bind(role)
        .execute(&mut *tx)
        .await
        .map_err(map_db)?;
    let (can_assume,): (bool,) = sqlx::query_as(
        "select exists(select 1 from pg_roles where rolname = $1)
            and pg_has_role(current_user, $1, 'MEMBER')",
    )
    .bind(role)
    .fetch_one(&mut *tx)
    .await
    .map_err(map_db)?;
    if can_assume {
        // `role` is one of two fixed literals above; never caller text.
        sqlx::query(if role == "authenticated" {
            "set local role authenticated"
        } else {
            "set local role anon"
        })
        .execute(&mut *tx)
        .await
        .map_err(map_db)?;
    }
    Ok(tx)
}

async fn execute_table(
    db: &Database,
    table: &str,
    steps: &[Value],
    user_id: Option<&str>,
) -> Result<Value, ExecError> {
    super::validate_table_name(table).map_err(|_| ExecError::Rejected)?;
    let mutating = steps.iter().any(|step| {
        step.get(0)
            .and_then(Value::as_str)
            .is_some_and(|name| matches!(name, "insert" | "update" | "delete" | "upsert"))
    });
    if mutating && user_id.is_none() {
        return Err(ExecError::Unauthorized);
    }
    let mut tx = caller_transaction(db, user_id).await?;
    let allowed = |name: &str| super::validate_table_name(name).is_ok();
    let result = super::table_api::execute(&mut tx, table, steps, &allowed).await?;
    tx.commit().await.map_err(map_command)?;
    Ok(result)
}

async fn execute_report(db: &Database, name: &str, args: &Value) -> Result<Value, ExecError> {
    if name != "report_daily_sales" {
        return Err(ExecError::Rejected);
    }
    let tenant_id = args
        .get("tenant_id")
        .and_then(Value::as_str)
        .ok_or(ExecError::Rejected)?;
    if tenant_id.is_empty() || tenant_id.len() > 80 {
        return Err(ExecError::Rejected);
    }
    let rows = sqlx::query_as::<_, (String,)>(
        "select total_bhd::text from public.zaipos_daily_sales where tenant_id = $1",
    )
    .bind(tenant_id)
    .fetch_all(db.pool())
    .await
    .map_err(map_db)?;
    let mut millis: i64 = 0;
    for (amount,) in rows {
        millis = millis
            .checked_add(parse_bhd_millis(&amount).map_err(|_| ExecError::Unavailable)?)
            .ok_or(ExecError::Unavailable)?;
    }
    Ok(json!({ "total_bhd": format_bhd_millis(millis) }))
}

fn is_ident(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('a'..='z' | '_'))
        && chars.all(|char| char.is_ascii_lowercase() || char.is_ascii_digit() || char == '_')
        && value.len() <= 63
}

pub fn parse_bhd_millis(value: &str) -> Result<i64, ()> {
    let value = value.trim();
    let negative = value.starts_with('-');
    let value = value.trim_start_matches('-');
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.chars().all(|char| char.is_ascii_digit())
        || fraction.len() > 3
        || !fraction.chars().all(|char| char.is_ascii_digit())
    {
        return Err(());
    }
    let whole: i64 = whole.parse().map_err(|_| ())?;
    let mut fraction = fraction.to_string();
    while fraction.len() < 3 {
        fraction.push('0');
    }
    let fraction: i64 = if fraction.is_empty() {
        0
    } else {
        fraction.parse().map_err(|_| ())?
    };
    let millis = whole
        .checked_mul(1000)
        .ok_or(())?
        .checked_add(fraction)
        .ok_or(())?;
    Ok(if negative { -millis } else { millis })
}

pub fn format_bhd_millis(millis: i64) -> String {
    let sign = if millis < 0 { "-" } else { "" };
    let millis = millis.unsigned_abs();
    format!("{sign}{}.{:03}", millis / 1000, millis % 1000)
}

pub async fn execute_command(
    db: &Database,
    name: &str,
    arguments: &Value,
    user_id: &str,
) -> Result<Value, ExecError> {
    super::valid_command_name(name).map_err(|_| ExecError::Rejected)?;
    let arguments = arguments.as_object().ok_or(ExecError::Rejected)?;
    if arguments.keys().any(|key| !is_ident(key)) {
        return Err(ExecError::Rejected);
    }
    let mut tx = caller_transaction(db, Some(user_id)).await?;
    let signature = function_signature(&mut tx, name, arguments).await?;
    let mut call = format!("public.{name}(");
    let mut binds: Vec<&Value> = Vec::new();
    for (index, (key, value)) in arguments.iter().enumerate() {
        if index > 0 {
            call.push_str(", ");
        }
        let target = signature
            .arguments
            .iter()
            .find(|(argument, _)| argument == key)
            .map(|(_, kind)| kind.as_str())
            .ok_or(ExecError::Rejected)?;
        if !value.is_null() {
            binds.push(value);
        }
        let position = binds.len();
        // The declared parameter type comes from pg_catalog, never from the caller.
        let expression = match value {
            Value::Null => format!("null::{target}"),
            Value::Bool(_) => format!("${position}::boolean::{target}"),
            Value::Number(_) => format!("${position}::bigint::{target}"),
            Value::String(_) => format!("${position}::text::{target}"),
            Value::Array(_) if !target.starts_with("json") && target.ends_with("[]") => {
                format!("array(select jsonb_array_elements_text(${position}::jsonb))::{target}")
            }
            Value::Object(_) | Value::Array(_) => format!("${position}::jsonb::{target}"),
        };
        call.push_str(&format!("{key} := {expression}"));
    }
    call.push(')');
    let sql = if signature.returns_set {
        format!("select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from {call} r")
    } else {
        format!("select to_jsonb({call})")
    };
    let sql = if signature.returns_void {
        format!("with c as (select {call}) select 'null'::jsonb from c")
    } else {
        sql
    };
    let mut query = sqlx::query_as::<_, (Value,)>(&sql);
    for value in binds {
        query = match value {
            Value::Null => query,
            Value::Bool(flag) => query.bind(*flag),
            Value::Number(number) => query.bind(number.as_i64().ok_or(ExecError::Rejected)?),
            Value::String(text) => query.bind(text.as_str()),
            Value::Object(_) | Value::Array(_) => query.bind(value),
        };
    }
    let row: Option<(Value,)> = query.fetch_optional(&mut *tx).await.map_err(map_command)?;
    tx.commit().await.map_err(map_command)?;
    Ok(row.map(|(value,)| value).unwrap_or(Value::Null))
}

/// (input names, input types, defaulted count, returns set, returns void)
type OverloadRow = (Vec<String>, Vec<String>, i16, bool, bool);

struct FunctionSignature {
    arguments: Vec<(String, String)>,
    returns_set: bool,
    returns_void: bool,
}

/// Picks the public function overload whose input parameter names cover the
/// caller's named arguments, mirroring PostgREST's named-argument RPC calls.
async fn function_signature(
    tx: &mut Transaction<'static, Postgres>,
    name: &str,
    arguments: &serde_json::Map<String, Value>,
) -> Result<FunctionSignature, ExecError> {
    let rows: Vec<OverloadRow> = sqlx::query_as(
        "select coalesce(array_agg(x.n order by x.o) filter (where x.m in ('i', 'b', 'v')), '{}'),
                coalesce(array_agg(format_type(x.t, null) order by x.o) filter (where x.m in ('i', 'b', 'v')), '{}'),
                p.pronargdefaults, p.proretset, p.prorettype = 'void'::regtype
           from pg_proc p
           left join lateral unnest(
                  coalesce(p.proallargtypes, p.proargtypes::oid[]),
                  coalesce(p.proargnames, array_fill(''::text, array[cardinality(coalesce(p.proallargtypes, p.proargtypes::oid[]))])),
                  coalesce(p.proargmodes, array_fill('i'::\"char\", array[cardinality(coalesce(p.proallargtypes, p.proargtypes::oid[]))]))
                ) with ordinality as x(t, n, m, o) on true
          where p.proname = $1 and p.pronamespace = 'public'::regnamespace
          group by p.oid, p.pronargdefaults, p.proretset, p.prorettype
          order by p.oid",
    )
    .bind(name)
    .fetch_all(&mut **tx)
    .await
    .map_err(map_command)?;
    let chosen = rows
        .into_iter()
        .filter(|(names, _, defaults, _, _)| {
            let required = names
                .len()
                .saturating_sub(usize::try_from(*defaults).unwrap_or(0));
            arguments.keys().all(|key| names.contains(key))
                && names[..required]
                    .iter()
                    .all(|name| arguments.contains_key(name))
        })
        .min_by_key(|(names, ..)| names.len())
        .ok_or_else(|| ExecError::Failed {
            code: "PGRST202".to_string(),
            message: format!("Could not find the function public.{name} with the given arguments"),
        })?;
    let (names, types, _, returns_set, returns_void) = chosen;
    Ok(FunctionSignature {
        arguments: names.into_iter().zip(types).collect(),
        returns_set,
        returns_void,
    })
}

pub(crate) fn map_command(error: sqlx::Error) -> ExecError {
    if let sqlx::Error::Database(db) = &error {
        return ExecError::Failed {
            code: db
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "ZX000".to_string()),
            message: db.message().to_string(),
        };
    }
    ExecError::Unavailable
}

fn map_db(error: sqlx::Error) -> ExecError {
    match error {
        sqlx::Error::Database(db) if db.code().as_deref() == Some("42P01") => {
            ExecError::Unavailable
        }
        _ => ExecError::Unavailable,
    }
}

impl From<DbError> for ExecError {
    fn from(_: DbError) -> Self {
        ExecError::Unavailable
    }
}

impl From<CommandError> for ExecError {
    fn from(_: CommandError) -> Self {
        ExecError::Rejected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bhd_sums_keep_three_decimal_fils() {
        let total = parse_bhd_millis("1.500").unwrap() + parse_bhd_millis("0.001").unwrap();
        assert_eq!(format_bhd_millis(total), "1.501");
        assert!(parse_bhd_millis("1.2e1").is_err());
    }
}
