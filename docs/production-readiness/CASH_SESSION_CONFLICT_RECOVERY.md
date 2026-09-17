# Cash session conflict recovery — PR67

Baseline: PR65 at `18dd13685ab709c4b36b33480842ecf256f78476`. Repair baseline: PR67 at `cc5b30a01803b51fa6eec9ba03ccf189fded340a`.

CI35211472796 failed 14 tests. Local reproduction on the same source also failed 14 tests. The primary cause was an accidental UUID regular-expression regression from five groups (8-4-4-4-12) to four groups (8-4-4-12). Valid tenant/branch IDs failed before persistence or network calls. The test fixtures use valid PostgreSQL UUIDs and did not require replacement or looser validation.

Restoring the standard UUID shape exposed one genuine contract mismatch: the old test expected a `rejected` conflict to permit clearing the saved identity. The stricter acknowledgement guard intentionally prevents that. The updated test now proves that the original identity and request remain, a replacement cannot start, recovery reuses the original identity, and only a matching recorded/cancelled receipt permits acknowledgement. Pending requests retain their existing recovery guard.

The UI now treats `rejected` as unresolved: it displays the conflict, offers retry/cancellation resolution under the original request, and withholds acknowledgement and new-session submission. The server still checks actor and payload binding. A permanently conflicting request needs manager reconciliation of the preserved original device/server records; a conflict alone never authorizes erasure, an invented receipt, or a replacement financial operation. No database evidence is changed by this repair.

Verification includes standard UUID acceptance through real recovery/UI paths, shortened-UUID rejection before persistence/network, conflict preservation, recovery after a matching receipt, retained explicit counts, remount/restart, corruption and failure handling. Twenty focused local tests passed after the correction. Full regression and exact-head CI results must be observed before integration.

Integrate this focused repair into the PR65 development branch only after verification. Main merge, release and deployment remain subject to explicit authorization. Preserve the previous failed CI as historical evidence.
