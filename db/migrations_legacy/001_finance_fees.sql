
BEGIN;

-- Ensure composite foreign keys can verify that students
-- belong to the correct school.
CREATE UNIQUE INDEX IF NOT EXISTS students_tenant_id_id_unique_idx
ON students (tenant_id, id);


-- 1. Fee categories
CREATE TABLE IF NOT EXISTS fee_categories (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fee_categories_tenant_name_unique
        UNIQUE (tenant_id, name),

    CONSTRAINT fee_categories_tenant_id_unique
        UNIQUE (tenant_id, id)
);


-- 2. Fee structures: fee amount for a class/category/year.
CREATE TABLE IF NOT EXISTS fee_structures (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    class_id BIGINT NOT NULL,
    category_id BIGINT NOT NULL,
    academic_year VARCHAR(9) NOT NULL,
    amount_paise BIGINT NOT NULL,
    frequency VARCHAR(20) NOT NULL DEFAULT 'annual',
    due_date DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fee_structures_class_tenant_fk
        FOREIGN KEY (tenant_id, class_id)
        REFERENCES school_classes (tenant_id, id),

    CONSTRAINT fee_structures_category_tenant_fk
        FOREIGN KEY (tenant_id, category_id)
        REFERENCES fee_categories (tenant_id, id),

    CONSTRAINT fee_structures_amount_check
        CHECK (amount_paise > 0),

    CONSTRAINT fee_structures_frequency_check
        CHECK (frequency IN (
            'one_time', 'monthly', 'quarterly', 'annual'
        )),

    CONSTRAINT fee_structures_status_check
        CHECK (status IN ('active', 'inactive')),

    CONSTRAINT fee_structures_academic_year_check
        CHECK (academic_year ~ '^[0-9]{4}-[0-9]{4}$'),

    CONSTRAINT fee_structures_academic_year_class_category_unique
        UNIQUE (tenant_id, class_id, category_id, academic_year),

    CONSTRAINT fee_structures_tenant_id_unique
        UNIQUE (tenant_id, id)
);


-- 3. Fees assigned to individual students.
CREATE TABLE IF NOT EXISTS student_fee_assignments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    student_id BIGINT NOT NULL,
    fee_structure_id BIGINT NOT NULL,
    amount_paise BIGINT NOT NULL,
    discount_paise BIGINT NOT NULL DEFAULT 0,
    due_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    notes VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT student_fee_assignments_student_tenant_fk
        FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id),

    CONSTRAINT student_fee_assignments_structure_tenant_fk
        FOREIGN KEY (tenant_id, fee_structure_id)
        REFERENCES fee_structures (tenant_id, id),

    CONSTRAINT student_fee_assignments_amount_check
        CHECK (amount_paise > 0),

    CONSTRAINT student_fee_assignments_discount_check
        CHECK (
            discount_paise >= 0
            AND discount_paise <= amount_paise
        ),

    CONSTRAINT student_fee_assignments_status_check
        CHECK (status IN ('active', 'cancelled', 'waived')),

    CONSTRAINT student_fee_assignments_unique
        UNIQUE (tenant_id, student_id, fee_structure_id),

    CONSTRAINT student_fee_assignments_tenant_id_unique
        UNIQUE (tenant_id, id)
);


-- 4. Individual payments against a student fee assignment.
CREATE TABLE IF NOT EXISTS fee_payments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    assignment_id BIGINT NOT NULL,
    receipt_number VARCHAR(60) NOT NULL,
    amount_paise BIGINT NOT NULL,
    payment_method VARCHAR(30) NOT NULL,
    transaction_reference VARCHAR(150),
    payment_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    notes VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fee_payments_assignment_tenant_fk
        FOREIGN KEY (tenant_id, assignment_id)
        REFERENCES student_fee_assignments (tenant_id, id),

    CONSTRAINT fee_payments_amount_check
        CHECK (amount_paise > 0),

    CONSTRAINT fee_payments_method_check
        CHECK (payment_method IN (
            'cash',
            'upi',
            'bank_transfer',
            'card',
            'cheque',
            'online',
            'other'
        )),

    CONSTRAINT fee_payments_receipt_unique
        UNIQUE (tenant_id, receipt_number)
);


-- Indexes for school-scoped lookups and reports.
CREATE INDEX IF NOT EXISTS idx_fee_structures_tenant_class
ON fee_structures (tenant_id, class_id);

CREATE INDEX IF NOT EXISTS idx_student_fee_assignments_tenant_student
ON student_fee_assignments (tenant_id, student_id);

CREATE INDEX IF NOT EXISTS idx_fee_payments_tenant_assignment
ON fee_payments (tenant_id, assignment_id);

CREATE INDEX IF NOT EXISTS idx_fee_payments_tenant_date
ON fee_payments (tenant_id, payment_date);

COMMIT;
