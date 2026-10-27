
BEGIN;

CREATE TABLE IF NOT EXISTS staff_leave_requests (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    staff_id BIGINT NOT NULL,

    leave_type VARCHAR(30) NOT NULL
        CHECK (leave_type IN (
            'casual',
            'sick',
            'earned',
            'unpaid',
            'other'
        )),

    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason TEXT NOT NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending',
            'approved',
            'rejected',
            'cancelled'
        )),

    reviewed_by BIGINT,
    reviewed_at TIMESTAMPTZ,
    review_comment TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT staff_leave_dates_check
        CHECK (end_date >= start_date),

    CONSTRAINT staff_leave_reason_check
        CHECK (length(trim(reason)) > 0),

    CONSTRAINT staff_leave_tenant_request_unique
        UNIQUE (tenant_id, id),

    CONSTRAINT staff_leave_staff_fk
        FOREIGN KEY (tenant_id, staff_id)
        REFERENCES staff (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_staff_leave_tenant_status
    ON staff_leave_requests (tenant_id, status, start_date);

CREATE INDEX IF NOT EXISTS idx_staff_leave_staff_dates
    ON staff_leave_requests (tenant_id, staff_id, start_date, end_date);

COMMIT;
