
BEGIN;

CREATE TABLE IF NOT EXISTS transport_vehicles (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    vehicle_number VARCHAR(30) NOT NULL,
    vehicle_type VARCHAR(50) NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    driver_name VARCHAR(150),
    driver_phone VARCHAR(20),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'maintenance')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, vehicle_number)
);

CREATE TABLE IF NOT EXISTS transport_routes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    route_name VARCHAR(150) NOT NULL,
    start_location VARCHAR(255) NOT NULL,
    end_location VARCHAR(255) NOT NULL,
    vehicle_id BIGINT REFERENCES transport_vehicles(id),
    monthly_fee NUMERIC(10, 2) NOT NULL DEFAULT 0
        CHECK (monthly_fee >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, route_name)
);

CREATE TABLE IF NOT EXISTS transport_stops (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    route_id BIGINT NOT NULL REFERENCES transport_routes(id)
        ON DELETE CASCADE,
    stop_name VARCHAR(150) NOT NULL,
    stop_order INTEGER NOT NULL CHECK (stop_order > 0),
    pickup_time TIME,
    dropoff_time TIME,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (route_id, stop_order)
);

CREATE TABLE IF NOT EXISTS student_transport_assignments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    student_id BIGINT NOT NULL REFERENCES students(id),
    route_id BIGINT NOT NULL REFERENCES transport_routes(id),
    stop_id BIGINT REFERENCES transport_stops(id),
    start_date DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_transport_vehicles_tenant
    ON transport_vehicles(tenant_id);

CREATE INDEX IF NOT EXISTS idx_transport_routes_tenant
    ON transport_routes(tenant_id);

CREATE INDEX IF NOT EXISTS idx_transport_stops_tenant_route
    ON transport_stops(tenant_id, route_id);

CREATE INDEX IF NOT EXISTS idx_student_transport_tenant_student
    ON student_transport_assignments(tenant_id, student_id);

COMMIT;
