//! PostgREST-compatible table API for the renderer's `supabase.from(...)` calls.
//!
//! Every statement runs inside a transaction that assumes the caller's database
//! role (`authenticated` with `request.jwt.claim.sub`, or `anon` without a
//! session), so the migration chain's row-level security stays the only data
//! authority. Identifiers are validated; every value is bound as JSONB and cast
//! through the target table's own row type, so no caller text reaches SQL.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use sqlx::{Postgres, Transaction};

use super::read_model::ExecError;

const DEFAULT_LIMIT: i64 = 1000;
const MAX_DEPTH: usize = 3;

#[derive(Debug, Clone, PartialEq)]
enum Item {
    Star,
    Column { name: String, alias: String },
    Embed(Embed),
}

#[derive(Debug, Clone, PartialEq)]
struct Embed {
    relation: String,
    alias: String,
    hint: Option<String>,
    inner: bool,
    items: Vec<Item>,
}

#[derive(Debug, Clone, PartialEq)]
struct Filter {
    path: Vec<String>,
    column: String,
    op: String,
    value: Value,
}

#[derive(Debug, Clone, PartialEq)]
struct Order {
    path: Vec<String>,
    column: String,
    ascending: bool,
    nulls_first: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
enum Mutation {
    Insert(Vec<Map<String, Value>>),
    Upsert {
        rows: Vec<Map<String, Value>>,
        on_conflict: Option<Vec<String>>,
        ignore_duplicates: bool,
    },
    Update(Map<String, Value>),
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Cardinality {
    Many,
    Single,
    MaybeSingle,
}

#[derive(Debug, Clone, PartialEq)]
struct Request {
    items: Option<Vec<Item>>,
    count: bool,
    head: bool,
    filters: Vec<Filter>,
    orders: Vec<Order>,
    limit: Option<i64>,
    offset: Option<i64>,
    cardinality: Cardinality,
    mutation: Option<Mutation>,
}

pub fn is_ident(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('a'..='z' | '_'))
        && chars.all(|char| char.is_ascii_lowercase() || char.is_ascii_digit() || char == '_')
        && value.len() <= 63
}

fn ident(value: &str) -> Result<String, ExecError> {
    if is_ident(value) {
        Ok(value.to_string())
    } else {
        Err(ExecError::Rejected)
    }
}

fn split_top_level(raw: &str) -> Result<Vec<String>, ExecError> {
    let mut parts = Vec::new();
    let mut depth = 0_i32;
    let mut current = String::new();
    for char in raw.chars() {
        match char {
            '(' => {
                depth += 1;
                current.push(char);
            }
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return Err(ExecError::Rejected);
                }
                current.push(char);
            }
            ',' if depth == 0 => {
                parts.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(char),
        }
    }
    if depth != 0 {
        return Err(ExecError::Rejected);
    }
    parts.push(current.trim().to_string());
    Ok(parts.into_iter().filter(|part| !part.is_empty()).collect())
}

fn parse_select(raw: &str, depth: usize) -> Result<Vec<Item>, ExecError> {
    if depth > MAX_DEPTH || raw.len() > 4096 {
        return Err(ExecError::Rejected);
    }
    let compact: String = raw.split_whitespace().collect::<Vec<_>>().join("");
    let parts = split_top_level(&compact)?;
    if parts.is_empty() {
        return Ok(vec![Item::Star]);
    }
    let mut items = Vec::new();
    for part in parts {
        if part == "*" {
            items.push(Item::Star);
            continue;
        }
        let (alias, rest) = match part.split_once(':') {
            Some((alias, rest)) if !rest.starts_with(':') => {
                (Some(ident(alias)?), rest.to_string())
            }
            _ => (None, part.clone()),
        };
        if let Some(open) = rest.find('(') {
            if !rest.ends_with(')') {
                return Err(ExecError::Rejected);
            }
            let head = &rest[..open];
            let inner_raw = &rest[open + 1..rest.len() - 1];
            let mut pieces = head.split('!');
            let relation = ident(pieces.next().unwrap_or(""))?;
            let mut hint = None;
            let mut inner = false;
            for piece in pieces {
                match piece {
                    "inner" => inner = true,
                    "left" => {}
                    other => hint = Some(ident(other)?),
                }
            }
            items.push(Item::Embed(Embed {
                alias: alias.unwrap_or_else(|| relation.clone()),
                relation,
                hint,
                inner,
                items: parse_select(inner_raw, depth + 1)?,
            }));
        } else {
            let name = ident(&rest)?;
            items.push(Item::Column {
                alias: alias.unwrap_or_else(|| name.clone()),
                name,
            });
        }
    }
    Ok(items)
}

