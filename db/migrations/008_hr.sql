-- db/migrations/008_hr.sql

CREATE TABLE IF NOT EXISTS staff (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id),
  staff_id        VARCHAR(30) UNIQUE NOT NULL,    -- e.g. STF-001
  department      VARCHAR(100),
  designation     VARCHAR(100),
  qualification   VARCHAR(200),
  joining_date    DATE,
  employment_type VARCHAR(30),                    -- full_time | part_time | contract
  salary          NUMERIC(12,2),
  bank_account    VARCHAR(50),
  bank_ifsc       VARCHAR(20),
  emergency_contact TEXT,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leave_types (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  name        VARCHAR(100) NOT NULL,              -- Sick | Casual | Earned | Maternity
  max_days    INT DEFAULT 0,
  is_paid     BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID REFERENCES tenants(id),
  staff_id     UUID REFERENCES staff(id),
  leave_type_id UUID REFERENCES leave_types(id),
  from_date    DATE NOT NULL,
  to_date      DATE NOT NULL,
  days         INT,
  reason       TEXT,
  status       VARCHAR(20) DEFAULT 'pending',     -- pending | approved | rejected | cancelled
  approved_by  UUID REFERENCES users(id),
  approved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id),
  month            SMALLINT NOT NULL,
  year             SMALLINT NOT NULL,
  status           VARCHAR(20) DEFAULT 'draft',   -- draft | approved | processed | paid
  total_amount     NUMERIC(14,2),
  approved_by      UUID REFERENCES users(id),
  processed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, month, year)
);

CREATE TABLE IF NOT EXISTS payslips (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payroll_run_id UUID REFERENCES payroll_runs(id) ON DELETE CASCADE,
  staff_id       UUID REFERENCES staff(id),
  basic_salary   NUMERIC(12,2),
  hra            NUMERIC(12,2) DEFAULT 0,
  allowances     NUMERIC(12,2) DEFAULT 0,
  deductions     NUMERIC(12,2) DEFAULT 0,
  tax            NUMERIC(12,2) DEFAULT 0,
  net_salary     NUMERIC(12,2),
  status         VARCHAR(20) DEFAULT 'pending',
  paid_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_tenant ON staff(tenant_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_staff ON leave_requests(staff_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_tenant ON payroll_runs(tenant_id);
