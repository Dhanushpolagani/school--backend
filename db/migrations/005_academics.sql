-- db/migrations/005_academics.sql

CREATE TABLE IF NOT EXISTS timetable_slots (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  class_offering_id UUID REFERENCES class_year_offerings(id),
  subject_id       UUID REFERENCES subjects(id),
  teacher_id       UUID REFERENCES users(id),
  day_of_week      SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_time       TIME NOT NULL,
  end_time         TIME NOT NULL,
  room_number      VARCHAR(20),
  academic_year_id UUID REFERENCES academic_years(id),
  term_id          UUID REFERENCES terms(id),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assignments (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  title            VARCHAR(200) NOT NULL,
  description      TEXT,
  subject_id       UUID REFERENCES subjects(id),
  class_offering_id UUID REFERENCES class_year_offerings(id),
  teacher_id       UUID REFERENCES users(id),
  due_date         DATE,
  max_marks        NUMERIC(6,2),
  attachment_url   TEXT,
  status           VARCHAR(20) DEFAULT 'active',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assignment_submissions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  assignment_id UUID REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    UUID REFERENCES students(id),
  submitted_at  TIMESTAMPTZ,
  file_url      TEXT,
  marks_obtained NUMERIC(6,2),
  feedback      TEXT,
  status        VARCHAR(20) DEFAULT 'pending'   -- pending | submitted | graded | late
);

CREATE TABLE IF NOT EXISTS exams (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name             VARCHAR(200) NOT NULL,
  exam_type        VARCHAR(50),                -- mid-term | final | unit-test
  academic_year_id UUID REFERENCES academic_years(id),
  term_id          UUID REFERENCES terms(id),
  start_date       DATE,
  end_date         DATE,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exam_schedules (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exam_id     UUID REFERENCES exams(id) ON DELETE CASCADE,
  subject_id  UUID REFERENCES subjects(id),
  class_offering_id UUID REFERENCES class_year_offerings(id),
  exam_date   DATE NOT NULL,
  start_time  TIME,
  end_time    TIME,
  room_number VARCHAR(20),
  max_marks   NUMERIC(6,2),
  pass_marks  NUMERIC(6,2)
);

CREATE TABLE IF NOT EXISTS exam_results (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exam_schedule_id UUID REFERENCES exam_schedules(id),
  student_id       UUID REFERENCES students(id),
  marks_obtained   NUMERIC(6,2),
  grade            VARCHAR(5),
  remarks          TEXT,
  is_absent        BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(exam_schedule_id, student_id)
);

CREATE TABLE IF NOT EXISTS learning_outcomes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  subject_id  UUID REFERENCES subjects(id),
  description TEXT NOT NULL,
  bloom_level VARCHAR(30),               -- Remember | Understand | Apply | ...
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS electives (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id),
  subject_id       UUID REFERENCES subjects(id),
  academic_year_id UUID REFERENCES academic_years(id),
  max_students     INT DEFAULT 30,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_timetable_class ON timetable_slots(class_offering_id);
CREATE INDEX IF NOT EXISTS idx_assignments_teacher ON assignments(teacher_id);
CREATE INDEX IF NOT EXISTS idx_exam_results_student ON exam_results(student_id);
