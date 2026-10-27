-- db/migrations/014_inventory.sql

CREATE TABLE IF NOT EXISTS inventory_categories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_suppliers (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(200) NOT NULL,
  contact_person VARCHAR(100),
  phone       VARCHAR(20),
  email       VARCHAR(150),
  address     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  category_id UUID REFERENCES inventory_categories(id) ON DELETE SET NULL,
  name        VARCHAR(200) NOT NULL,
  sku         VARCHAR(50),
  unit        VARCHAR(20) DEFAULT 'pieces',
  unit_price  NUMERIC(10,2) DEFAULT 0,
  quantity    INT DEFAULT 0,
  min_quantity INT DEFAULT 5,
  location    VARCHAR(100),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_stock_movements (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  item_id     UUID REFERENCES inventory_items(id) ON DELETE CASCADE,
  type        VARCHAR(20) NOT NULL,   -- stock_in | stock_out | adjustment
  quantity    INT NOT NULL,
  unit_price  NUMERIC(10,2),
  reference   VARCHAR(100),
  notes       TEXT,
  recorded_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  po_number   VARCHAR(50) UNIQUE NOT NULL,
  supplier_id UUID REFERENCES inventory_suppliers(id),
  status      VARCHAR(30) DEFAULT 'draft', -- draft | approved | received | cancelled
  total_amount NUMERIC(12,2) DEFAULT 0,
  created_by  UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  expected_date DATE,
  received_date DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_id       UUID REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id     UUID REFERENCES inventory_items(id),
  quantity    INT NOT NULL,
  unit_price  NUMERIC(10,2) NOT NULL,
  total_price NUMERIC(12,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_tenant ON inventory_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_stock_movements_item ON inventory_stock_movements(item_id);
