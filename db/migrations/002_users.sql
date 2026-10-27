-- db/migrations/002_users.sql

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM (
    'super_admin', 'school_admin', 'accountant', 'hr_manager',
    'teacher', 'librarian', 'hostel_warden', 'transport_manager',
    'parent', 'student'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE,
  email           VARCHAR(200) UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            user_role NOT NULL DEFAULT 'student',
  first_name      VARCHAR(100),
  last_name       VARCHAR(100),
  phone           VARCHAR(20),
  avatar_url      TEXT,
  is_active       BOOLEAN DEFAULT TRUE,
  is_email_verified BOOLEAN DEFAULT FALSE,
  otp_code        VARCHAR(10),
  otp_expires_at  TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ,
  mfa_enabled     BOOLEAN DEFAULT FALSE,
  mfa_secret      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  user_id     UUID REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,
  module      VARCHAR(50),
  entity_type VARCHAR(50),
  entity_id   UUID,
  old_value   JSONB,
  new_value   JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
