-- db/migrations/016_certificates.sql

CREATE TABLE IF NOT EXISTS certificate_templates (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name            VARCHAR(200) NOT NULL,
  certificate_type VARCHAR(50) NOT NULL,
  description     TEXT,
  template_content TEXT NOT NULL,
  placeholders    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS student_certificates (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID REFERENCES tenants(id) ON DELETE CASCADE,
  student_id        UUID REFERENCES students(id) ON DELETE CASCADE,
  template_id       UUID REFERENCES certificate_templates(id),
  certificate_type  VARCHAR(50) NOT NULL,
  certificate_number VARCHAR(100) NOT NULL,
  issue_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  academic_year     VARCHAR(50),
  file_storage_key  VARCHAR(500) NOT NULL,
  file_name         VARCHAR(255) NOT NULL,
  generation_status VARCHAR(30) NOT NULL DEFAULT 'completed',
  generated_by      UUID REFERENCES users(id),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, certificate_number)
);

CREATE INDEX IF NOT EXISTS idx_certificate_templates_tenant ON certificate_templates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_student_certificates_student ON student_certificates(student_id);
