
CREATE TABLE IF NOT EXISTS refresh_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    tenant_id BIGINT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    replaced_by BIGINT REFERENCES refresh_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user_tenant
    ON refresh_sessions (user_id, tenant_id);

CREATE INDEX IF NOT EXISTS idx_refresh_sessions_expiry
    ON refresh_sessions (expires_at);
