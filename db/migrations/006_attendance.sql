-- db/migrations/006_attendance.sql

DO $$ BEGIN
  CREATE TYPE attendance_status AS ENUM ('present', 'absent', 'late', 'excused');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS student_attendance (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  student_id       UUID REFERENCES students(id),
  class_offering_id UUID REFERENCES class_year_offerings(id),
  date             DATE NOT NULL,
  status           attendance_status DEFAULT 'present',
  marked_by        UUID REFERENCES users(id),
  remarks          TEXT,
  subject_id       UUID REFERENCES subjects(id),   -- for period-wise
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, date, subject_id)
);

CREATE TABLE IF NOT EXISTS staff_attendance (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  staff_id    UUID REFERENCES users(id),
  date        DATE NOT NULL,
  check_in    TIMESTAMPTZ,
  check_out   TIMESTAMPTZ,
  status      attendance_status DEFAULT 'present',
  biometric_id VARCHAR(50),
  remarks     TEXT,
  UNIQUE(staff_id, date)
);

CREATE INDEX IF NOT EXISTS idx_student_attendance_date ON student_attendance(date);
CREATE INDEX IF NOT EXISTS idx_student_attendance_student ON student_attendance(student_id);
CREATE INDEX IF NOT EXISTS idx_staff_attendance_date ON staff_attendance(date);
