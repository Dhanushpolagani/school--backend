
BEGIN;

CREATE TABLE IF NOT EXISTS school_calendar (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id)
        ON DELETE CASCADE,
    holiday_date DATE NOT NULL,
    holiday_name VARCHAR(150) NOT NULL,
    description VARCHAR(500),
    is_working_day BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, holiday_date)
);

CREATE INDEX IF NOT EXISTS idx_school_calendar_tenant_date
    ON school_calendar (tenant_id, holiday_date);

COMMIT;
