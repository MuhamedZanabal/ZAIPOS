import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_RUNTIME_OCCURRENCES = 419;
export const REQUIRED_NEGATIVE_DIMENSIONS = [
  'missing_authentication',
  'wrong_tenant',
  'wrong_branch',
  'unauthorized_role',
  'inactive_account',
  'credential_misuse',
];

export const EDGE_FUNCTION_AUTHORITY = {
  'supabase/functions/activate-device/index.ts': {
    authentication:'user-jwt', roles:['owner','admin','manager'], serviceRole:true,
    positive:['device-activation-edge','device-enrollment-postgres'],
    negative:{
      missing_authentication:['device-activation-edge'],
      wrong_tenant:['device-enrollment-postgres'],
      wrong_branch:['device-enrollment-postgres'],
      unauthorized_role:['device-enrollment-postgres'],
      inactive_account:['canonical-authority-helpers','device-enrollment-postgres'],
      credential_misuse:['device-activation-edge','device-credential-postgres'],
    },
  },
  'supabase/functions/ai-order-agent/index.ts': {
    authentication:'user-jwt', roles:[], serviceRole:false,
    positive:['ai-order-edge-disabled'],
    negative:{
      missing_authentication:['ai-order-edge-disabled'],
      wrong_tenant:['ai-order-edge-disabled'],
      wrong_branch:['ai-order-edge-disabled'],
      unauthorized_role:['ai-order-edge-disabled'],
      inactive_account:['ai-order-edge-disabled'],
      credential_misuse:['ai-order-edge-disabled'],
    },
  },
  'supabase/functions/create-user/index.ts': {
    authentication:'user-jwt', roles:['owner','admin'], serviceRole:true,
    positive:['create-user-edge'],
    negative:{
      missing_authentication:['create-user-edge'],
      wrong_tenant:['create-user-edge'],
      wrong_branch:['create-user-edge'],
      unauthorized_role:['create-user-edge'],
      inactive_account:['create-user-edge'],
      credential_misuse:['privileged-credential-custody'],
    },
  },
  'supabase/functions/embed-knowledge-doc/index.ts': {
    authentication:'user-jwt', roles:['owner','admin','manager'], serviceRole:true,
    positive:['embed-knowledge-edge','canonical-authority-helpers'],
    negative:{
      missing_authentication:['embed-knowledge-edge'],
      wrong_tenant:['canonical-authority-helpers','embed-knowledge-edge'],
      wrong_branch:['canonical-authority-helpers','embed-knowledge-edge'],
      unauthorized_role:['canonical-authority-helpers','embed-knowledge-edge'],
      inactive_account:['canonical-authority-helpers'],
      credential_misuse:['privileged-credential-custody'],
    },
  },
  'supabase/functions/evolution-webhook/index.ts': {
    authentication:'hmac', roles:[], serviceRole:true,
    positive:['evolution-webhook-hmac'],
    negative:{
      missing_authentication:['evolution-webhook-hmac'],
      wrong_tenant:['not-applicable:tenant-is-derived-after-hmac'],
      wrong_branch:['not-applicable:branch-is-derived-after-hmac'],
      unauthorized_role:['not-applicable:machine-webhook'],
      inactive_account:['not-applicable:machine-webhook'],
      credential_misuse:['evolution-webhook-hmac','privileged-credential-custody'],
    },
  },
  'supabase/functions/pos-pin/index.ts': {
    authentication:'user-jwt', roles:['owner','admin','manager','cashier'], serviceRole:true,
    positive:['pos-pin-edge','canonical-authority-helpers'],
    negative:{
      missing_authentication:['pos-pin-edge'],
      wrong_tenant:['pos-pin-postgres'],
      wrong_branch:['pos-pin-postgres'],
      unauthorized_role:['pos-pin-postgres'],
      inactive_account:['canonical-authority-helpers','pos-pin-postgres'],
      credential_misuse:['pos-pin-postgres','privileged-credential-custody'],
    },
  },
  'supabase/functions/process-email-queue/index.ts': {
    authentication:'exact-service-role-secret', roles:[], serviceRole:true,
    positive:['email-worker-service-secret'],
    negative:{
      missing_authentication:['email-worker-service-secret'],
      wrong_tenant:['not-applicable:service-worker-has-no-caller-tenant'],
      wrong_branch:['not-applicable:service-worker-has-no-caller-branch'],
      unauthorized_role:['email-worker-service-secret'],
      inactive_account:['not-applicable:non-human-service-principal'],
      credential_misuse:['email-worker-service-secret'],
    },
  },
  'supabase/functions/process-invoice/index.ts': {
    authentication:'user-jwt', roles:['owner','admin','manager','inventory'], serviceRole:false,
    positive:['process-invoice-edge','canonical-authority-helpers'],
    negative:{
      missing_authentication:['process-invoice-edge'],
      wrong_tenant:['canonical-authority-helpers','process-invoice-edge'],
      wrong_branch:['canonical-authority-helpers','process-invoice-edge'],
      unauthorized_role:['canonical-authority-helpers','process-invoice-edge'],
      inactive_account:['canonical-authority-helpers'],
      credential_misuse:['not-applicable:no-service-role-custody'],
    },
  },
  'supabase/functions/rotate-device-credential/index.ts': {
    authentication:'user-jwt', roles:['owner','admin','manager'], serviceRole:true,
    positive:['device-rotation-edge','device-rotation-postgres'],
    negative:{
      missing_authentication:['device-rotation-edge'],
      wrong_tenant:['device-rotation-postgres'],
      wrong_branch:['device-rotation-postgres'],
      unauthorized_role:['device-rotation-postgres'],
      inactive_account:['canonical-authority-helpers','device-rotation-postgres'],
      credential_misuse:['device-rotation-edge','device-rotation-postgres'],
    },
  },
  'supabase/functions/send-whatsapp-message/index.ts': {
    authentication:'user-jwt', roles:['owner','admin','manager','cashier'], serviceRole:true,
    positive:['send-whatsapp-edge','canonical-authority-helpers'],
    negative:{
      missing_authentication:['send-whatsapp-edge'],
      wrong_tenant:['send-whatsapp-edge','canonical-authority-helpers'],
      wrong_branch:['send-whatsapp-edge','canonical-authority-helpers'],
      unauthorized_role:['send-whatsapp-edge','canonical-authority-helpers'],
      inactive_account:['canonical-authority-helpers'],
      credential_misuse:['privileged-credential-custody'],
    },
  },
};

