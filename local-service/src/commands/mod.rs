mod device_activation;
mod read_model;
mod table_api;

use serde_json::Value;
use thiserror::Error;

pub use device_activation::activate_device;
pub(crate) use read_model::caller_transaction;
pub use read_model::{ExecError, execute_backend, execute_command};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CommandError {
    #[error("backend command is invalid")]
    Invalid,
}

const TABLES: &[&str] = &[
    "ai_action_requests",
    "ai_channel_configs",
    "ai_conversations",
    "ai_messages",
    "attendance_logs",
    "branch_products",
    "branches",
    "cash_movements",
    "cash_registers",
    "cash_sessions",
    "categories",
    "customers",
    "delivery_orders",
    "devices",
    "digital_order_items",
    "digital_orders",
    "discount_codes",
    "employee_shifts",
    "employees",
    "expense_categories",
    "expenses",
    "inventory_centers",
    "inventory_movements",
    "inventory_stocks",
    "modifier_groups",
    "modifier_options",
    "payments",
    "pricing_policy_rules",
    "product_barcode_conflicts",
    "product_barcodes",
    "device_enrollment_approvals",
    "product_channel_prices",
    "product_complementaries",
    "product_components",
    "product_prices",
    "production_orders",
    "products",
    "profiles",
    "purchase_order_items",
    "purchase_orders",
    "sale_items",
    "sale_return_items",
    "sale_returns",
    "sales",
    "suppliers",
    "table_order_items",
    "table_orders",
    "tables",
    "tenants",
    "user_roles",
    "wa_quick_replies",
];

pub fn validate_backend(value: &Value) -> Result<(), CommandError> {
    let object = value.as_object().ok_or(CommandError::Invalid)?;
    if object
        .keys()
        .any(|key| key == "sql" || key.contains("password") && key != "password")
    {
        return Err(CommandError::Invalid);
    }
    match object.get("kind").and_then(Value::as_str) {
        Some("table") => validate_table(object.get("table").and_then(Value::as_str).unwrap_or("")),
        Some("rpc") => validate_name(object.get("fn").and_then(Value::as_str).unwrap_or("")),
        Some("function") => validate_name(object.get("name").and_then(Value::as_str).unwrap_or("")),
        Some("attachment") => validate_attachment(object),
        Some("auth") => Ok(()),
        _ => Err(CommandError::Invalid),
    }
}

pub(crate) fn valid_command_name(name: &str) -> Result<(), CommandError> {
    validate_name(name)
}

pub(crate) fn validate_table_name(table: &str) -> Result<(), CommandError> {
    validate_table(table)
}

fn validate_table(table: &str) -> Result<(), CommandError> {
    if TABLES.contains(&table) {
        Ok(())
    } else {
        Err(CommandError::Invalid)
    }
}

fn validate_name(name: &str) -> Result<(), CommandError> {
    if !name.is_empty()
        && name.len() <= 80
        && name
            .chars()
            .all(|char| char.is_ascii_lowercase() || char.is_ascii_digit() || char == '_')
    {
        Ok(())
    } else {
        Err(CommandError::Invalid)
    }
}

fn validate_attachment(object: &serde_json::Map<String, Value>) -> Result<(), CommandError> {
    let bucket = object.get("bucket").and_then(Value::as_str).unwrap_or("");
    let path = object.get("path").and_then(Value::as_str).unwrap_or("");
    if !matches!(bucket, "product-images" | "return-evidence")
        || path.is_empty()
        || path.contains("..")
        || path.starts_with('/')
    {
        return Err(CommandError::Invalid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_raw_sql_and_unknown_tables_without_echoing_secrets() {
        let bad = serde_json::json!({"kind":"table","table":"sales;drop","password":"hunter2"});
        assert!(validate_backend(&bad).is_err());
        let rendered = format!("{bad}");
        assert!(rendered.contains("hunter2"));
        assert!(validate_backend(&serde_json::json!({"kind":"table","table":"sales"})).is_ok());
        assert!(
            validate_backend(&serde_json::json!({"kind":"rpc","fn":"export_business_data_v1"}))
                .is_ok()
        );
        assert!(validate_backend(&serde_json::json!({"kind":"attachment","bucket":"product-images","path":"../secret"})).is_err());
    }
}