fn split_path(raw: &str) -> Result<(Vec<String>, String), ExecError> {
    let mut segments = raw.split('.').map(ident).collect::<Result<Vec<_>, _>>()?;
    let column = segments.pop().ok_or(ExecError::Rejected)?;
    if segments.len() > MAX_DEPTH {
        return Err(ExecError::Rejected);
    }
    Ok((segments, column))
}

fn rows_of(value: &Value) -> Result<Vec<Map<String, Value>>, ExecError> {
    let rows = match value {
        Value::Object(row) => vec![row.clone()],
        Value::Array(items) => items
            .iter()
            .map(|item| item.as_object().cloned().ok_or(ExecError::Rejected))
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(ExecError::Rejected),
    };
    if rows.is_empty() || rows.len() > 1000 {
        return Err(ExecError::Rejected);
    }
    for row in &rows {
        if row.is_empty() || row.keys().any(|key| !is_ident(key)) {
            return Err(ExecError::Rejected);
        }
    }
    Ok(rows)
}

fn parse_request(steps: &[Value]) -> Result<Request, ExecError> {
    let mut request = Request {
        items: None,
        count: false,
        head: false,
        filters: Vec::new(),
        orders: Vec::new(),
        limit: None,
        offset: None,
        cardinality: Cardinality::Many,
        mutation: None,
    };
    if steps.len() > 64 {
        return Err(ExecError::Rejected);
    }
    for step in steps {
        let parts = step.as_array().ok_or(ExecError::Rejected)?;
        let name = parts
            .first()
            .and_then(Value::as_str)
            .ok_or(ExecError::Rejected)?;
        let empty = Vec::new();
        let args = parts.get(1).and_then(Value::as_array).unwrap_or(&empty);
        let arg = |index: usize| args.get(index).unwrap_or(&Value::Null);
        match name {
            "select" => {
                let raw = arg(0).as_str().unwrap_or("*");
                request.items = Some(parse_select(raw, 0)?);
                if let Some(options) = arg(1).as_object() {
                    request.count = options.get("count").is_some_and(|count| !count.is_null());
                    request.head = options
                        .get("head")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                }
            }
            "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "is" | "in" => {
                let (path, column) = split_path(arg(0).as_str().ok_or(ExecError::Rejected)?)?;
                let value = arg(1).clone();
                match name {
                    "in" if !value.is_array() => return Err(ExecError::Rejected),
                    "is" if !(value.is_null() || value.is_boolean()) => {
                        return Err(ExecError::Rejected);
                    }
                    "like" | "ilike" if !value.is_string() => return Err(ExecError::Rejected),
                    _ => {}
                }
                request.filters.push(Filter {
                    path,
                    column,
                    op: name.to_string(),
                    value,
                });
            }
            "match" => {
                let object = arg(0).as_object().ok_or(ExecError::Rejected)?;
                for (key, value) in object {
                    let (path, column) = split_path(key)?;
                    request.filters.push(Filter {
                        path,
                        column,
                        op: "eq".to_string(),
                        value: value.clone(),
                    });
                }
            }
            "order" => {
                let options = arg(1).as_object();
                let (mut path, column) = split_path(arg(0).as_str().ok_or(ExecError::Rejected)?)?;
                if let Some(foreign) = options
                    .and_then(|options| {
                        options
                            .get("referencedTable")
                            .or_else(|| options.get("foreignTable"))
                    })
                    .and_then(Value::as_str)
                {
                    path = foreign
                        .split('.')
                        .map(ident)
                        .collect::<Result<Vec<_>, _>>()?;
                }
                request.orders.push(Order {
                    path,
                    column,
                    ascending: options
                        .and_then(|options| options.get("ascending"))
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    nulls_first: options
                        .and_then(|options| options.get("nullsFirst"))
                        .and_then(Value::as_bool),
                });
            }
            "limit" => {
                let value = arg(0).as_i64().ok_or(ExecError::Rejected)?;
                if !(0..=DEFAULT_LIMIT).contains(&value) {
                    return Err(ExecError::Rejected);
                }
                let foreign = arg(1).as_object().is_some_and(|options| {
                    options.contains_key("referencedTable") || options.contains_key("foreignTable")
                });
                if !foreign {
                    request.limit = Some(value);
                }
            }
            "range" => {
                let from = arg(0).as_i64().ok_or(ExecError::Rejected)?;
                let to = arg(1).as_i64().ok_or(ExecError::Rejected)?;
                if from < 0 || to < from || to - from >= DEFAULT_LIMIT {
                    return Err(ExecError::Rejected);
                }
                request.offset = Some(from);
                request.limit = Some(to - from + 1);
            }
            "single" => request.cardinality = Cardinality::Single,
            "maybeSingle" => request.cardinality = Cardinality::MaybeSingle,
            "insert" => {
                set_mutation(&mut request, Mutation::Insert(rows_of(arg(0))?))?;
            }
            "upsert" => {
                let options = arg(1).as_object();
                let on_conflict = options
                    .and_then(|options| options.get("onConflict"))
                    .and_then(Value::as_str)
                    .map(|raw| raw.split(',').map(|column| ident(column.trim())).collect())
                    .transpose()?;
                set_mutation(
                    &mut request,
                    Mutation::Upsert {
                        rows: rows_of(arg(0))?,
                        on_conflict,
                        ignore_duplicates: options
                            .and_then(|options| options.get("ignoreDuplicates"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    },
                )?;
            }
            "update" => {
                let row = arg(0).as_object().ok_or(ExecError::Rejected)?;
                let mut rows = rows_of(&Value::Object(row.clone()))?;
                set_mutation(&mut request, Mutation::Update(rows.remove(0)))?;
            }
            "delete" => set_mutation(&mut request, Mutation::Delete)?,
            "abortSignal" | "throwOnError" | "returns" | "overrideTypes" => {}
            _ => return Err(ExecError::Rejected),
        }
    }
    if matches!(
        request.mutation,
        Some(Mutation::Update(_) | Mutation::Delete)
    ) && !request.filters.iter().any(|filter| filter.path.is_empty())
    {
        return Err(ExecError::Rejected);
    }
    if request.mutation.is_some() && request.filters.iter().any(|filter| !filter.path.is_empty()) {
        return Err(ExecError::Rejected);
    }
    Ok(request)
}

fn set_mutation(request: &mut Request, mutation: Mutation) -> Result<(), ExecError> {
    if request.mutation.is_some() {
        return Err(ExecError::Rejected);
    }
    request.mutation = Some(mutation);
    Ok(())
}

/// Foreign-key join between a parent table and an embedded relation.
#[derive(Debug, Clone)]
struct Join {
    /// true when the parent holds the foreign key (many-to-one => object).
    to_one: bool,
    parent_columns: Vec<String>,
    child_columns: Vec<String>,
}

struct Builder {
    joins: HashMap<Vec<String>, Join>,
    binds: Vec<Value>,
    aliases: usize,
}

async fn resolve_embeds(
    tx: &mut Transaction<'static, Postgres>,
    table: &str,
    items: &[Item],
    allowed: &(dyn Fn(&str) -> bool + Sync),
) -> Result<HashMap<Vec<String>, Join>, ExecError> {
    let mut joins = HashMap::new();
    let mut stack: Vec<(String, Vec<String>, Vec<Item>)> =
        vec![(table.to_string(), Vec::new(), items.to_vec())];
    while let Some((parent, path, items)) = stack.pop() {
        for item in items {
            if let Item::Embed(embed) = item {
                if !allowed(&embed.relation) {
                    return Err(ExecError::Rejected);
                }
                let join = resolve(tx, &parent, &embed).await?;
                let mut child_path = path.clone();
                child_path.push(embed.alias.clone());
                joins.insert(child_path.clone(), join);
                stack.push((embed.relation.clone(), child_path, embed.items.clone()));
            }
        }
    }
    Ok(joins)
}

async fn resolve(
    tx: &mut Transaction<'static, Postgres>,
    parent: &str,
    embed: &Embed,
) -> Result<Join, ExecError> {
    {
        let rows: Vec<(String, bool, Vec<String>, Vec<String>)> = sqlx::query_as(
            "select c.conname::text,
                    c.conrelid = to_regclass('public.' || $1),
                    array(select a.attname::text from unnest(c.conkey) with ordinality k(n, i)
                          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.i),
                    array(select a.attname::text from unnest(c.confkey) with ordinality k(n, i)
                          join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by k.i)
               from pg_constraint c
              where c.contype = 'f'
                and ((c.conrelid = to_regclass('public.' || $1) and c.confrelid = to_regclass('public.' || $2))
                  or (c.conrelid = to_regclass('public.' || $2) and c.confrelid = to_regclass('public.' || $1)))
              order by c.conname",
        )
        .bind(parent)
        .bind(&embed.relation)
        .fetch_all(&mut **tx)
        .await
        .map_err(super::read_model::map_command)?;
        let chosen = rows
            .into_iter()
            .find(|(name, _, local, foreign)| match &embed.hint {
                None => true,
                Some(hint) => {
                    name == hint
                        || (local.len() == 1 && &local[0] == hint)
                        || (foreign.len() == 1 && &foreign[0] == hint)
                }
            })
            .ok_or_else(|| ExecError::Failed {
                code: "PGRST200".to_string(),
                message: format!(
                    "Could not find a relationship between '{parent}' and '{}'",
                    embed.relation
                ),
            })?;
        let (_, parent_holds_key, fk_columns, referenced) = chosen;
        Ok(if parent_holds_key {
            Join {
                to_one: true,
                parent_columns: fk_columns,
                child_columns: referenced,
            }
        } else {
            Join {
                to_one: false,
                parent_columns: referenced,
                child_columns: fk_columns,
            }
        })
    }
}

impl Builder {
    fn bind(&mut self, value: Value) -> String {
        self.binds.push(value);
        format!("${}::jsonb", self.binds.len())
    }

    fn alias(&mut self) -> String {
        self.aliases += 1;
        format!("t{}", self.aliases)
    }

    fn filter_sql(&mut self, table: &str, alias: &str, filter: &Filter) -> String {
        let column = format!("{alias}.{}", filter.column);
        let cast = |builder: &mut Self, value: Value| {
            let placeholder = builder.bind(json!({ filter.column.clone(): value }));
            format!(
                "(jsonb_populate_record(null::public.{table}, {placeholder})).{}",
                filter.column
            )
        };
        match filter.op.as_str() {
            "is" => match &filter.value {
                Value::Bool(true) => format!("{column} is true"),
                Value::Bool(false) => format!("{column} is false"),
                _ => format!("{column} is null"),
            },
            "in" => {
                let placeholder = self.bind(filter.value.clone());
                format!(
                    "{column} = any(array(select (jsonb_populate_record(null::public.{table}, jsonb_build_object('{name}', e))).{name} from jsonb_array_elements({placeholder}) e))",
                    name = filter.column
                )
            }
            "like" | "ilike" => {
                let placeholder = self.bind(filter.value.clone());
                let op = if filter.op == "like" { "like" } else { "ilike" };
                format!("{column}::text {op} ({placeholder} #>> '{{}}')")
            }
            op => {
                let sql_op = match op {
                    "eq" => "=",
                    "neq" => "<>",
                    "gt" => ">",
                    "gte" => ">=",
                    "lt" => "<",
                    _ => "<=",
                };
                let value = cast(self, filter.value.clone());
                format!("{column} {sql_op} {value}")
            }
        }
    }

    fn order_sql(alias: &str, orders: &[&Order]) -> String {
        if orders.is_empty() {
            return String::new();
        }
        let clauses: Vec<String> = orders
            .iter()
            .map(|order| {
                let direction = if order.ascending { "asc" } else { "desc" };
                let nulls = match order.nulls_first {
                    Some(true) => " nulls first",
                    Some(false) => " nulls last",
                    None => "",
                };
                format!("{alias}.{} {direction}{nulls}", order.column)
            })
            .collect();
        format!(" order by {}", clauses.join(", "))
    }

    /// Returns (row JSON expression, extra parent conditions for !inner embeds).
    fn row_json(
        &mut self,
        alias: &str,
        items: &[Item],
        path: &[String],
        request: &Request,
    ) -> Result<(String, Vec<String>), ExecError> {
        {
            let star = items.iter().any(|item| matches!(item, Item::Star));
            let mut pairs = Vec::new();
            let mut conditions = Vec::new();
            for item in items {
                match item {
                    Item::Star => {}
                    Item::Column { name, alias: key } => {
                        pairs.push(format!("'{key}', {alias}.{name}"));
                    }
                    Item::Embed(embed) => {
                        let child = self.alias();
                        let mut child_path = path.to_vec();
                        child_path.push(embed.alias.clone());
                        let join = self
                            .joins
                            .get(&child_path)
                            .cloned()
                            .ok_or(ExecError::Rejected)?;
                        let (child_json, child_conditions) =
                            self.row_json(&child, &embed.items, &child_path, request)?;
                        let mut wheres: Vec<String> = join
                            .parent_columns
                            .iter()
                            .zip(&join.child_columns)
                            .map(|(parent, child_column)| {
                                format!("{child}.{child_column} = {alias}.{parent}")
                            })
                            .collect();
                        wheres.extend(child_conditions);
                        let filters: Vec<Filter> = request
                            .filters
                            .iter()
                            .filter(|filter| filter.path == child_path)
                            .cloned()
                            .collect();
                        for filter in &filters {
                            let sql = self.filter_sql(&embed.relation, &child, filter);
                            wheres.push(sql);
                        }
                        let where_sql = wheres.join(" and ");
                        let relation = &embed.relation;
                        if embed.inner {
                            conditions.push(format!(
                                "exists (select 1 from public.{relation} {child} where {where_sql})"
                            ));
                        }
                        let expression = if join.to_one {
                            format!(
                                "(select {child_json} from public.{relation} {child} where {where_sql} limit 1)"
                            )
                        } else {
                            let orders: Vec<&Order> = request
                                .orders
                                .iter()
                                .filter(|order| order.path == child_path)
                                .collect();
                            let order_sql = Self::order_sql(&child, &orders);
                            format!(
                                "coalesce((select jsonb_agg({child_json}{order_sql}) from public.{relation} {child} where {where_sql}), '[]'::jsonb)"
                            )
                        };
                        pairs.push(format!("'{}', {expression}", embed.alias));
                    }
                }
            }
            let mut chunks = Vec::new();
            if star {
                chunks.push(format!("to_jsonb({alias})"));
            }
            for group in pairs.chunks(40) {
                chunks.push(format!("jsonb_build_object({})", group.join(", ")));
            }
            if chunks.is_empty() {
                chunks.push("'{}'::jsonb".to_string());
            }
            Ok((format!("({})", chunks.join(" || ")), conditions))
        }
    }
}

async fn primary_key(
    tx: &mut Transaction<'static, Postgres>,
    table: &str,
) -> Result<Vec<String>, ExecError> {
    let (columns,): (Vec<String>,) = sqlx::query_as(
        "select coalesce(array(select a.attname::text from pg_index i
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
                where i.indrelid = to_regclass('public.' || $1) and i.indisprimary), '{}')",
    )
    .bind(table)
    .fetch_one(&mut **tx)
    .await
    .map_err(super::read_model::map_command)?;
    if columns.is_empty() {
        return Err(ExecError::Rejected);
    }
    Ok(columns)
}