const common = {
  rpc: {
    classification:'untrusted-rpc-client',
    authority:'PostgreSQL RPC is authoritative; renderer/Edge arguments are untrusted.',
    positive:['postgres-rpc-authority'],
    negative:{
      missing_authentication:['postgres-rpc-authority'],
      wrong_tenant:['postgres-rpc-authority','canonical-authority-helpers'],
      wrong_branch:['postgres-rpc-authority','canonical-authority-helpers'],
      unauthorized_role:['postgres-rpc-authority','canonical-authority-helpers'],
      inactive_account:['canonical-authority-helpers'],
      credential_misuse:['not-applicable:rpc-client-does-not-custody-service-role'],
    },
  },
  table: {
    classification:'untrusted-table-client',
    authority:'RLS/grants are authoritative; client queries are untrusted.',
    positive:['rls-authority'],
    negative:{
      missing_authentication:['rls-authority'],
      wrong_tenant:['rls-authority','canonical-authority-helpers'],
      wrong_branch:['rls-authority','canonical-authority-helpers'],
      unauthorized_role:['rls-authority','canonical-authority-helpers'],
      inactive_account:['canonical-authority-helpers'],
      credential_misuse:['not-applicable:table-client-does-not-custody-service-role'],
    },
  },
  storage: {
    classification:'storage-client',
    authority:'Storage object policies are authoritative.',
    positive:['storage-policy-authority'],
    negative:{
      missing_authentication:['storage-policy-authority'],
      wrong_tenant:['storage-policy-authority'],
      wrong_branch:['storage-policy-authority'],
      unauthorized_role:['storage-policy-authority'],
      inactive_account:['canonical-authority-helpers'],
      credential_misuse:['not-applicable:storage-client-does-not-custody-service-role'],
    },
  },
};

