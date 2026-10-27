
BEGIN;

CREATE TABLE IF NOT EXISTS staff_leave_balances (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    tenant_id BIGINT NOT NULL,
    staff_id BIGINT NOT NULL,
    leave_year INTEGER NOT NULL,
    leave_type VARCHAR(30) NOT NULL
        CHECK (leave_type IN ('casual', 'sick', 'earned')),

    allocated_days NUMERIC(6,2) NOT NULL DEFAULT 0
        CHECK (allocated_days >= 0),

    used_days NUMERIC(6,2) NOT NULL DEFAULT 0
        CHECK (used_days >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT staff_leave_balance_staff_fk
        FOREIGN KEY (tenant_id, staff_id)
        REFERENCES staff (tenant_id, id)
        ON DELETE CASCADE,

    CONSTRAINT staff_leave_balance_unique
        UNIQUE (tenant_id, staff_id, leave_year, leave_type),

    CONSTRAINT staff_leave_balance_year_check
        CHECK (leave_year BETWEEN 2000 AND 2200),

    CONSTRAINT staff_leave_balance_used_check
        CHECK (used_days <= allocated_days)
);

CREATE INDEX IF NOT EXISTS idx_staff_leave_balance_staff_year
    ON staff_leave_balances (tenant_id, staff_id, leave_year);

COMMIT;
