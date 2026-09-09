# POS PIN security

ZAIPOS employee PINs are verified by the authenticated `pos-pin` Edge Function. The browser never writes PINs or hashes to database tables.

## Security model

- PINs contain 4–8 digits.
- New credentials use Argon2id with version 19, 19 MiB memory, two iterations, one lane, a random 16-byte salt and a 32-byte result.
- Credential and attempt tables deny all direct access to authenticated application users.
- Only service-role database commands can set, begin or complete verification.
- The Edge Function validates the caller's JWT and passes that verified actor ID to the commands.
- PIN setup requires owner, admin or manager authority in the exact tenant and branch.
- Verification requires a registered, non-revoked device in that branch. When supplied, the open cash session must belong to the requesting operator.
- Five failed attempts lock the employee credential for 15 minutes.
- Successful verification returns the employee ID, display name, role and branch. It never returns a secret to the client.

## Legacy conversion

Historical plaintext employee PINs are moved into the inaccessible credential table during migration. The old `employees.pin` and `profiles.pin` columns are then removed. A legacy value is replaced by an Argon2id hash only after a successful constant-time verification. A manager can reset any unusable legacy PIN through Employees → Set PIN.

## Operations

- Managers set or reset a PIN from the Employees page.
- A failed Edge Function call can be retried with Set PIN; employee creation never writes the entered PIN into `employees`.
- Lockouts expire automatically after 15 minutes. Resetting a PIN also clears the failed-attempt state.
- Review `employee_pos_pin_attempts` and `audit_logs` with administrative/server access when investigating repeated failures. PIN values and hashes must never be copied into logs or support tickets.
