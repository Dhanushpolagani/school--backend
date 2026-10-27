
BEGIN;

-- Per-school borrowing policy
CREATE TABLE IF NOT EXISTS library_settings (
    tenant_id BIGINT PRIMARY KEY,
    max_active_loans INTEGER NOT NULL DEFAULT 3
        CHECK (max_active_loans BETWEEN 1 AND 100),
    max_renewals INTEGER NOT NULL DEFAULT 2
        CHECK (max_renewals BETWEEN 0 AND 20),
    loan_period_days INTEGER NOT NULL DEFAULT 14
        CHECK (loan_period_days BETWEEN 1 AND 365),
    reservation_hold_days INTEGER NOT NULL DEFAULT 2
        CHECK (reservation_hold_days BETWEEN 1 AND 30),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reservation queue for a book title
CREATE TABLE IF NOT EXISTS library_reservations (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    book_id BIGINT NOT NULL REFERENCES library_books(id)
        ON DELETE RESTRICT,
    student_id BIGINT NOT NULL REFERENCES students(id)
        ON DELETE RESTRICT,

    status VARCHAR(20) NOT NULL DEFAULT 'queued'
        CHECK (status IN (
            'queued', 'ready', 'fulfilled', 'cancelled', 'expired'
        )),

    reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ready_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    fulfilled_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active reservation per student per title
CREATE UNIQUE INDEX IF NOT EXISTS
    uq_library_active_student_reservation
ON library_reservations (tenant_id, book_id, student_id)
WHERE status IN ('queued', 'ready');

CREATE INDEX IF NOT EXISTS
    idx_library_reservation_queue
ON library_reservations (tenant_id, book_id, reserved_at, id)
WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS
    idx_library_reservation_student
ON library_reservations (tenant_id, student_id, reserved_at DESC);

-- Renewal count for each loan
ALTER TABLE library_loans
    ADD COLUMN IF NOT EXISTS renewal_count INTEGER NOT NULL DEFAULT 0
    CHECK (renewal_count >= 0);

COMMIT;