fn column_union(rows: &[Map<String, Value>]) -> Vec<String> {
    let mut columns: Vec<String> = Vec::new();
    for row in rows {
        for key in row.keys() {
            if !columns.contains(key) {
                columns.push(key.clone());
            }
        }
    }
    columns
}

/// Executes one renderer table request inside the caller's role.
pub async fn execute(
    tx: &mut Transaction<'static, Postgres>,
    table: &str,
    steps: &[Value],
    allowed: &(dyn Fn(&str) -> bool + Sync),
) -> Result<Value, ExecError> {
    if !allowed(table) {
        return Err(ExecError::Rejected);
    }
    let request = parse_request(steps)?;
    // Rows with different key sets are inserted per key set so that omitted
    // columns keep their database defaults instead of becoming NULL.
    let groups = match &request.mutation {
        Some(Mutation::Insert(rows) | Mutation::Upsert { rows, .. }) => {
            let mut groups: Vec<Vec<Map<String, Value>>> = Vec::new();
            for row in rows {
                match groups.iter_mut().find(|group| {
                    group[0].len() == row.len() && group[0].keys().all(|key| row.contains_key(key))
                }) {
                    Some(group) => group.push(row.clone()),
                    None => groups.push(vec![row.clone()]),
                }
            }
            groups
        }
        _ => Vec::new(),
    };
    if groups.len() > 1 {
        let mut combined = Vec::new();
        let mut returned = false;
        for group in groups {
            let mut sub = request.clone();
            sub.cardinality = Cardinality::Many;
            sub.mutation = Some(match &request.mutation {
                Some(Mutation::Upsert {
                    on_conflict,
                    ignore_duplicates,
                    ..
                }) => Mutation::Upsert {
                    rows: group,
                    on_conflict: on_conflict.clone(),
                    ignore_duplicates: *ignore_duplicates,
                },
                _ => Mutation::Insert(group),
            });
            if let Value::Array(rows) = execute_request(tx, table, sub, allowed).await? {
                returned = true;
                combined.extend(rows);
            }
        }
        if !returned {
            return Ok(Value::Null);
        }
        return finish(request.cardinality, combined);
    }
    execute_request(tx, table, request, allowed).await
}

