
BEGIN;

-- 1. Book catalog
CREATE TABLE IF NOT EXISTS library_books (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,

    title VARCHAR(255) NOT NULL,
    author VARCHAR(255),
    isbn VARCHAR(20),
    category VARCHAR(100),
    publisher VARCHAR(255),
    publication_year INTEGER,
    edition VARCHAR(100),
    language VARCHAR(100) DEFAULT 'English',
    description TEXT,

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        publication_year IS NULL
        OR publication_year BETWEEN 1000 AND 2200
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS
    uq_library_books_tenant_isbn
ON library_books (tenant_id, isbn)
WHERE isbn IS NOT NULL;

CREATE INDEX IF NOT EXISTS
    idx_library_books_tenant_title
ON library_books (tenant_id, LOWER(title));


-- 2. Individual physical copies
CREATE TABLE IF NOT EXISTS library_book_copies (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    book_id BIGINT NOT NULL,

    barcode VARCHAR(100) NOT NULL,
    acquisition_date DATE,
    purchase_price NUMERIC(12, 2),

    status VARCHAR(20) NOT NULL DEFAULT 'available'
        CHECK (
            status IN (
                'available',
                'issued',
                'lost',
                'damaged',
                'withdrawn'
            )
        ),

    condition_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_library_copy_book
        FOREIGN KEY (book_id)
        REFERENCES library_books(id)
        ON DELETE RESTRICT,

    CONSTRAINT uq_library_copy_barcode
        UNIQUE (tenant_id, barcode),

    CONSTRAINT chk_library_copy_price
        CHECK (purchase_price IS NULL OR purchase_price >= 0)
);

CREATE INDEX IF NOT EXISTS
    idx_library_copies_tenant_book
ON library_book_copies (tenant_id, book_id);

CREATE INDEX IF NOT EXISTS
    idx_library_copies_available
ON library_book_copies (tenant_id, status);


-- 3. Book issue and return transactions
CREATE TABLE IF NOT EXISTS library_loans (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    copy_id BIGINT NOT NULL,
    student_id BIGINT NOT NULL,

    issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE NOT NULL,
    returned_at TIMESTAMPTZ,

    status VARCHAR(20) NOT NULL DEFAULT 'issued'
        CHECK (status IN ('issued', 'returned', 'lost')),

    fine_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    remarks TEXT,

    issued_by BIGINT,
    received_by BIGINT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_library_loan_copy
        FOREIGN KEY (copy_id)
        REFERENCES library_book_copies(id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_library_loan_student
        FOREIGN KEY (student_id)
        REFERENCES students(id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_library_loan_dates
        CHECK (due_date >= issue_date),

    CONSTRAINT chk_library_loan_fine
        CHECK (fine_amount >= 0),

    CONSTRAINT chk_library_loan_return
        CHECK (
            (status = 'returned' AND returned_at IS NOT NULL)
            OR
            (status <> 'returned' AND returned_at IS NULL)
        )
);

-- A physical copy cannot have multiple active loans.
CREATE UNIQUE INDEX IF NOT EXISTS
    uq_library_active_loan_copy
ON library_loans (tenant_id, copy_id)
WHERE status = 'issued';

CREATE INDEX IF NOT EXISTS
    idx_library_loans_student
ON library_loans (tenant_id, student_id, issue_date DESC);

CREATE INDEX IF NOT EXISTS
    idx_library_loans_due
ON library_loans (tenant_id, due_date)
WHERE status = 'issued';

COMMIT;
