
BEGIN;

-- Ensure students can be referenced together with their tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_tenant_id
ON students (tenant_id, id);

-- 1. Hostels / hostel buildings
CREATE TABLE IF NOT EXISTS hostels (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    name VARCHAR(120) NOT NULL,
    hostel_type VARCHAR(20) NOT NULL
        CHECK (hostel_type IN ('boys', 'girls', 'coed')),
    address TEXT,
    warden_name VARCHAR(120),
    warden_phone VARCHAR(30),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_hostels_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uq_hostels_tenant_name UNIQUE (tenant_id, name)
);

-- 2. Rooms inside each hostel
CREATE TABLE IF NOT EXISTS hostel_rooms (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    hostel_id BIGINT NOT NULL,
    room_number VARCHAR(30) NOT NULL,
    floor_number INTEGER NOT NULL DEFAULT 0,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    monthly_fee NUMERIC(10, 2) NOT NULL DEFAULT 0
        CHECK (monthly_fee >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'maintenance', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_hostel_rooms_location
        UNIQUE (tenant_id, hostel_id, room_number),

    CONSTRAINT uq_hostel_rooms_tenant_hostel_id
        UNIQUE (tenant_id, hostel_id, id),

    CONSTRAINT fk_hostel_rooms_hostel
        FOREIGN KEY (tenant_id, hostel_id)
        REFERENCES hostels (tenant_id, id)
        ON DELETE RESTRICT
);

-- 3. Student room allocations and checkout history
CREATE TABLE IF NOT EXISTS hostel_allocations (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    hostel_id BIGINT NOT NULL,
    room_id BIGINT NOT NULL,
    student_id BIGINT NOT NULL,
    bed_number INTEGER NOT NULL CHECK (bed_number > 0),
    allocated_on DATE NOT NULL DEFAULT CURRENT_DATE,
    vacated_on DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'vacated', 'cancelled')),
    monthly_fee NUMERIC(10, 2) NOT NULL DEFAULT 0
        CHECK (monthly_fee >= 0),
    remarks TEXT,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_hostel_allocations_room
        FOREIGN KEY (tenant_id, hostel_id, room_id)
        REFERENCES hostel_rooms (tenant_id, hostel_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_hostel_allocations_student
        FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_hostel_vacated_date
        CHECK (vacated_on IS NULL OR vacated_on >= allocated_on),

    CONSTRAINT chk_hostel_vacated_status
        CHECK (status <> 'vacated' OR vacated_on IS NOT NULL)
);

-- A student can have only one active hostel allocation per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hostel_active_student
ON hostel_allocations (tenant_id, student_id)
WHERE status = 'active';

-- Prevent two students from occupying the same bed simultaneously.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hostel_active_bed
ON hostel_allocations (tenant_id, room_id, bed_number)
WHERE status = 'active';

-- Useful indexes for common API queries.
CREATE INDEX IF NOT EXISTS idx_hostels_tenant_status
ON hostels (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_hostel_rooms_hostel
ON hostel_rooms (tenant_id, hostel_id);

CREATE INDEX IF NOT EXISTS idx_hostel_allocations_room_status
ON hostel_allocations (tenant_id, room_id, status);

CREATE INDEX IF NOT EXISTS idx_hostel_allocations_student
ON hostel_allocations (tenant_id, student_id);

COMMIT;
