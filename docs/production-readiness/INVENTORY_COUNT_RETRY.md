# Physical count file identity

The stock import previously created a random operation on every upload. A UI reproduction showed that a committed count of 10, a lost response, a later sale reducing stock to 9 and a retry could reset stock to 10.

Every physical count file now requires a UUID `count_reference`, identical on all rows. A stock CSV export generates a fresh reference. Retain the original file/reference when retrying, including after restart or on another authorized terminal. The operation ID binds tenant, branch, destination center and count reference. Quantity changes retain that ID so the server rejects payload substitution. Rows are sorted by product ID before submission. The PostgreSQL operation ledger remains the authority; there is no second client stock ledger.

Start each genuinely new count with a new exported file/reference. Do not change a reference merely to get past an error: first establish whether the earlier operation committed. Retrying a completed count returns its original result and preserves later stock movement. Changing an already committed count requires a new, deliberately performed count or the reviewed stocktake correction workflow. Never recycle an old count reference for a new count.

Legacy files without the reference are rejected before mutation. To retry an import made by an older application version, inspect its inventory operation/movement evidence before importing again; old random operation IDs cannot be reconstructed from the file. Restore of a local screen is not required for new-format replay because the reference is in the file and the result is in PostgreSQL.

Validation: UI tests cover commit/lost response/intervening sale/restart/retry, missing identity, and altered payload identity. The full-schema PostgreSQL contract exercises four concurrent retries after an authoritative reduction, exact 0.001 quantity, immutable movement fingerprints, payload substitution, cashier/revoked-manager denial, and a separate new count. CI and release quality gates run the database contract.

Limits: a physical count replaces current stock and must be taken under the store's controlled counting procedure. For snapshot freshness and supervised counting, use the authoritative stocktake workflow. This change does not complete export pagination, make a CSV a database backup, or establish cryptographic device enrollment. Restrict retained count files to authorized inventory operators.
