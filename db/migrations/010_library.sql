-- db/migrations/010_library.sql

CREATE TABLE IF NOT EXISTS books (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID REFERENCES tenants(id) ON DELETE CASCADE,
  title         VARCHAR(300) NOT NULL,
  author        VARCHAR(200),
  isbn          VARCHAR(30),
  publisher     VARCHAR(200),
  edition       VARCHAR(50),
  category      VARCHAR(100),
  subject_id    UUID REFERENCES subjects(id),
  total_copies  INT DEFAULT 1,
  available     INT DEFAULT 1,
  location      VARCHAR(100),             -- Shelf / Rack reference
  added_at      DATE DEFAULT CURRENT_DATE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS book_issues (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  book_id     UUID REFERENCES books(id),
  borrower_id UUID REFERENCES users(id),  -- student or staff user id
  issue_date  DATE DEFAULT CURRENT_DATE,
  due_date    DATE,
  return_date DATE,
  fine_amount NUMERIC(8,2) DEFAULT 0,
  fine_paid   BOOLEAN DEFAULT FALSE,
  status      VARCHAR(20) DEFAULT 'issued',   -- issued | returned | overdue | lost
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_books_tenant ON books(tenant_id);
CREATE INDEX IF NOT EXISTS idx_book_issues_status ON book_issues(status);
CREATE INDEX IF NOT EXISTS idx_book_issues_borrower ON book_issues(borrower_id);
