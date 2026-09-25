# ZAIPOS Fully Local LAN Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every ZAIPOS runtime dependency on hosted Supabase with a store-local PostgreSQL database and an authenticated ZAIPOS Local Service that supports one server and multiple private-LAN Windows terminals.

**Architecture:** A Rust Windows service is the only process allowed to hold PostgreSQL credentials. Electron main communicates with the service over pinned TLS and exposes a narrow typed IPC bridge to the renderer; the renderer never receives database, service, device-private-key, or recovery credentials. Existing PostgreSQL migrations and financial RPCs remain authoritative while Supabase Auth, Realtime, Storage, Edge Functions, and the generic JavaScript client are replaced explicitly.

**Tech Stack:** Rust 2024, Tokio, Axum, rustls, SQLx/PostgreSQL, Argon2id, Ed25519/P-256 certificates, React 18, TypeScript 5.8, Electron 42, Vitest 3, PostgreSQL 17, NSIS/electron-builder, Windows Service Control Manager and DPAPI.

**Spec:** `docs/superpowers/specs/2026-09-25-fully-local-lan-architecture-design.md`

## Global Constraints

- Target Windows 10/11 x64 with `server + terminal` and `terminal only` installation roles.
- Core retail and restaurant operation must require neither internet access nor Supabase credentials.
- PostgreSQL listens only on loopback and accepts only the restricted ZAIPOS Local Service role.
- Renderers and terminal processes never receive PostgreSQL credentials or device private keys.
- Preserve exact BHD three-decimal accounting, atomicity, idempotency, immutable audit, tenant/branch/device/user/role isolation, and canonical replay behavior.
- Every mutation fails closed on missing authentication, wrong tenant, wrong branch, unauthorized role, inactive user, inactive branch, revoked device, copied credential, or conflicting replay.
- Offline financial checkout remains disabled; loss of the local service disables every financial submission.
- Existing ordered PostgreSQL migrations remain schema authority; historical migration bytes are immutable.
- The production-complete runtime and packaged binaries contain no Supabase SDK, URL, key, hosted-auth, Storage, Realtime, or Edge Function dependency.
- No production data is altered automatically; legacy import is explicit, reconciled, and reversible.
- Signed release, hardware compatibility, measured RPO/RTO, provider authorization, and Bahrain regulatory acceptance remain external gates.

## Review Focus

- A terminal presenting a valid certificate copied from another device must fail proof-of-possession with zero database effects; Task 4 pins this with a two-key enrollment test.
- A service crash after PostgreSQL commit but before HTTP response must return the original canonical result on retry; Task 7 pins this with a response-loss integration test.
- A migration whose filename is unchanged but bytes differ must stop service readiness without applying later migrations; Task 3 pins this with a checksum-tamper test.
- A backup with one modified attachment byte must be rejected before database promotion; Task 12 pins this with manifest-corruption tests.
- A terminal discovering a malicious LAN service with the right hostname but wrong CA fingerprint must not connect; Task 5 pins this with a certificate-pinning test.

---

## File and ownership map

| Path | Responsibility |
|---|---|
| `local-service/Cargo.toml` | Rust service crate and pinned dependency graph |
| `local-service/src/main.rs` | Process startup and Windows-service/console dispatch only |
| `local-service/src/config.rs` | Validated service configuration and secret paths |
| `local-service/src/http.rs` | Axum router, request limits, TLS listener, error envelope |
| `local-service/src/db/` | PostgreSQL pool, transaction identity, migrations and readiness |
| `local-service/src/auth/` | Local password/PIN credentials, sessions and recovery codes |
| `local-service/src/device/` | Store CA, enrollment, device certificates and revocation |
| `local-service/src/commands/` | Typed financial and operational command endpoints |
| `local-service/src/events/` | Transactional outbox and resumable WSS delivery |
| `local-service/src/attachments/` | Content-addressed, tenant-scoped file custody |
| `local-service/src/backup/` | Encrypted backup, verification and atomic restore |
| `local-service/tests/` | Real-PostgreSQL and HTTP/mTLS adversarial integration tests |
| `src/backend/` | Renderer-safe domain interfaces and local-service adapter |
| `electron/services/local-service-client.ts` | Pinned-TLS Electron-main transport and session/device custody |
| `electron/services/local-service-manager.ts` | Local server lifecycle and readiness coordination |
| `electron/preload.ts` / `electron/types.ts` | Narrow allowlisted typed IPC surface |
| `installer/` | PostgreSQL/service provisioning and NSIS role selection |
| `scripts/verify-no-supabase-runtime.mjs` | Source, dependency and packaged-binary zero-Supabase gate |
| `scripts/test-local-*.mjs` | Cross-process acceptance and migration/import verification |

### Task 1: Establish the Rust local-service boundary

**Files:**
- Create: `Cargo.toml`
- Create: `local-service/Cargo.toml`
- Create: `local-service/src/lib.rs`
- Create: `local-service/src/main.rs`
- Create: `local-service/src/config.rs`
- Create: `local-service/src/http.rs`
- Create: `local-service/tests/health.rs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: environment-independent paths supplied by the Windows service launcher.
- Produces: `ServiceConfig::load(ServicePaths) -> Result<ServiceConfig, ConfigError>`, `build_router(AppState) -> axum::Router`, and `GET /v1/health` returning `HealthResponse`.

- [x] **Step 1: Write the failing health and configuration tests**

```rust
#[tokio::test]
async fn health_never_discloses_secrets() {
    let app = test_app().await;
    let response = request(&app, "/v1/health").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_text(response).await;
    assert_eq!(body, r#"{"status":"starting","database":"unavailable"}"#);
    assert!(!body.contains("password"));
}

#[test]
fn rejects_config_outside_program_data() {
    let err = ServiceConfig::load(ServicePaths::new(r"C:\Users\Public\zaipos")).unwrap_err();
    assert!(matches!(err, ConfigError::UnsafeRoot));
}
```

- [x] **Step 2: Run the tests and confirm the missing crate failure**

Run: `cargo test -p zaipos-local-service --test health`

Expected: FAIL because `zaipos-local-service` and its exported test helpers do not exist.

- [x] **Step 3: Add the workspace, strict configuration parser, error envelope, and loopback-only health router**

```rust
#[derive(Clone, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub database: &'static str,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .layer(RequestBodyLimitLayer::new(1_048_576))
        .with_state(state)
}
```

The configuration parser must reject relative roots, user-profile roots, wildcard listen addresses, plaintext LAN mode, missing ACL-protected secret files, and unknown configuration keys.

- [x] **Step 4: Run service checks**

Run: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add Cargo.toml local-service .github/workflows/ci.yml
git commit -m "feat(local): establish fail-closed local service"
```

