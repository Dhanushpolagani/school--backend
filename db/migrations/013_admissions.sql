-- db/migrations/013_admissions.sql

DO $$ BEGIN
  CREATE TYPE admission_status AS ENUM (
    'inquiry', 'applied', 'shortlisted', 'interview_scheduled',
    'accepted', 'enrolled', 'rejected', 'waitlisted'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS admissions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  applicant_name   VARCHAR(200) NOT NULL,
  date_of_birth    DATE,
  gender           VARCHAR(10),
  applying_for_class UUID REFERENCES class_masters(id),
  academic_year_id UUID REFERENCES academic_years(id),
  parent_name      VARCHAR(200),
  parent_phone     VARCHAR(20),
  parent_email     VARCHAR(200),
  previous_school  VARCHAR(300),
  address          TEXT,
  status           admission_status DEFAULT 'inquiry',
  application_date DATE DEFAULT CURRENT_DATE,
  interview_date   DATE,
  notes            TEXT,
  assigned_to      UUID REFERENCES users(id),
  converted_to     UUID REFERENCES students(id),   -- on enrollment
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admissions_tenant ON admissions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_admissions_status ON admissions(status);
