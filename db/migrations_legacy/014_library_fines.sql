
BEGIN;

CREATE TABLE IF NOT EXISTS library_fine_payments (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    loan_id BIGINT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(30) NOT NULL
        CHECK (payment_method IN (
            'cash', 'upi', 'bank_transfer', 'card', 'cheque', 'other'
        )),
    transaction_reference VARCHAR(150),
    remarks TEXT,
    paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_by BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_library_fine_payment_loan
        FOREIGN KEY (loan_id)
        REFERENCES library_loans(id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_library_fine_payments_loan
    ON library_fine_payments (tenant_id, loan_id);

CREATE INDEX IF NOT EXISTS idx_library_fine_payments_date
    ON library_fine_payments (tenant_id, paid_at DESC);

COMMIT;
