
BEGIN;

-- Daily hostel attendance linked to the student's allocation.
CREATE TABLE IF NOT EXISTS hostel_attendance (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    allocation_id BIGINT NOT NULL,

    attendance_date DATE NOT NULL DEFAULT CURRENT_DATE,

    session VARCHAR(10) NOT NULL DEFAULT 'night'
        CHECK (session IN ('morning', 'evening', 'night')),

    status VARCHAR(20) NOT NULL
        CHECK (
            status IN (
                'present',
                'absent',
                'on_leave',
                'outing',
                'late'
            )
        ),

    remarks TEXT,

    marked_by BIGINT REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_hostel_attendance_session
        UNIQUE (
            tenant_id,
            allocation_id,
            attendance_date,
            session
        ),

    CONSTRAINT fk_hostel_attendance_allocation
        FOREIGN KEY (tenant_id, allocation_id)
        REFERENCES hostel_allocations (tenant_id, id)
        ON DELETE RESTRICT
);

-- Retrieve attendance by hostel allocation and date.
CREATE INDEX IF NOT EXISTS idx_hostel_attendance_date
ON hostel_attendance (
    tenant_id,
    attendance_date,
    session
);

CREATE INDEX IF NOT EXISTS idx_hostel_attendance_allocation
ON hostel_attendance (
    tenant_id,
    allocation_id,
    attendance_date DESC
);

COMMIT;
