use std::collections::BTreeMap;

use serde_json::{Map, Value};
use sqlx::QueryBuilder;
use std::convert::AsMut;

use crate::backup::BackupManifest;
use crate::commands::validate_table_name;
use crate::db::Database;

pub fn prepare_import(
    manifest: &BackupManifest,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<usize, &'static str> {
    manifest.verify(files)?;
    if files
        .keys()
        .any(|name| name.contains("..") || !name.ends_with(".json"))
    {
        return Err("import rejected");
    }
    Ok(files.len())
}

pub async fn import_json_rows(
    db: &Database,
    manifest: &BackupManifest,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<usize, &'static str> {
    let count = prepare_import(manifest, files)?;
    let mut tx = db.pool().begin().await.map_err(|_| "import rejected")?;
    for (name, bytes) in files {
        let table = name.trim_end_matches(".json");
        validate_table_name(table).map_err(|_| "import rejected")?;
        let rows: Vec<Map<String, Value>> =
            serde_json::from_slice(bytes).map_err(|_| "import rejected")?;
        for row in rows {
            insert_row(&mut tx, table, &row).await?;
        }
    }
    tx.commit().await.map_err(|_| "import rejected")?;
    Ok(count)
}

async fn insert_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    table: &str,
    row: &Map<String, Value>,
) -> Result<(), &'static str> {
    if row.is_empty() {
        return Err("import rejected");
    }
    let mut columns = row.keys().cloned().collect::<Vec<_>>();
    columns.sort();
    for column in &columns {
        if !column
            .chars()
            .all(|char| char.is_ascii_lowercase() || char.is_ascii_digit() || char == '_')
        {
            return Err("import rejected");
        }
    }
    let mut builder = QueryBuilder::<sqlx::Postgres>::new(format!("insert into {table} ("));
    let mut separated = builder.separated(", ");
    for column in &columns {
        separated.push(column);
    }
    builder.push(") values (");
    let mut separated = builder.separated(", ");
    for column in &columns {
        let value = row.get(column).ok_or("import rejected")?;
        let text = match value {
            Value::String(text) => text.clone(),
            Value::Number(number) if !number.is_f64() => number.to_string(),
            Value::Bool(flag) => flag.to_string(),
            _ => return Err("import rejected"),
        };
        separated.push_bind(text);
    }
    builder.push(")");
    builder
        .build()
        .execute(tx.as_mut())
        .await
        .map_err(|_| "import rejected")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_failure_imports_nothing() {
        let files = BTreeMap::from([("customers.json".into(), b"[]".to_vec())]);
        let manifest = BackupManifest::from_files(files.clone());
        assert_eq!(prepare_import(&manifest, &files).unwrap(), 1);
        let mut tampered = files.clone();
        tampered.get_mut("customers.json").unwrap().push(b'x');
        assert!(prepare_import(&manifest, &tampered).is_err());
    }
}
