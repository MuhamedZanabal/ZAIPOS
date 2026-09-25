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
