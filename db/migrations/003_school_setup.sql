-- db/migrations/003_school_setup.sql

CREATE TABLE IF NOT EXISTS academic_years (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,             -- e.g. '2026-27'
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  is_current  BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS terms (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  academic_year_id UUID REFERENCES academic_years(id) ON DELETE CASCADE,
  name             VARCHAR(100) NOT NULL,       -- e.g. 'Term 1'
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS class_masters (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(50) NOT NULL,             -- e.g. 'Grade 10'
  grade_level INT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sections (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE,
  class_master_id UUID REFERENCES class_masters(id) ON DELETE CASCADE,
  name            VARCHAR(10) NOT NULL,          -- e.g. 'A', 'B'
  capacity        INT DEFAULT 40,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS class_year_offerings (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  class_master_id  UUID REFERENCES class_masters(id),
  section_id       UUID REFERENCES sections(id),
  academic_year_id UUID REFERENCES academic_years(id),
  teacher_id       UUID REFERENCES users(id),    -- class teacher
  room_number      VARCHAR(20),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, section_id, academic_year_id)
);

CREATE TABLE IF NOT EXISTS subjects (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE,
  class_master_id UUID REFERENCES class_masters(id),
  name            VARCHAR(100) NOT NULL,
  code            VARCHAR(20),
  is_elective     BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_academic_years_tenant ON academic_years(tenant_id);
CREATE INDEX IF NOT EXISTS idx_terms_year ON terms(academic_year_id);
CREATE INDEX IF NOT EXISTS idx_sections_class ON sections(class_master_id);