### Task 2: Provision a loopback-only PostgreSQL cluster

**Files:**
- Create: `local-service/src/provisioning/mod.rs`
- Create: `local-service/src/provisioning/postgres.rs`
- Create: `local-service/src/db/mod.rs`
- Create: `local-service/src/db/pool.rs`
- Create: `local-service/tests/postgres_provisioning.rs`
- Create: `installer/postgres/postgresql.conf.template`
- Create: `installer/postgres/pg_hba.conf.template`

**Interfaces:**
- Consumes: `ServiceConfig.database_root`, a generated 32-byte password, and bundled PostgreSQL 17 binaries.
- Produces: `PostgresProvisioner::ensure_cluster() -> Result<ProvisionedDatabase, ProvisionError>` and `Database::connect(&ProvisionedDatabase) -> Result<Database, DbError>`.

- [x] **Step 1: Write failing provisioning-policy tests**

```rust
#[test]
fn generated_postgres_policy_is_loopback_and_scram_only() {
    let rendered = render_postgres_policy(55432).unwrap();
    assert!(rendered.postgresql_conf.contains("listen_addresses = '127.0.0.1'"));
    assert!(rendered.pg_hba_conf.contains("hostssl zaipos zaipos_service 127.0.0.1/32 scram-sha-256"));
    assert!(!rendered.pg_hba_conf.contains("0.0.0.0/0"));
    assert!(!rendered.pg_hba_conf.contains(" trust"));
}
```

- [ ] **Step 2: Verify the tests fail**

Run: `cargo test -p zaipos-local-service --test postgres_provisioning`

Expected: FAIL with unresolved `render_postgres_policy`. The policy tests were added together with the renderer, so this red run was not captured separately.

- [x] **Step 3: Implement cluster initialization and restricted roles**

```rust
pub struct ProvisionedDatabase {
    pub port: u16,
    pub database_name: String,
    credential: secrecy::SecretString,
}

impl PostgresProvisioner {
    pub async fn ensure_cluster(&self) -> Result<ProvisionedDatabase, ProvisionError>;
}
```

Initialize with SCRAM-SHA-256, TLS on loopback, `zaipos_owner` as non-login migration owner, and `zaipos_service` as the only login role. Store credentials under LocalSystem/service-account ACLs; never log or return them through HTTP/IPC.

- [ ] **Step 4: Run the real process test**

Run: `cargo test -p zaipos-local-service --test postgres_provisioning -- --ignored --nocapture`

Expected: PASS and a connection attempt from a non-loopback address is rejected.

- [ ] **Step 5: Commit**

```bash
git add local-service/src/provisioning local-service/src/db local-service/tests/postgres_provisioning.rs installer/postgres
git commit -m "feat(local): provision private PostgreSQL cluster"
```

### Task 3: Make the existing migration chain locally authoritative