export const POLICIES = {
  'ui-route': {
    classification:'ui-access-boundary',
    authority:'ProtectedRoute provides UI admission only; data authority remains server-side.',
    positive:['route-guard-contract'],
    negative:{
      missing_authentication:['route-guard-contract'],
      wrong_tenant:['canonical-authority-helpers'],
      wrong_branch:['canonical-authority-helpers'],
      unauthorized_role:['route-guard-contract'],
      inactive_account:['canonical-authority-helpers'],
      credential_misuse:['not-applicable:no-privileged-credential'],
    },
  },
  'edge': {
    classification:'edge-authority-boundary',
    authority:'Function-specific authentication, scope, role and credential declaration.',
    positive:['edge-function-specific-contract'],
    negative:Object.fromEntries(REQUIRED_NEGATIVE_DIMENSIONS.map(key => [key,['edge-function-specific-contract']])),
  },
  'privileged-secret': {
    classification:'privileged-secret-custody',
    authority:'Service-role credential remains inside the Edge/server boundary after request authorization.',
    positive:['privileged-credential-custody'],
    negative:Object.fromEntries(REQUIRED_NEGATIVE_DIMENSIONS.map(key => [key,['privileged-credential-custody']])),
  },
  'rpc-client': common.rpc,
  'table-client': common.table,
  'storage-client': common.storage,
  'scanner-false-positive': {
    classification:'scanner-false-positive',
    authority:'Lexical census match is not an authorization call and carries no authority.',
    positive:['census-classifier-contract'],
    negative:Object.fromEntries(REQUIRED_NEGATIVE_DIMENSIONS.map(key => [key,['not-applicable:not-an-authorization-surface']])),
  },
  'ipc-device': {
    classification:'native-ipc-authority',
    authority:'Trusted main-frame sender plus native-held device credential plus server authorization.',
    positive:['desktop-trust-boundary','device-credential-postgres'],
    negative:Object.fromEntries(REQUIRED_NEGATIVE_DIMENSIONS.map(key => [key,['device-credential-postgres']])),
  },
  'ipc-manager': {
    classification:'native-ipc-authority',
    authority:'Trusted main-frame sender plus fresh online manager authorization receipt.',
    positive:['desktop-manager-authority'],
    negative:Object.fromEntries(REQUIRED_NEGATIVE_DIMENSIONS.map(key => [key,['desktop-manager-authority']])),
  },
  'ipc-trusted': {
    classification:'native-ipc-authority',
    authority:'Trusted main-frame sender; this effect does not receive tenant/branch/service-role credential authority.',
    positive:['desktop-trust-boundary'],
    negative:{
      missing_authentication:['desktop-trust-boundary'],
      wrong_tenant:['not-applicable:no-tenant-bearing-effect'],
      wrong_branch:['not-applicable:no-branch-bearing-effect'],
      unauthorized_role:['not-applicable:trusted-renderer-effect'],
      inactive_account:['not-applicable:no-account-bearing-effect'],
      credential_misuse:['not-applicable:no-privileged-credential'],
    },
  },
  'preload': {
    classification:'preload-exposure',
    authority:'Preload is non-authoritative; paired main-process handler owns authorization.',
    positive:['desktop-trust-boundary'],
    negative:Object.fromEntries(REQUIRED_NEGATIVE_DIMENSIONS.map(key => [key,['paired-main-ipc-authority']])),
  },
  'export': {
    classification:'export-client',
    authority:'Server export RPC/RLS determines scope before local file download.',
    positive:['business-export-authorization'],
    negative:{
      missing_authentication:['business-export-authorization'],
      wrong_tenant:['business-export-authorization'],
      wrong_branch:['business-export-authorization'],
      unauthorized_role:['business-export-authorization'],
      inactive_account:['canonical-authority-helpers'],
      credential_misuse:['not-applicable:no-privileged-credential'],
    },
  },
  'external-navigation': {
    classification:'external-navigation',
    authority:'URL validation and trusted native sender prevent privileged navigation abuse.',
    positive:['external-navigation-contract'],
    negative:{
      missing_authentication:['external-navigation-contract'],
      wrong_tenant:['not-applicable:no-tenant-context'],
      wrong_branch:['not-applicable:no-branch-context'],
      unauthorized_role:['not-applicable:no-business-data-mutation'],
      inactive_account:['not-applicable:no-business-data-mutation'],
      credential_misuse:['not-applicable:no-privileged-credential'],
    },
  },
};

const FALSE_TABLE_IDENTIFIERS = new Set([
  'value','ciphertext','v','bytes','text','encrypted',
  'record.encryptedCredential!','record.encryptedCredential','record.ciphertext','[0x1b',
  '{ length: 8 }','{ length: 6 }','{ length: 7 }','productByName.values(',
  'new Set([...activeChannels','new Set((roles ?? []','new Set((orders ?? []','new Set(',
  'atob(base64','atob(padded','new Uint8Array(sigBuf','new Uint8Array(digest','hex.match(/.{2}/g',
]);

function isFalseTableClient(surface) {
  return surface.path.startsWith('electron/')
    || FALSE_TABLE_IDENTIFIERS.has(surface.identifier)
    || surface.identifier.startsWith('new ')
    || surface.identifier.startsWith('{ ')
    || surface.identifier.startsWith('record.')
    || surface.identifier.startsWith('atob(')
    || surface.identifier.includes('match(');
}

