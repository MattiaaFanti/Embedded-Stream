-- Firefox browser-key sign-in. Existing WebAuthn passkeys stay valid.
-- Private keys never leave IndexedDB; D1 stores public JWK only.
CREATE TABLE IF NOT EXISTS browser_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key_jwk TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_browser_credentials_user
  ON browser_credentials(user_id);
