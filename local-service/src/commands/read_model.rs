use serde_json::{Value, json};
use sqlx::QueryBuilder;

use crate::db::{Database, DbError};

use super::CommandError;

#[derive(Debug, PartialEq, Eq)]
pub enum ExecError {
    Rejected,
    Unavailable,
}

pub async fn execute_backend(db: &Database, value: &Value) -> Result<Value, ExecError> {
    let object = value.as_object().ok_or(ExecError::Rejected)?;
    match object.get("kind").and_then(Value::as_str) {
        Some("table") => {
            let table = object.get("table").and_then(Value::as_str).unwrap_or("");
            let steps = object
                .get("steps")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            execute_table(db, table, steps).await
        }
        Some("rpc") => {
            let name = object.get("fn").and_then(Value::as_str).unwrap_or("");
            let args = object.get("args").cloned().unwrap_or_else(|| json!({}));
            execute_report(db, name, &args).await
        }
        _ => Err(ExecError::Rejected),
    }
}

async fn execute_table(db: &Database, table: &str, steps: &[Value]) -> Result<Value, ExecError> {
    super::validate_table_name(table).map_err(|_| ExecError::Rejected)?;
    let mut columns = vec!["*".to_string()];
    let mut filters: Vec<(String, String)> = Vec::new();
    let mut order: Option<(String, bool)> = None;
    let mut limit: i64 = 100;
    for step in steps {
        let parts = step.as_array().ok_or(ExecError::Rejected)?;
        let name = parts
            .first()
            .and_then(Value::as_str)
            .ok_or(ExecError::Rejected)?;
        let args = parts.get(1).and_then(Value::as_array);
        match name {
            "select" => {
                let raw = args
                    .and_then(|args| args.first())
                    .and_then(Value::as_str)
                    .unwrap_or("*");
                columns = parse_columns(raw)?;
            }
            "eq" => {
                let column = args
                    .and_then(|args| args.first())
                    .and_then(Value::as_str)
                    .ok_or(ExecError::Rejected)?;
                let value = args
                    .and_then(|args| args.get(1))
                    .ok_or(ExecError::Rejected)?;
                if !is_ident(column) {
                    return Err(ExecError::Rejected);
                }
                filters.push((column.to_string(), json_text(value)?));
            }
            "order" => {
                let column = args
                    .and_then(|args| args.first())
                    .and_then(Value::as_str)
                    .ok_or(ExecError::Rejected)?;
                if !is_ident(column) {
                    return Err(ExecError::Rejected);
                }
                let ascending = args
                    .and_then(|args| args.get(1))
                    .and_then(|value| value.get("ascending"))
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                order = Some((column.to_string(), ascending));
            }
            "limit" => {
                let value = args
                    .and_then(|args| args.first())
                    .and_then(Value::as_i64)
                    .ok_or(ExecError::Rejected)?;
                if !(1..=1000).contains(&value) {
                    return Err(ExecError::Rejected);
                }
                limit = value;
            }
            "insert" | "update" | "delete" | "upsert" => return Err(ExecError::Rejected),
            _ => return Err(ExecError::Rejected),
        }
    }
    let projection = if columns.iter().any(|column| column == "*") {
        "*".to_string()
    } else {
        columns.join(", ")
    };
    let mut builder = QueryBuilder::<sqlx::Postgres>::new("select to_jsonb(row) from (select ");
    builder.push(projection);
    builder.push(" from ");
    builder.push(table);
    if !filters.is_empty() {
        builder.push(" where ");
        for (index, (column, value)) in filters.iter().enumerate() {
            if index > 0 {
                builder.push(" and ");
            }
            builder.push(column);
            builder.push("::text = ");
            builder.push_bind(value);
        }
    }
    if let Some((column, ascending)) = order {
        builder.push(" order by ");
        builder.push(column);
        builder.push(if ascending { " asc" } else { " desc" });
    }
    builder.push(" limit ");
    builder.push_bind(limit);
    builder.push(") row");
    let rows = builder
        .build_query_as::<(Value,)>()
        .fetch_all(db.pool())
        .await
        .map_err(map_db)?;
    Ok(Value::Array(rows.into_iter().map(|(row,)| row).collect()))
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

fn parse_columns(raw: &str) -> Result<Vec<String>, ExecError> {
    if raw.trim() == "*" {
        return Ok(vec!["*".to_string()]);
    }
    let columns = raw
        .split(',')
        .map(str::trim)
        .filter(|column| !column.is_empty())
        .map(|column| {
            if is_ident(column) {
                Ok(column.to_string())
            } else {
                Err(ExecError::Rejected)
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    if columns.is_empty() {
        return Err(ExecError::Rejected);
    }
    Ok(columns)
}

fn json_text(value: &Value) -> Result<String, ExecError> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Bool(flag) => Ok(flag.to_string()),
        Value::Number(number) => {
            if number.is_f64() {
                Err(ExecError::Rejected)
            } else {
                Ok(number.to_string())
            }
        }
        _ => Err(ExecError::Rejected),
    }
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