**Files:**
- Create: `local-service/src/db/migrations.rs`
- Create: `local-service/build.rs`
- Create: `local-service/tests/migration_chain.rs`
- Create: `scripts/test-local-migration-chain.mjs`
- Modify: `scripts/validate-migrations.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: immutable files under `supabase/migrations/*.sql` during the transition.
- Produces: `MigrationRunner::apply(&Database) -> Result<MigrationReport, MigrationError>` and table `zaipos_schema_migrations(filename, sha256, app_version, started_at, completed_at, failure_detail)`.

- [ ] **Step 1: Write failing empty-cluster, replay, and tamper tests**

```rust
#[tokio::test]
async fn changed_historical_migration_blocks_readiness() {
    let db = empty_postgres().await;
    runner_with(FIXTURE_V1).apply(&db).await.unwrap();
    let error = runner_with(FIXTURE_V1_TAMPERED).apply(&db).await.unwrap_err();
    assert!(matches!(error, MigrationError::ChecksumMismatch { .. }));
    assert_eq!(db.scalar::<i64>("select count(*) from later_fixture").await, Err(DbError::UndefinedTable));
}
```

- [ ] **Step 2: Verify failure before implementation**

Run: `cargo test -p zaipos-local-service --test migration_chain`

Expected: FAIL because `MigrationRunner` does not exist.

- [ ] **Step 3: Embed ordered migration bytes and implement advisory-lock execution**

```rust
pub async fn apply(&self, db: &Database) -> Result<MigrationReport, MigrationError> {
    let mut tx = db.begin().await?;
    sqlx::query("select pg_advisory_xact_lock($1)").bind(MIGRATION_LOCK).execute(&mut *tx).await?;
    self.verify_applied_checksums(&mut tx).await?;
    self.apply_pending_in_order(&mut tx).await?;
    tx.commit().await?;
    Ok(self.report())
}
```

The build script must sort by filename, reject duplicates/non-UTF-8 files, compute SHA-256 over exact bytes, and embed the manifest. Service readiness remains `migration_failed` until the complete chain and readiness probes pass.

- [ ] **Step 4: Run both local-service and existing PostgreSQL contracts**

Run: `cargo test -p zaipos-local-service --test migration_chain && npm run validate:migrations && node scripts/test-production-migration-chain-supabase.mjs`

Expected: PASS; the existing script name may remain until Task 14 renames the last Supabase-labelled verification artifact.

- [ ] **Step 5: Commit**

```bash
git add local-service/build.rs local-service/src/db/migrations.rs local-service/tests/migration_chain.rs scripts .github/workflows/ci.yml
git commit -m "feat(local): run immutable migrations locally"
```

### Task 4: Implement the store CA and device-bound LAN enrollment

**Files:**
- Create: `local-service/src/device/mod.rs`
- Create: `local-service/src/device/ca.rs`
- Create: `local-service/src/device/enrollment.rs`
- Create: `local-service/src/device/verification.rs`
- Create: `local-service/tests/device_enrollment.rs`
- Create: `supabase/migrations/20260925110000_local_device_certificates.sql`

**Interfaces:**
- Consumes: existing `devices`, enrollment approvals, tenant, branch and role authority.
- Produces: `POST /v1/devices/enrollment-requests`, `POST /v1/devices/{id}/approve`, `POST /v1/devices/{id}/revoke`, and `VerifiedDeviceContext`.

- [ ] **Step 1: Write failing enrollment adversarial tests**

```rust
#[tokio::test]
async fn copied_certificate_without_private_key_has_zero_effects() {
    let enrolled = harness.enroll_terminal("branch-a").await;
    let attacker_key = DeviceKeyPair::generate();
    let response = harness.call_with_certificate_and_key(
        enrolled.certificate,
        attacker_key,
        "/v1/commands/checkout",
        checkout_payload(),
    ).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(harness.sale_count().await, 0);
}
```

Add explicit cases for unapproved request, wrong tenant, wrong branch, inactive branch, revoked device, expired certificate, malformed certificate, replayed enrollment code, and an approver without `owner|admin|manager` authority.

- [ ] **Step 2: Verify the tests fail**

Run: `cargo test -p zaipos-local-service --test device_enrollment`

Expected: FAIL because enrollment routes and `VerifiedDeviceContext` are absent.

- [ ] **Step 3: Implement CA custody, proof-of-possession and revocation**

```rust
pub struct VerifiedDeviceContext {
    pub device_id: Uuid,
    pub tenant_id: Uuid,
    pub branch_id: Uuid,
    pub certificate_serial: String,
}

pub async fn verify_device(
    peer: PeerCertificate,
    proof: SignedChallenge,
    db: &Database,
) -> Result<VerifiedDeviceContext, DeviceAuthError>;
```

Generate the store CA once; encrypt its private key using DPAPI on Windows. Issue short-lived client certificates containing only opaque identifiers. Match certificate serial, public-key fingerprint, tenant, branch, active device state and revocation state inside one database transaction.

- [ ] **Step 4: Run migration and device suites**

Run: `cargo test -p zaipos-local-service --test device_enrollment && npm run test:migrations:devices`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add local-service/src/device local-service/tests/device_enrollment.rs supabase/migrations/20260925110000_local_device_certificates.sql
git commit -m "feat(local): enroll device-bound LAN terminals"
```

### Task 5: Add pinned-TLS Electron-main transport and secure discovery

**Files:**
- Create: `electron/services/local-service-client.ts`
- Create: `electron/services/local-service-discovery.ts`
- Create: `electron/services/local-device-key.ts`
- Create: `src/test/desktop/local-service-client.test.ts`
- Modify: `electron/main.ts`
- Modify: `electron/types.ts`
- Modify: `electron/preload.ts`

**Interfaces:**
- Consumes: `ServerProfile { origin, caFingerprint, deviceCertificateRef }` stored by Electron main.
- Produces: `LocalServiceClient.request<TReq,TRes>()`, `probeServerCandidate()`, and IPC methods `localStatus`, `enrollLocalTerminal`, `localRequest`, `subscribeLocalEvents`.

- [ ] **Step 1: Write failing pinning and custody tests**

```ts
it('rejects the correct hostname with the wrong CA fingerprint', async () => {
  const client = createLocalServiceClient(profile({ caFingerprint: GOOD_PIN }), fakeTls({ fingerprint: EVIL_PIN }));
  await expect(client.health()).rejects.toThrow('LOCAL_CA_MISMATCH');
});

it('never exposes private key material through preload', () => {
  expect(Object.keys(exposedElectronApi)).not.toContain('getDevicePrivateKey');
  expect(JSON.stringify(exposedElectronApi)).not.toMatch(/privateKey|databasePassword/);
});
```

- [ ] **Step 2: Verify focused tests fail**

Run: `npx vitest run src/test/desktop/local-service-client.test.ts`

Expected: FAIL because the client and IPC methods do not exist.

- [ ] **Step 3: Implement explicit-address/QR discovery and pinned TLS**

```ts
export interface ServerProfile {
  origin: `https://${string}`;
  caFingerprint: string;
  deviceCertificateRef: string;
}

export interface LocalServiceClient {
  health(signal?: AbortSignal): Promise<LocalHealth>;
  request<TRequest, TResponse>(command: LocalCommand<TRequest, TResponse>, body: TRequest): Promise<TResponse>;
}
```

Validate private IPv4/IPv6 or loopback origins, forbid embedded credentials, HTTP, redirects, public addresses, DNS rebinding and unknown QR fields. Optional mDNS results remain suggestions until fingerprint confirmation.

- [ ] **Step 4: Run desktop security regression**

Run: `npx vitest run src/test/desktop && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/local-service-* electron/services/local-device-key.ts electron/main.ts electron/types.ts electron/preload.ts src/test/desktop
git commit -m "feat(local): add pinned local-service transport"
```

### Task 6: Replace Supabase Auth with local identity and sessions

**Files:**
- Create: `local-service/src/auth/mod.rs`
- Create: `local-service/src/auth/password.rs`
- Create: `local-service/src/auth/session.rs`
- Create: `local-service/src/auth/recovery.rs`
- Create: `local-service/tests/authentication.rs`
- Create: `supabase/migrations/20260925120000_local_identity.sql`
- Create: `src/backend/auth.ts`
- Modify: `src/hooks/useAuth.ts`
- Modify: `src/pages/Auth.tsx`
- Modify: `src/lib/signOut.ts`

**Interfaces:**
- Consumes: enrolled `VerifiedDeviceContext` and local users/roles.
- Produces: `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `POST /v1/auth/recover`, `LocalSession`, and `AuthClient`.

- [ ] **Step 1: Write failing identity tests**

```rust
#[tokio::test]
async fn inactive_user_cannot_login_or_refresh() {
    let user = harness.user("cashier", false).await;
    assert_eq!(harness.login(user, "correct-password").await.status(), StatusCode::FORBIDDEN);
    assert_eq!(harness.refresh(user.existing_session).await.status(), StatusCode::FORBIDDEN);
}
```

Cover wrong password, wrong tenant, wrong branch, revoked device, inactive branch, expired refresh token, reused recovery code, Unicode-normalized username collision, and rate limiting without username enumeration.

- [ ] **Step 2: Verify failure**

Run: `cargo test -p zaipos-local-service --test authentication && npx vitest run src/hooks/useAuth.test.ts`

Expected: FAIL because the local identity API is absent and `useAuth` still imports Supabase.

- [ ] **Step 3: Implement Argon2id credentials and device-bound sessions**

```rust
pub struct SessionClaims {
    pub session_id: Uuid,
    pub user_id: Uuid,
    pub tenant_id: Uuid,
    pub branch_id: Uuid,
    pub roles: BTreeSet<Role>,
    pub device_id: Uuid,
    pub expires_at: DateTime<Utc>,
}
```

Use Argon2id with versioned parameters and random per-credential salts. Store only hashed refresh tokens. Rotate refresh tokens atomically and revoke the token family on reuse. Electron main stores session and recovery secrets using DPAPI-backed custody; the renderer receives only non-secret session metadata.

- [ ] **Step 4: Run authentication and authorization tests**

Run: `cargo test -p zaipos-local-service --test authentication && npx vitest run src/hooks/useAuth.test.ts src/pages/Auth.test.tsx && npm run test:migrations:pos-pin`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add local-service/src/auth local-service/tests/authentication.rs supabase/migrations/20260925120000_local_identity.sql src/backend/auth.ts src/hooks/useAuth.ts src/pages/Auth.tsx src/lib/signOut.ts
git commit -m "feat(local): replace hosted auth with local identity"
```

### Task 7: Route authoritative financial commands through the local service

**Files:**
- Create: `local-service/src/commands/mod.rs`
- Create: `local-service/src/commands/context.rs`
- Create: `local-service/src/commands/financial.rs`
- Create: `local-service/tests/financial_commands.rs`
- Create: `src/backend/financial.ts`
- Modify: `electron/services/device-credentials.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/modules/pos/POS.tsx`
- Modify: `src/modules/sales/ReturnDialog.tsx`
- Modify: `src/modules/sales/VoidSaleDialog.tsx`
- Modify: `src/lib/deviceCashSession.ts`
- Modify: `src/lib/cashMovementRecovery.ts`
- Modify: `src/modules/delivery/Delivery.tsx`
- Modify: `src/lib/deviceTableCheckout.ts`

**Interfaces:**
- Consumes: `VerifiedDeviceContext`, `SessionClaims`, an idempotency key and canonical JSON payload.
- Produces: `CommandContext`, `CommandResult<T>`, and versioned endpoints for checkout, return, void, cash movement/session, delivery collection, customer credit, supplier payment and table checkout.

- [ ] **Step 1: Write the shared adversarial and crash-replay suite**

```rust
#[tokio::test]
async fn response_loss_after_commit_replays_canonical_result() {
    let key = IdempotencyKey::new();
    harness.drop_connection_after_commit();
    assert!(harness.checkout(key, checkout_payload()).await.is_transport_error());
    let replay = harness.checkout(key, checkout_payload()).await.unwrap();
    assert_eq!(replay.sale_id, harness.only_sale_id().await);
    assert_eq!(harness.financial_effect_count(key).await, 1);
}
```

For every endpoint, generate cases for missing session, wrong tenant, wrong branch, wrong role, inactive user, inactive branch, revoked/copied device, missing idempotency key, identical replay, conflicting replay, two simultaneous identical requests, two conflicting requests, values beyond `numeric(20,3)`, and fractional-fils input.

- [ ] **Step 2: Verify the focused suite fails**

Run: `cargo test -p zaipos-local-service --test financial_commands`

Expected: FAIL because financial routes are absent.

- [ ] **Step 3: Implement one transaction wrapper around existing RPC authority**

```rust
pub async fn execute_command<T>(
    db: &Database,
    context: CommandContext,
    payload: T,
    invoke: impl AsyncFnOnce(&mut Transaction<'_, Postgres>, &T) -> Result<Uuid, CommandError>,
) -> Result<CommandResult<Uuid>, CommandError>;
```

The wrapper begins a transaction, revalidates device/user/tenant/branch/roles, sets transaction-local claims, locks or creates the idempotency record, compares the canonical payload hash, invokes the existing authoritative PostgreSQL function, stores the canonical response, appends audit/outbox rows, and commits once.

- [ ] **Step 4: Run the complete financial regression matrix**

Run: `cargo test -p zaipos-local-service --test financial_commands && npm run test:migrations:checkout && npm run test:migrations:returns && npm run test:migrations:void && node scripts/test-cash-replay-postgres.mjs && node scripts/test-transaction-auth-audit.mjs`

Expected: PASS with exact existing monetary totals and one effect per idempotency key.

- [ ] **Step 5: Commit**

```bash
git add local-service/src/commands local-service/tests/financial_commands.rs src/backend/financial.ts electron src/modules/pos/POS.tsx src/modules/sales src/lib/deviceCashSession.ts src/lib/cashMovementRecovery.ts src/modules/delivery/Delivery.tsx src/lib/deviceTableCheckout.ts
git commit -m "feat(local): route financial commands locally"
```

### Task 8: Port inventory, catalogue, production and restaurant mutations

**Files:**
- Create: `local-service/src/commands/inventory.rs`
- Create: `local-service/src/commands/catalogue.rs`
- Create: `local-service/src/commands/restaurant.rs`
- Create: `local-service/tests/operational_commands.rs`
- Create: `src/backend/inventory.ts`
- Create: `src/backend/catalogue.ts`
- Create: `src/backend/restaurant.ts`
- Modify: `src/modules/inventory/Inventory.tsx`
- Modify: `src/modules/suppliers/Suppliers.tsx`
- Modify: `src/modules/production/Production.tsx`
- Modify: `src/modules/products/Products.tsx`
- Modify: `src/modules/products/ProductForm.tsx`
- Modify: `src/modules/tables/TableOrder.tsx`
- Modify: `src/lib/catalogueImportCommands.ts`
- Modify: `src/lib/productMergeCommands.ts`
- Modify: `src/lib/productBarcodeCommands.ts`
- Modify: `src/lib/productFinancialCommands.ts`
- Modify: `src/lib/pricingPolicyCommands.ts`
- Modify: `src/lib/tableCart.ts`
- Modify: `src/lib/tableOrderItems.ts`
- Modify: `src/lib/tableKitchen.ts`

**Interfaces:**
- Consumes: the Task 7 `execute_command` wrapper.
- Produces: typed local endpoints for stock adjustment/count/transfer/batch, purchase-order receiving, production completion, product merge/barcode/pricing/import, table cart/item/kitchen lifecycle and restaurant order state.

- [ ] **Step 1: Write failing command-census and mode-isolation tests**

```rust
#[tokio::test]
async fn retail_tenant_cannot_mutate_restaurant_state() {
    let response = harness.as_retail_owner().open_table(valid_table_payload()).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(harness.table_order_count().await, 0);
}
```

Build a table-driven test listing every exported mutation name. Each row declares roles, tenant scope, branch scope, device requirement, idempotency requirement and positive fixture. The test must fail if a route exists without a declaration or a declaration lacks all negative cases.

- [ ] **Step 2: Verify failure**

Run: `cargo test -p zaipos-local-service --test operational_commands && node scripts/test-inventory-client-cutover.mjs`

Expected: FAIL while callers still depend on the Supabase client.

- [ ] **Step 3: Implement typed routes and migrate callers**

```ts
export interface InventoryClient {
  reconcile(input: ReconcileInventoryInput): Promise<InventoryCommandResult>;
  transfer(input: TransferInventoryInput): Promise<InventoryCommandResult>;
  receivePurchaseOrder(input: ReceivePurchaseOrderInput): Promise<InventoryCommandResult>;
  completeProduction(input: CompleteProductionInput): Promise<InventoryCommandResult>;
}
```

Do not expose generic RPC names to renderer code. Preserve all existing PostgreSQL transactional functions and revoke any newly discovered client-executable legacy function.

- [ ] **Step 4: Run inventory, supplier, product and restaurant contracts**

Run: `cargo test -p zaipos-local-service --test operational_commands && npm run test:migrations:inventory-idempotency && npm run test:migrations:product-barcodes && npm run test:migrations:product-merge && node scripts/test-table-checkout-security-postgres.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add local-service/src/commands local-service/tests/operational_commands.rs src/backend src/modules/inventory src/modules/suppliers src/modules/production src/modules/products src/modules/tables src/lib
git commit -m "feat(local): port operational commands"
```

### Task 9: Port read models, reports, administration and bootstrap

**Files:**
- Create: `local-service/src/queries/mod.rs`
- Create: `local-service/src/queries/reports.rs`
- Create: `local-service/src/queries/administration.rs`
- Create: `local-service/src/bootstrap.rs`
- Create: `local-service/tests/query_isolation.rs`
- Create: `src/backend/index.ts`
- Create: `src/backend/reports.ts`
- Create: `src/backend/administration.ts`
- Modify: `src/components/layout/TenantProvider.tsx`
- Modify: `src/pages/Onboarding.tsx`
- Modify: `src/modules/reports/Reports.tsx`
- Modify: `src/modules/branches/Branches.tsx`
- Modify: `src/modules/settings/UsersSettings.tsx`
- Modify: `src/modules/settings/SystemMaintenance.tsx`
- Modify: all remaining files reported by `rg -l 'integrations/supabase/client' src`

**Interfaces:**
- Consumes: local sessions and PostgreSQL read functions/views.
- Produces: `BackendClient`, cursor-based query envelopes, authoritative RETAIL/RESTAURANT bootstrap, exports and admin operations.

- [ ] **Step 1: Write failing exhaustive import and row-isolation tests**

```ts
it('renderer production modules import only BackendClient', async () => {
  const offenders = await findImports('src', /integrations\/supabase|@supabase\/supabase-js/);
  expect(offenders).toEqual([]);
});
```

Add real database tests proving tenant A cannot read tenant B data, branch A cannot read branch B scoped data, inactive users cannot query, retail tenants cannot query restaurant-only models, page sizes above 500 are rejected, and exports apply identical scope.

- [ ] **Step 2: Verify failure and capture the exact offender list**

Run: `npx vitest run src/backend/backend-import-boundary.test.ts && cargo test -p zaipos-local-service --test query_isolation`

Expected: FAIL with all remaining direct Supabase imports and missing local query routes.

- [ ] **Step 3: Implement query endpoints and migrate every remaining caller**

```ts
export interface BackendClient {
  auth: AuthClient;
  financial: FinancialClient;
  inventory: InventoryClient;
  catalogue: CatalogueClient;
  restaurant: RestaurantClient;
  reports: ReportsClient;
  administration: AdministrationClient;
  events: EventClient;
  attachments: AttachmentClient;
}
```

Use cursor pagination with stable `(updated_at,id)` ordering, schema-validated filter allowlists and fixed maximum page size. Bootstrap takes the existing global advisory lock and persists immutable business mode server-side.

- [ ] **Step 4: Run UI, report, export and business-mode suites**

Run: `npm test && cargo test -p zaipos-local-service --test query_isolation && node scripts/test-business-export-postgres.mjs && node scripts/test-authoritative-business-mode-postgres.mjs`

Expected: PASS and the direct-import offender list is empty.

- [ ] **Step 5: Commit**

```bash
git add local-service/src/queries local-service/src/bootstrap.rs local-service/tests/query_isolation.rs src/backend src/components/layout/TenantProvider.tsx src/pages/Onboarding.tsx src/modules src/lib
git commit -m "feat(local): port reads reports and administration"
```

### Task 10: Replace Realtime with a transactional outbox and resumable WSS

**Files:**
- Create: `supabase/migrations/20260925130000_local_event_outbox.sql`
- Create: `local-service/src/events/mod.rs`
- Create: `local-service/src/events/outbox.rs`
- Create: `local-service/src/events/websocket.rs`
- Create: `local-service/tests/event_delivery.rs`
- Create: `src/backend/events.ts`
- Modify: `src/hooks/useSyncEngine.ts`
- Modify: `src/hooks/useSyncEngine.test.ts`

**Interfaces:**
- Consumes: outbox rows inserted in the same transaction as authoritative mutations.
- Produces: `GET /v1/events?after=<sequence>` upgraded to WSS and `EventClient.subscribe(after, listener)`.

- [ ] **Step 1: Write failing ordering and isolation tests**

```rust
#[tokio::test]
async fn reconnect_resumes_without_cross_tenant_events() {
    let first = harness.connect_as(TENANT_A, 0).await;
    harness.emit(TENANT_A, BRANCH_A, "sale.changed").await;
    let sequence = first.next().await.sequence;
    harness.emit(TENANT_B, BRANCH_B, "sale.changed").await;
    harness.emit(TENANT_A, BRANCH_A, "inventory.changed").await;
    let resumed = harness.connect_as(TENANT_A, sequence).await;
    assert_eq!(resumed.next().await.kind, "inventory.changed");
    assert!(resumed.try_next_for(Duration::from_millis(100)).await.is_none());
}
```

- [ ] **Step 2: Verify failure**

Run: `cargo test -p zaipos-local-service --test event_delivery && npx vitest run src/hooks/useSyncEngine.test.ts`

Expected: FAIL because WSS event delivery is absent.

- [ ] **Step 3: Implement transactional outbox and bounded resume**

```rust
pub struct LocalEvent {
    pub sequence: i64,
    pub tenant_id: Uuid,
    pub branch_id: Option<Uuid>,
    pub kind: EventKind,
    pub entity_id: Uuid,
}
```

Authorize the WSS upgrade with device and user session context. Enforce tenant/branch filters server-side, maximum backlog, heartbeat timeout and explicit `RESYNC_REQUIRED` when the requested sequence has expired. Treat events as invalidation hints; reload authoritative state after gaps.

- [ ] **Step 4: Run event and renderer recovery tests**

Run: `cargo test -p zaipos-local-service --test event_delivery && npx vitest run src/hooks/useSyncEngine.test.ts`

Expected: PASS for ordered delivery, duplicates, gaps, stale sessions and isolation.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260925130000_local_event_outbox.sql local-service/src/events local-service/tests/event_delivery.rs src/backend/events.ts src/hooks/useSyncEngine.ts src/hooks/useSyncEngine.test.ts
git commit -m "feat(local): replace realtime with local events"
```

### Task 11: Replace Storage and Edge Functions

**Files:**
- Create: `local-service/src/attachments/mod.rs`
- Create: `local-service/src/attachments/store.rs`
- Create: `local-service/src/routes/users.rs`
- Create: `local-service/src/routes/pin.rs`
- Create: `local-service/src/routes/invoices.rs`
- Create: `local-service/tests/attachments.rs`
- Create: `local-service/tests/edge_replacements.rs`
- Create: `src/backend/attachments.ts`
- Modify: `src/modules/inventory/components/InvoiceOCRDialog.tsx`
- Modify: `src/modules/settings/UsersSettings.tsx`
- Delete at Task completion: `supabase/functions/activate-device/`
- Delete at Task completion: `supabase/functions/rotate-device-credential/`
- Delete at Task completion: `supabase/functions/create-user/`
- Delete at Task completion: `supabase/functions/pos-pin/`
- Delete at Task completion: `supabase/functions/process-invoice/`
- Delete at Task completion: `supabase/functions/embed-knowledge-doc/`
- Delete at Task completion: `supabase/functions/process-email-queue/`
- Delete at Task completion: `supabase/functions/send-whatsapp-message/`
- Delete at Task completion: `supabase/functions/evolution-webhook/`
- Delete at Task completion: `supabase/functions/ai-order-agent/`

**Interfaces:**
- Consumes: authenticated local sessions, tenant/branch scope and local filesystem root.
- Produces: `AttachmentStore::put/read/delete`, local user/PIN/invoice routes, and explicit `PROVIDER_NOT_CONFIGURED` for optional internet providers.

- [ ] **Step 1: Write failing attachment and route parity tests**

```rust
#[tokio::test]
async fn traversal_and_interrupted_write_leave_no_object() {
    assert!(matches!(store.put(TENANT_A, "../../secret", bytes()).await, Err(AttachmentError::InvalidName)));
    store.inject_failure_after_fsync();
    assert!(store.put(TENANT_A, "invoice.pdf", bytes()).await.is_err());
    assert_eq!(store.object_count().await, 0);
}
```

Cover oversized files, hash mismatch, corrupted objects, wrong tenant, wrong branch, inactive user, disallowed MIME, symlink targets, concurrent identical uploads and missing optional provider configuration.

- [ ] **Step 2: Verify failure**

Run: `cargo test -p zaipos-local-service --test attachments --test edge_replacements`

Expected: FAIL because local replacements do not exist.

- [ ] **Step 3: Implement atomic content-addressed custody and route replacements**

Write to an ACL-restricted temporary file, stream-hash with SHA-256, `sync_all`, rename atomically under `<tenant>/<hash-prefix>/<hash>`, then insert metadata in the owning transaction. Reads validate metadata scope before opening the canonical path. Keep email, WhatsApp, Evolution and AI order-agent modules disabled unless separately configured; they must never block core POS readiness.

- [ ] **Step 4: Run parity and source-census tests**

Run: `cargo test -p zaipos-local-service --test attachments --test edge_replacements && node scripts/authorization-surface-census.test.mjs`

Expected: PASS and all former Edge Function authority surfaces are represented by local-route declarations or explicit disabled-provider declarations.

- [ ] **Step 5: Commit**

```bash
git add local-service/src/attachments local-service/src/routes local-service/tests src/backend/attachments.ts src/modules/inventory/components/InvoiceOCRDialog.tsx src/modules/settings/UsersSettings.tsx supabase/functions
git commit -m "feat(local): replace storage and edge functions"
```

### Task 12: Implement encrypted backup and atomic restore

**Files:**
- Create: `local-service/src/backup/mod.rs`
- Create: `local-service/src/backup/manifest.rs`
- Create: `local-service/src/backup/restore.rs`
- Create: `local-service/tests/backup_restore.rs`
- Create: `src/backend/backup.ts`
- Modify: `src/modules/settings/SystemMaintenance.tsx`
- Create: `docs/production-readiness/LOCAL_BACKUP_RESTORE.md`

**Interfaces:**
- Consumes: `pg_dump`, attachment store, migration manifest, operator recovery secret and maintenance lock.
- Produces: `BackupService::create`, `BackupService::verify`, `BackupService::restore`, immutable audit results and admin API endpoints.

- [ ] **Step 1: Write failing corruption and rollback tests**

```rust
#[tokio::test]
async fn modified_attachment_rejects_restore_before_promotion() {
    let backup = harness.create_backup().await;
    harness.flip_one_attachment_byte(&backup);
    let original_database_id = harness.active_database_id().await;
    assert!(matches!(harness.restore(&backup).await, Err(RestoreError::ManifestMismatch { .. })));
    assert_eq!(harness.active_database_id().await, original_database_id);
}
```

Cover wrong recovery secret, incomplete archive, modified SQL dump, disk full, process death during restore, migration mismatch, failed readiness probes and concurrent business mutation attempts during restore.

- [ ] **Step 2: Verify failure**

Run: `cargo test -p zaipos-local-service --test backup_restore`

Expected: FAIL because backup services are absent.

- [ ] **Step 3: Implement encrypted manifest-first backup and new-database restore**

```rust
pub struct BackupManifest {
    pub format_version: u32,
    pub created_at: DateTime<Utc>,
    pub schema_manifest_sha256: String,
    pub database_sha256: String,
    pub attachments: BTreeMap<String, String>,
}
```

Derive an encryption key from the operator secret using Argon2id, encrypt with an authenticated streaming format, fsync and atomically rename. Restore to a new database name, run manifest/schema/financial/inventory probes, stop new mutations, swap the active database pointer, and retain the previous database until explicit cleanup.

- [ ] **Step 4: Run backup and financial reconciliation suites**

Run: `cargo test -p zaipos-local-service --test backup_restore && node scripts/test-backup-restore-postgres.mjs && node scripts/test-transaction-auth-audit.mjs`

Expected: PASS with unchanged monetary and inventory aggregates.

- [ ] **Step 5: Commit**

```bash
git add local-service/src/backup local-service/tests/backup_restore.rs src/backend/backup.ts src/modules/settings/SystemMaintenance.tsx docs/production-readiness/LOCAL_BACKUP_RESTORE.md
git commit -m "feat(local): add verified backup and restore"
```

### Task 13: Add explicit Supabase export and reconciled local import

**Files:**
- Create: `local-service/src/import/mod.rs`
- Create: `local-service/src/import/manifest.rs`
- Create: `local-service/src/import/reconcile.rs`
- Create: `local-service/tests/import_supabase_export.rs`
- Create: `scripts/export-supabase-for-local.mjs`
- Create: `scripts/test-local-import.mjs`
- Create: `docs/migration/SUPABASE_TO_LOCAL.md`

**Interfaces:**
- Consumes: an operator-created export archive; the importer never accepts live Supabase credentials.
- Produces: `ImportService::inspect`, `ImportService::import_into_empty`, and signed `ReconciliationReport`.

- [ ] **Step 1: Write failing manifest and reconciliation tests**

```rust
#[tokio::test]
async fn monetary_mismatch_prevents_activation() {
    let archive = fixture_export().with_declared_sales_total("100.000").with_actual_sales_total("99.999");
    let result = importer.import_into_empty(archive).await.unwrap_err();
    assert!(matches!(result, ImportError::ReconciliationMismatch { field } if field == "sales_total_bhd"));
    assert!(!harness.local_store_is_activated().await);
}
```

Cover schema-version mismatch, tenant mismatch, duplicate IDs, record-count mismatch, monetary mismatch, inventory mismatch, audit-chain discontinuity, missing attachment, duplicate idempotency key with different payload and interrupted import.

- [ ] **Step 2: Verify failure**

Run: `cargo test -p zaipos-local-service --test import_supabase_export && node scripts/test-local-import.mjs`

Expected: FAIL because the import format and service are absent.

- [ ] **Step 3: Implement offline archive validation and empty-database import**

```rust
pub struct ReconciliationReport {
    pub tenant_id: Uuid,
    pub source_schema_sha256: String,
    pub record_counts: BTreeMap<String, u64>,
    pub monetary_totals: BTreeMap<String, Decimal>,
    pub inventory_totals: BTreeMap<String, Decimal>,
    pub audit_chain_valid: bool,
    pub accepted_at: Option<DateTime<Utc>>,
}
```

The export script runs outside the packaged app with explicit environment credentials and outputs only the encrypted archive. Import requires an empty local tenant, runs in a staging database, reconciles before activation and never deletes or mutates the source project.

- [ ] **Step 4: Run import plus full migration chain**

Run: `cargo test -p zaipos-local-service --test import_supabase_export && node scripts/test-local-import.mjs && npm run validate:migrations`

Expected: PASS for a valid fixture and zero activation for every corrupt fixture.

- [ ] **Step 5: Commit**

```bash
git add local-service/src/import local-service/tests/import_supabase_export.rs scripts/export-supabase-for-local.mjs scripts/test-local-import.mjs docs/migration/SUPABASE_TO_LOCAL.md
git commit -m "feat(local): import reconciled Supabase exports"
```

### Task 14: Remove the production Supabase runtime completely

**Files:**
- Delete: `src/integrations/supabase/client.ts`
- Delete: `src/integrations/supabase/types.ts` after moving domain types to `src/backend/types.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Modify: `vite.config.ts`
- Modify: `electron/main.ts`
- Modify: `electron-builder.config.json`
- Create: `scripts/verify-no-supabase-runtime.mjs`
- Create: `scripts/verify-packaged-local-only.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: all completed local adapters.
- Produces: a production dependency tree and packaged application with zero runtime Supabase references.

- [ ] **Step 1: Write the failing zero-Supabase gate**

```js
const forbidden = [
  /@supabase\/supabase-js/,
  /VITE_SUPABASE_/,
  /https:\/\/[^/]+\.supabase\.co/,
  /integrations\/supabase/,
  /functions\.invoke\(/,
];
assertNoMatches(['src', 'electron', 'local-service', 'dist', 'dist-electron'], forbidden);
assertPackageAbsent('@supabase/supabase-js', packageJson, packageLock);
```

The script must distinguish retained migration history and the standalone export utility from runtime code. It must scan source, dependency lock, sourcemaps, ASAR contents and local-service binaries.

- [ ] **Step 2: Run the gate and capture every offender**

Run: `node scripts/verify-no-supabase-runtime.mjs`

Expected: FAIL until the SDK, environment variables, client/types imports and runtime strings are removed.

- [ ] **Step 3: Remove runtime dependencies and rename verification artifacts**

Run: `npm uninstall @supabase/supabase-js`

Move generated database domain types to `src/backend/types.ts`; remove Vite/Electron Supabase variables and the setup wizard. Rename `scripts/test-production-migration-chain-supabase.mjs` to `scripts/test-production-migration-chain-postgres.mjs` without changing assertions.

- [ ] **Step 4: Run source, dependency, build and package gates**

Run: `npm ci && npm audit --omit=dev && npm test && npm run lint && npx tsc --noEmit && npm run build && npm run build:electron:dir && node scripts/verify-no-supabase-runtime.mjs && node scripts/verify-packaged-local-only.mjs`

Expected: PASS; production audit reports zero known vulnerabilities and both source/package scans report zero runtime Supabase occurrences.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(local): remove Supabase runtime dependency"
```

### Task 15: Build the Windows service/terminal installer and lifecycle controls

**Files:**
- Create: `installer/nsis/role-selection.nsh`
- Create: `installer/nsis/service-install.nsh`
- Create: `installer/nsis/data-preservation.nsh`
- Create: `installer/scripts/install-local-service.ps1`
- Create: `installer/scripts/uninstall-local-service.ps1`
- Create: `electron/services/local-service-manager.ts`
- Create: `src/pages/LocalSetup.tsx`
- Create: `src/pages/LocalRecovery.tsx`
- Modify: `electron-builder.config.json`
- Modify: `package.json`
- Modify: `src/App.tsx`
- Create: `scripts/test-installer-contract.mjs`

**Interfaces:**
- Consumes: signed/unsigned Rust service executable, bundled PostgreSQL, Electron application and selected installation role.
- Produces: one NSIS installer supporting `server + terminal`, `terminal only`, upgrade, rollback and explicit data-preservation choice.

- [ ] **Step 1: Write failing installer-contract tests**

```js
assert.match(nsis, /Server \+ terminal/);
assert.match(nsis, /Terminal only/);
assert.match(uninstaller, /Preserve ZAIPOS business data/);
assert.doesNotMatch(uninstaller, /Remove-Item\s+[^\n]*-Recurse[^\n]*ProgramData\\ZAIPOS/);
assert.match(serviceInstaller, /sc\.exe create ZAIPOSLocalService/);
```

- [ ] **Step 2: Verify contract failure**

Run: `node scripts/test-installer-contract.mjs`

Expected: FAIL because role selection and service lifecycle scripts do not exist.

- [ ] **Step 3: Implement role-aware install, upgrade and uninstall**

Server mode installs PostgreSQL and the Local Service under restricted service accounts, provisions firewall rules only for the selected private profile, starts the service, waits for readiness and then opens local bootstrap. Terminal mode installs neither PostgreSQL nor the service and opens enrollment. Upgrade creates a verified backup before migration. Uninstall asks separately about application binaries and business data; the default preserves business data.

- [ ] **Step 4: Build and inspect the unsigned Windows package**

Run: `cargo build --release -p zaipos-local-service --target x86_64-pc-windows-msvc && npm run package:windows && node scripts/test-installer-contract.mjs && node scripts/verify-packaged-local-only.mjs`

Expected: PASS and the artifact contains the service, PostgreSQL bundle, role-selection pages and no Supabase runtime.

- [ ] **Step 5: Commit**

```bash
git add installer electron/services/local-service-manager.ts src/pages/LocalSetup.tsx src/pages/LocalRecovery.tsx src/App.tsx electron-builder.config.json package.json package-lock.json scripts/test-installer-contract.mjs
git commit -m "feat(local): package server and LAN terminal roles"
```

### Task 16: Add the final CI and Windows acceptance matrix

**Files:**
- Create: `.github/workflows/local-service.yml`
- Create: `.github/workflows/windows-local-acceptance.yml`
- Create: `scripts/test-local-two-terminal-contention.mjs`
- Create: `scripts/test-local-response-loss.mjs`
- Create: `scripts/test-local-disconnected-operation.ps1`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/RELEASE_CHECKLIST.md`
- Modify: `docs/engineering/ZAIPOS_AUTONOMOUS_HANDOFF.md`

**Interfaces:**
- Consumes: the complete local-only implementation and packaged Windows installer.
- Produces: exact-head CI evidence for Linux PostgreSQL contracts and Windows install/start/enroll/contention/disconnected-operation checks.

- [ ] **Step 1: Add a deliberately failing workflow contract test**

```js
const requiredJobs = [
  'local-service-rust',
  'local-postgres-migrations',
  'local-authorization-adversarial',
  'local-backup-restore',
  'windows-server-install',
  'windows-terminal-enrollment',
  'windows-two-terminal-contention',
  'windows-internet-disconnected',
  'zero-supabase-runtime',
];
assert.deepEqual(missingWorkflowJobs(requiredJobs), []);
```

- [ ] **Step 2: Verify missing jobs fail locally**

Run: `node scripts/test-workflow-contracts.mjs`

Expected: FAIL listing each absent job.

- [ ] **Step 3: Implement isolated jobs with artifact-preserved diagnostics**

Each job checks out the exact SHA, uses locked dependencies, emits test reports, uploads service/PostgreSQL logs only after redacting secrets, and fails on missing artifacts. The Windows disconnected test blocks public network routes after installation while retaining loopback/LAN test interfaces, then executes login, checkout, return, inventory, report and backup smoke paths.

- [ ] **Step 4: Run the full local pre-push matrix**

Run: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && npm ci && npm audit --omit=dev && npm run lint && npx tsc --noEmit && npm test && npm run build && npm run validate:migrations && node scripts/verify-no-supabase-runtime.mjs && node scripts/test-workflow-contracts.mjs && git diff --check`

Expected: PASS with zero Supabase runtime occurrences, zero high/critical production dependency findings, all existing PostgreSQL contracts green and offline financial checkout still disabled.

- [ ] **Step 5: Commit and publish the final implementation checkpoint**

```bash
git add .github/workflows scripts docs/RELEASE_CHECKLIST.md docs/engineering/ZAIPOS_AUTONOMOUS_HANDOFF.md
git commit -m "ci(local): verify fully local Windows operation"
```

Record the exact implementation head, every workflow run/job, installer SHA-256, remaining unsigned/hardware/regulatory gates, and the explicit statement that offline financial checkout remains disabled.

## Completion gate

Repository implementation is complete only after Tasks 1–16 are individually reviewed, the combined exact head passes all Linux and Windows workflows, `verify-no-supabase-runtime.mjs` and packaged-binary inspection report zero runtime Supabase occurrences, and a packaged server plus two packaged terminals pass local enrollment and contention tests with public internet blocked. This repository gate does not claim signed-installation, physical scanner/printer/drawer, production recovery objectives, provider authorization, or Bahrain regulatory acceptance.
