-- db/migrations/004_students.sql

DO $$ BEGIN
  CREATE TYPE student_status AS ENUM ('active', 'transferred', 'graduated', 'withdrawn');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS students (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID REFERENCES tenants(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id),            -- linked login account
  student_id        VARCHAR(30) UNIQUE NOT NULL,           -- e.g. STU-2026-0001
  admission_number  VARCHAR(50),
  national_id       VARCHAR(50),
  first_name        VARCHAR(100) NOT NULL,
  last_name         VARCHAR(100) NOT NULL,
  date_of_birth     DATE,
  gender            VARCHAR(10),
  blood_group       VARCHAR(5),
  avatar_url        TEXT,
  address           TEXT,
  city              VARCHAR(100),
  state             VARCHAR(100),
  country           VARCHAR(100),
  pin_code          VARCHAR(20),
  status            student_status DEFAULT 'active',
  admission_date    DATE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS student_enrollments (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id),
  student_id       UUID REFERENCES students(id) ON DELETE CASCADE,
  class_offering_id UUID REFERENCES class_year_offerings(id),
  academic_year_id UUID REFERENCES academic_years(id),
  roll_number      VARCHAR(20),
  enrolled_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, academic_year_id)
);

CREATE TABLE IF NOT EXISTS parents (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id),
  first_name  VARCHAR(100) NOT NULL,
  last_name   VARCHAR(100) NOT NULL,
  relation    VARCHAR(30),                 -- Father | Mother | Guardian
  email       VARCHAR(200),
  phone       VARCHAR(20),
  occupation  VARCHAR(100),
  address     TEXT,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS student_parents (
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  parent_id  UUID REFERENCES parents(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (student_id, parent_id)
);

CREATE INDEX IF NOT EXISTS idx_students_tenant ON students(tenant_id);
CREATE INDEX IF NOT EXISTS idx_students_status ON students(status);
CREATE INDEX IF NOT EXISTS idx_student_enrollments_year ON student_enrollments(academic_year_id);
