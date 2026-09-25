import { localClient } from '../../backend/local-client';

export type { LocalSession, LocalUser } from '../../backend/session';

// Callers keep this import path. The object no longer reaches a hosted Supabase project.
export const supabase = localClient;