fn finish(cardinality: Cardinality, rows: Vec<Value>) -> Result<Value, ExecError> {
    match cardinality {
        Cardinality::Many => Ok(Value::Array(rows)),
        Cardinality::MaybeSingle if rows.is_empty() => Ok(Value::Null),
        _ if rows.len() == 1 => Ok(rows.into_iter().next().unwrap_or(Value::Null)),
        _ => Err(ExecError::Failed {
            code: "PGRST116".to_string(),
            message: "JSON object requested, multiple (or no) rows returned".to_string(),
        }),
    }
}

async fn execute_request(
    tx: &mut Transaction<'static, Postgres>,
    table: &str,
    request: Request,
    allowed: &(dyn Fn(&str) -> bool + Sync),
) -> Result<Value, ExecError> {
    let root = "t0".to_string();
    let items = request.items.clone().unwrap_or_else(|| vec![Item::Star]);
    let mut builder = Builder {
        joins: resolve_embeds(tx, table, &items, allowed).await?,
        binds: Vec::new(),
        aliases: 0,
    };
    let returning = request.mutation.is_none() || request.items.is_some();
    let (row_json, inner_conditions) = builder.row_json(&root, &items, &[], &request)?;
    let mut wheres = inner_conditions;
    for filter in request
        .filters
        .iter()
        .filter(|filter| filter.path.is_empty())
    {
        let sql = builder.filter_sql(table, &root, filter);
        wheres.push(sql);
    }
    let where_sql = if wheres.is_empty() {
        String::new()
    } else {
        format!(" where {}", wheres.join(" and "))
    };
    let sql = match &request.mutation {
        None if request.head => {
            format!("select to_jsonb(count(*)) from public.{table} {root}{where_sql}")
        }
        None => {
            let orders: Vec<&Order> = request
                .orders
                .iter()
                .filter(|order| order.path.is_empty())
                .collect();
            let order_sql = Builder::order_sql(&root, &orders);
            let limit = match request.cardinality {
                Cardinality::Many => request.limit.unwrap_or(DEFAULT_LIMIT),
                _ => 2,
            };
            let offset = request
                .offset
                .map(|offset| format!(" offset {offset}"))
                .unwrap_or_default();
            format!(
                "select {row_json} from public.{table} {root}{where_sql}{order_sql} limit {limit}{offset}"
            )
        }
        Some(mutation) => {
            let statement = match mutation {
                Mutation::Insert(rows) | Mutation::Upsert { rows, .. } => {
                    let columns = column_union(rows).join(", ");
                    let placeholder = builder.bind(Value::Array(
                        rows.iter().cloned().map(Value::Object).collect(),
                    ));
                    let mut sql = format!(
                        "insert into public.{table} ({columns}) select {columns} from jsonb_populate_recordset(null::public.{table}, {placeholder})"
                    );
                    if let Mutation::Upsert {
                        on_conflict,
                        ignore_duplicates,
                        ..
                    } = mutation
                    {
                        let target = match on_conflict {
                            Some(columns) => columns.clone(),
                            None => primary_key(tx, table).await?,
                        };
                        let updates: Vec<String> = column_union(rows)
                            .into_iter()
                            .filter(|column| !target.contains(column))
                            .map(|column| format!("{column} = excluded.{column}"))
                            .collect();
                        sql.push_str(&format!(" on conflict ({})", target.join(", ")));
                        if *ignore_duplicates || updates.is_empty() {
                            sql.push_str(" do nothing");
                        } else {
                            sql.push_str(&format!(" do update set {}", updates.join(", ")));
                        }
                    }
                    sql
                }
                Mutation::Update(row) => {
                    let list = row.keys().cloned().collect::<Vec<_>>().join(", ");
                    let placeholder = builder.bind(Value::Object(row.clone()));
                    format!(
                        "update public.{table} {root} set ({list}) = (select {list} from jsonb_populate_record(null::public.{table}, {placeholder})){where_sql}"
                    )
                }
                Mutation::Delete => format!("delete from public.{table} {root}{where_sql}"),
            };
            // Data-modifying statements must sit in a top-level WITH clause.
            format!("with {root} as ({statement} returning *) select {row_json} from {root}")
        }
    };
    let mut query = sqlx::query_as::<_, (Value,)>(&sql);
    for value in &builder.binds {
        query = query.bind(value);
    }
    let rows: Vec<Value> = query
        .fetch_all(&mut **tx)
        .await
        .map_err(super::read_model::map_command)?
        .into_iter()
        .map(|(row,)| row)
        .collect();
    if request.head {
        let count = rows.first().cloned().unwrap_or(json!(0));
        return Ok(json!({ "__zaipos_count": count }));
    }
    if !returning {
        return Ok(Value::Null);
    }
    finish(request.cardinality, rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_embedded_selects_with_hints_and_aliases() {
        let items = parse_select(
            "id, quantity, label:product_name, products!complementary_id(id, name), table_orders!inner(status, tables(name))",
            0,
        )
        .unwrap();
        assert_eq!(items.len(), 5);
        match &items[3] {
            Item::Embed(embed) => {
                assert_eq!(embed.relation, "products");
                assert_eq!(embed.hint.as_deref(), Some("complementary_id"));
                assert!(!embed.inner);
            }
            other => panic!("unexpected {other:?}"),
        }
        match &items[4] {
            Item::Embed(embed) => {
                assert!(embed.inner);
                assert!(matches!(embed.items[1], Item::Embed(_)));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(
            items[2],
            Item::Column {
                name: "product_name".into(),
                alias: "label".into()
            }
        );
    }

    #[test]
    fn rejects_injection_in_identifiers_and_unknown_steps() {
        assert!(parse_select("id; drop table x", 0).is_err());
        assert!(parse_select("name)(", 0).is_err());
        assert!(parse_request(&[json!(["eq", ["id) or (1=1", "x"]])]).is_err());
        assert!(parse_request(&[json!(["rpc", []])]).is_err());
        assert!(parse_request(&[json!(["insert", [{"bad key": 1}]])]).is_err());
        assert!(parse_request(&[json!(["in", ["id", "not-an-array"]])]).is_err());
    }

    #[test]
    fn blanket_update_and_delete_are_rejected() {
        assert!(parse_request(&[json!(["delete", []])]).is_err());
        assert!(parse_request(&[json!(["update", [{"name": "x"}]])]).is_err());
        assert!(parse_request(&[json!(["delete", []]), json!(["eq", ["id", "1"]])]).is_ok());
    }

    #[test]
    fn parses_supabase_js_modifiers() {
        let request = parse_request(&[
            json!(["select", ["*", {"count": "exact", "head": true}]]),
            json!(["eq", ["sales.branch_id", "b1"]]),
            json!(["order", ["created_at", {"ascending": false}]]),
            json!(["range", [0, 9]]),
            json!(["maybeSingle", []]),
        ])
        .unwrap();
        assert!(request.head && request.count);
        assert_eq!(request.filters[0].path, vec!["sales".to_string()]);
        assert_eq!(request.limit, Some(10));
        assert_eq!(request.cardinality, Cardinality::MaybeSingle);
    }
}
