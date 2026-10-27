
BEGIN;

CREATE TABLE IF NOT EXISTS staff (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),

    employee_number VARCHAR(50) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(30),

    department VARCHAR(100),
    designation VARCHAR(100),
    employment_type VARCHAR(30) NOT NULL DEFAULT 'full_time'
        CHECK (employment_type IN (
            'full_time',
            'part_time',
            'contract',
            'temporary'
        )),

    joining_date DATE NOT NULL,
    salary_paise BIGINT NOT NULL DEFAULT 0
        CHECK (salary_paise >= 0),

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN (
            'active',
            'inactive',
            'on_leave',
            'terminated'
        )),

    address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT staff_tenant_employee_unique
        UNIQUE (tenant_id, employee_number),

    CONSTRAINT staff_tenant_id_id_unique
        UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_staff_tenant_status
    ON staff (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_staff_tenant_name
    ON staff (tenant_id, last_name, first_name);

COMMIT;