export function policyFor(surface) {
  if (surface.scope !== 'runtime') throw new Error('runtime classification only');
  if (surface.kind === 'application-route') return 'ui-route';
  if (surface.kind === 'edge-function') {
    if (!EDGE_FUNCTION_AUTHORITY[surface.path]) throw new Error(`Unclassified Edge Function: ${surface.path}`);
    return 'edge';
  }
  if (surface.kind === 'privileged-credential') {
    if (!EDGE_FUNCTION_AUTHORITY[surface.path]?.serviceRole) throw new Error(`Privileged credential outside declared Edge custody: ${surface.path}`);
    return 'privileged-secret';
  }
  if (surface.kind === 'rpc-client') return 'rpc-client';
  if (surface.kind === 'table-client') {
    if (isFalseTableClient(surface)) return 'scanner-false-positive';
    if (surface.identifier === 'product-images' || surface.identifier === 'return-evidence') return 'storage-client';
    return 'table-client';
  }
  if (surface.kind === 'ipc-main') {
    if (surface.identifier.includes('DEVICE_')
      || ['IPC_HANDLERS.ACTIVATE_DEVICE','IPC_HANDLERS.ROTATE_DEVICE_CREDENTIAL','IPC_HANDLERS.REVOKE_DEVICE'].includes(surface.identifier)) return 'ipc-device';
    if (['IPC_HANDLERS.SAVE_SETTINGS','IPC_HANDLERS.SET_KIOSK','IPC_HANDLERS.DOWNLOAD_UPDATE','IPC_HANDLERS.INSTALL_UPDATE'].includes(surface.identifier)
      || surface.path === 'electron/manager-authorization.ts') return 'ipc-manager';
    return 'ipc-trusted';
  }
  if (surface.kind === 'ipc-renderer') return 'preload';
  if (surface.kind === 'data-export') return 'export';
  if (surface.kind === 'external-navigation') return 'external-navigation';
  if (surface.kind === 'sql-revoke') return 'scanner-false-positive';
  throw new Error(`Unclassified runtime kind: ${surface.kind}`);
}

export function classifyRuntimeSurfaces(surfaces) {
  const runtime = surfaces.filter(surface => surface.scope === 'runtime');
  if (runtime.length !== EXPECTED_RUNTIME_OCCURRENCES) {
    throw new Error(`Expected ${EXPECTED_RUNTIME_OCCURRENCES} runtime occurrences, found ${runtime.length}; review census drift before accepting classification`);
  }
  const seen = new Map();
  return runtime.map(surface => {
    const signature = [surface.kind,surface.path,surface.identifier,surface.text].join('\0');
    const occurrence = (seen.get(signature) ?? 0) + 1;
    seen.set(signature, occurrence);
    const policy = policyFor(surface);
    return {
      kind:surface.kind,
      path:surface.path,
      identifier:surface.identifier,
      occurrence,
      policy,
      ...(surface.kind === 'edge-function' || surface.kind === 'privileged-credential'
        ? { edgeAuthority:EDGE_FUNCTION_AUTHORITY[surface.path] }
        : {}),
    };
  });
}

export function validatePolicies() {
  for (const [name, policy] of Object.entries(POLICIES)) {
    if (!policy.classification || !policy.authority || !Array.isArray(policy.positive) || policy.positive.length === 0) {
      throw new Error(`${name}: incomplete authority declaration`);
    }
    for (const dimension of REQUIRED_NEGATIVE_DIMENSIONS) {
      if (!Array.isArray(policy.negative?.[dimension]) || policy.negative[dimension].length === 0) {
        throw new Error(`${name}: missing negative evidence for ${dimension}`);
      }
    }
  }
  for (const [path, authority] of Object.entries(EDGE_FUNCTION_AUTHORITY)) {
    for (const dimension of REQUIRED_NEGATIVE_DIMENSIONS) {
      if (!Array.isArray(authority.negative?.[dimension]) || authority.negative[dimension].length === 0) {
        throw new Error(`${path}: missing Edge evidence for ${dimension}`);
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validatePolicies();
  const census = JSON.parse(readFileSync(process.argv[2] ?? 'authorization-surface-census.json','utf8'));
  const entries = classifyRuntimeSurfaces(census.surfaces ?? []);
  process.stdout.write(JSON.stringify({
    schema:1,
    status:'verified-runtime-classification',
    runtime_occurrence_count:entries.length,
    required_negative_dimensions:REQUIRED_NEGATIVE_DIMENSIONS,
    entries,
  }, null, 2));
}
