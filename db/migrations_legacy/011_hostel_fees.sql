
BEGIN;

-- Allow fee invoices to reference an allocation within its tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hostel_allocations_tenant_id
ON hostel_allocations (tenant_id, id);

-- 1. Monthly hostel fee invoices
CREATE TABLE IF NOT EXISTS hostel_fee_invoices (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    allocation_id BIGINT NOT NULL,
    billing_month DATE NOT NULL
        CHECK (EXTRACT(DAY FROM billing_month) = 1),
    amount_due NUMERIC(10, 2) NOT NULL
        CHECK (amount_due > 0),
    due_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'unpaid'
        CHECK (status IN ('unpaid', 'partially_paid', 'paid', 'waived')),
    remarks TEXT,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_hostel_fee_invoice_month
        UNIQUE (tenant_id, allocation_id, billing_month),

    CONSTRAINT uq_hostel_fee_invoice_tenant_id
        UNIQUE (tenant_id, id),

    CONSTRAINT fk_hostel_fee_invoice_allocation
        FOREIGN KEY (tenant_id, allocation_id)
        REFERENCES hostel_allocations (tenant_id, id)
        ON DELETE RESTRICT
);

-- 2. Payments against invoices; supports partial payments.
CREATE TABLE IF NOT EXISTS hostel_fee_payments (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    invoice_id BIGINT NOT NULL,
    amount_paid NUMERIC(10, 2) NOT NULL
        CHECK (amount_paid > 0),
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    payment_method VARCHAR(20) NOT NULL
        CHECK (
            payment_method IN (
                'cash', 'upi', 'bank_transfer',
                'card', 'cheque', 'other'
            )
        ),
    transaction_reference VARCHAR(120),
    remarks TEXT,
    received_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_hostel_fee_payment_invoice
        FOREIGN KEY (tenant_id, invoice_id)
        REFERENCES hostel_fee_invoices (tenant_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_hostel_fee_invoices_status
ON hostel_fee_invoices (tenant_id, status, due_date);

CREATE INDEX IF NOT EXISTS idx_hostel_fee_invoices_allocation
ON hostel_fee_invoices (tenant_id, allocation_id, billing_month);

CREATE INDEX IF NOT EXISTS idx_hostel_fee_payments_invoice
ON hostel_fee_payments (tenant_id, invoice_id, payment_date);

COMMIT;
