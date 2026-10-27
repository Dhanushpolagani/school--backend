-- db/migrations/007_finance.sql

CREATE TABLE IF NOT EXISTS fee_categories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,            -- Tuition | Transport | Hostel
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fee_structures (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name             VARCHAR(200) NOT NULL,
  academic_year_id UUID REFERENCES academic_years(id),
  term_id          UUID REFERENCES terms(id),
  class_master_id  UUID REFERENCES class_masters(id),
  category_id      UUID REFERENCES fee_categories(id),
  amount           NUMERIC(12,2) NOT NULL,
  due_date         DATE,
  late_fee_per_day NUMERIC(8,2) DEFAULT 0,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID REFERENCES tenants(id),
  invoice_number VARCHAR(50) UNIQUE NOT NULL,
  student_id     UUID REFERENCES students(id),
  fee_structure_id UUID REFERENCES fee_structures(id),
  amount         NUMERIC(12,2) NOT NULL,
  discount       NUMERIC(12,2) DEFAULT 0,
  net_amount     NUMERIC(12,2) NOT NULL,
  amount_paid    NUMERIC(12,2) DEFAULT 0,
  balance        NUMERIC(12,2),
  status         VARCHAR(30) DEFAULT 'Not Paid', -- Paid In Full | Partially Paid | Not Paid
  due_date       DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID REFERENCES tenants(id),
  invoice_id      UUID REFERENCES invoices(id),
  student_id      UUID REFERENCES students(id),
  amount          NUMERIC(12,2) NOT NULL,
  payment_method  VARCHAR(30),                 -- cash | card | bank_transfer | online | cheque
  transaction_ref VARCHAR(100),
  receipt_number  VARCHAR(50),
  payment_date    DATE DEFAULT CURRENT_DATE,
  recorded_by     UUID REFERENCES users(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scholarships (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  student_id  UUID REFERENCES students(id),
  name        VARCHAR(200),
  discount_type VARCHAR(20),               -- percentage | flat
  discount_value NUMERIC(10,2),
  applied_at  DATE DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_student ON invoices(student_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
