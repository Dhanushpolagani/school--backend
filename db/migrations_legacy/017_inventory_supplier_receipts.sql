
BEGIN;

ALTER TABLE inventory_stock_movements
ADD COLUMN IF NOT EXISTS supplier_id BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_inventory_movements_supplier'
    ) THEN
        ALTER TABLE inventory_stock_movements
        ADD CONSTRAINT fk_inventory_movements_supplier
        FOREIGN KEY (tenant_id, supplier_id)
        REFERENCES inventory_suppliers (tenant_id, id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_movements_supplier
ON inventory_stock_movements (tenant_id, supplier_id, created_at DESC);

COMMIT;
