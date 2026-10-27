-- db/migrations/009_transport.sql

CREATE TABLE IF NOT EXISTS vehicles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_number  VARCHAR(30) NOT NULL,
  vehicle_type    VARCHAR(30) DEFAULT 'bus',
  capacity        INT,
  driver_id       UUID REFERENCES users(id),
  model           VARCHAR(100),
  make_year       SMALLINT,
  insurance_expiry DATE,
  fitness_expiry  DATE,
  gps_device_id   VARCHAR(100),
  status          VARCHAR(20) DEFAULT 'active',   -- active | maintenance | inactive
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS routes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  route_name  VARCHAR(100) NOT NULL,
  vehicle_id  UUID REFERENCES vehicles(id),
  start_point VARCHAR(200),
  end_point   VARCHAR(200),
  distance_km NUMERIC(8,2),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS route_stops (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  route_id    UUID REFERENCES routes(id) ON DELETE CASCADE,
  stop_name   VARCHAR(200) NOT NULL,
  stop_order  INT,
  pickup_time TIME,
  drop_time   TIME,
  latitude    NUMERIC(10,7),
  longitude   NUMERIC(10,7)
);

CREATE TABLE IF NOT EXISTS student_transport (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  student_id  UUID REFERENCES students(id),
  route_id    UUID REFERENCES routes(id),
  stop_id     UUID REFERENCES route_stops(id),
  academic_year_id UUID REFERENCES academic_years(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, academic_year_id)
);

CREATE TABLE IF NOT EXISTS vehicle_trips (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  vehicle_id  UUID REFERENCES vehicles(id),
  route_id    UUID REFERENCES routes(id),
  trip_date   DATE DEFAULT CURRENT_DATE,
  trip_type   VARCHAR(20),               -- morning | afternoon
  departure_at TIMESTAMPTZ,
  arrival_at  TIMESTAMPTZ,
  status      VARCHAR(20) DEFAULT 'scheduled',  -- scheduled | in_progress | completed | delayed
  delay_mins  INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS maintenance_alerts (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  vehicle_id  UUID REFERENCES vehicles(id),
  alert_type  VARCHAR(50),
  description TEXT,
  due_date    DATE,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routes_tenant ON routes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_trips_date ON vehicle_trips(trip_date);
