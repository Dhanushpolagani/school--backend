-- db/migrations/012_communication.sql

CREATE TABLE IF NOT EXISTS notices (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID REFERENCES tenants(id) ON DELETE CASCADE,
  title         VARCHAR(300) NOT NULL,
  content       TEXT NOT NULL,
  target_roles  user_role[],               -- who can see: teacher | parent | student
  published_by  UUID REFERENCES users(id),
  publish_date  DATE DEFAULT CURRENT_DATE,
  expiry_date   DATE,
  is_pinned     BOOLEAN DEFAULT FALSE,
  attachment_url TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  sender_id   UUID REFERENCES users(id),
  recipient_id UUID REFERENCES users(id),
  subject     VARCHAR(300),
  body        TEXT NOT NULL,
  is_read     BOOLEAN DEFAULT FALSE,
  parent_msg_id UUID REFERENCES messages(id),   -- thread support
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  user_id     UUID REFERENCES users(id),
  title       VARCHAR(200),
  body        TEXT,
  type        VARCHAR(30),               -- fee | attendance | exam | system
  is_read     BOOLEAN DEFAULT FALSE,
  action_url  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sms_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  phone       VARCHAR(20),
  message     TEXT,
  status      VARCHAR(20),               -- sent | failed | delivered
  provider_ref VARCHAR(100),
  sent_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notices_tenant ON notices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
