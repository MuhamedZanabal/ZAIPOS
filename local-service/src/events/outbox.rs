use sqlx::Row;

use crate::db::{Database, DbError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboxEvent {
    pub sequence: u64,
    pub tenant_id: String,
    pub branch_id: String,
    pub kind: String,
}

#[derive(Default)]
pub struct Outbox {
    next: u64,
    events: Vec<OutboxEvent>,
}

impl Outbox {
    pub fn append(
        &mut self,
        tenant_id: impl Into<String>,
        branch_id: impl Into<String>,
        kind: impl Into<String>,
    ) -> u64 {
        self.next += 1;
        let sequence = self.next;
        self.events.push(OutboxEvent {
            sequence,
            tenant_id: tenant_id.into(),
            branch_id: branch_id.into(),
            kind: kind.into(),
        });
        sequence
    }

    pub fn read_after(&self, tenant_id: &str, branch_id: &str, cursor: u64) -> Vec<OutboxEvent> {
        self.events
            .iter()
            .filter(|event| {
                event.sequence > cursor
                    && event.tenant_id == tenant_id
                    && event.branch_id == branch_id
            })
            .cloned()
            .collect()
    }
}

pub async fn ensure_durable(db: &Database) -> Result<(), DbError> {
    sqlx::raw_sql(
        "create table if not exists public.zaipos_outbox (
            sequence bigint generated always as identity primary key,
            tenant_id text not null,
            branch_key text not null,
            kind text not null
        )",
    )
    .execute(db.pool())
    .await
    .map(|_| ())
    .map_err(|_| DbError::Connection)
}

pub async fn append_durable(
    db: &Database,
    tenant_id: &str,
    branch_id: &str,
    kind: &str,
) -> Result<u64, DbError> {
    if tenant_id.is_empty() || branch_id.is_empty() || kind.is_empty() {
        return Err(DbError::Connection);
    }
    let row = sqlx::query(
        "insert into public.zaipos_outbox (tenant_id, branch_key, kind)
         values ($1, $2, $3)
         returning sequence",
    )
    .bind(tenant_id)
    .bind(branch_id)
    .bind(kind)
    .fetch_one(db.pool())
    .await
    .map_err(|_| DbError::Connection)?;
    let sequence: i64 = row.get("sequence");
    u64::try_from(sequence).map_err(|_| DbError::Connection)
}

pub async fn read_durable(
    db: &Database,
    tenant_id: &str,
    branch_id: &str,
    cursor: u64,
) -> Result<Vec<OutboxEvent>, DbError> {
    let cursor = i64::try_from(cursor).map_err(|_| DbError::Connection)?;
    let rows = sqlx::query(
        "select sequence, tenant_id, branch_key, kind
           from public.zaipos_outbox
          where tenant_id = $1 and branch_key = $2 and sequence > $3
          order by sequence",
    )
    .bind(tenant_id)
    .bind(branch_id)
    .bind(cursor)
    .fetch_all(db.pool())
    .await
    .map_err(|_| DbError::Connection)?;
    rows.into_iter()
        .map(|row| {
            let sequence: i64 = row.get("sequence");
            Ok(OutboxEvent {
                sequence: u64::try_from(sequence).map_err(|_| DbError::Connection)?,
                tenant_id: row.get("tenant_id"),
                branch_id: row.get("branch_key"),
                kind: row.get("kind"),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_is_ordered_and_isolated() {
        let mut outbox = Outbox::default();
        outbox.append("tenant-a", "branch-a", "sale");
        let second = outbox.append("tenant-a", "branch-a", "payment");
        outbox.append("tenant-b", "branch-b", "sale");
        let resumed = outbox.read_after("tenant-a", "branch-a", 1);
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0].sequence, second);
        assert!(outbox.read_after("tenant-b", "branch-a", 0).is_empty());
    }
}
