# Cash session conflict recovery — PR67

Baseline: PR65 at `18dd13685ab709c4b36b33480842ecf256f78476`. Repair baseline: PR67 at `cc5b30a01803b51fa6eec9ba03ccf189fded340a`.

CI35211472796 failed 14 tests. Local reproduction on the same source also failed 14 tests. The primary cause was an accidental UUID regular-expression regression from five groups (8-4-4-4-12) to four groups (8-4-4-12). Valid tenant/branch IDs failed before persistence or network calls. The test fixtures use valid PostgreSQL UUIDs and did not require replacement or looser validation.

Restoring the standard UUID shape exposed one genuine contract mismatch: the old test expected a `rejected` conflict to permit clearing the saved identity. The stricter acknowledgement guard intentionally prevents that. The updated test now proves that the original identity and request remain, a replacement cannot start, recovery reuses the original identity, and only a matching recorded/cancelled receipt permits acknowledgement. Pending requests retain their existing recovery guard.

The UI now treats `rejected` as unresolved: it displays the conflict, offers retry/cancellation resolution under the original request, and withholds acknowledgement and new-session submission. The server still checks actor and payload binding. A permanently conflicting request needs manager reconciliation of the preserved original device/server records; a conflict alone never authorizes erasure, an invented receipt, or a replacement financial operation. No database evidence is changed by this repair.

Verification includes standard UUID acceptance through real recovery/UI paths, shortened-UUID rejection before persistence/network, conflict preservation, recovery after a matching receipt, retained explicit counts, remount/restart, corruption and failure handling. Twenty focused local tests passed after the correction. Full local regression passed 256 tests across 53 files. Exact repair head `75b4ba32a72cb2f981888bc287d788ba8a8df775` passed CI35237634656, including PostgreSQL contracts, lint, production build and unsigned Windows packaging. Tested merge `276d6b9d665aa5b051656d251df6edb67da72274` has the identical tree `d1d1a6f1afa78ae429c091f4f9744cce25d58751`.

Integrate this focused repair into the PR65 development branch only after verification. Main merge, release and deployment remain subject to explicit authorization. Preserve the previous failed CI as historical evidence.

The current user authorized integration into the PR65 development branch followed by combined verification. This integration preserves the tested repair commits and adds only this evidence update. Main merge remains a separate authorization boundary. The exact combined-head CI result is recorded in PR65, avoiding a self-referential claim that a commit has verified itself.
