export interface LocalUser {
  id: string;
  email?: string | null;
  aud?: string;
  role?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
}

export interface LocalSession {
  access_token: string;
  user: LocalUser;
  expires_at?: string;
}
