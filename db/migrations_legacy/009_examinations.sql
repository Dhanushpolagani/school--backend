
BEGIN;

-- Add tenant-scoped unique indexes needed by the composite foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS uq_school_classes_tenant_id_id
    ON public.school_classes (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_class_sections_tenant_class_id
    ON public.class_sections (tenant_id, class_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_students_tenant_id_id
    ON public.students (tenant_id, id);


-- 1. Subjects
CREATE TABLE IF NOT EXISTS public.school_subjects (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES public.tenants(id)
        ON DELETE CASCADE,

    subject_code VARCHAR(30) NOT NULL,
    name VARCHAR(120) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT school_subjects_tenant_id_unique
        UNIQUE (tenant_id, id),

    CONSTRAINT school_subjects_tenant_code_unique
        UNIQUE (tenant_id, subject_code),

    CONSTRAINT school_subjects_tenant_name_unique
        UNIQUE (tenant_id, name)
);


-- 2. Examinations
CREATE TABLE IF NOT EXISTS public.examinations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES public.tenants(id)
        ON DELETE CASCADE,

    name VARCHAR(150) NOT NULL,
    academic_year VARCHAR(9) NOT NULL
        CHECK (academic_year ~ '^[0-9]{4}-[0-9]{4}$'),
    term VARCHAR(50),

    start_date DATE NOT NULL,
    end_date DATE NOT NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN (
            'draft',
            'scheduled',
            'completed',
            'cancelled'
        )),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT examinations_dates_check
        CHECK (end_date >= start_date),

    CONSTRAINT examinations_tenant_id_unique
        UNIQUE (tenant_id, id),

    CONSTRAINT examinations_name_year_unique
        UNIQUE (tenant_id, academic_year, name)
);


-- 3. Exam schedules: one subject scheduled for a class/section
CREATE TABLE IF NOT EXISTS public.exam_schedules (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL,

    examination_id BIGINT NOT NULL,
    subject_id BIGINT NOT NULL,
    class_id BIGINT NOT NULL,
    section_id BIGINT,

    exam_date DATE NOT NULL,
    start_time TIME NOT NULL,
    duration_minutes INTEGER NOT NULL
        CHECK (duration_minutes BETWEEN 1 AND 600),

    max_marks NUMERIC(7,2) NOT NULL
        CHECK (max_marks > 0),

    pass_marks NUMERIC(7,2) NOT NULL
        CHECK (pass_marks >= 0 AND pass_marks <= max_marks),

    status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'completed', 'cancelled')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT exam_schedules_tenant_id_unique
        UNIQUE (tenant_id, id),

    CONSTRAINT exam_schedules_exam_fk
        FOREIGN KEY (tenant_id, examination_id)
        REFERENCES public.examinations (tenant_id, id)
        ON DELETE CASCADE,

    CONSTRAINT exam_schedules_subject_fk
        FOREIGN KEY (tenant_id, subject_id)
        REFERENCES public.school_subjects (tenant_id, id),

    CONSTRAINT exam_schedules_class_fk
        FOREIGN KEY (tenant_id, class_id)
        REFERENCES public.school_classes (tenant_id, id),

    CONSTRAINT exam_schedules_section_fk
        FOREIGN KEY (tenant_id, class_id, section_id)
        REFERENCES public.class_sections (tenant_id, class_id, id)
);

-- Prevent duplicate subject schedules for the same exam/class/section.
-- COALESCE treats a class-wide schedule (NULL section) as its own scope.
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_schedule_subject_scope
    ON public.exam_schedules (
        tenant_id,
        examination_id,
        class_id,
        (COALESCE(section_id, 0)),
        subject_id
    );

CREATE INDEX IF NOT EXISTS idx_exam_schedules_tenant_date
    ON public.exam_schedules (tenant_id, exam_date);

CREATE INDEX IF NOT EXISTS idx_exam_schedules_exam_class
    ON public.exam_schedules (tenant_id, examination_id, class_id);


-- 4. Student marks
CREATE TABLE IF NOT EXISTS public.exam_marks (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL,

    exam_schedule_id BIGINT NOT NULL,
    student_id BIGINT NOT NULL,

    attendance_status VARCHAR(20) NOT NULL DEFAULT 'present'
        CHECK (attendance_status IN ('present', 'absent', 'exempt')),

    marks_obtained NUMERIC(7,2),
    remarks VARCHAR(500),
    entered_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT exam_marks_value_check
        CHECK (
            (attendance_status = 'present'
                AND marks_obtained IS NOT NULL
                AND marks_obtained >= 0)
            OR
            (attendance_status IN ('absent', 'exempt')
                AND marks_obtained IS NULL)
        ),

    CONSTRAINT exam_marks_schedule_fk
        FOREIGN KEY (tenant_id, exam_schedule_id)
        REFERENCES public.exam_schedules (tenant_id, id)
        ON DELETE CASCADE,

    CONSTRAINT exam_marks_student_fk
        FOREIGN KEY (tenant_id, student_id)
        REFERENCES public.students (tenant_id, id),

    CONSTRAINT exam_marks_student_schedule_unique
        UNIQUE (tenant_id, exam_schedule_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_exam_marks_tenant_student
    ON public.exam_marks (tenant_id, student_id);

COMMIT;
