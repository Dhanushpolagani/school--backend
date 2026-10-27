
BEGIN;

CREATE TABLE IF NOT EXISTS student_attendance (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    tenant_id BIGINT NOT NULL
        REFERENCES tenants(id) ON DELETE CASCADE,

    student_id BIGINT NOT NULL
        REFERENCES students(id) ON DELETE CASCADE,

    attendance_date DATE NOT NULL,

    status VARCHAR(20) NOT NULL
        CHECK (status IN ('present', 'absent', 'late', 'excused')),

    remarks VARCHAR(500),

    marked_by BIGINT
        REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_student_attendance_day
        UNIQUE (tenant_id, student_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_student_attendance_tenant_date
    ON student_attendance (tenant_id, attendance_date);

CREATE INDEX IF NOT EXISTS idx_student_attendance_student_date
    ON student_attendance (tenant_id, student_id, attendance_date);

COMMIT;
