-- db/migrations/015_lms.sql

CREATE TABLE IF NOT EXISTS lms_courses (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  title            VARCHAR(200) NOT NULL,
  course_code      VARCHAR(50),
  description      TEXT,
  subject_id       UUID REFERENCES subjects(id),
  class_master_id  UUID REFERENCES class_masters(id),
  teacher_id       UUID REFERENCES users(id),
  status           VARCHAR(20) DEFAULT 'published', -- draft | published | archived
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lms_lessons (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  course_id   UUID REFERENCES lms_courses(id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,
  content     TEXT,
  lesson_order INT DEFAULT 1,
  duration_mins INT DEFAULT 45,
  video_url   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lms_materials (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  course_id   UUID REFERENCES lms_courses(id) ON DELETE CASCADE,
  lesson_id   UUID REFERENCES lms_lessons(id) ON DELETE SET NULL,
  title       VARCHAR(200) NOT NULL,
  file_url    TEXT NOT NULL,
  file_type   VARCHAR(50),
  file_size   BIGINT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lms_live_classes (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  course_id        UUID REFERENCES lms_courses(id) ON DELETE CASCADE,
  title            VARCHAR(200) NOT NULL,
  meeting_url      TEXT,
  meeting_id       VARCHAR(100),
  passcode         VARCHAR(50),
  teacher_id       UUID REFERENCES users(id),
  scheduled_start  TIMESTAMPTZ NOT NULL,
  scheduled_end    TIMESTAMPTZ,
  status           VARCHAR(20) DEFAULT 'scheduled', -- scheduled | live | completed | cancelled
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lms_assessments (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  course_id        UUID REFERENCES lms_courses(id) ON DELETE CASCADE,
  title            VARCHAR(200) NOT NULL,
  description      TEXT,
  teacher_id       UUID REFERENCES users(id),
  total_marks      NUMERIC(6,2) DEFAULT 100,
  passing_marks    NUMERIC(6,2) DEFAULT 40,
  due_date         TIMESTAMPTZ,
  time_limit_mins  INT DEFAULT 60,
  questions        JSONB DEFAULT '[]'::jsonb,
  status           VARCHAR(20) DEFAULT 'published',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lms_assessment_submissions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  assessment_id    UUID REFERENCES lms_assessments(id) ON DELETE CASCADE,
  student_id       UUID REFERENCES students(id),
  answers          JSONB DEFAULT '{}'::jsonb,
  marks_obtained   NUMERIC(6,2),
  feedback         TEXT,
  status           VARCHAR(20) DEFAULT 'submitted', -- submitted | graded | late
  submitted_at     TIMESTAMPTZ DEFAULT NOW(),
  graded_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lms_courses_tenant ON lms_courses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lms_lessons_course ON lms_lessons(course_id);
CREATE INDEX IF NOT EXISTS idx_lms_live_classes_start ON lms_live_classes(scheduled_start);
