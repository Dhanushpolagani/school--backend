-- db/migrations/011_hostel.sql

CREATE TABLE IF NOT EXISTS hostel_blocks (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,           -- Block A | Block B
  gender      VARCHAR(10),                     -- boys | girls | mixed
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hostel_rooms (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  block_id    UUID REFERENCES hostel_blocks(id) ON DELETE CASCADE,
  room_number VARCHAR(20) NOT NULL,
  capacity    INT DEFAULT 2,
  room_type   VARCHAR(30),                     -- single | double | dormitory
  status      VARCHAR(20) DEFAULT 'available', -- available | occupied | maintenance | reserved
  floor       INT DEFAULT 0,
  monthly_fee NUMERIC(10,2)
);

CREATE TABLE IF NOT EXISTS hostel_allocations (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  student_id  UUID REFERENCES students(id),
  room_id     UUID REFERENCES hostel_rooms(id),
  check_in    DATE,
  check_out   DATE,
  academic_year_id UUID REFERENCES academic_years(id),
  status      VARCHAR(20) DEFAULT 'active',
  UNIQUE(student_id, academic_year_id)
);

CREATE TABLE IF NOT EXISTS hostel_incidents (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID REFERENCES tenants(id),
  block_id     UUID REFERENCES hostel_blocks(id),
  room_id      UUID REFERENCES hostel_rooms(id),
  reported_by  UUID REFERENCES users(id),
  incident_type VARCHAR(50),
  description  TEXT NOT NULL,
  severity     VARCHAR(20) DEFAULT 'medium',   -- low | medium | high | critical
  status       VARCHAR(20) DEFAULT 'open',     -- open | in_progress | resolved
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hostel_visitors (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  student_id  UUID REFERENCES students(id),
  visitor_name VARCHAR(200),
  relation    VARCHAR(50),
  phone       VARCHAR(20),
  visit_date  DATE DEFAULT CURRENT_DATE,
  check_in    TIMESTAMPTZ,
  check_out   TIMESTAMPTZ,
  purpose     TEXT
);

CREATE INDEX IF NOT EXISTS idx_hostel_rooms_block ON hostel_rooms(block_id);
CREATE INDEX IF NOT EXISTS idx_hostel_allocations_student ON hostel_allocations(student_id);
